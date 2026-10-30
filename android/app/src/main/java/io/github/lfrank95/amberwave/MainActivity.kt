package io.github.lfrank95.amberwave

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.net.URLDecoder

/** Das Fenster der App: die Amberwave-Oberfläche vom eigenen Server, beim ersten Start die Frage nach der Adresse. */
class MainActivity : ComponentActivity() {
    companion object {
        @Volatile var aktiv: MainActivity? = null
        private const val START = "file:///android_asset/start.html"
    }

    private lateinit var rahmen: FrameLayout
    private lateinit var web: WebView
    private var dateiRueckruf: ValueCallback<Array<Uri>>? = null

    private val dateiWahl = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        dateiRueckruf?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        dateiRueckruf = null
    }
    private val benachrichtigungErlaubnis = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        aktiv = this
        Einstellungen.init(this)
        Speicher.init(this)
        Netz.init(this)

        rahmen = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#120d0a")) }
        setContentView(rahmen)
        // Inhalt nicht unter Statusleiste, Navigationsleiste und Tastatur
        ViewCompat.setOnApplyWindowInsetsListener(rahmen) { v, i ->
            val s = i.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = i.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(s.left, s.top, s.right, maxOf(s.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        // Rauchtest (CI, über adb): Entwicklerwerkzeuge der Oberfläche einschalten – erreichbar nur über adb, nicht aus dem Netz
        if (intent?.getBooleanExtra("aw_test", false) == true) WebView.setWebContentsDebuggingEnabled(true)
        val (w, neu) = WebHalter.holen(this) { k -> webBauen(k) }
        web = w
        rahmen.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        if (neu) {
            if (Einstellungen.server.isEmpty()) startseite(null) else serverLaden()
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack() && !web.url.orEmpty().startsWith(START)) web.goBack()
                else moveTaskToBack(true)   // nicht beenden – die Musik läuft weiter
            }
        })

        if (Build.VERSION.SDK_INT >= 33 && !Einstellungen.benachrichtigungGefragt &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Einstellungen.benachrichtigungGefragt = true
            benachrichtigungErlaubnis.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (Einstellungen.server.isNotEmpty()) Aktualisierung.pruefen(this)
    }

    fun serverLaden() {
        web.loadUrl(Einstellungen.server + "/")
    }

    /** Startseite: Adresse eingeben (fehler = Adresse, die gerade nicht erreichbar war) */
    fun startseite(fehler: String?) {
        web.loadUrl(START + (fehler?.let { "?fehler=" + Uri.encode(it) } ?: ""))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun webBauen(k: Context): WebView {
        val w = WebView(k)
        w.setBackgroundColor(Color.parseColor("#120d0a"))
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false   // der nächste Titel startet ohne Tippen
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = userAgentString + " AmberwaveAndroid/" + BuildConfig.VERSION_NAME
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        // Läuft Musik, soll Android die Oberfläche nicht drosseln (Lückenlos-Puffer, nächster Titel)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROCESS)) {
            runCatching { w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false) }
        }
        w.addJavascriptInterface(Bruecke(applicationContext) { aktiv }, "AwAndroid")

        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = Oberflaeche.abfangen(request)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "file") return false
                if (Einstellungen.istServer(u)) return false
                // Downloads über die Direktadresse im Heimnetz gehen an den DownloadListener
                if ((u.scheme == "http" || u.scheme == "https") && (u.path ?: "").startsWith("/api/v1/download/")) return false
                val a = aktiv ?: return true
                runCatching { a.startActivity(Intent(Intent.ACTION_VIEW, u)) }.onFailure { if (it is ActivityNotFoundException) Toast.makeText(a, u.toString(), Toast.LENGTH_SHORT).show() }
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                WebHalter.seite = url
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                WebHalter.seite = url
            }

            override fun onPageFinished(view: WebView, url: String) {
                WebHalter.seite = url
                CookieManager.getInstance().flush()
                val u = Uri.parse(url)
                if (Einstellungen.istServer(u) && Oberflaeche.appSeite(u.path ?: "/")) Oberflaeche.huelleMerken(url)
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // Server nicht erreichbar und noch keine Hülle für den Start ohne Netz: Startseite mit Hinweis
                if (request.isForMainFrame && Einstellungen.istServer(request.url)) aktiv?.startseite(Einstellungen.server)
            }
        }

        w.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, rueckruf: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                val a = aktiv ?: return false
                a.dateiRueckruf?.onReceiveValue(null)
                a.dateiRueckruf = rueckruf
                return runCatching { a.dateiWahl.launch(p.createIntent()); true }.getOrElse { a.dateiRueckruf = null; false }
            }
        }

        // „Datei herunterladen“: die echte Datei in den Musik-Ordner des Handys (für andere Apps sichtbar)
        w.setDownloadListener { url, agent, inhalt, mime, _ ->
            runCatching {
                val name = dateiname(url, inhalt, mime)
                val r = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("User-Agent", agent)
                    .setTitle(name)
                    .setMimeType(mime)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_MUSIC, "Amberwave/$name")
                CookieManager.getInstance().getCookie(url)?.let { r.addRequestHeader("Cookie", it) }
                k.applicationContext.getSystemService(DownloadManager::class.java).enqueue(r)
                Toast.makeText(k.applicationContext, k.getString(R.string.datei_laedt, name), Toast.LENGTH_SHORT).show()
            }.onFailure { Toast.makeText(k.applicationContext, k.getString(R.string.datei_fehler), Toast.LENGTH_LONG).show() }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        return w
    }

    /** Dateiname aus Content-Disposition (auch filename*=UTF-8''…), sonst geraten */
    private fun dateiname(url: String, inhalt: String?, mime: String?): String {
        val roh = inhalt?.let {
            Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1)?.let { n -> URLDecoder.decode(n, "UTF-8") }
                ?: Regex("filename=\"?([^\";]+)\"?", RegexOption.IGNORE_CASE).find(it)?.groupValues?.get(1)
        } ?: URLUtil.guessFileName(url, inhalt, mime)
        return roh.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().ifEmpty { "Amberwave" }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        aktiv = this
    }

    override fun onDestroy() {
        if (aktiv === this) aktiv = null
        rahmen.removeView(web)
        // Läuft Musik oder ein Download, bleibt die Oberfläche (an der App hängend) am Leben – sonst aufräumen
        if (isFinishing && !Medien.spielt) WebHalter.zerstoeren() else WebHalter.loesen(applicationContext)
        super.onDestroy()
    }
}
