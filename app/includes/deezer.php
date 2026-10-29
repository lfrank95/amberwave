<?php
// Kennzeichnung „explizit“ je Titel von Deezer (öffentliche Schnittstelle, kein Schlüssel, kein Konto).
// Läuft unauffällig beim MusicBrainz-Abgleich und bei „Metadaten abgleichen“ mit – keine eigene Funktion.
//
// Reihenfolge je Edition (Handeingaben und Datei-Tags haben immer Vorrang und werden nie angefasst):
//  1. Barcode der Edition → album/upc:… → ganze Titelliste mit Kennzeichnung (eine Anfrage pro Album)
//  2. übrige Titel mit ISRC → track/isrc:…
//  3. übrige Titel → Suche nach Künstler + Titel (+ Album); übernommen nur bei passendem Titel und Länge (±3 s)
// Ohne Treffer bleibt der Titel „unbekannt“ und wird nach DEEZER_WIEDERHOLEN_TAGE erneut versucht.
// Werte in tracks.explizit: NULL unbekannt, 0 nicht explizit, 1 explizit, 2 Clean-Fassung (bearbeitet).
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

require_once __DIR__ . '/musicbrainz.php';

function deezer_aktiv(): bool
{
    return (bool) (konfig()['quellen']['deezer_aktiv'] ?? false);
}

/** GET an Deezer (JSON). Liefert das Ergebnis, null bei „nicht gefunden“; wirft bei Netz- oder Dienstfehlern. */
function deezer_holen(string $pfad, array $param = []): ?array
{
    static $letzte = 0.0;
    $url = konfig()['quellen']['deezer_url'] . '/' . ltrim($pfad, '/') . ($param ? '?' . http_build_query($param) : '');
    $ordner = konfig()['pfade']['cache'] . '/deezer';
    $datei = $ordner . '/' . hash('sha256', $url) . '.json';
    if (is_file($datei) && filemtime($datei) > time() - 7 * 86400) {
        $j = json_decode((string) file_get_contents($datei), true);
        return is_array($j) && $j ? $j : null;
    }
    for ($versuch = 0; $versuch < 2; $versuch++) {
        // Takt: Deezer erlaubt etwa 50 Anfragen in 5 Sekunden – wir bleiben deutlich darunter
        $warten = 0.15 - (microtime(true) - $letzte);
        if ($warten > 0) {
            usleep((int) ($warten * 1000000));
        }
        $letzte = microtime(true);
        $r = http_holen($url, ['Accept: application/json'], 15, 4 * 1024 * 1024);
        if ($r['status'] >= 500 || $r['status'] === 429) {
            if ($versuch === 0) { sleep(2); continue; }
            throw new RuntimeException(t('Deezer antwortet nicht (HTTP {status}).', ['status' => $r['status']]));
        }
        $j = json_decode($r['body'], true);
        if (!is_array($j)) {
            throw new RuntimeException(t('Deezer: unerwartete Antwort.'));
        }
        if (isset($j['error'])) {
            $code = (int) ($j['error']['code'] ?? 0);
            if ($code === 4 && $versuch === 0) { sleep(5); continue; } // Kontingent kurz überschritten
            if ($code === 800 || $code === 700 || $code === 600) {      // keine Daten / nicht gefunden
                $j = [];
            } else {
                throw new RuntimeException('Deezer: ' . ($j['error']['message'] ?? 'Fehler'));
            }
        }
        if (!is_dir($ordner)) {
            @mkdir($ordner, 0775, true);
        }
        @file_put_contents($datei, json_encode($j));
        return $j ?: null;
    }
    return null;
}

/** Deezer-Angaben eines Titels → unser Wert (0, 1, 2) */
function deezer_wert(array $t): int
{
    $c = isset($t['explicit_content_lyrics']) ? (int) $t['explicit_content_lyrics'] : -1;
    if ($c === 1 || $c === 4 || !empty($t['explicit_lyrics'])) {
        return 1;                       // explizit / teilweise explizit
    }
    return $c === 3 ? 2 : 0;            // 3 = bearbeitet (Clean-Fassung), sonst nicht explizit
}

/** Titel für den Vergleich: klein, ohne Klammerzusätze (feat., Remaster …) und Satzzeichen */
function deezer_titel_norm(string $s): string
{
    $s = mb_strtolower($s);
    $s = (string) preg_replace('/[\(\[][^\)\]]*[\)\]]/u', ' ', $s);
    $s = (string) preg_replace('/\s+-\s+.*$/u', ' ', $s);            // „Titel - 2011 Remaster“
    $s = (string) preg_replace('/\b(feat|ft)\.?\s.*$/u', ' ', $s);
    return trim((string) preg_replace('/[^\p{L}\p{N}]+/u', '', $s));
}

