<?php
// Lautheit nach EBU R128 / ITU-R BS.1770-4 (gemessen mit ffmpeg „ebur128“).
//
// Pro Datei werden die Lautheitswerte aller 400-ms-Blöcke (M, alle 100 ms = 75 % Überlappung, wie die Norm) und aller
// 3-s-Blöcke (S) als Histogramm in 0,1-LU-Schritten gespeichert. Daraus lassen sich Titel UND Album exakt berechnen:
// Die Album-Lautheit ist nicht der Mittelwert der Titel, sondern das Gating über alle Blöcke aller Titel zusammen –
// genau so, als würde man das ganze Album am Stück messen.
//   Integrierte Lautheit: absolutes Gate −70 LUFS, relatives Gate −10 LU (BS.1770-4)
//   Lautheitsumfang LRA:  S-Blöcke, absolutes Gate −70, relatives Gate −20 LU, 95. minus 10. Perzentil (EBU Tech 3342)
// Dazu Sample-Peak und True-Peak (4-fach überabgetastet) in dBFS bzw. dBTP.
declare(strict_types=1);
require_once __DIR__ . '/i18n.php';

const LH_MIN = -70.0;    // untere Grenze (absolutes Gate)
const LH_MAX = 10.0;     // obere Grenze (lauter geht in der Praxis nicht)
const LH_SCHRITT = 0.1;  // LU je Fach
const LH_FAECHER = 801;  // (LH_MAX − LH_MIN) / LH_SCHRITT + 1

function lh_fach(float $l): ?int
{
    if ($l < LH_MIN) {
        return null; // unter dem absoluten Gate – zählt nirgends
    }
    return (int) min(LH_FAECHER - 1, round(($l - LH_MIN) / LH_SCHRITT));
}

function lh_wert(int $fach): float
{
    return LH_MIN + $fach * LH_SCHRITT;
}

function lh_packen(array $h): string
{
    return base64_encode(gzcompress(pack('V*', ...$h), 6));
}

function lh_entpacken(?string $s): ?array
{
    if (!$s) {
        return null;
    }
    $roh = @gzuncompress((string) base64_decode($s));
    if ($roh === false || strlen($roh) !== LH_FAECHER * 4) {
        return null;
    }
    return array_values(unpack('V*', $roh));
}

/** Integrierte Lautheit aus einem M-Histogramm (null = zu kurz/still) */
function lh_integriert(array $h): ?float
{
    $summe = 0.0;
    $n = 0;
    foreach ($h as $i => $c) {
        if ($c) {
            $summe += $c * 10 ** ((lh_wert($i) + 0.691) / 10);
            $n += $c;
        }
    }
    if ($n === 0) {
        return null;
    }
    $relativ = -0.691 + 10 * log10($summe / $n) - 10.0;
    $summe = 0.0;
    $n = 0;
    foreach ($h as $i => $c) {
        if ($c && lh_wert($i) > $relativ) {
            $summe += $c * 10 ** ((lh_wert($i) + 0.691) / 10);
            $n += $c;
        }
    }
    return $n ? round(-0.691 + 10 * log10($summe / $n), 2) : null;
}

/** Lautheitsumfang (LRA) aus einem S-Histogramm */
function lh_lra(array $h): ?float
{
    $summe = 0.0;
    $n = 0;
    foreach ($h as $i => $c) {
        if ($c) {
            $summe += $c * 10 ** (lh_wert($i) / 10);
            $n += $c;
        }
    }
    if ($n === 0) {
        return null;
    }
    $relativ = 10 * log10($summe / $n) - 20.0;
    $werte = [];
    $gesamt = 0;
    foreach ($h as $i => $c) {
        if ($c && lh_wert($i) > $relativ) {
            $werte[$i] = $c;
            $gesamt += $c;
        }
    }
    if ($gesamt === 0) {
        return 0.0;
    }
    $perzentil = static function (float $p) use ($werte, $gesamt): float {
        $ziel = $p * ($gesamt - 1);
        $lauf = 0;
        foreach ($werte as $i => $c) {
            if ($lauf + $c > $ziel) {
                return lh_wert($i);
            }
            $lauf += $c;
        }
        return lh_wert((int) array_key_last($werte));
    };
    return round(max(0.0, $perzentil(0.95) - $perzentil(0.10)), 2);
}

