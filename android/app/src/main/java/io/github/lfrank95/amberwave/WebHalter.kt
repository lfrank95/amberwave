package io.github.lfrank95.amberwave

import android.annotation.SuppressLint
import android.content.Context
import android.content.MutableContextWrapper
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebView
import org.json.JSONObject

/**
 * Hält die Oberfläche (WebView) über die Activity hinaus: wird die App weggewischt oder die Activity neu aufgebaut,
 * spielt die Musik weiter. Die WebView hängt an einem austauschbaren Kontext – mal an der Activity, mal an der App.
 */
object WebHalter {
    private val haupt = Handler(Looper.getMainLooper())
    private var kontext: MutableContextWrapper? = null
    var webView: WebView? = null
        private set

    /** Adresse der Seite im Hauptfenster (für die Prüfung der Brücke – wird von WebViewClient aktuell gehalten) */
    @Volatile var seite: String = ""

    @SuppressLint("SetJavaScriptEnabled")
    fun holen(activity: Context, neu: (Context) -> WebView): Pair<WebView, Boolean> {
        webView?.let { w ->
            kontext?.baseContext = activity
            (w.parent as? ViewGroup)?.removeView(w)
            return w to false
        }
        val k = MutableContextWrapper(activity)
        kontext = k
        val w = neu(k)
        webView = w
        return w to true
    }

    /** Activity weg: WebView an die App hängen (läuft weiter) */
    fun loesen(app: Context) {
        webView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        kontext?.baseContext = app.applicationContext
    }

    fun zerstoeren() {
        webView?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() }
        webView = null
        kontext = null
    }

    /** JavaScript in der Oberfläche ausführen (von jedem Thread aus) */
    fun js(code: String) {
        haupt.post { webView?.evaluateJavascript(code, null) }
    }

    /** Ereignis an die Oberfläche (offline.js hört über android.js zu) */
    fun ereignis(o: JSONObject) = js("window.awAndroidEreignis && window.awAndroidEreignis(${JSONObject.quote(o.toString())})")

    /** Knopf aus Benachrichtigung/Sperrbildschirm an den Player */
    fun aktion(aktion: String, daten: JSONObject? = null) =
        js("window.awAndroidAktion && window.awAndroidAktion(${JSONObject.quote(aktion)}, ${JSONObject.quote((daten ?: JSONObject()).toString())})")
}
