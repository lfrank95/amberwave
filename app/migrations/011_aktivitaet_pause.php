<?php
// Migration 011 (PHP): seit wann eine Wiedergabe pausiert ist (lange Pausen verschwinden aus der Aktivität)
declare(strict_types=1);
$st = $pdo->prepare("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aktive_wiedergaben' AND COLUMN_NAME = 'pausiert_seit'");
$st->execute();
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE aktive_wiedergaben ADD COLUMN pausiert_seit DATETIME NULL');
}
