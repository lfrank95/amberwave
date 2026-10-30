<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/region.php';

function h(?string $t): string
{
    return htmlspecialchars((string) $t, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function app_name(): string
{
    return (string) konfig()['app_name'];
}

function app_version(): string
{
    return (string) konfig()['version'];
}

/** Asset-URL mit Änderungsdatum als Versionsparameter -> Browser und Cloudflare laden nach Updates neu. */
function asset_url(string $pfad): string
{
    $datei = dirname(__DIR__) . $pfad;
    return $pfad . '?v=' . (is_file($datei) ? (string) filemtime($datei) : '0');
}

/**
 * Import-Map für die JS-Module: jede Datei unter /js/ mit eigenem Versionsparameter. Ohne sie lädt der Browser die per
 * import nachgeladenen Module ohne ?v= – über Zwischenspeicher (Cloudflare, Browser) kann dann nach einem Update eine
 * Mischung aus alten und neuen Dateien laufen.
 */
function import_map_json(): string
{
    $imports = [];
    $b = buendel();
    foreach (glob(dirname(__DIR__) . '/js/*.js') ?: [] as $datei) {
        $name = '/js/' . basename($datei);
        // mit Bündel braucht die Karte nur, was die App über absolute Adresse nachlädt (Sprachdatei); die Module selbst stecken im Bündel
        if ($b && $name !== '/js/i18n_en.js') {
            continue;
        }
        $imports[$name] = $name . '?v=' . filemtime($datei) . '-' . filesize($datei);
    }
    if ($b) {
        // die Stücke des Bündels importieren einander ohne ?v= – die Karte hängt es an (sonst lüde der Browser sie doppelt: einmal vorgeladen mit, einmal ohne)
        foreach ($b['dateien'] as $f) {
            $datei = dirname(__DIR__) . '/js/_b/' . $f;
            if (is_file($datei)) {
                $imports['/js/_b/' . $f] = '/js/_b/' . $f . '?v=' . filemtime($datei);
            }
        }
    }
    return json_encode(['imports' => $imports], JSON_UNESCAPED_SLASHES);
}

/**
 * Gebündelte Oberfläche (js/_b, gebaut mit scripts/buendeln.sh): wenige minimierte Dateien statt ~40 Module – der erste Start
 * lädt und übersetzt gut die Hälfte weniger. Gilt nur, wenn das Bündel zu den Quellen passt (Prüfsumme im Manifest); sonst
 * (oder ohne Bündel) laufen die Quellmodule wie gehabt. Liefert das Manifest oder null.
 */
function buendel(): ?array
{
    static $b = false;
    if ($b !== false) {
        return $b;
    }
    $b = null;
    $dir = dirname(__DIR__) . '/js/_b';
    $m = is_file($dir . '/manifest.json') ? json_decode((string) @file_get_contents($dir . '/manifest.json'), true) : null;
    if (!is_array($m) || empty($m['quelle']) || empty($m['einstieg']) || empty($m['start']) || !is_array($m['start'])) {
        return null;
    }
    $quellen = glob(dirname(__DIR__) . '/js/*.js') ?: [];
    sort($quellen, SORT_STRING);
    $stand = [];
    foreach ($quellen as $f) {
        $stand[] = basename($f) . ':' . filemtime($f) . ':' . filesize($f);
    }
    // Prüfergebnis je Quellen-Stand merken – sonst müsste jede Anfrage 1,3 MB hashen
    $cache = sys_get_temp_dir() . '/aw_buendel_' . md5(implode('|', $stand) . '|' . $m['quelle']) . '.ok';
    if (is_file($cache)) {
        $ok = @file_get_contents($cache) === '1';
    } else {
        $h = hash_init('sha1');
        foreach ($quellen as $f) {
            hash_update_file($h, $f);
        }
        $ok = hash_final($h) === $m['quelle'];
        @file_put_contents($cache, $ok ? '1' : '0');
        if (!$ok) {
            error_log('Amberwave: js/_b passt nicht zu js/*.js (nach einer Änderung der Oberfläche nicht neu gebündelt) – die App läuft mit den einzelnen Modulen, der erste Start dauert länger. Abhilfe: bash app/scripts/buendeln.sh');
        }
    }
    foreach ($m['start'] as $f) {
        if (!is_file($dir . '/' . $f)) {
            $ok = false;
        }
    }
    return $b = ($ok ? $m : null);
}

/** Einstiegsmodul der App: das Bündel, wenn es passt, sonst js/app.js */
function app_modul_url(): string
{
    return asset_url(buendel() ? '/js/_b/' . buendel()['einstieg'] : '/js/app.js');
}

/**
 * Alle JS-Module, die beim Start (statisch ab app.js) geladen werden: für <link rel="modulepreload">, damit der Browser sie
 * parallel holt statt Ebene für Ebene (jede Ebene kostet im Mobilnetz eine volle Laufzeit).
 * @return string[] Adressen wie in der Import-Map (mit ?v=)
 */
function module_vorladen(): array
{
    if ($b = buendel()) {
        return array_map(static fn($f) => asset_url('/js/_b/' . $f), $b['start']);
    }
    $karte = json_decode(import_map_json(), true)['imports'] ?? [];
    $cache = sys_get_temp_dir() . '/aw_modvor_' . md5(json_encode($karte)) . '.json';
    if (is_file($cache)) {
        $c = json_decode((string) @file_get_contents($cache), true);
        if (is_array($c)) {
            return $c;
        }
    }
    $gesehen = [];
    $stapel = ['/js/app.js'];
    while ($stapel) {
        $m = array_pop($stapel);
        if (isset($gesehen[$m]) || !isset($karte[$m])) {
            continue;
        }
        $gesehen[$m] = true;
        $code = (string) @file_get_contents(dirname(__DIR__) . $m);
        if (preg_match_all('~^\s*(?:import|export)\b[^;\'"]*?(?:from\s*)?[\'"](?:\./|/js/)([A-Za-z0-9_.\-]+\.js)[\'"]~m', $code, $tr)) {
            foreach ($tr[1] as $n) {
                $stapel[] = '/js/' . $n;
            }
        }
    }
    $liste = array_values(array_map(static fn($m) => $karte[$m], array_keys($gesehen)));
    @file_put_contents($cache, json_encode($liste));
    return $liste;
}

/**
 * Absoluter Link für E-Mails: APP_URL (bzw. Tunnel-Adresse), sonst die Adresse, unter der sich zuletzt ein Admin angemeldet
 * hat. Die Host-Kopfzeile der Anfrage zählt nur, wenn sie eine bloße IP-Adresse ist – sonst könnte ein Angreifer mit
 * „Host: boese.example“ einen Passwort-Link auf seinen eigenen Server schicken lassen.
 */
function app_link(string $pfad): string
{
    $basis = konfig()['app_url'] ?: app_url_gelernt();
    if ($basis === '') {
        $host = preg_replace('/[^A-Za-z0-9.:\-\[\]]/', '', (string) ($_SERVER['HTTP_HOST'] ?? 'localhost'));
        $nurHost = preg_replace('/:\d+$/', '', trim($host, '[]'));
        if (filter_var(trim($nurHost, '[]'), FILTER_VALIDATE_IP) === false && $nurHost !== 'localhost') {
            $host = (string) ($_SERVER['SERVER_ADDR'] ?? 'localhost');
        }
        $basis = (ist_https() ? 'https://' : 'http://') . $host;
    }
    return $basis . $pfad;
}

function app_url_gelernt_datei(): string
{
    return rtrim((string) konfig()['pfade']['cache'], '/') . '/app_url_gelernt.txt';
}

function app_url_gelernt(): string
{
    return rtrim(trim((string) @file_get_contents(app_url_gelernt_datei())), '/');
}

/** Bei der Anmeldung eines Admins: Adresse merken, unter der er die App benutzt (für Links in E-Mails ohne APP_URL) */
function app_url_lernen(): void
{
    if (konfig()['app_url'] !== '' || PHP_SAPI === 'cli') {
        return;
    }
    $host = preg_replace('/[^A-Za-z0-9.:\-\[\]]/', '', (string) ($_SERVER['HTTP_HOST'] ?? ''));
    if ($host === '') {
        return;
    }
    $url = (ist_https() ? 'https://' : 'http://') . $host;
    if ($url !== app_url_gelernt()) {
        @file_put_contents(app_url_gelernt_datei(), $url);
    }
}

/** Läuft die Verbindung über HTTPS – auch hinter Cloudflare Tunnel, das intern per HTTP weiterreicht? */
function ist_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        return true;
    }
    if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') {
        return true;
    }
    if (!empty($_SERVER['HTTP_CF_VISITOR'])) {
        $d = json_decode((string) $_SERVER['HTTP_CF_VISITOR'], true);
        if (($d['scheme'] ?? '') === 'https') {
            return true;
        }
    }
    return false;
}

