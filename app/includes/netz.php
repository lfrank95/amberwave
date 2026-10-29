<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/dienste.php';

/**
 * Ist das Gerät gerade im Heimnetz?
 * 1. Direkter Zugriff aus dem LAN (http://server:9950): private Adresse (LOKALE_NETZE).
 * 2. Zugriff über den Cloudflare Tunnel von zuhause: dann kommt die Anfrage mit der eigenen öffentlichen
 *    Internet-Adresse (HEIM_IP oder automatisch ermittelt). Bei IPv6 zählt das gleiche /64-Netz.
 */
function heim_ips(): array
{
    $k = konfig()['netz'];
    if ($k['heim_ip']) {
        return $k['heim_ip'];
    }
    if (!$k['heim_ip_erkennen']) {
        return [];
    }
    $datei = konfig()['pfade']['cache'] . '/tmp/heim_ip.json';
    $d = is_file($datei) ? json_decode((string) @file_get_contents($datei), true) : null;
    if (is_array($d) && ($d['zeit'] ?? 0) > time() - 900) {
        return $d['ips'] ?? [];
    }
    $ips = [];
    foreach ($k['erkennen_urls'] as $url) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 2, CURLOPT_TIMEOUT => 3, CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_USERAGENT => amberwave_user_agent()]);
        $roh = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        dienst_zaehlen($url, $roh === false ? 0 : $status);
        $body = (string) $roh;
        // Cloudflare-Trace („ip=…“) oder reine Adresse
        if (preg_match('/^ip=(.+)$/m', $body, $m)) {
            $body = $m[1];
        }
        $ip = trim($body);
        if (filter_var($ip, FILTER_VALIDATE_IP)) {
            $ips[] = $ip;
        }
    }
    $ips = array_values(array_unique($ips));
    if (!is_dir(dirname($datei))) {
        @mkdir(dirname($datei), 0775, true);
    }
    // Fehlschlag kürzer merken (nach 2 Minuten neu versuchen)
    @file_put_contents($datei, json_encode(['zeit' => $ips ? time() : time() - 780, 'ips' => $ips]));
    return $ips;
}

function netz_info(): array
{
    $ip = client_ip();
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    // Anfrage vom Tunnel selbst, aber ohne echte Besucher-Adresse: nicht als „zuhause“ werten
    if ($ip === $remote && in_array($remote, konfig()['sicherheit']['proxy_ips'], true)) {
        return ['lokal' => false, 'grund' => 'unbekannt'];
    }
    foreach (konfig()['netz']['lokale_netze'] as $netz) {
        if (ip_in_netz($ip, str_contains($netz, '/') ? $netz : $netz . (str_contains($netz, ':') ? '/128' : '/32'))) {
            return ['lokal' => true, 'grund' => 'lan'];
        }
    }
    foreach (heim_ips() as $heim) {
        if ($heim === $ip || (str_contains($heim, ':') && str_contains($ip, ':') && ip_in_netz($ip, $heim . '/64'))) {
            return ['lokal' => true, 'grund' => 'heim_ip'];
        }
    }
    return ['lokal' => false, 'grund' => 'extern'];
}
