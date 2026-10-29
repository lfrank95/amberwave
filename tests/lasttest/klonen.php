<?php
// Vervielfacht die Bibliothek in der DB (nur Datenbankzeilen, keine Dateien) für Lese-Lasttests: klonen.php <kopien>
require __DIR__ . '/../../app/includes/db.php';
$kopien = (int) ($argv[1] ?? 4);
$spalten = fn($t) => array_column(db_alle('SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=:t ORDER BY ORDINAL_POSITION', ['t' => $t]), 'c');
$max = fn($t) => (int) db_wert("SELECT MAX(id) FROM $t");
$basis = ['alben' => $max('alben'), 'editionen' => $max('editionen'), 'datentraeger' => $max('datentraeger'), 'tracks' => $max('tracks'), 'dateien' => $max('dateien')];
$off = []; foreach ($basis as $t => $m) { $off[$t] = (int) (ceil(($m + 1) / 1000000) * 1000000) ?: 1000000; }
$ersatz = [
  'alben' => ['id' => 'id+:o_alben', 'mbid' => 'NULL', 'anzeige_edition_id' => 'anzeige_edition_id+:o_editionen', 'edition_wahl_id' => 'IF(edition_wahl_id IS NULL,NULL,edition_wahl_id+:o_editionen)', 'hinzugefuegt_am' => 'hinzugefuegt_am - INTERVAL :k DAY'],
  'editionen' => ['id' => 'id+:o_editionen', 'mbid' => 'NULL', 'album_id' => 'album_id+:o_alben', 'ordner_hash' => 'SHA2(CONCAT(ordner_hash,:k),256)'],
  'datentraeger' => ['id' => 'id+:o_datentraeger', 'edition_id' => 'edition_id+:o_editionen'],
  'tracks' => ['id' => 'id+:o_tracks', 'datentraeger_id' => 'datentraeger_id+:o_datentraeger', 'mbid' => 'NULL'],
  'dateien' => ['id' => 'id+:o_dateien', 'track_id' => 'track_id+:o_tracks', 'pfad_hash' => 'SHA2(CONCAT(pfad_hash,:k),256)', 'pfad' => 'CONCAT(pfad,:ks)', 'tags_json' => 'NULL'],
  'album_genres' => ['album_id' => 'album_id+:o_alben'],
  'album_familien' => ['album_id' => 'album_id+:o_alben'],
];
$quelleMax = $basis;
for ($k = 1; $k <= $kopien; $k++) {
    foreach ($ersatz as $t => $e) {
        $c = $spalten($t);
        $sel = array_map(fn($x) => $e[$x] ?? $x, $c);
        $wo = isset($quelleMax[$t]) ? "WHERE id <= {$quelleMax[$t]}" : 'WHERE album_id <= ' . $quelleMax['alben'];
        $sql = "INSERT INTO $t (" . implode(',', $c) . ') SELECT ' . implode(',', $sel) . " FROM $t $wo";
        $p = [];
        foreach (['alben', 'editionen', 'datentraeger', 'tracks', 'dateien'] as $o) { $sql = str_replace(":o_$o", (string) ($off[$o] * $k), $sql); }
        $sql = str_replace(':ks', "'#k$k'", $sql);
        $sql = preg_replace('/:k\b/', (string) $k, $sql);
        $t0 = microtime(true);
        db_tun($sql, $p);
        printf("Kopie %d %-15s %.1f s\n", $k, $t, microtime(true) - $t0);
    }
}
foreach (['tracks', 'alben', 'dateien'] as $t) echo "$t: ", db_wert("SELECT COUNT(*) FROM $t"), "\n";
