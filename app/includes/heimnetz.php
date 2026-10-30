<?php
// Geräte im Heimnetz: DLNA/UPnP-Renderer (AV-Receiver, Fernseher, Streamer, Aktivboxen).
//
// Finden: gezielte SSDP-Anfrage (Unicast-M-SEARCH) an jede Adresse der Heimnetze – funktioniert auch aus einem eigenen
// Docker-Netz, in dem Multicast nicht hinauskommt –, dazu Multicast für den Fall „Host-Netz“, oder eine IP von Hand.
// Abspielen: der Renderer bekommt eine Adresse auf diesem Server (Original-Datei bitgenau, oder vom Server gerechnet:
// Effekte bzw. ein Format, das das Gerät kann) und holt sich die Musik selbst. Steuern: AVTransport/RenderingControl
// (Standard), dazu Ein/Eingang/Lautstärke/Tonmodus je Hersteller (Denon/Marantz, Yamaha MusicCast, Onkyo/Pioneer eISCP).
// Die Warteschlange führt der Heimnetz-Agent (scripts/heimnetz_agent.php) – auf dem Gerät läuft ja keine Amberwave-App.
// In der Fernsteuerung erscheinen die Geräte mit IDs ab HN_BASIS.
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

const HN_BASIS = 2000000000;
const HN_PROT_MAX = 60;

require_once __DIR__ . '/cast.php';

function hn_ist_cast(array $g): bool { return ($g['art'] ?? 'dlna') === 'cast'; }

function hn_konfig(): array
{
    return konfig()['heimnetz'] ?? ['an' => true, 'netze' => [], 'app_port' => 9950, 'render' => '', 'agent_ruhe_minuten' => 10, 'abfrage_ms' => 1000];
}

function hn_ist_fern_id(int $id): bool { return $id > HN_BASIS; }
function hn_fern_id(int $hid): int { return HN_BASIS + $hid; }

/* ---------------------------------------------------------------------------------------------------------------- */
/* Adresse des Servers im Heimnetz (dort holen die Geräte die Musik)                                               */

/** ['url' => 'http://192.168.1.10:9950' | '', 'quelle' => …] */
function hn_basis(): array
{
    require_once __DIR__ . '/einstellungen.php';
    $u = rtrim(einstellung('heimnetz_url'), '/');
    if ($u !== '') {
        return ['url' => $u, 'quelle' => einstellung_quelle('heimnetz_url') === 'env' ? 'env' : 'einstellung'];
    }
    $g = rtrim(einstellung('heimnetz_gelernt'), '/');
    if ($g !== '') {
        return ['url' => $g, 'quelle' => 'gelernt'];
    }
    $port = (int) hn_konfig()['app_port'];
    $ip = trim(einstellung('direkt_ip'));
    if ($ip !== '' && filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        return ['url' => "http://{$ip}:{$port}", 'quelle' => 'direkt_ip'];
    }
    $host = trim(einstellung('direkt_host'));
    if ($host !== '') {
        $ip = gethostbyname($host);
        if ($ip !== $host && hn_privat($ip)) {
            return ['url' => "http://{$ip}:{$port}", 'quelle' => 'direkt_host'];
        }
    }
    return ['url' => '', 'quelle' => 'unbekannt'];
}

function hn_privat(string $ip): bool
{
    return (bool) filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)
        && !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 | FILTER_FLAG_NO_PRIV_RANGE)
        && !str_starts_with($ip, '127.') && !str_starts_with($ip, '172.17.') ;
}

/**
 * Aus einer Anfrage im Heimnetz lernen, wie der Server dort heißt: wer die App über http://192.168.1.10:9950 öffnet,
 * zeigt genau die Adresse, die auch der Receiver erreicht (veröffentlichter Port, nicht der im Container).
 */
function hn_basis_lernen(?array $user = null): void
{
    try {
        // nur von Admins: sonst könnte jedes Konto per Host-Kopfzeile die Adresse umbiegen, von der alle Geräte Musik und Cover holen
        if (!$user || ($user['rolle'] ?? '') !== 'admin') {
            return;
        }
        if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
            return;
        }
        $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
        if (!preg_match('/^([a-z0-9.-]+)(?::(\d{1,5}))?$/', $host, $m)) {
            return;
        }
        require_once __DIR__ . '/netz.php';
        if (empty(netz_info()['lokal'])) {
            return;
        }
        $ip = filter_var($m[1], FILTER_VALIDATE_IP) ? $m[1] : gethostbyname($m[1]);
        if (!hn_privat($ip)) {
            return;
        }
        $url = 'http://' . $ip . (isset($m[2]) && $m[2] !== '' && $m[2] !== '80' ? ':' . $m[2] : '');
        require_once __DIR__ . '/einstellungen.php';
        if (einstellung('heimnetz_gelernt') !== $url) {
            einstellung_setzen('heimnetz_gelernt', $url);
        }
    } catch (Throwable $e) {
        // Lernen ist Kür
    }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* HTTP, SOAP                                                                                                        */

/** [status, body, kopfzeilen] – ohne Ausnahme (status 0 = keine Verbindung) */
function hn_http(string $methode, string $url, ?string $body = null, array $kopf = [], float $timeout = 2.5): array
{
    $ctx = stream_context_create(['http' => [
        'method' => $methode, 'header' => implode("\r\n", array_merge(['Connection: close', 'User-Agent: Amberwave/' . app_version() . ' UPnP/1.0 DLNADOC/1.50'], $kopf)),
        'content' => $body ?? '', 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0, 'protocol_version' => 1.1,
    ]]);
    $antwort = @file_get_contents($url, false, $ctx);
    $status = 0;
    $kz = $http_response_header ?? [];
    if ($kz && preg_match('#^HTTP/\S+\s+(\d{3})#', $kz[0], $m)) {
        $status = (int) $m[1];
    }
    return [$status, $antwort === false ? '' : $antwort, $kz];
}

/** SOAP-Aufruf; Rückgabe: Kindelemente der Antwort als Feld (Name → Text). Fehler → Ausnahme mit UPnP-Fehlertext. */
function hn_soap(string $url, string $dienst, string $aktion, array $args = [], float $timeout = 3.0): array
{
    $x = '';
    foreach ($args as $k => $v) {
        $x .= "<{$k}>" . htmlspecialchars((string) $v, ENT_XML1 | ENT_QUOTES, 'UTF-8') . "</{$k}>";
    }
    $body = '<?xml version="1.0" encoding="utf-8"?>' . "\n"
        . '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
        . "<u:{$aktion} xmlns:u=\"{$dienst}\">{$x}</u:{$aktion}></s:Body></s:Envelope>";
    [$st, $antwort] = hn_http('POST', $url, $body, ['Content-Type: text/xml; charset="utf-8"', "SOAPACTION: \"{$dienst}#{$aktion}\""], $timeout);
    if ($st === 0) {
        throw new RuntimeException(t('Gerät antwortet nicht'));
    }
    $xml = @simplexml_load_string($antwort);
    if ($st !== 200 || $xml === false) {
        $fehler = '';
        if ($xml !== false) {
            $f = $xml->xpath('//*[local-name()="errorDescription"]');
            $c = $xml->xpath('//*[local-name()="errorCode"]');
            $fehler = trim(($c ? (string) $c[0] . ' ' : '') . ($f ? (string) $f[0] : ''));
        }
        throw new RuntimeException("{$aktion}: " . ($fehler !== '' ? $fehler : "HTTP {$st}"));
    }
    $aus = [];
    $r = $xml->xpath('//*[local-name()="' . $aktion . 'Response"]');
    if ($r) {
        foreach ($r[0]->children() as $k) {
            $aus[$k->getName()] = (string) $k;
        }
        foreach ($r[0]->children('', true) as $k) {
            $aus[$k->getName()] = (string) $k;
        }
    }
    return $aus;
}

const HN_AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const HN_RC = 'urn:schemas-upnp-org:service:RenderingControl:1';
const HN_CM = 'urn:schemas-upnp-org:service:ConnectionManager:1';

/* ---------------------------------------------------------------------------------------------------------------- */
/* Suche                                                                                                             */

/** Netze, die abgesucht werden: .env, sonst das /24 der Server-Adresse und das des Admins, der gerade sucht */
function hn_suchnetze(): array
{
    $netze = hn_konfig()['netze'];
    if (!$netze) {
        $b = hn_basis()['url'];
        if ($b !== '' && preg_match('#//(\d+\.\d+\.\d+)\.\d+#', $b, $m)) {
            $netze[] = $m[1] . '.0/24';
        }
        $c = client_ip();
        if (hn_privat($c) || str_starts_with($c, '127.')) {
            $netze[] = preg_replace('/\.\d+$/', '.0/24', $c);
        }
    }
    return array_values(array_unique($netze));
}

/** Adressen eines Netzes (höchstens /22) */
function hn_adressen(string $netz): array
{
    if (!preg_match('#^(\d+\.\d+\.\d+\.\d+)(?:/(\d+))?$#', trim($netz), $m)) {
        return [];
    }
    $bits = isset($m[2]) ? max(22, min(32, (int) $m[2])) : 32;
    $basis = ip2long($m[1]) & (-1 << (32 - $bits));
    $n = 1 << (32 - $bits);
    $aus = [];
    for ($i = $n > 2 ? 1 : 0; $i < ($n > 2 ? $n - 1 : $n); $i++) {
        $aus[] = long2ip($basis + $i);
    }
    return $aus;
}