/** Ausdrücklich bekannte Proxys: PROXY_IPS, sonst der in der Oberfläche eingetragene (vorhandenes cloudflared außerhalb des Stacks) */
function vertraute_proxys(): array
{
    $s = konfig()['sicherheit'];
    if ($s['proxy_ips']) {
        return $s['proxy_ips'];
    }
    static $gelernt = null;
    if ($gelernt === null) {
        try {
            require_once __DIR__ . '/einstellungen.php';
            $gelernt = array_values(array_filter(array_map('trim', explode(',', einstellung('tunnel_proxy_ip')))));
        } catch (Throwable $e) {
            $gelernt = [];
        }
    }
    return $gelernt;
}

/** Ist diese Adresse ein ausdrücklich bekannter Proxy (Liste oder der cloudflared-Container im eigenen Stack)? */
function ist_bekannter_proxy(string $ip): bool
{
    if ($ip === '') {
        return false;
    }
    if (tunnel_container_ip() !== '' && tunnel_container_ip() === $ip) {
        return true;
    }
    foreach (vertraute_proxys() as $eintrag) {
        if ($eintrag === $ip || (str_contains($eintrag, '/') && ip_in_netz($ip, $eintrag))) {
            return true;
        }
    }
    return false;
}

/**
 * Besucher-IP. Proxy-Kopfzeilen gelten nur von einem Proxy, dem wir trauen:
 *  – CF-Connecting-IP nur vom cloudflared-Container, von PROXY_IPS bzw. dem eingetragenen Proxy (oder PROXY_VERTRAUEN=ja);
 *  – X-Forwarded-For wird von rechts gelesen: der letzte Eintrag hat der Proxy selbst angehängt, alles links davon kann der
 *    Besucher mitgeschickt haben. Bekannte Proxys in der Kette werden übersprungen.
 *  – „auto“ ohne bekannte Proxys (eine private Absenderadresse, z. B. ein Reverse Proxy im Docker-Netz): nur eine öffentliche
 *    Adresse zählt – so kann sich niemand per Kopfzeile als „zuhause“ ausgeben.
 */
