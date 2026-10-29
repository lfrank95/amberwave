<?php
// Migration 046 (PHP): Indizes für große Bibliotheken (100.000+ Titel), gefunden beim Lasttest vor der Beta.
// - dateien(track_id, bittiefe, abtastrate): „beste Datei je Titel“ (Stream, Lautheit, Klanganalyse) ohne Sortieren
// - wiedergaben(user_id, gezaehlt, track_id): „von dir am meisten gehört“ (Künstlerliste, Radio)
// - alben(titel) / kuenstler(sortname): Sortieren und Buchstaben-Filter der Listen
declare(strict_types=1);
$da = $pdo->prepare('SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND INDEX_NAME = :i');
foreach ([
    ['dateien', 'idx_datei_beste', '(track_id, bittiefe, abtastrate)'],
    ['wiedergaben', 'idx_wg_user_gezaehlt', '(user_id, gezaehlt, track_id)'],
    ['alben', 'idx_album_titel', '(titel(100))'],
    ['kuenstler', 'idx_kuenstler_sortname', '(sortname(100))'],
] as [$tabelle, $name, $spalten]) {
    $da->execute(['t' => $tabelle, 'i' => $name]);
    if ((int) $da->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE {$tabelle} ADD INDEX {$name} {$spalten}");
    }
}
