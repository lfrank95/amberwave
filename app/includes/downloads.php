<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/aufraeumen.php';
require_once __DIR__ . '/scanner.php';
require_once __DIR__ . '/musicbrainz.php';
require_once __DIR__ . '/uebernehmen.php';

/*
 * Downloads: Prowlarr sucht (nur Usenet), SABnzbd lädt, Amberwave kopiert das Fertige in den Musikordner und liest es ein.
 * Bewusst ohne automatische Suche – du tippst ein, was du willst, wählst einen Treffer und klickst „Holen“.
 *
 * Ablauf eines Auftrags (Tabelle downloads.status):
 *   gesendet → laeuft (in der SABnzbd-Warteschlange) → fertig (SABnzbd ist durch) → importiert
 *   oder fehler (SABnzbd meldet Fehler, Ordner nicht gefunden, Kopieren ging schief)
 * Wächter: ändert sich der Stand in SABnzbd DOWNLOAD_HAENGT_MIN Minuten lang nicht (Pause zählt nicht), ist der Auftrag
 * gescheitert – außer er stand bei 100 % bzw. in der Nachbearbeitung und die Dateien liegen im Download-Ordner, dann geht er
 * als fertig in den Import. Ist er in SABnzbd gar nicht mehr zu finden, nach DOWNLOAD_WEG_MIN Minuten gescheitert.
 * Der Import kopiert nach <Musikordner>/<download_ziel>/<Name>; danach wird das Original im Download-Ordner gelöscht
 * (Standard, DOWNLOAD_NACH_IMPORT=loeschen; braucht DOWNLOAD_MOUNT_MODUS=rw) oder bleibt liegen (behalten)
 * und stößt danach das Einlesen an. Abgeglichen wird im Zeitplan (jede Minute) und beim Öffnen der Seite.
 */

require_once __DIR__ . '/i18n.php';

const DL_AUDIO_BEILAGEN = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'cue', 'log'];

/** Usenet-Downloads eingeschaltet? (Einstellungen → Downloads; neu eingerichtet aus) */
function dl_aktiv(): bool
{
    return einstellung('usenet_aktiv') === '1';
}

function dl_aktiv_pruefen(): void
{
    if (!dl_aktiv()) {
        throw new ApiFehler(t('Usenet-Downloads sind ausgeschaltet – einschalten unter Einstellungen → Downloads.'), 409);
    }
}

function dl_konfig(): array
{
    $std = dl_client(0);
    return [
        // Standard-Prowlarr und Standard-SABnzbd (Einstellungen bzw. .env) – weitere Anbieter stehen in download_dienste
        'prowlarr_url' => rtrim(einstellung('prowlarr_url'), '/'),
        'prowlarr_key' => einstellung('prowlarr_api_key'),
        'kategorien' => dl_kategorien_liste(einstellung('prowlarr_kategorien')),
        'sab_url' => rtrim(einstellung('sabnzbd_url'), '/'),
        'sab_key' => einstellung('sabnzbd_api_key'),
        'sab_kat' => $std['kategorie'],
        'ziel' => trim(einstellung('download_ziel') ?: 'Downloads', '/'),
        'nach_import' => einstellung('download_nach_import') === 'behalten' ? 'behalten' : 'loeschen',
        'wurzel' => konfig()['pfade']['downloads'],
    ];
}

function dl_kategorien_liste(string $roh): array
{
    $k = array_values(array_unique(array_filter(array_map('intval', explode(',', $roh)), static fn($x) => $x > 0)));
    return $k ?: [3000];
}

// ---------- Anbieter: Suchanbieter (Prowlarr, Newznab) und Downloadclients (SABnzbd-kompatibel) ----------
//
// id 0 ist jeweils der „Standard“ aus den Einstellungen (bzw. der .env) – so laufen bestehende Installationen unverändert
// weiter. Weitere Anbieter stehen in der Tabelle download_dienste (id ≥ 1). Schlüssel liegen verschlüsselt und gehen nie an
// den Browser.

const DL_INDEXER_ARTEN = ['prowlarr', 'newznab'];

/** Alle Suchanbieter (Standard-Prowlarr zuerst). $nurBereit: nur eingeschaltete mit Adresse und Schlüssel. */
function dl_indexer_liste(bool $nurBereit = false): array
{
    $aus = [];
    $std = [
        'id' => 0, 'art' => 'prowlarr', 'standard' => true, 'name' => einstellung('prowlarr_name') ?: 'Prowlarr',
        'url' => rtrim(einstellung('prowlarr_url'), '/'), 'key' => einstellung('prowlarr_api_key'),
        'kategorien' => dl_kategorien_liste(einstellung('prowlarr_kategorien')), 'client_id' => max(0, (int) einstellung('prowlarr_client')),
        'musiksuche' => false, 'aktiv' => einstellung('prowlarr_aktiv') !== '0', 'caps' => null, 'api_pfad' => '',
    ];
    $aus[] = $std;
    foreach (dl_dienste_zeilen() as $z) {
        if (in_array($z['art'], DL_INDEXER_ARTEN, true)) {
            $aus[] = dl_dienst_aus_zeile($z);
        }
    }
    foreach ($aus as &$i) {
        $i['bereit'] = $i['aktiv'] && $i['url'] !== '' && $i['key'] !== '';
    }
    unset($i);
    return $nurBereit ? array_values(array_filter($aus, static fn($i) => $i['bereit'])) : $aus;
}

/** Alle Downloadclients (Standard-SABnzbd zuerst) */
function dl_client_liste(bool $nurBereit = false): array
{
    $aus = [dl_client(0)];
    foreach (dl_dienste_zeilen() as $z) {
        if ($z['art'] === 'sabnzbd') {
            $aus[] = dl_dienst_aus_zeile($z);
        }
    }
    foreach ($aus as &$c) {
        $c['bereit'] = $c['aktiv'] && $c['url'] !== '' && $c['key'] !== '';
    }
    unset($c);
    return $nurBereit ? array_values(array_filter($aus, static fn($c) => $c['bereit'])) : $aus;
}

/** Ein Downloadclient (0/null = Standard). Unbekannte id → null. */
function dl_client(?int $id): ?array
{
    $id = (int) ($id ?? 0);
    if ($id <= 0) {
        $c = [
            'id' => 0, 'art' => 'sabnzbd', 'standard' => true, 'name' => einstellung('sabnzbd_name') ?: 'SABnzbd',
            'url' => rtrim(einstellung('sabnzbd_url'), '/'), 'key' => einstellung('sabnzbd_api_key'),
            'api_pfad' => dl_api_pfad(einstellung('sabnzbd_api_pfad')), 'kategorie' => einstellung('sabnzbd_kategorie') ?: 'music',
            'import_ordner' => dl_import_ordner_sauber(einstellung('sabnzbd_import_ordner')), 'aktiv' => true,
        ];
    } else {
        $z = null;
        foreach (dl_dienste_zeilen() as $x) {
            if ((int) $x['id'] === $id && $x['art'] === 'sabnzbd') {
                $z = $x;
            }
        }
        if (!$z) {
            return null;
        }
        $c = dl_dienst_aus_zeile($z);
    }
    $c['bereit'] = $c['aktiv'] && $c['url'] !== '' && $c['key'] !== '';
    return $c;
}

/** Suchanbieter nach id (0 = Standard-Prowlarr) */
function dl_indexer(int $id): ?array
{
    foreach (dl_indexer_liste() as $i) {
        if ($i['id'] === $id) {
            return $i;
        }
    }
    return null;
}

function dl_dienste_zeilen(bool $neu = false): array
{
    static $cache = null;
    if ($cache === null || $neu) {
        try {
            $cache = db_alle('SELECT * FROM download_dienste ORDER BY reihenfolge, id');
        } catch (Throwable $e) {
            $cache = []; // Tabelle fehlt (Migration noch nicht gelaufen): nur der Standard
        }
    }
    return $cache;
}

function dl_dienst_aus_zeile(array $z): array
{
    $key = '';
    if ((string) ($z['api_key'] ?? '') !== '') {
        try {
            $key = entschluessle((string) $z['api_key']);
        } catch (Throwable $e) {
            $key = ''; // Schlüssel nicht lesbar (APP_SECRET_KEY geändert) – gilt als nicht eingerichtet
        }
    }
    $art = (string) $z['art'];
    $d = ['id' => (int) $z['id'], 'art' => $art, 'standard' => false, 'name' => (string) $z['name'] ?: ucfirst($art) . ' ' . $z['id'],
        'url' => rtrim((string) $z['url'], '/'), 'key' => $key, 'aktiv' => (int) $z['aktiv'] === 1];
    if ($art === 'sabnzbd') {
        $d += ['api_pfad' => dl_api_pfad((string) $z['api_pfad']), 'kategorie' => trim((string) $z['kategorien']) ?: 'music',
            'import_ordner' => dl_import_ordner_sauber((string) $z['import_ordner'])];
    } else {
        $caps = json_decode((string) ($z['caps'] ?? ''), true);
        $d += ['api_pfad' => $art === 'newznab' ? dl_api_pfad((string) $z['api_pfad']) : '', 'kategorien' => dl_kategorien_liste((string) $z['kategorien']),
            'client_id' => max(0, (int) ($z['client_id'] ?? 0)), 'musiksuche' => (int) $z['musiksuche'] === 1, 'caps' => is_array($caps) ? $caps : null];
    }
    return $d;
}

/** API-Pfad: mit führendem /, ohne / am Ende; leer → /api */
function dl_api_pfad(string $p): string
{
    $p = trim($p);
    if ($p === '' || $p === '/') {
        return '/api';
    }
    $p = '/' . trim($p, '/');
    return preg_match('#^/[\w./~-]*$#', $p) && !str_contains($p, '..') ? $p : '/api';
}

/** Unterordner im Download-Ordner (relativ, ohne ..) */
function dl_import_ordner_sauber(string $o): string
{
    $o = trim(str_replace('\\', '/', $o), " /");
    if ($o === '' || str_contains($o, '..') || !preg_match('#^[\pL\pN _.()\[\]&+,\'/-]+$#u', $o)) {
        return '';
    }
    return (string) preg_replace('#/+#', '/', $o);
}

/** Ordner im Container, in dem die fertigen Downloads dieses Clients liegen (DOWNLOAD_PFAD oder ein Unterordner davon) */
function dl_client_wurzel(?array $c): string
{
    $w = rtrim(konfig()['pfade']['downloads'], '/');
    $o = $c ? (string) ($c['import_ordner'] ?? '') : '';
    return $o === '' ? $w : $w . '/' . $o;
}

/** Downloadclient eines Auftrags (client_id NULL = Standard, auch bei allen Aufträgen von vor der Erweiterung) */
function dl_client_von(array $d): ?array
{
    return dl_client(isset($d['client_id']) ? (int) $d['client_id'] : 0);
}

function dl_prowlarr_bereit(): bool
{
    return (bool) dl_indexer_liste(true);
}

function dl_sab_bereit(): bool
{
    return (bool) dl_client_liste(true);
}

/** HTTP-Anfrage (GET oder POST multipart) → [status, body] */
function dl_http(string $url, array $kopf = [], ?array $post = null, int $timeout = 30): array
{
    $r = dl_http_viele([['url' => $url, 'kopf' => $kopf, 'post' => $post, 'timeout' => $timeout]])[0];
    if (isset($r['fehler'])) {
        throw new ApiFehler($r['fehler']);
    }
    return $r;
}

/**
 * Mehrere HTTP-Anfragen gleichzeitig (Suche bei mehreren Indexern). Liefert je Anfrage [status, body] oder [fehler].
 * @param array<int, array{url:string, kopf?:array, post?:?array, timeout?:int}> $anfragen
 */
function dl_http_viele(array $anfragen): array
{
    $mh = curl_multi_init();
    $griffe = [];
    $aus = [];
    foreach ($anfragen as $i => $a) {
        $url = (string) $a['url'];
        if (!preg_match('#^https?://#i', $url)) {
            $aus[$i] = ['fehler' => t('Ungültige Adresse: {url}', ['url' => $url])];
            continue;
        }
        $ch = curl_init($url);
        $opt = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => (int) ($a['timeout'] ?? 30),
            CURLOPT_HTTPHEADER => $a['kopf'] ?? [],
            CURLOPT_USERAGENT => 'Amberwave/' . konfig()['version'],
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_ENCODING => '',   // gzip/deflate annehmen (manche Indexer liefern NZB und XML komprimiert)
        ];
        if (($a['post'] ?? null) !== null) {
            $opt[CURLOPT_POST] = true;
            $opt[CURLOPT_POSTFIELDS] = $a['post'];
        }
        curl_setopt_array($ch, $opt);
        curl_multi_add_handle($mh, $ch);
        $griffe[$i] = $ch;
    }
    do {
        $st = curl_multi_exec($mh, $laeuft);
        if ($laeuft) {
            curl_multi_select($mh, 1.0);
        }
    } while ($laeuft && $st === CURLM_OK);
    foreach ($griffe as $i => $ch) {
        $body = curl_multi_getcontent($ch);
        $fehler = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($fehler !== '' || ($status === 0 && ($body === null || $body === ''))) {
            $aus[$i] = ['fehler' => t('Keine Verbindung zu {host}: {fehler}', ['host' => parse_url((string) $anfragen[$i]['url'], PHP_URL_HOST), 'fehler' => $fehler ?: t('unbekannter Fehler')])];
        } else {
            $aus[$i] = ['status' => $status, 'body' => (string) $body];
        }
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    ksort($aus);
    return $aus;
}

function dl_json(array $r, string $wer): array
{
    if ($r['status'] === 401 || $r['status'] === 403) {
        throw new ApiFehler(t('{wer}: API-Schlüssel wird nicht akzeptiert.', ['wer' => $wer]));
    }
    if ($r['status'] >= 400) {
        throw new ApiFehler(t('{wer} antwortet mit HTTP {status}.', ['wer' => $wer, 'status' => $r['status']]));
    }
    $j = json_decode($r['body'], true);
    if (!is_array($j)) {
        throw new ApiFehler(t('{wer} liefert keine gültige Antwort (Adresse richtig?).', ['wer' => $wer]));
    }
    return $j;
}

// ---------- SABnzbd (und kompatible) ----------

/** Adresse der SABnzbd-API eines Clients (ohne Parameter) */
function dl_sab_url(array $c): string
{
    return rtrim((string) $c['url'], '/') . dl_api_pfad((string) ($c['api_pfad'] ?? '/api'));
}

/**
 * Fehlerarten der SABnzbd-Schnittstelle – damit Prüfung und Abgleich unterscheiden können, ob der Client nicht erreichbar ist,
 * den Schlüssel ablehnt, einen (optionalen) Befehl nicht kennt oder etwas Unbrauchbares antwortet.
 */
const DL_SAB_NETZ = 'netz';          // keine Verbindung (Adresse, Port, Container aus)
const DL_SAB_AUTH = 'auth';          // API-Schlüssel abgelehnt
const DL_SAB_PFAD = 'pfad';          // HTTP 404/405 – unter Adresse + API-Pfad liegt keine API
const DL_SAB_HTTP = 'http';          // sonstiger HTTP-Fehler
const DL_SAB_MODUS = 'modus';        // Befehl (mode=…) wird nicht unterstützt
const DL_SAB_ANTWORT = 'antwort';    // kein JSON oder unerwarteter Aufbau
const DL_SAB_FEHLER = 'fehler';      // sonstige Fehlermeldung des Clients

/** Art eines SABnzbd-Fehlers (aus ApiFehler::extra['sab_art']), '' bei anderen Fehlern */
function dl_sab_fehlerart(Throwable $e): string
{
    return $e instanceof ApiFehler ? (string) ($e->extra['sab_art'] ?? '') : '';
}

/** Fehlermeldung eines Clients einordnen: Schlüssel, unbekannter Befehl oder Sonstiges (nur allgemeine Formulierungen, kein Anbieter-Sonderfall) */
function dl_sab_meldung_art(string $f): string
{
    if (preg_match('/api[ _-]?key|apikey|unauthori[sz]ed|not authori[sz]ed|forbidden|authentication|access denied/i', $f)) {
        return DL_SAB_AUTH;
    }
    if (preg_match('/\b(invalid|unknown|unsupported|not supported|not implemented|no such)\b.{0,20}\b(mode|command|method|call)\b|\b(mode|command|method)\b.{0,30}\b(not supported|unsupported|not implemented|unknown|invalid)\b|^not implemented/i', $f)) {
        return DL_SAB_MODUS;
    }
    return DL_SAB_FEHLER;
}

