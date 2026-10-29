<?php
// Migration 012 (PHP): Lautheit nach EBU R128 / ITU BS.1770 – pro Datei (Titel) und pro Edition (Album).
// Histogramme der 400-ms-Blöcke (M) und 3-s-Blöcke (S) machen die exakte Album-Messung möglich.
declare(strict_types=1);
$spalte = function (string $tabelle, string $name, string $def) use ($pdo): void {
    $st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
    $st->execute(['t' => $tabelle, 'c' => $name]);
    if ((int) $st->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE {$tabelle} ADD COLUMN {$name} {$def}");
    }
};
$spalte('dateien', 'lufs', 'DECIMAL(6,2) NULL');
$spalte('dateien', 'lra', 'DECIMAL(5,2) NULL');
$spalte('dateien', 'true_peak', 'DECIMAL(6,2) NULL');
$spalte('dateien', 'sample_peak', 'DECIMAL(6,2) NULL');
$spalte('dateien', 'lautheit_m', 'MEDIUMTEXT NULL');
$spalte('dateien', 'lautheit_s', 'MEDIUMTEXT NULL');
$spalte('dateien', 'lautheit_am', 'DATETIME NULL');
$spalte('dateien', 'lautheit_fehler', "VARCHAR(300) NOT NULL DEFAULT ''");
$spalte('editionen', 'album_lufs', 'DECIMAL(6,2) NULL');
$spalte('editionen', 'album_lra', 'DECIMAL(5,2) NULL');
$spalte('editionen', 'album_true_peak', 'DECIMAL(6,2) NULL');
$spalte('editionen', 'album_sample_peak', 'DECIMAL(6,2) NULL');
$spalte('editionen', 'album_lautheit_am', 'DATETIME NULL');
$st = $pdo->query("SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dateien' AND INDEX_NAME = 'idx_datei_lautheit'");
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('CREATE INDEX idx_datei_lautheit ON dateien (lautheit_am)');
}
