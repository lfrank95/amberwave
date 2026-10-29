<?php
// Bibliotheks-Scan als Hintergrundprozess: php scan.php <lauf-id>   (oder: php scan.php neu|voll  für einen direkten Lauf)
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/i18n.php';
require_once __DIR__ . '/../includes/scanner.php';
require_once __DIR__ . '/migrate.php';
set_time_limit(0);
ini_set('memory_limit', '1024M');
migrationen_ausfuehren();

$arg = $argv[1] ?? '';
if ($arg === 'neu' || $arg === 'voll') {
    $lauf = db_einfuegen('INSERT INTO scan_laeufe (art, status) VALUES (:a, \'wartet\')', ['a' => $arg]);
} else {
    $lauf = (int) $arg;
}
$z = db_zeile('SELECT * FROM scan_laeufe WHERE id = :id', ['id' => $lauf]);
if (!$z) {
    fwrite(STDERR, "Unbekannter Lauf\n");
    exit(1);
}
// Nur ein Scan gleichzeitig
if ((int) db()->query("SELECT GET_LOCK('amberwave_scan', 0)")->fetchColumn() !== 1) {
    db_tun("UPDATE scan_laeufe SET status = 'fehler', meldung = :m, beendet_am = NOW() WHERE id = :id", ['m' => t('Es läuft bereits ein anderer Scan.'), 'id' => $lauf]);
    exit(0);
}
try {
    $stat = scan_ausfuehren($lauf, $z['art'] === 'voll');
    $abgebrochen = !empty($stat['abgebrochen']);
    db_tun('UPDATE scan_laeufe SET status = :s, beendet_am = NOW(), lebenszeichen = NOW(), dateien_gesamt = :g, dateien_geprueft = :p, dateien_neu = :n,
            dateien_geaendert = :ge, dateien_entfernt = :e, alben_neu = :a, fehler_anzahl = :f, aktuell = :ak WHERE id = :id', [
        's' => $abgebrochen ? 'abgebrochen' : 'fertig', 'g' => $stat['gesamt'], 'p' => $stat['geprueft'], 'n' => $stat['neu'], 'ge' => $stat['geaendert'],
        'e' => $stat['entfernt'], 'a' => $stat['alben_neu'], 'f' => $stat['fehler'], 'ak' => $abgebrochen ? t('Abgebrochen') : t('Fertig'), 'id' => $lauf,
    ]);
    echo "Scan {$lauf} fertig: " . json_encode($stat) . "\n";
} catch (Throwable $e) {
    db_tun("UPDATE scan_laeufe SET status = 'fehler', meldung = :m, beendet_am = NOW() WHERE id = :id", ['m' => mb_substr($e->getMessage(), 0, 2000), 'id' => $lauf]);
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