/** SABnzbd-API aufrufen. $client: Downloadclient aus dl_client() – ohne Angabe der Standard-SABnzbd. */
function dl_sab(string $modus, array $param = [], ?array $post = null, ?array $client = null): array
{
    $c = $client ?? dl_client(0);
    if (!$c || !$c['bereit']) {
        throw new ApiFehler(t('{name} ist noch nicht eingerichtet (Einstellungen → Downloads).', ['name' => $c['name'] ?? 'SABnzbd']));
    }
    $wer = $c['name'];
    $fehler = static fn(string $art, string $text) => new ApiFehler($text, 400, ['sab_art' => $art, 'sab_modus' => $modus]);
    $url = dl_sab_url($c) . '?' . http_build_query(['mode' => $modus, 'output' => 'json', 'apikey' => $c['key']] + $param);
    $r = dl_http_viele([['url' => $url, 'post' => $post, 'timeout' => $post ? 60 : 20]])[0];
    if (isset($r['fehler'])) {
        throw $fehler(DL_SAB_NETZ, $r['fehler']);
    }
    $j = json_decode($r['body'], true);
    // Fehlermeldung aus dem Inhalt (auch bei HTTP-Fehlercodes liefern manche Clients JSON mit „error“)
    $meldung = '';
    if (is_array($j) && (($j['status'] ?? null) === false || (is_string($j['error'] ?? null) && trim($j['error']) !== '' && ($j['status'] ?? null) !== true))) {
        $meldung = trim((string) ($j['error'] ?? '')) ?: t('Fehler');
    } elseif (!is_array($j) && $r['status'] < 400 && preg_match('/^\s*error:?\s*(.+)$/i', $r['body'], $m)) {
        $meldung = trim($m[1]);   // Klartext-Antwort „error: …“ (ältere Clients ignorieren output=json bei Fehlern)
    }
    if ($r['status'] === 401 || $r['status'] === 403) {
        throw $fehler(DL_SAB_AUTH, t('{wer}: API-Schlüssel wird nicht akzeptiert.', ['wer' => $wer]));
    }
    if ($meldung !== '') {
        $art = dl_sab_meldung_art($meldung);
        if ($art === DL_SAB_AUTH) {
            throw $fehler($art, t('{wer}: API-Schlüssel wird nicht akzeptiert.', ['wer' => $wer]));
        }
        if ($art === DL_SAB_MODUS) {
            throw $fehler($art, t('{wer} unterstützt den Befehl „{modus}“ nicht ({fehler}).', ['wer' => $wer, 'modus' => $modus, 'fehler' => $meldung]));
        }
        throw $fehler($art, t('{wer}: {fehler}', ['wer' => $wer, 'fehler' => $meldung]));
    }
    if ($r['status'] === 404 || $r['status'] === 405) {
        throw $fehler(DL_SAB_PFAD, t('{wer}: unter {url} antwortet keine API (HTTP {status}) – API-Pfad prüfen.', ['wer' => $wer, 'url' => dl_sab_url($c), 'status' => $r['status']]));
    }
    if ($r['status'] === 501) {
        throw $fehler(DL_SAB_MODUS, t('{wer} unterstützt den Befehl „{modus}“ nicht ({fehler}).', ['wer' => $wer, 'modus' => $modus, 'fehler' => 'HTTP 501']));
    }
    if ($r['status'] >= 400) {
        throw $fehler(DL_SAB_HTTP, t('{wer} antwortet mit HTTP {status}.', ['wer' => $wer, 'status' => $r['status']]));
    }
    if (!is_array($j)) {
        throw $fehler(DL_SAB_ANTWORT, t('{wer} liefert auf „{modus}“ kein JSON – ist das eine SABnzbd-Schnittstelle (Adresse und API-Pfad)?', ['wer' => $wer, 'modus' => $modus]));
    }
    return $j;
}

/** Unerwarteten Aufbau einer SABnzbd-Antwort melden */
function dl_sab_aufbau_fehler(array $c, string $modus, string $erwartet): ApiFehler
{
    return new ApiFehler(t('{wer}: unerwartete Antwort auf „{modus}“ (erwartet: {erwartet}).', ['wer' => $c['name'], 'modus' => $modus, 'erwartet' => $erwartet]), 400,
        ['sab_art' => DL_SAB_ANTWORT, 'sab_modus' => $modus]);
}

/** Warteschlange eines Clients – mit Prüfung des Aufbaus (sonst gälten alle Aufträge als verschwunden) */
function dl_sab_queue(array $c, array $param = []): array
{
    $q = dl_sab('queue', $param, null, $c)['queue'] ?? null;
    if (!is_array($q) || (isset($q['slots']) && !is_array($q['slots']))) {
        throw dl_sab_aufbau_fehler($c, 'queue', 'queue.slots');
    }
    return $q;
}

/** Verlauf eines Clients – mit Prüfung des Aufbaus */
function dl_sab_history(array $c, array $param = []): array
{
    $h = dl_sab('history', $param, null, $c)['history'] ?? null;
    if (!is_array($h) || (isset($h['slots']) && !is_array($h['slots']))) {
        throw dl_sab_aufbau_fehler($c, 'history', 'history.slots');
    }
    return $h;
}

/**
 * Kategorien und Ablageordner eines Clients – allgemein für SABnzbd und kompatible Dienste:
 * erst mode=get_cats; kennt der Client den Befehl nicht (oder antwortet unbrauchbar), die Kategorien aus
 * mode=get_config → config.categories. complete_dir und die Kategorie-Ordner kommen immer aus get_config, wenn verfügbar.
 * Schlüssel- und Verbindungsfehler werden weitergereicht; fehlende optionale Befehle nicht.
 * @return array{kategorien:?array, quelle:string, complete:string, kat_ordner:array<string,string>, hinweise:array<int,string>}
 */
function dl_sab_kategorien(array $c): array
{
    $aus = ['kategorien' => null, 'quelle' => '', 'complete' => '', 'kat_ordner' => [], 'hinweise' => []];
    $hart = static fn(Throwable $e) => in_array(dl_sab_fehlerart($e), [DL_SAB_NETZ, DL_SAB_AUTH], true);
    try {
        $roh = dl_sab('get_cats', [], null, $c)['categories'] ?? null;
        if (is_array($roh) && array_is_list($roh)) {
            $kats = [];
            foreach ($roh as $k) {
                if (is_string($k) || is_int($k)) {
                    $kats[] = (string) $k;
                } elseif (is_array($k) && isset($k['name'])) {
                    $kats[] = (string) $k['name'];
                }
            }
            $aus['kategorien'] = $kats;
            $aus['quelle'] = 'get_cats';
        } else {
            $aus['hinweise'][] = t('get_cats: unerwarteter Aufbau');
        }
    } catch (Throwable $e) {
        if ($hart($e)) {
            throw $e;
        }
        $aus['hinweise'][] = dl_sab_fehlerart($e) === DL_SAB_MODUS ? t('get_cats nicht unterstützt') : 'get_cats: ' . $e->getMessage();
    }
    try {
        $cfg = dl_sab('get_config', [], null, $c)['config'] ?? null;
        if (!is_array($cfg)) {
            throw dl_sab_aufbau_fehler($c, 'get_config', 'config');
        }
        $misc = is_array($cfg['misc'] ?? null) ? $cfg['misc'] : [];
        $aus['complete'] = is_scalar($misc['complete_dir'] ?? null) ? trim((string) $misc['complete_dir']) : '';
        $liste = $cfg['categories'] ?? null;
        if (is_array($liste)) {
            $kats = [];
            // Liste von {name, dir, …} – manche Clients liefern ein Objekt mit dem Namen als Schlüssel
            foreach ($liste as $schl => $x) {
                if (!is_array($x)) {
                    continue;
                }
                $n = (string) ($x['name'] ?? (is_string($schl) ? $schl : ''));
                if ($n === '') {
                    continue;
                }
                $kats[] = $n;
                $aus['kat_ordner'][$n] = is_scalar($x['dir'] ?? null) ? trim((string) $x['dir']) : '';
            }
            if ($aus['kategorien'] === null && $kats) {
                $aus['kategorien'] = $kats;
                $aus['quelle'] = 'get_config';
            }
        } elseif ($aus['kategorien'] === null) {
            $aus['hinweise'][] = t('get_config: keine Kategorien (config.categories)');
        }
    } catch (Throwable $e) {
        if ($hart($e)) {
            throw $e;
        }
        $aus['hinweise'][] = dl_sab_fehlerart($e) === DL_SAB_MODUS ? t('get_config nicht unterstützt') : 'get_config: ' . preg_replace('/^' . preg_quote($c['name'], '/') . ':\s*/u', '', $e->getMessage());
    }
    return $aus;
}

// ---------- Prowlarr ----------

/** Prowlarr-API (JSON). $idx: Suchanbieter vom Typ prowlarr – ohne Angabe der Standard-Prowlarr. */
function dl_prowlarr(string $pfad, array $param = [], ?array $idx = null): array
{
    $i = $idx ?? dl_indexer(0);
    if (!$i || $i['url'] === '' || $i['key'] === '') {
        throw new ApiFehler(t('{name} ist noch nicht eingerichtet (Einstellungen → Downloads).', ['name' => $i['name'] ?? 'Prowlarr']));
    }
    return dl_json(dl_http(dl_prowlarr_url($i, $pfad, $param), ['X-Api-Key: ' . $i['key'], 'Accept: application/json'], null, 60), $i['name']);
}

function dl_prowlarr_url(array $i, string $pfad, array $param): string
{
    // Prowlarr erwartet wiederholte Parameter (categories=3000&categories=3040)
    $q = [];
    foreach ($param as $n => $w) {
        foreach ((array) $w as $x) {
            $q[] = rawurlencode((string) $n) . '=' . rawurlencode((string) $x);
        }
    }
    return rtrim((string) $i['url'], '/') . $pfad . ($q ? '?' . implode('&', $q) : '');
}

/** Prowlarr-Antwort ins interne Trefferformat */
function dl_prowlarr_treffer(array $roh, array $idx): array
{
    $aus = [];
    foreach ($roh as $r) {
        if (!is_array($r) || ($r['protocol'] ?? '') !== 'usenet' || empty($r['downloadUrl'])) {
            continue;
        }
        $kat = array_values(array_filter(array_map(static fn($c) => is_array($c) ? (string) ($c['name'] ?? '') : '', (array) ($r['categories'] ?? []))));
        $aus[] = [
            'titel' => (string) ($r['title'] ?? ''),
            'indexer' => (string) ($r['indexer'] ?? ''),
            'groesse' => (int) ($r['size'] ?? 0),
            'alter_tage' => isset($r['age']) ? (int) $r['age'] : null,
            'datum' => (string) ($r['publishDate'] ?? ''),
            'grabs' => isset($r['grabs']) ? (int) $r['grabs'] : null,
            'kategorien' => $kat,
            'kategorie_ids' => array_values(array_filter(array_map(static fn($c) => is_array($c) ? (int) ($c['id'] ?? 0) : 0, (array) ($r['categories'] ?? [])))),
            'guid' => (string) ($r['guid'] ?? $r['infoUrl'] ?? ''),
            'url' => (string) $r['downloadUrl'],
            'qualitaet' => dl_qualitaet((string) ($r['title'] ?? ''), $kat),
        ];
    }
    return $aus;
}

// ---------- Newznab (generisch, XML/RSS) ----------

/** Newznab-Standardkategorien (wenn ein Indexer in den caps keine Namen liefert) */
const DL_NEWZNAB_KATEGORIEN = [3000 => 'Audio', 3010 => 'Audio/MP3', 3020 => 'Audio/Video', 3030 => 'Audio/Audiobook', 3040 => 'Audio/Lossless', 3050 => 'Audio/Other', 3060 => 'Audio/Foreign',
    2000 => 'Movies', 5000 => 'TV', 7000 => 'Books', 7020 => 'Books/EBook', 7030 => 'Books/Comics', 8000 => 'Other', 4000 => 'PC', 1000 => 'Console', 6000 => 'XXX'];

/** Adresse eines Newznab-Aufrufs: <url><api_pfad>?t=…&apikey=… */
function dl_newznab_url(array $idx, array $param): string
{
    return rtrim((string) $idx['url'], '/') . dl_api_pfad((string) ($idx['api_pfad'] ?? '/api')) . '?' . http_build_query($param + ['apikey' => $idx['key']]);
}

/**
 * Newznab-Antwort lesen: XML (RSS 2.0 mit newznab:attr) prüfen, Fehlercodes in verständliche Meldungen übersetzen.
 * @return SimpleXMLElement
 */
function dl_newznab_xml(array $r, string $wer): SimpleXMLElement
{
    if ($r['status'] === 401 || $r['status'] === 403) {
        throw new ApiFehler(t('{wer}: API-Schlüssel wird nicht akzeptiert.', ['wer' => $wer]));
    }
    if ($r['status'] === 429) {
        throw new ApiFehler(t('{wer}: Anfrage-Limit erreicht – später nochmal versuchen.', ['wer' => $wer]));
    }
    if ($r['status'] >= 400) {
        throw new ApiFehler(t('{wer} antwortet mit HTTP {status}.', ['wer' => $wer, 'status' => $r['status']]));
    }
    $vorher = libxml_use_internal_errors(true);
    $x = simplexml_load_string($r['body'], SimpleXMLElement::class, LIBXML_NONET | LIBXML_NOCDATA);
    libxml_clear_errors();
    libxml_use_internal_errors($vorher);
    if (!$x) {
        throw new ApiFehler(t('{wer} liefert kein gültiges XML (Adresse und API-Pfad richtig?).', ['wer' => $wer]));
    }
    if ($x->getName() === 'error') {
        $code = (int) ($x['code'] ?? 0);
        $text = (string) ($x['description'] ?? '');
        if (in_array($code, [100, 101, 102], true)) {
            throw new ApiFehler(t('{wer}: API-Schlüssel wird nicht akzeptiert.', ['wer' => $wer]));
        }
        if (in_array($code, [429, 500, 501, 502], true) && preg_match('/limit/i', $text)) {
            throw new ApiFehler(t('{wer}: Anfrage-Limit erreicht – später nochmal versuchen.', ['wer' => $wer]));
        }
        throw new ApiFehler(t('{wer}: Fehler {code} – {text}', ['wer' => $wer, 'code' => $code, 'text' => $text ?: t('unbekannt')]));
    }
    return $x;
}

/**
 * Fähigkeiten eines Newznab-Indexers (t=caps): welche Suchen gehen (search, music-search mit welchen Parametern),
 * Kategorien mit Namen, Höchstzahl je Anfrage. Wird beim Speichern/Testen geholt und am Anbieter gemerkt.
 */
function dl_newznab_caps(array $idx): array
{
    $x = dl_newznab_xml(dl_http(dl_newznab_url($idx, ['t' => 'caps']), ['Accept: application/xml'], null, 20), $idx['name']);
    if ($x->getName() !== 'caps') {
        throw new ApiFehler(t('{wer} liefert auf t=caps keine Fähigkeiten (kein Newznab-Indexer?).', ['wer' => $idx['name']]));
    }
    $suche = static function (?SimpleXMLElement $e): array {
        if (!$e) {
            return ['an' => false, 'param' => []];
        }
        $p = array_values(array_filter(array_map('trim', explode(',', strtolower((string) ($e['supportedParams'] ?? ''))))));
        return ['an' => strtolower((string) ($e['available'] ?? '')) === 'yes', 'param' => $p];
    };
    $kats = [];
    foreach ($x->categories->category ?? [] as $k) {
        $id = (int) $k['id'];
        $name = (string) $k['name'];
        $kats[$id] = $name;
        foreach ($k->subcat ?? [] as $u) {
            $kats[(int) $u['id']] = $name . '/' . (string) $u['name'];
        }
    }
    return [
        'titel' => (string) ($x->server['title'] ?? ''),
        'max' => (int) ($x->limits['max'] ?? 0),
        'standard' => (int) ($x->limits['default'] ?? 0),
        'search' => $suche($x->searching->search ?? null),
        'music' => $suche($x->searching->{'music-search'} ?? null),
        'audio' => $suche($x->searching->{'audio-search'} ?? null),
        'kategorien' => $kats,
        'stand' => date('c'),
    ];
}

/**
 * Suchanfrage für einen Newznab-Indexer bauen: t=music mit artist/album, wenn Künstler und Album bekannt sind, der Indexer
 * das kann und es eingeschaltet ist – sonst t=search mit q.
 */
function dl_newznab_anfrage(array $idx, string $begriff, string $kuenstler = '', string $album = ''): array
{
    $caps = $idx['caps'] ?? null;
    $max = (int) ($caps['max'] ?? 0);
    $param = ['cat' => implode(',', $idx['kategorien']), 'extended' => 1, 'limit' => $max > 0 ? min(100, $max) : 100];
    $m = $caps['music'] ?? ['an' => false, 'param' => []];
    if ($idx['musiksuche'] && $kuenstler !== '' && $album !== '' && $m['an'] && in_array('artist', $m['param'], true) && in_array('album', $m['param'], true)) {
        return ['t' => 'music', 'artist' => $kuenstler, 'album' => $album] + $param;
    }
    if ($idx['musiksuche'] && $kuenstler !== '' && $album === '' && $m['an'] && in_array('artist', $m['param'], true)) {
        return ['t' => 'music', 'artist' => $kuenstler] + $param;
    }
    return ['t' => 'search', 'q' => $begriff] + $param;
}

