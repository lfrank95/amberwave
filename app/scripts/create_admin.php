<?php
// Notfall-Werkzeug auf der Kommandozeile:
//   docker exec -it amberwave_app php /var/www/html/scripts/create_admin.php <benutzername> <email> <passwort>
// Legt einen Admin an oder setzt bei vorhandenem Benutzernamen dessen Passwort neu (muss beim Login geändert werden).
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/sicherheit.php';
migrationen_ausfuehren();
[, $name, $mail, $pw] = $argv + [null, null, null, null];
if (!$name || !$mail || !$pw) {
    fwrite(STDERR, "Aufruf: php create_admin.php <benutzername> <email> <passwort>\n");
    exit(1);
}
if (($s = passwort_ist_zu_schwach($pw)) !== null) {
    fwrite(STDERR, $s . "\n");
    exit(1);
}
$id = db_wert('SELECT id FROM users WHERE benutzername = :b', ['b' => $name]);
if ($id) {
    db_tun("UPDATE users SET passwort_hash = :p, rolle = 'admin', status = 'aktiv', muss_passwort_aendern = 1 WHERE id = :id", ['p' => passwort_hashen($pw), 'id' => $id]);
    echo "Passwort für {$name} neu gesetzt (Admin, muss beim Login geändert werden).\n";
} else {
    db_tun("INSERT INTO users (vorname, nachname, benutzername, email, passwort_hash, rolle, status, aktiviert_am, muss_passwort_aendern)
            VALUES ('Admin', :n, :b, :e, :p, 'admin', 'aktiv', NOW(), 1)", ['n' => $name, 'b' => $name, 'e' => $mail, 'p' => passwort_hashen($pw)]);
    echo "Admin {$name} angelegt.\n";
}
