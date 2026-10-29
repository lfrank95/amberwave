<?php
// Arbeitet die Mail-Warteschlange im Hintergrund ab (wird nach dem Einreihen und vom Zeitplan gestartet).
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/mail.php';
[$ok, $fehler] = mail_warteschlange_abarbeiten();
if ($ok || $fehler) {
    echo date('c') . " Mails gesendet: {$ok}, fehlgeschlagen: {$fehler}\n";
}