/** Newznab-RSS ins interne Trefferformat (Titel, GUID, Kategorie, Download-Adresse, Größe, Alter, Grabs, Qualitätsangaben) */
function dl_newznab_treffer(SimpleXMLElement $x, array $idx): array
{
    $katNamen = ($idx['caps']['kategorien'] ?? []) + DL_NEWZNAB_KATEGORIEN;
    $aus = [];
    $items = $x->channel->item ?? [];
    foreach ($items as $it) {
        $attr = [];
        foreach ($it->children('newznab', true)->attr ?? [] as $a) {
            $n = strtolower((string) $a->attributes()['name']);
            $attr[$n][] = (string) $a->attributes()['value'];
        }
        // manche Indexer schreiben die Attribute ohne Namensraum-Präfix oder als torznab:attr – beides mitnehmen
        foreach ($it->children('torznab', true)->attr ?? [] as $a) {
            $attr[strtolower((string) $a->attributes()['name'])][] = (string) $a->attributes()['value'];
        }
        $titel = trim((string) $it->title);
        $enc = $it->enclosure ?? null;
        $url = trim((string) ($enc ? $enc['url'] : '')) ?: trim((string) $it->link);
        if ($titel === '' || $url === '') {
            continue;
        }
        $groesse = (int) ($attr['size'][0] ?? ($enc ? (string) $enc['length'] : 0));
        $datum = (string) ($attr['usenetdate'][0] ?? '') ?: (string) $it->pubDate;
        $zeit = $datum !== '' ? strtotime($datum) : false;
        $katIds = array_values(array_unique(array_map('intval', $attr['category'] ?? [])));
        // Kategorie-Namen: der genaueste (Unterkategorie) zuerst; ohne Attribute der Text aus <category>
        rsort($katIds);
        $kat = [];
        foreach ($katIds as $k) {
            if (isset($katNamen[$k])) {
                $kat[] = $katNamen[$k];
            }
        }
        // Oberkategorie weglassen, wenn eine ihrer Unterkategorien dabei ist („Audio/Lossless“ statt „Audio/Lossless, Audio“)
        $kat = array_values(array_filter($kat, static fn($n) => str_contains($n, '/') || !array_filter($kat, static fn($m) => str_starts_with($m, $n . '/'))));
        if (!$kat && trim((string) $it->category) !== '') {
            $kat[] = str_replace([' > ', '>'], '/', trim((string) $it->category));
        }
        // Qualität: aus dem Namen und aus den Angaben, die der Indexer mitliefert (audio, bitrate …)
        $zusatz = implode(' ', array_merge($attr['audio'] ?? [], $attr['bitrate'] ?? [], $attr['codec'] ?? [], $attr['format'] ?? [], $attr['resolution'] ?? []));
        $q = dl_qualitaet($titel . ($zusatz !== '' ? ' ' . $zusatz : ''), $kat);
        $guid = (string) ($attr['guid'][0] ?? '') ?: trim((string) $it->guid);
        $aus[] = [
            'titel' => $titel,
            'indexer' => $idx['name'],
            'groesse' => max(0, $groesse),
            'alter_tage' => $zeit ? max(0, (int) floor((time() - $zeit) / 86400)) : null,
            'datum' => $zeit ? date('c', $zeit) : '',
            'grabs' => isset($attr['grabs'][0]) ? (int) $attr['grabs'][0] : null,
            'kategorien' => $kat,
            'kategorie_ids' => $katIds,
            'guid' => $guid,
            'url' => $url,
            'qualitaet' => $q,
        ];
    }
    return $aus;
}

/**
 * Qualität aus dem Release-Namen und der Newznab-Kategorie lesen (Usenet liefert dafür keine eigenen Felder).
 * Liefert format (FLAC, ALAC, MP3, AAC, Opus, OGG, WAV, DSD), detail (24/96, 320, V0 …), quelle (WEB, CD, Vinyl),
 * kanaele (5.1), stufe (hires | lossless | lossy | unbekannt) und ob es nur aus der Kategorie geschlossen ist.
 */
function dl_qualitaet(string $titel, array $kategorien = []): array
{
    // Punkte und Unterstriche als Worttrenner – aber nicht zwischen Ziffern (44.1, 5.1)
    $t = ' ' . preg_replace('/(?<!\d)\.|\.(?!\d)/', ' ', str_replace('_', ' ', $titel)) . ' ';
    $q = ['format' => '', 'detail' => '', 'quelle' => '', 'kanaele' => '', 'stufe' => 'unbekannt', 'aus_kategorie' => false];
    $formate = [
        'FLAC' => '/\bflac\b/i', 'ALAC' => '/\balac\b/i', 'DSD' => '/\b(dsd(64|128|256)?|dsf|sacd)\b/i', 'WAV' => '/\b(wav|pcm)\b/i',
        'MP3' => '/\bmp3\b/i', 'AAC' => '/\b(aac|m4a)\b/i', 'Opus' => '/\bopus\b/i', 'OGG' => '/\b(ogg|vorbis)\b/i',
    ];
    foreach ($formate as $f => $re) {
        if (preg_match($re, $t)) {
            $q['format'] = $f;
            break;
        }
    }
    // Auflösung: 24bit, 24-96, 24/192, 96kHz, Hi-Res
    if (preg_match('/\b(16|24|32)\s*(?:bit)?\s*[-\/ .]\s*(44[.,]?1|48|88[.,]?2|96|176[.,]?4|192|352[.,]?8|384)\s*(?:k(?:hz)?)?\b/i', $t, $m)) {
        $q['detail'] = $m[1] . '/' . str_replace(',', '.', $m[2]);
    } elseif (preg_match('/\b(24|32)\s*-?\s*bit\b/i', $t, $m)) {
        $q['detail'] = $m[1] . ' Bit';
    } elseif (preg_match('/\b(88[.,]2|96|176[.,]4|192)\s*k(hz)?\b/i', $t, $m)) {
        $q['detail'] = str_replace(',', '.', $m[1]) . ' kHz';
    }
    if (!$q['detail'] && preg_match('/\bhi-?res\b/i', $t)) {
        $q['detail'] = 'Hi-Res';
    }
    // Bitrate verlustbehaftet: 320, 256, V0, V2, CBR/VBR
    if (preg_match('/\b(320|256|224|192|160|128)\s*(?:k(?:bps)?|kbit)?\b/i', $t, $m) && in_array($q['format'], ['', 'MP3', 'AAC', 'OGG', 'Opus'], true)
        && !preg_match('/\b' . $m[1] . '\s*k(hz)?\b/i', $t)) {
        $q['detail'] = $q['detail'] ?: $m[1];
    }
    if (preg_match('/\b(V0|V1|V2)\b/', $t, $m)) {
        $q['detail'] = $m[1];
    }
    if (preg_match('/\b(web(-?dl)?|itunes|qobuz|tidal|bandcamp|deezer)\b/i', $t)) {
        $q['quelle'] = 'WEB';
    } elseif (preg_match('/\b(vinyl|lp-?rip|lp)\b/i', $t)) {
        $q['quelle'] = 'Vinyl';
    } elseif (preg_match('/\b(cd(-?rip)?|cdda|redbook)\b/i', $t)) {
        $q['quelle'] = 'CD';
    } elseif (preg_match('/\bsacd\b/i', $t)) {
        $q['quelle'] = 'SACD';
    }
    if (preg_match('/\b(5[.,]1|7[.,]1|multichannel|mch|quad)\b/i', $t, $m)) {
        $q['kanaele'] = preg_match('/\d/', $m[1]) ? str_replace(',', '.', $m[1]) : t('Mehrkanal');
    }
    // Ohne Format im Namen: aus der Kategorie schließen (Audio/Lossless, Audio/MP3 …)
    if ($q['format'] === '') {
        $kat = mb_strtolower(implode(' ', $kategorien));
        if (str_contains($kat, 'lossless')) { $q['format'] = 'Lossless'; $q['aus_kategorie'] = true; }
        elseif (str_contains($kat, 'mp3')) { $q['format'] = 'MP3'; $q['aus_kategorie'] = true; }
        elseif (str_contains($kat, 'audiobook')) { $q['format'] = t('Hörbuch'); $q['aus_kategorie'] = true; }
    }
    if ($q['format'] === '' && preg_match('/^(320|256|224|192|160|128|V[012])$/', $q['detail'])) {
        $q['format'] = 'MP3'; // Bitrate ohne Formatangabe: fast immer MP3
        $q['aus_kategorie'] = true;
    }
    if ($q['format'] === '' && preg_match('/^(24|32)(\/| Bit)|kHz$|Hi-Res/', $q['detail'])) {
        $q['format'] = 'Lossless'; // hohe Auflösung ohne Formatangabe: so gut wie immer FLAC/WAV
        $q['aus_kategorie'] = true;
    }
    $hires = (bool) preg_match('/^(24|32)(\/| Bit)|kHz$|Hi-Res/', $q['detail']);
    if (in_array($q['format'], ['FLAC', 'ALAC', 'WAV', 'DSD', 'Lossless'], true)) {
        $q['stufe'] = ($hires || $q['format'] === 'DSD') ? 'hires' : 'lossless';
    } elseif ($q['format'] !== '' && $q['format'] !== t('Hörbuch')) {
        $q['stufe'] = 'lossy';
    }
    return $q;
}

function dl_suche_ordner(): string
{
    $o = konfig()['pfade']['cache'] . '/downloads';
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return $o;
}

/** Für Vergleiche: klein, ohne Akzente, nur Buchstaben/Ziffern durch Leerzeichen getrennt */
function dl_norm(string $s): string
{
    $s = mb_strtolower($s);
    if (class_exists('Normalizer')) {
        $s = (string) preg_replace('/\p{Mn}+/u', '', (string) Normalizer::normalize($s, Normalizer::FORM_D));
    }
    $s = strtr($s, ['ß' => 'ss', 'æ' => 'ae', 'ø' => 'o', 'œ' => 'oe', 'ł' => 'l', '$' => 's']);
    return trim((string) preg_replace('/[^\pL\pN]+/u', ' ', $s));
}

/**
 * Suchbegriff zerlegen: Wörter (alle Pflicht), "genaue Wortfolge", -ausschließen. Füllwörter (the, and, &, feat …)
 * sind keine Pflicht, weil Releases sie oft weglassen („Weeknd“, „Simon Garfunkel“).
 */
function dl_begriff_zerlegen(string $begriff): array
{
    $phrasen = [];
    $ohne = [];
    $begriff = preg_replace_callback('/"([^"]+)"/u', static function ($m) use (&$phrasen) { $phrasen[] = dl_norm($m[1]); return ' '; }, $begriff);
    $begriff = preg_replace_callback('/(?:^|\s)-(\S+)/u', static function ($m) use (&$ohne) { $ohne[] = dl_norm($m[1]); return ' '; }, (string) $begriff);
    $fuell = ['the', 'a', 'an', 'and', 'und', 'der', 'die', 'das', 'feat', 'ft', 'featuring', 'vs', 'with', 'of', 'le', 'la', 'les', 'el'];
    $woerter = [];
    $alle = [];
    foreach (explode(' ', dl_norm((string) $begriff)) as $w) {
        if ($w === '') continue;
        $alle[] = $w;
        if (!in_array($w, $fuell, true)) $woerter[] = $w;
    }
    foreach ($phrasen as $p) foreach (explode(' ', $p) as $w) if ($w !== '') $alle[] = $w;
    return ['woerter' => array_values(array_unique($woerter)), 'phrasen' => array_values(array_filter($phrasen)), 'ohne' => array_values(array_filter($ohne)),
        'folge' => implode(' ', array_diff($alle, $fuell))];
}

/**
 * Passt ein Treffer zum Suchbegriff? Indexer suchen unscharf („Alexis Jordan“ liefert auch „Michael Jordan“ oder Alben,
 * in denen nur ein Wort irgendwo vorkommt). Hier zählt: jedes Wort ganz im Namen (oder zusammengeschrieben: ACDC = AC/DC),
 * keine ausgeschlossenen Wörter, und es muss Musik sein. Dazu Punkte für die Reihenfolge (Wörter direkt hintereinander,
 * am Anfang des Namens = Künstler).
 */
function dl_relevanz(array $such, string $titel, array $kategorien): array
{
    $t = dl_norm($titel);
    $tw = ' ' . $t . ' ';
    $kompakt = str_replace(' ', '', $t);
    $grund = '';
    foreach ($such['woerter'] as $w) {
        if (!str_contains($tw, ' ' . $w . ' ') && !(mb_strlen($w) >= 4 && str_contains($kompakt, $w) && preg_match('/(^| )' . preg_quote(mb_substr($w, 0, 2), '/') . '/u', $t))) {
            $grund = t('„{wort}“ fehlt im Namen', ['wort' => $w]);
            break;
        }
    }
    // zusammengeschrieben / getrennt geschrieben: „acdc“ ↔ „ac dc“
    if ($grund !== '' && $such['folge'] !== '' && str_contains($kompakt, str_replace(' ', '', $such['folge']))) {
        $grund = '';
    }
    foreach ($such['phrasen'] as $p) {
        if ($grund === '' && !str_contains($tw, ' ' . $p . ' ')) $grund = t('„{wort}“ nicht als Wortfolge', ['wort' => $p]);
    }
    foreach ($such['ohne'] as $o) {
        if ($grund === '' && str_contains($tw, ' ' . $o . ' ')) $grund = t('enthält „{wort}“', ['wort' => $o]);
    }
    $kat = mb_strtolower(implode(' ', $kategorien));
    if ($grund === '' && $kat !== '') {
        if (!str_contains($kat, 'audio') && !str_contains($kat, 'music') && !str_contains($kat, 'musik')) $grund = t('keine Musik ({kategorien})', ['kategorien' => implode(', ', $kategorien)]);
        elseif (str_contains($kat, 'audiobook') || str_contains($kat, 'hörbuch')) $grund = t('Hörbuch');
        elseif (preg_match('#audio/(video|other)|music ?video#', $kat) && !preg_match('#audio/(mp3|lossless|flac)#', $kat)) $grund = t('Musikvideo oder Sonstiges');
    }
    if ($grund === '' && preg_match('/\b(x264|x265|h264|hevc|1080p|720p|2160p|bluray|bdrip|dvdrip|webrip|epub|mobi|audiobook|hoerbuch|hörbuch)\b/i', $titel)) {
        $grund = t('Video oder Buch');
    }
    $punkte = 0;
    if ($grund === '') {
        $punkte = 50;
        if ($such['folge'] !== '' && str_contains($tw, ' ' . $such['folge'] . ' ')) $punkte += 30;        // genau so hintereinander
        if ($such['folge'] !== '' && str_starts_with($t, $such['folge'])) $punkte += 20;                // steht vorne (Künstler)
        elseif ($such['woerter'] && str_starts_with($t, $such['woerter'][0])) $punkte += 10;
        $punkte -= min(20, max(0, count(explode(' ', $t)) - count($such['woerter']) - 8));   // lange Sammel-Namen etwas nach hinten
        if (preg_match('/\b(discography|diskografie|collection|anthology|top ?\d+|charts|various|va|sampler|bravo|now that)\b/i', $titel)) $punkte -= 15;
    }
    return ['passend' => $grund === '', 'grund' => $grund, 'punkte' => $punkte];
}

/**
 * Suche bei allen eingeschalteten Suchanbietern gleichzeitig (Prowlarr: JSON, Newznab: XML). Die Treffer kommen in ein
 * gemeinsames Format und laufen durch dieselbe Bewertung und Duplikaterkennung. Die Download-Links (mit Schlüssel) bleiben
 * auf dem Server, der Browser bekommt eine Such-ID. $kuenstler/$album (aus der Diskografie) erlauben Newznab-Indexern die
 * Musiksuche (t=music).
 */
