<?php
// Von unterwegs: Cloudflare Tunnel. Amberwave legt den Tunnel über die Cloudflare-API an (cloudflared braucht keinen offenen
// Port im Router), setzt die Weiterleitung auf den App-Container, schreibt den DNS-Eintrag und legt das Tunnel-Token für den
// cloudflared-Container (Dienst „tunnel“ im Stack) in PFAD_CACHE/tunnel/token ab. Der Tunnel ist „remotely managed“: die
// Weiterleitung lässt sich später ändern, ohne den Container neu zu starten.
//
// cloudflared ist freie Software unter der Apache-Lizenz 2.0 (https://github.com/cloudflare/cloudflared/blob/master/LICENSE);
// die Nutzung des Tunnels unterliegt den Bedingungen von Cloudflare (https://www.cloudflare.com/terms/). Cloudflare ist eine
// Marke von Cloudflare, Inc. – Amberwave nennt den Namen, führt kein Logo.
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/cloudflare.php';
require_once __DIR__ . '/direktzugang.php';

const TUNNEL_LINKS = [
    'bedingungen' => 'https://www.cloudflare.com/terms/',
    'datenschutz' => 'https://www.cloudflare.com/privacypolicy/',
    'doku' => 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/',
    'lizenz' => 'https://github.com/cloudflare/cloudflared/blob/master/LICENSE',
];

function tunnel_konfig(): array
{
    return konfig()['tunnel'] ?? ['modus' => 'eigen', 'ziel' => '', 'container' => 'amberwave_tunnel'];
}

/** 'eigen' = cloudflared-Container im Stack, 'vorhanden' = ein schon laufendes cloudflared, dessen Tunnel wir mitbenutzen */
function tunnel_modus(): string { return tunnel_konfig()['modus'] === 'vorhanden' ? 'vorhanden' : 'eigen'; }

/** Wohin der Tunnel weiterleitet: im Stack der App-Container; bei fremdem cloudflared die App über Server-IP und Port */
function tunnel_ziel(): string
{
    $z = trim((string) tunnel_konfig()['ziel']);
    if ($z !== '') {
        return $z;
    }
    if (tunnel_modus() === 'eigen') {
        return 'http://app:80';
    }
    $e = trim(einstellung('tunnel_ziel'));
    return $e !== '' ? $e : tunnel_ziel_vorschlag();
}

function tunnel_ziel_vorschlag(): string
{
    require_once __DIR__ . '/heimnetz.php';
    $b = hn_basis()['url'] ?? '';
    return $b !== '' ? $b : 'http://<Server-IP>:' . (getenv('APP_PORT') ?: '9950');
}

function tunnel_ordner(): string
{
    $o = konfig()['pfade']['cache'] . '/tunnel';
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return $o;
}

function tunnel_host(): string { return strtolower(trim(einstellung('tunnel_host'))); }
function tunnel_id(): string { return trim(einstellung('tunnel_id')); }
function tunnel_konto(): string { return trim(einstellung('tunnel_konto')); }

/** Kommt diese Anfrage durch den Tunnel? (cloudflared setzt diese Kopfzeilen; vertraut wird ihnen nur vom Tunnel-Container, siehe client_ip) */
function tunnel_anfrage(): bool
{
    return !empty($_SERVER['HTTP_CF_RAY']) && client_ip() !== (string) ($_SERVER['REMOTE_ADDR'] ?? '');
}

/** Konto (Account-ID) zu einer Zone */
function tunnel_konto_fuer_zone(string $token, string $zone): string
{
    $j = cf_anfrage($token, 'GET', "/zones/{$zone}");
    $id = (string) ($j['result']['account']['id'] ?? '');
    if ($id === '') {
        throw new CfFehler(t('Konto der Zone nicht lesbar – hat das Token das Recht „Konto · Cloudflare Tunnel · Bearbeiten“?'));
    }
    return $id;
}

