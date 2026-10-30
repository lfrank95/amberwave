<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/api.php';
require_once __DIR__ . '/bilder.php';
require_once __DIR__ . '/tags_flac.php';

/**
 * Wiedergabe:
 *  - original: Datei unverändert, mit HTTP-Range (Spulen) – bitgenau für den späteren Windows-Player
 *  - opus256/opus160/opus128: live mit ffmpeg nach Ogg Opus umgewandelt (Stereo, 48 kHz)
 *  - aac256/aac160: live nach AAC (ADTS) für Geräte ohne Opus (ältere iPhones)
 * Bei umgewandelten Streams spult die App über den Parameter t (Startsekunde) – der Stream startet dann dort neu.
 */

const STREAM_QUALITAETEN = [
    'opus256' => ['codec' => 'opus', 'kbit' => 256],
    'opus160' => ['codec' => 'opus', 'kbit' => 160],
    'opus128' => ['codec' => 'opus', 'kbit' => 128],
    'aac256' => ['codec' => 'aac', 'kbit' => 256],
    'aac160' => ['codec' => 'aac', 'kbit' => 160],
];

const AUDIO_MIME = [
    'flac' => 'audio/flac', 'mp3' => 'audio/mpeg', 'm4a' => 'audio/mp4', 'aac' => 'audio/aac', 'alac' => 'audio/mp4',
    'ogg' => 'audio/ogg', 'opus' => 'audio/ogg', 'wav' => 'audio/wav', 'aif' => 'audio/aiff', 'aiff' => 'audio/aiff',
    'wv' => 'audio/x-wavpack', 'ape' => 'audio/x-ape', 'dsf' => 'audio/x-dsf', 'dff' => 'audio/x-dff',
];

/** Spalten von „dateien“ ohne die großen Felder (Tags als JSON, Lautheits-Histogramme und -Kurve, zusammen oft 10 KB je Datei) */
function dateien_spalten_leicht(): string
{
    static $s = null;
    if ($s === null) {
        $weg = ['tags_json', 'lautheit_m', 'lautheit_s', 'lautheit_kurve'];
        $s = implode(', ', array_map(static fn($c) => '`' . $c . '`', array_values(array_diff(array_column(db_alle('SHOW COLUMNS FROM dateien'), 'Field'), $weg))));
    }
    return $s;
}

/** Beste Datei zu einem Track (absoluter Pfad + Zeile) oder Fehler. $voll: auch die großen Felder (Lautheitskurve …) */
function stream_datei(int $trackId, bool $voll = false): array
{
    $wurzel = konfig()['pfade']['musik'];
    $wurzelEcht = aw_realpath($wurzel) ?: $wurzel;
    $echt = false;
    $d = null;
    // Wird die Datei gerade vom Aufräumen verschoben, liegt der neue Pfad erst Millisekunden später in der Datenbank:
    // kurz neu nachsehen, zuletzt im Aufräum-Protokoll nach dem neuen Ort suchen.
    for ($versuch = 0; $versuch < 4; $versuch++) {
        $d = db_zeile('SELECT ' . ($voll ? '*' : dateien_spalten_leicht()) . ' FROM dateien WHERE track_id = :t ORDER BY bittiefe DESC, abtastrate DESC, id LIMIT 1', ['t' => $trackId]);
        if (!$d) {
            throw new ApiFehler(t('Für diesen Titel liegt keine Datei vor.'), 404);
        }
        $echt = aw_realpath($wurzel . '/' . $d['pfad']);
        if ($echt === false) {
            // Im Aufräum-Protokoll dem Weg der Datei folgen (auch über mehrere Umzüge) und den Fund gleich in der
            // Datenbank nachtragen – dann stimmt der Ort wieder, ohne auf das nächste Einlesen zu warten
            $pfad = (string) $d['pfad'];
            for ($hop = 0; $hop < 6 && $echt === false; $hop++) {
                $neu = (string) db_wert("SELECT nach FROM aufraeum_protokoll WHERE art = 'umbenannt' AND von = :v ORDER BY id DESC LIMIT 1", ['v' => $pfad]);
                if ($neu === '' || $neu === $pfad) {
                    break;
                }
                $pfad = $neu;
                $kandidat = aw_realpath($wurzel . '/' . $pfad);
                if ($kandidat !== false && is_file($kandidat) && str_starts_with($kandidat, $wurzelEcht . '/')) {
                    $echt = $kandidat;
                    try {
                        require_once __DIR__ . '/scanner.php';
                        if (!db_wert('SELECT 1 FROM dateien WHERE pfad_hash = :h AND id <> :id', ['h' => hash('sha256', $pfad), 'id' => $d['id']])) {
                            db_tun('UPDATE dateien SET pfad = :p, pfad_hash = :h, ordner_hash = :o WHERE id = :id',
                                ['p' => $pfad, 'h' => hash('sha256', $pfad), 'o' => hash('sha256', scan_basis_ordner($pfad)), 'id' => $d['id']]);
                        }
                    } catch (Throwable $e) {
                        // Nachtragen ist Kür – abgespielt wird trotzdem
                    }
                }
            }
        }
        if ($echt !== false && is_file($echt)) {
            break;
        }
        if ($versuch < 3) {
            usleep(150000);
        }
    }
    // Nie außerhalb des Musikordners lesen
    if ($echt === false || !str_starts_with($echt, $wurzelEcht . '/') || !is_file($echt)) {
        throw new ApiFehler(t('Die Datei ist nicht mehr vorhanden. Bitte die Bibliothek neu einlesen.'), 404);
    }
    return [$echt, $d];
}

