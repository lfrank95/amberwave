<?php
// Heimnetz-Agent: spielt auf DLNA- und Google-Cast-Geräten (Receiver, Fernseher, Streamer, Nest, Android TV) wie eine Amberwave-App – Warteschlange,
// nächster Titel (lückenlos per SetNextAVTransportURI, sonst am Ende), Befehle der Fernsteuerung, Zustand für die
// Fernbedienungen. Ein Prozess für alle Geräte; startet bei Bedarf (Fernsteuerung, Geräteliste) und beendet sich nach
// HEIMNETZ_AGENT_RUHE Minuten ohne Arbeit.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/api.php';
require_once __DIR__ . '/../includes/fernsteuerung.php';
require_once __DIR__ . '/../includes/stream.php';
require_once __DIR__ . '/../includes/lautheit.php';
require_once __DIR__ . '/../includes/direktzugang.php';
require_once __DIR__ . '/../includes/i18n.php';
set_time_limit(0);
migrationen_ausfuehren();

@mkdir(dirname(hn_agent_sperre()), 0775, true);
$sperre = fopen(hn_agent_sperre(), 'c');
if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
    exit(0);   // läuft schon
}

/** @var array<int, array> Zustand je Gerät (Heimnetz-ID) */
$S = [];
$ab = (int) db_wert('SELECT COALESCE(MAX(id), 0) FROM fern_befehle WHERE erstellt_am < NOW(3) - INTERVAL 15 SECOND');
$letzteArbeit = microtime(true);
$letzteListe = 0.0;
$ruhe = max(1, (int) hn_konfig()['agent_ruhe_minuten']) * 60;
$takt = max(300, (int) hn_konfig()['abfrage_ms']) / 1000;

/** Taktrate für Anzeigetexte: 44,1 / 44.1, 96 */
function khz_text(float $hz): string
{
    $z = zahl_fmt($hz / 1000, 1);
    $komma = sprache() === 'en' ? '.' : ',';
    return str_contains($z, $komma) ? rtrim(rtrim($z, '0'), $komma) : $z;
}

function agent_log(int $hid, string $t): void
{
    try {
        hn_protokoll($hid, $t);
    } catch (Throwable $e) {
    }
}

function sitzung_neu(int $hid): array
{
    // nach einem Neustart des Agenten: Warteschlange aus der Fernsteuerung wiederherstellen
    $p = db_zeile('SELECT zustand, liste FROM fern_praesenz WHERE geraet_id = :g', ['g' => hn_fern_id($hid)]);
    $z = hn_json($p['zustand'] ?? '');
    $l = json_decode((string) ($p['liste'] ?? ''), true);
    return [
        'liste' => is_array($l) ? $l : [], 'index' => (int) ($z['index'] ?? -1), 'kontext' => $z['kontext'] ?? null,
        'zufall' => !empty($z['zufall']), 'wdh' => (string) ($z['wdh'] ?? 'aus'), 'user' => (int) ($z['user'] ?? 0),
        'spielt' => false, 'pos' => (float) ($z['pos'] ?? 0), 'dauer' => (float) ($z['dauer'] ?? 0), 'uri' => '', 'next_uri' => '', 'next_index' => -1,
        'lv' => (int) ($z['lv'] ?? 0), 'liste_neu' => false, 'bereit' => false, 'gestartet' => 0.0, 'zustand_zeit' => 0.0, 'status_zeit' => 0.0,
        'aktiv_bis' => microtime(true) + 300, 'meldung' => null, 'bitgenau' => false, 'klang_text' => '', 'transport' => '', 'still_seit' => microtime(true),
        'eingeschaltet' => false, 'geschrieben' => '',
    ];
}

function meldung(array &$s, string $text): void
{
    $s['meldung'] = ['text' => $text, 't' => (int) round(microtime(true) * 1000)];
}

/** Dateiinfos eines Titels */
function datei_info(int $tid): ?array
{
    return db_zeile('SELECT format, abtastrate, bittiefe, kanaele, laenge_ms FROM dateien WHERE track_id = :t ORDER BY bittiefe DESC, abtastrate DESC, id LIMIT 1', ['t' => $tid]);
}

/** Lautheitsangleich wie in der App (Album, wenn Nachbarn aus derselben Edition direkt folgen) – [gain_db, lufs] */
function lautheit_fuer(array $s, int $i, float $ziel): array
{
    $t = $s['liste'][$i] ?? null;
    if (!$t) {
        return [0.0, null];
    }
    $ids = array_filter([(int) ($s['liste'][$i - 1]['id'] ?? 0), (int) $t['id'], (int) ($s['liste'][$i + 1]['id'] ?? 0)]);
    $lh = lh_fuer_tracks($ids);
    $l = $lh[(int) $t['id']] ?? null;
    if (!$l || $l['q'] === 'fehlt') {
        return [0.0, null];
    }
    $folgt = static fn($a, $b) => $a && $b && $a['q'] !== 'fehlt' && $b['q'] !== 'fehlt' && $a['e'] === $b['e'] && $b['o'] === $a['o'] + 1;
    $album = $l['a'] !== null && ($folgt($lh[(int) ($s['liste'][$i - 1]['id'] ?? 0)] ?? null, $l) || $folgt($l, $lh[(int) ($s['liste'][$i + 1]['id'] ?? 0)] ?? null));
    $lufs = $album ? $l['a'] : ($l['t'] ?? $l['a']);
    $tp = $album ? $l['atp'] : ($l['ttp'] ?? $l['atp']);
    if ($lufs === null) {
        return [0.0, null];
    }
    $db = $ziel - $lufs;
    if ($db > 0) {
        $db = min($db, max(0.0, -1.0 - (float) ($tp ?? 0)));
    }
    return [round($db, 2), (float) $lufs];
}

