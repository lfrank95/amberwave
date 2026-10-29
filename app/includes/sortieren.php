<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/tags.php';
require_once __DIR__ . '/musicbrainz.php';
require_once __DIR__ . '/erkennung.php';
require_once __DIR__ . '/scanner.php';
require_once __DIR__ . '/bibliothek.php';
require_once __DIR__ . '/aufraeumen.php';
require_once __DIR__ . '/tagziel.php';
require_once __DIR__ . '/tagschreiber.php';
require_once __DIR__ . '/uebernehmen.php';

/**
 * Sortier-Assistent: unsortierte Musik (Eingangsordner SORTIEREN_ORDNER im Musikordner) zu Alben zusammenstellen.
 *
 * 1. Analyse (Hintergrund): jede Datei auflisten, Technik lesen, Fingerabdruck rechnen, bei AcoustID nachschlagen – mit
 *    Release-Gruppen, Releases und Titelpositionen. So steht für jede Datei fest, welche Aufnahme sie ist und auf welchen
 *    Alben/Singles/Samplern diese Aufnahme vorkommt (ohne eine einzige MusicBrainz-Abfrage).
 * 2. Zuordnung (schnell, jederzeit neu): gleiche Aufnahmen → Dubletten (beste Qualität bleibt), schon in der Bibliothek →
 *    markiert, der Rest wird schrittweise auf Releases verteilt: Jedes Kandidaten-Release wird gewertet (wie viele unserer
 *    Titel es enthält, gemessen an seiner Größe; Studioalbum vor EP/Single/Sampler; eigener Künstler vor „Various Artists“;
 *    schon in der Bibliothek vorhandene Alben werden bevorzugt ergänzt), das beste genommen, seine Titel sind vergeben, dann
 *    neu gewertet. Von Hand festgelegte Releases gehen vor.
 * 3. Vorschau: nichts wird verschoben, bevor die Vorschau freigegeben ist.
 * 4. Ausführen (Hintergrund): Dubletten in den Papierkorb, jede Datei an ihren Platz (neue Alben in die Zwischenablage
 *    SORTIEREN_ZWISCHEN, vorhandene Alben direkt in ihren Ordner), Tags mit den MusicBrainz-IDs schreiben, einlesen, mit
 *    dem gewählten Release verknüpfen (Zuordnung Datei → Titel steht fest), Aufräumen freigeben → Künstler/Jahr - Album.
 */

const SRT_SPERRE = '/tmp/sortieren.lock';
const SRT_VA = '89ad4ac3-39f7-470e-963a-56509c546377';
const SRT_REL_MAX = 80;      // Releases je Datei, die wir uns merken (Sampler höchstens SRT_SAMPLER_MAX davon)
const SRT_SAMPLER_MAX = 15;

final class SrtFehler extends RuntimeException
{
}

function srt_konfig(): array
{
    return konfig()['sortieren'];
}

/** Relativer Pfad ohne „..“ und ohne führende/abschließende Schrägstriche (aus der .env) */
function srt_rel(string $r): string
{
    $teile = array_values(array_filter(explode('/', str_replace('\\', '/', $r)), static fn($t) => $t !== '' && $t !== '.' && $t !== '..'));
    return implode('/', $teile);
}

function srt_eingang(): string
{
    return srt_rel((string) srt_konfig()['ordner']) ?: '_unsortiert';
}

function srt_zwischen(): string
{
    return srt_rel((string) srt_konfig()['zwischen']) ?: '_sortiert';
}

// ---------- Zustand und Hintergrund ----------

/** Zustand direkt aus der Datenbank (nicht über den Einstellungs-Cache: Oberfläche und Hintergrund schreiben beide) */
function srt_stand_lesen(): array
{
    $z = json_decode((string) db_wert("SELECT wert_verschluesselt FROM einstellungen WHERE schluessel = 'sortieren_stand'"), true);
    return (is_array($z) ? $z : []) + ['phase' => 'leer', 'schritt' => '', 'seit' => 0, 'fehler' => '', 'scan_id' => 0, 'gelistet' => false];
}

function srt_stand_setzen(array $neu): array
{
    $z = array_merge(srt_stand_lesen(), $neu);
    db_tun("INSERT INTO einstellungen (schluessel, wert_verschluesselt) VALUES ('sortieren_stand', :w) ON DUPLICATE KEY UPDATE wert_verschluesselt = VALUES(wert_verschluesselt)",
        ['w' => (string) json_encode($z, JSON_UNESCAPED_UNICODE)]);
    return $z;
}

function srt_laeuft(): bool
{
    $h = @fopen(konfig()['pfade']['cache'] . SRT_SPERRE, 'c');
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

/** Hintergrund-Lauf starten, wenn es etwas zu tun gibt und keiner läuft */
function srt_anstossen(): void
{
    $p = srt_stand_lesen()['phase'];
    if (!in_array($p, ['analyse', 'ausfuehren', 'warten_scan', 'verknuepfen'], true) || srt_laeuft()) {
        return;
    }
    $skript = realpath(__DIR__ . '/../scripts/sortieren.php');
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) $skript) . ' > /dev/null 2>&1 &');
}

