<?php
// Sortier-Assistent im Hintergrund (Analyse, Einsortieren, Verknüpfen): php sortieren.php
// Wird vom Zeitplan jede Minute angestoßen, solange eine Phase offen ist; ein Lauf dauert höchstens ~5 Minuten.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/sortieren.php';
set_time_limit(0);
ini_set('memory_limit', '768M');
migrationen_ausfuehren();
if (function_exists('proc_nice')) {
    @proc_nice(10); // niedrige Priorität: Streams und Oberfläche gehen vor
}
srt_lauf(280);