const LH_KURVE_SCHRITT = 0.2; // s je Punkt der Lautheitskurve

/**
 * ffmpeg-Ausgabe (stderr von ebur128 mit framelog=info) auswerten.
 * Gibt die Histogramme (m, s), True-/Sample-Peak und die Lautheitskurve zurück
 * (kurve: je 0,2 s Momentary, Short-term und True-Peak des Abschnitts, in dB).
 */
function lh_auswerten(string $ausgabe): array
{
    $m = array_fill(0, LH_FAECHER, 0);
    $s = array_fill(0, LH_FAECHER, 0);
    $zeilen = 0;
    $km = [];
    $ks = [];
    $kp = [];
    $re = '/\bt:\s*([\d.]+)\s+TARGET:\S+\s+LUFS\s+M:\s*(-?[\d.]+|-inf|nan)\s+S:\s*(-?[\d.]+|-inf|nan)(?:.*?FTPK:((?:\s+(?:-?[\d.]+|-inf|nan))+)\s+dBFS)?/';
    if (preg_match_all($re, $ausgabe, $treffer, PREG_SET_ORDER)) {
        foreach ($treffer as $t) {
            $zeit = (float) $t[1];
            $zeilen++;
            $mw = is_numeric($t[2]) ? (float) $t[2] : -120.0;
            $sw = is_numeric($t[3]) ? (float) $t[3] : -120.0;
            // Erst ab einem vollen Block: M ab 0,4 s, S ab 3 s (davor rechnet ffmpeg mit einem unvollständigen Fenster)
            if ($zeit >= 0.3999 && ($f = lh_fach($mw)) !== null) {
                $m[$f]++;
            }
            if ($zeit >= 2.9999 && ($f = lh_fach($sw)) !== null) {
                $s[$f]++;
            }
            // Kurve: ein Punkt je 0,2 s (Abschnitt endet bei t)
            $k = max(0, (int) ceil($zeit / LH_KURVE_SCHRITT - 1e-6) - 1);
            $km[$k] = $zeit >= 0.3999 ? $mw : -120.0;
            $ks[$k] = $zeit >= 2.9999 ? $sw : -120.0;
            $spitze = -120.0;
            foreach (preg_split('/\s+/', trim($t[4] ?? '')) as $x) {
                if (is_numeric($x)) {
                    $spitze = max($spitze, (float) $x);
                }
            }
            $kp[$k] = max($kp[$k] ?? -120.0, $spitze);
        }
    }
    $peak = static function (string $art) use ($ausgabe): ?float {
        if (preg_match('/' . $art . ' peak:\s*Peak:\s*(-?[\d.]+|-inf)/', $ausgabe, $p)) {
            return is_numeric($p[1]) ? (float) $p[1] : -120.0;
        }
        return null;
    };
    $n = $km ? max(array_keys($km)) + 1 : 0;
    $reihe = static function (array $x) use ($n): array {
        $aus = [];
        $letzter = -120.0;
        for ($i = 0; $i < $n; $i++) {
            $letzter = $x[$i] ?? $letzter;
            $aus[] = $letzter;
        }
        return $aus;
    };
    return ['m' => $m, 's' => $s, 'true_peak' => $peak('True'), 'sample_peak' => $peak('Sample'), 'zeilen' => $zeilen,
        'kurve' => ['m' => $reihe($km), 's' => $reihe($ks), 'p' => $reihe($kp)]];
}

/** Kurve platzsparend: je Wert int16 (dB × 10), drei Reihen hintereinander, komprimiert */
function lh_kurve_packen(array $k): string
{
    $n = count($k['m']);
    $werte = [];
    foreach (['m', 's', 'p'] as $r) {
        foreach ($k[$r] as $v) {
            $werte[] = ((int) round(max(-120.0, min(20.0, (float) $v)) * 10)) & 0xFFFF;
        }
    }
    return base64_encode(gzcompress(pack('V', $n) . ($werte ? pack('v*', ...$werte) : ''), 6));
}