function client_ip(): string
{
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
    $s = konfig()['sicherheit'];
    $modus = $s['proxy_vertrauen'];
    if ($modus === 'nein') {
        return $remote;
    }
    $bekannt = ist_bekannter_proxy($remote);
    $privat = filter_var($remote, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
    $hatListe = (bool) vertraute_proxys();
    // auto: bekannter Proxy – oder, solange keine Liste gepflegt ist, irgendeine private Absenderadresse (mit Einschränkung)
    $vertraut = $modus === 'ja' || $bekannt || (!$hatListe && $privat);
    if (!$vertraut) {
        return $remote;
    }
    // „auto“ ohne Liste: eine private Absenderadresse mit weitergeleiteter Adresse merken (der Admin bestätigt oder lehnt ab,
    // siehe Übersicht) – abgelehnt heißt: nur der Absender selbst zählt
    if ($modus === 'auto' && !$bekannt && (($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '') !== '' || ($_SERVER['HTTP_CF_CONNECTING_IP'] ?? '') !== '')) {
        proxy_beobachten($remote);
        if (proxy_entscheidung() === 'nein') {
            return $remote;
        }
    }
    $nurOeffentlich = $modus === 'auto' && !$bekannt;
    $gueltig = static fn(string $k) => filter_var($k, FILTER_VALIDATE_IP, $nurOeffentlich ? FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE : 0) !== false;
    // Cloudflare: nur, wenn die Anfrage wirklich von einem bekannten Proxy kommt
    $cf = trim((string) ($_SERVER['HTTP_CF_CONNECTING_IP'] ?? ''));
    if ($cf !== '' && ($bekannt || $modus === 'ja') && $gueltig($cf)) {
        return $cf;
    }
    $xff = (string) ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? '');
    if ($xff !== '') {
        foreach (array_reverse(array_map('trim', explode(',', $xff))) as $k) {
            if (filter_var($k, FILTER_VALIDATE_IP) === false) {
                break;
            }
            if (ist_bekannter_proxy($k)) {
                continue;   // weiterer Proxy in der Kette
            }
            return $gueltig($k) ? $k : $remote;
        }
    }
    return $remote;
}

/** Entscheidung des Admins zum Reverse Proxy ('' offen, 'nein' nicht vertrauen) – je Anfrage einmal gelesen */
function proxy_entscheidung(): string
{
    static $e = null;
    if ($e === null) {
        try {
            require_once __DIR__ . '/einstellungen.php';
            $e = einstellung('proxy_entscheidung');
        } catch (Throwable $x) {
            $e = '';
        }
    }
    return $e;
}

