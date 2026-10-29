<?php
// Klanganalyse: akustische Ähnlichkeit je Aufnahme (Song), für Klangradio und als Signal im Radio.
//
// Verfahren:  'einfach3' – eingebaut (Version 3: dazu Rhythmus-Charakter, Gesangstendenz, Harmonie-Verlauf, Dynamik und
//                         Spannungsbogen des ganzen Titels – trennt Score von Dance-Pop), klassische Merkmale, braucht nur
//                         Python 3 + numpy (im Image enthalten); frei von Lizenzfragen. Immer der Rückfall.
//                         Vorgänger 'einfach2' bleibt lesbar, wird aber nicht mehr berechnet.
//             'modell'  – Discogs-EffNet der MTG (Essentia). Wird NICHT mit Amberwave ausgeliefert: der Admin installiert
//                         es per Knopf (Lizenz CC BY-NC-SA 4.0 anzeigen und bestätigen), der Server lädt das Python-Paket
//                         und das Modell direkt beim Hersteller in den Cache. Entfernen → zurück auf 'einfach3'.
// Ablauf:     Hintergrundprozess (scripts/klang.php, vom Zeitplan angestoßen) analysiert offene Aufnahmen stapelweise
//             (niedrige Priorität), danach wird der Index der nächsten Nachbarn neu berechnet (numpy, im Skript klang.py).
// Je Verfahren eigene Vektoren – beim Wechsel bleiben die alten erhalten (Zurückwechseln kostet nichts).
declare(strict_types=1);

require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/genres.php';

const KLANG_K = 100;                // gespeicherte Nachbarn je Aufnahme (werden beim Abruf mit Metadaten neu sortiert)
const KLANG_MODELL_DATEI = 'discogs-effnet-bs64-1.pb';
const KLANG_STIL_DATEI = 'genre_discogs400-discogs-effnet-1.pb';   // Kopf des Modells: 400 Discogs-Stile je Titel
const KLANG_STIL_LABELS = 'genre_discogs400-discogs-effnet-1.json';
const KLANG_SPERRE = '/tmp/klang.lock';
const KLANG_INSTALL_SPERRE = '/tmp/klang_installieren.lock';

function kl_aktiv(): bool
{
    return einstellung('klang_aktiv') !== '0';
}

function kl_ordner(string $teil = ''): string
{
    return konfig()['pfade']['cache'] . '/klang' . ($teil !== '' ? '/' . $teil : '');
}

function kl_skript(): string
{
    return (string) realpath(__DIR__ . '/../klang/klang.py');
}

/** Ist das erweiterte Modell installiert und eingeschaltet? */
function kl_modell_installiert(): bool
{
    return einstellung('klang_modell') === '1' && is_file(kl_ordner('venv/bin/python')) && is_file(kl_ordner('modell/' . KLANG_MODELL_DATEI));
}

/** Ist der Stil-Kopf (Discogs-400) zum installierten Modell da? Dann erkennt der Klang je Titel Genres/Stile. */
function kl_stile_verfuegbar(): bool
{
    return kl_modell_installiert() && is_file(kl_ordner('modell/' . KLANG_STIL_DATEI)) && is_file(kl_ordner('modell/' . KLANG_STIL_LABELS));
}

function kl_verfahren(): string
{
    return kl_modell_installiert() ? 'modell' : 'einfach3';
}

function kl_python(string $verfahren): string
{
    return $verfahren === 'modell' ? kl_ordner('venv/bin/python') : (string) konfig()['klang']['python'];
}

/** Kann das eingebaute Verfahren laufen (Python + numpy)? Ergebnis 10 Minuten gemerkt. */
function kl_bereit(): bool
{
    static $bereit = null;
    if ($bereit !== null) {
        return $bereit;
    }
    $datei = konfig()['pfade']['cache'] . '/tmp/klang_pruefung.json';
    $j = is_file($datei) && filemtime($datei) > time() - 600 ? json_decode((string) file_get_contents($datei), true) : null;
    if (!is_array($j)) {
        $aus = @shell_exec(escapeshellarg(kl_python('einfach2')) . ' ' . escapeshellarg(kl_skript()) . ' pruefen 2>/dev/null');
        $j = json_decode((string) $aus, true);
        $j = is_array($j) ? $j : ['numpy' => false];
        @file_put_contents($datei, json_encode($j));
    }
    return $bereit = !empty($j['numpy']);
}

