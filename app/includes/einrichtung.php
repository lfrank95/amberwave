<?php
// Einrichtung beim ersten Start: Datenbank anlegen, Tabellen, erstes Admin-Konto – über eine Seite im Browser
// (/einrichtung.php), ohne Passwörter in der .env.
//
// Ablauf: MariaDB startet nur mit dem Root-Zugang (ohne Passwort, nur im internen Stack-Netz). Die Einrichtungsseite legt
// Datenbank und Benutzer an (Name, Benutzer, Passwort vorausgefüllt und änderbar), führt die Migrationen aus, legt den Admin an
// und gibt dem Root-Zugang danach ein zufälliges Passwort. Alles Geheime liegt in PFAD_CACHE/geheimnisse/ (Rechte 0600).
//
// Schutz (Portainer-Weg): Die Seite ist nur eine begrenzte Zeit nach dem Start des Containers offen (EINRICHTUNG_FENSTER_MINUTEN,
// Standard 30; danach docker restart amberwave_app). Aus dem direkten Heimnetz geht es ohne Code; über einen Proxy, Tunnel
// oder aus dem Internet braucht es den Einrichtungscode aus dem Container-Log bzw. aus geheimnisse/einrichtungscode.
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/hilfen.php';

// ---------- Geheimnisse im Cache-Ordner ----------

function geheimnisse_ordner(): string
{
    $d = rtrim((string) konfig()['pfade']['cache'], '/') . '/geheimnisse';
    if (!is_dir($d)) {
        @mkdir($d, 0700, true);
    }
    return $d;
}

function geheimnis_lesen(string $name): string
{
    $p = geheimnisse_ordner() . '/' . $name;
    return is_file($p) ? trim((string) @file_get_contents($p)) : '';
}

