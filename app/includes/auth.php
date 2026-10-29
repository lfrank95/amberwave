<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/sicherheit.php';
require_once __DIR__ . '/geraete.php';
require_once __DIR__ . '/../scripts/migrate.php';

/** Ausstehende Migrationen einmal pro Anfrage anwenden (greift sofort nach einem Update). */
function pruefe_migrationen_einmal(): void
{
    static $geprueft = false;
    if ($geprueft) {
        return;
    }
    $geprueft = true;
    // Noch nicht eingerichtet (Datenbank/Konto fehlen): zur Einrichtungsseite, nichts anderes anfassen
    require_once __DIR__ . '/einrichtung.php';
    $einr = einrichtung_zustand();
    if ($einr['art'] !== 'fertig') {
        einrichtung_umleiten($einr);
    }
    // Schon geprüft (Merkdatei je Code-Stand): keine Datenbank-Abfragen pro Request – auch nicht für jedes Coverbild.
    // Die Merkdatei entsteht nach einer erfolgreichen Prüfung; ein Neustart des Containers löscht sie (start.sh).
    $stempel = migrationen_stempel();
    if ($stempel !== '' && is_file($stempel)) {
        return;
    }
    // Nach einem Fehler nicht bei jedem Seitenaufruf neu versuchen (und jedes Mal die Datenbank belasten): Pause 2 Minuten
    $fehlerDatei = $stempel !== '' ? dirname($stempel) . '/migration-fehler.txt' : '';
    $letzterFehler = $fehlerDatei !== '' && is_file($fehlerDatei) && time() - (int) @filemtime($fehlerDatei) < 120 ? (string) @file_get_contents($fehlerDatei) : '';
    try {
        if ($letzterFehler !== '') {
            throw new RuntimeException($letzterFehler);
        }
        migrationen_ausfuehren();
        if ($stempel !== '') {
            @mkdir(dirname($stempel), 0775, true);
            @touch($stempel);
        }
        if ($fehlerDatei !== '') {
            @unlink($fehlerDatei);
        }
    } catch (MigrationLaeuft $e) {
        update_seite(t('Update läuft'), $e->getMessage(), 20);
    } catch (SchemaZuNeu $e) {
        // Datenbank gehört zu einer neueren Version: nichts ausführen, klare Meldung zeigen
        error_log($e->getMessage());
        http_response_code(503);
        header('Retry-After: 3600');
        header('Cache-Control: no-store');
        if (str_starts_with((string) ($_SERVER['REQUEST_URI'] ?? ''), '/api/')) {
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['ok' => false, 'fehler' => $e->getMessage(), 'schema_zu_neu' => true], JSON_UNESCAPED_UNICODE);
        } else {
            header('Content-Type: text/html; charset=utf-8');
            echo '<!DOCTYPE html><html lang="' . sprache() . '"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' . htmlspecialchars(t('Neuere Datenbank'), ENT_QUOTES, 'UTF-8') . '</title>'
                . '<style>body{font-family:system-ui,sans-serif;background:#16110d;color:#f3ece4;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}main{max-width:560px}h1{font-size:1.4rem}p{line-height:1.5;color:#cfc5ba}</style></head><body><main><h1>' . htmlspecialchars(t('Diese Version ist älter als die Datenbank'), ENT_QUOTES, 'UTF-8') . '</h1><p>'
                . htmlspecialchars($e->getMessage(), ENT_QUOTES, 'UTF-8') . '</p></main></body></html>';
        }
        exit;
    } catch (Throwable $e) {
        if ($letzterFehler === '') {
            error_log('Automatische Migration fehlgeschlagen: ' . $e->getMessage());
            if ($fehlerDatei !== '') {
                @mkdir(dirname($fehlerDatei), 0775, true);
                @file_put_contents($fehlerDatei, mb_substr($e->getMessage(), 0, 2000));
            }
        }
        // Halb aktualisierte Datenbank: lieber eine klare Meldung als Folgefehler auf jeder Seite
        update_seite(t('Update fehlgeschlagen'), t('Eine Änderung an der Datenbank ist gescheitert (Details im Container-Log).') . ' ' . t('Amberwave versucht es in zwei Minuten erneut. Eine Sicherung vom Stand vor dem Update liegt im Sicherungsordner (Einstellungen › Sicherung).'), 120);
    }
}

