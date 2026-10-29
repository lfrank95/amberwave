<?php
// Migration 008 (PHP): Künstler nach Vorname Nachname sortieren („Michael Jackson“ unter M) – gesperrte Sortiernamen bleiben.
declare(strict_types=1);
require_once __DIR__ . '/../includes/config.php';
require_once __DIR__ . '/../includes/hilfen.php';

$alle = $pdo->query('SELECT id, name, sortname, gesperrte_felder FROM kuenstler')->fetchAll(PDO::FETCH_ASSOC);
$upd = $pdo->prepare('UPDATE kuenstler SET sortname = :s WHERE id = :id');
foreach ($alle as $k) {
    if (in_array('sortname', array_map('trim', explode(',', (string) $k['gesperrte_felder'])), true)) {
        continue;
    }
    $s = mb_substr(sortname_aus((string) $k['name']), 0, 500);
    if ($s !== $k['sortname']) {
        $upd->execute(['s' => $s, 'id' => $k['id']]);
    }
}
