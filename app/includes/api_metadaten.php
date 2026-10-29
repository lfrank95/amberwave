<?php
declare(strict_types=1);
require_once __DIR__ . '/api_bibliothek.php';
require_once __DIR__ . '/musicbrainz.php';
require_once __DIR__ . '/scanner.php';
require_once __DIR__ . '/fanart.php';
require_once __DIR__ . '/einstellungen.php';

/**
 * Metadaten bearbeiten (nur Admin): Alben, Editionen, Künstler, Mitwirkende – und der Abgleich mit MusicBrainz.
 * Jede manuelle Änderung kann ein Feld "sperren": Spätere Abgleiche und Scans überschreiben es dann nicht mehr.
 */

const ALBUM_FELDER_SPERRBAR = ['titel', 'kuenstler', 'typ', 'jahr', 'genres', 'beschreibung'];
const EDITION_FELDER_SPERRBAR = ['titel', 'kuenstler', 'datum', 'land', 'kommentar'];
const KUENSTLER_FELDER_SPERRBAR = ['name', 'sortname', 'typ', 'unterscheidung', 'land', 'beginn', 'ende', 'bio'];

function sperren_eingabe(array $erlaubt): ?string
{
    $g = api_wert('gesperrt');
    if (!is_array($g)) {
        return null;
    }
    return implode(',', array_values(array_intersect($erlaubt, array_map('strval', $g))));
}

function mb_fehler_umwandeln(callable $fn)
{
    try {
        return $fn();
    } catch (MbFehler $e) {
        throw new ApiFehler($e->getMessage(), 502);
    }
}

// ---------- Albenliste für die Verwaltung ----------

function api_admin_alben(): array
{
    $p = [];
    $wo = ['1=1'];
    $filter = (string) ($_GET['filter'] ?? 'alle');
    if ($filter === 'ohne_mb') {
        $wo[] = "a.mb_ohne = 0 AND EXISTS (SELECT 1 FROM editionen e2 WHERE e2.album_id = a.id AND e2.quelle = 'tags')";
    } elseif ($filter === 'eigen') {
        $wo[] = 'a.mb_ohne = 1';
    } elseif ($filter === 'mit_mb') {
        $wo[] = "NOT EXISTS (SELECT 1 FROM editionen e2 WHERE e2.album_id = a.id AND e2.quelle = 'tags')";
    } elseif ($filter === 'ohne_cover') {
        $wo[] = "e.cover_datei = ''";
    } elseif ($filter === 'mehrere') {
        $wo[] = '(SELECT COUNT(*) FROM editionen e3 WHERE e3.album_id = a.id) > 1';
    } elseif ($filter === 'unvollstaendig') {
        $wo[] = 'e.anzahl_dateien < e.anzahl_tracks';
    }
    $q = trim((string) ($_GET['q'] ?? ''));
    if ($q !== '') {
        $wo[] = such_bedingung($q, 'a.suchtext', $p);
    }
    // Eingrenzen: Dateiformat und Jahrzehnt (der Erstveröffentlichung)
    $format = (string) ($_GET['format'] ?? '');
    if ($format === 'flac') {
        $wo[] = "e.beste_qualitaet LIKE 'FLAC%'";
    } elseif ($format === 'mp3') {
        $wo[] = "e.beste_qualitaet LIKE 'MP3%'";
    } elseif ($format === 'sonst') {
        $wo[] = "(e.beste_qualitaet NOT LIKE 'FLAC%' AND e.beste_qualitaet NOT LIKE 'MP3%')";
    }
    $dekade = api_int('dekade', 0);
    if ($dekade >= 1900 && $dekade <= 2090) {
        $wo[] = $dekade >= 2000 ? 'a.erstjahr >= 2000' : "a.erstjahr BETWEEN {$dekade} AND " . ($dekade + 9);
    }
    $sort = (string) ($_GET['sort'] ?? 'offen');
    $reihenfolge = match ($sort) {
        'titel' => 'a.titel',
        'jahr' => '(a.erstjahr IS NULL), a.erstjahr, a.titel',
        'neu' => 'a.id DESC',
        default => "(a.quelle = 'tags') DESC, a.titel",
    };
    $pro = max(1, min(200, api_int('pro_seite', 60)));
    $seite = max(1, api_int('seite', 1));
    $bed = implode(' AND ', $wo);
    $gesamt = (int) db_wert("SELECT COUNT(*) FROM alben a LEFT JOIN editionen e ON e.id = a.anzeige_edition_id WHERE {$bed}", $p);
    $zeilen = db_alle("SELECT a.id, a.titel, a.credit_id, a.typ, a.erstjahr, a.mbid, a.quelle, a.mb_ohne, a.mb_abgleich_am, e.id AS edition_id, e.cover_datei, e.anzahl_tracks, e.anzahl_dateien,
            e.beste_qualitaet, e.ordner, e.quelle AS ed_quelle,
            (SELECT COUNT(*) FROM editionen e3 WHERE e3.album_id = a.id) AS editionen
        FROM alben a LEFT JOIN editionen e ON e.id = a.anzeige_edition_id WHERE {$bed}
        ORDER BY {$reihenfolge} LIMIT {$pro} OFFSET " . (($seite - 1) * $pro), $p);
    $credits = credit_listen(array_column($zeilen, 'credit_id'));
    return ['gesamt' => $gesamt, 'seite' => $seite, 'pro_seite' => $pro, 'alben' => array_map(static fn($z) => [
        'id' => (int) $z['id'], 'titel' => $z['titel'], 'kuenstler' => $credits[(int) $z['credit_id']] ?? [], 'typ' => $z['typ'], 'jahr' => $z['erstjahr'] !== null ? (int) $z['erstjahr'] : null,
        'mbid' => $z['mbid'], 'abgeglichen' => $z['ed_quelle'] === 'musicbrainz', 'abgleich_am' => iso($z['mb_abgleich_am']),
        'edition_id' => $z['edition_id'] !== null ? (int) $z['edition_id'] : null, 'cover' => bild_url('cover', $z['cover_datei'], 300),
        'tracks' => (int) $z['anzahl_tracks'], 'dateien' => (int) $z['anzahl_dateien'], 'qualitaet' => $z['beste_qualitaet'], 'ordner' => $z['ordner'],
        'editionen' => (int) $z['editionen'], 'eigen' => (int) $z['mb_ohne'] === 1,
    ], $zeilen), 'zahlen' => [
        'ohne_mb' => (int) db_wert("SELECT COUNT(DISTINCT e.album_id) FROM editionen e JOIN alben a ON a.id = e.album_id WHERE e.quelle = 'tags' AND a.mb_ohne = 0"),
        'eigen' => (int) db_wert('SELECT COUNT(*) FROM alben WHERE mb_ohne = 1'),
        'alle' => (int) db_wert('SELECT COUNT(*) FROM alben'),
        'ohne_cover' => (int) db_wert("SELECT COUNT(*) FROM alben a JOIN editionen e ON e.id = a.anzeige_edition_id WHERE e.cover_datei = ''"),
        'mehrere' => (int) db_wert('SELECT COUNT(*) FROM alben a WHERE (SELECT COUNT(*) FROM editionen e3 WHERE e3.album_id = a.id) > 1'),
        'unvollstaendig' => (int) db_wert('SELECT COUNT(*) FROM alben a JOIN editionen e ON e.id = a.anzeige_edition_id WHERE e.anzahl_dateien < e.anzahl_tracks'),
    ]];
}

/** Alben als „kein Treffer bei MusicBrainz, so lassen“ markieren bzw. wieder freigeben. Eingabe: {"ids":[…], "wert":true|false} */
function api_admin_alben_markieren(): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', (array) api_wert('ids')), static fn($i) => $i > 0)));
    if (!$ids || count($ids) > 1000) {
        throw new ApiFehler(t('Keine Alben ausgewählt.'), 422);
    }
    $wert = api_wert('wert') ? 1 : 0;
    $n = 0;
    foreach (array_chunk($ids, 200) as $teil) {
        [$in, $pin] = db_in($teil, 'a');
        $n += db_tun("UPDATE alben SET mb_ohne = {$wert} WHERE id IN {$in} AND mb_ohne <> {$wert}", $pin);
    }
    return ['geaendert' => $n, 'wert' => (bool) $wert];
}

// ---------- Album ----------

