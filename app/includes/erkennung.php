<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/musicbrainz.php';

/**
 * Erkennung am Klang: Alben per akustischem Fingerabdruck bei MusicBrainz finden.
 *
 * 1. Fingerabdruck je Datei (Chromaprint, die ersten 120 s – über ffmpeg, sonst fpcalc).
 * 2. AcoustID liefert dazu die MusicBrainz-Aufnahmen und die Releases, auf denen sie vorkommen (≤ 3 Anfragen/s).
 * 3. Je Edition (Albumordner): Releases, die (fast) alle unsere Aufnahmen enthalten, werden bei MusicBrainz geladen und
 *    Titel für Titel verglichen – Aufnahme, Reihenfolge, Anzahl, Laufzeiten → Sicherheit in %.
 * 4. Eindeutig → automatisch übernehmen (ERKENNUNG_AUTO). Gleiche Titelliste auf mehreren Editionen (CD/Vinyl/Länder):
 *    Tags (MusicBrainz-ID, Barcode) und Laufzeiten entscheiden, sonst Regeln (offiziell, Format passend zur Datei,
 *    Land, frühestes Datum) – je nach Einstellung übernehmen oder zur Bestätigung vorlegen.
 * Bearbeitet werden nur Editionen, die noch nicht mit MusicBrainz abgeglichen sind (quelle = 'tags'); an den Dateien
 * wird nichts geändert.
 */

final class ErkFehler extends RuntimeException
{
}

const ERK_SPERRE = '/tmp/erkennung.lock';
const ERK_STATUS_TEXT = [
    'uebernommen' => 'übernommen', 'eindeutig' => 'eindeutig erkannt', 'regeln' => 'Edition nach Regeln gewählt',
    'unsicher' => 'unsicher', 'nichts' => 'nicht erkannt', 'doppelt' => 'doppelt vorhanden', 'fehler' => 'Fehler',
    'ignoriert' => 'ignoriert', 'bestaetigt' => 'von Hand übernommen',
];

function erk_konfig(): array
{
    return konfig()['erkennung'];
}

function erk_schluessel(): string
{
    return trim(einstellung('acoustid_api_key'));
}

function erk_bereit(): bool
{
    return erk_konfig()['aktiv'] && erk_schluessel() !== '';
}

/** Läuft überhaupt eine Zuordnung (Tags brauchen keinen AcoustID-Schlüssel)? */
function erk_aktiv(): bool
{
    return erk_konfig()['aktiv'];
}

function erk_laeuft(): bool
{
    $h = @fopen(konfig()['pfade']['cache'] . ERK_SPERRE, 'c');
    if (!$h) {
        return false;
    }
    $frei = flock($h, LOCK_EX | LOCK_NB);
    if ($frei) {
        flock($h, LOCK_UN);
    }
    fclose($h);
    return !$frei;
}

/** Hintergrund-Lauf starten (wenn keiner läuft) */
function erk_anstossen(): void
{
    if (!erk_aktiv() || erk_laeuft()) {
        return;
    }
    $skript = realpath(__DIR__ . '/../scripts/erkennung.php');
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) $skript) . ' > /dev/null 2>&1 &');
}

// ---------- Fingerabdruck ----------

/** Womit wird der Fingerabdruck gerechnet? 'ffmpeg' (Chromaprint-Muxer), 'fpcalc' oder null */
function erk_werkzeug(): ?string
{
    static $w = false;
    if ($w !== false) {
        return $w;
    }
    $ff = konfig()['stream']['ffmpeg'];
    $aus = (string) @shell_exec(escapeshellarg($ff) . ' -hide_banner -muxers 2>/dev/null');
    if (preg_match('/\bchromaprint\b/', $aus)) {
        return $w = 'ffmpeg';
    }
    $fp = trim((string) @shell_exec('command -v fpcalc 2>/dev/null'));
    return $w = ($fp !== '' ? 'fpcalc' : null);
}

function erk_befehl(string $pfad): array
{
    if (erk_werkzeug() === 'fpcalc') {
        return ['fpcalc', '-plain', '-length', '120', $pfad];
    }
    return [konfig()['stream']['ffmpeg'], '-nostdin', '-v', 'error', '-threads', '1', '-i', $pfad, '-map', '0:a:0', '-t', '120',
        '-ac', '2', '-f', 'chromaprint', '-fp_format', 'base64', '-'];
}

/** Fehlende Fingerabdrücke für diese Dateien rechnen (parallel). $dateien: [id, pfad, mtime] */
function erk_fingerabdruecke(array $dateien): void
{
    $wurzel = konfig()['pfade']['musik'];
    $auftraege = [];
    $nach = [];
    foreach ($dateien as $d) {
        $auftraege[(int) $d['id']] = $wurzel . '/' . $d['pfad'];
        $nach[(int) $d['id']] = (int) $d['mtime'];
    }
    erk_fp_rechnen($auftraege, static function (int $id, ?string $fp, string $fehler) use ($nach): void {
        db_tun('INSERT INTO fingerabdruecke (datei_id, datei_mtime, fp, erstellt_am, fehler, aufnahmen, abgefragt_am)
                VALUES (:d, :m, :f, NOW(), :e, NULL, NULL)
                ON DUPLICATE KEY UPDATE datei_mtime = VALUES(datei_mtime), fp = VALUES(fp), erstellt_am = NOW(), fehler = VALUES(fehler), aufnahmen = NULL, abgefragt_am = NULL',
            ['d' => $id, 'm' => $nach[$id] ?? 0, 'f' => $fp, 'e' => mb_substr($fehler, 0, 300)]);
    });
}

/**
 * Fingerabdrücke parallel rechnen (ERKENNUNG_PARALLEL Prozesse). $auftraege: [Schlüssel => absoluter Pfad].
 * $fertig(Schlüssel, Fingerabdruck oder null, Fehlertext) wird je Datei aufgerufen, sobald sie fertig ist.
 */
