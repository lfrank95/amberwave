<?php
// Raumklang: Impulsantworten (IR) für den Hall der Surrounds.
// Quellen: das kostenlose Paket „IM Reverbs“ von Voxengo (lädt der Server auf Knopfdruck selbst – es wird nicht
// mit der App verteilt) und eigene WAV-Dateien. Ablage im Cache-Ordner unter raumklang/<quelle>/<datei>.wav
declare(strict_types=1);

require_once __DIR__ . '/musicbrainz.php';
require_once __DIR__ . '/i18n.php';

const RAUMKLANG_QUELLEN = ['voxengo' => 'Voxengo IM Reverbs', 'eigene' => 'Eigene'];

function raumklang_ordner(string $quelle = ''): string
{
    $o = konfig()['pfade']['cache'] . '/raumklang' . ($quelle !== '' ? '/' . $quelle : '');
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return $o;
}

/** Dateiname säubern: nur Buchstaben, Ziffern, Leer-, Binde- und Unterstrich, Punkt */
function raumklang_dateiname(string $name): string
{
    $name = basename(str_replace('\\', '/', $name));
    $stamm = preg_replace('/\.wav$/i', '', $name);
    $stamm = trim((string) preg_replace('/[^\p{L}\p{N} _().,-]+/u', '_', $stamm), ' ._');
    return ($stamm !== '' ? mb_substr($stamm, 0, 80) : 'impuls') . '.wav';
}

/** ID „quelle/datei.wav“ prüfen und in einen Pfad umsetzen (null = ungültig/fehlt) */
function raumklang_pfad(string $id): ?string
{
    if (!preg_match('#^(voxengo|eigene)/([^/\\\\]+\.wav)$#iu', $id, $m) || str_contains($m[2], '..')) {
        return null;
    }
    $pfad = raumklang_ordner($m[1]) . '/' . $m[2];
    return is_file($pfad) ? $pfad : null;
}

const RAUMKLANG_ARTEN = ['kammer' => 'Kammer', 'raum' => 'Raum', 'halle' => 'Halle', 'kirche' => 'Kirche', 'plate' => 'Plate/Feder', 'sonstige' => 'Sonstige'];