function dl_suchen(string $begriff, string $kuenstler = '', string $album = ''): array
{
    dl_aktiv_pruefen();
    $begriff = trim($begriff);
    if (mb_strlen($begriff) < 2) {
        throw new ApiFehler(t('Bitte mindestens zwei Zeichen eingeben.'));
    }
    $indexer = dl_indexer_liste(true);
    if (!$indexer) {
        throw new ApiFehler(t('Noch kein Suchanbieter eingerichtet (Einstellungen → Downloads).'));
    }
    $clients = [];
    foreach (dl_client_liste() as $c) {
        $clients[$c['id']] = $c;
    }
    // Newznab-Indexer ohne gemerkte Fähigkeiten: einmal nachfragen (für t=music und das Limit)
    foreach ($indexer as &$i) {
        if ($i['art'] === 'newznab' && $i['caps'] === null) {
            try {
                $i['caps'] = dl_newznab_caps($i);
                db_tun('UPDATE download_dienste SET caps = :c WHERE id = :id', ['c' => json_encode($i['caps'], JSON_UNESCAPED_UNICODE), 'id' => $i['id']]);
            } catch (Throwable $e) {
                $i['caps'] = [];   // dann eben ohne – die Suche selbst zeigt, ob er antwortet
            }
        }
    }
    unset($i);
    $anfragen = [];
    foreach ($indexer as $n => $i) {
        if ($i['art'] === 'prowlarr') {
            $anfragen[$n] = ['url' => dl_prowlarr_url($i, '/api/v1/search', ['query' => $begriff, 'type' => 'search', 'categories' => $i['kategorien'], 'limit' => 100]),
                'kopf' => ['X-Api-Key: ' . $i['key'], 'Accept: application/json'], 'timeout' => 60];
        } else {
            $anfragen[$n] = ['url' => dl_newznab_url($i, dl_newznab_anfrage($i, $begriff, trim($kuenstler), trim($album))), 'kopf' => ['Accept: application/rss+xml, application/xml'], 'timeout' => 45];
        }
    }
    $antworten = dl_http_viele($anfragen);
    $treffer = [];
    $fehler = [];
    foreach ($indexer as $n => $i) {
        $r = $antworten[$n] ?? ['fehler' => t('keine Antwort')];
        try {
            if (isset($r['fehler'])) {
                throw new ApiFehler($r['fehler']);
            }
            $liste = $i['art'] === 'prowlarr' ? dl_prowlarr_treffer(dl_json($r, $i['name']), $i) : dl_newznab_treffer(dl_newznab_xml($r, $i['name']), $i);
        } catch (Throwable $e) {
            $fehler[] = ['indexer' => $i['name'], 'fehler' => $e->getMessage()];
            continue;
        }
        $c = $clients[$i['client_id']] ?? $clients[0];
        foreach ($liste as $t) {
            $treffer[] = $t + ['quelle' => $i['id'], 'quelle_art' => $i['art'], 'quelle_name' => $i['name'], 'client' => $c['id'], 'client_name' => $c['name'], 'client_bereit' => $c['bereit']];
        }
    }
    if (!$treffer && $fehler && count($fehler) === count($indexer)) {
        // alle Anbieter gescheitert: als Fehler melden (wie bisher bei nur Prowlarr)
        throw new ApiFehler(implode(' · ', array_map(static fn($f) => $f['fehler'], $fehler)));
    }
    // Relevanz prüfen und doppelte Releases zusammenfassen: gleiche GUID beim selben Anbieter oder gleicher Name bei mehreren
    // Indexern – der meistgeladene bleibt, die anderen stehen unter „auch“
    $such = dl_begriff_zerlegen($begriff);
    $nachName = [];
    $nachGuid = [];
    foreach ($treffer as $i => &$t) {
        $t += dl_relevanz($such, $t['titel'], $t['kategorien']);
        $t['auch'] = [];
        $g = $t['guid'] !== '' ? $t['quelle_art'] . $t['quelle'] . '|' . $t['guid'] : '';
        if ($g !== '' && isset($nachGuid[$g])) {
            $t['doppelt'] = true;
            continue;
        }
        if ($g !== '') {
            $nachGuid[$g] = $i;
        }
        $schluessel = dl_norm($t['titel']);
        if (isset($nachName[$schluessel])) {
            $j = $nachName[$schluessel];
            $besser = ($t['grabs'] ?? -1) > ($treffer[$j]['grabs'] ?? -1);
            [$bleibt, $weg] = $besser ? [$i, $j] : [$j, $i];
            $treffer[$bleibt]['auch'] = array_values(array_unique(array_merge($treffer[$bleibt]['auch'], [$treffer[$weg]['indexer']], $treffer[$weg]['auch'])));
            $treffer[$weg]['doppelt'] = true;
            $nachName[$schluessel] = $bleibt;
        } else {
            $nachName[$schluessel] = $i;
        }
    }
    unset($t);
    // Aufräumen: alte Suchen weg (eine Stunde)
    foreach (glob(dl_suche_ordner() . '/suche-*.json') ?: [] as $f) {
        if (filemtime($f) < time() - 3600) {
            @unlink($f);
        }
    }
    $id = bin2hex(random_bytes(8));
    file_put_contents(dl_suche_ordner() . '/suche-' . $id . '.json', json_encode(['begriff' => $begriff, 'treffer' => $treffer], JSON_UNESCAPED_UNICODE));
    $aus = [];
    foreach ($treffer as $i => $t) {
        if (!empty($t['doppelt'])) continue;
        unset($t['url'], $t['doppelt'], $t['guid']);
        $aus[] = $t + ['nr' => $i];
    }
    // passende zuerst, dann nach Punkten, dann nach Grabs
    usort($aus, static fn($a, $b) => [$b['passend'], $b['punkte'], $b['grabs'] ?? -1] <=> [$a['passend'], $a['punkte'], $a['grabs'] ?? -1]);
    return ['suche' => $id, 'treffer' => $aus, 'roh' => count($treffer), 'fehler' => $fehler, 'anbieter' => count($indexer)];
}

/**
 * NZB-Datei beim Suchanbieter abholen, über den der Treffer kam: Prowlarr mit seinem Schlüssel im Kopf, Newznab über die
 * gelieferte Adresse (trägt den Schlüssel meist schon; sonst wird er für denselben Server ergänzt).
 */
function dl_nzb_holen(array $t): string
{
    $art = (string) ($t['quelle_art'] ?? 'prowlarr');
    $idx = dl_indexer((int) ($t['quelle'] ?? 0));
    if (!$idx || $idx['art'] !== $art) {
        throw new ApiFehler(t('Der Suchanbieter dieses Treffers ist nicht mehr eingerichtet – bitte erneut suchen.'));
    }
    $url = (string) $t['url'];
    $kopf = [];
    if ($art === 'prowlarr') {
        $kopf[] = 'X-Api-Key: ' . $idx['key'];
    } else {
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        $q = [];
        parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
        if ($host === strtolower((string) parse_url($idx['url'], PHP_URL_HOST)) && !isset($q['apikey']) && !isset($q['r']) && !isset($q['i'])) {
            $url .= (str_contains($url, '?') ? '&' : '?') . 'apikey=' . rawurlencode($idx['key']);
        }
    }
    $nzb = dl_http($url, $kopf, null, 60);
    $kopfteil = substr($nzb['body'], 0, 4000);
    if ($art === 'newznab' && str_contains($kopfteil, '<error')) {
        dl_newznab_xml($nzb, $idx['name']);   // wirft mit verständlicher Meldung (Schlüssel, Limit …)
    }
    if ($nzb['status'] >= 400 || !str_contains($kopfteil, '<nzb')) {
        throw new ApiFehler(t('Der Indexer hat keine NZB-Datei geliefert (HTTP {status}).', ['status' => $nzb['status']]));
    }
    return $nzb['body'];
}

/** Treffer holen: NZB beim Suchanbieter laden und genau an den Downloadclient übergeben, der diesem Anbieter zugeordnet ist. */
function dl_holen(string $suche, int $nr, array $user, bool $trotzdem = false, string $kuenstler = '', string $album = ''): array
{
    dl_aktiv_pruefen();
    if (!preg_match('/^[a-f0-9]{16}$/', $suche)) {
        throw new ApiFehler(t('Ungültige Suche.'));
    }
    $datei = dl_suche_ordner() . '/suche-' . $suche . '.json';
    $gespeichert = is_file($datei) ? json_decode((string) file_get_contents($datei), true) : null;
    $liste = is_array($gespeichert) ? ($gespeichert['treffer'] ?? $gespeichert) : null;
    $begriff = is_array($gespeichert) ? (string) ($gespeichert['begriff'] ?? '') : '';
    $t = is_array($liste) ? ($liste[$nr] ?? null) : null;
    if (!$t) {
        throw new ApiFehler(t('Die Suche ist abgelaufen – bitte erneut suchen.'));
    }
    if (!$trotzdem) {
        $da = dl_schon_da($kuenstler, $album, (string) $t['titel']);
        if ($da) {
            return ['schon_da' => $da, 'ok' => false];
        }
    }
    // Suchen von vor der Erweiterung kennen weder Anbieter noch Client: Standard-Prowlarr → Standard-SABnzbd
    $c = dl_client((int) ($t['client'] ?? 0));
    if (!$c || !$c['bereit']) {
        throw new ApiFehler(t('Der Downloadclient für diesen Treffer ist nicht eingerichtet oder ausgeschaltet (Einstellungen → Downloads).'));
    }
    $body = dl_nzb_holen($t);
    $name = trim(preg_replace('/[^\pL\pN ._()\[\]&,+\'-]+/u', ' ', $t['titel']) ?: 'Download');
    $tmp = tempnam(sys_get_temp_dir(), 'awnzb');
    file_put_contents($tmp, $body);
    try {
        $r = dl_sab('addfile', ['cat' => $c['kategorie'], 'nzbname' => $name], ['name' => new CURLFile($tmp, 'application/x-nzb', $name . '.nzb')], $c);
    } finally {
        @unlink($tmp);
    }
    $nzo = (string) (($r['nzo_ids'] ?? [])[0] ?? '');
    if ($nzo === '') {
        throw new ApiFehler(t('{name} hat den Auftrag nicht angenommen.', ['name' => $c['name']]));
    }
    $id = db_einfuegen('INSERT INTO downloads (nzo_id, titel, indexer, groesse, status, user_id, suchbegriff, client_id, quelle_id, quelle_art, guid)
        VALUES (:n, :t, :i, :g, :s, :u, :q, :c, :qi, :qa, :gu)', [
        'n' => $nzo, 't' => mb_substr($t['titel'], 0, 500), 'i' => mb_substr((string) $t['indexer'], 0, 120), 'g' => $t['groesse'], 's' => 'gesendet', 'u' => (int) $user['id'],
        'q' => mb_substr(trim($kuenstler . ' ' . $album) ?: $begriff, 0, 300),
        'c' => $c['id'] ?: null, 'qi' => (int) ($t['quelle'] ?? 0), 'qa' => (string) ($t['quelle_art'] ?? 'prowlarr'), 'gu' => mb_substr((string) ($t['guid'] ?? ''), 0, 500),
    ]);
    return ['ok' => true, 'id' => $id, 'client' => $c['name']];
}

// ---------- Abgleich und Import ----------

/**
 * Status aus den Downloadclients übernehmen (schnell, ohne Kopieren). Jeder Auftrag wird nur bei SEINEM Client nachgeschaut
 * (client_id; Aufträge von vor der Erweiterung: Standard-SABnzbd) – Job-IDs sind nur je Client eindeutig.
 * Liefert Fehler je Client (Client nicht erreichbar), die übrigen Clients laufen trotzdem.
 */
function dl_abgleichen_status(): array
{
    $offen = db_alle("SELECT * FROM downloads WHERE status IN ('gesendet', 'laeuft') AND nzo_id IS NOT NULL");
    $jeClient = [];
    foreach ($offen as $d) {
        $jeClient[(int) ($d['client_id'] ?? 0)][] = $d;
    }
    $fehler = [];
    foreach ($jeClient as $cid => $liste) {
        $c = dl_client($cid);
        if (!$c || !$c['bereit']) {
            foreach ($liste as $d) {
                db_tun('UPDATE downloads SET meldung = :m WHERE id = :id', ['id' => $d['id'],
                    'm' => mb_substr(t('Downloadclient nicht mehr eingerichtet oder ausgeschaltet – Stand unbekannt'), 0, 1000)]);
            }
            continue;
        }
        try {
            dl_abgleichen_client($c, $liste);
        } catch (Throwable $e) {
            $fehler[] = $c['name'] . ': ' . $e->getMessage();
        }
    }
    return $fehler;
}

/** Abgleich der offenen Aufträge eines Downloadclients */
function dl_abgleichen_client(array $c, array $offen): void
{
    $schlange = dl_sab_queue($c, ['limit' => 200]);
    $queue = [];
    foreach (($schlange['slots'] ?? []) as $s) {
        $queue[(string) ($s['nzo_id'] ?? '')] = $s;
    }
    $hist = [];
    foreach ((dl_sab_history($c, ['limit' => 200, 'category' => $c['kategorie']])['slots'] ?? []) as $s) {
        $hist[(string) ($s['nzo_id'] ?? '')] = $s;
    }
    // Bewegt sich in der Schlange überhaupt etwas? (Wer nur wartet, hängt nicht, solange vor ihm geladen wird)
    $global_pause = !empty($schlange['paused']) && $schlange['paused'] !== 'False';
    $schlange_laedt = (float) ($schlange['kbpersec'] ?? 0) > 0;
    foreach ($offen as $d) {
        $n = (string) $d['nzo_id'];
        if (!isset($queue[$n]) && !isset($hist[$n])) {
            // gezielt nach der ID fragen, auch ohne Kategoriefilter (landet manchmal in einer anderen Kategorie)
            try {
                foreach ((dl_sab('history', ['nzo_ids' => $n, 'limit' => 5], null, $c)['history']['slots'] ?? []) as $s) {
                    if ((string) ($s['nzo_id'] ?? '') === $n) {
                        $hist[$n] = $s;
                    }
                }
            } catch (Throwable $e) {
                // dann gilt er als nicht gefunden
            }
        }
        if (isset($queue[$n])) {
            $q = $queue[$n];
            $st = (string) ($q['status'] ?? '');
            $prozent = (float) ($q['percentage'] ?? 0);
            db_tun('UPDATE downloads SET status = :s, prozent = :p, meldung = :m WHERE id = :id', [
                's' => 'laeuft', 'p' => $prozent, 'id' => $d['id'],
                'm' => mb_substr(trim($st . ((string) ($q['timeleft'] ?? '') !== '' ? ' · ' . t('noch {zeit}', ['zeit' => $q['timeleft']]) : '')), 0, 1000),
            ]);
            // Pause (ganz SABnzbd oder dieser Auftrag) ist Absicht; wer nur wartet, während andere laden, hängt nicht
            $ruht = $global_pause || $st === 'Paused' || ($st === 'Queued' && $schlange_laedt);
            $fp = 'q|' . $st . '|' . $prozent . '|' . (string) ($q['mbleft'] ?? '');
            $haengt = dl_waechter($d, $fp, $ruht, 'haengt');
            if ($haengt !== null) {
                if ($prozent >= 100 && dl_waechter_dateien_da((string) ($q['filename'] ?? ''), $c)) {
                    dl_waechter_fertig($d, (string) ($q['filename'] ?? ''), $haengt);
                } else {
                    db_tun("UPDATE downloads SET status = 'fehler', meldung = :m WHERE id = :id", ['id' => $d['id'],
                        'm' => mb_substr(t('Keine Bewegung in {client} seit {min} min bei {prozent} % ({status}) – abgebrochen und aus der Warteschlange genommen.', ['client' => $c['name'], 'min' => $haengt, 'prozent' => dl_prozent($prozent), 'status' => $st ?: t('ohne Status')]), 0, 1000)]);
                    try {
                        dl_sab('queue', ['name' => 'delete', 'value' => $n, 'del_files' => 1], null, $c);
                    } catch (Throwable $e) {
                        // bleibt dann in SABnzbd stehen; hier zählt er als gescheitert
                    }
                }
            }
        } elseif (isset($hist[$n])) {
            $h = $hist[$n];
            $st = (string) ($h['status'] ?? '');
            if ($st === 'Completed') {
                db_tun("UPDATE downloads SET status = 'fertig', prozent = 100, pfad_sab = :p, fertig_am = NOW(), meldung = :m WHERE id = :id",
                    ['m' => t('Fertig geladen – wird kopiert und eingelesen'), 'p' => mb_substr((string) ($h['storage'] ?? ''), 0, 1000), 'id' => $d['id']]);
            } elseif ($st === 'Failed') {
                db_tun("UPDATE downloads SET status = 'fehler', meldung = :m WHERE id = :id", ['m' => mb_substr(t('{wer}: {fehler}', ['wer' => $c['name'], 'fehler' => (string) ($h['fail_message'] ?? t('fehlgeschlagen'))]), 0, 1000), 'id' => $d['id']]);
            } else {
                // Nachbearbeitung (Prüfen, Reparieren, Entpacken, Verschieben, Skript)
                db_tun('UPDATE downloads SET status = :s, prozent = 100, meldung = :m WHERE id = :id', ['s' => 'laeuft', 'm' => $c['name'] . ': ' . $st, 'id' => $d['id']]);
                $fp = 'h|' . $st . '|' . (string) ($h['action_line'] ?? '');
                $haengt = dl_waechter($d, $fp, false, 'haengt');
                if ($haengt !== null) {
                    $pfad = (string) ($h['storage'] ?? '') !== '' ? (string) $h['storage'] : (string) ($h['name'] ?? '');
                    if (dl_waechter_dateien_da($pfad, $c)) {
                        dl_waechter_fertig($d, $pfad, $haengt);
                    } else {
                        db_tun("UPDATE downloads SET status = 'fehler', meldung = :m WHERE id = :id", ['id' => $d['id'],
                            'm' => mb_substr(t('{client} hängt seit {min} min bei „{status}“ und im Download-Ordner liegt nichts Brauchbares – gescheitert.', ['client' => $c['name'], 'min' => $haengt, 'status' => $st]), 0, 1000)]);
                    }
                }
            }
        } else {
            // weder in der Schlange noch im Verlauf: nach der Wartezeit gescheitert
            $weg = dl_waechter($d, 'weg', false, 'weg');
            if ($weg !== null) {
                db_tun("UPDATE downloads SET status = 'fehler', meldung = :m WHERE id = :id",
                    ['m' => t('In {client} seit {min} min nicht mehr zu finden (gelöscht?) – gescheitert.', ['client' => $c['name'], 'min' => $weg]), 'id' => $d['id']]);
            }
        }
    }
}