/** Adresse + Metadaten für Titel i: Original (bitgenau), wenn das Gerät es kann, sonst gerechnet */
function titel_url(array $g, array &$s, int $i): ?array
{
    $t = $s['liste'][$i] ?? null;
    if (!$t) {
        return null;
    }
    $basis = hn_basis()['url'];
    if ($basis === '') {
        meldung($s, t('Unbekannt, unter welcher Adresse das Gerät den Server erreicht – bitte unter Einstellungen › Geräte im Heimnetz eintragen (oder HEIMNETZ_URL).'));
        return null;
    }
    $d = datei_info((int) $t['id']);
    if (!$d) {
        return null;
    }
    $f = hn_json($g['faehig']);
    $e = hn_einst($g);
    $k = $e['klang'];
    $maxRate = (int) ($e['max_rate'] ?? $f['max_rate'] ?? 192000);
    $maxBits = (int) ($e['max_bits'] ?? $f['max_bits'] ?? 24);
    $rate = (int) $d['abtastrate'] ?: 44100;
    $bits = (int) $d['bittiefe'] ?: 16;
    $kan = (int) $d['kanaele'] ?: 2;
    $effekte = $k['weg'] === 'effekte' && !empty($k['befehle']) && hn_render_pfad() !== null;
    $format = strtolower((string) $d['format']);
    $formatOk = match ($format) {
        'flac' => !empty($f['flac']),
        'wav' => !empty($f['wav']),
        'mp3' => in_array('audio/mpeg', $f['formate'] ?? [], true) || empty($f['formate']),
        'm4a', 'aac', 'alac' => in_array('audio/mp4', $f['formate'] ?? [], true) || in_array('audio/x-m4a', $f['formate'] ?? [], true),
        default => false,
    };
    $original = !$effekte && $formatOk && empty($f['umrechnen']) && $rate <= $maxRate && $bits <= $maxBits && ($kan <= 2 || !empty($f['mehrkanal']));
    $daten = ['t' => (int) $t['id'], 'u' => $s['user'], 'gd' => (int) $g['id']];
    $klangText = 'Original';
    if ($original) {
        $daten['m'] = 'o';
        $mime = AUDIO_MIME[$format] ?? 'audio/flac';
    } else {
        // Zielrate: dieselbe Familie (44,1 / 48) bis zur Grenze des Geräts
        $r = $rate;
        while ($r > $maxRate) {
            $r = intdiv($r, 2);
        }
        if ($r < 32000) {
            $r = $rate % 44100 === 0 ? 44100 : 48000;
        }
        $kanEin = $effekte ? min(2, $kan) : ($kan > 2 && empty($f['mehrkanal']) ? 2 : $kan);
        // Space: Stereo → 5.1 (bzw. Quadro) auf dem Server – nicht, wenn das Gerät es schon einmal abgelehnt hat
        $raum = null;
        $sp = $k['space'] ?? [];
        if ($effekte && !empty($sp['an']) && ($f['space'] ?? null) !== false) {
            $rs = $rate % 44100 === 0 ? 44100 : 48000;   // Space rechnet in der Familie der Quelle mit 44,1 bzw. 48 kHz
            $raum = hn_raum_datei((string) ($sp['raten'][(string) $rs] ?? '')) ?? null;
            if ($raum === null) {
                foreach ($sp['raten'] ?? [] as $rr => $hash) {
                    if ($raum = hn_raum_datei((string) $hash)) {
                        $rs = (int) $rr;
                        break;
                    }
                }
            }
            if ($raum !== null) {
                $r = $rs;
                if ($r > $maxRate) {
                    // Gerät auf 44,1 kHz begrenzt, Quelle aus der 48er-Familie: dann den 44,1-Graphen nehmen, sonst kein Space
                    $andere = hn_raum_datei((string) ($sp['raten']['44100'] ?? ''));
                    if ($andere !== null && 44100 <= $maxRate) {
                        $raum = $andere;
                        $r = 44100;
                    } else {
                        $raum = null;
                        $r = min($rs, $maxRate);
                    }
                }
            }
        }
        if ($effekte && !empty($sp['an']) && ($f['space'] ?? null) !== false && $raum === null && empty($s['space_datei_fehlt'])) {
            $s['space_datei_fehlt'] = true;
            agent_log((int) $g['id'], t('Space: vorbereitete Daten fehlen im Cache – bitte im Klang-Blatt noch einmal „Übernehmen“ (läuft in Stereo)'));
            meldung($s, $g['name'] . ': ' . t('Space-Daten fehlen – bitte im Klang-Blatt neu übernehmen'));
        }
        $kanAus = $raum !== null ? ((int) ($sp['kanaele'] ?? 6) === 4 ? 4 : 6) : $kanEin;
        $daten += ['m' => 'r', 'r' => $r, 'b' => min(24, $maxBits) >= 24 && ($bits > 16 || $effekte) ? 24 : 16, 'ki' => $kanEin, 'k' => $kanAus];
        if ($effekte) {
            [$gain, $lufs] = !empty($k['lautheit']) ? lautheit_fuer($s, $i, (float) ($k['ziel'] ?? -16)) : [0.0, null];
            $daten['h'] = hn_kette_vorbereiten($k, $lufs !== null ? $lufs + $gain : null, $raum !== null);
            if ($raum !== null) {
                $daten['sp'] = substr(basename($raum), 5, 24);
            }
            $daten['g'] = $gain;
            $klangText = t('Effekte') . ' · ' . ($k['beschreibung'] ?: 'Server') . ($raum !== null ? ' · Space ' . ($sp['name'] ?: '') . ' ' . ($kanAus === 6 ? '5.1' : t('Quadro')) : '');
        } else {
            $klangText = t('umgerechnet · {khz} kHz/{bit} Bit (Gerätegrenze)', ['khz' => khz_text((float) $r), 'bit' => $daten['b']]);
        }
        $mime = 'audio/wav';
    }
    $url = $basis . '/api/v1/heim/s/' . hn_stream_token($daten);
    $technik = $original
        ? strtoupper($format) . ($bits ? " · {$bits} bit" : '') . ' · ' . khz_text((float) $rate) . ' kHz'
        : 'WAV · ' . $daten['b'] . ' bit · ' . khz_text((float) $daten['r']) . ' kHz'
            . ((int) ($daten['k'] ?? 2) === 6 ? ' · 5.1' : ((int) ($daten['k'] ?? 2) === 4 ? ' · ' . t('Quadro') : ''));
    // Metadaten (Titel, Künstler, Album, Cover) – Cover mit kurzem Schlüssel, das Gerät hat ja kein Login
    $kuenstler = implode(', ', array_map(static fn($x) => is_array($x) ? (string) ($x['name'] ?? '') : (string) $x, (array) ($t['kuenstler'] ?? [])));
    $cover = cover_fuer_geraet($g, $t, hn_ist_cast($g) ? 1000 : 600);
    $sek = (int) round(((int) $d['laenge_ms']) / 1000);
    $dauer = sprintf('%d:%02d:%02d.000', intdiv($sek, 3600), intdiv($sek % 3600, 60), $sek % 60);
    $x = static fn($v) => htmlspecialchars((string) $v, ENT_XML1 | ENT_QUOTES, 'UTF-8');
    $meta = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
        . '<item id="aw-' . (int) $t['id'] . '" parentID="0" restricted="1"><dc:title>' . $x($t['titel'] ?? '') . '</dc:title>'
        . ($kuenstler !== '' ? '<dc:creator>' . $x($kuenstler) . '</dc:creator><upnp:artist>' . $x($kuenstler) . '</upnp:artist>' : '')
        . (!empty($t['album']['titel']) ? '<upnp:album>' . $x($t['album']['titel']) . '</upnp:album>' : '')
        . ($cover !== '' ? '<upnp:albumArtURI>' . $x($cover) . '</upnp:albumArtURI>' : '')
        . '<upnp:class>object.item.audioItem.musicTrack</upnp:class>'
        . '<res protocolInfo="http-get:*:' . $mime . ':*" duration="' . $dauer . '"'
        . (!$original ? ' sampleFrequency="' . (int) $daten['r'] . '" bitsPerSample="' . (int) $daten['b'] . '" nrAudioChannels="' . (int) $daten['k'] . '"' : '')
        . '>' . $x($url) . '</res></item></DIDL-Lite>';
    return ['url' => $url, 'meta' => $meta, 'dauer' => ((int) $d['laenge_ms']) / 1000, 'original' => $original, 'klang' => $klangText,
        'mime' => $mime, 'cover' => $cover, 'track' => $t, 'technik' => $technik, 'space' => !$original && (int) ($daten['k'] ?? 2) > 2 && !empty($daten['h'])];
}

