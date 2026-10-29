<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/einstellungen.php';

/**
 * Bausteine der Bibliothek: Künstler, Credits, Genres, Labels, Rollen.
 * Werden vom Scan und später vom MusicBrainz-Abgleich gleichermaßen benutzt.
 */

/** Künstler finden oder anlegen. Mit mbid eindeutig; ohne mbid über den normalisierten Namen. */
function kuenstler_holen(string $name, ?string $mbid = null, string $sortname = '', string $quelle = 'tags'): int
{
    $name = trim($name) !== '' ? trim($name) : '[unbekannt]';
    if (($um = name_umgedreht($name)) !== null) {
        // „Jackson, Michael“ aus den Tags: als „Michael Jackson“ führen
        $name = $um;
    }
    $norm = name_norm($name) ?: mb_strtolower($name);
    if (ist_uuid($mbid)) {
        $mbid = strtolower(trim((string) $mbid));
        $id = db_wert('SELECT id FROM kuenstler WHERE mbid = :m', ['m' => $mbid]);
        if ($id) {
            return (int) $id;
        }
        // Gleicher Name ohne MBID vorhanden? Dann diesen übernehmen statt doppelt anzulegen
        $id = db_wert('SELECT id FROM kuenstler WHERE name_norm = :n AND mbid IS NULL ORDER BY id LIMIT 1', ['n' => $norm]);
        if ($id) {
            db_tun('UPDATE kuenstler SET mbid = :m WHERE id = :id', ['m' => $mbid, 'id' => $id]);
            return (int) $id;
        }
    } else {
        $mbid = null;
        $id = db_wert('SELECT id FROM kuenstler WHERE name_norm = :n ORDER BY (mbid IS NULL) DESC, id LIMIT 1', ['n' => $norm]);
        if ($id) {
            return (int) $id;
        }
    }
    return db_einfuegen('INSERT INTO kuenstler (mbid, name, name_norm, sortname, quelle) VALUES (:m, :n, :nn, :s, :q)', [
        'm' => $mbid, 'n' => mb_substr($name, 0, 500), 'nn' => $norm, 's' => mb_substr(sortname_aus($name), 0, 500), 'q' => $quelle, // sortiert wird nach Vorname Nachname
    ]);
}

/**
 * Credit aus Teilen anlegen/finden. $teile = [['kuenstler_id' => …, 'name_als' => …, 'verbindung' => …], …]
 * oder statt kuenstler_id: 'name' (+ optional 'mbid', 'sortname').
 */
function credit_holen(array $teile, string $quelle = 'tags'): ?int
{
    $norm = [];
    foreach (array_values($teile) as $i => $t) {
        $kid = (int) ($t['kuenstler_id'] ?? 0);
        if (!$kid) {
            if (trim((string) ($t['name'] ?? '')) === '') {
                continue;
            }
            $kid = kuenstler_holen((string) $t['name'], $t['mbid'] ?? null, (string) ($t['sortname'] ?? ''), $quelle);
        }
        $als = name_anzeige((string) ($t['name_als'] ?? $t['name'] ?? ''));
        if ($als === '') {
            $als = (string) db_wert('SELECT name FROM kuenstler WHERE id = :id', ['id' => $kid]);
        }
        $norm[] = ['k' => $kid, 'a' => mb_substr($als, 0, 500), 'v' => mb_substr((string) ($t['verbindung'] ?? ''), 0, 60)];
    }
    if (!$norm) {
        return null;
    }
    $norm[count($norm) - 1]['v'] = rtrim($norm[count($norm) - 1]['v']) === '' ? '' : $norm[count($norm) - 1]['v'];
    $schluessel = hash('sha256', json_encode($norm, JSON_UNESCAPED_UNICODE));
    $id = db_wert('SELECT id FROM credits WHERE schluessel = :s', ['s' => $schluessel]);
    if ($id) {
        return (int) $id;
    }
    $anzeige = '';
    foreach ($norm as $n) {
        $anzeige .= $n['a'] . $n['v'];
    }
    try {
        $id = db_einfuegen('INSERT INTO credits (schluessel, anzeige) VALUES (:s, :a)', ['s' => $schluessel, 'a' => mb_substr(trim($anzeige), 0, 1000)]);
    } catch (PDOException $e) {
        // gleichzeitig angelegt
        return (int) db_wert('SELECT id FROM credits WHERE schluessel = :s', ['s' => $schluessel]);
    }
    foreach ($norm as $pos => $n) {
        db_tun('INSERT INTO credit_namen (credit_id, pos, kuenstler_id, name_als, verbindung) VALUES (:c, :p, :k, :a, :v)',
            ['c' => $id, 'p' => $pos, 'k' => $n['k'], 'a' => $n['a'], 'v' => $n['v']]);
    }
    return $id;
}

