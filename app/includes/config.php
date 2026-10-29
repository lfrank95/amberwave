<?php
// Zentrale Konfiguration – liest ausschließlich aus Umgebungsvariablen (.env).
// Hier liegen NIE Zugangsdaten im Klartext; die Werte unten sind nur Standardwerte.
declare(strict_types=1);

/** Ersatz-Schlüssel (64 Hex) aus dem Cache-Ordner; wird einmal erzeugt und bleibt, solange der Cache bleibt */
if (!function_exists('konfig_notschluessel')) {
function konfig_notschluessel(string $cache): string
{
    $p = $cache . '/.app_secret_key';
    $alt = is_file($p) ? trim((string) @file_get_contents($p)) : '';
    if (preg_match('/^[0-9a-f]{64}$/', $alt)) {
        return $alt;
    }
    try {
        $neu = bin2hex(random_bytes(32));
    } catch (Throwable $e) {
        return '';
    }
    if (!is_dir($cache)) {
        @mkdir($cache, 0775, true);
    }
    if (@file_put_contents($p . '.tmp', $neu . "\n", LOCK_EX) === false || !@rename($p . '.tmp', $p)) {
        @unlink($p . '.tmp');
        // nicht schreibbar: pro Prozess zufällig – Schlüssel passen dann nicht zueinander, aber nichts ist fälschbar
        return $neu;
    }
    @chmod($p, 0600);
    return $neu;
}
}

