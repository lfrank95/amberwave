<?php
// JSON-API v1 – Einstiegspunkt für die Web-App und alle späteren Apps (Windows-Player).
// Beschreibung aller Pfade: docs/API.md im Projektordner.
declare(strict_types=1);
require_once __DIR__ . '/../includes/api_nutzer.php';
require_once __DIR__ . '/../includes/einrichtung.php';
require_once __DIR__ . '/../includes/api_admin.php';
require_once __DIR__ . '/../includes/api_metadaten.php';
require_once __DIR__ . '/../includes/metadatenjob.php';
require_once __DIR__ . '/../includes/automatik.php';
require_once __DIR__ . '/../includes/klang.php';
require_once __DIR__ . '/../includes/stream.php';
require_once __DIR__ . '/../includes/raumklang.php';
require_once __DIR__ . '/../includes/direktzugang.php';
require_once __DIR__ . '/../includes/aktivitaet.php';
require_once __DIR__ . '/../includes/lautheit.php';
require_once __DIR__ . '/../includes/erkennung.php';
require_once __DIR__ . '/../includes/beliebt.php';
require_once __DIR__ . '/../includes/aufraeumen.php';
require_once __DIR__ . '/../includes/export.php';
require_once __DIR__ . '/../includes/radio.php';
require_once __DIR__ . '/../includes/genres.php';
require_once __DIR__ . '/../includes/presets.php';
require_once __DIR__ . '/../includes/fernsteuerung.php';

$pfad = (string) ($_GET['pfad'] ?? '');
unset($_GET['pfad']);