/** Datei atomar schreiben (nur für den Webserver-Benutzer lesbar) */
function geheimnis_schreiben(string $name, string $inhalt): bool
{
    $p = geheimnisse_ordner() . '/' . $name;
    $tmp = $p . '.' . bin2hex(random_bytes(3)) . '.tmp';
    if (@file_put_contents($tmp, $inhalt . "\n", LOCK_EX) === false) {
        @unlink($tmp);
        return false;
    }
    @chmod($tmp, 0600);
    if (!@rename($tmp, $p)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

function geheimnis_loeschen(string $name): void
{
    @unlink(geheimnisse_ordner() . '/' . $name);
}

// ---------- Zustand ----------

/** Fehlernummer der Datenbank (1045 = Zugang verweigert, 1049 = Datenbank fehlt, 2002 = nicht erreichbar …) */
function einrichtung_fehlernummer(Throwable $e): int
{
    if ($e instanceof PDOException && isset($e->errorInfo[1])) {
        return (int) $e->errorInfo[1];
    }
    if (preg_match('/\[(\d{4})\]/', $e->getMessage(), $m)) {
        return (int) $m[1];
    }
    return is_int($e->getCode()) ? $e->getCode() : 0;
}

function einrichtung_pdo(string $user, string $pw, ?string $name): PDO
{
    $c = konfig()['db'];
    $dsn = sprintf('mysql:host=%s;port=%d;charset=utf8mb4%s', $c['host'], $c['port'], $name !== null && $name !== '' ? ';dbname=' . $name : '');
    return new PDO($dsn, $user, $pw, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 4, PDO::ATTR_EMULATE_PREPARES => true]);
}

/**
 * Wo steht diese Installation?
 *   fertig   – Datenbank erreichbar und mindestens ein Konto vorhanden (Marke „eingerichtet“ wird gesetzt)
 *   leer     – Datenbank erreichbar, aber noch kein Konto (Tabellen/Admin fehlen)
 *   db_fehlt – Zugang verweigert oder Datenbank gibt es nicht: Datenbank und Benutzer müssen noch angelegt werden
 *   wartet   – Datenbank nicht erreichbar (startet noch)
 */
function einrichtung_zustand(bool $neu = false): array
{
    static $z = null;
    if ($z !== null && !$neu) {
        return $z;
    }
    if (is_file(geheimnisse_ordner() . '/eingerichtet')) {
        return $z = ['art' => 'fertig'];
    }
    $c = konfig()['db'];
    try {
        $pdo = einrichtung_pdo((string) $c['user'], (string) $c['password'], (string) $c['name']);
    } catch (Throwable $e) {
        $nr = einrichtung_fehlernummer($e);
        // 1045/1044 = Zugang verweigert, 1049 = Datenbank gibt es nicht (MariaDB); 2012 = kein Zugang vorhanden (andere Server)
        return $z = (in_array($nr, [1044, 1045, 1049, 2012], true) || preg_match('/access denied|unknown database|authentication/i', $e->getMessage()))
            ? ['art' => 'db_fehlt', 'meldung' => $e->getMessage()]
            : ['art' => 'wartet', 'meldung' => $e->getMessage()];
    }
    try {
        $n = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    } catch (Throwable $e) {
        $n = 0; // Tabelle fehlt noch
    }
    if ($n > 0) {
        geheimnis_schreiben('eingerichtet', (string) time());
        return $z = ['art' => 'fertig'];
    }
    return $z = ['art' => 'leer'];
}

function ist_eingerichtet(): bool
{
    return einrichtung_zustand()['art'] === 'fertig';
}

// ---------- Zugang: Zeitfenster, Heimnetz, Code ----------

function einrichtung_fenster_neu(): void
{
    geheimnis_schreiben('fenster', (string) time());
}

/** Verbleibende Sekunden, in denen die Einrichtung offen ist (PHP_INT_MAX = unbegrenzt) */
function einrichtung_fenster_rest(): int
{
    $min = (int) konfig()['einrichtung']['fenster_minuten'];
    if ($min <= 0) {
        return PHP_INT_MAX;
    }
    $start = (int) geheimnis_lesen('fenster');
    if ($start <= 0) {
        einrichtung_fenster_neu();
        $start = time();
    }
    return max(0, $start + $min * 60 - time());
}

/**
 * Kommt diese Anfrage direkt aus dem Heimnetz? ['lokal' => bool, 'grund' => proxy|bruecke|extern|lokal, 'ip' => Absender]
 *  – Proxy- oder Tunnel-Kopfzeilen: nicht direkt;
 *  – Absender ist die Docker-Brücke (Standard-Gateway des Containers): über sie kommt auch Dockers eigene Portweiterleitung,
 *    die Zugriffe aus dem Internet wie lokale aussehen lassen kann – deshalb nicht als Heimnetz werten;
 *  – private Adresse (LOKALE_NETZE) oder IPv6 aus demselben Netz (/64) wie der Container selbst: Heimnetz.
 */
function einrichtung_herkunft(): array
{
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    foreach (['HTTP_X_FORWARDED_FOR', 'HTTP_FORWARDED', 'HTTP_X_REAL_IP', 'HTTP_CF_CONNECTING_IP', 'HTTP_CF_RAY', 'HTTP_TRUE_CLIENT_IP',
        'HTTP_X_FORWARDED_HOST', 'HTTP_X_FORWARDED_PROTO', 'HTTP_VIA'] as $k) {
        if (!empty($_SERVER[$k])) {
            return ['lokal' => false, 'grund' => 'proxy', 'ip' => $ip];
        }
    }
    if (!filter_var($ip, FILTER_VALIDATE_IP)) {
        return ['lokal' => false, 'grund' => 'extern', 'ip' => $ip];
    }
    if ($ip !== '127.0.0.1' && $ip !== '::1' && $ip === docker_gateway_ip()) {
        return ['lokal' => false, 'grund' => 'bruecke', 'ip' => $ip];
    }
    foreach (konfig()['netz']['lokale_netze'] as $netz) {
        if (ip_in_netz($ip, str_contains($netz, '/') ? $netz : $netz . (str_contains($netz, ':') ? '/128' : '/32'))) {
            return ['lokal' => true, 'grund' => 'lokal', 'ip' => $ip];
        }
    }
    // weltweite IPv6-Adresse aus demselben /64 wie der Container (Container direkt im Heimnetz, z. B. Unraid br0)
    if (str_contains($ip, ':')) {
        foreach (@file('/proc/net/if_inet6') ?: [] as $z) {
            $f = preg_split('/\s+/', trim($z));
            if (count($f) < 6 || $f[5] === 'lo' || str_starts_with($f[0], 'fe80')) {
                continue;
            }
            $eigen = implode(':', str_split($f[0], 4));
            if (ip_in_netz($ip, $eigen . '/64')) {
                return ['lokal' => true, 'grund' => 'lokal', 'ip' => $ip];
            }
        }
    }
    return ['lokal' => false, 'grund' => 'extern', 'ip' => $ip];
}

function einrichtung_ist_direkt_lokal(): bool
{
    return einrichtung_herkunft()['lokal'];
}

function einrichtung_code_noetig(): bool
{
    return konfig()['einrichtung']['code_immer'] || !einrichtung_ist_direkt_lokal();
}

/** Der Einrichtungscode (XXXX-XXXX): aus EINRICHTUNGSCODE, sonst zufällig erzeugt und in geheimnisse/einrichtungscode abgelegt */
function einrichtung_code(): string
{
    $e = trim((string) konfig()['einrichtung']['code']);
    if ($e !== '') {
        return $e;
    }
    $alt = geheimnis_lesen('einrichtungscode');
    if ($alt !== '') {
        return $alt;
    }
    $zeichen = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    $s = '';
    for ($i = 0; $i < 8; $i++) {
        $s .= $zeichen[random_int(0, strlen($zeichen) - 1)];
    }
    $s = substr($s, 0, 4) . '-' . substr($s, 4);
    geheimnis_schreiben('einrichtungscode', $s);
    return $s;
}

function einrichtung_code_norm(string $s): string
{
    return strtoupper((string) preg_replace('/[^A-Za-z0-9]/', '', $s));
}

/** Code prüfen – mit Bremse gegen Raten (8 Fehlversuche → 5 Minuten Pause, für alle) */
function einrichtung_code_pruefen(string $eingabe): ?string
{
    $datei = 'code_versuche';
    $d = json_decode(geheimnis_lesen($datei), true);
    $d = is_array($d) ? $d : ['n' => 0, 'bis' => 0];
    if ((int) $d['bis'] > time()) {
        return tn((int) ceil(((int) $d['bis'] - time()) / 60), 'Zu viele falsche Codes. Bitte in einer Minute erneut versuchen.', 'Zu viele falsche Codes. Bitte in {n} Minuten erneut versuchen.');
    }
    if ($eingabe === '') {
        return t('Bitte den Einrichtungscode eintragen. Er steht im Log von amberwave_app und in der Datei cache/geheimnisse/einrichtungscode.');
    }
    if (hash_equals(einrichtung_code_norm(einrichtung_code()), einrichtung_code_norm($eingabe))) {
        geheimnis_loeschen($datei);
        return null;
    }
    $d['n'] = (int) $d['n'] + 1;
    if ($d['n'] >= 8) {
        $d = ['n' => 0, 'bis' => time() + 300];
    }
    geheimnis_schreiben($datei, (string) json_encode($d));
    return t('Der Einrichtungscode stimmt nicht. Er steht im Log von amberwave_app und in der Datei cache/geheimnisse/einrichtungscode.');
}

/**
 * Darf diese Anfrage einrichten? Liefert null (ja) oder ['art' => 'fenster'|'code', 'meldung' => …].
 * $eingabeCode: der mitgeschickte Code (nur nötig, wenn einrichtung_code_noetig()).
 */
function einrichtung_zugang(string $eingabeCode = ''): ?array
{
    if (einrichtung_fenster_rest() <= 0) {
        return ['art' => 'fenster', 'meldung' => t('Das Einrichtungsfenster ist abgelaufen.')];
    }
    if (einrichtung_code_noetig()) {
        $f = einrichtung_code_pruefen($eingabeCode);
        if ($f !== null) {
            return ['art' => 'code', 'meldung' => $f];
        }
    }
    return null;
}

// ---------- Eingaben prüfen ----------

function einrichtung_zufallspasswort(int $laenge = 20): string
{
    $z = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $s = '';
    for ($i = 0; $i < $laenge; $i++) {
        $s .= $z[random_int(0, strlen($z) - 1)];
        if ($i % 4 === 3 && $i < $laenge - 1) {
            $s .= '-';
        }
    }
    return $s;
}

/** Alle Eingaben der Einrichtung prüfen; Liste der Fehler (leer = ok). $art = Zustand (db_fehlt verlangt auch die Datenbank-Angaben) */
function einrichtung_eingaben_pruefen(array $in, string $art, bool $adminNoetig): array
{
    require_once __DIR__ . '/sicherheit.php';
    $f = [];
    if ($adminNoetig) {
        foreach (['vorname' => t('Vorname'), 'nachname' => t('Nachname')] as $k => $n) {
            $v = trim((string) ($in[$k] ?? ''));
            if ($v === '' || mb_strlen($v) > 100) {
                $f[$k] = t('{feld} fehlt oder ist zu lang.', ['feld' => $n]);
            }
        }
        $b = trim((string) ($in['benutzername'] ?? ''));
        if (!preg_match('/^[\p{L}0-9._-]{3,50}$/u', $b)) {
            $f['benutzername'] = t('Benutzername: 3–50 Zeichen (Buchstaben, Ziffern, . _ -).');
        }
        $m = trim((string) ($in['email'] ?? ''));
        if (!filter_var($m, FILTER_VALIDATE_EMAIL) || mb_strlen($m) > 255) {
            $f['email'] = t('Bitte eine gültige E-Mail-Adresse angeben.');
        }
        $pw = (string) ($in['passwort'] ?? '');
        if (($s = passwort_ist_zu_schwach($pw)) !== null) {
            $f['passwort'] = $s;
        } elseif ($pw !== (string) ($in['passwort2'] ?? '')) {
            $f['passwort2'] = t('Die Passwörter stimmen nicht überein.');
        }
    }
    $zone = trim((string) ($in['zeitzone'] ?? ''));
    if ($zone !== '' && !in_array($zone, timezone_identifiers_list(), true)) {
        $f['zeitzone'] = t('Diese Zeitzone kennt der Server nicht.');
    }
    if (mb_strlen(trim((string) ($in['servername'] ?? ''))) > 60) {
        $f['servername'] = t('Der Servername darf höchstens 60 Zeichen haben.');
    }
    if ($art === 'db_fehlt') {
        if (!preg_match('/^[A-Za-z][A-Za-z0-9_]{0,31}$/', (string) ($in['db_name'] ?? ''))) {
            $f['db_name'] = t('Datenbank: Buchstabe am Anfang, dann Buchstaben, Ziffern, Unterstrich (bis 32 Zeichen).');
        }
        if (!preg_match('/^[A-Za-z][A-Za-z0-9_]{0,31}$/', (string) ($in['db_user'] ?? ''))) {
            $f['db_user'] = t('Benutzer: Buchstabe am Anfang, dann Buchstaben, Ziffern, Unterstrich (bis 32 Zeichen).');
        }
        $dp = (string) ($in['db_passwort'] ?? '');
        if (mb_strlen($dp) < 16 || preg_match('/[\x00-\x1F\x7F\s]/', $dp) || stripos($dp, 'aendere') !== false) {
            $f['db_passwort'] = t('Datenbank-Passwort: mindestens 16 Zeichen, ohne Leerzeichen.');
        }
    }
    return $f;
}

// ---------- Datenbank anlegen (Root) ----------

function einrichtung_root_passwoerter(): array
{
    $liste = [];
    $e = trim((string) getenv('DB_ROOT_PASSWORD'));
    if ($e !== '') {
        $liste[] = $e;
    }
    $d = geheimnis_lesen('db_root_passwort');
    if ($d !== '') {
        $liste[] = $d;
    }
    $liste[] = ''; // Standard beim ersten Start: Root ohne Passwort, nur im internen Stack-Netz
    return array_values(array_unique($liste));
}

function einrichtung_root_verbinden(): PDO
{
    $letzter = null;
    foreach (einrichtung_root_passwoerter() as $pw) {
        try {
            return einrichtung_pdo('root', $pw, null);
        } catch (Throwable $e) {
            $letzter = $e;
        }
    }
    throw new RuntimeException(t('Kein Zugang zur Datenbank als Verwalter (root). Steht in der .env ein DB_ROOT_PASSWORD, muss es stimmen. ({grund})', ['grund' => $letzter ? $letzter->getMessage() : '']));
}

/** Datenbank und Benutzer anlegen (wiederholbar) und die Zugangsdaten als geheimnisse/datenbank.json merken */
function einrichtung_datenbank_anlegen(string $name, string $user, string $pw, bool $merken = true): void
{
    $root = einrichtung_root_verbinden();
    $q = static fn(string $s): string => '`' . str_replace('`', '``', $s) . '`';
    $root->exec('CREATE DATABASE IF NOT EXISTS ' . $q($name) . ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    $u = $root->quote($user) . '@' . $root->quote('%');
    $root->exec('CREATE USER IF NOT EXISTS ' . $u . ' IDENTIFIED BY ' . $root->quote($pw));
    $root->exec('ALTER USER ' . $u . ' IDENTIFIED BY ' . $root->quote($pw));
    $root->exec('GRANT ALL PRIVILEGES ON ' . $q(str_replace('_', '\\_', $name)) . '.* TO ' . $u);
    $root->exec('FLUSH PRIVILEGES');
    if ($merken && !geheimnis_schreiben('datenbank.json', (string) json_encode(['name' => $name, 'user' => $user, 'passwort' => $pw]))) {
        throw new RuntimeException(t('Konnte die Zugangsdaten nicht in den Cache-Ordner schreiben (geheimnisse/). Ist CACHE_PFAD beschreibbar?'));
    }
}

/** Root bekommt ein zufälliges Passwort (Notfallzugang: geheimnisse/db_root_passwort) – nur wenn es nicht in der .env steht */
function einrichtung_root_absichern(bool $nurOffen = false): bool
{
    if (trim((string) getenv('DB_ROOT_PASSWORD')) !== '') {
        return false;
    }
    try {
        // $nurOffen: nur eingreifen, wenn Root noch ohne Passwort offen ist (Nachholen beim Start)
        $root = $nurOffen ? einrichtung_pdo('root', '', null) : einrichtung_root_verbinden();
    } catch (Throwable $e) {
        return false; // schon abgesichert
    }
    $neu = bin2hex(random_bytes(16));
    try {
        $hosts = $root->query("SELECT DISTINCT Host FROM mysql.user WHERE User = 'root'")->fetchAll(PDO::FETCH_COLUMN) ?: ['%', 'localhost'];
    } catch (Throwable $e) {
        $hosts = ['%', 'localhost'];
    }
    // erst die Datei, dann die Datenbank: so geht der Notfallzugang nie verloren
    if (!geheimnis_schreiben('db_root_passwort', $neu)) {
        return false;
    }
    foreach ($hosts as $h) {
        try {
            $root->exec('ALTER USER ' . $root->quote('root') . '@' . $root->quote((string) $h) . ' IDENTIFIED BY ' . $root->quote($neu));
        } catch (Throwable $e) {
            error_log('Root absichern (' . $h . '): ' . $e->getMessage());
        }
    }
    return true;
}

// ---------- Admin anlegen ----------

/** Legt den ersten Admin an – nur, wenn es noch kein Konto gibt. true = angelegt */
function einrichtung_admin_anlegen(array $in): bool
{
    require_once __DIR__ . '/db.php';
    require_once __DIR__ . '/sicherheit.php';
    if ((int) db_wert('SELECT COUNT(*) FROM users') > 0) {
        return false;
    }
    db_tun("INSERT INTO users (vorname, nachname, benutzername, email, passwort_hash, rolle, status, aktiviert_am, muss_passwort_aendern, sprache)
            VALUES (:v, :n, :b, :e, :p, 'admin', 'aktiv', NOW(), 0, :s)", [
        's' => isset(SPRACHEN[(string) ($in['sprache'] ?? '')]) ? (string) $in['sprache'] : null,
        'v' => trim((string) $in['vorname']), 'n' => trim((string) $in['nachname']), 'b' => trim((string) $in['benutzername']),
        'e' => trim((string) $in['email']), 'p' => passwort_hashen((string) $in['passwort']),
    ]);
    return true;
}

/** Kopie des automatisch erzeugten Schlüssels neben die Sicherungen (ohne ihn sind gespeicherte Zugangsdaten nach einem Neuaufbau unlesbar) */
function schluessel_sichern(): bool
{
    $k = konfig();
    if (empty($k['app_secret_key_erzeugt'])) {
        return false; // steht in der .env – den kennt der Betreiber
    }
    $dir = rtrim((string) $k['pfade']['backups'], '/');
    if ($dir === '' || !is_dir($dir) || !is_writable($dir)) {
        return false;
    }
    $p = $dir . '/app_secret_key.txt';
    if (is_file($p) && trim((string) @file_get_contents($p)) === $k['app_secret_key']) {
        return true;
    }
    if (@file_put_contents($p, $k['app_secret_key'] . "\n") === false) {
        return false;
    }
    @chmod($p, 0600);
    return true;
}

// ---------- Umleitung für alle anderen Seiten ----------

/** Solange nicht eingerichtet: Seiten leiten zur Einrichtung, die API antwortet mit 503 */
function einrichtung_umleiten(array $z): never
{
    $pfad = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    header('Cache-Control: no-store');
    if (str_starts_with($pfad, '/api/')) {
        http_response_code(503);
        header('Retry-After: 30');
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['ok' => false, 'einrichtung' => true, 'fehler' => $z['art'] === 'wartet'
            ? t('Die Datenbank startet noch – bitte einen Moment warten.') : t('{app} ist noch nicht eingerichtet (/einrichtung.php).', ['app' => app_name()])], JSON_UNESCAPED_UNICODE);
        exit;
    }
    header('Location: /einrichtung.php');
    exit;
}

