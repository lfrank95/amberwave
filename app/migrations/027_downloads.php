<?php
// Migration 027 (PHP): Downloads über Prowlarr (Suche) und SABnzbd (Laden) – je Auftrag ein Eintrag mit Status und Import.
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS downloads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nzo_id VARCHAR(80) NULL,
    titel VARCHAR(500) NOT NULL,
    indexer VARCHAR(120) NOT NULL DEFAULT '',
    groesse BIGINT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'gesendet',
    prozent DECIMAL(5,1) NOT NULL DEFAULT 0,
    pfad_sab VARCHAR(1000) NOT NULL DEFAULT '',
    pfad_ziel VARCHAR(1000) NOT NULL DEFAULT '',
    meldung VARCHAR(1000) NOT NULL DEFAULT '',
    user_id INT NULL,
    angelegt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fertig_am DATETIME NULL,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_dl_status (status),
    INDEX idx_dl_nzo (nzo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