// Direktzugang im Heimnetz: CORS für die App (andere Herkunft) und Vorabanfragen beantworten
direkt_cors();
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$routen = [
    // Anmeldung & Sitzung
    ['GET', '/ich', function () {
        $r = api_ich();
        hn_basis_lernen(eingeloggter_user());   // von einem Admin im Heimnetz geöffnet? Dann kennen wir die Adresse für Receiver & Co.
        return $r;
    }],
    ['POST', '/auth/token', fn() => api_token_anmelden()],
    ['DELETE', '/auth/token', function () {
        $u = api_user();
        if (empty($GLOBALS['api_token_anmeldung'])) {
            throw new ApiFehler(t('Nur mit Geräte-Schlüssel möglich.'));
        }
        geraet_beenden((int) $u['id'], (int) aktuelles_geraet_id());
        return ['ok' => true];
    }],
    ['POST', '/abmelden', function () {
        api_user();
        abmelden();
        return ['ok' => true];
    }],

    // Bibliothek
    ['GET', '/start', fn() => api_start(api_user())],
    ['GET', '/alben', fn() => api_alben_liste(api_user())],
    ['GET', '/alben/{id}', fn($p) => api_album(api_user(), (int) $p['id'])],
    ['GET', '/kuenstler', fn() => api_kuenstler_liste(api_user())],
    ['GET', '/kuenstler/{id}', fn($p) => api_kuenstler(api_user(), (int) $p['id'])],
    ['GET', '/kuenstler/{id}/beliebt', function ($p) {
        $u = api_user();
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close(); // beim ersten Aufruf werden MusicBrainz/ListenBrainz gefragt
        }
        return api_kuenstler_beliebt($u, (int) $p['id']);
    }],
    ['GET', '/tracks/{id}', fn($p) => api_track(api_user(), (int) $p['id'])],
    ['POST', '/bibliothek/frisch', fn() => api_bibliothek_frisch(api_user())],
    ['GET', '/editionen/{id}/tracks', function ($p) {
        $u = api_user();
        return ['tracks' => edition_tracks((int) $p['id'], (int) $u['id'])];
    }],
    ['GET', '/suche', fn() => api_suche(api_user())],
    ['GET', '/genres', function () {
        api_user();
        return ['genres' => api_genres(), 'familien' => api_genre_familien()];
    }],
    ['GET', '/sync/aenderungen', function () {
        api_user();
        return api_aenderungen();
    }],

    // Wiedergabe & Bilder
    ['GET', '/stream/kette', function () {
        lueckenlos_kette_senden(api_user_medien(), (string) ($_GET['ids'] ?? ''), (string) ($_GET['q'] ?? 'opus256'), max(0.0, (float) ($_GET['t'] ?? 0)), (string) ($_GET['g'] ?? ''));
    }],
    ['GET', '/stream/{id}', function ($p) {
        stream_senden(api_user_medien(), (int) $p['id']);
        return null;
    }],
    // Direktzugang im Heimnetz
    ['GET', '/ping', function () {
        // Ohne Anmeldung, ohne Datenbank: die App prüft damit, ob die Direktadresse antwortet
        header('Cache-Control: no-store');
        // Name und öffentliche Adresse: damit findet und verbindet sich der Windows-Client im Heimnetz von selbst
        $k = konfig();
        // client_protokoll: Schnittstellen-Stand für den Windows-Client (bei unverträglichen Änderungen hochzählen)
        return ['ok' => true, 'app' => 'amberwave', 'version' => app_version(), 'client_protokoll' => 1,
            'name' => $k['server_name'] !== '' ? $k['server_name'] : (gethostname() ?: 'Amberwave'), 'url' => $k['app_url']];
    }],
    ['GET', '/direkt/token', function () {
        $u = api_user();
        $url = direkt_url();
        return $url === '' ? ['url' => null] : ['url' => $url] + direkt_token($u);
    }],
    ['GET', '/admin/region', function () {
        api_user(true);
        return json_decode(region_auswahl_json(), true);
    }],
    ['PUT', '/admin/region', function () {
        api_user(true);
        [$o, $f] = region_pruefen((array) api_wert('region', []));
        if ($f) {
            throw new ApiFehler(implode(' ', $f));
        }
        if (!region_speichern($o)) {
            throw new ApiFehler(t('Die Region lässt sich nicht speichern (Ordner für Geheimnisse nicht beschreibbar).'));
        }
        return ['ok' => true];
    }],
    ['GET', '/admin/direktzugang', function () {
        api_user(true);
        return direkt_stand();
    }],
    ['GET', '/admin/tunnel', function () {
        require_once __DIR__ . '/../includes/tunnel.php';
        return api_tunnel_stand(api_user(true));
    }],
    ['POST', '/admin/tunnel/einrichten', function () {
        require_once __DIR__ . '/../includes/tunnel.php';
        return api_tunnel_einrichten(api_user(true));
    }],
    ['POST', '/admin/proxy', function () {
        api_user(true);
        return api_admin_proxy();
    }],
    ['POST', '/admin/tunnel/entfernen', function () {
        require_once __DIR__ . '/../includes/tunnel.php';
        return api_tunnel_entfernen(api_user(true));
    }],
    ['GET', '/admin/tunnel/liste', function () {
        require_once __DIR__ . '/../includes/tunnel.php';
        return api_tunnel_liste(api_user(true));
    }],
    ['POST', '/admin/tunnel/proxy', function () {
        require_once __DIR__ . '/../includes/tunnel.php';
        return api_tunnel_proxy(api_user(true));
    }],
    ['POST', '/admin/direktzugang/token', function () {
        api_user(true);
        $t = trim((string) api_wert('token', ''));
        if ($t === '') {
            einstellung_loeschen('direkt_cf_token');
            return direkt_stand();
        }
        try {
            cf_token_pruefen($t);
            $zonen = cf_zonen($t);
        } catch (CfFehler $e) {
            throw new ApiFehler($e->getMessage());
        }
        einstellung_setzen('direkt_cf_token', $t);
        return direkt_stand() + ['zonen' => array_column($zonen, 'name')];
    }],
    ['GET', '/admin/direktzugang/zonen', function () {
        api_user(true);
        $t = einstellung('direkt_cf_token');
        if ($t === '') {
            throw new ApiFehler(t('Kein Token eingetragen.'));
        }
        try {
            cf_token_pruefen($t);
            return ['zonen' => array_column(cf_zonen($t), 'name')];
        } catch (CfFehler $e) {
            throw new ApiFehler($e->getMessage());
        }
    }],
    ['POST', '/admin/direktzugang/einrichten', function () {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        $host = strtolower(trim((string) api_wert('host', '')));
        $ip = trim((string) api_wert('ip', ''));
        $port = (int) api_wert('port', 8443);
        $email = trim((string) api_wert('email', ''));
        if (!preg_match('/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/', $host)) {
            throw new ApiFehler(t('Bitte einen gültigen Namen angeben, z. B. lokal.musik.example.de.'));
        }
        if (!filter_var($ip, FILTER_VALIDATE_IP)) {
            throw new ApiFehler(t('Bitte die IP-Adresse des Servers im Heimnetz angeben, z. B. 192.168.1.10.'));
        }
        if ($port < 1 || $port > 65535) {
            throw new ApiFehler(t('Ungültiger Port.'));
        }
        if ((int) getenv('APP_PORT') === $port) {
            throw new ApiFehler(t('Port {port} ist schon der normale (HTTP-)Port der App. Für den Direktzugang einen eigenen Port nehmen, z. B. 8443 – im Stack als „{port}“ daneben eine zweite Zeile „8443:8443“.', ['port' => $port]));
        }
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new ApiFehler(t('Die E-Mail-Adresse ist ungültig.'));
        }
        einstellung_setzen('direkt_email', $email);
        return direkt_einrichten($host, $ip, $port);
    }],
    ['POST', '/admin/direktzugang/erneuern', function () {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        @set_time_limit(600);
        $m = direkt_erneuern_wenn_noetig(true);
        if ($m && !str_starts_with($m, 'Zertifikat erneuert')) {
            throw new ApiFehler($m);
        }
        direkt_neuladen_abwarten();
        return direkt_stand();
    }],
    ['POST', '/admin/direktzugang/auto', function () {
        api_user(true);
        einstellung_setzen('direkt_auto', api_wert('an', true) ? '1' : '0');
        return direkt_stand();
    }],
    // Lautheit (EBU R128): Messwerte für den Player und Stand der Analyse für die Verwaltung
    ['GET', '/lautheit', function () {
        api_user();
        $k = konfig()['lautheit'];
        return ['tracks' => (object) lh_fuer_tracks(explode(',', (string) ($_GET['ids'] ?? ''))), 'ziel' => $k['ziel'], 'decke' => $k['decke']];
    }],
    ['GET', '/tracks/{id}/nerd', function ($p) {
        api_user();
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close(); // eine Nachmessung soll andere Anfragen nicht blockieren
        }
        return lh_nerd((int) $p['id']);
    }],
    ['GET', '/admin/lautheit', function () {
        api_user(true);
        return lh_stand();
    }],
    ['POST', '/admin/lautheit/neu', function () {
        api_user(true);
        // nur_fehler: nur fehlgeschlagene Messungen wiederholen; sonst alles neu messen
        if (api_wert('nur_fehler', false)) {
            db_tun("UPDATE dateien SET lautheit_am = NULL, lautheit_fehler = '' WHERE lautheit_fehler <> ''");
        } else {
            db_tun("UPDATE dateien SET lautheit_am = NULL, lautheit_fehler = ''");
            db_tun('UPDATE editionen SET album_lautheit_am = NULL');
        }
        return lh_stand();
    }],
    // Verlustfreie Titel (WAV, AIFF, ALAC) in FLAC umwandeln: Album oder ganze Bibliothek, als Hintergrundauftrag
    ['GET', '/admin/flac', function () {
        api_user(true);
        require_once __DIR__ . '/../includes/zuflac.php';
        auftrag_anstossen('flac');
        // Nur der Stand des Auftrags (Beobachter im Hintergrund, ohne die Bibliothek zu durchsuchen)
        if (!empty($_GET['stand'])) return ['auftrag' => auftrag_aussen('flac')];
        $e = (int) ($_GET['edition'] ?? 0);
        return zf_stand($e > 0 ? $e : null);
    }],
    ['POST', '/admin/flac/start', function () {
        api_user(true);
        require_once __DIR__ . '/../includes/zuflac.php';
        $e = (int) api_wert('edition_id', 0);
        zf_starten($e > 0 ? $e : null);
        return zf_stand($e > 0 ? $e : null);
    }],
    ['POST', '/admin/flac/anhalten', function () {
        api_user(true);
        require_once __DIR__ . '/../includes/zuflac.php';
        auftrag_anhalten('flac');
        return zf_stand();
    }],
    // Dateien aufräumen: Tags/Cover schreiben, umbenennen, Müll – immer erst Vorschau, dann Freigabe
    ['GET', '/admin/aufraeumen', function () {
        api_user(true);
        auftrag_anstossen('vorschau');
        return af_stand() + ['auftrag' => auftrag_aussen('vorschau')];
    }],
    ['POST', '/admin/aufraeumen/vorschau/anhalten', function () {
        api_user(true);
        auftrag_anhalten('vorschau');
        return af_stand() + ['auftrag' => auftrag_aussen('vorschau')];
    }],
    ['POST', '/admin/aufraeumen/vorschau', function () {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        $ed = (int) api_wert('edition_id', 0);
        if ($ed > 0) {
            if (!db_wert("SELECT id FROM editionen WHERE id = :e AND anzahl_dateien > 0", ['e' => $ed])) {
                throw new ApiFehler(t('Album nicht gefunden.'), 404);
            }
            af_plan_erstellen($ed);
            return ['ok' => true, 'edition_id' => $ed];
        }
        // Vorschau für alle: als Auftrag auf dem Server (läuft weiter, auch wenn die Seite zu ist)
        auftrag_vorschau_starten((bool) api_wert('neu', false));
        return af_stand() + ['auftrag' => auftrag_aussen('vorschau')];
    }],
    ['GET', '/admin/aufraeumen/debug', function () {
        api_user(true);
        $datei = af_debug_pfad();
        $text = is_file($datei) ? (string) file_get_contents($datei) : '';
        $zeilen = $text === '' ? [] : array_slice(explode("\n", trim($text)), -200);
        return ['zeilen' => $zeilen, 'pfad' => $datei, 'leer' => $zeilen === []];
    }],
    ['GET', '/admin/aufraeumen/{id}', function ($p) {
        api_user(true);
        $z = db_zeile("SELECT p.*, e.album_id, a.titel AS album_titel, COALESCE(c.anzeige, '') AS kuenstler FROM aufraeum_plaene p JOIN editionen e ON e.id = p.edition_id
            JOIN alben a ON a.id = e.album_id LEFT JOIN credits c ON c.id = a.credit_id WHERE p.edition_id = :e", ['e' => (int) $p['id']]);
        if (!$z) {
            throw new ApiFehler(t('Keine Vorschau vorhanden.'), 404);
        }
        return ['edition_id' => (int) $z['edition_id'], 'album_id' => (int) $z['album_id'], 'album_titel' => $z['album_titel'], 'kuenstler' => $z['kuenstler'],
            'status' => $z['status'], 'zusammenfassung' => $z['zusammenfassung'], 'aenderungen' => (int) $z['aenderungen'], 'log' => $z['log'],
            'plan' => json_decode((string) $z['plan_json'], true), 'erstellt_am' => $z['erstellt_am'], 'ausgefuehrt_am' => $z['ausgefuehrt_am']];
    }],
    ['POST', '/admin/aufraeumen/freigeben', function () {
        $u = api_user(true);
        $ids = array_values(array_filter(array_map('intval', (array) api_wert('edition_ids', []))));
        $alle = (bool) api_wert('alle', false);
        $stand = af_plan_stand();
        // Veraltete Vorschauen unter den gewählten erst neu rechnen, damit die Freigabe nicht still ins Leere läuft
        $veraltet = $alle
            ? db_alle("SELECT p.edition_id FROM aufraeum_plaene p JOIN editionen e ON e.id = p.edition_id WHERE p.status = 'offen' AND p.aenderungen > 0 AND p.stand <> :st AND e.mbid IS NOT NULL AND e.mbid <> ''", ['st' => $stand])
            : ($ids ? (function () use ($ids, $stand) { [$in, $pp] = db_in($ids, 'e'); return db_alle("SELECT edition_id FROM aufraeum_plaene WHERE status = 'offen' AND stand <> :st AND edition_id IN {$in}", $pp + ['st' => $stand]); })() : []);
        $neu = 0;
        foreach ($veraltet as $v) {
            try { af_plan_erstellen((int) $v['edition_id']); $neu++; } catch (Throwable $e) { /* wird unten als nicht freigegeben sichtbar */ }
        }
        if ($alle) {
            // Alben ohne MusicBrainz-Abgleich bleiben außen vor (Namen nur aus Tags) – die gibt man einzeln frei
            $betroffen = db_tun("UPDATE aufraeum_plaene p JOIN editionen e ON e.id = p.edition_id SET p.status = 'freigegeben', p.freigegeben_am = NOW()
                WHERE p.status = 'offen' AND p.aenderungen > 0 AND p.stand = :st AND e.mbid IS NOT NULL AND e.mbid <> ''", ['st' => $stand]);
        } elseif ($ids) {
            [$in, $pp] = db_in($ids, 'e');
            $betroffen = db_tun("UPDATE aufraeum_plaene SET status = 'freigegeben', freigegeben_am = NOW() WHERE status = 'offen' AND aenderungen > 0 AND stand = :st AND edition_id IN {$in}", $pp + ['st' => $stand]);
        } else {
            $betroffen = 0;
        }
        af_log('Freigabe geklickt', ['alle' => $alle, 'editionen' => $ids, 'veraltet_neu_gerechnet' => $neu, 'auf_freigegeben_gesetzt' => $betroffen]);
        if ($betroffen === 0 && $neu === 0) {
            af_log('Hinweis: kein Plan wurde freigegeben – keine Änderungen vorhanden?');
        }
        log_sicherheitsereignis((int) $u['id'], 'dateien_aufraeumen', $alle ? 'alle' : implode(',', $ids));
        af_anstossen();
        usleep(300000);
        return af_stand() + ['neu_gerechnet' => $neu];
    }],
    ['POST', '/admin/aufraeumen/verwerfen', function () {
        api_user(true);
        $ids = array_values(array_filter(array_map('intval', (array) api_wert('edition_ids', []))));
        if ($ids) {
            [$in, $pp] = db_in($ids, 'e');
            db_tun("DELETE FROM aufraeum_plaene WHERE status IN ('offen', 'fertig', 'fehler') AND edition_id IN {$in}", $pp);
        }
        return af_stand();
    }],
    ['POST', '/admin/aufraeumen/rechte', function () {
        $u = api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        $r = af_rechte_reparieren();
        log_sicherheitsereignis((int) $u['id'], 'rechte_repariert', t('{n} geändert', ['n' => $r['geaendert']]));
        return $r;
    }],
    ['POST', '/admin/aufraeumen/papierkorb-leeren', function () {
        $u = api_user(true);
        $n = af_papierkorb_leeren(true);
        log_sicherheitsereignis((int) $u['id'], 'papierkorb_geleert', $n . ' Dateien');
        return ['geloescht' => $n] + af_stand();
    }],
    // Erkennung am Klang (Fingerabdruck → AcoustID → MusicBrainz)
    ['GET', '/admin/erkennung', function () {
        api_user(true);
        return erk_stand();
    }],
    ['POST', '/admin/erkennung/start', function () {
        api_user(true);
        erk_anstossen();
        usleep(300000);
        return erk_stand();
    }],
    ['POST', '/admin/erkennung/neu', function () {
        api_user(true);
        erk_neu(api_wert('was', 'unsicher') === 'alle' ? 'alle' : 'unsicher');
        erk_anstossen();
        return erk_stand();
    }],
    // Auf Wunsch am Klang erkennen (AcoustID): ein Album oder alle, bei denen die Tags nicht gereicht haben
    ['POST', '/admin/erkennung/{id}/klang', function ($p) {
        api_user(true);
        erk_klang_anfordern([(int) $p['id']]);
        erk_anstossen();
        return erk_stand();
    }],
    ['POST', '/admin/erkennung/klang', function () {
        api_user(true);
        erk_klang_alle_anfordern();
        erk_anstossen();
        return erk_stand();
    }],
    ['POST', '/admin/erkennung/{id}/ignorieren', function ($p) {
        api_user(true);
        db_tun("UPDATE erkennung SET status = 'ignoriert' WHERE edition_id = :e", ['e' => (int) $p['id']]);
        return erk_stand();
    }],
    ['POST', '/admin/erkennung/{id}/erledigt', function ($p) {
        api_user(true);
        db_tun("UPDATE erkennung SET status = 'bestaetigt' WHERE edition_id = :e", ['e' => (int) $p['id']]);
        return erk_stand();
    }],
    // Radio, das aus dem Hören lernt: {saat: null | {art: track|album|kuenstler, id}, ausschluss: [track_ids], anzahl}
    ['POST', '/radio', function () {
        $u = api_user();
        $saat = api_wert('saat', null);
        $saat = is_array($saat) && in_array($saat['art'] ?? '', ['track', 'klang', 'album', 'kuenstler', 'jahrzehnt', 'genre', 'familie'], true) ? ['art' => $saat['art'], 'id' => (int) ($saat['id'] ?? 0)] : null;
        if ($saat && $saat['art'] === 'familie') {
            // Familie (Pop, Elektro …): der Schlüssel kommt als Text in „id“
            $roh = api_wert('saat', null);
            $key = (string) ($roh['id'] ?? '');
            $saat = isset(GENRE_FAMILIEN[$key]) ? ['art' => 'familie', 'id' => 0, 'familie' => $key] : null;
        }
        $aus = api_wert('ausschluss', []);
        return radio_mix($u, $saat, is_array($aus) ? array_slice(array_map('intval', $aus), 0, 2000) : [], max(5, min(50, (int) api_wert('anzahl', 25))));
    }],
    // WAV-Export (Playlist/Warteschlange/Album als eine lange Datei, z. B. fürs Mischpult)
    ['GET', '/export', function () {
        $u = api_user();
        return ['exporte' => array_map('export_objekt', db_alle('SELECT * FROM exporte WHERE user_id = :u ORDER BY erstellt_am DESC LIMIT 20', ['u' => $u['id']]))];
    }],
    ['POST', '/export', function () {
        $u = api_user();
        if (!konfig()['stream']['downloads_erlaubt'] && !ist_admin($u)) {
            throw new ApiFehler(t('Downloads sind auf diesem Server nicht freigegeben (DOWNLOADS_ERLAUBT).'), 403);
        }
        $art = (string) api_wert('art', '');
        $optionen = api_wert('optionen', []);
        $optionen = is_array($optionen) ? $optionen : [];
        if ($art === 'playlist') {
            $pl = playlist_laden($u, (int) api_wert('id', 0));
            $ids = array_map('intval', array_column(db_alle('SELECT track_id FROM playlist_eintraege WHERE playlist_id = :p ORDER BY pos, id', ['p' => $pl['id']]), 'track_id'));
            return export_anlegen($u, (string) api_wert('name', $pl['name']), t('Playlist „{name}“', ['name' => $pl['name']]), $ids, $optionen);
        }
        if ($art === 'tracks') {
            $ids = api_wert('track_ids', []);
            return export_anlegen($u, (string) api_wert('name', t('Warteschlange')), (string) api_wert('quelle', t('Warteschlange')), is_array($ids) ? $ids : [], $optionen);
        }
        throw new ApiFehler(t('Unbekannte Quelle.'));
    }],
    ['GET', '/export/{id}', fn($p) => export_objekt(export_laden(api_user(), (int) $p['id']))],
    ['DELETE', '/export/{id}', function ($p) {
        $z = export_laden(api_user(), (int) $p['id']);
        export_loeschen((int) $z['id']);
        return ['ok' => true];
    }],
    ['GET', '/export/{id}/datei/{nr}', function ($p) {
        $z = export_laden(api_user_medien(), (int) $p['id']);
        $teile = json_decode((string) $z['teile'], true) ?: [];
        $nr = (int) $p['nr'];
        $pfad = export_ordner() . '/' . (int) $z['id'] . '-' . $nr . '.wav';
        if ($z['status'] !== 'fertig' || !isset($teile[$nr - 1]) || !is_file($pfad)) {
            throw new ApiFehler(t('Datei nicht (mehr) vorhanden.'), 404);
        }
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        set_time_limit(0);
        datei_mit_range_senden($pfad, 'audio/wav', $teile[$nr - 1]['name']);
        exit;
    }],
    ['GET', '/export/{id}/titelliste', function ($p) {
        $z = export_laden(api_user_medien(), (int) $p['id']);
        if (!$z['titelliste']) {
            throw new ApiFehler(t('Noch keine Titelliste.'), 404);
        }
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . export_dateiname($z['name']) . ' - ' . t('Titelliste') . '.txt"');
        echo "\u{FEFF}" . str_replace("\n", "\r\n", $z['titelliste']);
        exit;
    }],
    // Aktivität: Player melden, was sie spielen; die Verwaltung zeigt es an
    ['POST', '/status', fn() => aktivitaet_melden(api_user())],
    // Fernsteuerung (Geräte steuern sich gegenseitig)
    ['GET', '/fern/strom', fn() => fern_strom(api_user())],
    ['GET', '/fern/geraete', fn() => fern_geraete(api_user())],
    ['POST', '/fern/verbinden', fn() => fern_verbinden(api_user())],
    ['POST', '/fern/befehl', fn() => fern_befehl(api_user())],
    ['POST', '/fern/zustand', fn() => fern_zustand_melden(api_user())],
    ['POST', '/fern/weg', fn() => fern_weg(api_user())],
    // Geräte im Heimnetz (DLNA): Stream für das Gerät (ohne Anmeldung, signierter Schlüssel) und Verwaltung (Admins)
    ['GET', '/heim/s/{token}', function ($p) {
        hn_stream_senden((string) $p['token']);
        return null;
    }],
    ['GET', '/heimnetz', fn() => api_heimnetz(api_user(true))],
    ['POST', '/heimnetz/suchen', fn() => api_heimnetz_suchen(api_user(true))],
    ['PUT', '/heimnetz/basis', fn() => api_heimnetz_basis(api_user(true))],
    ['PUT', '/heimnetz/cast', fn() => api_heimnetz_cast(api_user(true))],
    ['GET', '/admin/dienste/anfragen', function () {
        require_once __DIR__ . '/../includes/dienste.php';
        return api_dienste_anfragen(api_user(true));
    }],
    ['GET', '/admin/datenbank', fn() => api_datenbank_info(api_user(true))],
    ['POST', '/admin/datenbank/zeigen', fn() => api_datenbank_zeigen(api_user(true))],
    ['POST', '/admin/datenbank/passwort', fn() => api_datenbank_passwort(api_user(true))],
    ['POST', '/heimnetz/geraete', fn() => api_heimnetz_hinzufuegen(api_user(true))],
    ['PUT', '/heimnetz/geraete/{id}', fn($p) => api_heimnetz_aendern(api_user(true), (int) $p['id'])],
    ['DELETE', '/heimnetz/geraete/{id}', fn($p) => api_heimnetz_loeschen(api_user(true), (int) $p['id'])],
    ['POST', '/heimnetz/geraete/{id}/pruefen', fn($p) => api_heimnetz_pruefen(api_user(true), (int) $p['id'])],
    ['POST', '/heimnetz/geraete/{id}/klang', fn($p) => api_heimnetz_klang(api_user(true), (int) $p['id'])],
    ['POST', '/heimnetz/geraete/{id}/space', fn($p) => api_heimnetz_space_neu(api_user(true), (int) $p['id'])],
    ['POST', '/heimnetz/raum', fn() => api_heimnetz_raum(api_user(true))],
    ['POST', '/heimnetz/geraete/{id}/tonmodus', fn($p) => api_heimnetz_tonmodus(api_user(true), (int) $p['id'])],
    ['GET', '/admin/aktivitaet', function () {
        api_user(true);
        return aktivitaet_liste();
    }],
    ['POST', '/admin/direktzugang/aus', function () {
        api_user(true);
        return direkt_abschalten((bool) api_wert('dns_loeschen', false));
    }],

    // Raumklang: Impulsantworten für den Hall
    ['GET', '/raumklang/irs', function () {
        api_user();
        return raumklang_liste();
    }],
    ['GET', '/raumklang/ir', function () {
        api_user_medien();
        raumklang_senden((string) ($_GET['id'] ?? ''));
        return null;
    }],
    ['POST', '/admin/raumklang/voxengo', function () {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        @set_time_limit(300);
        return raumklang_voxengo_laden();
    }],
    ['POST', '/raumklang/ir', function () {
        $u = api_user();
        if (!konfig()['raumklang']['upload_alle'] && !ist_admin($u)) {
            throw new ApiFehler(t('Eigene Impulsantworten darf nur ein Admin hochladen.'), 403);
        }
        return raumklang_hochladen($u);
    }],
    ['POST', '/admin/raumklang/ir', function () {
        return raumklang_hochladen(api_user(true));
    }],
    ['DELETE', '/admin/raumklang/ir', function () {
        api_user(true);
        return raumklang_loeschen((string) ($_GET['id'] ?? ''));
    }],
    ['GET', '/download/{id}', function ($p) {
        $u = api_user_medien(); // auch mit Stream-Schlüssel – so laufen Downloads zuhause über die schnelle Direktadresse
        if (!konfig()['stream']['downloads_erlaubt'] && !ist_admin($u)) {
            throw new ApiFehler(t('Downloads sind ausgeschaltet.'), 403);
        }
        [$pfad, $d] = stream_datei((int) $p['id']);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        datei_mit_range_senden($pfad, AUDIO_MIME[$d['format']] ?? 'application/octet-stream', basename($pfad));
        return null;
    }],
    ['GET', '/bild/cover/{schluessel}', function ($p) {
        api_bild_zugang('cover', (string) $p['schluessel']);
        bild_senden('cover', $p['schluessel']);
        return null;
    }],
    ['GET', '/bild/kuenstler/{schluessel}', function ($p) {
        api_bild_zugang('kuenstler', (string) $p['schluessel']);
        bild_senden('kuenstler', $p['schluessel']);
        return null;
    }],
    ['GET', '/bild/profil/{schluessel}', function ($p) {
        api_bild_zugang('profil', (string) $p['schluessel']);
        bild_senden('profil', $p['schluessel']);
        return null;
    }],
    ['POST', '/wiedergabe', fn() => api_wiedergabe(api_user())],
    ['GET', '/verlauf', fn() => api_verlauf(api_user())],
    ['GET', '/warteschlange', fn() => api_warteschlange_lesen(api_user())],
    ['PUT', '/warteschlange', fn() => api_warteschlange_schreiben(api_user())],
    ['GET', '/netz', function () {
        api_user();
        return api_netz();
    }],
    ['GET', '/geraet/einstellungen', fn() => api_geraet_einstellungen_lesen(api_user())],
    ['PUT', '/geraet/einstellungen', fn() => api_geraet_einstellungen_schreiben(api_user())],

    // Favoriten & Playlists
    ['GET', '/favoriten', fn() => api_favoriten(api_user())],
    ['POST', '/favoriten', fn() => api_favorit_setzen(api_user())],
    ['GET', '/presets', fn() => api_presets(api_user())],
    ['POST', '/presets', fn() => api_preset_anlegen(api_user())],
    ['PUT', '/presets/{id}', fn($p) => api_preset_aendern(api_user(), (int) $p['id'])],
    ['DELETE', '/presets/{id}', fn($p) => api_preset_loeschen(api_user(), (int) $p['id'])],
    ['GET', '/playlists', fn() => api_playlists(api_user())],
    ['POST', '/playlists', fn() => api_playlist_anlegen(api_user())],
    ['GET', '/playlists/{id}', function ($p) {
        $u = api_user();
        return playlist_objekt(playlist_laden($u, (int) $p['id']), $u, true);
    }],
    ['PUT', '/playlists/{id}', fn($p) => api_playlist_aendern(api_user(), (int) $p['id'])],
    ['DELETE', '/playlists/{id}', function ($p) {
        $u = api_user();
        $pl = playlist_laden($u, (int) $p['id'], true);
        if ((int) $pl['user_id'] !== (int) $u['id'] && !ist_admin($u)) {
            throw new ApiFehler(t('Nur eigene Playlists können gelöscht werden.'), 403);
        }
        db_tun('DELETE FROM playlists WHERE id = :id', ['id' => $pl['id']]);
        return ['ok' => true];
    }],
    ['POST', '/playlists/{id}/tracks', function ($p) {
        $u = api_user();
        $pl = playlist_laden($u, (int) $p['id'], true);
        $n = playlist_tracks_hinzu((int) $pl['id'], array_map('intval', (array) api_wert('track_ids', [])));
        return ['ok' => true, 'hinzugefuegt' => $n];
    }],
    ['DELETE', '/playlists/{id}/eintraege/{eintrag}', function ($p) {
        $u = api_user();
        $pl = playlist_laden($u, (int) $p['id'], true);
        db_tun('DELETE FROM playlist_eintraege WHERE id = :e AND playlist_id = :p', ['e' => (int) $p['eintrag'], 'p' => $pl['id']]);
        db_tun('UPDATE playlists SET aktualisiert_am = NOW() WHERE id = :p', ['p' => $pl['id']]);
        return ['ok' => true];
    }],

    // Profil
    ['GET', '/profil', fn() => api_profil(api_user())],
    ['PUT', '/profil', function () {
        $u = api_user();
        // Nur, was mitgeschickt wird: mail_info, vorname, nachname
        if (api_wert('mail_info') !== null) {
            db_tun('UPDATE users SET mail_info = :m WHERE id = :id', ['m' => api_wert('mail_info') ? 1 : 0, 'id' => $u['id']]);
        }
        if (api_wert('sprache') !== null) {
            $sp = (string) api_wert('sprache');
            db_tun('UPDATE users SET sprache = :s WHERE id = :id', ['s' => isset(SPRACHEN[$sp]) ? $sp : null, 'id' => $u['id']]);
        }
        if (api_wert('vorname') !== null || api_wert('nachname') !== null) {
            $vor = trim((string) api_wert('vorname', $u['vorname']));
            $nach = trim((string) api_wert('nachname', $u['nachname']));
            if ($vor === '') {
                throw new ApiFehler(t('Der Vorname darf nicht leer sein.'));
            }
            if (mb_strlen($vor) > 100 || mb_strlen($nach) > 100) {
                throw new ApiFehler(t('Der Name ist zu lang (höchstens 100 Zeichen).'));
            }
            db_tun('UPDATE users SET vorname = :v, nachname = :n WHERE id = :id', ['v' => $vor, 'n' => $nach, 'id' => $u['id']]);
            log_sicherheitsereignis((int) $u['id'], 'name_geaendert');
        }
        return api_profil(db_zeile('SELECT * FROM users WHERE id = :id', ['id' => $u['id']]));
    }],
    ['POST', '/profil/bild', function () {
        $u = api_user();
        require_once __DIR__ . '/../includes/bilder.php';
        if (empty($_FILES['bild']['tmp_name']) || ($_FILES['bild']['error'] ?? 1) !== UPLOAD_ERR_OK) {
            throw new ApiFehler(t('Bitte ein Bild auswählen (JPG, PNG oder WebP).'));
        }
        if ((int) $_FILES['bild']['size'] > 15 * 1024 * 1024) {
            throw new ApiFehler(t('Das Bild ist zu groß (höchstens 15 MB).'));
        }
        $s = profilbild_speichern((int) $u['id'], (string) file_get_contents((string) $_FILES['bild']['tmp_name']));
        if (!$s) {
            throw new ApiFehler(t('Das Bild konnte nicht gelesen werden (JPG, PNG oder WebP, mindestens 32 × 32 Pixel).'));
        }
        if (($u['bild'] ?? '') !== '' && $u['bild'] !== $s) {
            bild_loeschen('profil', (string) $u['bild']);
        }
        db_tun('UPDATE users SET bild = :b WHERE id = :id', ['b' => $s, 'id' => $u['id']]);
        return api_profil(db_zeile('SELECT * FROM users WHERE id = :id', ['id' => $u['id']]));
    }],
    ['DELETE', '/profil/bild', function () {
        $u = api_user();
        require_once __DIR__ . '/../includes/bilder.php';
        if (($u['bild'] ?? '') !== '') {
            bild_loeschen('profil', (string) $u['bild']);
        }
        db_tun("UPDATE users SET bild = '' WHERE id = :id", ['id' => $u['id']]);
        return api_profil(db_zeile('SELECT * FROM users WHERE id = :id', ['id' => $u['id']]));
    }],
    ['PUT', '/profil/geraete/{id}', function ($p) {
        $u = api_user();
        $name = trim(preg_replace('/\s+/u', ' ', (string) api_wert('name', '')));
        if (mb_strlen($name) > 80) {
            throw new ApiFehler(t('Der Name ist zu lang (höchstens 80 Zeichen).'));
        }
        $n = db_tun('UPDATE nutzer_geraete SET eigener_name = :n WHERE id = :id AND user_id = :u AND beendet_am IS NULL',
            ['n' => $name === '' ? null : $name, 'id' => (int) $p['id'], 'u' => $u['id']]);
        if (!db_wert('SELECT id FROM nutzer_geraete WHERE id = :id AND user_id = :u AND beendet_am IS NULL', ['id' => (int) $p['id'], 'u' => $u['id']])) {
            throw new ApiFehler(t('Gerät nicht gefunden.'), 404);
        }
        return api_profil(db_zeile('SELECT * FROM users WHERE id = :id', ['id' => $u['id']]));
    }],
    ['POST', '/profil/passwort', fn() => api_passwort_aendern(api_user())],
    ['DELETE', '/profil/geraete/{id}', function ($p) {
        $u = api_user();
        if (!geraet_beenden((int) $u['id'], (int) $p['id'])) {
            throw new ApiFehler(t('Gerät nicht gefunden.'), 404);
        }
        return ['ok' => true];
    }],

    // Verwaltung (nur Admin)
    ['GET', '/admin/uebersicht', function () {
        api_user(true);
        return api_admin_uebersicht();
    }],
    ['GET', '/admin/scan', function () {
        api_user(true);
        return api_admin_scan_status();
    }],
    ['POST', '/admin/scan', fn() => api_admin_scan_starten(api_user(true))],
    ['POST', '/admin/scan/{id}/abbrechen', function ($p) {
        api_user(true);
        db_tun("UPDATE scan_laeufe SET status = 'abgebrochen' WHERE id = :id AND status IN ('wartet','laeuft')", ['id' => (int) $p['id']]);
        return ['ok' => true];
    }],
    ['GET', '/admin/dateien', function () {
        api_user(true);
        return api_admin_dateien_probleme();
    }],
    ['GET', '/admin/konten', function () {
        api_user(true);
        return api_admin_konten();
    }],
    ['POST', '/admin/konten', fn() => api_admin_konto_anlegen(api_user(true))],
    ['PUT', '/admin/konten/{id}', fn($p) => api_admin_konto_aendern(api_user(true), (int) $p['id'])],
    ['DELETE', '/admin/konten/{id}', fn($p) => api_admin_konto_loeschen(api_user(true), (int) $p['id'])],
    ['POST', '/admin/konten/{id}/{aktion}', fn($p) => api_admin_konto_aktion(api_user(true), (int) $p['id'], (string) $p['aktion'])],
    ['GET', '/admin/einstellungen', function () {
        api_user(true);
        return api_admin_einstellungen();
    }],
    ['PUT', '/admin/einstellungen', fn() => api_admin_einstellungen_speichern(api_user(true))],
    ['POST', '/admin/mailtest', fn() => api_admin_mailtest(api_user(true))],
    ['GET', '/admin/sicherheitslog', function () {
        api_user(true);
        return api_admin_sicherheitslog();
    }],
    ['PUT', '/admin/alben/{id}/edition', fn($p) => api_admin_album_edition(api_user(true), (int) $p['id'])],
    ['POST', '/admin/update', fn() => api_admin_update(api_user(true))],
    ['GET', '/admin/system', function () {
        api_user(true);
        return einr_festlegungen();
    }],
    ['GET', '/admin/sicherungen', function () {
        api_user(true);
        return api_admin_sicherungen();
    }],
    ['POST', '/admin/sicherungen', fn() => api_admin_sicherung_jetzt(api_user(true))],
    ['DELETE', '/admin/sicherungen', fn() => api_admin_sicherung_loeschen(api_user(true))],
    ['GET', '/admin/sicherungen/datei', function () {
        api_user(true);
        api_admin_sicherung_datei();
    }],
    ['POST', '/admin/sicherungen/wiederherstellen', fn() => api_admin_sicherung_wiederherstellen(api_user(true))],

    // Metadaten bearbeiten & MusicBrainz-Abgleich (nur Admin)
    ['GET', '/admin/alben', function () {
        api_user(true);
        return api_admin_alben();
    }],
    ['POST', '/admin/alben/markieren', fn() => (api_user(true) ? api_admin_alben_markieren() : null)],
    ['POST', '/admin/alben/luecken', function () {
        api_user(true);
        $ids = array_values(array_unique(array_filter(array_map('intval', (array) api_wert('ids', [])), static fn($i) => $i > 0)));
        if (!$ids) {
            throw new ApiFehler(t('Keine Alben ausgewählt.'), 422);
        }
        mj_starten('auswahl', array_slice($ids, 0, 2000));
        return ['auftrag' => mj_aussen()];
    }],
    ['GET', '/admin/alben/{id}', function ($p) {
        api_user(true);
        return api_admin_album_bearbeiten((int) $p['id']);
    }],
    ['PUT', '/admin/alben/{id}', fn($p) => api_admin_album_speichern(api_user(true), (int) $p['id'])],
    ['GET', '/admin/editionen/{id}', function ($p) {
        api_user(true);
        return api_admin_edition((int) $p['id']);
    }],
    ['PUT', '/admin/editionen/{id}', fn($p) => api_admin_edition_speichern(api_user(true), (int) $p['id'])],
    ['POST', '/admin/editionen/{id}/loeschen', fn($p) => api_admin_edition_loeschen(api_user(true), (int) $p['id'])],
    ['PUT', '/admin/editionen/{id}/tracks', fn($p) => api_admin_edition_tracks_speichern(api_user(true), (int) $p['id'])],
    ['GET', '/admin/tracks/{id}', function ($p) {
        api_user(true);
        return api_admin_track((int) $p['id']);
    }],
    ['PUT', '/admin/tracks/{id}', fn($p) => api_admin_track_speichern(api_user(true), (int) $p['id'])],
    // Fehlenden Titel aus einem anderen Album übernehmen (kopieren, benennen, umtaggen)
    ['GET', '/admin/tracks/{id}/uebernehmen', function ($p) {
        api_user(true);
        require_once __DIR__ . '/../includes/uebernehmen.php';
        return ue_kandidaten((int) $p['id'], (string) ($_GET['q'] ?? ''));
    }],
    ['POST', '/admin/tracks/{id}/uebernehmen', function ($p) {
        $u = api_user(true);
        require_once __DIR__ . '/../includes/uebernehmen.php';
        $r = ue_uebernehmen((int) $p['id'], (int) api_wert('quelle', 0));
        log_sicherheitsereignis((int) $u['id'], 'titel_uebernommen', (string) $r['pfad']);
        return $r;
    }],
    ['POST', '/admin/editionen/{id}/cover', fn($p) => api_admin_edition_cover(api_user(true), (int) $p['id'])],
    ['GET', '/admin/editionen/{id}/mb-suche', function ($p) {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close(); // Suche dauert einige Sekunden – andere Anfragen nicht blockieren
        }
        set_time_limit(180);
        return api_admin_mb_suche((int) $p['id']);
    }],
    ['GET', '/admin/editionen/{id}/mb-vergleich/{mbid}', function ($p) {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return api_admin_mb_vergleich((int) $p['id'], (string) $p['mbid']);
    }],
    // Wie der GET, aber mit von Hand angepasster Zuordnung im Body (zu lang für eine URL)
    ['POST', '/admin/editionen/{id}/mb-vergleich/{mbid}', function ($p) {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return api_admin_mb_vergleich((int) $p['id'], (string) $p['mbid']);
    }],
    ['POST', '/admin/editionen/{id}/mb-uebernehmen', function ($p) {
        $u = api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return api_admin_mb_uebernehmen($u, (int) $p['id']);
    }],
    ['POST', '/admin/editionen/{id}/mb-loesen', fn($p) => api_admin_mb_loesen(api_user(true), (int) $p['id'])],
    ['GET', '/admin/editionen/{id}/mitwirkende', function ($p) {
        api_user(true);
        return api_admin_mitwirkende((int) $p['id']);
    }],
    ['POST', '/admin/editionen/{id}/mitwirkende', fn($p) => api_admin_mitwirkend_anlegen(api_user(true), (int) $p['id'])],
    ['DELETE', '/admin/editionen/{id}/mitwirkende/{bez}', fn($p) => api_admin_mitwirkend_loeschen(api_user(true), (int) $p['id'], (int) $p['bez'])],
    ['GET', '/admin/kuenstler/{id}', function ($p) {
        api_user(true);
        return api_admin_kuenstler_bearbeiten((int) $p['id']);
    }],
    ['PUT', '/admin/kuenstler/{id}', fn($p) => api_admin_kuenstler_speichern(api_user(true), (int) $p['id'])],
    ['POST', '/admin/kuenstler/{id}/fanart', function ($p) {
        $u = api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return api_admin_kuenstler_fanart($u, (int) $p['id']);
    }],
    ['GET', '/admin/mb-cover/{mbid}', function ($p) {
        api_user(true);
        api_admin_mb_cover((string) $p['mbid']);
        exit;
    }],
    ['GET', '/admin/metadaten-abgleich', function () {
        api_user(true);
        mj_anstossen(); // falls der Prozess beendet wurde (z. B. Neustart), gleich weitermachen statt auf den Zeitplan zu warten
        return api_admin_metadaten_stand() + ['auftrag' => mj_aussen()];
    }],
    ['POST', '/admin/metadaten-abgleich/start', function () {
        api_user(true);
        mj_starten('alle', [], (bool) api_wert('neu'));
        return api_admin_metadaten_stand() + ['auftrag' => mj_aussen()];
    }],
    ['POST', '/admin/metadaten-abgleich/anhalten', function () {
        api_user(true);
        mj_anhalten();
        return api_admin_metadaten_stand() + ['auftrag' => mj_aussen()];
    }],
    ['GET', '/admin/fanart', function () {
        api_user(true);
        return api_admin_fanart_stand();
    }],
    ['GET', '/admin/klang', function () {
        api_user(true);
        kl_anstossen();
        return kl_stand();
    }],
    ['GET', '/admin/klang/qualitaet', function () {
        api_user(true);
        return kl_qualitaet() + kl_stichprobe(8);
    }],
    ['POST', '/admin/klang/installieren', function () {
        $admin = api_user(true);
        if (api_wert('lizenz') !== true) {
            throw new ApiFehler(t('Bitte zuerst die Lizenz bestätigen.'), 422);
        }
        kl_installation_starten($admin);
        return kl_stand();
    }],
    // Downloads (Prowlarr + SABnzbd)
    ['GET', '/admin/downloads', function () {
        api_user(true);
        require_once __DIR__ . '/../includes/downloads.php';
        return dl_stand();
    }],
    ['POST', '/admin/downloads/suche', function () {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        require_once __DIR__ . '/../includes/downloads.php';
        return dl_suchen((string) api_wert('q', ''), (string) api_wert('kuenstler', ''), (string) api_wert('album', ''));
    }],
    // Suchanbieter (Prowlarr, Newznab) und Downloadclients (SABnzbd-kompatibel) verwalten
    ['GET', '/admin/downloads/dienste', function () {
        api_user(true);
        require_once __DIR__ . '/../includes/downloads.php';
        return dl_dienste_fuer_oberflaeche();
    }],
    ['POST', '/admin/downloads/dienste', function () {
        $u = api_user(true);
        require_once __DIR__ . '/../includes/downloads.php';
        $r = dl_dienst_speichern((array) api_wert('dienst', []));
        log_sicherheitsereignis((int) $u['id'], 'einstellungen_geaendert', 'Download-Anbieter ' . (string) (api_wert('dienst', [])['art'] ?? ''));
        return $r;
    }],
    ['POST', '/admin/downloads/dienste/loeschen', function () {
        $u = api_user(true);
        require_once __DIR__ . '/../includes/downloads.php';
        $r = dl_dienst_loeschen((string) api_wert('art', ''), (int) api_wert('id', 0));
        log_sicherheitsereignis((int) $u['id'], 'einstellungen_geaendert', t('Download-Anbieter gelöscht'));
        return $r;
    }],
    ['POST', '/admin/downloads/dienste/test', function () {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        require_once __DIR__ . '/../includes/downloads.php';
        return dl_dienst_testen((array) api_wert('dienst', []));
    }],
    ['GET', '/admin/downloads/kuenstler', function () {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        require_once __DIR__ . '/../includes/downloads.php';
        return dl_mb_kuenstler((string) ($_GET['q'] ?? ''));
    }],
    ['GET', '/admin/downloads/kuenstler/{mbid}', function ($p) {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        require_once __DIR__ . '/../includes/downloads.php';
        return dl_mb_diskografie((string) $p['mbid']);
    }],
    ['POST', '/admin/downloads/holen', function () {
        $u = api_user(true);
        require_once __DIR__ . '/../includes/downloads.php';
        return dl_holen((string) api_wert('suche', ''), (int) api_wert('nr', -1), $u, (bool) api_wert('trotzdem', false), (string) api_wert('kuenstler', ''), (string) api_wert('album', ''));
    }],
    ['POST', '/admin/downloads/test', function () {
        api_user(true);
        require_once __DIR__ . '/../includes/downloads.php';
        return dl_testen();
    }],
    ['POST', '/admin/downloads/{id}/erneut', function ($p) {
        api_user(true);
        require_once __DIR__ . '/../includes/downloads.php';
        db_tun("UPDATE downloads SET status = 'fertig', fertig_am = NOW(), meldung = :m WHERE id = :id AND status = 'fehler' AND pfad_sab <> ''", ['m' => t('Import wird wiederholt'), 'id' => (int) $p['id']]);
        dl_import_anstossen();
        return dl_stand();
    }],
    ['POST', '/admin/downloads/{id}/entfernen', function ($p) {
        api_user(true);
        require_once __DIR__ . '/../includes/downloads.php';
        db_tun("DELETE FROM downloads WHERE id = :id AND status IN ('importiert', 'fehler')", ['id' => (int) $p['id']]);
        return dl_stand();
    }],
    // Sortier-Assistent (unsortierte Musik importieren)
    ['GET', '/admin/sortieren', function () {
        api_user(true);
        return api_sortieren(static fn() => srt_stand());
    }],
    ['POST', '/admin/sortieren/analyse', function () {
        api_user(true);
        return api_sortieren(static fn() => srt_analyse_starten());
    }],
    ['POST', '/admin/sortieren/ausfuehren', function () {
        api_user(true);
        return api_sortieren(static fn() => srt_ausfuehren_starten());
    }],
    ['POST', '/admin/sortieren/zuruecksetzen', function () {
        api_user(true);
        return api_sortieren(static function () {
            srt_eingriffe_zuruecksetzen();
            return srt_stand();
        });
    }],
    ['GET', '/admin/sortieren/liste/{rolle}', function ($p) {
        api_user(true);
        return api_sortieren(static fn() => srt_dateien_liste((string) $p['rolle'], max(1, (int) ($_GET['seite'] ?? 1))));
    }],
    ['GET', '/admin/sortieren/album/{id}', function ($p) {
        api_user(true);
        return api_sortieren(static fn() => srt_album_detail((int) $p['id']));
    }],
    ['POST', '/admin/sortieren/album/{id}', function ($p) {
        api_user(true);
        return api_sortieren(static function () use ($p) {
            if (api_wert('release') !== null) {
                srt_album_umhaengen((int) $p['id'], (string) api_wert('release', ''));
            } else {
                srt_album_schalten((int) $p['id'], (bool) api_wert('aktiv', true));
            }
            return srt_stand();
        });
    }],
    ['POST', '/admin/sortieren/datei/{id}', function ($p) {
        api_user(true);
        return api_sortieren(static function () use ($p) {
            srt_datei_aktion((int) $p['id'], (string) api_wert('aktion', ''));
            return ['ok' => true];
        });
    }],
    ['POST', '/admin/sortieren/datei/{id}/suche', function ($p) {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return api_sortieren(static fn() => srt_suche((int) $p['id'], (string) api_wert('q', '')));
    }],
    ['POST', '/admin/sortieren/datei/{id}/zuordnen', function ($p) {
        api_user(true);
        return api_sortieren(static function () use ($p) {
            srt_datei_zuordnen((int) $p['id'], (string) api_wert('aufnahme', ''));
            return srt_stand();
        });
    }],
    ['POST', '/admin/klang/neu', function () {
        api_user(true);
        return kl_neu_aufbauen((string) api_wert('was', ''));
    }],
    ['POST', '/admin/klang/entfernen', function () {
        api_user(true);
        kl_modell_entfernen();
        kl_anstossen();
        return kl_stand();
    }],
    ['GET', '/admin/automatik', function () {
        api_user(true);
        return automatik_stand();
    }],
    ['POST', '/admin/kuenstler/{id}/bild', fn($p) => api_admin_kuenstler_bild(api_user(true), (int) $p['id'])],
    ['GET', '/admin/kuenstler/{id}/mb-suche', function ($p) {
        api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return api_admin_kuenstler_mb_suche((int) $p['id']);
    }],
    ['POST', '/admin/kuenstler/{id}/mb-uebernehmen', function ($p) {
        $u = api_user(true);
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        return api_admin_kuenstler_mb_uebernehmen($u, (int) $p['id']);
    }],
];

/** Sortier-Assistent laden und seine Fehler in API-Fehler übersetzen */
function api_sortieren(callable $fn)
{
    require_once __DIR__ . '/../includes/sortieren.php';
    try {
        return $fn();
    } catch (SrtFehler $e) {
        throw new ApiFehler($e->getMessage(), $e->getCode() ?: 400);
    } catch (MbFehler $e) {
        throw new ApiFehler(t('MusicBrainz: {fehler}', ['fehler' => $e->getMessage()]), 502);
    } catch (ErkFehler $e) {
        throw new ApiFehler($e->getMessage(), 502);
    }
}

api_ausfuehren($routen, $pfad);
