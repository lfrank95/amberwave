<?php
// Migration 049 (PHP): Cover-Schlüssel und Startzeit je Connect-Auftrag – für die Übertragungs-Ansicht (Cover vom anderen Server über
// unseren Bild-Zwischenspeicher, Tempo und Dauer).
declare(strict_types=1);
foreach ([['cover', "VARCHAR(80) NOT NULL DEFAULT ''"], ['gestartet_am', 'DATETIME NULL']] as [$spalte, $typ]) {
    $da = $pdo->query("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connect_auftraege' AND COLUMN_NAME = '{$spalte}'")->fetchColumn();
    if ((int) $da === 0) {
        $pdo->exec("ALTER TABLE connect_auftraege ADD COLUMN {$spalte} {$typ}");
    }
}
