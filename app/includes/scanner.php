<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/tags.php';
require_once __DIR__ . '/bibliothek.php';
require_once __DIR__ . '/bilder.php';

/**
 * Bibliotheks-Scan.
 * Grundsätze:
 * - Die Sammlung wird so eingelesen, wie sie ist – ohne Rückfragen.
 * - Ein Album = ein Albumordner (CD1/CD2-Unterordner gehören dazu) und gleiche Album-Tags.
 * - Künstler werden nur aufgeteilt, wenn die Tags sie einzeln nennen (ARTISTS, Mehrfachwerte).
 * - Track-IDs bleiben bei erneutem Scan erhalten (Favoriten, Playlists, Verlauf gehen nicht verloren).
 * - Editionen, die per MusicBrainz abgeglichen wurden, werden vom Scan nicht umgebaut.
 */

const SCAN_DISC_MUSTER = '/^(cd|disc|disk|disque|scheibe|seite|side)[\s._-]*\d+\b/i';
const TAG_ROLLEN = [
    'COMPOSER' => 'composer', 'LYRICIST' => 'lyricist', 'WRITER' => 'writer', 'ARRANGER' => 'arranger',
    'PRODUCER' => 'producer', 'MIXER' => 'mix', 'ENGINEER' => 'engineer', 'DJMIXER' => 'dj_mix',
    'REMIXER' => 'remixer', 'CONDUCTOR' => 'conductor', 'ORCHESTRA' => 'orchestra',
];

function scan_basis_ordner(string $rel): string
{
    $dir = dirname($rel);
    if ($dir === '.' || $dir === '') {
        return '.';
    }
    if (preg_match(SCAN_DISC_MUSTER, basename($dir))) {
        $eltern = dirname($dir);
        return $eltern === '' ? '.' : $eltern;
    }
    return $dir;
}

/**
 * Alle Musikdateien unterhalb des Musikordners: [rel => [groesse, mtime]].
 * Ordner und Dateien ohne Leserecht landen in $kein_zugriff (Ordner mit „/“ am Ende) – sie werden gemeldet
 * und ihre schon bekannten Titel bleiben unangetastet.
 */
function scan_dateien_auflisten(string $wurzel, callable $fortschritt, array &$kein_zugriff = []): array
{
    $typen = array_flip(konfig()['scan']['dateitypen']);
    $ignor = konfig()['scan']['ignorieren'];
    $testziel = 'neu'; // Altlast: Testkopien früherer Versionen (Ordner „neu“ im Musikordner) werden nie eingelesen
    // Eingangsordner des Sortier-Assistenten: dort liegt Unsortiertes, bis der Assistent es erkannt und einsortiert hat
    $eingang = (string) (konfig()['sortieren']['ordner'] ?? '');
    // Der Download-Ordner (SABnzbd) wird nie eingelesen, auch wenn er im Musikordner liegt: Erkannt wird er an Gerät + Inode,
    // denn im Container hat er einen anderen Pfad (/downloads) als im Musikordner (/musik/…/complete), ist aber derselbe Ordner.
    // Sonst stünde jedes Album doppelt in der Bibliothek: einmal das Original im Download-Ordner, einmal der Import.
    // Ist der Download-Ordner falsch eingebunden (derselbe Ordner wie der Musikordner oder das Import-Ziel), wird NICHTS
    // übersprungen – sonst verschwänden importierte Alben aus der Bibliothek.
    $sperren = [];
    $dl = (string) (konfig()['pfade']['downloads'] ?? '');
    if ($dl !== '' && is_dir($dl) && ($st = @stat($dl)) && download_ordner_konflikt() === null) {
        $sperren[$st['dev'] . ':' . $st['ino']] = true;
    }
    $aus = [];
    $stapel = [''];
    $n = 0;
    while ($stapel) {
        $rel = array_pop($stapel);
        $abs = $rel === '' ? $wurzel : $wurzel . '/' . $rel;
        $eintraege = @scandir($abs);
        if ($eintraege === false) {
            $kein_zugriff[] = $rel . '/';
            continue;
        }
        foreach ($eintraege as $e) {
            if ($e === '.' || $e === '..' || $e[0] === '.') {
                continue;
            }
            $r = $rel === '' ? $e : $rel . '/' . $e;
            if ($testziel !== '' && $r === $testziel) {
                continue; // alte Testkopien nicht einlesen
            }
            if ($eingang !== '' && $r === $eingang) {
                continue; // unsortierte Musik – kommt über den Sortier-Assistenten in die Bibliothek
            }
            foreach ($ignor as $i) {
                if ($i !== '' && str_contains($r, $i)) {
                    continue 2;
                }
            }
            $p = $abs . '/' . $e;
            if (is_dir($p)) {
                if ($sperren && ($ds = @stat($p)) && isset($sperren[$ds['dev'] . ':' . $ds['ino']])) {
                    continue; // das ist der Download-Ordner
                }
                $stapel[] = $r;
                continue;
            }
            $ext = strtolower(pathinfo($e, PATHINFO_EXTENSION));
            if (!isset($typen[$ext])) {
                continue;
            }
            $st = @stat($p);
            if (!$st || !is_readable($p)) {
                $kein_zugriff[] = $r;
                continue;
            }
            if ($st) {
                $aus[$r] = [(int) $st['size'], (int) $st['mtime']];
                if (++$n % 500 === 0) {
                    $fortschritt($n);
                }
            }
        }
    }
    return $aus;
}

/** Tags fürs Speichern aufbereiten (Bilder/Altlasten raus, sehr lange Werte kürzen). */
function scan_tags_fuer_db(array $tags): array
{
    unset($tags['METADATA_BLOCK_PICTURE'], $tags['COVERART'], $tags['COVERARTMIME']);
    foreach ($tags as $k => $werte) {
        $tags[$k] = array_map(static fn($w) => mb_substr((string) $w, 0, in_array($k, ['LYRICS', 'UNSYNCEDLYRICS'], true) ? 20000 : 2000), array_slice($werte, 0, 50));
    }
    return $tags;
}

function scan_lauf_aktualisieren(int $lauf, array $felder): void
{
    $setz = [];
    $p = ['id' => $lauf];
    foreach ($felder as $k => $v) {
        $setz[] = "{$k} = :{$k}";
        $p[$k] = $v;
    }
    $setz[] = 'lebenszeichen = NOW()';
    db_tun('UPDATE scan_laeufe SET ' . implode(', ', $setz) . ' WHERE id = :id', $p);
}

function scan_abgebrochen(int $lauf): bool
{
    return db_wert('SELECT status FROM scan_laeufe WHERE id = :id', ['id' => $lauf]) === 'abgebrochen';
}

