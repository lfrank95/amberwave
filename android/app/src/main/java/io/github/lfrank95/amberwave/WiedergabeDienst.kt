package io.github.lfrank95.amberwave

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.media.session.MediaButtonReceiver
import org.json.JSONObject
import java.util.concurrent.Executors

/** Was gerade spielt – die Oberfläche meldet es über die Brücke, der Dienst zeigt es an */
object Medien {
    @Volatile var titel = ""
    @Volatile var kuenstler = ""
    @Volatile var album = ""
    @Volatile var bild: Bitmap? = null
    @Volatile var spielt = false
    @Volatile var dauer = 0.0
    @Volatile var position = 0.0
    @Volatile var tempo = 1.0
    @Volatile var positionZeit = 0L
    @Volatile var aktionen: Set<String> = emptySet()
    private var bildUrl = ""
    private val lader = Executors.newSingleThreadExecutor()

    fun meta(c: Context, titel: String, kuenstler: String, album: String, bild: String) {
        this.titel = titel; this.kuenstler = kuenstler; this.album = album
        if (bild != bildUrl) {
            bildUrl = bild
            this.bild = null
            if (bild.isNotEmpty()) lader.execute {
                val b = runCatching { bildLaden(bild) }.getOrNull()
                if (bildUrl == bild) { this.bild = b; WiedergabeDienst.auffrischen() }
            }
        }
        WiedergabeDienst.auffrischen()
    }

    /** Cover: aus dem Speicher (gespeicherte Alben) oder vom Server, verkleinert */
    private fun bildLaden(url: String): Bitmap? {
        val u = Uri.parse(url)
        val daten = Speicher.bild(Oberflaeche.schluessel(u))?.first?.readBytes()
            ?: if (Einstellungen.istServer(u)) Netz.oeffnen(url, 8000, 15000).let { c -> try { if (c.responseCode == 200) c.inputStream.readBytes() else null } finally { c.disconnect() } } else null
        daten ?: return null
        val b = BitmapFactory.decodeByteArray(daten, 0, daten.size) ?: return null
        val max = 512
        return if (b.width <= max && b.height <= max) b else Bitmap.createScaledBitmap(b, max, max * b.height / maxOf(1, b.width), true)
    }

    fun zustand(c: Context, spielt: Boolean) {
        val vorher = this.spielt
        this.spielt = spielt
        positionZeit = SystemClock.elapsedRealtime()
        if (spielt && !vorher) WiedergabeDienst.starten(c) else WiedergabeDienst.auffrischen()
    }

    fun position(dauer: Double, position: Double, tempo: Double) {
        this.dauer = dauer; this.position = position; this.tempo = tempo
        positionZeit = SystemClock.elapsedRealtime()
        WiedergabeDienst.positionMelden()
    }

    fun aktionen(a: Set<String>) { aktionen = a }
}

/**
 * Wiedergabe im Hintergrund: hält die App am Leben, solange Musik läuft (Vordergrunddienst), zeigt Titel und Knöpfe in der
 * Benachrichtigung und auf dem Sperrbildschirm, nimmt Kopfhörer-/Bluetooth-Tasten an und pausiert bei Anrufen oder wenn
 * der Kopfhörer abgezogen wird.
 */
class WiedergabeDienst : Service() {
    companion object {
        private const val KANAL = "wiedergabe"
        private const val NR = 1
        @Volatile private var dienst: WiedergabeDienst? = null
        private val haupt = Handler(Looper.getMainLooper())

        fun starten(c: Context) {
            if (dienst != null) { auffrischen(); return }
            runCatching { ContextCompat.startForegroundService(c, Intent(c, WiedergabeDienst::class.java)) }
        }

        fun auffrischen() = haupt.post { dienst?.anzeigen() }
        fun positionMelden() = haupt.post { dienst?.zustandSetzen() }
        fun laeuft() = dienst != null
    }

