package io.github.lfrank95.amberwave

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * Offline speichern im Hintergrund: lädt einen Titel nach dem anderen (der Server wandelt um) in den Speicher der App –
 * auch wenn die App geschlossen ist. Auf Wunsch nur im WLAN. Fortschritt in der Benachrichtigung und in der Oberfläche.
 */
class LadeDienst : Service() {
    companion object {
        private const val TAG = "AwLaden"
        private const val KANAL = "laden"
        private const val NR = 2
        @Volatile private var laeuft = false

        fun starten(c: Context) {
            if (laeuft) return
            runCatching { ContextCompat.startForegroundService(c, Intent(c, LadeDienst::class.java)) }.onFailure { Log.w(TAG, "start", it) }
        }
    }

    @Volatile private var anhalten = false
    private var fertigZahl = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(KANAL, getString(R.string.kanal_laden), NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "abbrechen") {
            anhalten = true
            Speicher.auftraegeLeeren()
            WebHalter.ereignis(JSONObject().put("art", "abgebrochen"))
            if (!laeuft) stopSelf()
            return START_NOT_STICKY
        }
        runCatching { startForeground(NR, meldung(getString(R.string.laden_start), 0, 0), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) }
        if (!laeuft) {
            laeuft = true
            anhalten = false
            Thread { try { schleife() } finally { laeuft = false; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() } }.start()
        }
        return START_NOT_STICKY
    }

    private fun meldung(text: String, fertig: Int, gesamt: Int, anteil: Double = 0.0): android.app.Notification {
        val oeffnen = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        val abbrechen = PendingIntent.getService(this, 1, Intent(this, LadeDienst::class.java).setAction("abbrechen"), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, KANAL)
            .setSmallIcon(R.drawable.ic_stat_amberwave)
            .setContentTitle(if (gesamt > 0) getString(R.string.laden_titel, fertig + 1, gesamt) else getString(R.string.laden_start))
            .setContentText(text)
            .setProgress(1000, ((if (gesamt > 0) (fertig + anteil) / gesamt else 0.0) * 1000).toInt(), gesamt == 0)
            .setContentIntent(oeffnen)
            .addAction(0, getString(R.string.abbrechen), abbrechen)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .build()
    }

    private fun zeigen(text: String, gesamt: Int, anteil: Double = 0.0) {
        getSystemService(NotificationManager::class.java).notify(NR, meldung(text, fertigZahl, gesamt, anteil))
    }

    private fun schleife() {
        var wartetGemeldet = ""
        while (!anhalten) {
            val a = Speicher.naechsterAuftrag() ?: break
            val gesamt = fertigZahl + Speicher.auftraegeOffen()
            // Netz abwarten (nur WLAN: auch das)
            val grund = when {
                !Netz.verbunden() -> "netz"
                Einstellungen.nurWlan && !Netz.unbegrenzt() -> "wlan"
                else -> ""
            }
            if (grund.isNotEmpty()) {
                if (grund != wartetGemeldet) {
                    wartetGemeldet = grund
                    WebHalter.ereignis(JSONObject().put("art", "wartet").put("grund", grund))
                    zeigen(getString(if (grund == "wlan") R.string.laden_wartet_wlan else R.string.laden_wartet_netz), gesamt)
                }
                Thread.sleep(15000)
                // ohne Aussicht nicht ewig im Vordergrund bleiben: nach einer Stunde aufhören, die Oberfläche startet neu
                if (System.currentTimeMillis() - (wartetSeit ?: System.currentTimeMillis().also { wartetSeit = it }) > 60 * 60_000) break
                continue
            }
            wartetSeit = null
            if (wartetGemeldet.isNotEmpty()) { wartetGemeldet = ""; WebHalter.ereignis(JSONObject().put("art", "wartet").put("grund", "")) }
            zeigen(a.name, gesamt)
            try {
                laden(a, gesamt)
                fertigZahl++
            } catch (e: KeinPlatz) {
                Speicher.auftraegeLeeren()
                WebHalter.ereignis(JSONObject().put("art", "platz"))
                break
            } catch (e: Endgueltig) {
                Speicher.auftragFertig(a.id)
                WebHalter.ereignis(JSONObject().put("art", "fehler").put("id", a.id).put("text", e.message))
            } catch (e: Exception) {
                Log.w(TAG, "Titel ${a.id}", e)
                if (a.versuche + 1 >= 4) {
                    Speicher.auftragFertig(a.id)
                    WebHalter.ereignis(JSONObject().put("art", "fehler").put("id", a.id).put("text", e.message ?: e.javaClass.simpleName))
                } else {
                    Speicher.auftragVersuch(a.id)
                    Thread.sleep(3000L * (a.versuche + 1))
                }
            }
        }
    }

    private var wartetSeit: Long? = null

    private class KeinPlatz : Exception()
    private class Endgueltig(m: String) : Exception(m)

    private fun laden(a: Speicher.Auftrag, gesamt: Int) {
        val server = Einstellungen.server
        val c = Netz.oeffnen(server + a.pfad, 20000, 120000)
        try {
            when (val code = c.responseCode) {
                200 -> {}
                503 -> { Thread.sleep((c.getHeaderField("Retry-After")?.toLongOrNull() ?: 5) * 1000); throw IOException("503") }
                401 -> throw Endgueltig(getString(R.string.fehler_anmeldung))
                403, 404 -> throw Endgueltig(runCatching { JSONObject(c.errorStream.bufferedReader().readText()).optString("fehler") }.getOrNull()?.ifEmpty { null } ?: "HTTP $code")
                else -> throw IOException("HTTP $code")
            }
            val dauer = c.getHeaderField("X-Dauern")?.split(',')?.firstOrNull()?.toDoubleOrNull() ?: 0.0
            val endung = c.getHeaderField("X-Endung")?.takeIf { Regex("^[a-z0-9]{2,5}$").matches(it) } ?: "webm"
            val format = if (endung == "webm") "opus" else endung
            val kbit = if (a.q == "original") 1000 else a.q.filter { it.isDigit() }.toIntOrNull() ?: 256
            val erwartet = c.contentLengthLong.takeIf { it > 0 } ?: maxOf(1L, (dauer * kbit * 125).toLong())
            val teil = File(Speicher.offlineOrdner, "${a.id}.teil")
            var n = 0L
            var zuletzt = 0L
            try {
                c.inputStream.use { ein ->
                    teil.outputStream().use { aus ->
                        val puffer = ByteArray(64 * 1024)
                        while (true) {
                            if (anhalten) throw IOException("abgebrochen")
                            val r = ein.read(puffer)
                            if (r < 0) break
                            aus.write(puffer, 0, r)
                            n += r
                            val jetzt = System.currentTimeMillis()
                            if (jetzt - zuletzt > 400) {
                                zuletzt = jetzt
                                val anteil = (n.toDouble() / erwartet).coerceAtMost(0.99)
                                WebHalter.ereignis(JSONObject().put("art", "fortschritt").put("id", a.id).put("anteil", anteil))
                                zeigen(a.name, gesamt, anteil)
                            }
                        }
                    }
                }
            } catch (e: IOException) {
                teil.delete()
                if (e.message?.contains("ENOSPC") == true || e.message?.contains("No space", true) == true) throw KeinPlatz()
                throw e
            }
            if (n < 1000) { teil.delete(); throw IOException("leere Antwort") }
            // inzwischen entfernt (Sammlung gelöscht)? Dann nichts ablegen
            if (!Speicher.auftragDa(a.id)) { teil.delete(); return }
            val name = "${a.id}.$endung"
            val ziel = File(Speicher.offlineOrdner, name)
            if (!teil.renameTo(ziel)) { teil.delete(); throw IOException("umbenennen") }
            Speicher.dateiEintragen(a.id, name, n, dauer, format, a.q)
            Speicher.auftragFertig(a.id)
            WebHalter.ereignis(JSONObject().put("art", "fertig").put("id", a.id).put("bytes", n).put("dauer", dauer).put("format", format).put("q", a.q))
        } finally { c.disconnect() }
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15: Vordergrund-Zeit für Datenübertragung aufgebraucht – beim nächsten Öffnen der App geht es weiter
        anhalten = true
        stopSelf()
    }
}
