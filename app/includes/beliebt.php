<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/bibliothek.php';
require_once __DIR__ . '/musicbrainz.php';
require_once __DIR__ . '/api_nutzer.php';

/**
 * Künstlerseite: Genre-Badges und beliebteste Titel.
 * - Genres: MusicBrainz-Genres des Künstlers mit Stimmen (beim Abgleich bzw. beim ersten Aufruf geholt); fehlen sie,
 *   die häufigsten Genres seiner Alben in der Bibliothek.
 * - Weltweit: ListenBrainz (offene Hörstatistik von MetaBrainz) – beliebteste Aufnahmen als MusicBrainz-IDs, damit exakt
 *   unseren Titeln zuzuordnen; sonst gleicher Titel (ohne „Remaster“, „Single Version“ …) beim selben Künstler.
 *   Fehlende Titel bleiben in der Liste (mit Album), damit man sieht, was man besorgen könnte.
 * - Bei uns: am häufigsten gehörte Titel des Künstlers aller Familienmitglieder.
 */

/** Titel für den Vergleich: Klammerzusätze und „ - 2008 Remaster“ & Co. weg */
function titel_basis(string $t): string
{
    $t = (string) preg_replace('/\s*[\(\[][^\)\]]*[\)\]]/u', '', $t);
    $t = (string) preg_replace('/\s+[-–]\s+.*\b(remaster(ed)?|version|mix|edit|mono|stereo|single|album|radio|demo|live|take)\b.*$/iu', '', $t);
    return name_norm($t);
}

/** MusicBrainz-Genres eines Künstlers speichern (die stärksten 8, mit Stimmen) */
function kuenstler_genres_speichern(int $kid, array $genres): void
{
    usort($genres, static fn($a, $b) => (int) ($b['count'] ?? 0) <=> (int) ($a['count'] ?? 0));
    db_tun('DELETE FROM kuenstler_genres WHERE kuenstler_id = :k', ['k' => $kid]);
    foreach (array_slice($genres, 0, 8) as $g) {
        $gid = genre_holen(mb_genre_name((string) ($g['name'] ?? '')));
        if ($gid && (int) ($g['count'] ?? 0) > 0) {
            db_tun('INSERT IGNORE INTO kuenstler_genres (kuenstler_id, genre_id, stimmen) VALUES (:k, :g, :s)', ['k' => $kid, 'g' => $gid, 's' => (int) $g['count']]);
        }
    }
    db_tun('UPDATE kuenstler SET genres_am = NOW() WHERE id = :k', ['k' => $kid]);
}

/** Abfrage bei ListenBrainz, zwischengespeichert (BELIEBT_TAGE) */
function lb_abfrage(string $pfad): array
{
    $q = konfig()['quellen'];
    $url = $q['listenbrainz_url'] . '/' . ltrim($pfad, '/');
    $o = konfig()['pfade']['cache'] . '/listenbrainz';
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    $datei = $o . '/' . hash('sha256', $url) . '.json';
    if (is_file($datei) && filemtime($datei) > time() - max(1, $q['beliebt_tage']) * 86400) {
        $d = json_decode((string) file_get_contents($datei), true);
        if (is_array($d)) {
            return $d;
        }
    }
    $r = http_holen($url, ['Accept: application/json'], 15, 4 * 1024 * 1024);
    if ($r['status'] === 404 || $r['status'] === 400) {
        $d = [];
    } elseif ($r['status'] !== 200) {
        throw new MbFehler(t('ListenBrainz antwortet nicht (Status {status}).', ['status' => $r['status']]));
    } else {
        $d = json_decode($r['body'], true);
        if (!is_array($d)) {
            throw new MbFehler(t('Unerwartete Antwort von ListenBrainz.'));
        }
    }
    @file_put_contents($datei . '.tmp', json_encode($d));
    @rename($datei . '.tmp', $datei);
    return $d;
}

/**
 * Alle Titel des Künstlers in der Bibliothek (mit Datei), je Aufnahme-MBID und je Grundtitel die beste Fassung:
 * Studioalbum vor EP/Single, vor Live/Kompilation/Soundtrack; dann beste Qualität.
 */
function kuenstler_titel_index(int $kid): array
{
    $zeilen = db_alle("SELECT t.id, t.titel, au.mbid AS rec, a.typ, a.zusatz_typen, e.beste_qualitaet, COALESCE(a.erstjahr, e.jahr) AS jahr
        FROM tracks t JOIN credit_namen cn ON cn.credit_id = t.credit_id AND cn.kuenstler_id = :k
        JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id
        LEFT JOIN aufnahmen au ON au.id = t.aufnahme_id
        WHERE EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id)", ['k' => $kid]);
    $rang = static function (array $z): array {
        $zusatz = (string) $z['zusatz_typen'];
        $neben = (int) (str_contains($zusatz, 'live') || str_contains($zusatz, 'compilation') || str_contains($zusatz, 'soundtrack') || str_contains($zusatz, 'remix'));
        $typ = ['album' => 0, 'ep' => 1, 'single' => 2][(string) $z['typ']] ?? 3;
        return [$neben, $typ, (int) ($z['jahr'] ?: 9999)];
    };
    $nachRec = [];
    $nachTitel = [];
    foreach ($zeilen as $z) {
        $r = $rang($z);
        if ($z['rec']) {
            $k = strtolower((string) $z['rec']);
            if (!isset($nachRec[$k]) || $r < $nachRec[$k]['r']) {
                $nachRec[$k] = ['id' => (int) $z['id'], 'r' => $r];
            }
        }
        $b = titel_basis((string) $z['titel']);
        if ($b !== '' && (!isset($nachTitel[$b]) || $r < $nachTitel[$b]['r'])) {
            $nachTitel[$b] = ['id' => (int) $z['id'], 'r' => $r];
        }
    }
    return [$nachRec, $nachTitel];
}

