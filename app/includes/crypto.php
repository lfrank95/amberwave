<?php
declare(strict_types=1);

// Symmetrische Verschlüsselung für Werte, die im Klartext in der DB
// liegen würden (z.B. SMTP-Passwort). Schlüssel kommt NUR aus der
// Umgebungsvariable, nie aus der Datenbank selbst.

// Format: „v2:“ + Base64(Nonce 12 | Tag 16 | Chiffre) mit AES-256-GCM – ein veränderter Wert wird beim Entschlüsseln erkannt
// und abgelehnt. Ältere Werte (AES-CBC ohne Prüfsumme, ohne Vorsatz) lassen sich weiter lesen; beim nächsten Speichern
// bekommen sie das neue Format.

function verschluessle(string $klartext): string
{
    $config = require __DIR__ . '/config.php';
    $schluessel = hash('sha256', 'aw-gcm|' . $config['app_secret_key'], true);
    $nonce = random_bytes(12);
    $tag = '';
    $chiffre = openssl_encrypt($klartext, 'aes-256-gcm', $schluessel, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    return 'v2:' . base64_encode($nonce . $tag . $chiffre);
}

function entschluessle(string $verschluesselt): string
{
    $config = require __DIR__ . '/config.php';
    return (string) entschluessle_mit($verschluesselt, (string) $config['app_secret_key']);
}

/** Wert mit einem bestimmten APP_SECRET_KEY entschlüsseln (auch der eines anderen Servers beim Umzug); null = nicht lesbar */
function entschluessle_mit(string $verschluesselt, string $geheimnis): ?string
{
    if (str_starts_with($verschluesselt, 'v2:')) {
        $daten = base64_decode(substr($verschluesselt, 3), true);
        if ($daten === false || strlen($daten) < 28) {
            return null;
        }
        $k = openssl_decrypt(substr($daten, 28), 'aes-256-gcm', hash('sha256', 'aw-gcm|' . $geheimnis, true), OPENSSL_RAW_DATA, substr($daten, 0, 12), substr($daten, 12, 16));
        return $k === false ? null : $k;
    }
    $daten = base64_decode($verschluesselt, true);
    if ($daten === false || strlen($daten) < 17) {
        return null;
    }
    $k = openssl_decrypt(substr($daten, 16), 'aes-256-cbc', hash('sha256', $geheimnis, true), OPENSSL_RAW_DATA, substr($daten, 0, 16));
    return $k === false ? null : $k;
}