// ---------- Einstellungen › Dienste & Schlüssel › Datenbank (nur Admin) ----------

/** Admin bestätigt mit seinem Anmelde-Passwort (Zeigen/Ändern von Zugangsdaten) */
function datenbank_admin_bestaetigen(array $admin): void
{
    require_once __DIR__ . '/api.php';
    require_once __DIR__ . '/sicherheit.php';
    if (!rate_erlaubt('datenbank_zugang', (string) $admin['id'], 10, 3600)) {
        throw new ApiFehler(t('Zu viele Versuche. Bitte später erneut versuchen.'), 429);
    }
    if (!password_verify((string) api_wert('passwort', ''), (string) $admin['passwort_hash'])) {
        throw new ApiFehler(t('Das Passwort stimmt nicht.'), 403);
    }
}

/** GET /admin/datenbank – wo die Zugangsdaten herkommen (ohne die Werte selbst) */
function api_datenbank_info(array $admin): array
{
    $k = konfig();
    $c = $k['db'];
    return [
        'host' => $c['host'], 'name' => $c['name'], 'user' => $c['user'],
        'quelle' => $c['quelle'],                                  // env = aus der .env, datei = aus der Einrichtung
        'passwort_aenderbar' => $c['quelle'] === 'datei',
        'root_notfall' => geheimnis_lesen('db_root_passwort') !== '',
        'schluessel_erzeugt' => !empty($k['app_secret_key_erzeugt']),
        'schluessel_gesichert' => !empty($k['app_secret_key_erzeugt']) && is_file(rtrim((string) $k['pfade']['backups'], '/') . '/app_secret_key.txt'),
    ];
}