/** Rohdaten zum Bearbeiten (inkl. aller Editionen) */
function api_admin_album_bearbeiten(int $id): array
{
    $a = db_zeile('SELECT * FROM alben WHERE id = :id', ['id' => $id]);
    if (!$a) {
        throw new ApiFehler(t('Album nicht gefunden.'), 404);
    }
    $genres = array_column(db_alle('SELECT g.name FROM album_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.album_id = :a ORDER BY g.name', ['a' => $id]), 'name');
    $editionen = array_map(static fn($e) => [
        'id' => (int) $e['id'], 'mbid' => $e['mbid'], 'titel' => $e['titel'], 'datum' => $e['datum'], 'land' => $e['land'], 'kommentar' => $e['kommentar'],
        'format' => $e['format_text'], 'barcode' => $e['barcode'], 'ordner' => $e['ordner'], 'quelle' => $e['quelle'], 'tracks' => (int) $e['anzahl_tracks'],
        'dateien' => (int) $e['anzahl_dateien'], 'qualitaet' => $e['beste_qualitaet'], 'cover' => bild_url('cover', $e['cover_datei'], 300),
        'gesperrt' => gesperrte_felder($e['gesperrte_felder']), 'angezeigt' => (int) $e['id'] === (int) $a['anzeige_edition_id'],
        'abgleich_am' => iso($e['mb_abgleich_am']),
    ], db_alle('SELECT * FROM editionen WHERE album_id = :a ORDER BY datum, id', ['a' => $id]));
    return [
        'id' => (int) $a['id'], 'mbid' => $a['mbid'], 'titel' => $a['titel'], 'kuenstler' => credit_liste((int) $a['credit_id']), 'typ' => $a['typ'],
        'zusatz' => $a['zusatz_typen'] !== '' ? explode(',', $a['zusatz_typen']) : [], 'jahr' => $a['erstjahr'] !== null ? (int) $a['erstjahr'] : null,
        'beschreibung' => (string) $a['beschreibung'], 'beschreibung_quelle' => $a['beschreibung_quelle'], 'genres' => $genres, 'quelle' => $a['quelle'],
        'gesperrt' => gesperrte_felder($a['gesperrte_felder']), 'edition_wahl_id' => $a['edition_wahl_id'] !== null ? (int) $a['edition_wahl_id'] : null,
        'editionen' => $editionen,
    ];
}

function api_admin_album_speichern(array $admin, int $id): array
{
    $a = db_zeile('SELECT * FROM alben WHERE id = :id', ['id' => $id]);
    if (!$a) {
        throw new ApiFehler(t('Album nicht gefunden.'), 404);
    }
    $titel = trim((string) api_wert('titel', $a['titel']));
    if ($titel === '') {
        throw new ApiFehler(t('Der Titel darf nicht leer sein.'));
    }
    $typ = (string) api_wert('typ', $a['typ']);
    if (!in_array($typ, ['album', 'single', 'ep', 'broadcast', 'sonstiges'], true)) {
        throw new ApiFehler(t('Ungültiger Album-Typ.'));
    }
    $erlaubt_zusatz = ['compilation', 'soundtrack', 'live', 'remix', 'dj-mix', 'mixtape/street', 'demo', 'spokenword', 'interview', 'audiobook', 'audio drama', 'field recording'];
    $zusatz = api_wert('zusatz');
    $zusatz = is_array($zusatz) ? implode(',', array_intersect($erlaubt_zusatz, array_map('strval', $zusatz))) : $a['zusatz_typen'];
    $jahr = api_wert('jahr', $a['erstjahr']);
    $jahr = ($jahr === null || $jahr === '') ? null : (int) $jahr;
    if ($jahr !== null && ($jahr < 1000 || $jahr > 2200)) {
        throw new ApiFehler(t('Bitte ein gültiges Jahr angeben.'));
    }
    $sperren = sperren_eingabe(ALBUM_FELDER_SPERRBAR) ?? $a['gesperrte_felder'];
    $beschreibung = api_wert('beschreibung', $a['beschreibung']);
    db_tun('UPDATE alben SET titel = :t, typ = :ty, zusatz_typen = :z, erstjahr = :j, beschreibung = :b, beschreibung_quelle = :bq, beschreibung_maschinell = :bm, gesperrte_felder = :g WHERE id = :id', [
        't' => mb_substr($titel, 0, 500), 'ty' => $typ, 'z' => $zusatz, 'j' => $jahr,
        'b' => $beschreibung !== null && trim((string) $beschreibung) !== '' ? mb_substr((string) $beschreibung, 0, 20000) : null,
        'bq' => (string) $beschreibung !== (string) $a['beschreibung'] ? 'manuell' : $a['beschreibung_quelle'],
        'bm' => (string) $beschreibung !== (string) $a['beschreibung'] ? 0 : (int) $a['beschreibung_maschinell'],
        'g' => $sperren, 'id' => $id,
    ]);
    $genres = api_wert('genres');
    if (is_array($genres)) {
        db_tun('DELETE FROM album_genres WHERE album_id = :a', ['a' => $id]);
        foreach (array_slice($genres, 0, 20) as $g) {
            $g = trim((string) $g);
            if ($g !== '' && mb_strlen($g) <= 60 && ($gid = genre_holen($g))) {
                db_tun("INSERT IGNORE INTO album_genres (album_id, genre_id, quelle) VALUES (:a, :g, 'manuell')", ['a' => $id, 'g' => $gid]);
            }
        }
    }
    // Albumkünstler neu setzen: Liste von Namen (+ Verbindungswort)
    $k = api_wert('kuenstler');
    if (is_array($k) && $k && ($c = credit_aus_eingabe($k))) {
        db_tun('UPDATE alben SET credit_id = :c WHERE id = :a', ['c' => $c, 'a' => $id]);
    }
    if ($a['quelle'] === 'tags') {
        db_tun("UPDATE alben SET quelle = 'manuell' WHERE id = :a", ['a' => $id]); // vom Scan nicht mehr überschreiben
    }
    album_suchtext_aktualisieren($id);
    log_sicherheitsereignis((int) $admin['id'], 'album_bearbeitet', '#' . $id);
    return api_admin_album_bearbeiten($id);
}

// ---------- Edition ----------

function edition_laden(int $id): array
{
    $e = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $id]);
    if (!$e) {
        throw new ApiFehler(t('Edition nicht gefunden.'), 404);
    }
    return $e;
}

/** Edition mit Dateien – Kopf der Abgleich-Seite */
function api_admin_edition(int $id): array
{
    $e = edition_laden($id);
    $a = db_zeile('SELECT * FROM alben WHERE id = :a', ['a' => $e['album_id']]);
    $tracks = edition_tracks_fuer_vergleich($id);
    $mit_datei = array_values(array_filter($tracks, static fn($t) => $t['datei'] !== null));
    $kuenstler = credit_liste((int) ($e['credit_id'] ?: $a['credit_id']));
    return [
        'id' => (int) $e['id'], 'album_id' => (int) $e['album_id'], 'album_titel' => $a['titel'], 'album_mbid' => $a['mbid'], 'mbid' => $e['mbid'],
        'titel' => $e['titel'], 'kuenstler' => $kuenstler, 'kuenstler_text' => implode('', array_map(static fn($k) => $k['name'] . $k['verbindung'], $kuenstler)),
        'datum' => $e['datum'], 'jahr' => $e['jahr'] !== null ? (int) $e['jahr'] : null, 'land' => $e['land'], 'barcode' => $e['barcode'], 'kommentar' => $e['kommentar'],
        'ordner' => $e['ordner'], 'quelle' => $e['quelle'], 'abgleich_am' => iso($e['mb_abgleich_am']), 'qualitaet' => $e['beste_qualitaet'],
        'format' => $e['format_text'], 'status' => $e['status'],
        'labels' => array_map(static fn($l) => ['name' => (string) $l['name'], 'katalognummer' => $l['katalognummer']],
            db_alle('SELECT COALESCE(l.name, \'\') AS name, el.katalognummer FROM edition_labels el LEFT JOIN labels l ON l.id = el.label_id WHERE el.edition_id = :e ORDER BY el.id', ['e' => $id])),
        'angezeigt' => (int) $e['id'] === (int) $a['anzeige_edition_id'], 'editionen_im_album' => (int) db_wert('SELECT COUNT(*) FROM editionen WHERE album_id = :a', ['a' => $e['album_id']]),
        'cover' => bild_url('cover', $e['cover_datei'], 300), 'cover_quelle' => $e['cover_quelle'], 'gesperrt' => gesperrte_felder($e['gesperrte_felder']),
        'medien' => count(array_unique(array_map(static fn($t) => (int) $t['disc'], $mit_datei))) ?: 1,
        'tracks' => array_map(static fn($t) => ['id' => (int) $t['id'], 'disc' => (int) $t['disc'], 'pos' => (int) $t['pos'], 'titel' => $t['titel'],
            'laenge_ms' => (int) ($t['datei_ms'] ?? $t['laenge_ms'] ?? 0), 'datei' => $t['datei'] !== null ? basename((string) $t['datei']) : null], $tracks),
        'dateien' => count($mit_datei),
    ];
}