function erk_fp_rechnen(array $auftraege, callable $fertig): void
{
    $parallel = erk_konfig()['parallel'];
    $laufend = [];
    while ($auftraege || $laufend) {
        while (count($laufend) < $parallel && $auftraege) {
            $schluessel = array_key_first($auftraege);
            $pfad = (string) $auftraege[$schluessel];
            unset($auftraege[$schluessel]);
            if (!is_readable($pfad)) {
                $fertig($schluessel, null, t('Datei nicht lesbar'));
                continue;
            }
            $proc = proc_open(erk_befehl($pfad), [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            if (!is_resource($proc)) {
                $fertig($schluessel, null, t('Fingerabdruck konnte nicht gestartet werden'));
                continue;
            }
            stream_set_blocking($pipes[1], false);
            stream_set_blocking($pipes[2], false);
            $laufend[] = ['proc' => $proc, 'aus' => $pipes[1], 'err' => $pipes[2], 'k' => $schluessel, 'puffer' => '', 'fehler' => ''];
        }
        if (!$laufend) {
            break;
        }
        $lesen = [];
        foreach ($laufend as $l) {
            $lesen[] = $l['aus'];
            $lesen[] = $l['err'];
        }
        $w = $x = null;
        @stream_select($lesen, $w, $x, 1);
        foreach ($laufend as $i => &$l) {
            while (($t = fread($l['aus'], 65536)) !== false && $t !== '') {
                $l['puffer'] .= $t;
            }
            while (($t = fread($l['err'], 8192)) !== false && $t !== '') {
                $l['fehler'] .= $t;
            }
            if (feof($l['aus'])) {
                fclose($l['aus']);
                fclose($l['err']);
                $status = proc_close($l['proc']);
                $fp = trim($l['puffer']);
                $ok = $status === 0 && preg_match('/^[A-Za-z0-9_\-+\/=]{20,}$/', $fp);
                $fertig($l['k'], $ok ? $fp : null,
                    $ok ? '' : t('Fingerabdruck fehlgeschlagen: {grund}', ['grund' => trim(mb_substr((string) preg_replace('/\s+/', ' ', $l['fehler']), -200))]));
                unset($laufend[$i]);
            }
        }
        unset($l);
    }
}

// ---------- AcoustID ----------

/** Takt: zwischen zwei AcoustID-Anfragen mindestens 0,34 s (höchstens 3 je Sekunde), prozessübergreifend */
function erk_takt(): void
{
    $h = @fopen(konfig()['pfade']['cache'] . '/tmp/acoustid.takt', 'c+');
    if (!$h) {
        usleep(400000);
        return;
    }
    flock($h, LOCK_EX);
    $letzte = (float) stream_get_contents($h);
    $warten = 0.34 - (microtime(true) - $letzte);
    if ($warten > 0) {
        usleep((int) ($warten * 1000000));
    }
    ftruncate($h, 0);
    rewind($h);
    fwrite($h, (string) microtime(true));
    flock($h, LOCK_UN);
    fclose($h);
}

/**
 * Eine AcoustID-Abfrage (mit Takt und Wiederholung bei Überlast). Liefert die dekodierte Antwort (status ok) oder
 * ['results' => [], 'hinweis' => …], wenn der Fingerabdruck unbrauchbar ist. $meta z. B. 'recordings releases'.
 */
function erk_acoustid_anfrage(string $fp, int $dauer, string $meta): array
{
    $url = erk_konfig()['acoustid_url'] . '/lookup';
    $daten = http_build_query(['client' => erk_schluessel(), 'format' => 'json', 'meta' => $meta,
        'duration' => max(1, $dauer), 'fingerprint' => $fp], '', '&');
    for ($versuch = 1; $versuch <= 3; $versuch++) {
        erk_takt();
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $daten, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 30, CURLOPT_ENCODING => '', CURLOPT_USERAGENT => amberwave_user_agent(),
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $fehler = curl_error($ch);
        curl_close($ch);
        dienst_zaehlen($url, $body === false ? 0 : $status);
        if ($body === false) {
            if ($versuch === 3) {
                throw new ErkFehler(t('AcoustID nicht erreichbar: {fehler}', ['fehler' => $fehler]));
            }
            sleep($versuch);
            continue;
        }
        $j = json_decode((string) $body, true);
        if ($status === 503 || $status === 429 || ($j['error']['code'] ?? 0) === 14) { // zu viele Anfragen
            sleep($versuch * 2);
            continue;
        }
        break;
    }
    if (!is_array($j ?? null)) {
        throw new ErkFehler(t('Unerwartete Antwort von AcoustID (Status {status}).', ['status' => $status]));
    }
    if (($j['status'] ?? '') !== 'ok') {
        $code = (int) ($j['error']['code'] ?? 0);
        $text = (string) ($j['error']['message'] ?? t('unbekannter Fehler'));
        if ($code === 4 || $code === 6) {
            throw new ErkFehler(t('Der AcoustID-Schlüssel wird abgelehnt ({grund}). Bitte den Schlüssel einer Anwendung von acoustid.org eintragen.', ['grund' => $text]), 401);
        }
        if ($code === 3 || $code === 8) {
            return ['results' => [], 'hinweis' => $text]; // Fingerabdruck/Dauer unbrauchbar: Titel gilt als nicht erkannt
        }
        throw new ErkFehler(t('AcoustID: {fehler}', ['fehler' => $text]));
    }
    return $j;
}

/**
 * Fingerabdruck + Dauer → Aufnahmen mit Trefferwert und die Releases, auf denen sie vorkommen.
 * Ergebnis: ['aufnahmen' => [[id, s, r => [release-ids]]], 'releases' => [id => [titel, land, datum, tracks, medien, format]]]
 */
function erk_acoustid(string $fp, int $dauer): array
{
    $j = erk_acoustid_anfrage($fp, $dauer, 'recordings releases');
    if (isset($j['hinweis'])) {
        return ['aufnahmen' => [], 'releases' => [], 'hinweis' => $j['hinweis']];
    }
    $aufnahmen = [];
    $releases = [];
    foreach ($j['results'] ?? [] as $r) {
        $score = (float) ($r['score'] ?? 0);
        if ($score < 0.5) {
            continue;
        }
        foreach ($r['recordings'] ?? [] as $rec) {
            $rid = strtolower((string) ($rec['id'] ?? ''));
            if (!ist_uuid($rid)) {
                continue;
            }
            $rels = [];
            foreach ($rec['releases'] ?? [] as $rel) {
                $id = strtolower((string) ($rel['id'] ?? ''));
                if (!ist_uuid($id)) {
                    continue;
                }
                $rels[] = $id;
                if (!isset($releases[$id])) {
                    $d = $rel['date'] ?? null;
                    $datum = is_array($d) ? trim(sprintf('%04d-%02d-%02d', $d['year'] ?? 0, $d['month'] ?? 0, $d['day'] ?? 0), '-') : (string) $d;
                    $datum = (string) preg_replace('/(-00)+$/', '', $datum === '0000-00-00' ? '' : $datum);
                    $med = $rel['mediums'] ?? [];
                    $releases[$id] = ['titel' => (string) ($rel['title'] ?? ''), 'land' => (string) ($rel['country'] ?? ''), 'datum' => $datum,
                        'tracks' => isset($rel['track_count']) ? (int) $rel['track_count'] : null, 'medien' => isset($rel['medium_count']) ? (int) $rel['medium_count'] : null,
                        'format' => (string) ($med[0]['format'] ?? '')];
                }
            }
            // gleiche Aufnahme aus mehreren Treffern: besten Wert behalten, Releases vereinen
            if (isset($aufnahmen[$rid])) {
                $aufnahmen[$rid]['s'] = max($aufnahmen[$rid]['s'], $score);
                $aufnahmen[$rid]['r'] = array_values(array_unique(array_merge($aufnahmen[$rid]['r'], $rels)));
            } else {
                $aufnahmen[$rid] = ['id' => $rid, 's' => round($score, 3), 'r' => $rels];
            }
        }
    }
    return ['aufnahmen' => array_values($aufnahmen), 'releases' => $releases];
}

// ---------- Release bestimmen ----------

/** Rang nach Regeln für gleichwertige Editionen (kleiner = besser) */
function erk_regel_rang(array $k, bool $hires): array
{
    $f = mb_strtolower($k['format'] ?? '');
    $cd = $f !== '' && (str_contains($f, 'cd') || $f === 'sacd');
    $digital = str_contains($f, 'digital');
    $analog = str_contains($f, 'vinyl') || str_contains($f, 'cassette') || str_contains($f, '"');
    $format = $hires ? ($digital ? 0 : ($cd ? 1 : ($analog ? 3 : 2))) : ($cd ? 0 : ($digital ? 1 : ($analog ? 3 : 2)));
    $land = ['DE' => 0, 'XE' => 1, 'XW' => 2, 'AT' => 3, 'CH' => 3, 'GB' => 4, 'US' => 4][$k['land'] ?? ''] ?? 5;
    return [($k['status'] ?? 'Official') === 'Official' ? 0 : 1, $format, $land, ($k['datum'] ?? '') !== '' ? $k['datum'] : '9999'];
}

function erk_regel_text(array $k, bool $hires): string
{
    $teile = [];
    $teile[] = ($k['status'] ?? 'Official') === 'Official' ? t('offiziell') : ($k['status'] ?? '');
    if ($k['format'] ?? '') {
        $teile[] = $k['format'] . ($hires ? ' ' . t('(Hi-Res-Dateien)') : '');
    }
    if ($k['land'] ?? '') {
        $teile[] = $k['land'];
    }
    if ($k['datum'] ?? '') {
        $teile[] = t('frühestes Datum {datum}', ['datum' => $k['datum']]);
    }
    return implode(', ', array_filter($teile));
}

/**
 * Unsere Dateien (mit Aufnahmen) mit einem MusicBrainz-Release vergleichen.
 * Liefert Sicherheit 0–100, Zahl der Treffer, mittlere Laufzeitabweichung (s), Reihenfolge ok.
 */
function erk_vergleichen(array $wir, array $rel): array
{
    $mb = [];
    foreach ($rel['media'] ?? [] as $m) {
        foreach ($m['tracks'] ?? [] as $t) {
            $mb[] = ['rec' => strtolower((string) ($t['recording']['id'] ?? '')), 'titel' => (string) ($t['title'] ?? ''),
                'ms' => isset($t['length']) ? (int) $t['length'] : (isset($t['recording']['length']) ? (int) $t['recording']['length'] : null)];
        }
    }
    $nW = count($wir);
    $nM = count($mb);
    if (!$nW || !$nM) {
        return ['sicherheit' => 0, 'treffer' => 0, 'abw' => null, 'tracks' => $nM];
    }
    $benutzt = [];
    $indizes = [];
    $treffer = 0.0;
    $abw = [];
    foreach ($wir as $i => $f) {
        $gefunden = null;
        $gewicht = 0.0;
        // 1. gleiche Aufnahme – bevorzugt an derselben Position
        $kandidaten = $i < $nM ? array_merge([$i], array_keys($mb)) : array_keys($mb);
        foreach ($kandidaten as $j) {
            if (!isset($benutzt[$j]) && $mb[$j]['rec'] !== '' && isset($f['recs'][$mb[$j]['rec']])) {
                $gefunden = $j;
                $gewicht = 1.0;
                break;
            }
        }
        // 2. sonst gleicher Titel und Laufzeit (±3 s) – fängt zusammengeführte Aufnahmen bei MusicBrainz ab
        if ($gefunden === null) {
            foreach ($kandidaten as $j) {
                if (!isset($benutzt[$j]) && name_norm($mb[$j]['titel']) === name_norm($f['titel'])
                    && $mb[$j]['ms'] !== null && abs($mb[$j]['ms'] - $f['ms']) <= 3000) {
                    $gefunden = $j;
                    $gewicht = 0.9;
                    break;
                }
            }
        }
        if ($gefunden !== null) {
            $benutzt[$gefunden] = true;
            $indizes[] = $gefunden;
            $treffer += $gewicht;
            if ($mb[$gefunden]['ms'] !== null && $f['ms'] > 0) {
                $abw[] = abs($mb[$gefunden]['ms'] - $f['ms']) / 1000;
            }
        }
    }
    $steigend = 0;
    for ($i = 1; $i < count($indizes); $i++) {
        if ($indizes[$i] > $indizes[$i - 1]) {
            $steigend++;
        }
    }
    $reihenfolge = count($indizes) > 1 ? $steigend / (count($indizes) - 1) : 1.0;
    $mittel = $abw ? array_sum($abw) / count($abw) : null;
    $s = 100 * min($treffer / $nW, $treffer / $nM) * (0.9 + 0.1 * $reihenfolge);
    if ($mittel !== null && $mittel > 3) {
        $s -= min(15, ($mittel - 3) * 1.5);
    }
    return ['sicherheit' => (int) max(0, round($s)), 'treffer' => round($treffer, 1), 'abw' => $mittel !== null ? round($mittel, 2) : null,
        'reihenfolge' => $reihenfolge >= 0.999, 'tracks' => $nM];
}

/** Ergebnis speichern */
function erk_merken(int $editionId, string $status, int $sicherheit, ?string $mbid, string $info, array $kandidaten = [], string $weg = 'klang'): array
{
    db_tun('INSERT INTO erkennung (edition_id, status, sicherheit, mbid, info, kandidaten, weg, geprueft_am) VALUES (:e, :s, :p, :m, :i, :k, :w, NOW())
            ON DUPLICATE KEY UPDATE status = VALUES(status), sicherheit = VALUES(sicherheit), mbid = VALUES(mbid), info = VALUES(info), kandidaten = VALUES(kandidaten), weg = VALUES(weg), geprueft_am = NOW()',
        ['e' => $editionId, 's' => $status, 'p' => max(0, min(100, $sicherheit)), 'm' => $mbid, 'i' => mb_substr($info, 0, 500),
         'k' => $kandidaten ? json_encode(array_values($kandidaten), JSON_UNESCAPED_UNICODE) : null, 'w' => $weg]);
    return ['status' => $status, 'sicherheit' => $sicherheit, 'mbid' => $mbid, 'info' => $info];
}

/**
 * Eine Edition am Klang erkennen (Fingerabdruck → AcoustID). Gibt null zurück, wenn die Zeit nicht gereicht hat (beim nächsten Lauf geht es weiter).
 */
function erk_edition_klang(int $editionId, int $bis): ?array
{
    $ed = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $editionId]);
    if (!$ed || $ed['quelle'] !== 'tags') {
        return null;
    }
    $dateien = db_alle('SELECT d.id, d.pfad, d.mtime, d.laenge_ms, d.bittiefe, d.abtastrate, t.titel, m.pos AS disc, t.pos
        FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
        WHERE m.edition_id = :e ORDER BY m.pos, t.pos, d.id', ['e' => $editionId]);
    if (!$dateien) {
        return erk_merken($editionId, 'nichts', 0, null, t('Keine Dateien'));
    }
    // eine Datei je Titel (bei mehreren Fassungen die beste)
    $jeTitel = [];
    foreach ($dateien as $d) {
        $s = $d['disc'] . '-' . $d['pos'] . '-' . $d['titel'];
        if (!isset($jeTitel[$s]) || (int) $d['bittiefe'] > (int) $jeTitel[$s]['bittiefe']) {
            $jeTitel[$s] = $d;
        }
    }
    $dateien = array_values($jeTitel);
    $ids = array_map(static fn($d) => (int) $d['id'], $dateien);
    $fp = [];
    foreach (db_alle('SELECT * FROM fingerabdruecke WHERE datei_id IN (' . implode(',', $ids) . ')') as $z) {
        $fp[(int) $z['datei_id']] = $z;
    }
    // 1. Fingerabdrücke
    $fehlend = array_values(array_filter($dateien, static fn($d) => !isset($fp[(int) $d['id']]) || (int) $fp[(int) $d['id']]['datei_mtime'] !== (int) $d['mtime']));
    if ($fehlend) {
        erk_fingerabdruecke($fehlend);
        return time() < $bis ? erk_edition_klang($editionId, $bis) : null;
    }
    // 2. AcoustID
    foreach ($dateien as $d) {
        $z = $fp[(int) $d['id']];
        if ($z['abgefragt_am'] !== null || $z['fp'] === null) {
            continue;
        }
        if (time() >= $bis) {
            return null;
        }
        try {
            $r = erk_acoustid((string) $z['fp'], (int) round((int) $d['laenge_ms'] / 1000));
            db_tun('UPDATE fingerabdruecke SET aufnahmen = :a, abgefragt_am = NOW(), fehler = \'\' WHERE datei_id = :d',
                ['a' => json_encode($r, JSON_UNESCAPED_UNICODE), 'd' => $d['id']]);
            $fp[(int) $d['id']]['aufnahmen'] = json_encode($r);
        } catch (ErkFehler $e) {
            if ($e->getCode() === 401) {
                throw $e; // Schlüssel ungültig: ganzen Lauf beenden
            }
            db_tun('UPDATE fingerabdruecke SET fehler = :f WHERE datei_id = :d', ['f' => mb_substr($e->getMessage(), 0, 300), 'd' => $d['id']]);
            return erk_merken($editionId, 'fehler', 0, null, $e->getMessage());
        }
    }
    // 3. Kandidaten sammeln
    $wir = [];
    $relZahl = [];
    $relInfo = [];
    $erkannt = 0;
    $hires = false;
    foreach ($dateien as $d) {
        $a = json_decode((string) ($fp[(int) $d['id']]['aufnahmen'] ?? ''), true) ?: ['aufnahmen' => [], 'releases' => []];
        $recs = [];
        $rels = [];
        foreach ($a['aufnahmen'] as $rec) {
            $recs[$rec['id']] = $rec['s'];
            foreach ($rec['r'] as $rid) {
                $rels[$rid] = true;
            }
        }
        foreach ($a['releases'] as $rid => $info) {
            $relInfo[$rid] = $info;
        }
        if ($recs) {
            $erkannt++;
        }
        foreach (array_keys($rels) as $rid) {
            $relZahl[$rid] = ($relZahl[$rid] ?? 0) + 1;
        }
        $hires = $hires || (int) $d['bittiefe'] > 16 || (int) $d['abtastrate'] > 48000;
        $wir[] = ['recs' => $recs, 'titel' => (string) $d['titel'], 'ms' => (int) $d['laenge_ms']];
    }
    $n = count($wir);
    $tagMbid = ist_uuid($ed['mbid'] ?? '') ? strtolower((string) $ed['mbid']) : null;
    if ($erkannt === 0 && !$tagMbid) {
        return erk_merken($editionId, 'nichts', 0, null, t('Keiner der {n} Titel ist bei AcoustID bekannt.', ['n' => $n]));
    }
    $mindest = max(1, (int) ceil($erkannt * 0.6));
    $kand = array_keys(array_filter($relZahl, static fn($z) => $z >= $mindest));
    // Vorsortieren: mehr unserer Titel enthalten, passende Titelanzahl, dann Regeln
    usort($kand, static function ($a, $b) use ($relZahl, $relInfo, $n, $hires) {
        $ta = ($relInfo[$a]['tracks'] ?? null) === $n ? 0 : 1;
        $tb = ($relInfo[$b]['tracks'] ?? null) === $n ? 0 : 1;
        return [-$relZahl[$a], $ta, erk_regel_rang($relInfo[$a] ?? [], $hires)] <=> [-$relZahl[$b], $tb, erk_regel_rang($relInfo[$b] ?? [], $hires)];
    });
    $kand = array_slice($kand, 0, 6);
    if ($tagMbid && !in_array($tagMbid, $kand, true)) {
        array_unshift($kand, $tagMbid);
    }
    // 4. Kandidaten bei MusicBrainz laden und vergleichen
    $bewertet = [];
    foreach ($kand as $rid) {
        if (time() >= $bis && $bewertet) {
            break; // genug für eine Entscheidung? sonst beim nächsten Lauf weiter – die Antworten sind zwischengespeichert
        }
        try {
            $rel = mb_edition_laden($rid);
        } catch (MbFehler $e) {
            continue;
        }
        $v = erk_vergleichen($wir, $rel);
        $med = $rel['media'] ?? [];
        $bewertet[] = $v + ['mbid' => $rid, 'titel' => (string) ($rel['title'] ?? ''), 'kuenstler' => mb_credit_text($rel['artist-credit'] ?? []),
            'datum' => (string) ($rel['date'] ?? ''), 'land' => (string) ($rel['country'] ?? ''), 'status' => (string) ($rel['status'] ?? ''),
            'format' => (string) ($med[0]['format'] ?? ''), 'medien' => count($med), 'barcode' => (string) ($rel['barcode'] ?? ''),
            'zusatz' => (string) ($rel['disambiguation'] ?? ''), 'tags' => $rid === $tagMbid];
    }
    if (!$bewertet) {
        return erk_merken($editionId, 'nichts', 0, null, t('{erkannt} von {n} Titeln erkannt, aber kein passendes Release bei MusicBrainz.', ['erkannt' => $erkannt, 'n' => $n]));
    }
    $erkText = t('{erkannt} von {n} Titeln am Klang erkannt', ['erkannt' => $erkannt, 'n' => $n]);
    return erk_abschluss($editionId, $ed, $bewertet, $hires, $erkText, 'klang');
}

/**
 * Aus den bewerteten Editionen entscheiden und ergebnisgemäß übernehmen oder zur Bestätigung vorlegen
 * (gemeinsam für die Zuordnung über Tags und über den Klang). $weg: 'tags' oder 'klang'.
 */
function erk_abschluss(int $editionId, array $ed, array $bewertet, bool $hires, string $erkText, string $weg): array
{
    usort($bewertet, static fn($a, $b) => [$b['sicherheit'], $a['abw'] ?? 99] <=> [$a['sicherheit'], $b['abw'] ?? 99]);
    $schwelle = erk_konfig()['schwelle'];
    $passend = array_values(array_filter($bewertet, static fn($k) => $k['sicherheit'] >= $schwelle));
    $kandText = array_map(static fn($k) => array_diff_key($k, ['reihenfolge' => 1]), $bewertet);
    if (!$passend) {
        $b = $bewertet[0];
        return erk_merken($editionId, $b['sicherheit'] >= 50 ? 'unsicher' : 'nichts', $b['sicherheit'], $b['sicherheit'] >= 50 ? $b['mbid'] : null,
            t('{text}; beste Edition passt zu {n} %.', ['text' => $erkText, 'n' => $b['sicherheit']]), $kandText, $weg);
    }
    // 5. Entscheiden
    $wahl = $passend[0];
    $status = 'eindeutig';
    $grund = '';
    $gleich = array_values(array_filter($passend, static fn($k) => $k['sicherheit'] >= $wahl['sicherheit'] - 2));
    if (count($gleich) > 1) {
        $barcode = preg_replace('/\D/', '', (string) $ed['barcode']);
        $mitTags = array_values(array_filter($gleich, static fn($k) => $k['tags']));
        $mitBarcode = $barcode !== '' ? array_values(array_filter($gleich, static fn($k) => preg_replace('/\D/', '', $k['barcode']) === $barcode)) : [];
        $abw = array_filter(array_map(static fn($k) => $k['abw'], $gleich), static fn($x) => $x !== null);
        sort($abw);
        if (count($mitTags) === 1) {
            $wahl = $mitTags[0];
            $grund = t('MusicBrainz-ID aus den Tags');
        } elseif (count($mitBarcode) === 1) {
            $wahl = $mitBarcode[0];
            $grund = t('Barcode aus den Tags');
        } elseif (count($abw) > 1 && $abw[1] - $abw[0] >= 0.5) {
            foreach ($gleich as $k) {
                if ($k['abw'] === $abw[0]) {
                    $wahl = $k;
                }
            }
            $grund = t('Laufzeiten passen am besten');
        } else {
            usort($gleich, static fn($a, $b) => erk_regel_rang($a, $hires) <=> erk_regel_rang($b, $hires));
            $wahl = $gleich[0];
            $status = 'regeln';
            $grund = t('{n} Editionen mit gleicher Titelliste – gewählt: {wahl}', ['n' => count($gleich), 'wahl' => erk_regel_text($wahl, $hires)]);
        }
    }
    $info = $erkText . ($grund !== '' ? '; ' . $grund : '') . '.';
    $auto = erk_konfig()['auto'];
    if ($auto === 'aus' || ($status === 'regeln' && $auto !== 'regeln')) {
        return erk_merken($editionId, $status, $wahl['sicherheit'], $wahl['mbid'], $info, $kandText, $weg);
    }
    // 6. Übernehmen (wie „Diese Edition übernehmen“ im Abgleich; vorhandenes Cover bleibt)
    try {
        mb_edition_uebernehmen($editionId, $wahl['mbid'], 'fehlend');
    } catch (MbFehler $e) {
        // Meldung aus musicbrainz.php: „… schon mit einer anderen Edition verknüpft (Ordner …“ – deutsch oder übersetzt
        $vorn = strstr(t('Diese MusicBrainz-Edition ist schon mit einer anderen Edition verknüpft (Ordner „{ordner}“, {n} Dateien). Liegt das Album doppelt vor?'), ' (', true);
        $doppelt = str_contains($e->getMessage(), 'anderen Edition') || ($vorn !== false && str_starts_with($e->getMessage(), $vorn));
        return erk_merken($editionId, $doppelt ? 'doppelt' : 'fehler', $wahl['sicherheit'], $wahl['mbid'], $e->getMessage(), $kandText, $weg);
    }
    return erk_merken($editionId, 'uebernommen', $wahl['sicherheit'], $wahl['mbid'],
        $info . ($status === 'regeln' ? ' Automatisch übernommen – bitte bei Gelegenheit prüfen.' : ''), $kandText, $weg) + ['regeln' => $status === 'regeln'];
}

/**
 * Wie viel weiß Amberwave schon über das Album, ohne den Klang zu fragen?
 *   'mbid'  – eine MusicBrainz-Release-ID steht in den Tags (z. B. von Picard): eindeutig
 *   'text'  – Albuminterpret und Albumtitel sind bekannt (aus den Tags oder dem Ordnernamen)
 *   'keiner' – weder Interpret noch Titel: nur der Klang kann helfen
 */
function erk_anhalt(array $ed, array $album): array
{
    $kuenstler = trim((string) ($album['kuenstler'] ?? ''));
    $titel = trim((string) ($album['titel'] ?? ''));
    $unbekannt = $kuenstler === '' || $kuenstler === '[unbekannt]';
    $ohneTitel = $titel === '' || $titel === 'Ohne Album';
    if (ist_uuid($ed['mbid'] ?? '')) {
        return ['art' => 'mbid', 'titel' => $titel, 'kuenstler' => $kuenstler];
    }
    if ($unbekannt || $ohneTitel) {
        return ['art' => 'keiner', 'titel' => $titel, 'kuenstler' => $kuenstler];
    }
    return ['art' => 'text', 'titel' => $titel, 'kuenstler' => $kuenstler];
}

/** Unsere Titel je Datei (eine Datei je Titel) für den Vergleich mit einem Release, ohne Fingerabdruck */
function erk_wir_aus_tags(int $editionId): array
{
    $dateien = db_alle('SELECT d.laenge_ms, d.bittiefe, d.abtastrate, t.titel, m.pos AS disc, t.pos
        FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
        WHERE m.edition_id = :e ORDER BY m.pos, t.pos, d.id', ['e' => $editionId]);
    $jeTitel = [];
    foreach ($dateien as $d) {
        $k = $d['disc'] . '-' . $d['pos'] . '-' . $d['titel'];
        if (!isset($jeTitel[$k]) || (int) $d['bittiefe'] > (int) $jeTitel[$k]['bittiefe']) {
            $jeTitel[$k] = $d;
        }
    }
    $wir = [];
    $hires = false;
    foreach ($jeTitel as $d) {
        $hires = $hires || (int) $d['bittiefe'] > 16 || (int) $d['abtastrate'] > 48000;
        $wir[] = ['recs' => [], 'titel' => (string) $d['titel'], 'ms' => (int) $d['laenge_ms']];
    }
    return [$wir, $hires];
}

/**
 * Eine Edition über ihre Tags zuordnen: MusicBrainz-ID aus den Tags, sonst eine einzige Suche nach Interpret und Titel.
 * Die Kandidaten werden Titel für Titel verglichen (Namen, Reihenfolge, Anzahl, Laufzeiten) – ohne AcoustID und ohne
 * Fingerabdruck. Eindeutiges wird wie beim Klang behandelt (ERKENNUNG_AUTO), Unsicheres kommt zur Bestätigung.
 */
function erk_edition_tags(int $editionId, array $ed, array $album, array $anhalt): array
{
    [$wir, $hires] = erk_wir_aus_tags($editionId);
    if (!$wir) {
        return erk_merken($editionId, 'nichts', 0, null, t('Keine Dateien'), [], 'tags');
    }
    $tagMbid = $anhalt['art'] === 'mbid' ? strtolower((string) $ed['mbid']) : null;
    // Releases laden und mit unseren Titeln vergleichen; eine unbekannte ID (404) wird übersprungen
    $laden = static function (array $ids) use ($wir, $tagMbid): array {
        $aus = [];
        foreach (array_values(array_unique($ids)) as $rid) {
            try {
                $rel = mb_edition_laden($rid);
            } catch (MbFehler $e) {
                if (str_contains($e->getMessage(), 'nicht gefunden') || $e->getMessage() === t('Bei MusicBrainz nicht gefunden.')) {
                    continue;
                }
                throw $e;
            }
            $v = erk_vergleichen($wir, $rel);
            $med = $rel['media'] ?? [];
            $aus[] = $v + ['mbid' => $rid, 'titel' => (string) ($rel['title'] ?? ''), 'kuenstler' => mb_credit_text($rel['artist-credit'] ?? []),
                'datum' => (string) ($rel['date'] ?? ''), 'land' => (string) ($rel['country'] ?? ''), 'status' => (string) ($rel['status'] ?? ''),
                'format' => (string) ($med[0]['format'] ?? ''), 'medien' => count($med), 'barcode' => (string) ($rel['barcode'] ?? ''),
                'zusatz' => (string) ($rel['disambiguation'] ?? ''), 'tags' => $rid === $tagMbid];
        }
        return $aus;
    };
    try {
        $bewertet = $tagMbid ? $laden([$tagMbid]) : [];
        // Ohne (gültige) ID aus den Tags: eine Suche nach Interpret und Titel, nur Alben mit demselben Titel
        if (!$bewertet && trim($anhalt['titel']) !== '' && !in_array($anhalt['kuenstler'], ['', '[unbekannt]'], true)) {
            // Titel wie im Tag und sein Kern ohne Editionszusatz („Rumours (Deluxe Edition)“ → „Rumours“): MusicBrainz führt
            // den Zusatz meist als Begriffsklärung neben dem schlichten Titel
            [$kern, $zusatz] = mb_titel_zerlegen($anhalt['titel']);
            $teile = [];
            foreach (array_unique([$anhalt['titel'], $kern]) as $ph) {
                $teile[] = 'release:"' . mb_lucene($ph) . '"';
                $teile[] = 'releasegroup:"' . mb_lucene($ph) . '"';
            }
            $artistQ = $anhalt['kuenstler'] !== 'Various Artists' ? ' AND artist:"' . mb_lucene(mb_kuenstler_kern($anhalt['kuenstler'])) . '"' : '';
            $d = mb_abfrage('release', ['query' => '(' . implode(' OR ', $teile) . ')' . $artistQ, 'limit' => 50], 86400);
            if (empty($d['releases']) && ($w = mb_lucene_woerter($kern)) !== '') {
                // unscharf: einzelne Wörter (andere Satzzeichen, „&“/„and“ …)
                $kw = $anhalt['kuenstler'] !== 'Various Artists' ? mb_lucene_woerter(mb_kuenstler_kern($anhalt['kuenstler'])) : '';
                $d = mb_abfrage('release', ['query' => '(release:(' . $w . ') OR releasegroup:(' . $w . '))' . ($kw !== '' ? ' AND artist:(' . $kw . ')' : ''), 'limit' => 50], 86400);
            }
            $titelN = name_norm($anhalt['titel']);
            $kernN = name_norm($kern);
            $zusatzW = array_values(array_filter(explode(' ', name_norm($zusatz)), static fn($x) => $x !== '' && !in_array($x, ['edition', 'version', 'the', 'ed'], true)));
            $treffer = [];
            foreach ($d['releases'] ?? [] as $r) {
                $rt = (string) ($r['title'] ?? '');
                $rgt = (string) ($r['release-group']['title'] ?? '');
                if (name_norm($rt) !== $titelN && name_norm(mb_titel_zerlegen($rt)[0]) !== $kernN && name_norm(mb_titel_zerlegen($rgt)[0]) !== $kernN) {
                    continue;
                }
                $k = mb_edition_kurz($r);
                // Editionszusatz aus dem Tag in Titel oder Begriffsklärung der Edition? („deluxe“, „2011“, „remaster“)
                $text = ' ' . name_norm($rt . ' ' . ($r['disambiguation'] ?? '')) . ' ';
                $zusatzTreffer = $zusatzW ? count(array_filter($zusatzW, static fn($x) => str_contains($text, ' ' . $x . ' '))) : 0;
                $treffer[] = [$k['tracks'] === count($wir) ? 0 : 1, -$zusatzTreffer, $k['status'] === 'Official' ? 0 : 1, -$k['score'], strtolower($k['mbid'])];
            }
            sort($treffer);
            $bewertet = $laden(array_map(static fn($t) => $t[4], array_slice($treffer, 0, 4)));
        }
    } catch (MbFehler $e) {
        return erk_merken($editionId, 'fehler', 0, null, $e->getMessage(), [], 'tags');
    }
    if (!$bewertet) {
        return erk_merken($editionId, 'nichts', 0, null, t('Nach den Tags ({kuenstler} – {titel}) kein passendes Album bei MusicBrainz gefunden.', ['kuenstler' => $anhalt['kuenstler'], 'titel' => $anhalt['titel']]), [], 'tags');
    }
    return erk_abschluss($editionId, $ed, $bewertet, $hires, t('Nach den Tags zugeordnet'), 'tags');
}

/** Welche Erkennung gilt: 'anhalt' (Standard: Klang nur ohne Anhaltspunkt) oder 'gruendlich' (Klang auch, wenn die Tags nicht reichen) */
function erk_modus(): string
{
    return einstellung('erkennung_modus') === 'gruendlich' ? 'gruendlich' : 'anhalt';
}

/**
 * Eine Edition bearbeiten. Reihenfolge: Tags zuerst; AcoustID nur, wenn es keinen Anhaltspunkt gibt, im Modus „gründlich“
 * auch wenn die Tags nicht gereicht haben, sonst auf Wunsch (Knopf → weg = 'klang_offen').
 */
function erk_bearbeiten(int $editionId, int $bis): ?array
{
    $ed = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $editionId]);
    if (!$ed || $ed['quelle'] !== 'tags') {
        return null;
    }
    $k = db_zeile('SELECT status, weg FROM erkennung WHERE edition_id = :e', ['e' => $editionId]);
    $weg = $k['weg'] ?? '';
    if ($weg === 'klang_offen' || ($weg === 'klang' && $k && $k['status'] === 'fehler')) {
        return erk_klang_oder_hinweis($editionId, $bis);
    }
    $album = db_zeile("SELECT a.titel, COALESCE(c.anzeige, '') AS kuenstler FROM alben a LEFT JOIN credits c ON c.id = a.credit_id WHERE a.id = :a", ['a' => $ed['album_id']]) ?: [];
    $anhalt = erk_anhalt($ed, $album);
    if ($k && $weg === 'tags' && in_array($k['status'], ['unsicher', 'nichts'], true) && erk_modus() === 'gruendlich') {
        return erk_klang_oder_hinweis($editionId, $bis); // gründlich: reichen die Tags nicht, fragt der Klang nach
    }
    if ($anhalt['art'] === 'keiner') {
        return erk_klang_oder_hinweis($editionId, $bis);
    }
    return erk_edition_tags($editionId, $ed, $album, $anhalt);
}

