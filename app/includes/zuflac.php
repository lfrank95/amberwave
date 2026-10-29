<?php
declare(strict_types=1);
require_once __DIR__ . '/uebernehmen.php';
require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/auftrag.php';

/*
 * Verlustfreie Titel, die nicht FLAC sind (WAV, AIFF, ALAC), in FLAC umwandeln: gleiche Bittiefe, Abtastrate und Kanäle.
 * Vor dem Ersetzen werden Original und FLAC dekodiert und ihre Audio-Prüfsummen verglichen (ue_zu_flac) – nur wenn sie
 * Sample für Sample gleich sind, kommt die FLAC an die Stelle des Originals; das Original wandert in den Papierkorb
 * (.amberwave-papierkorb, gelöscht nach AUFRAEUMEN_PAPIERKORB_TAGE). Der Datenbankeintrag bleibt derselbe (zeigt nur auf
 * die neue Datei): Verlauf, Lautheit, Favoriten und Playlists bleiben. Tags und Cover kommen aus der Datenbank.
 * Pro Album (Albummenü) oder für die ganze Bibliothek (Verwaltung → Bibliothek → Werkzeuge), als Hintergrundauftrag „flac“.
 */

/** ganzzahliges PCM – lässt sich bitgenau als FLAC speichern (Gleitkomma nicht) */
const ZF_PCM = ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_u8', 'pcm_s8'];

/** Art einer Datei: 'ja' (umwandelbar), 'nein' (verlustfrei, aber nicht als FLAC speicherbar) oder null (betrifft nicht) */
function zf_art(array $d): ?string
{
    $f = strtolower((string) $d['format']);
    $c = strtolower((string) $d['codec']);
    if (in_array($f, ['wav', 'aif', 'aiff'], true)) {
        return in_array($c, ZF_PCM, true) && (int) $d['bittiefe'] <= 32 && (int) $d['kanaele'] <= 8 ? 'ja' : 'nein';
    }
    if (in_array($f, ['m4a', 'mp4'], true) && $c === 'alac') {
        return (int) $d['kanaele'] <= 8 ? 'ja' : 'nein';
    }
    return null;
}

/** Warum nicht? (für die Anzeige) */
function zf_grund(array $d): string
{
    $c = strtolower((string) $d['codec']);
    if (str_starts_with($c, 'pcm_f')) {
        return t('Gleitkomma ({bits} Bit) – lässt sich nicht verlustfrei als FLAC speichern', ['bits' => (int) $d['bittiefe']]);
    }
    if ((int) $d['kanaele'] > 8) {
        return t('mehr als 8 Kanäle – FLAC kann höchstens 8');
    }
    return t('Format {codec} wird nicht umgewandelt', ['codec' => $c]);
}

