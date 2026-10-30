<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/crypto.php';

/**
 * Einstellungen aus der Oberfläche (Tabelle einstellungen; Geheimes verschlüsselt).
 * Reihenfolge: Oberfläche (DB) → .env → Standardwert.
 * 'geheim' = wird NIE an den Browser ausgeliefert.
 */
const EINSTELLUNGEN = [
    'smtp_host'             => ['env' => 'SMTP_HOST',             'standard' => '',          'geheim' => false],
    'smtp_port'             => ['env' => 'SMTP_PORT',             'standard' => '587',       'geheim' => false],
    'smtp_verschluesselung' => ['env' => 'SMTP_VERSCHLUESSELUNG', 'standard' => 'tls',       'geheim' => false],
    'smtp_benutzer'         => ['env' => 'SMTP_BENUTZER',         'standard' => '',          'geheim' => false],
    'smtp_passwort'         => ['env' => 'SMTP_PASSWORT',         'standard' => '',          'geheim' => true],
    'smtp_absender'         => ['env' => 'SMTP_ABSENDER',         'standard' => '',          'geheim' => false],
    'smtp_absender_name'    => ['env' => 'SMTP_ABSENDER_NAME',    'standard' => 'Amberwave', 'geheim' => false],
    'smtp_tls_pruefen'      => ['env' => 'SMTP_TLS_PRUEFEN',      'standard' => '1',         'geheim' => false],
    'mail_ablauf_tage'      => ['env' => 'MAIL_ABLAUF_TAGE',      'standard' => '30',        'geheim' => false],
    'musicbrainz_user_agent'=> ['env' => 'MUSICBRAINZ_USER_AGENT','standard' => '',          'geheim' => false],
    'installation_id'       => ['env' => 'AMBERWAVE_INSTALLATION_ID','standard' => '',       'geheim' => false],
    'fanart_api_key'        => ['env' => 'FANART_API_KEY',        'standard' => '',          'geheim' => true],
    'claude_api_key'        => ['env' => 'CLAUDE_API_KEY',        'standard' => '',          'geheim' => true],
    'acoustid_api_key'      => ['env' => 'ACOUSTID_API_KEY',      'standard' => '',          'geheim' => true],
    'lidarr_url'            => ['env' => 'LIDARR_URL',            'standard' => '',          'geheim' => false],
    'lidarr_api_key'        => ['env' => 'LIDARR_API_KEY',        'standard' => '',          'geheim' => true],
    // Downloads: Prowlarr sucht, SABnzbd lädt, Amberwave kopiert das Fertige in den Musikordner und liest es ein
    'prowlarr_url'          => ['env' => 'PROWLARR_URL',          'standard' => '',          'geheim' => false],
    'prowlarr_api_key'      => ['env' => 'PROWLARR_API_KEY',      'standard' => '',          'geheim' => true],
    'prowlarr_kategorien'   => ['env' => 'PROWLARR_KATEGORIEN',   'standard' => '3000',      'geheim' => false],
    'sabnzbd_url'           => ['env' => 'SABNZBD_URL',           'standard' => '',          'geheim' => false],
    'sabnzbd_api_key'       => ['env' => 'SABNZBD_API_KEY',       'standard' => '',          'geheim' => true],
    'sabnzbd_kategorie'     => ['env' => 'SABNZBD_KATEGORIE',     'standard' => 'music',     'geheim' => false],
    // Standard-SABnzbd: API-Pfad (/api; hinter einem Proxy z. B. /sabnzbd/api, SABnzbd-kompatible Dienste z. B. /api/sabnzbd)
    // und Unterordner im Download-Ordner, in dem seine fertigen Downloads liegen (leer = DOWNLOAD_PFAD selbst)
    'sabnzbd_api_pfad'      => ['env' => 'SABNZBD_API_PFAD',      'standard' => '/api',      'geheim' => false],
    'sabnzbd_import_ordner' => ['env' => 'SABNZBD_IMPORT_ORDNER', 'standard' => '',          'geheim' => false],
    'sabnzbd_name'          => ['env' => '',                      'standard' => 'SABnzbd',   'geheim' => false],
    'prowlarr_name'         => ['env' => '',                      'standard' => 'Prowlarr',  'geheim' => false],
    'prowlarr_client'       => ['env' => '',                      'standard' => '0',         'geheim' => false],   // an welchen Downloadclient Prowlarr-Treffer gehen (0 = Standard)
    'prowlarr_aktiv'        => ['env' => '',                      'standard' => '1',         'geheim' => false],
    'download_ziel'         => ['env' => 'DOWNLOAD_ZIEL',         'standard' => 'Downloads', 'geheim' => false],
    'download_nach_import'  => ['env' => 'DOWNLOAD_NACH_IMPORT',  'standard' => 'loeschen',  'geheim' => false],
    'download_einsortieren' => ['env' => 'DOWNLOAD_EINSORTIEREN', 'standard' => '1',         'geheim' => false],
    'download_wav_flac'     => ['env' => 'DOWNLOAD_WAV_ZU_FLAC',  'standard' => '1',         'geheim' => false],
    // Wächter: so viele Minuten ohne Bewegung in SABnzbd → gescheitert (bzw. bei 100 % Dateien prüfen); verschwunden → gescheitert
    'download_haengt_min'   => ['env' => 'DOWNLOAD_HAENGT_MIN',   'standard' => '30',        'geheim' => false],
    'download_weg_min'      => ['env' => 'DOWNLOAD_WEG_MIN',      'standard' => '15',        'geheim' => false],
    // Downloads als eigener Punkt im Hauptmenü (für Admins)
    'download_reiter'       => ['env' => 'DOWNLOAD_REITER',       'standard' => '0',         'geheim' => false],
    // Usenet-Downloads (Suche, Holen, Import) überhaupt verwenden – neu eingerichtet aus, bestehende Installationen mit Einrichtung an (Migration 045)
    'usenet_aktiv'          => ['env' => 'USENET_AKTIV',          'standard' => '0',         'geheim' => false],
    // Darf Amberwave im Musikordner schreiben (Tags, Aufräumen, Download-Import, Papierkorb)? Neu eingerichtet: nur lesen
    'musik_schreiben'       => ['env' => 'MUSIK_SCHREIBEN',       'standard' => '0',         'geheim' => false],
    // Hinweis „neue Version verfügbar“ (fragt die Releases auf GitHub ab, installiert nichts)
    'update_hinweis'        => ['env' => 'UPDATE_HINWEIS',        'standard' => '1',         'geheim' => false],
    'scan_auto_stunden'     => ['env' => 'SCAN_AUTO_STUNDEN',     'standard' => '0',         'geheim' => false],
    'kuenstler_standardnamen'=> ['env' => 'KUENSTLER_STANDARDNAMEN','standard' => '0',        'geheim' => false],
    // Automatik nach dem Einlesen und nachts (Reihenfolge: Erkennung → Metadaten → Aufräum-Vorschau)
    // Erkennung: 'anhalt' = Tags zuerst, AcoustID nur ohne Anhaltspunkt (Standard) | 'gruendlich' = AcoustID auch, wenn die Tags nicht reichen
    'erkennung_modus'       => ['env' => 'ERKENNUNG_MODUS',       'standard' => 'anhalt',    'geheim' => false],
    'auto_metadaten'        => ['env' => 'AUTO_METADATEN',        'standard' => '1',         'geheim' => false],
    'auto_vorschau'         => ['env' => 'AUTO_AUFRAEUM_VORSCHAU','standard' => '1',         'geheim' => false],
    'nachtlauf_stunde'      => ['env' => 'NACHTLAUF_STUNDE',      'standard' => '3',         'geheim' => false],
    // Tägliche Datensicherung nach <Backup-Ordner>/datenbank (Stunde −1 = aus)
    'sicherung_stunde'      => ['env' => 'SICHERUNG_STUNDE',      'standard' => '2',         'geheim' => false],
    'sicherung_tage'        => ['env' => 'SICHERUNG_TAGE',        'standard' => '7',         'geheim' => false],
    'sicherung_wochen'      => ['env' => 'SICHERUNG_WOCHEN',      'standard' => '4',         'geheim' => false],
    'klang_aktiv'           => ['env' => 'KLANG_AKTIV',           'standard' => '1',         'geheim' => false],
    // Direktzugang im Heimnetz (Cloudflare-DNS + Let's Encrypt)
    'direkt_cf_token'       => ['env' => 'CLOUDFLARE_API_TOKEN',  'standard' => '',          'geheim' => true],
    'direkt_host'           => ['env' => 'DIREKT_HOST',           'standard' => '',          'geheim' => false],
    'direkt_ip'             => ['env' => 'DIREKT_IP',             'standard' => '',          'geheim' => false],
    'direkt_port'           => ['env' => 'LOKAL_HTTPS_PORT',      'standard' => '8443',      'geheim' => false],
    'direkt_email'          => ['env' => 'ACME_EMAIL',            'standard' => '',          'geheim' => false],
    'direkt_auto'           => ['env' => 'DIREKT_AUTO_ERNEUERN',  'standard' => '1',         'geheim' => false],
    // Geräte im Heimnetz (DLNA): Adresse, unter der Receiver & Co. die Musik holen (leer = automatisch erkannt)
    'heimnetz_url'          => ['env' => 'HEIMNETZ_URL',          'standard' => '',          'geheim' => false],
    'cast_app_id'           => ['env' => 'CAST_APP_ID',           'standard' => '',          'geheim' => false],
    // Offline auf Geräten: höchste Qualität, die Apps und Browser speichern dürfen (0 = aus, opus128/opus160/opus256, original),
    // und ob Nutzer die echte Datei herunterladen dürfen („Datei herunterladen“, WAV-Export) – Admins dürfen das immer
    'offline_qualitaet'     => ['env' => 'OFFLINE_QUALITAET',     'standard' => 'opus256',   'geheim' => false],
    'downloads_erlaubt'     => ['env' => 'DOWNLOADS_ERLAUBT',     'standard' => '0',         'geheim' => false],
    // intern, ohne Oberfläche
    'direkt_aktiv'          => ['env' => '',                      'standard' => '0',         'geheim' => false],
    // Cloudflare Tunnel (von Amberwave angelegt, siehe tunnel.php)
    'tunnel_host'           => ['env' => 'TUNNEL_HOST',           'standard' => '',          'geheim' => false],
    'tunnel_id'             => ['env' => '',                      'standard' => '',          'geheim' => false],
    'tunnel_konto'          => ['env' => '',                      'standard' => '',          'geheim' => false],
    'tunnel_zone'           => ['env' => '',                      'standard' => '',          'geheim' => false],
    'tunnel_dns_id'         => ['env' => '',                      'standard' => '',          'geheim' => false],
    'tunnel_ziel'           => ['env' => '',                      'standard' => '',          'geheim' => false],
    'tunnel_fremd'          => ['env' => '',                      'standard' => '0',         'geheim' => false],
    'tunnel_proxy_ip'       => ['env' => '',                      'standard' => '',          'geheim' => false],
    // Reverse Proxy: '' = noch nicht entschieden, 'nein' = privaten Absendern nie die weitergeleitete Adresse glauben
    'proxy_entscheidung'    => ['env' => '',                      'standard' => '',          'geheim' => false],
    'heimnetz_gelernt'      => ['env' => '',                      'standard' => '',          'geheim' => false],
    'direkt_acme_konto'     => ['env' => '',                      'standard' => '',          'geheim' => true],
    'zeitplan_direkt_lauf'  => ['env' => '',                      'standard' => '',          'geheim' => false],
    'zeitplan_ablauf_lauf'  => ['env' => '',                      'standard' => '',          'geheim' => false],
    'zeitplan_scan_lauf'    => ['env' => '',                      'standard' => '',          'geheim' => false],
    'zeitplan_fanart_lauf'  => ['env' => '',                      'standard' => '',          'geheim' => false],
    'download_scan_noetig'  => ['env' => '',                      'standard' => '0',         'geheim' => false],
    'genre_familien_lauf'   => ['env' => '',                      'standard' => '',          'geheim' => false],   // Tag der letzten Genre-Familien-Berechnung (intern)
    'genre_familien_zeit'   => ['env' => '',                      'standard' => '0',         'geheim' => false],   // Zeitpunkt (Unix) der letzten Genre-Familien-Berechnung (intern)
    'zeitplan_papierkorb_lauf' => ['env' => '',                   'standard' => '',          'geheim' => false],
    'metadaten_abgleich_pos' => ['env' => '',                     'standard' => '0',         'geheim' => false],
    'erkennung_fehler'      => ['env' => '',                      'standard' => '',          'geheim' => false],
    'automatik_kette'       => ['env' => '',                      'standard' => '',          'geheim' => false],
    'zeitplan_sicherung_lauf' => ['env' => '',                    'standard' => '',          'geheim' => false],
    'sicherung_meldung'     => ['env' => '',                      'standard' => '',          'geheim' => false],
    'zeitplan_nacht_lauf'   => ['env' => '',                      'standard' => '',          'geheim' => false],
    'klang_modell'          => ['env' => '',                      'standard' => '0',         'geheim' => false],
    'klang_index'           => ['env' => '',                      'standard' => '',          'geheim' => false],
    'klang_lizenz'          => ['env' => '',                      'standard' => '',          'geheim' => false],
    'klang_meldung'         => ['env' => '',                      'standard' => '',          'geheim' => false],
];