/** Klang-Erkennung, sofern Schlüssel und Werkzeug da sind – sonst bleibt ein Hinweis stehen (kein Dauerlauf) */
function erk_klang_oder_hinweis(int $editionId, int $bis): ?array
{
    if (erk_schluessel() === '') {
        return erk_merken($editionId, 'nichts', 0, null, t('Keine Anhaltspunkte in den Tags. Für die Erkennung am Klang fehlt der AcoustID-Schlüssel (Einstellungen › Dienste).'), [], 'tags');
    }
    if (!erk_werkzeug()) {
        return erk_merken($editionId, 'nichts', 0, null, t('Keine Anhaltspunkte in den Tags. Für die Erkennung am Klang fehlt im Container ein Fingerabdruck-Werkzeug (ffmpeg mit Chromaprint oder fpcalc).'), [], 'tags');
    }
    return erk_edition_klang($editionId, $bis);
}

/** Auf Wunsch am Klang erkennen (Knopf): vormerken, der Hintergrundlauf holt es ab. Gibt die Zahl der vorgemerkten Alben zurück. */
function erk_klang_anfordern(array $editionIds): int
{
    $n = 0;
    foreach (array_map('intval', $editionIds) as $id) {
        $n += db_tun("UPDATE erkennung SET weg = 'klang_offen' WHERE edition_id = :e AND status NOT IN ('uebernommen', 'bestaetigt', 'ignoriert')", ['e' => $id]);
    }
    return $n;
}