/** Gerät für die Wiedergabe vorbereiten: einschalten, Eingang, Tonmodus, Startlautstärke */
function geraet_vorbereiten(array $g, array &$s): void
{
    $e = hn_einst($g);
    if (!$g['steuerung'] || hn_ist_cast($g)) {
        return;
    }
    $st = hn_status($g);
    if (!empty($st['erreichbar']) && empty($st['an']) && $e['einschalten']) {
        agent_log((int) $g['id'], t('einschalten'));
        hn_ein($g);
        $s['eingeschaltet'] = true;
        for ($i = 0; $i < 15; $i++) {
            usleep(800000);
            $st = hn_status($g);
            if (!empty($st['an'])) {
                break;
            }
        }
        usleep(1500000);   // Netzwerkteil braucht nach dem Einschalten noch einen Moment
        if ($e['start_vol'] !== null) {
            hn_vol_setzen($g, (float) $e['start_vol']);
        }
    }
    if ($e['eingang']) {
        hn_eingang_netz($g);
        usleep(1200000);
    }
    if ($e['tonmodus'] !== '') {
        hn_tonmodus($g, $e['tonmodus']);
    }
}

function avt(array $g, string $aktion, array $args = []): array
{
    return hn_soap($g['avt_url'], HN_AVT, $aktion, ['InstanceID' => 0] + $args, 4.0);
}

function zeit_text(float $s): string
{
    $s = max(0, (int) round($s));
    return sprintf('%d:%02d:%02d', intdiv($s, 3600), intdiv($s % 3600, 60), $s % 60);
}

function zeit_sek(string $t): float
{
    if (!preg_match('/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/', trim($t), $m)) {
        return 0.0;
    }
    return (int) $m[1] * 3600 + (int) $m[2] * 60 + (int) $m[3] + (isset($m[4]) ? (float) ('0.' . $m[4]) : 0);
}

/** nächsten Index nach den Regeln der App (Wiederholen alle/eins) */
function naechster_index(array $s, int $i): int
{
    if ($s['wdh'] === 'eins') {
        return $i;
    }
    if ($i + 1 < count($s['liste'])) {
        return $i + 1;
    }
    return $s['wdh'] === 'alle' && $s['liste'] ? 0 : -1;
}

/** Titel i starten (ab Sekunde ab) */
function starten(array $g, array &$s, int $i, float $ab = 0.0): void
{
    if (!isset($s['liste'][$i])) {
        return;
    }
    if (!$s['bereit']) {
        geraet_vorbereiten($g, $s);
        $s['bereit'] = true;
    }
    $s['index'] = $i;
    $u = titel_url($g, $s, $i);
    if (!$u) {
        $s['spielt'] = false;
        return;
    }
    $t = $s['liste'][$i];
    if (hn_ist_cast($g)) {
        $u = cast_starten($g, $s, $i, $u, $ab);
        if (!$u) {
            $s['spielt'] = false;
            return;
        }
    } else for ($versuch = 0; $versuch < 2; $versuch++) {
        try {
            try {
                avt($g, 'Stop');
            } catch (Throwable $e) {
            }
            avt($g, 'SetAVTransportURI', ['CurrentURI' => $u['url'], 'CurrentURIMetaData' => $u['meta']]);
            avt($g, 'Play', ['Speed' => 1]);
            if ($ab > 1) {
                usleep(600000);
                try {
                    avt($g, 'Seek', ['Unit' => 'REL_TIME', 'Target' => zeit_text($ab)]);
                } catch (Throwable $e) {
                    $ab = 0.0;   // Gerät spielt von vorn – die Space-Beobachtung rechnet dann ab 0
                }
            }
            break;
        } catch (Throwable $e) {
            // Space (5.1) als abgelehnt werten: nur bei einer echten Antwort des Geräts (UPnP-Fehler), nicht bei Timeout
            // (Gerät schaltet gerade den Eingang um) – und erst, wenn der normale zweite Versuch auch scheitert
            $antwortet = !str_contains($e->getMessage(), t('Gerät antwortet nicht'));
            $formatNein = $antwortet && str_starts_with($e->getMessage(), 'SetAVTransportURI:') && !str_contains($e->getMessage(), ': 701');
            if (!empty($u['space']) && empty($spaceWeg) && $antwortet && ($versuch === 1 || $formatNein)) {
                $spaceWeg = true;
                // 5.1-Stream abgelehnt: merken, in Stereo noch einmal
                space_abgelehnt($g, $s, 'DLNA: ' . $e->getMessage());
                $u = titel_url($g, $s, $i) ?? $u;
                $versuch = -1;   // mit Stereo wieder zwei Versuche
                continue;
            }
            if ($versuch === 1) {
                meldung($s, $g['name'] . ': ' . $e->getMessage());
                agent_log((int) $g['id'], t('Abspielen fehlgeschlagen: {fehler}', ['fehler' => $e->getMessage()]));
                $s['spielt'] = false;
                return;
            }
            usleep(2000000);   // z. B. Eingang schaltet gerade um
        }
    }
    $s['uri'] = $u['url'];
    $s['spielt'] = true;
    $s['pos'] = $ab;
    $s['dauer'] = $u['dauer'];
    $s['gestartet'] = microtime(true);
    $s['bitgenau'] = $u['original'];
    $s['klang_text'] = $u['klang'];
    $s['space'] = !empty($u['space']);
    $s['space_lief'] = false;
    $s['space_ab'] = $ab;
    unset($s['space_pos0']);
    $s['next_uri'] = '';
    $s['next_index'] = -1;
    agent_log((int) $g['id'], '▶ ' . ($t['titel'] ?? '') . ' · ' . $u['klang']);
    if ($s['user'] > 0) {
        try {
            $tz = db_zeile('SELECT m.edition_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE t.id = :t', ['t' => (int) $t['id']]);
            if ($tz) {
                db_einfuegen('INSERT INTO wiedergaben (user_id, track_id, edition_id, geraet_id, quelle) VALUES (:u, :t, :e, NULL, :q)',
                    ['u' => $s['user'], 't' => (int) $t['id'], 'e' => $tz['edition_id'], 'q' => 'heimnetz']);
            }
        } catch (Throwable $e) {
        }
    }
    naechsten_vormerken($g, $s);
}