/** Tunnel bei Cloudflare lesen (null = gibt es nicht mehr) */
function tunnel_lesen(string $token, string $konto, string $id): ?array
{
    try {
        $j = cf_anfrage($token, 'GET', "/accounts/{$konto}/cfd_tunnel/{$id}");
    } catch (CfFehler $e) {
        if (preg_match('/\b(1003|404|not found)\b/i', $e->getMessage())) {
            return null;
        }
        throw $e;
    }
    $r = $j['result'] ?? null;
    return is_array($r) && empty($r['deleted_at']) ? $r : null;
}

/** Weiterleitung des Tunnels: dieser Name → App-Container, alles andere 404 */
function tunnel_weiterleitung_setzen(string $token, string $konto, string $id, string $host): void
{
    cf_anfrage($token, 'PUT', "/accounts/{$konto}/cfd_tunnel/{$id}/configurations", ['config' => ['ingress' => [
        ['hostname' => $host, 'service' => tunnel_ziel(), 'originRequest' => ['httpHostHeader' => $host]],
        ['service' => 'http_status:404'],
    ]]]);
}

/** Konten des Tokens */
function tunnel_konten(string $token): array
{
    $j = cf_anfrage($token, 'GET', '/accounts?per_page=50');
    return array_map(static fn($a) => ['id' => (string) $a['id'], 'name' => (string) ($a['name'] ?? '')], $j['result'] ?? []);
}

/** Vorhandene Tunnel aller Konten (für die Auswahl im Modus „vorhanden“) */
function tunnel_liste(string $token): array
{
    $aus = [];
    foreach (tunnel_konten($token) as $k) {
        $j = cf_anfrage($token, 'GET', "/accounts/{$k['id']}/cfd_tunnel?is_deleted=false&per_page=100");
        foreach ($j['result'] ?? [] as $t) {
            $aus[] = ['id' => (string) $t['id'], 'name' => (string) ($t['name'] ?? ''), 'status' => (string) ($t['status'] ?? ''), 'konto' => $k['id'],
                'konto_name' => $k['name'], 'remote' => !empty($t['remote_config']), 'verbindungen' => count($t['connections'] ?? [])];
        }
    }
    return $aus;
}

/** Regel für unseren Namen in die Konfiguration eines fremden Tunnels einfügen (andere Regeln bleiben) bzw. wieder herausnehmen */
function tunnel_regel_mischen(string $token, string $konto, string $id, string $host, ?string $ziel): array
{
    $j = cf_anfrage($token, 'GET', "/accounts/{$konto}/cfd_tunnel/{$id}/configurations");
    $config = is_array($j['result']['config'] ?? null) ? $j['result']['config'] : [];
    $ingress = array_values(array_filter((array) ($config['ingress'] ?? []), static fn($r) => strtolower((string) ($r['hostname'] ?? '')) !== $host));
    $fang = $ingress && empty(end($ingress)['hostname']) ? array_pop($ingress) : ['service' => 'http_status:404'];
    if ($ziel !== null) {
        $ingress[] = ['hostname' => $host, 'service' => $ziel, 'originRequest' => ['httpHostHeader' => $host]];
    }
    $ingress[] = $fang;
    $config['ingress'] = $ingress;
    cf_anfrage($token, 'PUT', "/accounts/{$konto}/cfd_tunnel/{$id}/configurations", ['config' => $config]);
    return $ingress;
}

function tunnel_token_schreiben(string $tunnelToken): void
{
    $p = tunnel_ordner() . '/token';
    file_put_contents($p . '.tmp', $tunnelToken, LOCK_EX);
    @chmod($p . '.tmp', 0640);
    rename($p . '.tmp', $p);
}

/** Öffentliche Adresse für den Rest von Amberwave (konfig()['app_url'] fällt darauf zurück, wenn APP_URL in der .env leer ist) */
function tunnel_app_url_schreiben(string $url): void
{
    $p = tunnel_ordner() . '/app_url.txt';
    if ($url === '') {
        @unlink($p);
        return;
    }
    file_put_contents($p, $url . "\n", LOCK_EX);
}

/**
 * Tunnel einrichten: anlegen (oder den vorhandenen weiterverwenden), Weiterleitung, DNS (proxied CNAME), Token-Datei.
 * Schritte landen wie beim Direktzugang in einer Datei, die die Oberfläche währenddessen abfragt.
 */
