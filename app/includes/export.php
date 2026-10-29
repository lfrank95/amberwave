<?php
// WAV-Export: eine Playlist (oder Warteschlange, Album) als EINE lange WAV-Datei – z. B. zum Einspielen über den
// USB-Player eines Mischpults (Behringer X32: WAV, 16 Bit, Stereo, 44,1 oder 48 kHz, spielt zwischen Dateien mit Lücke).
//
// Ablauf (Hintergrund-Job, scripts/export.php):
//   1. Titel auflösen, optional Stille am Anfang/Ende messen (silencedetect)
//   2. Lautheitsangleich je Titel (wie im Player: Album-Gain für Titel, die im Album direkt aufeinander folgen)
//   3. ein ffmpeg-Lauf je Teil: Abtastratenwandlung (SoX), Stereo, Gain, Übergänge (nahtlos, Pause oder Überblendung),
//      am Ende einmal auf 16 Bit mit Dither (TPDF)
//   4. Teile < 4 GB (FAT32 auf dem USB-Stick, RIFF-Grenze), Titelliste mit Startzeiten als Text
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

require_once __DIR__ . '/stream.php';
require_once __DIR__ . '/lautheit.php';

const EXPORT_RATEN = [44100, 48000];
const EXPORT_STILLE_DB = -60;    // darunter gilt als Stille (dBFS)
const EXPORT_STILLE_MIN = 0.3;   // kürzere Stille bleibt

function export_ordner(): string
{
    $o = konfig()['pfade']['cache'] . '/export';
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return $o;
}

/** Name für Dateien auf dem USB-Stick: nur ASCII, keine Sonderzeichen (Mischpulte zeigen sonst Unsinn an) */
function export_dateiname(string $name): string
{
    $name = strtr($name, ['ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue', 'Ä' => 'Ae', 'Ö' => 'Oe', 'Ü' => 'Ue', 'ß' => 'ss']);
    $ascii = function_exists('iconv') ? (string) @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $name) : $name;
    $ascii = preg_replace('/[^A-Za-z0-9 _.-]+/', '', $ascii) ?? '';
    $ascii = trim(preg_replace('/\s+/', ' ', $ascii) ?? '', ' .-');
    return mb_substr($ascii !== '' ? $ascii : 'Amberwave Export', 0, 60);
}

/** Optionen prüfen und mit Standardwerten auffüllen */
function export_optionen(array $o): array
{
    $rate = (int) ($o['rate'] ?? 44100);
    $lh = (string) ($o['lautheit'] ?? 'auto');
    $ziel = (float) ($o['ziel'] ?? konfig()['lautheit']['ziel']);
    return [
        'rate' => in_array($rate, EXPORT_RATEN, true) ? $rate : 44100,
        // auto = Album-Gain für zusammenhängende Albumtitel, sonst Titel-Gain; titel = jeder Titel einzeln; aus = unverändert
        'lautheit' => in_array($lh, ['auto', 'titel', 'aus'], true) ? $lh : 'auto',
        'ziel' => max(-30.0, min(-8.0, $ziel)),
        'ueberblenden' => round(max(0.0, min(12.0, (float) ($o['ueberblenden'] ?? 0))), 1),
        'pause' => round(max(0.0, min(30.0, (float) ($o['pause'] ?? 0))), 1),
        'stille' => !empty($o['stille']),
    ];
}

