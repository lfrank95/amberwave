<?php
// All-in-One-Image: legt beim ersten Start das Admin-Konto aus der Unraid-Vorlage an (ADMIN_BENUTZER, ADMIN_PASSWORT,
// optional ADMIN_EMAIL). Nur solange es noch kein einziges Konto gibt – spätere Änderungen in der Vorlage ändern nichts
// (Passwort dann in Amberwave unter Profil ändern). Ohne Angaben bleibt es bei der Einrichtungsseite im Browser.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/einrichtung.php';
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/sicherheit.php';

$name = trim((string) getenv('ADMIN_BENUTZER'));
$pw = (string) getenv('ADMIN_PASSWORT');
if ($name === '' || $pw === '') {
    if (einrichtung_zustand(true)['art'] !== 'fertig') {
        echo "AIO: Kein ADMIN_BENUTZER/ADMIN_PASSWORT in der Vorlage – das erste Konto legst du auf der Einrichtungsseite an.\n";
    }
    exit(0);
}
if (einrichtung_zustand(true)['art'] === 'fertig') {
    exit(0); // es gibt schon Konten – die Vorlage ändert nichts mehr
}
if (!preg_match('/^[\p{L}0-9._-]{3,50}$/u', $name)) {
    echo "AIO: ADMIN_BENUTZER „{$name}“ ist ungültig (3–50 Zeichen: Buchstaben, Ziffern, . _ -) – bitte in der Vorlage ändern.\n";
    exit(0);
}
if (($grund = passwort_ist_zu_schwach($pw)) !== null) {
    echo "AIO: ADMIN_PASSWORT zu schwach: {$grund} – bitte in der Vorlage ändern, oder das Konto auf der Einrichtungsseite anlegen.\n";
    exit(0);
}
try {
    migrationen_ausfuehren();   // neue Installation: Tabellen anlegen
    if ((int) db_wert('SELECT COUNT(*) FROM users') > 0) {
        exit(0);
    }
} catch (Throwable $e) {
    echo "AIO: Admin-Konto nicht angelegt – Datenbank nicht bereit (" . $e->getMessage() . ")\n";
    exit(0);
}
$mail = trim((string) getenv('ADMIN_EMAIL'));
if ($mail === '' || !filter_var($mail, FILTER_VALIDATE_EMAIL)) {
    $mail = strtolower(preg_replace('/[^a-z0-9._-]/i', '', $name) ?: 'admin') . '@localhost';
}
if (einrichtung_admin_anlegen(['vorname' => $name, 'nachname' => '', 'benutzername' => $name, 'email' => $mail, 'passwort' => $pw, 'sprache' => ''])) {
    einrichtung_zustand(true);
    schluessel_sichern();
    echo "AIO: Admin-Konto „{$name}“ angelegt – Anmeldung unter http://<Server-IP>:" . konfig()['heimnetz']['app_port'] . "\n";
}
