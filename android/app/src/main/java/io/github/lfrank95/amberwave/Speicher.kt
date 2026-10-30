package io.github.lfrank95.amberwave

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * Der eigene Speicher der App (nur sie kommt dran, Android räumt ihn nicht weg – erst beim Deinstallieren):
 *  - kv:        Angaben der Oberfläche zu gespeicherten Titeln und Sammlungen (JSON, wie zuvor in IndexedDB)
 *  - dateien:   offline gespeicherte Titel (Datei, Größe, exakte Länge, Format, Qualität)
 *  - auftraege: was noch geladen werden soll (überlebt Neustart und geschlossene App)
 *  - bilder:    Cover gespeicherter Alben (ohne Netz)
 *  - statisch:  Dateien der Oberfläche (Skripte, Stile, Schriften) – damit die App ohne Netz startet
 */
object Speicher {
    private lateinit var db: SQLiteDatabase
    lateinit var wurzel: File
        private set

    val offlineOrdner get() = File(wurzel, "offline").apply { mkdirs() }
    val bilderOrdner get() = File(wurzel, "bilder").apply { mkdirs() }
    val oberflaecheOrdner get() = File(wurzel, "oberflaeche").apply { mkdirs() }
    val huelleDatei get() = File(wurzel, "huelle.html")

    @Synchronized
    fun init(c: Context) {
        if (::db.isInitialized) return
        wurzel = c.applicationContext.filesDir
        db = object : SQLiteOpenHelper(c.applicationContext, "amberwave.db", null, 1) {
            override fun onCreate(d: SQLiteDatabase) {
                d.execSQL("CREATE TABLE kv (store TEXT NOT NULL, schluessel TEXT NOT NULL, wert TEXT NOT NULL, PRIMARY KEY (store, schluessel))")
                d.execSQL("CREATE TABLE dateien (id INTEGER PRIMARY KEY, datei TEXT NOT NULL, bytes INTEGER NOT NULL, dauer REAL NOT NULL, format TEXT NOT NULL, q TEXT NOT NULL, gespeichert INTEGER NOT NULL)")
                d.execSQL("CREATE TABLE auftraege (id INTEGER PRIMARY KEY, pfad TEXT NOT NULL, q TEXT NOT NULL, name TEXT NOT NULL, ersetzen INTEGER NOT NULL DEFAULT 0, versuche INTEGER NOT NULL DEFAULT 0, angelegt INTEGER NOT NULL)")
                d.execSQL("CREATE TABLE bilder (schluessel TEXT PRIMARY KEY, datei TEXT NOT NULL, typ TEXT NOT NULL)")
                d.execSQL("CREATE TABLE statisch (schluessel TEXT PRIMARY KEY, pfad TEXT NOT NULL, datei TEXT NOT NULL, typ TEXT NOT NULL)")
            }

            override fun onUpgrade(d: SQLiteDatabase, alt: Int, neu: Int) {}
        }.writableDatabase
    }

    fun hash(s: String): String = MessageDigest.getInstance("SHA-1").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    // ---------- kv ----------
    @Synchronized
    fun kvAlle(store: String): String {
        val a = JSONArray()
        db.rawQuery("SELECT wert FROM kv WHERE store = ?", arrayOf(store)).use { c ->
            while (c.moveToNext()) runCatching { a.put(JSONObject(c.getString(0))) }
        }
        return a.toString()
    }

