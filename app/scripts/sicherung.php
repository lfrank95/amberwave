<?php
// Tägliche Datensicherung (vom Zeitplan als eigener Prozess gestartet; auch von Hand: php scripts/sicherung.php)
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/hilfen.php';
require_once __DIR__ . '/../includes/i18n.php';
require_once __DIR__ . '/../includes/einstellungen.php';
require_once __DIR__ . '/../includes/sicherung.php';

$sperre = @fopen(dirname(sicherung_sperrdatei()) . '/sicherung.lock', 'c');
if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
    exit(0); // läuft schon
}
if (sicherung_wiederherstellung_laeuft()) {
    exit(0);
}
try {
    $r = sicherung_erstellen('taeglich');
    $text = t('Letzte Sicherung {datum} ({mb} MB)', ['datum' => sicherung_datum(time()), 'mb' => zahl_fmt(round($r['groesse'] / 1048576, 1), 1)])
        . ($r['geloescht'] ? ', ' . tn((int) $r['geloescht'], 'eine alte entfernt', '{n} alte entfernt') : '') . '.';
    einstellung_setzen('sicherung_meldung', $text);
    echo date('c') . " Datensicherung: {$r['name']}\n";
} catch (Throwable $e) {
    einstellung_setzen('sicherung_meldung', 'FEHLER ' . sicherung_datum(time()) . ': ' . $e->getMessage());
    echo date('c') . ' Datensicherung: ' . log_sauber($e->getMessage()) . "\n";
    exit(1);
}
