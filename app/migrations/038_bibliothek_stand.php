<?php
// Migration 038 (PHP): Indexe auf aktualisiert_am von Titeln und Aufnahmen – der „Stand der Bibliothek“ (bib_stand) fragt
// alle zwei Sekunden die jüngste Änderung ab, damit offene Apps neue Metadaten ohne Neuladen übernehmen.
declare(strict_types=1);
foreach ([['tracks', 'idx_track_akt'], ['aufnahmen', 'idx_aufnahme_akt']] as [$tabelle, $index]) {
    $st = $pdo->query("SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{$tabelle}' AND INDEX_NAME = '{$index}'");
    if ((int) $st->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE {$tabelle} ADD INDEX {$index} (aktualisiert_am)");
    }
}