/**
 * Google Cast: Titel laden (Standard-Empfänger). Lehnt das Gerät das Original ab (manche können kein FLAC), merkt sich
 * Amberwave das und schickt künftig vom Server umgerechnetes WAV – für größtmögliche Verträglichkeit.
 */
function cast_starten(array &$g, array &$s, int $i, array $u, float $ab): ?array
{
    for ($versuch = 0; $versuch < 3; $versuch++) {
        try {
            $c = cast_verbindung($g, $versuch > 0);
            $c->laden(cast_media($u['url'], $u['mime'], $u['track'], $u['cover'], $u['dauer'], ['technik' => $u['technik'], 'klang' => $u['klang']]), $ab);
            $s['next_item'] = null;
            if ($c->hinweis) {
                agent_log((int) $g['id'], $c->hinweis);
                $c->hinweis = null;
            }
            return $u;
        } catch (Throwable $e) {
            $fehler = $e->getMessage();
            agent_log((int) $g['id'], 'Cast: ' . $fehler);
            if ($u['original'] && preg_match('/LOAD_FAILED|ERROR|INVALID/', $fehler)) {
                // Format abgelehnt: ab jetzt umrechnen (WAV), bei 24/96 zuerst 16/48
                $f = hn_json($g['faehig']);
                if ($u['mime'] === 'audio/flac') $f['flac'] = false; else $f['umrechnen'] = true;
                db_tun('UPDATE heimgeraete SET faehig = :f WHERE id = :id', ['f' => json_encode($f), 'id' => $g['id']]);
                $g['faehig'] = json_encode($f);
                agent_log((int) $g['id'], t('Original abgelehnt – ab jetzt rechnet der Server um'));
                $u = titel_url($g, $s, $i) ?? $u;
                continue;
            }
            if (!empty($u['space']) && preg_match('/LOAD_FAILED|ERROR|INVALID/', $fehler)) {
                space_abgelehnt($g, $s, 'Cast: ' . $fehler);
                $u = titel_url($g, $s, $i) ?? $u;
                continue;
            }
            if (!$u['original'] && preg_match('/LOAD_FAILED/', $fehler)) {
                $f = hn_json($g['faehig']);
                if (($f['max_rate'] ?? 96000) > 48000 || ($f['max_bits'] ?? 24) > 16) {
                    $f['max_rate'] = 48000; $f['max_bits'] = 16;
                    db_tun('UPDATE heimgeraete SET faehig = :f WHERE id = :id', ['f' => json_encode($f), 'id' => $g['id']]);
                    $g['faehig'] = json_encode($f);
                    agent_log((int) $g['id'], t('Format abgelehnt – ab jetzt 48 kHz / 16 Bit'));
                    $u = titel_url($g, $s, $i) ?? $u;
                    continue;
                }
            }
            if ($versuch === 2) {
                meldung($s, $g['name'] . ': ' . $fehler);
                return null;
            }
            usleep(800000);
        }
    }
    return null;
}

/** lückenlos: nächsten Titel beim Gerät vormerken (wenn es SetNext kann) */
function naechsten_vormerken(array $g, array &$s): void
{
    $f = hn_json($g['faehig']);
    if (empty($f['setnext']) || $s['index'] < 0) {
        return;
    }
    $n = naechster_index($s, $s['index']);
    if ($n === $s['next_index'] && $n >= 0) {
        return;
    }
    if (hn_ist_cast($g)) {
        cast_vormerken($g, $s, $n);
        return;
    }
    if ($n < 0) {
        return;
    }
    $u = titel_url($g, $s, $n);
    if (!$u) {
        return;
    }
    try {
        avt($g, 'SetNextAVTransportURI', ['NextURI' => $u['url'], 'NextURIMetaData' => $u['meta']]);
        $s['next_uri'] = $u['url'];
        $s['next_index'] = $n;
        $s['next_info'] = $u;
    } catch (Throwable $e) {
        // kann das Gerät nicht: Ende abwarten und dann neu starten
        $f['setnext'] = false;
        db_tun('UPDATE heimgeraete SET faehig = :f WHERE id = :id', ['f' => json_encode($f), 'id' => $g['id']]);
        agent_log((int) $g['id'], t('kein SetNext – nächster Titel wird am Ende gestartet'));
    }
}

/** Google Cast: nächsten Titel in die Warteschlange des Geräts (wird vorgeladen); ein früher vorgemerkter fliegt raus */
function cast_vormerken(array $g, array &$s, int $n): void
{
    try {
        $c = cast_verbindung($g);
        if (!empty($s['next_item'])) {
            $c->entfernen([(int) $s['next_item']]);
            $s['next_item'] = null;
            $s['next_uri'] = '';
            $s['next_index'] = -1;
        }
        if ($n < 0) {
            return;
        }
        $u = titel_url($g, $s, $n);
        if (!$u) {
            return;
        }
        $s['next_item'] = $c->einreihen(cast_media($u['url'], $u['mime'], $u['track'], $u['cover'], $u['dauer'], ['technik' => $u['technik'], 'klang' => $u['klang']]));
        $s['next_uri'] = $u['url'];
        $s['next_index'] = $n;
        $s['next_info'] = $u;
    } catch (Throwable $e) {
        $f = hn_json($g['faehig']);
        $f['setnext'] = false;
        db_tun('UPDATE heimgeraete SET faehig = :f WHERE id = :id', ['f' => json_encode($f), 'id' => $g['id']]);
        agent_log((int) $g['id'], t('keine Warteschlange am Gerät ({fehler}) – nächster Titel wird am Ende gestartet', ['fehler' => $e->getMessage()]));
    }
}

