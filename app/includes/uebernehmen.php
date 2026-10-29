<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/bibliothek.php';
require_once __DIR__ . '/tags.php';
require_once __DIR__ . '/tagziel.php';
require_once __DIR__ . '/tagschreiber.php';
require_once __DIR__ . '/aufraeumen.php';

/*
 * Fehlenden Titel aus einem anderen Album übernehmen: Ein Titel zeigt „Datei fehlt“, die Aufnahme liegt aber in einem
 * anderen Album (z. B. „All I Want for Christmas Is You“ auf einem Sampler). Amberwave kopiert die Datei in den Ordner des
 * Albums, benennt sie nach dem Aufräum-Schema und schreibt die Tags des Zielalbums hinein. Das Original bleibt, wo es ist.
 */

const UE_FORMATE = ['flac', 'mp3', 'm4a', 'mp4', 'm4b', 'aac'];
// Verlustfreie Formate ohne (beschreibbare) Tags: beim Übernehmen bitgenau zu FLAC umwandeln, dann taggen
const UE_ZU_FLAC = ['wav', 'aif', 'aiff', 'wv', 'ape'];

/**
 * Verlustfrei nach FLAC umwandeln und prüfen, dass das Audio bitgenau gleich ist (MD5 über die dekodierten Samples).
 * Wirft ApiFehler bei Problemen; $ziel wird dann nicht angelegt bzw. wieder gelöscht.
 */
function ue_zu_flac(string $von, string $ziel, bool $tagsMitnehmen = false): void
{
    $ff = escapeshellarg(konfig()['stream']['ffmpeg']);
    // Tags (RIFF-INFO, ID3 in WAV/AIFF) auf Wunsch als Vorbis-Kommentare mitnehmen, sonst leer (werden danach neu geschrieben)
    $cmd = $ff . ' -nostdin -v error -y -i ' . escapeshellarg($von) . ' -map 0:a:0 -map_metadata ' . ($tagsMitnehmen ? '0' : '-1') . ' -c:a flac -compression_level 8 ' . escapeshellarg($ziel) . ' 2>&1';
    exec($cmd, $aus, $rc);
    if ($rc !== 0 || !is_file($ziel) || filesize($ziel) < 1000) {
        @unlink($ziel);
        throw new ApiFehler(t('Umwandeln nach FLAC fehlgeschlagen: {grund}', ['grund' => mb_substr(trim(implode(' ', $aus)), 0, 200)]));
    }
    $md5 = static function (string $datei) use ($ff): string {
        $o = [];
        exec($ff . ' -nostdin -v error -i ' . escapeshellarg($datei) . ' -map 0:a:0 -c:a pcm_s32le -f md5 - 2>/dev/null', $o);
        return trim(implode('', $o));
    };
    $a = $md5($von);
    $b = $md5($ziel);
    if ($a === '' || $a !== $b) {
        @unlink($ziel);
        throw new ApiFehler(t('Prüfung nach dem Umwandeln fehlgeschlagen (Audio nicht identisch) – nichts übernommen.'));
    }
}

/** Ziel-Titel laden und prüfen (muss ohne Datei sein) */
function ue_ziel(int $trackId): array
{
    $t = db_zeile('SELECT t.*, m.edition_id, m.pos AS disc FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE t.id = :id', ['id' => $trackId]);
    if (!$t) {
        throw new ApiFehler(t('Titel nicht gefunden.'), 404);
    }
    if (db_wert('SELECT 1 FROM dateien WHERE track_id = :t LIMIT 1', ['t' => $trackId])) {
        throw new ApiFehler(t('Für diesen Titel liegt schon eine Datei vor.'));
    }
    return $t;
}

/** Beste Datei je Titel (höchste Auflösung) für eine Liste von Track-IDs */
function ue_beste_dateien(array $trackIds): array
{
    $aus = [];
    if (!$trackIds) {
        return $aus;
    }
    [$in, $pp] = db_in(array_values(array_unique($trackIds)));
    foreach (db_alle("SELECT id, track_id, pfad, format, bittiefe, abtastrate, laenge_ms, groesse FROM dateien WHERE track_id IN {$in} AND fehler = '' ORDER BY bittiefe DESC, abtastrate DESC, id", $pp) as $d) {
        $aus[(int) $d['track_id']] ??= $d;
    }
    return $aus;
}