/** POST /admin/datenbank/zeigen {passwort} – Datenbank-Passwort, Notfallzugang und Schlüssel anzeigen (nach Bestätigung) */
function api_datenbank_zeigen(array $admin): array
{
    datenbank_admin_bestaetigen($admin);
    $k = konfig();
    log_sicherheitsereignis((int) $admin['id'], 'datenbank_zugang_angezeigt');
    return [
        'db_passwort' => $k['db']['quelle'] === 'datei' ? $k['db']['password'] : null,
        'root_passwort' => geheimnis_lesen('db_root_passwort') ?: null,
        'schluessel' => !empty($k['app_secret_key_erzeugt']) ? $k['app_secret_key'] : null,
    ];
}

/** POST /admin/datenbank/passwort {passwort, neu?} – Datenbank-Passwort ändern (leer = zufällig). Nur wenn es aus der Einrichtung stammt. */
function api_datenbank_passwort(array $admin): array
{
    datenbank_admin_bestaetigen($admin);
    $c = konfig()['db'];
    if ($c['quelle'] !== 'datei') {
        throw new ApiFehler(t('Das Datenbank-Passwort steht in deiner .env (DB_PASSWORD). Dort ändern und den Stack neu starten.'), 409);
    }
    $neu = trim((string) api_wert('neu', ''));
    if ($neu === '') {
        $neu = einrichtung_zufallspasswort(20);
    }
    if (mb_strlen($neu) < 16 || preg_match('/[\x00-\x1F\x7F\s]/', $neu)) {
        throw new ApiFehler(t('Mindestens 16 Zeichen, ohne Leerzeichen.'));
    }
    // zuerst in der Datenbank (mit der noch gültigen Verbindung), dann in die Datei; schlägt das Schreiben fehl, wird zurückgestellt
    $pdo = db();
    $alt = (string) $c['password'];
    // eigener Eintrag („benutzer@host“ aus CURRENT_USER()) – ALTER USER mit ausdrücklichem Namen geht überall
    $ich = (string) $pdo->query('SELECT CURRENT_USER()')->fetchColumn();
    $at = strrpos($ich, '@');
    $konto = $pdo->quote(substr($ich, 0, (int) $at)) . '@' . $pdo->quote(substr($ich, (int) $at + 1));
    $pdo->exec('ALTER USER ' . $konto . ' IDENTIFIED BY ' . $pdo->quote($neu));
    if (!geheimnis_schreiben('datenbank.json', (string) json_encode(['name' => $c['name'], 'user' => $c['user'], 'passwort' => $neu]))) {
        $pdo->exec('ALTER USER ' . $konto . ' IDENTIFIED BY ' . $pdo->quote($alt));
        throw new ApiFehler(t('Konnte das neue Passwort nicht im Cache-Ordner ablegen – nichts wurde geändert.'), 500);
    }
    log_sicherheitsereignis((int) $admin['id'], 'datenbank_passwort_geaendert');
    return ['ok' => true, 'db_passwort' => $neu];
}


