<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/einstellungen.php';

/**
 * Soll-Tags eines Titels aus der Amberwave-Datenbank – in der Schreibweise von Vorbis-Kommentaren (FLAC) und mit den
 * Feldnamen, die MusicBrainz Picard verwendet. Mehrfachwerte sind Listen. Die Schreiber für MP3/M4A übersetzen daraus.
 */

/** Felder, die Amberwave verwaltet (ältere Schreibweisen derselben Felder werden beim Schreiben mit ersetzt) */
const TAG_VERWALTET = [
    'TITLE', 'ARTIST', 'ARTISTS', 'ARTISTSORT', 'ALBUM', 'ALBUMARTIST', 'ALBUMARTISTS', 'ALBUMARTISTSORT',
    'TRACKNUMBER', 'TRACKTOTAL', 'DISCNUMBER', 'DISCTOTAL', 'DISCSUBTITLE', 'DATE', 'ORIGINALDATE', 'ORIGINALYEAR',
    'GENRE', 'LABEL', 'CATALOGNUMBER', 'BARCODE', 'RELEASECOUNTRY', 'MEDIA', 'RELEASETYPE', 'RELEASESTATUS',
    'COMPOSER', 'LYRICIST', 'WRITER', 'ARRANGER', 'CONDUCTOR', 'PRODUCER', 'ENGINEER', 'MIXER', 'REMIXER', 'DJMIXER',
    'PERFORMER', 'WORK', 'MUSICBRAINZ_ALBUMID', 'MUSICBRAINZ_RELEASEGROUPID', 'MUSICBRAINZ_TRACKID',
    'MUSICBRAINZ_RELEASETRACKID', 'MUSICBRAINZ_ARTISTID', 'MUSICBRAINZ_ALBUMARTISTID', 'MUSICBRAINZ_WORKID',
    'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK', 'REPLAYGAIN_ALBUM_GAIN', 'REPLAYGAIN_ALBUM_PEAK',
    'AMBERWAVE_EDITION',
];
/** Andere Schreibweisen, die beim Setzen des Hauptfelds entfernt werden (sonst stünde es doppelt drin) */
const TAG_ALIASE = [
    'ALBUMARTIST' => ['ALBUM ARTIST', 'ALBUM_ARTIST'], 'TRACKTOTAL' => ['TOTALTRACKS'], 'DISCTOTAL' => ['TOTALDISCS'],
    'MUSICBRAINZ_ALBUMID' => ['MUSICBRAINZ ALBUM ID'], 'MUSICBRAINZ_RELEASEGROUPID' => ['MUSICBRAINZ RELEASE GROUP ID'],
    'MUSICBRAINZ_TRACKID' => ['MUSICBRAINZ TRACK ID'], 'MUSICBRAINZ_RELEASETRACKID' => ['MUSICBRAINZ RELEASE TRACK ID'],
    'MUSICBRAINZ_ARTISTID' => ['MUSICBRAINZ ARTIST ID'], 'MUSICBRAINZ_ALBUMARTISTID' => ['MUSICBRAINZ ALBUM ARTIST ID'],
    'MUSICBRAINZ_WORKID' => ['MUSICBRAINZ WORK ID'], 'RELEASECOUNTRY' => ['MUSICBRAINZ ALBUM RELEASE COUNTRY'],
    'RELEASETYPE' => ['MUSICBRAINZ ALBUM TYPE'], 'RELEASESTATUS' => ['MUSICBRAINZ ALBUM STATUS'], 'ORIGINALDATE' => ['ORIGINAL DATE'],
];

/** Rolle (beziehungstypen.schluessel) → Tagfeld; Musiker gehen als PERFORMER „Name (Instrument)“ */
const TAGZIEL_ROLLEN = [
    'composer' => 'COMPOSER', 'lyricist' => 'LYRICIST', 'writer' => 'WRITER', 'arranger' => 'ARRANGER', 'orchestrator' => 'ARRANGER',
    'conductor' => 'CONDUCTOR', 'producer' => 'PRODUCER', 'mix' => 'MIXER', 'engineer' => 'ENGINEER', 'recording' => 'ENGINEER',
    'remixer' => 'REMIXER', 'dj_mix' => 'DJMIXER',
];

