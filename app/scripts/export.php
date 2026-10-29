<?php
// WAV-Exporte im Hintergrund abarbeiten (einer nach dem anderen): php export.php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/api.php';
require_once __DIR__ . '/../includes/bibliothek.php';
require_once __DIR__ . '/../includes/export.php';
set_time_limit(0);
ini_set('memory_limit', '512M');
migrationen_ausfuehren();

$sperre = fopen(export_sperre_pfad(), 'c');
if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
    exit(0); // läuft schon
}
for ($runde = 0; $runde < 100; $runde++) {
    $id = (int) db_wert("SELECT id FROM exporte WHERE status = 'wartet' ORDER BY erstellt_am, id LIMIT 1");
    if (!$id) {
        break;
    }
    export_ausfuehren($id);
}
flock($sperre, LOCK_UN);
fclose($sperre);
