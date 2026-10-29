<?php
// Migration 013 (PHP): WAV-Exporte (z. B. eine Playlist als eine lange Datei fürs Mischpult)
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS exporte (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(200) NOT NULL,
    quelle VARCHAR(200) NOT NULL DEFAULT '',
    track_ids MEDIUMTEXT NOT NULL,
    optionen TEXT NOT NULL,
    status ENUM('wartet','laeuft','fertig','fehler','abgebrochen') NOT NULL DEFAULT 'wartet',
    schritt VARCHAR(200) NOT NULL DEFAULT '',
    fortschritt DECIMAL(5,1) NOT NULL DEFAULT 0,
    dauer_sek DECIMAL(12,3) NOT NULL DEFAULT 0,
    teile MEDIUMTEXT NULL,
    titelliste MEDIUMTEXT NULL,
    fehler TEXT NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    gestartet_am DATETIME NULL,
    fertig_am DATETIME NULL,
    lebenszeichen DATETIME NULL,
    INDEX idx_export_user (user_id, erstellt_am),
    INDEX idx_export_status (status),
    CONSTRAINT fk_export_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
