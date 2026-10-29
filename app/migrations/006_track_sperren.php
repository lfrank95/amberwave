<?php
// Migration 006 (PHP): Titel (Tracks) bekommen gesperrte Felder, damit von Hand Bearbeitetes
// bei Scan und MusicBrainz-Abgleich erhalten bleibt.
declare(strict_types=1);

$st = $pdo->prepare("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tracks' AND COLUMN_NAME = 'gesperrte_felder'");
$st->execute();
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec("ALTER TABLE tracks ADD COLUMN gesperrte_felder VARCHAR(255) NOT NULL DEFAULT ''");
}
