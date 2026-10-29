<?php
// Migration 020 (PHP): Album als „Kein Treffer bei MusicBrainz, so lassen“ markieren (taucht nicht mehr unter „Ohne MusicBrainz“ auf).
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'alben', 'c' => 'mb_ohne']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE alben ADD COLUMN mb_ohne TINYINT(1) NOT NULL DEFAULT 0');
}