function tunnel_einrichten(string $host, string $fremdId = '', string $ziel = ''): array
{
    $host = strtolower(trim($host));
    $fremd = tunnel_modus() === 'vorhanden';
    if ($fremd) {
        if (!preg_match('/^[A-Za-z0-9-]{3,64}$/', $fremdId)) {
            throw new ApiFehler(t('Bitte den vorhandenen Tunnel auswählen.'));
        }
        $ziel = trim($ziel);
        if (!preg_match('#^https?://[A-Za-z0-9._-]+(:\d{1,5})?/?$#', $ziel) || str_contains($ziel, '<')) {
            throw new ApiFehler(t('Bitte das Ziel so angeben: http://192.168.1.10:9950 (die App, wie dein cloudflared sie erreicht).'));
        }
    }
    if (!preg_match('/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/', $host)) {
        throw new ApiFehler(t('Bitte einen vollständigen Namen angeben, z. B. musik.example.de'));
    }
    $sperre = fopen(tunnel_ordner() . '/einrichten.lock', 'c');
    if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
        throw new ApiFehler(t('Die Einrichtung läuft bereits.'));
    }
    @set_time_limit(300);
    $lauf = new TunnelLauf();
    try {
        $token = einstellung('direkt_cf_token');
        if ($token === '') {
            throw new ApiFehler(t('Bitte zuerst das Cloudflare-Token eintragen (Direktzugang, Schritt 1).'));
        }
        $lauf->start(t('Cloudflare-Token prüfen'));
        cf_token_pruefen($token);
        $lauf->ende();

        $lauf->start(t('Zone für {host} finden', ['host' => $host]));
        $zone = cf_zone_fuer($token, $host);
        $konto = tunnel_konto_fuer_zone($token, $zone['id']);
        $lauf->ende('ok', $zone['name']);

        if ($fremd) {
            $lauf->start(t('Vorhandenen Tunnel prüfen'));
            $t = tunnel_lesen($token, $konto, $fremdId);
            if (!$t) {
                // vielleicht ein anderes Konto des Tokens
                foreach (tunnel_konten($token) as $k) {
                    if ($t = tunnel_lesen($token, $k['id'], $fremdId)) {
                        $konto = $k['id'];
                        break;
                    }
                }
            }
            if (!$t) {
                throw new CfFehler(t('Diesen Tunnel gibt es nicht (mehr).'));
            }
            if (empty($t['remote_config'])) {
                throw new CfFehler(t('Dieser Tunnel wird lokal per config.yml konfiguriert – seine Regeln liegen nicht bei Cloudflare. Bitte im Dashboard auf „Configure“ migrieren oder die Regel von Hand eintragen.'));
            }
            $lauf->ende('ok', ($t['name'] ?? $fremdId) . ' · ' . tn(count($t['connections'] ?? []), '{n} Verbindung', '{n} Verbindungen'));
            // vorher ein eigener Tunnel? Den nicht liegen lassen
            if (tunnel_id() !== '' && tunnel_id() !== $fremdId && einstellung('tunnel_fremd') !== '1') {
                $lauf->start(t('Alten eigenen Tunnel entfernen'));
                try {
                    cf_anfrage($token, 'DELETE', "/accounts/" . tunnel_konto() . "/cfd_tunnel/" . tunnel_id() . "/connections");
                } catch (CfFehler $e) {
                }
                try {
                    cf_anfrage($token, 'DELETE', "/accounts/" . tunnel_konto() . "/cfd_tunnel/" . tunnel_id());
                } catch (CfFehler $e) {
                }
                @unlink(tunnel_ordner() . '/token');
                $lauf->ende();
            }
            $id = $fremdId;
            einstellung_setzen('tunnel_id', $id);
            einstellung_setzen('tunnel_konto', $konto);
            einstellung_setzen('tunnel_fremd', '1');
            einstellung_setzen('tunnel_ziel', $ziel);
            $lauf->start(t('Regel in den Tunnel eintragen (andere Regeln bleiben)'));
            $regeln = tunnel_regel_mischen($token, $konto, $id, $host, $ziel);
            $lauf->ende('ok', "{$host} → {$ziel} · " . t('{n} Regeln insgesamt', ['n' => count($regeln)]));
        } else {
        einstellung_setzen('tunnel_fremd', '0');
        $id = tunnel_id();
        $alt = $id !== '' && tunnel_konto() === $konto ? tunnel_lesen($token, $konto, $id) : null;
        if ($alt) {
            $lauf->start(t('Tunnel'));
            $lauf->ende('ok', t('vorhanden: {name}', ['name' => $alt['name'] ?? $id]));
        } else {
            $lauf->start(t('Tunnel anlegen'));
            $name = 'amberwave-' . preg_replace('/[^a-z0-9]+/', '-', $host);
            $j = cf_anfrage($token, 'POST', "/accounts/{$konto}/cfd_tunnel", ['name' => $name, 'config_src' => 'cloudflare']);
            $id = (string) ($j['result']['id'] ?? '');
            $tunnelToken = (string) ($j['result']['token'] ?? '');
            if ($id === '' || $tunnelToken === '') {
                throw new CfFehler(t('Cloudflare hat keinen Tunnel zurückgegeben.'));
            }
            tunnel_token_schreiben($tunnelToken);
            einstellung_setzen('tunnel_id', $id);
            einstellung_setzen('tunnel_konto', $konto);
            $lauf->ende('ok', $name);
        }
        if (!is_file(tunnel_ordner() . '/token')) {
            // Token-Datei fehlt (z. B. Cache neu): Token noch einmal holen
            $lauf->start(t('Tunnel-Token holen'));
            $j = cf_anfrage($token, 'GET', "/accounts/{$konto}/cfd_tunnel/{$id}/token");
            $t = (string) ($j['result'] ?? '');
            if ($t === '') {
                throw new CfFehler(t('Tunnel-Token nicht lesbar.'));
            }
            tunnel_token_schreiben($t);
            $lauf->ende();
        }

        $lauf->start(t('Weiterleitung auf den App-Container'));
        tunnel_weiterleitung_setzen($token, $konto, $id, $host);
        $lauf->ende('ok', $host . ' → ' . tunnel_ziel());
        }

        $lauf->start(t('DNS-Eintrag {host} (über Cloudflare)', ['host' => $host]));
        $dnsId = cf_eintrag_setzen($token, $zone['id'], 'CNAME', $host, $id . '.cfargotunnel.com', 1, true);
        einstellung_setzen('tunnel_dns_id', $dnsId);
        einstellung_setzen('tunnel_zone', $zone['id']);
        einstellung_setzen('tunnel_host', $host);
        $lauf->ende();

        tunnel_app_url_schreiben('https://' . $host);
        $lauf->start($fremd ? t('Verbindung des Tunnels') : t('Tunnel-Container wartet auf die Verbindung'));
        $stand = tunnel_verbindung_abwarten($token, $konto, $id, $fremd ? 6 : 75);
        $lauf->ende($stand['verbunden'] ? 'ok' : 'warnung', $stand['verbunden']
            ? tn(count($stand['verbindungen']), '{n} Verbindung', '{n} Verbindungen') . ' · cloudflared ' . ($stand['version'] ?: '?')
            : ($fremd ? t('Der Tunnel ist gerade nicht verbunden – läuft dein cloudflared?') : t('Noch keine Verbindung. Läuft der Dienst „tunnel“ im Stack? Er startet von selbst neu, sobald die Token-Datei da ist (bis zu einer Minute).')));
        $lauf->fertig(true, $stand['verbunden']
            ? t('Fertig. Amberwave ist unter https://{host} erreichbar.', ['host' => $host])
            : t('Fertig. Amberwave ist unter https://{host} erreichbar, sobald der Tunnel verbunden ist.', ['host' => $host]));
        return tunnel_stand();
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

/** Verbindungen des Tunnels (cloudflared → Cloudflare) */
function tunnel_verbindungen(string $token, string $konto, string $id): array
{
    $t = tunnel_lesen($token, $konto, $id);
    if (!$t) {
        return ['vorhanden' => false, 'verbunden' => false, 'status' => 'geloescht', 'verbindungen' => [], 'version' => ''];
    }
    $v = [];
    $version = '';
    foreach ($t['connections'] ?? [] as $c) {
        if (!empty($c['is_pending_reconnect'])) {
            continue;
        }
        $v[] = ['ort' => (string) ($c['colo_name'] ?? ''), 'seit' => (string) ($c['opened_at'] ?? ''), 'ip' => (string) ($c['origin_ip'] ?? '')];
        $version = $version ?: (string) ($c['client_version'] ?? '');
    }
    return ['vorhanden' => true, 'verbunden' => ($t['status'] ?? '') === 'healthy' || $v, 'status' => (string) ($t['status'] ?? ''), 'verbindungen' => $v, 'version' => $version, 'name' => (string) ($t['name'] ?? '')];
}

function tunnel_verbindung_abwarten(string $token, string $konto, string $id, int $sekunden): array
{
    $bis = time() + $sekunden;
    do {
        $s = tunnel_verbindungen($token, $konto, $id);
        if ($s['verbunden']) {
            return $s;
        }
        sleep(3);
    } while (time() < $bis);
    return $s;
}

/** Tunnel entfernen: Verbindungen trennen, Tunnel und DNS-Eintrag löschen, Token-Datei weg */
function tunnel_entfernen(): array
{
    $token = einstellung('direkt_cf_token');
    $id = tunnel_id();
    $konto = tunnel_konto();
    $fehler = [];
    $fremd = einstellung('tunnel_fremd') === '1';
    if ($token !== '' && $id !== '' && $konto !== '') {
        if ($fremd) {
            // fremder Tunnel: nur unsere Regel heraus, der Tunnel bleibt
            try {
                if (tunnel_host() !== '' && tunnel_lesen($token, $konto, $id)) {
                    tunnel_regel_mischen($token, $konto, $id, tunnel_host(), null);
                }
            } catch (CfFehler $e) {
                $fehler[] = t('Regel: {fehler}', ['fehler' => $e->getMessage()]);
            }
        } else {
            try {
                cf_anfrage($token, 'DELETE', "/accounts/{$konto}/cfd_tunnel/{$id}/connections");
            } catch (CfFehler $e) {
                // keine Verbindungen – egal
            }
            try {
                if (tunnel_lesen($token, $konto, $id)) {
                    cf_anfrage($token, 'DELETE', "/accounts/{$konto}/cfd_tunnel/{$id}");
                }
            } catch (CfFehler $e) {
                $fehler[] = t('Tunnel: {fehler}', ['fehler' => $e->getMessage()]);
            }
        }
        try {
            cf_eintrag_loeschen($token, einstellung('tunnel_zone'), einstellung('tunnel_dns_id'));
        } catch (CfFehler $e) {
            $fehler[] = t('DNS: {fehler}', ['fehler' => $e->getMessage()]);
        }
    }
    foreach (['tunnel_id', 'tunnel_konto', 'tunnel_dns_id', 'tunnel_zone', 'tunnel_host', 'tunnel_ziel', 'tunnel_fremd'] as $k) {
        einstellung_loeschen($k);
    }
    @unlink(tunnel_ordner() . '/token');
    @unlink(tunnel_ordner() . '/schritte.json');
    tunnel_app_url_schreiben('');
    return tunnel_stand() + ['probleme' => $fehler];
}

/** Für die Oberfläche */
function tunnel_stand(bool $mitCloudflare = true): array
{
    $host = tunnel_host();
    $id = tunnel_id();
    $token = einstellung('direkt_cf_token');
    $appHost = (string) (parse_url(konfig()['app_url'], PHP_URL_HOST) ?? '');
    $s = ['vorhanden' => false, 'verbunden' => false, 'status' => '', 'verbindungen' => [], 'version' => ''];
    if ($mitCloudflare && $id !== '' && $token !== '' && tunnel_konto() !== '') {
        try {
            $s = tunnel_verbindungen($token, tunnel_konto(), $id);
        } catch (Throwable $e) {
            $s['fehler'] = $e->getMessage();
        }
    }
    $schritte = is_file(tunnel_ordner() . '/schritte.json') ? (json_decode((string) file_get_contents(tunnel_ordner() . '/schritte.json'), true) ?: []) : [];
    return [
        'aktiv' => $host !== '' && $id !== '',
        'host' => $host,
        'url' => $host !== '' ? 'https://' . $host : '',
        'id' => $id,
        'token_gesetzt' => $token !== '',
        'token_datei' => is_file(tunnel_ordner() . '/token'),
        'vorschlag_host' => $appHost !== '' && !str_starts_with($appHost, 'lokal.') ? $appHost : '',
        'modus' => tunnel_modus(),
        'fremd' => einstellung('tunnel_fremd') === '1',
        'ziel' => tunnel_ziel(),
        'ziel_vorschlag' => tunnel_ziel_vorschlag(),
        'container' => tunnel_konfig()['container'],
        'container_ip' => tunnel_container_ip(),
        'diese_anfrage_im_tunnel' => tunnel_anfrage(),
        // Proxy für die Besucher-IP: aus der .env (PROXY_IPS), aus der Oberfläche (tunnel_proxy_ip) oder der Container im Stack
        'proxy_env' => konfig()['sicherheit']['proxy_ips'],
        'proxy_eingetragen' => einstellung('tunnel_proxy_ip'),
        // Vorschlag: diese Anfrage trägt Cloudflare-Kopfzeilen, kommt aber von einer Adresse, der nicht vertraut wird
        'proxy_vorschlag' => !empty($_SERVER['HTTP_CF_RAY']) && !tunnel_anfrage() ? (string) ($_SERVER['REMOTE_ADDR'] ?? '') : '',
        'app_url_aus_env' => (string) getenv('APP_URL') !== '',
        'links' => TUNNEL_LINKS,
        'lauf' => $schritte,
    ] + $s;
}

final class TunnelLauf
{
    public array $schritte = [];
    private function schreiben(array $s): void
    {
        file_put_contents(tunnel_ordner() . '/schritte.json', json_encode($s, JSON_UNESCAPED_UNICODE), LOCK_EX);
    }
    public function start(string $text): void
    {
        $this->schritte[] = ['text' => $text, 'status' => 'laeuft', 'zeit' => date('c'), 'info' => ''];
        $this->schreiben(['laeuft' => true, 'schritte' => $this->schritte]);
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
        $this->schreiben(['laeuft' => true, 'schritte' => $this->schritte]);
    }
    public function fertig(bool $ok, string $meldung = ''): void
    {
        $this->schreiben(['laeuft' => false, 'ok' => $ok, 'meldung' => $meldung, 'schritte' => $this->schritte, 'ende' => date('c')]);
    }
}

/* API */
function api_tunnel_stand(array $admin): array { return tunnel_stand(empty($_GET['kurz'])); }
function api_tunnel_einrichten(array $admin): array
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    return tunnel_einrichten((string) api_wert('host', ''), (string) api_wert('tunnel', ''), (string) api_wert('ziel', ''));
}
function api_tunnel_entfernen(array $admin): array { return tunnel_entfernen(); }
function api_tunnel_liste(array $admin): array
{
    $token = einstellung('direkt_cf_token');
    if ($token === '') {
        throw new ApiFehler(t('Kein Cloudflare-Token eingetragen.'));
    }
    try {
        return ['tunnel' => tunnel_liste($token)];
    } catch (CfFehler $e) {
        throw new ApiFehler($e->getMessage());
    }
}
/** Proxy-Adresse eines vorhandenen cloudflared eintragen (leer = löschen) */
function api_tunnel_proxy(array $admin): array
{
    $ip = trim((string) api_wert('ip', ''));
    if ($ip !== '' && !filter_var($ip, FILTER_VALIDATE_IP) && !preg_match('#^[0-9a-fA-F.:]+/\d{1,3}$#', $ip)) {
        throw new ApiFehler(t('Bitte eine IP-Adresse (oder ein Netz wie 172.18.0.0/16) angeben.'));
    }
    if ($ip === '') {
        einstellung_loeschen('tunnel_proxy_ip');
    } else {
        einstellung_setzen('tunnel_proxy_ip', $ip);
    }
    return tunnel_stand(false);
}
