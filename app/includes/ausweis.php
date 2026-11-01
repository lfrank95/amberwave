<?php
declare(strict_types=1);
// Ausweis des Servers: ein Schlüsselpaar (Ed25519), beim ersten Bedarf erzeugt, verschlüsselt in den Einstellungen
// (damit in jeder Sicherung und beim Umzug dabei). Der öffentliche Schlüssel ist die feste Kennung des Servers – egal
// welche IP er hat oder wie er heißt. Gekoppelte Server (Amberwave Connect) und die Apps merken sich diese Kennung und
// lassen sich beim Wiederfinden beweisen, dass es wirklich derselbe Server ist (Unterschrift über eine Zufallszahl).
require_once __DIR__ . '/einstellungen.php';

/** Geheimer Schlüssel (64 Byte, Ed25519) – beim ersten Aufruf erzeugt */
function ausweis_geheim(): string
{
    static $sk = null;
    if ($sk !== null) {
        return $sk;
    }
    $gespeichert = einstellung('ausweis_schluessel');
    $roh = $gespeichert !== '' ? base64_decode($gespeichert, true) : false;
    if ($roh === false || strlen($roh) !== SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
        $paar = sodium_crypto_sign_keypair();
        $roh = sodium_crypto_sign_secretkey($paar);
        einstellung_setzen('ausweis_schluessel', base64_encode($roh));
    }
    return $sk = $roh;
}

/** Öffentlicher Schlüssel (32 Byte) – liegt zusätzlich als Datei im Cache, damit /ping ihn ohne Datenbank nennen kann */
function ausweis_oeffentlich(): string
{
    static $pk = null;
    if ($pk === null) {
        $pk = sodium_crypto_sign_publickey_from_secretkey(ausweis_geheim());
        $datei = ausweis_datei();
        if (@file_get_contents($datei) !== bin2hex($pk)) {
            @file_put_contents($datei, bin2hex($pk), LOCK_EX);
        }
    }
    return $pk;
}

function ausweis_datei(): string
{
    return rtrim((string) konfig()['pfade']['cache'], '/') . '/ausweis.pub';
}

/** Für /ping: öffentlicher Schlüssel aus der Cache-Datei (ohne Datenbank), sonst null */
function ausweis_ping(): ?array
{
    $hex = trim((string) @file_get_contents(ausweis_datei()));
    if (!preg_match('/^[0-9a-f]{64}$/', $hex)) {
        return null;
    }
    return ['schluessel' => $hex, 'kennung' => ausweis_kennung(hex2bin($hex))];
}

/** Kurze, lesbare Kennung aus einem öffentlichen Schlüssel: AW-7K3F-92QX (Base32 ohne verwechselbare Zeichen) */
function ausweis_kennung(?string $pk = null): string
{
    $h = hash('sha256', $pk ?? ausweis_oeffentlich(), true);
    $abc = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    $bits = '';
    for ($i = 0; $i < 5; $i++) {
        $bits .= str_pad(decbin(ord($h[$i])), 8, '0', STR_PAD_LEFT);
    }
    $z = '';
    for ($i = 0; $i < 8; $i++) {
        $z .= $abc[bindec(substr($bits, $i * 5, 5))];
    }
    return 'AW-' . substr($z, 0, 4) . '-' . substr($z, 4, 4);
}

/** Beweis für eine Zufallszahl des Fragenden: Unterschrift über Zweck, Zufallszahl und Kennung */
function ausweis_beweis(string $zufall): array
{
    $pk = ausweis_oeffentlich();
    $nachricht = 'amberwave-ausweis-v1|' . $zufall . '|' . bin2hex($pk);
    return ['schluessel' => bin2hex($pk), 'kennung' => ausweis_kennung($pk), 'zufall' => $zufall,
        'unterschrift' => bin2hex(sodium_crypto_sign_detached($nachricht, ausweis_geheim()))];
}

/** Prüft einen Beweis gegen den erwarteten öffentlichen Schlüssel (hex) */
function ausweis_beweis_pruefen(array $b, string $zufall, string $erwartet_hex): bool
{
    if (($b['schluessel'] ?? '') !== $erwartet_hex || ($b['zufall'] ?? '') !== $zufall || !ctype_xdigit((string) ($b['unterschrift'] ?? ''))) {
        return false;
    }
    $pk = hex2bin($erwartet_hex);
    $sig = hex2bin((string) $b['unterschrift']);
    return $pk !== false && $sig !== false && strlen($sig) === SODIUM_CRYPTO_SIGN_BYTES
        && sodium_crypto_sign_verify_detached($sig, 'amberwave-ausweis-v1|' . $zufall . '|' . $erwartet_hex, $pk);
}

/** Schlüssel für Verschlüsselung zwischen Servern (X25519, aus dem Ausweis abgeleitet) */
function ausweis_box_geheim(): string
{
    return sodium_crypto_sign_ed25519_sk_to_curve25519(ausweis_geheim());
}

function ausweis_box_oeffentlich_von(string $pk_ed): string
{
    return sodium_crypto_sign_ed25519_pk_to_curve25519($pk_ed);
}