// ---------- Server-Angaben (Zeitzone, Name) ----------

/** Zeitzone und Servername aus der Einrichtung ablegen (PFAD_CACHE/geheimnisse/server.json). Die .env hat weiterhin Vorrang. */
function einrichtung_server_speichern(string $zone, string $name): bool
{
    $zone = trim($zone);
    $name = trim($name);
    $a = [];
    if ($zone !== '' && in_array($zone, timezone_identifiers_list(), true)) {
        $a['zeitzone'] = $zone;
    }
    if ($name !== '') {
        $a['servername'] = mb_substr($name, 0, 60);
    }
    return geheimnis_schreiben('server.json', json_encode($a, JSON_UNESCAPED_UNICODE));
}

// ---------- Systemprüfung (Ordner, Rechte, Werkzeuge) ----------

const EINR_AUDIO_ENDUNGEN = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma', 'aiff', 'aif', 'alac', 'ape', 'wv'];

function einr_benutzername(int $uid): string
{
    $n = function_exists('posix_getpwuid') ? (@posix_getpwuid($uid)['name'] ?? '') : '';
    return $n !== '' ? $n : (string) $uid;
}

function einr_gruppenname(int $gid): string
{
    $n = function_exists('posix_getgrgid') ? (@posix_getgrgid($gid)['name'] ?? '') : '';
    return $n !== '' ? $n : (string) $gid;
}

/** Audiodateien zählen (höchstens $max, höchstens $sekunden) und eine Stichprobe auf Lesbarkeit prüfen */
function einr_musik_erkunden(string $ordner, int $max = 50000, float $sekunden = 2.5): array
{
    $anzahl = 0;
    $probe = [];
    $abgebrochen = false;
    $ende = microtime(true) + $sekunden;
    try {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($ordner, FilesystemIterator::SKIP_DOTS | FilesystemIterator::UNIX_PATHS),
            RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::CATCH_GET_CHILD);
        foreach ($it as $datei) {
            if (!$datei->isFile() || !in_array(strtolower($datei->getExtension()), EINR_AUDIO_ENDUNGEN, true)) {
                continue;
            }
            $anzahl++;
            if (count($probe) < 5 && $anzahl % 7 === 1) {
                $probe[] = $datei->getPathname();
            }
            if ($anzahl >= $max || microtime(true) > $ende) {
                $abgebrochen = true;
                break;
            }
        }
    } catch (Throwable $e) {
        // unlesbare Unterordner zählen wir einfach nicht mit
    }
    $lesbar = 0;
    foreach ($probe as $p) {
        $h = @fopen($p, 'rb');
        if ($h && @fread($h, 1) !== false) {
            $lesbar++;
        }
        if ($h) {
            fclose($h);
        }
    }
    return ['dateien' => $anzahl, 'mehr' => $abgebrochen, 'probe' => count($probe), 'probe_lesbar' => $lesbar];
}