/** SSDP: Unicast-M-SEARCH an jede Adresse (Port 1900) + Multicast; Ergebnis: LOCATION-URLs je IP */
function hn_ssdp(array $ips, float $sekunden = 2.5): array
{
    $st = 'urn:schemas-upnp-org:device:MediaRenderer:1';
    $socks = [];
    foreach ($ips as $ip) {
        $s = @stream_socket_client("udp://{$ip}:1900", $e1, $e2, 0.2);
        if (!$s) {
            continue;
        }
        stream_set_blocking($s, false);
        @fwrite($s, "M-SEARCH * HTTP/1.1\r\nHOST: {$ip}:1900\r\nMAN: \"ssdp:discover\"\r\nST: {$st}\r\nUSER-AGENT: Amberwave UPnP/1.1\r\n\r\n");
        $socks[$ip] = $s;
    }
    // Multicast (klappt nur, wenn der Container im Host-Netz läuft)
    $mc = @stream_socket_client('udp://239.255.255.250:1900', $e1, $e2, 0.2);
    if ($mc) {
        stream_set_blocking($mc, false);
        @fwrite($mc, "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {$st}\r\nUSER-AGENT: Amberwave UPnP/1.1\r\n\r\n");
        $socks['*'] = $mc;
    }
    $funde = [];
    $ende = microtime(true) + $sekunden;
    while ($socks && microtime(true) < $ende) {
        $lesen = array_values($socks);
        $w = $x = null;
        if (@stream_select($lesen, $w, $x, 0, 200000) > 0) {
            foreach ($lesen as $s) {
                while (($d = @fread($s, 4096)) !== false && $d !== '') {
                    if (preg_match('/^LOCATION:\s*(\S+)/mi', $d, $m) && preg_match('#^https?://([\d.]+)#', $m[1], $h)) {
                        $funde[$h[1]] = $m[1];
                    }
                }
            }
        }
    }
    foreach ($socks as $s) {
        fclose($s);
    }
    return $funde;
}

/** Bekannte Orte der Gerätebeschreibung je Hersteller (falls ein Gerät auf M-SEARCH nicht antwortet) */
const HN_BEKANNTE_ORTE = [
    ':60006/upnp/desc/aios_device/aios_device.xml',   // Denon/Marantz mit HEOS
    ':8080/description.xml',                           // Denon/Marantz älter
    ':49154/MediaRenderer/desc.xml',                   // Yamaha
    ':8888/description.xml',                           // Onkyo/Pioneer
];

/** Beschreibung eines Geräts lesen: Name, Hersteller, Modell, Dienste (AVTransport, RenderingControl, ConnectionManager) */
function hn_beschreibung(string $ort): ?array
{
    [$st, $xml] = hn_http('GET', $ort, null, [], 2.5);
    if ($st !== 200 || $xml === '') {
        return null;
    }
    $x = @simplexml_load_string($xml);
    if ($x === false) {
        return null;
    }
    $x->registerXPathNamespace('u', 'urn:schemas-upnp-org:device-1-0');
    $basis = (string) ($x->xpath('//u:URLBase')[0] ?? '');
    if ($basis === '') {
        $p = parse_url($ort);
        $basis = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    }
    $absolut = static function (string $u) use ($basis, $ort): string {
        if ($u === '' || preg_match('#^https?://#', $u)) {
            return $u;
        }
        if ($u[0] === '/') {
            $p = parse_url($basis);
            return $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '') . $u;
        }
        return rtrim($basis, '/') . '/' . $u;
    };
    // das Gerät mit AVTransport (kann eingebettet sein)
    $geraete = $x->xpath('//u:device');
    foreach ($geraete as $g) {
        $g->registerXPathNamespace('u', 'urn:schemas-upnp-org:device-1-0');
        $dienste = [];
        foreach ($g->xpath('u:serviceList/u:service') as $s) {
            $s->registerXPathNamespace('u', 'urn:schemas-upnp-org:device-1-0');
            $typ = (string) ($s->xpath('u:serviceType')[0] ?? '');
            $dienste[preg_replace('/^urn:schemas-upnp-org:service:([A-Za-z]+):\d+$/', '$1', $typ)] = $absolut((string) ($s->xpath('u:controlURL')[0] ?? ''));
        }
        if (empty($dienste['AVTransport'])) {
            continue;
        }
        // Name/Hersteller vom Gerät selbst, sonst vom Wurzelgerät
        $wert = static function (string $feld) use ($g, $x): string {
            $v = trim((string) ($g->xpath('u:' . $feld)[0] ?? ''));
            return $v !== '' ? $v : trim((string) ($x->xpath('//u:device/u:' . $feld)[0] ?? ''));
        };
        return [
            'name' => $wert('friendlyName'), 'hersteller' => $wert('manufacturer'), 'modell' => trim($wert('modelName') . ' ' . $wert('modelNumber')),
            'udn' => $wert('UDN'), 'typ' => $wert('deviceType'), 'ort' => $ort,
            'avt' => $dienste['AVTransport'] ?? '', 'rc' => $dienste['RenderingControl'] ?? '', 'cm' => $dienste['ConnectionManager'] ?? '',
        ];
    }
    return null;
}