/** Transport-Befehle für beide Arten */
function ctl(array $g, string $was, float $sek = 0.0): void
{
    if (hn_ist_cast($g)) {
        $c = cast_verbindung($g);
        match ($was) {
            'pause' => $c->befehl('PAUSE'),
            'play' => $c->befehl('PLAY'),
            'stop' => $c->befehl('STOP'),
            'seek' => $c->befehl('SEEK', ['currentTime' => $sek, 'resumeState' => 'PLAYBACK_START']),
        };
        return;
    }
    match ($was) {
        'pause' => avt($g, 'Pause'),
        'play' => avt($g, 'Play', ['Speed' => 1]),
        'stop' => avt($g, 'Stop'),
        'seek' => avt($g, 'Seek', ['Unit' => 'REL_TIME', 'Target' => zeit_text($sek)]),
    };
}

/** Befehl der Fernsteuerung ausführen */
function befehl(array $g, array &$s, array $b): void
{
    $x = json_decode((string) $b['daten'], true);
    $art = (string) $b['befehl'];
    $s['aktiv_bis'] = microtime(true) + 600;
    try {
        switch ($art) {
            case 'abspielen':
                if (!is_array($x) || empty($x['tracks'])) {
                    return;
                }
                $alle = array_values(array_filter($x['tracks'], static fn($t) => is_array($t) && ($t['verfuegbar'] ?? true) !== false && !empty($t['id'])));
                $startId = (int) ($x['tracks'][(int) ($x['start'] ?? 0)]['id'] ?? 0);
                $s['liste'] = $alle;
                $i = 0;
                foreach ($alle as $j => $t) {
                    if ((int) $t['id'] === $startId) { $i = $j; break; }
                }
                $s['kontext'] = is_array($x['kontext'] ?? null) ? $x['kontext'] + ['fern' => true] : ['fern' => true];
                $s['user'] = (int) $b['von_user'];
                if ($s['zufall']) {
                    $aktuell = $s['liste'][$i];
                    $rest = array_values(array_filter($s['liste'], static fn($t, $j) => $j !== $i, ARRAY_FILTER_USE_BOTH));
                    shuffle($rest);
                    $s['liste'] = array_merge([$aktuell], $rest);
                    $i = 0;
                }
                $s['liste_neu'] = true;
                starten($g, $s, $i, (float) ($x['ab'] ?? 0));
                break;
            case 'play':
            case 'pp':
                if ($art === 'pp' && $s['spielt']) {
                    ctl($g, 'pause');
                    $s['spielt'] = false;
                } elseif ($s['uri'] === '') {
                    starten($g, $s, max(0, $s['index']), $s['pos']);
                } else {
                    ctl($g, 'play');
                    $s['spielt'] = true;
                }
                break;
            case 'pause':
            case 'holen':
                if ($s['spielt']) {
                    ctl($g, 'pause');
                }
                $s['spielt'] = false;
                break;
            case 'stopp':
                ctl($g, 'stop');
                $s['spielt'] = false;
                $s['pos'] = 0;
                $s['uri'] = '';
                break;
            case 'weiter':
                $n = $s['index'] + 1 < count($s['liste']) ? $s['index'] + 1 : ($s['wdh'] === 'alle' ? 0 : -1);
                if ($n >= 0) {
                    starten($g, $s, $n);
                }
                break;
            case 'zurueck':
                if ($s['pos'] > 4 || $s['index'] <= 0) {
                    ctl($g, 'seek', 0.0);
                    $s['pos'] = 0;
                } else {
                    starten($g, $s, $s['index'] - 1);
                }
                break;
            case 'springen':
                $sek = max(0.0, (float) $x);
                ctl($g, 'seek', $sek);
                $s['pos'] = $sek;
                break;
            case 'springen_zu':
                starten($g, $s, max(0, min(count($s['liste']) - 1, (int) $x)));
                break;
            case 'neu_laden':
                if ($s['uri'] !== '' && $s['index'] >= 0) {
                    $s['next_index'] = -1;
                    starten($g, $s, $s['index'], $s['pos']);
                }
                break;
            case 'vol':
                $bereich = hn_vol_bereich($g);
                $wert = $bereich['min'] + max(0.0, min(1.0, (float) $x)) * ($bereich['max'] - $bereich['min']);
                if ($g['steuerung'] === '' && $g['rc_url'] === '' && !hn_ist_cast($g)) {
                    meldung($s, t('Lautstärke lässt sich an diesem Gerät nicht regeln'));
                    break;
                }
                hn_vol_setzen($g, $wert);
                $z = hn_json($g['zustand']);
                $z['vol'] = $wert;
                db_tun('UPDATE heimgeraete SET zustand = :z WHERE id = :id', ['z' => json_encode($z), 'id' => $g['id']]);
                break;
            case 'zufall':
                $s['zufall'] = !$s['zufall'];
                if ($s['zufall'] && count($s['liste']) > 1 && $s['index'] >= 0) {
                    $aktuell = $s['liste'][$s['index']];
                    $rest = array_values(array_filter($s['liste'], static fn($t, $j) => $j !== $s['index'], ARRAY_FILTER_USE_BOTH));
                    shuffle($rest);
                    $s['liste'] = array_merge([$aktuell], $rest);
                    $s['index'] = 0;
                    $s['liste_neu'] = true;
                    $s['next_index'] = -1;
                    naechsten_vormerken($g, $s);
                }
                break;
            case 'wdh':
                $s['wdh'] = ['aus' => 'alle', 'alle' => 'eins', 'eins' => 'aus'][$s['wdh']] ?? 'aus';
                $s['next_index'] = -1;
                naechsten_vormerken($g, $s);
                break;
            case 'naechstes':
            case 'anhaengen':
                $neu = array_values(array_filter((array) ($x['tracks'] ?? []), static fn($t) => is_array($t) && !empty($t['id'])));
                if (!$neu) {
                    break;
                }
                if (!$s['liste']) {
                    $s['liste'] = $neu;
                    $s['user'] = (int) $b['von_user'];
                    $s['liste_neu'] = true;
                    starten($g, $s, 0);
                    break;
                }
                if ($art === 'naechstes') {
                    array_splice($s['liste'], $s['index'] + 1, 0, $neu);
                } else {
                    array_push($s['liste'], ...$neu);
                }
                $s['liste_neu'] = true;
                $s['next_index'] = -1;
                naechsten_vormerken($g, $s);
                break;
            case 'entfernen':
                $i = (int) $x;
                if ($i !== $s['index'] && isset($s['liste'][$i])) {
                    array_splice($s['liste'], $i, 1);
                    if ($i < $s['index']) {
                        $s['index']--;
                    }
                    $s['liste_neu'] = true;
                    $s['next_index'] = -1;
                    naechsten_vormerken($g, $s);
                }
                break;
        }
    } catch (Throwable $e) {
        meldung($s, $g['name'] . ': ' . $e->getMessage());
        agent_log((int) $g['id'], t('Befehl {art}: {fehler}', ['art' => $art, 'fehler' => $e->getMessage()]));
    }
}

