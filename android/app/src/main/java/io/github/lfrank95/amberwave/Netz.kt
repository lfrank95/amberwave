package io.github.lfrank95.amberwave

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.webkit.CookieManager
import android.webkit.WebSettings
import java.net.HttpURLConnection
import java.net.URL

/** Anfragen der App selbst (Downloads, Oberflächen-Dateien) – mit der Anmeldung der Oberfläche (Cookie) */
object Netz {
    private lateinit var app: Context
    @Volatile private var agent: String = ""

    fun init(c: Context) {
        app = c.applicationContext
    }

    /** Kennung wie die Oberfläche (der Server ordnet Gerät und Sitzung darüber zu) */
    fun kennung(): String {
        if (agent.isEmpty()) agent = runCatching { WebSettings.getDefaultUserAgent(app) }.getOrDefault("Mozilla/5.0 (Linux; Android)") + " AmberwaveAndroid/" + BuildConfig.VERSION_NAME
        return agent
    }

    fun oeffnen(url: String, verbinden: Int = 15000, lesen: Int = 60000, mitCookie: Boolean = true): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = verbinden
        c.readTimeout = lesen
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", kennung())
        c.setRequestProperty("Accept-Language", java.util.Locale.getDefault().toLanguageTag())
        if (mitCookie) runCatching { CookieManager.getInstance().getCookie(url) }.getOrNull()?.let { c.setRequestProperty("Cookie", it) }
        return c
    }

    /** Irgendein Netz da? */
    fun verbunden(): Boolean {
        val cm = app.getSystemService(ConnectivityManager::class.java) ?: return true
        val n = cm.activeNetwork ?: return false
        val f = cm.getNetworkCapabilities(n) ?: return false
        return f.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** Netz ohne Volumenbegrenzung (WLAN, LAN) */
    fun unbegrenzt(): Boolean {
        val cm = app.getSystemService(ConnectivityManager::class.java) ?: return true
        val f = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) } ?: return false
        return f.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    /** /api/v1/ping eines Servers (null = antwortet nicht oder ist kein Amberwave) */
    fun ping(server: String, zeit: Int = 3000): org.json.JSONObject? = runCatching {
        val c = oeffnen("$server/api/v1/ping", zeit, zeit, mitCookie = false)
        try { if (c.responseCode == 200) org.json.JSONObject(c.inputStream.bufferedReader().readText()).takeIf { it.optString("app") == "amberwave" } else null } finally { c.disconnect() }
    }.getOrNull()

    /**
     * Antwortet der Server – und ist es noch derselbe? (kurz – sonst startet die App mit dem Gespeicherten)
     * Beim ersten Mal merkt sich die App seinen Ausweis; danach muss er ihn per Unterschrift belegen. Ein anderer
     * Amberwave unter derselben Adresse (z. B. hat ein anderes Gerät die alte IP bekommen) zählt als „nicht da“.
     */
    fun serverErreichbar(server: String = Einstellungen.server, zeit: Int = 3000): Boolean {
        fremd = false
        if (server.isEmpty() || !verbunden()) return false
        val j = ping(server, zeit) ?: return false
        val ok = ausweisPasst(server, j, server == Einstellungen.server, zeit)
        fremd = !ok
        return ok
    }

    /** Beim letzten serverErreichbar() hat unter der Adresse ein anderer Amberwave geantwortet */
    @Volatile var fremd = false

    /** Passt der Ausweis zum gemerkten (mit Unterschrift belegt)? Ohne gemerkten wird er nach Beleg übernommen. */
    fun ausweisPasst(server: String, j: org.json.JSONObject, merken: Boolean = true, zeit: Int = 3000): Boolean {
        val s = j.optString("schluessel")
        val bekannt = Einstellungen.ausweis
        // Ist ein Ausweis gemerkt, muss er kommen und passen – ein Gerät, das einfach keinen nennt, ist nicht unser Server
        if (bekannt.isNotEmpty() && (s.isEmpty() || bekannt != s)) return false
        if (s.isEmpty()) return true   // noch nichts gemerkt und älterer Server ohne Ausweis
        if (!ausweisBelegt(server, s, zeit)) return false
        if (bekannt.isEmpty() && merken) Einstellungen.ausweis = s
        return true
    }

    /** Der Server unterschreibt eine frische Zufallszahl mit seinem geheimen Schlüssel – nachmachen kann das nur der echte */
    fun ausweisBelegt(server: String, schluessel: String, zeit: Int = 3000): Boolean = runCatching {
        val z = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val c = oeffnen("$server/api/v1/ausweis?z=$z", zeit, zeit, mitCookie = false)
        val b = try { if (c.responseCode == 200) org.json.JSONObject(c.inputStream.bufferedReader().readText()) else null } finally { c.disconnect() }
        b != null && b.optString("schluessel") == schluessel && b.optString("zufall") == z &&
            Ed25519.pruefen(Ed25519.hex(schluessel), "amberwave-ausweis-v1|$z|$schluessel".toByteArray(Charsets.UTF_8), Ed25519.hex(b.optString("unterschrift")))
    }.getOrDefault(false)
}