/** Nachhallzeit (RT60, Sekunden) und Länge einer WAV-Impulsantwort messen (Schroeder-Rückwärtsintegration, 10-ms-Blöcke) */
function raumklang_messen(string $pfad): ?array
{
    $d = @file_get_contents($pfad);
    if ($d === false || !raumklang_wav_pruefen($d)) {
        return null;
    }
    $pos = 12;
    $fmt = null;
    $daten = null;
    $n = strlen($d);
    while ($pos + 8 <= $n) {
        $id = substr($d, $pos, 4);
        $len = unpack('V', substr($d, $pos + 4, 4))[1];
        if ($id === 'fmt ') {
            $fmt = unpack('vformat/vkanaele/Vrate/Vbytes/vblock/vbits', substr($d, $pos + 8, 16));
        } elseif ($id === 'data') {
            $daten = substr($d, $pos + 8, min($len, $n - $pos - 8));
            break;
        }
        $pos += 8 + $len + ($len & 1);
    }
    if (!$fmt || $daten === null || $fmt['kanaele'] < 1 || $fmt['rate'] < 8000) {
        return null;
    }
    $bytes = intdiv($fmt['bits'], 8);
    if (!in_array($bytes, [2, 3, 4], true)) {
        return null;
    }
    $rahmen = intdiv(strlen($daten), $bytes * $fmt['kanaele']);
    $block = max(1, intdiv($fmt['rate'], 100));
    $energie = [];
    $ist_float = (int) $fmt['format'] === 3 || ((int) $fmt['format'] === 65534 && $bytes === 4 && false);
    for ($start = 0; $start < $rahmen; $start += $block) {
        $anz = min($block, $rahmen - $start);
        $chunk = substr($daten, $start * $bytes * $fmt['kanaele'], $anz * $bytes * $fmt['kanaele']);
        $summe = 0.0;
        if ($bytes === 2) {
            $v = unpack('s*', $chunk);
            foreach ($v as $x) { $summe += ($x / 32768) ** 2; }
        } elseif ($bytes === 4) {
            $v = unpack($ist_float ? 'g*' : 'l*', $chunk);
            foreach ($v as $x) { $summe += ($ist_float ? $x : $x / 2147483648) ** 2; }
        } else {
            $b = unpack('C*', $chunk);
            for ($i = 1, $c = count($b); $i + 2 <= $c; $i += 3) {
                $x = $b[$i] | ($b[$i + 1] << 8) | ($b[$i + 2] << 16);
                if ($x & 0x800000) { $x -= 0x1000000; }
                $summe += ($x / 8388608) ** 2;
            }
        }
        $energie[] = $summe;
    }
    if (count($energie) < 3) {
        return null;
    }
    $spitze = array_search(max($energie), $energie, true);
    $energie = array_slice($energie, (int) $spitze);
    $gesamt = array_sum($energie);
    if ($gesamt <= 0) {
        return null;
    }
    // Abklingkurve in dB (rückwärts summiert)
    $rest = $gesamt;
    $kurve = [];
    foreach ($energie as $e) {
        $kurve[] = 10 * log10(max($rest, 1e-30) / $gesamt);
        $rest -= $e;
    }
    $zeit = static function (float $db) use ($kurve): ?float {
        foreach ($kurve as $i => $v) {
            if ($v <= $db) { return $i * 0.01; }
        }
        return null;
    };
    $t5 = $zeit(-5.0);
    $t25 = $zeit(-25.0);
    $rt = null;
    if ($t5 !== null && $t25 !== null && $t25 > $t5) {
        $rt = ($t25 - $t5) * 3;
    } elseif ($t5 !== null && ($t15 = $zeit(-15.0)) !== null && $t15 > $t5) {
        $rt = ($t15 - $t5) * 6;
    }
    return ['rt60' => $rt !== null ? round($rt, 2) : round(count($energie) * 0.01, 2), 'dauer' => round($rahmen / $fmt['rate'], 2)];
}

/** Art und Größe aus Name und Nachhallzeit ableiten (eine vom Nutzer gewählte Art hat Vorrang) */
function raumklang_einordnen(string $name, ?float $rt60, ?string $art_vorgabe = null): array
{
    $n = mb_strtolower($name);
    if ($art_vorgabe && isset(RAUMKLANG_ARTEN[$art_vorgabe])) {
        $art = $art_vorgabe;
    } elseif (preg_match('/church|cathedral|kirche|chapel|basilica|nicolaes|abbey|minster/', $n)) {
        $art = 'kirche';
    } elseif (preg_match('/plate|spring|feder|tank|echo chamber/', $n)) {
        $art = 'plate';
    } elseif (preg_match('/hall|halle|saal|opera|theat|arena|auditor|konzert|concert|stadium|garage|silo|cave|tunnel/', $n)) {
        $art = 'halle';
    } elseif (preg_match('/salon|chamber|kammer|closet|booth|cabin|bath|toilet|cabinet|cupboard/', $n)) {
        $art = 'kammer';
    } elseif (preg_match('/room|raum|studio|drum|lounge|bedroom|kitchen|office|stage|vocal|space|lodge/', $n)) {
        $art = 'raum';
    } elseif ($rt60 !== null) {
        $art = $rt60 < 0.45 ? 'kammer' : ($rt60 < 1.2 ? 'raum' : 'halle');
    } else {
        $art = 'sonstige';
    }
    $groesse = $rt60 === null ? null : ($rt60 < 0.5 ? t('klein') : ($rt60 < 1.3 ? t('mittel') : ($rt60 < 2.8 ? t('groß') : t('sehr groß'))));
    return ['art' => $art, 'art_name' => RAUMKLANG_ARTEN[$art], 'klasse' => $groesse];
}

