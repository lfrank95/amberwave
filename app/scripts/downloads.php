<?php
// Fertige Downloads (SABnzbd) in den Musikordner kopieren und einlesen – im Hintergrund, nie zweimal gleichzeitig.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/hilfen.php';
require_once __DIR__ . '/../includes/downloads.php';
$sperre = fopen(konfig()['pfade']['cache'] . '/downloads.lock', 'c');
if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
    exit(0);
}
try {
    dl_abgleichen_status();
    $n = dl_importe();
    if ($n) {
        echo date('c') . " Downloads: {$n} importiert\n";
    }
} catch (Throwable $e) {
    echo date('c') . ' Downloads: ' . log_sauber($e->getMessage()) . "\n";
} finally {
    flock($sperre, LOCK_UN);
    fclose($sperre);
}
