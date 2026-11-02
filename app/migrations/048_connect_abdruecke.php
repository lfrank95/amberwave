<?php
// Migration 048 (PHP): Fingerabdrücke der eigenen Alben und Titel für „Hast du schon“ bei Amberwave Connect.
// Statt einer Liste aller Titel im Speicher (bei 100.000 Titeln Sekunden und viele MB) steht je Album/Titel ein
// Abdruck (md5 aus normalisiertem Künstler|Titel) in der Datenbank; beim Stöbern auf einem anderen Server
// genügt eine Abfrage mit IN (…) für die gerade sichtbare Seite. Gepflegt wird die Tabelle schrittweise
// (connect_abdruecke_pflegen): nur geänderte, neue oder verschwundene Zeilen.
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS connect_abdruecke (
    art TINYINT NOT NULL,
    ziel_id INT NOT NULL,
    abdruck BINARY(16) NOT NULL,
    PRIMARY KEY (art, ziel_id, abdruck),
    INDEX idx_cab_abdruck (abdruck)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
