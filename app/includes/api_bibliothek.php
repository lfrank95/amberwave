<?php
declare(strict_types=1);
require_once __DIR__ . '/api.php';
require_once __DIR__ . '/bibliothek.php';

/** Standard-Spalten für Album-Kacheln (Album + angezeigte Edition). */
const ALBUM_SPALTEN = 'a.id, a.titel, a.credit_id, a.typ, a.zusatz_typen, a.erstjahr, a.hinzugefuegt_am, e.id AS edition_id, e.jahr AS ed_jahr,
    e.cover_datei, e.beste_qualitaet, e.anzahl_tracks, e.anzahl_dateien, e.laenge_ms, a.editionen_einzeln, e.titel AS ed_titel, e.kommentar AS ed_kommentar, e.land AS ed_land, e.explizit AS ed_explizit';

/** Zeilen (ALBUM_SPALTEN) in API-Objekte umwandeln. */
function album_items(array $zeilen, ?int $userId = null): array
{
    $credits = credit_listen(array_column($zeilen, 'credit_id'));
    $fav = [];
    if ($userId && $zeilen) {
        [$in, $p] = db_in(array_column($zeilen, 'id'));
        $p['u'] = $userId;
        foreach (db_alle("SELECT objekt_id FROM favoriten WHERE user_id = :u AND art = 'album' AND objekt_id IN {$in}", $p) as $f) {
            $fav[(int) $f['objekt_id']] = true;
        }
    }
    return array_map(static fn($z) => [
        'id' => (int) $z['id'],
        'titel' => $z['titel'],
        'kuenstler' => $credits[(int) $z['credit_id']] ?? [],
        'jahr' => $z['erstjahr'] !== null ? (int) $z['erstjahr'] : ($z['ed_jahr'] !== null ? (int) $z['ed_jahr'] : null),
        'typ' => $z['typ'],
        'zusatz' => $z['zusatz_typen'] !== '' ? explode(',', $z['zusatz_typen']) : [],
        'edition_id' => (int) $z['edition_id'],
        'cover' => bild_url('cover', $z['cover_datei'], 300),
        'cover_gross' => bild_url('cover', $z['cover_datei'], 1200),
        'farbe' => bild_farbe('cover', $z['cover_datei']),
        'qualitaet' => $z['beste_qualitaet'],
        'tracks' => (int) $z['anzahl_tracks'],
        'laenge_ms' => (int) $z['laenge_ms'],
        'hinzugefuegt' => iso($z['hinzugefuegt_am']),
        'favorit' => isset($fav[(int) $z['id']]),
        'einzeln' => !empty($z['editionen_einzeln']),
        'version' => !empty($z['editionen_einzeln']) ? edition_kurzname($z) : null,
        'explizit' => !empty($z['ed_explizit']),
    ], $zeilen);
}

/** Kurzer Name einer Edition für getrennt angezeigte Versionen: Kommentar („Remaster“), sonst abweichender Titel, sonst Jahr/Land */
function edition_kurzname(array $z): string
{
    if (trim((string) ($z['ed_kommentar'] ?? '')) !== '') {
        return trim((string) $z['ed_kommentar']);
    }
    if (isset($z['ed_titel']) && name_norm((string) $z['ed_titel']) !== name_norm((string) $z['titel'])) {
        $rest = trim((string) preg_replace('/^' . preg_quote((string) $z['titel'], '/') . '\s*/iu', '', (string) $z['ed_titel']));
        return trim($rest !== '' ? $rest : (string) $z['ed_titel'], ' ()[]-–');
    }
    return trim(implode(' · ', array_filter([$z['ed_jahr'] ?? null, $z['ed_land'] ?? null])));
}

/** Name einer Edition, falls sie einen hat (MusicBrainz-Kommentar wie „Deluxe Edition“ oder abweichender Titel) – sonst '' */
function edition_name(array $ed, string $albumtitel): string
{
    $k = trim((string) ($ed['kommentar'] ?? ''));
    if ($k !== '') {
        return $k;
    }
    $t = trim((string) ($ed['titel'] ?? ''));
    if ($t !== '' && name_norm($t) !== name_norm($albumtitel)) {
        $rest = trim((string) preg_replace('/^' . preg_quote($albumtitel, '/') . '\s*/iu', '', $t));
        return trim($rest !== '' ? $rest : $t, ' ()[]-–:');
    }
    return '';
}

/** Suchbegriff in LIKE-Bedingungen für jedes Wort zerlegen. */
function such_bedingung(string $q, string $spalte, array &$p, string $praefix = 'q'): string
{
    $woerter = array_slice(array_filter(explode(' ', name_norm($q)), 'strlen'), 0, 8);
    if (!$woerter) {
        return '1=1';
    }
    $teile = [];
    foreach ($woerter as $i => $w) {
        $p[$praefix . $i] = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $w) . '%';
        $teile[] = "{$spalte} LIKE :{$praefix}{$i}";
    }
    return '(' . implode(' AND ', $teile) . ')';
}

/**
 * Rang eines Treffers (kleiner = besser): 0 genau der Suchtext, 1 beginnt damit, 2 jedes Wort beginnt ein Wort im Text,
 * 3 nur irgendwo mittendrin („bru“ in „Fabrulous“).
 */
function such_rang(string $q, string $spalte, array &$p, string $praefix = 'r'): string
{
    $n = name_norm($q);
    $woerter = array_slice(array_filter(explode(' ', $n), 'strlen'), 0, 8);
    if (!$woerter) {
        return '3';
    }
    $esc = static fn(string $w): string => str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $w);
    $p[$praefix . 'n'] = $n;
    $p[$praefix . 'p'] = $esc($n) . '%';
    $wort = [];
    foreach ($woerter as $i => $w) {
        $p[$praefix . 'a' . $i] = $esc($w) . '%';
        $p[$praefix . 'b' . $i] = '% ' . $esc($w) . '%';
        $wort[] = "({$spalte} LIKE :{$praefix}a{$i} OR {$spalte} LIKE :{$praefix}b{$i})";
    }
    return "CASE WHEN {$spalte} = :{$praefix}n THEN 0 WHEN {$spalte} LIKE :{$praefix}p THEN 1 WHEN " . implode(' AND ', $wort) . ' THEN 2 ELSE 3 END';
}

/** Gibt es Treffer, die an Wortanfängen passen, fallen reine „mittendrin“-Treffer weg (sonst bleiben sie als Auffangnetz). */
function such_filter(array $zeilen): array
{
    foreach ($zeilen as $z) {
        if ((int) $z['rang'] < 3) {
            return array_values(array_filter($zeilen, static fn($x) => (int) $x['rang'] < 3));
        }
    }
    return $zeilen;
}

function api_alben_liste(array $user): array
{
    $p = [];
    $wo = ['e.anzahl_dateien > 0'];
    $typ = (string) ($_GET['typ'] ?? '');
    if (in_array($typ, ['album', 'single', 'ep', 'broadcast', 'sonstiges'], true)) {
        $wo[] = 'a.typ = :typ';
        $p['typ'] = $typ;
    } elseif (in_array($typ, ['live', 'compilation', 'soundtrack', 'remix'], true)) {
        $wo[] = 'FIND_IN_SET(:typ, a.zusatz_typen) > 0';
        $p['typ'] = $typ;
    } elseif ($typ === 'studio') {
        $wo[] = "a.typ = 'album' AND a.zusatz_typen = ''";
    }
    $fam = (string) ($_GET['familie'] ?? '');
    if (($g = api_int('genre')) && $fam === '') {
        // Heißt das Genre wie eine Familie (Pop, Elektro …), gilt die ganze Familie
        $fam = (string) genre_familie_kopf((string) db_wert('SELECT name FROM genres WHERE id = :g', ['g' => $g]));
        if ($fam === '') {
            // Einzelnes Genre: MusicBrainz-Genres zählen erst ab einem Stimmenanteil (ein einzelner Ausreißer reicht nicht)
            $wo[] = "EXISTS (SELECT 1 FROM album_genres ag WHERE ag.album_id = a.id AND ag.genre_id = :g AND (ag.quelle <> 'musicbrainz' OR ag.anteil >= 0.15))";
            $p['g'] = $g;
        }
    }
    if ($fam !== '' && isset(GENRE_FAMILIEN[$fam])) {
        $wo[] = 'EXISTS (SELECT 1 FROM album_familien af WHERE af.album_id = a.id AND af.familie = :fam AND af.wert >= :fw)';
        $p['fam'] = $fam;
        $p['fw'] = genre_familie_schwelle();
    }
    if ($j = api_int('jahrzehnt')) {
        $wo[] = 'COALESCE(a.erstjahr, e.jahr) BETWEEN :j1 AND :j2';
        $p['j1'] = $j;
        $p['j2'] = $j + 9;
    }
    if ($k = api_int('kuenstler')) {
        $wo[] = 'EXISTS (SELECT 1 FROM credit_namen cn WHERE cn.credit_id = a.credit_id AND cn.kuenstler_id = :k)';
        $p['k'] = $k;
    }
    if (!empty($_GET['favoriten'])) {
        $wo[] = "EXISTS (SELECT 1 FROM favoriten f WHERE f.user_id = :fu AND f.art = 'album' AND f.objekt_id = a.id)";
        $p['fu'] = (int) $user['id'];
    }
    $q = trim((string) ($_GET['q'] ?? ''));
    if ($q !== '') {
        $wo[] = such_bedingung($q, 'a.suchtext', $p);
    }
    $erster = '(SELECT k.sortname FROM credit_namen cn JOIN kuenstler k ON k.id = cn.kuenstler_id WHERE cn.credit_id = a.credit_id ORDER BY cn.pos LIMIT 1)';
    $b = (string) ($_GET['buchstabe'] ?? '');
    if (preg_match('/^[A-Z]$/', $b)) {
        $wo[] = "UPPER(LEFT({$erster}, 1)) = :bu";
        $p['bu'] = $b;
    } elseif ($b === '#') {
        $wo[] = "UPPER(LEFT({$erster}, 1)) NOT BETWEEN 'A' AND 'Z'";
    }
    $sort = (string) ($_GET['sort'] ?? 'kuenstler');
    $richtung = ($_GET['richtung'] ?? '') === 'ab' ? 'DESC' : 'ASC';
    $sortier = match ($sort) {
        // Gruppiert nach Albumkünstler: gleiche Künstlerangabe immer am Stück (Solo vor Kollaborationen), darin chronologisch
        'gruppiert' => "({$erster} = '[unbekannt]'), {$erster} {$richtung}, (SELECT COUNT(*) FROM credit_namen cn2 WHERE cn2.credit_id = a.credit_id), (SELECT c.anzeige FROM credits c WHERE c.id = a.credit_id), a.credit_id, COALESCE(a.erstjahr, e.jahr), a.titel",
        'neu' => 'a.hinzugefuegt_am DESC, a.id DESC',
        'titel' => "a.titel {$richtung}",
        'jahr' => "COALESCE(a.erstjahr, e.jahr) {$richtung}, a.titel",
        'zufall' => 'RAND()',
        default => "(SELECT k.sortname FROM credit_namen cn JOIN kuenstler k ON k.id = cn.kuenstler_id WHERE cn.credit_id = a.credit_id ORDER BY cn.pos LIMIT 1) {$richtung}, COALESCE(a.erstjahr, e.jahr), a.titel",
    };
    $pro = max(1, min(500, api_int('pro_seite', 120)));
    $seite = max(1, api_int('seite', 1));
    $bed = implode(' AND ', $wo);
    $gesamt = (int) db_wert("SELECT COUNT(*) FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0)) WHERE {$bed}", $p);
    $zeilen = db_alle('SELECT ' . ALBUM_SPALTEN . " FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0)) WHERE {$bed} ORDER BY {$sortier} LIMIT " . $pro . ' OFFSET ' . (($seite - 1) * $pro), $p);
    $aus = ['gesamt' => $gesamt, 'seite' => $seite, 'pro_seite' => $pro, 'alben' => album_items($zeilen, (int) $user['id'])];
    if ($sort === 'gruppiert') {
        // Bilder der Albumkünstler für die Gruppen-Köpfe
        $ids = [];
        foreach ($aus['alben'] as $a) {
            foreach ($a['kuenstler'] as $k) {
                $ids[$k['id']] = true;
            }
        }
        $aus['bilder'] = [];
        if ($ids) {
            [$in, $pp] = db_in(array_keys($ids));
            foreach (db_alle("SELECT id, bild_datei FROM kuenstler WHERE id IN {$in} AND bild_datei <> ''", $pp) as $z) {
                $aus['bilder'][(string) $z['id']] = bild_url('kuenstler', $z['bild_datei'], 300);
            }
        }
    }
    return $aus;
}

