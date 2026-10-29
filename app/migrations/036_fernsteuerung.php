<?php
// Migration 036 (PHP): Fernsteuerung – welches Gerät ist gerade da (Rückkanal offen), was spielt es, wen steuert es;
// Befehle an ein Gerät (werden über seinen Rückkanal abgeholt und nach kurzer Zeit verworfen).
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS fern_praesenz (
    geraet_id INT NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    ziel_id INT NULL,
    zustand MEDIUMTEXT NULL,
    zustand_ver INT NOT NULL DEFAULT 0,
    liste MEDIUMTEXT NULL,
    liste_ver INT NOT NULL DEFAULT 0,
    kanal_am DATETIME(3) NULL,
    zuletzt_am DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_fern_user (user_id),
    INDEX idx_fern_ziel (ziel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
$pdo->exec("CREATE TABLE IF NOT EXISTS fern_befehle (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ziel_id INT NOT NULL,
    von_id INT NOT NULL,
    von_user INT NOT NULL,
    befehl VARCHAR(20) NOT NULL,
    daten MEDIUMTEXT NULL,
    erstellt_am DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_fern_befehl_ziel (ziel_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
