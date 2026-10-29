<?php
// Migration 014 (PHP): Lautheitskurve je Datei (für die Nerd-Ansicht im Player)
declare(strict_types=1);
$hat = (bool) $pdo->query("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dateien' AND COLUMN_NAME = 'lautheit_kurve'")->fetchColumn();
if (!$hat) {
    $pdo->exec('ALTER TABLE dateien ADD COLUMN lautheit_kurve MEDIUMTEXT NULL');
}
