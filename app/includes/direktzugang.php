<?php
// Direktzugang im Heimnetz (wie Plex): Amberwave ist zuhause zusätzlich unter einer eigenen HTTPS-Adresse direkt
// erreichbar, z. B. https://lokal.musik.example.de:8443 – der Name zeigt (per Cloudflare-DNS, „nur DNS“) auf die
// LAN-IP des Servers, das Zertifikat holt Amberwave selbst bei Let's Encrypt (DNS-Challenge, kein offener Port).
// Die App prüft, ob diese Adresse antwortet, und holt die Musik dann direkt – sonst über den normalen Weg.
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/acme.php';
require_once __DIR__ . '/musicbrainz.php';

function direkt_ordner(): string
{
    $o = konfig()['pfade']['cache'] . '/tls';
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return $o;
}

function direkt_host(): string { return strtolower(trim(einstellung('direkt_host'))); }
function direkt_port(): int { return max(1, (int) (einstellung('direkt_port') ?: 8443)); }

/** Basis-Adresse der Direktverbindung (oder '' wenn aus). DIREKT_URL in der .env übersteuert alles (z. B. eigener Proxy). */
function direkt_url(): string
{
    $fest = konfig()['direkt']['url'];
    if ($fest !== '') {
        return rtrim($fest, '/');
    }
    if (einstellung('direkt_aktiv') !== '1' || direkt_host() === '') {
        return '';
    }
    $p = direkt_port();
    return 'https://' . direkt_host() . ($p === 443 ? '' : ':' . $p);
}

function direkt_origin(): string
{
    $u = direkt_url();
    if ($u === '') {
        return '';
    }
    $t = parse_url($u);
    return ($t['scheme'] ?? 'https') . '://' . ($t['host'] ?? '') . (isset($t['port']) ? ':' . $t['port'] : '');
}

// ---------- Stream-Schlüssel (die Direktadresse ist eine andere Herkunft – dort gibt es kein Login-Cookie) ----------
/**
 * Schlüssel für den Direktzugang: Nutzer, Gerät und Ablauf, signiert. Damit holt die App zuhause Musik, Bilder und
 * alle API-Daten direkt vom Server (ohne Login-Cookie, das gehört zur normalen Adresse).
 */
function direkt_token(array $user, int $sekunden = 43200): array
{
    $bis = time() + $sekunden;
    $daten = (int) $user['id'] . '.' . (int) (aktuelles_geraet_id() ?? 0) . '.' . $bis;
    $sig = static fn(string $zweck) => b64u(hash_hmac('sha256', 'direkt|' . $zweck . '|' . $daten, konfig()['app_secret_key'], true));
    // Zwei getrennte Schlüssel: „medien“ steht in Adressen (?st=…, kann in Verläufen und Protokollen landen) und öffnet nur
    // Musik, Bilder und Exporte; „api“ geht nur als Kopfzeile mit und öffnet die übrige API – aber nie die Verwaltung.
    return ['token' => $daten . '.' . $sig('medien'), 'api_token' => $daten . '.' . $sig('api'), 'bis' => $bis];
}

/** Schlüssel prüfen: [Nutzer, Geräte-ID] oder null. $zweck: 'medien' (?st=…) oder 'api' (Kopfzeile). */
function direkt_token_pruefen(string $t, string $zweck = 'medien'): ?array
{
    $teile = explode('.', $t);
    if (count($teile) !== 4 || !in_array($zweck, ['medien', 'api'], true)) {
        return null;
    }
    $signiert = $teile[0] . '.' . $teile[1] . '.' . $teile[2];
    if (!ctype_digit($teile[0]) || !ctype_digit($teile[1]) || !ctype_digit($teile[2]) || (int) $teile[2] < time()) {
        return null;
    }
    $erwartet = b64u(hash_hmac('sha256', 'direkt|' . $zweck . '|' . $signiert, konfig()['app_secret_key'], true));
    if (!hash_equals($erwartet, $teile[3])) {
        return null;
    }
    $u = db_zeile('SELECT * FROM users WHERE id = :id', ['id' => (int) $teile[0]]);
    if (!$u || !account_ist_gueltig($u)) {
        return null;
    }
    $g = (int) $teile[1];
    if ($g > 0 && !geraet_aktiv((int) $u['id'], $g)) {
        return null; // Gerät wurde abgemeldet
    }
    return [$u, $g ?: null];
}