function deezer_passt(array $unser, array $dz, int $toleranz = 3): bool
{
    $a = deezer_titel_norm((string) $unser['titel']);
    $b = deezer_titel_norm((string) ($dz['title'] ?? ''));
    $titel = $a !== '' && $b !== '' && ($a === $b || (mb_strlen($a) >= 4 && (str_contains($a, $b) || str_contains($b, $a))));
    $ms = (int) ($unser['laenge_ms'] ?? 0);
    $laenge = $ms <= 0 || !isset($dz['duration']) || abs($ms / 1000 - (int) $dz['duration']) <= $toleranz;
    return $titel && $laenge;
}

/** Alle Titel eines Deezer-Albums (bei langen Alben über die Titel-Seite nachladen) */
function deezer_album_titel(array $album): array
{
    $liste = $album['tracks']['data'] ?? [];
    if (count($liste) < (int) ($album['nb_tracks'] ?? 0) && !empty($album['id'])) {
        $r = deezer_holen('album/' . (int) $album['id'] . '/tracks', ['limit' => 1000]);
        if ($r && !empty($r['data'])) {
            $liste = $r['data'];
        }
    }
    return array_values($liste);
}

/** Barcode-Varianten (EAN-13 mit führender 0 ↔ UPC-12) */
function deezer_barcodes(string $bc): array
{
    $bc = preg_replace('/\D/', '', $bc);
    if (strlen($bc) < 8 || strlen($bc) > 14) {
        return [];
    }
    $v = [$bc];
    if (strlen($bc) === 13 && $bc[0] === '0') $v[] = substr($bc, 1);
    if (strlen($bc) === 12) $v[] = '0' . $bc;
    return array_values(array_unique($v));
}

/**
 * Kennzeichnung für die Titel einer Edition holen. $nurUnbekannte: Titel überspringen, die Deezer schon beantwortet hat
 * oder vor kurzem ohne Treffer gefragt wurden. Gibt die Zahl der gesetzten Titel zurück. Wirft bei Netzproblemen.
 */