    private lateinit var sitzung: MediaSessionCompat
    private lateinit var audio: AudioManager
    private var fokus: AudioFocusRequest? = null
    private var vonFokusPausiert = false
    private var vordergrund = false
    private var wach: PowerManager.WakeLock? = null
    private var wlan: WifiManager.WifiLock? = null
    private var laermEmpfaenger: BroadcastReceiver? = null
    private val aufhoeren = Runnable { if (!Medien.spielt) { stopForeground(STOP_FOREGROUND_DETACH); vordergrund = false } }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        dienst = this
        audio = getSystemService(AudioManager::class.java)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(KANAL, getString(R.string.kanal_wiedergabe), NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        sitzung = MediaSessionCompat(this, "Amberwave").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = WebHalter.aktion("play")
                override fun onPause() = WebHalter.aktion("pause")
                override fun onSkipToNext() = WebHalter.aktion("nexttrack")
                override fun onSkipToPrevious() = WebHalter.aktion("previoustrack")
                override fun onSeekTo(pos: Long) = WebHalter.aktion("seekto", JSONObject().put("seekTime", pos / 1000.0))
                override fun onFastForward() = WebHalter.aktion("seekforward")
                override fun onRewind() = WebHalter.aktion("seekbackward")
                override fun onStop() = WebHalter.aktion("pause")
            })
            setSessionActivity(oeffnen())
            isActive = true
        }
        wach = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Amberwave:Wiedergabe").apply { setReferenceCounted(false) }
        @Suppress("DEPRECATION")
        wlan = applicationContext.getSystemService(WifiManager::class.java).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Amberwave:Wiedergabe").apply { setReferenceCounted(false) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // als Vordergrunddienst gestartet: sofort in den Vordergrund (Android verlangt das binnen Sekunden), bei Pause
        // gibt anzeigen() ihn nach kurzer Zeit wieder ab
        if (!vordergrund) runCatching { startForeground(NR, benachrichtigung(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK); vordergrund = true }
        MediaButtonReceiver.handleIntent(sitzung, intent)
        if (intent?.action == "beenden") { WebHalter.aktion("pause"); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
        anzeigen()
        return START_NOT_STICKY
    }

    private fun oeffnen(): PendingIntent = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    fun zustandSetzen() {
        if (!::sitzung.isInitialized) return
        var erlaubt = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP
        val a = Medien.aktionen
        if ("nexttrack" in a) erlaubt = erlaubt or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        if ("previoustrack" in a) erlaubt = erlaubt or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        if ("seekto" in a && Medien.dauer > 0) erlaubt = erlaubt or PlaybackStateCompat.ACTION_SEEK_TO
        sitzung.setPlaybackState(PlaybackStateCompat.Builder()
            .setActions(erlaubt)
            .setState(if (Medien.spielt) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED, (Medien.position * 1000).toLong(),
                if (Medien.spielt) Medien.tempo.toFloat() else 0f, Medien.positionZeit)
            .build())
    }

    fun anzeigen() {
        if (!::sitzung.isInitialized) return
        sitzung.setMetadata(MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, Medien.titel)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, Medien.kuenstler)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, Medien.album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (Medien.dauer * 1000).toLong())
            .apply { Medien.bild?.let { putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) } }
            .build())
        zustandSetzen()
        val n = benachrichtigung()
        if (Medien.spielt) {
            haupt.removeCallbacks(aufhoeren)
            fokusHolen()
            wach?.acquire(6 * 60 * 60 * 1000L)
            wlan?.acquire()
            laermAn()
            if (!vordergrund) {
                runCatching { startForeground(NR, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK); vordergrund = true }
                    .onFailure { getSystemService(NotificationManager::class.java).notify(NR, n) }
            } else getSystemService(NotificationManager::class.java).notify(NR, n)
        } else {
            wach?.let { if (it.isHeld) it.release() }
            wlan?.let { if (it.isHeld) it.release() }
            laermAus()
            getSystemService(NotificationManager::class.java).notify(NR, n)
            // kurz warten: zwischen zwei Titeln meldet der Player oft eine Pause
            haupt.removeCallbacks(aufhoeren)
            haupt.postDelayed(aufhoeren, 3000)
        }
    }

    private fun benachrichtigung(): Notification {
        val b = NotificationCompat.Builder(this, KANAL)
            .setSmallIcon(R.drawable.ic_stat_amberwave)
            .setContentTitle(Medien.titel.ifEmpty { getString(R.string.app_name) })
            .setContentText(listOf(Medien.kuenstler, Medien.album).filter { it.isNotEmpty() }.joinToString(" · "))
            .setLargeIcon(Medien.bild)
            .setContentIntent(oeffnen())
            .setDeleteIntent(PendingIntent.getService(this, 9, Intent(this, WiedergabeDienst::class.java).setAction("beenden"), PendingIntent.FLAG_IMMUTABLE))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(Medien.spielt)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
        val knoepfe = mutableListOf<Int>()
        if ("previoustrack" in Medien.aktionen) {
            b.addAction(R.drawable.ic_zurueck, getString(R.string.zurueck), MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS))
            knoepfe += knoepfe.size
        }
        b.addAction(if (Medien.spielt) R.drawable.ic_pause else R.drawable.ic_play, getString(if (Medien.spielt) R.string.pause else R.string.abspielen),
            MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_PLAY_PAUSE))
        knoepfe += knoepfe.size
        if ("nexttrack" in Medien.aktionen) {
            b.addAction(R.drawable.ic_weiter, getString(R.string.weiter), MediaButtonReceiver.buildMediaButtonPendingIntent(this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT))
            knoepfe += knoepfe.size
        }
        b.setStyle(androidx.media.app.NotificationCompat.MediaStyle().setMediaSession(sitzung.sessionToken).setShowActionsInCompactView(*knoepfe.toIntArray()))
        return b.build()
    }

    // ---------- Audiofokus: Anrufe, Navigationsansagen, andere Musik-Apps ----------
    private val fokusHoerer = AudioManager.OnAudioFocusChangeListener { f ->
        when (f) {
            AudioManager.AUDIOFOCUS_LOSS -> { vonFokusPausiert = false; WebHalter.aktion("pause"); fokus = null }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> if (Medien.spielt) { vonFokusPausiert = true; WebHalter.aktion("pause") }
            AudioManager.AUDIOFOCUS_GAIN -> if (vonFokusPausiert) { vonFokusPausiert = false; WebHalter.aktion("play") }
        }
    }

    private fun fokusHolen() {
        if (fokus != null) return
        val r = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener(fokusHoerer)
            .setWillPauseWhenDucked(false)
            .build()
        if (audio.requestAudioFocus(r) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) fokus = r
    }

    // ---------- Kopfhörer abgezogen / Bluetooth weg: Pause ----------
    private fun laermAn() {
        if (laermEmpfaenger != null) return
        laermEmpfaenger = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) { if (i?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) WebHalter.aktion("pause") }
        }
        ContextCompat.registerReceiver(this, laermEmpfaenger, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun laermAus() {
        laermEmpfaenger?.let { runCatching { unregisterReceiver(it) } }
        laermEmpfaenger = null
    }

    /** App aus der Übersicht gewischt: läuft nichts, ist auch der Dienst fertig */
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (!Medien.spielt) stopSelf()
    }

    override fun onDestroy() {
        haupt.removeCallbacks(aufhoeren)
        laermAus()
        fokus?.let { audio.abandonAudioFocusRequest(it) }
        wach?.let { if (it.isHeld) it.release() }
        wlan?.let { if (it.isHeld) it.release() }
        sitzung.isActive = false
        sitzung.release()
        getSystemService(NotificationManager::class.java).cancel(NR)
        dienst = null
        super.onDestroy()
    }
}