function direkt_token_user(string $t): ?array
{
    return direkt_token_pruefen($t)[0] ?? null;
}

/** CORS für Anfragen von der App (normale Adresse) an die Direktadresse – nur diese eine Herkunft wird erlaubt */
function direkt_cors(): void
{
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin === '' || headers_sent()) {
        return;
    }
    $erlaubt = [];
    $app = konfig()['app_url'];
    if ($app !== '') {
        $t = parse_url($app);
        $erlaubt[] = ($t['scheme'] ?? 'https') . '://' . ($t['host'] ?? '') . (isset($t['port']) ? ':' . $t['port'] : '');
    }
    foreach (konfig()['direkt']['cors_zusatz'] as $z) {
        $erlaubt[] = rtrim($z, '/');
    }
    if (!in_array($origin, $erlaubt, true) && !direkt_heim_origin($origin)) {
        return;
    }
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin', false);
    header('Access-Control-Expose-Headers: X-Samples, X-Rate, X-Bitgenau, X-Dauern, Content-Length, Content-Range');
    // Chrome: Zugriff von einer öffentlichen Seite ins private Netz (Private/Local Network Access)
    if (!empty($_SERVER['HTTP_ACCESS_CONTROL_REQUEST_PRIVATE_NETWORK'])) {
        header('Access-Control-Allow-Private-Network: true');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        header('Access-Control-Allow-Methods: GET, HEAD, POST, PUT, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Range, Content-Type, Accept, X-Amberwave-Direkt, X-CSRF-Token');
        header('Access-Control-Max-Age: 600');
    }
}

/**
 * Die App im Heimnetz direkt über die Server-IP aufgerufen (z. B. http://192.168.1.10:9950) oder unter einem lokalen
 * Namen (*.local, *.lan, *.home.arpa)? Auch von dort darf die Direktadresse benutzt werden. Die Streams sind ohnehin
 * nur mit gültigem Stream-Schlüssel abrufbar.
 */
function direkt_heim_origin(string $origin): bool
{
    $t = parse_url($origin);
    $host = trim((string) ($t['host'] ?? ''), '[]');
    if ($host === '' || !in_array($t['scheme'] ?? '', ['http', 'https'], true)) {
        return false;
    }
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        // private oder Loopback-Adresse
        return filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
    }
    return (bool) preg_match('/\.(local|lan|home\.arpa|internal)$/i', $host) || $host === 'localhost';
}

// ---------- Zertifikat ----------
function direkt_zertifikat(): ?array
{
    $datei = direkt_ordner() . '/fullchain.pem';
    if (!is_file($datei)) {
        return null;
    }
    $pem = (string) file_get_contents($datei);
    $x = @openssl_x509_parse($pem);
    if (!$x) {
        return null;
    }
    $sans = [];
    foreach (explode(',', (string) ($x['extensions']['subjectAltName'] ?? '')) as $s) {
        $s = trim($s);
        if (str_starts_with($s, 'DNS:')) {
            $sans[] = substr($s, 4);
        }
    }
    $platzhalter = ($x['subject']['CN'] ?? '') === 'amberwave-platzhalter';
    return [
        'namen' => $sans ?: [(string) ($x['subject']['CN'] ?? '')],
        'aussteller' => (string) ($x['issuer']['O'] ?? $x['issuer']['CN'] ?? ''),
        'gueltig_bis' => date('c', (int) $x['validTo_time_t']),
        'tage' => (int) floor(((int) $x['validTo_time_t'] - time()) / 86400),
        'platzhalter' => $platzhalter,
        'fingerabdruck' => openssl_x509_fingerprint($pem, 'sha256') ?: '',
    ];
}

