<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';

/** Sicherheits-Header für jede Antwort (einmal pro Anfrage). */
function sicherheits_header_senden(): void
{
    static $gesendet = false;
    if ($gesendet || headers_sent()) {
        return;
    }
    $gesendet = true;
    $s = konfig()['sicherheit'];
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: same-origin');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex');
    header_remove('X-Powered-By');
    if ($s['hsts'] && ist_https()) {
        header('Strict-Transport-Security: max-age=31536000');
    }
    if ($s['csp']) {
        $css = '';    // Schriften kommen vom eigenen Server (/fonts)
        $font = '';
        $direkt = '';
        try {
            require_once __DIR__ . '/direktzugang.php';
            $o = direkt_origin();
            $direkt = $o !== '' ? ' ' . $o : '';
        } catch (Throwable $e) {
            $direkt = '';
        }
        // die Import-Map der App (index.php) ist ein Inline-Skript: per Hash erlaubt, sonst nichts Inline
        $karte = function_exists('import_map_json') ? " 'sha256-" . base64_encode(hash('sha256', import_map_json(), true)) . "'" : '';
        header("Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'{$karte}; style-src 'self' 'unsafe-inline'{$css}; "
            . "img-src 'self' data: blob:{$direkt}; media-src 'self' blob:{$direkt}; font-src 'self' data:{$font}; connect-src 'self'{$direkt}; "
            . "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'; manifest-src 'self'");
    }
}

/** Passwort-Hash: Argon2id, falls verfügbar, sonst bcrypt. */
function passwort_hashen(string $passwort): string
{
    return password_hash($passwort, defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT);
}

/** Alten Hash nach erfolgreichem Login auf den aktuellen Standard heben. */
function passwort_hash_aktualisieren(int $userId, string $passwort, string $hash): void
{
    if (password_needs_rehash($hash, defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT)) {
        db_tun('UPDATE users SET passwort_hash = :p WHERE id = :id', ['p' => passwort_hashen($passwort), 'id' => $userId]);
    }
}

/** Gleiche Rechenzeit wie ein echter Passwort-Check (verrät nicht, ob es den Nutzer gibt). */
function passwort_schein_pruefung(string $passwort): void
{
    // Fester Hash mit denselben Kosten wie passwort_hashen(): nur EIN Prüfschritt wie bei einem echten Konto
    // (vorher wurde zusätzlich ein Hash erzeugt – unbekannte Namen brauchten doppelt so lange und waren daran erkennbar)
    $hash = defined('PASSWORD_ARGON2ID')
        ? '$argon2id$v=19$m=65536,t=4,p=1$bndNQkVQY25XazV1Mktrcw$U89EaN411pkLXXylyGMEaRk6vJ3/oNkDY+MpFCRodhw'
        : '$2y$10$POIURTWgKKFXL4TZCj2i..nVe4RNMOM3aGz1xwYII/DeSZbCYlEBG';
    password_verify($passwort, $hash);
}

/** null = Passwort ok, sonst Fehlermeldung. Mind. 8 Zeichen, gängige schwache Passwörter gesperrt. */
function passwort_ist_zu_schwach(string $passwort): ?string
{
    $min = konfig()['sicherheit']['passwort_min_laenge'];
    if (mb_strlen($passwort) < $min) {
        return t('Das Passwort muss mindestens {n} Zeichen lang sein.', ['n' => $min]);
    }
    $schwach = ['12345678', '123456789', '1234567890', 'password', 'passwort', 'qwertzuiop', 'qwertyuiop', '11111111',
        '00000000', 'abcdefgh', 'iloveyou', 'password1', 'passwort1', 'amberwave', 'musik123', 'hallo123', 'qwertz12'];
    if (in_array(mb_strtolower($passwort), $schwach, true)) {
        return t('Dieses Passwort ist zu leicht zu erraten. Bitte ein anderes wählen.');
    }
    if (preg_match('/^\d+$/', $passwort)) {
        $auf = $ab = true;
        for ($i = 1, $n = strlen($passwort); $i < $n; $i++) {
            if ((int) $passwort[$i] !== ((int) $passwort[$i - 1] + 1) % 10) { $auf = false; }
            if ((int) $passwort[$i] !== ((int) $passwort[$i - 1] + 9) % 10) { $ab = false; }
        }
        if ($auf || $ab) {
            return t('Dieses Passwort ist zu leicht zu erraten. Bitte ein anderes wählen.');
        }
    }
    if (preg_match('/^(.)\1+$/u', $passwort)) {
        return t('Dieses Passwort ist zu leicht zu erraten. Bitte ein anderes wählen.');
    }
    return null;
}

// ---------- Allgemeines Rate-Limit (Tabelle rate_log) ----------

function rate_anzahl(string $bereich, string $schluessel, int $sekunden): int
{
    return (int) db_wert(
        'SELECT COUNT(*) FROM rate_log WHERE bereich = :b AND schluessel = :s AND zeit > (NOW() - INTERVAL ' . max(1, $sekunden) . ' SECOND)',
        ['b' => $bereich, 's' => mb_substr($schluessel, 0, 190)]
    );
}

function rate_zaehlen(string $bereich, string $schluessel): void
{
    db_tun('INSERT INTO rate_log (bereich, schluessel) VALUES (:b, :s)', ['b' => $bereich, 's' => mb_substr($schluessel, 0, 190)]);
    if (random_int(1, 50) === 1) {
        db()->exec('DELETE FROM rate_log WHERE zeit < (NOW() - INTERVAL 8 DAY)');
    }
}

/** true = noch erlaubt; zählt den Versuch gleich mit. */
function rate_erlaubt(string $bereich, string $schluessel, int $max, int $sekunden): bool
{
    if (rate_anzahl($bereich, $schluessel, $sekunden) >= $max) {
        return false;
    }
    rate_zaehlen($bereich, $schluessel);
    return true;
}

function log_sicherheitsereignis(?int $userId, string $ereignis, string $details = ''): void
{
    try {
        db_tun('INSERT INTO sicherheits_log (user_id, ereignis, details, ip_adresse) VALUES (:u, :e, :d, :ip)',
            ['u' => $userId, 'e' => mb_substr($ereignis, 0, 100), 'd' => mb_substr($details, 0, 2000), 'ip' => client_ip()]);
    } catch (Throwable $e) {
        error_log('Sicherheits-Log: ' . $e->getMessage());
    }
}