function einstellung_def(string $k): ?array
{
    return EINSTELLUNGEN[$k] ?? null;
}

function einstellung_db_wert(string $k): ?string
{
    static $cache = null;
    if ($k === '__reset__') {
        $cache = null;
        return null;
    }
    if ($cache === null) {
        $cache = [];
        try {
            foreach (db()->query('SELECT schluessel, wert_verschluesselt FROM einstellungen') as $z) {
                $cache[$z['schluessel']] = (string) $z['wert_verschluesselt'];
            }
        } catch (Throwable $e) {
            // vor der Einrichtung gibt es die Tabelle noch nicht – das ist kein Fehler
            if (!str_contains($e->getMessage(), '42S02')) {
                error_log('Einstellungen nicht lesbar: ' . $e->getMessage());
            }
        }
    }
    if (!isset($cache[$k]) || $cache[$k] === '') {
        return null;
    }
    if (str_starts_with($cache[$k], 'p:')) {
        $klar = substr($cache[$k], 2); // nicht geheime Werte liegen im Klartext
    } else {
        try {
            $klar = entschluessle($cache[$k]);
        } catch (Throwable $e) {
            return null;
        }
    }
    return $klar === '' ? null : $klar;
}

/** Standardnamen statt „credited as“-Schreibweisen (DB-Einstellung, sonst .env KUENSTLER_STANDARDNAMEN) */
function standardnamen_aktiv(): bool
{
    return einstellung('kuenstler_standardnamen') === '1';
}