function tag_credit(?int $creditId): array
{
    if (!$creditId) {
        return ['anzeige' => '', 'namen' => [], 'mbids' => [], 'sort' => ''];
    }
    $standard = standardnamen_aktiv();
    $anzeige = (string) db_wert('SELECT anzeige FROM credits WHERE id = :c', ['c' => $creditId]);
    $namen = db_alle('SELECT cn.name_als, cn.verbindung, k.name, k.mbid, k.sortname FROM credit_namen cn JOIN kuenstler k ON k.id = cn.kuenstler_id WHERE cn.credit_id = :c ORDER BY cn.pos', ['c' => $creditId]);
    if ($standard && $namen) {
        // Anzeige aus den Standardnamen + Verbindungen neu zusammensetzen (z. B. „Beyoncé feat. JAŸ-Z“ → „… feat. JAY-Z“)
        $anzeige = '';
        foreach ($namen as $n) {
            $anzeige .= (string) $n['name'] . (string) $n['verbindung'];
        }
        $anzeige = trim($anzeige);
    }
    return [
        'anzeige' => $anzeige,
        'namen' => array_map(static fn($n) => (string) ($standard ? $n['name'] : ($n['name_als'] ?: $n['name'])), $namen),
        'mbids' => array_values(array_filter(array_map(static fn($n) => strtolower((string) $n['mbid']), $namen), 'ist_uuid')),
        'sort' => count($namen) === 1 ? (string) $namen[0]['sortname'] : '',
    ];
}

function tag_rg(?float $lufs, ?float $tp): array
{
    if ($lufs === null) {
        return [null, null];
    }
    $g = -18.0 - $lufs; // ReplayGain 2.0: Bezug −18 LUFS
    return [sprintf('%.2f dB', $g), $tp !== null ? sprintf('%.6f', min(9.99, 10 ** ($tp / 20))) : null];
}

/**
 * Soll-Tags für alle Titel einer Edition: [track_id => ['FELD' => [werte…]]]
 */