/** Transport des Geräts lesen: Position, Titelwechsel (SetNext), Ende → nächster Titel */
function transport(array $g, array &$s): void
{
    if (hn_ist_cast($g)) {
        cast_transport($g, $s);
        return;
    }
    try {
        $ti = avt($g, 'GetTransportInfo');
        $pi = avt($g, 'GetPositionInfo');
    } catch (Throwable $e) {
        return;
    }
    $zustand = (string) ($ti['CurrentTransportState'] ?? '');
    $s['transport'] = $zustand;
    $uri = (string) ($pi['TrackURI'] ?? '');
    $pos = zeit_sek((string) ($pi['RelTime'] ?? '0:00:00'));
    // das Gerät ist von selbst zum vorgemerkten Titel gesprungen
    if ($s['next_uri'] !== '' && $uri === $s['next_uri']) {
        $s['index'] = $s['next_index'];
        $s['uri'] = $s['next_uri'];
        $s['dauer'] = $s['next_info']['dauer'] ?? $s['dauer'];
        $s['bitgenau'] = $s['next_info']['original'] ?? $s['bitgenau'];
        $s['klang_text'] = $s['next_info']['klang'] ?? $s['klang_text'];
        $s['space'] = !empty($s['next_info']['space']);
        $s['space_lief'] = false;
        $s['space_ab'] = 0.0;
        unset($s['space_pos0']);
        $s['next_uri'] = '';
        $s['next_index'] = -1;
        $s['gestartet'] = microtime(true);
        agent_log((int) $g['id'], '▶ ' . ($s['liste'][$s['index']]['titel'] ?? '') . ' ' . t('(lückenlos)'));
        naechsten_vormerken($g, $s);
    }
    if ($zustand === 'PLAYING' || $zustand === 'TRANSITIONING') {
        if ($uri !== '' && $uri !== $s['uri'] && $uri !== $s['next_uri'] && microtime(true) - $s['gestartet'] > 5) {
            // jemand spielt am Gerät etwas anderes (andere App, anderer Eingang): wir sind raus
            $s['spielt'] = false;
            $s['uri'] = '';
            return;
        }
        $s['spielt'] = true;
        $s['pos'] = $pos;
        $s['still_seit'] = microtime(true);
    } elseif ($zustand === 'PAUSED_PLAYBACK') {
        $s['spielt'] = false;
        $s['pos'] = $pos;
    } elseif (in_array($zustand, ['STOPPED', 'NO_MEDIA_PRESENT'], true)) {
        if ($s['spielt'] && microtime(true) - $s['gestartet'] > 4) {
            // Ende des Titels (ohne SetNext) → nächsten starten; sonst wurde am Gerät gestoppt
            if ($s['pos'] >= $s['dauer'] - 6 || microtime(true) - $s['gestartet'] >= $s['dauer'] - 3) {
                $n = naechster_index($s, $s['index']);
                if ($n >= 0) {
                    starten($g, $s, $n);
                    return;
                }
                $s['pos'] = 0;
            }
            $s['spielt'] = false;
        }
    }
}

/**
 * Cover-Adresse für ein Gerät ohne Anmeldung. Der Schlüssel des Covers kommt aus der Datenbank (Edition des Titels),
 * nie aus dem, was ein Client in der Warteschlange mitschickt – und der Bild-Schlüssel (?bt=) öffnet nur dieses eine Bild.
 * Geräte verraten ihre Adressen jedem im Heimnetz (UPnP, Cast-Status), darum darf dort kein Zugangsschlüssel stehen.
 */
function cover_fuer_geraet(array $g, array $t, int $groesse): string
{
    static $schluessel = [];
    $tid = (int) ($t['id'] ?? 0);
    if ($tid <= 0) {
        return '';
    }
    if (!array_key_exists($tid, $schluessel)) {
        if (count($schluessel) > 2000) {
            $schluessel = [];
        }
        $schluessel[$tid] = (string) db_wert('SELECT e.cover_datei FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id WHERE t.id = :t', ['t' => $tid]);
    }
    if ($schluessel[$tid] === '') {
        return '';
    }
    $basis = hn_ist_cast($g) ? cast_https_basis() : hn_basis()['url'];
    return $basis . bild_url_geraet('cover', $schluessel[$tid], $groesse, 86400 * 2);
}

/** Cover-Adresse für Cast-Geräte (HTTPS, Bild-Schlüssel) */
function cast_cover(array $g, array $t, int $groesse = 600): string
{
    return cover_fuer_geraet($g, $t, $groesse);
}

/** Warteschlange an den Amberwave-Empfänger (Plattenkiste auf dem Fernseher): ein Ausschnitt um den laufenden Titel */
function cast_liste_senden(array $g, array &$s, bool $erzwingen = false): void
{
    $sig = $s['lv'] . '|' . $s['index'] . '|' . ($s['spielt'] ? 1 : 0) . '|' . $s['uri'];
    if (!$erzwingen && $sig === ($s['cast_sig'] ?? '') && microtime(true) - ($s['cast_liste_zeit'] ?? 0) < 30) {
        return;
    }
    try {
        $c = cast_verbindung($g);
        if (!$c->eigener()) {
            return;
        }
        $von = max(0, $s['index'] - 40);
        $teil = array_slice($s['liste'], $von, 90);
        $liste = array_map(static fn($t) => [
            'id' => (int) $t['id'], 'titel' => (string) ($t['titel'] ?? ''), 'laenge_ms' => (int) ($t['laenge_ms'] ?? 0),
            'kuenstler' => array_map(static fn($k) => ['name' => is_array($k) ? (string) ($k['name'] ?? '') : (string) $k], (array) ($t['kuenstler'] ?? [])),
            'album' => ['id' => (int) ($t['album']['id'] ?? 0), 'edition_id' => (int) ($t['album']['edition_id'] ?? 0), 'titel' => (string) ($t['album']['titel'] ?? ''),
                'cover' => cast_cover($g, $t, 600)],
        ], $teil);
        $c->anEmpfaenger(['type' => 'liste', 'liste' => $liste, 'index' => $s['index'] - $von, 'versatz' => $von, 'spielt' => $s['spielt']]);
        $s['cast_sig'] = $sig;
        $s['cast_liste_zeit'] = microtime(true);
    } catch (Throwable $e) {
    }
}