/** Ein Lauf (vom Skript aufgerufen, höchstens $sekunden): die aktuelle Phase so weit wie möglich voranbringen */
function srt_lauf(int $sekunden = 280): void
{
    $h = fopen(konfig()['pfade']['cache'] . SRT_SPERRE, 'c');
    if (!$h || !flock($h, LOCK_EX | LOCK_NB)) {
        return;
    }
    $bis = time() + $sekunden;
    try {
        for ($runde = 0; $runde < 500 && time() < $bis; $runde++) {
            $phase = srt_stand_lesen()['phase'];
            $weiter = match ($phase) {
                'analyse' => srt_analyse_takt($bis),
                'ausfuehren' => srt_ausfuehren_takt($bis),
                'warten_scan' => srt_warten_takt(),
                'verknuepfen' => srt_verknuepfen_takt($bis),
                default => false,
            };
            if (!$weiter) {
                break;
            }
        }
    } catch (ErkFehler $e) {
        // AcoustID-Schlüssel abgelehnt o. Ä.: anhalten, mit Meldung – die Analyse kann danach fortgesetzt werden
        srt_stand_setzen(['phase' => $e->getCode() === 401 ? 'pause' : srt_stand_lesen()['phase'], 'fehler' => $e->getMessage()]);
    } catch (Throwable $e) {
        srt_stand_setzen(['fehler' => mb_substr($e->getMessage(), 0, 500)]);
        error_log('Sortieren: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
}

// ---------- 1. Analyse ----------

/** Analyse starten (oder fortsetzen). Erledigte Einträge eines früheren Durchgangs werden vergessen. */
function srt_analyse_starten(): array
{
    if (!erk_bereit()) {
        throw new SrtFehler(t('Für die Erkennung am Klang wird ein AcoustID-Schlüssel gebraucht (Einstellungen → Dienste, kostenlos bei acoustid.org).'), 422);
    }
    $p = srt_stand_lesen()['phase'];
    if (in_array($p, ['ausfuehren', 'warten_scan', 'verknuepfen'], true)) {
        throw new SrtFehler(t('Gerade wird einsortiert – bitte warten, bis das fertig ist.'), 409);
    }
    $abs = af_wurzel() . '/' . srt_eingang();
    if (!is_dir($abs)) {
        if (!af_ordner_anlegen($abs)) {
            throw new SrtFehler(t('Der Eingangsordner „{ordner}“ fehlt im Musikordner und konnte nicht angelegt werden.', ['ordner' => srt_eingang()]), 422);
        }
    }
    db_tun("DELETE FROM sortier_dateien WHERE erledigt <> ''");
    db_tun("DELETE FROM sortier_alben WHERE status IN ('fertig', 'fehler', 'verschoben')");
    srt_stand_setzen(['phase' => 'analyse', 'schritt' => t('Dateien auflisten'), 'seit' => time(), 'fehler' => '', 'gelistet' => false]);
    srt_anstossen();
    return srt_stand();
}

/** Ein Schritt der Analyse; true = es geht in dieser Runde weiter */
function srt_analyse_takt(int $bis): bool
{
    $z = srt_stand_lesen();
    if (!$z['gelistet']) {
        srt_stand_setzen(['schritt' => t('Dateien auflisten')]);
        srt_auflisten();
        srt_stand_setzen(['gelistet' => true]);
        return true;
    }
    // Technik und Tags lesen
    $offen = db_alle("SELECT id, pfad FROM sortier_dateien WHERE format = '' AND status = 'neu' ORDER BY id LIMIT 50");
    if ($offen) {
        srt_stand_setzen(['schritt' => t('Dateien lesen')]);
        foreach ($offen as $d) {
            srt_technik_lesen((int) $d['id'], (string) $d['pfad']);
            if (time() >= $bis) {
                return false;
            }
        }
        return true;
    }
    // Fingerabdrücke (parallel)
    $offen = db_alle("SELECT id, pfad FROM sortier_dateien WHERE status = 'neu' ORDER BY id LIMIT 24");
    if ($offen) {
        srt_stand_setzen(['schritt' => t('Fingerabdrücke rechnen')]);
        $auftraege = [];
        foreach ($offen as $d) {
            $auftraege[(int) $d['id']] = af_wurzel() . '/' . $d['pfad'];
        }
        erk_fp_rechnen($auftraege, static function (int $id, ?string $fp, string $fehler): void {
            db_tun('UPDATE sortier_dateien SET fp = :f, status = :s, fehler = :e WHERE id = :id',
                ['f' => $fp, 's' => $fp !== null ? 'fp' : 'fehler', 'e' => mb_substr($fehler, 0, 300), 'id' => $id]);
        });
        return time() < $bis;
    }
    // AcoustID (höchstens 3 Anfragen je Sekunde)
    $offen = db_alle("SELECT id, fp, dauer_ms FROM sortier_dateien WHERE status = 'fp' ORDER BY id LIMIT 30");
    if ($offen) {
        srt_stand_setzen(['schritt' => t('Bei AcoustID nachschlagen')]);
        foreach ($offen as $d) {
            srt_nachschlagen((int) $d['id'], (string) $d['fp'], (int) $d['dauer_ms']);
            if (time() >= $bis) {
                return false;
            }
        }
        return true;
    }
    srt_stand_setzen(['schritt' => t('Alben zusammenstellen')]);
    srt_zuordnen();
    srt_stand_setzen(['phase' => 'bereit', 'schritt' => '', 'fehler' => '']);
    return false;
}

/** Eingangsordner durchgehen: neue Dateien eintragen, geänderte neu analysieren, verschwundene vergessen */
function srt_auflisten(): void
{
    $wurzel = af_wurzel();
    $eingang = srt_eingang();
    $typen = array_flip(konfig()['scan']['dateitypen']);
    $ignor = konfig()['scan']['ignorieren'];
    $gesehen = [];
    $bekannt = [];
    foreach (db_alle('SELECT id, pfad_hash, groesse, mtime FROM sortier_dateien') as $z) {
        $bekannt[$z['pfad_hash']] = $z;
    }
    $stapel = [$eingang];
    while ($stapel) {
        $rel = array_pop($stapel);
        $eintraege = @scandir($wurzel . '/' . $rel);
        if ($eintraege === false) {
            continue;
        }
        foreach ($eintraege as $e) {
            if ($e === '.' || $e === '..' || $e[0] === '.') {
                continue;
            }
            $r = $rel . '/' . $e;
            foreach ($ignor as $i) {
                if ($i !== '' && str_contains($r, $i)) {
                    continue 2;
                }
            }
            $p = $wurzel . '/' . $r;
            if (is_dir($p)) {
                $stapel[] = $r;
                continue;
            }
            if (!isset($typen[strtolower(pathinfo($e, PATHINFO_EXTENSION))]) || !is_readable($p) || !($st = @stat($p))) {
                continue;
            }
            $hash = hash('sha256', $r);
            $gesehen[$hash] = true;
            $alt = $bekannt[$hash] ?? null;
            if (!$alt) {
                db_tun('INSERT INTO sortier_dateien (pfad_hash, pfad, groesse, mtime) VALUES (:h, :p, :g, :m)',
                    ['h' => $hash, 'p' => mb_substr($r, 0, 2000), 'g' => (int) $st['size'], 'm' => (int) $st['mtime']]);
            } elseif ((int) $alt['groesse'] !== (int) $st['size'] || (int) $alt['mtime'] !== (int) $st['mtime']) {
                db_tun("UPDATE sortier_dateien SET groesse = :g, mtime = :m, format = '', status = 'neu', fp = NULL, treffer = NULL, manuell = 0,
                    aufnahme_mbid = NULL, release_fest = NULL, fehler = '' WHERE id = :id", ['g' => (int) $st['size'], 'm' => (int) $st['mtime'], 'id' => $alt['id']]);
            }
        }
    }
    foreach (db_alle("SELECT id, pfad_hash FROM sortier_dateien WHERE erledigt = ''") as $d) {
        if (!isset($gesehen[$d['pfad_hash']])) {
            db_tun('DELETE FROM sortier_dateien WHERE id = :id', ['id' => $d['id']]);
        }
    }
}

/** Qualität einer Datei als Text und Rang (höher = besser; verlustfrei immer vor verlustbehaftet) */
function srt_qualitaet(string $format, string $codec, int $bittiefe, int $abtastrate, int $bitrate): array
{
    $format = strtolower($format);
    $codec = strtolower($codec);
    $verlustfrei = in_array($format, ['flac', 'wav', 'aif', 'aiff', 'ape', 'wv', 'dsf', 'dff', 'alac'], true)
        || in_array($codec, ['flac', 'alac', 'ape', 'wavpack', 'tta', 'mlp', 'truehd'], true) || str_starts_with($codec, 'pcm_') || str_starts_with($codec, 'dsd_');
    if ($verlustfrei) {
        $bits = $bittiefe ?: 16;
        $khz = $abtastrate ? round($abtastrate / 1000, 1) : 44.1;
        $name = $codec === 'alac' ? 'ALAC' : strtoupper($format === 'aif' ? 'aiff' : $format);
        return [$name . ' ' . $bits . '/' . rtrim(rtrim(zahl_fmt((float) $khz, 1), '0'), ',.'), 100000 + $bits * 1000 + (int) ($abtastrate / 100)];
    }
    $kbps = (int) round($bitrate / 1000);
    $faktor = match (true) {
        in_array($codec, ['aac', 'opus', 'vorbis'], true) => 1.3,
        str_starts_with($codec, 'wma') => 0.9,
        default => 1.0,
    };
    $name = strtoupper($codec === 'vorbis' ? 'ogg' : ($codec !== '' ? $codec : $format));
    return [$name . ($kbps ? ' ' . $kbps . ' kbit/s' : ''), (int) round($kbps * $faktor * 10)];
}

function srt_technik_lesen(int $id, string $rel): void
{
    try {
        $info = datei_lesen(af_wurzel() . '/' . $rel);
    } catch (Throwable $e) {
        db_tun("UPDATE sortier_dateien SET format = :f, status = 'fehler', fehler = :e WHERE id = :id",
            ['f' => strtolower(pathinfo($rel, PATHINFO_EXTENSION)) ?: '?', 'e' => mb_substr(t('Nicht lesbar: {grund}', ['grund' => $e->getMessage()]), 0, 300), 'id' => $id]);
        return;
    }
    $t = $info['technik'];
    $tags = $info['tags'];
    [$q, $rang] = srt_qualitaet((string) ($t['format'] ?? ''), (string) ($t['codec'] ?? ''), (int) ($t['bittiefe'] ?? 0), (int) ($t['abtastrate'] ?? 0), (int) ($t['bitrate'] ?? 0));
    db_tun('UPDATE sortier_dateien SET format = :f, dauer_ms = :d, qualitaet = :q, rang = :r, tag_kuenstler = :tk, tag_titel = :tt, tag_album = :ta WHERE id = :id', [
        'f' => mb_substr((string) ($t['format'] ?? '') ?: strtolower(pathinfo($rel, PATHINFO_EXTENSION)), 0, 10), 'd' => (int) ($t['laenge_ms'] ?? 0),
        'q' => $q, 'r' => $rang, 'tk' => mb_substr(tag1($tags, 'ARTIST', 'ALBUMARTIST'), 0, 500), 'tt' => mb_substr(tag1($tags, 'TITLE'), 0, 500),
        'ta' => mb_substr(tag1($tags, 'ALBUM'), 0, 500), 'id' => $id,
    ]);
}

/** Künstlername aus einer AcoustID-Künstlerliste ([{id, name, joinphrase}]) */
function srt_kuenstler_text(array $artists): string
{
    $s = '';
    $n = count($artists);
    foreach (array_values($artists) as $i => $a) {
        $s .= (string) ($a['name'] ?? '') . (isset($a['joinphrase']) ? (string) $a['joinphrase'] : ($i < $n - 1 ? ', ' : ''));
    }
    return trim($s);
}

function srt_datum(mixed $d): string
{
    if (is_array($d)) {
        $s = sprintf('%04d-%02d-%02d', (int) ($d['year'] ?? 0), (int) ($d['month'] ?? 0), (int) ($d['day'] ?? 0));
        $s = (string) preg_replace('/(-00)+$/', '', $s);
        return $s === '0000' ? '' : $s;
    }
    return mb_substr((string) $d, 0, 10);
}

/**
 * Release-Angaben merken (einmal je Release, für Wertung und Anzeige) und die Fundstelle der Aufnahme darauf liefern:
 * [release, disc, pos, release-track-id].
 */
function srt_release_merken(array $rel, ?array $rg, string $recId): ?array
{
    $id = strtolower((string) ($rel['id'] ?? ''));
    if (!ist_uuid($id)) {
        return null;
    }
    $rgArtists = $rg['artists'] ?? [];
    $artists = $rel['artists'] ?? $rgArtists;
    $va = false;
    foreach ($artists as $a) {
        if (strtolower((string) ($a['id'] ?? '')) === SRT_VA || strcasecmp((string) ($a['name'] ?? ''), 'Various Artists') === 0) {
            $va = true;
        }
    }
    $med = $rel['mediums'] ?? [];
    $disc = 0;
    $pos = 0;
    $tid = '';
    foreach ($med as $m) {
        foreach ($m['tracks'] ?? [] as $t) {
            if ($disc === 0) {
                $disc = (int) ($m['position'] ?? 1);
                $pos = (int) ($t['position'] ?? 0);
                $tid = ist_uuid(strtolower((string) ($t['id'] ?? ''))) ? strtolower((string) $t['id']) : '';
            }
        }
    }
    static $gemerkt = [];
    if (!isset($gemerkt[$id])) {
        $gemerkt[$id] = true;
        $sek = array_map('strval', $rg['secondarytypes'] ?? []);
        db_tun('INSERT INTO sortier_releases (mbid, rg_mbid, titel, kuenstler, va, typ, sekundaer, datum, land, format, tracks, medien)
                VALUES (:m, :rg, :t, :k, :va, :typ, :sek, :d, :l, :f, :n, :med)
                ON DUPLICATE KEY UPDATE rg_mbid = COALESCE(VALUES(rg_mbid), rg_mbid), titel = VALUES(titel), kuenstler = IF(VALUES(kuenstler) <> \'\', VALUES(kuenstler), kuenstler),
                    va = VALUES(va), typ = IF(VALUES(typ) <> \'\', VALUES(typ), typ), sekundaer = IF(VALUES(typ) <> \'\', VALUES(sekundaer), sekundaer),
                    datum = VALUES(datum), land = VALUES(land), format = VALUES(format), tracks = GREATEST(tracks, VALUES(tracks)), medien = GREATEST(medien, VALUES(medien))', [
            'm' => $id, 'rg' => ist_uuid(strtolower((string) ($rg['id'] ?? ''))) ? strtolower((string) $rg['id']) : null,
            't' => mb_substr((string) ($rel['title'] ?? $rg['title'] ?? ''), 0, 500), 'k' => mb_substr(srt_kuenstler_text($artists), 0, 500), 'va' => $va ? 1 : 0,
            'typ' => mb_substr((string) ($rg['type'] ?? ''), 0, 30), 'sek' => mb_substr(implode(',', $sek), 0, 200), 'd' => srt_datum($rel['date'] ?? ''),
            'l' => mb_substr((string) ($rel['country'] ?? ''), 0, 10), 'f' => mb_substr((string) ($med[0]['format'] ?? ''), 0, 60),
            'n' => (int) ($rel['track_count'] ?? array_sum(array_map(static fn($m) => (int) ($m['track_count'] ?? 0), $med))), 'med' => (int) ($rel['medium_count'] ?? count($med)),
        ]);
    }
    return [$id, $disc, $pos, $tid, $va, in_array('Compilation', $rg['secondarytypes'] ?? [], true), srt_datum($rel['date'] ?? '')];
}

/**
 * AcoustID-Antwort einer Datei auswerten: beste Aufnahme (Trefferwert, bei Gleichstand die passende Länge), weitere
 * gleichwertige Aufnahmen (MusicBrainz führt dasselbe Stück oft mehrfach) und alle Releases, auf denen sie vorkommen.
 */
function srt_nachschlagen(int $id, string $fp, int $dauerMs): void
{
    $j = erk_acoustid_anfrage($fp, (int) round($dauerMs / 1000), 'recordings releasegroups releases tracks');
    $recs = [];
    foreach ($j['results'] ?? [] as $r) {
        $score = (float) ($r['score'] ?? 0);
        foreach ($r['recordings'] ?? [] as $rec) {
            $rid = strtolower((string) ($rec['id'] ?? ''));
            if (!ist_uuid($rid)) {
                continue;
            }
            $fund = [];
            // Form mit Release-Gruppen (meta releasegroups) und ohne (nur releases)
            foreach ($rec['releasegroups'] ?? [] as $rg) {
                foreach ($rg['releases'] ?? [] as $rel) {
                    if ($f = srt_release_merken($rel, $rg, $rid)) {
                        $fund[] = $f;
                    }
                }
            }
            foreach ($rec['releases'] ?? [] as $rel) {
                if ($f = srt_release_merken($rel, null, $rid)) {
                    $fund[] = $f;
                }
            }
            if (isset($recs[$rid])) {
                $recs[$rid]['s'] = max($recs[$rid]['s'], $score);
                $recs[$rid]['fund'] = array_merge($recs[$rid]['fund'], $fund);
                continue;
            }
            $recs[$rid] = ['id' => $rid, 's' => $score, 'titel' => (string) ($rec['title'] ?? ''), 'kuenstler' => srt_kuenstler_text($rec['artists'] ?? []),
                'dauer' => isset($rec['duration']) ? (int) round((float) $rec['duration'] * 1000) : null, 'fund' => $fund];
        }
    }
    srt_treffer_speichern($id, array_values($recs), $dauerMs, false);
}

/**
 * Treffer einer Datei speichern: Aufnahme wählen, plausible weitere Aufnahmen und ihre Releases (gekappt) merken.
 * $recs: [[id, s (0–1), titel, kuenstler, dauer (ms|null), fund => [[release, disc, pos, tid, va, sampler, datum]]]]
 */
function srt_treffer_speichern(int $id, array $recs, int $dauerMs, bool $manuell): void
{
    $schwelle = srt_konfig()['schwelle'] / 100;
    usort($recs, static fn($a, $b) => $b['s'] <=> $a['s']);
    $passtLaenge = static fn(array $r): bool => $r['dauer'] === null || $dauerMs <= 0 || abs($r['dauer'] - $dauerMs) <= max(7000, $dauerMs * 0.04);
    $top = null;
    foreach ($recs as $r) {
        if ($r['s'] >= ($recs[0]['s'] ?? 0) - 0.1 && $passtLaenge($r)) {
            $top = $r; // bester Treffer mit passender Länge (sonst der beste überhaupt)
            break;
        }
    }
    $top ??= $recs[0] ?? null;
    if (!$top || $top['s'] < $schwelle) {
        db_tun("UPDATE sortier_dateien SET status = 'unerkannt', treffer = NULL, aufnahme_mbid = NULL, aufnahme_titel = '', aufnahme_kuenstler = '', sicherheit = :s, manuell = 0 WHERE id = :id",
            ['s' => $top ? (int) round($top['s'] * 100) : 0, 'id' => $id]);
        return;
    }
    $plausibel = array_values(array_filter($recs, static fn($r) => $r['id'] === $top['id'] || ($r['s'] >= $top['s'] - 0.05 && $passtLaenge($r))));
    // Sicherheit: Trefferwert; uneinig über den Titel (zwei verschiedene Stücke gleich gut) → deutlich weniger
    $titel = array_unique(array_filter(array_map(static fn($r) => name_norm((string) $r['titel']), $plausibel)));
    $sicher = (int) round($top['s'] * 100) - (count($titel) > 1 ? 25 : 0) - ($passtLaenge($top) ? 0 : 20);
    // Releases: je Release einmal, Nicht-Sampler zuerst, dann nach Datum; gekappt
    $rels = [];
    foreach ($plausibel as $r) {
        foreach ($r['fund'] as $f) {
            if (!isset($rels[$f[0]])) {
                $rels[$f[0]] = $f;
            }
        }
    }
    $rels = array_values($rels);
    usort($rels, static fn($a, $b) => [(int) ($a[4] || $a[5]), $a[6] === '' ? '9999' : $a[6]] <=> [(int) ($b[4] || $b[5]), $b[6] === '' ? '9999' : $b[6]]);
    $aus = [];
    $sampler = 0;
    foreach ($rels as $f) {
        if ($f[4] || $f[5]) {
            if (++$sampler > SRT_SAMPLER_MAX) {
                continue;
            }
        }
        $aus[] = [$f[0], $f[1], $f[2], $f[3]];
        if (count($aus) >= SRT_REL_MAX) {
            break;
        }
    }
    $treffer = ['recs' => array_map(static fn($r) => $r['id'], $plausibel), 'rels' => $aus];
    db_tun("UPDATE sortier_dateien SET status = 'erkannt', treffer = :t, aufnahme_mbid = :a, aufnahme_titel = :ti, aufnahme_kuenstler = :k, sicherheit = :s, manuell = :m WHERE id = :id", [
        't' => json_encode($treffer), 'a' => $top['id'], 'ti' => mb_substr((string) $top['titel'], 0, 500), 'k' => mb_substr((string) $top['kuenstler'], 0, 500),
        's' => max(1, min(100, $manuell ? 100 : $sicher)), 'm' => $manuell ? 1 : 0, 'id' => $id,
    ]);
}

// ---------- 2. Zuordnung ----------

/** Wertungsfaktor nach Art des Releases: Studioalbum vor EP vor Single, Sampler/Live/Remix-Sammlungen deutlich dahinter */
function srt_typ_faktor(array $r): float
{
    $f = match (strtolower((string) $r['typ'])) {
        'album', '' => 1.0,
        'ep' => 0.9,
        'single' => 0.6,
        default => 0.5, // Broadcast, Other
    };
    $sek = array_map('strtolower', array_filter(explode(',', (string) $r['sekundaer'])));
    foreach ($sek as $s) {
        $f *= match ($s) {
            'compilation' => 0.55,
            'dj-mix', 'mixtape/street' => 0.4,
            'remix' => 0.7,
            'live', 'soundtrack' => 0.85,
            default => 0.9,
        };
    }
    if ((int) $r['va'] === 1) {
        $f *= 0.6;
    }
    return $f;
}

/** Wertung eines Releases, das $k unserer Titel enthält */
function srt_wertung(array $r, int $k, bool $inBibliothek): float
{
    $n = max($k, (int) $r['tracks']);
    return $k * srt_typ_faktor($r) * (0.6 + 0.4 * ($k / $n)) * ($inBibliothek ? 1.5 : 1.0);
}

/** Kann der Assistent in dieses Format Tags schreiben (WAV/AIFF werden vorher nach FLAC gewandelt, wenn eingeschaltet)? */
function srt_beschreibbar(string $pfad): bool
{
    $ext = strtolower(pathinfo($pfad, PATHINFO_EXTENSION));
    return in_array($ext, ['flac', 'mp3', 'm4a', 'mp4', 'aac'], true)
        || (in_array($ext, ['wav', 'aif', 'aiff'], true) && einstellung('download_wav_flac') !== '0');
}

/** Effektive Aktion einer Datei (von Hand gewählt oder Vorgabe je Rolle) */
function srt_aktion(array $d): string
{
    if ($d['aktion'] !== '') {
        return $d['aktion'];
    }
    return match ($d['rolle']) {
        'album' => 'uebernehmen',
        'dublette' => srt_konfig()['dubletten'],
        default => 'liegen',
    };
}

/**
 * Alles neu zuordnen (schnell, nur Datenbank): Dubletten, Bibliothek, Alben. Von Hand festgelegte Releases und
 * abgewählte Alben bleiben erhalten.
 */
function srt_zuordnen(): void
{
    $dateien = [];
    foreach (db_alle("SELECT id, status, treffer, aufnahme_mbid, dauer_ms, rang, groesse, release_fest, sicherheit FROM sortier_dateien WHERE erledigt = ''") as $d) {
        $d['t'] = $d['treffer'] !== null ? (json_decode((string) $d['treffer'], true) ?: ['recs' => [], 'rels' => []]) : null;
        unset($d['treffer']);
        $dateien[(int) $d['id']] = $d;
    }
    $rolle = [];
    $dublVon = [];
    $bibInfo = [];
    $erkannt = [];
    foreach ($dateien as $id => $d) {
        if ($d['status'] !== 'erkannt' || !$d['t']) {
            $rolle[$id] = $d['status'] === 'fehler' ? 'fehler' : 'unerkannt';
            continue;
        }
        $erkannt[$id] = $d;
    }
    // Dubletten: Dateien, deren Aufnahmen sich überschneiden (bei gleicher Länge ±5 s) – Union-Find
    $eltern = [];
    $finde = static function (int $x) use (&$eltern, &$finde): int {
        while (($eltern[$x] ?? $x) !== $x) {
            $x = $eltern[$x];
        }
        return $x;
    };
    $nachRec = [];
    foreach ($erkannt as $id => $d) {
        foreach ($d['t']['recs'] as $rec) {
            $nachRec[$rec][] = $id;
        }
    }
    foreach ($nachRec as $ids) {
        for ($i = 1; $i < count($ids); $i++) {
            $a = $erkannt[$ids[0]];
            $b = $erkannt[$ids[$i]];
            $topGleich = $a['aufnahme_mbid'] === $b['aufnahme_mbid'];
            if ($topGleich || abs((int) $a['dauer_ms'] - (int) $b['dauer_ms']) <= 5000) {
                $ra = $finde($ids[0]);
                $rb = $finde($ids[$i]);
                if ($ra !== $rb) {
                    $eltern[$rb] = $ra;
                }
            }
        }
    }
    $gruppen = [];
    foreach ($erkannt as $id => $d) {
        $gruppen[$finde($id)][] = $id;
    }
    $behalten = [];
    foreach ($gruppen as $ids) {
        // Welche Fassung bleibt? 1. vollständig (nicht mehr als 3 s kürzer als die längste – abgeschnittene Dateien verlieren
        // immer, egal in welchem Format), 2. besseres Format/Bitrate, 3. länger, 4. größer
        $laengste = max(array_map(static fn($i) => (int) $erkannt[$i]['dauer_ms'], $ids));
        $voll = static fn(int $i): int => (int) $erkannt[$i]['dauer_ms'] >= $laengste - 3000 ? 1 : 0;
        usort($ids, static fn($a, $b) => [$voll($b), (int) $erkannt[$b]['rang'], (int) $erkannt[$b]['dauer_ms'], (int) $erkannt[$b]['groesse'], $a]
            <=> [$voll($a), (int) $erkannt[$a]['rang'], (int) $erkannt[$a]['dauer_ms'], (int) $erkannt[$a]['groesse'], $b]);
        $behalten[$ids[0]] = true;
        foreach (array_slice($ids, 1) as $x) {
            $rolle[$x] = 'dublette';
            $dublVon[$x] = $ids[0];
        }
    }
    // Schon in der Bibliothek (Aufnahme hat dort eine Datei)?
    $alleRecs = [];
    foreach ($behalten as $id => $_) {
        foreach ($erkannt[$id]['t']['recs'] as $rec) {
            $alleRecs[$rec] = true;
        }
    }
    $inBib = [];
    foreach (array_chunk(array_keys($alleRecs), 400) as $teil) {
        [$in, $pp] = db_in($teil);
        // je Aufnahme die schwächste Datei in der Bibliothek (die würde „Ersetzen“ ablösen) – mit ihrer Qualität
        foreach (db_alle("SELECT au.mbid, d.id AS datei_id, d.laenge_ms, d.format, d.codec, d.bittiefe, d.abtastrate, d.bitrate, a.titel AS album
                FROM aufnahmen au JOIN tracks t ON t.aufnahme_id = au.id JOIN dateien d ON d.track_id = t.id
                JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id
                WHERE au.mbid IN {$in} AND t.mbid IS NOT NULL", $pp) as $z) {
            [$q, $rang] = srt_qualitaet((string) $z['format'], (string) $z['codec'], (int) $z['bittiefe'], (int) $z['abtastrate'], (int) $z['bitrate']);
            $m = strtolower((string) $z['mbid']);
            if (!isset($inBib[$m]) || $rang < $inBib[$m]['rang']) {
                $inBib[$m] = ['rang' => $rang, 'q' => $q, 'album' => (string) $z['album'], 'datei_id' => (int) $z['datei_id'], 'ms' => (int) $z['laenge_ms']];
            }
        }
        // Aufnahmen, die nur als Zusatztitel ohne MusicBrainz-Bezug da sind, zählen auch als vorhanden (ohne Ersetzen)
        foreach (db_alle("SELECT au.mbid, d.format, d.codec, d.bittiefe, d.abtastrate, d.bitrate, a.titel AS album
                FROM aufnahmen au JOIN tracks t ON t.aufnahme_id = au.id JOIN dateien d ON d.track_id = t.id
                JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id
                WHERE au.mbid IN {$in} AND t.mbid IS NULL", $pp) as $z) {
            $m = strtolower((string) $z['mbid']);
            if (!isset($inBib[$m])) {
                [$q, $rang] = srt_qualitaet((string) $z['format'], (string) $z['codec'], (int) $z['bittiefe'], (int) $z['abtastrate'], (int) $z['bitrate']);
                $inBib[$m] = ['rang' => $rang, 'q' => $q, 'album' => (string) $z['album'], 'datei_id' => 0, 'ms' => 0];
            }
        }
    }
    $offen = [];
    $bibDatei = [];
    $besserAls = [];
    foreach ($behalten as $id => $_) {
        $treffer = null;
        foreach ($erkannt[$id]['t']['recs'] as $rec) {
            if (isset($inBib[$rec]) && (!$treffer || $inBib[$rec]['rang'] < $treffer['rang'])) {
                $treffer = $inBib[$rec];
            }
        }
        if ($treffer) {
            $rolle[$id] = 'bibliothek';
            $bibInfo[$id] = mb_substr($treffer['album'] . ' · ' . $treffer['q'], 0, 500);
            // besser = vollständig (nicht kürzer als die Bibliotheksdatei) und dann besseres Format – oder gleich gut, aber
            // die Bibliotheksdatei ist abgeschnitten
            $ms = (int) $erkannt[$id]['dauer_ms'];
            $nichtKuerzer = $treffer['ms'] <= 0 || $ms >= $treffer['ms'] - 3000;
            $bibAbgeschnitten = $treffer['ms'] > 0 && $ms > $treffer['ms'] + 3000;
            $besser = $treffer['datei_id'] > 0 && $nichtKuerzer && ((int) $erkannt[$id]['rang'] > $treffer['rang'] || ($bibAbgeschnitten && (int) $erkannt[$id]['rang'] >= $treffer['rang']));
            if ($besser) {
                $bibDatei[$id] = $treffer['datei_id'];
                $besserAls[$id] = true;
            }
            continue;
        }
        if (!$erkannt[$id]['t']['rels']) {
            $rolle[$id] = 'ohne_album'; // erkannt, aber auf keinem Release (z. B. nur als einzelne Aufnahme bei MusicBrainz)
            continue;
        }
        $offen[$id] = true;
    }
    // Releases der offenen Dateien
    // Release → [Datei → Position „disc-pos“] (ohne bekannte Position: eigener Platz je Datei)
    $relDateien = [];
    foreach ($offen as $id => $_) {
        foreach ($erkannt[$id]['t']['rels'] as $f) {
            $relDateien[$f[0]][$id] = $f[2] ? $f[1] . '-' . $f[2] : 'd' . $id;
        }
    }
    $relInfo = [];
    foreach (array_chunk(array_keys($relDateien), 400) as $teil) {
        [$in, $pp] = db_in($teil);
        foreach (db_alle("SELECT * FROM sortier_releases WHERE mbid IN {$in}", $pp) as $r) {
            $relInfo[$r['mbid']] = $r;
        }
    }
    $bibRel = [];
    foreach (array_chunk(array_keys($relDateien), 400) as $teil) {
        [$in, $pp] = db_in($teil);
        foreach (db_alle("SELECT mbid, id FROM editionen WHERE mbid IN {$in} AND anzahl_dateien > 0", $pp) as $e) {
            $bibRel[strtolower((string) $e['mbid'])] = (int) $e['id'];
        }
    }
    $zuAlbum = [];
    // a) von Hand festgelegte Releases zuerst
    foreach ($offen as $id => $_) {
        $fest = (string) ($erkannt[$id]['release_fest'] ?? '');
        if ($fest !== '' && isset($relDateien[$fest][$id])) {
            $zuAlbum[$id] = $fest;
            unset($offen[$id]);
        }
    }
    // b) schrittweise: bestes Release nehmen, seine Titel vergeben, neu werten (verzögerte Neuwertung über eine Warteschlange)
    // k = belegte Titelplätze (zwei Dateien auf demselben Platz zählen einmal – ein Release hat jeden Platz nur einmal)
    $wert = static function (string $rel) use (&$relDateien, &$offen, $relInfo, $bibRel): array {
        $plaetze = [];
        foreach ($relDateien[$rel] as $id => $platz) {
            if (isset($offen[$id])) {
                $plaetze[$platz] = true;
            }
        }
        $k = count($plaetze);
        $r = $relInfo[$rel] ?? ['typ' => '', 'sekundaer' => '', 'va' => 0, 'tracks' => 0, 'datum' => ''];
        return [$k, $k ? srt_wertung($r, $k, isset($bibRel[$rel])) : 0.0];
    };
    $schluessel = static function (string $rel, float $w) use ($relInfo): array {
        // höhere Wertung zuerst, bei Gleichstand das frühere Release (Original vor Neuauflage), dann stabil nach ID
        $d = (string) ($relInfo[$rel]['datum'] ?? '');
        $datum = $d === '' ? 99999999 : (int) str_pad(str_replace('-', '', $d), 8, '0');
        return [round($w, 6), -$datum, $rel];
    };
    $q = new SplPriorityQueue();
    $q->setExtractFlags(SplPriorityQueue::EXTR_BOTH);
    foreach ($relDateien as $rel => $_) {
        [$k, $w] = $wert($rel);
        if ($k) {
            $q->insert([$rel, $k], $schluessel($rel, $w));
        }
    }
    while ($offen && !$q->isEmpty()) {
        $x = $q->extract();
        [$rel, $kAlt] = $x['data'];
        [$k, $w] = $wert($rel);
        if ($k === 0) {
            continue;
        }
        if ($k !== $kAlt) {
            $q->insert([$rel, $k], $schluessel($rel, $w)); // veraltet: neu einreihen
            continue;
        }
        $belegt = [];
        foreach ($relDateien[$rel] as $id => $platz) {
            if (isset($offen[$id]) && !isset($belegt[$platz])) {
                $belegt[$platz] = true;
                $zuAlbum[$id] = $rel;
                unset($offen[$id]);
            }
        }
    }
    foreach ($offen as $id => $_) {
        $rolle[$id] = 'ohne_album'; // kein freier Titelplatz mehr (z. B. zwei verschiedene Fassungen desselben Titels)
    }
    // Speichern
    db()->beginTransaction();
    try {
        db_tun("UPDATE sortier_dateien SET rolle = '', album_id = NULL, dublette_von = NULL, bibliothek_info = '', bib_datei_id = NULL, besser = 0 WHERE erledigt = ''");
        // Rollen ohne eigene Angaben gesammelt setzen (bei zehntausend Dateien macht das den Unterschied), den Rest einzeln
        $sammel = [];
        foreach ($rolle as $id => $r) {
            if (isset($dublVon[$id]) || isset($bibInfo[$id])) {
                db_tun('UPDATE sortier_dateien SET rolle = :r, dublette_von = :d, bibliothek_info = :b, bib_datei_id = :bd, besser = :bs WHERE id = :id',
                    ['r' => $r, 'd' => $dublVon[$id] ?? null, 'b' => $bibInfo[$id] ?? '', 'bd' => $bibDatei[$id] ?? null, 'bs' => isset($besserAls[$id]) ? 1 : 0, 'id' => $id]);
            } else {
                $sammel[$r][] = $id;
            }
        }
        foreach ($sammel as $r => $ids) {
            foreach (array_chunk($ids, 500) as $teil) {
                [$in, $pp] = db_in($teil);
                $pp['r'] = $r;
                db_tun("UPDATE sortier_dateien SET rolle = :r WHERE id IN {$in}", $pp);
            }
        }
        $nachRel = [];
        foreach ($zuAlbum as $id => $rel) {
            $nachRel[$rel][] = $id;
        }
        $vorhanden = [];
        foreach (db_alle("SELECT id, release_mbid, status FROM sortier_alben") as $a) {
            $vorhanden[$a['release_mbid']] = $a;
        }
        foreach ($nachRel as $rel => $ids) {
            $r = $relInfo[$rel] ?? ['typ' => '', 'sekundaer' => '', 'va' => 0, 'tracks' => 0];
            $sicher = min(array_map(static fn($i) => (int) $erkannt[$i]['sicherheit'], $ids));
            $w = srt_wertung($r, count($ids), isset($bibRel[$rel]));
            if (isset($vorhanden[$rel])) {
                $aid = (int) $vorhanden[$rel]['id'];
                db_tun('UPDATE sortier_alben SET anzahl = :n, wertung = :w, sicherheit = :s, edition_id = :e WHERE id = :id',
                    ['n' => count($ids), 'w' => $w, 's' => $sicher, 'e' => $bibRel[$rel] ?? null, 'id' => $aid]);
                unset($vorhanden[$rel]);
            } else {
                $aid = db_einfuegen('INSERT INTO sortier_alben (release_mbid, anzahl, wertung, sicherheit, edition_id) VALUES (:r, :n, :w, :s, :e)',
                    ['r' => $rel, 'n' => count($ids), 'w' => $w, 's' => $sicher, 'e' => $bibRel[$rel] ?? null]);
            }
            foreach (array_chunk($ids, 500) as $teil) {
                [$in, $pp] = db_in($teil);
                $pp['a'] = $aid;
                db_tun("UPDATE sortier_dateien SET rolle = 'album', album_id = :a WHERE id IN {$in}", $pp);
            }
        }
        foreach ($vorhanden as $a) {
            if (!in_array($a['status'], ['verschoben', 'fertig', 'fehler'], true)) {
                db_tun('DELETE FROM sortier_alben WHERE id = :id', ['id' => $a['id']]);
            }
        }
        db()->commit();
    } catch (Throwable $e) {
        db()->rollBack();
        throw $e;
    }
}

/** Andere Releases, auf denen Titel dieses Albums auch vorkommen (für „passt auch zu …“) */
function srt_alternativen(int $albumId): array
{
    $a = db_zeile('SELECT * FROM sortier_alben WHERE id = :id', ['id' => $albumId]);
    if (!$a) {
        return [];
    }
    $zaehl = [];
    foreach (db_alle("SELECT treffer FROM sortier_dateien WHERE album_id = :a AND erledigt = ''", ['a' => $albumId]) as $d) {
        $t = json_decode((string) $d['treffer'], true) ?: [];
        foreach ($t['rels'] ?? [] as $f) {
            if ($f[0] !== $a['release_mbid']) {
                $zaehl[$f[0]] = ($zaehl[$f[0]] ?? 0) + 1;
            }
        }
    }
    if (!$zaehl) {
        return [];
    }
    [$in, $pp] = db_in(array_keys($zaehl));
    $aus = [];
    foreach (db_alle("SELECT * FROM sortier_releases WHERE mbid IN {$in}", $pp) as $r) {
        $k = $zaehl[$r['mbid']];
        $aus[] = srt_release_aussen($r) + ['enthaelt' => $k, 'wertung' => round(srt_wertung($r, $k, false), 3)];
    }
    usort($aus, static fn($x, $y) => [$y['enthaelt'], $y['wertung']] <=> [$x['enthaelt'], $x['wertung']]);
    // je Release-Gruppe nur die beste Edition, höchstens 8
    $gesehen = [];
    $aus = array_values(array_filter($aus, static function ($r) use (&$gesehen) {
        $k = $r['rg'] ?: $r['mbid'];
        if (isset($gesehen[$k])) {
            return false;
        }
        return $gesehen[$k] = true;
    }));
    return array_slice($aus, 0, 8);
}

function srt_typ_text(array $r): string
{
    $typ = match (strtolower((string) $r['typ'])) {
        'album' => t('Album'), 'ep' => 'EP', 'single' => t('Single'), 'broadcast' => t('Sendung'), 'other' => t('Sonstiges'), default => '',
    };
    $sek = array_map(static fn($s) => match (strtolower($s)) {
        'compilation' => t('Sampler'), 'live' => t('Live'), 'soundtrack' => 'Soundtrack', 'remix' => t('Remixe'), 'dj-mix' => 'DJ-Mix',
        'demo' => 'Demo', 'spokenword' => t('Wortbeitrag'), 'interview' => 'Interview', 'audiobook' => t('Hörbuch'), default => $s,
    }, array_filter(explode(',', (string) $r['sekundaer'])));
    return implode(' · ', array_filter(array_merge([$typ], $sek)));
}

function srt_release_aussen(array $r): array
{
    return [
        'mbid' => (string) $r['mbid'], 'rg' => (string) ($r['rg_mbid'] ?? ''), 'titel' => (string) $r['titel'], 'kuenstler' => (string) $r['kuenstler'],
        'jahr' => $r['datum'] !== '' ? (int) substr((string) $r['datum'], 0, 4) : null, 'land' => (string) $r['land'], 'format' => (string) $r['format'],
        'tracks' => (int) $r['tracks'], 'medien' => (int) $r['medien'], 'typ' => srt_typ_text($r), 'va' => (bool) $r['va'],
    ];
}

// ---------- Eingriffe aus der Vorschau ----------

function srt_bearbeitbar(): void
{
    if (srt_stand_lesen()['phase'] !== 'bereit') {
        throw new SrtFehler(t('Die Vorschau kann gerade nicht geändert werden (Analyse oder Einsortieren läuft).'), 409);
    }
}

function srt_album_schalten(int $albumId, bool $aktiv): void
{
    srt_bearbeitbar();
    db_tun("UPDATE sortier_alben SET aktiv = :a WHERE id = :id AND status = 'vorschlag'", ['a' => $aktiv ? 1 : 0, 'id' => $albumId]);
}

/** Titel eines Albums (soweit sie dort vorkommen) auf ein anderes Release legen */
function srt_album_umhaengen(int $albumId, string $release): int
{
    srt_bearbeitbar();
    $release = strtolower($release);
    if (!ist_uuid($release)) {
        throw new SrtFehler(t('Ungültiges Release.'), 422);
    }
    $n = 0;
    foreach (db_alle("SELECT id, treffer FROM sortier_dateien WHERE album_id = :a AND erledigt = ''", ['a' => $albumId]) as $d) {
        $t = json_decode((string) $d['treffer'], true) ?: [];
        foreach ($t['rels'] ?? [] as $f) {
            if ($f[0] === $release) {
                db_tun('UPDATE sortier_dateien SET release_fest = :r WHERE id = :id', ['r' => $release, 'id' => $d['id']]);
                $n++;
                break;
            }
        }
    }
    srt_zuordnen();
    return $n;
}

/** Aktion einer einzelnen Datei setzen: uebernehmen (nur Album), papierkorb, liegen – oder '' (Vorgabe) */
function srt_datei_aktion(int $id, string $aktion): void
{
    srt_bearbeitbar();
    if (!in_array($aktion, ['', 'uebernehmen', 'papierkorb', 'liegen', 'ersetzen'], true)) {
        throw new SrtFehler(t('Unbekannte Aktion.'), 422);
    }
    if ($aktion === 'ersetzen') {
        $d = db_zeile('SELECT rolle, besser, pfad FROM sortier_dateien WHERE id = :id', ['id' => $id]);
        if (!$d || $d['rolle'] !== 'bibliothek' || !(int) $d['besser']) {
            throw new SrtFehler(t('Ersetzen geht nur, wenn diese Datei besser ist als die in der Bibliothek.'), 422);
        }
        if (!srt_beschreibbar((string) $d['pfad'])) {
            throw new SrtFehler(t('Ersetzen geht nur mit FLAC, MP3, M4A oder WAV/AIFF (die Datei braucht MusicBrainz-Tags, damit sie ihren Titel findet).'), 422);
        }
    }
    db_tun("UPDATE sortier_dateien SET aktion = :a WHERE id = :id AND erledigt = ''", ['a' => $aktion, 'id' => $id]);
}

/** Handsuche bei MusicBrainz (Aufnahmen) für eine unerkannte Datei: „Künstler – Titel“ oder freier Text */
function srt_suche(int $id, string $q): array
{
    $d = db_zeile('SELECT * FROM sortier_dateien WHERE id = :id', ['id' => $id]);
    if (!$d) {
        throw new SrtFehler(t('Datei nicht gefunden.'), 404);
    }
    $q = trim($q);
    if ($q === '') {
        $q = trim($d['tag_kuenstler'] . ' ' . ($d['tag_titel'] ?: pathinfo((string) $d['pfad'], PATHINFO_FILENAME)));
    }
    $teile = preg_split('/\s+[-–]\s+/u', $q, 2);
    $lucene = count($teile) === 2
        ? 'artist:(' . mb_lucene($teile[0]) . ') AND recording:(' . mb_lucene($teile[1]) . ')'
        : mb_lucene($q);
    $j = mb_abfrage('recording', ['query' => $lucene, 'limit' => 12], 3600);
    $aus = [];
    foreach ($j['recordings'] ?? [] as $rec) {
        $laenge = isset($rec['length']) ? (int) $rec['length'] : null;
        $rels = [];
        foreach ($rec['releases'] ?? [] as $rel) {
            $rels[] = ['titel' => (string) ($rel['title'] ?? ''), 'jahr' => isset($rel['date']) ? (int) substr((string) $rel['date'], 0, 4) ?: null : null,
                'typ' => srt_typ_text(['typ' => (string) ($rel['release-group']['primary-type'] ?? ''), 'sekundaer' => implode(',', $rel['release-group']['secondary-types'] ?? [])])];
        }
        $aus[] = ['mbid' => (string) $rec['id'], 'titel' => (string) ($rec['title'] ?? ''), 'kuenstler' => mb_credit_text($rec['artist-credit'] ?? []),
            'laenge_ms' => $laenge, 'passt_laenge' => $laenge === null || (int) $d['dauer_ms'] <= 0 || abs($laenge - (int) $d['dauer_ms']) <= 7000,
            'releases' => array_slice($rels, 0, 5), 'anzahl_releases' => count($rec['releases'] ?? []), 'score' => (int) ($rec['score'] ?? 0)];
    }
    return ['q' => $q, 'treffer' => $aus];
}

/** Eine Datei von Hand einer MusicBrainz-Aufnahme zuordnen (Releases der Aufnahme werden geladen) */
function srt_datei_zuordnen(int $id, string $recMbid): void
{
    srt_bearbeitbar();
    $recMbid = strtolower($recMbid);
    $d = db_zeile('SELECT * FROM sortier_dateien WHERE id = :id', ['id' => $id]);
    if (!$d || !ist_uuid($recMbid)) {
        throw new SrtFehler(t('Datei oder Aufnahme ungültig.'), 422);
    }
    $rec = mb_abfrage('recording/' . $recMbid, ['inc' => 'artist-credits+releases+release-groups+media'], 86400);
    $fund = [];
    foreach ($rec['releases'] ?? [] as $rel) {
        $rg = $rel['release-group'] ?? [];
        $acRg = ['id' => $rg['id'] ?? null, 'title' => $rg['title'] ?? '', 'type' => $rg['primary-type'] ?? '', 'secondarytypes' => $rg['secondary-types'] ?? [],
            'artists' => array_map(static fn($c) => ['id' => $c['artist']['id'] ?? '', 'name' => $c['name'] ?? ($c['artist']['name'] ?? ''), 'joinphrase' => $c['joinphrase'] ?? ''], $rel['artist-credit'] ?? $rec['artist-credit'] ?? [])];
        $mediums = [];
        foreach ($rel['media'] ?? [] as $m) {
            $tr = [];
            foreach ($m['tracks'] ?? $m['track'] ?? [] as $t) {
                $tr[] = ['position' => (int) ($t['position'] ?? $t['number'] ?? 0), 'id' => (string) ($t['id'] ?? '')];
            }
            $mediums[] = ['position' => (int) ($m['position'] ?? 1), 'format' => (string) ($m['format'] ?? ''), 'track_count' => (int) ($m['track-count'] ?? 0), 'tracks' => $tr];
        }
        $acRel = ['id' => $rel['id'] ?? '', 'title' => $rel['title'] ?? '', 'country' => $rel['country'] ?? '', 'date' => $rel['date'] ?? '',
            'track_count' => array_sum(array_map(static fn($m) => (int) ($m['track-count'] ?? 0), $rel['media'] ?? [])) ?: null, 'medium_count' => count($rel['media'] ?? []),
            'mediums' => $mediums, 'artists' => $acRg['artists']];
        if ($f = srt_release_merken($acRel, $acRg, $recMbid)) {
            $fund[] = $f;
        }
    }
    srt_treffer_speichern($id, [['id' => $recMbid, 's' => 1.0, 'titel' => (string) ($rec['title'] ?? ''), 'kuenstler' => mb_credit_text($rec['artist-credit'] ?? []),
        'dauer' => isset($rec['length']) ? (int) $rec['length'] : null, 'fund' => $fund]], (int) $d['dauer_ms'], true);
    srt_zuordnen();
}

/** Vorschau verwerfen: alle Eingriffe (festgelegte Releases, Aktionen, Abwahlen) zurücksetzen und neu zuordnen */
function srt_eingriffe_zuruecksetzen(): void
{
    srt_bearbeitbar();
    db_tun("UPDATE sortier_dateien SET aktion = '', release_fest = NULL WHERE erledigt = ''");
    db_tun("UPDATE sortier_alben SET aktiv = 1 WHERE status = 'vorschlag'");
    srt_zuordnen();
}

// ---------- 3. Ausführen ----------

function srt_ausfuehren_starten(): array
{
    srt_bearbeitbar();
    $t = af_schreibtest();
    if (!$t['ok']) {
        throw new SrtFehler(t('Der Musikordner ist nicht beschreibbar: {grund}', ['grund' => $t['meldung']]), 422);
    }
    srt_stand_setzen(['phase' => 'ausfuehren', 'schritt' => t('Einsortieren vorbereiten'), 'seit' => time(), 'fehler' => '']);
    srt_anstossen();
    return srt_stand();
}

function srt_ausfuehren_takt(int $bis): bool
{
    if (scan_laufend() || af_laeuft()) {
        srt_stand_setzen(['schritt' => t('Wartet, bis Einlesen/Aufräumen fertig ist')]);
        sleep(5);
        return true;
    }
    // a) Dateien, die weg sollen (Dubletten, schon Vorhandenes), in den Papierkorb
    foreach (db_alle("SELECT * FROM sortier_dateien WHERE erledigt = '' AND rolle IN ('dublette', 'bibliothek', 'unerkannt', 'ohne_album')") as $d) {
        if (srt_aktion($d) !== 'papierkorb') {
            continue;
        }
        srt_stand_setzen(['schritt' => t('Dubletten in den Papierkorb')]);
        try {
            $ziel = af_in_papierkorb((string) $d['pfad'], 'sortieren');
            db_tun("UPDATE sortier_dateien SET erledigt = 'papierkorb', ziel = :z WHERE id = :id", ['z' => mb_substr($ziel, 0, 2000), 'id' => $d['id']]);
            af_protokoll(null, 'sortieren', (string) $d['pfad'], $ziel, t('Dublette in den Papierkorb'));
        } catch (Throwable $e) {
            db_tun("UPDATE sortier_dateien SET erledigt = 'fehler', meldung = :m WHERE id = :id", ['m' => mb_substr($e->getMessage(), 0, 500), 'id' => $d['id']]);
        }
        if (time() >= $bis) {
            return false;
        }
    }
    // a2) Bessere Fassung ersetzt die Datei in der Bibliothek (die alte geht in den Papierkorb)
    foreach (db_alle("SELECT * FROM sortier_dateien WHERE erledigt = '' AND rolle = 'bibliothek' AND aktion = 'ersetzen' AND besser = 1") as $d) {
        srt_stand_setzen(['schritt' => t('Bessere Fassungen einsetzen')]);
        try {
            $ziel = srt_ersetzen($d);
            db_tun("UPDATE sortier_dateien SET erledigt = 'ersetzt', ziel = :z, meldung = '' WHERE id = :id", ['z' => mb_substr($ziel, 0, 2000), 'id' => $d['id']]);
            srt_stand_setzen(['scan_noetig' => true]);
        } catch (Throwable $e) {
            db_tun("UPDATE sortier_dateien SET erledigt = 'fehler', meldung = :m WHERE id = :id", ['m' => mb_substr($e->getMessage(), 0, 500), 'id' => $d['id']]);
        }
        if (time() >= $bis) {
            return false;
        }
    }
    // b) Alben an ihren Platz
    $alben = db_alle("SELECT * FROM sortier_alben WHERE status = 'vorschlag' AND aktiv = 1 ORDER BY id");
    foreach ($alben as $a) {
        srt_stand_setzen(['schritt' => t('Einsortieren: {titel}', ['titel' => db_wert('SELECT titel FROM sortier_releases WHERE mbid = :m', ['m' => $a['release_mbid']])])]);
        srt_album_verschieben($a);
        if (time() >= $bis) {
            return false;
        }
    }
    srt_leere_ordner_weg();
    // c) einlesen lassen, danach verknüpfen
    if (db_wert("SELECT COUNT(*) FROM sortier_alben WHERE status = 'verschoben'") || !empty(srt_stand_lesen()['scan_noetig'])) {
        $sid = scan_starten(false, null);
        srt_stand_setzen(['phase' => 'warten_scan', 'scan_id' => $sid, 'scan_noetig' => false, 'schritt' => t('Neue Dateien einlesen')]);
        return true;
    }
    srt_stand_setzen(['phase' => 'fertig', 'schritt' => '']);
    return false;
}

/** Leere Unterordner im Eingangsordner entfernen (nur wirklich leere, der Eingangsordner selbst bleibt) */
function srt_leere_ordner_weg(): void
{
    $wurzel = af_wurzel() . '/' . srt_eingang();
    if (!is_dir($wurzel)) {
        return;
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($wurzel, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) {
        if ($f->isDir() && !$f->isLink() && count((array) @scandir($f->getPathname())) === 2) {
            @rmdir($f->getPathname());
        }
    }
}

/**
 * Bessere Fassung an die Stelle der Bibliotheksdatei: gleicher Ordner und Name (neue Endung), Tags aus der Bibliothek
 * (mit MusicBrainz-IDs, damit das Einlesen sie demselben Titel zuordnet), Cover wie beim Aufräumen. Die alte Datei geht
 * in den Papierkorb – erst, wenn die neue fertig daneben liegt.
 */
function srt_ersetzen(array $d): string
{
    $alt = db_zeile('SELECT d.id, d.pfad, d.track_id, m.edition_id FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
        WHERE d.id = :id AND t.mbid IS NOT NULL', ['id' => (int) $d['bib_datei_id']]);
    $wurzel = af_wurzel();
    if (!$alt || !is_file($wurzel . '/' . $alt['pfad'])) {
        throw new RuntimeException(t('Die Datei in der Bibliothek ist nicht mehr da (bitte neu analysieren).'));
    }
    $e = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $alt['edition_id']]);
    $soll = tags_fuer_edition((int) $alt['edition_id'])[(int) $alt['track_id']] ?? null;
    if (!$soll || !$e) {
        throw new RuntimeException(t('Für diesen Titel gibt es keine Tags in der Bibliothek.'));
    }
    $ext = strtolower(pathinfo((string) $d['pfad'], PATHINFO_EXTENSION));
    $wandeln = in_array($ext, ['wav', 'aif', 'aiff'], true);
    $neuExt = $wandeln ? 'flac' : $ext;
    $ordner = dirname((string) $alt['pfad']);
    $basis = pathinfo((string) $alt['pfad'], PATHINFO_FILENAME);
    $zielRel = ($ordner === '.' ? '' : $ordner . '/') . $basis . '.' . $neuExt;
    if ($zielRel !== $alt['pfad']) {
        for ($k = 2; file_exists($wurzel . '/' . $zielRel); $k++) {
            $zielRel = ($ordner === '.' ? '' : $ordner . '/') . $basis . ' (' . $k . ').' . $neuExt;
        }
    }
    $tmp = $wurzel . '/' . ($ordner === '.' ? '' : $ordner . '/') . '.aw-sortieren-' . bin2hex(random_bytes(4)) . '.' . $neuExt;
    $von = $wurzel . '/' . $d['pfad'];
    try {
        if ($wandeln) {
            ue_zu_flac($von, $tmp);
        } else {
            af_verschieben($von, $tmp);
        }
        datei_tags_schreiben($tmp, $soll, af_cover($e));
    } catch (Throwable $ex) {
        if (!$wandeln && is_file($tmp) && !is_file($von)) {
            @rename($tmp, $von); // zurück an den alten Platz
        }
        @unlink($tmp);
        throw new RuntimeException(t('Ersetzen fehlgeschlagen: {grund}', ['grund' => $ex->getMessage()]));
    }
    $imKorb = af_in_papierkorb((string) $alt['pfad'], 'sortieren-ersetzt');
    if (!@rename($tmp, $wurzel . '/' . $zielRel)) {
        throw new RuntimeException(t('Umbenennen fehlgeschlagen – die neue Datei liegt als {datei} daneben, die alte im Papierkorb ({korb}).', ['datei' => basename($tmp), 'korb' => $imKorb]));
    }
    af_datei_rechte($wurzel . '/' . $zielRel);
    if ($wandeln) {
        af_in_papierkorb((string) $d['pfad'], 'sortieren-wav');
    }
    af_protokoll((int) $alt['edition_id'], 'sortieren', (string) $d['pfad'], $zielRel, t('Bessere Fassung ersetzt {pfad}', ['pfad' => $alt['pfad']]));
    return $zielRel;
}

/** Fundstellen der Aufnahmen auf einem Release (aus MusicBrainz): Aufnahme → [i (Index), disc, pos, track-mbid, titel, künstler] */
function srt_release_titel(array $rel): array
{
    $aus = [];
    $i = 0;
    foreach ($rel['media'] ?? [] as $m) {
        foreach ($m['tracks'] ?? [] as $t) {
            $rec = strtolower((string) ($t['recording']['id'] ?? ''));
            if (ist_uuid($rec) && !isset($aus[$rec])) {
                $aus[$rec] = ['i' => $i, 'disc' => (int) ($m['position'] ?? 1), 'pos' => (int) ($t['position'] ?? 0), 'tid' => strtolower((string) ($t['id'] ?? '')),
                    'titel' => (string) ($t['title'] ?? ''), 'kuenstler' => mb_credit_text($t['artist-credit'] ?? []), 'aufnahme' => $rec];
            }
            $i++;
        }
    }
    return $aus;
}

/**
 * Dateien eines Albums an ihren Platz: vorhandenes Album → in dessen Ordner, sonst in die Zwischenablage. Dateiname nach
 * Titelposition, Tags mit den MusicBrainz-IDs (damit Einlesen und Abgleich jede Datei sicher ihrem Titel zuordnen),
 * WAV/AIFF nach FLAC (wie beim Download-Import, abschaltbar).
 */
function srt_album_verschieben(array $a): void
{
    $r = (string) $a['release_mbid'];
    try {
        $rel = mb_edition_laden($r, 86400);
    } catch (Throwable $e) {
        db_tun("UPDATE sortier_alben SET status = 'fehler', meldung = :m WHERE id = :id", ['m' => mb_substr(t('MusicBrainz: {fehler}', ['fehler' => $e->getMessage()]), 0, 500), 'id' => $a['id']]);
        return;
    }
    $titelListe = srt_release_titel($rel);
    $albumKuenstler = mb_credit_text($rel['artist-credit'] ?? []);
    $albumTitel = (string) ($rel['title'] ?? '');
    $eid = (int) ($a['edition_id'] ?? 0);
    $e = $eid ? db_zeile('SELECT id, ordner FROM editionen WHERE id = :id AND mbid = :m', ['id' => $eid, 'm' => $r]) : null;
    if ($e) {
        $ordner = (string) $e['ordner'];
    } else {
        $eid = 0;
        $ordner = srt_zwischen() . '/' . af_sicher(af_kuerzen($albumKuenstler . ' - ' . $albumTitel, 120) . ' [' . substr($r, -8) . ']');
    }
    $wurzel = af_wurzel();
    $zuFlac = einstellung('download_wav_flac') !== '0';
    $vergeben = [];
    $n = 0;
    $fehler = [];
    foreach (db_alle("SELECT * FROM sortier_dateien WHERE album_id = :a AND erledigt = '' ORDER BY id", ['a' => $a['id']]) as $d) {
        if (srt_aktion($d) !== 'uebernehmen') {
            continue;
        }
        $t = json_decode((string) $d['treffer'], true) ?: [];
        $ziel = null;
        foreach ($t['recs'] ?? [] as $rec) {
            if (isset($titelListe[$rec]) && !isset($vergeben[$titelListe[$rec]['i']])) {
                $ziel = $titelListe[$rec];
                break;
            }
        }
        if (!$ziel) {
            db_tun('UPDATE sortier_dateien SET meldung = :m WHERE id = :id', ['m' => t('Steht nicht (mehr) auf diesem Release – bleibt liegen'), 'id' => $d['id']]);
            continue;
        }
        $vergeben[$ziel['i']] = true;
        $ext = strtolower(pathinfo((string) $d['pfad'], PATHINFO_EXTENSION));
        $wandeln = $zuFlac && in_array($ext, ['wav', 'aif', 'aiff'], true);
        $name = sprintf('%d-%02d %s.%s', $ziel['disc'], $ziel['pos'], af_kuerzen(af_sicher($ziel['titel']) ?: 'Titel', 100), $wandeln ? 'flac' : $ext);
        $nachRel = $ordner . '/' . $name;
        for ($k = 2; file_exists($wurzel . '/' . $nachRel); $k++) {
            $nachRel = $ordner . '/' . pathinfo($name, PATHINFO_FILENAME) . ' (' . $k . ').' . pathinfo($name, PATHINFO_EXTENSION);
        }
        $von = $wurzel . '/' . $d['pfad'];
        $nach = $wurzel . '/' . $nachRel;
        try {
            if ($wandeln) {
                if (!af_ordner_anlegen(dirname($nach))) {
                    throw new RuntimeException(t('Ordner konnte nicht angelegt werden'));
                }
                $tmp = dirname($nach) . '/.aw-sortieren-' . bin2hex(random_bytes(4)) . '.flac';
                try {
                    ue_zu_flac($von, $tmp, true);
                    if (!@rename($tmp, $nach)) {
                        throw new RuntimeException(t('Umbenennen fehlgeschlagen'));
                    }
                } catch (Throwable $ex) {
                    @unlink($tmp);
                    throw $ex;
                }
                af_datei_rechte($nach);
                af_in_papierkorb((string) $d['pfad'], 'sortieren-wav'); // das WAV-Original bleibt 30 Tage im Papierkorb
            } else {
                af_verschieben($von, $nach);
            }
            af_protokoll($eid ?: null, 'sortieren', (string) $d['pfad'], $nachRel, $albumTitel);
            db_tun("UPDATE sortier_dateien SET erledigt = 'verschoben', ziel = :z, meldung = '' WHERE id = :id", ['z' => mb_substr($nachRel, 0, 2000), 'id' => $d['id']]);
            $n++;
        } catch (Throwable $ex) {
            $fehler[] = basename((string) $d['pfad']) . ': ' . $ex->getMessage();
            db_tun("UPDATE sortier_dateien SET erledigt = 'fehler', meldung = :m WHERE id = :id", ['m' => mb_substr($ex->getMessage(), 0, 500), 'id' => $d['id']]);
            continue;
        }
        // Tags (FLAC, MP3, M4A): Fehler hier sind nicht schlimm – die Zuordnung klappt auch ohne (siehe Verknüpfen)
        if (in_array(strtolower(pathinfo($nach, PATHINFO_EXTENSION)), ['flac', 'mp3', 'm4a', 'mp4', 'aac'], true)) {
            try {
                datei_tags_schreiben($nach, [
                    'TITLE' => [$ziel['titel']], 'ARTIST' => [$ziel['kuenstler'] ?: $albumKuenstler], 'ALBUM' => [$albumTitel], 'ALBUMARTIST' => [$albumKuenstler],
                    'TRACKNUMBER' => [(string) $ziel['pos']], 'DISCNUMBER' => [(string) $ziel['disc']], 'DATE' => [(string) ($rel['date'] ?? '')],
                    'MUSICBRAINZ_ALBUMID' => [$r], 'MUSICBRAINZ_RELEASEGROUPID' => [strtolower((string) ($rel['release-group']['id'] ?? ''))],
                    'MUSICBRAINZ_TRACKID' => [$ziel['aufnahme']], 'MUSICBRAINZ_RELEASETRACKID' => [$ziel['tid']],
                ]);
            } catch (Throwable $ex) {
                // z. B. schreibgeschützt oder ungewöhnlicher Kopf – bleibt beim Dateinamen
            }
        }
    }
    db_tun("UPDATE sortier_alben SET status = :s, ordner = :o, edition_id = :e, meldung = :m WHERE id = :id", [
        's' => $n ? 'verschoben' : 'fehler', 'o' => mb_substr($ordner, 0, 2000), 'e' => $eid ?: null,
        'm' => mb_substr($fehler ? implode(' · ', $fehler) : ($n ? '' : t('Keine Datei verschoben')), 0, 500), 'id' => $a['id'],
    ]);
}

function srt_warten_takt(): bool
{
    if (scan_laufend()) {
        sleep(5); // im selben Lauf weiterwarten (der Zeitplan stößt sonst erst in einer Minute wieder an)
        return true;
    }
    srt_stand_setzen(['phase' => 'verknuepfen', 'schritt' => t('Mit MusicBrainz verknüpfen')]);
    return true;
}

function srt_verknuepfen_takt(int $bis): bool
{
    if (scan_laufend()) {
        srt_stand_setzen(['phase' => 'warten_scan']);
        return true;
    }
    foreach (db_alle("SELECT * FROM sortier_alben WHERE status = 'verschoben' ORDER BY id") as $a) {
        try {
            srt_album_verknuepfen($a);
        } catch (Throwable $e) {
            db_tun("UPDATE sortier_alben SET status = 'fehler', meldung = :m WHERE id = :id", ['m' => mb_substr($e->getMessage(), 0, 500), 'id' => $a['id']]);
        }
        if (time() >= $bis) {
            return false;
        }
    }
    af_anstossen();
    srt_stand_setzen(['phase' => 'fertig', 'schritt' => '']);
    return false;
}

/**
 * Eingelesenes Album mit seinem Release verknüpfen und jede Datei auf ihren Titel legen, dann Aufräumen freigeben.
 * Neue Alben: die Edition im Zwischenordner wird mit dem Release abgeglichen (Zuordnung von Hand vorgegeben, nicht
 * geraten). Danach (und bei vorhandenen Alben) wird geprüft, dass jede Datei auf dem Titel mit ihrer MusicBrainz-ID liegt –
 * Dateien ohne schreibbare Tags (Ogg, WMA …) landen sonst als Zusatztitel oder eigene Edition.
 */
function srt_album_verknuepfen(array $a): void
{
    $r = (string) $a['release_mbid'];
    $rel = mb_edition_laden($r, 86400);
    $titelListe = srt_release_titel($rel);
    $dateien = [];
    foreach (db_alle("SELECT * FROM sortier_dateien WHERE album_id = :a AND erledigt = 'verschoben'", ['a' => $a['id']]) as $d) {
        $z = db_zeile('SELECT d.id, d.track_id, m.edition_id FROM dateien d LEFT JOIN tracks t ON t.id = d.track_id LEFT JOIN datentraeger m ON m.id = t.datentraeger_id
            WHERE d.pfad_hash = :h', ['h' => hash('sha256', (string) $d['ziel'])]);
        $t = json_decode((string) $d['treffer'], true) ?: [];
        $ziel = null;
        foreach ($t['recs'] ?? [] as $rec) {
            if (isset($titelListe[$rec])) {
                $ziel = $titelListe[$rec];
                break;
            }
        }
        if ($z && $ziel) {
            $dateien[] = ['sd' => $d, 'datei_id' => (int) $z['id'], 'track_id' => $z['track_id'] !== null ? (int) $z['track_id'] : null,
                'edition_id' => $z['edition_id'] !== null ? (int) $z['edition_id'] : null, 'ziel' => $ziel];
        }
    }
    if (!$dateien) {
        db_tun("UPDATE sortier_alben SET status = 'fehler', meldung = :m WHERE id = :id", ['m' => t('Die Dateien wurden nicht eingelesen (Rechte? Format?)'), 'id' => $a['id']]);
        return;
    }
    $eid = (int) ($a['edition_id'] ?? 0);
    if (!$eid) {
        // Haupt-Edition: die mit den meisten unserer Dateien
        $zaehl = [];
        foreach ($dateien as $x) {
            if ($x['edition_id']) {
                $zaehl[$x['edition_id']] = ($zaehl[$x['edition_id']] ?? 0) + 1;
            }
        }
        arsort($zaehl);
        $eid = (int) array_key_first($zaehl);
        if (!$eid) {
            throw new RuntimeException(t('Keine Edition zu den eingelesenen Dateien gefunden.'));
        }
        $ed = db_zeile('SELECT mbid, quelle FROM editionen WHERE id = :id', ['id' => $eid]);
        if ($ed['quelle'] === 'tags' || strtolower((string) $ed['mbid']) !== $r) {
            $zuordnung = [];
            foreach ($dateien as $x) {
                if ($x['edition_id'] === $eid && $x['track_id']) {
                    $zuordnung[$x['track_id']] = $x['ziel']['i'];
                }
            }
            mb_edition_uebernehmen($eid, $r, 'fehlend', $zuordnung, true);
        }
    }
    // Jede Datei auf ihren Titel (über die Release-Track-ID)
    $alteEditionen = [];
    foreach ($dateien as $x) {
        $soll = (int) db_wert('SELECT t.id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e AND t.mbid = :m LIMIT 1',
            ['e' => $eid, 'm' => $x['ziel']['tid']]);
        $ist = (int) db_wert('SELECT track_id FROM dateien WHERE id = :id', ['id' => $x['datei_id']]);
        if (!$soll || $soll === $ist) {
            continue;
        }
        if (db_wert('SELECT 1 FROM dateien WHERE track_id = :t AND id <> :d LIMIT 1', ['t' => $soll, 'd' => $x['datei_id']])) {
            continue; // der Titel hat schon eine Datei – nicht doppelt belegen
        }
        db_tun('UPDATE dateien SET track_id = :t WHERE id = :id', ['t' => $soll, 'id' => $x['datei_id']]);
        if ($ist) {
            $alt = db_zeile('SELECT t.id, t.mbid, m.edition_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE t.id = :t', ['t' => $ist]);
            if ($alt && $alt['mbid'] === null && !db_wert('SELECT 1 FROM dateien WHERE track_id = :t LIMIT 1', ['t' => $ist])) {
                db_tun('DELETE FROM tracks WHERE id = :id', ['id' => $ist]); // verwaister Zusatztitel aus Tags
                geloescht_merken('track', $ist);
            }
            if ($alt && (int) $alt['edition_id'] !== $eid) {
                $alteEditionen[(int) $alt['edition_id']] = true;
            }
        }
    }
    foreach (array_keys($alteEditionen) as $alt) {
        $rest = (int) db_wert('SELECT COUNT(*) FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $alt]);
        if ($rest === 0) {
            $album = (int) db_wert('SELECT album_id FROM editionen WHERE id = :id', ['id' => $alt]);
            edition_loeschen($alt);
            if ($album && !db_wert('SELECT 1 FROM editionen WHERE album_id = :a LIMIT 1', ['a' => $album])) {
                db_tun('DELETE FROM alben WHERE id = :id', ['id' => $album]);
                geloescht_merken('album', $album);
            }
        } else {
            edition_kennzahlen($alt);
        }
    }
    edition_kennzahlen($eid);
    album_anzeige_aktualisieren((int) db_wert('SELECT album_id FROM editionen WHERE id = :id', ['id' => $eid]));
    // Aufräumen: nach Schema an den endgültigen Platz (ohne Freigabe – die Vorschau des Assistenten war die Freigabe)
    $meldung = '';
    $plan = db_zeile('SELECT status FROM aufraeum_plaene WHERE edition_id = :e', ['e' => $eid]);
    if (!$plan || !in_array($plan['status'], ['freigegeben', 'laeuft'], true)) {
        $p = af_plan_erstellen($eid);
        $bewegt = count(array_filter($p['dateien'] ?? [], static fn($x) => !empty($x['nach'])));
        if ($bewegt || ($p['ordner_neu'] ?? '') !== ($p['ordner_alt'] ?? '')) {
            db_tun("UPDATE aufraeum_plaene SET status = 'freigegeben', freigegeben_am = NOW() WHERE edition_id = :e AND status = 'offen'", ['e' => $eid]);
            $meldung = t('Wird einsortiert nach {ziel}', ['ziel' => $p['ordner_neu'] ?? '']);
        }
    }
    db_tun("UPDATE sortier_alben SET status = 'fertig', edition_id = :e, meldung = :m WHERE id = :id", ['e' => $eid, 'm' => mb_substr($meldung, 0, 500), 'id' => $a['id']]);
}

// ---------- Stand für die Oberfläche ----------

function srt_stand(): array
{
    $z = srt_stand_lesen();
    $zahlen = [];
    foreach (db_alle("SELECT status, COUNT(*) AS n FROM sortier_dateien WHERE erledigt = '' GROUP BY status") as $s) {
        $zahlen[$s['status']] = (int) $s['n'];
    }
    $rollen = [];
    foreach (db_alle("SELECT rolle, COUNT(*) AS n, SUM(groesse) AS b FROM sortier_dateien WHERE erledigt = '' GROUP BY rolle") as $s) {
        $rollen[$s['rolle'] ?: 'offen'] = ['n' => (int) $s['n'], 'bytes' => (int) $s['b']];
    }
    $erledigt = [];
    foreach (db_alle("SELECT erledigt, COUNT(*) AS n FROM sortier_dateien WHERE erledigt <> '' GROUP BY erledigt") as $s) {
        $erledigt[$s['erledigt']] = (int) $s['n'];
    }
    $gesamt = array_sum($zahlen);
    $abs = af_wurzel() . '/' . srt_eingang();
    // Was „Übernehmen“ tun würde
    $aktionen = ['alben' => 0, 'album_dateien' => 0, 'papierkorb' => 0, 'papierkorb_bytes' => 0, 'ersetzen' => 0, 'liegen' => 0];
    $aktiv = [];
    foreach (db_alle("SELECT id, aktiv FROM sortier_alben WHERE status = 'vorschlag'") as $a) {
        $aktiv[(int) $a['id']] = (bool) $a['aktiv'];
        $aktionen['alben'] += $a['aktiv'] ? 1 : 0;
    }
    foreach (db_alle("SELECT rolle, aktion, album_id, groesse, besser FROM sortier_dateien WHERE erledigt = ''") as $d) {
        $a = srt_aktion($d);
        if ($d['rolle'] === 'album') {
            if ($a === 'uebernehmen' && ($aktiv[(int) $d['album_id']] ?? false)) {
                $aktionen['album_dateien']++;
            } else {
                $aktionen['liegen']++;
            }
        } elseif ($a === 'papierkorb') {
            $aktionen['papierkorb']++;
            $aktionen['papierkorb_bytes'] += (int) $d['groesse'];
        } elseif ($a === 'ersetzen' && (int) $d['besser']) {
            $aktionen['ersetzen']++;
        } else {
            $aktionen['liegen']++;
        }
    }
    return [
        'phase' => $z['phase'], 'schritt' => $z['schritt'], 'fehler' => $z['fehler'], 'laeuft' => srt_laeuft(),
        'eingang' => srt_eingang(), 'eingang_da' => is_dir($abs), 'zwischen' => srt_zwischen(), 'acoustid' => erk_bereit(),
        'dubletten_vorgabe' => srt_konfig()['dubletten'],
        'zahlen' => ['gesamt' => $gesamt, 'gelesen' => $gesamt - (int) ($zahlen['neu'] ?? 0), 'fp' => (int) ($zahlen['fp'] ?? 0),
            'erkannt' => (int) ($zahlen['erkannt'] ?? 0), 'unerkannt' => (int) ($zahlen['unerkannt'] ?? 0), 'fehler' => (int) ($zahlen['fehler'] ?? 0),
            'offen' => (int) ($zahlen['neu'] ?? 0) + (int) ($zahlen['fp'] ?? 0)],
        'rollen' => $rollen, 'erledigt' => $erledigt, 'aktionen' => $aktionen, 'papierkorb_tage' => (int) (konfig()['aufraeumen']['papierkorb_tage'] ?? 30),
        'alben' => in_array($z['phase'], ['leer', 'analyse'], true) ? [] : srt_alben_liste(),
    ];
}

function srt_alben_liste(): array
{
    $aus = [];
    foreach (db_alle("SELECT a.*, r.titel, r.kuenstler, r.datum, r.tracks, r.medien, r.typ, r.sekundaer, r.va, r.land, r.format, r.rg_mbid, r.mbid
            FROM sortier_alben a JOIN sortier_releases r ON r.mbid = a.release_mbid ORDER BY r.kuenstler, r.datum, r.titel") as $a) {
        $meldung = (string) $a['meldung'];
        if ($a['status'] === 'fertig' && $a['edition_id'] !== null) {
            // Aufräumen fertig? Dann steht der endgültige Ordner an der Edition
            $o = (string) db_wert('SELECT ordner FROM editionen WHERE id = :id', ['id' => $a['edition_id']]);
            if ($o !== '' && !str_starts_with($o, srt_zwischen() . '/')) {
                $meldung = t('Einsortiert: {ziel}', ['ziel' => $o]);
            }
        }
        $aus[] = srt_release_aussen($a) + [
            'id' => (int) $a['id'], 'anzahl' => (int) $a['anzahl'], 'sicherheit' => (int) $a['sicherheit'], 'aktiv' => (bool) $a['aktiv'],
            'status' => (string) $a['status'], 'meldung' => $meldung, 'in_bibliothek' => $a['edition_id'] !== null,
            'vollstaendig' => (int) $a['tracks'] > 0 && (int) $a['anzahl'] >= (int) $a['tracks'],
        ];
    }
    return $aus;
}

function srt_datei_aussen(array $d): array
{
    return [
        'id' => (int) $d['id'], 'pfad' => substr((string) $d['pfad'], strlen(srt_eingang()) + 1), 'qualitaet' => (string) $d['qualitaet'],
        'dauer_ms' => (int) $d['dauer_ms'], 'groesse' => (int) $d['groesse'], 'titel' => (string) $d['aufnahme_titel'], 'kuenstler' => (string) $d['aufnahme_kuenstler'],
        'tag_titel' => (string) $d['tag_titel'], 'tag_kuenstler' => (string) $d['tag_kuenstler'], 'tag_album' => (string) $d['tag_album'],
        'sicherheit' => (int) $d['sicherheit'], 'manuell' => (bool) $d['manuell'], 'rolle' => (string) $d['rolle'], 'aktion' => srt_aktion($d),
        'aktion_gewaehlt' => (string) $d['aktion'], 'dublette_von' => $d['dublette_von'] !== null ? (int) $d['dublette_von'] : null,
        'bibliothek' => (string) $d['bibliothek_info'], 'besser' => (bool) ($d['besser'] ?? false), 'ersetzbar' => (bool) ($d['besser'] ?? false) && srt_beschreibbar((string) $d['pfad']), 'fehler' => (string) $d['fehler'], 'erledigt' => (string) $d['erledigt'], 'meldung' => (string) $d['meldung'],
    ];
}

/** Ein Album mit seinen Dateien (und Position auf dem Release, soweit bekannt) */
function srt_album_detail(int $id): array
{
    $a = db_zeile('SELECT a.*, r.* FROM sortier_alben a JOIN sortier_releases r ON r.mbid = a.release_mbid WHERE a.id = :id', ['id' => $id]);
    if (!$a) {
        throw new SrtFehler(t('Album nicht gefunden.'), 404);
    }
    $dateien = [];
    foreach (db_alle("SELECT * FROM sortier_dateien WHERE album_id = :a ORDER BY id", ['a' => $id]) as $d) {
        $t = json_decode((string) $d['treffer'], true) ?: [];
        $pos = null;
        foreach ($t['rels'] ?? [] as $f) {
            if ($f[0] === $a['release_mbid'] && $f[2]) {
                $pos = ['disc' => (int) $f[1], 'pos' => (int) $f[2]];
                break;
            }
        }
        $dateien[] = srt_datei_aussen($d) + ['position' => $pos];
    }
    usort($dateien, static fn($x, $y) => [$x['position']['disc'] ?? 99, $x['position']['pos'] ?? 999, $x['id']] <=> [$y['position']['disc'] ?? 99, $y['position']['pos'] ?? 999, $y['id']]);
    // Dubletten der Album-Titel gleich mit anzeigen
    $ids = array_column($dateien, 'id');
    $dubl = [];
    if ($ids) {
        [$in, $pp] = db_in($ids);
        foreach (db_alle("SELECT * FROM sortier_dateien WHERE dublette_von IN {$in} AND erledigt = ''", $pp) as $d) {
            $dubl[] = srt_datei_aussen($d);
        }
    }
    return ['album' => srt_release_aussen($a) + ['id' => (int) $a['id'], 'aktiv' => (bool) $a['aktiv'], 'status' => (string) $a['status'], 'in_bibliothek' => $a['edition_id'] !== null],
        'dateien' => $dateien, 'dubletten' => $dubl, 'alternativen' => srt_alternativen($id)];
}

/** Dateien einer Rolle (Dubletten, Bibliothek, Unerkannt, Fehler), seitenweise */
function srt_dateien_liste(string $rolle, int $seite = 1, int $proSeite = 100): array
{
    $rollen = match ($rolle) {
        'unerkannt' => ['unerkannt', 'ohne_album', 'fehler'],
        'dublette' => ['dublette'],
        'bibliothek' => ['bibliothek'],
        default => throw new SrtFehler(t('Unbekannte Liste.'), 422),
    };
    [$in, $pp] = db_in($rollen);
    $n = (int) db_wert("SELECT COUNT(*) FROM sortier_dateien WHERE erledigt = '' AND rolle IN {$in}", $pp);
    $ab = max(0, ($seite - 1) * $proSeite);
    $liste = db_alle("SELECT * FROM sortier_dateien WHERE erledigt = '' AND rolle IN {$in} ORDER BY pfad LIMIT " . (int) $proSeite . ' OFFSET ' . (int) $ab, $pp);
    $vonIds = array_values(array_unique(array_filter(array_map(static fn($d) => $d['dublette_von'], $liste))));
    $von = [];
    if ($vonIds) {
        [$in2, $pp2] = db_in($vonIds, 'v');
        foreach (db_alle("SELECT id, pfad, qualitaet, dauer_ms FROM sortier_dateien WHERE id IN {$in2}", $pp2) as $v) {
            $von[(int) $v['id']] = ['pfad' => substr((string) $v['pfad'], strlen(srt_eingang()) + 1), 'qualitaet' => (string) $v['qualitaet'], 'dauer_ms' => (int) $v['dauer_ms']];
        }
    }
    return ['gesamt' => $n, 'seite' => $seite, 'dateien' => array_map(static fn($d) => srt_datei_aussen($d) + ['behalten' => $von[(int) ($d['dublette_von'] ?? 0)] ?? null], $liste)];
}