function stream_senden(array $user, int $trackId): void
{
    [$pfad, $d] = stream_datei($trackId);
    // „Wird gespielt“ vermerken (höchstens alle 30 s je Datei): das Aufräumen verschiebt solche Alben nicht
    try {
        db_tun('UPDATE dateien SET zuletzt_gespielt = NOW() WHERE id = :i AND (zuletzt_gespielt IS NULL OR zuletzt_gespielt < NOW() - INTERVAL 30 SECOND)', ['i' => $d['id']]);
    } catch (Throwable $e) {
    }
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close(); // andere Anfragen dieses Nutzers nicht blockieren
    }
    // Die Übertragung dauert Minuten: Datenbankverbindung bis dahin freigeben (wird sie doch gebraucht, öffnet db() neu)
    db_schliessen();
    $q = (string) ($_GET['q'] ?? 'original');
    if (($_GET['art'] ?? '') === 'luecken') {
        // Lückenlose Wiedergabe: Original als FLAC in fragmentiertem MP4 (Dateiinhalt bitgenau bzw. verlustfrei dekodiert)
        lueckenlos_titel_senden($pfad, $d, max(0.0, (float) ($_GET['t'] ?? 0)));
        return;
    }
    if (($_GET['art'] ?? '') === 'flac' && ($_GET['wav'] ?? '') === '1' && in_array($d['format'], ['wav', 'aif', 'aiff'], true)
        && in_array((string) ($d['codec'] ?? ''), ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s16be', 'pcm_s24be', 'pcm_s32be', 'pcm_u8', 'pcm_s8'], true)) {
        // Windows-Client ab 0.7: WAV/AIFF mit ganzzahligem PCM unverändert (die Engine liest sie selbst – bitgenau, sofort spulbar)
        datei_mit_range_senden($pfad, AUDIO_MIME[$d['format']] ?? 'application/octet-stream');
        return;
    }
    if (($_GET['art'] ?? '') === 'flac') {
        // Windows-Client: immer ein reiner FLAC-Strom. FLAC-Dateien 1:1 mit Range (bitgenau, spulbar), alles andere
        // verlustfrei nach FLAC dekodiert (Start über t)
        flac_strom_senden($pfad, $d, max(0.0, (float) ($_GET['t'] ?? 0)));
        return;
    }
    if ($q === 'original') {
        datei_mit_range_senden($pfad, AUDIO_MIME[$d['format']] ?? 'application/octet-stream');
        return;
    }
    if (!isset(STREAM_QUALITAETEN[$q])) {
        throw new ApiFehler(t('Unbekannte Qualität.'), 400);
    }
    $start = max(0.0, (float) ($_GET['t'] ?? 0));
    require_once __DIR__ . '/lautheit.php';
    umwandeln_senden($pfad, STREAM_QUALITAETEN[$q], $start, lh_gain_param($_GET['g'] ?? null));
}

