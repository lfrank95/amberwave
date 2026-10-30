package io.github.lfrank95.amberwave

import android.net.Uri
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.Executors

/**
 * Was der Service Worker im Browser macht, macht hier die App (dauerhaft, Android räumt es nicht weg):
 *  - Startseite ohne Netz: die zuletzt geladene Hülle (index.php), markiert mit data-aw-huelle – die App startet dann offline
 *  - Skripte, Stile, Schriften der Oberfläche (mit ?v=): einmal geladen, dann von der Platte
 *  - Cover gespeicherter Alben, und der Ton gespeicherter Titel unter /__aw/offline/<id>
 */
object Oberflaeche {
    private const val TAG = "AwOberflaeche"
    private val arbeiter = Executors.newFixedThreadPool(3)
    @Volatile private var huelleZeit = 0L

    /** Für shouldInterceptRequest: Antwort aus dem eigenen Speicher, sonst null (normal übers Netz) */
    fun abfangen(r: WebResourceRequest): WebResourceResponse? {
        val u = r.url
        if (!Einstellungen.istServer(u) || r.method != "GET") return null
        val pfad = u.path ?: "/"
        return try {
            when {
                pfad.startsWith("/__aw/offline/") -> offlineTon(pfad.removePrefix("/__aw/offline/").toLongOrNull() ?: 0, r.requestHeaders["Range"] ?: r.requestHeaders["range"])
                r.isForMainFrame -> if (appSeite(pfad)) hauptseite() else null
                statisch(u) -> Speicher.statisch(schluessel(u))?.let { (f, typ) -> antwort(f, typ, unveraenderlich = true) }
                pfad.startsWith("/api/v1/bild/cover/") -> Speicher.bild(schluessel(u))?.let { (f, typ) -> antwort(f, typ, unveraenderlich = true) }
                else -> null
            }
        } catch (e: Exception) {
            Log.w(TAG, "abfangen $pfad", e)
            null
        }
    }

    fun schluessel(u: Uri): String = (u.encodedPath ?: "/") + (u.encodedQuery?.let { "?$it" } ?: "")

    /** Seiten der App (nicht Anmeldung, Einrichtung, Schnittstelle, einzelne Dateien) */
    fun appSeite(pfad: String): Boolean =
        !Regex("^/(api/|login\\.php|logout\\.php|register\\.php|passwort|einrichtung|cast/|__aw/)").containsMatchIn(pfad) && !Regex("\\.(html?|php|js|css|json|svg|png|webmanifest)$", RegexOption.IGNORE_CASE).containsMatchIn(pfad)

    /** Dateien, die sich unter ihrer Adresse nie ändern (Version im ?v= bzw. im Namen) */
    private fun statisch(u: Uri): Boolean {
        val p = u.path ?: return false
        return (Regex("^/(css|js|img)/").containsMatchIn(p) && u.getQueryParameter("v") != null) || Regex("^/fonts/[^/]+\\.woff2$").matches(p)
    }

    /** Startseite: Server da → normal laden; sonst die gemerkte Hülle (offline starten) */
    private fun hauptseite(): WebResourceResponse? {
        if (Netz.serverErreichbar()) return null
        val f = Speicher.huelleDatei
        if (!f.exists()) return null
        val html = f.readText().replaceFirst("<html", "<html data-aw-huelle=\"1\"")
        return WebResourceResponse("text/html", "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(html.toByteArray()))
    }

    private fun antwort(f: File, typ: String, unveraenderlich: Boolean = false): WebResourceResponse {
        val mime = typ.substringBefore(';').trim().ifEmpty { "application/octet-stream" }
        val zeichensatz = Regex("charset=([\\w-]+)", RegexOption.IGNORE_CASE).find(typ)?.groupValues?.get(1)
        val kopf = mutableMapOf("Content-Length" to f.length().toString())
        if (unveraenderlich) kopf["Cache-Control"] = "max-age=31536000, immutable"
        return WebResourceResponse(mime, zeichensatz, 200, "OK", kopf, FileInputStream(f))
    }

    /** Ton eines gespeicherten Titels (die Oberfläche holt ihn mit fetch und spielt ihn ab) */
    private fun offlineTon(id: Long, range: String?): WebResourceResponse {
        val d = Speicher.datei(id)
        if (d == null || !d.datei.exists()) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf(), ByteArrayInputStream(ByteArray(0)))
        val mime = when (d.format) {
            "opus", "webm" -> "audio/webm"
            "flac" -> "audio/flac"
            "mp3" -> "audio/mpeg"
            "m4a" -> "audio/mp4"
            "ogg" -> "audio/ogg"
            "wav" -> "audio/wav"
            else -> "application/octet-stream"
        }
        val laenge = d.datei.length()
        val m = range?.let { Regex("bytes=(\\d*)-(\\d*)").find(it) }
        if (m != null && m.groupValues[1].isNotEmpty()) {
            val von = m.groupValues[1].toLong().coerceAtMost(laenge)
            val bis = (m.groupValues[2].toLongOrNull() ?: (laenge - 1)).coerceAtMost(laenge - 1)
            val s = FileInputStream(d.datei)
            s.skip(von)
            return WebResourceResponse(mime, null, 206, "Partial Content", mapOf(
                "Content-Range" to "bytes $von-$bis/$laenge", "Content-Length" to (bis - von + 1).toString(), "Accept-Ranges" to "bytes",
            ), BegrenzterStrom(s, bis - von + 1))
        }
        return WebResourceResponse(mime, null, 200, "OK", mapOf("Content-Length" to laenge.toString(), "Accept-Ranges" to "bytes"), FileInputStream(d.datei))
    }