/** Datei mit der zuletzt gesehenen privaten Absenderadresse, die eine weitergeleitete Adresse mitschickt */
function proxy_beobachtung_datei(): string
{
    return rtrim((string) konfig()['pfade']['cache'], '/') . '/tmp/proxy-beobachtung.json';
}

/** höchstens einmal pro Minute festhalten (eine Datei, kein Datenbankzugriff) */
function proxy_beobachten(string $ip): void
{
    static $erledigt = false;
    if ($erledigt) {
        return;
    }
    $erledigt = true;
    $d = proxy_beobachtung_datei();
    $alt = is_file($d) ? (json_decode((string) @file_get_contents($d), true) ?: []) : [];
    if (($alt['ip'] ?? '') === $ip && time() - (int) ($alt['zeit'] ?? 0) < 60) {
        return;
    }
    @mkdir(dirname($d), 0775, true);
    @file_put_contents($d, json_encode(['ip' => $ip, 'zeit' => time(), 'cf' => ($_SERVER['HTTP_CF_CONNECTING_IP'] ?? '') !== '']), LOCK_EX);
}

/** Standard-Gateway des Containers (die Docker-Brücke): über sie kommen Dockers eigene Portweiterleitung und Proxys im Host-Netz */
function docker_gateway_ip(): string
{
    foreach (@file('/proc/net/route') ?: [] as $z) {
        $f = preg_split('/\s+/', trim($z));
        if (($f[1] ?? '') === '00000000' && isset($f[2]) && strlen($f[2]) === 8) {
            return implode('.', array_reverse(array_map('hexdec', str_split($f[2], 2))));
        }
    }
    return '';
}

/** IP des cloudflared-Containers im Docker-Netz (Dienst „tunnel“, TUNNEL_CONTAINER) – eine Minute gemerkt; '' = keiner */
function tunnel_container_ip(): string
{
    static $ip = null, $zeit = 0;
    if ($ip !== null && time() - $zeit < 60) {
        return $ip;
    }
    $zeit = time();
    $name = (string) (konfig()['tunnel']['container'] ?? '');
    if ($name === '') {
        return $ip = '';
    }
    $r = gethostbyname($name);
    return $ip = ($r !== $name && filter_var($r, FILTER_VALIDATE_IP) ? $r : '');
}

function ip_in_netz(string $ip, string $cidr): bool
{
    [$netz, $bits] = explode('/', $cidr) + [1 => '32'];
    $a = @inet_pton($ip);
    $n = @inet_pton($netz);
    $bits = (int) $bits;
    if ($a === false || $n === false || strlen($a) !== strlen($n) || $bits < 0 || $bits > strlen($a) * 8) {
        return false;
    }
    $voll = intdiv($bits, 8);
    $rest = $bits % 8;
    return substr($a, 0, $voll) === substr($n, 0, $voll)
        && ($rest === 0 || ((ord($a[$voll]) ^ ord($n[$voll])) >> (8 - $rest)) === 0);
}

/**
 * Datumseingabe (TT.MM.JJJJ, T.M.JJJJ, MM.JJJJ, JJJJ oder ISO JJJJ-MM-TT/JJJJ-MM) in die gespeicherte Form JJJJ[-MM[-TT]].
 * Leer -> ''. Ungültig -> null.
 */
function datum_eingabe(string $s): ?string
{
    $s = trim($s);
    if ($s === '') {
        return '';
    }
    if (preg_match('/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/', $s, $m)) {
        return checkdate((int) $m[2], (int) $m[1], (int) $m[3]) ? sprintf('%04d-%02d-%02d', $m[3], $m[2], $m[1]) : null;
    }
    if (preg_match('/^(\d{1,2})\.(\d{4})$/', $s, $m)) {
        return (int) $m[1] >= 1 && (int) $m[1] <= 12 ? sprintf('%04d-%02d', $m[2], $m[1]) : null;
    }
    if (preg_match('/^\d{4}(-\d{2}(-\d{2})?)?$/', $s)) {
        return $s;
    }
    return null;
}

/** Datumsformat nach Sprache: TT.MM.JJJJ bzw. 25 Oct 2026 */
function formatiere_datum(?string $datum): string
{
    if (!$datum) {
        return '–';
    }
    $ts = strtotime($datum);
    return region_datum($datum);
}

function formatiere_datum_uhrzeit(?string $datum): string
{
    if (!$datum) {
        return '–';
    }
    $ts = strtotime($datum);
    return region_datum($datum, true);
}

/**
 * Normalform für Namensvergleiche: klein, ohne Akzente/Satzzeichen, "The " am Anfang weg,
 * "&" = "and"/"und". Nur für den Abgleich, nie für die Anzeige.
 */
