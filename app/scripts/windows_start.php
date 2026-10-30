<?php
// Amberwave Windows Server: vom Tray-Programm aufgerufen, sobald die mitgelieferte MariaDB läuft (wie aio.sh im Docker-Image).
// Legt Datenbank und Zugang für Amberwave an bzw. gleicht sie an (geheimnisse/datenbank.json) – root meldet sich mit dem
// zufälligen Passwort aus geheimnisse/db_root_passwort an, das das Tray-Programm beim Anlegen der Datenbank gesetzt hat.
// Ausgabe: eine Zeile „ok …“ oder „fehler …“ (das Tray-Programm schreibt sie ins Log). Exit-Code 0 = bereit.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/einrichtung.php';

$rootPw = geheimnis_lesen('db_root_passwort');
if ($rootPw === '') {
    echo "fehler: geheimnisse/db_root_passwort fehlt\n";
    exit(1);
}
$root = null;
for ($i = 0; $i < 30 && $root === null; $i++) {
    try {
        $root = einrichtung_pdo('root', $rootPw, null);
    } catch (Throwable $e) {
        if ($i === 29) {
            echo 'fehler: keine Verbindung zur Datenbank als root – ' . $e->getMessage() . "\n";
            exit(1);
        }
        sleep(1);
    }
}

$d = json_decode(geheimnis_lesen('datenbank.json'), true);
if (!is_array($d) || !preg_match('/^\w{1,64}$/', (string) ($d['name'] ?? '')) || !preg_match('/^\w{1,32}$/', (string) ($d['user'] ?? '')) || (string) ($d['passwort'] ?? '') === '') {
    $d = ['name' => 'amberwave', 'user' => 'amberwave', 'passwort' => bin2hex(random_bytes(20))];
    if (!geheimnis_schreiben('datenbank.json', (string) json_encode($d))) {
        echo "fehler: konnte geheimnisse/datenbank.json nicht schreiben\n";
        exit(1);
    }
}
try {
    $q = static fn(string $s): string => '`' . str_replace('`', '``', $s) . '`';
    $root->exec('CREATE DATABASE IF NOT EXISTS ' . $q($d['name']) . ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    foreach (['127.0.0.1', 'localhost'] as $h) {
        $u = $root->quote($d['user']) . '@' . $root->quote($h);
        $root->exec('CREATE USER IF NOT EXISTS ' . $u . ' IDENTIFIED BY ' . $root->quote($d['passwort']));
        $root->exec('ALTER USER ' . $u . ' IDENTIFIED BY ' . $root->quote($d['passwort']));
        $root->exec('GRANT ALL PRIVILEGES ON ' . $q(str_replace('_', '\\_', $d['name'])) . '.* TO ' . $u);
    }
    $root->exec('FLUSH PRIVILEGES');
} catch (Throwable $e) {
    echo 'fehler: Datenbank/Benutzer anlegen – ' . $e->getMessage() . "\n";
    exit(1);
}
echo 'ok: Datenbank „' . $d['name'] . "“ bereit\n";
