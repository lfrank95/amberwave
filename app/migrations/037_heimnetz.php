<?php
// Migration 037 (PHP): Geräte im Heimnetz (DLNA-Renderer: AV-Receiver, Fernseher, Streamer) – Fähigkeiten, Steuerung
// (Denon/Marantz, Yamaha, Onkyo/Pioneer), Einstellungen und Klang-Profil; zuletzt gelesener Zustand und Protokoll.
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS heimgeraete (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(80) NOT NULL DEFAULT '',
    hersteller VARCHAR(80) NOT NULL DEFAULT '',
    modell VARCHAR(120) NOT NULL DEFAULT '',
    ip VARCHAR(64) NOT NULL,
    udn VARCHAR(120) NOT NULL DEFAULT '',
    beschreibung_url VARCHAR(400) NOT NULL DEFAULT '',
    avt_url VARCHAR(400) NOT NULL DEFAULT '',
    rc_url VARCHAR(400) NOT NULL DEFAULT '',
    cm_url VARCHAR(400) NOT NULL DEFAULT '',
    steuerung VARCHAR(20) NOT NULL DEFAULT '',
    steuer_port INT NOT NULL DEFAULT 0,
    faehig TEXT NULL,
    einst MEDIUMTEXT NULL,
    zustand TEXT NULL,
    protokoll MEDIUMTEXT NULL,
    aktiv TINYINT(1) NOT NULL DEFAULT 1,
    zuletzt_ok DATETIME NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_heim_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
