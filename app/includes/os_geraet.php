<?php
declare(strict_types=1);
// Amberwave OS: Einstellungen des Geräts (Name im Netz, Netzwerk, Musikquelle, Updates, SSH, Strom) – die App selbst
// läuft im Container und spricht dafür mit dem Gerätedienst auf dem Gerät (os/…/geraet.py, nur 127.0.0.1).
// Den Schlüssel legt der Gerätedienst in /appdata ab. Außerhalb von Amberwave OS gibt es diesen Bereich nicht.
require_once __DIR__ . '/api.php';

function os_geraet_aktiv(): bool
{
    return getenv('AMBERWAVE_OS') === '1';
}

function os_geraet_url(): string
{
    return rtrim((string) (getenv('AMBERWAVE_GERAET_URL') ?: 'http://127.0.0.1:7699'), '/');
}

function os_geraet_schluessel(): string
{
    return trim((string) @file_get_contents((string) (getenv('AMBERWAVE_GERAET_SCHLUESSEL') ?: '/appdata/geraet.schluessel')));
}

/** Kanal des Geräts (latest | beta), wie ihn der Gerätedienst ablegt – null außerhalb von Amberwave OS */
function os_geraet_kanal(): ?string
{
    if (!os_geraet_aktiv()) {
        return null;
    }
    $k = trim((string) @file_get_contents((string) (getenv('AMBERWAVE_GERAET_KANAL') ?: '/appdata/geraet-kanal')));
    return in_array($k, ['latest', 'beta'], true) ? $k : null;
}

/** Anfrage an den Gerätedienst; JSON-Antwort als Array (bzw. Text bei $text) */
function os_geraet_anfrage(string $methode, string $pfad, ?array $daten = null, bool $text = false, int $zeit = 30): array|string
{
    if (!os_geraet_aktiv()) {
        throw new ApiFehler(t('Nur bei Amberwave OS.'), 404);
    }
    $ch = curl_init(os_geraet_url() . $pfad);
    $kopf = ['X-Amberwave-Geraet: ' . os_geraet_schluessel()];
    if ($methode === 'POST') {
        $kopf[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($daten ?? new stdClass(), JSON_UNESCAPED_UNICODE));
    }
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $zeit, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_HTTPHEADER => $kopf,
        CURLOPT_CUSTOMREQUEST => $methode]);
    $roh = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($roh === false || $status === 0) {
        throw new ApiFehler(t('Der Gerätedienst antwortet nicht. Hilft ein Neustart des Geräts?'), 503);
    }
    if ($status === 403) {
        throw new ApiFehler(t('Der Gerätedienst hat die Anfrage abgelehnt (Schlüssel passt nicht).'), 503);
    }
    if ($text) {
        return (string) $roh;
    }
    $d = json_decode((string) $roh, true);
    if (!is_array($d)) {
        throw new ApiFehler(t('Unerwartete Antwort vom Gerätedienst.'), 502);
    }
    if ($status >= 500) {
        throw new ApiFehler(t('Fehler im Gerätedienst: {meldung}', ['meldung' => (string) ($d['meldung'] ?? '')]), 500);
    }
    return $d;
}

/** GET /admin/geraet */
function api_admin_os_geraet(): array
{
    require_once __DIR__ . '/updatecheck.php';
    $i = os_geraet_anfrage('GET', '/info');
    $i['app_version'] = app_version();
    $i['update'] = update_hinweis(false);
    return $i;
}

/** POST /admin/geraet/{aktion} */
function api_admin_os_geraet_aktion(array $admin, string $aktion): array
{
    $erlaubt = ['name' => ['name'], 'netz' => ['art', 'adresse', 'praefix', 'router', 'dns'], 'netz-bestaetigen' => [],
        'musik' => ['art', 'uuid', 'nur_lesen', 'pfad', 'benutzer', 'passwort'], 'musik-pruefen' => ['pfad', 'benutzer', 'passwort'],
        'kanal' => ['kanal'], 'sicherheitsupdates' => ['an'], 'ssh' => ['an', 'schluessel'], 'strom' => ['aktion']];
    if (!isset($erlaubt[$aktion])) {
        throw new ApiFehler(t('Unbekannte Aktion.'), 404);
    }
    $daten = [];
    foreach ($erlaubt[$aktion] as $k) {
        if (array_key_exists($k, api_eingabe())) {
            $daten[$k] = api_wert($k);
        }
    }
    if ($aktion === 'ssh' && !empty($daten['an'])) {
        // Zugang zum Gerät selbst: nur mit dem Passwort des Admins (eine offene Sitzung allein reicht nicht)
        require_once __DIR__ . '/einrichtung.php';
        datenbank_admin_bestaetigen($admin);
    }
    $r = os_geraet_anfrage('POST', '/' . str_replace('-', '/', $aktion), $daten, false, $aktion === 'musik' ? 170 : 30);
    if (!empty($r['ok']) && in_array($aktion, ['name', 'netz', 'musik', 'kanal', 'sicherheitsupdates', 'ssh', 'strom'], true)) {
        $was = match ($aktion) {
            'name' => (string) ($r['name'] ?? ''),
            'netz' => (string) ($daten['art'] ?? '') . ' ' . (string) ($daten['adresse'] ?? ''),
            'musik' => (string) ($daten['art'] ?? '') . ' ' . (string) ($daten['pfad'] ?? ''),
            'kanal' => (string) ($daten['kanal'] ?? ''),
            'strom' => (string) ($daten['aktion'] ?? ''),
            default => !empty($daten['an']) ? 'an' : 'aus',
        };
        log_sicherheitsereignis((int) $admin['id'], 'geraet_' . $aktion, trim($was));
    }
    if (!empty($r['ok']) && $aktion === 'kanal') {
        @unlink(rtrim((string) konfig()['pfade']['cache'], '/') . '/update_stand.json');
    }
    return $r;
}

/** GET /admin/geraet/protokoll – Datei für die Fehlersuche */
function api_admin_os_geraet_protokoll(): void
{
    $text = (string) os_geraet_anfrage('GET', '/protokoll', null, true, 40);
    header('Content-Type: text/plain; charset=utf-8');
    header('Content-Disposition: attachment; filename="amberwave-os-protokoll-' . date('Y-m-d-His') . '.txt"');
    header('Cache-Control: no-store');
    echo $text;
    exit;
}