/** Google Cast: Stand des Players (die Meldungen kommen auch von selbst; GET_STATUS liefert die Position) */
function cast_transport(array $g, array &$s): void
{
    try {
        $c = cast_verbindung($g);
        if (!$c->unsere()) {
            // eine andere App (YouTube, Spotify …) hat übernommen, oder der Player wurde am Gerät beendet
            if ($s['uri'] !== '' && microtime(true) - $s['gestartet'] > 5) {
                $s['spielt'] = false;
                $s['uri'] = '';
                $s['next_item'] = null;
                agent_log((int) $g['id'], t('am Gerät beendet oder von einer anderen App übernommen'));
            }
            return;
        }
        $m = $c->mediaStatus();
        foreach ($c->vomEmpfaenger() as $n) {
            // Doppeltipp auf ein Cover am Nest Hub: dorthin springen
            if (($n['type'] ?? '') === 'springen' && isset($s['liste'][(int) ($n['i'] ?? -1)])) {
                agent_log((int) $g['id'], t('am Gerät gewählt: {titel}', ['titel' => $s['liste'][(int) $n['i']]['titel'] ?? '']));
                starten($g, $s, (int) $n['i']);
                return;
            }
            if (($n['type'] ?? '') === 'hallo') {
                $s['cast_sig'] = '';
            }
        }
    } catch (Throwable $e) {
        return;
    }
    $zustand = (string) ($m['playerState'] ?? 'IDLE');
    $uri = (string) ($m['media']['contentId'] ?? '');
    $pos = (float) ($m['currentTime'] ?? 0);
    $s['transport'] = $zustand;
    if ($s['next_uri'] !== '' && $uri === $s['next_uri']) {
        $s['index'] = $s['next_index'];
        $s['uri'] = $s['next_uri'];
        $s['dauer'] = $s['next_info']['dauer'] ?? $s['dauer'];
        $s['bitgenau'] = $s['next_info']['original'] ?? $s['bitgenau'];
        $s['klang_text'] = $s['next_info']['klang'] ?? $s['klang_text'];
        $s['space'] = !empty($s['next_info']['space']);
        $s['space_lief'] = false;
        $s['space_ab'] = 0.0;
        unset($s['space_pos0']);
        $s['next_uri'] = '';
        $s['next_index'] = -1;
        $s['next_item'] = null;
        $s['gestartet'] = microtime(true);
        agent_log((int) $g['id'], '▶ ' . ($s['liste'][$s['index']]['titel'] ?? '') . ' ' . t('(lückenlos)'));
        naechsten_vormerken($g, $s);
    }
    if ($zustand === 'PLAYING' || $zustand === 'BUFFERING') {
        $s['spielt'] = true;
        $s['pos'] = $pos;
        $s['still_seit'] = microtime(true);
    } elseif ($zustand === 'PAUSED') {
        $s['spielt'] = false;
        $s['pos'] = $pos;
    } elseif ($zustand === 'IDLE' && $s['spielt'] && microtime(true) - $s['gestartet'] > 4) {
        $grund = (string) ($m['idleReason'] ?? '');
        if ($grund === 'ERROR') {
            meldung($s, $g['name'] . ': ' . t('Titel ließ sich nicht abspielen'));
        }
        if ($grund === 'FINISHED' || ($grund === '' && $s['pos'] >= $s['dauer'] - 6)) {
            $n = naechster_index($s, $s['index']);
            if ($n >= 0) {
                starten($g, $s, $n);
                return;
            }
            $s['pos'] = 0;
        }
        $s['spielt'] = false;
    }
}

/** Space (5.1 vom Server) hat das Gerät abgelehnt: für dieses Gerät merken – die Option wird ausgegraut, bis man es neu versucht */
function space_abgelehnt(array &$g, array &$s, string $grund): void
{
    hn_space_merken((int) $g['id'], false, $grund);
    $g = hn_geraet((int) $g['id']) ?? $g;
    $s['space'] = false;
    agent_log((int) $g['id'], t('Space abgelehnt ({grund}) – ab jetzt Stereo', ['grund' => $grund]));
    meldung($s, $g['name'] . ': ' . t('Space (5.1) geht an diesem Gerät nicht – spielt in Stereo weiter'));
}

/**
 * Lief der 5.1-Stream wirklich? Manche Geräte nehmen ihn an und hören dann einfach auf (oder fangen nie an).
 * Nach 10 s Wiedergabe gilt Space als bestätigt; endet er vorher ohne zu spielen, in Stereo neu starten.
 */
function space_beobachten(array &$g, array &$s): void
{
    if (empty($s['space']) || $s['index'] < 0) {
        return;
    }
    $seit = microtime(true) - $s['gestartet'];
    $tr = (string) ($s['transport'] ?? '');
    // läuft = die Position ist seit der ersten Beobachtung wirklich vorangekommen (nicht nur „PLAYING“ gemeldet);
    // Startpunkt ist die erste gemeldete Position, nicht die gewünschte – falls der Seek nicht griff
    if (in_array($tr, ['PLAYING', 'BUFFERING'], true) && !isset($s['space_pos0'])) {
        $s['space_pos0'] = (float) $s['pos'];
    }
    if (in_array($tr, ['PLAYING', 'BUFFERING'], true) && $s['pos'] >= ($s['space_pos0'] ?? $s['space_ab'] ?? 0.0) + 1.5) {
        $s['space_lief'] = true;
        if ($seit >= 10 && (hn_json($g['faehig'])['space'] ?? null) !== true) {
            hn_space_merken((int) $g['id'], true);
            $g = hn_geraet((int) $g['id']) ?? $g;
            agent_log((int) $g['id'], t('Space läuft – das Gerät spielt den Mehrkanal-Stream'));
        }
        return;
    }
    if ($s['space_lief'] || in_array($tr, ['PAUSED_PLAYBACK', 'PAUSED'], true)) {
        return;
    }
    $weg = in_array($tr, ['STOPPED', 'NO_MEDIA_PRESENT', 'IDLE'], true) && $seit > 4;
    if ($weg || $seit > 20) {
        space_abgelehnt($g, $s, $weg ? t('Wiedergabe endete sofort nach dem Start') : t('keine Wiedergabe nach 20 s'));
        starten($g, $s, $s['index'], 0.0);
    }
}

