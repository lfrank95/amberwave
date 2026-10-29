<?php
// Migration 046 (PHP): Indizes für große Bibliotheken (100.000+ Titel), gefunden beim Lasttest vor der Beta.
// - dateien(track_id, bittiefe, abtastrate): „beste Datei je Titel“ (Stream, Lautheit, Albumseite) ohne Sortieren;
//   ersetzt den alten Index auf track_id allein (der neue beginnt mit track_id und deckt auch den Fremdschlüssel ab)
// - wiedergaben(user_id, gezaehlt, track_id): „von dir am meisten gehört“ (Künstlerliste, Radio)
// - wiedergaben(track_id, gezaehlt, gestartet_am): Beliebtheit in der Suche
declare(strict_types=1);
$da = $pdo->prepare('SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND INDEX_NAME = :i');
$gibt = static function (string $t, string $i) use ($da): bool {
    $da->execute(['t' => $t, 'i' => $i]);
    return (int) $da->fetchColumn() > 0;
};
foreach ([
    ['dateien', 'idx_datei_beste', '(track_id, bittiefe, abtastrate)'],
    ['wiedergaben', 'idx_wg_user_gezaehlt', '(user_id, gezaehlt, track_id)'],
    ['wiedergaben', 'idx_wg_track_gezaehlt', '(track_id, gezaehlt, gestartet_am)'],
] as [$tabelle, $name, $spalten]) {
    if (!$gibt($tabelle, $name)) {
        $pdo->exec("ALTER TABLE {$tabelle} ADD INDEX {$name} {$spalten}");
    }
}
// Doppelte Indizes kosten bei jedem Scan Schreibarbeit
foreach ([['dateien', 'idx_datei_beste', 'idx_datei_track'], ['wiedergaben', 'idx_wg_track_gezaehlt', 'idx_wg_track']] as [$tabelle, $neu, $alt]) {
    if ($gibt($tabelle, $neu) && $gibt($tabelle, $alt)) {
        $pdo->exec("ALTER TABLE {$tabelle} DROP INDEX {$alt}");
    }
}
// Vorabstand dieser Migration (nur Entwicklungsversionen): Präfix-Indizes, die keine Abfrage nutzt
foreach ([['alben', 'idx_album_titel'], ['kuenstler', 'idx_kuenstler_sortname']] as [$tabelle, $alt]) {
    if ($gibt($tabelle, $alt)) {
        $pdo->exec("ALTER TABLE {$tabelle} DROP INDEX {$alt}");
    }
}