// ---------- Fortschritt (für die Anzeige während des Einrichtens) ----------
function direkt_schritte_lesen(): array
{
    $d = direkt_ordner() . '/schritte.json';
    return is_file($d) ? (json_decode((string) file_get_contents($d), true) ?: []) : [];
}

function direkt_schritte_schreiben(array $s): void
{
    file_put_contents(direkt_ordner() . '/schritte.json', json_encode($s, JSON_UNESCAPED_UNICODE), LOCK_EX);
}

final class DirektLauf
{
    public array $schritte = [];
    public function start(string $text): void
    {
        $this->schritte[] = ['text' => $text, 'status' => 'laeuft', 'zeit' => date('c'), 'info' => ''];
        direkt_schritte_schreiben(['laeuft' => true, 'schritte' => $this->schritte]);
    }
    public function info(string $text): void
    {
        $i = count($this->schritte) - 1;
        if ($i >= 0) {
            $this->schritte[$i]['info'] = $text;
            direkt_schritte_schreiben(['laeuft' => true, 'schritte' => $this->schritte]);
        }
    }
    public function ende(string $status = 'ok', string $info = ''): void
    {
        $i = count($this->schritte) - 1;
        if ($i >= 0) {
            $this->schritte[$i]['status'] = $status;
            if ($info !== '') {
                $this->schritte[$i]['info'] = $info;
            }
        }
        direkt_schritte_schreiben(['laeuft' => true, 'schritte' => $this->schritte]);
    }
    public function fertig(bool $ok, string $meldung = ''): void
    {
        direkt_schritte_schreiben(['laeuft' => false, 'ok' => $ok, 'meldung' => $meldung, 'schritte' => $this->schritte, 'ende' => date('c')]);
    }
}

/** Datum für Statusmeldungen, nach Sprache (de: 24.10.2026, en: 24 Oct 2026) */
function direkt_datum(int|false $ts): string
{
    return date(sprache() === 'en' ? 'j M Y' : 'd.m.Y', (int) $ts);
}

/** Wartet, bis der TXT-Eintrag über öffentliches DNS (DNS-over-HTTPS) sichtbar ist */
function direkt_txt_abwarten(string $name, string $wert, DirektLauf $lauf, int $sekunden = 180): void
{
    $k = konfig()['direkt'];
    if (!$k['dns_pruefen']) {
        sleep(2);
        return;
    }
    $ende = time() + $sekunden;
    $runde = 0;
    while (time() < $ende) {
        $runde++;
        try {
            $r = http_holen($k['doh_url'] . '?' . http_build_query(['name' => $name, 'type' => 'TXT']), ['Accept: application/dns-json'], 10);
            $j = json_decode($r['body'], true);
            foreach ($j['Answer'] ?? [] as $a) {
                if (trim((string) ($a['data'] ?? ''), '"') === $wert) {
                    sleep(3); // noch einen Moment für alle Cloudflare-Nameserver
                    return;
                }
            }
        } catch (Throwable $e) {
            // DNS-Abfrage nicht möglich – einfach weiter warten
        }
        $lauf->info(t('noch nicht sichtbar, {n} s …', ['n' => $runde * 5]));
        sleep(5);
    }
    // Nicht sichtbar geworden: trotzdem versuchen – Let's Encrypt fragt die Cloudflare-Nameserver direkt
}

