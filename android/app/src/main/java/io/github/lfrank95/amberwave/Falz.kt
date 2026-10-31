package io.github.lfrank95.amberwave

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.View
import androidx.core.util.Consumer
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Faltgeräte: die WebView kennt Falz und Haltung nicht (im Browser: Viewport Segments, Device Posture). Die App liest sie
 * aus Android (Jetpack WindowManager) und gibt sie an die Oberfläche (falz.js) – in CSS-Pixeln der Oberfläche.
 *   zustand: „flach“ | „halb“ (wie ein Buch bzw. Laptop aufgestellt), richtung: „senkrecht“ | „waagerecht“
 */
object Falz {
    @Volatile var json: String = "null"
        private set
    private var adapter: WindowInfoTrackerCallbackAdapter? = null
    private var hoerer: Consumer<WindowLayoutInfo>? = null

    fun starten(a: Activity, web: View) {
        stoppen()
        val ad = WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(a))
        val h = Consumer<WindowLayoutInfo> { info -> setzen(a, web, info) }
        runCatching { ad.addWindowLayoutInfoListener(a, a.mainExecutor, h) }.onSuccess { adapter = ad; hoerer = h }
    }

    fun stoppen() {
        val ad = adapter
        val h = hoerer
        if (ad != null && h != null) runCatching { ad.removeWindowLayoutInfoListener(h) }
        adapter = null
        hoerer = null
    }

    private fun setzen(a: Activity, web: View, info: WindowLayoutInfo) {
        val f = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
        // Halb aufgeklappt: Drehen nach dem Lagesensor erlauben, auch wenn die Drehung gesperrt ist – sonst bleibt die App
        // hochkant, obwohl das Gerät wie ein Laptop aufgestellt ist. Flach oder zugeklappt gilt wieder die Sperre.
        val gewuenscht = if (f?.state == FoldingFeature.State.HALF_OPENED) ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        if (a.requestedOrientation != gewuenscht) a.requestedOrientation = gewuenscht
        json = if (f == null) "null" else {
            val d = a.resources.displayMetrics.density
            val ort = IntArray(2)
            web.getLocationInWindow(ort)
            val b = web.width / d
            val h = web.height / d
            val l = (f.bounds.left - ort[0]) / d
            val r = (f.bounds.right - ort[0]) / d
            val o = (f.bounds.top - ort[1]) / d
            val u = (f.bounds.bottom - ort[1]) / d
            val senkrecht = f.orientation == FoldingFeature.Orientation.VERTICAL
            val segmente = JSONArray()
            if (senkrecht) {
                segmente.put(seg(0f, 0f, l, h)).put(seg(r, 0f, b - r, h))
            } else {
                segmente.put(seg(0f, 0f, b, o)).put(seg(0f, u, b, h - u))
            }
            JSONObject()
                .put("zustand", if (f.state == FoldingFeature.State.HALF_OPENED) "halb" else "flach")
                .put("richtung", if (senkrecht) "senkrecht" else "waagerecht")
                .put("trennt", f.isSeparating)
                .put("segmente", segmente)
                .toString()
        }
        WebHalter.js("window.awAndroidFalz && window.awAndroidFalz($json)")
    }

    private fun seg(x: Float, y: Float, b: Float, h: Float) =
        JSONObject().put("x", Math.round(x)).put("y", Math.round(y)).put("width", Math.round(maxOf(0f, b))).put("height", Math.round(maxOf(0f, h)))
}