function kl_offen_bedingung(): string
{
    return "t.aufnahme_id IS NOT NULL AND EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM klang k WHERE k.aufnahme_id = t.aufnahme_id AND k.verfahren = :v
            AND (k.vektor IS NOT NULL OR k.analysiert_am > NOW() - INTERVAL 7 DAY)"
        // Modell mit Stil-Kopf: auch Aufnahmen, die schon einen Vektor haben, aber noch keine Stile (einmalige Nachanalyse)
        . (kl_stile_verfuegbar() ? ' AND (k.vektor IS NULL OR k.stile_am IS NOT NULL)' : '') . ')';
}

function kl_offen(?string $verfahren = null): int
{
    return (int) db_wert('SELECT COUNT(DISTINCT t.aufnahme_id) FROM tracks t WHERE ' . kl_offen_bedingung(), ['v' => $verfahren ?? kl_verfahren()]);
}

/** Gibt es überhaupt offene Aufnahmen? (für den minütlichen Check – bricht beim ersten Treffer ab statt alle zu zählen) */
function kl_etwas_offen(?string $verfahren = null): bool
{
    return (bool) db_wert('SELECT 1 FROM tracks t WHERE ' . kl_offen_bedingung() . ' LIMIT 1', ['v' => $verfahren ?? kl_verfahren()]);
}

function kl_laeuft(): bool
{
    $h = @fopen(konfig()['pfade']['cache'] . KLANG_SPERRE, 'c');
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

/** Index-Stand: für welches Verfahren, wie viele Aufnahmen, wann */
function kl_index_stand(): array
{
    $j = json_decode((string) einstellung('klang_index'), true);
    return is_array($j) ? $j + ['verfahren' => '', 'anzahl' => 0, 'am' => null] : ['verfahren' => '', 'anzahl' => 0, 'am' => null];
}

/** Muss der Index neu gebaut werden? (anderes Verfahren oder neue Vektoren seit dem letzten Bau) */
function kl_index_veraltet(): bool
{
    $s = kl_index_stand();
    $v = kl_verfahren();
    $n = (int) db_wert('SELECT COUNT(*) FROM klang WHERE verfahren = :v AND vektor IS NOT NULL', ['v' => $v]);
    return $n >= 2 && ($s['verfahren'] !== $v || (int) $s['anzahl'] !== $n);
}

/** Hintergrundprozess starten, wenn es etwas zu tun gibt */
function kl_anstossen(): bool
{
    if (!kl_aktiv() || !kl_bereit() || kl_laeuft() || (function_exists('scan_laufend') && scan_laufend())) {
        return false;
    }
    if (!kl_etwas_offen() && !kl_index_veraltet()) {
        return false;
    }
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) realpath(__DIR__ . '/../scripts/klang.php')) . ' > /dev/null 2>&1 &');
    return true;
}