/** Haupteinstieg. $voll = alle Dateien neu lesen (sonst nur neue/geänderte). */
function scan_ausfuehren(int $lauf, bool $voll): array
{
    $wurzel = konfig()['pfade']['musik'];
    $stat = ['gesamt' => 0, 'neu' => 0, 'geaendert' => 0, 'entfernt' => 0, 'alben_neu' => 0, 'fehler' => 0, 'geprueft' => 0];
    if (!is_dir($wurzel)) {
        throw new RuntimeException(t('Musikordner {wurzel} nicht gefunden – MUSIK_PFAD in der .env prüfen.', ['wurzel' => $wurzel]));
    }
    // Nie gleichzeitig mit dem Aufräumen: verschiebt es gerade ein Album, sähe der Scan Dateien am alten Ort fehlen und am
    // neuen als neu – Titel würden kurz verschwinden oder neu angelegt. Das Aufräumen pausiert nach dem laufenden Album,
    // sobald ein Scan ansteht; so lange wartet der Scan (höchstens 20 Minuten).
    require_once __DIR__ . '/aufraeumen.php';
    for ($w = 0; af_laeuft() && $w < 600; $w++) {
        if ($w % 5 === 0) {
            scan_lauf_aktualisieren($lauf, ['status' => 'laeuft', 'aktuell' => t('Wartet, bis das Aufräumen das aktuelle Album fertig verschoben hat …')]);
        }
        sleep(2);
    }
    scan_lauf_aktualisieren($lauf, ['status' => 'laeuft', 'aktuell' => t('Dateien werden gezählt …')]);

    $kein_zugriff = [];
    $platte = scan_dateien_auflisten($wurzel, static function (int $n) use ($lauf): void {
        scan_lauf_aktualisieren($lauf, ['aktuell' => t('{n} Dateien gefunden …', ['n' => $n])]);
    }, $kein_zugriff);
    $stat['gesamt'] = count($platte);
    $stat['kein_zugriff'] = count($kein_zugriff);
    foreach (array_slice($kein_zugriff, 0, 500) as $rel) {
        db_tun('INSERT INTO scan_fehler (lauf_id, pfad, fehler) VALUES (:l, :p, :f)', ['l' => $lauf, 'p' => mb_substr($rel === '/' ? t('(Musikordner)') : $rel, 0, 2000),
            'f' => str_ends_with($rel, '/') ? t('Kein Zugriff auf den Ordner (Rechte) – bisherige Titel bleiben erhalten') : t('Kein Zugriff auf die Datei (Rechte) – bisheriger Stand bleibt erhalten')]);
    }
    // Ordner bzw. Dateien ohne Zugriff: nichts davon als „gelöscht“ werten, betroffene Albumordner nicht neu aufbauen
    $gesperrt_ordner = array_values(array_filter($kein_zugriff, static fn($r) => str_ends_with($r, '/')));
    $gesperrt_dateien = array_flip(array_filter($kein_zugriff, static fn($r) => !str_ends_with($r, '/')));
    $ist_gesperrt = static function (string $rel) use ($gesperrt_ordner, $gesperrt_dateien): bool {
        if (isset($gesperrt_dateien[$rel])) {
            return true;
        }
        foreach ($gesperrt_ordner as $o) {
            if ($o === '/' || str_starts_with($rel, ltrim($o, '/'))) {
                return true;
            }
        }
        return false;
    };
    $gesperrte_basis = [];
    foreach ($kein_zugriff as $rel) {
        $gesperrte_basis[scan_basis_ordner(rtrim($rel, '/') . (str_ends_with($rel, '/') ? '/x' : ''))] = true;
    }
    scan_lauf_aktualisieren($lauf, ['dateien_gesamt' => $stat['gesamt'], 'aktuell' => t('Abgleich mit der Bibliothek …')]);

    // Bekannte Dateien
    $bekannt = [];
    foreach (db()->query('SELECT id, pfad, groesse, mtime FROM dateien', PDO::FETCH_ASSOC) as $z) {
        $bekannt[$z['pfad']] = ['id' => (int) $z['id'], 'groesse' => (int) $z['groesse'], 'mtime' => (int) $z['mtime']];
    }
    // Schutz: Musikordner leer (Freigabe nicht eingehängt, Array gestoppt) -> nichts löschen
    if (!$platte && $bekannt) {
        throw new RuntimeException(t('Im Musikordner wurden keine Dateien gefunden, die Bibliothek kennt aber {n} – ist das Array gestartet und MUSIK_PFAD richtig eingehängt? Es wurde nichts verändert.', ['n' => count($bekannt)]));
    }

    // Nach Albumordner gruppieren und betroffene Ordner bestimmen
    $nach_basis = [];
    $betroffen = [];
    foreach ($platte as $rel => [$groesse, $mtime]) {
        $basis = scan_basis_ordner($rel);
        $nach_basis[$basis][] = $rel;
        $alt = $bekannt[$rel] ?? null;
        if ($voll || !$alt || $alt['groesse'] !== $groesse || $alt['mtime'] !== $mtime) {
            $betroffen[$basis] = true;
            $alt ? $stat['geaendert']++ : $stat['neu']++;
        }
    }
    $entfernt = array_filter(array_diff_key($bekannt, $platte), static fn($info, $rel) => !$ist_gesperrt((string) $rel), ARRAY_FILTER_USE_BOTH);
    foreach ($entfernt as $rel => $info) {
        $betroffen[scan_basis_ordner($rel)] = true;
    }
    $stat['entfernt'] = count($entfernt);
    if ($voll) {
        $stat['geaendert'] = max(0, $stat['geaendert']);
    }

    // Entfernte Dateien löschen (Track-Aufräumen passiert beim Neuaufbau des Ordners)
    foreach ($entfernt as $rel => $info) {
        db_tun('DELETE FROM dateien WHERE id = :id', ['id' => $info['id']]);
    }

    $i = 0;
    $gesamt_ordner = count($betroffen);
    foreach (array_keys($betroffen) as $basis) {
        if (isset($gesperrte_basis[$basis])) {
            continue; // Teile des Albumordners sind nicht lesbar: lieber so lassen, wie er ist
        }
        if (++$i % 5 === 1) {
            if (scan_abgebrochen($lauf)) {
                $stat['abgebrochen'] = true;
                break;
            }
            scan_lauf_aktualisieren($lauf, [
                'aktuell' => mb_substr(t('Ordner {i} von {gesamt}: {basis}', ['i' => $i, 'gesamt' => $gesamt_ordner, 'basis' => $basis]), 0, 500),
                'dateien_geprueft' => $stat['geprueft'], 'dateien_neu' => $stat['neu'], 'dateien_geaendert' => $stat['geaendert'],
                'dateien_entfernt' => $stat['entfernt'], 'alben_neu' => $stat['alben_neu'], 'fehler_anzahl' => $stat['fehler'],
            ]);
        }
        $dateien = $nach_basis[$basis] ?? [];
        db()->beginTransaction();
        try {
            $r = scan_ordner_aufbauen($lauf, $wurzel, $basis, $dateien, $platte, $bekannt, $voll);
            db()->commit();
            $stat['alben_neu'] += $r['alben_neu'];
            $stat['fehler'] += $r['fehler'];
            $stat['geprueft'] += count($dateien);
        } catch (Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            $stat['fehler']++;
            db_tun('INSERT INTO scan_fehler (lauf_id, pfad, fehler) VALUES (:l, :p, :f)', ['l' => $lauf, 'p' => mb_substr($basis, 0, 2000), 'f' => mb_substr($e->getMessage(), 0, 500)]);
            error_log('Scan ' . $basis . ': ' . $e->getMessage());
        }
    }

    // Aufräumen nur, wenn sich etwas geändert hat (sonst liefen bei jedem automatischen Scan Abfragen über die ganze Bibliothek)
    if ($stat['neu'] + $stat['geaendert'] + $stat['entfernt'] > 0 || $voll) {
        scan_lauf_aktualisieren($lauf, ['aktuell' => t('Aufräumen …')]);
        bibliothek_aufraeumen();
        credits_anzeige_angleichen(); // Künstler-Anzeige auf den eingestellten Stil (Standard- oder Credit-Schreibweise) bringen
    }
    return $stat;
}

/**
 * Einen Albumordner (mit CD-Unterordnern) neu aufbauen.
 * $dateien = relative Pfade, die aktuell im Ordner liegen.
 */