/** Datei mit Unterstützung für Range-Anfragen ausliefern. */
function datei_mit_range_senden(string $pfad, string $mime, ?string $download_name = null): void
{
    $groesse = (int) filesize($pfad);
    $mtime = (int) filemtime($pfad);
    $etag = '"' . substr(hash('sha256', $pfad . '|' . $groesse . '|' . $mtime), 0, 24) . '"';
    header('Accept-Ranges: bytes');
    header('Content-Type: ' . $mime);
    header('ETag: ' . $etag);
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    header('Cache-Control: private, max-age=86400');
    header('X-Content-Type-Options: nosniff');
    if ($download_name !== null) {
        $sicher = preg_replace('/[^\w .()\[\]-]+/u', '_', $download_name) ?: 'titel';
        header("Content-Disposition: attachment; filename=\"" . str_replace('"', '', $sicher) . "\"; filename*=UTF-8''" . rawurlencode($download_name));
    }
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        return;
    }
    $von = 0;
    $bis = $groesse - 1;
    $range = (string) ($_SERVER['HTTP_RANGE'] ?? '');
    if ($range !== '' && preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $m)) {
        if ($m[1] === '' && $m[2] !== '') {
            $von = max(0, $groesse - (int) $m[2]);
        } else {
            $von = (int) $m[1];
            if ($m[2] !== '') {
                $bis = min($bis, (int) $m[2]);
            }
        }
        if ($von > $bis || $von >= $groesse) {
            http_response_code(416);
            header('Content-Range: bytes */' . $groesse);
            return;
        }
        http_response_code(206);
        header("Content-Range: bytes {$von}-{$bis}/{$groesse}");
    }
    $laenge = $bis - $von + 1;
    header('Content-Length: ' . $laenge);
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
        return;
    }
    set_time_limit(0);
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    $f = fopen($pfad, 'rb');
    fseek($f, $von);
    $rest = $laenge;
    while ($rest > 0 && !feof($f)) {
        $stueck = fread($f, (int) min(256 * 1024, $rest));
        if ($stueck === false || $stueck === '') {
            break;
        }
        echo $stueck;
        flush();
        $rest -= strlen($stueck);
        if (connection_aborted()) {
            break;
        }
    }
    fclose($f);
}

/** Einen freien Platz für eine Umwandlung belegen (begrenzt die Zahl gleichzeitiger ffmpeg-Prozesse). */
function umwandlung_platz()
{
    $max = max(1, (int) konfig()['stream']['max_umwandlungen']);
    $ordner = konfig()['pfade']['cache'] . '/tmp';
    if (!is_dir($ordner)) {
        @mkdir($ordner, 0775, true);
    }
    for ($i = 0; $i < $max; $i++) {
        $h = @fopen($ordner . '/umwandlung-' . $i . '.lock', 'c');
        if ($h && flock($h, LOCK_EX | LOCK_NB)) {
            return $h;
        }
        if ($h) {
            fclose($h);
        }
    }
    return null;
}

function umwandeln_senden(string $pfad, array $ziel, float $start, ?float $gain = null): void
{
    $platz = umwandlung_platz();
    if (!$platz) {
        header('Retry-After: 5');
        throw new ApiFehler(t('Der Server wandelt gerade zu viele Titel gleichzeitig um. Bitte gleich noch einmal versuchen.'), 503);
    }
    $ffmpeg = konfig()['stream']['ffmpeg'];
    $teile = [aw_arg($ffmpeg), '-v error -nostdin'];
    if ($start > 0) {
        $teile[] = '-ss ' . number_format($start, 3, '.', '');
    }
    $teile[] = '-i ' . aw_arg($pfad);
    $teile[] = '-map 0:a:0 -vn -sn -dn -map_metadata -1 -ac 2';
    if ($gain !== null) {
        // Lautheitsangleich (EBU R128) vor dem Kodieren – Opus/AAC rechnen intern mit Fließkomma, nichts wird abgeschnitten
        $teile[] = '-af ' . aw_arg(lh_gain_filter($gain));
    }
    if ($ziel['codec'] === 'opus') {
        $teile[] = '-ar 48000 -c:a libopus -b:a ' . (int) $ziel['kbit'] . 'k -vbr on -compression_level 5 -application audio -f ogg';
        $mime = 'audio/ogg';
    } else {
        $teile[] = '-c:a aac -b:a ' . (int) $ziel['kbit'] . 'k -f adts';
        $mime = 'audio/aac';
    }
    $teile[] = 'pipe:1';
    $cmd = implode(' ', $teile);

    set_time_limit(0);
    ignore_user_abort(true);
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    $proc = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) {
        flock($platz, LOCK_UN);
        throw new ApiFehler(t('Umwandlung konnte nicht gestartet werden.'), 500);
    }
    stream_set_blocking($pipes[2], false);
    header('Content-Type: ' . $mime);
    header('Cache-Control: no-store');
    header('X-Accel-Buffering: no');
    header('Accept-Ranges: none');
    $gesendet = 0;
    $fehler = '';
    while (!feof($pipes[1])) {
        $stueck = fread($pipes[1], 64 * 1024);
        if ($stueck === false) {
            break;
        }
        if ($stueck !== '') {
            echo $stueck;
            flush();
            $gesendet += strlen($stueck);
        }
        // Fehlerausgabe laufend leeren – läuft die Leitung voll, bliebe ffmpeg stehen
        $fehler .= (string) stream_get_contents($pipes[2]);
        if (strlen($fehler) > 65536) {
            $fehler = substr($fehler, -8192);
        }
        if (connection_aborted()) {
            break;
        }
    }
    $fehler .= (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $status = proc_get_status($proc);
    if ($status['running']) {
        proc_terminate($proc, 15);
    }
    proc_close($proc);
    flock($platz, LOCK_UN);
    fclose($platz);
    if ($gesendet === 0 && $fehler) {
        error_log('ffmpeg: ' . mb_substr((string) $fehler, 0, 500));
    }
}

