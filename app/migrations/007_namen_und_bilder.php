<?php
// Migration 007 (PHP): „Nachname, Vorname“-Künstler umdrehen und Spalte für die fanart.tv-Prüfung anlegen.
declare(strict_types=1);
require_once __DIR__ . '/../includes/bibliothek.php';

$st = $pdo->prepare("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kuenstler' AND COLUMN_NAME = 'bild_geprueft_am'");
$st->execute();
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE kuenstler ADD COLUMN bild_geprueft_am DATETIME NULL');
}
kuenstler_namen_umdrehen();
