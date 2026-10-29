<?php
// Migration 009 (PHP): Alben können ihre Editionen als eigene Alben zeigen (z. B. Original und Remaster nebeneinander).
declare(strict_types=1);
$st = $pdo->prepare("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alben' AND COLUMN_NAME = 'editionen_einzeln'");
$st->execute();
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE alben ADD COLUMN editionen_einzeln TINYINT(1) NOT NULL DEFAULT 0');
}
