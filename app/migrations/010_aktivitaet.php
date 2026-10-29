<?php
// Migration 010 (PHP): Was läuft gerade wo? (für das Dashboard „Aktivität“ in der Verwaltung)
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS aktive_wiedergaben (
    schluessel VARCHAR(40) NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    geraet_id INT NULL,
    track_id INT NOT NULL,
    position_sek DECIMAL(10,2) NOT NULL DEFAULT 0,
    dauer_sek DECIMAL(10,2) NOT NULL DEFAULT 0,
    spielt TINYINT(1) NOT NULL DEFAULT 0,
    verbindung VARCHAR(12) NOT NULL DEFAULT 'extern',
    ip VARCHAR(64) NOT NULL DEFAULT '',
    details TEXT NULL,
    gestartet_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_aktiv_zeit (aktualisiert_am),
    CONSTRAINT fk_aktiv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
