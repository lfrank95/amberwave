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

    /** Antwortet der Server? (kurz – sonst startet die App mit dem Gespeicherten) */
    fun serverErreichbar(server: String = Einstellungen.server, zeit: Int = 3000): Boolean {
        if (server.isEmpty() || !verbunden()) return false
        return runCatching {
            val c = oeffnen("$server/api/v1/ping", zeit, zeit, mitCookie = false)
            try { c.responseCode == 200 && c.inputStream.bufferedReader().readText().contains("amberwave") } finally { c.disconnect() }
        }.getOrDefault(false)
    }
}
