<?php
// Fernsteuerung: ein Gerät steuert die Wiedergabe eines anderen (eigene Geräte; Admins alle).
//
// Jede offene App hält einen Rückkanal (Server-Sent Events, GET /fern/strom). Darüber bekommt sie
//   – Befehle an sich selbst (befehl),
//   – wer sie gerade steuert (beobachter),
//   – Zustand und Warteschlange des Geräts, das sie selbst steuert (zustand, liste, online).
// Ihren eigenen Zustand schickt sie mit POST /fern/zustand. Befehle gehen mit POST /fern/befehl in eine Tabelle und
// werden vom Rückkanal des Ziels abgeholt (nach 10 s verworfen). Kein Kanal frei → das Gerät fragt mit ?einmal=1 nach.
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

const FERN_BEFEHLE = ['play', 'pause', 'pp', 'weiter', 'zurueck', 'springen', 'springen_zu', 'stopp', 'vol', 'zufall', 'wdh',
    'abspielen', 'naechstes', 'anhaengen', 'entfernen', 'holen'];
require_once __DIR__ . '/heimnetz.php';
require_once __DIR__ . '/bibstand.php';

function fern_konfig(): array
{
    return konfig()['fern'] ?? ['an' => true, 'max_verbindungen' => 40, 'offline_sekunden' => 15, 'kanal_sekunden' => 30, 'takt_ms' => 250];
}

function fern_ich(): int
{
    $g = (int) aktuelles_geraet_id();
    if ($g <= 0) {
        throw new ApiFehler(t('Kein Gerät erkannt – bitte die Seite neu laden.'));
    }
    return $g;
}

function fern_nutzername(array $z): string
{
    return trim((string) ($z['vorname'] ?? '')) ?: (string) ($z['benutzername'] ?? '');
}

/** Einstellung eines Geräts (geraet_einstellungen, JSON) */
function fern_geraet_einst(int $geraet, string $schluessel, $standard)
{
    $w = db_wert('SELECT wert FROM geraet_einstellungen WHERE geraet_id = :g AND schluessel = :k', ['g' => $geraet, 'k' => $schluessel]);
    if ($w === null || $w === false) {
        return $standard;
    }
    $v = json_decode((string) $w, true);
    return $v ?? $standard;
}

/** Eigenen Eintrag anlegen/auffrischen */
function fern_da(int $geraet, int $user, bool $kanal = false): void
{
    db_tun('INSERT INTO fern_praesenz (geraet_id, user_id, zuletzt_am' . ($kanal ? ', kanal_am' : '') . ') VALUES (:g, :u, NOW(3)' . ($kanal ? ', NOW(3)' : '') . ')
            ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), zuletzt_am = NOW(3)' . ($kanal ? ', kanal_am = NOW(3)' : ''), ['g' => $geraet, 'u' => $user]);
}