function scan_ordner_aufbauen(int $lauf, string $wurzel, string $basis, array $dateien, array $platte, array $bekannt, bool $voll): array
{
    $r = ['alben_neu' => 0, 'fehler' => 0];
    $basis_hash = hash('sha256', $basis);

    // 1. Jede Datei lesen (oder Tags aus der Datenbank, wenn unverändert) und in dateien speichern
    $eintraege = [];
    foreach ($dateien as $rel) {
        [$groesse, $mtime] = $platte[$rel];
        $alt = $bekannt[$rel] ?? null;
        $pfad_hash = hash('sha256', $rel);
        $neu_lesen = $voll || !$alt || $alt['groesse'] !== $groesse || $alt['mtime'] !== $mtime;
        if (!$neu_lesen) {
            $z = db_zeile('SELECT id, fehler, tags_json, laenge_ms, track_id, bild_eingebettet FROM dateien WHERE pfad_hash = :h', ['h' => $pfad_hash]);
            if ($z && $z['fehler'] !== '') {
                continue; // weiterhin unlesbar, bleibt außerhalb der Bibliothek
            }
            if ($z && $z['tags_json'] !== null) {
                $eintraege[] = ['rel' => $rel, 'id' => (int) $z['id'], 'tags' => json_decode((string) $z['tags_json'], true) ?: [],
                    'technik' => ['laenge_ms' => (int) $z['laenge_ms']], 'track_id' => $z['track_id'] !== null ? (int) $z['track_id'] : null,
                    'hat_bild' => (bool) $z['bild_eingebettet']];
                continue;
            }
        }
        try {
            $info = datei_lesen($wurzel . '/' . $rel);
        } catch (Throwable $e) {
            $r['fehler']++;
            db_tun('INSERT INTO scan_fehler (lauf_id, pfad, fehler) VALUES (:l, :p, :f)', ['l' => $lauf, 'p' => mb_substr($rel, 0, 2000), 'f' => mb_substr($e->getMessage(), 0, 500)]);
            $info = ['technik' => ['format' => strtolower(pathinfo($rel, PATHINFO_EXTENSION))], 'tags' => [], 'hat_bild' => false, 'fehler' => $e->getMessage()];
        }
        $t = $info['tags'];
        $tech = $info['technik'] + ['format' => '', 'codec' => '', 'abtastrate' => 0, 'bittiefe' => 0, 'kanaele' => 0, 'laenge_ms' => 0, 'bitrate' => 0];
        $rg = static function (string $feld) use ($t): ?float {
            $w = tag1($t, $feld);
            return preg_match('/^\s*([-+]?\d+(?:[.,]\d+)?)/', $w, $m) ? (float) str_replace(',', '.', $m[1]) : null;
        };
        $werte = [
            'h' => $pfad_hash, 'p' => $rel, 'o' => $basis_hash, 'g' => $groesse, 'm' => $mtime,
            'f' => mb_substr((string) $tech['format'], 0, 10), 'c' => mb_substr((string) $tech['codec'], 0, 30),
            'ar' => (int) $tech['abtastrate'], 'bt' => (int) $tech['bittiefe'], 'k' => (int) $tech['kanaele'],
            'l' => (int) $tech['laenge_ms'], 'br' => (int) $tech['bitrate'],
            'tj' => json_encode(scan_tags_fuer_db($t), JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            'rtd' => $rg('REPLAYGAIN_TRACK_GAIN'), 'rtp' => $rg('REPLAYGAIN_TRACK_PEAK'), 'rad' => $rg('REPLAYGAIN_ALBUM_GAIN'), 'rap' => $rg('REPLAYGAIN_ALBUM_PEAK'),
            'be' => !empty($info['hat_bild']) ? 1 : 0, 'fe' => mb_substr((string) ($info['fehler'] ?? ''), 0, 300),
        ];
        if ($alt) {
            db_tun('UPDATE dateien SET groesse = :g, mtime = :m, ordner_hash = :o, format = :f, codec = :c, abtastrate = :ar, bittiefe = :bt, kanaele = :k,
                    laenge_ms = :l, bitrate = :br, tags_json = :tj, rg_track_db = :rtd, rg_track_peak = :rtp, rg_album_db = :rad, rg_album_peak = :rap,
                    bild_eingebettet = :be, fehler = :fe, zuletzt_gesehen = NOW(), pfad = :p,
                    lautheit_am = NULL, lautheit_fehler = \'\' WHERE pfad_hash = :h', $werte);
            $id = $alt['id'];
            $track = db_wert('SELECT track_id FROM dateien WHERE id = :id', ['id' => $id]);
        } else {
            $id = db_einfuegen('INSERT INTO dateien (pfad_hash, pfad, ordner_hash, groesse, mtime, format, codec, abtastrate, bittiefe, kanaele, laenge_ms, bitrate,
                    tags_json, rg_track_db, rg_track_peak, rg_album_db, rg_album_peak, bild_eingebettet, fehler)
                    VALUES (:h, :p, :o, :g, :m, :f, :c, :ar, :bt, :k, :l, :br, :tj, :rtd, :rtp, :rad, :rap, :be, :fe)', $werte);
            $track = null;
        }
        if (!empty($info['fehler'])) {
            continue; // unlesbare Datei: gespeichert (Fehler sichtbar), aber nicht in die Bibliothek
        }
        $eintraege[] = ['rel' => $rel, 'id' => $id, 'tags' => $t, 'technik' => $tech, 'track_id' => $track !== null ? (int) $track : null, 'hat_bild' => !empty($info['hat_bild'])];
    }

    // 2. Nach Album gruppieren. Ein Ordner = ein Album, solange der Albumtitel gleich ist – auch wenn einzelne Dateien
    //    keinen oder einen anderen Albuminterpreten tragen (sonst würden sie als unsichtbare Zweit-Edition abgespalten).
    //    Nur verschiedene MusicBrainz-Release-IDs bei gleichem Titel trennen echte Editionen; Dateien ohne ID gehen zur größten.
    $nach_titel = [];
    foreach ($eintraege as $e) {
        $albumtitel = scan_albumtitel_bereinigen(tag1($e['tags'], 'ALBUM'));
        if ($albumtitel === '') {
            $albumtitel = $basis === '.' ? t('Ohne Album') : basename($basis);
        }
        $nach_titel[name_norm($albumtitel) ?: mb_strtolower($albumtitel)][] = $e + ['albumtitel' => $albumtitel];
    }
    $gruppen = [];
    foreach ($nach_titel as $tn => $liste) {
        $ids = [];
        foreach ($liste as $e) {
            $m = strtolower(tag1($e['tags'], 'MUSICBRAINZ_ALBUMID'));
            if (ist_uuid($m)) {
                $ids[$m] = ($ids[$m] ?? 0) + 1;
            }
        }
        if (count($ids) <= 1) {
            $gruppen['|' . $tn] = $liste;
            continue;
        }
        arsort($ids);
        $groesste = (string) array_key_first($ids);
        foreach ($liste as $e) {
            $m = strtolower(tag1($e['tags'], 'MUSICBRAINZ_ALBUMID'));
            $gruppen[(ist_uuid($m) ? $m : $groesste) . '|' . $tn][] = $e;
        }
    }

    $gueltige_editionen = [];
    foreach ($gruppen as $schluessel => $liste) {
        $gruppe_hash = hash('sha256', $basis . '|' . $schluessel);
        $e = scan_gruppe_aufbauen($basis, $basis_hash, $gruppe_hash, $liste, $wurzel);
        if ($e['edition_id']) {
            $gueltige_editionen[] = $e['edition_id'];
        }
        $r['alben_neu'] += $e['album_neu'] ? 1 : 0;
    }

    // 3. Editionen aus diesem Ordner, zu denen es keine Dateien mehr gibt
    foreach (db_alle('SELECT id, quelle, cover_datei FROM editionen WHERE ordner_hash = :o', ['o' => $basis_hash]) as $ed) {
        if (in_array((int) $ed['id'], $gueltige_editionen, true)) {
            continue;
        }
        $alb = (int) db_wert('SELECT album_id FROM editionen WHERE id = :id', ['id' => $ed['id']]);
        if ($ed['quelle'] === 'tags') {
            edition_loeschen((int) $ed['id']);
        } else {
            edition_kennzahlen((int) $ed['id']); // abgeglichene Edition bleibt, zeigt aber "Dateien fehlen"
        }
        album_anzeige_aktualisieren($alb);
    }
    return $r;
}

/**
 * Abgeglichene Edition: neue Dateien (z. B. ein nachgereichter Titel) den vorhandenen Tracks zuordnen –
 * zuerst über die MusicBrainz-Track-ID im Tag, sonst über Datenträger + Tracknummer, nur an Tracks ohne Datei.
 */
function scan_dateien_zuordnen(int $editionId, array $liste): void
{
    foreach ($liste as $e) {
        if ($e['track_id']) {
            $gehoert = db_wert('SELECT 1 FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE t.id = :t AND m.edition_id = :e', ['t' => $e['track_id'], 'e' => $editionId]);
            if ($gehoert) {
                continue;
            }
        }
        $t = $e['tags'];
        $tid = null;
        $tr_mbid = strtolower(tag1($t, 'MUSICBRAINZ_RELEASETRACKID'));
        if (ist_uuid($tr_mbid)) {
            $tid = db_wert('SELECT t.id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e AND t.mbid = :m', ['e' => $editionId, 'm' => $tr_mbid]);
        }
        if (!$tid) {
            $disc = scan_disc_nr($e);
            [$nr] = nummer_paar(tag1($t, 'TRACKNUMBER', 'TRACK'));
            if ($nr > 0) {
                $tid = db_wert('SELECT t.id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id
                    WHERE m.edition_id = :e AND m.pos = :d AND t.pos = :p AND NOT EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id) LIMIT 1',
                    ['e' => $editionId, 'd' => $disc, 'p' => $nr]);
            }
        }
        if (!$tid) {
            $tid = scan_zusatztrack_anlegen($editionId, $e);
        }
        if ($tid) {
            db_tun('UPDATE dateien SET track_id = :t WHERE id = :id', ['t' => $tid, 'id' => $e['id']]);
        }
    }
}

