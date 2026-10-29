<?php
// Migration 042 (PHP): Erkennung merkt sich, auf welchem Weg ein Album zugeordnet wurde:
// 'tags' (über Interpret/Titel/MusicBrainz-ID aus den Tags, ohne AcoustID), 'klang' (Fingerabdruck → AcoustID)
// oder 'klang_offen' (von Hand zur Erkennung am Klang vorgemerkt). Bisherige Einträge stammen alle vom Klang.
declare(strict_types=1);
$spalten = $pdo->query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'erkennung'")->fetchAll(PDO::FETCH_COLUMN);
if (!in_array('weg', $spalten, true)) {
    $pdo->exec("ALTER TABLE erkennung ADD COLUMN weg VARCHAR(12) NOT NULL DEFAULT 'klang' AFTER kandidaten, ADD INDEX idx_erk_weg (weg)");
}
