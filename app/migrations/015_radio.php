<?php
// Migration 015 (PHP): Für das lernende Radio – übersprungene Titel und woher eine Wiedergabe kam.
declare(strict_types=1);
$spalte = function (string $tabelle, string $name, string $def) use ($pdo): void {
    $st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
    $st->execute(['t' => $tabelle, 'c' => $name]);
    if ((int) $st->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE {$tabelle} ADD COLUMN {$name} {$def}");
    }
};
$spalte('wiedergaben', 'uebersprungen', 'TINYINT(1) NOT NULL DEFAULT 0');
$spalte('wiedergaben', 'quelle', "VARCHAR(20) NOT NULL DEFAULT ''");
$st = $pdo->query("SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wiedergaben' AND INDEX_NAME = 'idx_wg_zeit'");
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE wiedergaben ADD INDEX idx_wg_zeit (gestartet_am)');
}