/** Ein Stapel: bis zu 30 offene Aufnahmen analysieren (bis $sekunden). Gibt die Zahl der bearbeiteten zurück. */
function kl_stapel(int $sekunden = 50): int
{
    $verfahren = kl_verfahren();
    $zeilen = db_alle('SELECT t.aufnahme_id, MIN(t.id) AS track_id FROM tracks t WHERE ' . kl_offen_bedingung() . ' GROUP BY t.aufnahme_id ORDER BY t.aufnahme_id LIMIT 30', ['v' => $verfahren]);
    if (!$zeilen) {
        return 0;
    }
    $wurzel = konfig()['pfade']['musik'];
    $liste = [];
    foreach ($zeilen as $z) {
        // beste Datei dieser Aufnahme (höchste Auflösung)
        $d = db_zeile('SELECT d.pfad, d.laenge_ms, t.id AS track_id FROM dateien d JOIN tracks t ON t.id = d.track_id WHERE t.aufnahme_id = :a
            ORDER BY d.bittiefe DESC, d.abtastrate DESC, d.id LIMIT 1', ['a' => $z['aufnahme_id']]);
        if (!$d) continue;
        $liste[] = ['id' => (int) $z['aufnahme_id'], 'track' => (int) $d['track_id'], 'pfad' => $wurzel . '/' . $d['pfad'], 'dauer' => round((int) $d['laenge_ms'] / 1000, 1)];
    }
    $datei = konfig()['pfade']['cache'] . '/tmp/klang_liste_' . getmypid() . '.json';
    file_put_contents($datei, json_encode($liste));
    $befehl = escapeshellarg(kl_python($verfahren)) . ' ' . escapeshellarg(kl_skript()) . ' analyse --verfahren ' . $verfahren
        . ' --liste ' . escapeshellarg($datei) . ' --budget ' . max(5, $sekunden)
        . ($verfahren === 'modell' ? ' --modell ' . escapeshellarg(kl_ordner('modell')) : '');
    $env = 'FFMPEG=' . escapeshellarg((string) konfig()['stream']['ffmpeg']) . ' OMP_NUM_THREADS=2 TF_CPP_MIN_LOG_LEVEL=3 ';
    $aus = (string) @shell_exec($env . $befehl . ' 2>/dev/null');
    @unlink($datei);
    $tracks = array_column($liste, 'track', 'id');
    $n = 0;
    foreach (explode("\n", trim($aus)) as $zeile) {
        $r = json_decode($zeile, true);
        if (!is_array($r) || !isset($r['id'])) continue;
        $id = (int) $r['id'];
        $vektor = isset($r['vektor']) ? base64_decode((string) $r['vektor'], true) : false;
        if ($vektor === false && db_wert('SELECT 1 FROM klang WHERE aufnahme_id = :a AND verfahren = :v AND vektor IS NOT NULL', ['a' => $id, 'v' => $verfahren])) {
            continue; // schon vorhandenen Vektor (Nachanalyse für Stile) nie durch einen Fehler ersetzen
        }
        $mit_stilen = $verfahren === 'modell' && $vektor !== false && kl_stile_verfuegbar();
        db_tun('REPLACE INTO klang (aufnahme_id, verfahren, track_id, vektor, dim, fehler, analysiert_am, stile_am) VALUES (:a, :v, :t, :x, :d, :f, NOW(), ' . ($mit_stilen ? 'NOW()' : 'NULL') . ')', [
            'a' => $id, 'v' => $verfahren, 't' => $tracks[$id] ?? null, 'x' => $vektor !== false ? $vektor : null,
            'd' => $vektor !== false ? (int) ($r['dim'] ?? 0) : 0, 'f' => $vektor !== false ? '' : mb_substr((string) ($r['fehler'] ?? t('Fehler')), 0, 250),
        ]);
        if ($mit_stilen) {
            db_tun('DELETE FROM aufnahme_stile WHERE aufnahme_id = :a', ['a' => $id]);
            foreach (array_slice((array) ($r['stile'] ?? []), 0, 12) as $rang => $st) {
                if (is_array($st) && isset($st[0], $st[1])) {
                    db_tun('INSERT IGNORE INTO aufnahme_stile (aufnahme_id, rang, stil, wert) VALUES (:a, :r, :s, :w)',
                        ['a' => $id, 'r' => $rang, 's' => mb_substr((string) $st[0], 0, 100), 'w' => (float) $st[1]]);
                }
            }
            $GLOBALS['kl_stile_neu'] = true;
        }
        $n++;
    }
    if ($n === 0 && $liste) {
        // Skript lief gar nicht (z. B. Modell defekt): beim Modell auf das eingebaute Verfahren zurückfallen
        if ($verfahren === 'modell') {
            einstellung_setzen('klang_modell', '0');
            einstellung_setzen('klang_meldung', t('Das erweiterte Modell lief nicht – Rückfall auf das eingebaute Verfahren. Bitte neu installieren.'));
        }
    }
    return $n;
}

/** Index der nächsten Nachbarn für das aktive Verfahren neu berechnen (numpy) und speichern */
function kl_index_bauen(): int
{
    $verfahren = kl_verfahren();
    $zeilen = db_alle('SELECT aufnahme_id, vektor, dim FROM klang WHERE verfahren = :v AND vektor IS NOT NULL ORDER BY aufnahme_id', ['v' => $verfahren]);
    $dim = $zeilen ? (int) $zeilen[0]['dim'] : 0;
    $zeilen = array_values(array_filter($zeilen, static fn($z) => (int) $z['dim'] === $dim && strlen((string) $z['vektor']) === $dim * 4));
    $n = count($zeilen);
    if ($n < 2) {
        return 0;
    }
    $basis = konfig()['pfade']['cache'] . '/tmp/klang_index_' . getmypid();
    $f = fopen($basis . '.ein', 'wb');
    foreach ($zeilen as $z) fwrite($f, (string) $z['vektor']);
    fclose($f);
    $befehl = escapeshellarg(kl_python($verfahren)) . ' ' . escapeshellarg(kl_skript()) . " index --verfahren {$verfahren} --ein " . escapeshellarg($basis . '.ein')
        . " --anzahl {$n} --dim {$dim} --k " . KLANG_K . ' --aus ' . escapeshellarg($basis . '.aus');
    $r = json_decode((string) @shell_exec('OMP_NUM_THREADS=2 ' . $befehl . ' 2>/dev/null'), true);
    @unlink($basis . '.ein');
    if (empty($r['ok']) || !is_file($basis . '.aus')) {
        @unlink($basis . '.aus');
        return 0;
    }
    $k = (int) $r['k'];
    $roh = (string) file_get_contents($basis . '.aus');
    @unlink($basis . '.aus');
    $idx = array_values(unpack('l*', substr($roh, 0, $n * $k * 4)));
    $sim = array_values(unpack('g*', substr($roh, $n * $k * 4, $n * $k * 4)));
    $ids = array_map(static fn($z) => (int) $z['aufnahme_id'], $zeilen);
    db()->beginTransaction();
    try {
        db_tun('DELETE FROM klang_nachbarn');
        $werte = [];
        $p = [];
        $flush = static function () use (&$werte, &$p) {
            if ($werte) {
                db_tun('INSERT INTO klang_nachbarn (aufnahme_id, rang, nachbar_id, aehnlich) VALUES ' . implode(',', $werte), $p);
                $werte = [];
                $p = [];
            }
        };
        for ($i = 0; $i < $n; $i++) {
            for ($j = 0; $j < $k; $j++) {
                $q = $i * $k + $j;
                $c = count($werte);
                $werte[] = "(:a{$c}, :r{$c}, :n{$c}, :s{$c})";
                $p["a{$c}"] = $ids[$i]; $p["r{$c}"] = $j; $p["n{$c}"] = $ids[$idx[$q]]; $p["s{$c}"] = round((float) $sim[$q], 4);
                if (count($werte) >= 400) $flush();
            }
        }
        $flush();
        db()->commit();
    } catch (Throwable $e) {
        db()->rollBack();
        throw $e;
    }
    einstellung_setzen('klang_index', json_encode(['verfahren' => $verfahren, 'anzahl' => $n, 'am' => date('c')]));
    return $n;
}

/** Hintergrundlauf (scripts/klang.php): analysieren bis $sekunden, danach ggf. Index bauen */
function kl_lauf(int $sekunden = 280): void
{
    $sperre = @fopen(konfig()['pfade']['cache'] . KLANG_SPERRE, 'c');
    if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
        return;
    }
    try {
        $ende = time() + $sekunden;
        while (time() < $ende - 10) {
            if (function_exists('scan_laufend') && scan_laufend()) break;
            if (kl_stapel(min(50, $ende - time() - 5)) === 0) break;
        }
        // Neue Stile fließen in die Genre-Familien ein – höchstens stündlich (Neuberechnung geht über die ganze Bibliothek)
        if (!empty($GLOBALS['kl_stile_neu']) && time() - (int) einstellung('genre_familien_zeit') >= 3600) {
            $GLOBALS['kl_stile_neu'] = false;
            try { genre_familien_neu_berechnen(); einstellung_setzen('genre_familien_zeit', (string) time()); } catch (Throwable $e) {}
        }
        // Index: wenn fertig analysiert; vorher nur, wenn seit dem letzten Bau mindestens 10 % (oder 200) Aufnahmen dazukamen
        // und der letzte Bau 30 Minuten her ist – sonst würde er bei großen Bibliotheken tagelang alle 30 Minuten komplett neu gebaut
        $s = kl_index_stand();
        $alt = !$s['am'] || strtotime((string) $s['am']) < time() - 1800;
        if (kl_index_veraltet()) {
            $n = (int) db_wert('SELECT COUNT(*) FROM klang WHERE verfahren = :v AND vektor IS NOT NULL', ['v' => kl_verfahren()]);
            $genugNeu = $s['verfahren'] !== kl_verfahren() || $n >= max((int) $s['anzahl'] * 1.1, (int) $s['anzahl'] + 200);
            if (!kl_etwas_offen() || ($alt && $genugNeu)) {
                kl_index_bauen();
            }
        }
    } finally {
        flock($sperre, LOCK_UN);
        fclose($sperre);
    }
}