/**
 * Anzeige-Namen aller Credits neu berechnen, immer aus den „credited as“-Schreibweisen (name_als).
 * Die Standardnamen-Einstellung betrifft nur Tags und Ordnernamen in den Dateien (tag_credit), nicht die Anzeige.
 * Liefert die Anzahl geänderter Credits.
 */
function credits_anzeige_angleichen(): int
{
    $n = 0;
    foreach (db_alle('SELECT id, anzeige FROM credits') as $c) {
        $teile = db_alle('SELECT cn.name_als, cn.verbindung, k.name FROM credit_namen cn JOIN kuenstler k ON k.id = cn.kuenstler_id WHERE cn.credit_id = :c ORDER BY cn.pos', ['c' => $c['id']]);
        if (!$teile) {
            continue;
        }
        $neu = '';
        foreach ($teile as $t) {
            $neu .= (string) ($t['name_als'] ?: $t['name']) . (string) $t['verbindung'];
        }
        $neu = mb_substr(trim($neu), 0, 1000);
        if ($neu !== '' && $neu !== (string) $c['anzeige']) {
            db_tun('UPDATE credits SET anzeige = :a WHERE id = :id', ['a' => $neu, 'id' => $c['id']]);
            $n++;
        }
    }
    return $n;
}

/**
 * Teile eines Credits aus Tags bilden – ohne zu raten:
 * Nur wenn die Tags die Künstler einzeln nennen (ARTISTS / Mehrfachwerte), wird aufgeteilt.
 * "Simon & Garfunkel" ohne Einzelnennung bleibt also EIN Künstler.
 */
function credit_teile_aus_tags(string $anzeige, array $namen, array $mbids, array $sortnamen = []): array
{
    $anzeige = trim($anzeige);
    $namen = array_values(array_filter(array_map('trim', $namen), 'strlen'));
    $mbids = array_values(array_filter(array_map('trim', $mbids), 'ist_uuid'));
    if (count($namen) <= 1) {
        $name = $anzeige !== '' ? $anzeige : ($namen[0] ?? '');
        if ($name === '') {
            return [];
        }
        return [['name' => $name, 'name_als' => $name, 'mbid' => count($mbids) === 1 ? $mbids[0] : null, 'sortname' => $sortnamen[0] ?? '', 'verbindung' => '']];
    }
    // Namen der Reihe nach im Anzeige-Text suchen, Verbindungswörter dazwischen übernehmen
    $teile = [];
    $pos = 0;
    $gefunden = $anzeige !== '';
    $starts = [];
    foreach ($namen as $i => $n) {
        $p = $anzeige !== '' ? mb_stripos($anzeige, $n, $pos) : false;
        if ($p === false) {
            $gefunden = false;
            break;
        }
        $starts[$i] = $p;
        $pos = $p + mb_strlen($n);
    }
    $anzahl = count($namen);
    foreach ($namen as $i => $n) {
        if ($gefunden) {
            $ende = $starts[$i] + mb_strlen($n);
            $verb = $i + 1 < $anzahl ? mb_substr($anzeige, $ende, $starts[$i + 1] - $ende) : mb_substr($anzeige, $ende);
            $als = mb_substr($anzeige, $starts[$i], mb_strlen($n));
        } else {
            $verb = $i + 1 < $anzahl ? ($i + 2 === $anzahl ? ' & ' : ', ') : '';
            $als = $n;
        }
        $teile[] = ['name' => $n, 'name_als' => $als, 'mbid' => count($mbids) === $anzahl ? $mbids[$i] : null,
            'sortname' => count($sortnamen) === $anzahl ? $sortnamen[$i] : '', 'verbindung' => $verb];
    }
    return $teile;
}

