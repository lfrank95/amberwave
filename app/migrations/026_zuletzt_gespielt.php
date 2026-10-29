<?php
// Migration 026 (PHP): wann eine Datei zuletzt gestreamt wurde – das Aufräumen lässt Alben in Wiedergabe in Ruhe.
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'dateien', 'c' => 'zuletzt_gespielt']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE dateien ADD COLUMN zuletzt_gespielt DATETIME NULL');
}