/** Ähnlichste Aufnahmen zu einer Menge von Aufnahmen: [aufnahme_id => [ähnlichkeit 0..1, quelle_aufnahme]] (inkl. 2. Ebene, gedämpft) */
function kl_aehnliche(array $aufnahmen, int $tiefe = 2): array
{
    $aufnahmen = array_values(array_unique(array_filter(array_map('intval', $aufnahmen))));
    if (!$aufnahmen) {
        return [];
    }
    $erg = [];
    $ebene = array_fill_keys($aufnahmen, [1.0, 0]);
    foreach ($aufnahmen as $a) $ebene[$a] = [1.0, $a];
    for ($t = 0; $t < $tiefe && $ebene; $t++) {
        $quellen = array_keys($ebene);
        $naechste = [];
        foreach (array_chunk($quellen, 300) as $teil) {
            [$in, $p] = db_in($teil, 'kq');
            foreach (db_alle("SELECT aufnahme_id, nachbar_id, aehnlich FROM klang_nachbarn WHERE aufnahme_id IN {$in}", $p) as $z) {
                [$gew, $urquelle] = $ebene[(int) $z['aufnahme_id']];
                $w = max(0.0, (float) $z['aehnlich']) * $gew * ($t === 0 ? 1.0 : 0.85);
                $nid = (int) $z['nachbar_id'];
                if (in_array($nid, $aufnahmen, true)) continue;
                if (!isset($erg[$nid]) || $erg[$nid][0] < $w) {
                    $erg[$nid] = [$w, $urquelle];
                    if ($t + 1 < $tiefe && $w > 0.5) $naechste[$nid] = [$w, $urquelle];
                }
            }
        }
        // zweite Ebene nur von den stärksten Nachbarn aus (sonst wird es beliebig)
        uasort($naechste, static fn($x, $y) => $y[0] <=> $x[0]);
        $ebene = array_slice($naechste, 0, 25, true);
    }
    return $erg;
}