    @Synchronized
    fun kvSetzen(store: String, schluessel: String, wert: String) {
        db.insertWithOnConflict("kv", null, ContentValues().apply { put("store", store); put("schluessel", schluessel); put("wert", wert) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    @Synchronized
    fun kvLoeschen(store: String, schluessel: String) {
        db.delete("kv", "store = ? AND schluessel = ?", arrayOf(store, schluessel))
    }

    // ---------- Dateien ----------
    data class Datei(val id: Long, val datei: File, val bytes: Long, val dauer: Double, val format: String, val q: String)

    @Synchronized
    fun dateien(): String {
        val o = JSONObject()
        db.rawQuery("SELECT id, datei, bytes, dauer, format, q FROM dateien", null).use { c ->
            while (c.moveToNext()) {
                if (!File(offlineOrdner, c.getString(1)).exists()) continue
                o.put(c.getLong(0).toString(), JSONObject().put("bytes", c.getLong(2)).put("dauer", c.getDouble(3)).put("format", c.getString(4)).put("q", c.getString(5)))
            }
        }
        return o.toString()
    }

    @Synchronized
    fun datei(id: Long): Datei? = db.rawQuery("SELECT datei, bytes, dauer, format, q FROM dateien WHERE id = ?", arrayOf(id.toString())).use { c ->
        if (!c.moveToFirst()) null else Datei(id, File(offlineOrdner, c.getString(0)), c.getLong(1), c.getDouble(2), c.getString(3), c.getString(4))
    }

    @Synchronized
    fun dateiEintragen(id: Long, name: String, bytes: Long, dauer: Double, format: String, q: String) {
        val alt = datei(id)
        db.insertWithOnConflict("dateien", null, ContentValues().apply {
            put("id", id); put("datei", name); put("bytes", bytes); put("dauer", dauer); put("format", format); put("q", q); put("gespeichert", System.currentTimeMillis())
        }, SQLiteDatabase.CONFLICT_REPLACE)
        if (alt != null && alt.datei.name != name) alt.datei.delete()
    }

    @Synchronized
    fun dateiLoeschen(id: Long) {
        datei(id)?.datei?.delete()
        db.delete("dateien", "id = ?", arrayOf(id.toString()))
        db.delete("auftraege", "id = ?", arrayOf(id.toString()))
        File(offlineOrdner, "$id.teil").delete()
    }

    @Synchronized
    fun allesLoeschen() {
        db.delete("dateien", null, null)
        db.delete("auftraege", null, null)
        db.delete("kv", null, null)
        db.delete("bilder", null, null)
        offlineOrdner.listFiles()?.forEach { it.delete() }
        bilderOrdner.listFiles()?.forEach { it.delete() }
    }

    /** Belegter Platz der Offline-Titel */
    @Synchronized
    fun belegt(): Long = db.rawQuery("SELECT COALESCE(SUM(bytes), 0) FROM dateien", null).use { c -> if (c.moveToFirst()) c.getLong(0) else 0 }

    // ---------- Aufträge ----------
    data class Auftrag(val id: Long, val pfad: String, val q: String, val name: String, val ersetzen: Boolean, val versuche: Int)

    /** Neue Aufträge (vorhandene werden aufgefrischt, z. B. andere Qualität); schon gespeicherte nur mit „ersetzen“ */
    @Synchronized
    fun auftraegeEintragen(liste: JSONArray): Int {
        var n = 0
        for (i in 0 until liste.length()) {
            val a = liste.optJSONObject(i) ?: continue
            val id = a.optLong("id")
            val pfad = a.optString("pfad")
            if (id <= 0 || !pfad.startsWith("/api/")) continue
            val ersetzen = a.optBoolean("ersetzen")
            val vorhanden = datei(id)
            if (vorhanden != null && !ersetzen) continue
            if (vorhanden != null && vorhanden.q == a.optString("q")) continue
            db.insertWithOnConflict("auftraege", null, ContentValues().apply {
                put("id", id); put("pfad", pfad); put("q", a.optString("q", "opus256")); put("name", a.optString("name").take(200))
                put("ersetzen", if (ersetzen) 1 else 0); put("versuche", 0); put("angelegt", System.currentTimeMillis())
            }, SQLiteDatabase.CONFLICT_REPLACE)
            n++
        }
        return n
    }

    @Synchronized
    fun naechsterAuftrag(): Auftrag? = db.rawQuery("SELECT id, pfad, q, name, ersetzen, versuche FROM auftraege ORDER BY angelegt, id LIMIT 1", null).use { c ->
        if (!c.moveToFirst()) null else Auftrag(c.getLong(0), c.getString(1), c.getString(2), c.getString(3), c.getInt(4) == 1, c.getInt(5))
    }

    @Synchronized
    fun auftraegeOffen(): Int = db.rawQuery("SELECT COUNT(*) FROM auftraege", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }

    @Synchronized
    fun auftragDa(id: Long): Boolean = db.rawQuery("SELECT 1 FROM auftraege WHERE id = ?", arrayOf(id.toString())).use { it.moveToFirst() }

    @Synchronized
    fun auftragFertig(id: Long) {
        db.delete("auftraege", "id = ?", arrayOf(id.toString()))
    }

    /** Fehlversuch: nach hinten in der Schlange */
    @Synchronized
    fun auftragVersuch(id: Long) {
        db.execSQL("UPDATE auftraege SET versuche = versuche + 1, angelegt = ? WHERE id = ?", arrayOf<Any>(System.currentTimeMillis(), id))
    }

    @Synchronized
    fun auftraegeLeeren() {
        db.delete("auftraege", null, null)
    }

    // ---------- Bilder ----------
    @Synchronized
    fun bild(schluessel: String): Pair<File, String>? = db.rawQuery("SELECT datei, typ FROM bilder WHERE schluessel = ?", arrayOf(schluessel)).use { c ->
        if (!c.moveToFirst()) null else File(bilderOrdner, c.getString(0)).takeIf { it.exists() }?.let { it to c.getString(1) }
    }

    @Synchronized
    fun bildEintragen(schluessel: String, datei: String, typ: String) {
        db.insertWithOnConflict("bilder", null, ContentValues().apply { put("schluessel", schluessel); put("datei", datei); put("typ", typ) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    // ---------- Oberfläche ----------
    @Synchronized
    fun statisch(schluessel: String): Pair<File, String>? = db.rawQuery("SELECT datei, typ FROM statisch WHERE schluessel = ?", arrayOf(schluessel)).use { c ->
        if (!c.moveToFirst()) null else File(oberflaecheOrdner, c.getString(0)).takeIf { it.exists() }?.let { it to c.getString(1) }
    }

    /** Neue Fassung einer Datei: ältere Fassungen desselben Pfads (anderes ?v=) fliegen raus */
    @Synchronized
    fun statischEintragen(schluessel: String, pfad: String, datei: String, typ: String) {
        db.rawQuery("SELECT datei FROM statisch WHERE pfad = ? AND schluessel != ?", arrayOf(pfad, schluessel)).use { c ->
            while (c.moveToNext()) File(oberflaecheOrdner, c.getString(0)).delete()
        }
        db.delete("statisch", "pfad = ? AND schluessel != ?", arrayOf(pfad, schluessel))
        db.insertWithOnConflict("statisch", null, ContentValues().apply { put("schluessel", schluessel); put("pfad", pfad); put("datei", datei); put("typ", typ) }, SQLiteDatabase.CONFLICT_REPLACE)
    }

    /** Nur noch diese Dateien der Oberfläche behalten (alte Fassungen gebündelter Stücke heißen anders und blieben sonst liegen) */
    @Synchronized
    fun statischBehalten(schluessel: Set<String>) {
        if (schluessel.size < 5) return   // unvollständige Liste: lieber nichts löschen
        val weg = mutableListOf<Pair<String, String>>()
        db.rawQuery("SELECT schluessel, datei FROM statisch", null).use { c -> while (c.moveToNext()) if (c.getString(0) !in schluessel) weg += c.getString(0) to c.getString(1) }
        for ((k, d) in weg) {
            File(oberflaecheOrdner, d).delete()
            db.delete("statisch", "schluessel = ?", arrayOf(k))
        }
    }

    /** Anderer Server: Oberfläche und Hülle des alten weg (die Offline-Musik gehört zum Konto – die räumt die Oberfläche selbst) */
    @Synchronized
    fun oberflaecheLeeren() {
        db.delete("statisch", null, null)
        oberflaecheOrdner.listFiles()?.forEach { it.delete() }
        huelleDatei.delete()
    }
}