/** Export anlegen und den Hintergrund-Job anstoßen */
function export_anlegen(array $user, string $name, string $quelle, array $trackIds, array $optionen): array
{
    $k = konfig()['export'];
    $ids = array_slice(array_values(array_filter(array_map('intval', $trackIds))), 0, (int) $k['max_titel']);
    if (!$ids) {
        throw new ApiFehler(t('Keine Titel zum Exportieren.'));
    }
    $offen = (int) db_wert("SELECT COUNT(*) FROM exporte WHERE user_id = :u AND status IN ('wartet','laeuft')", ['u' => $user['id']]);
    if ($offen >= 2) {
        throw new ApiFehler(t('Es laufen schon zwei Exporte von dir – bitte warten, bis einer fertig ist.'));
    }
    // Ältere fertige Exporte dieses Nutzers über der Höchstzahl wegräumen
    $alte = db_alle("SELECT id FROM exporte WHERE user_id = :u AND status NOT IN ('wartet','laeuft') ORDER BY erstellt_am DESC", ['u' => $user['id']]);
    foreach (array_slice($alte, max(0, (int) $k['max_pro_nutzer'] - 1)) as $a) {
        export_loeschen((int) $a['id']);
    }
    $id = db_einfuegen('INSERT INTO exporte (user_id, name, quelle, track_ids, optionen, schritt) VALUES (:u, :n, :q, :t, :o, :s)', [
        'u' => $user['id'], 'n' => mb_substr(trim($name) ?: t('Export'), 0, 200), 'q' => mb_substr($quelle, 0, 200),
        't' => json_encode($ids), 'o' => json_encode(export_optionen($optionen)), 's' => t('wartet auf den Start'),
    ]);
    export_anstossen();
    return export_objekt(db_zeile('SELECT * FROM exporte WHERE id = :id', ['id' => $id]));
}

/** Hintergrund-Job starten, falls er nicht schon läuft (er arbeitet alle wartenden Exporte nacheinander ab) */
function export_anstossen(): void
{
    if (export_laeuft()) {
        return;
    }
    $skript = realpath(__DIR__ . '/../scripts/export.php');
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) $skript) . ' > /dev/null 2>&1 &');
}

function export_sperre_pfad(): string
{
    return export_ordner() . '/.laeuft.lock';
}

function export_laeuft(): bool
{
    $h = @fopen(export_sperre_pfad(), 'c');
    if (!$h) {
        return false;
    }
    $frei = flock($h, LOCK_EX | LOCK_NB);
    if ($frei) {
        flock($h, LOCK_UN);
    }
    fclose($h);
    return !$frei;
}

function export_objekt(array $z): array
{
    $teile = json_decode((string) ($z['teile'] ?? ''), true) ?: [];
    return [
        'id' => (int) $z['id'], 'name' => $z['name'], 'quelle' => $z['quelle'], 'status' => $z['status'], 'schritt' => $z['schritt'],
        'fortschritt' => (float) $z['fortschritt'], 'dauer' => (float) $z['dauer_sek'], 'optionen' => json_decode((string) $z['optionen'], true),
        'titel' => count(json_decode((string) $z['track_ids'], true) ?: []),
        'teile' => array_map(static fn($t, $i) => ['nr' => $i + 1, 'name' => $t['name'], 'groesse' => (int) $t['groesse'], 'dauer' => (float) $t['dauer'],
            'url' => '/api/v1/export/' . (int) $z['id'] . '/datei/' . ($i + 1)], $teile, array_keys($teile)),
        'titelliste_url' => $z['titelliste'] ? '/api/v1/export/' . (int) $z['id'] . '/titelliste' : null,
        'fehler' => $z['fehler'], 'erstellt' => iso($z['erstellt_am']), 'fertig' => iso($z['fertig_am']),
        'loeschen_am' => $z['fertig_am'] ? iso(date('Y-m-d H:i:s', strtotime((string) $z['fertig_am']) + 3600 * (int) konfig()['export']['aufheben_stunden'])) : null,
    ];
}

function export_laden(array $user, int $id): array
{
    $z = db_zeile('SELECT * FROM exporte WHERE id = :id', ['id' => $id]);
    if (!$z || ((int) $z['user_id'] !== (int) $user['id'] && !ist_admin($user))) {
        throw new ApiFehler(t('Export nicht gefunden.'), 404);
    }
    return $z;
}

function export_loeschen(int $id): void
{
    foreach (glob(export_ordner() . '/' . $id . '-*') ?: [] as $f) {
        @unlink($f);
    }
    db_tun("UPDATE exporte SET status = IF(status IN ('wartet','laeuft'), 'abgebrochen', status) WHERE id = :id", ['id' => $id]);
    db_tun("DELETE FROM exporte WHERE id = :id AND status NOT IN ('laeuft')", ['id' => $id]);
}