/** Für die Verwaltung */
function kl_stand(): array
{
    $v = kl_verfahren();
    $gesamt = (int) db_wert('SELECT COUNT(DISTINCT t.aufnahme_id) FROM tracks t WHERE t.aufnahme_id IS NOT NULL AND EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id)');
    $inst = json_decode((string) @file_get_contents(kl_ordner('installation.json')), true) ?: [];
    if (($inst['status'] ?? '') === 'laeuft' && !kl_installation_laeuft()) {
        $inst['status'] = 'fehler';
        $inst['schritt'] = t('abgebrochen');
    }
    return [
        'aktiv' => kl_aktiv(), 'bereit' => kl_bereit(), 'verfahren' => $v, 'modell' => kl_modell_installiert(), 'stile' => kl_stile_verfuegbar(),
        'stile_fertig' => (int) db_wert('SELECT COUNT(*) FROM klang WHERE verfahren = \'modell\' AND stile_am IS NOT NULL'),
        'gesamt' => $gesamt, 'analysiert' => (int) db_wert('SELECT COUNT(*) FROM klang WHERE verfahren = :v AND vektor IS NOT NULL', ['v' => $v]),
        'fehler' => (int) db_wert("SELECT COUNT(*) FROM klang WHERE verfahren = :v AND vektor IS NULL", ['v' => $v]),
        'offen' => kl_offen($v), 'laeuft' => kl_laeuft(), 'index' => kl_index_stand(),
        'installation' => $inst, 'meldung' => (string) einstellung('klang_meldung'),
        'modell_url' => (string) konfig()['klang']['modell_url'], 'lizenz_url' => (string) konfig()['klang']['lizenz_url'],
        'paket' => (string) konfig()['klang']['pip_paket'],
    ];
}

// ---------- Erweitertes Modell: Installation per Knopf (lädt direkt beim Hersteller) ----------

function kl_installation_laeuft(): bool
{
    $h = @fopen(konfig()['pfade']['cache'] . KLANG_INSTALL_SPERRE, 'c');
    if (!$h) return false;
    $frei = flock($h, LOCK_EX | LOCK_NB);
    if ($frei) flock($h, LOCK_UN);
    fclose($h);
    return !$frei;
}

