<?php
// Linux (Docker) und Windows (Amberwave Windows Server) aus einem Code: alles, was Programme startet oder Pfade vergleicht,
// geht über diese Helfer. Unter Linux verhalten sie sich exakt wie die bisherigen Aufrufe.
declare(strict_types=1);

if (!function_exists('aw_windows')) {

function aw_windows(): bool
{
    return PHP_OS_FAMILY === 'Windows';
}

/** Das „Nichts“-Gerät für Umleitungen und proc_open */
function aw_null(): string
{
    return aw_windows() ? 'NUL' : '/dev/null';
}

/** Ein Argument für die Kommandozeile. Unter Windows: Anführungszeichen nach den Regeln von CreateProcess (escapeshellarg
 *  ersetzt dort %, ! und " durch Leerzeichen – „Wham!“ würde zu „Wham “). */
function aw_arg(string $s): string
{
    if (!aw_windows()) {
        return escapeshellarg($s);
    }
    $aus = '"';
    $bs = 0;
    $n = strlen($s);
    for ($i = 0; $i < $n; $i++) {
        $c = $s[$i];
        if ($c === '\\') {
            $bs++;
            continue;
        }
        if ($c === '"') {
            $aus .= str_repeat('\\', $bs * 2 + 1) . '"';
        } else {
            $aus .= str_repeat('\\', $bs) . $c;
        }
        $bs = 0;
    }
    return $aus . str_repeat('\\', $bs * 2) . '"';
}

/** Stderr verwerfen: ' 2>/dev/null' bzw. ' 2>NUL' */
function aw_ohne_fehler(): string
{
    return ' 2>' . aw_null();
}

/** Befehl im Hintergrund starten, Ausgabe verwerfen oder an $log anhängen ($anhaengen) bzw. überschreiben */
function aw_hintergrund(string $befehl, ?string $log = null, bool $anhaengen = false): void
{
    $ziel = ($anhaengen ? ' >> ' : ' > ') . ($log !== null ? aw_arg($log) : aw_null()) . ' 2>&1';
    if (aw_windows()) {
        // start /B: ohne eigenes Fenster, ohne zu warten; das leere "" ist der Fenstertitel
        $p = @popen('start "" /B ' . $befehl . $ziel, 'r');
        if ($p !== false) {
            pclose($p);
        }
        return;
    }
    exec($befehl . $ziel . ' &');
}

/** Umgebungsvariablen nur für diesen Befehl: 'A=1 B=2 befehl' bzw. unter Windows 'set "A=1" && set "B=2" && befehl' */
function aw_mit_umgebung(array $env, string $befehl): string
{
    $teile = [];
    foreach ($env as $k => $v) {
        $teile[] = aw_windows() ? 'set "' . $k . '=' . str_replace('"', '', (string) $v) . '"' : $k . '=' . escapeshellarg((string) $v);
    }
    if (!$teile) {
        return $befehl;
    }
    return aw_windows() ? implode(' && ', $teile) . ' && ' . $befehl : implode(' ', $teile) . ' ' . $befehl;
}

/** Vollständiger Pfad eines Programms aus PATH (unter Windows mit .exe/.cmd/.bat) – null = nicht gefunden */
function aw_programm(string $name): ?string
{
    if ($name === '') {
        return null;
    }
    if (str_contains($name, '/') || str_contains($name, '\\')) {
        return is_file($name) ? $name : (aw_windows() && is_file($name . '.exe') ? $name . '.exe' : null);
    }
    $endungen = aw_windows() ? array_merge([''], array_map('strtolower', explode(';', (string) (getenv('PATHEXT') ?: '.EXE;.CMD;.BAT')))) : [''];
    foreach (explode(PATH_SEPARATOR, (string) getenv('PATH')) as $ordner) {
        $ordner = trim($ordner, " \"");
        if ($ordner === '') {
            continue;
        }
        foreach ($endungen as $e) {
            $p = rtrim($ordner, '/\\') . DIRECTORY_SEPARATOR . $name . $e;
            if (is_file($p) && (aw_windows() || is_executable($p))) {
                return $p;
            }
        }
    }
    return null;
}

/** PHP für Hintergrundskripte (unter dem Webserver ist PHP_BINARY der Webserver selbst). AW_PHP_CLI setzt der Windows-Server. */
function aw_php(): string
{
    $e = (string) getenv('AW_PHP_CLI');
    if ($e !== '') {
        return $e;
    }
    if (!aw_windows()) {
        return is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    }
    if (PHP_SAPI === 'cli' && is_file(PHP_BINARY)) {
        return PHP_BINARY;
    }
    return aw_programm('php') ?? 'php';
}

/** Ziel für stderr bei proc_open: unter Windows eine Datei (Pipes lassen sich dort nicht nicht-blockierend lesen – ffmpeg
 *  bliebe stehen, sobald eine der beiden Leitungen voll ist), sonst wie bisher eine Pipe. */
function aw_stderr_ziel(?string &$datei): array
{
    if (!aw_windows()) {
        $datei = null;
        return ['pipe', 'w'];
    }
    $datei = (string) tempnam(sys_get_temp_dir(), 'awf');
    return ['file', $datei, 'w'];
}

/** Bisherige Fehlerausgabe lesen (Windows: erst am Ende, aus der Datei) */
function aw_stderr_lesen(array $pipes, ?string $datei, bool $ende = false): string
{
    if ($datei === null) {
        return isset($pipes[2]) ? (string) stream_get_contents($pipes[2]) : '';
    }
    return $ende ? (string) @file_get_contents($datei) : '';
}

function aw_stderr_schliessen(array $pipes, ?string $datei): void
{
    if ($datei === null) {
        if (isset($pipes[2]) && is_resource($pipes[2])) {
            fclose($pipes[2]);
        }
        return;
    }
    @unlink($datei);
}

/** Pfad mit / als Trenner (Windows liefert \) – Vergleiche wie „liegt unter dem Musikordner?“ funktionieren dann überall */
function aw_pfad(string $p): string
{
    return aw_windows() ? str_replace('\\', '/', $p) : $p;
}

/** realpath mit einheitlichem Trenner */
function aw_realpath(string $p): string|false
{
    $r = realpath($p);
    return $r === false ? false : aw_pfad($r);
}

/** Ordner samt Inhalt löschen (ersetzt rm -rf) */
function aw_ordner_loeschen(string $ordner): void
{
    if (!is_dir($ordner) || is_link($ordner)) {
        @unlink($ordner);
        return;
    }
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($ordner, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $f) {
        $f->isDir() && !$f->isLink() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
    }
    @rmdir($ordner);
}

}