/**
 * Datei ohne Gegenstück in einer abgeglichenen Edition (z. B. Bonustitel, Demo): als zusätzlichen Titel aus den Tags
 * anlegen, statt sie zu verschweigen. Er steht hinter den Titeln seines Datenträgers.
 */
function scan_zusatztrack_anlegen(int $editionId, array $e): ?int
{
    $t = $e['tags'];
    $disc = scan_disc_nr($e);
    $dt = db_wert('SELECT id FROM datentraeger WHERE edition_id = :e AND pos = :p', ['e' => $editionId, 'p' => $disc])
        ?: db_wert('SELECT id FROM datentraeger WHERE edition_id = :e ORDER BY pos DESC LIMIT 1', ['e' => $editionId]);
    if (!$dt) {
        $dt = db_einfuegen('INSERT INTO datentraeger (edition_id, pos) VALUES (:e, :p)', ['e' => $editionId, 'p' => $disc]);
    }
    [$nr] = nummer_paar(tag1($t, 'TRACKNUMBER', 'TRACK'));
    $belegt = (bool) db_wert('SELECT 1 FROM tracks WHERE datentraeger_id = :d AND pos = :p', ['d' => $dt, 'p' => $nr]);
    $pos = ($nr > 0 && !$belegt) ? $nr : (int) db_wert('SELECT COALESCE(MAX(pos), 0) + 1 FROM tracks WHERE datentraeger_id = :d', ['d' => $dt]);
    $titel = tag1($t, 'TITLE') ?: (trim((string) preg_replace('/^\s*(?:\d+[-.])?\d{1,3}\s*[-._)]*\s*/', '', pathinfo($e['rel'], PATHINFO_FILENAME))) ?: pathinfo($e['rel'], PATHINFO_FILENAME));
    $ed = db_zeile('SELECT e.credit_id, a.credit_id AS album_credit FROM editionen e JOIN alben a ON a.id = e.album_id WHERE e.id = :e', ['e' => $editionId]);
    $credit = credit_holen(credit_teile_aus_tags(tag1($t, 'ARTIST'), tagliste($t, 'ARTISTS'), tagliste($t, 'MUSICBRAINZ_ARTISTID', true), tagliste($t, 'ARTISTSORT')))
        ?? ($ed ? (int) ($ed['credit_id'] ?: $ed['album_credit']) : null);
    $laenge = (int) ($e['technik']['laenge_ms'] ?? 0);
    $auf = db_einfuegen("INSERT INTO aufnahmen (titel, credit_id, laenge_ms, quelle) VALUES (:t, :c, :l, 'tags')", ['t' => mb_substr($titel, 0, 500), 'c' => $credit, 'l' => $laenge]);
    $tid = db_einfuegen('INSERT INTO tracks (datentraeger_id, pos, nummer, titel, credit_id, aufnahme_id, laenge_ms, suchtext) VALUES (:d, :p, :n, :t, :c, :a, :l, :s)', [
        'd' => $dt, 'p' => $pos, 'n' => (string) $pos, 't' => mb_substr($titel, 0, 500), 'c' => $credit, 'a' => $auf, 'l' => $laenge,
        's' => such_norm($titel, ...array_column(credit_liste($credit), 'name')),
    ]);
    if ($tid) {
        scan_explizit_aus_tags((int) $tid, $t, true);
    }
    return $tid ?: null;
}

/**
 * ISRC und Kennzeichnung „explizit“ aus den Tags: ITUNESADVISORY (Vorbis, ID3 TXXX, MP4 freeform) bzw. rtng (MP4):
 * 1/4 = explizit, 2 = Clean-Fassung, 0 = nicht explizit. Handeingaben bleiben; fehlt das Tag später, fällt die Datei-Angabe weg.
 */
function scan_explizit_aus_tags(int $trackId, array $t, bool $neu = false): void
{
    $isrc = strtoupper((string) preg_replace('/[^A-Za-z0-9]/', '', tag1($t, 'ISRC', 'TSRC')));
    if (preg_match('/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/', $isrc)) {
        db_tun('UPDATE tracks SET isrc = :i WHERE id = :id', ['i' => $isrc, 'id' => $trackId]);
    }
    $roh = strtolower(trim(tag1($t, 'ITUNESADVISORY', 'RTNG', 'ITUNES_ADVISORY', 'EXPLICIT', 'RATING')));
    $wert = match ($roh) {
        '1', '4', 'explicit', 'yes', 'true' => 1,
        '2', 'clean', 'edited' => 2,
        '0', 'no', 'false', 'none' => 0,
        default => null,
    };
    if ($wert !== null) {
        db_tun("UPDATE tracks SET explizit = :x, explizit_quelle = 'datei' WHERE id = :id AND explizit_quelle <> 'hand'", ['x' => $wert, 'id' => $trackId]);
    } elseif (!$neu) {   // ein gerade angelegter Titel hat noch keine Datei-Angabe, die wegfallen könnte
        db_tun("UPDATE tracks SET explizit = NULL, explizit_quelle = '', explizit_am = NULL WHERE id = :id AND explizit_quelle = 'datei'", ['id' => $trackId]);
    }
}

/** Disc-Nummer einer Datei: DISCNUMBER-Tag, sonst Ordnername („CD 2“, „Disc 3“), sonst 1 */
function scan_disc_nr(array $e): int
{
    [$disc] = nummer_paar(tag1($e['tags'], 'DISCNUMBER', 'DISC'));
    if ($disc < 1) {
        $ordnername = basename(dirname($e['rel']));
        $disc = preg_match(SCAN_DISC_MUSTER, $ordnername) && preg_match('/(\d+)/', $ordnername, $m) ? (int) $m[1] : 1;
    }
    return max(1, $disc);
}

/** " (Disc 1)", " [CD2]" am Ende des Albumtitels entfernen. */
function scan_albumtitel_bereinigen(string $t): string
{
    return trim((string) preg_replace('/\s*[\(\[]\s*(cd|disc|disk)\s*\d+\s*[\)\]]\s*$/i', '', $t));
}