function kl_installation_starten(array $admin): void
{
    if (kl_installation_laeuft()) {
        throw new ApiFehler(t('Die Installation läuft bereits.'), 409);
    }
    @mkdir(kl_ordner(), 0775, true);
    einstellung_setzen('klang_lizenz', json_encode(['bestaetigt_am' => date('c'), 'von' => (int) $admin['id'], 'lizenz' => konfig()['klang']['lizenz_url']]));
    file_put_contents(kl_ordner('installation.json'), json_encode(['status' => 'laeuft', 'schritt' => t('startet …'), 'gestartet' => date('c'), 'log' => '']));
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) realpath(__DIR__ . '/../scripts/klang_installieren.php')) . ' > /dev/null 2>&1 &');
}

function kl_modell_entfernen(): void
{
    if (kl_installation_laeuft()) {
        throw new ApiFehler(t('Bitte warten, bis die Installation fertig ist.'), 409);
    }
    einstellung_setzen('klang_modell', '0');
    exec('rm -rf ' . escapeshellarg(kl_ordner('venv')) . ' ' . escapeshellarg(kl_ordner('modell')));
    @unlink(kl_ordner('installation.json'));
    einstellung_setzen('klang_meldung', '');
}

/**
 * Analyse-Ergebnisse verwerfen und neu rechnen lassen (für Updates und Reparaturen). Es werden nur abgeleitete Daten
 * gelöscht – Bibliothek, Tags, Playlists und Hörverlauf bleiben unberührt.
 *   stile = nur die Stil-Erkennung (400 Discogs-Stile je Song) neu; die Klangvektoren bleiben
 *   alles = Klangvektoren, Stile und Ähnlichkeits-Index neu
 */
function kl_neu_aufbauen(string $was): array
{
    if (!in_array($was, ['stile', 'alles'], true)) {
        throw new ApiFehler(t('Unbekannte Auswahl.'));
    }
    $vorher = (int) db_wert('SELECT COUNT(*) FROM klang');
    if ($was === 'alles') {
        db_tun('DELETE FROM aufnahme_stile');
        db_tun('DELETE FROM klang');
        einstellung_setzen('klang_index', '');
    } else {
        db_tun('DELETE FROM aufnahme_stile');
        db_tun('UPDATE klang SET stile_am = NULL');
    }
    if (function_exists('genre_familien_neu_berechnen')) {
        genre_familien_neu_berechnen(); // ohne die alten Stile – kommt nach der Analyse wieder dazu
    }
    einstellung_setzen('klang_meldung', $was === 'alles'
        ? t('Klanganalyse wird komplett neu gerechnet ({n} Einträge verworfen).', ['n' => $vorher])
        : t('Stil-Erkennung wird neu gerechnet.'));
    kl_anstossen();
    return kl_stand();
}

// ---------- Qualität (ehrliche Kennzahlen aus der eigenen Sammlung) ----------

/** Klang + Metadaten gemischt: die besten Nachbarn eines Songs (wie im Klangradio sortiert) */
function kl_mischnachbarn(int $aufnahme, array $songs, int $anzahl = 5): array
{
    $quelle = $songs['a' . $aufnahme] ?? null;
    if (!$quelle) return [];
    $mix = kl_verfahren() === 'modell' ? [0.8, 0.2] : [0.55, 0.45];
    $liste = [];
    foreach (db_alle('SELECT nachbar_id, aehnlich FROM klang_nachbarn WHERE aufnahme_id = :a', ['a' => $aufnahme]) as $z) {
        $s = $songs['a' . $z['nachbar_id']] ?? null;
        if (!$s) continue;
        $kl = max(0.0, ((float) $z['aehnlich'] - 0.5) / 0.5);
        $meta = radio_meta_aehnlich($s, $quelle);
        $liste[] = ['key' => 'a' . $z['nachbar_id'], 'wert' => $mix[0] * $kl + $mix[1] * $meta, 'klang' => round((float) $z['aehnlich'], 2), 'meta' => round($meta, 2)];
    }
    usort($liste, static fn($x, $y) => $y['wert'] <=> $x['wert']);
    return array_slice($liste, 0, $anzahl);
}

/**
 * Kennzahlen: (1) wie oft unter den 5 ähnlichsten Songs derselbe Künstler ist – gegenüber Zufall (der Künstler fließt
 * nicht in die Sortierung ein, ist also ein fairer Prüfstein); (2) wie oft Klang-Vorschläge im Radio übersprungen werden
 * gegenüber den übrigen Radio-Titeln (letzte 90 Tage) – echtes Hörverhalten.
 */