function tags_fuer_edition(int $editionId): array
{
    $e = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $editionId]);
    if (!$e) {
        return [];
    }
    $a = db_zeile('SELECT * FROM alben WHERE id = :a', ['a' => $e['album_id']]);
    $albumCredit = tag_credit($e['credit_id'] ? (int) $e['credit_id'] : ($a['credit_id'] ? (int) $a['credit_id'] : null));
    $labels = db_alle('SELECT COALESCE(l.name, \'\') AS name, el.katalognummer FROM edition_labels el LEFT JOIN labels l ON l.id = el.label_id WHERE el.edition_id = :e', ['e' => $editionId]);
    $genres = array_column(db_alle('SELECT g.name FROM album_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.album_id = :a ORDER BY g.name', ['a' => $a['id']]), 'name');
    $discs = db_alle('SELECT d.id, d.pos, d.format, d.titel, (SELECT COUNT(*) FROM tracks t WHERE t.datentraeger_id = d.id) AS n FROM datentraeger d WHERE d.edition_id = :e ORDER BY d.pos', ['e' => $editionId]);
    $discNach = [];
    foreach ($discs as $d) {
        $discNach[(int) $d['id']] = $d;
    }
    [$albGain, $albPeak] = tag_rg($e['album_lufs'] !== null ? (float) $e['album_lufs'] : null, $e['album_true_peak'] !== null ? (float) $e['album_true_peak'] : null);
    $typ = array_values(array_filter(array_merge([(string) $a['typ']], array_filter(explode(',', (string) $a['zusatz_typen']), 'strlen'))));
    // Versionsname (z. B. „Deluxe Edition“) in Klammern hinter den Albumnamen – wie bei den Ordnern
    $albumtitel = (string) ($e['titel'] ?: $a['titel']);
    $version = trim((string) $e['kommentar']);
    if ($version !== '' && mb_stripos($albumtitel, $version) === false) {
        $albumtitel .= ' (' . $version . ')';
    }
    // Titeljahr: Editionsdatum/-jahr, sonst aus dem Albumjahr (Erstveröffentlichung) – damit das Jahr nie fehlt
    $jahr = (string) ($e['datum'] ?: ($e['jahr'] ?: ($a['erstjahr'] ?? '')));
    $basis = [
        'ALBUM' => [$albumtitel],
        'ALBUMARTIST' => [$albumCredit['anzeige']], 'ALBUMARTISTS' => $albumCredit['namen'], 'ALBUMARTISTSORT' => [$albumCredit['sort']],
        'MUSICBRAINZ_ALBUMARTISTID' => $albumCredit['mbids'],
        'DATE' => [$jahr],
        'ORIGINALDATE' => [(string) ($a['erst_datum'] ?: ($a['erstjahr'] ?? ''))],
        'ORIGINALYEAR' => [(string) ($a['erstjahr'] ?? '')],
        'GENRE' => $genres,
        'LABEL' => array_values(array_unique(array_filter(array_column($labels, 'name')))),
        'CATALOGNUMBER' => array_values(array_unique(array_filter(array_column($labels, 'katalognummer')))),
        'BARCODE' => [(string) $e['barcode']],
        'RELEASECOUNTRY' => [(string) $e['land']],
        'RELEASETYPE' => $typ,
        'RELEASESTATUS' => [mb_strtolower((string) $e['status'])],
        'MUSICBRAINZ_ALBUMID' => [ist_uuid($e['mbid'] ?? '') ? strtolower((string) $e['mbid']) : ''],
        'MUSICBRAINZ_RELEASEGROUPID' => [ist_uuid($a['mbid'] ?? '') ? strtolower((string) $a['mbid']) : ''],
        'DISCTOTAL' => [(string) count($discs)],
        'AMBERWAVE_EDITION' => [(string) $e['kommentar']],
        'REPLAYGAIN_ALBUM_GAIN' => [$albGain ?? ''], 'REPLAYGAIN_ALBUM_PEAK' => [$albPeak ?? ''],
    ];
    // Beteiligte (Produzent, Komponist, Musiker/Gäste …) nur schreiben, wenn gewünscht – Standard aus
    $mitwirkende = (bool) (konfig()['aufraeumen']['mitwirkende'] ?? false);
    $allgemein = $mitwirkende ? tag_beteiligte([['edition', $editionId], ['album', (int) $a['id']]]) : [];

    $aus = [];
    $tracks = db_alle('SELECT t.*, au.mbid AS rec_mbid,
            (SELECT d.lufs FROM dateien d WHERE d.track_id = t.id ORDER BY d.bittiefe DESC, d.id LIMIT 1) AS lufs,
            (SELECT d.true_peak FROM dateien d WHERE d.track_id = t.id ORDER BY d.bittiefe DESC, d.id LIMIT 1) AS tp
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id LEFT JOIN aufnahmen au ON au.id = t.aufnahme_id
        WHERE m.edition_id = :e ORDER BY m.pos, t.pos', ['e' => $editionId]);
    foreach ($tracks as $t) {
        $d = $discNach[(int) $t['datentraeger_id']] ?? ['pos' => 1, 'n' => 0, 'format' => '', 'titel' => ''];
        $c = tag_credit($t['credit_id'] ? (int) $t['credit_id'] : null);
        $werke = $t['aufnahme_id'] ? db_alle('SELECT w.id, w.titel, w.mbid FROM aufnahme_werke aw JOIN werke w ON w.id = aw.werk_id WHERE aw.aufnahme_id = :a', ['a' => $t['aufnahme_id']]) : [];
        $ziele = [];
        if ($t['aufnahme_id']) {
            $ziele[] = ['aufnahme', (int) $t['aufnahme_id']];
        }
        foreach ($werke as $w) {
            $ziele[] = ['werk', (int) $w['id']];
        }
        $bet = $mitwirkende ? tag_beteiligte($ziele) : [];
        foreach ($allgemein as $f => $w) {
            $bet[$f] = array_values(array_unique(array_merge($bet[$f] ?? [], $w)));
        }
        [$trGain, $trPeak] = tag_rg($t['lufs'] !== null ? (float) $t['lufs'] : null, $t['tp'] !== null ? (float) $t['tp'] : null);
        $tags = $basis + [
            'TITLE' => [(string) $t['titel']],
            'ARTIST' => [$c['anzeige'] ?: $albumCredit['anzeige']], 'ARTISTS' => $c['namen'] ?: $albumCredit['namen'],
            'ARTISTSORT' => [$c['anzeige'] ? $c['sort'] : $albumCredit['sort']],
            'MUSICBRAINZ_ARTISTID' => $c['mbids'] ?: $albumCredit['mbids'],
            'TRACKNUMBER' => [(string) (int) $t['pos']], 'TRACKTOTAL' => [(string) (int) $d['n']],
            'DISCNUMBER' => [(string) (int) $d['pos']], 'DISCSUBTITLE' => [(string) $d['titel']],
            'MEDIA' => [(string) ($d['format'] ?: $e['format_text'])],
            'MUSICBRAINZ_TRACKID' => [ist_uuid($t['rec_mbid'] ?? '') ? strtolower((string) $t['rec_mbid']) : ''],
            'MUSICBRAINZ_RELEASETRACKID' => [ist_uuid($t['mbid'] ?? '') ? strtolower((string) $t['mbid']) : ''],
            'WORK' => array_column($werke, 'titel'),
            'MUSICBRAINZ_WORKID' => array_values(array_filter(array_map(static fn($w) => strtolower((string) $w['mbid']), $werke), 'ist_uuid')),
            'REPLAYGAIN_TRACK_GAIN' => [$trGain ?? ''], 'REPLAYGAIN_TRACK_PEAK' => [$trPeak ?? ''],
        ] + $bet;
        // leere Werte raus
        foreach ($tags as $f => $w) {
            $w = array_values(array_filter(array_map(static fn($x) => trim((string) $x), (array) $w), static fn($x) => $x !== ''));
            if ($w) {
                $tags[$f] = $w;
            } else {
                unset($tags[$f]);
            }
        }
        $aus[(int) $t['id']] = $tags;
    }
    return $aus;
}