// ---------------------------------------------------------------------------------------------
// Lückenlose Wiedergabe (gapless) über Media Source Extensions im Browser.
// Die Dateien selbst werden nie verändert – nur für die Übertragung neu verpackt bzw. dekodiert.
// ---------------------------------------------------------------------------------------------

/** Exakte Länge eines Titels in Samples und die Abtastrate (für sample-genaues Aneinanderhängen). */
function stream_genaue_laenge(string $pfad, array $d): array
{
    if ($d['format'] === 'flac') {
        try {
            $t = flac_lesen($pfad)['technik'];
            if (!empty($t['samples']) && !empty($t['abtastrate'])) {
                return ['samples' => (int) $t['samples'], 'rate' => (int) $t['abtastrate']];
            }
        } catch (Throwable $e) {
            // weiter mit ffprobe
        }
    }
    $cmd = aw_arg(konfig()['stream']['ffprobe']) . ' -v error -select_streams a:0 -show_entries stream=sample_rate,duration_ts,time_base,duration -of json ' . aw_arg($pfad);
    $j = json_decode((string) shell_exec($cmd), true);
    $s = $j['streams'][0] ?? [];
    $rate = (int) ($s['sample_rate'] ?? 0);
    $dauer = (float) ($s['duration'] ?? 0);
    if (!empty($s['duration_ts']) && preg_match('#^1/(\d+)$#', (string) ($s['time_base'] ?? ''), $m) && (int) $m[1] === $rate) {
        return ['samples' => (int) $s['duration_ts'], 'rate' => $rate];
    }
    if ($rate <= 0) {
        $rate = 44100;
    }
    if ($dauer <= 0) {
        $dauer = ((int) $d['laenge_ms']) / 1000;
    }
    return ['samples' => (int) round($dauer * $rate), 'rate' => $rate];
}

/** ffmpeg starten und die Ausgabe durchreichen (mit Platz-Begrenzung). */
function ffmpeg_durchreichen(string $cmd, string $mime, array $kopfzeilen = []): void
{
    $platz = umwandlung_platz();
    if (!$platz) {
        header('Retry-After: 5');
        throw new ApiFehler(t('Der Server wandelt gerade zu viele Titel gleichzeitig um. Bitte gleich noch einmal versuchen.'), 503);
    }
    set_time_limit(0);
    ignore_user_abort(true);
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    $proc = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) {
        flock($platz, LOCK_UN);
        throw new ApiFehler(t('Wiedergabe konnte nicht gestartet werden.'), 500);
    }
    stream_set_blocking($pipes[2], false);
    header('Content-Type: ' . $mime);
    header('Cache-Control: no-store');
    header('X-Accel-Buffering: no');
    header('Accept-Ranges: none');
    foreach ($kopfzeilen as $k => $v) {
        header($k . ': ' . $v);
    }
    $gesendet = 0;
    $fehler = '';
    while (!feof($pipes[1])) {
        $stueck = fread($pipes[1], 64 * 1024);
        if ($stueck === false) {
            break;
        }
        if ($stueck !== '') {
            echo $stueck;
            flush();
            $gesendet += strlen($stueck);
        }
        $fehler .= (string) stream_get_contents($pipes[2]);
        if (connection_aborted()) {
            break;
        }
    }
    $fehler .= (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $status = proc_get_status($proc);
    if ($status['running']) {
        proc_terminate($proc, 15);
    }
    proc_close($proc);
    flock($platz, LOCK_UN);
    fclose($platz);
    if ($gesendet === 0 && $fehler !== '') {
        error_log('ffmpeg: ' . mb_substr($fehler, 0, 500));
    }
}

