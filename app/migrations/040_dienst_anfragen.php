<?php
// Migration 040 (PHP): Zähler für Anfragen an fremde Dienste (MusicBrainz, AcoustID, Cover Art Archive, Deezer, fanart.tv …) –
// je Dienst, Tag und Edition (Free/Pro) die Zahl der Anfragen und der fehlgeschlagenen. Zu sehen unter Einstellungen › Dienste & Schlüssel.
declare(strict_types=1);
$pdo->exec("CREATE TABLE IF NOT EXISTS dienst_anfragen (
    dienst VARCHAR(60) NOT NULL,
    tag DATE NOT NULL,
    edition VARCHAR(10) NOT NULL DEFAULT 'Free',
    anzahl INT UNSIGNED NOT NULL DEFAULT 0,
    fehler INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (dienst, tag, edition),
    KEY idx_dienst_tag (tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