/** Gemessene Eigenschaften je IR (Datei raumklang/eigenschaften.json, gültig solange die Datei unverändert ist) */
function raumklang_eigenschaften(string $id, string $pfad, ?array &$speicher = null): array
{
    $mt = (int) filemtime($pfad);
    $e = $speicher[$id] ?? null;
    if (!is_array($e) || ($e['mtime'] ?? 0) !== $mt) {
        $m = raumklang_messen($pfad);
        $e = ['mtime' => $mt, 'rt60' => $m['rt60'] ?? null, 'dauer' => $m['dauer'] ?? null, 'art' => $e['art'] ?? null];
        $speicher[$id] = $e;
        $speicher['_neu'] = true;
    }
    return $e;
}

function raumklang_liste(): array
{
    $meta_datei = raumklang_ordner() . '/eigenschaften.json';
    $meta = is_file($meta_datei) ? (json_decode((string) file_get_contents($meta_datei), true) ?: []) : [];
    $aus = [];
    foreach (RAUMKLANG_QUELLEN as $q => $titel) {
        foreach (glob(raumklang_ordner($q) . '/*.wav') ?: [] as $datei) {
            $name = preg_replace('/\.wav$/i', '', basename($datei));
            $id = $q . '/' . basename($datei);
            $e = raumklang_eigenschaften($id, $datei, $meta);
            $aus[] = ['id' => $id, 'name' => $name, 'quelle' => $q, 'quelle_titel' => $titel, 'groesse' => filesize($datei),
                'nachhall_s' => $e['rt60'], 'dauer_s' => $e['dauer']] + raumklang_einordnen($name, $e['rt60'], $e['art'] ?? null);
        }
    }
    if (!empty($meta['_neu'])) {
        unset($meta['_neu']);
        @file_put_contents($meta_datei, json_encode($meta), LOCK_EX);
    }
    usort($aus, fn($a, $b) => [$a['quelle'], mb_strtolower($a['name'])] <=> [$b['quelle'], mb_strtolower($b['name'])]);
    $lizenz = raumklang_ordner('voxengo') . '/LIZENZ.txt';
    return ['irs' => $aus, 'voxengo' => [
        'installiert' => count(array_filter($aus, fn($x) => $x['quelle'] === 'voxengo')) > 0,
        'url' => konfig()['raumklang']['ir_url'],
        'lizenz' => is_file($lizenz) ? (string) file_get_contents($lizenz) : null,
    ]];
}

/** Ist das eine brauchbare WAV-Datei? */
function raumklang_wav_pruefen(string $daten): bool
{
    return strlen($daten) > 44 && substr($daten, 0, 4) === 'RIFF' && substr($daten, 8, 4) === 'WAVE';
}