function einr_ordner_info(string $schluessel, string $name, string $pfad, string $hostPfad, bool $schreibenNoetig, bool $optional = false): array
{
    $uid = function_exists('posix_geteuid') ? posix_geteuid() : 0;
    $gid = function_exists('posix_getegid') ? posix_getegid() : 0;
    $o = ['schluessel' => $schluessel, 'name' => $name, 'pfad' => $pfad, 'host' => $hostPfad, 'optional' => $optional,
        'vorhanden' => is_dir($pfad), 'lesen' => false, 'schreiben' => false, 'besitzer' => null, 'gerät' => null, 'ok' => false, 'fehler' => null, 'befehl' => null, 'falscher_benutzer' => null];
    if (!$o['vorhanden']) {
        $o['fehler'] = t('Der Ordner ist im Container nicht vorhanden.');
        return $o;
    }
    $o['lesen'] = is_readable($pfad);
    // Schreiben wirklich ausprobieren (is_writable täuscht bei Netzwerk-Freigaben und ACLs)
    $t = $pfad . '/.amberwave_schreibtest_' . bin2hex(random_bytes(4));
    $o['schreiben'] = @file_put_contents($t, 'x') !== false;
    if ($o['schreiben']) {
        @unlink($t);
    }
    $st = @stat($pfad);
    if ($st) {
        $o['besitzer'] = ['uid' => (int) $st['uid'], 'gid' => (int) $st['gid'], 'name' => einr_benutzername((int) $st['uid']), 'gruppe' => einr_gruppenname((int) $st['gid'])];
        $o['gerät'] = (int) $st['dev'];
    }
    $o['ok'] = $o['lesen'] && ($o['schreiben'] || !$schreibenNoetig);
    if (!$o['ok']) {
        $ziel = $hostPfad !== '' ? $hostPfad : $pfad;
        $o['fehler'] = !$o['lesen'] ? t('Amberwave darf den Ordner nicht lesen.') : t('Amberwave darf in den Ordner nicht schreiben.');
        $o['befehl'] = 'chown -R ' . $uid . ':' . $gid . ' ' . escapeshellarg($ziel);
        if ($o['besitzer'] && $o['besitzer']['uid'] > 0 && ($o['besitzer']['uid'] !== $uid || $o['besitzer']['gid'] !== $gid)) {
            $o['falscher_benutzer'] = ['name' => $o['besitzer']['name'], 'uid' => $o['besitzer']['uid'], 'gid' => $o['besitzer']['gid']];
        }
    }
    return $o;
}

function einr_werkzeug(string $befehl): ?string
{
    if (!function_exists('shell_exec')) {
        return null;
    }
    $a = @shell_exec($befehl . ' 2>/dev/null');
    return is_string($a) && trim($a) !== '' ? trim($a) : null;
}

/** Woher kommt der Benutzer, als der Amberwave läuft? start.sh legt es in AW_BENUTZER_HERKUNFT ab: env | gemerkt | erkannt:<Ordner> | standard */
function einr_benutzer_herkunft(): array
{
    $h = trim((string) getenv('AW_BENUTZER_HERKUNFT'));
    if (str_starts_with($h, 'erkannt:')) {
        return ['art' => 'erkannt', 'quelle' => substr($h, 8)];
    }
    if (in_array($h, ['env', 'gemerkt', 'standard'], true)) {
        return ['art' => $h, 'quelle' => ''];
    }
    return ['art' => trim((string) getenv('PUID')) !== '' ? 'env' : 'container', 'quelle' => ''];
}

/** Woher kommt ein Ordner auf dem Server? Aus der .env (eigene Variable), aus APPDATA_PFAD abgeleitet oder Standard von Compose */
function einr_ordner_quelle(array $vars, string $unter): string
{
    foreach ($vars as $v) {
        if (trim((string) getenv($v)) !== '') {
            return t('{var} in der .env', ['var' => $v]);
        }
    }
    return trim((string) getenv('APPDATA_PFAD')) !== '' ? t('aus APPDATA_PFAD ({unter})', ['unter' => $unter]) : t('Standard: neben der docker-compose.yml');
}

