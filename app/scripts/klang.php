<?php
// Klanganalyse im Hintergrund: php klang.php – vom Zeitplan jede Minute angestoßen, solange etwas offen ist.
// Ein Lauf dauert höchstens ~5 Minuten (niedrige Priorität), danach wird bei Bedarf der Index der Nachbarn neu berechnet.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/scanner.php';
require_once __DIR__ . '/../includes/api.php';
require_once __DIR__ . '/../includes/klang.php';
set_time_limit(0);
ini_set('memory_limit', '1024M');
migrationen_ausfuehren();
if (function_exists('proc_nice')) {
    @proc_nice(15); // Streams und Oberfläche gehen immer vor
}
kl_lauf(280);
