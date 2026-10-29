-- Migration 023: Klanganalyse (akustische Ähnlichkeit) je Aufnahme und Index der nächsten Nachbarn.
-- klang: ein Vektor je Aufnahme und Verfahren ('einfach' = eingebaut, 'modell' = vom Nutzer installiertes Netz);
--        vektor NULL + fehler = Analyse fehlgeschlagen (wird nach einigen Tagen erneut versucht).
-- klang_nachbarn: die ähnlichsten Aufnahmen je Aufnahme (für das aktive Verfahren), im Hintergrund berechnet.
CREATE TABLE IF NOT EXISTS klang (
    aufnahme_id INT NOT NULL,
    verfahren VARCHAR(10) NOT NULL,
    track_id INT NULL,
    vektor MEDIUMBLOB NULL,
    dim SMALLINT NOT NULL DEFAULT 0,
    fehler VARCHAR(255) NOT NULL DEFAULT '',
    analysiert_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (aufnahme_id, verfahren),
    INDEX idx_klang_verfahren (verfahren, analysiert_am),
    CONSTRAINT fk_klang_aufnahme FOREIGN KEY (aufnahme_id) REFERENCES aufnahmen(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS klang_nachbarn (
    aufnahme_id INT NOT NULL,
    rang TINYINT NOT NULL,
    nachbar_id INT NOT NULL,
    aehnlich FLOAT NOT NULL,
    PRIMARY KEY (aufnahme_id, rang),
    INDEX idx_klang_nachbar (nachbar_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
