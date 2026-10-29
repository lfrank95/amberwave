<?php
// Freigegebene Aufräum-Pläne im Hintergrund ausführen (Tags/Cover schreiben, umbenennen, Müll in den Papierkorb): php aufraeumen.php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/aufraeumen.php';
set_time_limit(0);
ini_set('memory_limit', '512M');
migrationen_ausfuehren();
if (function_exists('proc_nice')) {
    @proc_nice(10);
}
af_log('Worker gestartet (Hintergrund-Prozess läuft)');
$n = af_stapel();
af_log('Worker beendet', ['bearbeitet' => $n]);
if ($n) {
    echo date('c') . " Aufräumen: {$n} Alben bearbeitet\n";
}