function einstellung_env(array $def): ?string
{
    if ($def['env'] === '') {
        return null;
    }
    $e = getenv($def['env']);
    return ($e !== false && trim($e) !== '') ? trim($e) : null;
}

function einstellung(string $k): string
{
    $def = einstellung_def($k);
    if (!$def) {
        return '';
    }
    return einstellung_db_wert($k) ?? einstellung_env($def) ?? $def['standard'];
}

/** 'db' | 'env' | 'standard' | 'leer' */
function einstellung_quelle(string $k): string
{
    $def = einstellung_def($k);
    if (!$def) {
        return 'leer';
    }
    if (einstellung_db_wert($k) !== null) {
        return 'db';
    }
    if (einstellung_env($def) !== null) {
        return 'env';
    }
    return $def['standard'] !== '' ? 'standard' : 'leer';
}

function einstellung_setzen(string $k, string $wert): void
{
    $def = einstellung_def($k);
    if (!$def) {
        throw new InvalidArgumentException('Unbekannte Einstellung: ' . $k);
    }
    // Geheimes verschlüsselt (braucht APP_SECRET_KEY), alles andere im Klartext
    $gespeichert = $def['geheim'] ? verschluessle($wert) : 'p:' . $wert;
    db_tun('INSERT INTO einstellungen (schluessel, wert_verschluesselt) VALUES (:k, :w) ON DUPLICATE KEY UPDATE wert_verschluesselt = VALUES(wert_verschluesselt)',
        ['k' => $k, 'w' => $gespeichert]);
    einstellung_db_wert('__reset__');
}

function einstellung_loeschen(string $k): void
{
    db_tun('DELETE FROM einstellungen WHERE schluessel = :k', ['k' => $k]);
    einstellung_db_wert('__reset__');
}

/** Für die Oberfläche: Werte (Geheimes nur als "gesetzt ja/nein") plus Quelle. */
function einstellungen_fuer_oberflaeche(array $schluessel): array
{
    $aus = [];
    foreach ($schluessel as $k) {
        $def = einstellung_def($k);
        if (!$def) {
            continue;
        }
        $wert = einstellung($k);
        $aus[$k] = [
            'wert' => $def['geheim'] ? '' : $wert,
            'gesetzt' => $wert !== '',
            'geheim' => $def['geheim'],
            'quelle' => einstellung_quelle($k),
            'env' => $def['env'],
        ];
    }
    return $aus;
}