/** Beteiligte (Rollen) zu Objekten: ['COMPOSER' => [...], 'PERFORMER' => ['Name (guitar)', ...], ...] */
function tag_beteiligte(array $ziele): array
{
    $aus = [];
    foreach ($ziele as [$art, $id]) {
        $zeilen = db_alle("SELECT b.id, bt.schluessel, b.attribute, COALESCE(NULLIF(b.name_als, ''), k.name) AS name,
                (SELECT GROUP_CONCAT(i.name ORDER BY i.name SEPARATOR '|') FROM beziehung_instrumente bi JOIN instrumente i ON i.id = bi.instrument_id WHERE bi.beziehung_id = b.id) AS instr
            FROM beziehungen b JOIN beziehungstypen bt ON bt.id = b.typ_id JOIN kuenstler k ON k.id = b.von_id
            WHERE b.von_art = 'kuenstler' AND b.zu_art = :a AND b.zu_id = :i ORDER BY bt.reihenfolge, b.pos", ['a' => $art, 'i' => $id]);
        foreach ($zeilen as $z) {
            $s = (string) $z['schluessel'];
            $name = (string) $z['name'];
            if (isset(TAGZIEL_ROLLEN[$s])) {
                $aus[TAGZIEL_ROLLEN[$s]][] = $name;
            } elseif (in_array($s, ['vocal', 'instrument', 'performer', 'orchestra', 'chorus_master'], true)) {
                $was = [];
                if ($z['instr']) {
                    $was = explode('|', (string) $z['instr']);
                } elseif ($s === 'vocal') {
                    $attr = array_filter(array_map('trim', explode(',', (string) $z['attribute'])), static fn($x) => $x !== '' && !in_array($x, ['guest', 'additional', 'solo'], true));
                    $was = [$attr ? implode(' ', $attr) . (str_contains(implode(' ', $attr), 'vocal') ? '' : ' vocals') : 'vocals'];
                } elseif ($s === 'orchestra') {
                    $was = ['orchestra'];
                } elseif ($s === 'chorus_master') {
                    $was = ['chorus master'];
                }
                foreach ($was ?: [''] as $w) {
                    $aus['PERFORMER'][] = $name . ($w !== '' ? ' (' . $w . ')' : '');
                }
            }
        }
    }
    foreach ($aus as $f => $w) {
        $aus[$f] = array_values(array_unique($w));
    }
    return $aus;
}

/** Werden fremde Tags entfernt (AUFRAEUMEN_TAGS=sauber)? */
function tags_sauber(): bool
{
    return (konfig()['aufraeumen']['tags'] ?? 'sauber') === 'sauber';
}

/** Fremde Felder, die auch beim sauberen Schreiben bleiben (Liedtexte, ISRC … – AUFRAEUMEN_BEHALTEN) */
function tag_behalten(string $feld): bool
{
    $f = strtoupper($feld);
    return in_array($f, konfig()['aufraeumen']['behalten'] ?? [], true);
}

/**
 * Ist-Tags (aus der Datei) mit Soll-Tags zusammenführen: Verwaltetes ersetzen; Fremdes bleibt nur beim Ergänzen
 * bzw. wenn es in AUFRAEUMEN_BEHALTEN steht.
 */
function tags_zusammenfuehren(array $ist, array $soll): array
{
    $neu = [];
    $weg = [];
    foreach ($soll as $f => $w) {
        $weg[$f] = true;
        foreach (TAG_ALIASE[$f] ?? [] as $al) {
            $weg[$al] = true;
        }
    }
    $sauber = tags_sauber();
    foreach ($ist as $f => $w) {
        $F = strtoupper((string) $f);
        if (!isset($weg[$F]) && (!$sauber || tag_behalten($F))) {
            $neu[$F] = array_values((array) $w);
        }
    }
    foreach ($soll as $f => $w) {
        $neu[$f] = $w;
    }
    return $neu;
}

/** Unterschiede für die Vorschau: [[feld, alt, neu]]; beim sauberen Schreiben auch, was entfernt wird (neu = '') */
function tags_unterschiede(array $ist, array $soll): array
{
    $istN = [];
    foreach ($ist as $f => $w) {
        $istN[strtoupper((string) $f)] = array_values((array) $w);
    }
    $alias = [];
    foreach (TAG_ALIASE as $haupt => $aliase) {
        foreach ($aliase as $al) {
            $alias[$al] = $haupt;
            if (!isset($istN[$haupt]) && isset($istN[$al])) {
                $istN[$haupt] = $istN[$al];
            }
        }
    }
    $aus = [];
    foreach ($soll as $f => $w) {
        $alt = $istN[$f] ?? [];
        if (array_map('strval', $alt) !== array_map('strval', $w)) {
            $aus[] = [$f, implode(' · ', $alt), implode(' · ', $w)];
        }
    }
    if (tags_sauber()) {
        foreach ($istN as $f => $w) {
            if (isset($soll[$f]) || isset($alias[$f]) || tag_behalten($f) || in_array($f, ['ENCODER', 'VENDOR'], true)) {
                continue; // ENCODER ist bei FLAC der Vendor-String, keine echte Angabe
            }
            $aus[] = [$f, implode(' · ', $w), ''];
        }
    }
    return $aus;
}
