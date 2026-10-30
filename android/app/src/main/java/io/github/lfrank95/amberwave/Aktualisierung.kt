package io.github.lfrank95.amberwave

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import java.io.File

/**
 * Neue Version auf GitHub? Dann fragen, laden und Android zum Installieren übergeben (Android fragt selbst noch einmal).
 * Höchstens zweimal am Tag; eine abgelehnte Version wird nicht noch einmal angeboten.
 */
object Aktualisierung {
    private const val TAG = "AwUpdate"
    private const val RELEASES = "https://api.github.com/repos/lfrank95/amberwave/releases?per_page=15"

    fun pruefen(a: Activity, vonHand: Boolean = false) {
        if (!vonHand && System.currentTimeMillis() - Einstellungen.updateGeprueft < 12 * 3600_000L) return
        Einstellungen.updateGeprueft = System.currentTimeMillis()
        Thread {
            val neu = runCatching { neuste() }.onFailure { Log.w(TAG, "prüfen", it) }.getOrNull()
            a.runOnUiThread {
                if (a.isFinishing) return@runOnUiThread
                if (neu == null || !Version.neuer(neu.first, BuildConfig.VERSION_NAME)) {
                    if (vonHand) Toast.makeText(a, a.getString(R.string.update_aktuell), Toast.LENGTH_SHORT).show()
                    return@runOnUiThread
                }
                if (!vonHand && neu.first == Einstellungen.updateAusgelassen) return@runOnUiThread
                AlertDialog.Builder(a)
                    .setTitle(a.getString(R.string.update_titel, neu.first))
                    .setMessage(a.getString(R.string.update_text, BuildConfig.VERSION_NAME))
                    .setPositiveButton(R.string.update_installieren) { _, _ -> laden(a, neu.first, neu.second) }
                    .setNegativeButton(R.string.update_spaeter) { _, _ -> Einstellungen.updateAusgelassen = neu.first }
                    .show()
            }
        }.start()
    }

    /** Neuste Version mit Android-App: (Version, Download-Adresse) */
    private fun neuste(): Pair<String, String>? {
        val c = Netz.oeffnen(RELEASES, 10000, 15000, mitCookie = false)
        c.setRequestProperty("Accept", "application/vnd.github+json")
        val text = try { if (c.responseCode == 200) c.inputStream.bufferedReader().readText() else return null } finally { c.disconnect() }
        var best: Pair<String, String>? = null
        val liste = JSONArray(text)
        for (i in 0 until liste.length()) {
            val r = liste.getJSONObject(i)
            if (r.optBoolean("draft")) continue
            val assets = r.optJSONArray("assets") ?: continue
            for (j in 0 until assets.length()) {
                val asset = assets.getJSONObject(j)
                val m = Regex("^Amberwave-Android-(.+)\\.apk$").find(asset.optString("name")) ?: continue
                val v = m.groupValues[1]
                if (best == null || Version.neuer(v, best.first)) best = v to asset.optString("browser_download_url")
            }
        }
        return best
    }

    private fun laden(a: Activity, version: String, url: String) {
        // Erlaubnis „Unbekannte Apps installieren“ für Amberwave – sonst erst dorthin
        if (!a.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(a, a.getString(R.string.update_erlaubnis), Toast.LENGTH_LONG).show()
            a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}")))
            return
        }
        val ordner = a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return
        val datei = File(ordner, "Amberwave-$version.apk")
        ordner.listFiles()?.filter { it.name.endsWith(".apk") }?.forEach { it.delete() }
        val dm = a.getSystemService(DownloadManager::class.java)
        val id = dm.enqueue(DownloadManager.Request(Uri.parse(url))
            .setTitle("Amberwave $version")
            .setMimeType("application/vnd.android.package-archive")
            .setDestinationUri(Uri.fromFile(datei))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE))
        Toast.makeText(a, a.getString(R.string.update_laedt), Toast.LENGTH_SHORT).show()
        val app = a.applicationContext
        ContextCompat.registerReceiver(app, object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                if (i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return
                runCatching { app.unregisterReceiver(this) }
                if (!datei.exists() || datei.length() < 100_000) {
                    Toast.makeText(app, app.getString(R.string.update_fehler), Toast.LENGTH_LONG).show()
                    return
                }
                val uri = FileProvider.getUriForFile(app, "${app.packageName}.dateien", datei)
                app.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED)
    }
}