/** 503-Seite (bzw. JSON für die API) während oder nach einem Datenbank-Update, beendet den Request */
function update_seite(string $titel, string $text, int $erneut): never
{
    http_response_code(503);
    header('Retry-After: ' . $erneut);
    header('Cache-Control: no-store');
    if (str_starts_with((string) ($_SERVER['REQUEST_URI'] ?? ''), '/api/')) {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => false, 'fehler' => $titel . ': ' . $text, 'update' => true], JSON_UNESCAPED_UNICODE);
    } else {
        header('Content-Type: text/html; charset=utf-8');
        echo '<!DOCTYPE html><html lang="' . sprache() . '"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="' . $erneut . '"><title>' . htmlspecialchars($titel, ENT_QUOTES, 'UTF-8') . '</title>'
            . '<style>body{font-family:system-ui,sans-serif;background:#16110d;color:#f3ece4;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}main{max-width:560px}h1{font-size:1.4rem}p{line-height:1.5;color:#cfc5ba}</style></head><body><main><h1>'
            . htmlspecialchars($titel, ENT_QUOTES, 'UTF-8') . '</h1><p>' . htmlspecialchars($text, ENT_QUOTES, 'UTF-8') . '</p></main></body></html>';
    }
    exit;
}

function starte_sichere_session(): void
{
    pruefe_migrationen_einmal();
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    sicherheits_header_senden();
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.gc_maxlifetime', (string) (konfig()['sicherheit']['sitzung_stunden'] * 3600));
    session_name('amberwave');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => ist_https(), 'httponly' => true, 'samesite' => 'Lax']);
    session_start();
}

// ---------- CSRF ----------

function csrf_token(): string
{
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return (string) $_SESSION['csrf_token'];
}

function csrf_feld(): string
{
    return '<input type="hidden" name="csrf_token" value="' . h(csrf_token()) . '">';
}

