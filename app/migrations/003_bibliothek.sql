-- Migration 003: Musikbibliothek, angelehnt an das Datenmodell von MusicBrainz.
-- Album = Release Group, Edition = Release, Datenträger = Medium, Track = Track,
-- Aufnahme = Recording, Werk = Work. Künstler-Credits sind Listen echter Künstler-Objekte.
-- mbid ist überall optional: Einträge ohne MusicBrainz-Bezug sind ausdrücklich erlaubt.

CREATE TABLE IF NOT EXISTS kuenstler (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mbid CHAR(36) NULL,
    name VARCHAR(500) NOT NULL,
    name_norm VARCHAR(255) NOT NULL,
    sortname VARCHAR(500) NOT NULL DEFAULT '',
    typ ENUM('person','gruppe','orchester','chor','figur','sonstiges') NULL,
    unterscheidung VARCHAR(255) NOT NULL DEFAULT '',
    land VARCHAR(10) NOT NULL DEFAULT '',
    beginn VARCHAR(10) NOT NULL DEFAULT '',
    ende VARCHAR(10) NOT NULL DEFAULT '',
    bio TEXT NULL,
    bio_quelle VARCHAR(500) NOT NULL DEFAULT '',
    bio_maschinell TINYINT(1) NOT NULL DEFAULT 0,
    bild_datei VARCHAR(255) NOT NULL DEFAULT '',
    bild_quelle VARCHAR(30) NOT NULL DEFAULT '',
    quelle ENUM('tags','musicbrainz','manuell') NOT NULL DEFAULT 'tags',
    gesperrte_felder VARCHAR(1000) NOT NULL DEFAULT '',
    mb_abgleich_am DATETIME NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_kuenstler_mbid (mbid),
    INDEX idx_kuenstler_norm (name_norm),
    INDEX idx_kuenstler_akt (aktualisiert_am)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kuenstler_aliase (
    id INT AUTO_INCREMENT PRIMARY KEY,
    kuenstler_id INT NOT NULL,
    name VARCHAR(500) NOT NULL,
    sortname VARCHAR(500) NOT NULL DEFAULT '',
    sprache VARCHAR(10) NOT NULL DEFAULT '',
    typ VARCHAR(30) NOT NULL DEFAULT '',
    primaer TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_alias_kuenstler (kuenstler_id),
    CONSTRAINT fk_alias_kuenstler FOREIGN KEY (kuenstler_id) REFERENCES kuenstler(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "Bruno Mars & Lady Gaga" = ein Credit mit zwei Einträgen, jeder zeigt auf einen echten Künstler
CREATE TABLE IF NOT EXISTS credits (
    id INT AUTO_INCREMENT PRIMARY KEY,
    schluessel CHAR(64) NOT NULL,
    anzeige VARCHAR(1000) NOT NULL,
    UNIQUE KEY uq_credit_schluessel (schluessel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS credit_namen (
    credit_id INT NOT NULL,
    pos TINYINT NOT NULL,
    kuenstler_id INT NOT NULL,
    name_als VARCHAR(500) NOT NULL,
    verbindung VARCHAR(60) NOT NULL DEFAULT '',
    PRIMARY KEY (credit_id, pos),
    INDEX idx_creditname_kuenstler (kuenstler_id),
    CONSTRAINT fk_creditname_credit FOREIGN KEY (credit_id) REFERENCES credits(id) ON DELETE CASCADE,
    CONSTRAINT fk_creditname_kuenstler FOREIGN KEY (kuenstler_id) REFERENCES kuenstler(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS alben (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mbid CHAR(36) NULL,
    titel VARCHAR(500) NOT NULL,
    credit_id INT NULL,
    typ ENUM('album','single','ep','broadcast','sonstiges') NOT NULL DEFAULT 'album',
    zusatz_typen VARCHAR(200) NOT NULL DEFAULT '',
    erstjahr SMALLINT NULL,
    erst_datum VARCHAR(10) NOT NULL DEFAULT '',
    beschreibung TEXT NULL,
    beschreibung_quelle VARCHAR(500) NOT NULL DEFAULT '',
    beschreibung_maschinell TINYINT(1) NOT NULL DEFAULT 0,
    edition_wahl_id INT NULL,
    anzeige_edition_id INT NULL,
    hinzugefuegt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    quelle ENUM('tags','musicbrainz','manuell') NOT NULL DEFAULT 'tags',
    gesperrte_felder VARCHAR(1000) NOT NULL DEFAULT '',
    mb_abgleich_am DATETIME NULL,
    suchtext VARCHAR(1500) NOT NULL DEFAULT '',
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_album_mbid (mbid),
    INDEX idx_album_credit (credit_id),
    INDEX idx_album_hinzu (hinzugefuegt_am),
    INDEX idx_album_jahr (erstjahr),
    INDEX idx_album_akt (aktualisiert_am),
    INDEX idx_album_anzeige (anzeige_edition_id),
    CONSTRAINT fk_album_credit FOREIGN KEY (credit_id) REFERENCES credits(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS editionen (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mbid CHAR(36) NULL,
    album_id INT NOT NULL,
    titel VARCHAR(500) NOT NULL,
    credit_id INT NULL,
    datum VARCHAR(10) NOT NULL DEFAULT '',
    jahr SMALLINT NULL,
    land VARCHAR(10) NOT NULL DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT '',
    barcode VARCHAR(40) NOT NULL DEFAULT '',
    format_text VARCHAR(120) NOT NULL DEFAULT '',
    kommentar VARCHAR(255) NOT NULL DEFAULT '',
    ordner VARCHAR(2000) NOT NULL DEFAULT '',
    ordner_hash CHAR(64) NULL,
    gruppe_hash CHAR(64) NULL,
    cover_datei VARCHAR(255) NOT NULL DEFAULT '',
    cover_quelle VARCHAR(30) NOT NULL DEFAULT '',
    cover_signatur VARCHAR(64) NOT NULL DEFAULT '',
    anzahl_tracks INT NOT NULL DEFAULT 0,
    anzahl_dateien INT NOT NULL DEFAULT 0,
    laenge_ms BIGINT NOT NULL DEFAULT 0,
    beste_qualitaet VARCHAR(40) NOT NULL DEFAULT '',
    quelle ENUM('tags','musicbrainz','manuell') NOT NULL DEFAULT 'tags',
    gesperrte_felder VARCHAR(1000) NOT NULL DEFAULT '',
    mb_abgleich_am DATETIME NULL,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_edition_mbid (mbid),
    INDEX idx_edition_album (album_id),
    INDEX idx_edition_ordner (ordner_hash),
    INDEX idx_edition_gruppe (gruppe_hash),
    INDEX idx_edition_akt (aktualisiert_am),
    CONSTRAINT fk_edition_album FOREIGN KEY (album_id) REFERENCES alben(id) ON DELETE CASCADE,
    CONSTRAINT fk_edition_credit FOREIGN KEY (credit_id) REFERENCES credits(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS datentraeger (
    id INT AUTO_INCREMENT PRIMARY KEY,
    edition_id INT NOT NULL,
    pos SMALLINT NOT NULL DEFAULT 1,
    format VARCHAR(40) NOT NULL DEFAULT '',
    titel VARCHAR(500) NOT NULL DEFAULT '',
    UNIQUE KEY uq_datentraeger (edition_id, pos),
    CONSTRAINT fk_datentraeger_edition FOREIGN KEY (edition_id) REFERENCES editionen(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS aufnahmen (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mbid CHAR(36) NULL,
    titel VARCHAR(500) NOT NULL,
    credit_id INT NULL,
    laenge_ms INT NULL,
    kommentar VARCHAR(255) NOT NULL DEFAULT '',
    quelle ENUM('tags','musicbrainz','manuell') NOT NULL DEFAULT 'tags',
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_aufnahme_mbid (mbid),
    INDEX idx_aufnahme_credit (credit_id),
    CONSTRAINT fk_aufnahme_credit FOREIGN KEY (credit_id) REFERENCES credits(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tracks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mbid CHAR(36) NULL,
    datentraeger_id INT NOT NULL,
    pos SMALLINT NOT NULL,
    nummer VARCHAR(20) NOT NULL DEFAULT '',
    titel VARCHAR(500) NOT NULL,
    credit_id INT NULL,
    aufnahme_id INT NULL,
    laenge_ms INT NULL,
    suchtext VARCHAR(1500) NOT NULL DEFAULT '',
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    aktualisiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_track_dt (datentraeger_id, pos),
    INDEX idx_track_aufnahme (aufnahme_id),
    INDEX idx_track_credit (credit_id),
    INDEX idx_track_mbid (mbid),
    CONSTRAINT fk_track_dt FOREIGN KEY (datentraeger_id) REFERENCES datentraeger(id) ON DELETE CASCADE,
    CONSTRAINT fk_track_credit FOREIGN KEY (credit_id) REFERENCES credits(id) ON DELETE SET NULL,
    CONSTRAINT fk_track_aufnahme FOREIGN KEY (aufnahme_id) REFERENCES aufnahmen(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS werke (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mbid CHAR(36) NULL,
    titel VARCHAR(500) NOT NULL,
    typ VARCHAR(40) NOT NULL DEFAULT '',
    sprache VARCHAR(10) NOT NULL DEFAULT '',
    quelle ENUM('tags','musicbrainz','manuell') NOT NULL DEFAULT 'tags',
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_werk_mbid (mbid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS aufnahme_werke (
    aufnahme_id INT NOT NULL,
    werk_id INT NOT NULL,
    PRIMARY KEY (aufnahme_id, werk_id),
    CONSTRAINT fk_aw_aufnahme FOREIGN KEY (aufnahme_id) REFERENCES aufnahmen(id) ON DELETE CASCADE,
    CONSTRAINT fk_aw_werk FOREIGN KEY (werk_id) REFERENCES werke(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS labels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mbid CHAR(36) NULL,
    name VARCHAR(500) NOT NULL,
    name_norm VARCHAR(255) NOT NULL,
    UNIQUE KEY uq_label_mbid (mbid),
    INDEX idx_label_norm (name_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS edition_labels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    edition_id INT NOT NULL,
    label_id INT NULL,
    katalognummer VARCHAR(100) NOT NULL DEFAULT '',
    INDEX idx_el_edition (edition_id),
    INDEX idx_el_label (label_id),
    CONSTRAINT fk_el_edition FOREIGN KEY (edition_id) REFERENCES editionen(id) ON DELETE CASCADE,
    CONSTRAINT fk_el_label FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Beziehungstypen (Rollen): Produzent, Musiker, Songwriter, Bandmitglied …
CREATE TABLE IF NOT EXISTS beziehungstypen (
    id INT AUTO_INCREMENT PRIMARY KEY,
    schluessel VARCHAR(60) NOT NULL,
    mb_name VARCHAR(100) NOT NULL DEFAULT '',
    name_de VARCHAR(100) NOT NULL,
    gruppe ENUM('produktion','musiker','songwriting','technik','band','sonstiges') NOT NULL DEFAULT 'sonstiges',
    reihenfolge SMALLINT NOT NULL DEFAULT 100,
    UNIQUE KEY uq_beztyp (schluessel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS instrumente (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mbid CHAR(36) NULL,
    name VARCHAR(200) NOT NULL,
    name_de VARCHAR(200) NOT NULL DEFAULT '',
    UNIQUE KEY uq_instrument_mbid (mbid),
    UNIQUE KEY uq_instrument_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Eine allgemeine Beziehung: Objekt A –(Typ)→ Objekt B, z. B. Künstler –Produzent→ Edition
CREATE TABLE IF NOT EXISTS beziehungen (
    id INT AUTO_INCREMENT PRIMARY KEY,
    typ_id INT NOT NULL,
    von_art ENUM('kuenstler','album','edition','aufnahme','werk','label') NOT NULL,
    von_id INT NOT NULL,
    zu_art ENUM('kuenstler','album','edition','aufnahme','werk','label') NOT NULL,
    zu_id INT NOT NULL,
    attribute VARCHAR(500) NOT NULL DEFAULT '',
    name_als VARCHAR(500) NOT NULL DEFAULT '',
    beginn VARCHAR(10) NOT NULL DEFAULT '',
    ende VARCHAR(10) NOT NULL DEFAULT '',
    quelle ENUM('tags','musicbrainz','manuell') NOT NULL DEFAULT 'tags',
    pos SMALLINT NOT NULL DEFAULT 0,
    erstellt_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_bez_von (von_art, von_id),
    INDEX idx_bez_zu (zu_art, zu_id),
    INDEX idx_bez_typ (typ_id),
    CONSTRAINT fk_bez_typ FOREIGN KEY (typ_id) REFERENCES beziehungstypen(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS beziehung_instrumente (
    beziehung_id INT NOT NULL,
    instrument_id INT NOT NULL,
    PRIMARY KEY (beziehung_id, instrument_id),
    CONSTRAINT fk_bi_bez FOREIGN KEY (beziehung_id) REFERENCES beziehungen(id) ON DELETE CASCADE,
    CONSTRAINT fk_bi_instr FOREIGN KEY (instrument_id) REFERENCES instrumente(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Genres/Schlagworte, frei vergeben
CREATE TABLE IF NOT EXISTS genres (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    name_norm VARCHAR(120) NOT NULL,
    UNIQUE KEY uq_genre_norm (name_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS album_genres (
    album_id INT NOT NULL,
    genre_id INT NOT NULL,
    quelle ENUM('tags','musicbrainz','manuell') NOT NULL DEFAULT 'tags',
    PRIMARY KEY (album_id, genre_id),
    INDEX idx_ag_genre (genre_id),
    CONSTRAINT fk_ag_album FOREIGN KEY (album_id) REFERENCES alben(id) ON DELETE CASCADE,
    CONSTRAINT fk_ag_genre FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS aufnahme_genres (
    aufnahme_id INT NOT NULL,
    genre_id INT NOT NULL,
    quelle ENUM('tags','musicbrainz','manuell') NOT NULL DEFAULT 'tags',
    PRIMARY KEY (aufnahme_id, genre_id),
    CONSTRAINT fk_aug_aufnahme FOREIGN KEY (aufnahme_id) REFERENCES aufnahmen(id) ON DELETE CASCADE,
    CONSTRAINT fk_aug_genre FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Dateien auf der Platte. Ein Track kann (später) mehrere Dateien haben, z. B. FLAC und MP3.
CREATE TABLE IF NOT EXISTS dateien (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pfad_hash CHAR(64) NOT NULL,
    pfad VARCHAR(2000) NOT NULL,
    ordner_hash CHAR(64) NOT NULL,
    groesse BIGINT NOT NULL DEFAULT 0,
    mtime INT NOT NULL DEFAULT 0,
    format VARCHAR(10) NOT NULL DEFAULT '',
    codec VARCHAR(30) NOT NULL DEFAULT '',
    abtastrate INT NOT NULL DEFAULT 0,
    bittiefe TINYINT NOT NULL DEFAULT 0,
    kanaele TINYINT NOT NULL DEFAULT 0,
    laenge_ms INT NOT NULL DEFAULT 0,
    bitrate INT NOT NULL DEFAULT 0,
    track_id INT NULL,
    tags_json MEDIUMTEXT NULL,
    rg_track_db DECIMAL(6,2) NULL,
    rg_track_peak DECIMAL(8,6) NULL,
    rg_album_db DECIMAL(6,2) NULL,
    rg_album_peak DECIMAL(8,6) NULL,
    bild_eingebettet TINYINT(1) NOT NULL DEFAULT 0,
    fehler VARCHAR(300) NOT NULL DEFAULT '',
    gefunden_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    zuletzt_gesehen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_datei_pfad (pfad_hash),
    INDEX idx_datei_ordner (ordner_hash),
    INDEX idx_datei_track (track_id),
    CONSTRAINT fk_datei_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scan_laeufe (
    id INT AUTO_INCREMENT PRIMARY KEY,
    art ENUM('neu','voll') NOT NULL DEFAULT 'neu',
    status ENUM('wartet','laeuft','fertig','fehler','abgebrochen') NOT NULL DEFAULT 'wartet',
    gestartet_von INT NULL,
    gestartet_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    beendet_am DATETIME NULL,
    lebenszeichen DATETIME NULL,
    dateien_gesamt INT NOT NULL DEFAULT 0,
    dateien_geprueft INT NOT NULL DEFAULT 0,
    dateien_neu INT NOT NULL DEFAULT 0,
    dateien_geaendert INT NOT NULL DEFAULT 0,
    dateien_entfernt INT NOT NULL DEFAULT 0,
    alben_neu INT NOT NULL DEFAULT 0,
    fehler_anzahl INT NOT NULL DEFAULT 0,
    aktuell VARCHAR(500) NOT NULL DEFAULT '',
    meldung TEXT NULL,
    INDEX idx_scan_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scan_fehler (
    id INT AUTO_INCREMENT PRIMARY KEY,
    lauf_id INT NOT NULL,
    pfad VARCHAR(2000) NOT NULL,
    fehler VARCHAR(500) NOT NULL,
    INDEX idx_scanfehler_lauf (lauf_id),
    CONSTRAINT fk_scanfehler_lauf FOREIGN KEY (lauf_id) REFERENCES scan_laeufe(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Gelöschte Objekte, damit Apps (Windows-Player) ihren Zwischenspeicher abgleichen können
CREATE TABLE IF NOT EXISTS geloescht (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    art VARCHAR(20) NOT NULL,
    objekt_id INT NOT NULL,
    zeit DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_geloescht_zeit (zeit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
