<?php
// Migration 044 (PHP): mehrere Suchanbieter (Prowlarr, Newznab-Indexer) und SABnzbd-kompatible Downloadclients.
// Der bisherige Prowlarr und der bisherige SABnzbd bleiben als „Standard“ in den Einstellungen (id 0) – hier stehen nur die
// zusätzlichen. Jeder Auftrag merkt sich seinen Downloadclient (client_id, NULL = Standard) und woher er kam (quelle_id).
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS download_dienste (
    id INT AUTO_INCREMENT PRIMARY KEY,
    art VARCHAR(20) NOT NULL,
    name VARCHAR(80) NOT NULL DEFAULT '',
    url VARCHAR(500) NOT NULL DEFAULT '',
    api_pfad VARCHAR(200) NOT NULL DEFAULT '',
    api_key TEXT NULL,
    kategorien VARCHAR(200) NOT NULL DEFAULT '',
    client_id INT NULL,
    import_ordner VARCHAR(300) NOT NULL DEFAULT '',
    musiksuche TINYINT NOT NULL DEFAULT 1,
    aktiv TINYINT NOT NULL DEFAULT 1,
    caps TEXT NULL,
    reihenfolge INT NOT NULL DEFAULT 0,
    angelegt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_dd_art (art)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
foreach (['client_id' => 'INT NULL', 'quelle_id' => 'INT NULL', 'quelle_art' => "VARCHAR(20) NOT NULL DEFAULT ''", 'guid' => "VARCHAR(500) NOT NULL DEFAULT ''"] as $sp => $typ) {
    $st->execute(['t' => 'downloads', 'c' => $sp]);
    if ((int) $st->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE downloads ADD COLUMN {$sp} {$typ}");
    }
}