/** Formate aus GetProtocolInfo → Fähigkeiten */
function hn_faehig(array $b, array $alt = []): array
{
    $sink = '';
    if ($b['cm'] !== '') {
        try {
            $sink = hn_soap($b['cm'], HN_CM, 'GetProtocolInfo')['Sink'] ?? '';
        } catch (Throwable $e) {
        }
    }
    $formate = [];
    foreach (explode(',', $sink) as $p) {
        $teile = explode(':', trim($p));
        if (count($teile) >= 3 && $teile[2] !== '') {
            $formate[] = strtolower($teile[2]);
        }
    }
    $formate = array_values(array_unique($formate));
    $hat = static fn(string $m) => (bool) array_filter($formate, static fn($f) => str_starts_with($f, $m));
    $tv = (bool) preg_match('/\b(tv|bravia|webos|tizen|television|oled|qled)\b/i', $b['name'] . ' ' . $b['modell'] . ' ' . $b['typ']);
    $avr = (bool) preg_match('/denon|marantz|yamaha|onkyo|pioneer|integra|nad|arcam|cambridge|naim|bluesound|heos/i', $b['hersteller'] . ' ' . $b['modell']);
    $setnext = false;
    if ($b['avt'] !== '') {
        // SetNextAVTransportURI anbieten? Steht in der Dienstbeschreibung – vereinfacht: AV-Receiver/Streamer ja, Fernseher nein
        $setnext = $avr || !$tv;
    }
    return array_merge([
        'formate' => $formate,
        'flac' => $hat('audio/flac') || $hat('audio/x-flac') || (!$formate && $avr),
        'wav' => $hat('audio/wav') || $hat('audio/x-wav') || $hat('audio/wave') || !$formate,
        'l16' => $hat('audio/l16'),
        // ohne Angabe: Receiver/Streamer bis 24/192, Fernseher vorsichtig 16/48 (lässt sich je Gerät ändern)
        'max_rate' => $tv ? 48000 : 192000, 'max_bits' => $tv ? 16 : 24,
        'mehrkanal' => $avr, 'setnext' => $setnext, 'tv' => $tv, 'avr' => $avr,
    ], array_intersect_key($alt, array_flip(['max_rate', 'max_bits', 'mehrkanal', 'setnext'])));
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Steuerung je Hersteller                                                                                           */

/** Welche Steuerung hat das Gerät? ['denon'|'yamaha'|'onkyo'|'', port] */
function hn_steuerung_erkennen(string $ip, string $hersteller): array
{
    $h = strtolower($hersteller);
    $versuche = [];
    if (str_contains($h, 'denon') || str_contains($h, 'marantz') || $h === '') {
        $versuche[] = 'denon';
    }
    if (str_contains($h, 'yamaha') || $h === '') {
        $versuche[] = 'yamaha';
    }
    if (preg_match('/onkyo|pioneer|integra/', $h) || $h === '') {
        $versuche[] = 'onkyo';
    }
    foreach ($versuche as $art) {
        if ($art === 'denon') {
            foreach ([8080, 80] as $port) {
                [$st, $b] = hn_http('GET', "http://{$ip}:{$port}/goform/formMainZone_MainZoneXmlStatusLite.xml", null, [], 1.5);
                if ($st === 200 && str_contains($b, '<Power>')) {
                    return ['denon', $port];
                }
            }
        } elseif ($art === 'yamaha') {
            [$st, $b] = hn_http('GET', "http://{$ip}/YamahaExtendedControl/v1/system/getDeviceInfo", null, [], 1.5);
            $j = json_decode($b, true);
            if ($st === 200 && is_array($j) && ($j['response_code'] ?? -1) === 0) {
                return ['yamaha', 80];
            }
        } else {
            $r = hn_eiscp($ip, 60128, 'PWRQSTN', 'PWR', 1.2);
            if ($r !== null) {
                return ['onkyo', 60128];
            }
        }
    }
    return ['', 0];
}

/** eISCP (Onkyo/Pioneer/Integra): Befehl senden, auf Antwort mit Präfix warten (null = keine) */
function hn_eiscp(string $ip, int $port, string $cmd, ?string $warte = null, float $timeout = 1.5): ?string
{
    $s = @stream_socket_client("tcp://{$ip}:{$port}", $e1, $e2, $timeout);
    if (!$s) {
        return null;
    }
    stream_set_timeout($s, (int) ceil($timeout));
    $daten = "!1{$cmd}\r";
    fwrite($s, 'ISCP' . pack('N', 16) . pack('N', strlen($daten)) . "\x01\x00\x00\x00" . $daten);
    $antwort = $warte === null ? '' : null;
    $ende = microtime(true) + $timeout;
    $puffer = '';
    while ($warte !== null && microtime(true) < $ende) {
        $r = [$s]; $w = $x = null;
        if (@stream_select($r, $w, $x, 0, 200000) < 1) {
            continue;
        }
        $d = fread($s, 4096);
        if ($d === false || $d === '') {
            break;
        }
        $puffer .= $d;
        while (strlen($puffer) >= 16 && str_starts_with($puffer, 'ISCP')) {
            $kopf = unpack('N', substr($puffer, 4, 4))[1];
            $laenge = unpack('N', substr($puffer, 8, 4))[1];
            if (strlen($puffer) < $kopf + $laenge) {
                break;
            }
            $msg = rtrim(substr($puffer, $kopf, $laenge), "\x1a\r\n");
            $puffer = substr($puffer, $kopf + $laenge);
            if (str_starts_with($msg, '!1' . $warte)) {
                $antwort = substr($msg, 2 + strlen($warte));
                break 2;
            }
        }
    }
    fclose($s);
    return $antwort;
}

function hn_denon(array $g, string $cmd): bool
{
    [$st] = hn_http('GET', "http://{$g['ip']}:{$g['steuer_port']}/goform/formiPhoneAppDirect.xml?" . rawurlencode($cmd), null, [], 2.0);
    return $st === 200;
}

function hn_yamaha(array $g, string $pfad): ?array
{
    [$st, $b] = hn_http('GET', "http://{$g['ip']}/YamahaExtendedControl/v1/{$pfad}", null, [], 2.0);
    $j = json_decode($b, true);
    return $st === 200 && is_array($j) ? $j : null;
}

/** Lautstärke-Bereich: ['min','max','einheit','schritt'] – max ist die Schutzgrenze aus den Einstellungen */
function hn_vol_bereich(array $g): array
{
    $e = hn_einst($g);
    $z = hn_json($g['zustand']);
    if (hn_ist_cast($g)) {
        $max = is_numeric($e['max_vol'] ?? null) ? (float) $e['max_vol'] : 100.0;
        return ['min' => 0.0, 'max' => min(100.0, max(1.0, $max)), 'einheit' => '%', 'schritt' => 1.0];
    }
    if ($g['steuerung'] === 'denon' || ($g['steuerung'] === 'yamaha' && isset($z['db']))) {
        $max = is_numeric($e['max_vol'] ?? null) ? (float) $e['max_vol'] : -10.0;
        return ['min' => -80.0, 'max' => min(18.0, $max), 'einheit' => 'dB', 'schritt' => 0.5];
    }
    $max = is_numeric($e['max_vol'] ?? null) ? (float) $e['max_vol'] : 60.0;
    $deckel = $g['steuerung'] === 'yamaha' ? (float) ($z['vol_max'] ?? 100) : 100.0;
    return ['min' => 0.0, 'max' => min($deckel, max(1.0, $max)), 'einheit' => '', 'schritt' => 1.0];
}

function hn_vol_text(array $g, ?float $wert): string
{
    if ($wert === null) {
        return '';
    }
    $b = hn_vol_bereich($g);
    if ($b['einheit'] === 'dB') {
        return ($wert > 0 ? '+' : ($wert < 0 ? '−' : '')) . number_format(abs($wert), 1, ',', '') . ' dB';
    }
    if ($b['einheit'] === '%') {
        return (int) round($wert) . ' %';
    }
    return (string) (int) round($wert);
}

/**
 * Zustand des Geräts lesen (Strom, Eingang, Lautstärke, Tonmodus) – je nach Steuerung; ohne Herstellersteuerung nur die
 * Lautstärke über RenderingControl. Rückgabe: Feld oder ['erreichbar' => false].
 */
function hn_status(array $g): array
{
    if (hn_ist_cast($g)) {
        return cast_status($g);
    }
    try {
        if ($g['steuerung'] === 'denon') {
            [$st, $b] = hn_http('GET', "http://{$g['ip']}:{$g['steuer_port']}/goform/formMainZone_MainZoneXmlStatusLite.xml", null, [], 2.0);
            if ($st !== 200) {
                return ['erreichbar' => false];
            }
            $x = @simplexml_load_string($b);
            $vol = (string) ($x->MasterVolume->value ?? '');
            return ['erreichbar' => true, 'an' => strtoupper((string) ($x->Power->value ?? '')) === 'ON', 'eingang' => (string) ($x->InputFuncSelect->value ?? ''),
                'vol' => is_numeric($vol) ? (float) $vol : -80.0, 'stumm' => strtolower((string) ($x->Mute->value ?? '')) === 'on', 'db' => true];
        }
        if ($g['steuerung'] === 'yamaha') {
            $j = hn_yamaha($g, 'main/getStatus');
            if (!$j) {
                return ['erreichbar' => false];
            }
            $db = isset($j['actual_volume']['mode']) && $j['actual_volume']['mode'] === 'db';
            return ['erreichbar' => true, 'an' => ($j['power'] ?? '') === 'on', 'eingang' => (string) ($j['input'] ?? ''),
                'vol' => $db ? (float) $j['actual_volume']['value'] : (float) ($j['volume'] ?? 0), 'vol_max' => (float) ($j['max_volume'] ?? 100),
                'stumm' => !empty($j['mute']), 'modus' => !empty($j['pure_direct']) ? 'pure_direct' : (string) ($j['sound_program'] ?? ''), 'db' => $db ?: null];
        }
        if ($g['steuerung'] === 'onkyo') {
            $pwr = hn_eiscp($g['ip'], (int) $g['steuer_port'], 'PWRQSTN', 'PWR', 1.5);
            if ($pwr === null) {
                return ['erreichbar' => false];
            }
            $mvl = hn_eiscp($g['ip'], (int) $g['steuer_port'], 'MVLQSTN', 'MVL', 1.0);
            $sli = hn_eiscp($g['ip'], (int) $g['steuer_port'], 'SLIQSTN', 'SLI', 1.0);
            $lmd = hn_eiscp($g['ip'], (int) $g['steuer_port'], 'LMDQSTN', 'LMD', 1.0);
            return ['erreichbar' => true, 'an' => $pwr === '01', 'eingang' => (string) $sli, 'vol' => $mvl !== null && ctype_xdigit($mvl) ? (float) hexdec($mvl) : 0.0, 'modus' => (string) $lmd];
        }
        if ($g['rc_url'] !== '') {
            $v = hn_soap($g['rc_url'], HN_RC, 'GetVolume', ['InstanceID' => 0, 'Channel' => 'Master'], 2.0);
            return ['erreichbar' => true, 'an' => true, 'vol' => (float) ($v['CurrentVolume'] ?? 0)];
        }
        hn_soap($g['avt_url'], HN_AVT, 'GetTransportInfo', ['InstanceID' => 0], 2.0);
        return ['erreichbar' => true, 'an' => true];
    } catch (Throwable $e) {
        return ['erreichbar' => false];
    }
}

/** Einschalten (falls im Standby) */
function hn_ein(array $g): bool
{
    return match ($g['steuerung']) {
        'denon' => hn_denon($g, 'PWON') && hn_denon($g, 'ZMON'),
        'yamaha' => (bool) hn_yamaha($g, 'main/setPower?power=on'),
        'onkyo' => hn_eiscp($g['ip'], (int) $g['steuer_port'], 'PWR01') !== null,
        default => true,
    };
}

function hn_aus(array $g): bool
{
    return match ($g['steuerung']) {
        'denon' => hn_denon($g, 'PWSTANDBY'),
        'yamaha' => (bool) hn_yamaha($g, 'main/setPower?power=standby'),
        'onkyo' => hn_eiscp($g['ip'], (int) $g['steuer_port'], 'PWR00') !== null,
        'cast' => (static function () use ($g) { try { cast_verbindung($g)->appStoppen(); return true; } catch (Throwable $e) { return false; } })(),
        default => false,
    };
}

/** Eingang „Netzwerk/Server“ */
function hn_eingang_netz(array $g): bool
{
    return match ($g['steuerung']) {
        'denon' => hn_denon($g, 'SINET'),
        'yamaha' => (bool) hn_yamaha($g, 'main/setInput?input=server'),
        'onkyo' => hn_eiscp($g['ip'], (int) $g['steuer_port'], 'SLI2B') !== null,
        default => true,
    };
}

/** Lautstärke als Wert in der Einheit des Geräts (dB bzw. 0–100), begrenzt auf die Schutzgrenze */
function hn_vol_setzen(array $g, float $wert): bool
{
    $b = hn_vol_bereich($g);
    $wert = max($b['min'], min($b['max'], round($wert / $b['schritt']) * $b['schritt']));
    try {
        if (hn_ist_cast($g)) {
            cast_verbindung($g)->lautstaerke($wert / 100);
            return true;
        }
        if ($g['steuerung'] === 'denon') {
            $abs = $wert + 80.0;
            $ganz = (int) floor($abs);
            return hn_denon($g, 'MV' . sprintf('%02d', $ganz) . ($abs - $ganz >= 0.25 ? '5' : ''));
        }
        if ($g['steuerung'] === 'yamaha') {
            return $b['einheit'] === 'dB'
                ? (bool) hn_yamaha($g, 'main/setActualVolume?mode=db&value=' . number_format($wert, 1, '.', ''))
                : (bool) hn_yamaha($g, 'main/setVolume?volume=' . (int) round($wert));
        }
        if ($g['steuerung'] === 'onkyo') {
            return hn_eiscp($g['ip'], (int) $g['steuer_port'], 'MVL' . sprintf('%02X', (int) round($wert))) !== null;
        }
        if ($g['rc_url'] !== '') {
            hn_soap($g['rc_url'], HN_RC, 'SetVolume', ['InstanceID' => 0, 'Channel' => 'Master', 'DesiredVolume' => (int) round($wert)]);
            return true;
        }
    } catch (Throwable $e) {
    }
    return false;
}

/** Tonmodi je Steuerung: Schlüssel → [Anzeige, Befehl] */
function hn_tonmodi(string $steuerung): array
{
    return match ($steuerung) {
        'denon' => ['pure' => ['Pure Direct', 'MSPURE DIRECT'], 'direct' => ['Direct', 'MSDIRECT'], 'stereo' => ['Stereo', 'MSSTEREO'], 'mch' => ['Multi Ch Stereo', 'MSMCH STEREO'], 'auto' => ['Auto', 'MSAUTO']],
        'yamaha' => ['pure' => ['Pure Direct', 'pure_direct'], 'direct' => ['Straight', 'straight'], 'stereo' => ['2ch Stereo', '2ch_stereo'], 'mch' => ['All-Ch Stereo', 'all_ch_stereo'], 'auto' => ['Surround Decoder', 'surr_decoder']],
        'onkyo' => ['pure' => ['Pure Audio', '11'], 'direct' => ['Direct', '01'], 'stereo' => ['Stereo', '00'], 'mch' => ['All Ch Stereo', '0C'], 'auto' => ['Auto', '0F']],
        default => [],
    };
}

function hn_tonmodus(array $g, string $modus): bool
{
    $m = hn_tonmodi($g['steuerung'])[$modus] ?? null;
    if (!$m) {
        return false;
    }
    if ($g['steuerung'] === 'denon') {
        return hn_denon($g, $m[1]);
    }
    if ($g['steuerung'] === 'yamaha') {
        if ($modus === 'pure') {
            return (bool) hn_yamaha($g, 'main/setPureDirect?enable=true');
        }
        hn_yamaha($g, 'main/setPureDirect?enable=false');
        return (bool) hn_yamaha($g, 'main/setSoundProgram?program=' . $m[1]);
    }
    return hn_eiscp($g['ip'], (int) $g['steuer_port'], 'LMD' . $m[1]) !== null;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Geräte                                                                                                            */

function hn_json(?string $s): array
{
    $j = json_decode((string) $s, true);
    return is_array($j) ? $j : [];
}

/** Einstellungen eines Geräts mit Standards */
function hn_einst(array $g): array
{
    $e = array_merge([
        'einschalten' => true, 'eingang' => true, 'tonmodus' => '', 'aus_minuten' => 0, 'max_vol' => null, 'start_vol' => null,
        'max_rate' => null, 'max_bits' => null,
        'klang' => ['weg' => 'original', 'befehle' => [], 'beschreibung' => '', 'kanaele' => 2, 'lautheit' => false, 'ziel' => -16, 'bezug' => [],
            'space' => ['an' => false, 'preset' => '', 'name' => '', 'kanaele' => 6, 'raten' => []]],
    ], hn_einst_roh($g));
    $e['klang'] += ['weg' => 'original', 'befehle' => [], 'beschreibung' => '', 'kanaele' => 2, 'lautheit' => false, 'ziel' => -16, 'bezug' => [], 'space' => []];
    $e['klang']['space'] += ['an' => false, 'preset' => '', 'name' => '', 'kanaele' => 6, 'raten' => []];
    return $e;
}
function hn_einst_roh(array $g): array { return hn_json($g['einst'] ?? ''); }

function hn_geraet(int $id): ?array
{
    return db_zeile('SELECT * FROM heimgeraete WHERE id = :id', ['id' => $id]);
}

function hn_protokoll(int $id, string $text): void
{
    $z = date('H:i:s') . ' ' . mb_substr($text, 0, 300);
    $alt = (string) db_wert('SELECT protokoll FROM heimgeraete WHERE id = :id', ['id' => $id]);
    $zeilen = array_slice(array_filter(explode("\n", $alt)), -(HN_PROT_MAX - 1));
    $zeilen[] = $z;
    db_tun('UPDATE heimgeraete SET protokoll = :p WHERE id = :id', ['p' => implode("\n", $zeilen), 'id' => $id]);
}

/** Gerät unter einer Adresse (LOCATION-URL oder IP) untersuchen – Beschreibung, Formate, Steuerung */
function hn_untersuchen(string $ort_oder_ip): ?array
{
    $orte = [];
    if (preg_match('#^https?://#', $ort_oder_ip)) {
        $orte[] = $ort_oder_ip;
        preg_match('#//([\d.]+)#', $ort_oder_ip, $m);
        $ip = $m[1] ?? '';
    } else {
        $ip = $ort_oder_ip;
        $f = hn_ssdp([$ip], 1.5);
        if (isset($f[$ip])) {
            $orte[] = $f[$ip];
        }
        foreach (HN_BEKANNTE_ORTE as $o) {
            $orte[] = "http://{$ip}{$o}";
        }
    }
    foreach ($orte as $ort) {
        $b = hn_beschreibung($ort);
        if (!$b) {
            continue;
        }
        [$steuerung, $port] = hn_steuerung_erkennen($ip, $b['hersteller']);
        return $b + ['ip' => $ip, 'faehig' => hn_faehig($b), 'steuerung' => $steuerung, 'steuer_port' => $port];
    }
    return null;
}

function hn_hinzufuegen(array $u): int
{
    $art = ($u['art'] ?? 'dlna') === 'cast' ? 'cast' : 'dlna';
    $vorhanden = $art === 'cast'
        ? db_zeile('SELECT * FROM heimgeraete WHERE ip = :ip AND art = :art AND steuer_port = :p', ['ip' => $u['ip'], 'art' => $art, 'p' => (int) $u['steuer_port']])
        : db_zeile('SELECT * FROM heimgeraete WHERE ip = :ip AND art = :art', ['ip' => $u['ip'], 'art' => $art]);
    $werte = ['h' => mb_substr($u['hersteller'], 0, 80), 'm' => mb_substr($u['modell'], 0, 120), 'udn' => mb_substr($u['udn'], 0, 120),
        'b' => $u['ort'], 'a' => $u['avt'], 'r' => $u['rc'], 'c' => $u['cm'], 's' => $u['steuerung'], 'sp' => (int) $u['steuer_port'],
        'f' => json_encode($u['faehig']), 'ip' => $u['ip'], 'art' => $art];
    if ($vorhanden) {
        if ($art === 'cast') {
            // von Hand oder nach einem Fehler gesetzte Formatgrenzen (z. B. „kein FLAC“) bleiben
            $alt = hn_json($vorhanden['faehig']);
            $werte['f'] = json_encode(array_merge($u['faehig'], array_intersect_key($alt, ['flac' => 1, 'max_rate' => 1, 'max_bits' => 1, 'setnext' => 1, 'umrechnen' => 1])));
        }
        // Space: was das Gerät beim Abspielen gezeigt hat (geht / abgelehnt), bleibt beim neuen Untersuchen
        $alt = hn_json($vorhanden['faehig']);
        $werte['f'] = json_encode(array_merge(hn_json($werte['f']), array_intersect_key($alt, ['space' => 1, 'space_grund' => 1, 'space_zeit' => 1])));
        db_tun('UPDATE heimgeraete SET hersteller = :h, modell = :m, udn = :udn, beschreibung_url = :b, avt_url = :a, rc_url = :r, cm_url = :c,
                steuerung = :s, steuer_port = :sp, faehig = :f, zuletzt_ok = NOW() WHERE id = :vid', array_diff_key($werte, ['ip' => 1, 'art' => 1]) + ['vid' => $vorhanden['id']]);
        hn_protokoll((int) $vorhanden['id'], t('neu untersucht: {modell}', ['modell' => $u['modell']]) . ($u['steuerung'] ? ' · ' . t('Steuerung {name}', ['name' => $u['steuerung']]) : ''));
        return (int) $vorhanden['id'];
    }
    $name = trim(preg_replace('/\s*\(.*?\)\s*/', '', $u['name'])) ?: ($u['modell'] ?: t('Gerät'));
    $id = db_einfuegen('INSERT INTO heimgeraete (art, name, hersteller, modell, ip, udn, beschreibung_url, avt_url, rc_url, cm_url, steuerung, steuer_port, faehig, zuletzt_ok)
            VALUES (:art, :n, :h, :m, :ip, :udn, :b, :a, :r, :c, :s, :sp, :f, NOW())', $werte + ['n' => mb_substr($name, 0, 80)]);
    hn_protokoll($id, t('hinzugefügt: {gerät}', ['gerät' => $u['hersteller'] . ' ' . $u['modell']]) . ' · ' . $u['ort']);
    return $id;
}

/** für Oberfläche und Fernsteuerung */
function hn_aussen(array $g, bool $admin = false): array
{
    $f = hn_json($g['faehig']);
    $e = hn_einst($g);
    $z = hn_json($g['zustand']);
    $b = hn_vol_bereich($g);
    $aus = [
        'id' => (int) $g['id'], 'art' => $g['art'] ?? 'dlna', 'fern_id' => hn_fern_id((int) $g['id']), 'name' => $g['name'], 'hersteller' => $g['hersteller'], 'modell' => $g['modell'],
        'ip' => $g['ip'], 'aktiv' => (bool) $g['aktiv'], 'steuerung' => $g['steuerung'],
        'faehig' => $f, 'zustand' => $z, 'vol_bereich' => $b, 'vol_text' => hn_vol_text($g, isset($z['vol']) ? (float) $z['vol'] : null),
        'tonmodi' => array_map(static fn($m) => $m[0], hn_tonmodi($g['steuerung'])),
        'klang' => ['weg' => $e['klang']['weg'], 'beschreibung' => $e['klang']['beschreibung'], 'kanaele' => $e['klang']['kanaele'], 'space' => hn_space_aussen($g)],
        'zuletzt_ok' => iso($g['zuletzt_ok']),
    ];
    if ($admin) {
        $aus['einst'] = array_diff_key($e, ['klang' => 1]);
        $aus['beschreibung_url'] = $g['beschreibung_url'];
        $aus['protokoll'] = array_reverse(array_filter(explode("\n", (string) $g['protokoll'])));
    }
    return $aus;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* API                                                                                                               */

function api_heimnetz(array $admin): array
{
    $b = hn_basis();
    return [
        'geraete' => array_map(static fn($g) => hn_aussen($g, true), db_alle('SELECT * FROM heimgeraete ORDER BY name')),
        'basis' => $b, 'netze' => hn_suchnetze(), 'agent' => hn_agent_laeuft(), 'render' => hn_render_pfad() !== null,
        'cast' => hn_cast_info(),
    ];
}

/** Eigener Cast-Empfänger: App-ID (woher), Adresse der Empfänger-Seite (muss HTTPS sein) */
function hn_cast_info(): array
{
    require_once __DIR__ . '/einstellungen.php';
    $basis = cast_https_basis();
    return ['app_id' => cast_app_id(), 'quelle' => einstellung_quelle('cast_app_id'), 'empfaenger' => $basis . '/cast/empfaenger.html',
        'https' => str_starts_with($basis, 'https://'), 'geraete' => (int) db_wert("SELECT COUNT(*) FROM heimgeraete WHERE art = 'cast'")];
}

/** App-ID des eigenen Empfängers setzen (leer = Standard-Empfänger von Google) */
function api_heimnetz_cast(array $admin): array
{
    $id = strtoupper(trim((string) api_wert('app_id', '')));
    if ($id !== '' && !preg_match('/^[0-9A-F]{8}$/', $id)) {
        throw new ApiFehler(t('Die App-ID hat 8 Zeichen (0–9, A–F), z. B. 1A2B3C4D.'));
    }
    require_once __DIR__ . '/einstellungen.php';
    einstellung_setzen('cast_app_id', $id);
    return ['ok' => true, 'cast' => hn_cast_info()];
}

function api_heimnetz_suchen(array $admin): array
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    set_time_limit(60);
    $netz = trim((string) api_wert('netz', ''));
    $netze = $netz !== '' ? [$netz] : hn_suchnetze();
    $ips = [];
    foreach ($netze as $n) {
        $ips = array_merge($ips, hn_adressen($n));
    }
    $ips = array_slice(array_values(array_unique($ips)), 0, 1024);
    $funde = hn_ssdp($ips, 2.5);
    $cast = cast_suchen($ips, 2.0);
    $bekannt = [];
    foreach (db_alle('SELECT id, ip, art, steuer_port FROM heimgeraete') as $z) {
        $bekannt[$z['ip'] . '|' . $z['art'] . ($z['art'] === 'cast' ? ':' . $z['steuer_port'] : '')] = (int) $z['id'];
    }
    $aus = [];
    foreach ($funde as $ip => $ort) {
        $b = hn_beschreibung($ort);
        if (!$b) {
            continue;
        }
        $aus[] = ['art' => 'dlna', 'ip' => $ip, 'ort' => $ort, 'name' => $b['name'], 'hersteller' => $b['hersteller'], 'modell' => $b['modell'], 'bekannt' => $bekannt[$ip . '|dlna'] ?? null];
    }
    foreach ($cast as $f) {
        $aus[] = ['art' => 'cast', 'ip' => $f['ip'], 'ort' => "cast://{$f['ip']}:{$f['port']}", 'name' => $f['name'] ?: t('Cast-Gerät'), 'hersteller' => $f['gruppe'] ? t('Google Cast · Gruppe') : 'Google Cast',
            'modell' => $f['modell'], 'bekannt' => $bekannt[$f['ip'] . '|cast:' . $f['port']] ?? null];
    }
    return ['funde' => $aus, 'netze' => $netze, 'adressen' => count($ips)];
}

function api_heimnetz_hinzufuegen(array $admin): array
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    $wo = trim((string) api_wert('ort', api_wert('ip', '')));
    if ($wo === '' || (!filter_var($wo, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) && !preg_match('#^(https?|cast)://[\d.]+(:\d+)?(/|$)#', $wo))) {
        throw new ApiFehler(t('Bitte eine IPv4-Adresse wie 192.168.1.42 angeben.'));
    }
    // per IP: erst DLNA, dann Google Cast
    $u = str_starts_with($wo, 'cast://') ? cast_untersuchen($wo) : (hn_untersuchen($wo) ?? (filter_var($wo, FILTER_VALIDATE_IP) ? cast_untersuchen($wo) : null));
    if (!$u) {
        throw new ApiFehler(t('Unter {wo} antwortet kein Abspielgerät (DLNA oder Google Cast). Ist es an und im selben Netz?', ['wo' => $wo]), 404);
    }
    $id = hn_hinzufuegen($u);
    hn_status_auffrischen($id);
    return ['ok' => true, 'geraet' => hn_aussen(hn_geraet($id), true)];
}

function api_heimnetz_aendern(array $admin, int $id): array
{
    $g = hn_geraet($id);
    if (!$g) {
        throw new ApiFehler(t('Gerät nicht gefunden.'), 404);
    }
    $e = hn_einst_roh($g);
    $neu = api_wert('einst', []);
    if (is_array($neu)) {
        foreach (['einschalten', 'eingang'] as $k) {
            if (array_key_exists($k, $neu)) $e[$k] = (bool) $neu[$k];
        }
        if (array_key_exists('tonmodus', $neu)) $e['tonmodus'] = array_key_exists((string) $neu['tonmodus'], hn_tonmodi($g['steuerung'])) ? (string) $neu['tonmodus'] : '';
        if (array_key_exists('aus_minuten', $neu)) $e['aus_minuten'] = max(0, min(240, (int) $neu['aus_minuten']));
        foreach (['max_vol', 'start_vol'] as $k) {
            if (array_key_exists($k, $neu)) $e[$k] = is_numeric($neu[$k]) ? (float) $neu[$k] : null;
        }
        if (array_key_exists('max_rate', $neu)) $e['max_rate'] = in_array((int) $neu['max_rate'], [44100, 48000, 96000, 192000], true) ? (int) $neu['max_rate'] : null;
        if (array_key_exists('max_bits', $neu)) $e['max_bits'] = in_array((int) $neu['max_bits'], [16, 24], true) ? (int) $neu['max_bits'] : null;
    }
    $name = api_wert('name', null);
    db_tun('UPDATE heimgeraete SET einst = :e, name = COALESCE(:n, name), aktiv = COALESCE(:a, aktiv) WHERE id = :id', [
        'e' => json_encode($e, JSON_UNESCAPED_UNICODE), 'n' => is_string($name) && trim($name) !== '' ? mb_substr(trim($name), 0, 80) : null,
        'a' => api_wert('aktiv', null) === null ? null : (api_wert('aktiv') ? 1 : 0), 'id' => $id]);
    return ['ok' => true, 'geraet' => hn_aussen(hn_geraet($id), true)];
}

/** Adresse im Heimnetz von Hand setzen (leer = wieder automatisch) */
function api_heimnetz_basis(array $admin): array
{
    $u = rtrim(trim((string) api_wert('url', '')), '/');
    if ($u !== '' && !preg_match('#^https?://[A-Za-z0-9.-]+(:\d{1,5})?$#', $u)) {
        throw new ApiFehler(t('Bitte so angeben: http://192.168.1.10:9950'));
    }
    require_once __DIR__ . '/einstellungen.php';
    einstellung_setzen('heimnetz_url', $u);
    return ['ok' => true, 'basis' => hn_basis()];
}

/** Klang-Profil (nur Admins): Original oder Effekte; befehle = Kette wie für die Engine, aus der Web-App */
function api_heimnetz_klang(array $admin, int $id): array
{
    $g = hn_geraet($id);
    if (!$g) {
        throw new ApiFehler(t('Gerät nicht gefunden.'), 404);
    }
    $e = hn_einst_roh($g);
    $k = $e['klang'] ?? [];
    $weg = (string) api_wert('weg', $k['weg'] ?? 'original');
    $k['weg'] = $weg === 'effekte' ? 'effekte' : 'original';
    $befehle = api_wert('befehle', null);
    if (is_array($befehle)) {
        $sauber = [];
        foreach (array_slice($befehle, 0, 40) as $b) {
            if (is_array($b) && in_array($b['c'] ?? '', ['fx', 'kette'], true)) {
                $sauber[] = $b;
            }
        }
        $json = json_encode($sauber);
        if ($json === false || strlen($json) > 200000) {
            throw new ApiFehler(t('Kette zu groß.'));
        }
        $k['befehle'] = $sauber;
    }
    foreach (['beschreibung' => 120] as $f => $l) {
        if (is_string(api_wert($f, null))) $k[$f] = mb_substr((string) api_wert($f), 0, $l);
    }
    $bezug = api_wert('bezug', null);
    if (is_array($bezug)) {
        $k['bezug'] = array_filter(array_map(static fn($v) => is_numeric($v) ? (float) $v : null, array_intersect_key($bezug, ['glow' => 1, 'iron' => 1, 'silk' => 1])), static fn($v) => $v !== null);
    }
    $space = api_wert('space', null);
    if (is_array($space)) {
        $raten = [];
        foreach ((array) ($space['raten'] ?? []) as $r => $hash) {
            if (in_array((int) $r, HN_SPACE_RATEN, true) && is_string($hash) && hn_raum_datei($hash)) {
                $raten[(string) (int) $r] = $hash;
            }
        }
        $an = !empty($space['an']) && $raten;
        // Kanalzahl kommt aus den Graphen selbst (alle müssen gleich sein), nicht aus der Angabe des Clients
        $kanaele = null;
        foreach ($raten as $hash) {
            $kn = hn_raum_kanaele((string) hn_raum_datei($hash));
            if ($kn === null || ($kanaele !== null && $kn !== $kanaele)) {
                throw new ApiFehler(t('Space-Daten passen nicht zusammen (Kanalzahl).'));
            }
            $kanaele = $kn;
        }
        $k['space'] = ['an' => $an, 'preset' => mb_substr((string) ($space['preset'] ?? ''), 0, 20), 'name' => mb_substr((string) ($space['name'] ?? ''), 0, 40),
            'kanaele' => $kanaele ?? 6, 'raten' => $an ? $raten : []];
    }
    if (api_wert('lautheit', null) !== null) $k['lautheit'] = (bool) api_wert('lautheit');
    if (is_numeric(api_wert('ziel', null))) $k['ziel'] = max(-30.0, min(-10.0, (float) api_wert('ziel')));
    $e['klang'] = $k;
    db_tun('UPDATE heimgeraete SET einst = :e WHERE id = :id', ['e' => json_encode($e, JSON_UNESCAPED_UNICODE), 'id' => $id]);
    hn_protokoll($id, t('Klang: {wert}', ['wert' => $k['weg'] === 'effekte' ? t('Effekte ({beschreibung})', ['beschreibung' => ($k['beschreibung'] ?? '') . (!empty($k['space']['an']) ? ' · Space ' . $k['space']['name'] : '')]) : t('Original')]));
    // laufender Titel: ab der aktuellen Stelle mit dem neuen Klang
    db_einfuegen('INSERT INTO fern_befehle (ziel_id, von_id, von_user, befehl, daten) VALUES (:z, 0, :u, :b, :d)',
        ['z' => hn_fern_id($id), 'u' => $admin['id'], 'b' => 'neu_laden', 'd' => 'null']);
    if (function_exists('fern_signal')) {
        fern_signal(hn_fern_id($id));
    }
    hn_agent_anstossen();
    return ['ok' => true, 'geraet' => hn_aussen(hn_geraet($id), true)];
}

function api_heimnetz_loeschen(array $admin, int $id): array
{
    db_tun('DELETE FROM heimgeraete WHERE id = :id', ['id' => $id]);
    db_tun('DELETE FROM fern_praesenz WHERE geraet_id = :g', ['g' => hn_fern_id($id)]);
    db_tun('UPDATE fern_praesenz SET ziel_id = NULL WHERE ziel_id = :g', ['g' => hn_fern_id($id)]);
    return ['ok' => true];
}

function api_heimnetz_pruefen(array $admin, int $id): array
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    $g = hn_geraet($id);
    if (!$g) {
        throw new ApiFehler(t('Gerät nicht gefunden.'), 404);
    }
    $u = hn_ist_cast($g) ? cast_untersuchen($g['ip'] . ':' . $g['steuer_port']) : (hn_untersuchen($g['beschreibung_url'] ?: $g['ip']) ?? hn_untersuchen($g['ip']));
    if ($u) {
        if (!hn_ist_cast($g)) {
            $u['faehig'] = hn_faehig($u, array_intersect_key(hn_json($g['faehig']), []));
        }
        hn_hinzufuegen($u);
    } else {
        hn_protokoll($id, t('Prüfung: Gerät antwortet nicht'));
    }
    hn_status_auffrischen($id);
    return ['ok' => (bool) $u, 'geraet' => hn_aussen(hn_geraet($id), true)];
}

/** Zustand vom Gerät lesen und merken */
function hn_status_auffrischen(int $id): array
{
    $g = hn_geraet($id);
    if (!$g) {
        return [];
    }
    $s = hn_status($g);
    db_tun('UPDATE heimgeraete SET zustand = :z' . (!empty($s['erreichbar']) ? ', zuletzt_ok = NOW()' : '') . ' WHERE id = :id', ['z' => json_encode($s), 'id' => $id]);
    return $s;
}

/** Tonmodus (nur Admins) */
function api_heimnetz_tonmodus(array $admin, int $id): array
{
    $g = hn_geraet($id);
    if (!$g) {
        throw new ApiFehler(t('Gerät nicht gefunden.'), 404);
    }
    $m = (string) api_wert('modus', '');
    if (!hn_tonmodus($g, $m)) {
        throw new ApiFehler(t('Tonmodus ließ sich nicht setzen.'), 502);
    }
    hn_protokoll($id, t('Tonmodus: {modus}', ['modus' => hn_tonmodi($g['steuerung'])[$m][0] ?? $m]));
    $s = hn_status_auffrischen($id);
    return ['ok' => true, 'zustand' => $s];
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Stream für das Gerät                                                                                              */

function hn_b64u(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function hn_b64u_dec(string $s): string { return (string) base64_decode(strtr($s, '-_', '+/')); }

/** Adresse für das Gerät: t = Track, u = Nutzer, g = Gerät, m = 'o' (Original) / 'r' (gerechnet), r/b/k = Ziel, h = Profil */
function hn_stream_token(array $d): string
{
    $d['x'] = time() + 86400;
    $j = hn_b64u(json_encode($d));
    return $j . '.' . hn_b64u(substr(hash_hmac('sha256', 'heim|' . $j, konfig()['app_secret_key'], true), 0, 18));
}

function hn_stream_token_pruefen(string $t): ?array
{
    $teile = explode('.', $t);
    if (count($teile) !== 2) {
        return null;
    }
    $soll = hn_b64u(substr(hash_hmac('sha256', 'heim|' . $teile[0], konfig()['app_secret_key'], true), 0, 18));
    if (!hash_equals($soll, $teile[1])) {
        return null;
    }
    $d = json_decode(hn_b64u_dec($teile[0]), true);
    return is_array($d) && (int) ($d['x'] ?? 0) >= time() ? $d : null;
}

function hn_render_pfad(): ?string
{
    $p = hn_konfig()['render'] ?: aw_realpath(__DIR__ . '/../bin/aw-render');
    if (!$p || !is_file($p)) {
        return null;
    }
    if (!is_executable($p)) {
        @chmod($p, 0755);
    }
    return is_executable($p) ? $p : null;
}

/** DLNA-Kopfzeilen (manche Geräte spielen sonst nicht oder können nicht spulen) */
function hn_dlna_kopf(string $mime, bool $spulbar): void
{
    header('transferMode.dlna.org: Streaming');
    header('contentFeatures.dlna.org: DLNA.ORG_OP=' . ($spulbar ? '01' : '00') . ';DLNA.ORG_CI=' . ($mime === 'audio/flac' ? '0' : '1') . ';DLNA.ORG_FLAGS=01700000000000000000000000000000');
    header('Cache-Control: no-cache');
}

/** GET /heim/s/{token} – ohne Anmeldung, der Schlüssel ist signiert und läuft nach einem Tag ab */
function hn_stream_senden(string $token): void
{
    require_once __DIR__ . '/stream.php';
    $d = hn_stream_token_pruefen($token);
    if (!$d) {
        throw new ApiFehler(t('Schlüssel ungültig oder abgelaufen.'), 403);
    }
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    [$pfad, $datei] = stream_datei((int) $d['t']);
    if (($d['m'] ?? 'o') === 'o') {
        $mime = AUDIO_MIME[$datei['format']] ?? 'application/octet-stream';
        hn_dlna_kopf($mime, true);
        datei_mit_range_senden($pfad, $mime);
        return;
    }
    hn_render_senden($pfad, $datei, $d);
}

/**
 * Gerechnet: WAV mit exakter Länge (Content-Length stimmt, Spulen über Range = neu rechnen ab der Stelle).
 * Quelle → ffmpeg (float, Zielrate) → aw-render (Kette aus dem Profil, Angleich) → PCM 16/24 Bit.
 */
function hn_render_senden(string $pfad, array $datei, array $d): void
{
    $rate = (int) ($d['r'] ?? 44100);
    $bits = (int) ($d['b'] ?? 24) === 16 ? 16 : 24;
    $kanEin = max(1, min(8, (int) ($d['ki'] ?? 2)));
    $kanAus = max(1, min(8, (int) ($d['k'] ?? $kanEin)));
    $laengeS = max(0.1, (float) $datei['laenge_ms'] / 1000.0);
    $frames = (int) round($laengeS * $rate);
    $block = $kanAus * ($bits / 8);
    $daten = $frames * $block;
    // mehr als 2 Kanäle: WAVE_FORMAT_EXTENSIBLE mit Lautsprecher-Maske (5.1: FL FR FC LFE BL BR, Quadro: FL FR BL BR) –
    // ohne Maske ordnen manche Receiver die Kanäle falsch zu oder lehnen ab
    $kl = $kanAus > 2 ? 68 : 44;
    $gesamt = $kl + $daten;
    $von = 0;
    $range = (string) ($_SERVER['HTTP_RANGE'] ?? '');
    if ($range !== '' && preg_match('/^bytes=(\d+)-/', trim($range), $m)) {
        $von = min((int) $m[1], $gesamt - 1);
    }
    hn_dlna_kopf('audio/wav', true);
    header('Content-Type: audio/wav');
    header('Accept-Ranges: bytes');
    if ($von > 0) {
        http_response_code(206);
        header("Content-Range: bytes {$von}-" . ($gesamt - 1) . "/{$gesamt}");
    }
    header('Content-Length: ' . ($gesamt - $von));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
        return;
    }
    // wie jede andere Umwandlung: begrenzt viele ffmpeg-Prozesse gleichzeitig (der Schlüssel ist ohne Anmeldung nutzbar)
    $platz = umwandlung_platz();
    if (!$platz) {
        header('Retry-After: 5');
        throw new ApiFehler(t('Der Server wandelt gerade zu viele Titel gleichzeitig um. Bitte gleich noch einmal versuchen.'), 503);
    }
    set_time_limit(0);
    ignore_user_abort(false);
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    if ($kl === 68) {
        $maske = [3 => 0x7, 4 => 0x33, 5 => 0x37, 6 => 0x3F, 7 => 0x13F, 8 => 0x63F][$kanAus] ?? 0;
        $kopf = 'RIFF' . pack('V', 60 + $daten) . 'WAVE' . 'fmt ' . pack('VvvVVvv', 40, 0xFFFE, $kanAus, $rate, $rate * $block, $block, $bits)
            . pack('vvV', 22, $bits, $maske) . hex2bin('0100000000001000800000aa00389b71') . 'data' . pack('V', $daten);
    } else {
        $kopf = 'RIFF' . pack('V', 36 + $daten) . 'WAVE' . 'fmt ' . pack('VvvVVvv', 16, 1, $kanAus, $rate, $rate * $block, $block, $bits) . 'data' . pack('V', $daten);
    }
    $startFrame = 0;
    if ($von < $kl) {
        echo substr($kopf, $von);
    } else {
        $startFrame = intdiv($von - $kl, $block);
        $versatz = ($von - $kl) % $block;   // mitten in einem Frame: Rest des Frames verwerfen
    }
    $start = $startFrame / $rate;
    $render = hn_render_pfad();
    $kette = (string) ($d['h'] ?? '') !== '' ? hn_kette_datei((string) $d['h']) : null;
    $raum = (string) ($d['sp'] ?? '') !== '' ? hn_raum_datei((string) $d['sp']) : null;
    $aufraeumen = null;
    if ($kette && $raum) {
        // Kette (klein, je Titel) und Space-Graph (groß, je Preset) erst hier zusammenführen – nur für diesen einen Lauf
        $tmp = tempnam(konfig()['pfade']['cache'] . '/tmp', 'kette-');
        if ($tmp !== false && file_put_contents($tmp, file_get_contents($kette) . file_get_contents($raum)) !== false) {
            $kette = $tmp;
            $aufraeumen = $tmp;
        } else {
            $raum = null;
        }
    }
    $spaceFehlt = $kanAus > 2 && (!$render || !$kette || !$raum);
    if ($spaceFehlt) {
        // 6 Kanäle versprochen (Kopf ist schon raus), aber kein Space rechenbar (Datei weg, aw-render fehlt):
        // Stereo nach vorn, hinten Stille – nicht ffmpegs eigener Matrix-Upmix
        error_log('Amberwave Heimnetz: Space-Kette fehlt für Titel ' . (int) $d['t'] . ' – Stream läuft ohne Raumklang');
    }
    $ff = konfig()['stream']['ffmpeg'] ?? 'ffmpeg';
    $bezugSs = $start > 0 ? ' -ss ' . number_format($start, 3, '.', '') : '';
    $fmt = $bits === 16 ? 's16le' : 's24le';
    if ($render && $kette && !$spaceFehlt) {
        $gain = (float) ($d['g'] ?? 0);
        $cmd = aw_arg($ff) . " -v error -nostdin{$bezugSs} -i " . aw_arg($pfad) . " -map 0:a:0 -f f32le -ac {$kanEin} -ar {$rate} -af aresample=resampler=soxr - | "
            . aw_arg($render) . " {$rate} {$kanEin} {$bits} " . aw_arg($kette) . ' ' . number_format($gain, 2, '.', '') . aw_ohne_fehler();
    } else {
        // nur Format (Rate/Bits/Kanäle) – z. B. Fernseher bis 48 kHz
        $pan = $kanAus > 2 ? ',pan=' . ($kanAus === 6 ? '5.1|FL=FL|FR=FR' : 'quad|FL=FL|FR=FR') : '';
        $filter = 'aresample=resampler=soxr' . ($bits === 16 ? ':dither_method=triangular' : '') . $pan;
        $cmd = aw_arg($ff) . " -v error -nostdin{$bezugSs} -i " . aw_arg($pfad) . " -map 0:a:0 -f {$fmt} -ac {$kanAus} -ar {$rate} -af " . aw_arg($filter) . ' -';
    }
    $p = popen($cmd, 'r');
    if (!$p) {
        if ($aufraeumen !== null) {
            @unlink($aufraeumen);
        }
        flock($platz, LOCK_UN);
        fclose($platz);
        return;
    }
    $rest = ($frames - $startFrame) * $block - ($versatz ?? 0);   // genau so viele Bytes, wie Content-Length verspricht
    $weg = $versatz ?? 0;
    while ($rest > 0 && !feof($p)) {
        $s = fread($p, 262144);
        if ($s === false || $s === '') {
            break;
        }
        if ($weg > 0) {
            $s = substr($s, $weg);
            $weg = 0;
        }
        if (strlen($s) > $rest) {
            $s = substr($s, 0, $rest);
        }
        echo $s;
        flush();
        $rest -= strlen($s);
        if (connection_aborted()) {
            break;
        }
    }
    pclose($p);
    if ($aufraeumen !== null) {
        @unlink($aufraeumen);
    }
    flock($platz, LOCK_UN);
    fclose($platz);
    // zu kurz gerechnet (Rundung beim Umrechnen): mit Stille auf die versprochene Länge
    while ($rest > 0 && !connection_aborted()) {
        $n = min($rest, 65536);
        echo str_repeat("\0", $n);
        $rest -= $n;
    }
}

/** Kette als Datei im Cache (je Profil-Hash); Inhalt kommt aus hn_kette_vorbereiten */
function hn_kette_datei(string $hash): ?string
{
    if (!preg_match('/^[a-f0-9]{16,64}$/', $hash)) {
        return null;
    }
    $p = konfig()['pfade']['cache'] . '/heimnetz/kette-' . $hash . '.jsonl';
    return is_file($p) ? $p : null;
}

/**
 * Kette für einen Titel: Befehle des Profils, die Ansteuerung von Glow/Iron/Silk je nach Lautheit am Eingang angepasst
 * (wie in der App: leise Titel stärker, laute schwächer). Rückgabe: Hash (Dateiname) oder ''.
 */
function hn_kette_vorbereiten(array $klang, ?float $lufsEingang, bool $mitRaum = false): string
{
    $befehle = $klang['befehle'] ?? [];
    if (!$befehle && !$mitRaum) {
        return '';
    }
    $zeilen = [];
    foreach ($befehle as $b) {
        if (($b['c'] ?? '') === 'fx' && in_array($b['art'] ?? '', ['glow', 'iron', 'silk'], true) && isset($b['w.drive']) && $lufsEingang !== null) {
            $ref = $klang['bezug'][$b['art']] ?? null;
            if ($ref !== null) {
                $korr = max(-12.0, min(12.0, (float) $ref - $lufsEingang));
                $b['w.drive'] = (float) $b['w.drive'] * pow(10, $korr / 20);
            }
        }
        $zeilen[] = json_encode($b, JSON_UNESCAPED_UNICODE);
    }
    $text = implode("\n", $zeilen) . "\n";   // der Space-Graph (groß) bleibt eine eigene Datei und kommt erst beim Streamen dazu
    $hash = substr(hash('sha256', $text), 0, 24);
    $ordner = konfig()['pfade']['cache'] . '/heimnetz';
    if (!is_dir($ordner)) {
        @mkdir($ordner, 0775, true);
    }
    $p = "{$ordner}/kette-{$hash}.jsonl";
    if (!is_file($p)) {
        file_put_contents($p . '.tmp', $text);
        rename($p . '.tmp', $p);
    }
    return $hash;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Space (Raumklang) vom Server                                                                                      */

/** Abtastraten, für die die Web-App den Space-Graphen schickt – mit Space rechnet der Server in dieser Familie (44,1 / 48 kHz) */
const HN_SPACE_RATEN = [44100, 48000];

function hn_raum_datei(string $hash): ?string
{
    if (!preg_match('/^[a-f0-9]{24}$/', $hash)) {
        return null;
    }
    $p = konfig()['pfade']['cache'] . '/heimnetz/raum-' . $hash . '.jsonl';
    return is_file($p) ? $p : null;
}

/** Kanalzahl (4 oder 6) aus dem raum-Befehl einer Space-Datei; null, wenn unbrauchbar */
function hn_raum_kanaele(string $pfad): ?int
{
    if ($pfad === '' || !is_file($pfad)) {
        return null;
    }
    $h = fopen($pfad, 'r');
    if (!$h) {
        return null;
    }
    $kan = null;
    while (($z = fgets($h)) !== false) {
        if (str_starts_with($z, '{"c":"raum"')) {
            $b = json_decode($z, true);
            if (($b['c'] ?? '') === 'raum') {
                $kan = (int) ($b['w.kan'] ?? 0);
                break;
            }
        }
    }
    fclose($h);
    return in_array($kan, [4, 6], true) ? $kan : null;
}

/** POST /heimnetz/raum (Admin, Formular mit Datei „kette“): Space-Befehle einer Abtastrate speichern → Hash */
function api_heimnetz_raum(array $admin): array
{
    $f = $_FILES['kette'] ?? null;
    if (!$f || ($f['error'] ?? 1) !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) {
        throw new ApiFehler(t('Keine Space-Daten erhalten.'));
    }
    if ((int) $f['size'] > 16 * 1024 * 1024) {
        throw new ApiFehler(t('Space-Daten zu groß.'));
    }
    $zeilen = [];
    $graph = false;
    foreach (explode("\n", (string) file_get_contents($f['tmp_name'])) as $z) {
        if (trim($z) === '') {
            continue;
        }
        $b = json_decode($z, true);
        if (!is_array($b) || !in_array($b['c'] ?? '', ['raum', 'raum_ir', 'raum_p', 'raum_m'], true)) {
            throw new ApiFehler(t('Ungültige Space-Daten.'));
        }
        $graph = $graph || $b['c'] === 'raum';
        $zeilen[] = json_encode($b, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    if (!$graph) {
        throw new ApiFehler(t('Space-Daten ohne Graph.'));
    }
    $text = implode("\n", $zeilen) . "\n";
    $hash = substr(hash('sha256', $text), 0, 24);
    $ordner = konfig()['pfade']['cache'] . '/heimnetz';
    if (!is_dir($ordner)) {
        @mkdir($ordner, 0775, true);
    }
    $p = "{$ordner}/raum-{$hash}.jsonl";
    if (!is_file($p)) {
        file_put_contents($p . '.tmp', $text);
        rename($p . '.tmp', $p);
    }
    return ['ok' => true, 'hash' => $hash];
}

/** cache/heimnetz aufräumen: Kettendateien nach 7 Tagen, Space-Graphen nach 60 Tagen (ohne Bezug aus einem Geräteprofil) */
function hn_cache_aufraeumen(): int
{
    $ordner = konfig()['pfade']['cache'] . '/heimnetz';
    if (!is_dir($ordner)) {
        return 0;
    }
    $benutzt = [];
    foreach (db_alle('SELECT einst FROM heimgeraete') as $g) {
        foreach ((hn_json($g['einst'])['klang']['space']['raten'] ?? []) as $hash) {
            $benutzt[(string) $hash] = true;
        }
    }
    $n = 0;
    foreach (glob($ordner . '/*.jsonl') ?: [] as $p) {
        $name = basename($p);
        $alter = time() - (int) filemtime($p);
        $weg = str_starts_with($name, 'kette-') ? $alter > 7 * 86400
            : (str_starts_with($name, 'raum-') ? $alter > 60 * 86400 && !isset($benutzt[substr($name, 5, 24)]) : $alter > 86400);
        if ($weg && @unlink($p)) {
            $n++;
        }
    }
    return $n;
}

/** Space am Gerät: eingestellt? kann es das Gerät (null = noch nicht ausprobiert)? */
function hn_space_aussen(array $g): array
{
    $sp = hn_einst($g)['klang']['space'];
    $f = hn_json($g['faehig']);
    return ['an' => !empty($sp['an']), 'preset' => $sp['preset'], 'name' => $sp['name'], 'kanaele' => $sp['kanaele'],
        'geht' => array_key_exists('space', $f) ? ($f['space'] === null ? null : (bool) $f['space']) : null,
        'grund' => $f['space_grund'] ?? '', 'zeit' => $f['space_zeit'] ?? null];
}

/** Ergebnis merken: Space geht (true) oder wurde abgelehnt (false, mit Grund); null = vergessen, neu ausprobieren */
function hn_space_merken(int $id, ?bool $geht, string $grund = ''): void
{
    $g = hn_geraet($id);
    if (!$g) {
        return;
    }
    $f = hn_json($g['faehig']);
    if ($geht === null) {
        unset($f['space'], $f['space_grund'], $f['space_zeit']);
    } else {
        $f['space'] = $geht;
        $f['space_grund'] = $geht ? '' : mb_substr($grund, 0, 200);
        $f['space_zeit'] = date('c');
    }
    db_tun('UPDATE heimgeraete SET faehig = :f WHERE id = :id', ['f' => json_encode($f), 'id' => $id]);
}

/** POST /heimnetz/geraete/{id}/space – gemerkte Ablehnung vergessen und Space beim nächsten Titel neu ausprobieren */
function api_heimnetz_space_neu(array $admin, int $id): array
{
    if (!hn_geraet($id)) {
        throw new ApiFehler(t('Gerät nicht gefunden.'), 404);
    }
    hn_space_merken($id, null);
    hn_protokoll($id, t('Space: wird beim nächsten Titel neu ausprobiert'));
    db_einfuegen('INSERT INTO fern_befehle (ziel_id, von_id, von_user, befehl, daten) VALUES (:z, 0, :u, :b, :d)',
        ['z' => hn_fern_id($id), 'u' => $admin['id'], 'b' => 'neu_laden', 'd' => 'null']);
    if (function_exists('fern_signal')) {
        fern_signal(hn_fern_id($id));
    }
    hn_agent_anstossen();
    return ['ok' => true, 'geraet' => hn_aussen(hn_geraet($id), true)];
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Agent                                                                                                             */

function hn_agent_sperre(): string { return konfig()['pfade']['cache'] . '/tmp/heimnetz-agent.lock'; }

function hn_agent_laeuft(): bool
{
    $p = hn_agent_sperre();
    if (!is_file($p)) {
        return false;
    }
    $h = @fopen($p, 'c');
    if (!$h) {
        return false;
    }
    $frei = flock($h, LOCK_EX | LOCK_NB);
    if ($frei) {
        flock($h, LOCK_UN);
    }
    fclose($h);
    return !$frei;
}

/** Agent starten, falls er nicht läuft (er beendet sich nach einer Weile ohne Arbeit selbst) */
function hn_agent_anstossen(): void
{
    if (!hn_konfig()['an'] || hn_agent_laeuft()) {
        return;
    }
    @mkdir(dirname(hn_agent_sperre()), 0775, true);
    $skript = aw_realpath(__DIR__ . '/../scripts/heimnetz_agent.php');
    $php = aw_php();
    aw_hintergrund(aw_arg($php) . ' ' . aw_arg((string) $skript));
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Fernsteuerung: Geräte im Heimnetz als Ziele                                                                       */

/** Zeile wie fern_geraet() für ein Heimnetz-Gerät (gehört „allen“: user_id = der Fragende) */
function hn_fern_geraet(int $fernId, array $user): ?array
{
    $g = hn_geraet($fernId - HN_BASIS);
    if (!$g || !$g['aktiv']) {
        return null;
    }
    $p = db_zeile('SELECT zustand, ziel_id, (zuletzt_am > NOW(3) - INTERVAL 20 SECOND) AS frisch FROM fern_praesenz WHERE geraet_id = :g', ['g' => $fernId]);
    $z = hn_json($g['zustand']);
    return ['id' => $fernId, 'user_id' => (int) $user['id'], 'name' => $g['name'], 'vorname' => 'Heimnetz', 'benutzername' => '',
        'zustand' => $p['zustand'] ?? null, 'ziel_id' => null, 'online' => ($z['erreichbar'] ?? true) !== false ? 1 : 0, 'alter_sek' => 0, 'heim' => true];
}

/** Einträge für /fern/geraete */
function hn_fern_liste(array $user, int $ich): array
{
    $aus = [];
    foreach (db_alle('SELECT * FROM heimgeraete WHERE aktiv = 1 ORDER BY name') as $g) {
        $fid = hn_fern_id((int) $g['id']);
        $p = db_zeile('SELECT zustand FROM fern_praesenz WHERE geraet_id = :g', ['g' => $fid]);
        $st = hn_json($p['zustand'] ?? '');
        $z = hn_json($g['zustand']);
        $erreichbar = ($z['erreichbar'] ?? true) !== false;
        $steuern = array_map('intval', array_column(db_alle('SELECT geraet_id FROM fern_praesenz WHERE ziel_id = :g AND zuletzt_am > NOW(3) - INTERVAL 20 SECOND', ['g' => $fid]), 'geraet_id'));
        $aus[] = [
            'id' => $fid, 'name' => $g['name'], 'ich' => false, 'online' => $erreichbar, 'alter_sek' => 0, 'heim' => true,
            'besitzer' => ['id' => 0, 'name' => t('Im Heimnetz'), 'ich' => false],
            'zustand' => [
                'art' => hn_ist_cast($g) ? 'cast' : 'dlna', 'mobil' => false, 'spielt' => !empty($st['spielt']),
                'titel' => $st['track']['titel'] ?? null, 'kuenstler' => isset($st['track']['kuenstler']) ? implode(', ', array_map(static fn($k) => is_array($k) ? (string) ($k['name'] ?? '') : (string) $k, (array) $st['track']['kuenstler'])) : null,
                'cover' => $st['track']['album']['cover'] ?? null, 'vol' => isset($st['vol']) ? (float) $st['vol'] : null, 'bitgenau' => false,
                'an' => $z['an'] ?? null, 'eingang' => $z['eingang'] ?? null, 'vol_text' => hn_vol_text($g, isset($z['vol']) ? (float) $z['vol'] : null),
                'hersteller' => $g['hersteller'], 'modell' => $g['modell'], 'steuerung' => $g['steuerung'],
            ],
            'steuerbar' => $erreichbar, 'grund' => $erreichbar ? null : t('nicht erreichbar'),
            'steuert' => null, 'gesteuert_von' => $steuern, 'max_vol' => 100,
            'klang' => hn_einst($g)['klang']['weg'],
        ];
    }
    return $aus;
}