/** Alle, bei denen die Tags nicht gereicht haben (unsicher / nicht gefunden), auf Wunsch am Klang erkennen */
function erk_klang_alle_anfordern(): int
{
    return db_tun("UPDATE erkennung SET weg = 'klang_offen' WHERE weg = 'tags' AND status IN ('unsicher', 'nichts')");
}

/**
 * Hintergrund-Lauf: offene Editionen nacheinander erkennen, höchstens $sekunden lang.
 */
function erk_stapel(int $sekunden = 280): int
{
    if (!erk_aktiv()) {
        return 0;
    }
    $h = fopen(konfig()['pfade']['cache'] . ERK_SPERRE, 'c');
    if (!$h || !flock($h, LOCK_EX | LOCK_NB)) {
        return 0;
    }
    $bis = time() + $sekunden;
    $fertig = 0;
    // „Gründlich“ legt den Klang nur nach, wenn auch ein Schlüssel da ist (sonst gäbe es eine Endlosschleife)
    $nachlegen = erk_modus() === 'gruendlich' && erk_bereit() && erk_werkzeug() ? 1 : 0;
    try {
        while (time() < $bis) {
            $offen = db_alle("SELECT e.id FROM editionen e LEFT JOIN erkennung k ON k.edition_id = e.id
                WHERE e.quelle = 'tags' AND e.anzahl_dateien > 0
                  AND (k.edition_id IS NULL OR k.weg = 'klang_offen'
                       OR (k.status = 'fehler' AND k.geprueft_am < NOW() - INTERVAL 1 DAY)
                       OR (:n = 1 AND k.weg = 'tags' AND k.status IN ('unsicher', 'nichts')))
                ORDER BY e.id LIMIT 20", ['n' => $nachlegen]);
            if (!$offen) {
                break;
            }
            foreach ($offen as $o) {
                if (time() >= $bis) {
                    break 2;
                }
                $r = erk_bearbeiten((int) $o['id'], $bis);
                if ($r === null) {
                    break 2; // Zeit um – beim nächsten Lauf geht es mit dieser Edition weiter
                }
                $fertig++;
            }
        }
        einstellung_setzen('erkennung_fehler', '');
    } catch (ErkFehler $e) {
        einstellung_setzen('erkennung_fehler', $e->getMessage());
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
    return $fertig;
}

// ---------- Für die Verwaltung ----------

function erk_stand(): array
{
    $k = erk_konfig();
    $z = db_zeile("SELECT
        (SELECT COUNT(*) FROM dateien WHERE track_id IS NOT NULL) AS dateien,
        (SELECT COUNT(*) FROM fingerabdruecke WHERE fp IS NOT NULL) AS fingerabdruecke,
        (SELECT COUNT(*) FROM fingerabdruecke WHERE abgefragt_am IS NOT NULL) AS abgefragt,
        (SELECT COUNT(*) FROM fingerabdruecke WHERE abgefragt_am IS NOT NULL AND aufnahmen LIKE '%\"s\"%') AS erkannt,
        (SELECT COUNT(*) FROM editionen e WHERE e.anzahl_dateien > 0 AND (e.quelle <> 'tags' OR EXISTS (SELECT 1 FROM erkennung k WHERE k.edition_id = e.id))) AS alben_fertig,
        (SELECT COUNT(*) FROM editionen WHERE anzahl_dateien > 0) AS editionen,
        (SELECT COUNT(*) FROM editionen WHERE quelle <> 'tags' AND anzahl_dateien > 0) AS abgeglichen,
        (SELECT COUNT(*) FROM editionen e LEFT JOIN erkennung k ON k.edition_id = e.id WHERE e.quelle = 'tags' AND e.anzahl_dateien > 0 AND k.edition_id IS NULL) AS offen");
    $wege = db_zeile("SELECT
        SUM(weg = 'tags' AND status IN ('uebernommen', 'bestaetigt')) AS ueber_tags,
        SUM(weg = 'klang' AND status IN ('uebernommen', 'bestaetigt')) AS ueber_klang,
        SUM(weg = 'tags' AND status IN ('unsicher', 'nichts')) AS wartet,
        SUM(weg = 'klang_offen') AS klang_offen FROM erkennung");
    $status = [];
    foreach (db_alle('SELECT status, COUNT(*) AS n FROM erkennung GROUP BY status') as $s) {
        $status[$s['status']] = (int) $s['n'];
    }
    $liste = db_alle("SELECT k.*, e.album_id, e.ordner, a.titel AS album_titel, COALESCE(c.anzeige, '') AS kuenstler
        FROM erkennung k JOIN editionen e ON e.id = k.edition_id JOIN alben a ON a.id = e.album_id LEFT JOIN credits c ON c.id = a.credit_id
        WHERE k.status IN ('unsicher', 'regeln', 'eindeutig', 'doppelt', 'fehler') OR (k.status = 'nichts' AND k.weg <> 'klang') OR (k.status = 'uebernommen' AND k.info LIKE '%prüfen%')
        ORDER BY FIELD(k.status, 'regeln', 'eindeutig', 'unsicher', 'uebernommen', 'doppelt', 'fehler', 'nichts'), k.sicherheit DESC, a.titel LIMIT 300");
    foreach ($liste as &$l) {
        $l['edition_id'] = (int) $l['edition_id'];
        $l['album_id'] = (int) $l['album_id'];
        $l['sicherheit'] = (int) $l['sicherheit'];
        $l['kandidaten'] = $l['kandidaten'] ? (json_decode($l['kandidaten'], true) ?: []) : [];
        $l['status_text'] = isset(ERK_STATUS_TEXT[$l['status']]) ? t(ERK_STATUS_TEXT[$l['status']]) : $l['status'];
        $l['pruefen'] = $l['status'] === 'uebernommen' && str_contains((string) $l['info'], 'prüfen'); // sprachunabhängige Kennzeichnung für die Oberfläche
        $l['klang_moeglich'] = $l['weg'] === 'tags' && in_array($l['status'], ['unsicher', 'nichts'], true);
    }
    unset($l);
    return [
        'aktiv' => $k['aktiv'], 'schluessel' => erk_schluessel() !== '', 'auto' => $k['auto'], 'schwelle' => $k['schwelle'], 'modus' => erk_modus(),
        'ueber_tags' => (int) $wege['ueber_tags'], 'ueber_klang' => (int) $wege['ueber_klang'], 'wartet' => (int) $wege['wartet'], 'klang_offen' => (int) $wege['klang_offen'],
        'werkzeug' => erk_werkzeug(), 'laeuft' => erk_laeuft(), 'fehler' => einstellung('erkennung_fehler'),
        'dateien' => (int) $z['dateien'], 'fingerabdruecke' => (int) $z['fingerabdruecke'], 'abgefragt' => (int) $z['abgefragt'], 'erkannt' => (int) $z['erkannt'],
        'editionen' => (int) $z['editionen'], 'abgeglichen' => (int) $z['abgeglichen'], 'offen' => (int) $z['offen'], 'alben_fertig' => (int) $z['alben_fertig'],
        'status' => $status, 'liste' => $liste,
    ];
}

/** Einträge zurücksetzen, damit sie neu geprüft werden: 'unsicher' (unsicher/nicht erkannt/Fehler) oder 'alle' (außer Übernommenem) */
function erk_neu(string $was): void
{
    if ($was === 'alle') {
        db_tun("DELETE FROM erkennung WHERE status NOT IN ('uebernommen', 'bestaetigt')");
        db_tun('UPDATE fingerabdruecke SET abgefragt_am = NULL, aufnahmen = NULL'); // AcoustID lernt dazu
    } else {
        db_tun("DELETE FROM erkennung WHERE status IN ('unsicher', 'nichts', 'fehler')");
        db_tun("UPDATE fingerabdruecke f JOIN dateien d ON d.id = f.datei_id JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
                LEFT JOIN erkennung k ON k.edition_id = m.edition_id SET f.abgefragt_am = NULL, f.aufnahmen = NULL WHERE k.edition_id IS NULL");
    }
    einstellung_setzen('erkennung_fehler', '');
}
