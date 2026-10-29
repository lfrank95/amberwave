-- Migration 001: Konten, Anmeldung, Sicherheit (Grundlage aus einem früheren Projekt übernommen)

CREATE TABLE IF NOT EXISTS schema_version (
    version INT NOT NULL PRIMARY KEY,
    angewendet_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vorname VARCHAR(100) NOT NULL,
    nachname VARCHAR(100) NOT NULL,
    benutzername VARCHAR(50) NOT NULL,
    email VARCHAR(255) NOT NULL,
    passwort_hash VARCHAR(255) NOT NULL,
    rolle ENUM('admin','user') NOT NULL DEFAULT 'user',
    status ENUM('pending','aktiv','gesperrt') NOT NULL DEFAULT 'pending',
    aktiviert_am DATETIME NULL,
    gueltigkeit_monate INT NULL,
    gueltig_bis DATETIME NULL,
    muss_passwort_aendern TINYINT(1) NOT NULL DEFAULT 0,
    gesperrt_bis DATETIME NULL,
    sperr_grund VARCHAR(500) NULL,
    gesperrt_am DATETIME NULL,
    mail_info TINYINT(1) NOT NULL DEFAULT 1,
    ablauf_mail_fuer DATETIME NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_name (benutzername),
    UNIQUE KEY uq_users_mail (email),
    INDEX idx_users_status (status),
    INDEX idx_users_gueltig (gueltig_bis)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS remember_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    gueltig_bis DATETIME NOT NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_remember_hash (token_hash),
    CONSTRAINT fk_remember_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    gueltig_bis DATETIME NOT NULL,
    benutzt TINYINT(1) NOT NULL DEFAULT 0,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_reset_hash (token_hash),
    CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS login_versuche (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip_adresse VARCHAR(45) NOT NULL,
    benutzername VARCHAR(255) NOT NULL,
    erfolgreich TINYINT(1) NOT NULL DEFAULT 0,
    zeitstempel DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_login_ip (ip_adresse, zeitstempel),
    INDEX idx_login_name (benutzername, zeitstempel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS registrierungs_versuche (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip_adresse VARCHAR(45) NOT NULL,
    zeitstempel DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_reg_ip (ip_adresse, zeitstempel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sicherheits_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NULL,
    ereignis VARCHAR(100) NOT NULL,
    details TEXT NULL,
    ip_adresse VARCHAR(45) NULL,
    zeitstempel DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sichlog_zeit (zeitstempel),
    CONSTRAINT fk_sichlog_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rate_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    bereich VARCHAR(40) NOT NULL,
    schluessel VARCHAR(190) NOT NULL,
    zeit TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_rate (bereich, schluessel, zeit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Einstellungen aus der Oberfläche (verschlüsselt mit APP_SECRET_KEY)
CREATE TABLE IF NOT EXISTS einstellungen (
    schluessel VARCHAR(60) NOT NULL PRIMARY KEY,
    wert_verschluesselt TEXT NULL,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mail_warteschlange (
    id INT AUTO_INCREMENT PRIMARY KEY,
    an VARCHAR(255) NOT NULL,
    betreff VARCHAR(255) NOT NULL,
    inhalt MEDIUMTEXT NOT NULL,
    versuche TINYINT NOT NULL DEFAULT 0,
    naechster_versuch DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    in_arbeit_seit DATETIME NULL,
    letzter_fehler VARCHAR(300) NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_mail_faellig (versuche, naechster_versuch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Geräte: Browser (Cookie) und Apps (Geräte-Schlüssel) gleichermaßen
CREATE TABLE IF NOT EXISTS nutzer_geraete (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    art ENUM('browser','app') NOT NULL DEFAULT 'browser',
    geraet_hash CHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    ip VARCHAR(64) NOT NULL DEFAULT '',
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    zuletzt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    beendet_am DATETIME NULL,
    ende_grund VARCHAR(20) NULL,
    UNIQUE KEY uq_geraet (user_id, geraet_hash),
    INDEX idx_geraet_aktiv (user_id, beendet_am, zuletzt_am),
    CONSTRAINT fk_geraet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Geräte-Schlüssel für Apps (API-first: späterer Windows-Player meldet sich hiermit an)
CREATE TABLE IF NOT EXISTS api_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    geraet_id INT NOT NULL,
    token_hash CHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    gueltig_bis DATETIME NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    zuletzt_am DATETIME NULL,
    widerrufen_am DATETIME NULL,
    UNIQUE KEY uq_api_token (token_hash),
    CONSTRAINT fk_apitoken_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_apitoken_geraet FOREIGN KEY (geraet_id) REFERENCES nutzer_geraete(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Einstellungen pro Gerät (z. B. Streaming-Qualität, später Ausgabeprofile/Upmix des Windows-Players)
CREATE TABLE IF NOT EXISTS geraet_einstellungen (
    geraet_id INT NOT NULL,
    schluessel VARCHAR(60) NOT NULL,
    wert MEDIUMTEXT NOT NULL,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (geraet_id, schluessel),
    CONSTRAINT fk_geraeteinst_geraet FOREIGN KEY (geraet_id) REFERENCES nutzer_geraete(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