/** Credit als Liste für die API: [{id, name, verbindung}] */
function credit_liste(?int $creditId): array
{
    if (!$creditId) {
        return [];
    }
    static $cache = [];
    if (!isset($cache[$creditId])) {
        $cache[$creditId] = array_map(static fn($z) => ['id' => (int) $z['kuenstler_id'], 'name' => $z['name_als'], 'verbindung' => $z['verbindung']],
            db_alle('SELECT kuenstler_id, name_als, verbindung FROM credit_namen WHERE credit_id = :c ORDER BY pos', ['c' => $creditId]));
    }
    return $cache[$creditId];
}

/** Credits für viele IDs auf einmal (vermeidet viele Einzelabfragen in Listen). */
function credit_listen(array $ids): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    $aus = [];
    if (!$ids) {
        return $aus;
    }
    [$in, $p] = db_in($ids);
    foreach (db_alle("SELECT credit_id, kuenstler_id, name_als, verbindung FROM credit_namen WHERE credit_id IN {$in} ORDER BY credit_id, pos", $p) as $z) {
        $aus[(int) $z['credit_id']][] = ['id' => (int) $z['kuenstler_id'], 'name' => $z['name_als'], 'verbindung' => $z['verbindung']];
    }
    return $aus;
}

function genre_holen(string $name): ?int
{
    $name = trim($name);
    $norm = mb_substr(name_norm($name), 0, 120);
    if ($norm === '') {
        return null;
    }
    $id = db_wert('SELECT id FROM genres WHERE name_norm = :n', ['n' => $norm]);
    if ($id) {
        return (int) $id;
    }
    try {
        return db_einfuegen('INSERT INTO genres (name, name_norm) VALUES (:a, :n)', ['a' => mb_substr($name, 0, 120), 'n' => $norm]);
    } catch (PDOException $e) {
        return (int) db_wert('SELECT id FROM genres WHERE name_norm = :n', ['n' => $norm]);
    }
}

function label_holen(string $name, ?string $mbid = null): ?int
{
    $name = trim($name);
    if ($name === '') {
        return null;
    }
    if (ist_uuid($mbid)) {
        $id = db_wert('SELECT id FROM labels WHERE mbid = :m', ['m' => strtolower((string) $mbid)]);
        if ($id) {
            return (int) $id;
        }
    }
    $norm = name_norm($name);
    $id = db_wert('SELECT id FROM labels WHERE name_norm = :n ORDER BY id LIMIT 1', ['n' => $norm]);
    if ($id) {
        return (int) $id;
    }
    return db_einfuegen('INSERT INTO labels (mbid, name, name_norm) VALUES (:m, :n, :nn)', ['m' => ist_uuid($mbid) ? strtolower((string) $mbid) : null, 'n' => mb_substr($name, 0, 500), 'nn' => $norm]);
}

function beziehungstyp_id(string $schluessel): ?int
{
    static $cache = [];
    if (!array_key_exists($schluessel, $cache)) {
        $id = db_wert('SELECT id FROM beziehungstypen WHERE schluessel = :s', ['s' => $schluessel]);
        $cache[$schluessel] = $id ? (int) $id : null;
    }
    return $cache[$schluessel];
}

function instrument_holen(string $name, ?string $mbid = null): ?int
{
    $name = mb_strtolower(trim($name));
    if ($name === '') {
        return null;
    }
    $id = db_wert('SELECT id FROM instrumente WHERE name = :n', ['n' => $name]);
    if ($id) {
        return (int) $id;
    }
    try {
        return db_einfuegen('INSERT INTO instrumente (mbid, name, name_de) VALUES (:m, :n, :d)', ['m' => ist_uuid($mbid) ? $mbid : null, 'n' => mb_substr($name, 0, 200), 'd' => instrument_deutsch($name)]);
    } catch (PDOException $e) {
        return (int) db_wert('SELECT id FROM instrumente WHERE name = :n', ['n' => $name]);
    }
}