/** Voxengo-Paket herunterladen und die WAV-Dateien unverändert ablegen */
function raumklang_voxengo_laden(): array
{
    $url = konfig()['raumklang']['ir_url'];
    $r = http_holen($url, [], 180, 60 * 1024 * 1024);
    if ($r['status'] !== 200 || strlen($r['body']) < 1000) {
        throw new ApiFehler(t('Download fehlgeschlagen (HTTP {status}). Adresse: {url}', ['status' => $r['status'], 'url' => $url]));
    }
    $tmp = tempnam(sys_get_temp_dir(), 'awir');
    file_put_contents($tmp, $r['body']);
    $zip = new ZipArchive();
    if ($zip->open($tmp) !== true) {
        @unlink($tmp);
        throw new ApiFehler(t('Das heruntergeladene Paket ist kein gültiges Zip.'));
    }
    $ziel = raumklang_ordner('voxengo');
    $anzahl = 0;
    $lizenz = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = (string) $zip->getNameIndex($i);
        if (str_ends_with($name, '/') || str_contains($name, '__MACOSX')) {
            continue;
        }
        $inhalt = $zip->getFromIndex($i);
        if ($inhalt === false) {
            continue;
        }
        if (preg_match('/\.wav$/i', $name) && raumklang_wav_pruefen($inhalt)) {
            file_put_contents($ziel . '/' . raumklang_dateiname($name), $inhalt);
            $anzahl++;
        } elseif (preg_match('/\.(txt|rtf|md)$/i', $name) || preg_match('/(licen[cs]e|readme)/i', $name)) {
            $lizenz[] = '--- ' . basename($name) . " ---\n" . trim((string) $inhalt);
        }
    }
    $zip->close();
    @unlink($tmp);
    if ($anzahl === 0) {
        throw new ApiFehler(t('Im Paket wurden keine WAV-Dateien gefunden.'));
    }
    $text = "Voxengo IM Reverbs – Copyright (c) Aleksey Vaneev, https://www.voxengo.com/impulses/\n"
        . t('Kostenlos nutzbar; nicht verkaufen, nur vollständig und unverändert weitergeben.') . "\n"
        . t('Heruntergeladen am {datum} von {url}', ['datum' => date(sprache() === 'en' ? 'Y-m-d' : 'd.m.Y'), 'url' => $url]) . "\n\n" . implode("\n\n", $lizenz);
    file_put_contents($ziel . '/LIZENZ.txt', $text);
    return ['ok' => true, 'anzahl' => $anzahl] + raumklang_liste();
}

function raumklang_hochladen(): array
{
    $f = $_FILES['ir'] ?? null;
    if (!$f || empty($f['tmp_name']) || ($f['error'] ?? 1) !== UPLOAD_ERR_OK) {
        throw new ApiFehler(t('Keine Datei empfangen.'));
    }
    if ((int) $f['size'] > 30 * 1024 * 1024) {
        throw new ApiFehler(t('Die Datei ist zu groß (höchstens 30 MB).'));
    }
    $daten = (string) file_get_contents((string) $f['tmp_name']);
    if (!raumklang_wav_pruefen($daten)) {
        throw new ApiFehler(t('Bitte eine WAV-Datei hochladen.'));
    }
    $name = raumklang_dateiname((string) ($f['name'] ?? 'impuls.wav'));
    file_put_contents(raumklang_ordner('eigene') . '/' . $name, $daten);
    $art = (string) ($_POST['art'] ?? '');
    if (isset(RAUMKLANG_ARTEN[$art])) {
        $meta_datei = raumklang_ordner() . '/eigenschaften.json';
        $meta = is_file($meta_datei) ? (json_decode((string) file_get_contents($meta_datei), true) ?: []) : [];
        unset($meta['eigene/' . $name]);
        raumklang_eigenschaften('eigene/' . $name, raumklang_ordner('eigene') . '/' . $name, $meta);
        $meta['eigene/' . $name]['art'] = $art;
        unset($meta['_neu']);
        @file_put_contents($meta_datei, json_encode($meta), LOCK_EX);
    }
    return ['ok' => true, 'id' => 'eigene/' . $name] + raumklang_liste();
}

function raumklang_loeschen(string $id): array
{
    $pfad = raumklang_pfad($id);
    if (!$pfad) {
        throw new ApiFehler(t('Nicht gefunden.'), 404);
    }
    if (str_starts_with($id, 'voxengo/')) {
        // ganzes Paket entfernen (nur vollständig behalten, so verlangt es die Lizenz)
        foreach (glob(raumklang_ordner('voxengo') . '/*') ?: [] as $d) {
            @unlink($d);
        }
    } else {
        @unlink($pfad);
    }
    return ['ok' => true] + raumklang_liste();
}

function raumklang_senden(string $id): void
{
    $pfad = raumklang_pfad($id);
    if (!$pfad) {
        throw new ApiFehler(t('Nicht gefunden.'), 404);
    }
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    header('Content-Type: audio/wav');
    header('Content-Length: ' . filesize($pfad));
    header('Cache-Control: private, max-age=86400');
    readfile($pfad);
    exit;
}
