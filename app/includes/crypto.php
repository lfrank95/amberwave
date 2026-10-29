<?php
declare(strict_types=1);

// Symmetrische Verschlüsselung für Werte, die im Klartext in der DB
// liegen würden (z.B. SMTP-Passwort). Schlüssel kommt NUR aus der
// Umgebungsvariable, nie aus der Datenbank selbst.

function verschluessle(string $klartext): string
{
    $config = require __DIR__ . '/config.php';
    $schluessel = hash('sha256', $config['app_secret_key'], true);
    $iv = random_bytes(16);
    $chiffre = openssl_encrypt($klartext, 'aes-256-cbc', $schluessel, OPENSSL_RAW_DATA, $iv);
    return base64_encode($iv . $chiffre);
}

function entschluessle(string $verschluesselt): string
{
    $config = require __DIR__ . '/config.php';
    $schluessel = hash('sha256', $config['app_secret_key'], true);
    $daten = base64_decode($verschluesselt);
    $iv = substr($daten, 0, 16);
    $chiffre = substr($daten, 16);
    return (string) openssl_decrypt($chiffre, 'aes-256-cbc', $schluessel, OPENSSL_RAW_DATA, $iv);
}
