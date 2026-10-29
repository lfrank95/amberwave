<?php
// Migration 025 (PHP): Genre-Gewichtung, Genre-Familien und Stil-Erkennung aus dem Klang.
//  - album_genres / aufnahme_genres: stimmen (MusicBrainz-Stimmen) und anteil (Anteil an allen Stimmen des Albums bzw. Titels, 1 = eigene Tags/manuell)
//  - alben.genre_stimmen_am: wann die Stimmen von MusicBrainz nachgeholt wurden (Hintergrundlauf für schon vorhandene Alben)
//  - album_familien: berechnete Familien je Album (Pop, Elektro, Rock …) mit Wert 0–1
//  - aufnahme_stile: Top-Stile je Aufnahme aus dem erweiterten Klang-Modell (Discogs-400)
//  - klang.stile_am: wann die Stil-Erkennung für diese Aufnahme lief
declare(strict_types=1);
$hat = static function (string $tabelle, string $spalte) use ($pdo): bool {
    $st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
    $st->execute(['t' => $tabelle, 'c' => $spalte]);
    return (int) $st->fetchColumn() > 0;
};
foreach (['album_genres', 'aufnahme_genres'] as $t) {
    if (!$hat($t, 'stimmen')) {
        $pdo->exec("ALTER TABLE {$t} ADD COLUMN stimmen INT NOT NULL DEFAULT 0");
    }
    if (!$hat($t, 'anteil')) {
        $pdo->exec("ALTER TABLE {$t} ADD COLUMN anteil DECIMAL(6,4) NOT NULL DEFAULT 1");
    }
}
if (!$hat('alben', 'genre_stimmen_am')) {
    $pdo->exec('ALTER TABLE alben ADD COLUMN genre_stimmen_am DATETIME NULL');
}
if (!$hat('klang', 'stile_am')) {
    $pdo->exec('ALTER TABLE klang ADD COLUMN stile_am DATETIME NULL');
}
$pdo->exec('CREATE TABLE IF NOT EXISTS album_familien (
    album_id INT NOT NULL,
    familie VARCHAR(20) NOT NULL,
    wert DECIMAL(6,4) NOT NULL,
    PRIMARY KEY (album_id, familie),
    INDEX idx_af_familie (familie, wert),
    CONSTRAINT fk_af_album FOREIGN KEY (album_id) REFERENCES alben(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
$pdo->exec('CREATE TABLE IF NOT EXISTS aufnahme_stile (
    aufnahme_id INT NOT NULL,
    rang TINYINT NOT NULL,
    stil VARCHAR(100) NOT NULL,
    wert DECIMAL(6,4) NOT NULL,
    PRIMARY KEY (aufnahme_id, rang),
    CONSTRAINT fk_as_aufnahme FOREIGN KEY (aufnahme_id) REFERENCES aufnahmen(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