function kl_qualitaet(): array
{
    $kat = radio_katalog();
    $songs = $kat['songs'];
    $aufn = array_map('intval', array_column(db_alle('SELECT DISTINCT aufnahme_id FROM klang_nachbarn'), 'aufnahme_id'));
    shuffle($aufn);
    $aufn = array_slice($aufn, 0, 300);
    $treffer = 0;
    $paare = 0;
    foreach ($aufn as $a) {
        $q = $songs['a' . $a] ?? null;
        if (!$q) continue;
        foreach (kl_mischnachbarn($a, $songs, 5) as $n) {
            $paare++;
            if (array_intersect($q['kuenstler'], $songs[$n['key']]['kuenstler'])) $treffer++;
        }
    }
    // Zufall: gleiche Rechnung mit beliebigen Song-Paaren
    $keys = array_keys($songs);
    $zt = 0;
    $zn = min(3000, max(0, count($keys) * 5));
    for ($i = 0; $i < $zn; $i++) {
        $x = $songs[$keys[array_rand($keys)]];
        $y = $songs[$keys[array_rand($keys)]];
        if ($x['track'] !== $y['track'] && array_intersect($x['kuenstler'], $y['kuenstler'])) $zt++;
    }
    $sk = ['klang' => [0, 0], 'radio' => [0, 0]];
    foreach (db_alle("SELECT quelle, COUNT(*) AS n, SUM(uebersprungen) AS u FROM wiedergaben WHERE gestartet_am > NOW() - INTERVAL 90 DAY
            AND quelle IN ('klangradio', 'radioklang', 'radio') GROUP BY quelle") as $z) {
        $g = $z['quelle'] === 'radio' ? 'radio' : 'klang';
        $sk[$g][0] += (int) $z['n'];
        $sk[$g][1] += (int) $z['u'];
    }
    return [
        'kuenstler' => ['anteil' => $paare ? round($treffer / $paare * 100) : null, 'zufall' => $zn ? round($zt / $zn * 100, 1) : null, 'paare' => $paare],
        'ueberspringen' => [
            'klang' => $sk['klang'][0] >= 20 ? round($sk['klang'][1] / $sk['klang'][0] * 100) : null, 'klang_n' => $sk['klang'][0],
            'radio' => $sk['radio'][0] >= 20 ? round($sk['radio'][1] / $sk['radio'][0] * 100) : null, 'radio_n' => $sk['radio'][0],
        ],
    ];
}

/** Stichprobe zum Reinhören: zufällige Songs mit ihren 5 ähnlichsten (gemischt sortiert) */
function kl_stichprobe(int $anzahl = 8): array
{
    $songs = radio_katalog()['songs'];
    $aufn = array_map('intval', array_column(db_alle('SELECT DISTINCT aufnahme_id FROM klang_nachbarn'), 'aufnahme_id'));
    shuffle($aufn);
    $namen = [];
    $text = static function (array $s) use (&$namen): string {
        $ids = array_diff($s['kuenstler'], array_keys($namen));
        if ($ids) {
            [$in, $p] = db_in(array_values($ids), 'sn');
            foreach (db_alle("SELECT id, name FROM kuenstler WHERE id IN {$in}", $p) as $z) $namen[(int) $z['id']] = $z['name'];
        }
        return implode(', ', array_map(static fn($k) => $namen[$k] ?? '', $s['kuenstler']));
    };
    $aus = [];
    foreach ($aufn as $a) {
        if (count($aus) >= $anzahl) break;
        $q = $songs['a' . $a] ?? null;
        if (!$q) continue;
        $nachbarn = array_map(static fn($n) => ['track' => $songs[$n['key']]['track'], 'titel' => $songs[$n['key']]['titel'], 'kuenstler' => $text($songs[$n['key']]),
            'jahr' => $songs[$n['key']]['jahr'], 'klang' => $n['klang'], 'meta' => $n['meta']], kl_mischnachbarn($a, $songs, 5));
        if (!$nachbarn) continue;
        $aus[] = ['track' => $q['track'], 'titel' => $q['titel'], 'kuenstler' => $text($q), 'jahr' => $q['jahr'], 'nachbarn' => $nachbarn];
    }
    return ['stichprobe' => $aus];
}