/** Zustand für die Fernbedienungen (wie /fern/zustand einer App) */
function zustand_schreiben(array $g, array &$s, bool $erzwingen = false): void
{
    if (hn_ist_cast($g) && $s['uri'] !== '') {
        cast_liste_senden($g, $s, $s['liste_neu']);
    }
    $fid = hn_fern_id((int) $g['id']);
    $z = hn_json($g['zustand']);
    $b = hn_vol_bereich($g);
    $vol = isset($z['vol']) ? max(0.0, min(1.0, ((float) $z['vol'] - $b['min']) / max(0.001, $b['max'] - $b['min']))) : null;
    if ($s['liste_neu']) {
        $s['lv']++;
    }
    $st = [
        'art' => hn_ist_cast($g) ? 'cast' : 'dlna', 'mobil' => false, 'sichtbar' => true, 'aktiviert' => true,
        'spielt' => $s['spielt'], 'pos' => round($s['pos'], 1), 'dauer' => round($s['dauer'], 1),
        'vol' => $vol, 'vol_text' => hn_vol_text($g, isset($z['vol']) ? (float) $z['vol'] : null),
        'zufall' => $s['zufall'], 'wdh' => $s['wdh'], 'index' => $s['index'], 'anzahl' => count($s['liste']), 'versatz' => 0, 'lv' => $s['lv'],
        'track' => $s['liste'][$s['index']] ?? null, 'kontext' => $s['kontext'], 'bitgenau' => $s['bitgenau'], 'user' => $s['user'],
        'geraet' => ['an' => $z['an'] ?? null, 'eingang' => $z['eingang'] ?? null, 'erreichbar' => $z['erreichbar'] ?? true, 'steuerung' => $g['steuerung'],
            'modus' => $z['modus'] ?? null, 'tonmodi' => array_map(static fn($m) => $m[0], hn_tonmodi($g['steuerung'])), 'hn_id' => (int) $g['id']],
        'klang' => ['weg' => hn_einst($g)['klang']['weg'], 'text' => $s['klang_text'], 'space' => hn_space_aussen($g), 'space_jetzt' => !empty($s['space'])],
        'meldung' => $s['meldung'],
        't' => (int) round(microtime(true) * 1000),
    ];
    $vergleich = json_encode(array_diff_key($st, ['t' => 1, 'pos' => 1]));
    $neuWert = $erzwingen || $vergleich !== $s['geschrieben'] || $s['liste_neu'] || microtime(true) - $s['zustand_zeit'] > 10;
    db_tun('INSERT INTO fern_praesenz (geraet_id, user_id, zuletzt_am) VALUES (:g, 0, NOW(3)) ON DUPLICATE KEY UPDATE zuletzt_am = NOW(3)', ['g' => $fid]);
    if ($s['liste_neu']) {
        db_tun('UPDATE fern_praesenz SET liste = :l, liste_ver = liste_ver + 1 WHERE geraet_id = :g', ['l' => json_encode($s['liste'], JSON_UNESCAPED_UNICODE), 'g' => $fid]);
        $s['liste_neu'] = false;
    }
    if ($neuWert) {
        db_tun('UPDATE fern_praesenz SET zustand = :z, zustand_ver = zustand_ver + 1 WHERE geraet_id = :g', ['z' => json_encode($st, JSON_UNESCAPED_UNICODE), 'g' => $fid]);
        $s['geschrieben'] = $vergleich;
        $s['zustand_zeit'] = microtime(true);
    }
}

/* ---------------------------------------------------------------------------------------------------------------- */
while (true) {
    $jetzt = microtime(true);
    cast_verbindungen_pumpen();   // Herzschlag der Cast-Geräte beantworten, Meldungen lesen
    $geraete = [];
    foreach (db_alle('SELECT * FROM heimgeraete WHERE aktiv = 1') as $g) {
        $geraete[(int) $g['id']] = $g;
    }
    // wer wird gerade gesteuert? (Fernbedienungen mit offenem Kanal)
    $gesteuert = [];
    foreach (db_alle('SELECT DISTINCT ziel_id FROM fern_praesenz WHERE ziel_id > :b AND zuletzt_am > NOW(3) - INTERVAL 20 SECOND', ['b' => HN_BASIS]) as $z) {
        $gesteuert[(int) $z['ziel_id'] - HN_BASIS] = true;
    }
    // Befehle
    $befehle = db_alle('SELECT id, ziel_id, von_id, von_user, befehl, daten FROM fern_befehle WHERE ziel_id > :b AND id > :ab AND erstellt_am > NOW(3) - INTERVAL 15 SECOND ORDER BY id LIMIT 50',
        ['b' => HN_BASIS, 'ab' => $ab]);
    foreach ($befehle as $b) {
        $ab = max($ab, (int) $b['id']);
        $hid = (int) $b['ziel_id'] - HN_BASIS;
        if (!isset($geraete[$hid])) {
            continue;
        }
        $S[$hid] ??= sitzung_neu($hid);
        befehl($geraete[$hid], $S[$hid], $b);
        $geraete[$hid] = hn_geraet($hid) ?? $geraete[$hid];
        zustand_schreiben($geraete[$hid], $S[$hid], true);
        $letzteArbeit = microtime(true);
    }
    foreach ($geraete as $hid => $g) {
        $aktiv = isset($gesteuert[$hid]) || (isset($S[$hid]) && ($S[$hid]['spielt'] || $S[$hid]['aktiv_bis'] > $jetzt));
        if (!$aktiv) {
            continue;
        }
        $S[$hid] ??= sitzung_neu($hid);
        $s = &$S[$hid];
        $letzteArbeit = $jetzt;
        if ($jetzt - $s['status_zeit'] >= ($s['spielt'] ? 4 : 2)) {
            $s['status_zeit'] = $jetzt;
            $st = hn_status_auffrischen($hid);
            $g = hn_geraet($hid) ?? $g;
        }
        if ($jetzt - ($s['transport_zeit'] ?? 0) < $takt) {
            unset($s);
            continue;
        }
        $s['transport_zeit'] = $jetzt;
        if ($s['uri'] !== '' || $s['spielt']) {
            transport($g, $s);
            space_beobachten($g, $s);
        }
        // nach dem Ende ausschalten (nur, wenn wir eingeschaltet haben)
        $aus = (int) hn_einst($g)['aus_minuten'];
        if ($aus > 0 && $s['eingeschaltet'] && !$s['spielt'] && $jetzt - $s['still_seit'] > $aus * 60) {
            hn_aus($g);
            agent_log($hid, t('nach {aus} Min. Stille ausgeschaltet', ['aus' => $aus]));
            $s['eingeschaltet'] = false;
            $s['bereit'] = false;
        }
        zustand_schreiben($g, $s);
        unset($s);
    }
    // Geräteliste frisch halten (an/Standby, Lautstärke), auch ohne Sitzung: alle 30 s
    if ($jetzt - $letzteListe > 30) {
        $letzteListe = $jetzt;
        foreach ($geraete as $hid => $g) {
            if (!isset($S[$hid]) || !$S[$hid]['spielt']) {
                hn_status_auffrischen($hid);
            }
        }
    }
    if ($jetzt - $letzteArbeit > $ruhe && !array_filter($S, static fn($s) => $s['spielt'])) {
        break;
    }
    usleep($befehle ? 50000 : (int) min(250000, $takt * 250000));
}
flock($sperre, LOCK_UN);
