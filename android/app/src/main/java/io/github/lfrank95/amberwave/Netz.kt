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
     * Beim ersten Mal merkt sich die App seinen Ausweis; ein anderer Amberwave unter derselben Adresse zählt als „nicht da“.
     */
    fun serverErreichbar(server: String = Einstellungen.server, zeit: Int = 3000): Boolean {
        if (server.isEmpty() || !verbunden()) return false
        val j = ping(server, zeit) ?: return false
        return ausweisPasst(j, server == Einstellungen.server)
    }

    /** Passt der Ausweis aus /ping zum gemerkten? Ohne gemerkten wird er übernommen (nur für den eingestellten Server). */
    fun ausweisPasst(j: org.json.JSONObject, merken: Boolean = true): Boolean {
        val s = j.optString("schluessel")
        if (s.isEmpty()) return true   // ältere Server ohne Ausweis
        val bekannt = Einstellungen.ausweis
        if (bekannt.isEmpty()) { if (merken) Einstellungen.ausweis = s; return true }
        return bekannt == s
    }
}
