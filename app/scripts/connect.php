<?php
// Amberwave Connect: offene Übertragungen abarbeiten (wird beim Anlegen eines Auftrags und vom Zeitplan angestoßen)
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/connect_uebertragung.php';
set_time_limit(0);
ini_set('memory_limit', '512M');
migrationen_ausfuehren();
if (function_exists('proc_nice')) {
    @proc_nice(10);   // Streams und Oberfläche gehen vor
}
connect_arbeiten();