function dl_prozent(float $p): string
{
    return zahl_fmt(round($p, $p < 10 ? 1 : 0), $p < 10 ? 1 : 0);
}

/**
 * Wächter: Fingerabdruck merken; ändert er sich, läuft die Uhr neu. Gibt die Minuten zurück, wenn die Wartezeit
 * (download_haengt_min bzw. download_weg_min) ohne Änderung abgelaufen ist, sonst null. $ruht = Uhr anhalten (Pause).
 */
function dl_waechter(array $d, string $fp, bool $ruht, string $art): ?int
{
    $fp = mb_substr($fp, 0, 255);
    if ($ruht || (string) ($d['fingerabdruck'] ?? '') !== $fp || empty($d['bewegt_am'])) {
        db_tun('UPDATE downloads SET fingerabdruck = :f, bewegt_am = NOW() WHERE id = :id', ['f' => $fp, 'id' => $d['id']]);
        return null;
    }
    $min = max(5, (int) einstellung($art === 'weg' ? 'download_weg_min' : 'download_haengt_min'));
    $seit = (int) db_wert('SELECT TIMESTAMPDIFF(SECOND, bewegt_am, NOW()) FROM downloads WHERE id = :id', ['id' => $d['id']]);
    return $seit >= $min * 60 ? (int) floor($seit / 60) : null;
}

/** Liegen unter diesem Namen (SABnzbd-Pfad oder Auftragsname) Audiodateien im Download-Ordner? */
function dl_waechter_dateien_da(string $pfad, ?array $client = null): bool
{
    if (trim($pfad) === '') {
        return false;
    }
    $q = dl_quelle_finden(['pfad_sab' => $pfad, 'client_id' => $client['id'] ?? 0]);
    if ($q === null) {
        return false;
    }
    $typen = konfig()['scan']['dateitypen'];
    if (is_file($q)) {
        return in_array(strtolower(pathinfo($q, PATHINFO_EXTENSION)), $typen, true) && filesize($q) > 0;
    }
    try {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($q, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            if ($f->isFile() && $f->getSize() > 0 && in_array(strtolower($f->getExtension()), $typen, true)) {
                return true;
            }
        }
    } catch (Throwable $e) {
        return false;
    }
    return false;
}

/** SABnzbd meldet sich nicht mehr, aber die Dateien sind da: als fertig weiterreichen (Import kopiert und prüft) */
function dl_waechter_fertig(array $d, string $pfad, int $min): void
{
    db_tun("UPDATE downloads SET status = 'fertig', prozent = 100, pfad_sab = :p, fertig_am = NOW(), meldung = :m WHERE id = :id", [
        'p' => mb_substr($pfad, 0, 1000), 'id' => $d['id'],
        'm' => t('SABnzbd meldet seit {min} min nichts Neues, die Dateien sind aber da – wird kopiert und eingelesen', ['min' => $min]),
    ]);
}

/**
 * Wo liegt der fertige Download bei uns? Der Client meldet seinen eigenen Pfad – wir nehmen den letzten Namensteil und suchen
 * ihn im Import-Ordner DIESES Clients (DOWNLOAD_PFAD oder sein Unterordner).
 */
function dl_quelle_finden(array $d): ?string
{
    $wurzel = rtrim(dl_client_wurzel(dl_client_von($d)), '/');
    $name = basename(str_replace('\\', '/', (string) $d['pfad_sab']));
    if ($name === '' || $name === '.' || $name === '..') {
        return null;
    }
    $p = $wurzel . '/' . $name;
    $echt = realpath($p);
    $w = realpath($wurzel);
    if ($echt === false || $w === false || !str_starts_with($echt, $w . '/')) {
        return null;
    }
    return $echt;
}

/** Dateien, die mitkommen: Audio und Beilagen (Cover, Booklet, Cue, Log) – kein Par2, NFO, SFV, NZB */
function dl_mitnehmen(string $datei): bool
{
    $n = basename($datei);
    if ($n === '' || $n[0] === '.' || af_ist_muell($n)) {
        return false;
    }
    $ext = strtolower(pathinfo($n, PATHINFO_EXTENSION));
    return in_array($ext, konfig()['scan']['dateitypen'], true) || in_array($ext, DL_AUDIO_BEILAGEN, true);
}

/** Einen fertigen Download in den Musikordner kopieren. Gibt den Zielpfad (relativ) zurück. */
function dl_importieren(array $d): array
{
    $k = dl_konfig();
    if (($konflikt = download_ordner_konflikt()) !== null) {
        throw new RuntimeException(t('Import angehalten: {grund}', ['grund' => $konflikt]));
    }
    $quelle = dl_quelle_finden($d);
    $originalPfad = $quelle; // Ordner des Releases oder einzelne Datei direkt im Download-Ordner
    if ($quelle === null) {
        $c = dl_client_von($d);
        throw new RuntimeException(t('Nicht gefunden unter {pfad} – ist das der Ordner, in den {client} die Kategorie „{kategorie}“ ablegt?',
            ['pfad' => dl_client_wurzel($c) . '/' . basename((string) $d['pfad_sab']), 'client' => $c['name'] ?? 'SABnzbd', 'kategorie' => $c['kategorie'] ?? $k['sab_kat']]));
    }
    $musik = af_wurzel();
    $basis = af_sicher(is_dir($quelle) ? basename($quelle) : pathinfo($quelle, PATHINFO_FILENAME));
    $zielRel = af_sicher($k['ziel']) . '/' . $basis;
    for ($i = 2; file_exists($musik . '/' . $zielRel); $i++) {
        $zielRel = af_sicher($k['ziel']) . '/' . $basis . ' (' . $i . ')';
    }
    $dateien = [];
    if (is_dir($quelle)) {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($quelle, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            if ($f->isFile() && dl_mitnehmen($f->getPathname())) {
                $dateien[] = substr($f->getPathname(), strlen($quelle) + 1);
            }
        }
    } elseif (dl_mitnehmen($quelle)) {
        $dateien[] = basename($quelle);
        $quelle = dirname($quelle);
    }
    $audio = array_filter($dateien, static fn($r) => in_array(strtolower(pathinfo($r, PATHINFO_EXTENSION)), konfig()['scan']['dateitypen'], true));
    if (!$audio) {
        throw new RuntimeException(t('Im Download ist keine Musikdatei (vielleicht noch gepackt oder ein anderes Format).'));
    }
    $t = af_schreibtest();
    if (!$t['ok']) {
        throw new RuntimeException(t('Der Musikordner ist nicht beschreibbar: {grund}', ['grund' => $t['meldung']]));
    }
    $zuFlac = einstellung('download_wav_flac') !== '0';
    $umgewandelt = 0;
    foreach ($dateien as $rel) {
        $von = $quelle . '/' . $rel;
        $nach = $musik . '/' . $zielRel . '/' . $rel;
        if (!af_ordner_anlegen(dirname($nach))) {
            throw new RuntimeException(t('Ordner konnte nicht angelegt werden: {pfad}', ['pfad' => dirname($nach)]));
        }
        $ext = strtolower(pathinfo($rel, PATHINFO_EXTENSION));
        if ($zuFlac && in_array($ext, ['wav', 'aif', 'aiff'], true)) {
            // verlustfrei nach FLAC (prüft die Samples per MD5); erst unter verstecktem Namen, dann umbenennen
            $nach = preg_replace('/\.[^.\/]+$/', '.flac', $nach);
            $tmp = dirname($nach) . '/.aw-import-' . bin2hex(random_bytes(4)) . '.flac';
            try {
                ue_zu_flac($von, $tmp, true);
                if (!@rename($tmp, $nach)) {
                    throw new RuntimeException(t('Umbenennen fehlgeschlagen'));
                }
            } catch (Throwable $e) {
                @unlink($tmp);
                throw new RuntimeException(t('Umwandeln nach FLAC fehlgeschlagen ({datei}): {grund}', ['datei' => $rel, 'grund' => $e->getMessage()]));
            }
            $umgewandelt++;
        } elseif (!@copy($von, $nach) || filesize($von) !== filesize($nach)) {
            @unlink($nach);
            throw new RuntimeException(t('Kopieren fehlgeschlagen: {datei}', ['datei' => $rel]));
        }
        af_datei_rechte($nach);
    }
    // Alles ist angekommen (jede Datei mit gleicher Größe geprüft) – jetzt erst das Original entfernen
    $original = 'behalten';
    if ($k['nach_import'] === 'loeschen') {
        $original = dl_original_entfernen($originalPfad, dl_client_wurzel(dl_client_von($d)));
    }
    return ['ziel' => $zielRel, 'original' => $original, 'flac' => $umgewandelt];
}

/**
 * Original im Download-Ordner entfernen (Ordner oder einzelne Datei direkt in der Wurzel). Nur innerhalb des Download-Ordners.
 * Liefert 'weg' | 'nur_lesbar' (Ordner ro eingebunden) | 'fehler'.
 */
function dl_original_entfernen(string $abs, ?string $wurzel = null): string
{
    if (download_ordner_konflikt() !== null || dl_pfad_im_musikordner($wurzel ?? dl_konfig()['wurzel'])) {
        return 'fehler'; // Download- und Musikordner überschneiden sich: nie etwas löschen
    }
    $w = realpath($wurzel ?? dl_konfig()['wurzel']);
    $echt = realpath($abs);
    if ($w === false || $echt === false || $echt === $w || !str_starts_with($echt, $w . '/')) {
        return 'fehler';
    }
    if (!is_writable(dirname($echt))) {
        return 'nur_lesbar';
    }
    if (is_file($echt)) {
        return @unlink($echt) ? 'weg' : 'fehler';
    }
    dl_ordner_loeschen($echt, $w);
    return file_exists($echt) ? 'fehler' : 'weg';
}

/** Liegt dieser Ordner im Musikordner (oder ist er es)? Dann wird dort nie etwas gelöscht. */
function dl_pfad_im_musikordner(string $pfad): bool
{
    $p = realpath($pfad);
    $m = realpath((string) konfig()['pfade']['musik']);
    return $p !== false && $m !== false && ($p === $m || str_starts_with($p . '/', $m . '/'));
}

/**
 * Nachträglich aufräumen: Originale schon importierter Downloads löschen (z. B. aus der Zeit, als „behalten“ eingestellt war,
 * oder als der Ordner noch nur lesbar war). Gelöscht wird nur, wenn jede Musikdatei des Originals mit gleicher Größe in der
 * Bibliothek steht – das hält auch, wenn das Album inzwischen umbenannt oder verschoben wurde.
 */
function dl_originale_aufraeumen(int $max = 10): int
{
    $k = dl_konfig();
    if ($k['nach_import'] !== 'loeschen' || download_ordner_konflikt() !== null) {
        return 0;
    }
    $n = 0;
    $typen = konfig()['scan']['dateitypen'];
    foreach (db_alle("SELECT * FROM downloads WHERE status = 'importiert' AND original_weg = 0 ORDER BY id LIMIT " . (int) $max) as $d) {
        $quelle = dl_quelle_finden($d);
        if ($quelle === null) {
            db_tun('UPDATE downloads SET original_weg = 1 WHERE id = :id', ['id' => $d['id']]); // schon weg (von Hand oder von SABnzbd)
            continue;
        }
        $groessen = [];
        if (is_dir($quelle)) {
            foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($quelle, FilesystemIterator::SKIP_DOTS)) as $f) {
                if ($f->isFile() && in_array(strtolower($f->getExtension()), $typen, true)) {
                    $groessen[] = (int) $f->getSize();
                }
            }
        } elseif (in_array(strtolower(pathinfo($quelle, PATHINFO_EXTENSION)), $typen, true)) {
            $groessen[] = (int) filesize($quelle);
        }
        $alleDa = $groessen !== [];
        foreach ($groessen as $g) {
            if (!db_wert('SELECT 1 FROM dateien WHERE groesse = :g LIMIT 1', ['g' => $g])) {
                $alleDa = false;
                break;
            }
        }
        if (!$alleDa) {
            continue; // noch nicht (fertig) eingelesen – später nochmal
        }
        $r = dl_original_entfernen($quelle, dl_client_wurzel(dl_client_von($d)));
        if ($r === 'weg') {
            db_tun('UPDATE downloads SET original_weg = 1, meldung = :m WHERE id = :id', ['m' => mb_substr(preg_replace('/ · Original .*$/u', '', (string) $d['meldung']) . ' · ' . t('Original im Download-Ordner gelöscht'), 0, 1000), 'id' => $d['id']]);
            $n++;
        } elseif ($r === 'nur_lesbar') {
            break; // Ordner ist nur lesbar eingebunden – bei den anderen genauso
        }
    }
    return $n;
}

/** Quelle nach erfolgreichem Kopieren löschen (nur innerhalb des Import-Ordners des Clients bzw. des Download-Ordners) */
function dl_ordner_loeschen(string $abs, ?string $wurzel = null): void
{
    $w = realpath($wurzel ?? dl_konfig()['wurzel']);
    $echt = realpath($abs);
    if ($w === false || $echt === false || !str_starts_with($echt, $w . '/')) {
        return;
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($echt, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) {
        $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
    }
    @rmdir($echt);
}

/** Alles Fertige importieren und danach einlesen (Hintergrund / Zeitplan) */
function dl_importe(): int
{
    require_once __DIR__ . '/schreibschutz.php';
    if (!musik_schreiben_erlaubt()) {
        // Musikordner auf „nur lesen“: Fertiges bleibt im Download-Ordner liegen und wird übernommen, sobald Schreiben erlaubt ist
        db_tun("UPDATE downloads SET meldung = :m WHERE status = 'fertig'", ['m' => mb_substr(t('Wartet: Der Musikordner steht auf „nur lesen“ (Einstellungen → Bibliothek & Automatik).'), 0, 1000)]);
        return 0;
    }
    $n = 0;
    foreach (db_alle("SELECT * FROM downloads WHERE status = 'fertig' ORDER BY id") as $d) {
        try {
            $imp = dl_importieren($d);
            $ziel = $imp['ziel'];
            $zusatz = ['weg' => ' · ' . t('Original im Download-Ordner gelöscht'), 'nur_lesbar' => ' · ' . t('Original bleibt: Download-Ordner ist nur lesbar eingebunden (DOWNLOAD_MOUNT_MODUS=rw)'),
                'fehler' => ' · ' . t('Original konnte nicht gelöscht werden'), 'behalten' => ''][$imp['original']] ?? '';
            $zusatz = (!empty($imp['flac']) ? ' · ' . t('{n} WAV/AIFF verlustfrei als FLAC', ['n' => $imp['flac']]) : '') . $zusatz;
            db_tun("UPDATE downloads SET status = 'importiert', pfad_ziel = :z, meldung = :m, original_weg = :o WHERE id = :id",
                ['z' => $ziel, 'm' => t('Kopiert nach {ziel}', ['ziel' => $ziel]) . $zusatz, 'o' => $imp['original'] === 'weg' ? 1 : 0, 'id' => $d['id']]);
            $n++;
        } catch (Throwable $e) {
            // SABnzbd verschiebt manchmal noch ein paar Sekunden: erst nach 10 Minuten als Fehler werten
            $alt = strtotime((string) ($d['fertig_am'] ?? 'now')) < time() - 600;
            db_tun('UPDATE downloads SET status = :s, meldung = :m WHERE id = :id',
                ['s' => $alt ? 'fehler' : 'fertig', 'm' => mb_substr($e->getMessage(), 0, 1000), 'id' => $d['id']]);
        }
    }
    if ($n > 0) {
        if (scan_laufend()) {
            einstellung_setzen('download_scan_noetig', '1'); // der Zeitplan liest ein, sobald der laufende Scan fertig ist
        } else {
            scan_starten(false, null);
        }
    }
    return $n;
}

/** Hintergrundprozess für den Import starten (falls etwas fertig ist) */
function dl_import_anstossen(): void
{
    if (!db_wert("SELECT COUNT(*) FROM downloads WHERE status = 'fertig'")) {
        return;
    }
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) realpath(__DIR__ . '/../scripts/downloads.php')) . ' > /dev/null 2>&1 &');
}

