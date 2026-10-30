package io.github.lfrank95.amberwave

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri

/** Was die App sich merkt: Serveradresse und Wünsche, die nur das Gerät betreffen (nur im WLAN laden). */
object Einstellungen {
    private lateinit var p: SharedPreferences

    fun init(c: Context) {
        if (!::p.isInitialized) p = c.applicationContext.getSharedPreferences("amberwave", Context.MODE_PRIVATE)
    }

    /** Adresse des Servers ohne Pfad und ohne / am Ende, z. B. https://musik.example.de – leer = noch nicht eingerichtet */
    var server: String
        get() = p.getString("server", "") ?: ""
        set(v) = p.edit().putString("server", v).apply()

    var nurWlan: Boolean
        get() = p.getBoolean("nur_wlan", false)
        set(v) = p.edit().putBoolean("nur_wlan", v).apply()

    var updateGeprueft: Long
        get() = p.getLong("update_geprueft", 0)
        set(v) = p.edit().putLong("update_geprueft", v).apply()

    var updateAusgelassen: String
        get() = p.getString("update_ausgelassen", "") ?: ""
        set(v) = p.edit().putString("update_ausgelassen", v).apply()

    var benachrichtigungGefragt: Boolean
        get() = p.getBoolean("benachrichtigung_gefragt", false)
        set(v) = p.edit().putBoolean("benachrichtigung_gefragt", v).apply()

    /** Gehört die Adresse zum eingestellten Server? (Schema, Host und Port gleich) */
    fun istServer(u: Uri?): Boolean {
        val s = server
        if (u == null || s.isEmpty()) return false
        val su = Uri.parse(s)
        return u.scheme.equals(su.scheme, true) && u.host.equals(su.host, true) && port(u) == port(su)
    }

    private fun port(u: Uri): Int = if (u.port > 0) u.port else if (u.scheme.equals("https", true)) 443 else 80

    /** Eingabe zu einer Adresse machen: ohne Schema → https://, ohne Pfad, ohne / am Ende */
    fun normalisieren(eingabe: String, schema: String = "https"): String? {
        var e = eingabe.trim()
        if (e.isEmpty()) return null
        if (!e.contains("://")) e = "$schema://$e"
        val u = Uri.parse(e)
        val host = u.host ?: return null
        if (u.scheme != "http" && u.scheme != "https") return null
        return "${u.scheme}://$host" + (if (u.port > 0) ":${u.port}" else "")
    }
}

/** Versionen vergleichen: 0.9.1-beta.5 < 0.9.1-beta.10 < 0.9.1 < 0.9.2-beta.1 */
object Version {
    fun neuer(a: String, b: String): Boolean = vergleichen(a, b) > 0

    fun vergleichen(a: String, b: String): Int {
        val (ka, va) = teile(a)
        val (kb, vb) = teile(b)
        for (i in 0 until maxOf(ka.size, kb.size)) {
            val d = (ka.getOrElse(i) { 0 }).compareTo(kb.getOrElse(i) { 0 })
            if (d != 0) return d
        }
        if (va == null && vb == null) return 0
        if (va == null) return 1
        if (vb == null) return -1
        val na = Regex("\\d+").find(va)?.value?.toIntOrNull() ?: 0
        val nb = Regex("\\d+").find(vb)?.value?.toIntOrNull() ?: 0
        val wa = va.substringBefore('.').lowercase()
        val wb = vb.substringBefore('.').lowercase()
        if (wa != wb) return wa.compareTo(wb)
        return na.compareTo(nb)
    }

    private fun teile(v: String): Pair<List<Int>, String?> {
        val s = v.trim().removePrefix("v")
        val kern = s.substringBefore('-')
        val vor = if (s.contains('-')) s.substringAfter('-') else null
        return kern.split('.').map { it.toIntOrNull() ?: 0 } to vor
    }
}
