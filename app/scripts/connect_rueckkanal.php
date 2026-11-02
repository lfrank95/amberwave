<?php
// Amberwave Connect – Rückkanal: dieser Server ist von außen nicht erreichbar (z. B. hinter CGNAT, ohne Tunnel) und hält
// bei gekoppelten Servern mit Adresse eine Anfrage offen, über die sie ihn erreichen. Gestartet vom Zeitplan.
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
if (!empty($argv[1]) && str_ends_with((string) $argv[1], '.auftrag')) {
    connect_rueck_auftrag_datei((string) $argv[1]);   // eine einzelne hereingereichte Anfrage ausführen
} else {
    connect_rueckkanal_laufen();
}
