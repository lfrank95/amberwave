<?php
// Migration 016 (PHP): Erkennung per akustischem Fingerabdruck (Chromaprint/AcoustID → MusicBrainz).
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS fingerabdruecke (
    datei_id INT PRIMARY KEY,
    datei_mtime INT NOT NULL DEFAULT 0,
    fp MEDIUMTEXT NULL,
    dauer INT NOT NULL DEFAULT 0,
    aufnahmen MEDIUMTEXT NULL,
    erstellt_am DATETIME NULL,
    abgefragt_am DATETIME NULL,
    fehler VARCHAR(300) NOT NULL DEFAULT '',
    CONSTRAINT fk_fp_datei FOREIGN KEY (datei_id) REFERENCES dateien(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
$pdo->exec("CREATE TABLE IF NOT EXISTS erkennung (
    edition_id INT PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'offen',
    sicherheit TINYINT NOT NULL DEFAULT 0,
    mbid CHAR(36) NULL,
    info VARCHAR(500) NOT NULL DEFAULT '',
    kandidaten MEDIUMTEXT NULL,
    geprueft_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_erk_status (status),
    CONSTRAINT fk_erk_edition FOREIGN KEY (edition_id) REFERENCES editionen(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
