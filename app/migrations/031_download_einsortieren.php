<?php
// Migration 031 (PHP): Downloads kennen ihre Edition – fürs automatische Einsortieren nach dem MusicBrainz-Abgleich.
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
foreach (['edition_id' => 'INT NULL', 'einsortiert_am' => 'DATETIME NULL'] as $sp => $typ) {
    $st->execute(['t' => 'downloads', 'c' => $sp]);
    if ((int) $st->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE downloads ADD COLUMN {$sp} {$typ}");
    }
}