/** Formular (POST-Feld) oder API (Kopfzeile X-CSRF-Token). */
function csrf_pruefen(): bool
{
    $eingabe = (string) ($_POST['csrf_token'] ?? $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    return !empty($_SESSION['csrf_token']) && $eingabe !== '' && hash_equals((string) $_SESSION['csrf_token'], $eingabe);
}

// ---------- Registrierung / Login: Rate Limits ----------

function registrierung_erlaubt(string $ip): bool
{
    $n = (int) db_wert('SELECT COUNT(*) FROM registrierungs_versuche WHERE ip_adresse = :ip AND zeitstempel > (NOW() - INTERVAL 1 HOUR)', ['ip' => $ip]);
    return $n < konfig()['sicherheit']['registrierung_max_pro_stunde'];
}

function registrierungsversuch_protokollieren(string $ip): void
{
    db_tun('INSERT INTO registrierungs_versuche (ip_adresse) VALUES (:ip)', ['ip' => $ip]);
}

/**
 * Verbleibende Sperre in Sekunden (0 = Login erlaubt). Steigt pro Fehlversuch über der Schwelle (1/2/4/8 … Minuten).
 * Gezählt wird je Name UND Besucher-IP – ein Fremder kann so nicht das Konto eines anderen von außen aussperren.
 * Gegen Raten mit wechselnden Adressen: höchstens LOGIN_MAX_FEHLVERSUCHE_PRO_NAME_STUNDE Fehlversuche je Name und Stunde,
 * danach 5 Minuten Pause – aber nicht für Geräte, auf denen sich dieses Konto schon einmal angemeldet hat.
 */
function login_sperre_verbleibend(string $name, string $ip, ?string $absender = null): int
{
    $s = konfig()['sicherheit'];
    $absender ??= (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $sperre = login_sperre_fuer($name, 'ip_adresse', $ip, $s);
    if ($sperre === 0) {
        $n = (int) db_wert("SELECT COUNT(*) FROM login_versuche WHERE benutzername = :u AND erfolgreich = 0 AND zeitstempel > (NOW() - INTERVAL 1 HOUR)",
            ['u' => mb_substr($name, 0, 255)]);
        if ($n >= $s['login_max_pro_name_stunde'] && !login_bekanntes_geraet($name)) {
            $sperre = 300;
        }
    }
    return $sperre;
}

/** Hat sich dieses Konto auf diesem Browser schon einmal angemeldet (Geräte-Cookie gehört zu einem seiner Geräte)? */
function login_bekanntes_geraet(string $name): bool
{
    $roh = (string) ($_COOKIE['geraet'] ?? '');
    if ($roh === '' || !preg_match('/^[a-f0-9]{32,128}$/', $roh)) {
        return false;
    }
    try {
        return (bool) db_wert('SELECT 1 FROM nutzer_geraete g JOIN users u ON u.id = g.user_id WHERE g.geraet_hash = :h AND (u.benutzername = :a OR u.email = :b) LIMIT 1',
            ['h' => hash('sha256', $roh), 'a' => $name, 'b' => $name]);
    } catch (Throwable $e) {
        return false;
    }
}

function login_sperre_fuer(string $name, string $spalte, string $adresse, array $s, bool $adressLimit = true): int
{
    $versuche = db_alle("SELECT zeitstempel, erfolgreich FROM login_versuche WHERE benutzername = :u AND {$spalte} = :ip ORDER BY zeitstempel DESC, id DESC LIMIT 50",
        ['u' => mb_substr($name, 0, 255), 'ip' => $adresse]);
    $in_folge = 0;
    $letzter = null;
    foreach ($versuche as $v) {
        if ((int) $v['erfolgreich'] === 1) {
            break;
        }
        $in_folge++;
        $letzter ??= $v['zeitstempel'];
    }
    if ($adressLimit && (int) db_wert("SELECT COUNT(*) FROM login_versuche WHERE erfolgreich = 0 AND {$spalte} = :ip AND zeitstempel > (NOW() - INTERVAL 1 HOUR)",
        ['ip' => $adresse]) >= $s['login_max_pro_ip_stunde']) {
        return 300;
    }
    if ($in_folge < $s['login_max_fehlversuche'] || $letzter === null) {
        return 0;
    }
    $dauer = $s['login_sperre_basis_sekunden'] * (2 ** min(10, $in_folge - $s['login_max_fehlversuche']));
    $seit = (int) db_wert('SELECT TIMESTAMPDIFF(SECOND, :t, NOW())', ['t' => $letzter]);
    return max(0, $dauer - $seit);
}

function loginversuch_protokollieren(string $name, string $ip, bool $ok): void
{
    db_tun('INSERT INTO login_versuche (ip_adresse, absender, benutzername, erfolgreich) VALUES (:ip, :a, :u, :e)',
        ['ip' => $ip, 'a' => mb_substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45), 'u' => mb_substr($name, 0, 255), 'e' => $ok ? 1 : 0]);
}

// ---------- Remember-Me ----------

function remember_me_setzen(int $userId): void
{
    $tage = konfig()['sicherheit']['remember_me_tage'];
    $roh = bin2hex(random_bytes(32));
    db_tun('INSERT INTO remember_tokens (user_id, token_hash, gueltig_bis) VALUES (:u, :h, (NOW() + INTERVAL ' . (int) $tage . ' DAY))',
        ['u' => $userId, 'h' => hash('sha256', $roh)]);
    setcookie('remember_me', $userId . ':' . $roh, ['expires' => time() + $tage * 86400, 'path' => '/', 'secure' => ist_https(), 'httponly' => true, 'samesite' => 'Lax']);
}

function remember_me_pruefen(): ?array
{
    if (empty($_COOKIE['remember_me'])) {
        return null;
    }
    [$uid, $roh] = array_pad(explode(':', (string) $_COOKIE['remember_me'], 2), 2, '');
    if (!ctype_digit($uid) || !preg_match('/^[a-f0-9]{64}$/', $roh)) {
        return null;
    }
    $t = db_zeile('SELECT id FROM remember_tokens WHERE user_id = :u AND token_hash = :h AND gueltig_bis > NOW()', ['u' => (int) $uid, 'h' => hash('sha256', $roh)]);
    if (!$t) {
        return null;
    }
    if (!geraet_remember_erlaubt((int) $uid)) {
        remember_me_loeschen();
        $GLOBALS['geraet_abgemeldet'] = true;
        return null;
    }
    $user = db_zeile('SELECT * FROM users WHERE id = :id', ['id' => (int) $uid]);
    db_tun('DELETE FROM remember_tokens WHERE id = :id', ['id' => $t['id']]); // Rotation
    if (!$user) {
        return null;
    }
    remember_me_setzen((int) $user['id']);
    return $user;
}

function remember_me_loeschen(): void
{
    if (!empty($_COOKIE['remember_me'])) {
        [, $roh] = array_pad(explode(':', (string) $_COOKIE['remember_me'], 2), 2, '');
        if ($roh !== '') {
            db_tun('DELETE FROM remember_tokens WHERE token_hash = :h', ['h' => hash('sha256', $roh)]);
        }
    }
    setcookie('remember_me', '', ['expires' => time() - 3600, 'path' => '/', 'secure' => ist_https(), 'httponly' => true, 'samesite' => 'Lax']);
}

// ---------- Aktueller Nutzer ----------

function sperren_auto_aufheben(): void
{
    static $erledigt = false;
    if ($erledigt) {
        return;
    }
    $erledigt = true;
    try {
        db()->exec("UPDATE users SET status = 'aktiv', gesperrt_bis = NULL, sperr_grund = NULL, gesperrt_am = NULL
                    WHERE status = 'gesperrt' AND gesperrt_bis IS NOT NULL AND gesperrt_bis <= NOW()");
    } catch (Throwable $e) {
        error_log('Sperren aufheben: ' . $e->getMessage());
    }
}

function sperre_text(array $user): string
{
    $t = !empty($user['gesperrt_bis'])
        ? t('Dein Konto ist bis zum {datum} gesperrt.', ['datum' => formatiere_datum((string) $user['gesperrt_bis'])])
        : t('Dein Konto wurde gesperrt.');
    if (!empty($user['sperr_grund'])) {
        $t .= ' ' . t('Grund: {grund}', ['grund' => $user['sperr_grund']]);
    }
    return $t;
}

function account_ist_gueltig(array $user): bool
{
    if ($user['status'] !== 'aktiv') {
        return false;
    }
    if ($user['rolle'] === 'admin' || $user['gueltig_bis'] === null) {
        return true;
    }
    return strtotime((string) $user['gueltig_bis']) > time();
}

/** Aktuelles Gerät (Browser-Sitzung oder App-Schlüssel) */
function aktuelles_geraet_id(): ?int
{
    if (isset($GLOBALS['api_geraet_id'])) {
        return (int) $GLOBALS['api_geraet_id'];
    }
    return !empty($_SESSION['geraet_id']) ? (int) $_SESSION['geraet_id'] : null;
}

/** Bearer-Schlüssel aus der Kopfzeile (Apps). */
function bearer_token(): ?string
{
    $kopf = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (preg_match('/^Bearer\s+(\S+)$/i', $kopf, $m)) {
        return $m[1];
    }
    return null;
}

/** Angemeldeter Nutzer; setzt dabei die Sprache seines Kontos (users.sprache, leer = Browser/Cookie) */
function eingeloggter_user(): ?array
{
    $u = eingeloggter_user_roh();
    static $gesetzt = false;
    if ($u && !$gesetzt) {
        $gesetzt = true;
        if (in_array($u['sprache'] ?? '', array_keys(SPRACHEN), true)) {
            sprache((string) $u['sprache']);
        }
    }
    return $u;
}

function eingeloggter_user_roh(): ?array
{
    static $cache = false;
    if ($cache !== false) {
        return $cache;
    }
    sperren_auto_aufheben();

    // Zuhause über die Direktadresse: Direkt-Schlüssel in der Kopfzeile (ohne Sitzung; eine Kopfzeile kann eine fremde
    // Seite ohne CORS-Freigabe nicht setzen – daher kein CSRF nötig)
    $direkt = (string) ($_SERVER['HTTP_X_AMBERWAVE_DIREKT'] ?? '');
    if ($direkt !== '') {
        pruefe_migrationen_einmal();
        sicherheits_header_senden();
        require_once __DIR__ . '/direktzugang.php';
        $r = direkt_token_pruefen($direkt, 'api');
        if ($r) {
            if ($r[1]) {
                $GLOBALS['api_geraet_id'] = $r[1];
            }
            $GLOBALS['api_token_anmeldung'] = true;
            $GLOBALS['api_direkt'] = true;
            return $cache = $r[0];
        }
        return $cache = null;
    }

    // App mit Geräte-Schlüssel (ohne Sitzung, ohne CSRF)
    $token = bearer_token();
    if ($token !== null) {
        pruefe_migrationen_einmal();
        sicherheits_header_senden();
        $r = api_token_pruefen($token);
        if ($r) {
            $GLOBALS['api_geraet_id'] = $r[1];
            $GLOBALS['api_token_anmeldung'] = true;
            return $cache = $r[0];
        }
        return $cache = null;
    }

    starte_sichere_session();
    if (!empty($_SESSION['user_id'])) {
        $user = db_zeile('SELECT * FROM users WHERE id = :id', ['id' => (int) $_SESSION['user_id']]);
        if ($user) {
            if (empty($_SESSION['geraet_id'])) {
                $_SESSION['geraet_id'] = geraet_registrieren($user);
            } elseif (!geraet_aktiv((int) $user['id'], (int) $_SESSION['geraet_id'])) {
                $_SESSION = [];
                session_destroy();
                $GLOBALS['geraet_abgemeldet'] = true;
                return $cache = null;
            }
            return $cache = $user;
        }
    }
    $user = remember_me_pruefen();
    if ($user) {
        session_regenerate_id(true);
        $_SESSION['user_id'] = (int) $user['id'];
        $_SESSION['geraet_id'] = geraet_registrieren($user);
        return $cache = $user;
    }
    return $cache = null;
}

/** Für normale Seiten: ohne gültige Anmeldung zur Login-Seite. */
function benoetige_login_seite(bool $trotz_pflichtwechsel = false): array
{
    $user = eingeloggter_user();
    if (!$user || !account_ist_gueltig($user)) {
        header('Location: /login.php' . (!empty($GLOBALS['geraet_abgemeldet']) ? '?grund=geraet' : ''));
        exit;
    }
    if (!$trotz_pflichtwechsel && !empty($user['muss_passwort_aendern'])) {
        header('Location: /passwort-erzwingen.php');
        exit;
    }
    return $user;
}

function ist_admin(?array $user): bool
{
    return $user !== null && $user['rolle'] === 'admin';
}

/** Anzeigename */
function voller_name(array $user): string
{
    $n = trim(($user['vorname'] ?? '') . ' ' . ($user['nachname'] ?? ''));
    return $n !== '' ? $n : (string) $user['benutzername'];
}

/** Nach erfolgreicher Prüfung von Name+Passwort: Sitzung starten. */
function anmelden(array $user, bool $merken): void
{
    session_regenerate_id(true);
    $_SESSION['user_id'] = (int) $user['id'];
    $_SESSION['geraet_id'] = geraet_registrieren($user);
    if ($merken) {
        remember_me_setzen((int) $user['id']);
    }
    log_sicherheitsereignis((int) $user['id'], 'login_erfolgreich');
    if (($user['rolle'] ?? '') === 'admin') {
        app_url_lernen();
    }
}

/**
 * Prüft Benutzername/E-Mail + Passwort inkl. Sperren. Liefert ['user' => …] oder ['fehler' => …].
 * Wird von der Login-Seite und von der App-Anmeldung (Geräte-Schlüssel) gleichermaßen genutzt.
 */
function anmeldung_pruefen(string $name, string $passwort): array
{
    $ip = client_ip();
    $name = trim($name);
    $sperre = login_sperre_verbleibend($name, $ip);
    if ($sperre > 0) {
        return ['fehler' => tn((int) ceil($sperre / 60), 'Zu viele Fehlversuche. Bitte in etwa einer Minute erneut versuchen.', 'Zu viele Fehlversuche. Bitte in etwa {n} Minuten erneut versuchen.'), 'sperre' => $sperre];
    }
    sperren_auto_aufheben();
    $user = db_zeile('SELECT * FROM users WHERE benutzername = :a OR email = :b ORDER BY (benutzername = :c) DESC LIMIT 1',
        ['a' => $name, 'b' => $name, 'c' => $name]);
    if (!$user) {
        passwort_schein_pruefung($passwort);
        loginversuch_protokollieren($name, $ip, false);
        return ['fehler' => t('Benutzername/E-Mail oder Passwort ist falsch.')];
    }
    if (!password_verify($passwort, (string) $user['passwort_hash'])) {
        loginversuch_protokollieren($name, $ip, false);
        return ['fehler' => t('Benutzername/E-Mail oder Passwort ist falsch.')];
    }
    passwort_hash_aktualisieren((int) $user['id'], $passwort, (string) $user['passwort_hash']);
    if ($user['status'] === 'pending') {
        loginversuch_protokollieren($name, $ip, false);
        return ['fehler' => t('Dein Konto wartet noch auf Freischaltung durch den Administrator.')];
    }
    if ($user['status'] === 'gesperrt') {
        loginversuch_protokollieren($name, $ip, false);
        return ['fehler' => sperre_text($user)];
    }
    if (!account_ist_gueltig($user)) {
        loginversuch_protokollieren($name, $ip, false);
        return ['fehler' => t('Dein Konto ist abgelaufen. Bitte den Administrator kontaktieren.')];
    }
    loginversuch_protokollieren($name, $ip, true);
    return ['user' => $user];
}

function abmelden(): void
{
    $user = eingeloggter_user();
    if ($user && !empty($_SESSION['geraet_id'])) {
        geraet_beenden((int) $user['id'], (int) $_SESSION['geraet_id']);
    }
    remember_me_loeschen();
    $_SESSION = [];
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_destroy();
    }
    setcookie('amberwave', '', ['expires' => time() - 3600, 'path' => '/']);
}