/** Für die Oberfläche: Einrichtung, Ordner, Aufträge */
function dl_stand(): array
{
    $k = dl_konfig();
    $fehler = '';
    if (dl_sab_bereit()) {
        try {
            $f = dl_abgleichen_status();
            $fehler = implode(' · ', $f);
            dl_import_anstossen();
        } catch (Throwable $e) {
            $fehler = $e->getMessage();
        }
    }
    $wurzel = $k['wurzel'];
    $clients = dl_client_liste();
    $cName = [];
    foreach ($clients as $c) {
        $cName[$c['id']] = $c['name'];
    }
    $auftraege = db_alle('SELECT id, titel, indexer, groesse, status, prozent, pfad_ziel, meldung, angelegt_am, fertig_am, suchbegriff, pfad_sab, einsortiert_am, client_id FROM downloads ORDER BY id DESC LIMIT 60');
    foreach ($auftraege as &$a) {
        $a['client'] = $cName[(int) ($a['client_id'] ?? 0)] ?? t('(entfernter Client)');
        unset($a['client_id']);
    }
    unset($a);
    return [
        'aktiv' => dl_aktiv(),
        'prowlarr' => dl_prowlarr_bereit(),   // irgendein Suchanbieter bereit (Name aus der Zeit, als es nur Prowlarr gab)
        'sab' => dl_sab_bereit(),             // irgendein Downloadclient bereit
        'indexer' => array_map(static fn($i) => ['id' => $i['id'], 'art' => $i['art'], 'name' => $i['name'], 'bereit' => $i['bereit'], 'client' => $cName[$i['client_id']] ?? ''], dl_indexer_liste()),
        'clients' => array_map(static fn($c) => ['id' => $c['id'], 'name' => $c['name'], 'bereit' => $c['bereit'], 'kategorie' => $c['kategorie']], $clients),
        'ordner' => ['pfad' => $wurzel, 'da' => is_dir($wurzel), 'lesbar' => is_dir($wurzel) && is_readable($wurzel)],
        'ziel' => $k['ziel'],
        'kategorie' => $k['sab_kat'],
        'nach_import' => $k['nach_import'],
        'einsortieren' => einstellung('download_einsortieren') === '1',
        'fehler' => $fehler,
        'konflikt' => download_ordner_konflikt(),
        'pruefung' => dl_pruefen(false),
        'auftraege' => $auftraege,
    ];
}

/**
 * Selbstprüfung der Download-Konfiguration. Liefert eine Liste von Prüfungen [{ok, text, tipp}] – jede mit dem, was in der
 * .env, in den Einstellungen oder im Client zu ändern ist. Läuft auf Knopfdruck (Einstellungen) und beim Öffnen der
 * Downloads (ohne Netz). Geprüft wird jeder eingeschaltete Suchanbieter und jeder Downloadclient mit seinem Import-Ordner.
 * Schlüssel: prowlarr / sab / ordner / schreiben / pfad für den Standard, mit _<id> für die weiteren.
 */
function dl_pruefen(bool $mitNetz = true): array
{
    $k = dl_konfig();
    $p = [];
    $ok = static fn(string $t, string $tipp = '') => ['ok' => true, 'text' => $t, 'tipp' => $tipp];
    $nein = static fn(string $t, string $tipp = '') => ['ok' => false, 'text' => $t, 'tipp' => $tipp];
    if ($mitNetz) {
        foreach (dl_indexer_liste() as $i) {
            if (!$i['aktiv'] || ($i['standard'] && $i['url'] === '' && $i['key'] === '' && count(dl_indexer_liste(true)) > 0)) {
                continue; // ausgeschaltet oder unbenutzter Standard-Prowlarr neben anderen Anbietern
            }
            $schl = $i['standard'] ? 'prowlarr' : 'idx_' . $i['id'];
            $p[$schl] = dl_indexer_pruefen($i);
        }
    }
    $clients = array_filter(dl_client_liste(), static fn($c) => $c['aktiv'] && ($c['url'] !== '' || $c['standard']));
    $mehrere = count(dl_client_liste(true)) > 1;
    foreach ($clients as $c) {
        if ($c['standard'] && $c['url'] === '' && $c['key'] === '' && dl_client_liste(true)) {
            continue; // unbenutzter Standard-SABnzbd neben anderen Clients
        }
        foreach (dl_client_pruefen($c, $mitNetz, $mehrere) as $n => $x) {
            $p[$n . ($c['standard'] ? '' : '_' . $c['id'])] = $x;
        }
    }
    // Trennung vom Musikordner
    $w = $k['wurzel'];
    if (($konflikt = download_ordner_konflikt()) !== null) {
        $p['trennung'] = $nein($konflikt, t('DOWNLOAD_PFAD in der .env auf einen eigenen Ordner außerhalb des Import-Ziels zeigen lassen und den Downloadclient dorthin laden lassen.'));
    } elseif (is_dir($w)) {
        $p['trennung'] = $ok(t('Download-Ordner und Musikordner sind getrennt'));
    }
    // Import-Ziel im Musikordner
    $t = af_schreibtest();
    $p['ziel'] = $t['ok'] ? $ok(t('Import-Ziel Musikordner/{ziel} – Musikordner ist beschreibbar', ['ziel' => $k['ziel']])) : $nein(t('Musikordner ist nicht beschreibbar: {grund}', ['grund' => $t['meldung']]), t('Compose: Musik mit :rw einbinden; Rechte prüfen (Rechte reparieren unter Bibliothek → Dateien aufräumen).'));
    $alle = !in_array(false, array_map(static fn($x) => $x['ok'], $p), true);
    return ['ok' => $alle, 'pruefungen' => $p];
}

/** Ein Suchanbieter erreichbar? Prowlarr: system/status; Newznab: t=caps (die Fähigkeiten werden dabei gemerkt) */
function dl_indexer_pruefen(array $i): array
{
    if ($i['url'] === '' || $i['key'] === '') {
        return ['ok' => false, 'text' => t('{name}: Adresse oder API-Schlüssel fehlt', ['name' => $i['name']]), 'tipp' => t('Unter Einstellungen → Downloads eintragen.')];
    }
    try {
        if ($i['art'] === 'prowlarr') {
            $s = dl_prowlarr('/api/v1/system/status', [], $i);
            return ['ok' => true, 'text' => t('{name} {version} erreichbar', ['name' => $i['name'], 'version' => $s['version'] ?? '']), 'tipp' => ''];
        }
        $caps = dl_newznab_caps($i);
        if (!$i['standard']) {
            db_tun('UPDATE download_dienste SET caps = :c WHERE id = :id', ['c' => json_encode($caps, JSON_UNESCAPED_UNICODE), 'id' => $i['id']]);
            dl_dienste_zeilen(true);
        }
        $musik = $caps['music']['an'] ? t('Musiksuche ({param})', ['param' => implode(', ', $caps['music']['param'])]) : t('keine Musiksuche, nur allgemeine Suche');
        $fehlend = array_diff($i['kategorien'], array_keys($caps['kategorien']));
        if (!$caps['search']['an'] && !$caps['music']['an']) {
            return ['ok' => false, 'text' => t('{name} erreichbar, bietet aber keine Suche an', ['name' => $i['name']]), 'tipp' => t('In den Fähigkeiten (t=caps) ist weder search noch music-search verfügbar.')];
        }
        if ($fehlend && $caps['kategorien']) {
            return ['ok' => null, 'text' => t('{name} erreichbar · {musik} · Kategorie {kat} kennt der Indexer nicht', ['name' => $i['name'], 'musik' => $musik, 'kat' => implode(', ', $fehlend)]),
                'tipp' => t('Kategorien prüfen – Musik ist bei Newznab 3000 (Audio), 3010 (MP3), 3040 (Lossless).')];
        }
        return ['ok' => true, 'text' => t('{name} erreichbar · {musik}', ['name' => $i['name'] . ($caps['titel'] !== '' && $caps['titel'] !== $i['name'] ? ' (' . $caps['titel'] . ')' : ''), 'musik' => $musik]), 'tipp' => ''];
    } catch (Throwable $e) {
        return ['ok' => false, 'text' => t('{name}: {fehler}', ['name' => $i['name'], 'fehler' => $e->getMessage()]),
            'tipp' => $i['art'] === 'prowlarr' ? t('Adresse und API-Schlüssel unter Einstellungen → Downloads (oder PROWLARR_URL / PROWLARR_API_KEY).') : t('Adresse, API-Pfad (meist /api) und API-Schlüssel unter Einstellungen → Downloads prüfen.')];
    }
}

/** Ein Downloadclient: erreichbar, Kategorie da, Import-Ordner eingebunden/lesbar/beschreibbar, passt sein Ablageort dazu? */
function dl_client_pruefen(array $c, bool $mitNetz, bool $mehrere): array
{
    $k = dl_konfig();
    $p = [];
    $ok = static fn(string $t, string $tipp = '') => ['ok' => true, 'text' => $t, 'tipp' => $tipp];
    $nein = static fn(string $t, string $tipp = '') => ['ok' => false, 'text' => $t, 'tipp' => $tipp];
    $vor = $mehrere ? $c['name'] . ': ' : '';
    $kat = $c['kategorie'];
    $sabPfade = [];
    if ($mitNetz) {
        $ohneName = static fn(Throwable $e) => preg_replace('/^' . preg_quote($c['name'], '/') . ':\s*/u', '', $e->getMessage());
        $tippAdresse = $c['standard'] ? t('Adresse und API-Schlüssel unter Einstellungen → Downloads (oder SABNZBD_URL / SABNZBD_API_KEY).') : t('Adresse, API-Pfad und API-Schlüssel unter Einstellungen → Downloads prüfen.');
        try {
            // 1. Pflicht: version – zeigt Erreichbarkeit, Schlüssel und ob überhaupt eine SABnzbd-Schnittstelle antwortet
            $v = dl_sab('version', [], null, $c);
            $version = is_scalar($v['version'] ?? null) ? trim((string) $v['version']) : '';
            if ($version === '') {
                throw dl_sab_aufbau_fehler($c, 'version', '{"version": "…"}');
            }
            // 2. Kategorien: get_cats, sonst get_config (optional – fehlt beides, ist die Kategorie nur nicht prüfbar)
            $kinfo = dl_sab_kategorien($c);
            $kats = $kinfo['kategorien'];
            $woher = $kinfo['quelle'] === 'get_config' ? ' ' . t('(laut get_config)') : '';
            $liste = $kats ? implode(', ', array_filter($kats, static fn($x) => $x !== '*')) : '';
            if ($kats === null) {
                $p['sab'] = ['ok' => null, 'text' => t('{name} {version} erreichbar – ob es die Kategorie „{kategorie}“ gibt, lässt sich nicht abfragen', ['name' => $c['name'], 'version' => $version, 'kategorie' => $kat]),
                    'tipp' => $kinfo['hinweise'] ? t('Der Client bietet weder get_cats noch get_config an ({was}). Downloads funktionieren trotzdem, solange es die Kategorie dort gibt.', ['was' => implode('; ', $kinfo['hinweise'])]) : ''];
            } elseif (in_array($kat, $kats, true)) {
                $p['sab'] = $ok(t('{name} {version} erreichbar, Kategorie „{kategorie}“ vorhanden', ['name' => $c['name'], 'version' => $version, 'kategorie' => $kat]) . $woher);
            } else {
                $p['sab'] = $nein(t('{name} erreichbar, aber die Kategorie „{kategorie}“ gibt es dort nicht', ['name' => $c['name'], 'kategorie' => $kat]) . $woher,
                    t('Im Downloadclient die Kategorie anlegen oder unter Einstellungen → Downloads eine vorhandene wählen ({liste}).', ['liste' => $liste !== '' ? $liste : '–']));
            }
            // Wo legt der Client die Kategorie ab? complete_dir + Kategorie-Ordner (relativ) oder absoluter Kategorie-Pfad
            $katDir = $kinfo['kat_ordner'][$kat] ?? '';
            if ($kinfo['complete'] !== '' || $katDir !== '') {
                $sabPfade = ['complete' => $kinfo['complete'], 'kat' => $katDir];
            }
            // 3. Pflicht für den Betrieb: Warteschlange und Verlauf lesen (addfile lässt sich ohne echten Auftrag nicht prüfen)
            $fehlt = [];
            foreach (['queue' => 'dl_sab_queue', 'history' => 'dl_sab_history'] as $m => $fn) {
                try {
                    $fn($c, ['limit' => 1]);
                } catch (Throwable $e) {
                    if (dl_sab_fehlerart($e) === DL_SAB_NETZ || dl_sab_fehlerart($e) === DL_SAB_AUTH) {
                        throw $e;
                    }
                    $fehlt[] = $ohneName($e);
                }
            }
            $p['api'] = $fehlt
                ? $nein(t('{vor}Warteschlange/Verlauf nicht lesbar: {fehler}', ['vor' => $vor ?: $c['name'] . ': ', 'fehler' => implode(' · ', $fehlt)]),
                    t('Amberwave braucht von einem SABnzbd-kompatiblen Client die Befehle addfile, queue und history – ohne sie lässt sich ein Download nicht verfolgen.'))
                : $ok(t('{vor}Warteschlange und Verlauf abrufbar', ['vor' => $vor ?: $c['name'] . ': ']));
        } catch (Throwable $e) {
            $art = dl_sab_fehlerart($e);
            $tipp = match ($art) {
                DL_SAB_NETZ => t('Läuft der Client, und stimmen Adresse und Port? Aus dem Amberwave-Container muss er unter dieser Adresse erreichbar sein (nicht „localhost“, sondern IP des Servers).'),
                DL_SAB_AUTH => t('Den API-Schlüssel aus den Einstellungen des Clients kopieren (bei SABnzbd: Config → General → API Key, nicht der NZB-Schlüssel).'),
                DL_SAB_PFAD => t('Unter Adresse + API-Pfad antwortet nichts. SABnzbd: /api, hinter Proxy z. B. /sabnzbd/api; kompatible Dienste nennen ihren Pfad (z. B. /api/sabnzbd).'),
                DL_SAB_MODUS => t('Der Dienst kennt nicht einmal den Grundbefehl „version“ – ist er wirklich SABnzbd-kompatibel, und stimmt der API-Pfad?'),
                DL_SAB_ANTWORT => t('Unter dieser Adresse antwortet etwas, aber keine SABnzbd-Schnittstelle (oft eine Weboberfläche oder ein Proxy). API-Pfad prüfen.'),
                default => $tippAdresse,
            };
            $p['sab'] = $nein(t('{name}: {fehler}', ['name' => $c['name'], 'fehler' => $ohneName($e)]), $tipp);
        }
    }
    $w = dl_client_wurzel($c);
    $env = $c['import_ordner'] === '' ? 'DOWNLOAD_PFAD' : 'DOWNLOAD_PFAD/' . $c['import_ordner'];
    if (!is_dir($w)) {
        $p['ordner'] = $nein(t('{vor}Download-Ordner {pfad} ist im Container nicht eingebunden', ['vor' => $vor, 'pfad' => $w]),
            $c['import_ordner'] === '' ? t('In der .env DOWNLOAD_PFAD auf den Ordner setzen, in den SABnzbd die Kategorie „{kategorie}“ ablegt (z. B. /mnt/user/downloads/complete/music), dann docker compose up -d.', ['kategorie' => $kat])
                : t('Den Ordner, in den {client} die Kategorie „{kategorie}“ ablegt, als Unterordner „{unter}“ unter DOWNLOAD_PFAD einbinden – oder den Import-Ordner dieses Clients anpassen.', ['client' => $c['name'], 'kategorie' => $kat, 'unter' => $c['import_ordner']]));
    } elseif (!is_readable($w)) {
        $p['ordner'] = $nein(t('{vor}Download-Ordner {pfad} ist nicht lesbar', ['vor' => $vor, 'pfad' => $w]), t('Rechte des Ordners auf dem Server prüfen (Unraid: Tools → New Permissions auf den Download-Share).'));
    } elseif (dl_pfad_im_musikordner($w)) {
        $p['ordner'] = $nein(t('{vor}Import-Ordner {pfad} liegt im Musikordner', ['vor' => $vor, 'pfad' => $w]), t('Der Client muss in einen eigenen Ordner außerhalb des Musikordners laden.'));
    } else {
        $p['ordner'] = $ok(t('{vor}Download-Ordner {pfad} ist eingebunden und lesbar', ['vor' => $vor, 'pfad' => $w]));
    }
    if (is_dir($w)) {
        if ($k['nach_import'] === 'loeschen') {
            $p['schreiben'] = is_writable($w)
                ? $ok(t('{vor}Download-Ordner ist beschreibbar – Originale werden nach dem Import gelöscht', ['vor' => $vor]))
                : $nein(t('{vor}Download-Ordner ist nur lesbar, „Original löschen“ ist aber eingestellt', ['vor' => $vor]), t('In der .env DOWNLOAD_MOUNT_MODUS=ro entfernen (Standard rw) und docker compose up -d – oder unter Einstellungen → Downloads „Original behalten“ wählen.'));
        } else {
            $p['schreiben'] = $ok(t('{vor}Originale bleiben nach dem Import liegen (Einstellung „behalten“)', ['vor' => $vor]));
        }
    }
    // Passt der Client-Pfad zum eingebundenen Ordner? (Nur Name des letzten Ordners vergleichbar – andere Container, andere Pfade)
    if ($sabPfade && is_dir($w)) {
        $katDir = $sabPfade['kat'];
        $sabZiel = $katDir === '' ? rtrim($sabPfade['complete'], '/') . '/' . $kat
            : (str_starts_with($katDir, '/') ? $katDir : rtrim($sabPfade['complete'], '/') . '/' . $katDir);
        $sabZiel = rtrim($sabZiel, '/');
        $letztSab = strtolower(basename($sabZiel));
        $letztWir = strtolower(basename(rtrim($w, '/')));
        $hostPfad = $c['import_ordner'] === '' ? einr_host_pfad('DOWNLOAD_PFAD') : '';
        $letztHost = $hostPfad !== '' ? strtolower(basename(rtrim($hostPfad, '/'))) : '';
        // Liegt der Client-Pfad (oder sein Ende) als Unterordner in unserem Ordner? Dann ist der Überordner eingebunden.
        $teile = array_values(array_filter(explode('/', $sabZiel)));
        $drin = '';
        for ($i = 0; $i < count($teile) && $drin === ''; $i++) {
            $rest = implode('/', array_slice($teile, $i));
            if ($rest !== '' && is_dir($w . '/' . $rest)) {
                $drin = $rest;
            }
        }
        if ($drin !== '') {
            $p['pfad'] = $nein(t('{vor}Eingebunden ist ein Überordner: {client} legt „{kategorie}“ in {pfad} ab, der Import-Ordner zeigt aber auf den Ordner darüber', ['vor' => $vor, 'client' => $c['name'], 'kategorie' => $kat, 'pfad' => $w . '/' . $drin]),
                $c['standard'] && $c['import_ordner'] === ''
                    ? t('DOWNLOAD_PFAD in der .env um „/{unter}“ ergänzen{host}, dann docker compose up -d. Sonst findet Amberwave fertige Downloads nicht.', ['unter' => $drin, 'host' => $hostPfad ? ' (' . rtrim($hostPfad, '/') . '/' . $drin . ')' : ''])
                    : t('Den Import-Ordner dieses Clients um „/{unter}“ ergänzen (Einstellungen → Downloads).', ['unter' => $drin]));
        } elseif ($letztSab !== '' && ($letztSab === $letztHost || $letztSab === $letztWir)) {
            $p['pfad'] = $ok(t('{vor}{client} legt „{kategorie}“ unter …/{ordner} ab – das passt zum eingebundenen Ordner', ['vor' => $vor, 'client' => $c['name'], 'kategorie' => $kat, 'ordner' => basename($sabZiel)]));
        } else {
            $p['pfad'] = ['ok' => null, 'text' => t('{vor}{client} legt „{kategorie}“ unter {pfad} ab (aus seiner Sicht); eingebunden ist {eingebunden} – ob das derselbe Ordner ist, lässt sich von hier nicht sicher sagen', ['vor' => $vor, 'client' => $c['name'], 'kategorie' => $kat, 'pfad' => $sabZiel, 'eingebunden' => $hostPfad ?: $w]),
                'tipp' => t('Wenn ein Download nach dem Laden als „nicht gefunden“ stehen bleibt, zeigt der Import-Ordner auf den falschen Ordner: dann auf den Ordner setzen, den der Client-Container unter {pfad} eingebunden hat.', ['pfad' => $sabZiel])];
        }
    }
    return $p;
}