function name_norm(string $s): string
{
    $s = mb_strtolower(trim($s), 'UTF-8');
    if (class_exists('Normalizer')) {
        $s = (string) Normalizer::normalize($s, Normalizer::FORM_D);
        $s = (string) preg_replace('/\p{Mn}+/u', '', $s);
    }
    $s = str_replace(['ß', 'æ', 'œ', 'ø'], ['ss', 'ae', 'oe', 'o'], $s);
    $s = (string) preg_replace('/\s+(&|and|und|\+)\s+/u', ' and ', $s);
    $s = (string) preg_replace('/^(the|die|der|das)\s+/u', '', $s);
    $s = (string) preg_replace('/[^\p{L}\p{N}]+/u', ' ', $s);
    return mb_substr(trim($s), 0, 250, 'UTF-8');
}

/** Suchtext: alle Bestandteile normalisiert hintereinander. */
function such_norm(string ...$teile): string
{
    return mb_substr(implode(' ', array_filter(array_map('name_norm', $teile), 'strlen')), 0, 1500, 'UTF-8');
}

/** Sortiername aus einem Namen: "The Beatles" -> "Beatles, The" */
/**
 * Sortiername = Anzeigename („Michael Jackson“ steht unter M). Nur ein Artikel am Anfang zählt nicht mit
 * („The Beatles“ unter B), abschaltbar mit SORTIERUNG_OHNE_ARTIKEL=0.
 */
function sortname_aus(string $name): string
{
    $name = trim($name);
    $ohne_artikel = !function_exists('konfig') || (konfig()['sortierung_ohne_artikel'] ?? true);
    if ($ohne_artikel && preg_match('/^(The|Die|Der|Das|Les|La|Le|Los|El)\s+(.+)$/u', $name, $m)) {
        return $m[2] . ', ' . $m[1];
    }
    return $name;
}

/**
 * „Nachname, Vorname“ (Sortierform aus manchen Tags) in „Vorname Nachname“ umdrehen.
 * „Beatles, The“ → „The Beatles“. Bandnamen mit Komma bleiben: „Earth, Wind & Fire“, „Crosby, Stills & Nash“,
 * „Tyler, The Creator“, „Peter, Paul and Mary“. Liefert null, wenn nichts umzudrehen ist.
 */
function name_umgedreht(string $name): ?string
{
    $name = trim($name);
    if (substr_count($name, ',') !== 1 || preg_match('/[&+\/;\d]|\b(and|und|feat\.?|ft\.?|with|vs\.?|x)\b/iu', $name)) {
        return null;
    }
    [$nach, $vor] = array_map('trim', explode(',', $name));
    if ($nach === '' || $vor === '') {
        return null;
    }
    $w_nach = preg_split('/\s+/u', $nach);
    $w_vor = preg_split('/\s+/u', $vor);
    if (count($w_nach) > 3 || count($w_vor) > 4) {
        return null;
    }
    // Artikel hinten („Beatles, The“) nur als einzelnes Wort; „Tyler, The Creator“ bleibt
    if (preg_match('/^(the|die|der|das|les|la|le|los|el)$/iu', $w_vor[0]) && count($w_vor) > 1) {
        return null;
    }
    return $vor . ' ' . $nach;
}

/** Anzeigename: umgedreht, falls es eine „Nachname, Vorname“-Form ist. */
function name_anzeige(string $name): string
{
    return name_umgedreht($name) ?? trim($name);
}

/** Sicherer Dateiname-Teil (für Cache-Dateien). */
function datei_sicher(string $s): string
{
    return (string) preg_replace('/[^A-Za-z0-9._-]/', '_', $s);
}

function ist_uuid(?string $s): bool
{
    return is_string($s) && (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', trim($s));
}

/**
 * Text fürs Protokoll entschärfen: Schlüssel, Token und Passwörter in Adressen und Kopfzeilen werden durch *** ersetzt
 * (Logs posten Tester gern in Fehlerberichte).
 */
function log_sauber(string $text): string
{
    $text = (string) preg_replace('#(://[^/\s:@]+:)[^@\s/]+@#', '$1***@', $text);
    $text = (string) preg_replace('/((?<![A-Za-z0-9_])(?:api_?key|apikey|token|st|key|passwor[dt]|secret|code)=)[^&\s"\']+/i', '$1***', $text);
    $text = (string) preg_replace('/((?:X-Api-Key|Authorization|X-Amberwave-Direkt)\s*:\s*)(?:Bearer\s+)?\S+/i', '$1***', $text);
    return (string) preg_replace('/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/', 'Bearer ***', $text);
}
