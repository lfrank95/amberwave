<?php
// Hintergrundauftrag abarbeiten: php auftrag.php <metadaten|vorschau|fanart>
// Wird beim Start eines Auftrags sofort und danach vom Zeitplan jede Minute angestoßen, solange er läuft.
// Ein Prozess arbeitet höchstens ~10 Minuten, dann übernimmt der nächste.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/scanner.php';
require_once __DIR__ . '/../includes/api.php';
require_once __DIR__ . '/../includes/api_metadaten.php';
require_once __DIR__ . '/../includes/metadatenjob.php';
require_once __DIR__ . '/../includes/zuflac.php';
$typ = (string) ($argv[1] ?? '');
if (!in_array($typ, AUFTRAG_TYPEN, true)) {
    fwrite(STDERR, "Unbekannter Auftrag: {$typ}\n");
    exit(1);
}
set_time_limit(0);
ini_set('memory_limit', '512M');
migrationen_ausfuehren();
if (function_exists('proc_nice')) {
    @proc_nice(10); // niedrige Priorität: Streams und Oberfläche gehen vor
}
auftrag_ausfuehren($typ);
