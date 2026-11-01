<?php
// Migration 047 (PHP): Amberwave Connect – gekoppelte Server und Übertragungen zwischen ihnen.
// connect_server:    jede Gegenstelle mit ihrem Ausweis (öffentlicher Schlüssel), Adressbuch und Rechten
// connect_auftraege: was geholt wird (Album, Titel, Playlist) – von wem, in welcher Qualität, wie weit
// connect_dateien:   jede einzelne Datei eines Auftrags (fortsetzbar: wie viele Bytes schon da sind)
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS connect_server (
    id INT AUTO_INCREMENT PRIMARY KEY,
    schluessel CHAR(64) NOT NULL,
    kennung VARCHAR(20) NOT NULL DEFAULT '',
    name VARCHAR(120) NOT NULL DEFAULT '',
    adressen TEXT NULL,
    weg VARCHAR(400) NOT NULL DEFAULT '',
    weg_art VARCHAR(20) NOT NULL DEFAULT '',
    weg_ms INT NULL,
    weg_am DATETIME NULL,
    rechte TEXT NULL,
    dir_erlaubt TEXT NULL,
    version VARCHAR(40) NOT NULL DEFAULT '',
    gekoppelt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    gekoppelt_von INT NULL,
    zuletzt_am DATETIME NULL,
    UNIQUE KEY uq_cs_schluessel (schluessel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS connect_auftraege (
    id INT AUTO_INCREMENT PRIMARY KEY,
    server_id INT NOT NULL,
    art VARCHAR(12) NOT NULL,
    ref VARCHAR(40) NOT NULL,
    titel VARCHAR(400) NOT NULL DEFAULT '',
    unter VARCHAR(400) NOT NULL DEFAULT '',
    qualitaet VARCHAR(16) NOT NULL DEFAULT 'original',
    status VARCHAR(12) NOT NULL DEFAULT 'wartet',
    fehler VARCHAR(500) NOT NULL DEFAULT '',
    bytes BIGINT NOT NULL DEFAULT 0,
    gesamt BIGINT NOT NULL DEFAULT 0,
    dateien INT NOT NULL DEFAULT 0,
    fertig INT NOT NULL DEFAULT 0,
    user_id INT NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fertig_am DATETIME NULL,
    INDEX idx_ca_status (status),
    INDEX idx_ca_server (server_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS connect_dateien (
    id INT AUTO_INCREMENT PRIMARY KEY,
    auftrag_id INT NOT NULL,
    track_ref INT NOT NULL,
    ziel VARCHAR(1000) NOT NULL DEFAULT '',
    groesse BIGINT NOT NULL DEFAULT 0,
    bytes BIGINT NOT NULL DEFAULT 0,
    sha256 CHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(12) NOT NULL DEFAULT 'wartet',
    fehler VARCHAR(500) NOT NULL DEFAULT '',
    INDEX idx_cd_auftrag (auftrag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
