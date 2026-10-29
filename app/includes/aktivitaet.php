<?php
// Aktivität: Jeder Player meldet alle paar Sekunden, was er gerade spielt (Titel, Position, Qualität, Weg).
// Die Verwaltung zeigt daraus „wer hört gerade was, wo, wie“ – ähnlich dem Plex-Dashboard.
declare(strict_types=1);

const AKTIV_SPIELT_SEKUNDEN = 35;     // spielende Player melden sich alle 10 s – ohne Meldung gelten sie danach als getrennt
const AKTIV_WEG_SEKUNDEN = 90;        // ohne jedes Lebenszeichen (Tab zu, Gerät aus) verschwindet der Eintrag danach ganz
// Pausierte Player melden sich alle 30 s; nach AKTIVITAET_PAUSE_MINUTEN (Standard 10) Pause werden sie ausgeblendet

function aktivitaet_melden(array $user): array
{
    $geraet = aktuelles_geraet_id();
    $schluessel = $geraet ? 'g' . $geraet : 'u' . (int) $user['id'] . '-' . substr(hash('sha256', session_id() ?: 'x'), 0, 12);
    $track = (int) api_wert('track_id', 0);
    if ($track <= 0 || api_wert('ereignis', '') === 'stopp') {
        db_tun('DELETE FROM aktive_wiedergaben WHERE schluessel = :s', ['s' => $schluessel]);
        return ['ok' => true];
    }
    $info = api_wert('info', []);
    $info = is_array($info) ? $info : [];
    // nur bekannte, kurze Felder übernehmen
    $erlaubt = ['qualitaet', 'art', 'lueckenlos', 'bitgenau', 'ersatz', 'direkt', 'eq', 'raumklang', 'layout', 'app', 'mobil', 'browser', 'lautheit'];
    $details = [];
    foreach ($erlaubt as $k) {
        if (array_key_exists($k, $info) && (is_scalar($info[$k]) || $info[$k] === null)) {
            $details[$k] = is_string($info[$k]) ? mb_substr($info[$k], 0, 80) : $info[$k];
        }
    }
    $netz = netz_info();
    $verbindung = !empty($details['direkt']) ? 'direkt' : (!empty($netz['lokal']) ? 'heim' : 'extern');
    $spielt = api_wert('spielt', false) ? 1 : 0;
    db_tun('INSERT INTO aktive_wiedergaben (schluessel, user_id, geraet_id, track_id, position_sek, dauer_sek, spielt, verbindung, ip, details, pausiert_seit)
            VALUES (:s, :u, :g, :t, :p, :d, :sp, :v, :ip, :de, IF(:sp2 = 1, NULL, NOW()))
            ON DUPLICATE KEY UPDATE gestartet_am = IF(track_id <> VALUES(track_id), NOW(), gestartet_am),
              pausiert_seit = IF(VALUES(spielt) = 1, NULL, IFNULL(pausiert_seit, NOW())),
              user_id = VALUES(user_id), geraet_id = VALUES(geraet_id), track_id = VALUES(track_id), position_sek = VALUES(position_sek),
              dauer_sek = VALUES(dauer_sek), spielt = VALUES(spielt), verbindung = VALUES(verbindung), ip = VALUES(ip),
              details = VALUES(details), aktualisiert_am = NOW()', [
        's' => $schluessel, 'u' => (int) $user['id'], 'g' => $geraet, 't' => $track,
        'p' => round(max(0, (float) api_wert('position', 0)), 2), 'd' => round(max(0, (float) api_wert('dauer', 0)), 2),
        'sp' => $spielt, 'sp2' => $spielt, 'v' => $verbindung, 'ip' => client_ip(), 'de' => json_encode($details, JSON_UNESCAPED_UNICODE),
    ]);
    return ['ok' => true];
}

/** Wie viele Umwandlungen (ffmpeg) laufen gerade? (belegte Plätze) */
function aktivitaet_umwandlungen(): int
{
    $max = max(1, (int) konfig()['stream']['max_umwandlungen']);
    $ordner = konfig()['pfade']['cache'] . '/tmp';
    $n = 0;
    for ($i = 0; $i < $max; $i++) {
        $d = $ordner . '/umwandlung-' . $i . '.lock';
        if (!is_file($d)) {
            continue;
        }
        $h = @fopen($d, 'c');
        if ($h && !flock($h, LOCK_EX | LOCK_NB)) {
            $n++;
        } elseif ($h) {
            flock($h, LOCK_UN);
        }
        if ($h) {
            fclose($h);
        }
    }
    return $n;
}

/** Ungefähre Datenrate in kbit/s für das, was gerade übertragen wird */
function aktivitaet_kbit(array $details, ?array $datei): int
{
    $q = (string) ($details['qualitaet'] ?? '');
    if (preg_match('/^(opus|aac)(\d+)$/', $q, $m)) {
        return (int) $m[2];
    }
    if (!$datei) {
        return 0;
    }
    if ((int) $datei['laenge_ms'] > 0 && (int) $datei['groesse'] > 0) {
        return (int) round($datei['groesse'] * 8 / $datei['laenge_ms']); // Bit pro ms = kbit/s
    }
    return (int) round(((int) $datei['bitrate']) / 1000);
}