function deezer_edition_explizit(int $editionId, bool $nurUnbekannte = true): int
{
    if (!deezer_aktiv()) {
        return 0;
    }
    $tage = max(1, (int) (konfig()['quellen']['deezer_wiederholen_tage'] ?? 30));
    $ed = db_zeile('SELECT e.id, e.barcode, e.titel, e.credit_id, a.titel AS album_titel, a.credit_id AS album_credit FROM editionen e JOIN alben a ON a.id = e.album_id WHERE e.id = :e', ['e' => $editionId]);
    if (!$ed) {
        return 0;
    }
    $alle = db_alle("SELECT t.id, t.titel, t.isrc, t.credit_id, t.explizit, t.explizit_quelle, t.explizit_am, m.pos AS disc, t.pos,
            COALESCE(t.laenge_ms, (SELECT d.laenge_ms FROM dateien d WHERE d.track_id = t.id ORDER BY d.id LIMIT 1)) AS laenge_ms
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e ORDER BY m.pos, t.pos, t.id", ['e' => $editionId]);
    $grenze = time() - $tage * 86400;
    $offen = array_values(array_filter($alle, static function ($t) use ($nurUnbekannte, $grenze) {
        if (in_array($t['explizit_quelle'], ['hand', 'datei'], true)) return false;
        if (!$nurUnbekannte) return true;
        if ($t['explizit_quelle'] === 'deezer') return false;
        return $t['explizit_am'] === null || strtotime((string) $t['explizit_am']) < $grenze;
    }));
    if (!$offen) {
        return 0;
    }
    $treffer = []; // Track-ID → Wert
    $kuenstler = implode(' ', array_column(credit_liste((int) ($ed['credit_id'] ?: $ed['album_credit'])), 'name'));

    // 1. Ganzes Album über den Barcode
    foreach (deezer_barcodes((string) $ed['barcode']) as $bc) {
        $album = deezer_holen('album/upc:' . $bc);
        if (!$album) continue;
        $dz = deezer_album_titel($album);
        $gleichLang = count($dz) === count($alle);
        foreach ($offen as $t) {
            // Erst die Position (bei gleicher Titelzahl) mit Längenprüfung, sonst über Titel und Länge
            $i = array_search($t['id'], array_column($alle, 'id'), true);
            if ($gleichLang && isset($dz[$i]) && (deezer_passt($t, $dz[$i]) || deezer_passt(['titel' => $dz[$i]['title'] ?? ''] + $t, $dz[$i], 2))) {
                $treffer[(int) $t['id']] = deezer_wert($dz[$i]);
                continue;
            }
            foreach ($dz as $x) {
                if (deezer_passt($t, $x)) { $treffer[(int) $t['id']] = deezer_wert($x); break; }
            }
        }
        break;
    }
    // 2. Einzeln über den ISRC
    foreach ($offen as $t) {
        if (isset($treffer[(int) $t['id']]) || !preg_match('/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/', (string) $t['isrc'])) continue;
        $x = deezer_holen('track/isrc:' . $t['isrc']);
        if ($x && !empty($x['id'])) {
            $treffer[(int) $t['id']] = deezer_wert($x);
        }
    }
    // 3. Suche nach Künstler und Titel (nur bei eindeutig passendem Titel und Länge)
    foreach ($offen as $t) {
        if (isset($treffer[(int) $t['id']])) continue;
        $tk = $t['credit_id'] ? implode(' ', array_column(credit_liste((int) $t['credit_id']), 'name')) : $kuenstler;
        $titel = trim((string) preg_replace('/\s*[\(\[][^\)\]]*[\)\]]\s*/u', ' ', (string) $t['titel']));
        if ($tk === '' || $titel === '') continue;
        $q = 'artist:"' . str_replace('"', '', $tk) . '" track:"' . str_replace('"', '', $titel) . '"';
        $r = deezer_holen('search', ['q' => $q, 'limit' => 15]);
        $kandidaten = $r['data'] ?? [];
        $albumNorm = deezer_titel_norm((string) ($ed['titel'] ?: $ed['album_titel']));
        usort($kandidaten, static fn($a, $b) => (deezer_titel_norm((string) ($b['album']['title'] ?? '')) === $albumNorm) <=> (deezer_titel_norm((string) ($a['album']['title'] ?? '')) === $albumNorm));
        foreach ($kandidaten as $x) {
            if (deezer_passt($t, $x, 2)) { $treffer[(int) $t['id']] = deezer_wert($x); break; }
        }
    }
    // Speichern: Treffer setzen, sonst nur den Versuch vermerken
    foreach ($offen as $t) {
        $id = (int) $t['id'];
        if (isset($treffer[$id])) {
            db_tun("UPDATE tracks SET explizit = :x, explizit_quelle = 'deezer', explizit_am = NOW() WHERE id = :id AND explizit_quelle NOT IN ('hand', 'datei')", ['x' => $treffer[$id], 'id' => $id]);
        } else {
            db_tun("UPDATE tracks SET explizit_am = NOW() WHERE id = :id", ['id' => $id]);
        }
    }
    edition_explizit_aktualisieren($editionId);
    return count($treffer);
}

/** Zusammenfassung je Edition: mindestens ein Titel explizit; Clean-Fassung, wenn Titel bearbeitet sind und keiner explizit ist */
function edition_explizit_aktualisieren(int $editionId): void
{
    $z = db_zeile('SELECT MAX(t.explizit = 1) AS e, MAX(t.explizit = 2) AS c FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $editionId]) ?? [];
    $e = (int) ($z['e'] ?? 0);
    db_tun('UPDATE editionen SET explizit = :e, clean = :c WHERE id = :id', ['e' => $e, 'c' => $e ? 0 : (int) ($z['c'] ?? 0), 'id' => $editionId]);
}

/** ISRCs der Aufnahmen einer MusicBrainz-Edition in die Titel übernehmen (nur wo noch keiner steht) */
function mb_isrcs_uebernehmen(int $editionId, array $rel): void
{
    foreach ($rel['media'] ?? [] as $m) {
        foreach ($m['tracks'] ?? [] as $t) {
            $isrc = strtoupper((string) (($t['recording']['isrcs'] ?? [])[0] ?? ''));
            if ($isrc === '' || empty($t['id'])) continue;
            db_tun("UPDATE tracks t JOIN datentraeger m ON m.id = t.datentraeger_id SET t.isrc = :i WHERE t.mbid = :m AND m.edition_id = :e AND t.isrc = ''",
                ['i' => mb_substr($isrc, 0, 15), 'm' => strtolower((string) $t['id']), 'e' => $editionId]);
        }
    }
}