function edition_loeschen(int $editionId): void
{
    $cover = (string) db_wert('SELECT cover_datei FROM editionen WHERE id = :id', ['id' => $editionId]);
    foreach (db_alle('SELECT t.id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $editionId]) as $t) {
        geloescht_merken('track', (int) $t['id']);
    }
    db_tun('DELETE FROM editionen WHERE id = :id', ['id' => $editionId]);
    geloescht_merken('edition', $editionId);
    if ($cover !== '' && !db_wert('SELECT 1 FROM editionen WHERE cover_datei = :c LIMIT 1', ['c' => $cover])) {
        bild_loeschen('cover', $cover);
    }
}

/** Eine Albumgruppe (= eine Edition) anlegen bzw. aktualisieren. */
function scan_gruppe_aufbauen(string $basis, string $basis_hash, string $gruppe_hash, array $liste, string $wurzel): array
{
    // Mehrheitswerte über alle Dateien der Gruppe
    $erst = $liste[0]['tags'];
    $mehrheit = static function (array $liste, string ...$felder): string {
        $z = [];
        foreach ($liste as $e) {
            $w = tag1($e['tags'], ...$felder);
            if ($w !== '') {
                $z[$w] = ($z[$w] ?? 0) + 1;
            }
        }
        arsort($z);
        return (string) (array_key_first($z) ?? '');
    };
    $albumtitel = $liste[0]['albumtitel'];
    $aa = $mehrheit($liste, 'ALBUMARTIST', 'ALBUM ARTIST');
    $aa_namen = [];
    $aa_mbids = [];
    foreach ($liste as $e) {
        if (tag1($e['tags'], 'ALBUMARTIST', 'ALBUM ARTIST') === $aa) {
            $aa_namen = tagliste($e['tags'], 'ALBUMARTISTS') ?: (count($e['tags']['ALBUMARTIST'] ?? []) > 1 ? $e['tags']['ALBUMARTIST'] : []);
            $aa_mbids = tagliste($e['tags'], 'MUSICBRAINZ_ALBUMARTISTID', true);
            break;
        }
    }
    if (count($aa_namen) > 1 && $aa === ($aa_namen[0] ?? '')) {
        $aa = implode(' & ', $aa_namen); // nur Einzelwerte vorhanden: Anzeige zusammensetzen
    }
    if ($aa === '') {
        // Ohne Albuminterpret: einheitlicher Track-Künstler oder Various Artists
        $kuenstler = array_unique(array_map(static fn($e) => name_norm(tag1($e['tags'], 'ARTIST')), $liste));
        $ist_sampler = count($kuenstler) > 1 || in_array(strtolower(tag1($erst, 'COMPILATION')), ['1', 'true', 'yes'], true);
        if ($ist_sampler) {
            $aa = 'Various Artists';
            $aa_mbids = ['89ad4ac3-39f7-470e-963a-56509c546377'];
        } else {
            $aa = $mehrheit($liste, 'ARTIST') ?: '[unbekannt]';
            $aa_namen = tagliste($erst, 'ARTISTS');
            $aa_mbids = tagliste($erst, 'MUSICBRAINZ_ARTISTID', true);
        }
    }
    $album_credit = credit_holen(credit_teile_aus_tags($aa, $aa_namen, $aa_mbids, tagliste($erst, 'ALBUMARTISTSORT')));

    // Vorhandene Edition dieser Gruppe? Erst über den Gruppenschlüssel, sonst über die Edition, zu der die meisten
    // Dateien schon gehören (so bleiben IDs, Favoriten und Playlists erhalten, wenn sich die Gruppierung ändert)
    $edition = db_zeile('SELECT * FROM editionen WHERE gruppe_hash = :g', ['g' => $gruppe_hash]);
    if (!$edition) {
        $tids = array_values(array_filter(array_map(static fn($e) => $e['track_id'], $liste)));
        if ($tids) {
            [$in, $pp] = db_in($tids);
            $pp['oh'] = $basis_hash;
            $eid = db_wert("SELECT m.edition_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id
                WHERE t.id IN {$in} AND e.ordner_hash = :oh GROUP BY m.edition_id ORDER BY COUNT(*) DESC, (e.quelle <> 'tags') DESC LIMIT 1", $pp);
            if ($eid) {
                $edition = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $eid]);
            }
        }
    }
    $rel_mbid = tag1($erst, 'MUSICBRAINZ_ALBUMID');
    if (!$edition && ist_uuid($rel_mbid)) {
        $edition = db_zeile('SELECT * FROM editionen WHERE mbid = :m', ['m' => strtolower($rel_mbid)]);
    }
    $album_neu = false;

    if ($edition && $edition['quelle'] !== 'tags') {
        // Abgeglichene Edition: Struktur nicht anfassen, nur Ordnerbezug und Kennzahlen pflegen
        db_tun('UPDATE editionen SET ordner = :o, ordner_hash = :oh, gruppe_hash = :g WHERE id = :id', ['o' => mb_substr($basis, 0, 2000), 'oh' => $basis_hash, 'g' => $gruppe_hash, 'id' => $edition['id']]);
        scan_dateien_zuordnen((int) $edition['id'], $liste);
        // Zusatztitel aus Tags, deren Datei verschwunden ist, wieder entfernen (MusicBrainz-Titel bleiben als „Datei fehlt“)
        foreach (db_alle("SELECT t.id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id LEFT JOIN aufnahmen au ON au.id = t.aufnahme_id
                WHERE m.edition_id = :e AND t.mbid IS NULL AND (au.id IS NULL OR au.quelle = 'tags') AND NOT EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id)",
                ['e' => $edition['id']]) as $weg) {
            db_tun('DELETE FROM tracks WHERE id = :id', ['id' => $weg['id']]);
            geloescht_merken('track', (int) $weg['id']);
        }
        scan_cover_pruefen((int) $edition['id'], $basis, $liste, $wurzel);
        edition_kennzahlen((int) $edition['id']);
        album_anzeige_aktualisieren((int) $edition['album_id']);
        return ['edition_id' => (int) $edition['id'], 'album_neu' => false];
    }

    // Album (Release Group) bestimmen
    $rg_mbid = tag1($erst, 'MUSICBRAINZ_RELEASEGROUPID');
    $album_id = null;
    if (ist_uuid($rg_mbid)) {
        $album_id = db_wert('SELECT id FROM alben WHERE mbid = :m', ['m' => strtolower($rg_mbid)]);
    }
    if (!$album_id && $edition) {
        // Bisheriges Album behalten, solange Titel und Künstler noch passen
        $alt = db_zeile('SELECT id, titel, credit_id, quelle FROM alben WHERE id = :a', ['a' => $edition['album_id']]);
        if ($alt && ($alt['quelle'] !== 'tags' || (name_norm($alt['titel']) === name_norm($albumtitel) && (int) $alt['credit_id'] === (int) $album_credit))) {
            $album_id = $alt['id'];
        }
    }
    if (!$album_id) {
        // Gleicher Titel und gleicher Künstler -> weitere Edition desselben Albums (z. B. Original und Remaster in zwei Ordnern)
        $album_id = db_wert('SELECT id FROM alben WHERE credit_id <=> :c AND mbid IS NULL AND LOWER(titel) = LOWER(:t) LIMIT 1', ['c' => $album_credit, 't' => $albumtitel]);
    }
    [$datum, $jahr] = datum_aus_tag($mehrheit($liste, 'DATE', 'YEAR'));
    [$erstdatum, $erstjahr] = datum_aus_tag($mehrheit($liste, 'ORIGINALDATE', 'ORIGINALYEAR'));
    [$typ, $zusatz] = scan_albumtyp(tagliste($erst, 'RELEASETYPE', true));
    if (!$album_id) {
        $album_id = db_einfuegen('INSERT INTO alben (mbid, titel, credit_id, typ, zusatz_typen, erstjahr, erst_datum, quelle) VALUES (:m, :t, :c, :ty, :z, :j, :d, \'tags\')', [
            'm' => ist_uuid($rg_mbid) ? strtolower($rg_mbid) : null, 't' => mb_substr($albumtitel, 0, 500), 'c' => $album_credit,
            'ty' => $typ, 'z' => $zusatz, 'j' => $erstjahr ?? $jahr, 'd' => $erstdatum !== '' ? $erstdatum : $datum,
        ]);
        $album_neu = true;
    } else {
        $a = db_zeile('SELECT quelle, gesperrte_felder, erstjahr FROM alben WHERE id = :a', ['a' => $album_id]);
        if ($a && $a['quelle'] === 'tags') {
            db_tun('UPDATE alben SET titel = :t, credit_id = :c, typ = :ty, zusatz_typen = :z, erstjahr = LEAST(COALESCE(erstjahr, :j1), COALESCE(:j2, erstjahr, 9999)) WHERE id = :a', [
                't' => mb_substr($albumtitel, 0, 500), 'c' => $album_credit, 'ty' => $typ, 'z' => $zusatz,
                'j1' => $erstjahr ?? $jahr, 'j2' => $erstjahr ?? $jahr, 'a' => $album_id,
            ]);
        }
    }
    $album_id = (int) $album_id;

    // Edition anlegen/aktualisieren
    $ed_werte = [
        'm' => ist_uuid($rel_mbid) ? strtolower($rel_mbid) : null, 'a' => $album_id, 't' => mb_substr($albumtitel, 0, 500), 'c' => $album_credit,
        'd' => $datum, 'j' => $jahr, 'l' => mb_substr(tag1($erst, 'RELEASECOUNTRY'), 0, 10), 's' => mb_substr(strtolower(tag1($erst, 'RELEASESTATUS')), 0, 30),
        'b' => mb_substr(tag1($erst, 'BARCODE', 'UPC', 'EAN'), 0, 40), 'f' => mb_substr(tag1($erst, 'MEDIA'), 0, 120),
        'o' => mb_substr($basis, 0, 2000), 'oh' => $basis_hash, 'g' => $gruppe_hash,
    ];
    if ($edition) {
        // MBID nur setzen, wenn keine andere Edition sie schon trägt
        if ($ed_werte['m'] !== null && db_wert('SELECT id FROM editionen WHERE mbid = :m AND id <> :id', ['m' => $ed_werte['m'], 'id' => $edition['id']])) {
            $ed_werte['m'] = null;
        }
        $ed_werte['id'] = $edition['id'];
        db_tun('UPDATE editionen SET mbid = :m, album_id = :a, titel = :t, credit_id = :c, datum = :d, jahr = :j, land = :l, status = :s, barcode = :b,
                format_text = :f, ordner = :o, ordner_hash = :oh, gruppe_hash = :g WHERE id = :id', $ed_werte);
        $edition_id = (int) $edition['id'];
    } else {
        if ($ed_werte['m'] !== null && db_wert('SELECT id FROM editionen WHERE mbid = :m', ['m' => $ed_werte['m']])) {
            $ed_werte['m'] = null;
        }
        $edition_id = db_einfuegen('INSERT INTO editionen (mbid, album_id, titel, credit_id, datum, jahr, land, status, barcode, format_text, ordner, ordner_hash, gruppe_hash, quelle)
                VALUES (:m, :a, :t, :c, :d, :j, :l, :s, :b, :f, :o, :oh, :g, \'tags\')', $ed_werte);
    }

    // Label
    db_tun('DELETE FROM edition_labels WHERE edition_id = :e', ['e' => $edition_id]);
    $label = tag1($erst, 'LABEL', 'ORGANIZATION', 'PUBLISHER');
    $katnr = tag1($erst, 'CATALOGNUMBER');
    if ($label !== '' || $katnr !== '') {
        db_tun('INSERT INTO edition_labels (edition_id, label_id, katalognummer) VALUES (:e, :l, :k)', ['e' => $edition_id, 'l' => label_holen($label, tag1($erst, 'MUSICBRAINZ_LABELID')), 'k' => mb_substr($katnr, 0, 100)]);
    }

    // Tracks
    $behalten = [];
    $dt_cache = [];
    $folge = 0;
    usort($liste, static fn($x, $y) => strnatcasecmp($x['rel'], $y['rel']));
    foreach ($liste as $e) {
        $t = $e['tags'];
        $folge++;
        $disc = scan_disc_nr($e);
        [$nr] = nummer_paar(tag1($t, 'TRACKNUMBER', 'TRACK'));
        $dateiname = pathinfo($e['rel'], PATHINFO_FILENAME);
        if ($nr < 1 && preg_match('/^\s*(?:\d+[-.])?(\d{1,3})\b/', $dateiname, $m)) {
            $nr = (int) $m[1];
        }
        if ($nr < 1) {
            $nr = $folge;
        }
        $titel = tag1($t, 'TITLE');
        if ($titel === '') {
            $titel = trim((string) preg_replace('/^\s*(?:\d+[-.])?\d{1,3}\s*[-._)]*\s*/', '', $dateiname)) ?: $dateiname;
        }
        $dt_key = $disc;
        if (!isset($dt_cache[$dt_key])) {
            $dt_id = db_wert('SELECT id FROM datentraeger WHERE edition_id = :e AND pos = :p', ['e' => $edition_id, 'p' => $disc]);
            if (!$dt_id) {
                $dt_id = db_einfuegen('INSERT INTO datentraeger (edition_id, pos, format, titel) VALUES (:e, :p, :f, :t)',
                    ['e' => $edition_id, 'p' => $disc, 'f' => mb_substr(tag1($t, 'MEDIA'), 0, 40), 't' => mb_substr(tag1($t, 'DISCSUBTITLE', 'SETSUBTITLE'), 0, 500)]);
            } else {
                db_tun('UPDATE datentraeger SET titel = :t WHERE id = :id', ['t' => mb_substr(tag1($t, 'DISCSUBTITLE', 'SETSUBTITLE'), 0, 500), 'id' => $dt_id]);
            }
            $dt_cache[$dt_key] = (int) $dt_id;
        }
        $dt_id = $dt_cache[$dt_key];

        $credit = credit_holen(credit_teile_aus_tags(tag1($t, 'ARTIST') ?: $aa, tagliste($t, 'ARTISTS') ?: (count($t['ARTIST'] ?? []) > 1 ? $t['ARTIST'] : []),
            tagliste($t, 'MUSICBRAINZ_ARTISTID', true), tagliste($t, 'ARTISTSORT'))) ?? $album_credit;
        if (count($t['ARTIST'] ?? []) > 1 && tagliste($t, 'ARTISTS') === []) {
            // Mehrfachwert ARTIST ohne Anzeige-String: Anzeige zusammensetzen
            $credit = credit_holen(credit_teile_aus_tags(implode(' & ', $t['ARTIST']), $t['ARTIST'], tagliste($t, 'MUSICBRAINZ_ARTISTID', true))) ?? $credit;
        }
        $laenge = (int) ($e['technik']['laenge_ms'] ?? 0);

        // Aufnahme
        $rec_mbid = tag1($t, 'MUSICBRAINZ_TRACKID');
        $track = $e['track_id'] ? db_zeile('SELECT t.* FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE t.id = :t AND m.edition_id = :e', ['t' => $e['track_id'], 'e' => $edition_id]) : null;
        $aufnahme_id = null;
        if (ist_uuid($rec_mbid)) {
            $aufnahme_id = db_wert('SELECT id FROM aufnahmen WHERE mbid = :m', ['m' => strtolower($rec_mbid)]);
        }
        if (!$aufnahme_id && $track && $track['aufnahme_id']) {
            $aufnahme_id = $track['aufnahme_id'];
            $am = db_wert('SELECT mbid FROM aufnahmen WHERE id = :a', ['a' => $aufnahme_id]);
            if ($am !== null && ist_uuid($rec_mbid) && $am !== strtolower($rec_mbid)) {
                $aufnahme_id = null; // Datei wurde auf eine andere Aufnahme umgetaggt
            }
        }
        if ($aufnahme_id) {
            db_tun("UPDATE aufnahmen SET titel = :t, credit_id = :c, laenge_ms = :l WHERE id = :a AND quelle = 'tags'", ['t' => mb_substr($titel, 0, 500), 'c' => $credit, 'l' => $laenge, 'a' => $aufnahme_id]);
        } else {
            $aufnahme_id = db_einfuegen("INSERT INTO aufnahmen (mbid, titel, credit_id, laenge_ms, quelle) VALUES (:m, :t, :c, :l, 'tags')",
                ['m' => ist_uuid($rec_mbid) ? strtolower($rec_mbid) : null, 't' => mb_substr($titel, 0, 500), 'c' => $credit, 'l' => $laenge]);
        }
        $aufnahme_id = (int) $aufnahme_id;

        $tr_mbid = tag1($t, 'MUSICBRAINZ_RELEASETRACKID');
        $such = such_norm($titel, ...array_column(credit_liste($credit), 'name'));
        if ($track) {
            // Von Hand bearbeitete (gesperrte) Felder bleiben erhalten
            $sperre = array_filter(explode(',', (string) ($track['gesperrte_felder'] ?? '')), 'strlen');
            $t_titel = in_array('titel', $sperre, true) ? $track['titel'] : mb_substr($titel, 0, 500);
            $t_credit = in_array('kuenstler', $sperre, true) ? ($track['credit_id'] !== null ? (int) $track['credit_id'] : null) : $credit;
            $t_nummer = in_array('nummer', $sperre, true) ? $track['nummer'] : (string) $nr;
            $t_pos = in_array('nummer', $sperre, true) ? (int) $track['pos'] : $nr;
            $t_dt = in_array('nummer', $sperre, true) ? (int) $track['datentraeger_id'] : $dt_id; // CD gehört zur Nummer
            db_tun('UPDATE tracks SET mbid = :m, datentraeger_id = :d, pos = :p, nummer = :n, titel = :t, credit_id = :c, aufnahme_id = :a, laenge_ms = :l, suchtext = :s WHERE id = :id', [
                'm' => ist_uuid($tr_mbid) ? strtolower($tr_mbid) : null, 'd' => $t_dt, 'p' => $t_pos, 'n' => $t_nummer, 't' => $t_titel,
                'c' => $t_credit, 'a' => $aufnahme_id, 'l' => $laenge, 's' => such_norm($t_titel, ...array_column(credit_liste($t_credit), 'name')), 'id' => $track['id'],
            ]);
            $track_id = (int) $track['id'];
        } else {
            $track_id = db_einfuegen('INSERT INTO tracks (mbid, datentraeger_id, pos, nummer, titel, credit_id, aufnahme_id, laenge_ms, suchtext) VALUES (:m, :d, :p, :n, :t, :c, :a, :l, :s)', [
                'm' => ist_uuid($tr_mbid) ? strtolower($tr_mbid) : null, 'd' => $dt_id, 'p' => $nr, 'n' => (string) $nr, 't' => mb_substr($titel, 0, 500),
                'c' => $credit, 'a' => $aufnahme_id, 'l' => $laenge, 's' => $such,
            ]);
            db_tun('UPDATE dateien SET track_id = :t WHERE id = :id', ['t' => $track_id, 'id' => $e['id']]);
        }
        $behalten[] = $track_id;
        scan_explizit_aus_tags($track_id, $t, !$track);

        // Mitwirkende aus den Tags (Komponist, Produzent, Musiker …) an der Aufnahme
        scan_rollen_aus_tags($aufnahme_id, $t);
        // Genres der Aufnahme
        db_tun("DELETE FROM aufnahme_genres WHERE aufnahme_id = :a AND quelle = 'tags'", ['a' => $aufnahme_id]);
        foreach (scan_genres($t) as $gid) {
            db_tun("INSERT IGNORE INTO aufnahme_genres (aufnahme_id, genre_id, quelle) VALUES (:a, :g, 'tags')", ['a' => $aufnahme_id, 'g' => $gid]);
        }
    }

    // Tracks der Edition ohne Datei entfernen (nur bei Tag-Editionen)
    foreach (db_alle('SELECT t.id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $edition_id]) as $alt) {
        if (!in_array((int) $alt['id'], $behalten, true)) {
            db_tun('DELETE FROM tracks WHERE id = :id', ['id' => $alt['id']]);
            geloescht_merken('track', (int) $alt['id']);
        }
    }
    db_tun('DELETE FROM datentraeger WHERE edition_id = :e AND id NOT IN (SELECT datentraeger_id FROM tracks)', ['e' => $edition_id]);

    // Album-Genres = Vereinigung der Track-Genres
    db_tun("DELETE FROM album_genres WHERE album_id = :a AND quelle = 'tags'", ['a' => $album_id]);
    $gz = [];
    foreach ($liste as $e) {
        foreach (scan_genres($e['tags']) as $gid) {
            $gz[$gid] = true;
        }
    }
    foreach (array_keys($gz) as $gid) {
        db_tun("INSERT IGNORE INTO album_genres (album_id, genre_id, quelle) VALUES (:a, :g, 'tags')", ['a' => $album_id, 'g' => $gid]);
    }

    scan_cover_pruefen($edition_id, $basis, $liste, $wurzel);
    edition_kennzahlen($edition_id);
    album_anzeige_aktualisieren($album_id);
    if ($edition && (int) $edition['album_id'] !== $album_id) {
        album_anzeige_aktualisieren((int) $edition['album_id']); // Edition ist in ein anderes Album gewandert
    }
    album_suchtext_aktualisieren($album_id);
    db_tun('UPDATE alben SET hinzugefuegt_am = LEAST(hinzugefuegt_am, (SELECT MIN(d.gefunden_am) FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e)) WHERE id = :a',
        ['e' => $edition_id, 'a' => $album_id]);
    return ['edition_id' => $edition_id, 'album_neu' => $album_neu];
}

/** RELEASETYPE ("album", "album; live", "compilation") -> [Haupttyp, Zusatztypen] */
function scan_albumtyp(array $werte): array
{
    $haupt = 'album';
    $zusatz = [];
    foreach ($werte as $w) {
        $w = strtolower(trim($w));
        if (in_array($w, ['album', 'single', 'ep', 'broadcast'], true)) {
            $haupt = $w;
        } elseif ($w === 'other') {
            $haupt = 'sonstiges';
        } elseif (in_array($w, ['compilation', 'soundtrack', 'spokenword', 'interview', 'audiobook', 'audio drama', 'live', 'remix', 'dj-mix', 'mixtape/street', 'demo', 'field recording'], true)) {
            $zusatz[] = $w;
        }
    }
    return [$haupt, implode(',', array_unique($zusatz))];
}

/** Genre-IDs aus GENRE-Tags (Mehrfachwerte, ";" oder "/" getrennt). */
function scan_genres(array $t): array
{
    $ids = [];
    foreach ($t['GENRE'] ?? [] as $w) {
        foreach (preg_split('#\s*[;/|]\s*#', $w) ?: [] as $g) {
            $g = trim($g);
            if ($g !== '' && mb_strlen($g) <= 60 && ($id = genre_holen($g))) {
                $ids[$id] = $id;
            }
        }
    }
    return array_values($ids);
}

/** Rollen aus Tags an eine Aufnahme hängen. Vorher alte Tag-Rollen dieser Aufnahme entfernen. */
function scan_rollen_aus_tags(int $aufnahmeId, array $t): void
{
    db_tun("DELETE FROM beziehungen WHERE zu_art = 'aufnahme' AND zu_id = :a AND quelle = 'tags'", ['a' => $aufnahmeId]);
    $pos = 0;
    foreach (TAG_ROLLEN as $feld => $typ) {
        foreach (tagliste($t, $feld) as $name) {
            foreach (preg_split('/\s*;\s*/u', $name) ?: [] as $n) {
                if (trim($n) !== '') {
                    beziehung_anlegen($typ, 'kuenstler', kuenstler_holen(trim($n)), 'aufnahme', $aufnahmeId, ['pos' => $pos++]);
                }
            }
        }
    }
    // PERFORMER = "Name (Instrument)" (so schreibt es Picard)
    foreach (tagliste($t, 'PERFORMER') as $w) {
        if (preg_match('/^(.+?)\s*\(([^()]+)\)\s*$/u', $w, $m)) {
            $name = trim($m[1]);
            $instr = array_filter(array_map('trim', preg_split('/\s*(?:,| and | und )\s*/u', $m[2]) ?: []), 'strlen');
            $ist_gesang = (bool) array_filter($instr, static fn($i) => str_contains(mb_strtolower($i), 'vocal'));
            beziehung_anlegen($ist_gesang ? 'vocal' : 'instrument', 'kuenstler', kuenstler_holen($name), 'aufnahme', $aufnahmeId,
                ['instrumente' => $instr, 'pos' => $pos++]);
        } elseif (trim($w) !== '') {
            beziehung_anlegen('performer', 'kuenstler', kuenstler_holen(trim($w)), 'aufnahme', $aufnahmeId, ['pos' => $pos++]);
        }
    }
}

/** Cover einer Edition: Bild im Ordner hat Vorrang, sonst eingebettetes Bild. Nur neu, wenn sich die Quelle geändert hat. */
function scan_cover_pruefen(int $editionId, string $basis, array $liste, string $wurzel): void
{
    $ed = db_zeile('SELECT cover_datei, cover_signatur, cover_quelle FROM editionen WHERE id = :id', ['id' => $editionId]);
    if (!$ed || in_array($ed['cover_quelle'], ['manuell', 'musicbrainz'], true)) {
        return; // manuell gewähltes oder abgeglichenes Cover nie überschreiben
    }
    $ordner_abs = $basis === '.' ? $wurzel : $wurzel . '/' . $basis;
    $kandidaten = [$ordner_abs];
    foreach ($liste as $e) {
        $d = dirname($wurzel . '/' . $e['rel']);
        if (!in_array($d, $kandidaten, true)) {
            $kandidaten[] = $d;
        }
    }
    $datei = null;
    foreach ($kandidaten as $k) {
        if ($datei = ordner_bild_finden($k)) {
            break;
        }
    }
    $daten = null;
    $quelle = '';
    if ($datei) {
        $st = @stat($datei);
        $signatur = 'o:' . substr(hash('sha256', $datei . '|' . ($st['size'] ?? 0) . '|' . ($st['mtime'] ?? 0)), 0, 40);
        if ($signatur === $ed['cover_signatur'] && $ed['cover_datei'] !== '') {
            return;
        }
        $daten = @file_get_contents($datei);
        $quelle = 'ordner';
    } else {
        $mit_bild = null;
        foreach ($liste as $e) {
            if (!empty($e['hat_bild'])) {
                $mit_bild = $e;
                break;
            }
        }
        if (!$mit_bild) {
            if ($ed['cover_datei'] !== '' && $ed['cover_quelle'] !== '') {
                db_tun("UPDATE editionen SET cover_datei = '', cover_signatur = '', cover_quelle = '' WHERE id = :id", ['id' => $editionId]);
            }
            return;
        }
        $st = @stat($wurzel . '/' . $mit_bild['rel']);
        $signatur = 'e:' . substr(hash('sha256', $mit_bild['rel'] . '|' . ($st['size'] ?? 0) . '|' . ($st['mtime'] ?? 0)), 0, 40);
        if ($signatur === $ed['cover_signatur'] && $ed['cover_datei'] !== '') {
            return;
        }
        $b = eingebettetes_bild($wurzel . '/' . $mit_bild['rel']);
        $daten = $b[0] ?? null;
        $quelle = 'eingebettet';
    }
    if (!$daten) {
        return;
    }
    $schluessel = bild_speichern('cover', 'e' . $editionId, $daten);
    if ($schluessel) {
        if ($ed['cover_datei'] !== '' && $ed['cover_datei'] !== $schluessel) {
            bild_loeschen('cover', $ed['cover_datei']);
        }
        db_tun('UPDATE editionen SET cover_datei = :c, cover_signatur = :s, cover_quelle = :q WHERE id = :id', ['c' => $schluessel, 's' => $signatur, 'q' => $quelle, 'id' => $editionId]);
    }
}

// ---------- Start und Status ----------

/** Läuft gerade ein Scan? (Lebenszeichen jünger als 3 Minuten) */
function scan_laufend(): ?array
{
    return db_zeile("SELECT * FROM scan_laeufe WHERE status IN ('wartet','laeuft') AND COALESCE(lebenszeichen, gestartet_am) > (NOW() - INTERVAL 3 MINUTE) ORDER BY id DESC LIMIT 1");
}

/** Scan im Hintergrund starten. Liefert die Lauf-ID. */
function scan_starten(bool $voll, ?int $userId): int
{
    if ($l = scan_laufend()) {
        return (int) $l['id'];
    }
    db_tun("UPDATE scan_laeufe SET status = 'fehler', meldung = :m, beendet_am = NOW() WHERE status IN ('wartet','laeuft')", ['m' => t('Abgebrochen (kein Lebenszeichen mehr)')]);
    $id = db_einfuegen('INSERT INTO scan_laeufe (art, status, gestartet_von) VALUES (:a, \'wartet\', :u)', ['a' => $voll ? 'voll' : 'neu', 'u' => $userId]);
    $skript = realpath(__DIR__ . '/../scripts/scan.php');
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) $skript) . ' ' . (int) $id . ' > /dev/null 2>&1 &');
    return $id;
}