/** Reiner FLAC-Strom für den Windows-Client (eigene Engine, kein Browser) */
function flac_strom_senden(string $pfad, array $d, float $start): void
{
    if ($d['format'] === 'flac' && $start <= 0) {
        datei_mit_range_senden($pfad, 'audio/flac');
        return;
    }
    $ffmpeg = aw_arg(konfig()['stream']['ffmpeg']);
    $hohe_rate = in_array($d['format'], ['dsf', 'dff'], true);
    $teile = [$ffmpeg, '-v error -nostdin'];
    if ($start > 0) {
        $teile[] = '-ss ' . number_format($start, 3, '.', '');
    }
    $teile[] = '-i ' . aw_arg($pfad);
    $teile[] = '-map 0:a:0 -vn -sn -dn -map_metadata -1';
    $teile[] = ($hohe_rate ? '-ar 88200 ' : '') . '-c:a flac -compression_level 1' . ((int) $d['bittiefe'] > 16 || $hohe_rate ? ' -sample_fmt s32' : '');
    $teile[] = '-f flac pipe:1';
    ffmpeg_durchreichen(implode(' ', $teile), 'audio/flac', ['X-Bitgenau' => '0']);
}

/**
 * Ein Titel als FLAC in fragmentiertem MP4 (für den lückenlosen Player zuhause).
 * FLAC-Dateien ab Anfang: Audiodaten 1:1 kopiert (bitgenau). Andere Formate bzw. Start mitten im Titel:
 * verlustfrei nach FLAC dekodiert – die Samples sind identisch, Encoder-Vorlauf/Füllstille (MP3/AAC) fällt dabei weg.
 * Kopfzeile X-Samples/X-Rate: exakte Länge, damit der nächste Titel auf das Sample genau anschließt.
 */
function lueckenlos_titel_senden(string $pfad, array $d, float $start): void
{
    $laenge = stream_genaue_laenge($pfad, $d);
    $ffmpeg = aw_arg(konfig()['stream']['ffmpeg']);
    $kopieren = $d['format'] === 'flac' && $start <= 0;
    $teile = [$ffmpeg, '-v error -nostdin'];
    if ($start > 0) {
        $teile[] = '-ss ' . number_format($start, 3, '.', '');
    }
    $teile[] = '-i ' . aw_arg($pfad);
    $teile[] = '-map 0:a:0 -vn -sn -dn -map_metadata -1';
    if ($kopieren) {
        $teile[] = '-c:a copy';
    } else {
        // DSD u. ä. auf 88,2 kHz, sonst Abtastrate wie im Original; 24 Bit bleiben 24 Bit
        $hohe_rate = in_array($d['format'], ['dsf', 'dff'], true);
        $teile[] = ($hohe_rate ? '-ar 88200 ' : '') . '-c:a flac -compression_level 1' . ((int) $d['bittiefe'] > 16 || $hohe_rate ? ' -sample_fmt s32' : '');
    }
    $teile[] = '-f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 pipe:1';
    // Format des Stroms (Rate/Kanäle/Bit): ändert es sich zum Vortitel, beginnt der Player einen neuen Puffer – ein
    // Formatwechsel mitten in einem Media-Source-Puffer führt in manchen Browsern zu Störgeräuschen
    $hohe_rate = in_array($d['format'], ['dsf', 'dff'], true);
    $bits = $kopieren ? (int) $d['bittiefe'] : ((int) $d['bittiefe'] > 16 || $hohe_rate ? 32 : 16);
    $format = ($hohe_rate && !$kopieren ? 88200 : (int) $laenge['rate']) . '/' . (int) $d['kanaele'] . '/' . $bits;
    ffmpeg_durchreichen(implode(' ', $teile), 'audio/mp4', [
        'X-Samples' => (string) $laenge['samples'], 'X-Rate' => (string) $laenge['rate'], 'X-Bitgenau' => $kopieren ? '1' : '0',
        'X-Format' => $format,
        'Access-Control-Expose-Headers' => 'X-Samples, X-Rate, X-Bitgenau, X-Format',
    ]);
}

/**
 * Mehrere aufeinanderfolgende Titel (z. B. ein Live-Album) als EIN durchgehender Opus-Strom (WebM).
 * Weil der Encoder ohne Unterbrechung über die Titelgrenzen läuft, gibt es keine Naht – sample-genau lückenlos.
 * Kopfzeile X-Dauern: exakte Länge jedes Titels in Sekunden (für Anzeige und Titelwechsel).
 */
