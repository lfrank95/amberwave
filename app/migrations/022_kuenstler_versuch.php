<?php
// Migration 022 (PHP): letzter Versuch, einen Künstler mit MusicBrainz abzugleichen (auch erfolglos) – damit „Metadaten
// vervollständigen“ Künstler, die MusicBrainz nicht (mehr) kennt, nicht bei jedem Lauf erneut fragt (erst nach 30 Tagen).
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'kuenstler', 'c' => 'mb_versuch_am']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE kuenstler ADD COLUMN mb_versuch_am DATETIME NULL');
}