/** Abgelaufene Exporte entfernen (Zeitplan) */
function export_aufraeumen(): int
{
    $n = 0;
    $h = (int) konfig()['export']['aufheben_stunden'];
    foreach (db_alle("SELECT id FROM exporte WHERE (status IN ('fertig','fehler','abgebrochen') AND COALESCE(fertig_am, erstellt_am) < NOW() - INTERVAL {$h} HOUR)
            OR (status = 'laeuft' AND lebenszeichen < NOW() - INTERVAL 10 MINUTE)") as $z) {
        export_loeschen((int) $z['id']);
        $n++;
    }
    // Verwaiste Dateien (ohne Eintrag)
    foreach (glob(export_ordner() . '/*.wav') ?: [] as $f) {
        if (preg_match('#/(\d+)-#', $f, $m) && !db_wert('SELECT 1 FROM exporte WHERE id = :id', ['id' => (int) $m[1]])) {
            @unlink($f);
        }
    }
    if (!export_laeuft() && db_wert("SELECT 1 FROM exporte WHERE status = 'wartet' LIMIT 1")) {
        export_anstossen();
    }
    return $n;
}

// ---------------------------------------------------------------------------------------------
// Ausführen
// ---------------------------------------------------------------------------------------------

function export_schritt(int $id, string $schritt, ?float $fortschritt = null): void
{
    db_tun('UPDATE exporte SET schritt = :s, lebenszeichen = NOW()' . ($fortschritt !== null ? ', fortschritt = :f' : '') . ' WHERE id = :id',
        ['s' => mb_substr($schritt, 0, 200), 'id' => $id] + ($fortschritt !== null ? ['f' => round(max(0, min(100, $fortschritt)), 1)] : []));
}

function export_abgebrochen(int $id): bool
{
    return db_wert('SELECT status FROM exporte WHERE id = :id', ['id' => $id]) !== 'laeuft';
}

/** Stille am Anfang/Ende eines Titels messen: [Anfang in s, Ende in s] (Ende = Länge, wenn keine Stille am Schluss) */
function export_stille(string $pfad, float $dauer): array
{
    $cmd = escapeshellarg(konfig()['stream']['ffmpeg']) . ' -nostdin -hide_banner -nostats -threads 1 -i ' . escapeshellarg($pfad)
        . ' -map 0:a:0 -af silencedetect=n=' . EXPORT_STILLE_DB . 'dB:d=' . EXPORT_STILLE_MIN . ' -f null - 2>&1';
    $aus = (string) shell_exec($cmd);
    preg_match_all('/silence_start:\s*(-?[\d.]+)/', $aus, $starts);
    preg_match_all('/silence_end:\s*([\d.]+)/', $aus, $enden);
    $s = array_map('floatval', $starts[1]);
    $e = array_map('floatval', $enden[1]);
    $anfang = 0.0;
    $ende = $dauer;
    if ($s && $s[0] <= 0.01) {
        $anfang = $e[0] ?? $dauer;
    }
    $letzter = count($s) - 1;
    if ($letzter >= 0 && $s[$letzter] > $anfang && (!isset($e[$letzter]) || $e[$letzter] >= $dauer - 0.05)) {
        $ende = $s[$letzter];
    }
    // ein Hauch Luft lassen, damit Ein-/Ausschwinger nicht abgeschnitten werden
    $anfang = max(0.0, $anfang - 0.02);
    $ende = min($dauer, $ende + 0.05);
    if ($ende - $anfang < 1.0) {
        return [0.0, $dauer]; // fast nur Stille – lieber unverändert
    }
    return [$anfang, $ende];
}

/** Gain je Titel (dB) wie im Player: Album-Gain für Titel, die mit Vorgänger/Nachfolger im Album direkt zusammenhängen */
function export_gains(array $ids, array $o): array
{
    $n = count($ids);
    $gains = array_fill(0, $n, 0.0);
    $arten = array_fill(0, $n, '');
    if ($o['lautheit'] === 'aus') {
        return [$gains, $arten];
    }
    $lh = lh_fuer_tracks($ids);
    $decke = (float) konfig()['lautheit']['decke'];
    $folgt = static fn($a, $b) => $a && $b && $a['q'] !== 'fehlt' && $b['q'] !== 'fehlt' && $a['e'] === $b['e'] && $b['o'] === $a['o'] + 1;
    foreach ($ids as $i => $id) {
        $l = $lh[$id] ?? null;
        if (!$l || $l['q'] === 'fehlt') {
            $arten[$i] = 'fehlt';
            continue;
        }
        $album = $o['lautheit'] === 'auto' && $l['a'] !== null
            && ($folgt($lh[$ids[$i - 1] ?? 0] ?? null, $l) || $folgt($l, $lh[$ids[$i + 1] ?? 0] ?? null));
        $lufs = $album ? $l['a'] : ($l['t'] ?? $l['a']);
        $tp = $album ? $l['atp'] : ($l['ttp'] ?? $l['atp']);
        if ($lufs === null) {
            $arten[$i] = 'fehlt';
            continue;
        }
        $g = $o['ziel'] - $lufs;
        if ($g > 0) {
            $g = min($g, $tp === null ? 0.0 : max(0.0, $decke - $tp));
        }
        $gains[$i] = round($g, 2);
        $arten[$i] = $album ? 'album' : 'titel';
    }
    return [$gains, $arten];
}

/** Hängen Titel i und i+1 im Album direkt zusammen? (dann immer nahtlos – keine Pause, keine Überblendung, kein Kürzen) */
function export_zusammenhaengend(array $lh, array $ids, int $i): bool
{
    $a = $lh[$ids[$i]] ?? null;
    $b = $lh[$ids[$i + 1] ?? 0] ?? null;
    return $a && $b && $a['e'] === $b['e'] && $b['o'] === $a['o'] + 1;
}

function export_soxr(): bool
{
    static $ok = null;
    if ($ok === null) {
        exec(escapeshellarg(konfig()['stream']['ffmpeg']) . ' -v error -nostdin -f lavfi -i anullsrc=d=0.01 -af aresample=resampler=soxr -f null - 2>/dev/null', $x, $rc);
        $ok = $rc === 0;
    }
    return $ok;
}

function export_zeit(float $s): string
{
    $s = max(0, $s);
    return sprintf('%d:%02d:%02d', (int) floor($s / 3600), (int) floor(fmod($s, 3600) / 60), (int) floor(fmod($s, 60)));
}

/** Einen Export ausführen (läuft im Hintergrund-Job) */
function export_ausfuehren(int $id): void
{
    $z = db_zeile('SELECT * FROM exporte WHERE id = :id', ['id' => $id]);
    if (!$z || $z['status'] !== 'wartet') {
        return;
    }
    // Meldungen und Titelliste in der Sprache des Nutzers, dem der Export gehört
    $sp = (string) db_wert('SELECT sprache FROM users WHERE id = :u', ['u' => $z['user_id']]);
    if ($sp !== '') {
        sprache($sp);
    }
    db_tun("UPDATE exporte SET status = 'laeuft', gestartet_am = NOW(), lebenszeichen = NOW(), fortschritt = 0 WHERE id = :id", ['id' => $id]);
    try {
        export_bauen($id, $z);
    } catch (Throwable $e) {
        foreach (glob(export_ordner() . '/' . $id . '-*') ?: [] as $f) {
            @unlink($f);
        }
        if (!export_abgebrochen($id)) {
            db_tun("UPDATE exporte SET status = 'fehler', fehler = :f, fertig_am = NOW() WHERE id = :id", ['id' => $id, 'f' => mb_substr($e->getMessage(), 0, 2000)]);
        }
    }
}

function export_bauen(int $id, array $z): void
{
    $o = export_optionen(json_decode((string) $z['optionen'], true) ?: []);
    $ids = json_decode((string) $z['track_ids'], true) ?: [];
    $k = konfig()['export'];

    // 1. Titel auflösen (fehlende Dateien überspringen)
    $titel = [];
    $alle = count($ids);
    foreach ($ids as $n => $tid) {
        try {
            [$pfad, $d] = stream_datei((int) $tid);
        } catch (Throwable $e) {
            continue;
        }
        $l = stream_genaue_laenge($pfad, $d);
        $dauer = $l['samples'] / max(1, $l['rate']);
        if ($dauer <= 0) {
            continue;
        }
        $info = db_zeile('SELECT t.titel, a.titel AS album FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id WHERE t.id = :t', ['t' => $tid]) ?: [];
        $credit = db_wert('SELECT credit_id FROM tracks WHERE id = :t', ['t' => $tid]);
        $kuenstler = $credit ? implode(', ', array_map(static fn($x) => $x['name'], credit_liste((int) $credit))) : '';
        $titel[] = ['id' => (int) $tid, 'pfad' => $pfad, 'dauer' => $dauer, 'von' => 0.0, 'bis' => $dauer,
            'name' => trim(($kuenstler !== '' ? $kuenstler . ' – ' : '') . ($info['titel'] ?? ''), ' –'), 'album' => $info['album'] ?? ''];
        if ($n % 10 === 0) {
            export_schritt($id, t('Titel werden vorbereitet …'), 2 * $n / max(1, $alle));
            if (export_abgebrochen($id)) {
                return;
            }
        }
    }
    if (!$titel) {
        throw new RuntimeException(t('Keiner der Titel ist als Datei vorhanden.'));
    }
    $tids = array_column($titel, 'id');
    $lh = lh_fuer_tracks($tids);
    $zusammen = [];
    foreach ($tids as $i => $_) {
        $zusammen[$i] = export_zusammenhaengend($lh, $tids, $i);
    }

    // 2. Stille am Anfang/Ende (nur an Übergängen, die nicht im Album zusammenhängen)
    if ($o['stille']) {
        foreach ($titel as $i => &$t) {
            $vorne = $i === 0 || !$zusammen[$i - 1];
            $hinten = !($zusammen[$i] ?? false);
            if ($vorne || $hinten) {
                [$a, $b] = export_stille($t['pfad'], $t['dauer']);
                if ($vorne) { $t['von'] = $a; }
                if ($hinten) { $t['bis'] = $b; }
            }
            if ($i % 5 === 0) {
                export_schritt($id, t('Stille am Anfang/Ende wird gesucht … ({i} von {n})', ['i' => $i + 1, 'n' => count($titel)]), 2 + 8 * $i / count($titel));
                if (export_abgebrochen($id)) {
                    return;
                }
            }
        }
        unset($t);
    }

    // 3. Gain je Titel
    [$gains, $arten] = export_gains($tids, $o);

    // 4. In Teile < 4 GB aufteilen (an Titelgrenzen)
    // höchstens knapp 4 GB je Datei (FAT32 auf USB-Sticks, RIFF/WAV-Grenze); optional kürzer über EXPORT_TEIL_MAX_MINUTEN
    $max = 4.0e9 / ($o['rate'] * 4);
    if ((int) $k['teil_max_minuten'] > 0) {
        $max = min($max, (int) $k['teil_max_minuten'] * 60);
    }
    $teile = [[]];
    $laenge = 0.0;
    foreach ($titel as $i => $t) {
        $d = $t['bis'] - $t['von'];
        if ($laenge > 0 && $laenge + $d > $max) {
            $teile[] = [];
            $laenge = 0.0;
        }
        $teile[count($teile) - 1][] = $i;
        $laenge += $d;
    }

    // 5. Rendern
    $gesamt = 0.0;
    foreach ($titel as $t) {
        $gesamt += $t['bis'] - $t['von'];
    }
    $fertig = 0.0;
    $ergebnis = [];
    $liste = [];
    $basis = export_dateiname($z['name']);
    foreach ($teile as $nr => $idx) {
        $name = count($teile) > 1 ? sprintf('%s - Teil %d.wav', $basis, $nr + 1) : $basis . '.wav';
        $ziel = export_ordner() . '/' . $id . '-' . ($nr + 1) . '.wav';
        $r = export_teil_rendern($id, $titel, $idx, $gains, $zusammen, $o, $ziel, $fertig, $gesamt, $nr + 1, count($teile));
        if ($r === null) {
            return; // abgebrochen
        }
        $fertig += $r['quelle_sek'];
        $ergebnis[] = ['name' => $name, 'groesse' => (int) filesize($ziel), 'dauer' => $r['dauer']];
        $liste[] = ['name' => $name, 'starts' => $r['starts'], 'dauer' => $r['dauer']];
    }

    // 6. Titelliste
    $dez = static fn($v): string => sprache() === 'en' ? (string) $v : str_replace('.', ',', (string) $v);
    $text = "{$z['name']}\n" . t('Erstellt mit Amberwave am {datum}', ['datum' => date(sprache() === 'en' ? 'd M Y, H:i' : 'd.m.Y H:i')]) . "\n"
        . t('WAV {khz} kHz, 16 Bit, Stereo · Lautstärke: {laut} · Übergänge: {uebergang}{stille}', [
            'khz' => $dez($o['rate'] / 1000),
            'laut' => $o['lautheit'] === 'aus' ? t('unverändert') : ($o['lautheit'] === 'auto' ? t('angeglichen (Alben als Ganzes)') : t('angeglichen je Titel')) . t(', Ziel {ziel} LUFS', ['ziel' => $dez($o['ziel'])]),
            'uebergang' => $o['ueberblenden'] > 0 ? t('Überblendung {s} s', ['s' => $dez($o['ueberblenden'])]) : ($o['pause'] > 0 ? t('Pause {s} s', ['s' => $dez($o['pause'])]) : t('nahtlos')),
            'stille' => $o['stille'] ? t(', Stille an den Rändern gekürzt') : '',
        ]) . "\n";
    if (count($titel) < count($ids)) {
        $text .= tn(count($ids) - count($titel), 'Hinweis: 1 Titel ohne Datei wurde übersprungen.', 'Hinweis: {n} Titel ohne Datei wurden übersprungen.') . "\n";
    }
    foreach ($liste as $teil) {
        $text .= "\n{$teil['name']} (" . export_zeit($teil['dauer']) . ")\n";
        foreach ($teil['starts'] as $s) {
            $g = $gains[$s['i']];
            $text .= sprintf("  %s  %s%s%s\n", export_zeit($s['zeit']), $titel[$s['i']]['name'],
                $titel[$s['i']]['album'] !== '' ? '  [' . $titel[$s['i']]['album'] . ']' : '',
                $o['lautheit'] !== 'aus' ? sprintf('  (%s%s dB)', $g > 0 ? '+' : '', $dez(number_format($g, 1, '.', ''))) : '');
        }
    }
    if (export_abgebrochen($id)) {
        return;
    }
    db_tun("UPDATE exporte SET status = 'fertig', fortschritt = 100, schritt = 'fertig', teile = :t, titelliste = :l, dauer_sek = :d, fertig_am = NOW() WHERE id = :id", [
        'id' => $id, 't' => json_encode($ergebnis, JSON_UNESCAPED_UNICODE), 'l' => $text, 'd' => array_sum(array_column($ergebnis, 'dauer')),
    ]);
}

const EXPORT_STAPEL = 40; // höchstens so viele Dateien gleichzeitig in einem ffmpeg-Lauf (Threads/offene Dateien im Container)

/**
 * Filtergraph für eine Folge von Abschnitten bauen. Abschnitt: ['eingabe' => '-i …', 'kette' => Filter nach dem Eingang
 * (leer = unverändert), 'uebergang' => 'nahtlos'|'pause'|'blende' (zum Vorgänger; beim ersten egal)].
 * Ergebnis endet im Label [aus], nach dem Filter $ende.
 */
function export_graph(array $abschnitte, array $o, string $ende): array
{
    $rate = $o['rate'];
    $eingaben = [];
    $filter = [];
    $bloecke = [[]];
    $stille = 0;
    foreach ($abschnitte as $n => $a) {
        $eingaben[] = $a['eingabe'];
        $filter[] = "[{$n}:a:0]" . ($a['kette'] !== '' ? $a['kette'] : 'anull') . "[t{$n}]";
        if ($n > 0) {
            if ($a['uebergang'] === 'blende') {
                $bloecke[] = [];
            } elseif ($a['uebergang'] === 'pause') {
                $filter[] = sprintf('anullsrc=r=%d:cl=stereo:d=%.3f,aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo[s%d]', $rate, $o['pause'], $rate, $stille);
                $bloecke[count($bloecke) - 1][] = "[s{$stille}]";
                $stille++;
            }
        }
        $bloecke[count($bloecke) - 1][] = "[t{$n}]";
    }
    $namen = [];
    foreach ($bloecke as $b => $teile) {
        if (count($teile) === 1) {
            $namen[] = $teile[0];
        } else {
            $filter[] = implode('', $teile) . 'concat=n=' . count($teile) . ":v=0:a=1[b{$b}]";
            $namen[] = "[b{$b}]";
        }
    }
    $aktuell = $namen[0];
    for ($b = 1; $b < count($namen); $b++) {
        // Überblendung mit gleicher Leistung (Viertelsinus) – bei unkorrelierter Musik kein Loch in der Mitte
        $filter[] = $aktuell . $namen[$b] . sprintf('acrossfade=d=%.2f:c1=qsin:c2=qsin', $o['ueberblenden']) . "[x{$b}]";
        $aktuell = "[x{$b}]";
    }
    $filter[] = $aktuell . $ende . '[aus]';
    return [$eingaben, implode(';', $filter)];
}

/** Einen ffmpeg-Lauf ausführen; $fortschritt(Sekunden) wird etwa sekündlich gerufen. false = abgebrochen. */
function export_ffmpeg(int $id, array $eingaben, string $graph, string $ausgabe, string $ziel, callable $fortschritt): bool
{
    $tmp = $ziel . '.teil';
    $graphDatei = $ziel . '.filter';
    file_put_contents($graphDatei, $graph); // lange Filtergraphen nicht über die Kommandozeile
    $nice = is_executable('/usr/bin/nice') ? '/usr/bin/nice -n 10 ' : '';
    $cmd = $nice . escapeshellarg(konfig()['stream']['ffmpeg']) . ' -v error -nostdin -y -filter_complex_threads 1 ' . implode(' ', $eingaben)
        . ' -filter_complex_script ' . escapeshellarg($graphDatei) . ' -map [aus] ' . $ausgabe
        . ' -map_metadata -1 -flags +bitexact -fflags +bitexact -f wav -progress pipe:1 -nostats ' . escapeshellarg($tmp);
    $proc = proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($proc)) {
        @unlink($graphDatei);
        throw new RuntimeException(t('ffmpeg konnte nicht gestartet werden.'));
    }
    stream_set_blocking($pipes[2], false);
    $fehler = '';
    $letzte = 0.0;
    while (($zeile = fgets($pipes[1])) !== false) {
        $fehler .= (string) stream_get_contents($pipes[2]);
        if (preg_match('/^out_time_us=(\d+)/', $zeile, $m) && microtime(true) - $letzte > 1) {
            $letzte = microtime(true);
            $fortschritt((int) $m[1] / 1e6);
            if (export_abgebrochen($id)) {
                proc_terminate($proc, 15);
                break;
            }
        }
    }
    $fehler .= (string) stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $rc = proc_close($proc);
    @unlink($graphDatei);
    if (export_abgebrochen($id)) {
        @unlink($tmp);
        return false;
    }
    if ($rc !== 0 || !is_file($tmp)) {
        @unlink($tmp);
        $f = trim(mb_substr($fehler, -600));
        throw new RuntimeException($f !== '' ? 'ffmpeg: ' . $f : t('Fehler beim Schreiben der WAV-Datei.'));
    }
    rename($tmp, $ziel);
    return true;
}