function lueckenlos_kette_senden(array $user, string $ids_text, string $q, float $start, string $gains_text = ''): void
{
    require_once __DIR__ . '/lautheit.php';
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    if (!isset(STREAM_QUALITAETEN[$q]) || STREAM_QUALITAETEN[$q]['codec'] !== 'opus') {
        throw new ApiFehler(t('Unbekannte Qualität.'), 400);
    }
    $ids = array_slice(array_values(array_filter(array_map('intval', explode(',', $ids_text)))), 0, 40);
    if (!$ids) {
        throw new ApiFehler(t('Keine Titel angegeben.'), 400);
    }
    $eingaben = [];
    $dauern = [];
    foreach ($ids as $i => $id) {
        [$pfad, $d] = stream_datei($id);
        $l = stream_genaue_laenge($pfad, $d);
        $dauern[] = number_format($l['samples'] / max(1, $l['rate']), 6, '.', '');
        $eingaben[] = '-threads 1 ' . ($i === 0 && $start > 0 ? '-ss ' . number_format($start, 3, '.', '') . ' ' : '') . '-i ' . aw_arg($pfad);
    }
    // Lautheitsangleich je Titel (dB, gleiche Reihenfolge wie ids) – wechselt sample-genau an der Titelgrenze
    $gains = $gains_text !== '' ? explode(',', $gains_text) : [];
    $filter = '';
    foreach ($ids as $i => $_) {
        $g = lh_gain_filter(lh_gain_param($gains[$i] ?? null));
        $filter .= "[{$i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo" . ($g !== '' ? ',' . $g : '') . "[e{$i}];";
    }
    $filter .= implode('', array_map(static fn($i) => "[e{$i}]", array_keys($ids))) . 'concat=n=' . count($ids) . ':v=0:a=1[aus]';
    $kbit = (int) STREAM_QUALITAETEN[$q]['kbit'];
    $cmd = aw_arg(konfig()['stream']['ffmpeg']) . ' -v error -nostdin -filter_complex_threads 1 ' . implode(' ', $eingaben)
        . ' -filter_complex ' . aw_arg($filter) . ' -map [aus] -c:a libopus -b:a ' . $kbit . 'k -vbr on -compression_level 5 -application audio'
        . ' -f webm -cluster_time_limit 2000 pipe:1';
    ffmpeg_durchreichen($cmd, 'audio/webm', ['X-Dauern' => implode(',', $dauern), 'Access-Control-Expose-Headers' => 'X-Dauern']);
}

/** Cover/Künstlerbild aus dem Cache ausliefern (Schlüssel enthält einen Inhalts-Hash -> lange cachebar). */
function bild_senden(string $art, string $schluessel): void
{
    $pfad = bild_pfad($art, $schluessel, max(32, min(2000, api_int('g', 300))));
    if (!$pfad) {
        throw new ApiFehler(t('Bild nicht gefunden.'), 404);
    }
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    // Kleine Cover als WebP (rund ein Drittel kleiner – wichtig im Mobilnetz), einmalig aus dem JPEG erzeugt und abgelegt
    $webp = false;
    if (strpos((string) ($_SERVER['HTTP_ACCEPT'] ?? ''), 'image/webp') !== false && function_exists('imagewebp') && preg_match('/_(\d+)\.jpg$/', $pfad, $m) && (int) $m[1] <= 600) {
        $wp = substr($pfad, 0, -4) . '.webp';
        if (!is_file($wp) || filemtime($wp) < filemtime($pfad)) {
            $q = @imagecreatefromjpeg($pfad);
            if ($q) {
                $tmp = $wp . '.' . getmypid() . '.tmp';
                if (@imagewebp($q, $tmp, 74) && @rename($tmp, $wp)) {
                    $webp = true;
                } else {
                    @unlink($tmp);
                }
                imagedestroy($q);
            }
        } else {
            $webp = true;
        }
        if ($webp) {
            $pfad = $wp;
        }
    }
    header('Vary: Accept');
    $etag = '"' . substr(md5($pfad . filemtime($pfad)), 0, 16) . '"';
    header('Cache-Control: private, max-age=31536000, immutable');
    header('ETag: ' . $etag);
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        return;
    }
    header('Content-Type: ' . ($webp ? 'image/webp' : 'image/jpeg'));
    header('Content-Length: ' . filesize($pfad));
    readfile($pfad);
}