function api_admin_edition_speichern(array $admin, int $id): array
{
    $e = edition_laden($id);
    $titel = trim((string) api_wert('titel', $e['titel']));
    if ($titel === '') {
        throw new ApiFehler(t('Der Titel darf nicht leer sein.'));
    }
    $datum = datum_eingabe((string) api_wert('datum', $e['datum']));
    if ($datum === null) {
        throw new ApiFehler(t('Datum bitte als TT.MM.JJJJ, MM.JJJJ oder JJJJ angeben.'));
    }
    db_tun('UPDATE editionen SET titel = :t, datum = :d, jahr = :j, land = :l, kommentar = :k, barcode = :b, format_text = :f, gesperrte_felder = :g WHERE id = :id', [
        't' => mb_substr($titel, 0, 500), 'd' => $datum, 'j' => $datum !== '' ? (int) substr($datum, 0, 4) : null,
        'l' => mb_substr(strtoupper(trim((string) api_wert('land', $e['land']))), 0, 10), 'k' => mb_substr(trim((string) api_wert('kommentar', $e['kommentar'])), 0, 255),
        'b' => mb_substr(preg_replace('/[^0-9A-Za-z]/', '', (string) api_wert('barcode', $e['barcode'])), 0, 40),
        'f' => mb_substr(trim((string) api_wert('format', $e['format_text'])), 0, 120),
        'g' => sperren_eingabe(EDITION_FELDER_SPERRBAR) ?? $e['gesperrte_felder'], 'id' => $id,
    ]);
    // Labels und Katalognummern (nur wenn mitgeschickt): ersetzen die bisherigen
    $labels = api_wert('labels');
    if (is_array($labels)) {
        db_tun('DELETE FROM edition_labels WHERE edition_id = :e', ['e' => $id]);
        foreach (array_slice($labels, 0, 12) as $l) {
            $name = trim((string) ($l['name'] ?? ''));
            $kat = mb_substr(trim((string) ($l['katalognummer'] ?? '')), 0, 100);
            if ($name === '' && $kat === '') {
                continue;
            }
            db_tun('INSERT INTO edition_labels (edition_id, label_id, katalognummer) VALUES (:e, :l, :k)', ['e' => $id, 'l' => label_holen($name), 'k' => $kat]);
        }
    }
    log_sicherheitsereignis((int) $admin['id'], 'edition_bearbeitet', '#' . $id);
    return api_admin_edition($id);
}

