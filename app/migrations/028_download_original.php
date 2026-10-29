<?php
// Migration 028 (PHP): ob das Original eines importierten Downloads aus dem Download-Ordner entfernt ist (Aufräumen nach dem Import).
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'downloads', 'c' => 'original_weg']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE downloads ADD COLUMN original_weg TINYINT NOT NULL DEFAULT 0');
}
