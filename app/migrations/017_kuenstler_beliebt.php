<?php
// Migration 017 (PHP): Genres je Künstler (MusicBrainz, mit Stimmen) für die Badges auf der Künstlerseite.
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS kuenstler_genres (
    kuenstler_id INT NOT NULL,
    genre_id INT NOT NULL,
    stimmen INT NOT NULL DEFAULT 0,
    PRIMARY KEY (kuenstler_id, genre_id),
    INDEX idx_kg_genre (genre_id),
    CONSTRAINT fk_kg_kuenstler FOREIGN KEY (kuenstler_id) REFERENCES kuenstler(id) ON DELETE CASCADE,
    CONSTRAINT fk_kg_genre FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'kuenstler', 'c' => 'genres_am']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE kuenstler ADD COLUMN genres_am DATETIME NULL');
}
