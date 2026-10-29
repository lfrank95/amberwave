<?php
// Migration 033 (PHP): Eigene Presets je Effektgerät (glow, iron, silk, space, eq) und fürs ganze Rack (rack) – pro Konto.
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS effekt_presets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    art VARCHAR(10) NOT NULL,
    name VARCHAR(60) NOT NULL,
    werte MEDIUMTEXT NOT NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    geaendert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_preset_name (user_id, art, name),
    INDEX idx_preset_user (user_id),
    CONSTRAINT fk_preset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