/** „Was Amberwave festgelegt hat“: alles, was beim Start entschieden wurde, samt Herkunft – für Einstellungen › System & Ordner */
function einr_festlegungen(): array
{
    $k = konfig();
    $uid = function_exists('posix_geteuid') ? posix_geteuid() : 0;
    $gid = function_exists('posix_getegid') ? posix_getegid() : 0;
    $hk = einr_benutzer_herkunft();
    $hkText = ['env' => t('PUID/PGID in der .env'), 'gemerkt' => t('beim ersten Start erkannt und gemerkt'), 'erkannt' => t('automatisch erkannt (Besitzer von {quelle})', ['quelle' => $hk['quelle']]),
        'standard' => t('Standard (nobody:users wie bei Lidarr & Co.)'), 'container' => t('vom Container vorgegeben')][$hk['art']] ?? '';
    $benutzer = ['uid' => $uid, 'gid' => $gid, 'name' => einr_benutzername($uid), 'gruppe' => einr_gruppenname($gid), 'herkunft' => $hk['art'], 'quelle' => $hkText,
        'hinweis' => $hk['art'] === 'env' ? '' : t('Soll es fest sein: PUID und PGID in die .env schreiben (der Tunnel-Container liest sie ebenfalls).')];
    $host = static fn(string $n): string => einr_host_pfad($n);
    $ordner = [];
    $defs = [
        ['musik', t('Musiksammlung'), $k['pfade']['musik'], 'MUSIK_PFAD', false, ['MUSIK_PFAD'], ''],
        ['daten', t('App-Daten (Cover, Geheimnisse)'), $k['pfade']['cache'], 'CACHE_PFAD', true, ['CACHE_PFAD'], '/cache'],
        ['sicherungen', t('Sicherungen'), $k['pfade']['backups'], 'BACKUP_PFAD', true, ['BACKUP_PFAD', 'SICHERUNG_PFAD'], '/backups'],
    ];
    foreach ($defs as [$sk, $name, $pfad, $var, $schreiben, $quellVars, $unter]) {
        $o = einr_ordner_info($sk, $name, $pfad, $host($var), $schreiben);
        $o['quelle'] = $sk === 'musik' ? ($host($var) !== '' ? t('MUSIK_PFAD in der .env') : t('Standard')) : einr_ordner_quelle($quellVars, $unter);
        $ordner[] = $o;
    }
    $d = $k['pfade']['downloads'] ?? '';
    if ($d !== '' && is_dir($d) && einr_usenet_an()) {
        $o = einr_ordner_info('downloads', t('Downloads'), $d, $host('DOWNLOAD_PFAD'), true, true);
        $o['quelle'] = t('DOWNLOAD_PFAD in der .env');
        $ordner[] = $o;
    }
    $ordner[] = ['schluessel' => 'db', 'name' => t('MariaDB-Datenbank (Dateien)'), 'pfad' => t('im MariaDB-Container'), 'host' => $host('DB_DATA_PFAD'), 'vorhanden' => true, 'ok' => true,
        'quelle' => einr_ordner_quelle(['DB_DATA_PFAD'], '/db'), 'besitzer' => null, 'schreiben' => null, 'lesen' => null, 'nur_anzeige' => true];
    $geh = rtrim((string) $k['pfade']['cache'], '/') . '/geheimnisse';
    $server = [];
    $sj = is_file($geh . '/server.json') ? json_decode((string) @file_get_contents($geh . '/server.json'), true) : null;
    $sj = is_array($sj) ? $sj : [];
    $server[] = ['name' => t('Zeitzone'), 'wert' => $k['zeitzone'], 'quelle' => trim((string) getenv('APP_ZEITZONE')) !== '' ? t('APP_ZEITZONE in der .env') : (isset($sj['zeitzone']) ? t('aus der Einrichtung (Browser)') : t('Standard'))];
    $server[] = ['name' => t('Servername'), 'wert' => (string) ($k['server_name'] ?? ($sj['servername'] ?? '')) ?: '–', 'quelle' => trim((string) getenv('CLIENT_SERVERNAME')) !== '' ? t('CLIENT_SERVERNAME in der .env') : (isset($sj['servername']) ? t('aus der Einrichtung') : t('Standard'))];
    $server[] = ['name' => t('Datenbank'), 'wert' => $k['db']['user'] . '@' . $k['db']['host'] . '/' . $k['db']['name'], 'quelle' => ['env' => t('DB_* in der .env'), 'datei' => t('von der Einrichtung angelegt (geheimnisse/datenbank.json)')][$k['db']['quelle']] ?? t('nicht festgelegt')];
    $server[] = ['name' => t('Schlüssel'), 'wert' => empty($k['app_secret_key_erzeugt']) ? t('gesetzt') : t('automatisch erzeugt'), 'quelle' => empty($k['app_secret_key_erzeugt']) ? t('APP_SECRET_KEY in der .env') : t('App-Daten/.app_secret_key (Kopie in den Sicherungen)')];
    return ['benutzer' => $benutzer, 'ordner' => $ordner, 'server' => $server, 'version' => $k['version']];
}

function einrichtung_systempruefung(): array
{
    $k = konfig();
    $uid = function_exists('posix_geteuid') ? posix_geteuid() : 0;
    $gid = function_exists('posix_getegid') ? posix_getegid() : 0;
    $host = static fn(string $n): string => einr_host_pfad($n);
    $hk = einr_benutzer_herkunft();
    $benutzer = ['uid' => $uid, 'gid' => $gid, 'name' => einr_benutzername($uid), 'gruppe' => einr_gruppenname($gid),
        'herkunft' => $hk['art'], 'quelle' => $hk['quelle']];
    $ordner = [];
    $m = einr_ordner_info('musik', t('Musiksammlung'), $k['pfade']['musik'], $host('MUSIK_PFAD'), false);
    if ($m['vorhanden'] && $m['lesen']) {
        $m += einr_musik_erkunden($k['pfade']['musik']);
        if ($m['dateien'] === 0) {
            $m['hinweis'] = t('Im Ordner liegen noch keine Musikdateien (oder der Ordner ist leer eingebunden). Prüfe MUSIK_PFAD in der .env.');
        } elseif ($m['probe'] > $m['probe_lesbar']) {
            $m['ok'] = false;
            $m['fehler'] = t('Einige Dateien lassen sich nicht lesen ({gut} von {alle} in der Stichprobe).', ['gut' => $m['probe_lesbar'], 'alle' => $m['probe']]);
            $m['befehl'] = 'chown -R ' . $uid . ':' . $gid . ' ' . escapeshellarg($m['host'] !== '' ? $m['host'] : $k['pfade']['musik']);
        }
    }
    $m['schreibbar_hinweis'] = $m['schreiben'];
    $ordner[] = $m;
    $c = einr_ordner_info('daten', t('App-Daten'), $k['pfade']['cache'], $host('CACHE_PFAD'), true);
    $b = einr_ordner_info('sicherungen', t('Sicherungen'), $k['pfade']['backups'], $host('BACKUP_PFAD'), true);
    $hinweise = [];
    if ($c['ok'] && $b['ok'] && $c['gerät'] !== null && $c['gerät'] === $b['gerät'] && !preg_match('#^/mnt/user/#', $c['host']) && !preg_match('#^/mnt/user/#', $b['host'])) {
        $b['warnung'] = t('selbes Laufwerk wie die App-Daten');
        $hinweise[] = ['ordner' => 'sicherungen', 'titel' => t('Sicherung auf derselben Platte'), 'text' => t('Fällt das Laufwerk aus, sind Daten und Sicherung weg. Besser: SICHERUNG_PFAD in der .env auf ein anderes Laufwerk legen.')];
    }
    if ($c['ok'] && preg_match('#^/mnt/user/#', $c['host'])) {
        $c['warnung'] = t('liegt auf /mnt/user (Share)');
        $hinweise[] = ['ordner' => 'daten', 'titel' => t('Besser auf das Cache-Laufwerk'), 'text' => t('/mnt/user ist für Datenbanken langsam. Besser: APPDATA_PFAD (oder CACHE_PFAD) in der .env auf /mnt/cache/… legen, dann neu starten. Bestehende Daten zieht scripts/pfade-migrieren.sh um.')];
    }
    $ordner[] = $c;
    $ordner[] = $b;
    $d = $k['pfade']['downloads'] ?? '';
    if ($d !== '' && is_dir($d) && einr_usenet_an()) {
        $ordner[] = einr_ordner_info('downloads', t('Downloads'), $d, $host('DOWNLOAD_PFAD'), true, true);
    }
    $z = einrichtung_zustand(true);
    $ff = einr_werkzeug('ffmpeg -version | head -n1');
    $pyv = einr_werkzeug('python3 -c "import sys,numpy;print(\'%d.%d|%s\'%(sys.version_info[0],sys.version_info[1],numpy.__version__))"');
    $py = $pyv !== null && str_contains($pyv, '|') ? t('Python {py} mit numpy {np}', ['py' => explode('|', $pyv)[0], 'np' => explode('|', $pyv)[1]]) : null;
    $werkzeuge = [
        ['name' => t('Datenbank'), 'ok' => in_array($z['art'], ['leer', 'fertig'], true) || $z['art'] === 'db_fehlt', 'text' => $z['art'] === 'wartet' ? t('Die Datenbank startet noch – gleich nochmal prüfen') : t('MariaDB erreicht – wird gleich eingerichtet')],
        ['name' => $ff ? preg_replace('/^ffmpeg version (\S+).*/', 'ffmpeg $1', $ff) : 'ffmpeg', 'ok' => $ff !== null, 'text' => $ff ? t('für Umwandlung (Opus/AAC) und Tags') : t('nicht gefunden – Umwandlung und Tags gehen nicht')],
        ['name' => $py ?: t('Python mit numpy'), 'ok' => $py !== null, 'text' => $py ? t('für die Klanganalyse') : t('nicht gefunden – die Klanganalyse bleibt aus')],
    ];
    $ok = true;
    foreach ($ordner as $o) {
        if (!$o['optional'] && !$o['ok']) {
            $ok = false;
        }
    }
    return ['bereit' => $ok, 'benutzer' => $benutzer, 'ordner' => $ordner, 'hinweise' => $hinweise, 'werkzeuge' => $werkzeuge,
        'zeitzone' => $k['zeitzone'], 'servername' => $k['server_name']];
}