/**
 * Prüft, ob der Download-Ordner (SABnzbd, im Container PFAD_DOWNLOADS) und der Musikordner sich in die Quere kommen.
 * Verglichen wird über Gerät + Inode, denn im Container haben beide verschiedene Pfade, auch wenn es auf dem Server
 * derselbe Ordner ist. Konflikt, wenn der Download-Ordner
 *  - der Musikordner selbst ist,
 *  - das Import-Ziel (Musikordner/<download_ziel>) ist oder es enthält (Ziel liegt im Download-Ordner).
 * Liefert eine Erklärung oder null (alles in Ordnung / kein Download-Ordner).
 */
function download_ordner_konflikt(): ?string
{
    static $cache = null;
    if ($cache !== null) {
        return $cache ?: null;
    }
    $cache = '';
    $dl = (string) (konfig()['pfade']['downloads'] ?? '');
    $musik = (string) konfig()['pfade']['musik'];
    if ($dl === '' || !is_dir($dl) || !($sd = @stat($dl))) {
        return null;
    }
    $id = static fn(array $st): string => $st['dev'] . ':' . $st['ino'];
    $dlId = $id($sd);
    if (($sm = @stat($musik)) && $id($sm) === $dlId) {
        return $cache = t('Der Download-Ordner (DOWNLOAD_PFAD) ist derselbe Ordner wie der Musikordner.');
    }
    $ziel = trim((string) (function_exists('einstellung') ? einstellung('download_ziel') : '') ?: 'Downloads', '/');
    // vom Import-Ziel aufwärts bis zum Musikordner: ist einer davon der Download-Ordner?
    $p = rtrim($musik, '/') . '/' . $ziel;
    while (strlen($p) > strlen(rtrim($musik, '/'))) {
        if (is_dir($p) && ($st = @stat($p)) && $id($st) === $dlId) {
            return $cache = t('Der Download-Ordner (DOWNLOAD_PFAD) ist derselbe Ordner wie „{ordner}“ im Musikordner, in den importiert wird. SABnzbd muss in einen eigenen Ordner laden (z. B. /mnt/user/downloads/complete/music).',
                ['ordner' => substr($p, strlen(rtrim($musik, '/')) + 1)]);
        }
        $p = dirname($p);
    }
    return null;
}