function lh_kurve_entpacken(?string $s): ?array
{
    if (!$s) {
        return null;
    }
    $roh = @gzuncompress((string) base64_decode($s));
    if ($roh === false || strlen($roh) < 4) {
        return null;
    }
    $n = unpack('V', substr($roh, 0, 4))[1];
    if (strlen($roh) !== 4 + $n * 6) {
        return null;
    }
    $w = $n ? array_values(unpack('v*', substr($roh, 4))) : [];
    $aus = ['schritt' => LH_KURVE_SCHRITT];
    foreach (['m', 's', 'p'] as $r => $name) {
        $aus[$name] = array_map(static fn($x) => round(($x >= 0x8000 ? $x - 0x10000 : $x) / 10, 1), array_slice($w, $r * $n, $n));
    }
    return $aus;
}

function lh_befehl(string $pfad): string
{
    $ffmpeg = escapeshellarg(konfig()['stream']['ffmpeg']);
    $nice = is_executable('/usr/bin/nice') ? '/usr/bin/nice -n 15 ' : '';
    return $nice . $ffmpeg . ' -nostdin -hide_banner -nostats -threads 1 -i ' . escapeshellarg($pfad)
        . ' -map 0:a:0 -vn -sn -dn -af ebur128=framelog=info:peak=true+sample -f null - 2>&1';
}

/** Eine Datei messen (blockierend) – für Tests und Einzelaufrufe */
function lh_datei_messen(string $pfad): array
{
    $aus = shell_exec(lh_befehl($pfad));
    return lh_auswerten((string) $aus);
}

/** Ergebnis einer Datei speichern */
function lh_speichern(int $dateiId, array $e, string $fehler = ''): void
{
    if ($fehler !== '' || $e['zeilen'] === 0) {
        db_tun('UPDATE dateien SET lautheit_am = NOW(), lautheit_fehler = :f WHERE id = :id',
            ['id' => $dateiId, 'f' => mb_substr($fehler !== '' ? $fehler : t('ffmpeg lieferte keine Messwerte'), 0, 300)]);
        return;
    }
    db_tun('UPDATE dateien SET lufs = :l, lra = :r, true_peak = :tp, sample_peak = :sp, lautheit_m = :hm, lautheit_s = :hs, lautheit_kurve = :k,
            lautheit_am = NOW(), lautheit_fehler = \'\' WHERE id = :id', [
        'id' => $dateiId, 'l' => lh_integriert($e['m']), 'r' => lh_lra($e['s']),
        'tp' => $e['true_peak'], 'sp' => $e['sample_peak'], 'hm' => lh_packen($e['m']), 'hs' => lh_packen($e['s']),
        'k' => isset($e['kurve']) ? lh_kurve_packen($e['kurve']) : null,
    ]);
}