/**
 * Kandidaten: ohne Suchbegriff Vorschläge (gleiche Aufnahme, sonst gleicher Titel vom selben Künstler),
 * mit Suchbegriff alles, was zu Titel, Künstler oder Album passt.
 */
function ue_kandidaten(int $zielTrackId, string $q = ''): array
{
    $z = ue_ziel($zielTrackId);
    $zielEdition = (int) $z['edition_id'];
    $basisSql = "SELECT t.id, t.titel, t.aufnahme_id, t.laenge_ms, t.suchtext, m.edition_id, e.ordner, e.jahr, e.format_text, a.id AS album_id, a.titel AS album_titel,
            COALESCE(ct.anzeige, ca.anzeige, '') AS kuenstler
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id
        LEFT JOIN credits ct ON ct.id = t.credit_id LEFT JOIN credits ca ON ca.id = a.credit_id
        WHERE m.edition_id <> :ze AND EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id AND d.fehler = '')";
    $treffer = [];
    $q = trim($q);
    if ($q !== '') {
        $woerter = array_slice(array_values(array_filter(explode(' ', name_norm($q)))), 0, 6);
        if (!$woerter) {
            return ['ziel' => ue_ziel_info($z), 'kandidaten' => []];
        }
        $p = ['ze' => $zielEdition];
        $bed = [];
        foreach ($woerter as $i => $w) {
            $bed[] = "CONCAT(t.suchtext, ' ', a.suchtext) LIKE :w{$i}";
            $p["w{$i}"] = '%' . $w . '%';
        }
        $treffer = db_alle($basisSql . ' AND ' . implode(' AND ', $bed) . ' ORDER BY a.titel, m.pos, t.pos LIMIT 40', $p);
    } else {
        // 1. gleiche Aufnahme (MusicBrainz)
        if ($z['aufnahme_id']) {
            $treffer = db_alle($basisSql . ' AND t.aufnahme_id = :au LIMIT 20', ['ze' => $zielEdition, 'au' => $z['aufnahme_id']]);
        }
        // 2. gleicher Titel (ohne Zusätze wie „Remastered“) von einem der Künstler des Titels oder Albums
        $tn = name_norm((string) preg_replace('/\s*[(\[][^)\]]*(remaster|version|edit|mix|live|mono|stereo)[^)\]]*[)\]]/i', '', (string) $z['titel']));
        if ($tn !== '') {
            $kuenstler = array_values(array_filter(array_map(static fn($r) => (string) $r['name_norm'], db_alle(
                'SELECT DISTINCT k.name_norm FROM credit_namen cn JOIN kuenstler k ON k.id = cn.kuenstler_id
                 WHERE cn.credit_id IN (:c1, (SELECT COALESCE(e.credit_id, a.credit_id) FROM editionen e JOIN alben a ON a.id = e.album_id WHERE e.id = :e))',
                ['c1' => (int) ($z['credit_id'] ?? 0), 'e' => $zielEdition]))));
            foreach (db_alle($basisSql . ' AND t.suchtext LIKE :tn LIMIT 60', ['ze' => $zielEdition, 'tn' => '%' . $tn . '%']) as $r) {
                $kandTitel = name_norm((string) preg_replace('/\s*[(\[][^)\]]*[)\]]/', '', (string) $r['titel']));
                $titelPasst = $kandTitel === $tn || str_starts_with($kandTitel, $tn . ' ') || str_starts_with($tn, $kandTitel . ' ');
                $kuenstlerPasst = !$kuenstler;
                foreach ($kuenstler as $k) {
                    if ($k !== '' && str_contains(' ' . $r['suchtext'] . ' ', ' ' . $k . ' ')) {
                        $kuenstlerPasst = true;
                        break;
                    }
                }
                if ($titelPasst && $kuenstlerPasst) {
                    $treffer[] = $r;
                }
            }
        }
    }
    // doppelte raus, beste Datei dazu, sortieren: gleiche Aufnahme, dann ähnliche Länge, dann beste Qualität
    $nachId = [];
    foreach ($treffer as $r) {
        $nachId[(int) $r['id']] ??= $r;
    }
    $dateien = ue_beste_dateien(array_keys($nachId));
    $aus = [];
    foreach ($nachId as $id => $r) {
        $d = $dateien[$id] ?? null;
        if (!$d) {
            continue;
        }
        $diff = ($z['laenge_ms'] && $d['laenge_ms']) ? (int) round(((int) $d['laenge_ms'] - (int) $z['laenge_ms']) / 1000) : null;
        $ext = strtolower(pathinfo((string) $d['pfad'], PATHINFO_EXTENSION));
        $aus[] = [
            'track_id' => $id, 'titel' => (string) $r['titel'], 'kuenstler' => (string) $r['kuenstler'],
            'album_id' => (int) $r['album_id'], 'album' => (string) $r['album_titel'], 'jahr' => $r['jahr'] ? (int) $r['jahr'] : null,
            'gleiche_aufnahme' => $z['aufnahme_id'] && (int) $r['aufnahme_id'] === (int) $z['aufnahme_id'],
            'laenge_ms' => (int) $d['laenge_ms'], 'laenge_diff_s' => $diff,
            'format' => strtoupper($ext), 'bittiefe' => (int) $d['bittiefe'], 'abtastrate' => (int) $d['abtastrate'],
            'moeglich' => in_array($ext, UE_FORMATE, true) || in_array($ext, UE_ZU_FLAC, true),
            'zu_flac' => in_array($ext, UE_ZU_FLAC, true),
        ];
    }
    usort($aus, static fn($a, $b) => [$b['gleiche_aufnahme'], -abs($a['laenge_diff_s'] ?? 99), $b['bittiefe'], $b['abtastrate']]
        <=> [$a['gleiche_aufnahme'], -abs($b['laenge_diff_s'] ?? 99), $a['bittiefe'], $a['abtastrate']]);
    return ['ziel' => ue_ziel_info($z), 'kandidaten' => $aus];
}

