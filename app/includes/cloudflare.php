<?php
// Cloudflare-API (nur DNS): Token prüfen, Zone zu einem Namen finden, DNS-Einträge setzen und löschen.
// Das Token braucht nur das Recht „Zone → DNS → Bearbeiten“ für die eine Zone (Cloudflare-Vorlage „Zone-DNS bearbeiten“).
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/dienste.php';

final class CfFehler extends RuntimeException
{
}

function cf_anfrage(string $token, string $methode, string $pfad, ?array $daten = null): array
{
    $url = konfig()['direkt']['cloudflare_url'] . $pfad;
    $ch = curl_init($url);
    $kopf = ['Authorization: Bearer ' . $token, 'Accept: application/json'];
    if ($daten !== null) {
        $kopf[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($daten, JSON_UNESCAPED_SLASHES));
    }
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $methode,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $kopf,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_USERAGENT => amberwave_user_agent(),
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    ]);
    $ca = konfig()['direkt']['ca_datei'];
    if ($ca !== '') {
        curl_setopt($ch, CURLOPT_CAINFO, $ca);
    }
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $fehler = curl_error($ch);
    curl_close($ch);
    dienst_zaehlen($url, $body === false ? 0 : $status);
    if ($body === false) {
        throw new CfFehler(t('Cloudflare nicht erreichbar: ') . $fehler);
    }
    $j = json_decode((string) $body, true);
    if (!is_array($j)) {
        throw new CfFehler(t('Cloudflare antwortet unerwartet (HTTP {status}).', ['status' => $status]));
    }
    if (empty($j['success'])) {
        $texte = array_map(static fn($e) => trim(($e['code'] ?? '') . ' ' . ($e['message'] ?? '')), $j['errors'] ?? []);
        $text = $texte ? implode('; ', $texte) : "HTTP {$status}";
        if ($status === 401 || $status === 403) {
            $text = t('Das Token wird abgelehnt oder hat nicht die nötigen Rechte ({text}).', ['text' => $text]);
        }
        throw new CfFehler($text);
    }
    return $j;
}

/** Ist das Token gültig und aktiv? */
function cf_token_pruefen(string $token): array
{
    $j = cf_anfrage($token, 'GET', '/user/tokens/verify');
    if (($j['result']['status'] ?? '') !== 'active') {
        throw new CfFehler(t('Das Token ist nicht aktiv (Status: {status}).', ['status' => $j['result']['status'] ?? '?']));
    }
    return $j['result'];
}

/** Zonen, auf die das Token Zugriff hat */
function cf_zonen(string $token): array
{
    $j = cf_anfrage($token, 'GET', '/zones?per_page=50');
    return array_map(static fn($z) => ['id' => (string) $z['id'], 'name' => (string) $z['name']], $j['result'] ?? []);
}

/** Zone, zu der ein Name gehört (längster passender Zonenname) */
function cf_zone_fuer(string $token, string $name): array
{
    $name = strtolower(rtrim($name, '.'));
    $beste = null;
    foreach (cf_zonen($token) as $z) {
        $zn = strtolower($z['name']);
        if (($name === $zn || str_ends_with($name, '.' . $zn)) && (!$beste || strlen($zn) > strlen($beste['name']))) {
            $beste = $z;
        }
    }
    if (!$beste) {
        throw new CfFehler(t('Für „{name}“ hat das Token keinen Zugriff auf eine passende Zone. Liegt die Domain bei Cloudflare, und ist das Token für diese Zone freigegeben?', ['name' => $name]));
    }
    return $beste;
}

/** DNS-Eintrag anlegen oder (falls es ihn schon gibt) aktualisieren. Gibt die ID zurück. */
function cf_eintrag_setzen(string $token, string $zone, string $typ, string $name, string $inhalt, int $ttl = 60, bool $proxied = false): string
{
    $q = http_build_query(['type' => $typ, 'name' => $name]);
    $da = cf_anfrage($token, 'GET', "/zones/{$zone}/dns_records?{$q}")['result'] ?? [];
    $daten = ['type' => $typ, 'name' => $name, 'content' => $inhalt, 'ttl' => $ttl];
    if ($typ === 'A' || $typ === 'AAAA') {
        $daten['proxied'] = false; // nur DNS – eine private Adresse darf nicht über Cloudflare laufen
    } elseif ($typ === 'CNAME') {
        $daten['proxied'] = $proxied; // Tunnel: über Cloudflare
    }
    if ($typ !== 'TXT' && $da) {
        $id = (string) $da[0]['id'];
        cf_anfrage($token, 'PUT', "/zones/{$zone}/dns_records/{$id}", $daten);
        return $id;
    }
    return (string) (cf_anfrage($token, 'POST', "/zones/{$zone}/dns_records", $daten)['result']['id'] ?? '');
}

function cf_eintrag_loeschen(string $token, string $zone, string $id): void
{
    if ($id !== '') {
        cf_anfrage($token, 'DELETE', "/zones/{$zone}/dns_records/{$id}");
    }
}