/** Zertifikat holen (oder erneuern) und ablegen. Wirft bei Fehlern. */
function direkt_zertifikat_holen(string $token, array $zone, string $host, DirektLauf $lauf, bool $zweiterVersuch = false): void
{
    $k = konfig()['direkt'];
    $konto = json_decode(einstellung('direkt_acme_konto') ?: '{}', true) ?: [];
    if (empty($konto['schluessel']) || ($konto['url'] ?? '') !== $k['acme_url']) {
        $konto = ['schluessel' => Acme::neuerSchluessel(), 'kid' => null, 'url' => $k['acme_url']];
    }
    $acme = new Acme($k['acme_url'], $konto['schluessel'], $konto['kid'] ?? null, fn($t) => $lauf->info($t));
    if (empty($konto['kid'])) {
        $lauf->info(t('Konto bei Let\'s Encrypt anlegen …'));
        $acme->konto(einstellung('direkt_email'));
        $konto['kid'] = $acme->kid();
        einstellung_setzen('direkt_acme_konto', json_encode($konto));
    }
    try {
        [$kette, $schluessel] = $acme->zertifikat(
            $host,
            fn($name, $wert) => cf_eintrag_setzen($token, $zone['id'], 'TXT', $name, $wert, 60),
            fn($id) => cf_eintrag_loeschen($token, $zone['id'], $id),
            fn($name, $wert) => direkt_txt_abwarten($name, $wert, $lauf),
        );
    } catch (AcmeFehler $e) {
        // Konto bei Let's Encrypt nicht mehr gültig (gelöscht/deaktiviert): einmal mit neuem Konto versuchen
        if (!$zweiterVersuch && $e->typ === 'urn:ietf:params:acme:error:accountDoesNotExist') {
            einstellung_loeschen('direkt_acme_konto');
            $lauf->info(t('Konto bei Let\'s Encrypt neu anlegen …'));
            direkt_zertifikat_holen($token, $zone, $host, $lauf, true);
            return;
        }
        throw $e;
    }
    // Prüfen, ob Schlüssel und Zertifikat zusammenpassen, dann ablegen (erst temporär, dann umbenennen)
    if (!openssl_x509_check_private_key($kette, $schluessel)) {
        throw new AcmeFehler(t('Zertifikat und Schlüssel passen nicht zusammen.'));
    }
    $o = direkt_ordner();
    file_put_contents($o . '/privkey.pem.neu', $schluessel);
    @chmod($o . '/privkey.pem.neu', 0600);
    file_put_contents($o . '/fullchain.pem.neu', $kette);
    rename($o . '/privkey.pem.neu', $o . '/privkey.pem');
    rename($o . '/fullchain.pem.neu', $o . '/fullchain.pem');
    // Der Container lädt den Webserver neu, sobald diese Datei da ist (siehe scripts/start.sh)
    touch($o . '/neu_laden');
}

/** Wartet, bis der Webserver das neue Zertifikat ausliefert (Neuladen passiert im Container alle paar Sekunden) */
function direkt_neuladen_abwarten(int $sekunden = 30): bool
{
    $flag = direkt_ordner() . '/neu_laden';
    $ende = time() + $sekunden;
    clearstatcache(true, $flag);
    while (is_file($flag) && time() < $ende) {
        sleep(1);
        clearstatcache(true, $flag);
    }
    if (is_file($flag)) {
        return false;
    }
    sleep(2);
    return true;
}

/** Liefert der Webserver auf dem HTTPS-Port im Container das Zertifikat aus der Datei? */
function direkt_selbsttest(string $host): array
{
    $soll = direkt_zertifikat();
    $ctx = stream_context_create(['ssl' => ['capture_peer_cert' => true, 'verify_peer' => false, 'verify_peer_name' => false, 'peer_name' => $host, 'SNI_enabled' => true]]);
    $s = @stream_socket_client('ssl://127.0.0.1:' . konfig()['direkt']['interner_port'], $nr, $text, 5, STREAM_CLIENT_CONNECT, $ctx);
    if (!$s) {
        return ['ok' => false, 'text' => t('HTTPS-Port im Container antwortet nicht ({text}). Läuft der Container mit dem neuen Startskript (einmal neu starten)?', ['text' => $text])];
    }
    $p = stream_context_get_params($s);
    fclose($s);
    $fp = isset($p['options']['ssl']['peer_certificate']) ? openssl_x509_fingerprint($p['options']['ssl']['peer_certificate'], 'sha256') : '';
    if ($soll && $fp === $soll['fingerabdruck']) {
        return ['ok' => true, 'text' => t('Der Webserver liefert das neue Zertifikat aus.')];
    }
    return ['ok' => false, 'text' => t('Der Webserver liefert noch ein anderes Zertifikat aus – Container einmal neu starten.')];
}