function api_kuenstler_beliebt(array $user, int $kid): array
{
    $k = db_zeile('SELECT id, mbid, genres_am FROM kuenstler WHERE id = :id', ['id' => $kid]);
    if (!$k) {
        throw new ApiFehler(t('Künstler nicht gefunden.'), 404);
    }
    $mbid = ist_uuid($k['mbid'] ?? '') ? strtolower((string) $k['mbid']) : null;
    $hinweise = [];

    // ---- Genres ----
    if ($mbid && ($k['genres_am'] === null || strtotime((string) $k['genres_am']) < time() - 30 * 86400)) {
        try {
            $a = mb_abfrage('artist/' . $mbid, ['inc' => 'aliases+artist-rels+url-rels+genres'], 7 * 86400);
            kuenstler_genres_speichern($kid, $a['genres'] ?? []);
        } catch (Throwable $e) {
            $hinweise[] = t('Genres: {fehler}', ['fehler' => $e->getMessage()]);
        }
    }
    $genres = db_alle('SELECT g.id, g.name, kg.stimmen FROM kuenstler_genres kg JOIN genres g ON g.id = kg.genre_id
        WHERE kg.kuenstler_id = :k ORDER BY kg.stimmen DESC, g.name LIMIT 5', ['k' => $kid]);
    $genresQuelle = 'musicbrainz';
    if (!$genres) {
        $genresQuelle = 'alben';
        $genres = db_alle('SELECT g.id, g.name, COUNT(DISTINCT a.id) AS stimmen FROM alben a JOIN credit_namen cn ON cn.credit_id = a.credit_id AND cn.kuenstler_id = :k
            JOIN album_genres ag ON ag.album_id = a.id JOIN genres g ON g.id = ag.genre_id GROUP BY g.id, g.name ORDER BY stimmen DESC, g.name LIMIT 5', ['k' => $kid]);
    }
    foreach ($genres as &$g) {
        $g = ['id' => (int) $g['id'], 'name' => $g['name'], 'stimmen' => (int) $g['stimmen']];
    }
    unset($g);

    // ---- Weltweit (ListenBrainz) ----
    [$nachRec, $nachTitel] = kuenstler_titel_index($kid);
    $welt = [];
    if ($mbid) {
        try {
            $liste = lb_abfrage('1/popularity/top-recordings-for-artist/' . $mbid);
            $gesehen = [];
            foreach ($liste as $r) {
                $rec = strtolower((string) ($r['recording_mbid'] ?? ''));
                $titel = (string) ($r['recording_name'] ?? '');
                $basis = titel_basis($titel);
                if ($titel === '' || isset($gesehen[$basis])) {
                    continue; // dasselbe Lied in anderer Aufnahme (Single-, Album-, Remaster-Fassung) nur einmal
                }
                $gesehen[$basis] = true;
                $track = $nachRec[$rec]['id'] ?? ($nachTitel[$basis]['id'] ?? null);
                $welt[] = ['rang' => count($welt) + 1, 'titel' => $titel, 'aufnahme_mbid' => $rec,
                    'hoerer' => (int) ($r['total_user_count'] ?? 0), 'wiedergaben' => (int) ($r['total_listen_count'] ?? 0),
                    'album' => (string) ($r['release_name'] ?? ''), 'release_mbid' => strtolower((string) ($r['release_mbid'] ?? '')),
                    'laenge_ms' => isset($r['length']) ? (int) $r['length'] : null, 'track_id' => $track];
                if (count($welt) >= 10) {
                    break;
                }
            }
        } catch (Throwable $e) {
            $hinweise[] = t('ListenBrainz: {fehler}', ['fehler' => $e->getMessage()]);
        }
    }

    // ---- Bei uns (alle Familienmitglieder, gezählte Wiedergaben) ----
    $eigen = db_alle('SELECT t.id, t.titel, COUNT(*) AS n FROM wiedergaben w JOIN tracks t ON t.id = w.track_id
        JOIN credit_namen cn ON cn.credit_id = t.credit_id AND cn.kuenstler_id = :k
        WHERE w.gezaehlt = 1 AND EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id)
        GROUP BY t.id, t.titel ORDER BY n DESC LIMIT 60', ['k' => $kid]);
    $beiUns = [];
    $gesehen = [];
    foreach ($eigen as $z) {
        $b = titel_basis((string) $z['titel']);
        if (isset($gesehen[$b])) {
            $beiUns[$gesehen[$b]]['wiedergaben'] += (int) $z['n']; // gleiche Lieder aus verschiedenen Alben zusammenzählen
            continue;
        }
        $gesehen[$b] = count($beiUns);
        $beiUns[] = ['track_id' => (int) $z['id'], 'wiedergaben' => (int) $z['n']];
    }
    usort($beiUns, static fn($a, $b) => $b['wiedergaben'] <=> $a['wiedergaben']);
    $beiUns = array_slice($beiUns, 0, 10);

    // Titel für den Player
    $ids = array_values(array_unique(array_filter(array_merge(array_column($welt, 'track_id'), array_column($beiUns, 'track_id')))));
    $tracks = [];
    foreach (tracks_mit_album($ids, (int) $user['id']) as $t) {
        $tracks[(string) $t['id']] = $t;
    }
    return ['genres' => $genres, 'genres_quelle' => $genresQuelle, 'welt' => $welt, 'welt_quelle' => $mbid ? 'listenbrainz' : null,
        'bei_uns' => $beiUns, 'tracks' => (object) $tracks, 'hinweise' => $hinweise, 'mbid' => $mbid];
}