/** Verbindungen prüfen (Knopf „Verbindung testen“) */
function dl_testen(): array
{
    return dl_pruefen(true);
}

// ---------- Anbieter verwalten (Einstellungen → Downloads) ----------

/** Liste für die Oberfläche – ohne Schlüssel (nur ob einer gesetzt ist) */
function dl_dienste_fuer_oberflaeche(): array
{
    $quelleStd = static fn(string $k) => einstellung_quelle($k);
    $idx = array_map(static function ($i) use ($quelleStd) {
        $x = ['id' => $i['id'], 'art' => $i['art'], 'standard' => $i['standard'], 'name' => $i['name'], 'url' => $i['url'], 'api_pfad' => $i['api_pfad'],
            'key_gesetzt' => $i['key'] !== '', 'kategorien' => implode(',', $i['kategorien']), 'client_id' => $i['client_id'], 'musiksuche' => $i['musiksuche'],
            'aktiv' => $i['aktiv'], 'bereit' => $i['bereit']];
        if ($i['art'] === 'newznab' && is_array($i['caps'])) {
            $x['caps'] = ['titel' => $i['caps']['titel'] ?? '', 'music' => $i['caps']['music'] ?? null, 'search' => $i['caps']['search'] ?? null, 'stand' => $i['caps']['stand'] ?? ''];
        }
        if ($i['standard']) {
            $x['env'] = ['url' => $quelleStd('prowlarr_url') === 'env', 'key' => $quelleStd('prowlarr_api_key') === 'env'];
        }
        return $x;
    }, dl_indexer_liste());
    $cl = array_map(static function ($c) use ($quelleStd) {
        $x = ['id' => $c['id'], 'art' => 'sabnzbd', 'standard' => $c['standard'], 'name' => $c['name'], 'url' => $c['url'], 'api_pfad' => $c['api_pfad'],
            'key_gesetzt' => $c['key'] !== '', 'kategorie' => $c['kategorie'], 'import_ordner' => $c['import_ordner'], 'aktiv' => $c['aktiv'], 'bereit' => $c['bereit'],
            'import_pfad' => dl_client_wurzel($c)];
        if ($c['standard']) {
            $x['env'] = ['url' => $quelleStd('sabnzbd_url') === 'env', 'key' => $quelleStd('sabnzbd_api_key') === 'env'];
        }
        return $x;
    }, dl_client_liste());
    return ['indexer' => $idx, 'clients' => $cl, 'download_pfad' => konfig()['pfade']['downloads']];
}

/** Eingaben eines Anbieters prüfen und vereinheitlichen. $alt: gespeicherter Stand (für leeres Schlüsselfeld = unverändert). */
function dl_dienst_eingabe(array $e, ?array $alt): array
{
    $art = (string) ($e['art'] ?? '');
    if (!in_array($art, ['prowlarr', 'newznab', 'sabnzbd'], true)) {
        throw new ApiFehler(t('Unbekannte Art – erlaubt sind Prowlarr, Newznab und SABnzbd.'));
    }
    $name = trim((string) ($e['name'] ?? ''));
    if (mb_strlen($name) > 80) {
        throw new ApiFehler(t('Der Name ist zu lang (höchstens 80 Zeichen).'));
    }
    $url = rtrim(trim((string) ($e['url'] ?? '')), '/');
    if ($url !== '' && (!preg_match('~^https?://[^\s/?#]+(/[^\s?#]*)?$~i', $url))) {
        throw new ApiFehler(t('Die Adresse muss mit http:// oder https:// beginnen (ohne ?… dahinter).'));
    }
    $key = trim((string) ($e['key'] ?? ''));
    if ($key === '' && $alt) {
        $key = (string) $alt['key'];   // leeres Feld = Schlüssel bleibt
    }
    if ($key !== '' && !preg_match('/^[\x21-\x7e]{1,200}$/', $key)) {
        throw new ApiFehler(t('Der API-Schlüssel enthält ungültige Zeichen.'));
    }
    $pfadRoh = trim((string) ($e['api_pfad'] ?? ''));
    if ($pfadRoh !== '' && ($pfadRoh[0] !== '/' || str_contains($pfadRoh, '..') || !preg_match('#^/[\w./~-]*$#', $pfadRoh))) {
        throw new ApiFehler(t('API-Pfad: beginnt mit /, z. B. /api oder /api/sabnzbd.'));
    }
    $aus = ['art' => $art, 'name' => $name, 'url' => $url, 'key' => $key, 'aktiv' => !isset($e['aktiv']) || (bool) $e['aktiv'], 'api_pfad' => $pfadRoh === '' ? '' : dl_api_pfad($pfadRoh)];
    if ($art === 'sabnzbd') {
        $kat = trim((string) ($e['kategorie'] ?? '')) ?: 'music';
        if (!preg_match('/^[\w .-]{1,60}$/u', $kat)) {
            throw new ApiFehler(t('Ungültige SABnzbd-Kategorie.'));
        }
        $ordnerRoh = trim((string) ($e['import_ordner'] ?? ''));
        $ordner = dl_import_ordner_sauber($ordnerRoh);
        if ($ordnerRoh !== '' && trim($ordnerRoh, '/ ') !== '' && $ordner === '') {
            throw new ApiFehler(t('Import-Ordner: ein Unterordner im Download-Ordner, z. B. „sab2“ (kein „..“, kein absoluter Pfad).'));
        }
        $aus += ['kategorie' => $kat, 'import_ordner' => $ordner];
    } else {
        $kat = trim((string) ($e['kategorien'] ?? '')) ?: '3000';
        if (!preg_match('/^\d+(\s*,\s*\d+)*$/', $kat)) {
            throw new ApiFehler(t('Kategorien als Zahlen mit Komma, z. B. 3000 oder 3010,3040.'));
        }
        $cid = max(0, (int) ($e['client_id'] ?? 0));
        if ($cid > 0 && !dl_client($cid)) {
            throw new ApiFehler(t('Den gewählten Downloadclient gibt es nicht.'));
        }
        $aus += ['kategorien' => implode(',', dl_kategorien_liste($kat)), 'client_id' => $cid, 'musiksuche' => !isset($e['musiksuche']) || (bool) $e['musiksuche']];
    }
    return $aus;
}