function ue_ziel_info(array $z): array
{
    $e = db_zeile('SELECT e.id, e.ordner, e.titel, a.titel AS album FROM editionen e JOIN alben a ON a.id = e.album_id WHERE e.id = :id', ['id' => $z['edition_id']]);
    $beste = db_zeile('SELECT MAX(d.bittiefe) bt, MAX(d.abtastrate) ar FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $z['edition_id']]);
    return ['track_id' => (int) $z['id'], 'titel' => (string) $z['titel'], 'nr' => (int) $z['pos'], 'disc' => (int) $z['disc'], 'laenge_ms' => (int) ($z['laenge_ms'] ?? 0),
        'album' => (string) (($e['titel'] ?? '') ?: ($e['album'] ?? '')), 'ordner' => (string) ($e['ordner'] ?? ''),
        'album_bittiefe' => (int) ($beste['bt'] ?? 0), 'album_abtastrate' => (int) ($beste['ar'] ?? 0)];
}

/**
 * Kopieren, benennen, umtaggen, eintragen. Liefert ['ok', 'pfad', 'log'].
 */
function ue_uebernehmen(int $zielTrackId, int $quellTrackId): array
{
    $z = ue_ziel($zielTrackId);
    $eid = (int) $z['edition_id'];
    $e = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $eid]);
    $a = db_zeile('SELECT * FROM alben WHERE id = :id', ['id' => $e['album_id']]);
    $quelle = ue_beste_dateien([$quellTrackId])[$quellTrackId] ?? null;
    if (!$quelle) {
        throw new ApiFehler(t('Der gewählte Titel hat keine Datei.'));
    }
    $wurzel = af_wurzel();
    $von = $wurzel . '/' . $quelle['pfad'];
    if (!is_file($von)) {
        throw new ApiFehler(t('Die Quelldatei liegt nicht mehr dort, wo die Bibliothek sie erwartet – bitte einlesen.'));
    }
    $quellExt = strtolower(pathinfo($von, PATHINFO_EXTENSION));
    $zuFlac = in_array($quellExt, UE_ZU_FLAC, true);
    if (!$zuFlac && !in_array($quellExt, UE_FORMATE, true)) {
        throw new ApiFehler(t('Dateien im Format .{ext} kann Amberwave nicht umtaggen – FLAC, MP3, M4A und verlustfreie Formate (WAV, AIFF, WavPack, APE → FLAC) gehen.', ['ext' => $quellExt]));
    }
    $ext = $zuFlac ? 'flac' : $quellExt;
    if (af_laeuft()) {
        throw new ApiFehler(t('Das Aufräumen verschiebt gerade Dateien – bitte gleich noch einmal versuchen.'));
    }
    $t = af_schreibtest();
    if (!$t['ok']) {
        throw new ApiFehler(t('Der Musikordner ist nicht beschreibbar: {grund}', ['grund' => $t['meldung']]));
    }

    // Zielordner: der Ordner des Albums; hat das Album keine Dateien (mehr), der Ordner nach Schema
    $k = konfig()['aufraeumen'];
    $credit = tag_credit($e['credit_id'] ? (int) $e['credit_id'] : ($a['credit_id'] ? (int) $a['credit_id'] : null));
    $werte = [
        'albumkuenstler' => $credit['anzeige'] ?: 'Unbekannt', 'album' => (string) ($e['titel'] ?: $a['titel']),
        'originaljahr' => (string) ($a['erstjahr'] ?: ($e['jahr'] ?? '')), 'jahr' => (string) (($e['jahr'] ?? null) ?: ($a['erstjahr'] ?: '')),
        'edition' => trim((string) $e['kommentar']), 'land' => (string) $e['land'], 'format' => (string) $e['format_text'], 'katalognummer' => '',
    ];
    $ordner = trim((string) $e['ordner'], '/');
    $hatDateien = (bool) db_wert('SELECT 1 FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e LIMIT 1', ['e' => $eid]);
    if ($ordner === '' || $ordner === '.' || !$hatDateien || !is_dir($wurzel . '/' . $ordner)) {
        $ordner = af_pfad($k['ordner'], $werte);
    }
    // Dateiname nach Schema ({nr} - {titel}, ggf. CD-Ordner); Nummernbreite wie im Album
    $discs = (int) db_wert('SELECT COUNT(*) FROM datentraeger WHERE edition_id = :e', ['e' => $eid]);
    $nrBreite = max(2, strlen((string) db_wert('SELECT MAX(t.pos) FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $eid])));
    $name = af_pfad($k['datei'], $werte + ['disc' => ($discs > 1 || $k['cd_immer']) ? (string) $z['disc'] : '', 'nr' => str_pad((string) $z['pos'], $nrBreite, '0', STR_PAD_LEFT), 'titel' => (string) $z['titel']]);
    // Liegen die übrigen Titel einer mehrteiligen Ausgabe nicht in CD-Unterordnern, den Unterordner weglassen
    if (str_contains($name, '/') && $hatDateien && !db_wert("SELECT 1 FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
            WHERE m.edition_id = :e AND d.pfad LIKE :p LIMIT 1", ['e' => $eid, 'p' => $ordner . '/%/%'])) {
        $name = basename($name);
    }
    $rel = $ordner . '/' . $name . '.' . $ext;
    for ($n = 2; file_exists($wurzel . '/' . $rel); $n++) {
        $rel = $ordner . '/' . $name . ' (' . $n . ').' . $ext;
    }
    $ziel = $wurzel . '/' . $rel;
    if (!af_ordner_anlegen(dirname($ziel))) {
        throw new ApiFehler(t('Ordner konnte nicht angelegt werden: {pfad}', ['pfad' => dirname($rel)]));
    }

    // Tags des Zielalbums; Albumtitel und Release-ID an die übrigen Dateien des Ordners angleichen, damit das Einlesen
    // die Datei derselben Edition zuordnet (gruppiert wird nach dem Album-Tag)
    $soll = tags_fuer_edition($eid)[$zielTrackId] ?? [];
    if (!$soll) {
        throw new ApiFehler(t('Für das Zielalbum konnten keine Tags erstellt werden.'));
    }
    $nachbar = db_wert('SELECT d.tags_json FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e AND d.pfad LIKE :p ORDER BY d.id LIMIT 1',
        ['e' => $eid, 'p' => $ordner . '/%']);
    if ($nachbar) {
        $nt = json_decode((string) $nachbar, true) ?: [];
        $nAlbum = tag1($nt, 'ALBUM');
        if ($nAlbum !== '' && name_norm(scan_albumtitel_bereinigen($nAlbum)) !== name_norm(scan_albumtitel_bereinigen((string) ($soll['ALBUM'][0] ?? '')))) {
            $soll['ALBUM'] = [$nAlbum];
        }
        $nId = strtolower(tag1($nt, 'MUSICBRAINZ_ALBUMID'));
        if (ist_uuid($nId)) {
            $soll['MUSICBRAINZ_ALBUMID'] = [$nId];
        }
    }

    // Erst als versteckte Datei kopieren und umtaggen (das Einlesen überspringt Punkt-Dateien), dann umbenennen
    $tmp = dirname($ziel) . '/.aw-uebernahme-' . bin2hex(random_bytes(4)) . '.' . $ext;
    try {
        if ($zuFlac) {
            ue_zu_flac($von, $tmp);
        } elseif (!@copy($von, $tmp) || filesize($tmp) !== filesize($von)) {
            throw new ApiFehler(t('Kopieren fehlgeschlagen (Platz oder Rechte?).'));
        }
        af_datei_rechte($tmp);
        try {
            datei_tags_schreiben($tmp, $soll, af_cover($e));
        } catch (Throwable $ex) {
            throw new ApiFehler(t('Tags konnten nicht geschrieben werden: {grund}', ['grund' => $ex->getMessage()]));
        }
        if (!@rename($tmp, $ziel)) {
            throw new ApiFehler(t('Umbenennen fehlgeschlagen.'));
        }
    } finally {
        if (is_file($tmp)) {
            @unlink($tmp);
        }
    }
    af_datei_rechte($ziel);

    // Eintragen wie beim Einlesen, gleich mit dem Ziel-Titel verknüpft
    clearstatcache(true, $ziel);
    $info = datei_lesen($ziel);
    $tags = $info['tags'] ?? [];
    $tech = ($info['technik'] ?? []) + ['format' => '', 'codec' => '', 'abtastrate' => 0, 'bittiefe' => 0, 'kanaele' => 0, 'laenge_ms' => 0, 'bitrate' => 0];
    $rg = static function (string $feld) use ($tags): ?float {
        $w = tag1($tags, $feld);
        return preg_match('/^\s*([-+]?\d+(?:[.,]\d+)?)/', $w, $m) ? (float) str_replace(',', '.', $m[1]) : null;
    };
    $basis = scan_basis_ordner($rel);
    $dateiId = db_einfuegen('INSERT INTO dateien (pfad_hash, pfad, ordner_hash, groesse, mtime, format, codec, abtastrate, bittiefe, kanaele, laenge_ms, bitrate,
            tags_json, rg_track_db, rg_track_peak, rg_album_db, rg_album_peak, bild_eingebettet, fehler, track_id)
            VALUES (:h, :p, :o, :g, :m, :f, :c, :ar, :bt, :k, :l, :br, :tj, :rtd, :rtp, :rad, :rap, :be, :fe, :t)', [
        'h' => hash('sha256', $rel), 'p' => $rel, 'o' => hash('sha256', $basis), 'g' => filesize($ziel), 'm' => filemtime($ziel),
        'f' => mb_substr((string) $tech['format'], 0, 10), 'c' => mb_substr((string) $tech['codec'], 0, 30),
        'ar' => (int) $tech['abtastrate'], 'bt' => (int) $tech['bittiefe'], 'k' => (int) $tech['kanaele'], 'l' => (int) $tech['laenge_ms'], 'br' => (int) $tech['bitrate'],
        'tj' => json_encode(scan_tags_fuer_db($tags), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
        'rtd' => $rg('REPLAYGAIN_TRACK_GAIN'), 'rtp' => $rg('REPLAYGAIN_TRACK_PEAK'), 'rad' => $rg('REPLAYGAIN_ALBUM_GAIN'), 'rap' => $rg('REPLAYGAIN_ALBUM_PEAK'),
        'be' => !empty($info['hat_bild']) ? 1 : 0, 'fe' => mb_substr((string) ($info['fehler'] ?? ''), 0, 300), 't' => $zielTrackId,
    ]);
    // Hatte die Edition keine Dateien (mehr), zeigt ihr Ordner jetzt auf den neuen
    if (!$hatDateien) {
        $tn = name_norm(scan_albumtitel_bereinigen((string) ($soll['ALBUM'][0] ?? $werte['album']))) ?: mb_strtolower($werte['album']);
        db_tun('UPDATE editionen SET ordner = :o, ordner_hash = :oh, gruppe_hash = :g WHERE id = :id',
            ['o' => $basis, 'oh' => hash('sha256', $basis), 'g' => hash('sha256', $basis . '||' . $tn), 'id' => $eid]);
    }
    edition_kennzahlen($eid);
    album_anzeige_aktualisieren((int) $e['album_id']);
    af_protokoll($eid, 'kopiert', (string) $quelle['pfad'], $rel, t('Fehlenden Titel aus anderem Album übernommen') . ($zuFlac ? ' ' . t('(verlustfrei nach FLAC umgewandelt)') : ''));
    return ['ok' => true, 'pfad' => $rel, 'datei_id' => $dateiId, 'zu_flac' => $zuFlac];
}
