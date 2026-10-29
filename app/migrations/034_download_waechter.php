<?php
// Migration 034 (PHP): Wächter für hängende Downloads – letzter Stand in SABnzbd (Fingerabdruck) und wann er sich zuletzt
// bewegt hat. Ändert sich lange nichts, gilt der Auftrag als gescheitert (oder, bei 100 %, als fertig, wenn die Dateien da sind).
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
foreach (['fingerabdruck' => 'VARCHAR(255) NULL', 'bewegt_am' => 'DATETIME NULL'] as $sp => $typ) {
    $st->execute(['t' => 'downloads', 'c' => $sp]);
    if ((int) $st->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE downloads ADD COLUMN {$sp} {$typ}");
    }
}
