<?php
// Migration 021 (PHP): Kennzeichnung „explizit“ je Titel (Quelle: Hand, Datei-Tag oder Deezer) und ISRC je Titel;
// je Edition zusammengefasst (mindestens ein Titel explizit / Clean-Fassung) für Listen ohne Zusatzabfrage.
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$spalten = [
    ['tracks', 'explizit', 'TINYINT NULL'],                              // NULL unbekannt, 0 nein, 1 explizit, 2 Clean-Fassung
    ['tracks', 'explizit_quelle', "VARCHAR(10) NOT NULL DEFAULT ''"],    // hand, datei, deezer
    ['tracks', 'explizit_am', 'DATETIME NULL'],                          // letzter Versuch bei Deezer
    ['tracks', 'isrc', "VARCHAR(15) NOT NULL DEFAULT ''"],
    ['editionen', 'explizit', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['editionen', 'clean', 'TINYINT(1) NOT NULL DEFAULT 0'],
];
foreach ($spalten as [$t, $c, $typ]) {
    $st->execute(['t' => $t, 'c' => $c]);
    if ((int) $st->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE {$t} ADD COLUMN {$c} {$typ}");
    }
}