/** Album-Werte einer Edition neu berechnen, sobald alle (abspielbaren) Titel gemessen sind */
function lh_album_berechnen(int $editionId): bool
{
    // je Titel dieselbe Datei, die auch gestreamt wird (höchste Auflösung)
    $zeilen = db_alle('SELECT d.id, d.lautheit_am, d.lautheit_m, d.lautheit_s, d.true_peak, d.sample_peak, d.lautheit_fehler
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id
        JOIN dateien d ON d.id = (SELECT d2.id FROM dateien d2 WHERE d2.track_id = t.id ORDER BY d2.bittiefe DESC, d2.abtastrate DESC, d2.id LIMIT 1)
        WHERE m.edition_id = :e', ['e' => $editionId]);
    if (!$zeilen) {
        return false;
    }
    $m = array_fill(0, LH_FAECHER, 0);
    $s = array_fill(0, LH_FAECHER, 0);
    $tp = null;
    $sp = null;
    foreach ($zeilen as $z) {
        if ($z['lautheit_am'] === null) {
            return false; // noch nicht alles gemessen
        }
        $hm = lh_entpacken($z['lautheit_m']);
        $hs = lh_entpacken($z['lautheit_s']);
        if ($hm) {
            foreach ($hm as $i => $c) { $m[$i] += $c; }
        }
        if ($hs) {
            foreach ($hs as $i => $c) { $s[$i] += $c; }
        }
        if ($z['true_peak'] !== null) { $tp = $tp === null ? (float) $z['true_peak'] : max($tp, (float) $z['true_peak']); }
        if ($z['sample_peak'] !== null) { $sp = $sp === null ? (float) $z['sample_peak'] : max($sp, (float) $z['sample_peak']); }
    }
    db_tun('UPDATE editionen SET album_lufs = :l, album_lra = :r, album_true_peak = :tp, album_sample_peak = :sp, album_lautheit_am = NOW() WHERE id = :e',
        ['e' => $editionId, 'l' => lh_integriert($m), 'r' => lh_lra($s), 'tp' => $tp, 'sp' => $sp]);
    return true;
}

/**
 * Hintergrund-Job: misst ungemessene Dateien, mehrere parallel, höchstens $sekunden lang (für den Minuten-Zeitplan).
 * Gibt die Zahl der gemessenen Dateien zurück.
 */
function lh_stapel(int $sekunden = 50): int
{
    $k = konfig()['lautheit'];
    if (!$k['aktiv']) {
        return 0;
    }
    $sperre = fopen(konfig()['pfade']['cache'] . '/tmp/lautheit.lock', 'c');
    if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
        return 0; // läuft schon
    }
    $wurzel = konfig()['pfade']['musik'];
    $ende = time() + $sekunden;
    $parallel = max(1, min(16, (int) $k['parallel']));
    $laufend = [];   // [proc, pipe, datei, edition, puffer]
    $fertig = 0;
    $editionen = [];
    $offen = static fn() => db_alle('SELECT d.id, d.pfad, m.edition_id FROM dateien d
        JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
        WHERE d.lautheit_am IS NULL ORDER BY m.edition_id, d.id LIMIT 200');
    $warteschlange = $offen();
    $vergeben = [];
    while (($warteschlange || $laufend)) {
        // neue starten
        while (count($laufend) < $parallel && $warteschlange && time() < $ende) {
            $d = array_shift($warteschlange);
            if (isset($vergeben[$d['id']])) {
                continue;
            }
            $vergeben[$d['id']] = true;
            $pfad = $wurzel . '/' . $d['pfad'];
            if (!is_readable($pfad)) {
                lh_speichern((int) $d['id'], ['zeilen' => 0], t('Datei nicht lesbar'));
                continue;
            }
            $proc = proc_open(lh_befehl($pfad), [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w']], $pipes);
            if (!is_resource($proc)) {
                lh_speichern((int) $d['id'], ['zeilen' => 0], t('ffmpeg konnte nicht gestartet werden'));
                continue;
            }
            stream_set_blocking($pipes[1], false);
            $laufend[] = ['proc' => $proc, 'pipe' => $pipes[1], 'datei' => (int) $d['id'], 'edition' => (int) $d['edition_id'], 'puffer' => ''];
        }
        if (!$laufend) {
            break;
        }
        // Ausgaben einsammeln
        $lesen = array_map(static fn($l) => $l['pipe'], $laufend);
        $w = $x = null;
        @stream_select($lesen, $w, $x, 1);
        foreach ($laufend as $i => &$l) {
            while (($teil = fread($l['pipe'], 65536)) !== false && $teil !== '') {
                $l['puffer'] .= $teil;
            }
            if (feof($l['pipe'])) {
                fclose($l['pipe']);
                $status = proc_close($l['proc']);
                $e = lh_auswerten($l['puffer']);
                $fehler = $e['zeilen'] === 0 ? ('ffmpeg: ' . trim(mb_substr(preg_replace('/\s+/', ' ', $l['puffer']), -200))) : '';
                lh_speichern($l['datei'], $e, $status !== 0 && $e['zeilen'] === 0 ? $fehler : '');
                $editionen[$l['edition']] = true;
                $fertig++;
                unset($laufend[$i]);
            }
        }
        unset($l);
        if (time() >= $ende) {
            $warteschlange = []; // keine neuen mehr, laufende zu Ende messen
        } elseif (!$warteschlange && $laufend === []) {
            $warteschlange = array_values(array_filter($offen(), static fn($d) => !isset($vergeben[$d['id']])));
        }
    }
    foreach (array_keys($editionen) as $e) {
        lh_album_berechnen($e);
    }
    flock($sperre, LOCK_UN);
    fclose($sperre);
    return $fertig;
}

/** Fortschritt für die Verwaltung */
function lh_stand(): array
{
    $z = db_zeile('SELECT COUNT(*) AS alle, SUM(lautheit_am IS NOT NULL) AS fertig, SUM(lautheit_fehler <> \'\') AS fehler,
        SUM(CASE WHEN lautheit_am IS NULL THEN laenge_ms ELSE 0 END) AS rest_ms FROM dateien WHERE track_id IS NOT NULL') ?: [];
    $alben = db_zeile('SELECT COUNT(*) AS alle, SUM(album_lautheit_am IS NOT NULL) AS fertig FROM editionen WHERE anzahl_dateien > 0') ?: [];
    $letzte = db_wert('SELECT MAX(lautheit_am) FROM dateien');
    $schnitt = db_zeile('SELECT ROUND(AVG(lufs), 1) AS lufs, ROUND(AVG(lra), 1) AS lra FROM dateien WHERE lufs IS NOT NULL') ?: [];
    return [
        'aktiv' => konfig()['lautheit']['aktiv'], 'parallel' => konfig()['lautheit']['parallel'],
        'dateien' => (int) ($z['alle'] ?? 0), 'gemessen' => (int) ($z['fertig'] ?? 0), 'fehler' => (int) ($z['fehler'] ?? 0),
        'rest_stunden' => round(((int) ($z['rest_ms'] ?? 0)) / 3600000, 1),
        'alben' => (int) ($alben['alle'] ?? 0), 'alben_fertig' => (int) ($alben['fertig'] ?? 0),
        'zuletzt' => iso($letzte ?: null), 'schnitt_lufs' => isset($schnitt['lufs']) ? (float) $schnitt['lufs'] : null,
        'schnitt_lra' => isset($schnitt['lra']) ? (float) $schnitt['lra'] : null,
        'laeuft' => lh_laeuft(),
    ];
}

function lh_laeuft(): bool
{
    $d = konfig()['pfade']['cache'] . '/tmp/lautheit.lock';
    if (!is_file($d)) {
        return false;
    }
    $h = @fopen($d, 'c');
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

/**
 * Lautheit für Titel (für den Player): je Track-ID Edition, Position im Album und die Messwerte.
 *   e = Edition, o = laufende Nummer im Album (über alle Discs), t/ttp = Titel-LUFS/True-Peak, a/atp = Album-LUFS/True-Peak,
 *   q = Quelle ('messung' oder 'tags' – ReplayGain-Tags als Notbehelf, solange noch nicht gemessen)
 */
function lh_fuer_tracks(array $ids): array
{
    $ids = array_slice(array_values(array_unique(array_filter(array_map('intval', $ids)))), 0, 2000);
    if (!$ids) {
        return [];
    }
    [$in, $p] = db_in($ids, 'lh');
    $zeilen = db_alle("SELECT t.id, m.edition_id, d.lufs, d.true_peak, e.album_lufs, e.album_true_peak,
            d.rg_track_db, d.rg_album_db, d.rg_track_peak, d.rg_album_peak
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id
        LEFT JOIN dateien d ON d.id = (SELECT d2.id FROM dateien d2 WHERE d2.track_id = t.id ORDER BY d2.bittiefe DESC, d2.abtastrate DESC, d2.id LIMIT 1)
        WHERE t.id IN {$in}", $p);
    // Reihenfolge innerhalb der Editionen (für „folgt im Album direkt aufeinander“)
    $ordnung = [];
    $editionen = array_values(array_unique(array_map(static fn($z) => (int) $z['edition_id'], $zeilen)));
    if ($editionen) {
        [$in2, $p2] = db_in($editionen, 'le');
        $n = [];
        foreach (db_alle("SELECT t.id, m.edition_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id
                WHERE m.edition_id IN {$in2} ORDER BY m.edition_id, m.pos, t.pos, t.id", $p2) as $z) {
            $e = (int) $z['edition_id'];
            $n[$e] = ($n[$e] ?? 0) + 1;
            $ordnung[(int) $z['id']] = $n[$e];
        }
    }
    $zahl = static fn($v) => $v !== null ? (float) $v : null;
    $db = static fn($lin) => $lin !== null && (float) $lin > 0 ? round(20 * log10((float) $lin), 2) : null;
    $aus = [];
    foreach ($zeilen as $z) {
        $x = ['e' => (int) $z['edition_id'], 'o' => $ordnung[(int) $z['id']] ?? 0, 'q' => 'messung',
            't' => $zahl($z['lufs']), 'ttp' => $zahl($z['true_peak']), 'a' => $zahl($z['album_lufs']), 'atp' => $zahl($z['album_true_peak'])];
        if ($x['t'] === null && ($z['rg_track_db'] !== null || $z['rg_album_db'] !== null)) {
            // ReplayGain 2.0 bezieht sich auf −18 LUFS: Lautheit ≈ −18 − Gain
            $x = ['q' => 'tags', 't' => $z['rg_track_db'] !== null ? round(-18 - (float) $z['rg_track_db'], 2) : null, 'ttp' => $db($z['rg_track_peak']),
                'a' => $z['rg_album_db'] !== null ? round(-18 - (float) $z['rg_album_db'], 2) : null, 'atp' => $db($z['rg_album_peak'])] + $x;
        }
        if ($x['t'] === null && $x['a'] === null) {
            $x['q'] = 'fehlt';
        }
        $aus[(int) $z['id']] = $x;
    }
    return $aus;
}

/** Gain-Wert aus einer Anfrage (dB) prüfen; null = keiner */
function lh_gain_param(mixed $wert): ?float
{
    if ($wert === null || $wert === '' || !is_numeric($wert)) {
        return null;
    }
    $g = round(max(-40.0, min(24.0, (float) $wert)), 2);
    return abs($g) < 0.01 ? null : $g;
}

/** ffmpeg-Filter für einen Gain (leer = keiner) */
function lh_gain_filter(?float $db): string
{
    return $db === null ? '' : 'volume=' . number_format($db, 2, '.', '') . 'dB';
}

/**
 * Alles für die Nerd-Ansicht eines Titels: Datei, Titel- und Album-Werte, Lautheitskurve.
 * Fehlt die Kurve (vor v0.1.30 gemessen), wird der Titel jetzt sofort gemessen (dauert je nach Länge ein paar Sekunden).
 */
function lh_nerd(int $trackId): array
{
    [$pfad, $d] = stream_datei($trackId);
    if (!$d['lautheit_kurve'] && ($d['lautheit_fehler'] ?? '') === '') {
        set_time_limit(300);
        $e = lh_datei_messen($pfad);
        lh_speichern((int) $d['id'], $e);
        $d = db_zeile('SELECT * FROM dateien WHERE id = :id', ['id' => $d['id']]);
        $ed = (int) db_wert('SELECT m.edition_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE t.id = :t', ['t' => $trackId]);
        if ($ed) {
            lh_album_berechnen($ed);
        }
    }
    $e = db_zeile('SELECT e.album_lufs, e.album_lra, e.album_true_peak, e.album_sample_peak FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id
        JOIN editionen e ON e.id = m.edition_id WHERE t.id = :t', ['t' => $trackId]) ?: [];
    $zahl = static fn($v) => $v !== null ? (float) $v : null;
    return [
        'datei' => ['name' => basename((string) $d['pfad']), 'format' => $d['format'], 'codec' => $d['codec'], 'abtastrate' => (int) $d['abtastrate'],
            'bittiefe' => (int) $d['bittiefe'], 'kanaele' => (int) $d['kanaele'], 'bitrate' => (int) $d['bitrate'], 'groesse' => (int) $d['groesse'],
            'laenge_ms' => (int) $d['laenge_ms'],
            'replaygain' => ['track_db' => $zahl($d['rg_track_db']), 'album_db' => $zahl($d['rg_album_db'])]],
        'titel' => ['lufs' => $zahl($d['lufs']), 'lra' => $zahl($d['lra']), 'true_peak' => $zahl($d['true_peak']), 'sample_peak' => $zahl($d['sample_peak'])],
        'album' => ['lufs' => $zahl($e['album_lufs'] ?? null), 'lra' => $zahl($e['album_lra'] ?? null), 'true_peak' => $zahl($e['album_true_peak'] ?? null),
            'sample_peak' => $zahl($e['album_sample_peak'] ?? null)],
        'kurve' => lh_kurve_entpacken($d['lautheit_kurve']),
        'fehler' => $d['lautheit_fehler'] ?: null,
    ];
}
