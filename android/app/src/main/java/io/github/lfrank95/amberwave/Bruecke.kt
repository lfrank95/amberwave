package io.github.lfrank95.amberwave

import android.content.Context
import android.net.Uri
import android.os.StatFs
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * window.AwAndroid – was die Oberfläche von der App braucht. Antwortet nur der eigenen Startseite und dem eingestellten
 * Server (andere Seiten, etwa ein Link nach außen, bekommen nichts).
 */
class Bruecke(private val app: Context, private val aktivitaet: () -> MainActivity?) {

    private fun vomServer(): Boolean = Einstellungen.istServer(Uri.parse(WebHalter.seite))
    private fun vomStart(): Boolean = WebHalter.seite.startsWith("file:///android_asset/")

    @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME

    // ---------- Startseite (Serveradresse) ----------
    /** Adresse prüfen; das Ergebnis kommt als window.startErgebnis({ok, adresse, name, fehler}) */
    @JavascriptInterface fun serverPruefen(eingabe: String) {
        if (!vomStart()) return
        Thread {
            val erg = JSONObject()
            val versuche = if (eingabe.contains("://")) listOfNotNull(Einstellungen.normalisieren(eingabe))
                else listOfNotNull(Einstellungen.normalisieren(eingabe, "https"), Einstellungen.normalisieren(eingabe, "http"))
            var gefunden: String? = null
            var name = ""
            for (a in versuche) {
                val r = runCatching {
                    val c = Netz.oeffnen("$a/api/v1/ping", 6000, 6000, mitCookie = false)
                    try { if (c.responseCode == 200) JSONObject(c.inputStream.bufferedReader().readText()) else null } finally { c.disconnect() }
                }.getOrNull()
                if (r?.optString("app") == "amberwave") { gefunden = a; name = r.optString("name"); break }
            }
            if (gefunden != null) erg.put("ok", true).put("adresse", gefunden).put("name", name)
            else erg.put("ok", false).put("fehler", if (versuche.isEmpty()) "adresse" else "nicht_erreichbar")
            WebHalter.js("window.startErgebnis && window.startErgebnis(${erg})")
        }.start()
    }

    @JavascriptInterface fun serverSetzen(adresse: String) {
        if (!vomStart()) return
        val a = Einstellungen.normalisieren(adresse, if (adresse.startsWith("http://")) "http" else "https") ?: return
        if (a != Einstellungen.server) {
            Speicher.oberflaecheLeeren()
            Speicher.allesLoeschen()
        }
        Einstellungen.server = a
        aktivitaet()?.runOnUiThread { aktivitaet()?.serverLaden() }
    }

    /** Server im Heimnetz suchen; Ergebnis als window.startFunde([{name, lan, url, version}]) */
    @JavascriptInterface fun serverSuchen() {
        if (!vomStart()) return
        Thread {
            val f = runCatching { Netzsuche.suchen(app) }.getOrDefault(JSONArray())
            WebHalter.js("window.startFunde && window.startFunde($f)")
        }.start()
    }

    /** Falz von Faltgeräten (Lage, halb oder ganz aufgeklappt) – null ohne Falz */
    @JavascriptInterface fun falz(): String = Falz.json

    @JavascriptInterface fun gespeicherterServer(): String = if (vomStart()) Einstellungen.server else ""

    /** Startseite nach einem Fehler: noch einmal versuchen */
    @JavascriptInterface fun neuVersuchen() {
        if (!vomStart()) return
        aktivitaet()?.runOnUiThread { aktivitaet()?.serverLaden() }
    }

    /** Aus den Einstellungen der Oberfläche: anderen Server wählen */
    @JavascriptInterface fun serverWechseln() {
        if (!vomServer() && !vomStart()) return
        aktivitaet()?.runOnUiThread { aktivitaet()?.startseite(null) }
    }

    /** Aus den Einstellungen: jetzt nach einer neuen Version der App schauen */
    @JavascriptInterface fun updatePruefen() {
        if (!vomServer()) return
        aktivitaet()?.let { a -> a.runOnUiThread { Aktualisierung.pruefen(a, vonHand = true) } }
    }

    @JavascriptInterface fun server(): String = if (vomServer()) Einstellungen.server else ""

    // ---------- Speicher der Oberfläche ----------
    @JavascriptInterface fun kvAlle(store: String): String = if (vomServer()) Speicher.kvAlle(store) else "[]"
    @JavascriptInterface fun kvSetzen(store: String, schluessel: String, wert: String) { if (vomServer()) Speicher.kvSetzen(store, schluessel, wert) }
    @JavascriptInterface fun kvLoeschen(store: String, schluessel: String) { if (vomServer()) Speicher.kvLoeschen(store, schluessel) }

    // ---------- Offline-Titel ----------
    @JavascriptInterface fun dateien(): String = if (vomServer()) Speicher.dateien() else "{}"

    @JavascriptInterface fun laden(liste: String) {
        if (!vomServer()) return
        val a = runCatching { JSONArray(liste) }.getOrNull() ?: return
        if (Speicher.auftraegeEintragen(a) > 0 || Speicher.auftraegeOffen() > 0) LadeDienst.starten(app)
    }

    @JavascriptInterface fun dateiLoeschen(id: Long) { if (vomServer()) Speicher.dateiLoeschen(id) }
    @JavascriptInterface fun allesLoeschen() { if (vomServer()) Speicher.allesLoeschen() }

    @JavascriptInterface fun speicher(): String {
        val s = runCatching { StatFs(Speicher.wurzel.path) }.getOrNull()
        return JSONObject().put("frei", s?.availableBytes ?: 0).put("gesamt", s?.totalBytes ?: 0).put("belegt", Speicher.belegt()).toString()
    }

    @JavascriptInterface fun einstellungen(): String = JSONObject().put("nurWlan", Einstellungen.nurWlan).toString()

    @JavascriptInterface fun einstellungSetzen(k: String, v: String) {
        if (!vomServer()) return
        if (k == "nurWlan") {
            Einstellungen.nurWlan = v == "1"
            if (Speicher.auftraegeOffen() > 0) LadeDienst.starten(app)
        }
    }

    @JavascriptInterface fun bilderMerken(liste: String) {
        if (vomServer()) runCatching { Oberflaeche.bilderMerken(JSONArray(liste)) }
    }

    @JavascriptInterface fun huelleVorladen(liste: String) {
        if (vomServer()) runCatching { Oberflaeche.vorladen(JSONArray(liste)) }
    }

    // ---------- Wiedergabe (Benachrichtigung, Sperrbildschirm, Kopfhörertasten) ----------
    @JavascriptInterface fun medienMeta(json: String) {
        if (!vomServer()) return
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return
        Medien.meta(app, o.optString("titel"), o.optString("kuenstler"), o.optString("album"), o.optString("bild"))
    }

    @JavascriptInterface fun medienZustand(zustand: String) { if (vomServer()) Medien.zustand(app, zustand == "playing") }

    @JavascriptInterface fun medienAktionen(json: String) {
        if (!vomServer()) return
        val a = runCatching { JSONArray(json) }.getOrNull() ?: return
        Medien.aktionen((0 until a.length()).map { a.optString(it) }.toSet())
    }

    @JavascriptInterface fun medienPosition(json: String) {
        if (!vomServer()) return
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return
        Medien.position(o.optDouble("dauer", 0.0), o.optDouble("position", 0.0), o.optDouble("tempo", 1.0))
    }
}