/** Tracknummer für die Anzeige: "5" bzw. "2-3" bei mehreren Datenträgern */
function track_label(int $disc, int $nr, bool $mehrere): string
{
    return $mehrere ? $disc . '-' . $nr : (string) $nr;
}

/** Rollenname mit Zusatz: "Ko-Produzent", "Gitarre (zusätzlich)" */
function rolle_mit_zusatz(string $rolle, string $attribute): string
{
    $a = array_filter(explode(',', $attribute), 'strlen');
    $rolle = t($rolle); // Rollennamen stehen deutsch in der Datenbank (beziehungstypen.name_de), die Übersetzung kommt aus dem Wörterbuch
    if (in_array('co', $a, true)) {
        $rolle = t('Ko-{rolle}', ['rolle' => $rolle]);
    }
    if (in_array('assistant', $a, true)) {
        $rolle = t('{rolle} (Assistenz)', ['rolle' => $rolle]);
    } elseif (in_array('additional', $a, true)) {
        $rolle = t('{rolle} (zusätzlich)', ['rolle' => $rolle]);
    }
    return $rolle;
}

/** Instrumentname für die Anzeige: deutsch (name_de, sonst Originalname) bzw. in Englisch der MusicBrainz-Name */
function instrument_anzeige(string $name, string $name_de): string
{
    if (sprache() === 'en' && $name !== '') {
        return mb_strtoupper(mb_substr($name, 0, 1)) . mb_substr($name, 1);
    }
    return $name_de !== '' ? $name_de : $name;
}

/** SQL-Ausdruck für den Instrumentnamen (Tabellenalias $i) passend zu instrument_anzeige() */
function instrument_sql(string $i = 'i'): string
{
    return sprache() === 'en'
        ? "CONCAT(UPPER(LEFT({$i}.name, 1)), SUBSTRING({$i}.name, 2))"
        : "COALESCE(NULLIF({$i}.name_de, ''), {$i}.name)";
}

/**
 * Rollen (Credits) für eine Edition einsammeln.
 * $aufnahme_labels = [aufnahme_id => [Tracknummern für die Anzeige]].
 * Pro Gruppe (Produktion, Songwriting, Musiker …) und Person ein Eintrag: Rollen bzw. Instrumente und Titel werden zusammengefasst.
 * Liefert [gruppen, pro_aufnahme].
 */
