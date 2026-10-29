<?php
// Migration 035 (PHP): Profilbild je Konto (Schlüssel im Bild-Cache) und eigener Gerätename (überschreibt den automatisch
// aus dem Browser/Client erkannten Namen; leer = wieder automatisch).
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
foreach ([['users', 'bild', "VARCHAR(80) NOT NULL DEFAULT ''"], ['nutzer_geraete', 'eigener_name', 'VARCHAR(80) NULL']] as [$t, $sp, $typ]) {
    $st->execute(['t' => $t, 'c' => $sp]);
    if ((int) $st->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE {$t} ADD COLUMN {$sp} {$typ}");
    }
}
