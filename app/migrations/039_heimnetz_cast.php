<?php
// Migration 039 (PHP): Geräte im Heimnetz bekommen eine Art – „dlna“ (UPnP-Renderer) oder „cast“ (Google Cast: Android TV,
// Google TV, Nest Hub/Audio, Chromecast, Fernseher und Lautsprecher mit Chromecast built-in). Ein Gerät mit beidem (z. B. ein
// Receiver mit HEOS und Chromecast) erscheint zweimal – darum ist die Adresse nur noch je Art (und Port: Cast-Gruppen laufen auf einem der Geräte) eindeutig.
declare(strict_types=1);
$spalten = $pdo->query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'heimgeraete'")->fetchAll(PDO::FETCH_COLUMN);
if (!in_array('art', $spalten, true)) {
    $pdo->exec("ALTER TABLE heimgeraete ADD COLUMN art VARCHAR(10) NOT NULL DEFAULT 'dlna' AFTER id");
}
$idx = $pdo->query("SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'heimgeraete'")->fetchAll(PDO::FETCH_COLUMN);
if (in_array('uq_heim_ip', $idx, true)) {
    $pdo->exec('ALTER TABLE heimgeraete DROP INDEX uq_heim_ip');
}
if (!in_array('uq_heim_ip_art', $idx, true)) {
    $pdo->exec('ALTER TABLE heimgeraete ADD UNIQUE KEY uq_heim_ip_art (ip, art, steuer_port)');
}
