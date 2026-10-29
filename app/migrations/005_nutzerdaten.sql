-- Migration 005: Daten pro Nutzer – Favoriten, Hörverlauf, Weiterhören, Playlists, Warteschlange

CREATE TABLE IF NOT EXISTS favoriten (
    user_id INT NOT NULL,
    art ENUM('album','kuenstler','track','playlist') NOT NULL,
    objekt_id INT NOT NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, art, objekt_id),
    CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wiedergaben (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    track_id INT NOT NULL,
    edition_id INT NULL,
    geraet_id INT NULL,
    gestartet_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    gehoert_sekunden INT NOT NULL DEFAULT 0,
    gezaehlt TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_wg_user (user_id, gestartet_am),
    INDEX idx_wg_track (track_id),
    CONSTRAINT fk_wg_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_wg_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Weiterhören": zuletzt gehörte Editionen mit Position
CREATE TABLE IF NOT EXISTS weiterhoeren (
    user_id INT NOT NULL,
    edition_id INT NOT NULL,
    track_id INT NULL,
    position_sek INT NOT NULL DEFAULT 0,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, edition_id),
    INDEX idx_wh_zeit (user_id, aktualisiert_am),
    CONSTRAINT fk_wh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_wh_edition FOREIGN KEY (edition_id) REFERENCES editionen(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS playlists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(200) NOT NULL,
    beschreibung TEXT NULL,
    familie TINYINT(1) NOT NULL DEFAULT 0,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_pl_user (user_id),
    INDEX idx_pl_familie (familie),
    CONSTRAINT fk_pl_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS playlist_eintraege (
    id INT AUTO_INCREMENT PRIMARY KEY,
    playlist_id INT NOT NULL,
    track_id INT NOT NULL,
    pos INT NOT NULL,
    hinzugefuegt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ple_pl (playlist_id, pos),
    CONSTRAINT fk_ple_pl FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    CONSTRAINT fk_ple_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Warteschlange pro Gerät (Grundlage für Fortsetzen und spätere Fernbedienung)
CREATE TABLE IF NOT EXISTS warteschlangen (
    geraet_id INT NOT NULL PRIMARY KEY,
    user_id INT NOT NULL,
    inhalt MEDIUMTEXT NOT NULL,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ws_geraet FOREIGN KEY (geraet_id) REFERENCES nutzer_geraete(id) ON DELETE CASCADE,
    CONSTRAINT fk_ws_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
