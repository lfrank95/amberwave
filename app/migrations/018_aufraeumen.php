<?php
// Migration 018 (PHP): Dateien aufräumen – Pläne (Vorschau) und Protokoll.
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS aufraeum_plaene (
    edition_id INT PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'offen',
    plan_json MEDIUMTEXT NULL,
    zusammenfassung VARCHAR(500) NOT NULL DEFAULT '',
    aenderungen INT NOT NULL DEFAULT 0,
    probleme INT NOT NULL DEFAULT 0,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ausgefuehrt_am DATETIME NULL,
    log MEDIUMTEXT NULL,
    INDEX idx_ap_status (status),
    CONSTRAINT fk_ap_edition FOREIGN KEY (edition_id) REFERENCES editionen(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
$pdo->exec("CREATE TABLE IF NOT EXISTS aufraeum_protokoll (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    edition_id INT NULL,
    zeit DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    art VARCHAR(20) NOT NULL,
    von VARCHAR(2000) NOT NULL DEFAULT '',
    nach VARCHAR(2000) NOT NULL DEFAULT '',
    info VARCHAR(500) NOT NULL DEFAULT '',
    INDEX idx_aprot_zeit (zeit),
    INDEX idx_aprot_edition (edition_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