    // ---------- Speichern ----------

    /** Nach dem Laden einer App-Seite: die Hülle für den Start ohne Netz merken (höchstens alle 10 Minuten) */
    fun huelleMerken(url: String) {
        val jetzt = System.currentTimeMillis()
        if (jetzt - huelleZeit < 10 * 60_000 && Speicher.huelleDatei.exists()) return
        huelleZeit = jetzt
        arbeiter.execute {
            runCatching {
                val c = Netz.oeffnen(url, 10000, 20000)
                c.setRequestProperty("Accept", "text/html")
                try {
                    val html = if (c.responseCode == 200 && (c.contentType ?: "").contains("text/html") && Uri.parse(c.url.toString()).path == Uri.parse(url).path)
                        c.inputStream.bufferedReader().readText() else ""
                    // nur eine angemeldete Hülle (mit eingebettetem Konto) taugt für den Start ohne Netz
                    if (html.contains("id=\"aw-ich\"")) {
                        val tmp = File(Speicher.wurzel, "huelle.neu")
                        tmp.writeText(html)
                        tmp.renameTo(Speicher.huelleDatei)
                    }
                } finally { c.disconnect() }
            }.onFailure { Log.w(TAG, "Hülle", it) }
        }
    }

    /** Liste der Oberfläche (von der App nach dem Start geschickt) einmal laden */
    fun vorladen(urls: JSONArray) {
        val server = Einstellungen.server
        arbeiter.execute {
            val alle = mutableSetOf<String>()
            for (i in 0 until urls.length()) {
                val rel = urls.optString(i)
                if (!rel.startsWith("/")) continue
                val u = Uri.parse(server + rel)
                val k = schluessel(u)
                alle += k
                if (Speicher.statisch(k) != null) continue
                runCatching { laden(server + rel) { daten, typ -> if (!typ.contains("text/html")) {
                    val name = Speicher.hash(k)
                    File(Speicher.oberflaecheOrdner, name).writeBytes(daten)
                    Speicher.statischEintragen(k, u.path ?: rel, name, typ)
                } } }.onFailure { Log.w(TAG, "vorladen $rel", it) }
            }
            Speicher.statischBehalten(alle)
        }
    }

    /** Cover gespeicherter Alben für unterwegs */
    fun bilderMerken(urls: JSONArray) {
        val server = Einstellungen.server
        arbeiter.execute {
            for (i in 0 until urls.length()) {
                val rel = urls.optString(i)
                if (!rel.startsWith("/api/v1/bild/")) continue
                val k = schluessel(Uri.parse(server + rel))
                if (Speicher.bild(k) != null) continue
                runCatching { laden(server + rel) { daten, typ -> if (typ.startsWith("image/")) {
                    val name = Speicher.hash(k)
                    File(Speicher.bilderOrdner, name).writeBytes(daten)
                    Speicher.bildEintragen(k, name, typ)
                } } }
            }
        }
    }

    private fun laden(url: String, fertig: (ByteArray, String) -> Unit) {
        val c = Netz.oeffnen(url, 10000, 30000)
        try {
            if (c.responseCode == 200) fertig(c.inputStream.readBytes(), c.contentType ?: "application/octet-stream")
        } finally { c.disconnect() }
    }
}

/** Liest höchstens n Bytes (Teilantwort bei Range-Anfragen) */
private class BegrenzterStrom(private val s: java.io.InputStream, private var rest: Long) : java.io.InputStream() {
    override fun read(): Int = if (rest <= 0) -1 else s.read().also { if (it >= 0) rest-- }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (rest <= 0) return -1
        val n = s.read(b, off, minOf(len.toLong(), rest).toInt())
        if (n > 0) rest -= n
        return n
    }
    override fun close() = s.close()
}
