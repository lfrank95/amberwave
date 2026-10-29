<?php
// Migration 024 (PHP): Klanganalyse „einfach2“ (Spektralform ohne Mastering-Lautheit) ersetzt „einfach“ – alte Vektoren weg,
// die Sammlung wird im Hintergrund neu analysiert. Dazu: wann die Genres je Aufnahme von MusicBrainz geholt wurden.
declare(strict_types=1);
$pdo->exec("DELETE FROM klang WHERE verfahren = 'einfach'");
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'editionen', 'c' => 'mb_aufnahme_genres_am']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE editionen ADD COLUMN mb_aufnahme_genres_am DATETIME NULL');
}
