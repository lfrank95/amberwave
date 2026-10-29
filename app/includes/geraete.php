<?php
declare(strict_types=1);
require_once __DIR__ . '/sicherheit.php';

/**
 * Geräte-Begrenzung: pro Nutzer höchstens N gleichzeitig angemeldete Geräte.
 * Browser werden über ein langlebiges Cookie "geraet" erkannt, Apps über ihren Geräte-Schlüssel.
 * Meldet sich ein weiteres Gerät an, wird das am längsten ungenutzte abgemeldet.
 */

function geraete_max(array $user): int
{
    $c = konfig()['sicherheit'];
    return $user['rolle'] === 'admin' ? (int) $c['max_geraete_admin'] : (int) $c['max_geraete'];
}

function geraet_cookie_hash(bool $anlegen = true): ?string
{
    $roh = (string) ($_COOKIE['geraet'] ?? '');
    if (!preg_match('/^[a-f0-9]{48}$/', $roh)) {
        if (!$anlegen) {
            return null;
        }
        $roh = bin2hex(random_bytes(24));
        $_COOKIE['geraet'] = $roh;
        if (!headers_sent()) {
            setcookie('geraet', $roh, ['expires' => time() + 400 * 86400, 'path' => '/', 'secure' => ist_https(), 'httponly' => true, 'samesite' => 'Lax']);
        }
    }
    return hash('sha256', $roh);
}

function geraet_name_aus_ua(string $ua): string
{
    // Amberwave Windows Client: „AmberwaveClient/0.3.0 (COMPUTERNAME)“
    if (preg_match('~AmberwaveClient/[\d.]+(?: \(([A-Za-z0-9._-]{1,40})\))?~', $ua, $m)) {
        return !empty($m[1]) ? $m[1] . ' · Windows Client' : 'Windows Client';
    }
    $browser = 'Browser';
    foreach (['Edg' => 'Edge', 'OPR' => 'Opera', 'SamsungBrowser' => 'Samsung Internet', 'Firefox' => 'Firefox', 'CriOS' => 'Chrome', 'Chrome' => 'Chrome', 'Safari' => 'Safari'] as $k => $v) {
        if (stripos($ua, $k) !== false) { $browser = $v; break; }
    }
    $os = t('unbekanntem System');
    foreach (['iPhone' => 'iPhone', 'iPad' => 'iPad', 'Android' => 'Android', 'Windows' => 'Windows', 'Mac OS' => 'macOS', 'Linux' => 'Linux'] as $k => $v) {
        if (stripos($ua, $k) !== false) { $os = $v; break; }
    }
    return t('{browser} auf {os}', ['browser' => $browser, 'os' => $os]);
}

/** Überzählige Geräte (am längsten ungenutzt zuerst) abmelden. */
function geraete_begrenzen(array $user, int $behalten_id): void
{
    $max = geraete_max($user);
    if ($max <= 0) {
        return;
    }
    $andere = array_map('intval', array_column(db_alle(
        'SELECT id FROM nutzer_geraete WHERE user_id = :u AND beendet_am IS NULL AND id <> :id ORDER BY zuletzt_am ASC',
        ['u' => (int) $user['id'], 'id' => $behalten_id]
    ), 'id'));
    $zuviel = count($andere) + 1 - $max;
    for ($i = 0; $i < $zuviel; $i++) {
        geraet_beenden_intern($andere[$i], 'verdraengt');
        rate_zaehlen('geraet_wechsel', (string) $user['id']);
    }
    if ($zuviel > 0) {
        log_sicherheitsereignis((int) $user['id'], 'geraet_verdraengt', $zuviel . ' Gerät(e) abgemeldet');
    }
}

/** Gerät dieses Browsers anlegen/reaktivieren. Liefert die Geräte-ID. */
function geraet_registrieren(array $user): int
{
    $uid = (int) $user['id'];
    $hash = geraet_cookie_hash();
    $name = mb_substr(geraet_name_aus_ua((string) ($_SERVER['HTTP_USER_AGENT'] ?? '')), 0, 120);
    $ip = mb_substr(client_ip(), 0, 64);
    $id = (int) db_wert('SELECT id FROM nutzer_geraete WHERE user_id = :u AND geraet_hash = :h', ['u' => $uid, 'h' => $hash]);
    if ($id) {
        db_tun("UPDATE nutzer_geraete SET beendet_am = NULL, ende_grund = NULL, zuletzt_am = NOW(), name = :n, ip = :ip WHERE id = :id",
            ['n' => $name, 'ip' => $ip, 'id' => $id]);
    } else {
        $id = db_einfuegen("INSERT INTO nutzer_geraete (user_id, art, geraet_hash, name, ip) VALUES (:u, 'browser', :h, :n, :ip)",
            ['u' => $uid, 'h' => $hash, 'n' => $name, 'ip' => $ip]);
    }
    geraete_begrenzen($user, $id);
    return $id;
}