/** Kandidaten (eine Edition oder alle): ['ja' => [...], 'nein' => [...]] mit Album/Titel für die Anzeige */
function zf_kandidaten(?int $editionId = null): array
{
    $wo = "(d.format IN ('wav', 'aif', 'aiff') OR (d.format IN ('m4a', 'mp4') AND d.codec = 'alac')) AND d.track_id IS NOT NULL";
    $p = [];
    if ($editionId !== null) {
        $wo .= ' AND m.edition_id = :e';
        $p['e'] = $editionId;
    }
    $aus = ['ja' => [], 'nein' => []];
    foreach (db_alle("SELECT d.id, d.pfad, d.format, d.codec, d.bittiefe, d.abtastrate, d.kanaele, d.groesse, t.titel, t.pos, m.edition_id, e.album_id, al.titel AS album
            FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id
            LEFT JOIN alben al ON al.id = e.album_id WHERE {$wo} ORDER BY al.titel, m.pos, t.pos", $p) as $d) {
        $art = zf_art($d);
        if ($art === null) {
            continue;
        }
        $z = ['id' => (int) $d['id'], 'pfad' => $d['pfad'], 'titel' => $d['titel'], 'album' => (string) $d['album'], 'album_id' => (int) $d['album_id'],
            'edition_id' => (int) $d['edition_id'], 'format' => $d['codec'] === 'alac' ? 'ALAC' : strtoupper((string) $d['format']),
            'bittiefe' => (int) $d['bittiefe'], 'abtastrate' => (int) $d['abtastrate'], 'groesse' => (int) $d['groesse']];
        if ($art === 'nein') {
            $z['grund'] = zf_grund($d);
        }
        $aus[$art][] = $z;
    }
    return $aus;
}

/** Für die Oberfläche: Kandidaten, Schreibrechte, Auftrag */
function zf_stand(?int $editionId = null): array
{
    require_once __DIR__ . '/aufraeumen.php';
    $k = zf_kandidaten($editionId);
    $alben = [];
    foreach ($k['ja'] as $z) {
        $alben[$z['edition_id']] ??= ['edition_id' => $z['edition_id'], 'album_id' => $z['album_id'], 'album' => $z['album'], 'titel' => 0, 'groesse' => 0, 'formate' => []];
        $alben[$z['edition_id']]['titel']++;
        $alben[$z['edition_id']]['groesse'] += $z['groesse'];
        $alben[$z['edition_id']]['formate'][$z['format']] = true;
    }
    foreach ($alben as &$a) {
        $a['formate'] = array_keys($a['formate']);
    }
    unset($a);
    $s = af_schreibtest();
    return ['alben' => array_values($alben), 'titel' => count($k['ja']), 'groesse' => array_sum(array_column($k['ja'], 'groesse')),
        'nicht' => $k['nein'], 'schreiben' => ['ok' => $s['ok'], 'meldung' => $s['meldung']], 'auftrag' => auftrag_aussen('flac')];
}

/** Auftrag starten: eine Edition oder alles */
function zf_starten(?int $editionId): array
{
    $alt = auftrag_zustand('flac');
    if ($alt['status'] === 'laeuft') {
        throw new ApiFehler(t('Es läuft schon eine Umwandlung.'));
    }
    require_once __DIR__ . '/aufraeumen.php';
    $s = af_schreibtest();
    if (!$s['ok']) {
        throw new ApiFehler($s['meldung']);
    }
    $ids = array_column(zf_kandidaten($editionId)['ja'], 'id');
    if (!$ids) {
        throw new ApiFehler(t('Hier gibt es nichts umzuwandeln.'));
    }
    return auftrag_beginnen('flac', ['art' => $editionId !== null ? 'edition' : 'alle', 'edition_id' => $editionId, 'ids' => $ids, 'gesamt' => count($ids),
        'probleme' => []], false);
}

/** Schritt des Hintergrundauftrags: Dateien nacheinander, höchstens ~20 s je Schritt */
function auftrag_schritt_flac(array $z): array
{
    $ids = array_values($z['ids'] ?? []);
    $probleme = $z['probleme'] ?? [];
    $start = microtime(true);
    $fertig = 0;
    $ok = 0;
    while ($ids && microtime(true) - $start < 20) {
        $id = (int) array_shift($ids);
        $fertig++;
        try {
            zf_datei_umwandeln($id);
            $ok++;
        } catch (Throwable $ex) {
            $d = db_zeile('SELECT pfad FROM dateien WHERE id = :i', ['i' => $id]);
            $probleme[] = ['pfad' => (string) ($d['pfad'] ?? t('Datei {id}', ['id' => $id])), 'text' => $ex->getMessage()];
        }
    }
    $r = ['zaehler' => ['geprueft' => $fertig, 'geaendert' => $ok], 'setzen' => ['ids' => $ids, 'probleme' => array_slice($probleme, -50)]];
    if (!$ids) {
        $n = (int) $z['geaendert'] + $ok;
        $r['fertig'] = true;
        $r['meldung'] = tn($n, '1 Titel in FLAC umgewandelt, Originale im Papierkorb.', '{n} Titel in FLAC umgewandelt, Originale im Papierkorb.')
            . ($probleme ? ' ' . t('{n} nicht umgewandelt (siehe Liste).', ['n' => count($probleme)]) : '');
    }
    return $r;
}

/** Eine Datei umwandeln und ersetzen (wirft bei Problemen; das Original bleibt dann unverändert) */
function zf_datei_umwandeln(int $dateiId): void
{
    $d = db_zeile('SELECT d.*, m.edition_id FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE d.id = :i', ['i' => $dateiId]);
    if (!$d) {
        throw new RuntimeException(t('Datei nicht mehr in der Bibliothek.'));
    }
    if (zf_art($d) !== 'ja') {
        throw new RuntimeException(zf_grund($d));
    }
    $wurzel = af_wurzel();
    $rel = (string) $d['pfad'];
    $von = $wurzel . '/' . $rel;
    if (!is_file($von)) {
        throw new RuntimeException(t('Datei fehlt im Musikordner.'));
    }
    if (!is_writable(dirname($von))) {
        throw new RuntimeException(t('Keine Schreibrechte im Ordner.'));
    }
    // Ziel: gleicher Name mit .flac; gibt es den schon, mit Zusatz
    $basis = preg_replace('/\.[^.\/]+$/', '', $rel);
    $neuRel = $basis . '.flac';
    for ($n = 2; file_exists($wurzel . '/' . $neuRel); $n++) {
        $neuRel = $basis . " ({$n}).flac";
    }
    $nach = $wurzel . '/' . $neuRel;
    $eid = (int) $d['edition_id'];
    $e = db_zeile('SELECT * FROM editionen WHERE id = :e', ['e' => $eid]);
    $soll = tags_fuer_edition($eid)[(int) $d['track_id']] ?? [];
    // als versteckte Datei umwandeln (das Einlesen überspringt Punkt-Dateien), prüfen, taggen, dann umbenennen
    $tmp = dirname($von) . '/.aw-flac-' . bin2hex(random_bytes(4)) . '.flac';
    try {
        ue_zu_flac($von, $tmp, true);   // vergleicht die Audio-Prüfsummen; wirft, wenn sie nicht gleich sind
        af_datei_rechte($tmp);
        if ($soll) {
            datei_tags_schreiben($tmp, $soll, $e ? af_cover($e) : null);
        }
        musik_schreibschutz($nach);
        if (!@rename($tmp, $nach)) {
            throw new RuntimeException(t('Umbenennen fehlgeschlagen.'));
        }
    } finally {
        if (is_file($tmp)) {
            @unlink($tmp);
        }
    }
    af_datei_rechte($nach);
    // Original in den Papierkorb; klappt das nicht, die neue FLAC wieder weg (nichts doppelt)
    try {
        $korb = af_in_papierkorb($rel, 'flac-umwandlung');
    } catch (Throwable $ex) {
        @unlink($nach);
        throw new RuntimeException(t('Original ließ sich nicht in den Papierkorb legen: {grund}', ['grund' => $ex->getMessage()]));
    }
    // Datenbankeintrag auf die neue Datei umstellen (gleiche Zeile: Lautheit, Verlauf, Verknüpfungen bleiben)
    clearstatcache(true, $nach);
    $info = datei_lesen($nach);
    $tech = ($info['technik'] ?? []) + ['format' => 'flac', 'codec' => 'flac', 'bitrate' => 0];
    db_tun('UPDATE dateien SET pfad_hash = :h, pfad = :p, groesse = :g, mtime = :m, format = :f, codec = :c, bitrate = :br, tags_json = :tj, bild_eingebettet = :be, fehler = :fe WHERE id = :id', [
        'h' => hash('sha256', $neuRel), 'p' => $neuRel, 'g' => filesize($nach), 'm' => filemtime($nach),
        'f' => mb_substr((string) $tech['format'], 0, 10), 'c' => mb_substr((string) $tech['codec'], 0, 30), 'br' => (int) $tech['bitrate'],
        'tj' => json_encode(scan_tags_fuer_db($info['tags'] ?? []), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
        'be' => !empty($info['hat_bild']) ? 1 : 0, 'fe' => mb_substr((string) ($info['fehler'] ?? ''), 0, 300), 'id' => $dateiId,
    ]);
    edition_kennzahlen($eid);
    if ($e && $e['album_id']) {
        album_anzeige_aktualisieren((int) $e['album_id']);
    }
    af_protokoll($eid, 'umgewandelt', $rel, $neuRel, t('Verlustfrei in FLAC umgewandelt (Audio geprüft), Original im Papierkorb: {korb}', ['korb' => $korb]));
}
