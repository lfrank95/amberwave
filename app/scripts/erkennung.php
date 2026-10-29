<?php
// Erkennung am Klang im Hintergrund (Fingerabdruck → AcoustID → MusicBrainz): php erkennung.php
// Wird vom Zeitplan jede Minute angestoßen, wenn nichts läuft; ein Lauf dauert höchstens ~5 Minuten.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/scanner.php';
require_once __DIR__ . '/../includes/erkennung.php';
set_time_limit(0);
ini_set('memory_limit', '512M');
migrationen_ausfuehren();
if (function_exists('proc_nice')) {
    @proc_nice(10); // niedrige Priorität: Streams und Oberfläche gehen vor
}
if (scan_laufend()) {
    exit(0); // während des Einlesens ändern sich die Editionen noch
}
$n = erk_stapel(280);
if ($n) {
    echo date('c') . " Erkennung: {$n} Alben geprüft\n";
}