function aktivitaet_liste(): array
{
    $pause = max(1, (int) konfig()['aktivitaet_pause_minuten']);
    // Ohne Lebenszeichen (Tab geschlossen, Gerät schläft) oder zu lange pausiert: raus
    db_tun('DELETE FROM aktive_wiedergaben WHERE aktualisiert_am < NOW() - INTERVAL ' . AKTIV_WEG_SEKUNDEN . ' SECOND'
        . ' OR (spielt = 0 AND pausiert_seit IS NOT NULL AND pausiert_seit < NOW() - INTERVAL ' . $pause . ' MINUTE)');
    $zeilen = db_alle('SELECT a.*, TIMESTAMPDIFF(SECOND, a.aktualisiert_am, NOW()) AS alter_sek,
                              TIMESTAMPDIFF(SECOND, a.pausiert_seit, NOW()) AS pause_sek, u.vorname, u.nachname, u.benutzername,
                              COALESCE(g.eigener_name, g.name) AS geraet_name, g.art AS geraet_art
                       FROM aktive_wiedergaben a JOIN users u ON u.id = a.user_id LEFT JOIN nutzer_geraete g ON g.id = a.geraet_id
                       ORDER BY a.spielt DESC, a.aktualisiert_am DESC');
    $ids = array_values(array_unique(array_map(static fn($z) => (int) $z['track_id'], $zeilen)));
    $tracks = [];
    foreach ($ids ? tracks_mit_album($ids, 0) : [] as $t) {
        $tracks[(int) $t['id']] = $t;
    }
    $dateien = [];
    if ($ids) {
        $in = implode(',', $ids);
        foreach (db_alle("SELECT track_id, format, codec, abtastrate, bittiefe, kanaele, laenge_ms, groesse, bitrate FROM dateien WHERE track_id IN ({$in})") as $d) {
            $dateien[(int) $d['track_id']] ??= $d;
        }
    }
    $aus = [];
    $summe = ['aktiv' => 0, 'pausiert' => 0, 'direkt' => 0, 'heim' => 0, 'extern' => 0, 'kbit_internet' => 0];
    foreach ($zeilen as $z) {
        $details = json_decode((string) $z['details'], true) ?: [];
        $alter = (int) $z['alter_sek'];
        $zustand = $z['spielt'] && $alter <= AKTIV_SPIELT_SEKUNDEN ? 'spielt' : ($z['spielt'] ? 'getrennt' : 'pausiert');
        $datei = $dateien[(int) $z['track_id']] ?? null;
        $kbit = aktivitaet_kbit($details, $datei);
        if ($zustand === 'spielt') {
            $summe['aktiv']++;
            $summe[$z['verbindung']] = ($summe[$z['verbindung']] ?? 0) + 1;
            if ($z['verbindung'] !== 'direkt') {
                $summe['kbit_internet'] += $kbit;
            }
        } else {
            $summe['pausiert']++;
        }
        $aus[] = [
            'schluessel' => $z['schluessel'],
            'user' => trim($z['vorname'] . ' ' . $z['nachname']) ?: $z['benutzername'],
            'geraet' => $z['geraet_name'] ?: t('Unbekanntes Gerät'),
            'geraet_art' => $z['geraet_art'] ?: 'browser',
            'track' => $tracks[(int) $z['track_id']] ?? ['id' => (int) $z['track_id'], 'titel' => t('Titel #{id}', ['id' => $z['track_id']])],
            'position' => (float) $z['position_sek'] + ($zustand === 'spielt' ? $alter : 0),
            'dauer' => (float) $z['dauer_sek'] > 0 ? (float) $z['dauer_sek'] : (float) (($tracks[(int) $z['track_id']]['laenge_ms'] ?? 0) / 1000),
            'zustand' => $zustand,
            'verbindung' => $z['verbindung'],
            'ip' => $z['ip'],
            'details' => $details,
            'datei' => $datei ? ['format' => $datei['format'], 'codec' => $datei['codec'], 'abtastrate' => (int) $datei['abtastrate'],
                'bittiefe' => (int) $datei['bittiefe'], 'kanaele' => (int) $datei['kanaele']] : null,
            'kbit' => $kbit,
            'seit' => iso($z['gestartet_am']),
            'aktualisiert_vor' => $alter,
            'pause_sek' => $z['pause_sek'] !== null ? (int) $z['pause_sek'] : null,
        ];
    }
    return ['wiedergaben' => $aus, 'summe' => $summe, 'umwandlungen' => aktivitaet_umwandlungen(), 'pause_minuten' => $pause,
        'max_umwandlungen' => (int) konfig()['stream']['max_umwandlungen'], 'zeit' => iso(date('Y-m-d H:i:s'))];
}