/** Gängige Instrumentennamen auf Deutsch (Rest bleibt englisch, bis ihn jemand übersetzt). */
function instrument_deutsch(string $name): string
{
    $de = [
        'guitar' => 'Gitarre', 'electric guitar' => 'E-Gitarre', 'acoustic guitar' => 'Akustikgitarre', 'bass guitar' => 'Bassgitarre', 'bass' => 'Bass',
        'electric bass guitar' => 'E-Bass', 'double bass' => 'Kontrabass', 'drums' => 'Schlagzeug', 'drums (drum set)' => 'Schlagzeug', 'drum set' => 'Schlagzeug',
        'percussion' => 'Perkussion', 'piano' => 'Klavier', 'keyboard' => 'Keyboard', 'keyboards' => 'Keyboards', 'synthesizer' => 'Synthesizer',
        'organ' => 'Orgel', 'hammond organ' => 'Hammondorgel', 'violin' => 'Violine', 'viola' => 'Bratsche', 'cello' => 'Cello', 'strings' => 'Streicher',
        'trumpet' => 'Trompete', 'trombone' => 'Posaune', 'saxophone' => 'Saxophon', 'tenor saxophone' => 'Tenorsaxophon', 'alto saxophone' => 'Altsaxophon',
        'flute' => 'Flöte', 'clarinet' => 'Klarinette', 'horn' => 'Horn', 'french horn' => 'Waldhorn', 'harmonica' => 'Mundharmonika', 'harp' => 'Harfe',
        'vocals' => 'Gesang', 'lead vocals' => 'Leadgesang', 'background vocals' => 'Hintergrundgesang', 'backing vocals' => 'Hintergrundgesang', 'choir' => 'Chor',
        'programming' => 'Programmierung', 'drum machine' => 'Drumcomputer', 'turntables' => 'Plattenspieler', 'vibraphone' => 'Vibraphon', 'marimba' => 'Marimba',
        'banjo' => 'Banjo', 'mandolin' => 'Mandoline', 'ukulele' => 'Ukulele', 'accordion' => 'Akkordeon', 'tuba' => 'Tuba', 'oboe' => 'Oboe', 'bassoon' => 'Fagott',
    ];
    return $de[mb_strtolower($name)] ?? '';
}

/** Beziehung Künstler –(Rolle)→ Objekt anlegen. */
function beziehung_anlegen(string $typ, string $vonArt, int $vonId, string $zuArt, int $zuId, array $optionen = []): ?int
{
    $tid = beziehungstyp_id($typ);
    if (!$tid) {
        return null;
    }
    $id = db_einfuegen('INSERT INTO beziehungen (typ_id, von_art, von_id, zu_art, zu_id, attribute, name_als, beginn, ende, quelle, pos)
                        VALUES (:t, :va, :vi, :za, :zi, :a, :n, :b, :e, :q, :p)', [
        't' => $tid, 'va' => $vonArt, 'vi' => $vonId, 'za' => $zuArt, 'zi' => $zuId,
        'a' => mb_substr((string) ($optionen['attribute'] ?? ''), 0, 500), 'n' => mb_substr((string) ($optionen['name_als'] ?? ''), 0, 500),
        'b' => (string) ($optionen['beginn'] ?? ''), 'e' => (string) ($optionen['ende'] ?? ''), 'q' => (string) ($optionen['quelle'] ?? 'tags'),
        'p' => (int) ($optionen['pos'] ?? 0),
    ]);
    foreach ($optionen['instrumente'] ?? [] as $instr) {
        $iid = instrument_holen((string) $instr);
        if ($iid) {
            db_tun('INSERT IGNORE INTO beziehung_instrumente (beziehung_id, instrument_id) VALUES (:b, :i)', ['b' => $id, 'i' => $iid]);
        }
    }
    return $id;
}

