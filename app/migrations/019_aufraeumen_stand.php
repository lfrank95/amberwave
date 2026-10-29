<?php
// Migration 019 (PHP): Fingerabdruck der Einstellungen je Aufräum-Plan – veraltete Vorschauen werden neu gerechnet.
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'aufraeum_plaene', 'c' => 'stand']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec("ALTER TABLE aufraeum_plaene ADD COLUMN stand VARCHAR(40) NOT NULL DEFAULT ''");
}