/** Komplette Einrichtung: Token prüfen, Zone, DNS-Eintrag, Zertifikat, Neuladen, Selbsttest */
function direkt_einrichten(string $host, string $ip, int $port): array
{
    $sperre = fopen(direkt_ordner() . '/einrichten.lock', 'c');
    if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
        throw new ApiFehler(t('Die Einrichtung läuft bereits.'));
    }
    @set_time_limit(600);
    $lauf = new DirektLauf();
    try {
        $token = einstellung('direkt_cf_token');
        if ($token === '') {
            throw new ApiFehler(t('Bitte zuerst das Cloudflare-Token eintragen.'));
        }
        $lauf->start(t('Cloudflare-Token prüfen'));
        cf_token_pruefen($token);
        $lauf->ende();

        $lauf->start(t('Zone für {host} finden', ['host' => $host]));
        $zone = cf_zone_fuer($token, $host);
        $lauf->ende('ok', $zone['name']);

        $lauf->start(t('DNS-Eintrag {host} → {ip} (nur DNS)', ['host' => $host, 'ip' => $ip]));
        cf_eintrag_setzen($token, $zone['id'], filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) ? 'AAAA' : 'A', $host, $ip, 300);
        $lauf->ende();

        einstellung_setzen('direkt_host', $host);
        einstellung_setzen('direkt_ip', $ip);
        einstellung_setzen('direkt_port', (string) $port);

        $z = direkt_zertifikat();
        if ($z && !$z['platzhalter'] && in_array($host, $z['namen'], true) && $z['tage'] > konfig()['direkt']['erneuern_tage']) {
            $lauf->start(t('Zertifikat'));
            $lauf->ende('ok', t('vorhanden, gültig bis {datum}', ['datum' => direkt_datum(strtotime($z['gueltig_bis']))]));
        } else {
            $lauf->start(t('Zertifikat bei Let\'s Encrypt holen'));
            direkt_zertifikat_holen($token, $zone, $host, $lauf);
            $z = direkt_zertifikat();
            $lauf->ende('ok', t('gültig bis {datum}', ['datum' => direkt_datum(strtotime($z['gueltig_bis']))]) . ($z['aussteller'] ? ' · ' . $z['aussteller'] : ''));
        }

        $lauf->start(t('HTTPS im Container neu laden'));
        if (direkt_neuladen_abwarten()) {
            $lauf->ende();
            $lauf->start(t('Selbsttest'));
            $t = direkt_selbsttest($host);
            $lauf->ende($t['ok'] ? 'ok' : 'warnung', $t['text']);
        } else {
            $lauf->ende('warnung', t('Der Container hat nicht neu geladen – läuft er schon mit dem neuen Startskript? Einmal neu starten.'));
        }
        einstellung_setzen('direkt_aktiv', '1');
        $lauf->fertig(true, t('Fertig. Geräte im Heimnetz holen die Musik jetzt direkt.'));
        return direkt_stand();
    } catch (Throwable $e) {
        $lauf->ende('fehler', $e->getMessage());
        $lauf->fertig(false, $e->getMessage());
        if ($e instanceof ApiFehler) {
            throw $e;
        }
        throw new ApiFehler($e->getMessage());
    } finally {
        flock($sperre, LOCK_UN);
        fclose($sperre);
    }
}