/** Anbieter anlegen oder ändern. id 0 mit art prowlarr/sabnzbd = Standard (schreibt in die Einstellungen). Liefert die neue Liste. */
function dl_dienst_speichern(array $e): array
{
    $id = (int) ($e['id'] ?? -1);
    $art = (string) ($e['art'] ?? '');
    if ($id === 0) {
        if ($art === 'newznab') {
            throw new ApiFehler(t('Unbekannter Anbieter.'));
        }
        $alt = $art === 'prowlarr' ? dl_indexer(0) : dl_client(0);
        $x = dl_dienst_eingabe($e, $alt);
        if ($art === 'prowlarr') {
            einstellung_setzen('prowlarr_name', $x['name'] ?: 'Prowlarr');
            einstellung_setzen('prowlarr_url', $x['url']);
            if (trim((string) ($e['key'] ?? '')) !== '') einstellung_setzen('prowlarr_api_key', $x['key']);
            einstellung_setzen('prowlarr_kategorien', $x['kategorien']);
            einstellung_setzen('prowlarr_client', (string) $x['client_id']);
            einstellung_setzen('prowlarr_aktiv', $x['aktiv'] ? '1' : '0');
        } else {
            einstellung_setzen('sabnzbd_name', $x['name'] ?: 'SABnzbd');
            einstellung_setzen('sabnzbd_url', $x['url']);
            if (trim((string) ($e['key'] ?? '')) !== '') einstellung_setzen('sabnzbd_api_key', $x['key']);
            einstellung_setzen('sabnzbd_api_pfad', $x['api_pfad'] ?: '/api');
            einstellung_setzen('sabnzbd_kategorie', $x['kategorie']);
            einstellung_setzen('sabnzbd_import_ordner', $x['import_ordner']);
        }
        return dl_dienste_fuer_oberflaeche();
    }
    $alt = null;
    if ($id > 0) {
        $z = db_zeile('SELECT * FROM download_dienste WHERE id = :id', ['id' => $id]);
        if (!$z) {
            throw new ApiFehler(t('Unbekannter Anbieter.'), 404);
        }
        $alt = dl_dienst_aus_zeile($z);
        if ($z['art'] !== $art) {
            throw new ApiFehler(t('Die Art eines Anbieters lässt sich nicht ändern – bitte neu anlegen.'));
        }
    }
    $x = dl_dienst_eingabe($e, $alt);
    if ($x['url'] === '') {
        throw new ApiFehler(t('Bitte eine Adresse angeben.'));
    }
    $werte = ['art' => $art, 'name' => $x['name'] ?: ($art === 'sabnzbd' ? 'SABnzbd' : ($art === 'newznab' ? (string) parse_url($x['url'], PHP_URL_HOST) : 'Prowlarr')), 'url' => $x['url'],
        'pfad' => $x['api_pfad'], 'key' => $x['key'] !== '' ? verschluessle($x['key']) : '', 'kat' => $art === 'sabnzbd' ? $x['kategorie'] : $x['kategorien'],
        'client' => $art === 'sabnzbd' ? null : ($x['client_id'] ?: null), 'ordner' => $art === 'sabnzbd' ? $x['import_ordner'] : '',
        'musik' => $art === 'sabnzbd' ? 0 : ($x['musiksuche'] ? 1 : 0), 'aktiv' => $x['aktiv'] ? 1 : 0];
    if ($id > 0) {
        // Adresse oder Schlüssel geändert: gemerkte Fähigkeiten verwerfen (werden bei der nächsten Suche neu geholt)
        $capsNeu = $alt && ($alt['url'] !== $x['url'] || $alt['key'] !== $x['key'] || $alt['api_pfad'] !== dl_api_pfad($x['api_pfad']));
        db_tun('UPDATE download_dienste SET name = :name, url = :url, api_pfad = :pfad, api_key = :key, kategorien = :kat, client_id = :client, import_ordner = :ordner,
            musiksuche = :musik, aktiv = :aktiv' . ($capsNeu ? ', caps = NULL' : '') . ' WHERE id = :id', array_diff_key($werte, ['art' => 1]) + ['id' => $id]);
    } else {
        $reihe = (int) db_wert('SELECT COALESCE(MAX(reihenfolge), 0) + 1 FROM download_dienste');
        $id = db_einfuegen('INSERT INTO download_dienste (art, name, url, api_pfad, api_key, kategorien, client_id, import_ordner, musiksuche, aktiv, reihenfolge)
            VALUES (:art, :name, :url, :pfad, :key, :kat, :client, :ordner, :musik, :aktiv, :reihe)', $werte + ['reihe' => $reihe]);
    }
    dl_dienste_zeilen(true);
    // Newznab: Fähigkeiten gleich holen (für t=music und das Limit) – scheitert das, bleibt der Anbieter trotzdem gespeichert
    if ($art === 'newznab' && $x['aktiv'] && $x['key'] !== '') {
        try {
            $i = dl_indexer($id);
            if ($i) {
                db_tun('UPDATE download_dienste SET caps = :c WHERE id = :id', ['c' => json_encode(dl_newznab_caps($i), JSON_UNESCAPED_UNICODE), 'id' => $id]);
                dl_dienste_zeilen(true);
            }
        } catch (Throwable $e) {
            // Prüfung zeigt den Fehler
        }
    }
    return dl_dienste_fuer_oberflaeche() + ['gespeichert' => $id];
}

/** Anbieter löschen. Ein Client mit laufenden Aufträgen bleibt; seine Indexer gehen an den Standard-Client. */
function dl_dienst_loeschen(string $art, int $id): array
{
    if ($id <= 0) {
        throw new ApiFehler(t('Der Standard-Anbieter lässt sich nicht löschen – leere seine Adresse oder schalte ihn aus.'));
    }
    $z = db_zeile('SELECT * FROM download_dienste WHERE id = :id AND art = :a', ['id' => $id, 'a' => $art]);
    if (!$z) {
        throw new ApiFehler(t('Unbekannter Anbieter.'), 404);
    }
    if ($art === 'sabnzbd') {
        $offen = (int) db_wert("SELECT COUNT(*) FROM downloads WHERE client_id = :c AND status IN ('gesendet', 'laeuft', 'fertig')", ['c' => $id]);
        if ($offen) {
            throw new ApiFehler(t('An diesen Client laufen noch {n} Aufträge – erst wenn sie fertig oder entfernt sind, lässt er sich löschen. Ausschalten geht sofort.', ['n' => $offen]));
        }
        db_tun('UPDATE download_dienste SET client_id = NULL WHERE client_id = :c', ['c' => $id]);
        if ((int) einstellung('prowlarr_client') === $id) {
            einstellung_setzen('prowlarr_client', '0');
        }
    }
    db_tun('DELETE FROM download_dienste WHERE id = :id', ['id' => $id]);
    dl_dienste_zeilen(true);
    return dl_dienste_fuer_oberflaeche();
}

/** Einen Anbieter testen – auch mit noch nicht gespeicherten Eingaben (leeres Schlüsselfeld = gespeicherter Schlüssel) */
function dl_dienst_testen(array $e): array
{
    $id = (int) ($e['id'] ?? -1);
    $art = (string) ($e['art'] ?? '');
    $alt = $id >= 0 ? ($art === 'sabnzbd' ? dl_client($id) : dl_indexer($id)) : null;
    if ($alt && $alt['art'] !== $art) {
        $alt = null;
    }
    $x = dl_dienst_eingabe($e, $alt);
    $basis = ['id' => max(0, $id), 'standard' => $id === 0, 'name' => $x['name'] ?: ($alt['name'] ?? ucfirst($art)), 'url' => $x['url'], 'key' => $x['key'], 'aktiv' => true,
        'api_pfad' => $x['api_pfad'] !== '' ? $x['api_pfad'] : '/api', 'art' => $art];
    if ($art === 'sabnzbd') {
        $c = $basis + ['kategorie' => $x['kategorie'], 'import_ordner' => $x['import_ordner']];
        $c['bereit'] = $c['url'] !== '' && $c['key'] !== '';
        $p = dl_client_pruefen($c, true, false);
    } else {
        $i = $basis + ['kategorien' => dl_kategorien_liste($x['kategorien']), 'client_id' => $x['client_id'], 'musiksuche' => $x['musiksuche'], 'caps' => null];
        if ($art === 'prowlarr') {
            $i['api_pfad'] = '';
        }
        $i['standard'] = true;   // beim Test nichts speichern
        $p = ['indexer' => dl_indexer_pruefen($i)];
    }
    return ['ok' => !in_array(false, array_map(static fn($x) => $x['ok'], $p), true), 'pruefungen' => $p];
}

// ---------- Künstler-Suche über MusicBrainz (Diskografie → Usenet-Suche) ----------

function dl_mb(callable $fn)
{
    try {
        return $fn();
    } catch (MbFehler $e) {
        throw new ApiFehler($e->getMessage(), 502);
    }
}

/** Künstler bei MusicBrainz suchen; markiert, wer schon in der Bibliothek ist */
function dl_mb_kuenstler(string $name): array
{
    $name = trim($name);
    if (mb_strlen($name) < 2) {
        throw new ApiFehler(t('Bitte mindestens zwei Zeichen eingeben.'));
    }
    $liste = dl_mb(static fn() => mb_kuenstler_suchen($name));
    $liste = array_values(array_filter($liste, static fn($a) => $a['score'] >= 50));
    $ids = array_column($liste, 'mbid');
    $da = [];
    if ($ids) {
        $in = implode(',', array_map(static fn($i) => db()->quote($i), $ids));
        foreach (db_alle("SELECT k.mbid, COUNT(DISTINCT a.id) n FROM kuenstler k LEFT JOIN credit_namen ck ON ck.kuenstler_id = k.id LEFT JOIN alben a ON a.credit_id = ck.credit_id WHERE k.mbid IN ($in) GROUP BY k.mbid") as $z) {
            $da[$z['mbid']] = (int) $z['n'];
        }
    }
    foreach ($liste as &$a) {
        $a['alben_hier'] = $da[$a['mbid']] ?? null;
    }
    return ['kuenstler' => array_slice($liste, 0, 12)];
}

/**
 * Diskografie eines Künstlers (Release Groups) von MusicBrainz, neueste zuerst. Markiert, was schon in der Bibliothek liegt
 * (über die MBID der Release Group, sonst über den Titel bei diesem Künstler).
 */
function dl_mb_diskografie(string $mbid): array
{
    $mbid = strtolower($mbid);
    if (!ist_uuid($mbid)) {
        throw new ApiFehler(t('Ungültige MusicBrainz-ID.'));
    }
    $kuenstler = dl_mb(static fn() => mb_abfrage('artist/' . $mbid, [], 7 * 86400));
    $gruppen = [];
    $gesamt = null;
    for ($offset = 0; $offset < 400 && ($gesamt === null || $offset < $gesamt); $offset += 100) {
        $d = dl_mb(static fn() => mb_abfrage('release-group', ['artist' => $mbid, 'limit' => 100, 'offset' => $offset], 86400));
        $gesamt = (int) ($d['release-group-count'] ?? 0);
        foreach ($d['release-groups'] ?? [] as $rg) {
            $gruppen[] = $rg;
        }
        if (count($d['release-groups'] ?? []) < 100) {
            break;
        }
    }
    // Was liegt schon hier? MBID der Release Group, ersatzweise gleicher Titel bei einem Album dieses Künstlers
    $hierMbid = [];
    $hierTitel = [];
    foreach (db_alle("SELECT a.mbid, a.titel FROM alben a JOIN credit_namen ck ON ck.credit_id = a.credit_id JOIN kuenstler k ON k.id = ck.kuenstler_id WHERE k.mbid = :m", ['m' => $mbid]) as $z) {
        if ($z['mbid']) $hierMbid[strtolower((string) $z['mbid'])] = true;
        $hierTitel[dl_norm((string) $z['titel'])] = true;
    }
    $rgIds = array_map(static fn($g) => (string) $g['id'], $gruppen);
    if ($rgIds) {
        $in = implode(',', array_map(static fn($i) => db()->quote($i), $rgIds));
        foreach (db_alle("SELECT mbid FROM alben WHERE mbid IN ($in)") as $z) {
            $hierMbid[strtolower((string) $z['mbid'])] = true;
        }
    }
    $aus = [];
    foreach ($gruppen as $rg) {
        $typ = (string) ($rg['primary-type'] ?? '');
        $neben = array_values(array_map('strval', (array) ($rg['secondary-types'] ?? [])));
        $art = match (true) {
            in_array('Live', $neben, true) => 'live',
            in_array('Compilation', $neben, true) => 'compilation',
            (bool) array_intersect(['Remix', 'DJ-mix', 'Mixtape/Street', 'Soundtrack', 'Demo', 'Interview', 'Spokenword', 'Audiobook', 'Audio drama'], $neben) => 'sonstiges',
            $typ === 'Album' => 'album',
            $typ === 'EP' => 'ep',
            $typ === 'Single' => 'single',
            default => 'sonstiges',
        };
        $aus[] = [
            'mbid' => (string) $rg['id'],
            'titel' => (string) ($rg['title'] ?? ''),
            'zusatz' => (string) ($rg['disambiguation'] ?? ''),
            'datum' => (string) ($rg['first-release-date'] ?? ''),
            'typ' => trim($typ . ($neben ? ' · ' . implode(', ', $neben) : '')),
            'art' => $art,
            'hier' => isset($hierMbid[strtolower((string) $rg['id'])]) || isset($hierTitel[dl_norm((string) ($rg['title'] ?? ''))]),
        ];
    }
    usort($aus, static fn($a, $b) => strcmp($b['datum'] ?: '0', $a['datum'] ?: '0'));
    return [
        'kuenstler' => ['mbid' => $mbid, 'name' => (string) ($kuenstler['name'] ?? ''), 'unterscheidung' => (string) ($kuenstler['disambiguation'] ?? ''),
            'land' => (string) ($kuenstler['country'] ?? ''), 'beginn' => (string) ($kuenstler['life-span']['begin'] ?? '')],
        'releases' => $aus,
        'gesamt' => $gesamt ?? count($aus),
    ];
}

/**
 * Hast du das schon? Prüft vor dem Holen, ob ein Album dieses Künstlers mit (ungefähr) diesem Titel in der Bibliothek liegt.
 * $kuenstler/$album kommen aus der Diskografie (sicher) oder aus dem Release-Namen (Schätzung: „Künstler - Album (Jahr) …“).
 * Liefert null oder [{album_id, titel, kuenstler, editionen:[{id, ordner, format, jahr}]}].
 */
function dl_schon_da(string $kuenstler, string $album, string $releaseName = ''): ?array
{
    $kuenstler = trim($kuenstler);
    $album = trim($album);
    if (($kuenstler === '' || $album === '') && $releaseName !== '') {
        // Release-Name zerlegen: Trenner „ - “ oder „-“ zwischen Künstler und Album, danach Jahr/Format weg
        $n = str_replace(['_', '.'], ' ', $releaseName);
        $n = preg_replace('/[\[(][^\])]*[\])]/', ' ', $n);                       // [FLAC], (2011), (Deluxe Edition)
        $n = preg_replace('/\b(19|20)\d{2}\b.*$/', '', $n);                        // ab dem Jahr alles weg
        $n = preg_replace('/\b(flac|mp3|web|cd|vinyl|24bit|16bit|\d{2,3}\s?k(bps|hz)?|lossless|hi-?res|v0|v2|320|deluxe|remaster(ed)?|edition|explicit|clean)\b.*$/i', '', $n);
        $teile = preg_split('/\s+-\s+|(?<=\S)-(?=[A-Z])/', trim((string) $n), 2);
        if (count($teile) === 2) {
            $kuenstler = $kuenstler ?: trim($teile[0]);
            $album = $album ?: trim($teile[1]);
        }
    }
    if ($kuenstler === '' || $album === '') {
        return null;
    }
    $kn = name_norm($kuenstler);
    $an = name_norm(scan_albumtitel_bereinigen($album));
    if ($kn === '' || $an === '') {
        return null;
    }
    // Künstler über Name/Alias, Album über normalisierten Titel (auch Teilstring: „Thriller“ ↔ „Thriller 25“)
    $treffer = db_alle("SELECT DISTINCT a.id, a.titel, COALESCE(c.anzeige, '') AS kuenstler
        FROM alben a JOIN credits c ON c.id = a.credit_id JOIN credit_namen cn ON cn.credit_id = c.id JOIN kuenstler k ON k.id = cn.kuenstler_id
        WHERE k.name_norm = :k AND (a.suchtext LIKE :a1 OR :a2 LIKE CONCAT('%', REPLACE(a.titel, ' ', '%'), '%'))
        LIMIT 5", ['k' => $kn, 'a1' => '%' . $an . '%', 'a2' => $an]);
    $aus = [];
    foreach ($treffer as $t) {
        $tn = name_norm(scan_albumtitel_bereinigen((string) $t['titel']));
        if ($tn === '' || (!str_contains($an, $tn) && !str_contains($tn, $an))) {
            continue;
        }
        $eds = db_alle('SELECT id, ordner, format_text, jahr, anzahl_dateien, beste_qualitaet FROM editionen WHERE album_id = :a AND anzahl_dateien > 0', ['a' => $t['id']]);
        if (!$eds) {
            continue; // Album ohne Dateien zählt nicht
        }
        $aus[] = ['album_id' => (int) $t['id'], 'titel' => (string) $t['titel'], 'kuenstler' => (string) $t['kuenstler'],
            'editionen' => array_map(static fn($e) => ['id' => (int) $e['id'], 'ordner' => (string) $e['ordner'], 'format' => (string) $e['format_text'], 'jahr' => $e['jahr'] ? (int) $e['jahr'] : null,
                'dateien' => (int) $e['anzahl_dateien'], 'qualitaet' => (string) $e['beste_qualitaet']], $eds)];
    }
    return $aus ?: null;
}

// ---------- Einsortieren: importierte Alben nach dem MusicBrainz-Abgleich an ihren Platz ----------

/**
 * Importierte Downloads, die inzwischen eingelesen und mit MusicBrainz abgeglichen sind, von <Musikordner>/<download_ziel>/…
 * nach Schema einsortieren – ohne Freigabe, aber mit allen Sicherungen des Aufräumens (Plan wird vor dem Verschieben neu
 * gerechnet, laufende Alben warten, nie gleichzeitig mit dem Einlesen). Alben ohne Abgleich bleiben liegen.
 * Läuft im Zeitplan. Liefert, wie viele Pläne freigegeben wurden.
 */
function dl_einsortieren(): int
{
    if (einstellung('download_einsortieren') !== '1') {
        return 0;
    }
    $k = dl_konfig();
    $ziel = af_sicher($k['ziel']);
    $n = 0;
    foreach (db_alle("SELECT * FROM downloads WHERE status = 'importiert' AND einsortiert_am IS NULL AND pfad_ziel <> '' ORDER BY id LIMIT 20") as $d) {
        // Edition zum Importordner finden (Ordner = pfad_ziel oder darunter, z. B. CD-Unterordner)
        $eid = (int) ($d['edition_id'] ?? 0);
        if (!$eid) {
            $eid = (int) db_wert('SELECT id FROM editionen WHERE ordner = :o OR ordner LIKE :u ORDER BY (ordner = :o2) DESC, id LIMIT 1',
                ['o' => $d['pfad_ziel'], 'u' => $d['pfad_ziel'] . '/%', 'o2' => $d['pfad_ziel']]);
            if ($eid) {
                db_tun('UPDATE downloads SET edition_id = :e WHERE id = :id', ['e' => $eid, 'id' => $d['id']]);
            }
        }
        if (!$eid) {
            continue; // noch nicht eingelesen
        }
        $e = db_zeile('SELECT id, ordner, mbid, quelle FROM editionen WHERE id = :id', ['id' => $eid]);
        if (!$e) {
            db_tun('UPDATE downloads SET edition_id = NULL WHERE id = :id', ['id' => $d['id']]); // Edition weg (neu eingelesen?) – nächstes Mal neu suchen
            continue;
        }
        if (!str_starts_with((string) $e['ordner'], $ziel . '/')) {
            // liegt schon woanders (von Hand aufgeräumt) – fertig
            db_tun('UPDATE downloads SET einsortiert_am = NOW(), pfad_ziel = :p, meldung = :m WHERE id = :id', ['p' => $e['ordner'], 'm' => t('Einsortiert nach {ziel}', ['ziel' => $e['ordner']]), 'id' => $d['id']]);
            continue;
        }
        if (($e['mbid'] ?? '') === '' || $e['quelle'] === 'tags') {
            continue; // noch kein Abgleich – bleibt unter Downloads/, wartet auf den Abgleich oder auf dich
        }
        $plan = db_zeile('SELECT status, freigegeben_am FROM aufraeum_plaene WHERE edition_id = :e', ['e' => $eid]);
        if ($plan && in_array($plan['status'], ['freigegeben', 'laeuft'], true)) {
            continue; // ist schon unterwegs
        }
        try {
            $p = af_plan_erstellen($eid);
        } catch (Throwable $ex) {
            db_tun('UPDATE downloads SET meldung = :m WHERE id = :id', ['m' => mb_substr('Einsortieren: ' . $ex->getMessage(), 0, 1000), 'id' => $d['id']]);
            continue;
        }
        $bewegt = count(array_filter($p['dateien'] ?? [], static fn($x) => !empty($x['nach'])));
        if (!$bewegt && ($p['ordner_neu'] ?? '') === ($p['ordner_alt'] ?? '')) {
            db_tun('UPDATE downloads SET einsortiert_am = NOW() WHERE id = :id', ['id' => $d['id']]); // nichts zu verschieben
            continue;
        }
        db_tun("UPDATE aufraeum_plaene SET status = 'freigegeben', freigegeben_am = NOW() WHERE edition_id = :e AND status = 'offen'", ['e' => $eid]);
        db_tun('UPDATE downloads SET meldung = :m WHERE id = :id', ['m' => mb_substr(t('Wird einsortiert nach {ziel}', ['ziel' => $p['ordner_neu'] ?? '']), 0, 1000), 'id' => $d['id']]);
        af_log('Einsortieren: Download-Album freigegeben', ['download' => $d['id'], 'edition' => $eid, 'nach' => $p['ordner_neu'] ?? '']);
        $n++;
    }
    // Fertig verschobene nachtragen (Ordner der Edition hat sich geändert)
    foreach (db_alle("SELECT d.id, d.pfad_ziel, e.ordner FROM downloads d JOIN editionen e ON e.id = d.edition_id WHERE d.status = 'importiert' AND d.einsortiert_am IS NULL AND e.ordner <> d.pfad_ziel AND e.ordner NOT LIKE :u", ['u' => $ziel . '/%']) as $d) {
        db_tun('UPDATE downloads SET einsortiert_am = NOW(), pfad_ziel = :p, meldung = :m WHERE id = :id', ['p' => $d['ordner'], 'm' => t('Einsortiert nach {ziel}', ['ziel' => $d['ordner']]), 'id' => $d['id']]);
    }
    if ($n > 0) {
        af_anstossen();
    }
    return $n;
}