/**
 * Einen Teil rendern. Rückgabe: dauer (s), starts [{i, zeit}], quelle_sek (für den Fortschritt) – oder null bei Abbruch.
 * Bis EXPORT_STAPEL Titel in einem Lauf; mehr Titel erst stapelweise in Zwischendateien (32 Bit float, verlustfrei),
 * die ein letzter Lauf mit denselben Übergängen zusammensetzt.
 */
function export_teil_rendern(int $id, array $titel, array $idx, array $gains, array $zusammen, array $o, string $ziel,
    float $fertig, float $gesamt, int $teilNr, int $teileAnzahl): ?array
{
    $rate = $o['rate'];
    $resampler = export_soxr() ? 'aresample=resampler=soxr:precision=28:osr=' . $rate : 'aresample=filter_size=64:phase_shift=10:cutoff=0.97:osr=' . $rate;
    // Plan: Übergang jedes Titels zu seinem Vorgänger und Startzeiten
    $abschnitte = [];
    $starts = [];
    $zeit = 0.0;
    $quelle = 0.0;
    foreach ($idx as $n => $i) {
        $t = $titel[$i];
        $d = $t['bis'] - $t['von'];
        $quelle += $d;
        $uebergang = 'nahtlos';
        if ($n > 0 && !($zusammen[$idx[$n - 1]] ?? false)) {
            if ($o['ueberblenden'] > 0 && $d > $o['ueberblenden'] * 2 + 1) {
                $uebergang = 'blende';
                $zeit -= $o['ueberblenden'];
            } elseif ($o['pause'] > 0) {
                $uebergang = 'pause';
                $zeit += $o['pause'];
            }
        }
        $kette = '';
        if ($t['von'] > 0.001 || $t['bis'] < $t['dauer'] - 0.001) {
            $kette .= sprintf('atrim=start=%.4f:end=%.4f,asetpts=PTS-STARTPTS,', $t['von'], $t['bis']);
        }
        $kette .= $resampler . ",aformat=sample_fmts=fltp:sample_rates={$rate}:channel_layouts=stereo";
        if (abs($gains[$i]) >= 0.01) {
            $kette .= ',' . lh_gain_filter($gains[$i]);
        }
        // je Eingang nur ein Decoder-Thread: sonst startet ffmpeg pro Datei so viele Threads wie CPU-Kerne,
        // und bei vielen Titeln stößt der Container an seine Thread-/Prozessgrenze („Resource temporarily unavailable“)
        $abschnitte[] = ['eingabe' => '-threads 1 -i ' . escapeshellarg($t['pfad']), 'kette' => $kette, 'uebergang' => $uebergang, 'dauer' => $d];
        $starts[] = ['i' => $i, 'zeit' => $zeit];
        $zeit += $d;
    }
    $text = $teileAnzahl > 1 ? t('WAV wird geschrieben (Teil {nr} von {anzahl}) …', ['nr' => $teilNr, 'anzahl' => $teileAnzahl]) : t('WAV wird geschrieben …');
    $melden = static function (float $anteilImTeil) use ($id, $text, $fertig, $quelle, $gesamt): void {
        export_schritt($id, $text, 10 + 90 * ($fertig + $quelle * max(0, min(1, $anteilImTeil))) / max(1, $gesamt));
    };
    $s16 = 'aresample=osf=s16:dither_method=triangular'; // am Ende einmal auf 16 Bit mit TPDF-Dither
    $ausgabe16 = '-c:a pcm_s16le -ar ' . $rate . ' -ac 2';

    if (count($abschnitte) <= EXPORT_STAPEL) {
        [$eingaben, $graph] = export_graph($abschnitte, $o, $s16);
        if (!export_ffmpeg($id, $eingaben, $graph, $ausgabe16, $ziel, static fn($sek) => $melden($sek / max(1, $zeit)))) {
            return null;
        }
    } else {
        // 1. Stapel in Zwischendateien (float, ohne Dither); der erste Übergang jedes Stapels kommt im letzten Lauf
        $stapel = array_chunk($abschnitte, EXPORT_STAPEL);
        $zwischen = [];
        $erledigt = 0.0;
        foreach ($stapel as $s => $teil) {
            $datei = $ziel . '.stapel' . $s . '.wav';
            $laenge = array_sum(array_column($teil, 'dauer'));
            [$eingaben, $graph] = export_graph($teil, $o, 'anull');
            $ok = export_ffmpeg($id, $eingaben, $graph, '-c:a pcm_f32le -rf64 auto -ar ' . $rate . ' -ac 2', $datei,
                static fn($sek) => $melden(0.85 * ($erledigt + min($laenge, $sek)) / max(1, $quelle)));
            if (!$ok) {
                foreach ($zwischen as $z) { @unlink($z['datei']); }
                return null;
            }
            $zwischen[] = ['datei' => $datei, 'uebergang' => $teil[0]['uebergang']];
            $erledigt += $laenge;
        }
        // 2. Stapel zusammensetzen – mit denselben Übergängen wie zwischen den Titeln
        $abschn = array_map(static fn($z) => ['eingabe' => '-threads 1 -i ' . escapeshellarg($z['datei']), 'kette' => '', 'uebergang' => $z['uebergang']], $zwischen);
        [$eingaben, $graph] = export_graph($abschn, $o, $s16);
        try {
            $ok = export_ffmpeg($id, $eingaben, $graph, $ausgabe16, $ziel, static fn($sek) => $melden(0.85 + 0.15 * $sek / max(1, $zeit)));
        } finally {
            foreach ($zwischen as $z) { @unlink($z['datei']); }
        }
        if (!$ok) {
            return null;
        }
    }
    $bytes = max(0, filesize($ziel) - 44);
    return ['dauer' => $bytes / ($rate * 4), 'starts' => array_map(static fn($x) => $x, $starts), 'quelle_sek' => $quelle];
}