if (!function_exists('konfig')) {
    function konfig(): array
    {
        static $k = null;
        if ($k !== null) {
            return $k;
        }
        $env = static function (string $name, string $standard = ''): string {
            $wert = getenv($name);
            return ($wert === false || trim($wert) === '') ? $standard : trim($wert);
        };
        $zahl = static function (string $name, int $standard) use ($env): int {
            $wert = $env($name, (string) $standard);
            return is_numeric($wert) ? (int) $wert : $standard;
        };
        $liste = static function (string $name, string $standard) use ($env): array {
            return array_values(array_filter(array_map('trim', explode(',', $env($name, $standard))), 'strlen'));
        };

        // Zeitzone für alle Datums-/Zeitangaben (Datenbank-Sitzung übernimmt sie, siehe db.php)
        // Angaben aus der Einrichtung (PFAD_CACHE/geheimnisse/server.json); APP_ZEITZONE und CLIENT_SERVERNAME aus der .env haben Vorrang
        $serverDatei = rtrim($env('PFAD_CACHE', '/cache'), '/') . '/geheimnisse/server.json';
        $serverAngaben = is_file($serverDatei) ? json_decode((string) @file_get_contents($serverDatei), true) : null;
        $serverAngaben = is_array($serverAngaben) ? $serverAngaben : [];
        $zone = $env('APP_ZEITZONE', (string) ($serverAngaben['zeitzone'] ?? 'Europe/Berlin'));
        if (!@date_default_timezone_set($zone)) {
            date_default_timezone_set('Europe/Berlin');
        }

        $k = [
            'version' => '0.9.1-beta.2',
            'zeitzone' => date_default_timezone_get(),
            'db' => [
                'host' => $env('DB_HOST', 'db'),
                'port' => $zahl('DB_PORT', 3306),
                'name' => $env('DB_NAME', 'amberwave'),
                'user' => $env('DB_USER', 'amberwave'),
                'password' => $env('DB_PASSWORD'),
            ],
            'app_name' => $env('APP_NAME', 'Amberwave'),
            // Edition (Free/Pro) – steht im User-Agent aller Anfragen an fremde Dienste; später aus dem Lizenzschlüssel
            'edition' => strtolower($env('AMBERWAVE_EDITION', 'free')) === 'pro' ? 'pro' : 'free',
            // Kontakt für die Betreiber fremder Dienste (im User-Agent); leer = fest eingebauter Entwickler-Kontakt bzw. APP_URL
            'dienste_kontakt' => trim($env('DIENSTE_KONTAKT', '')),
            'aktivitaet_pause_minuten' => $zahl('AKTIVITAET_PAUSE_MINUTEN', 10),
            'sortierung_ohne_artikel' => $zahl('SORTIERUNG_OHNE_ARTIKEL', 1) === 1,
            'zoom_sperren' => $zahl('ZOOM_SPERREN', 1) === 1,
            // Fernsteuerung: offene Rückkanäle (je einer pro Gerät mit offener App; jeder belegt einen PHP-Prozess),
            // nach wie vielen Sekunden ohne Lebenszeichen ein Gerät als offline gilt, Länge eines Kanals bis zum Neuaufbau
            // Geräte im Heimnetz (DLNA-Receiver, Fernseher, Streamer): Suche, Agent, Server-Renderer
            'heimnetz' => [
                'an' => $zahl('HEIMNETZ_AN', 1) === 1,
                'netze' => $liste('HEIMNETZ_NETZE', ''),
                'app_port' => $zahl('APP_PORT', 9950),
                'render' => trim($env('AW_RENDER_PFAD', '')),
                'agent_ruhe_minuten' => $zahl('HEIMNETZ_AGENT_RUHE', 10),
                'abfrage_ms' => $zahl('HEIMNETZ_ABFRAGE_MS', 1000),
            ],
            'fern' => [
                'an' => $zahl('FERN_AN', 1) === 1,
                'max_verbindungen' => $zahl('FERN_MAX_VERBINDUNGEN', 40),
                'offline_sekunden' => $zahl('FERN_OFFLINE_SEKUNDEN', 15),
                'kanal_sekunden' => $zahl('FERN_KANAL_SEKUNDEN', 30),
                'takt_ms' => $zahl('FERN_TAKT_MS', 250),
            ],
            // öffentliche Adresse; ohne APP_URL die vom eingerichteten Cloudflare Tunnel (Datei schreibt tunnel.php)
            'app_url' => rtrim($env('APP_URL'), '/') ?: rtrim(trim((string) @file_get_contents(rtrim($env('PFAD_CACHE', '/cache'), '/') . '/tunnel/app_url.txt')), '/'),
            // Cloudflare Tunnel: Ziel der Weiterleitung (App-Container im Stack) und Name des cloudflared-Containers
            // TUNNEL_IM_STACK=1: eigener cloudflared-Container im Stack (Compose legt ihn an); 0: ein schon vorhandenes cloudflared
            // auf dem Server oder im Netz – Amberwave trägt dann nur seine Regel in dessen Tunnel ein
            'tunnel' => [
                'modus' => $env('TUNNEL_IM_STACK', '1') === '0' ? 'vorhanden' : 'eigen',
                'ziel' => $env('TUNNEL_ZIEL', ''),
                'container' => $env('TUNNEL_CONTAINER', 'amberwave_tunnel'),
            ],
            'server_name' => trim($env('CLIENT_SERVERNAME', (string) ($serverAngaben['servername'] ?? ''))),
            'app_secret_key' => $env('APP_SECRET_KEY'),
            'pfade' => [
                'musik' => rtrim($env('PFAD_MUSIK', '/musik'), '/'),
                'cache' => rtrim($env('PFAD_CACHE', '/cache'), '/'),
                'backups' => rtrim($env('PFAD_BACKUPS', '/backups'), '/'),
                // Fertige Downloads von SABnzbd (Kategorie-Ordner, im Container eingebunden – siehe DOWNLOAD_PFAD)
                'downloads' => rtrim($env('PFAD_DOWNLOADS', '/downloads'), '/'),
            ],
            'scan' => [
                'dateitypen' => array_map('strtolower', $liste('SCAN_DATEITYPEN', 'flac,mp3,m4a,m4b,mp4,aac,ogg,oga,opus,wav,aif,aiff,wv,ape,alac,dsf,dff,wma,mka,mpc')),
                'cover_namen' => array_map('strtolower', $liste('SCAN_COVER_NAMEN', 'cover,folder,front,album,albumart')),
                'ignorieren' => $liste('SCAN_IGNORIEREN', '@eaDir,.Trash,#recycle,.AppleDouble'),
                'auto_stunden' => $zahl('SCAN_AUTO_STUNDEN', 0),
                'cover_groessen' => array_map('intval', $liste('COVER_GROESSEN', '200,300,400,600,1200')),
                // Standardnamen statt stilisierter „credited as“-Schreibweisen aus MusicBrainz („JAŸ-Z“ → „JAY-Z“).
                // Nachteil: gewollte Stilisierungen wie „P!nk“ werden dann ebenfalls zum Standardnamen vereinheitlicht.
                'standardnamen' => $zahl('KUENSTLER_STANDARDNAMEN', 0) === 1,
            ],
            'stream' => [
                'standard' => $env('STREAM_STANDARD', 'opus256'),
                // „Offline speichern“ (PWA): Qualität der gespeicherten Titel (opus128, opus160, opus256), 0 = abgeschaltet
                'offline' => $env('OFFLINE_QUALITAET', 'opus256'),
                'max_umwandlungen' => $zahl('STREAM_MAX_UMWANDLUNGEN', 8),
                'ffmpeg' => $env('FFMPEG_PFAD', 'ffmpeg'),
                'ffprobe' => $env('FFPROBE_PFAD', 'ffprobe'),
                'gehoert_ab_prozent' => $zahl('GEHOERT_AB_PROZENT', 50),
                'gehoert_ab_sekunden' => $zahl('GEHOERT_AB_SEKUNDEN', 240),
                'downloads_erlaubt' => $zahl('DOWNLOADS_ERLAUBT', 0) === 1,
            ],
            'quellen' => [
                'musicbrainz_url' => rtrim($env('MUSICBRAINZ_URL', 'https://musicbrainz.org/ws/2'), '/'),
                'coverart_url' => rtrim($env('COVERART_URL', 'https://coverartarchive.org'), '/'),
                'musicbrainz_user_agent' => $env('MUSICBRAINZ_USER_AGENT'),
                'fanart_api_key' => $env('FANART_API_KEY'),
                'fanart_url' => rtrim($env('FANART_URL', 'https://webservice.fanart.tv/v3'), '/'),
                'fanart_minuten' => $zahl('FANART_ALLE_MINUTEN', 10),
                'claude_api_key' => $env('CLAUDE_API_KEY'),
                'listenbrainz_url' => rtrim($env('LISTENBRAINZ_URL', 'https://api.listenbrainz.org'), '/'), // beliebteste Titel je Künstler
                'beliebt_tage' => $zahl('BELIEBT_TAGE', 30),   // so lange gelten die Top-Titel, dann werden sie neu geholt
                // Kennzeichnung „explizit“ je Titel von Deezer (öffentliche Schnittstelle, kein Schlüssel) – läuft beim Abgleich mit
                'deezer_aktiv' => $env('DEEZER_AKTIV', '1') !== '0',
                'deezer_url' => rtrim($env('DEEZER_URL', 'https://api.deezer.com'), '/'),
                'deezer_wiederholen_tage' => $zahl('DEEZER_WIEDERHOLEN_TAGE', 30), // Titel ohne Treffer erst nach … Tagen erneut fragen
                'lidarr_url' => rtrim($env('LIDARR_URL'), '/'),
                'lidarr_api_key' => $env('LIDARR_API_KEY'),
            ],
            'sicherheit' => [
                'registrierung_modus' => $env('REGISTRIERUNG_MODUS', 'freigabe'),
                'registrierung_max_pro_stunde' => $zahl('REGISTRIERUNG_MAX_PRO_STUNDE', 3),
                'login_max_fehlversuche' => $zahl('LOGIN_MAX_FEHLVERSUCHE', 5),
                'login_sperre_basis_sekunden' => $zahl('LOGIN_SPERRE_BASIS_SEKUNDEN', 60),
                'login_max_pro_ip_stunde' => $zahl('LOGIN_MAX_FEHLVERSUCHE_PRO_IP_STUNDE', 30),
                'login_max_pro_name_stunde' => $zahl('LOGIN_MAX_FEHLVERSUCHE_PRO_NAME_STUNDE', 20),
                'reset_max_pro_ip_stunde' => $zahl('PASSWORT_RESET_MAX_PRO_IP_STUNDE', 5),
                'reset_max_pro_mail_stunde' => $zahl('PASSWORT_RESET_MAX_PRO_MAIL_STUNDE', 3),
                'reset_gueltig_minuten' => $zahl('PASSWORD_RESET_GUELTIG_MINUTEN', 60),
                'remember_me_tage' => $zahl('REMEMBER_ME_TAGE', 30),
                'passwort_min_laenge' => $zahl('PASSWORT_MIN_LAENGE', 8),
                'sitzung_stunden' => $zahl('SITZUNG_STUNDEN', 12),
                'max_geraete' => $zahl('MAX_GERAETE_PRO_NUTZER', 3),
                'max_geraete_admin' => $zahl('MAX_GERAETE_ADMIN', 0),
                'api_token_tage' => $zahl('API_TOKEN_TAGE', 365),
                'csp' => $zahl('SICHERHEIT_CSP', 1) === 1,
                'hsts' => $zahl('SICHERHEIT_HSTS', 1) === 1,
                'proxy_ips' => $liste('PROXY_IPS', ''),
                'proxy_vertrauen' => $env('PROXY_VERTRAUEN', 'auto'),
            ],
            'netz' => [
                // Diese Netze gelten als „zuhause“ (Komma-getrennt, CIDR)
                'lokale_netze' => $liste('LOKALE_NETZE', '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,fc00::/7,fe80::/10,::1/128'),
                // Eigene öffentliche Adresse(n) – für Geräte zuhause, die über den Cloudflare Tunnel kommen
                'heim_ip' => $liste('HEIM_IP', ''),
                'heim_ip_erkennen' => $zahl('HEIM_IP_ERKENNEN', 1) === 1,
                'erkennen_urls' => $liste('HEIM_IP_URLS', 'https://1.1.1.1/cdn-cgi/trace,https://[2606:4700:4700::1111]/cdn-cgi/trace'),
            ],
            'direkt' => [
                // Direktzugang im Heimnetz: ACME (Let's Encrypt), Cloudflare-API, Prüfung über DNS-over-HTTPS
                'url' => rtrim($env('DIREKT_URL'), '/'),   // fest vorgegebene lokale Adresse (z. B. eigener Reverse Proxy) – dann ohne Automatik
                'acme_url' => $env('ACME_URL', 'https://acme-v02.api.letsencrypt.org/directory'),
                'cloudflare_url' => rtrim($env('CLOUDFLARE_API_URL', 'https://api.cloudflare.com/client/v4'), '/'),
                'doh_url' => $env('DIREKT_DOH_URL', 'https://cloudflare-dns.com/dns-query'),
                'dns_pruefen' => $zahl('DIREKT_DNS_PRUEFEN', 1) === 1,
                'ca_datei' => $env('ACME_CA_DATEI'),       // nur für Tests mit eigener Zertifizierungsstelle
                'erneuern_tage' => $zahl('DIREKT_ERNEUERN_TAGE', 30),
                'interner_port' => $zahl('DIREKT_INTERNER_PORT', 8443),
                'cors_zusatz' => $liste('DIREKT_CORS_ZUSATZ', ''),
            ],
            'export' => [
                // WAV-Export (z. B. Playlist als eine Datei fürs Mischpult); Dateien liegen im Cache unter export/
                'aufheben_stunden' => $zahl('EXPORT_AUFHEBEN_STUNDEN', 48),
                'max_pro_nutzer' => $zahl('EXPORT_MAX_PRO_NUTZER', 3),
                'max_titel' => $zahl('EXPORT_MAX_TITEL', 500),
                'teil_max_minuten' => $zahl('EXPORT_TEIL_MAX_MINUTEN', 0), // 0 = automatisch knapp unter 4 GB
            ],
            'lautheit' => [
                // Lautheitsanalyse (EBU R128) im Hintergrund und Angleichen beim Abspielen
                'aktiv' => $zahl('LAUTHEIT_AKTIV', 1) === 1,
                'parallel' => $zahl('LAUTHEIT_PARALLEL', 2),       // gleichzeitige ffmpeg-Messungen
                'ziel' => (float) $env('LAUTHEIT_ZIEL', '-16'),    // Standard-Zielwert in LUFS (pro Gerät änderbar)
                'decke' => (float) $env('LAUTHEIT_DECKE', '-1'),   // höchster True-Peak nach dem Anheben (dBTP), kein Limiter
            ],
            'erkennung' => [
                // Alben per akustischem Fingerabdruck erkennen (Chromaprint über ffmpeg → AcoustID → MusicBrainz)
                'aktiv' => $zahl('ERKENNUNG_AKTIV', 1) === 1,
                'auto' => in_array($env('ERKENNUNG_AUTO', 'regeln'), ['regeln', 'eindeutig', 'aus'], true) ? $env('ERKENNUNG_AUTO', 'regeln') : 'regeln',
                'schwelle' => max(50, min(100, $zahl('ERKENNUNG_SCHWELLE', 90))), // ab dieser Sicherheit (%) gilt eine Edition als passend
                'parallel' => max(1, min(8, $zahl('ERKENNUNG_PARALLEL', 2))),    // gleichzeitige Fingerabdrücke
                'acoustid_url' => rtrim($env('ACOUSTID_URL', 'https://api.acoustid.org/v2'), '/'),
            ],
            'sortieren' => [
                // Sortier-Assistent: unsortierte Musik aus einem Eingangsordner (relativ zum Musikordner) per Fingerabdruck
                // erkennen, zu Alben zusammenstellen und nach der Freigabe einsortieren. Der Eingangsordner wird nie normal eingelesen.
                'ordner' => trim($env('SORTIEREN_ORDNER', '_unsortiert'), '/') ?: '_unsortiert',
                // Zwischenablage für neue Alben, bis sie mit MusicBrainz verknüpft und nach Schema einsortiert sind
                'zwischen' => trim($env('SORTIEREN_ZWISCHEN', '_sortiert'), '/') ?: '_sortiert',
                // ab diesem AcoustID-Trefferwert (%) gilt ein Titel als erkannt
                'schwelle' => max(50, min(99, $zahl('SORTIEREN_SCHWELLE', 80))),
                // Vorauswahl für doppelte Dateien: papierkorb (Papierkorb des Aufräumens, AUFRAEUMEN_PAPIERKORB_TAGE) | liegen
                'dubletten' => $env('SORTIEREN_DUBLETTEN', 'papierkorb') === 'liegen' ? 'liegen' : 'papierkorb',
            ],
            'presets' => [
                // Eigene Presets je Effektgerät und fürs ganze Rack (pro Konto): höchstens so viele je Gerät und Konto
                'max' => max(1, min(1000, $zahl('PRESETS_MAX', 100))),
            ],
            'aufraeumen' => [
                // Dateien aufräumen: Tags/Cover in die Dateien schreiben, nach Schema benennen, Müll entfernen (immer mit Vorschau)
                'ordner' => $env('AUFRAEUMEN_ORDNER', '{albumkuenstler}/{jahr} - {album}{ (edition)}'),
                'datei' => $env('AUFRAEUMEN_DATEI', '{CD disc/}{nr} - {titel}'),
                'zeichen' => strtolower($env('AUFRAEUMEN_ZEICHEN', 'windows')) === 'ascii' ? 'ascii' : 'windows', // windows = alles, was unter Windows/SMB geht; ascii = streng
                'cd_immer' => $zahl('AUFRAEUMEN_CD_IMMER', 0) === 1,
                // Rechte für alles, was Amberwave im Musikordner anlegt (oktal) – Unraid-Standard wie „New Permissions“
                'rechte_ordner' => octdec(preg_replace('/[^0-7]/', '', $env('AUFRAEUMEN_RECHTE_ORDNER', '777')) ?: '777'),
                'rechte_datei' => octdec(preg_replace('/[^0-7]/', '', $env('AUFRAEUMEN_RECHTE_DATEI', '666')) ?: '666'),  // Ordner „CD 1“ auch bei Alben mit nur einem Datenträger (Standard: nur bei mehreren)
                // sauber = alte Tags werden ersetzt, Fremdes entfernt (außer AUFRAEUMEN_BEHALTEN); ergaenzen = Fremdes bleibt
                'tags' => $env('AUFRAEUMEN_TAGS', 'sauber') === 'ergaenzen' ? 'ergaenzen' : 'sauber',
                // Mitwirkende (Produzent, Komponist, Musiker/Gäste …) in die Dateien schreiben? Standard aus – die meisten
                // Player können damit nichts anfangen, und in Amberwave bleiben sie ohnehin erhalten.
                'mitwirkende' => $zahl('AUFRAEUMEN_MITWIRKENDE', 0) === 1,
                // ITUNESADVISORY (Kennzeichnung „explizit“) bleibt immer erhalten, auch wenn die .env-Liste es nicht nennt
                'behalten' => array_values(array_unique(array_merge(array_map('strtoupper', $liste('AUFRAEUMEN_BEHALTEN', 'LYRICS,UNSYNCEDLYRICS,ISRC')), ['ITUNESADVISORY']))),
                'muell' => $liste('AUFRAEUMEN_MUELL', '*.nfo,*.sfv,*.m3u,*.m3u8,*.log,*.cue,*.md5,*.ffp,*.url,*.accurip,Thumbs.db,desktop.ini,.DS_Store,._*'),
                'cover' => $zahl('AUFRAEUMEN_COVER', 1) === 1,          // Cover in die Dateien einbetten
                'cover_groesse' => $zahl('AUFRAEUMEN_COVER_GROESSE', 1200),
                'papierkorb_tage' => $zahl('AUFRAEUMEN_PAPIERKORB_TAGE', 30),
                'name_max' => max(40, min(240, $zahl('AUFRAEUMEN_NAME_MAX', 180))),   // Bytes je Datei-/Ordnername (verschlüsselte NAS-Ordner: 140)
                'pfad_max' => max(80, $zahl('AUFRAEUMEN_PFAD_MAX', 200)),             // Zeichen des ganzen Pfads unter dem Musikordner
                'freigabe_stunden' => max(1, $zahl('AUFRAEUMEN_FREIGABE_STUNDEN', 12)), // so lange gilt eine Freigabe; danach neu freigeben
                'schonzeit_min' => $zahl('AUFRAEUMEN_SCHONZEIT_MIN', 10), // Alben mit Titeln, die so kurz zuvor gespielt wurden, bleiben unangetastet
            ],
            'waerme' => [
                // Röhrensättigung für neue Geräte: aus | hauch | warm | glut (jedes Gerät kann es danach selbst umstellen)
                'vorgabe' => in_array($env('WAERME_VORGABE', 'aus'), ['aus', 'hauch', 'warm', 'glut'], true) ? $env('WAERME_VORGABE', 'aus') : 'aus',
                // Röhre für neue Geräte: ax7 (12AX7, heiß) | at7 (12AT7, Punch) | au7 (12AU7, glatt) | sn7 (6SN7, breit); Schaltung: eintakt | gegentakt
                'roehre' => in_array($env('WAERME_ROEHRE', 'ax7'), ['ax7', 'at7', 'au7', 'sn7'], true) ? $env('WAERME_ROEHRE', 'ax7') : 'ax7',
                'schaltung' => in_array($env('WAERME_SCHALTUNG', 'eintakt'), ['eintakt', 'gegentakt'], true) ? $env('WAERME_SCHALTUNG', 'eintakt') : 'eintakt',
                // Lautheit (LUFS), bei der die Stufen so klingen wie abgestimmt – leisere Titel werden stärker, lautere schwächer angefahren
                'bezug_lufs' => max(-30, min(-8, (float) $env('WAERME_BEZUG_LUFS', '-18'))),
            ],
            'band' => [
                // Bandmaschine für neue Geräte: aus | fresh | worn | old; Bezugslautheit wie bei der Röhre
                'vorgabe' => in_array($env('BAND_VORGABE', 'aus'), ['aus', 'fresh', 'worn', 'old'], true) ? $env('BAND_VORGABE', 'aus') : 'aus',
                'bezug_lufs' => max(-30, min(-8, (float) $env('BAND_BEZUG_LUFS', $env('WAERME_BEZUG_LUFS', '-18')))),
                // Bandsorte (sm900 | 456 | sm468) und Entzerrungsnorm (nab | ccir) für neue Geräte
                'sorte' => in_array($env('BAND_SORTE', 'sm900'), ['sm900', '456', 'sm468'], true) ? $env('BAND_SORTE', 'sm900') : 'sm900',
                'norm' => in_array($env('BAND_NORM', 'nab'), ['nab', 'ccir'], true) ? $env('BAND_NORM', 'nab') : 'nab',
            ],
            'trafo' => [
                // Übertrager (AmberIron) für neue Geräte: aus | hauch | satt | schwer; Kern nickel | stahl | eisen; Bezug wie die Röhre
                'vorgabe' => in_array($env('TRAFO_VORGABE', 'aus'), ['aus', 'hauch', 'satt', 'schwer'], true) ? $env('TRAFO_VORGABE', 'aus') : 'aus',
                'kern' => in_array($env('TRAFO_KERN', 'stahl'), ['nickel', 'stahl', 'eisen'], true) ? $env('TRAFO_KERN', 'stahl') : 'stahl',
                'bezug_lufs' => max(-30, min(-8, (float) $env('TRAFO_BEZUG_LUFS', $env('WAERME_BEZUG_LUFS', '-18')))),
            ],
            'radio' => [
                'thema_min' => $zahl('RADIO_THEMA_MIN', 25), // Songs, ab denen ein Jahrzehnt/Genre einen Radio-Knopf bekommt
                // Genre-Radios: ab wann ein Song dazugehört (Anteile 0–1). Familie: stärkste Familie ab familie_min, sonst ab familie_sicher;
                // einzelnes Genre: Album-Genre unter den zwei stärksten ab genre_min (Titel-Genres zählen immer)
                'familie_min' => max(0.15, min(0.9, (float) $env('RADIO_FAMILIE_MIN', '0.40'))),
                'familie_sicher' => max(0.3, min(1.0, (float) $env('RADIO_FAMILIE_SICHER', '0.55'))),
                'genre_min' => max(0.1, min(0.9, (float) $env('RADIO_GENRE_MIN', '0.35'))),
                'kuenstler_anteil' => max(30, min(100, $zahl('RADIO_KUENSTLER_ANTEIL', 100))), // Künstler-Radio: so viel Prozent vom Künstler selbst, der Rest passt dazu
            ],
            'genres' => [
                // Ab welchem Anteil (in %) ein Album zu einer Genre-Familie (Pop, Elektro …) zählt
                'schwelle' => max(5, min(90, $zahl('GENRE_FAMILIE_SCHWELLE', 25))),
            ],
            'klang' => [
                // Klanganalyse (akustische Ähnlichkeit). Eingebaut: Python 3 + numpy aus dem Image.
                'python' => $env('KLANG_PYTHON', 'python3'),
                // Erweitertes Modell – wird NICHT mitgeliefert; der Admin installiert es per Knopf direkt beim Hersteller (MTG).
                'pip_paket' => $env('KLANG_PIP_PAKET', 'essentia-tensorflow'),
                'modell_url' => $env('KLANG_MODELL_URL', 'https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb'),
                // Stil-Kopf des Modells (400 Discogs-Stile) – Modelldatei und Beschriftung
                'stil_url' => $env('KLANG_STIL_URL', 'https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb'),
                'stil_json_url' => $env('KLANG_STIL_JSON_URL', 'https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json'),
                'lizenz_url' => $env('KLANG_LIZENZ_URL', 'https://essentia.upf.edu/models/LICENSE'),
            ],
            'raumklang' => [
                // Paket mit Impulsantworten für den Hall (lädt der Server auf Knopfdruck unter Verwaltung → System)
                'ir_url' => $env('RAUMKLANG_IR_URL', 'https://www.voxengo.com/files/impulses/IMreverbs.zip'),
                // Bassmanagement und Center (Vorgaben für neue Geräte, pro Gerät im Raumklang-Menü umschaltbar): Trennfrequenz des Bassmanagements in Hz (80, 100, 120; 0 = aus),
                // LFE-Pegel in dB (-10 = Receiver hebt den LFE um 10 dB an, 0 = ohne Absenkung), Center-Anteil 0–100 (50 = klassisch, −3 dB)
                'lcr_trennung' => (static function ($t) { return $t === 0 ? 0 : ($t >= 60 && $t <= 250 ? (int) (round($t / 10) * 10) : 80); })((int) $env('RAUMKLANG_LFE_TRENNUNG', '80')),
                'lcr_lfe' => (int) $env('RAUMKLANG_LFE_PEGEL', '-10') === 0 ? 0 : -10,
                'lcr_center' => max(0, min(100, (int) $env('RAUMKLANG_CENTER_ANTEIL', '50'))),
                // Rear-Delay für neue Geräte in ms (0–20): Ls/Rs kommen so viel später, die Bühne rückt per Präzedenzeffekt nach vorn
                'rear_delay' => max(0, min(20, (int) $env('RAUMKLANG_REAR_DELAY', '0'))),
                // Raumklang-Modul bei Titelwahl, Skip und Play frisch starten (1) oder durchlaufen lassen (0)
                'neustart' => $env('RAUMKLANG_NEUSTART', '1') !== '0',
                // Stärke „Mittel“ (Regler 0–100; Intensität/Pegel 50 = wie das Preset) – „Klein“ und „Groß“ werden davon abgeleitet:
                // Intensität und Pegel ± SCHRITT, Effekte und Breite × (1 ∓ SCHRITT/30)
                'mittel' => [
                    'intensitaet' => max(0, min(100, $zahl('RAUMKLANG_MITTEL_INTENSITAET', 34))), // 34 = −3,8 dB
                    'pegel' => max(0, min(100, $zahl('RAUMKLANG_MITTEL_PEGEL', 75))),             // 75 = +6,0 dB
                    'effekte' => max(0, min(100, $zahl('RAUMKLANG_MITTEL_EFFEKTE', 26))),
                    'breite' => max(0, min(100, $zahl('RAUMKLANG_MITTEL_BREITE', 22))),
                ],
                // Dürfen alle Nutzer eigene Impulsantworten hochladen (1) oder nur Admins (0)? Löschen bleibt dem Admin vorbehalten
                'upload_alle' => $env('RAUMKLANG_UPLOAD_ALLE', '1') !== '0',
                'prozent' => max(5, min(60, $zahl('RAUMKLANG_STAERKE_PROZENT', 20))), // Subtil/Intensiv = Weit ∓/± so viel Prozent
            ],
            'mail' => [
                'ablauf_tage' => $zahl('MAIL_ABLAUF_TAGE', 30),
            ],
            // Einrichtung beim ersten Start (/einrichtung.php): Zeitfenster nach dem Containerstart (0 = unbegrenzt),
            // Code auch im direkten Heimnetz verlangen, eigener Code statt des erzeugten
            'einrichtung' => [
                'fenster_minuten' => max(0, $zahl('EINRICHTUNG_FENSTER_MINUTEN', 30)),
                'code_immer' => $zahl('EINRICHTUNG_CODE_IMMER', 1) === 1,   // Standard: Code immer (sicher auch hinter Docker-Portweiterleitungen)
                'code' => $env('EINRICHTUNGSCODE', ''),
            ],
        ];
        // Datenbank-Zugang: steht DB_PASSWORD in der .env, gilt die .env (DB_NAME/DB_USER/DB_PASSWORD) – sonst die Angaben aus der
        // Einrichtung (PFAD_CACHE/geheimnisse/datenbank.json)
        $k['db']['quelle'] = $env('DB_PASSWORD') !== '' ? 'env' : 'keine';
        if ($k['db']['quelle'] === 'keine') {
            $dbDatei = $k['pfade']['cache'] . '/geheimnisse/datenbank.json';
            $dbAngaben = is_file($dbDatei) ? json_decode((string) @file_get_contents($dbDatei), true) : null;
            if (is_array($dbAngaben) && !empty($dbAngaben['name']) && !empty($dbAngaben['user']) && !empty($dbAngaben['passwort'])) {
                $k['db']['name'] = (string) $dbAngaben['name'];
                $k['db']['user'] = (string) $dbAngaben['user'];
                $k['db']['password'] = (string) $dbAngaben['passwort'];
                $k['db']['quelle'] = 'datei';
            }
        }
        // Kein APP_SECRET_KEY in der .env: einen erzeugen und im Cache ablegen, statt mit leerem Schlüssel zu signieren
        // (damit wären Direktzugang, Heimnetz-Streams und Bild-Schlüssel fälschbar). Der Schlüssel in der .env hat Vorrang.
        if ($k['app_secret_key'] === '') {
            $k['app_secret_key'] = konfig_notschluessel($k['pfade']['cache']);
            $k['app_secret_key_erzeugt'] = true;
            // dauerhaft im App-Daten-Ordner abgelegt (Normalfall, die Einrichtung sichert eine Kopie) – nur wenn das nicht ging,
            // ist der Schlüssel flüchtig und gespeicherte Zugangsdaten wären nach einem Neustart unlesbar
            $k['app_secret_key_fluechtig'] = !is_file($k['pfade']['cache'] . '/.app_secret_key');
        }
        return $k;
    }
}

if (!function_exists('einr_host_pfad')) { // config.php wird teils mit require geladen (crypto.php) – nicht doppelt deklarieren
    /** Ordner auf dem Server (Host): Compose reicht sie als HOST_<NAME> durch (auch wenn sie aus APPDATA_PFAD abgeleitet sind), sonst der Wert der .env */
    function einr_host_pfad(string $name): string
    {
        $v = trim((string) getenv('HOST_' . $name));
        return $v !== '' ? $v : trim((string) getenv($name));
    }
}

return konfig();