/** true = Gerät noch aktiv. Aktualisiert "zuletzt" höchstens einmal pro Minute. */
function geraet_aktiv(int $userId, int $geraetId): bool
{
    $z = db_zeile('SELECT beendet_am FROM nutzer_geraete WHERE id = :id AND user_id = :u', ['id' => $geraetId, 'u' => $userId]);
    if (!$z || $z['beendet_am'] !== null) {
        return false;
    }
    // Name mitziehen (Browser-Update, Windows Client mit Computername statt „Chrome auf Windows“)
    $ua = (string) ($_SERVER['HTTP_USER_AGENT'] ?? '');
    $name = $ua !== '' ? mb_substr(geraet_name_aus_ua($ua), 0, 120) : null;
    db_tun('UPDATE nutzer_geraete SET zuletzt_am = NOW(), name = COALESCE(:n, name) WHERE id = :id AND zuletzt_am < (NOW() - INTERVAL 60 SECOND)', ['id' => $geraetId, 'n' => $name]);
    return true;
}

/** Remember-Me darf nur ein nicht abgemeldetes Gerät wieder anmelden. */
function geraet_remember_erlaubt(int $userId): bool
{
    $hash = geraet_cookie_hash(false);
    if ($hash === null) {
        return true;
    }
    $z = db_zeile('SELECT beendet_am FROM nutzer_geraete WHERE user_id = :u AND geraet_hash = :h', ['u' => $userId, 'h' => $hash]);
    return !$z || $z['beendet_am'] === null;
}

function geraete_aktive(int $userId): array
{
    return db_alle('SELECT id, art, name, eigener_name, ip, erstellt_am, zuletzt_am FROM nutzer_geraete WHERE user_id = :u AND beendet_am IS NULL ORDER BY zuletzt_am DESC', ['u' => $userId]);
}

function geraet_beenden_intern(int $geraetId, string $grund): void
{
    db_tun('UPDATE nutzer_geraete SET beendet_am = NOW(), ende_grund = :g WHERE id = :id AND beendet_am IS NULL', ['g' => $grund, 'id' => $geraetId]);
    db_tun('UPDATE api_tokens SET widerrufen_am = NOW() WHERE geraet_id = :id AND widerrufen_am IS NULL', ['id' => $geraetId]);
}

function geraet_beenden(int $userId, int $geraetId): bool
{
    $ok = (bool) db_wert('SELECT id FROM nutzer_geraete WHERE id = :id AND user_id = :u AND beendet_am IS NULL', ['id' => $geraetId, 'u' => $userId]);
    if ($ok) {
        geraet_beenden_intern($geraetId, 'manuell');
    }
    return $ok;
}

// ---------- Geräte-Schlüssel für Apps ----------

/** Neues App-Gerät mit Schlüssel anlegen. Liefert [token_klartext, geraet_id]. Der Klartext wird nur einmal herausgegeben. */
function api_token_erstellen(array $user, string $name): array
{
    $name = mb_substr(trim($name) !== '' ? trim($name) : 'App', 0, 120);
    $roh = 'aw_' . bin2hex(random_bytes(32));
    $hash = hash('sha256', $roh);
    $geraet = db_einfuegen("INSERT INTO nutzer_geraete (user_id, art, geraet_hash, name, ip) VALUES (:u, 'app', :h, :n, :ip)",
        ['u' => (int) $user['id'], 'h' => hash('sha256', 'app|' . $hash), 'n' => $name, 'ip' => mb_substr(client_ip(), 0, 64)]);
    $tage = (int) konfig()['sicherheit']['api_token_tage'];
    db_tun('INSERT INTO api_tokens (user_id, geraet_id, token_hash, name, gueltig_bis) VALUES (:u, :g, :h, :n, ' . ($tage > 0 ? '(NOW() + INTERVAL ' . $tage . ' DAY)' : 'NULL') . ')',
        ['u' => (int) $user['id'], 'g' => $geraet, 'h' => $hash, 'n' => $name]);
    geraete_begrenzen($user, $geraet);
    return [$roh, $geraet];
}

/** Prüft einen Geräte-Schlüssel. Liefert [user, geraet_id] oder null. */
function api_token_pruefen(string $roh): ?array
{
    if (!preg_match('/^aw_[a-f0-9]{64}$/', $roh)) {
        return null;
    }
    $t = db_zeile(
        'SELECT t.id AS token_id, t.geraet_id, g.beendet_am FROM api_tokens t JOIN nutzer_geraete g ON g.id = t.geraet_id
         WHERE t.token_hash = :h AND t.widerrufen_am IS NULL AND (t.gueltig_bis IS NULL OR t.gueltig_bis > NOW())',
        ['h' => hash('sha256', $roh)]
    );
    if (!$t || $t['beendet_am'] !== null) {
        return null;
    }
    $user = db_zeile('SELECT u.* FROM users u JOIN api_tokens t ON t.user_id = u.id WHERE t.id = :t', ['t' => $t['token_id']]);
    if (!$user) {
        return null;
    }
    db_tun('UPDATE api_tokens SET zuletzt_am = NOW() WHERE id = :id AND (zuletzt_am IS NULL OR zuletzt_am < (NOW() - INTERVAL 60 SECOND))', ['id' => $t['token_id']]);
    db_tun('UPDATE nutzer_geraete SET zuletzt_am = NOW() WHERE id = :id AND zuletzt_am < (NOW() - INTERVAL 60 SECOND)', ['id' => $t['geraet_id']]);
    return [$user, (int) $t['geraet_id']];
}