/** Merkt sich gelöschte Objekte, damit Apps ihren Zwischenspeicher abgleichen können. */
function geloescht_merken(string $art, int $id): void
{
    db_tun('INSERT INTO geloescht (art, objekt_id) VALUES (:a, :i)', ['a' => $art, 'i' => $id]);
}

/** Kennzahlen einer Edition neu berechnen (Anzahl Tracks/Dateien, Länge, beste Qualität). */
function edition_kennzahlen(int $editionId): void
{
    $z = db_zeile(
        'SELECT COUNT(DISTINCT t.id) AS tracks, COUNT(DISTINCT CASE WHEN d.id IS NOT NULL THEN t.id END) AS mit_datei,
                SUM(COALESCE(t.laenge_ms, 0)) AS laenge
         FROM datentraeger m JOIN tracks t ON t.datentraeger_id = m.id
         LEFT JOIN dateien d ON d.track_id = t.id
         WHERE m.edition_id = :e', ['e' => $editionId]) ?? [];
    $q = db_zeile(
        'SELECT d.format, d.codec, MAX(d.bittiefe) AS bits, MAX(d.abtastrate) AS rate, MAX(d.kanaele) AS kan, MAX(d.bitrate) AS br
         FROM datentraeger m JOIN tracks t ON t.datentraeger_id = m.id JOIN dateien d ON d.track_id = t.id
         WHERE m.edition_id = :e GROUP BY d.format, d.codec ORDER BY MAX(d.bittiefe) DESC, MAX(d.abtastrate) DESC LIMIT 1', ['e' => $editionId]);
    $qualitaet = '';
    if ($q) {
        $fmt = strtoupper($q['format'] === 'm4a' && $q['codec'] === 'alac' ? 'ALAC' : ($q['codec'] === 'aac' ? 'AAC' : (string) $q['format']));
        if ((int) $q['bits'] > 0) {
            $qualitaet = $fmt . ' ' . (int) $q['bits'] . '/' . rtrim(rtrim(number_format((int) $q['rate'] / 1000, 1, '.', ''), '0'), '.');
        } else {
            $qualitaet = $fmt . ((int) $q['br'] > 0 ? ' ' . (int) round($q['br'] / 1000) . ' kbit/s' : '');
        }
        if ((int) $q['kan'] > 2) {
            $qualitaet .= ' · ' . ((int) $q['kan'] === 6 ? '5.1' : ((int) $q['kan'] === 8 ? '7.1' : t('{n} Kanäle', ['n' => (int) $q['kan']])));
        }
    }
    db_tun('UPDATE editionen SET anzahl_tracks = :t, anzahl_dateien = :d, laenge_ms = :l, beste_qualitaet = :q WHERE id = :e',
        ['t' => (int) ($z['tracks'] ?? 0), 'd' => (int) ($z['mit_datei'] ?? 0), 'l' => (int) ($z['laenge'] ?? 0), 'q' => $qualitaet, 'e' => $editionId]);
    // Kennzeichnung „explizit“ zusammenfassen (mindestens ein Titel explizit; Clean-Fassung, wenn bearbeitet und keiner explizit)
    $x = db_zeile('SELECT MAX(t.explizit = 1) AS e, MAX(t.explizit = 2) AS c FROM datentraeger m JOIN tracks t ON t.datentraeger_id = m.id WHERE m.edition_id = :e', ['e' => $editionId]) ?? [];
    db_tun('UPDATE editionen SET explizit = :x, clean = :c WHERE id = :e', ['x' => (int) ($x['e'] ?? 0), 'c' => (int) ($x['e'] ?? 0) ? 0 : (int) ($x['c'] ?? 0), 'e' => $editionId]);
}

/**
 * Welche Edition sieht die Familie? Admin-Wahl hat Vorrang, sonst die mit den meisten vorhandenen Tracks,
 * bei Gleichstand die neueste.
 */
function album_anzeige_edition(int $albumId): ?int
{
    $wahl = db_wert('SELECT a.edition_wahl_id FROM alben a JOIN editionen e ON e.id = a.edition_wahl_id AND e.album_id = a.id WHERE a.id = :a', ['a' => $albumId]);
    if ($wahl) {
        return (int) $wahl;
    }
    $id = db_wert('SELECT id FROM editionen WHERE album_id = :a ORDER BY (anzahl_dateien > 0) DESC, anzahl_dateien DESC, anzahl_tracks DESC, datum DESC, id DESC LIMIT 1', ['a' => $albumId]);
    return $id ? (int) $id : null;
}

/** Angezeigte Edition im Album zwischenspeichern (für schnelle Listen). */
function album_anzeige_aktualisieren(int $albumId): void
{
    db_tun('UPDATE alben SET anzeige_edition_id = :e WHERE id = :a', ['e' => album_anzeige_edition($albumId), 'a' => $albumId]);
}

/** Alben-Suchtext aus Titel und Künstlern neu bilden. */
function album_suchtext_aktualisieren(int $albumId): void
{
    $a = db_zeile('SELECT titel, credit_id FROM alben WHERE id = :a', ['a' => $albumId]);
    if (!$a) {
        return;
    }
    $namen = array_column(credit_liste((int) $a['credit_id']), 'name');
    db_tun('UPDATE alben SET suchtext = :s WHERE id = :a', ['s' => such_norm($a['titel'], ...$namen), 'a' => $albumId]);
}

/** Verwaiste Objekte entfernen (nach dem Scan). Nur Einträge aus Tags – Manuelles und MusicBrainz-Daten bleiben. */
function bibliothek_aufraeumen(): array
{
    $n = ['alben' => 0, 'kuenstler' => 0];
    foreach (db_alle("SELECT a.id FROM alben a LEFT JOIN editionen e ON e.album_id = a.id WHERE e.id IS NULL AND a.quelle = 'tags'") as $z) {
        db_tun('DELETE FROM alben WHERE id = :id', ['id' => $z['id']]);
        geloescht_merken('album', (int) $z['id']);
        $n['alben']++;
    }
    db()->exec('DELETE FROM aufnahmen WHERE quelle <> \'manuell\' AND id NOT IN (SELECT aufnahme_id FROM tracks WHERE aufnahme_id IS NOT NULL)');
    db()->exec("DELETE FROM werke WHERE quelle <> 'manuell' AND id NOT IN (SELECT werk_id FROM aufnahme_werke)");
    db()->exec("DELETE FROM beziehungen WHERE zu_art = 'aufnahme' AND zu_id NOT IN (SELECT id FROM aufnahmen)");
    db()->exec("DELETE FROM beziehungen WHERE zu_art = 'werk' AND zu_id NOT IN (SELECT id FROM werke)");
    db()->exec("DELETE FROM beziehungen WHERE zu_art = 'edition' AND zu_id NOT IN (SELECT id FROM editionen)");
    db()->exec("DELETE FROM beziehungen WHERE zu_art = 'album' AND zu_id NOT IN (SELECT id FROM alben)");
    db()->exec('DELETE FROM credits WHERE id NOT IN (SELECT credit_id FROM alben WHERE credit_id IS NOT NULL)
                AND id NOT IN (SELECT credit_id FROM editionen WHERE credit_id IS NOT NULL)
                AND id NOT IN (SELECT credit_id FROM tracks WHERE credit_id IS NOT NULL)
                AND id NOT IN (SELECT credit_id FROM aufnahmen WHERE credit_id IS NOT NULL)');
    foreach (db_alle("SELECT k.id FROM kuenstler k WHERE k.quelle = 'tags'
                        AND NOT EXISTS (SELECT 1 FROM credit_namen c WHERE c.kuenstler_id = k.id)
                        AND NOT EXISTS (SELECT 1 FROM beziehungen b WHERE b.von_art = 'kuenstler' AND b.von_id = k.id)
                        AND NOT EXISTS (SELECT 1 FROM beziehungen b2 WHERE b2.zu_art = 'kuenstler' AND b2.zu_id = k.id)") as $z) {
        db_tun('DELETE FROM kuenstler WHERE id = :id', ['id' => $z['id']]);
        geloescht_merken('kuenstler', (int) $z['id']);
        $n['kuenstler']++;
    }
    db()->exec('DELETE FROM genres WHERE id NOT IN (SELECT genre_id FROM album_genres) AND id NOT IN (SELECT genre_id FROM aufnahme_genres)');
    db()->exec('DELETE FROM labels WHERE id NOT IN (SELECT label_id FROM edition_labels WHERE label_id IS NOT NULL)');
    return $n;
}

/** Künstler $von in $nach aufgehen lassen (Credits, Beziehungen, Aliase, Favoriten, Bild). */
function kuenstler_zusammenfuehren(int $von, int $nach): void
{
    if ($von === $nach) {
        return;
    }
    db_tun('UPDATE credit_namen SET kuenstler_id = :n WHERE kuenstler_id = :v', ['n' => $nach, 'v' => $von]);
    db_tun("UPDATE beziehungen SET von_id = :n WHERE von_art = 'kuenstler' AND von_id = :v", ['n' => $nach, 'v' => $von]);
    db_tun("UPDATE beziehungen SET zu_id = :n WHERE zu_art = 'kuenstler' AND zu_id = :v", ['n' => $nach, 'v' => $von]);
    db_tun("DELETE FROM beziehungen WHERE von_art = 'kuenstler' AND zu_art = 'kuenstler' AND von_id = zu_id");
    db_tun('UPDATE kuenstler_aliase SET kuenstler_id = :n WHERE kuenstler_id = :v', ['n' => $nach, 'v' => $von]);
    db_tun("UPDATE IGNORE favoriten SET objekt_id = :n WHERE art = 'kuenstler' AND objekt_id = :v", ['n' => $nach, 'v' => $von]);
    db_tun("DELETE FROM favoriten WHERE art = 'kuenstler' AND objekt_id = :v", ['v' => $von]);
    $alt = db_zeile('SELECT bild_datei, bild_quelle, bio, bio_quelle FROM kuenstler WHERE id = :v', ['v' => $von]);
    if ($alt && $alt['bild_datei'] !== '') {
        db_tun("UPDATE kuenstler SET bild_datei = :b, bild_quelle = :q WHERE id = :n AND bild_datei = ''", ['b' => $alt['bild_datei'], 'q' => $alt['bild_quelle'], 'n' => $nach]);
    }
    if ($alt && $alt['bio'] !== null) {
        db_tun('UPDATE kuenstler SET bio = :b, bio_quelle = :q WHERE id = :n AND bio IS NULL', ['b' => $alt['bio'], 'q' => $alt['bio_quelle'], 'n' => $nach]);
    }
    db_tun('DELETE FROM kuenstler WHERE id = :v', ['v' => $von]);
    geloescht_merken('kuenstler', $von);
}

/** Anzeige und Schlüssel eines Credits neu berechnen; fällt er mit einem vorhandenen zusammen, wird dieser verwendet. */
function credit_neu_berechnen(int $creditId): int
{
    $namen = db_alle('SELECT kuenstler_id, name_als, verbindung FROM credit_namen WHERE credit_id = :c ORDER BY pos', ['c' => $creditId]);
    if (!$namen) {
        return $creditId;
    }
    $norm = array_map(static fn($n) => ['k' => (int) $n['kuenstler_id'], 'a' => $n['name_als'], 'v' => $n['verbindung']], $namen);
    $schluessel = hash('sha256', json_encode($norm, JSON_UNESCAPED_UNICODE));
    $anzeige = trim(implode('', array_map(static fn($n) => $n['a'] . $n['v'], $norm)));
    $anderer = db_wert('SELECT id FROM credits WHERE schluessel = :s AND id <> :c', ['s' => $schluessel, 'c' => $creditId]);
    if ($anderer) {
        foreach (['alben', 'editionen', 'tracks', 'aufnahmen'] as $tab) {
            db_tun("UPDATE {$tab} SET credit_id = :n WHERE credit_id = :c", ['n' => $anderer, 'c' => $creditId]);
        }
        db_tun('DELETE FROM credits WHERE id = :c', ['c' => $creditId]);
        return (int) $anderer;
    }
    db_tun('UPDATE credits SET schluessel = :s, anzeige = :a WHERE id = :c', ['s' => $schluessel, 'a' => mb_substr($anzeige, 0, 1000), 'c' => $creditId]);
    return $creditId;
}

/**
 * Vorhandene „Nachname, Vorname“-Künstler auf „Vorname Nachname“ umstellen (einmalig per Migration, danach beim Einlesen).
 * Gibt es den Künstler in richtiger Schreibweise schon, werden beide zusammengeführt. Gesperrte Namen bleiben.
 */
function kuenstler_namen_umdrehen(): int
{
    $n = 0;
    $betroffen = [];
    foreach (db_alle("SELECT id, mbid, name, sortname, gesperrte_felder FROM kuenstler WHERE name LIKE '%,%'") as $k) {
        $neu = name_umgedreht((string) $k['name']);
        if ($neu === null || in_array('name', array_map('trim', explode(',', (string) $k['gesperrte_felder'])), true)) {
            continue;
        }
        $norm = name_norm($neu) ?: mb_strtolower($neu);
        $ziel = db_zeile('SELECT id, mbid FROM kuenstler WHERE name_norm = :n AND id <> :id ORDER BY (mbid IS NULL), id LIMIT 1', ['n' => $norm, 'id' => $k['id']]);
        if ($ziel && !($ziel['mbid'] && $k['mbid'] && $ziel['mbid'] !== $k['mbid'])) {
            if ($k['mbid'] && !$ziel['mbid']) {
                kuenstler_zusammenfuehren((int) $ziel['id'], (int) $k['id']); // der mit MBID bleibt
                db_tun('UPDATE kuenstler SET name = :n, name_norm = :nn WHERE id = :id', ['n' => $neu, 'nn' => $norm, 'id' => $k['id']]);
                $betroffen[] = (int) $k['id'];
            } else {
                kuenstler_zusammenfuehren((int) $k['id'], (int) $ziel['id']);
                $betroffen[] = (int) $ziel['id'];
            }
        } else {
            db_tun('UPDATE kuenstler SET name = :n, name_norm = :nn WHERE id = :id', ['n' => mb_substr($neu, 0, 500), 'nn' => $norm, 'id' => $k['id']]);
            $betroffen[] = (int) $k['id'];
        }
        $n++;
    }
    // Schreibweise in den Credits („name_als“) ebenfalls umdrehen
    $credits = [];
    foreach (db_alle("SELECT credit_id, pos, name_als FROM credit_namen WHERE name_als LIKE '%,%'") as $z) {
        if (($neu = name_umgedreht((string) $z['name_als'])) !== null) {
            db_tun('UPDATE credit_namen SET name_als = :a WHERE credit_id = :c AND pos = :p', ['a' => mb_substr($neu, 0, 500), 'c' => $z['credit_id'], 'p' => $z['pos']]);
            $credits[(int) $z['credit_id']] = true;
        }
    }
    if ($betroffen) {
        [$in, $p] = db_in(array_values(array_unique($betroffen)));
        foreach (db_alle("SELECT DISTINCT credit_id FROM credit_namen WHERE kuenstler_id IN {$in}", $p) as $z) {
            $credits[(int) $z['credit_id']] = true;
        }
    }
    $neue_ids = [];
    foreach (array_keys($credits) as $cid) {
        $neue_ids[] = credit_neu_berechnen($cid);
    }
    if ($neue_ids) {
        [$in, $p] = db_in(array_values(array_unique($neue_ids)));
        foreach (db_alle("SELECT id FROM alben WHERE credit_id IN {$in}", $p) as $a) {
            album_suchtext_aktualisieren((int) $a['id']);
        }
        foreach (db_alle("SELECT id, titel, credit_id FROM tracks WHERE credit_id IN {$in}", $p) as $t) {
            db_tun('UPDATE tracks SET suchtext = :s WHERE id = :id', ['s' => such_norm($t['titel'], ...array_column(credit_liste((int) $t['credit_id']), 'name')), 'id' => $t['id']]);
        }
    }
    return $n;
}
