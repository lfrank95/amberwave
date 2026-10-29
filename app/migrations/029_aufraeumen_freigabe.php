<?php
// Migration 029 (PHP): wann ein Aufräum-Plan freigegeben wurde – alte Freigaben verfallen, statt Stunden später still loszulaufen.
declare(strict_types=1);
$st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
$st->execute(['t' => 'aufraeum_plaene', 'c' => 'freigegeben_am']);
if ((int) $st->fetchColumn() === 0) {
    $pdo->exec('ALTER TABLE aufraeum_plaene ADD COLUMN freigegeben_am DATETIME NULL');
}
// Freigaben aus der Zeit davor haben kein Datum: sicherheitshalber zurück auf „offen“ (neu prüfen und freigeben)
$pdo->exec("UPDATE aufraeum_plaene SET status = 'offen', log = 'Freigabe zurückgesetzt (Update): bitte Vorschau prüfen und erneut freigeben.' WHERE status = 'freigegeben' AND freigegeben_am IS NULL");