/** Gerät (mit Besitzer und Anwesenheit) */
function fern_geraet(int $geraet, ?array $user = null): ?array
{
    if (hn_ist_fern_id($geraet)) {
        return $user ? hn_fern_geraet($geraet, $user) : null;
    }
    $off = (int) fern_konfig()['offline_sekunden'];
    return db_zeile("SELECT g.id, g.user_id, COALESCE(NULLIF(g.eigener_name, ''), g.name) AS name, u.vorname, u.benutzername,
                            p.zustand, p.ziel_id, p.zuletzt_am, (p.zuletzt_am > NOW(3) - INTERVAL {$off} SECOND) AS online,
                            TIMESTAMPDIFF(SECOND, p.zuletzt_am, NOW(3)) AS alter_sek
                     FROM nutzer_geraete g JOIN users u ON u.id = g.user_id LEFT JOIN fern_praesenz p ON p.geraet_id = g.id
                     WHERE g.id = :g AND g.beendet_am IS NULL", ['g' => $geraet]);
}

/**
 * Darf $user (von Gerät $von) das Gerät $z steuern? Liefert null (ja) oder den Grund (nein).
 * Eigene Geräte immer, fremde nur als Admin. „Fernsteuerung aus“ am Gerät gilt nicht für Admins.
 */
function fern_grund(array $user, int $von, array $z): ?string
{
    $admin = $user['rolle'] === 'admin';
    if ((int) $z['id'] === $von) {
        return t('Das ist dieses Gerät.');
    }
    if (!empty($z['heim'])) {
        // Geräte im Heimnetz (Receiver, Fernseher): alle dürfen darauf abspielen
        return empty($z['online']) ? t('nicht erreichbar') : null;
    }
    if ((int) $z['user_id'] !== (int) $user['id'] && !$admin) {
        return t('Fremdes Gerät');
    }
    if (empty($z['online'])) {
        return t('nicht erreichbar');
    }
    if (!$admin && !fern_geraet_einst((int) $z['id'], 'fern_erlaubt', true)) {
        return t('Fernsteuerung ist dort ausgeschaltet');
    }
    $st = json_decode((string) ($z['zustand'] ?? ''), true);
    if (!is_array($st)) {
        return t('meldet sich gerade erst');
    }
    if (($st['art'] ?? '') === 'windows') {
        return null;
    }
    if (!empty($st['mobil']) && empty($st['spielt']) && empty($st['sichtbar'])) {
        return t('schläft – App dort öffnen');
    }
    if (empty($st['aktiviert'])) {
        return t('erst nach einmal Play dort');
    }
    return null;
}

function fern_kurzzustand(?string $json): ?array
{
    $st = json_decode((string) $json, true);
    if (!is_array($st)) {
        return null;
    }
    $t = is_array($st['track'] ?? null) ? $st['track'] : null;
    return [
        'art' => (string) ($st['art'] ?? 'browser'), 'mobil' => !empty($st['mobil']), 'spielt' => !empty($st['spielt']),
        'titel' => $t ? (string) ($t['titel'] ?? '') : null,
        'kuenstler' => $t ? implode(', ', array_map(static fn($k) => is_array($k) ? (string) ($k['name'] ?? '') : (string) $k, (array) ($t['kuenstler'] ?? []))) : null,
        'cover' => $t ? ($t['album']['cover'] ?? null) : null,
        'vol' => isset($st['vol']) ? (float) $st['vol'] : null, 'bitgenau' => !empty($st['bitgenau']),
    ];
}

/** GET /fern/geraete – eigene Geräte (Admins: alle), die in den letzten 24 h da waren */
function fern_geraete(array $user): array
{
    $ich = fern_ich();
    $off = (int) fern_konfig()['offline_sekunden'];
    $admin = $user['rolle'] === 'admin';
    $zeilen = db_alle("SELECT g.id, g.user_id, COALESCE(NULLIF(g.eigener_name, ''), g.name) AS name, u.vorname, u.benutzername,
                              p.zustand, p.ziel_id, (p.zuletzt_am > NOW(3) - INTERVAL {$off} SECOND) AS online,
                              TIMESTAMPDIFF(SECOND, p.zuletzt_am, NOW(3)) AS alter_sek
                       FROM fern_praesenz p JOIN nutzer_geraete g ON g.id = p.geraet_id AND g.beendet_am IS NULL JOIN users u ON u.id = g.user_id
                       WHERE (p.zuletzt_am > NOW() - INTERVAL 30 MINUTE OR g.id = :ich2)" . ($admin ? '' : ' AND g.user_id = :u') . '
                       ORDER BY (g.id = :ich) DESC, (g.user_id = :u2) DESC, u.vorname, online DESC, p.zuletzt_am DESC',
        $admin ? ['u2' => $user['id'], 'ich' => $ich, 'ich2' => $ich] : ['u' => $user['id'], 'u2' => $user['id'], 'ich' => $ich, 'ich2' => $ich]);
    $steuern = [];
    foreach ($zeilen as $z) {
        if ($z['online'] && $z['ziel_id']) {
            $steuern[(int) $z['ziel_id']][] = (int) $z['id'];
        }
    }
    $aus = [];
    foreach ($zeilen as $z) {
        $id = (int) $z['id'];
        $grund = $id === $ich ? null : fern_grund($user, $ich, $z);
        $aus[] = [
            'id' => $id, 'name' => (string) $z['name'], 'ich' => $id === $ich, 'online' => (bool) $z['online'] || $id === $ich,
            'alter_sek' => (int) $z['alter_sek'],
            'besitzer' => ['id' => (int) $z['user_id'], 'name' => fern_nutzername($z), 'ich' => (int) $z['user_id'] === (int) $user['id']],
            'zustand' => fern_kurzzustand($z['zustand']),
            'steuerbar' => $id !== $ich && $grund === null, 'grund' => $grund,
            'steuert' => $z['online'] && $z['ziel_id'] ? (int) $z['ziel_id'] : null,
            'gesteuert_von' => $steuern[$id] ?? [],
            'max_vol' => (int) fern_geraet_einst($id, 'fern_max_lautstaerke', 100),
        ];
    }
    if (hn_konfig()['an']) {
        $heim = hn_fern_liste($user, $ich);
        if ($heim) {
            $aus = array_merge($aus, $heim);
            hn_agent_anstossen();   // Zustand (an/Standby, Eingang, Lautstärke) frisch halten, solange jemand hinsieht
        }
    }
    $mein = db_zeile('SELECT ziel_id FROM fern_praesenz WHERE geraet_id = :g', ['g' => $ich]);
    return ['geraete' => $aus, 'ich' => $ich, 'ziel' => $mein && $mein['ziel_id'] ? (int) $mein['ziel_id'] : null, 'admin' => $admin];
}

/** POST /fern/verbinden {ziel: id|null} – ab jetzt dieses Gerät steuern (null = wieder selbst spielen) */
function fern_verbinden(array $user): array
{
    $ich = fern_ich();
    fern_da($ich, (int) $user['id']);
    $ziel = (int) api_wert('ziel', 0);
    if ($ziel <= 0 || $ziel === $ich) {
        db_tun('UPDATE fern_praesenz SET ziel_id = NULL WHERE geraet_id = :g', ['g' => $ich]);
        return ['ok' => true, 'ziel' => null];
    }
    $z = fern_geraet($ziel, $user);
    if (!$z) {
        throw new ApiFehler(t('Gerät nicht gefunden.'), 404);
    }
    $grund = fern_grund($user, $ich, $z);
    if ($grund !== null) {
        throw new ApiFehler($z['name'] . ': ' . $grund, 409);
    }
    // Kein Pingpong: steuert das Ziel gerade uns, endet das – wer zuletzt wählt, übernimmt
    db_tun('UPDATE fern_praesenz SET ziel_id = NULL WHERE geraet_id = :z AND ziel_id = :g', ['z' => $ziel, 'g' => $ich]);
    db_tun('UPDATE fern_praesenz SET ziel_id = :z WHERE geraet_id = :g', ['z' => $ziel, 'g' => $ich]);
    if (!empty($z['heim'])) {
        hn_agent_anstossen();
    }
    return ['ok' => true, 'ziel' => $ziel, 'name' => (string) $z['name'], 'heim' => !empty($z['heim'])];
}

/** POST /fern/befehl {befehl, daten, ziel?} */
function fern_befehl(array $user): array
{
    $ich = fern_ich();
    $befehl = (string) api_wert('befehl', '');
    if (!in_array($befehl, FERN_BEFEHLE, true)) {
        throw new ApiFehler(t('Unbekannter Befehl.'));
    }
    $ziel = (int) api_wert('ziel', 0);
    if ($ziel <= 0) {
        $ziel = (int) db_wert('SELECT ziel_id FROM fern_praesenz WHERE geraet_id = :g', ['g' => $ich]);
    }
    $z = $ziel > 0 ? fern_geraet($ziel, $user) : null;
    if (!$z) {
        throw new ApiFehler(t('Kein Gerät zum Steuern gewählt.'), 409);
    }
    $grund = fern_grund($user, $ich, $z);
    if ($grund !== null) {
        throw new ApiFehler($z['name'] . ': ' . $grund, 409);
    }
    $daten = api_wert('daten', null);
    if ($befehl === 'vol' && empty($z['heim'])) {
        // Obergrenze des Ziels für die Fernbedienung (Kinderzimmer nachts)
        $max = max(0, min(100, (int) fern_geraet_einst($ziel, 'fern_max_lautstaerke', 100))) / 100;
        $daten = round(max(0.0, min($max, (float) $daten)), 3);
    }
    $json = json_encode($daten, JSON_UNESCAPED_UNICODE);
    if ($json === false || strlen($json) > 600000) {
        throw new ApiFehler(t('Zu viele Daten für einen Befehl.'));
    }
    fern_da($ich, (int) $user['id']);
    $id = db_einfuegen('INSERT INTO fern_befehle (ziel_id, von_id, von_user, befehl, daten) VALUES (:z, :v, :u, :b, :d)',
        ['z' => $ziel, 'v' => $ich, 'u' => $user['id'], 'b' => $befehl, 'd' => $json]);
    if (random_int(1, 25) === 1) {
        db_tun('DELETE FROM fern_befehle WHERE erstellt_am < NOW(3) - INTERVAL 2 MINUTE');
    }
    if (!empty($z['heim'])) {
        hn_agent_anstossen();
    }
    return ['ok' => true, 'id' => $id, 'wert' => $daten];
}

/** POST /fern/zustand {zustand, liste?} – eigener Zustand (für Fernbedienungen und die Geräteliste) */
function fern_zustand_melden(array $user): array
{
    $ich = fern_ich();
    $st = api_wert('zustand', null);
    if (!is_array($st)) {
        throw new ApiFehler(t('Zustand fehlt.'));
    }
    $st['t'] = (int) round(microtime(true) * 1000);   // Serverzeit der Meldung (Position = pos + vergangene Zeit)
    $json = json_encode($st, JSON_UNESCAPED_UNICODE);
    if ($json === false || strlen($json) > 40000) {
        throw new ApiFehler(t('Zustand zu groß.'));
    }
    fern_da($ich, (int) $user['id']);
    $liste = api_wert('liste', null);
    if (is_array($liste)) {
        $lj = json_encode(array_slice($liste, 0, 1000), JSON_UNESCAPED_UNICODE);
        if ($lj !== false && strlen($lj) <= 2000000) {
            db_tun('UPDATE fern_praesenz SET liste = :l, liste_ver = liste_ver + 1 WHERE geraet_id = :g', ['l' => $lj, 'g' => $ich]);
        }
    }
    db_tun('UPDATE fern_praesenz SET zustand = :z, zustand_ver = zustand_ver + 1 WHERE geraet_id = :g', ['z' => $json, 'g' => $ich]);
    return ['ok' => true];
}

/** POST /fern/weg – Seite wird geschlossen (sendBeacon) */
function fern_weg(array $user): array
{
    $g = (int) aktuelles_geraet_id();
    if ($g > 0) {
        db_tun('UPDATE fern_praesenz SET zuletzt_am = NOW(3) - INTERVAL 1 HOUR, kanal_am = NULL, ziel_id = NULL WHERE geraet_id = :g AND user_id = :u', ['g' => $g, 'u' => $user['id']]);
    }
    return ['ok' => true];
}

/**
 * Eine Runde des Rückkanals: neue Befehle, Beobachter, Zustand/Liste/Erreichbarkeit des gesteuerten Geräts.
 * $s wird fortgeschrieben (ab, zv, lv, online, beob, ziel). Liefert Ereignisse [[name, daten], …].
 */
function fern_runde(int $ich, array &$s, bool $voll): array
{
    $off = (int) fern_konfig()['offline_sekunden'];
    $ev = [];
    foreach (db_alle('SELECT b.id, b.von_id, b.von_user, b.befehl, b.daten, COALESCE(NULLIF(g.eigener_name, \'\'), g.name) AS von_name, u.vorname, u.benutzername
                      FROM fern_befehle b LEFT JOIN nutzer_geraete g ON g.id = b.von_id LEFT JOIN users u ON u.id = b.von_user
                      WHERE b.ziel_id = :g AND b.id > :ab AND b.erstellt_am > NOW(3) - INTERVAL 10 SECOND ORDER BY b.id LIMIT 30',
                 ['g' => $ich, 'ab' => $s['ab']]) as $b) {
        $s['ab'] = (int) $b['id'];
        $ev[] = ['befehl', ['id' => (int) $b['id'], 'befehl' => $b['befehl'], 'daten' => json_decode((string) $b['daten'], true),
            'von' => ['id' => (int) $b['von_id'], 'name' => (string) $b['von_name'], 'nutzer' => fern_nutzername($b), 'fremd' => (int) $b['von_user'] !== $s['user']]]];
    }
    if ($voll) {
        $beob = db_alle("SELECT p.geraet_id AS id, COALESCE(NULLIF(g.eigener_name, ''), g.name) AS name, u.id AS uid, u.vorname, u.benutzername
                         FROM fern_praesenz p JOIN nutzer_geraete g ON g.id = p.geraet_id JOIN users u ON u.id = p.user_id
                         WHERE p.ziel_id = :g AND p.zuletzt_am > NOW(3) - INTERVAL {$off} SECOND ORDER BY p.geraet_id", ['g' => $ich]);
        $beob = array_map(static fn($b) => ['id' => (int) $b['id'], 'name' => (string) $b['name'], 'nutzer' => fern_nutzername($b), 'fremd' => (int) $b['uid'] !== $s['user']], $beob);
        $j = json_encode($beob);
        if ($j !== $s['beob']) {
            $s['beob'] = $j;
            $ev[] = ['beobachter', $beob];
        }
        $neu = (int) db_wert('SELECT ziel_id FROM fern_praesenz WHERE geraet_id = :g', ['g' => $ich]);
        if ($s['ziel'] > 0 && $neu !== $s['ziel']) {
            // Verbindung wurde anderswo beendet (das Ziel hat uns übernommen, anderer Tab …)
            $ev[] = ['getrennt', ['ziel' => $s['ziel'], 'neu' => $neu ?: null]];
            $s['zv'] = -1; $s['lv'] = -1; $s['online'] = null;
        }
        $s['ziel'] = $neu;
        // Bibliothek geändert (Abgleich, Einlesen, Bearbeiten …): die App holt Seite und Player-Angaben neu
        $bib = bib_stand();
        if ($bib !== $s['bv']) {
            $s['bv'] = $bib;
            $ev[] = ['bib', ['stand' => $bib]];
        }
    }
    if ($s['ziel'] > 0) {
        $z = db_zeile("SELECT zustand_ver, liste_ver, (zuletzt_am > NOW(3) - INTERVAL {$off} SECOND) AS online FROM fern_praesenz WHERE geraet_id = :z", ['z' => $s['ziel']]);
        $online = $z && $z['online'];
        if ($z && (int) $z['zustand_ver'] !== $s['zv']) {
            $s['zv'] = (int) $z['zustand_ver'];
            $roh = db_wert('SELECT zustand FROM fern_praesenz WHERE geraet_id = :z', ['z' => $s['ziel']]);
            $ev[] = ['zustand', ['ziel' => $s['ziel'], 'ver' => $s['zv'], 'jetzt' => (int) round(microtime(true) * 1000), 'zustand' => json_decode((string) $roh, true)]];
        }
        if ($z && (int) $z['liste_ver'] !== $s['lv']) {
            $s['lv'] = (int) $z['liste_ver'];
            $roh = db_wert('SELECT liste FROM fern_praesenz WHERE geraet_id = :z', ['z' => $s['ziel']]);
            $ev[] = ['liste', ['ziel' => $s['ziel'], 'ver' => $s['lv'], 'liste' => json_decode((string) $roh, true) ?: []]];
        }
        if ($online !== $s['online']) {
            $s['online'] = $online;
            $ev[] = ['online', ['ziel' => $s['ziel'], 'online' => $online]];
        }
    }
    return $ev;
}

/** GET /fern/strom – Rückkanal (SSE); mit ?einmal=1 eine einzelne Runde als JSON (Nachfragen ohne freien Kanal) */
function fern_strom(array $user): ?array
{
    $k = fern_konfig();
    $ich = fern_ich();
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();   // sonst blockiert der offene Kanal jede andere Anfrage dieser Sitzung
    }
    $s = [
        'user' => (int) $user['id'],
        'ab' => max(0, api_int('ab', 0)),
        'zv' => api_int('zv', -1), 'lv' => api_int('lv', -1),
        'online' => null, 'beob' => '', 'ziel' => 0,
        'bv' => preg_replace('/[^0-9a-f]/', '', (string) ($_GET['bv'] ?? '')),
    ];
    if ($s['ab'] === 0) {
        // frisch verbunden: nur Befehle ab jetzt
        $s['ab'] = (int) db_wert('SELECT COALESCE(MAX(id), 0) FROM fern_befehle WHERE ziel_id = :g', ['g' => $ich]);
    }
    $einmal = !empty($_GET['einmal']) || !$k['an'];
    if (!$einmal) {
        // Kanal frei? (Kanäle melden sich jede Sekunde; der eigene zählt nicht)
        $offen = (int) db_wert('SELECT COUNT(*) FROM fern_praesenz WHERE kanal_am > NOW(3) - INTERVAL 3 SECOND AND geraet_id <> :g', ['g' => $ich]);
        if ($offen >= max(1, (int) $k['max_verbindungen'])) {
            throw new ApiFehler(t('Gerade sind alle Kanäle belegt.'), 503, ['nachfragen' => true]);
        }
    }
    fern_da($ich, $s['user'], !$einmal);
    if ($einmal) {
        $ev = fern_runde($ich, $s, true);
        return ['ok' => true, 'ereignisse' => $ev, 'ab' => $s['ab'], 'zv' => $s['zv'], 'lv' => $s['lv'], 'bv' => $s['bv'], 'nachfragen' => !$k['an'] ? 2000 : 2000];
    }

    // ---- Server-Sent Events ----
    ignore_user_abort(true);
    $dauer = max(5, (int) $k['kanal_sekunden']);
    set_time_limit($dauer + 20);
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', '1');
    }
    @ini_set('zlib.output_compression', '0');
    while (ob_get_level() > 0) {
        ob_end_flush();
    }
    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-transform');
    header('X-Accel-Buffering: no');
    $senden = static function (string $name, $daten, ?int $id = null): void {
        echo ($id !== null ? "id: {$id}\n" : '') . "event: {$name}\ndata: " . json_encode($daten, JSON_UNESCAPED_UNICODE) . "\n\n";
    };
    echo 'retry: 2000' . "\n" . ':' . str_repeat(' ', 2048) . "\n\n";   // Polster gegen Puffer unterwegs
    $senden('hallo', ['ich' => $ich, 'ab' => $s['ab']]);
    flush();
    $start = microtime(true);
    $takt = max(100, (int) $k['takt_ms']) * 1000;
    $letzteVoll = 0.0;
    $letzterPuls = microtime(true);
    while (microtime(true) - $start < $dauer) {
        $voll = microtime(true) - $letzteVoll >= 1.0;
        if ($voll) {
            $letzteVoll = microtime(true);
            fern_da($ich, $s['user'], true);
        }
        foreach (fern_runde($ich, $s, $voll) as [$name, $daten]) {
            $senden($name, $daten, $name === 'befehl' ? $daten['id'] : null);
            $letzterPuls = microtime(true);
        }
        if (microtime(true) - $letzterPuls > 5) {
            echo ": puls\n\n";
            $letzterPuls = microtime(true);
        }
        flush();
        if (connection_aborted()) {
            return null;
        }
        usleep($takt);
    }
    $senden('ende', ['ab' => $s['ab'], 'zv' => $s['zv'], 'lv' => $s['lv'], 'bv' => $s['bv']]);
    flush();
    exit;
}
