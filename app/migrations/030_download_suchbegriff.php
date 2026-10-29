<?php
// Migration 030 (PHP): Suchbegriff je Download-Auftrag – für „anderes Release suchen“ nach einem Fehlschlag.
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'downloads', 'c' => 'suchbegriff']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec("ALTER TABLE downloads ADD COLUMN suchbegriff VARCHAR(300) NOT NULL DEFAULT ''");
}