/** Sind unterhalb von $abs noch Musikdateien? */
function ordner_hat_musik(string $abs, array $typen): bool
{
    if (!is_dir($abs)) {
        return false;
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($abs, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if ($f->isFile() && in_array(strtolower($f->getExtension()), $typen, true)) {
            return true;
        }
    }
    return false;
}

/**
 * Edition löschen. Mit Dateien: Die Musikdateien (und, wenn danach keine Musik mehr im Ordner liegt, auch Cover und Beilagen)
 * wandern in den Papierkorb im Musikordner (AUFRAEUMEN_PAPIERKORB_TAGE), sonst käme die Edition beim nächsten Scan zurück.
 * Ohne Dateien (z. B. nur von MusicBrainz angelegt) wird nur der Eintrag entfernt.
 * Eingabe: {"dateien":"papierkorb"} – ist Pflicht, sobald die Edition Dateien hat.
 */
function api_admin_edition_loeschen(array $admin, int $id): array
{
    require_once __DIR__ . '/aufraeumen.php';
    $e = edition_laden($id);
    $albumId = (int) $e['album_id'];
    $dateien = db_alle('SELECT d.id, d.pfad FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $id]);
    $verschoben = 0;
    if ($dateien) {
        if (api_wert('dateien') !== 'papierkorb') {
            throw new ApiFehler(t('Diese Edition hat Dateien. Sie können nur zusammen mit dem Verschieben in den Papierkorb gelöscht werden.'));
        }
        $test = af_schreibtest();
        if (!$test['ok']) {
            throw new ApiFehler(t('Die Dateien können nicht in den Papierkorb verschoben werden: {grund}', ['grund' => $test['meldung']]));
        }
        $wurzel = af_wurzel();
        $fehler = [];
        $erledigt = [];
        foreach ($dateien as $d) {
            $rel = (string) $d['pfad'];
            if ($rel === '' || str_contains($rel, '..') || !is_file($wurzel . '/' . $rel)) {
                $erledigt[] = (int) $d['id']; // Datei ist schon weg
                continue;
            }
            try {
                af_in_papierkorb($rel, 'geloescht');
                $erledigt[] = (int) $d['id'];
                $verschoben++;
            } catch (Throwable $x) {
                $fehler[] = $rel . ' – ' . $x->getMessage();
            }
        }
        if ($erledigt) {
            [$in, $pp] = db_in($erledigt);
            db_tun("DELETE FROM dateien WHERE id IN {$in}", $pp);
        }
        if ($fehler) {
            af_log('Edition löschen: Dateien nicht verschoben', ['edition' => $id, 'fehler' => array_slice($fehler, 0, 10)]);
            throw new ApiFehler(tn(count($fehler), 'Eine Datei konnte nicht verschoben werden (Rechte?), die Edition bleibt bestehen. Erstes Beispiel: {bsp}', '{n} Dateien konnten nicht verschoben werden (Rechte?), die Edition bleibt bestehen. Erstes Beispiel: {bsp}', ['bsp' => $fehler[0]]));
        }
        // Liegt im Ordner keine Musik mehr, wandern Cover, Booklets & Co. ebenfalls in den Papierkorb und der leere Ordner verschwindet
        $ordner = trim((string) $e['ordner'], '/');
        $papierkorb = trim(AF_PAPIERKORB, '/');
        if ($ordner !== '' && !str_contains($ordner, '..') && $ordner !== $papierkorb && !str_starts_with($ordner, $papierkorb . '/')
                && is_dir($wurzel . '/' . $ordner) && !ordner_hat_musik($wurzel . '/' . $ordner, konfig()['scan']['dateitypen'])) {
            $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($wurzel . '/' . $ordner, FilesystemIterator::SKIP_DOTS));
            $reste = [];
            foreach ($it as $f) {
                if ($f->isFile()) {
                    $reste[] = ltrim(substr($f->getPathname(), strlen($wurzel)), '/');
                }
            }
            foreach ($reste as $rel) {
                try {
                    af_in_papierkorb($rel, 'geloescht');
                } catch (Throwable $x) {
                    af_log('Edition löschen: Beilage nicht verschoben', ['datei' => $rel, 'fehler' => $x->getMessage()]);
                }
            }
            af_leere_ordner_weg($ordner);
        }
    }
    edition_loeschen($id);
    db_tun('UPDATE alben SET edition_wahl_id = NULL WHERE id = :a AND edition_wahl_id = :e', ['a' => $albumId, 'e' => $id]);
    $albumWeg = false;
    if (!db_wert('SELECT 1 FROM editionen WHERE album_id = :a LIMIT 1', ['a' => $albumId])) {
        db_tun('DELETE FROM alben WHERE id = :a', ['a' => $albumId]);
        geloescht_merken('album', $albumId);
        $albumWeg = true;
    } else {
        album_anzeige_aktualisieren($albumId);
    }
    bibliothek_aufraeumen();
    log_sicherheitsereignis((int) $admin['id'], 'edition_geloescht', '#' . $id . ' (' . $verschoben . ' Dateien im Papierkorb)');
    return ['ok' => true, 'album_id' => $albumId, 'album_geloescht' => $albumWeg, 'verschoben' => $verschoben];
}

/** Cover hochladen (Feld "bild") oder aus dem Cover Art Archive laden ({"quelle":"musicbrainz"}) oder zurücksetzen ({"quelle":"datei"}) */
function api_admin_edition_cover(array $admin, int $id): array
{
    $e = edition_laden($id);
    $quelle = (string) api_wert('quelle', '');
    if ($quelle === 'musicbrainz') {
        if (!ist_uuid($e['mbid'])) {
            throw new ApiFehler(t('Die Edition ist noch nicht mit MusicBrainz abgeglichen.'));
        }
        if (!mb_cover_laden($id, (string) $e['mbid'])) {
            throw new ApiFehler(t('Bei MusicBrainz (Cover Art Archive) ist für diese Edition kein Cover vorhanden.'), 404);
        }
    } elseif ($quelle === 'datei') {
        db_tun("UPDATE editionen SET cover_quelle = '', cover_signatur = '' WHERE id = :id", ['id' => $id]);
        $dateien = db_alle('SELECT d.pfad, d.bild_eingebettet FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $id]);
        $liste = array_map(static fn($d) => ['rel' => $d['pfad'], 'hat_bild' => (bool) $d['bild_eingebettet']], $dateien);
        scan_cover_pruefen($id, $e['ordner'] !== '' ? $e['ordner'] : '.', $liste, konfig()['pfade']['musik']);
    } else {
        if (empty($_FILES['bild']['tmp_name']) || ($_FILES['bild']['error'] ?? 1) !== UPLOAD_ERR_OK) {
            throw new ApiFehler(t('Bitte ein Bild auswählen (JPG, PNG oder WebP).'));
        }
        if ((int) $_FILES['bild']['size'] > 20 * 1024 * 1024) {
            throw new ApiFehler(t('Das Bild ist zu groß (max. 20 MB).'));
        }
        $daten = (string) file_get_contents((string) $_FILES['bild']['tmp_name']);
        $schluessel = bild_speichern('cover', 'e' . $id, $daten);
        if (!$schluessel) {
            throw new ApiFehler(t('Das Bild konnte nicht gelesen werden.'));
        }
        if ($e['cover_datei'] !== '' && $e['cover_datei'] !== $schluessel) {
            bild_loeschen('cover', $e['cover_datei']);
        }
        db_tun("UPDATE editionen SET cover_datei = :c, cover_quelle = 'manuell', cover_signatur = 'manuell' WHERE id = :id", ['c' => $schluessel, 'id' => $id]);
    }
    log_sicherheitsereignis((int) $admin['id'], 'cover_geaendert', '#' . $id . ' ' . ($quelle ?: 'upload'));
    return api_admin_edition($id);
}

// ---------- MusicBrainz-Abgleich ----------

function api_admin_mb_suche(int $editionId): array
{
    $info = api_admin_edition($editionId);
    $titel = trim((string) ($_GET['titel'] ?? $info['album_titel']));
    $kuenstler = trim((string) ($_GET['kuenstler'] ?? $info['kuenstler_text']));
    if ($kuenstler === 'Various Artists' || $kuenstler === '[unbekannt]') {
        $kuenstler = ''; // Sampler: nur nach dem Titel suchen
    }
    return mb_fehler_umwandeln(static function () use ($titel, $kuenstler, $info) {
        $rg = (($_GET['ohne_rg'] ?? '') === '1') ? null : $info['album_mbid'];
        $r = mb_editionen_suchen($titel, $kuenstler, $rg);
        $r = mb_kandidaten_bewerten($r, [
            'titel' => $titel, 'kuenstler' => $kuenstler, 'tracks' => $info['dateien'], 'jahr' => $info['jahr'], 'medien' => $info['medien'],
            'barcode' => (string) $info['barcode'], 'mbid' => (string) ($info['mbid'] ?? ''),
        ]);
        return $r + ['suche' => ['titel' => $titel, 'kuenstler' => $kuenstler]];
    });
}

/** Von Hand angepasste Zuordnung aus der Anfrage: { "<track_id>": <MusicBrainz-Index oder null>, … } – oder null, wenn automatisch */
function api_mb_zuordnung(): ?array
{
    $z = api_wert('zuordnung', null);
    if (!is_array($z)) {
        return null;
    }
    $aus = [];
    foreach ($z as $tid => $mi) {
        if (!is_numeric($tid) || (int) $tid <= 0 || count($aus) >= 3000) {
            continue;
        }
        $aus[(int) $tid] = ($mi === null || $mi === '' || !is_numeric($mi) || (int) $mi < 0) ? null : (int) $mi;
    }
    return $aus;
}

function api_admin_mb_vergleich(int $editionId, string $mbid): array
{
    edition_laden($editionId);
    $zuordnung = api_mb_zuordnung();
    return mb_fehler_umwandeln(static function () use ($editionId, $mbid, $zuordnung) {
        $rel = mb_edition_laden($mbid);
        $v = mb_vergleich($editionId, $rel, $zuordnung);
        $rg = $rel['release-group'] ?? [];
        $mitwirkende = 0;
        foreach ($rel['media'] ?? [] as $m) {
            foreach ($m['tracks'] ?? [] as $t) {
                foreach ($t['recording']['relations'] ?? [] as $r) {
                    if (($r['target-type'] ?? '') === 'artist') {
                        $mitwirkende++;
                    } elseif (($r['target-type'] ?? '') === 'work') {
                        $mitwirkende += count(array_filter($r['work']['relations'] ?? [], static fn($x) => ($x['target-type'] ?? '') === 'artist'));
                    }
                }
            }
        }
        foreach ($rel['relations'] ?? [] as $r) {
            if (($r['target-type'] ?? '') === 'artist') {
                $mitwirkende++;
            }
        }
        return [
            'edition' => mb_edition_kurz($rel) + ['album' => ['mbid' => $rg['id'] ?? null, 'titel' => $rg['title'] ?? '', 'typ' => mb_album_typ($rg)[0],
                'erst' => (string) ($rg['first-release-date'] ?? '')]],
            'vergleich' => $v,
            'mitwirkende' => $mitwirkende,
            'cover_moeglich' => !empty($rel['cover-art-archive']['front']),
            'cover_mb' => !empty($rel['cover-art-archive']['front']) ? '/api/v1/admin/mb-cover/' . strtolower((string) $rel['id']) . '?g=500' : null,
            'genres' => array_map(static fn($g) => mb_genre_name((string) $g['name']), array_slice($rel['genres'] ?? [], 0, 8)),
            'link' => 'https://musicbrainz.org/release/' . $rel['id'],
        ];
    });
}

function api_admin_mb_uebernehmen(array $admin, int $editionId): array
{
    $mbid = (string) api_wert('mbid', '');
    if (!ist_uuid($mbid)) {
        throw new ApiFehler(t('Ungültige MusicBrainz-ID.'));
    }
    $cover = (string) api_wert('cover', 'fehlend');
    if (!in_array($cover, ['fehlend', 'immer', 'nie'], true)) {
        $cover = 'fehlend';
    }
    set_time_limit(300);
    $zuordnung = api_mb_zuordnung();
    $loesen = $zuordnung !== null && (bool) api_wert('sperren_loesen', false);
    $r = mb_fehler_umwandeln(static fn() => mb_edition_uebernehmen($editionId, $mbid, $cover, $zuordnung, $loesen));
    log_sicherheitsereignis((int) $admin['id'], 'musicbrainz_uebernommen', '#' . $editionId . ' ' . $mbid . ($zuordnung !== null ? ' (Zuordnung von Hand)' : ''));
    // Gleich im Hintergrund nachholen: Daten und Bilder der (oft neuen) Künstler dieses Albums – Gäste, Produzenten, Mitglieder
    try {
        require_once __DIR__ . '/metadatenjob.php';
        mj_starten('auswahl', [(int) db_wert('SELECT album_id FROM editionen WHERE id = :e', ['e' => $editionId])], false, true);
    } catch (Throwable $e) {
        // läuft gerade die ganze Sammlung – die nimmt diese Künstler mit
    }
    // Vorschlag der Erkennung damit erledigt
    try {
        db_tun("UPDATE erkennung SET status = 'bestaetigt', mbid = :m WHERE edition_id = :e", ['m' => strtolower($mbid), 'e' => $editionId]);
    } catch (Throwable $e) {
        // Tabelle evtl. noch nicht migriert – egal
    }
    return ['ok' => true] + $r;
}

/** Verknüpfung lösen: Edition wird beim nächsten Scan wieder aus den Tags aufgebaut. */
function api_admin_mb_loesen(array $admin, int $editionId): array
{
    $e = edition_laden($editionId);
    db_tun("UPDATE editionen SET quelle = 'tags', mbid = NULL, mb_abgleich_am = NULL WHERE id = :id", ['id' => $editionId]);
    db_tun("DELETE FROM beziehungen WHERE zu_art = 'edition' AND zu_id = :e AND quelle = 'musicbrainz'", ['e' => $editionId]);
    // Dateien als geändert markieren, damit der Scan sie neu liest
    db_tun('UPDATE dateien SET mtime = 0 WHERE ordner_hash = :o', ['o' => $e['ordner_hash'] ?? '']);
    db_tun("DELETE FROM tracks WHERE datentraeger_id IN (SELECT id FROM datentraeger WHERE edition_id = :e) AND NOT EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = tracks.id)", ['e' => $editionId]);
    $lauf = scan_starten(false, (int) $admin['id']);
    log_sicherheitsereignis((int) $admin['id'], 'musicbrainz_geloest', '#' . $editionId);
    return ['ok' => true, 'lauf_id' => $lauf];
}

// ---------- Künstler ----------

function api_admin_kuenstler_bearbeiten(int $id): array
{
    $k = db_zeile('SELECT * FROM kuenstler WHERE id = :id', ['id' => $id]);
    if (!$k) {
        throw new ApiFehler(t('Künstler nicht gefunden.'), 404);
    }
    return [
        'id' => (int) $k['id'], 'mbid' => $k['mbid'], 'name' => $k['name'], 'sortname' => $k['sortname'], 'typ' => $k['typ'], 'unterscheidung' => $k['unterscheidung'],
        'land' => $k['land'], 'beginn' => $k['beginn'], 'ende' => $k['ende'], 'bio' => (string) $k['bio'], 'bio_quelle' => $k['bio_quelle'],
        'bio_maschinell' => (bool) $k['bio_maschinell'], 'bild' => bild_url('kuenstler', $k['bild_datei'], 300), 'quelle' => $k['quelle'],
        'gesperrt' => gesperrte_felder($k['gesperrte_felder']), 'abgleich_am' => iso($k['mb_abgleich_am']),
    ];
}

function api_admin_kuenstler_speichern(array $admin, int $id): array
{
    $k = db_zeile('SELECT * FROM kuenstler WHERE id = :id', ['id' => $id]);
    if (!$k) {
        throw new ApiFehler(t('Künstler nicht gefunden.'), 404);
    }
    $name = trim((string) api_wert('name', $k['name']));
    if ($name === '') {
        throw new ApiFehler(t('Der Name darf nicht leer sein.'));
    }
    $typ = api_wert('typ', $k['typ']);
    if ($typ !== null && $typ !== '' && !in_array($typ, ['person', 'gruppe', 'orchester', 'chor', 'figur', 'sonstiges'], true)) {
        throw new ApiFehler(t('Ungültiger Typ.'));
    }
    $beginn = datum_eingabe((string) api_wert('beginn', $k['beginn']));
    $ende = datum_eingabe((string) api_wert('ende', $k['ende']));
    if ($beginn === null || $ende === null) {
        throw new ApiFehler(t('Beginn/Ende bitte als TT.MM.JJJJ, MM.JJJJ oder JJJJ angeben.'));
    }
    $bio = api_wert('bio', $k['bio']);
    $bio_neu = (string) $bio !== (string) $k['bio'];
    db_tun('UPDATE kuenstler SET name = :n, name_norm = :nn, sortname = :s, typ = :t, unterscheidung = :u, land = :l, beginn = :b, ende = :e,
            bio = :bio, bio_quelle = :bq, bio_maschinell = :bm, gesperrte_felder = :g, quelle = IF(quelle = \'tags\', \'manuell\', quelle) WHERE id = :id', [
        'n' => mb_substr($name, 0, 500), 'nn' => name_norm($name) ?: mb_strtolower($name), 's' => mb_substr(($sn = trim((string) api_wert('sortname', $k['sortname']))) !== '' && !($sn === $k['sortname'] && $name !== $k['name']) ? $sn : sortname_aus($name), 0, 500),
        't' => $typ ?: null, 'u' => mb_substr(trim((string) api_wert('unterscheidung', $k['unterscheidung'])), 0, 255),
        'l' => mb_substr(strtoupper(trim((string) api_wert('land', $k['land']))), 0, 10), 'b' => $beginn, 'e' => $ende,
        'bio' => trim((string) $bio) !== '' ? mb_substr((string) $bio, 0, 20000) : null, 'bq' => $bio_neu ? 'manuell' : $k['bio_quelle'], 'bm' => $bio_neu ? 0 : (int) $k['bio_maschinell'],
        'g' => sperren_eingabe(KUENSTLER_FELDER_SPERRBAR) ?? $k['gesperrte_felder'], 'id' => $id,
    ]);
    log_sicherheitsereignis((int) $admin['id'], 'kuenstler_bearbeitet', '#' . $id);
    return api_admin_kuenstler_bearbeiten($id);
}

function api_admin_kuenstler_bild(array $admin, int $id): array
{
    $k = db_zeile('SELECT bild_datei FROM kuenstler WHERE id = :id', ['id' => $id]);
    if (!$k) {
        throw new ApiFehler(t('Künstler nicht gefunden.'), 404);
    }
    if (api_wert('entfernen')) {
        bild_loeschen('kuenstler', (string) $k['bild_datei']);
        db_tun("UPDATE kuenstler SET bild_datei = '', bild_quelle = '', bild_geprueft_am = NOW() WHERE id = :id", ['id' => $id]); // nicht gleich wieder automatisch holen
        return api_admin_kuenstler_bearbeiten($id);
    }
    if (empty($_FILES['bild']['tmp_name']) || ($_FILES['bild']['error'] ?? 1) !== UPLOAD_ERR_OK) {
        throw new ApiFehler(t('Bitte ein Bild auswählen (JPG, PNG oder WebP).'));
    }
    $schluessel = bild_speichern('kuenstler', 'k' . $id, (string) file_get_contents((string) $_FILES['bild']['tmp_name']));
    if (!$schluessel) {
        throw new ApiFehler(t('Das Bild konnte nicht gelesen werden.'));
    }
    if ($k['bild_datei'] !== '' && $k['bild_datei'] !== $schluessel) {
        bild_loeschen('kuenstler', (string) $k['bild_datei']);
    }
    db_tun("UPDATE kuenstler SET bild_datei = :b, bild_quelle = 'manuell' WHERE id = :id", ['b' => $schluessel, 'id' => $id]);
    return api_admin_kuenstler_bearbeiten($id);
}

function api_admin_kuenstler_mb_suche(int $id): array
{
    $k = db_zeile('SELECT name FROM kuenstler WHERE id = :id', ['id' => $id]);
    if (!$k) {
        throw new ApiFehler(t('Künstler nicht gefunden.'), 404);
    }
    $name = trim((string) ($_GET['name'] ?? $k['name']));
    return mb_fehler_umwandeln(static fn() => ['treffer' => mb_kuenstler_suchen($name), 'name' => $name]);
}

function api_admin_kuenstler_mb_uebernehmen(array $admin, int $id): array
{
    $mbid = api_wert('mbid');
    $r = mb_fehler_umwandeln(static fn() => mb_kuenstler_uebernehmen($id, is_string($mbid) && $mbid !== '' ? $mbid : null));
    log_sicherheitsereignis((int) $admin['id'], 'kuenstler_musicbrainz', '#' . $id);
    if (fanart_aktiv() && db_wert("SELECT 1 FROM kuenstler WHERE id = :id AND bild_quelle <> 'manuell'", ['id' => $id])) {
        $f = fanart_bild_holen($id, true);
        $r['log'][] = $f['meldung'];
    }
    return ['ok' => true, 'log' => $r['log'], 'kuenstler' => api_admin_kuenstler_bearbeiten($id)];
}

// ---------- Mitwirkende von Hand ----------

function api_admin_beziehungstypen(): array
{
    return ['typen' => array_map(static fn($z) => ['schluessel' => $z['schluessel'], 'name' => $z['name_de'], 'gruppe' => $z['gruppe']],
        db_alle("SELECT schluessel, name_de, gruppe FROM beziehungstypen WHERE gruppe <> 'band' AND schluessel NOT IN ('remix_of','cover_of') ORDER BY reihenfolge"))];
}

/** Mitwirkende eines Albums (Edition + Aufnahmen) als Liste mit IDs zum Bearbeiten */
function api_admin_mitwirkende(int $editionId): array
{
    edition_laden($editionId);
    $tracks = db_alle('SELECT t.id, t.titel, t.aufnahme_id, m.pos AS disc, t.pos FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e ORDER BY m.pos, t.pos', ['e' => $editionId]);
    $auf = array_values(array_unique(array_filter(array_map(static fn($t) => (int) $t['aufnahme_id'], $tracks))));
    [$in, $p] = db_in($auf ?: [0], 'a');
    $p['e'] = $editionId;
    $zeilen = db_alle("SELECT b.id, b.zu_art, b.zu_id, b.quelle, b.attribute, bt.schluessel, bt.name_de, k.id AS kid, k.name,
            (SELECT GROUP_CONCAT(i.name SEPARATOR ', ') FROM beziehung_instrumente bi JOIN instrumente i ON i.id = bi.instrument_id WHERE bi.beziehung_id = b.id) AS instr
        FROM beziehungen b JOIN beziehungstypen bt ON bt.id = b.typ_id JOIN kuenstler k ON k.id = b.von_id AND b.von_art = 'kuenstler'
        WHERE (b.zu_art = 'edition' AND b.zu_id = :e) OR (b.zu_art = 'aufnahme' AND b.zu_id IN {$in}) ORDER BY bt.reihenfolge, k.name", $p);
    return [
        'tracks' => array_map(static fn($t) => ['id' => (int) $t['id'], 'aufnahme_id' => $t['aufnahme_id'] !== null ? (int) $t['aufnahme_id'] : null, 'label' => $t['disc'] . '-' . $t['pos'], 'titel' => $t['titel']], $tracks),
        'eintraege' => array_map(static fn($z) => ['id' => (int) $z['id'], 'zu_art' => $z['zu_art'], 'zu_id' => (int) $z['zu_id'], 'quelle' => $z['quelle'],
            'rolle' => $z['name_de'], 'schluessel' => $z['schluessel'], 'kuenstler' => ['id' => (int) $z['kid'], 'name' => $z['name']], 'instrumente' => (string) $z['instr']], $zeilen),
    ] + api_admin_beziehungstypen();
}

function api_admin_mitwirkend_anlegen(array $admin, int $editionId): array
{
    edition_laden($editionId);
    $name = trim((string) api_wert('name', ''));
    $schluessel = (string) api_wert('rolle', '');
    if ($name === '' || !beziehungstyp_id($schluessel)) {
        throw new ApiFehler(t('Bitte Name und Rolle angeben.'));
    }
    $kid = (int) api_wert('kuenstler_id', 0);
    if (!$kid || !db_wert('SELECT id FROM kuenstler WHERE id = :k', ['k' => $kid])) {
        $kid = kuenstler_holen($name, null, '', 'manuell');
    }
    $instr = array_values(array_filter(array_map('trim', explode(',', (string) api_wert('instrumente', ''))), 'strlen'));
    $ziele = array_map('intval', (array) api_wert('aufnahmen', []));
    $n = 0;
    if (!$ziele) {
        beziehung_anlegen($schluessel, 'kuenstler', $kid, 'edition', $editionId, ['instrumente' => $instr, 'quelle' => 'manuell']);
        $n++;
    } else {
        foreach ($ziele as $aid) {
            $gehoert = db_wert('SELECT 1 FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e AND t.aufnahme_id = :a LIMIT 1', ['e' => $editionId, 'a' => $aid]);
            if ($gehoert) {
                beziehung_anlegen($schluessel, 'kuenstler', $kid, 'aufnahme', $aid, ['instrumente' => $instr, 'quelle' => 'manuell']);
                $n++;
            }
        }
    }
    log_sicherheitsereignis((int) $admin['id'], 'mitwirkende_ergaenzt', '#' . $editionId . ': ' . $name . ' (' . $schluessel . ') ×' . $n);
    return api_admin_mitwirkende($editionId);
}

function api_admin_mitwirkend_loeschen(array $admin, int $editionId, int $beziehungId): array
{
    edition_laden($editionId);
    db_tun('DELETE FROM beziehungen WHERE id = :id', ['id' => $beziehungId]);
    return api_admin_mitwirkende($editionId);
}

// ---------- Titel (Tracks) ----------

const TRACK_FELDER_SPERRBAR = ['titel', 'kuenstler', 'nummer'];

function track_laden(int $id): array
{
    $t = db_zeile('SELECT t.*, m.edition_id, m.pos AS disc, e.album_id, e.credit_id AS ed_credit, a.credit_id AS album_credit, a.titel AS album_titel
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id WHERE t.id = :id', ['id' => $id]);
    if (!$t) {
        throw new ApiFehler(t('Titel nicht gefunden.'), 404);
    }
    return $t;
}

/** Künstlerliste aus der Eingabe [{name, verbindung, id?}] in einen Credit umwandeln */
function credit_aus_eingabe(array $liste): ?int
{
    $teile = [];
    foreach (array_slice($liste, 0, 20) as $t) {
        $name = trim((string) ($t['name'] ?? ''));
        if ($name === '') {
            continue;
        }
        $kid = !empty($t['id']) && db_wert('SELECT id FROM kuenstler WHERE id = :i', ['i' => (int) $t['id']]) ? (int) $t['id'] : kuenstler_holen($name, null, '', 'manuell');
        if (in_array($kid, array_column($teile, 'kuenstler_id'), true)) {
            continue; // derselbe Künstler zweimal ergibt keinen Sinn
        }
        $teile[] = ['kuenstler_id' => $kid, 'name_als' => mb_substr($name, 0, 500), 'verbindung' => mb_substr((string) ($t['verbindung'] ?? ''), 0, 60)];
    }
    if ($teile) {
        $teile[count($teile) - 1]['verbindung'] = '';
    }
    return $teile ? credit_holen($teile, 'manuell') : null;
}

/** Datenträger (CD) einer Edition mit dieser Nummer – wird bei Bedarf angelegt (Format wie die erste CD) */
function datentraeger_fuer(int $editionId, int $disc): int
{
    $id = db_wert('SELECT id FROM datentraeger WHERE edition_id = :e AND pos = :p', ['e' => $editionId, 'p' => $disc]);
    if ($id) {
        return (int) $id;
    }
    $format = (string) (db_wert('SELECT format FROM datentraeger WHERE edition_id = :e ORDER BY pos LIMIT 1', ['e' => $editionId]) ?: '');
    return db_einfuegen('INSERT INTO datentraeger (edition_id, pos, format) VALUES (:e, :p, :f)', ['e' => $editionId, 'p' => $disc, 'f' => $format]);
}

/** Leer gewordene Datenträger einer Edition entfernen */
function datentraeger_leere_entfernen(int $editionId): void
{
    db_tun('DELETE FROM datentraeger WHERE edition_id = :e AND id NOT IN (SELECT datentraeger_id FROM tracks)', ['e' => $editionId]);
}

/**
 * Prüft, ob nach den Änderungen [track_id => [disc, pos]] zwei Titel derselben Edition dieselbe CD + Nummer hätten.
 * Wirft eine verständliche Meldung („CD 1, Nr. 3: „A“ und „B“).
 */
function track_nummern_pruefen(int $editionId, array $neu): void
{
    $belegt = [];
    foreach (db_alle('SELECT t.id, t.titel, t.pos, m.pos AS disc FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $editionId]) as $t) {
        [$disc, $pos] = $neu[(int) $t['id']] ?? [(int) $t['disc'], (int) $t['pos']];
        $k = $disc . '-' . $pos;
        if (isset($belegt[$k])) {
            throw new ApiFehler(t('CD {disc}, Nr. {pos} ist doppelt belegt: „{a}“ und „{b}“.', ['disc' => $disc, 'pos' => $pos, 'a' => $belegt[$k], 'b' => $t['titel']]));
        }
        $belegt[$k] = (string) $t['titel'];
    }
}

function api_admin_track(int $id): array
{
    $t = track_laden($id);
    $album_credit = (int) ($t['ed_credit'] ?: $t['album_credit']);
    $datei = db_zeile('SELECT pfad, format, abtastrate, bittiefe FROM dateien WHERE track_id = :t ORDER BY id LIMIT 1', ['t' => $id]);
    return [
        'id' => (int) $t['id'], 'mbid' => $t['mbid'], 'titel' => $t['titel'], 'nummer' => $t['nummer'], 'pos' => (int) $t['pos'], 'disc' => (int) $t['disc'],
        'kuenstler' => credit_liste((int) ($t['credit_id'] ?: $album_credit)), 'wie_album' => !$t['credit_id'] || (int) $t['credit_id'] === $album_credit,
        'album_kuenstler' => credit_liste($album_credit), 'album_id' => (int) $t['album_id'], 'album_titel' => $t['album_titel'], 'edition_id' => (int) $t['edition_id'],
        'gesperrt' => gesperrte_felder($t['gesperrte_felder'] ?? ''), 'datei' => $datei ? $datei['pfad'] : null,
        'explizit' => $t['explizit'] !== null ? (int) $t['explizit'] : null, 'explizit_quelle' => $t['explizit_quelle'], 'isrc' => $t['isrc'],
    ];
}

function track_suchtext(string $titel, ?int $credit): string
{
    return such_norm($titel, ...array_column(credit_liste($credit), 'name'));
}

function api_admin_track_speichern(array $admin, int $id): array
{
    $t = track_laden($id);
    $geaendert = [];
    $titel = trim((string) api_wert('titel', $t['titel']));
    if ($titel === '') {
        throw new ApiFehler(t('Der Titel darf nicht leer sein.'));
    }
    if ($titel !== $t['titel']) {
        $geaendert[] = 'titel';
    }
    $pos = (int) api_wert('pos', $t['pos']);
    if ($pos < 1 || $pos > 999) {
        throw new ApiFehler(t('Die Titelnummer muss zwischen 1 und 999 liegen.'));
    }
    $disc = (int) api_wert('disc', $t['disc']);
    if ($disc < 1 || $disc > 99) {
        throw new ApiFehler(t('Die CD-Nummer muss zwischen 1 und 99 liegen.'));
    }
    if ($pos !== (int) $t['pos'] || $disc !== (int) $t['disc']) {
        $geaendert[] = 'nummer';
        track_nummern_pruefen((int) $t['edition_id'], [$id => [$disc, $pos]]);
    }
    $credit = $t['credit_id'] !== null ? (int) $t['credit_id'] : null;
    $album_credit = (int) ($t['ed_credit'] ?: $t['album_credit']);
    if (api_wert('wie_album')) {
        if ($credit !== $album_credit) {
            $credit = $album_credit;
            $geaendert[] = 'kuenstler';
        }
    } elseif (is_array($k = api_wert('kuenstler')) && $k) {
        $neu = credit_aus_eingabe($k);
        if ($neu && $neu !== $credit) {
            $credit = $neu;
            $geaendert[] = 'kuenstler';
        }
    }
    $gesperrt = sperren_eingabe(TRACK_FELDER_SPERRBAR);
    $liste = $gesperrt !== null ? array_filter(explode(',', $gesperrt), 'strlen') : gesperrte_felder($t['gesperrte_felder'] ?? '');
    $liste = array_values(array_unique(array_merge($liste, $geaendert)));
    $dt = $disc !== (int) $t['disc'] ? datentraeger_fuer((int) $t['edition_id'], $disc) : (int) $t['datentraeger_id'];
    db_tun('UPDATE tracks SET titel = :t, nummer = IF(pos = :p2, nummer, :n), pos = :p, datentraeger_id = :d, credit_id = :c, suchtext = :s, gesperrte_felder = :g WHERE id = :id', [
        't' => mb_substr($titel, 0, 500), 'p' => $pos, 'p2' => $pos, 'n' => (string) $pos, 'd' => $dt, 'c' => $credit, 's' => track_suchtext($titel, $credit), 'g' => implode(',', $liste), 'id' => $id,
    ]);
    // Kennzeichnung „explizit“: 'auto' = wieder automatisch (Datei-Tag/Deezer), sonst 0/1/2 von Hand (geht allem vor)
    $ex = api_wert('explizit', null);
    if ($ex !== null) {
        if ($ex === 'auto') {
            if ($t['explizit_quelle'] === 'hand') {
                db_tun("UPDATE tracks SET explizit = NULL, explizit_quelle = '', explizit_am = NULL WHERE id = :id", ['id' => $id]);
                $geaendert[] = 'explizit';
            }
        } elseif (in_array((int) $ex, [0, 1, 2], true) && ((string) $t['explizit'] !== (string) (int) $ex || $t['explizit_quelle'] !== 'hand')) {
            db_tun("UPDATE tracks SET explizit = :x, explizit_quelle = 'hand' WHERE id = :id", ['x' => (int) $ex, 'id' => $id]);
            $geaendert[] = 'explizit';
        }
        edition_kennzahlen((int) $t['edition_id']);
    }
    datentraeger_leere_entfernen((int) $t['edition_id']);
    log_sicherheitsereignis((int) $admin['id'], 'titel_bearbeitet', '#' . $id . ($geaendert ? ' ' . implode(',', $geaendert) : ''));
    return api_admin_track($id);
}

/** Titelliste einer Edition auf einmal: [{id, titel, pos, disc}] – Geändertes wird automatisch geschützt */
function api_admin_edition_tracks_speichern(array $admin, int $editionId): array
{
    edition_laden($editionId);
    $eingabe = api_wert('tracks');
    if (!is_array($eingabe)) {
        throw new ApiFehler(t('Keine Titel übergeben.'));
    }
    // Erst alles prüfen, dann schreiben (Tauschen von Nummern geht so in einem Rutsch)
    $plan = [];
    $nummern = [];
    foreach (array_slice($eingabe, 0, 1000) as $e) {
        $id = (int) ($e['id'] ?? 0);
        $t = db_zeile('SELECT t.*, m.pos AS disc FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE t.id = :t AND m.edition_id = :e', ['t' => $id, 'e' => $editionId]);
        if (!$t) {
            continue;
        }
        $titel = trim((string) ($e['titel'] ?? $t['titel']));
        $pos = (int) ($e['pos'] ?? $t['pos']);
        $disc = (int) ($e['disc'] ?? $t['disc']);
        if ($pos < 1 || $pos > 999) {
            throw new ApiFehler(t('„{titel}“: Die Titelnummer muss zwischen 1 und 999 liegen.', ['titel' => $t['titel']]));
        }
        if ($disc < 1 || $disc > 99) {
            throw new ApiFehler(t('„{titel}“: Die CD-Nummer muss zwischen 1 und 99 liegen.', ['titel' => $t['titel']]));
        }
        $geaendert = [];
        if ($titel !== '' && $titel !== $t['titel']) {
            $geaendert[] = 'titel';
        } else {
            $titel = $t['titel'];
        }
        if ($pos !== (int) $t['pos'] || $disc !== (int) $t['disc']) {
            $geaendert[] = 'nummer';
        }
        $nummern[$id] = [$disc, $pos];
        if ($geaendert) {
            $plan[] = [$t, $titel, $pos, $disc, $geaendert];
        }
    }
    track_nummern_pruefen($editionId, $nummern);
    db()->beginTransaction();
    try {
        foreach ($plan as [$t, $titel, $pos, $disc, $geaendert]) {
            $dt = $disc !== (int) $t['disc'] ? datentraeger_fuer($editionId, $disc) : (int) $t['datentraeger_id'];
            $g = array_values(array_unique(array_merge(gesperrte_felder($t['gesperrte_felder'] ?? ''), $geaendert)));
            db_tun('UPDATE tracks SET titel = :t, nummer = IF(pos = :p2 AND datentraeger_id = :d2, nummer, :n), pos = :p, datentraeger_id = :d, suchtext = :s, gesperrte_felder = :g WHERE id = :id', [
                't' => mb_substr($titel, 0, 500), 'p' => $pos, 'p2' => $pos, 'd2' => $dt, 'n' => (string) $pos, 'd' => $dt,
                's' => track_suchtext($titel, $t['credit_id'] !== null ? (int) $t['credit_id'] : null), 'g' => implode(',', $g), 'id' => (int) $t['id'],
            ]);
        }
        datentraeger_leere_entfernen($editionId);
        db()->commit();
    } catch (Throwable $ex) {
        db()->rollBack();
        throw $ex;
    }
    log_sicherheitsereignis((int) $admin['id'], 'titelliste_bearbeitet', '#' . $editionId . ' ×' . count($plan));
    return ['ok' => true, 'geaendert' => count($plan)];
}

// ---------- fanart.tv ----------

function api_admin_kuenstler_fanart(array $admin, int $id): array
{
    $r = fanart_bild_holen($id, true);
    if (in_array($r['status'], ['fehler', 'aus', 'ohne_mbid'], true)) {
        throw new ApiFehler($r['meldung'], $r['status'] === 'fehler' ? 502 : 400);
    }
    return ['ok' => $r['status'] === 'ok', 'meldung' => $r['meldung'], 'kuenstler' => api_admin_kuenstler_bearbeiten($id)];
}

/** Cover, das MusicBrainz zu einer Edition hat (Vorschau im Abgleich) – direkt als Bild */
function api_admin_mb_cover(string $mbid): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    $c = mb_cover_vorschau($mbid, api_int('g', 250), ($_GET['art'] ?? '') === 'rg' ? 'release-group' : 'release');
    if (!$c) {
        throw new ApiFehler(t('Kein Cover bei MusicBrainz.'), 404);
    }
    header('Cache-Control: private, max-age=86400');
    header('Content-Type: ' . $c['mime']);
    header('Content-Length: ' . strlen($c['body']));
    echo $c['body'];
}

/** SQL-Bedingung: Edition (e) mit MusicBrainz-Verknüpfung, bei der etwas fehlt (Album = a) */
function metadaten_luecke_bedingung(): string
{
    return "e.mbid IS NOT NULL AND e.mbid <> '' AND (
        e.datum = '' OR e.land = '' OR e.barcode = '' OR e.format_text = '' OR e.status = '' OR e.cover_datei = ''
        OR NOT EXISTS (SELECT 1 FROM edition_labels el WHERE el.edition_id = e.id)
        OR a.erstjahr IS NULL OR a.erst_datum = ''
        OR NOT EXISTS (SELECT 1 FROM album_genres g WHERE g.album_id = a.id AND g.quelle = 'musicbrainz')
        OR e.mb_aufnahme_genres_am IS NULL" . metadaten_explizit_luecke() . ')';
}

/** Lücke „explizit“: Titel ohne Kennzeichnung, die Deezer noch nie oder vor längerer Zeit gefragt wurde */
function metadaten_explizit_luecke(): string
{
    if (!deezer_aktiv()) {
        return '';
    }
    $tage = max(1, (int) (konfig()['quellen']['deezer_wiederholen_tage'] ?? 30));
    return "
        OR EXISTS (SELECT 1 FROM datentraeger m2 JOIN tracks t2 ON t2.datentraeger_id = m2.id WHERE m2.edition_id = e.id AND t2.explizit IS NULL
            AND t2.explizit_quelle = '' AND (t2.explizit_am IS NULL OR t2.explizit_am < NOW() - INTERVAL {$tage} DAY))";
}

/** Stand des Sammelabgleichs (verknüpfte Editionen, bei denen etwas fehlt) */
function api_admin_metadaten_stand(): array
{
    $pos = (int) einstellung('metadaten_abgleich_pos');
    $b = metadaten_luecke_bedingung();
    $von = 'FROM editionen e JOIN alben a ON a.id = e.album_id WHERE ' . $b;
    return [
        'gesamt' => (int) db_wert("SELECT COUNT(*) FROM editionen e WHERE e.mbid IS NOT NULL AND e.mbid <> ''"),
        'luecken' => (int) db_wert("SELECT COUNT(*) {$von}"),
        'kuenstler_offen' => function_exists('mj_kuenstler_offen') ? mj_kuenstler_offen() : 0,
        'bilder_offen' => function_exists('mj_bilder_offen') ? mj_bilder_offen() : 0,
        'fanart_aktiv' => fanart_aktiv(),
        'pos' => $pos,
        'offen' => (int) db_wert("SELECT COUNT(*) {$von} AND e.id > :p", ['p' => $pos]),
    ];
}

/**
 * Füllt bei einer mit MusicBrainz verknüpften Edition (und ihrem Album) nur das aus, was fehlt:
 * Erscheinungsdatum, Land, Barcode, Format, Status, Label + Katalognummer, Cover, Erstveröffentlichung, Genres.
 * Vorhandenes (auch von Hand Eingetragenes) und geschützte Felder bleiben unberührt. Gibt die gefüllten Felder zurück.
 */
function metadaten_luecken_fuellen(array $ed): array
{
    $gefuellt = [];
    $rel = mb_edition_laden((string) $ed['mbid']);
    $rg = $rel['release-group'] ?? [];
    $a = db_zeile('SELECT * FROM alben WHERE id = :a', ['a' => $ed['album_id']]);
    $ag = gesperrte_felder($a['gesperrte_felder'] ?? '');
    $eg = gesperrte_felder($ed['gesperrte_felder'] ?? '');

    // Edition
    $setz = [];
    $p = ['id' => $ed['id']];
    $datum = mb_substr((string) ($rel['date'] ?? ''), 0, 10);
    if ($ed['datum'] === '' && $datum !== '' && !in_array('datum', $eg, true)) {
        $setz[] = 'datum = :datum';
        $p['datum'] = $datum;
        if ($ed['jahr'] === null && preg_match('/^(\d{4})/', $datum, $m)) {
            $setz[] = 'jahr = :jahr';
            $p['jahr'] = (int) $m[1];
        }
        $gefuellt[] = 'Datum';
    }
    $tab = [
        'land' => ['Land', mb_substr((string) ($rel['country'] ?? ''), 0, 10)],
        'barcode' => ['Barcode', mb_substr((string) ($rel['barcode'] ?? ''), 0, 40)],
        'format_text' => ['Format', mb_substr(mb_format_text($rel['media'] ?? []), 0, 120)],
        'status' => ['Status', mb_substr(strtolower((string) ($rel['status'] ?? '')), 0, 30)],
    ];
    foreach ($tab as $spalte => [$name, $wert]) {
        if ($ed[$spalte] === '' && $wert !== '' && !in_array($spalte === 'format_text' ? 'format' : $spalte, $eg, true)) {
            $setz[] = "{$spalte} = :{$spalte}";
            $p[$spalte] = $wert;
            $gefuellt[] = $name;
        }
    }
    if ($setz) {
        db_tun('UPDATE editionen SET ' . implode(', ', $setz) . ', mb_abgleich_am = NOW() WHERE id = :id', $p);
    }

    // Label + Katalognummer, nur wenn noch keins eingetragen ist
    if (!db_wert('SELECT 1 FROM edition_labels WHERE edition_id = :e LIMIT 1', ['e' => $ed['id']])) {
        $n = 0;
        foreach ($rel['label-info'] ?? [] as $li) {
            $kat = trim((string) ($li['catalog-number'] ?? ''));
            $kat = strtolower($kat) === '[none]' ? '' : $kat;
            $lid = !empty($li['label']['name']) ? label_holen((string) $li['label']['name'], $li['label']['id'] ?? null) : null;
            if ($lid || $kat !== '') {
                db_tun('INSERT INTO edition_labels (edition_id, label_id, katalognummer) VALUES (:e, :l, :k)', ['e' => $ed['id'], 'l' => $lid, 'k' => mb_substr($kat, 0, 60)]);
                $n++;
            }
        }
        if ($n) {
            $gefuellt[] = 'Label';
        }
    }

    // Cover
    if ($ed['cover_datei'] === '' && !empty($rel['cover-art-archive']['front']) && mb_cover_laden((int) $ed['id'], (string) $ed['mbid'])) {
        $gefuellt[] = 'Cover';
    }

    // Album: Erstveröffentlichung
    if (($a['erstjahr'] === null || $a['erst_datum'] === '') && !in_array('jahr', $ag, true)
        && !empty($rg['first-release-date']) && preg_match('/^(\d{4})/', (string) $rg['first-release-date'], $m)) {
        if ($a['erstjahr'] === null) {
            db_tun('UPDATE alben SET erstjahr = :j WHERE id = :a', ['j' => (int) $m[1], 'a' => $a['id']]);
        }
        if ($a['erst_datum'] === '') {
            db_tun('UPDATE alben SET erst_datum = :d WHERE id = :a', ['d' => mb_substr((string) $rg['first-release-date'], 0, 10), 'a' => $a['id']]);
        }
        $gefuellt[] = 'Erstveröffentlichung';
    }

    // Album: Genres, wenn von MusicBrainz noch keine da sind
    if (!in_array('genres', $ag, true) && !db_wert("SELECT 1 FROM album_genres WHERE album_id = :a AND quelle = 'musicbrainz' LIMIT 1", ['a' => $a['id']])) {
        $genres = mb_album_genres($rel, $rg, false);
        if ($genres) {
            album_genres_von_mb_setzen((int) $a['id'], $genres);
            $gefuellt[] = 'Genres';
        }
    }
    // Genres je Aufnahme (Track) – einmal je Edition
    if (($ed['mb_aufnahme_genres_am'] ?? null) === null && mb_aufnahme_genres_holen((int) $ed['id'], (string) $ed['mbid'])) {
        $gefuellt[] = 'Track-Genres';
    }
    // ISRC aus MusicBrainz und Kennzeichnung „explizit“ (Deezer) für Titel, die noch keine haben
    mb_isrcs_uebernehmen((int) $ed['id'], $rel);
    try {
        if (deezer_aktiv() && deezer_edition_explizit((int) $ed['id'])) {
            $gefuellt[] = 'Explizit';
        }
    } catch (Throwable $e) {
        // Deezer nicht erreichbar: MusicBrainz-Angaben sind trotzdem gespeichert, „explizit“ kommt beim nächsten Durchlauf
    }
    return $gefuellt;
}

/**
 * Sammelabgleich: holt von MusicBrainz alles, was fehlt – nur bei Editionen mit MusicBrainz-Verknüpfung, ein Stapel pro Aufruf
 * (MusicBrainz erlaubt etwa eine Anfrage pro Sekunde). Eingabe: {"neu":true} = von vorn beginnen.
 * Es wird nie etwas Vorhandenes überschrieben.
 */
function api_admin_metadaten_stapel(): array
{
    set_time_limit(120);
    if (api_wert('neu')) {
        einstellung_setzen('metadaten_abgleich_pos', '0');
    }
    $pos = (int) einstellung('metadaten_abgleich_pos');
    $start = microtime(true);
    $aus = ['geprueft' => 0, 'geaendert' => 0, 'felder' => 0, 'fehler' => 0, 'meldung' => ''];
    $b = metadaten_luecke_bedingung();
    $liste = db_alle("SELECT e.* FROM editionen e JOIN alben a ON a.id = e.album_id WHERE {$b} AND e.id > :p ORDER BY e.id LIMIT 15", ['p' => $pos]);
    foreach ($liste as $e) {
        if (microtime(true) - $start > 22) {
            break;
        }
        try {
            $f = metadaten_luecken_fuellen($e);
            if ($f) {
                $aus['geaendert']++;
                $aus['felder'] += count($f);
            }
        } catch (Throwable $ex) {
            $aus['fehler']++;
            $aus['meldung'] = $ex->getMessage(); // bei Netz-/Limit-Problemen nicht weiter anfragen; diese Edition wird beim Fortsetzen erneut versucht
            break;
        }
        $pos = (int) $e['id'];
        $aus['geprueft']++;
    }
    $rest = (int) db_wert("SELECT COUNT(*) FROM editionen e JOIN alben a ON a.id = e.album_id WHERE {$b} AND e.id > :p", ['p' => $pos]);
    einstellung_setzen('metadaten_abgleich_pos', $rest > 0 ? (string) $pos : '0');
    return $aus + ['rest' => $rest] + api_admin_metadaten_stand();
}

/**
 * Sammelaktion in der Bibliothek: bei den ausgewählten Alben alles Fehlende von MusicBrainz holen (nur Editionen mit Verknüpfung,
 * nur leere Felder). Eingabe: {"ids":[Album-IDs]}. Läuft höchstens ~22 s; "offen" nennt die Alben, die noch nicht dran waren.
 */
function api_admin_alben_luecken(): array
{
    set_time_limit(120);
    $ids = array_values(array_unique(array_filter(array_map('intval', (array) api_wert('ids', [])), static fn($i) => $i > 0)));
    $ids = array_slice($ids, 0, 200);
    $start = microtime(true);
    $aus = ['geprueft' => 0, 'geaendert' => 0, 'felder' => 0, 'ohne_verknuepfung' => 0, 'fehler' => 0, 'meldung' => '', 'offen' => []];
    foreach ($ids as $i => $albumId) {
        if (microtime(true) - $start > 22) {
            $aus['offen'] = array_slice($ids, $i);
            break;
        }
        $editionen = db_alle("SELECT * FROM editionen WHERE album_id = :a AND mbid IS NOT NULL AND mbid <> ''", ['a' => $albumId]);
        if (!$editionen) {
            $aus['ohne_verknuepfung']++;
            continue;
        }
        try {
            $gefuellt = 0;
            foreach ($editionen as $e) {
                $gefuellt += count(metadaten_luecken_fuellen($e));
            }
            $aus['geprueft']++;
            if ($gefuellt) {
                $aus['geaendert']++;
                $aus['felder'] += $gefuellt;
            }
        } catch (Throwable $ex) {
            $aus['fehler']++;
            $aus['meldung'] = $ex->getMessage();
            $aus['offen'] = array_slice($ids, $i);
            break;
        }
    }
    return $aus;
}

function api_admin_fanart_stapel(): array
{
    set_time_limit(120);
    if (!fanart_aktiv()) {
        throw new ApiFehler(t('Bitte zuerst unter Einstellungen den fanart.tv-Schlüssel eintragen.'));
    }
    return fanart_stapel(25, 25.0);
}

function api_admin_fanart_stand(): array
{
    return [
        'aktiv' => fanart_aktiv(),
        'offen' => (int) db_wert('SELECT COUNT(*) FROM kuenstler k WHERE ' . fanart_offen_bedingung()),
        'mit_bild' => (int) db_wert("SELECT COUNT(*) FROM kuenstler WHERE bild_datei <> ''"),
        'von_fanart' => (int) db_wert("SELECT COUNT(*) FROM kuenstler WHERE bild_quelle = 'fanart'"),
    ];
}