function edition_credits(int $editionId, int $albumId, array $aufnahme_labels): array
{
    $auf_ids = array_keys($aufnahme_labels);
    [$in, $p] = db_in($auf_ids ?: [0], 'au');
    // Kompositionen (Werke) der Aufnahmen: Songwriter hängen bei MusicBrainz am Werk
    $werk_aufnahmen = [];
    foreach (db_alle("SELECT aufnahme_id, werk_id FROM aufnahme_werke WHERE aufnahme_id IN {$in}", $p) as $z) {
        $werk_aufnahmen[(int) $z['werk_id']][] = (int) $z['aufnahme_id'];
    }
    [$inw, $pw] = db_in(array_keys($werk_aufnahmen) ?: [0], 'wk');
    $p += $pw;
    $p['ed'] = $editionId;
    $p['al'] = $albumId;
    $zeilen = db_alle(
        "SELECT b.id, b.zu_art, b.zu_id, b.attribute, b.name_als, b.pos, bt.schluessel, bt.name_de, bt.gruppe, bt.reihenfolge, k.id AS kid, k.name AS kname
         FROM beziehungen b JOIN beziehungstypen bt ON bt.id = b.typ_id JOIN kuenstler k ON k.id = b.von_id AND b.von_art = 'kuenstler'
         WHERE (b.zu_art = 'aufnahme' AND b.zu_id IN {$in}) OR (b.zu_art = 'werk' AND b.zu_id IN {$inw})
            OR (b.zu_art = 'edition' AND b.zu_id = :ed) OR (b.zu_art = 'album' AND b.zu_id = :al)
         ORDER BY bt.reihenfolge, b.pos, b.id", $p);
    $instr = [];
    if ($zeilen) {
        [$in2, $p2] = db_in(array_column($zeilen, 'id'), 'bz');
        foreach (db_alle("SELECT bi.beziehung_id, i.name, i.name_de FROM beziehung_instrumente bi JOIN instrumente i ON i.id = bi.instrument_id WHERE bi.beziehung_id IN {$in2}", $p2) as $z) {
            $instr[(int) $z['beziehung_id']][] = instrument_anzeige((string) $z['name'], (string) $z['name_de']);
        }
    }
    $gesamt_tracks = count(array_unique(array_merge(...array_values($aufnahme_labels ?: [[]]))));
    $gruppen = [];
    $pro_aufnahme = [];
    foreach ($zeilen as $z) {
        $instrumente = $instr[(int) $z['id']] ?? [];
        // Bei Musikern zählen die Instrumente, sonst der Rollenname
        $teile = ($z['gruppe'] === 'musiker' && $instrumente) ? $instrumente : [rolle_mit_zusatz((string) $z['name_de'], (string) $z['attribute'])];
        $kuenstler = ['id' => (int) $z['kid'], 'name' => $z['name_als'] !== '' ? $z['name_als'] : $z['kname']];
        $gast = str_contains((string) $z['attribute'], 'guest');
        $betroffen = match ($z['zu_art']) {
            'aufnahme' => [(int) $z['zu_id']],
            'werk' => $werk_aufnahmen[(int) $z['zu_id']] ?? [],
            default => null,
        };
        $schluessel = $z['gruppe'] . '|' . $z['kid'];
        if (!isset($gruppen[$z['gruppe']][$schluessel])) {
            $gruppen[$z['gruppe']][$schluessel] = ['kuenstler' => $kuenstler, 'rollen' => [], 'schluessel' => [], 'tracks' => [], 'alle' => false, 'gast' => $gast];
        }
        $e = &$gruppen[$z['gruppe']][$schluessel];
        foreach ($teile as $t) {
            $e['rollen'][$t] = true;
        }
        $e['schluessel'][$z['schluessel']] = true;
        $e['gast'] = $e['gast'] && $gast;
        if ($betroffen === null) {
            $e['alle'] = true;
        } else {
            foreach ($betroffen as $aid) {
                $e['tracks'] = array_values(array_unique(array_merge($e['tracks'], $aufnahme_labels[$aid] ?? [])));
                $pk = $z['gruppe'] . '|' . $z['kid'];
                if (!isset($pro_aufnahme[$aid][$pk])) {
                    $pro_aufnahme[$aid][$pk] = ['kuenstler' => $kuenstler, 'rollen' => [], 'gruppe' => $z['gruppe'], 'gast' => $gast];
                }
                foreach ($teile as $t) {
                    $pro_aufnahme[$aid][$pk]['rollen'][$t] = true;
                }
            }
        }
        unset($e);
    }
    $reihenfolge = ['produktion' => t('Produktion'), 'songwriting' => t('Songwriting'), 'musiker' => t('Musiker'), 'technik' => t('Technik{x}', ['x' => '']), 'band' => t('Band{x}', ['x' => '']), 'sonstiges' => t('Sonstiges')];
    $aus = [];
    foreach ($reihenfolge as $g => $titel) {
        if (empty($gruppen[$g])) {
            continue;
        }
        $eintraege = [];
        foreach ($gruppen[$g] as $e) {
            $alle = $e['alle'] || ($gesamt_tracks > 0 && count($e['tracks']) >= $gesamt_tracks);
            $tracks = $e['tracks'];
            natsort($tracks);
            $eintraege[] = ['kuenstler' => $e['kuenstler'], 'rolle' => implode(', ', array_keys($e['rollen'])), 'schluessel' => array_keys($e['schluessel']),
                'instrumente' => [], 'tracks' => $alle ? null : array_values($tracks), 'gast' => $e['gast']];
        }
        // Wer an allen Titeln beteiligt ist, zuerst
        usort($eintraege, static fn($x, $y) => [($x['tracks'] === null ? 0 : 1), $x['tracks'] === null ? 0 : -count($x['tracks'])] <=> [($y['tracks'] === null ? 0 : 1), $y['tracks'] === null ? 0 : -count($y['tracks'])]);
        $aus[] = ['gruppe' => $g, 'titel' => $titel, 'eintraege' => $eintraege];
    }
    $pa = [];
    foreach ($pro_aufnahme as $aid => $liste) {
        foreach ($liste as $x) {
            $pa[$aid][] = ['kuenstler' => $x['kuenstler'], 'rolle' => implode(', ', array_keys($x['rollen'])), 'gruppe' => $x['gruppe'], 'instrumente' => [], 'gast' => $x['gast']];
        }
    }
    return [$aus, $pa];
}

/** Tracks einer Edition mit Dateiinfos (für Album, Warteschlange, App). */
function edition_tracks(int $editionId, ?int $userId = null): array
{
    $zeilen = db_alle(
        'SELECT t.id, t.pos, t.nummer, t.titel, t.credit_id, t.aufnahme_id, t.laenge_ms, t.explizit, m.pos AS disc, m.titel AS disc_titel,
                d.id AS datei_id, d.format, d.codec, d.abtastrate, d.bittiefe, d.kanaele, d.bitrate, d.laenge_ms AS d_laenge,
                d.rg_track_db, d.rg_album_db, d.rg_track_peak, d.rg_album_peak, d.lufs, d.lra, d.true_peak
         FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id
         LEFT JOIN dateien d ON d.id = (SELECT d2.id FROM dateien d2 WHERE d2.track_id = t.id ORDER BY d2.bittiefe DESC, d2.abtastrate DESC, d2.id LIMIT 1)
         WHERE m.edition_id = :e ORDER BY m.pos, t.pos, t.id', ['e' => $editionId]);
    $credits = credit_listen(array_column($zeilen, 'credit_id'));
    $mehrere = count(array_unique(array_column($zeilen, 'disc'))) > 1;
    $fav = [];
    if ($userId && $zeilen) {
        [$in, $p] = db_in(array_column($zeilen, 'id'));
        $p['u'] = $userId;
        foreach (db_alle("SELECT objekt_id FROM favoriten WHERE user_id = :u AND art = 'track' AND objekt_id IN {$in}", $p) as $f) {
            $fav[(int) $f['objekt_id']] = true;
        }
    }
    return array_map(static fn($z) => [
        'id' => (int) $z['id'],
        'disc' => (int) $z['disc'],
        'disc_titel' => $z['disc_titel'],
        'nr' => (int) $z['pos'],
        'label' => track_label((int) $z['disc'], (int) $z['pos'], $mehrere),
        'titel' => $z['titel'],
        'kuenstler' => $credits[(int) $z['credit_id']] ?? [],
        'aufnahme_id' => $z['aufnahme_id'] !== null ? (int) $z['aufnahme_id'] : null,
        'laenge_ms' => (int) ($z['laenge_ms'] ?: $z['d_laenge']),
        'verfuegbar' => $z['datei_id'] !== null,
        'format' => $z['datei_id'] !== null ? [
            'datei' => $z['format'], 'codec' => $z['codec'], 'abtastrate' => (int) $z['abtastrate'], 'bittiefe' => (int) $z['bittiefe'],
            'kanaele' => (int) $z['kanaele'], 'bitrate' => (int) $z['bitrate'],
        ] : null,
        'replaygain' => $z['datei_id'] !== null ? [
            'track_db' => $z['rg_track_db'] !== null ? (float) $z['rg_track_db'] : null, 'album_db' => $z['rg_album_db'] !== null ? (float) $z['rg_album_db'] : null,
            'track_peak' => $z['rg_track_peak'] !== null ? (float) $z['rg_track_peak'] : null, 'album_peak' => $z['rg_album_peak'] !== null ? (float) $z['rg_album_peak'] : null,
        ] : null,
        'lautheit' => $z['lufs'] !== null ? ['lufs' => (float) $z['lufs'], 'lra' => $z['lra'] !== null ? (float) $z['lra'] : null,
            'true_peak' => $z['true_peak'] !== null ? (float) $z['true_peak'] : null] : null,
        'favorit' => isset($fav[(int) $z['id']]),
        'explizit' => $z['explizit'] !== null ? (int) $z['explizit'] : null,
    ], $zeilen);
}

function api_album(array $user, int $id): array
{
    $a = db_zeile('SELECT * FROM alben WHERE id = :id', ['id' => $id]);
    if (!$a) {
        throw new ApiFehler(t('Album nicht gefunden.'), 404);
    }
    $ist_admin = ist_admin($user);
    $edition_id = (int) ($a['anzeige_edition_id'] ?? 0);
    if ($w = api_int('edition')) {
        // Admin: jede Edition; Familie: jede Edition mit Dateien (z. B. getrennt angezeigte Versionen)
        $edition_id = (int) (db_wert('SELECT id FROM editionen WHERE id = :e AND album_id = :a' . ($ist_admin ? '' : ' AND anzahl_dateien > 0'), ['e' => $w, 'a' => $id]) ?: $edition_id);
    }
    $ed = db_zeile('SELECT * FROM editionen WHERE id = :e', ['e' => $edition_id]);
    if (!$ed || (!$ist_admin && (int) $ed['anzahl_dateien'] === 0)) {
        throw new ApiFehler(t('Album nicht gefunden.'), 404);
    }
    $tracks = edition_tracks($edition_id, (int) $user['id']);
    $labels = [];
    foreach ($tracks as $t) {
        if ($t['aufnahme_id']) {
            $labels[$t['aufnahme_id']][] = $t['label'];
        }
    }
    [$credits, $pro_aufnahme] = edition_credits($edition_id, $id, $labels);
    foreach ($tracks as &$t) {
        $t['credits'] = $t['aufnahme_id'] ? ($pro_aufnahme[$t['aufnahme_id']] ?? []) : [];
    }
    unset($t);
    // Hat die angezeigte Edition keine Mitwirkenden, eine abgeglichene Schwester-Edition aber schon: deren Angaben zeigen (Zuordnung über den Titel)
    $credits_quelle = null;
    $ohne_eigene = !array_filter($credits, static fn($g) => $g['gruppe'] !== 'sonstiges');
    if ($ohne_eigene) {
        $alt = db_zeile("SELECT id, titel, jahr, land, kommentar FROM editionen WHERE album_id = :a AND id <> :e AND quelle = 'musicbrainz' ORDER BY anzahl_tracks DESC, id LIMIT 1", ['a' => $id, 'e' => $edition_id]);
        if ($alt) {
            $nach_titel = [];
            foreach ($tracks as $t) {
                $nach_titel[name_norm($t['titel'])][] = $t['label'];
            }
            $labels2 = [];
            $auf_titel = [];
            foreach (db_alle('SELECT t.titel, t.aufnahme_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e AND t.aufnahme_id IS NOT NULL', ['e' => $alt['id']]) as $f) {
                $n = name_norm($f['titel']);
                if (isset($nach_titel[$n])) {
                    $labels2[(int) $f['aufnahme_id']] = $nach_titel[$n];
                    $auf_titel[$n] = (int) $f['aufnahme_id'];
                }
            }
            [$credits2, $pro2] = edition_credits((int) $alt['id'], $id, $labels2);
            if ($credits2) {
                $credits = $credits2;
                foreach ($tracks as &$t) {
                    $aid = $auf_titel[name_norm($t['titel'])] ?? null;
                    if (!$t['credits'] && $aid && isset($pro2[$aid])) {
                        $t['credits'] = $pro2[$aid];
                    }
                }
                unset($t);
                $credits_quelle = t('Mitwirkende aus der Edition „{titel}“{kommentar}{jahr} · Quelle: MusicBrainz', [
                    'titel' => $alt['titel'], 'kommentar' => $alt['kommentar'] !== '' ? ' (' . $alt['kommentar'] . ')' : '', 'jahr' => $alt['jahr'] ? ', ' . $alt['jahr'] : '']);
            }
        }
    }
    $label = db_alle('SELECT l.id, l.name, el.katalognummer FROM edition_labels el LEFT JOIN labels l ON l.id = el.label_id WHERE el.edition_id = :e', ['e' => $edition_id]);
    $genres = db_alle('SELECT g.id, g.name FROM album_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.album_id = :a ORDER BY g.name', ['a' => $id]);
    $editionen = $ist_admin ? array_map(static fn($e) => [
        'id' => (int) $e['id'], 'titel' => $e['titel'], 'datum' => $e['datum'], 'jahr' => $e['jahr'] !== null ? (int) $e['jahr'] : null, 'land' => $e['land'],
        'format' => $e['format_text'], 'tracks' => (int) $e['anzahl_tracks'], 'dateien' => (int) $e['anzahl_dateien'], 'qualitaet' => $e['beste_qualitaet'],
        'ordner' => $e['ordner'], 'quelle' => $e['quelle'], 'mbid' => $e['mbid'], 'angezeigt' => (int) $e['id'] === (int) $a['anzeige_edition_id'],
    ], db_alle('SELECT * FROM editionen WHERE album_id = :a ORDER BY datum, id', ['a' => $id])) : null;

    $fav = (bool) db_wert("SELECT 1 FROM favoriten WHERE user_id = :u AND art = 'album' AND objekt_id = :a", ['u' => $user['id'], 'a' => $id]);
    $kuenstler = credit_liste((int) $a['credit_id']);

    return [
        'id' => (int) $a['id'],
        'mbid' => $a['mbid'],
        'titel' => $a['titel'],
        'kuenstler' => $kuenstler,
        'typ' => $a['typ'],
        'zusatz' => $a['zusatz_typen'] !== '' ? explode(',', $a['zusatz_typen']) : [],
        'jahr' => $a['erstjahr'] !== null ? (int) $a['erstjahr'] : ($ed['jahr'] !== null ? (int) $ed['jahr'] : null),
        'beschreibung' => $a['beschreibung'],
        'beschreibung_quelle' => $a['beschreibung_quelle'],
        'beschreibung_maschinell' => (bool) $a['beschreibung_maschinell'],
        'genres' => array_map(static fn($g) => ['id' => (int) $g['id'], 'name' => $g['name']], $genres),
        'favorit' => $fav,
        'hinzugefuegt' => iso($a['hinzugefuegt_am']),
        'edition' => [
            'id' => (int) $ed['id'], 'mbid' => $ed['mbid'], 'titel' => $ed['titel'], 'datum' => $ed['datum'], 'jahr' => $ed['jahr'] !== null ? (int) $ed['jahr'] : null,
            'land' => $ed['land'], 'barcode' => $ed['barcode'], 'format' => $ed['format_text'], 'kommentar' => $ed['kommentar'],
            'cover' => bild_url('cover', $ed['cover_datei'], 600), 'cover_gross' => bild_url('cover', $ed['cover_datei'], 1200),
            'qualitaet' => $ed['beste_qualitaet'], 'laenge_ms' => (int) $ed['laenge_ms'], 'tracks' => (int) $ed['anzahl_tracks'],
            'labels' => array_map(static fn($l) => ['id' => $l['id'] !== null ? (int) $l['id'] : null, 'name' => $l['name'], 'katalognummer' => $l['katalognummer']], $label),
            'quelle' => $ed['quelle'],
            'explizit' => (bool) $ed['explizit'], 'clean' => (bool) $ed['clean'],
            'name' => edition_name($ed, (string) $a['titel']),
            // Lautheit nach EBU R128 (über alle Titel am Stück gemessen); PLR = Abstand True-Peak zu Lautheit
            'lautheit' => $ed['album_lufs'] !== null ? [
                'lufs' => (float) $ed['album_lufs'], 'lra' => $ed['album_lra'] !== null ? (float) $ed['album_lra'] : null,
                'true_peak' => $ed['album_true_peak'] !== null ? (float) $ed['album_true_peak'] : null,
                'sample_peak' => $ed['album_sample_peak'] !== null ? (float) $ed['album_sample_peak'] : null,
                'plr' => $ed['album_true_peak'] !== null ? round((float) $ed['album_true_peak'] - (float) $ed['album_lufs'], 1) : null,
            ] : null,
        ],
        'tracks' => $tracks,
        'credits' => $credits,
        'credits_quelle' => $credits_quelle,
        'editionen' => $editionen,
        'einzeln' => (bool) $a['editionen_einzeln'],
        // Getrennt angezeigte Versionen: für alle sichtbar, mit kurzem Namen
        'versionen' => $a['editionen_einzeln'] ? array_map(static fn($v) => ['id' => (int) $v['id'], 'name' => edition_kurzname($v + ['titel' => $a['titel']]),
            'cover' => bild_url('cover', $v['cover_datei'], 300), 'aktiv' => (int) $v['id'] === $edition_id],
            db_alle('SELECT id, titel AS ed_titel, kommentar AS ed_kommentar, jahr AS ed_jahr, land AS ed_land, cover_datei FROM editionen WHERE album_id = :a AND anzahl_dateien > 0 ORDER BY datum, id', ['a' => $id])) : [],
        'verwandt' => album_verwandt($id, $edition_id, $kuenstler, $credits, (int) $user['id']),
    ];
}

/** "Mehr von …", "Auch produziert von …", "Gleiche Musiker" */
function album_verwandt(int $albumId, int $editionId, array $kuenstler, array $credits, int $userId): array
{
    $abschnitte = [];
    // Mehr vom Hauptkünstler
    if ($kuenstler) {
        $k = $kuenstler[0];
        $z = db_alle('SELECT ' . ALBUM_SPALTEN . ' FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0))
                      WHERE e.anzahl_dateien > 0 AND a.id <> :a AND EXISTS (SELECT 1 FROM credit_namen cn WHERE cn.credit_id = a.credit_id AND cn.kuenstler_id = :k)
                      ORDER BY COALESCE(a.erstjahr, e.jahr) LIMIT 12', ['a' => $albumId, 'k' => $k['id']]);
        if ($z) {
            $abschnitte[] = ['art' => 'kuenstler', 'titel' => t('Mehr von'), 'kuenstler' => $k, 'alben' => album_items($z, $userId)];
        }
    }
    // Produzenten
    $produzenten = [];
    foreach ($credits as $g) {
        if ($g['gruppe'] === 'produktion') {
            foreach ($g['eintraege'] as $e) {
                if (in_array('producer', (array) $e['schluessel'], true)) {
                    $produzenten[$e['kuenstler']['id']] = $e['kuenstler'];
                }
            }
        }
    }
    foreach (array_slice($produzenten, 0, 2, true) as $pk) {
        $z = alben_mit_rolle((int) $pk['id'], ['producer'], $albumId, 12);
        if ($z) {
            $abschnitte[] = ['art' => 'rolle', 'titel' => t('Auch produziert von'), 'kuenstler' => $pk, 'alben' => album_items($z, $userId)];
        }
    }
    // Gleiche Musiker
    $musiker = [];
    foreach ($credits as $g) {
        if ($g['gruppe'] === 'musiker') {
            foreach ($g['eintraege'] as $e) {
                $musiker[$e['kuenstler']['id']] = true;
            }
        }
    }
    foreach ($kuenstler as $k) {
        unset($musiker[$k['id']]); // der Hauptkünstler selbst zählt hier nicht
    }
    if ($musiker) {
        [$in, $p] = db_in(array_keys($musiker), 'mu');
        $p['a'] = $albumId;
        $treffer = db_alle(
            "SELECT al.id, COUNT(DISTINCT b.von_id) AS n, GROUP_CONCAT(DISTINCT k.name ORDER BY k.name SEPARATOR ', ') AS namen
             FROM beziehungen b JOIN beziehungstypen bt ON bt.id = b.typ_id AND bt.gruppe = 'musiker'
             JOIN tracks t ON t.aufnahme_id = b.zu_id AND b.zu_art = 'aufnahme'
             JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id
             JOIN alben al ON al.id = e.album_id AND (al.anzeige_edition_id = e.id OR al.editionen_einzeln = 1)
             JOIN kuenstler k ON k.id = b.von_id
             WHERE b.von_art = 'kuenstler' AND b.von_id IN {$in} AND al.id <> :a
             GROUP BY al.id ORDER BY n DESC LIMIT 12", $p);
        if ($treffer) {
            [$in3, $p3] = db_in(array_column($treffer, 'id'), 'al');
            $z = db_alle('SELECT ' . ALBUM_SPALTEN . " FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0)) WHERE e.anzahl_dateien > 0 AND a.id IN {$in3}", $p3);
            $nach_id = [];
            foreach (album_items($z, $userId) as $it) {
                $nach_id[$it['id']] = $it;
            }
            $alben = [];
            foreach ($treffer as $t) {
                if (isset($nach_id[(int) $t['id']])) {
                    $alben[] = $nach_id[(int) $t['id']] + ['hinweis' => $t['namen']];
                }
            }
            if ($alben) {
                $abschnitte[] = ['art' => 'musiker', 'titel' => t('Gleiche Musiker'), 'alben' => $alben];
            }
        }
    }
    return $abschnitte;
}

/** Alben (angezeigte Edition), bei denen ein Künstler eine der Rollen hat. */
function alben_mit_rolle(int $kuenstlerId, ?array $schluessel, int $ohneAlbum = 0, int $limit = 60, ?array $gruppen = null): array
{
    $p = ['k' => $kuenstlerId, 'oa' => $ohneAlbum];
    $typ_bed = '1=1';
    if ($schluessel) {
        $namen = [];
        foreach (array_values($schluessel) as $i => $s) {
            $namen[] = ':s' . $i;
            $p['s' . $i] = $s;
        }
        $typ_bed = 'bt.schluessel IN (' . implode(',', $namen) . ')';
    } elseif ($gruppen) {
        $namen = [];
        foreach (array_values($gruppen) as $i => $g) {
            $namen[] = ':g' . $i;
            $p['g' . $i] = $g;
        }
        $typ_bed = 'bt.gruppe IN (' . implode(',', $namen) . ')';
    }
    return db_alle('SELECT ' . ALBUM_SPALTEN . " FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0))
        WHERE e.anzahl_dateien > 0 AND a.id <> :oa AND EXISTS (
            SELECT 1 FROM beziehungen b JOIN beziehungstypen bt ON bt.id = b.typ_id
            WHERE b.von_art = 'kuenstler' AND b.von_id = :k AND {$typ_bed} AND (
                (b.zu_art = 'album' AND b.zu_id = a.id) OR (b.zu_art = 'edition' AND b.zu_id IN (SELECT e9.id FROM editionen e9 WHERE e9.album_id = a.id)) OR
                (b.zu_art = 'aufnahme' AND b.zu_id IN (SELECT t.aufnahme_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e8 ON e8.id = m.edition_id WHERE e8.album_id = a.id)) OR
                (b.zu_art = 'werk' AND b.zu_id IN (SELECT aw.werk_id FROM aufnahme_werke aw JOIN tracks t2 ON t2.aufnahme_id = aw.aufnahme_id JOIN datentraeger m2 ON m2.id = t2.datentraeger_id JOIN editionen e7 ON e7.id = m2.edition_id WHERE e7.album_id = a.id))
            ))
        ORDER BY COALESCE(a.erstjahr, e.jahr), a.titel LIMIT " . (int) $limit, $p);
}

function api_kuenstler_liste(array $user): array
{
    $p = [];
    $wo = ["EXISTS (SELECT 1 FROM credit_namen cn JOIN alben a ON a.credit_id = cn.credit_id JOIN editionen e ON e.id = a.anzeige_edition_id AND e.anzahl_dateien > 0 WHERE cn.kuenstler_id = k.id)"];
    if (($_GET['alle'] ?? '') === '1') {
        $wo = ['1=1']; // auch Mitwirkende ohne eigenes Album
    }
    $q = trim((string) ($_GET['q'] ?? ''));
    if ($q !== '') {
        $wo[] = such_bedingung($q, 'k.name_norm', $p);
    }
    $b = (string) ($_GET['buchstabe'] ?? '');
    if (preg_match('/^[A-Z]$/', $b)) {
        $wo[] = 'UPPER(LEFT(k.sortname, 1)) = :b';
        $p['b'] = $b;
    } elseif ($b === '#') {
        $wo[] = "UPPER(LEFT(k.sortname, 1)) NOT BETWEEN 'A' AND 'Z'";
    }
    $typ = (string) ($_GET['typ'] ?? '');
    if ($typ === 'person') {
        $wo[] = "k.typ = 'person'";
    } elseif ($typ === 'gruppe') {
        $wo[] = "k.typ IN ('gruppe','orchester','chor')";
    }
    $pro = max(1, min(500, api_int('pro_seite', 200)));
    $seite = max(1, api_int('seite', 1));
    $bed = implode(' AND ', $wo);
    $alben_sql = '(SELECT COUNT(DISTINCT a.id) FROM credit_namen cn JOIN alben a ON a.credit_id = cn.credit_id JOIN editionen e ON e.id = a.anzeige_edition_id AND e.anzahl_dateien > 0 WHERE cn.kuenstler_id = k.id)';
    $neu_sql = '(SELECT MAX(a.hinzugefuegt_am) FROM credit_namen cn JOIN alben a ON a.credit_id = cn.credit_id WHERE cn.kuenstler_id = k.id)';
    // Wie oft du (der angemeldete Nutzer) Titel dieses Künstlers gehört hast
    $gehoert_sql = '(SELECT COUNT(*) FROM wiedergaben w JOIN tracks t ON t.id = w.track_id JOIN credit_namen cn ON cn.credit_id = t.credit_id
        WHERE w.user_id = :wu AND w.gezaehlt = 1 AND cn.kuenstler_id = k.id)';
    $sort = (string) ($_GET['sort'] ?? 'name');
    $extra = '';
    $order = match ($sort) {
        'name_ab' => 'k.sortname DESC, k.name DESC',
        'alben' => 'alben DESC, k.sortname',
        'neu' => 'zuletzt DESC, k.sortname',
        'gehoert' => 'gehoert DESC, alben DESC, k.sortname',
        'zufall' => 'RAND(' . max(1, api_int('saat', 1)) . ')',
        default => 'k.sortname, k.name',
    };
    $pz = $p;
    if ($sort === 'neu') {
        $extra = ", {$neu_sql} AS zuletzt";
    } elseif ($sort === 'gehoert') {
        $extra = ", {$gehoert_sql} AS gehoert";
        $pz['wu'] = (int) $user['id'];
    }
    $gesamt = (int) db_wert("SELECT COUNT(*) FROM kuenstler k WHERE {$bed}", $p);
    $zeilen = db_alle("SELECT k.id, k.name, k.sortname, k.typ, k.bild_datei, {$alben_sql} AS alben{$extra}
        FROM kuenstler k WHERE {$bed} ORDER BY {$order} LIMIT {$pro} OFFSET " . (($seite - 1) * $pro), $pz);
    return ['gesamt' => $gesamt, 'seite' => $seite, 'pro_seite' => $pro, 'kuenstler' => array_map(static fn($z) => [
        'id' => (int) $z['id'], 'name' => $z['name'], 'typ' => $z['typ'], 'alben' => (int) $z['alben'],
        'bild' => bild_url('kuenstler', $z['bild_datei'], 300),
        'gehoert' => isset($z['gehoert']) ? (int) $z['gehoert'] : null,
        'zuletzt' => isset($z['zuletzt']) ? iso($z['zuletzt']) : null,
    ], $zeilen)];
}

function api_kuenstler(array $user, int $id): array
{
    $k = db_zeile('SELECT * FROM kuenstler WHERE id = :id', ['id' => $id]);
    if (!$k) {
        throw new ApiFehler(t('Künstler nicht gefunden.'), 404);
    }
    $uid = (int) $user['id'];
    $eigene = db_alle('SELECT ' . ALBUM_SPALTEN . ' FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0))
                       WHERE e.anzahl_dateien > 0 AND EXISTS (SELECT 1 FROM credit_namen cn WHERE cn.credit_id = a.credit_id AND cn.kuenstler_id = :k)
                       ORDER BY COALESCE(a.erstjahr, e.jahr), a.titel', ['k' => $id]);
    // Auftritte auf fremden Alben (Track-Credit, aber nicht Album-Credit)
    $gast = db_alle('SELECT ' . ALBUM_SPALTEN . ', GROUP_CONCAT(t.titel ORDER BY m.pos, t.pos SEPARATOR \' · \') AS gast_titel
        FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0))
        JOIN datentraeger m ON m.edition_id = e.id JOIN tracks t ON t.datentraeger_id = m.id
        WHERE e.anzahl_dateien > 0
          AND EXISTS (SELECT 1 FROM credit_namen cn WHERE cn.credit_id = t.credit_id AND cn.kuenstler_id = :k1)
          AND NOT EXISTS (SELECT 1 FROM credit_namen cn2 WHERE cn2.credit_id = a.credit_id AND cn2.kuenstler_id = :k2)
        GROUP BY a.id, a.titel, a.credit_id, a.typ, a.zusatz_typen, a.erstjahr, a.hinzugefuegt_am, e.id, e.jahr, e.cover_datei, e.beste_qualitaet, e.anzahl_tracks, e.anzahl_dateien, e.laenge_ms, a.editionen_einzeln, e.titel, e.kommentar, e.land, e.explizit
        ORDER BY COALESCE(a.erstjahr, e.jahr)', ['k1' => $id, 'k2' => $id]);
    $gast_items = album_items($gast, $uid);
    foreach ($gast_items as $i => &$it) {
        $it['hinweis'] = $gast[$i]['gast_titel'];
    }
    unset($it);

    // Rollen nach Gruppen
    $rollen = [];
    $gruppen = ['produktion' => t('Als Produzent'), 'musiker' => t('Als Musiker'), 'songwriting' => t('Als Songwriter'), 'technik' => t('Technik{x}', ['x' => '']), 'sonstiges' => t('Sonstiges')];
    foreach ($gruppen as $g => $titel) {
        $z = alben_mit_rolle($id, null, 0, 200, [$g]);
        if (!$z) {
            continue;
        }
        $items = album_items($z, $uid);
        // Welche Rollen/Instrumente genau, je Album
        foreach ($items as &$it) {
            $det = db_alle("SELECT DISTINCT bt.name_de, b.attribute, (SELECT GROUP_CONCAT(" . instrument_sql() . " SEPARATOR ', ') FROM beziehung_instrumente bi JOIN instrumente i ON i.id = bi.instrument_id WHERE bi.beziehung_id = b.id) AS instr
                FROM beziehungen b JOIN beziehungstypen bt ON bt.id = b.typ_id AND bt.gruppe = :g
                WHERE b.von_art = 'kuenstler' AND b.von_id = :k AND (
                  (b.zu_art = 'album' AND b.zu_id = :a) OR (b.zu_art = 'edition' AND b.zu_id IN (SELECT e9.id FROM editionen e9 WHERE e9.album_id = :a1)) OR
                  (b.zu_art = 'aufnahme' AND b.zu_id IN (SELECT t.aufnahme_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e8 ON e8.id = m.edition_id WHERE e8.album_id = :a2)) OR
                  (b.zu_art = 'werk' AND b.zu_id IN (SELECT aw.werk_id FROM aufnahme_werke aw JOIN tracks t2 ON t2.aufnahme_id = aw.aufnahme_id JOIN datentraeger m2 ON m2.id = t2.datentraeger_id JOIN editionen e7 ON e7.id = m2.edition_id WHERE e7.album_id = :a3)))",
                ['g' => $g, 'k' => $id, 'a' => $it['id'], 'a1' => $it['id'], 'a2' => $it['id'], 'a3' => $it['id']]);
            $teile = [];
            foreach ($det as $d) {
                foreach (array_filter(array_map('trim', explode(',', (string) $d['instr'])), 'strlen') ?: [rolle_mit_zusatz((string) $d['name_de'], (string) $d['attribute'])] as $t) {
                    $teile[$t] = true;
                }
            }
            $it['hinweis'] = implode(', ', array_keys($teile));
        }
        unset($it);
        $rollen[] = ['gruppe' => $g, 'titel' => $titel, 'alben' => $items];
    }

    // Häufige Partner: andere Künstler auf denselben Alben (Credits und Rollen)
    $partner = db_alle(
        "SELECT k2.id, k2.name, k2.bild_datei, COUNT(DISTINCT x.album_id) AS n FROM (
            SELECT a.id AS album_id FROM alben a JOIN credit_namen cn ON cn.credit_id = a.credit_id WHERE cn.kuenstler_id = :k1
            UNION
            SELECT e.album_id FROM beziehungen b JOIN tracks t ON t.aufnahme_id = b.zu_id AND b.zu_art = 'aufnahme'
              JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id WHERE b.von_art = 'kuenstler' AND b.von_id = :k2
            UNION
            SELECT e.album_id FROM beziehungen b JOIN editionen e ON e.id = b.zu_id WHERE b.von_art = 'kuenstler' AND b.von_id = :k4 AND b.zu_art = 'edition'
            UNION
            SELECT e.album_id FROM beziehungen b JOIN aufnahme_werke aw ON aw.werk_id = b.zu_id AND b.zu_art = 'werk' JOIN tracks t ON t.aufnahme_id = aw.aufnahme_id
              JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id WHERE b.von_art = 'kuenstler' AND b.von_id = :k5
         ) mein
         JOIN (
            SELECT a.id AS album_id, cn.kuenstler_id FROM alben a JOIN credit_namen cn ON cn.credit_id = a.credit_id
            UNION
            SELECT e.album_id, b.von_id FROM beziehungen b JOIN tracks t ON t.aufnahme_id = b.zu_id AND b.zu_art = 'aufnahme'
              JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id WHERE b.von_art = 'kuenstler'
            UNION
            SELECT e.album_id, b.von_id FROM beziehungen b JOIN editionen e ON e.id = b.zu_id WHERE b.von_art = 'kuenstler' AND b.zu_art = 'edition'
            UNION
            SELECT e.album_id, b.von_id FROM beziehungen b JOIN aufnahme_werke aw ON aw.werk_id = b.zu_id AND b.zu_art = 'werk' JOIN tracks t ON t.aufnahme_id = aw.aufnahme_id
              JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id WHERE b.von_art = 'kuenstler'
         ) x ON x.album_id = mein.album_id
         JOIN kuenstler k2 ON k2.id = x.kuenstler_id AND k2.id <> :k3
         GROUP BY k2.id, k2.name, k2.bild_datei ORDER BY n DESC, k2.name LIMIT 10", ['k1' => $id, 'k2' => $id, 'k3' => $id, 'k4' => $id, 'k5' => $id]);

    $mitglieder = db_alle("SELECT k2.id, k2.name, b.beginn, b.ende, (SELECT GROUP_CONCAT(" . instrument_sql() . " SEPARATOR ', ') FROM beziehung_instrumente bi JOIN instrumente i ON i.id = bi.instrument_id WHERE bi.beziehung_id = b.id) AS instr
        FROM beziehungen b JOIN beziehungstypen bt ON bt.id = b.typ_id AND bt.schluessel = 'member' JOIN kuenstler k2 ON k2.id = b.von_id
        WHERE b.zu_art = 'kuenstler' AND b.zu_id = :k ORDER BY b.beginn, k2.name", ['k' => $id]);
    $bands = db_alle("SELECT k2.id, k2.name, b.beginn, b.ende FROM beziehungen b JOIN beziehungstypen bt ON bt.id = b.typ_id AND bt.schluessel = 'member'
        JOIN kuenstler k2 ON k2.id = b.zu_id WHERE b.von_art = 'kuenstler' AND b.von_id = :k ORDER BY b.beginn", ['k' => $id]);
    $aliase = array_column(db_alle('SELECT name FROM kuenstler_aliase WHERE kuenstler_id = :k ORDER BY primaer DESC, name', ['k' => $id]), 'name');

    return [
        'id' => (int) $k['id'], 'mbid' => $k['mbid'], 'name' => $k['name'], 'sortname' => $k['sortname'], 'typ' => $k['typ'],
        'unterscheidung' => $k['unterscheidung'], 'land' => $k['land'], 'beginn' => $k['beginn'], 'ende' => $k['ende'],
        'bio' => $k['bio'], 'bio_quelle' => $k['bio_quelle'], 'bio_maschinell' => (bool) $k['bio_maschinell'],
        'bild' => bild_url('kuenstler', $k['bild_datei'], 600), 'aliase' => $aliase,
        'favorit' => (bool) db_wert("SELECT 1 FROM favoriten WHERE user_id = :u AND art = 'kuenstler' AND objekt_id = :k", ['u' => $uid, 'k' => $id]),
        'alben' => album_items($eigene, $uid),
        'gast' => $gast_items,
        'rollen' => $rollen,
        'partner' => array_map(static fn($z) => ['id' => (int) $z['id'], 'name' => $z['name'], 'alben' => (int) $z['n'], 'bild' => bild_url('kuenstler', $z['bild_datei'], 300)], $partner),
        'mitglieder' => array_map(static fn($z) => ['id' => (int) $z['id'], 'name' => $z['name'], 'beginn' => $z['beginn'], 'ende' => $z['ende'], 'instrumente' => $z['instr']], $mitglieder),
        'bands' => array_map(static fn($z) => ['id' => (int) $z['id'], 'name' => $z['name'], 'beginn' => $z['beginn'], 'ende' => $z['ende']], $bands),
    ];
}

/** Wörter eines Suchbegriffs (normalisiert). */
function such_woerter(string $q): array
{
    return array_slice(array_values(array_filter(explode(' ', name_norm($q)), 'strlen')), 0, 8);
}

/** Passt ein Suchwort (mit Tippfehler-Toleranz) zu einem Wort des Textes? Toleranz: 1 Buchstabe, ab 6 Zeichen 2. */
function such_wort_aehnlich(string $qw, string $cw): bool
{
    $l = mb_strlen($qw);
    if ($l < 3) {
        return strncmp($cw, $qw, strlen($qw)) === 0;
    }
    $tol = $l >= 6 ? 2 : 1;
    if (strncmp($cw, $qw, strlen($qw)) === 0) {
        return true;
    }
    $a = mb_substr($cw, 0, $l + 1);
    return levenshtein(substr($qw, 0, 60), substr($cw, 0, 60)) <= $tol || levenshtein(substr($qw, 0, 60), substr($a, 0, 60)) <= $tol
        || levenshtein(substr($qw, 0, 60), substr(mb_substr($cw, 0, $l), 0, 60)) <= $tol;
}

/**
 * Tippfehler-Suche (nur wenn die normale Suche nichts findet): Kandidaten mit PHP prüfen. Auch zusammengeschrieben („acdc“ für „AC/DC“).
 * @return int[] IDs
 */
function such_aehnlich(string $q, string $sql): array
{
    $ws = such_woerter($q);
    if (!$ws || mb_strlen(implode('', $ws)) < 3) {
        return [];
    }
    $kompakt = implode('', $ws);
    $treffer = [];
    foreach (db_alle($sql) as $z) {
        $text = (string) $z['t'];
        if ($text === '') {
            continue;
        }
        $cw = explode(' ', $text);
        $ok = strlen($kompakt) >= 4 && str_contains(str_replace(' ', '', $text), $kompakt);
        if (!$ok) {
            $ok = true;
            foreach ($ws as $qw) {
                $hit = false;
                foreach ($cw as $w) {
                    if ($w !== '' && such_wort_aehnlich($qw, $w)) {
                        $hit = true;
                        break;
                    }
                }
                if (!$hit) {
                    $ok = false;
                    break;
                }
            }
        }
        if ($ok) {
            $treffer[] = (int) $z['id'];
            if (count($treffer) >= 60) {
                break;
            }
        }
    }
    return $treffer;
}

/** Wie oft wurde gehört (Familie, letzte 2 Jahre)? Je Titel-ID. */
function such_beliebt_tracks(array $ids): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    if (!$ids) {
        return [];
    }
    [$in, $p] = db_in($ids, 'bt');
    return array_map('intval', array_column(db_alle("SELECT track_id, COUNT(*) AS n FROM wiedergaben WHERE gezaehlt = 1 AND gestartet_am > (NOW() - INTERVAL 730 DAY) AND track_id IN {$in} GROUP BY track_id", $p), 'n', 'track_id'));
}

/** Gehört je Künstler (über die Titel, bei denen er im Credit steht). */
function such_beliebt_kuenstler(array $ids): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    if (!$ids) {
        return [];
    }
    [$in, $p] = db_in($ids, 'bk');
    return array_map('intval', array_column(db_alle("SELECT cn.kuenstler_id, COUNT(*) AS n FROM wiedergaben w JOIN tracks t ON t.id = w.track_id JOIN credit_namen cn ON cn.credit_id = t.credit_id
        WHERE w.gezaehlt = 1 AND w.gestartet_am > (NOW() - INTERVAL 730 DAY) AND cn.kuenstler_id IN {$in} GROUP BY cn.kuenstler_id", $p), 'n', 'kuenstler_id'));
}

function api_suche(array $user): array
{
    $q = trim((string) ($_GET['q'] ?? ''));
    if (mb_strlen($q) < 2) {
        return ['alben' => [], 'kuenstler' => [], 'tracks' => [], 'top' => null];
    }
    $ws = such_woerter($q);
    $uid = (int) $user['id'];
    $albumSql = 'FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0)) WHERE e.anzahl_dateien > 0 AND ';
    $trackSql = 'FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id AND a.anzeige_edition_id = e.id
        WHERE EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id) AND ';
    $abfragen = static function (?array $ids) use ($q, $albumSql, $trackSql): array {
        $pa = [];
        $ra = such_rang($q, 'a.suchtext', $pa);
        $ca = $ids === null ? such_bedingung($q, 'a.suchtext', $pa) : ($ids['alben'] ? 'a.id IN (' . implode(',', $ids['alben']) . ')' : '1=0');
        $alben = db_alle('SELECT ' . ALBUM_SPALTEN . ', ' . $ra . ' AS rang ' . $albumSql . $ca . ' ORDER BY rang, a.titel LIMIT 40', $pa);
        $pk = [];
        $rk = such_rang($q, 'k.name_norm', $pk);
        $ck = $ids === null ? such_bedingung($q, 'k.name_norm', $pk) : ($ids['kuenstler'] ? 'k.id IN (' . implode(',', $ids['kuenstler']) . ')' : '1=0');
        $kuenstler = db_alle('SELECT k.id, k.name, k.bild_datei, ' . $rk . ' AS rang, (SELECT COUNT(DISTINCT a.id) FROM credit_namen cn JOIN alben a ON a.credit_id = cn.credit_id WHERE cn.kuenstler_id = k.id) AS eigene FROM kuenstler k WHERE '
            . $ck . ' ORDER BY rang, CHAR_LENGTH(k.name), k.name LIMIT 100', $pk);
        $pt = [];
        $rt = such_rang($q, 't.suchtext', $pt);
        $ct = $ids === null ? such_bedingung($q, 't.suchtext', $pt) : ($ids['tracks'] ? 't.id IN (' . implode(',', $ids['tracks']) . ')' : '1=0');
        $tracks = db_alle('SELECT t.id, t.titel, t.credit_id, t.laenge_ms, t.explizit, a.id AS album_id, a.titel AS album_titel, e.id AS edition_id, e.cover_datei, ' . $rt . ' AS rang '
            . $trackSql . $ct . ' ORDER BY rang, CHAR_LENGTH(t.titel), t.titel LIMIT 150', $pt);
        return [$alben, $kuenstler, $tracks];
    };
    [$alben, $kuenstler, $tracks] = $abfragen(null);
    $aehnlich = false;
    if (!$alben && !$kuenstler && !$tracks) {
        // Nichts gefunden: Tippfehler und zusammengeschriebene Namen versuchen
        $ids = [
            'alben' => such_aehnlich($q, 'SELECT a.id, a.suchtext AS t FROM alben a JOIN editionen e ON e.album_id = a.id WHERE e.anzahl_dateien > 0 GROUP BY a.id, a.suchtext'),
            'kuenstler' => such_aehnlich($q, 'SELECT k.id, k.name_norm AS t FROM kuenstler k'),
            'tracks' => such_aehnlich($q, 'SELECT t.id, t.suchtext AS t FROM tracks t WHERE EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id)'),
        ];
        if ($ids['alben'] || $ids['kuenstler'] || $ids['tracks']) {
            [$alben, $kuenstler, $tracks] = $abfragen($ids);
            $aehnlich = true;
        }
    }
    $alben = array_slice(such_filter($alben), 0, 6);
    $kuenstler = such_filter($kuenstler);
    $tracks = such_filter($tracks);
    $tc = credit_listen(array_column($tracks, 'credit_id'));
    // Beliebtheit: bei gleichem Treffergrad stehen die meistgehörten vorn
    $bt = such_beliebt_tracks(array_column($tracks, 'id'));
    $bk = such_beliebt_kuenstler(array_column($kuenstler, 'id'));
    foreach ($tracks as &$z) {
        // Titel und Künstler getrennt: „thriller jackson“ → ein Wort im Titel, der Rest im Künstlernamen ist der beste Treffer
        $titel = ' ' . name_norm((string) $z['titel']);
        $kn = ' ' . name_norm(implode(' ', array_column($tc[(int) $z['credit_id']] ?? [], 'name')));
        $inT = $inK = 0;
        foreach ($ws as $w) {
            if (str_contains($titel, ' ' . $w)) {
                $inT++;
            } elseif (str_contains($kn, ' ' . $w)) {
                $inK++;
            }
        }
        if (count($ws) > 1 && $inT > 0 && $inK > 0 && $inT + $inK === count($ws) && (int) $z['rang'] > 0) {
            $z['rang'] = 1;
        }
        $z['pop'] = $bt[(int) $z['id']] ?? 0;
    }
    unset($z);
    usort($tracks, static fn($x, $y) => [(int) $x['rang'], -$x['pop'], mb_strlen((string) $x['titel'])] <=> [(int) $y['rang'], -$y['pop'], mb_strlen((string) $y['titel'])]);
    $tracks = array_slice($tracks, 0, 30);
    foreach ($kuenstler as &$z) {
        $z['pop'] = $bk[(int) $z['id']] ?? 0;
    }
    unset($z);
    // Wer eigene Alben hat, steht bei gleichem Treffergrad vor reinen Mitwirkenden; danach das, was oft gehört wird
    usort($kuenstler, static fn($x, $y) => [(int) $x['rang'], (int) $x['eigene'] > 0 ? 0 : 1, -$x['pop'], -(int) $x['eigene']] <=> [(int) $y['rang'], (int) $y['eigene'] > 0 ? 0 : 1, -$y['pop'], -(int) $y['eigene']]);
    $kuenstler = array_slice($kuenstler, 0, 8);
    $trackItem = function ($z) use (&$tc) {
        return [
        'id' => (int) $z['id'], 'titel' => $z['titel'], 'kuenstler' => $tc[(int) $z['credit_id']] ?? [], 'laenge_ms' => (int) $z['laenge_ms'], 'explizit' => $z['explizit'] !== null ? (int) $z['explizit'] : null,
        'album' => ['id' => (int) $z['album_id'], 'titel' => $z['album_titel'], 'edition_id' => (int) $z['edition_id'], 'cover' => bild_url('cover', $z['cover_datei'], 300)],
        ];
    };
    $items = array_map($trackItem, $tracks);
    $kItems = array_map(static fn($z) => ['id' => (int) $z['id'], 'name' => $z['name'], 'bild' => bild_url('kuenstler', $z['bild_datei'], 300)], $kuenstler);
    $aItems = album_items($alben, $uid);
    // Bester Treffer: das mit dem besten Treffergrad (Künstler vor Titel vor Album); bei Künstlern mit seinen meistgehörten Titeln
    $top = null;
    $rk = $kuenstler ? (int) $kuenstler[0]['rang'] : 9;
    $rt = $tracks ? (int) $tracks[0]['rang'] : 9;
    $ra = $alben ? (int) $alben[0]['rang'] : 9;
    if (!$aehnlich && min($rk, $rt, $ra) <= 2) {
        if ($rk <= $rt && $rk <= $ra) {
            $kid = (int) $kuenstler[0]['id'];
            $tt = db_alle('SELECT t.id, t.titel, t.credit_id, t.laenge_ms, t.explizit, a.id AS album_id, a.titel AS album_titel, e.id AS edition_id, e.cover_datei,
                    (SELECT COUNT(*) FROM wiedergaben w WHERE w.track_id = t.id AND w.gezaehlt = 1) AS n
                FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id AND a.anzeige_edition_id = e.id
                WHERE t.credit_id IN (SELECT credit_id FROM credit_namen WHERE kuenstler_id = :k) AND EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id) ORDER BY n DESC, t.id LIMIT 4', ['k' => $kid]);
            $tc += credit_listen(array_column($tt, 'credit_id'));
            $top = ['art' => 'kuenstler', 'kuenstler' => $kItems[0], 'alben' => (int) $kuenstler[0]['eigene'], 'tracks' => array_map($trackItem, $tt)];
        } elseif ($rt <= $ra) {
            $top = ['art' => 'track', 'track' => $items[0]];
        } else {
            $top = ['art' => 'album', 'album' => $aItems[0]];
        }
    }
    return ['alben' => $aItems, 'kuenstler' => $kItems, 'tracks' => $items, 'top' => $top, 'aehnlich' => $aehnlich];
}

function api_genres(): array
{
    return array_map(static fn($z) => ['id' => (int) $z['id'], 'name' => $z['name'], 'alben' => (int) $z['n']], db_alle(
        'SELECT g.id, g.name, COUNT(DISTINCT a.id) AS n FROM genres g JOIN album_genres ag ON ag.genre_id = g.id JOIN alben a ON a.id = ag.album_id
         JOIN editionen e ON e.id = a.anzeige_edition_id AND e.anzahl_dateien > 0
         WHERE ag.quelle <> \'musicbrainz\' OR ag.anteil >= 0.15 GROUP BY g.id, g.name ORDER BY n DESC, g.name'));
}

/** Genre-Familien mit Zahl der Alben (ab Schwelle) */
function api_genre_familien(): array
{
    $z = db_alle('SELECT af.familie, COUNT(DISTINCT af.album_id) AS n FROM album_familien af JOIN alben a ON a.id = af.album_id
        JOIN editionen e ON e.id = a.anzeige_edition_id AND e.anzahl_dateien > 0 WHERE af.wert >= :w GROUP BY af.familie', ['w' => genre_familie_schwelle()]);
    $n = array_column($z, 'n', 'familie');
    $erg = [];
    foreach (genre_familien() as $k => $name) {
        if (!empty($n[$k])) {
            $erg[] = ['key' => $k, 'name' => $name, 'alben' => (int) $n[$k]];
        }
    }
    return $erg;
}

function api_start(array $user): array
{
    $uid = (int) $user['id'];
    $weiter = db_alle('SELECT ' . ALBUM_SPALTEN . ', w.track_id AS w_track, w.position_sek AS w_pos, w.aktualisiert_am AS w_zeit
        FROM weiterhoeren w JOIN editionen e ON e.id = w.edition_id JOIN alben a ON a.id = e.album_id
        WHERE w.user_id = :u AND e.anzahl_dateien > 0 ORDER BY w.aktualisiert_am DESC LIMIT 12', ['u' => $uid]);
    $w_items = album_items($weiter, $uid);
    foreach ($w_items as $i => &$it) {
        $it['edition_id'] = (int) $weiter[$i]['edition_id']; // die zuletzt gehörte Edition
        $it['weiter'] = ['track_id' => $weiter[$i]['w_track'] !== null ? (int) $weiter[$i]['w_track'] : null, 'position_sek' => (int) $weiter[$i]['w_pos'], 'zeit' => iso($weiter[$i]['w_zeit'])];
    }
    unset($it);
    $neu = db_alle('SELECT ' . ALBUM_SPALTEN . ' FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0)) WHERE e.anzahl_dateien > 0 ORDER BY a.hinzugefuegt_am DESC, a.id DESC LIMIT 18');
    $oft = db_alle('SELECT ' . ALBUM_SPALTEN . ', COUNT(*) AS n FROM wiedergaben w JOIN tracks t ON t.id = w.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
        JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id
        WHERE w.user_id = :u AND w.gezaehlt = 1 AND w.gestartet_am > (NOW() - INTERVAL 90 DAY) AND e.anzahl_dateien > 0
        GROUP BY a.id, a.titel, a.credit_id, a.typ, a.zusatz_typen, a.erstjahr, a.hinzugefuegt_am, e.id, e.jahr, e.cover_datei, e.beste_qualitaet, e.anzahl_tracks, e.anzahl_dateien, e.laenge_ms, a.editionen_einzeln, e.titel, e.kommentar, e.land, e.explizit
        ORDER BY n DESC LIMIT 12', ['u' => $uid]);
    // ?entdecken=1,2,3: dieselben Alben wie zuvor (stilles Auffrischen der Seite soll „Entdecken“ nicht neu würfeln)
    $behalten = array_slice(array_values(array_filter(array_map('intval', explode(',', (string) ($_GET['entdecken'] ?? ''))), static fn($i) => $i > 0)), 0, 12);
    if ($behalten) {
        [$in, $p] = db_in($behalten, 'ed');
        $zufall = db_alle('SELECT ' . ALBUM_SPALTEN . " FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0)) WHERE e.anzahl_dateien > 0 AND a.id IN {$in} LIMIT 24", $p);
        $rang = array_flip($behalten);
        usort($zufall, static fn($x, $y) => ($rang[(int) $x['id']] ?? 99) <=> ($rang[(int) $y['id']] ?? 99));
        $zufall = array_slice($zufall, 0, 12);
    } else {
        $zufall = db_alle('SELECT ' . ALBUM_SPALTEN . ' FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0)) WHERE e.anzahl_dateien > 0 ORDER BY RAND() LIMIT 12');
    }
    return [
        'weiterhoeren' => $w_items,
        'neu' => album_items($neu, $uid),
        'oft' => album_items($oft, $uid),
        'entdecken' => album_items($zufall, $uid),
        // Knöpfe für Themenradios (Jahrzehnte, Genres) – nur mit genug Songs
        'radio_themen' => function_exists('radio_themen') ? radio_themen(true) : ['jahrzehnte' => [], 'genres' => []],
        'zahlen' => [
            'alben' => (int) db_wert('SELECT COUNT(*) FROM alben a JOIN editionen e ON e.album_id = a.id AND (e.id = a.anzeige_edition_id OR (a.editionen_einzeln = 1 AND e.anzahl_dateien > 0)) WHERE e.anzahl_dateien > 0'),
            'kuenstler' => (int) db_wert('SELECT COUNT(DISTINCT cn.kuenstler_id) FROM alben a JOIN credit_namen cn ON cn.credit_id = a.credit_id'),
            'tracks' => (int) db_wert('SELECT COUNT(DISTINCT track_id) FROM dateien WHERE track_id IS NOT NULL'),
        ],
    ];
}

function api_track(array $user, int $id): array
{
    $t = db_zeile('SELECT t.*, m.edition_id, m.pos AS disc, e.album_id, e.cover_datei, e.jahr AS ed_jahr, a.titel AS album_titel, a.credit_id AS album_credit,
            a.typ AS album_typ, a.zusatz_typen AS album_zusatz, a.erstjahr AS album_jahr
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id WHERE t.id = :t', ['t' => $id]);
    if (!$t) {
        throw new ApiFehler(t('Titel nicht gefunden.'), 404);
    }
    $labels = $t['aufnahme_id'] ? [(int) $t['aufnahme_id'] => [(string) $t['pos']]] : [];
    [$credits] = edition_credits((int) $t['edition_id'], (int) $t['album_id'], $labels);
    $credits_quelle = null;
    if (!array_filter($credits, static fn($g) => $g['gruppe'] !== 'sonstiges')) {
        // Wie auf der Albumseite: Mitwirkende einer abgeglichenen Schwester-Edition (gleicher Titel, sonst gleiche Position)
        $alt = db_zeile("SELECT id, titel FROM editionen WHERE album_id = :a AND id <> :e AND quelle = 'musicbrainz' ORDER BY anzahl_tracks DESC, id LIMIT 1",
            ['a' => $t['album_id'], 'e' => $t['edition_id']]);
        if ($alt) {
            $kandidaten = db_alle('SELECT t.titel, t.aufnahme_id, t.pos, m.pos AS disc FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id
                WHERE m.edition_id = :e AND t.aufnahme_id IS NOT NULL', ['e' => $alt['id']]);
            $treffer = null;
            foreach ($kandidaten as $k) {
                if (name_norm($k['titel']) === name_norm((string) $t['titel'])) {
                    $treffer = $k;
                    break;
                }
            }
            foreach ($kandidaten as $k) {
                if (!$treffer && (int) $k['disc'] === (int) $t['disc'] && (int) $k['pos'] === (int) $t['pos']) {
                    $treffer = $k;
                }
            }
            if ($treffer) {
                [$c2] = edition_credits((int) $alt['id'], (int) $t['album_id'], [(int) $treffer['aufnahme_id'] => [(string) $t['pos']]]);
                if ($c2) {
                    $credits = $c2;
                    $credits_quelle = t('Aus der Edition „{titel}“ (MusicBrainz)', ['titel' => $alt['titel']]);
                }
            }
        }
    }
    $datei = db_zeile('SELECT format, codec, abtastrate, bittiefe, kanaele, bitrate, laenge_ms, groesse FROM dateien WHERE track_id = :t ORDER BY bittiefe DESC, abtastrate DESC LIMIT 1', ['t' => $id]);
    return [
        'id' => (int) $t['id'], 'titel' => $t['titel'], 'kuenstler' => credit_liste((int) $t['credit_id']), 'laenge_ms' => (int) $t['laenge_ms'],
        'disc' => (int) $t['disc'], 'nr' => (int) $t['pos'], 'explizit' => $t['explizit'] !== null ? (int) $t['explizit'] : null,
        'album' => ['id' => (int) $t['album_id'], 'titel' => $t['album_titel'], 'kuenstler' => credit_liste((int) $t['album_credit']), 'edition_id' => (int) $t['edition_id'],
            'cover' => bild_url('cover', $t['cover_datei'], 600), 'typ' => $t['album_typ'],
            'zusatz' => $t['album_zusatz'] !== '' ? explode(',', $t['album_zusatz']) : [],
            'jahr' => $t['album_jahr'] !== null ? (int) $t['album_jahr'] : ($t['ed_jahr'] !== null ? (int) $t['ed_jahr'] : null)],
        'credits' => $credits,
        'credits_quelle' => $credits_quelle,
        'datei' => $datei ? ['format' => $datei['format'], 'codec' => $datei['codec'], 'abtastrate' => (int) $datei['abtastrate'], 'bittiefe' => (int) $datei['bittiefe'],
            'kanaele' => (int) $datei['kanaele'], 'bitrate' => (int) $datei['bitrate'], 'groesse' => (int) $datei['groesse']] : null,
        'favorit' => (bool) db_wert("SELECT 1 FROM favoriten WHERE user_id = :u AND art = 'track' AND objekt_id = :t", ['u' => $user['id'], 't' => $id]),
    ];
}

/** Für Apps: Was hat sich seit einem Zeitpunkt geändert? */
function api_aenderungen(): array
{
    $seit = (string) ($_GET['seit'] ?? '');
    $ts = $seit !== '' ? strtotime($seit) : 0;
    $jetzt = (string) db_wert('SELECT NOW()');
    $ab = $ts ? date('Y-m-d H:i:s', $ts) : '1970-01-01 00:00:00';
    $ids = static fn(string $sql) => array_map('intval', array_column(db_alle($sql, ['s' => $ab]), 'id'));
    return [
        'jetzt' => iso($jetzt),
        'alben' => $ids('SELECT id FROM alben WHERE aktualisiert_am >= :s'),
        'editionen' => $ids('SELECT id FROM editionen WHERE aktualisiert_am >= :s'),
        'tracks' => $ids('SELECT id FROM tracks WHERE aktualisiert_am >= :s'),
        'kuenstler' => $ids('SELECT id FROM kuenstler WHERE aktualisiert_am >= :s'),
        'geloescht' => array_map(static fn($z) => ['art' => $z['art'], 'id' => (int) $z['objekt_id']], db_alle('SELECT art, objekt_id FROM geloescht WHERE zeit >= :s ORDER BY id', ['s' => $ab])),
    ];
}