/** Für den Zeitplan: rechtzeitig erneuern (Standard 30 Tage vor Ablauf) */
function direkt_erneuern_wenn_noetig(bool $erzwingen = false): ?string
{
    if (einstellung('direkt_aktiv') !== '1' || konfig()['direkt']['url'] !== '') {
        return $erzwingen ? t('Der Direktzugang ist nicht eingerichtet.') : null;
    }
    if (!$erzwingen && einstellung('direkt_auto') === '0') {
        return null; // automatische Erneuerung abgeschaltet
    }
    $z = direkt_zertifikat();
    $host = direkt_host();
    if (!$erzwingen && $z && !$z['platzhalter'] && in_array($host, $z['namen'], true) && $z['tage'] > konfig()['direkt']['erneuern_tage']) {
        return null;
    }
    $token = einstellung('direkt_cf_token');
    if ($token === '' || $host === '') {
        return t('Erneuern nicht möglich: Token oder Name fehlt.');
    }
    $lauf = new DirektLauf();
    try {
        $lauf->start($erzwingen ? t('Zertifikat erneuern') : t('Zertifikat automatisch erneuern'));
        direkt_zertifikat_holen($token, cf_zone_fuer($token, $host), $host, $lauf);
        $neu = direkt_zertifikat();
        $lauf->ende('ok', $neu ? t('gültig bis {datum}', ['datum' => direkt_datum(strtotime($neu['gueltig_bis']))]) : '');
        $lauf->fertig(true, t('Zertifikat erneuert.'));
        return t('Zertifikat erneuert.');
    } catch (Throwable $e) {
        $lauf->ende('fehler', $e->getMessage());
        $lauf->fertig(false, $e->getMessage());
        return t('Erneuern fehlgeschlagen: {fehler}', ['fehler' => $e->getMessage()]);
    }
}

function direkt_abschalten(bool $dnsLoeschen): array
{
    einstellung_setzen('direkt_aktiv', '0');
    if ($dnsLoeschen && direkt_host() !== '' && einstellung('direkt_cf_token') !== '') {
        try {
            $token = einstellung('direkt_cf_token');
            $zone = cf_zone_fuer($token, direkt_host());
            $q = http_build_query(['name' => direkt_host()]);
            foreach (cf_anfrage($token, 'GET', "/zones/{$zone['id']}/dns_records?{$q}")['result'] ?? [] as $e) {
                if (in_array($e['type'], ['A', 'AAAA'], true)) {
                    cf_eintrag_loeschen($token, $zone['id'], (string) $e['id']);
                }
            }
        } catch (Throwable $e) {
            // nicht kritisch
        }
    }
    return direkt_stand();
}

/** Zustand für die Verwaltung */
function direkt_stand(): array
{
    $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
    $hostOhnePort = preg_replace('/:\d+$/', '', $host);
    $vorschlagIp = filter_var($hostOhnePort, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) && !filter_var($hostOhnePort, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE)
        ? $hostOhnePort : '';
    $appHost = (string) (parse_url(konfig()['app_url'], PHP_URL_HOST) ?? '');
    $s = direkt_schritte_lesen();
    return [
        'aktiv' => direkt_url() !== '',
        'fest' => konfig()['direkt']['url'] !== '',
        'url' => direkt_url(),
        'token_gesetzt' => einstellung('direkt_cf_token') !== '',
        'token_quelle' => einstellung_quelle('direkt_cf_token'),
        'host' => direkt_host(),
        'ip' => einstellung('direkt_ip'),
        'port' => direkt_port(),
        'email' => einstellung('direkt_email'),
        'vorschlag_host' => $appHost !== '' ? 'lokal.' . $appHost : '',
        'vorschlag_ip' => $vorschlagIp,
        // HTTP-Port der App auf dem Server (APP_PORT aus der .env, sonst der Port dieses Aufrufs) – nur für den Hinweis
        'app_port' => (int) (getenv('APP_PORT') ?: (preg_match('/:(\d+)$/', $host, $pm) ? $pm[1] : 9950)),
        'port_quelle' => einstellung_quelle('direkt_port'),
        'zertifikat' => direkt_zertifikat(),
        'erneuern_tage' => konfig()['direkt']['erneuern_tage'],
        'auto' => einstellung('direkt_auto') !== '0',
        'auto_quelle' => einstellung_quelle('direkt_auto'),
        'naechste_erneuerung' => (function () {
            $z = direkt_zertifikat();
            if (!$z || $z['platzhalter']) {
                return null;
            }
            $t = max(time(), strtotime($z['gueltig_bis']) - konfig()['direkt']['erneuern_tage'] * 86400);
            return date('c', $t);
        })(),
        'lauf' => $s,
        'app_url_fehlt' => konfig()['app_url'] === '',
        'app_url' => konfig()['app_url'],
    ];
}