// ---------- Erstes Einlesen ----------

function einrichtung_scan_status(): array
{
    require_once __DIR__ . '/db.php';
    require_once __DIR__ . '/scanner.php';
    $l = db_zeile('SELECT * FROM scan_laeufe ORDER BY id DESC LIMIT 1');
    $laeuft = $l && scan_laufend() !== null;
    $gesamt = $l ? (int) $l['dateien_gesamt'] : 0;
    $geprueft = $l ? (int) $l['dateien_geprueft'] : 0;
    $fertig = $l && in_array($l['status'], ['fertig', 'ok', 'abgeschlossen'], true);
    $fehler = $l && in_array($l['status'], ['fehler', 'abgebrochen'], true);
    $covers = [];
    foreach (db_alle("SELECT cover_datei FROM editionen WHERE cover_datei IS NOT NULL AND cover_datei <> '' ORDER BY id DESC LIMIT 36") as $e) {
        $covers[] = '/api/v1/bild/cover/' . rawurlencode((string) $e['cover_datei']) . '?g=300';
    }
    return [
        'lauf' => $l ? (int) $l['id'] : null, 'status' => $l['status'] ?? null, 'laeuft' => $laeuft, 'fertig' => $fertig, 'fehler' => $fehler, 'meldung' => $l['meldung'] ?? null,
        'gesamt' => $gesamt, 'geprueft' => $geprueft, 'prozent' => $gesamt > 0 ? min(100, (int) floor($geprueft * 100 / $gesamt)) : 0,
        'titel' => $geprueft, 'alben' => (int) db_wert('SELECT COUNT(*) FROM alben'), 'kuenstler' => (int) db_wert('SELECT COUNT(*) FROM kuenstler'),
        'fehler_anzahl' => $l ? (int) $l['fehler_anzahl'] : 0, 'aktuell' => $l['aktuell'] ?? null, 'covers' => $covers,
    ];
}

function einrichtung_scan_zusammenfassung(): array
{
    require_once __DIR__ . '/db.php';
    $s = einrichtung_scan_status();
    $ms = (int) db_wert('SELECT COALESCE(SUM(laenge_ms),0) FROM tracks');
    $j = db_zeile('SELECT MIN(erstjahr) AS a, MAX(erstjahr) AS n FROM alben WHERE erstjahr IS NOT NULL AND erstjahr > 1000');
    $top = db_alle('SELECT c.anzeige AS name, COUNT(*) AS n FROM tracks t JOIN credits c ON c.id = t.credit_id GROUP BY t.credit_id, c.anzeige ORDER BY n DESC LIMIT 5');
    return $s + ['spielzeit_ms' => $ms, 'aeltestes' => $j['a'] !== null ? (int) $j['a'] : null, 'neuestes' => $j['n'] !== null ? (int) $j['n'] : null,
        'top' => array_map(static fn($r) => ['name' => (string) $r['name'], 'n' => (int) $r['n']], $top)];
}

/** Downloads-Ordner nur zeigen, wenn Usenet-Downloads eingeschaltet sind (sonst ist er für Tester nur verwirrend) */
function einr_usenet_an(): bool
{
    try {
        return function_exists('einstellung') && einstellung('usenet_aktiv') === '1';
    } catch (Throwable $e) {
        return false;
    }
}
