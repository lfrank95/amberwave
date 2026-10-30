package io.github.lfrank95.amberwave

import android.content.Context
import android.net.ConnectivityManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Amberwave im Heimnetz finden (wie der Windows-Client): alle Adressen des eigenen Netzes (/24) auf den üblichen Ports
 * fragen – erst, ob der Port offen ist, dann /api/v1/ping. Ergebnis: Name, Adresse im Heimnetz und die öffentliche
 * Adresse (APP_URL), falls der Server eine hat.
 */
object Netzsuche {
    private val PORTS = listOf(9950, 80, 8095)

    /** eigene IPv4-Netze als „192.168.1“ */
    private fun netze(c: Context): List<String> {
        val cm = c.getSystemService(ConnectivityManager::class.java) ?: return emptyList()
        val n = cm.activeNetwork ?: return emptyList()
        val lp = cm.getLinkProperties(n) ?: return emptyList()
        return lp.linkAddresses.mapNotNull { la ->
            val a = la.address as? Inet4Address ?: return@mapNotNull null
            if (a.isLoopbackAddress || a.isLinkLocalAddress) return@mapNotNull null
            if (!a.isSiteLocalAddress) return@mapNotNull null   // nur private Netze (10.x, 172.16–31.x, 192.168.x)
            a.hostAddress?.substringBeforeLast('.')
        }.distinct()
    }

    private fun portOffen(ip: String, port: Int): Boolean = runCatching {
        Socket().use { it.connect(InetSocketAddress(ip, port), 500); true }
    }.getOrDefault(false)

    private fun ping(basis: String): JSONObject? = runCatching {
        val c = Netz.oeffnen("$basis/api/v1/ping", 2500, 2500, mitCookie = false)
        try { if (c.responseCode == 200) JSONObject(c.inputStream.bufferedReader().readText()).takeIf { it.optString("app") == "amberwave" } else null } finally { c.disconnect() }
    }.getOrNull()

    fun suchen(c: Context): JSONArray {
        val funde = ConcurrentLinkedQueue<JSONObject>()
        val pool = Executors.newFixedThreadPool(64)
        for (basis in netze(c)) for (i in 1..254) for (p in PORTS) {
            val ip = "$basis.$i"
            pool.execute {
                if (!portOffen(ip, p)) return@execute
                val lan = if (p == 80) "http://$ip" else "http://$ip:$p"
                val j = ping(lan) ?: return@execute
                funde += JSONObject().put("lan", lan).put("url", j.optString("url")).put("name", j.optString("name", "Amberwave")).put("version", j.optString("version"))
            }
        }
        pool.shutdown()
        pool.awaitTermination(40, TimeUnit.SECONDS)
        // derselbe Server über mehrere Ports nur einmal
        val eindeutig = LinkedHashMap<String, JSONObject>()
        for (f in funde.sortedBy { it.optString("lan") }) eindeutig.putIfAbsent(f.optString("name") + "|" + f.optString("url"), f)
        return JSONArray(eindeutig.values)
    }
}
