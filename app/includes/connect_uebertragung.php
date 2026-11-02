<?php
declare(strict_types=1);
// Amberwave Connect – Übertragung: liefern (Datei oder umgewandelte Fassung in Stücken), holen (Aufträge in der
// Warteschlange, fortsetzbar), Tempogrenze (für alle Übertragungen zusammen) und Reinhören über den eigenen Server.
require_once __DIR__ . '/connect.php';
require_once __DIR__ . '/schreibschutz.php';

const CONNECT_DATEI_MAX = 4 * 1024 * 1024 * 1024;   // größer wird keine einzelne Datei geholt (4 GB)
const CONNECT_FREI_MIN = 2 * 1024 * 1024 * 1024;    // so viel Platz bleibt auf dem Musikordner immer frei (2 GB)
const CONNECT_ENDUNG = ['opus256' => 'opus', 'opus160' => 'opus', 'opus128' => 'opus', 'aac256' => 'm4a', 'aac160' => 'm4a', 'flac1644' => 'flac'];

// ---------- Tempo ----------

/** Grenze in Mbit/s für eine Richtung (0 = keine), unter Berücksichtigung von „nachts frei“ und „im Heimnetz frei“ */
function connect_grenze(string $richtung, bool $heimnetz): float
{
    // Langläufer (Arbeiter, Rückkanal) sollen Änderungen an der Grenze mitbekommen: Einstellungs-Cache alle 30 s leeren
    static $frisch = 0;
    if (PHP_SAPI === 'cli' && time() - $frisch > 30) {
        $frisch = time();
        einstellung_db_wert('__reset__');
    }
    if ($heimnetz && einstellung('connect_heim_frei') === '1') {
        return 0.0;
    }
    if (einstellung('connect_nachts_frei') === '1' && (int) date('G') < 6) {
        return 0.0;
    }
    return max(0.0, (float) str_replace(',', '.', einstellung($richtung === 'hoch' ? 'connect_hoch_mbit' : 'connect_runter_mbit')));
}

/**
 * Wartet, bis $bytes in dieser Richtung übertragen werden dürfen. Alle Prozesse teilen sich einen Zeitplan in einer
 * Datei: jede Übertragung reserviert ihr Zeitfenster hinter der vorigen – so gilt die Grenze für alle zusammen.
 */
function connect_tempo_warten(string $richtung, int $bytes, bool $heimnetz): void
{
    $mbit = connect_grenze($richtung, $heimnetz);
    if ($mbit <= 0 || $bytes <= 0) {
        return;
    }
    $fp = fopen(connect_ordner() . '/tempo_' . ($richtung === 'hoch' ? 'hoch' : 'runter'), 'c+');
    if (!$fp) {
        return;
    }
    flock($fp, LOCK_EX);
    $naechste = (float) stream_get_contents($fp);
    $jetzt = microtime(true);
    if ($naechste > $jetzt + 120) {
        $naechste = $jetzt;   // Uhr ist zurückgesprungen (NTP, Standby): Zeitplan nicht in der Zukunft kleben lassen
    }
    $start = max($jetzt, $naechste < $jetzt - 2 ? $jetzt : $naechste);
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, (string) ($start + $bytes * 8 / ($mbit * 1e6)));
    flock($fp, LOCK_UN);
    fclose($fp);
    if ($start > $jetzt) {
        usleep((int) min(60e6, ($start - $jetzt) * 1e6));
    }
}

/** Ausgabe in kleinen Scheiben (64 KB), jede nach der Tempogrenze – gleichmäßig statt in Stößen */
function connect_ausgeben(string $daten, string $richtung, bool $heimnetz): void
{
    $begrenzt = connect_grenze($richtung, $heimnetz) > 0;
    if (!$begrenzt) {
        echo $daten;
        return;
    }
    $n = strlen($daten);
    for ($i = 0; $i < $n; $i += 65536) {
        $teil = substr($daten, $i, 65536);
        connect_tempo_warten($richtung, strlen($teil), $heimnetz);
        echo $teil;
        @ob_flush();
        flush();
    }
}

/** Stückgröße beim Holen: bei enger Grenze kleiner, damit Fortschritt und Abbrechen flüssig bleiben */
function connect_stueck_groesse(bool $heimnetz): int
{
    $mbit = connect_grenze('runter', $heimnetz);
    if ($mbit <= 0) {
        return CONNECT_STUECK;
    }
    return (int) max(256 * 1024, min(CONNECT_STUECK, $mbit * 1e6 / 8 * 4));
}

// ---------- Liefern ----------

/** Datei (oder umgewandelte Fassung) in einem Stück ab Byte $ab liefern: [kopf, bytes] */
function connect_datei_liefern(int $track, string $q, int $ab, int $laenge): array
{
    require_once __DIR__ . '/stream.php';
    if (!in_array($q, CONNECT_QUALITAETEN, true)) {
        $q = 'original';
    }
    [$pfad, $d] = stream_datei($track);
    $endung = strtolower(pathinfo($pfad, PATHINFO_EXTENSION));
    if ($q !== 'original') {
        $pfad = connect_umwandeln($pfad, $track, $q, $d);
        $endung = CONNECT_ENDUNG[$q];
    }
    $groesse = (int) filesize($pfad);
    $laenge = max(1, min(CONNECT_STUECK, $laenge));
    $ab = max(0, min($groesse, $ab));
    $fh = fopen($pfad, 'rb');
    fseek($fh, $ab);
    $bytes = $laenge > 0 && $ab < $groesse ? (string) fread($fh, min($laenge, $groesse - $ab)) : '';
    fclose($fh);
    return [['groesse' => $groesse, 'ab' => $ab, 'endung' => $endung, 'qualitaet' => $q], $bytes];
}

/** Umgewandelte Fassung im Cache (einmal erzeugt, danach wiederverwendet; Älteres wird aufgeräumt) */
function connect_umwandeln(string $pfad, int $track, string $q, array $d): string
{
    $ordner = connect_ordner('umwandlung');
    $ziel = $ordner . '/' . $track . '-' . $q . '-' . substr(md5($pfad . '|' . filemtime($pfad)), 0, 10) . '.' . CONNECT_ENDUNG[$q];
    if (is_file($ziel)) {
        @touch($ziel);
        return $ziel;
    }
    // Nur ein Prozess wandelt dieselbe Datei um; die anderen warten auf ihn
    $sperre = fopen($ziel . '.sperre', 'c');
    flock($sperre, LOCK_EX);
    try {
        if (is_file($ziel)) {
            return $ziel;
        }
        if ($q === 'flac1644' && (int) ($d['bittiefe'] ?? 16) <= 16 && (int) ($d['abtastrate'] ?? 44100) <= 48000 && strtolower(pathinfo($pfad, PATHINFO_EXTENSION)) === 'flac') {
            return $pfad;   // ist schon CD-Qualität
        }
        $codec = match ($q) {
            'opus256' => '-c:a libopus -b:a 256k -vbr on',
            'opus160' => '-c:a libopus -b:a 160k -vbr on',
            'opus128' => '-c:a libopus -b:a 128k -vbr on',
            'aac256' => '-c:a aac -b:a 256k -movflags +faststart',
            'aac160' => '-c:a aac -b:a 160k -movflags +faststart',
            default => '-c:a flac -sample_fmt s16 -ar ' . ((int) ($d['abtastrate'] ?? 44100) % 48000 === 0 ? '48000' : '44100'),
        };
        $tmp = $ziel . '.' . getmypid() . '.tmp.' . CONNECT_ENDUNG[$q];
        $cmd = aw_arg(konfig()['stream']['ffmpeg']) . ' -nostdin -hide_banner -loglevel error -y -i ' . aw_arg($pfad)
            . ' -map 0:a:0 -map_metadata 0 ' . $codec . ' ' . aw_arg($tmp) . aw_ohne_fehler();
        exec($cmd, $o, $rc);
        if ($rc !== 0 || !is_file($tmp) || filesize($tmp) < 1000) {
            @unlink($tmp);
            throw new ApiFehler(t('Die Datei ließ sich nicht umwandeln.'), 500);
        }
        rename($tmp, $ziel);
        // Aufräumen: Umgewandeltes, das eine Woche niemand mehr geholt hat
        foreach (glob($ordner . '/*') ?: [] as $f) {
            if (is_file($f) && filemtime($f) < time() - 7 * 86400) {
                @unlink($f);
            }
        }
        return $ziel;
    } finally {
        flock($sperre, LOCK_UN);
        fclose($sperre);
        @unlink($ziel . '.sperre');
    }
}

// ---------- Aufträge (holen) ----------

function connect_qualitaet_standard(array $peer): string
{
    if ($peer['weg_art'] === 'heimnetz' && einstellung('connect_heim_original') === '1') {
        return 'original';
    }
    $q = einstellung('connect_qualitaet');
    return in_array($q, CONNECT_QUALITAETEN, true) ? $q : 'opus256';
}

function connect_auftrag_anlegen(int $serverId, string $art, int $ref, string $qualitaet, ?int $userId, string $titel = '', string $unter = ''): int
{
    if (!in_array($art, ['album', 'titel', 'playlist'], true) || $ref <= 0) {
        throw new ApiFehler(t('Unbekannte Art.'), 400);
    }
    $peer = connect_server($serverId);
    require_once __DIR__ . '/schreibschutz.php';
    if (!musik_schreiben_erlaubt()) {
        throw new ApiFehler(musik_schreibschutz_text(), 409);
    }
    if (!in_array($qualitaet, CONNECT_QUALITAETEN, true)) {
        $qualitaet = connect_qualitaet_standard($peer);
    }
    // Läuft dasselbe schon? Dann nicht doppelt
    $da = db_wert("SELECT id FROM connect_auftraege WHERE server_id = :s AND art = :a AND ref = :r AND status IN ('wartet', 'laeuft')",
        ['s' => $serverId, 'a' => $art, 'r' => (string) $ref]);
    if ($da) {
        return (int) $da;
    }
    $id = (int) db_einfuegen('INSERT INTO connect_auftraege (server_id, art, ref, titel, unter, qualitaet, user_id) VALUES (:s, :a, :r, :t, :u, :q, :uid)',
        ['s' => $serverId, 'a' => $art, 'r' => (string) $ref, 't' => mb_substr($titel, 0, 400), 'u' => mb_substr($unter, 0, 400), 'q' => $qualitaet, 'uid' => $userId]);
    connect_arbeiter_anstossen();
    return $id;
}

function connect_arbeiter_anstossen(): void
{
    if (connect_arbeiter_laeuft()) {
        return;
    }
    aw_hintergrund(aw_arg(aw_php()) . ' ' . aw_arg(__DIR__ . '/../scripts/connect.php'), konfig()['pfade']['cache'] . '/tmp/connect.log', true);
}

function connect_arbeiter_laeuft(): bool
{
    $fp = @fopen(connect_ordner() . '/arbeiter.sperre', 'c');
    if (!$fp) {
        return false;
    }
    $frei = flock($fp, LOCK_EX | LOCK_NB);
    if ($frei) {
        flock($fp, LOCK_UN);
    }
    fclose($fp);
    return !$frei;
}

function connect_auftrag_objekt(array $z): array
{
    return ['id' => (int) $z['id'], 'server_id' => (int) $z['server_id'], 'server' => (string) ($z['server_name'] ?? ''), 'art' => $z['art'], 'ref' => (int) $z['ref'],
        'titel' => $z['titel'], 'unter' => $z['unter'], 'qualitaet' => $z['qualitaet'], 'status' => $z['status'], 'fehler' => $z['fehler'],
        'bytes' => (int) $z['bytes'], 'gesamt' => (int) $z['gesamt'], 'dateien' => (int) $z['dateien'], 'fertig' => (int) $z['fertig'],
        'erstellt' => iso($z['erstellt_am']), 'fertig_am' => iso($z['fertig_am'])];
}

function connect_auftraege(): array
{
    return array_map('connect_auftrag_objekt', db_alle('SELECT a.*, s.name AS server_name FROM connect_auftraege a LEFT JOIN connect_server s ON s.id = a.server_id
        ORDER BY (a.status IN (\'laeuft\', \'wartet\')) DESC, a.id DESC LIMIT 100'));
}

/** Zielpfad (relativ zum Musikordner) für einen geholten Titel */
function connect_zielpfad(array $peer, array $t, string $endung): string
{
    require_once __DIR__ . '/aufraeumen.php';
    $ordner = trim(einstellung('connect_ordner'), '/ ') ?: 'Connect';
    $album = $t['album'] . ($t['jahr'] ? ' (' . $t['jahr'] . ')' : '');
    $nr = preg_match('/^\d+$/', (string) $t['nummer']) ? str_pad((string) $t['nummer'], 2, '0', STR_PAD_LEFT) : af_sicher((string) $t['nummer']);
    $name = ($t['discs'] > 1 ? $t['disc'] . '-' : '') . $nr . ' ' . $t['titel'];
    return implode('/', [af_sicher($ordner), af_sicher($peer['name'] ?: $peer['kennung']), af_sicher($t['album_kuenstler'] ?: $t['kuenstler'] ?: '?'),
        af_sicher($album ?: '?'), af_sicher($name) . '.' . $endung]);
}

/** Haben wir diesen Titel schon (gleiche MusicBrainz-Aufnahme mit Datei)? */
function connect_schon_da(array $t): bool
{
    if (($t['aufnahme_mbid'] ?? '') === '') {
        return false;
    }
    return (bool) db_wert("SELECT 1 FROM aufnahmen au JOIN tracks t ON t.aufnahme_id = au.id JOIN dateien d ON d.track_id = t.id AND d.fehler = ''
        WHERE au.mbid = :m LIMIT 1", ['m' => $t['aufnahme_mbid']]);
}

/** Arbeiter: alle offenen Aufträge abarbeiten (höchstens ~50 Minuten, dann übernimmt der nächste Lauf) */
final class ConnectZeitUm extends RuntimeException {}

function connect_arbeiten(): void
{
    $fp = fopen(connect_ordner() . '/arbeiter.sperre', 'c');
    if (!$fp || !flock($fp, LOCK_EX | LOCK_NB)) {
        return;
    }
    $ende = time() + 3000;
    $zurueck = [];   // Aufträge, die in diesem Lauf schon gescheitert sind – die anderen kommen dran
    try {
        while (time() < $ende) {
            $sql = "SELECT * FROM connect_auftraege WHERE status IN ('laeuft', 'wartet')";
            if ($zurueck) {
                $sql .= ' AND id NOT IN (' . implode(',', array_map('intval', $zurueck)) . ')';
            }
            $a = db_zeile($sql . " ORDER BY status = 'laeuft' DESC, id LIMIT 1");
            if (!$a) {
                break;
            }
            try {
                connect_auftrag_ausfuehren($a, $ende);
            } catch (ConnectZeitUm $e) {
                break;   // kein Fehler: der nächste Lauf macht weiter
            } catch (Throwable $e) {
                $fehler = mb_substr($e->getMessage(), 0, 500);
                $neu = (int) db_wert('SELECT COUNT(*) FROM connect_dateien WHERE auftrag_id = :a AND status = \'fertig\'', ['a' => $a['id']]);
                // Netz weg o. Ä.: Auftrag bleibt offen und geht später weiter – erst nach wiederholtem Scheitern als Fehler
                $alle = json_decode((string) @file_get_contents(connect_ordner() . '/versuche.json'), true) ?: [];
                $bytesJetzt = (int) db_wert('SELECT bytes FROM connect_auftraege WHERE id = :id', ['id' => $a['id']]);
                // Fortschritt seit dem letzten Fehler? Dann zählt der Zähler von vorn (Abbrüche über Tage sind kein Scheitern)
                $versuche = ($alle['b' . $a['id']] ?? -1) === $bytesJetzt ? (int) ($alle[$a['id']] ?? 0) + 1 : 1;
                // Dauerhafte Hindernisse (Schreibschutz, Rechte) gleich als Fehler – Wiederholen bringt da nichts
                if (!musik_schreiben_erlaubt() || ($e instanceof ApiFehler && in_array($e->getCode(), [400, 403, 404], true))) {
                    $versuche = 30;
                }
                $alle[$a['id']] = $versuche;
                $alle['b' . $a['id']] = $bytesJetzt;
                @file_put_contents(connect_ordner() . '/versuche.json', json_encode($alle), LOCK_EX);
                db_tun('UPDATE connect_auftraege SET status = :s, fehler = :f, fertig = :n WHERE id = :id',
                    ['s' => $versuche >= 30 ? 'fehler' : 'laeuft', 'f' => $fehler, 'n' => $neu, 'id' => $a['id']]);
                if ($versuche < 30) {
                    $zurueck[] = (int) $a['id'];   // später weiter (der Zeitplan stößt jede Minute an) – erst die anderen
                }
            }
        }
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

function connect_auftrag_ausfuehren(array $a, int $ende): void
{
    require_once __DIR__ . '/aufraeumen.php';
    $peer = connect_server((int) $a['server_id']);
    db_tun("UPDATE connect_auftraege SET status = 'laeuft' WHERE id = :id AND status = 'wartet'", ['id' => $a['id']]);
    // Dateiliste beim ersten Mal anlegen
    if (!db_wert('SELECT 1 FROM connect_dateien WHERE auftrag_id = :a LIMIT 1', ['a' => $a['id']])) {
        [$kopf] = connect_rufen($peer, 'liste', ['art' => $a['art'], 'id' => (int) $a['ref']]);
        $peer = connect_server((int) $a['server_id']);
        $gesamt = 0;
        $erster = null;
        foreach ((array) ($kopf['titel'] ?? []) as $t) {
            $erster ??= $t;
            if (connect_schon_da($t)) {
                continue;
            }
            $endung = $a['qualitaet'] === 'original' ? strtolower((string) $t['format']) : CONNECT_ENDUNG[$a['qualitaet']];
            if (!preg_match('/^[a-z0-9]{1,5}$/', $endung)) {
                $endung = 'bin';   // nur eine schlichte Endung – nie Pfadteile vom anderen Server
            }
            if ((int) $t['groesse'] > CONNECT_DATEI_MAX) {
                continue;   // unplausibel groß – wird übersprungen
            }
            $ziel = connect_zielpfad($peer, $t, $endung === 'aac' ? 'm4a' : $endung);
            db_einfuegen('INSERT INTO connect_dateien (auftrag_id, track_ref, ziel, groesse) VALUES (:a, :t, :z, :g)',
                ['a' => $a['id'], 't' => (int) $t['track'], 'z' => $ziel, 'g' => $a['qualitaet'] === 'original' ? (int) $t['groesse'] : 0]);
            $gesamt += $a['qualitaet'] === 'original' ? (int) $t['groesse'] : (int) round(((int) $t['laenge_ms']) / 1000 * ((int) preg_replace('/\D/', '', $a['qualitaet']) ?: 900) * 125);
        }
        $n = (int) db_wert('SELECT COUNT(*) FROM connect_dateien WHERE auftrag_id = :a', ['a' => $a['id']]);
        $titel = $a['titel'] !== '' ? $a['titel'] : (string) ($erster['album'] ?? '');
        db_tun('UPDATE connect_auftraege SET dateien = :n, gesamt = :g, titel = :t WHERE id = :id', ['n' => $n, 'g' => $gesamt, 't' => $titel, 'id' => $a['id']]);
        if ($n === 0) {
            db_tun("UPDATE connect_auftraege SET status = 'fertig', fehler = :f, fertig_am = NOW() WHERE id = :id",
                ['f' => count((array) ($kopf['titel'] ?? [])) ? t('Alles schon vorhanden.') : t('Dort liegen keine Dateien dazu.'), 'id' => $a['id']]);
            return;
        }
        // Cover für den Album-Ordner
        if ($erster && $erster['cover'] !== '') {
            try {
                [, $bild] = connect_rufen($peer, 'bild', ['art' => 'cover', 'schluessel' => $erster['cover'], 'g' => 1200]);
                $z1 = db_wert('SELECT ziel FROM connect_dateien WHERE auftrag_id = :a ORDER BY id LIMIT 1', ['a' => $a['id']]);
                $abs = konfig()['pfade']['musik'] . '/' . dirname((string) $z1);
                if (connect_bild_plausibel($bild) && af_ordner_anlegen($abs) && !is_file($abs . '/cover.jpg')) {
                    file_put_contents($abs . '/cover.jpg', $bild);
                }
            } catch (Throwable $e) {
                // ohne Cover geht es auch
            }
        }
    }
    $wurzel = rtrim((string) konfig()['pfade']['musik'], '/');
    foreach (db_alle("SELECT * FROM connect_dateien WHERE auftrag_id = :a AND status <> 'fertig' ORDER BY id", ['a' => $a['id']]) as $d) {
        $abs = $wurzel . '/' . $d['ziel'];
        if (!af_ordner_anlegen(dirname($abs))) {
            throw new ApiFehler(t('Der Musikordner ist nicht beschreibbar – Musik kann hier nicht abgelegt werden.'));
        }
        $teil = $abs . '.amberwave-teil';
        if (is_file($abs)) {
            // liegt schon da (von Hand abgelegt oder frühere Übertragung): nicht noch einmal holen
            db_tun("UPDATE connect_dateien SET status = 'fertig', bytes = groesse WHERE id = :id", ['id' => $d['id']]);
            db_tun('UPDATE connect_auftraege SET fertig = fertig + 1 WHERE id = :id', ['id' => $a['id']]);
            continue;
        }
        $ab = is_file($teil) ? (int) filesize($teil) : 0;
        $groesse = (int) $d['groesse'];
        while ($groesse === 0 || $ab < $groesse) {
            $stand = (string) db_wert('SELECT status FROM connect_auftraege WHERE id = :id', ['id' => $a['id']]);
            if ($stand !== 'laeuft') {
                return;   // abgebrochen oder pausiert
            }
            if (time() > $ende) {
                throw new ConnectZeitUm();
            }
            $heim = $peer['weg_art'] === 'heimnetz';
            $stueck = connect_stueck_groesse($heim);
            [$kopf, $bytes] = connect_rufen($peer, 'datei', ['track' => (int) $d['track_ref'], 'qualitaet' => $a['qualitaet'], 'ab' => $ab, 'laenge' => $stueck], 300);
            $peer = connect_server((int) $a['server_id']);
            if ((int) $kopf['groesse'] > CONNECT_DATEI_MAX) {
                throw new ApiFehler(t('Die Datei ist zu groß.'), 400);
            }
            if ($groesse !== 0 && $ab > 0 && (int) $kopf['groesse'] !== $groesse) {
                // Die Quelle hat sich unterwegs geändert (neu getaggt, neu umgewandelt): von vorn, sonst klebt Altes an Neuem
                @unlink($teil);
                $ab = 0;
                $groesse = (int) $kopf['groesse'];
                db_tun('UPDATE connect_dateien SET groesse = :g, bytes = 0 WHERE id = :id', ['g' => $groesse, 'id' => $d['id']]);
                continue;
            }
            if ($groesse === 0 || (int) $kopf['groesse'] !== $groesse) {
                $groesse = (int) $kopf['groesse'];
                db_tun('UPDATE connect_dateien SET groesse = :g WHERE id = :id', ['g' => $groesse, 'id' => $d['id']]);
            }
            if ((int) $kopf['ab'] !== $ab) {
                throw new RuntimeException(t('Unerwartete Antwort beim Holen.'));
            }
            if ($bytes === '' && $ab < $groesse) {
                throw new RuntimeException(t('Leere Antwort beim Holen.'));
            }
            connect_tempo_warten('runter', strlen($bytes), $heim);
            $frei = @disk_free_space(dirname($abs));
            if ($frei !== false && $frei < CONNECT_FREI_MIN) {
                throw new ApiFehler(t('Zu wenig Platz im Musikordner – unter {mb} MB frei.', ['mb' => (int) (CONNECT_FREI_MIN / 1048576)]), 507);
            }
            $geschrieben = @file_put_contents($teil, $bytes, FILE_APPEND | LOCK_EX);
            if ($geschrieben !== strlen($bytes)) {
                // Schreibfehler (Platte voll, Rechte): auf den sicher geschriebenen Stand zurück, nicht weiterzählen
                $h = @fopen($teil, 'r+');
                if ($h) {
                    ftruncate($h, $ab);
                    fclose($h);
                }
                throw new RuntimeException(t('Die Datei ließ sich nicht schreiben – ist der Musikordner voll?'));
            }
            $ab += strlen($bytes);
            db_tun('UPDATE connect_dateien SET bytes = :b, status = \'laeuft\' WHERE id = :id', ['b' => $ab, 'id' => $d['id']]);
            db_tun('UPDATE connect_auftraege SET bytes = (SELECT COALESCE(SUM(bytes), 0) FROM connect_dateien WHERE auftrag_id = :a),
                gesamt = GREATEST(gesamt, (SELECT COALESCE(SUM(groesse), 0) FROM connect_dateien WHERE auftrag_id = :a2)), fehler = \'\' WHERE id = :id',
                ['a' => $a['id'], 'a2' => $a['id'], 'id' => $a['id']]);
            if ($groesse === 0) {
                break;
            }
        }
        clearstatcache(true, $teil);
        if ($groesse > 0 && is_file($teil) && filesize($teil) !== $groesse) {
            @unlink($teil);
            db_tun('UPDATE connect_dateien SET bytes = 0 WHERE id = :id', ['id' => $d['id']]);
            throw new RuntimeException(t('Die Datei kam unvollständig an – wird neu geholt.'));
        }
        if (is_file($abs)) {
            @unlink($teil);   // gibt es schon (z. B. von Hand abgelegt) – nicht überschreiben
        } else {
            rename($teil, $abs);
            af_datei_rechte($abs);
        }
        db_tun("UPDATE connect_dateien SET status = 'fertig', bytes = groesse WHERE id = :id", ['id' => $d['id']]);
        db_tun('UPDATE connect_auftraege SET fertig = fertig + 1 WHERE id = :id', ['id' => $a['id']]);
    }
    db_tun("UPDATE connect_auftraege SET status = 'fertig', fehler = '', fertig_am = NOW(), bytes = gesamt WHERE id = :id", ['id' => $a['id']]);
    // Beiwerk mitnehmen: Künstlerbilder, Biografien, Albumtexte (übernommen, sobald die Bibliothek die Musik kennt)
    try {
        connect_beiwerk_holen($peer, $a);
    } catch (Throwable $e) {
        error_log('Connect: Beiwerk: ' . log_sauber($e->getMessage()));
    }
    // Einlesen, damit es gleich in der Bibliothek steht
    try {
        require_once __DIR__ . '/scanner.php';
        if (!scan_laufend()) {
            scan_starten(false, $a['user_id'] !== null ? (int) $a['user_id'] : null);
        }
    } catch (Throwable $e) {
        error_log('Connect: Einlesen anstoßen: ' . log_sauber($e->getMessage()));
    }
}

// ---------- Reinhören und Bilder über den eigenen Server ----------

/** GET /connect/server/{id}/stream/{track}?q=… – mit Range, damit der Player springen kann */
function connect_stream_senden(int $serverId, int $track): void
{
    $peer = connect_server($serverId);
    // Reinhören immer Opus 256 – AAC 256 für Browser ohne Opus, FLAC 16/44,1 für die Windows-Engine (kann kein Opus)
    $q = (string) ($_GET['q'] ?? 'opus256');
    if (!in_array($q, ['opus256', 'aac256', 'flac1644'], true)) {
        $q = 'opus256';
    }
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    $start = 0;
    $bis = null;
    if (preg_match('/bytes=(\d+)-(\d*)/', (string) ($_SERVER['HTTP_RANGE'] ?? ''), $m)) {
        $start = (int) $m[1];
        $bis = $m[2] !== '' ? (int) $m[2] : null;
    }
    $stueck = 1024 * 1024;
    [$kopf, $bytes] = connect_rufen($peer, 'datei', ['track' => $track, 'qualitaet' => $q, 'ab' => $start, 'laenge' => $stueck, 'zweck' => 'hoeren'], 120);
    $groesse = (int) $kopf['groesse'];
    $bis = $bis === null ? $groesse - 1 : min($bis, $groesse - 1);
    if ($start >= $groesse || $start > $bis) {
        // Bereich hinter dem Dateiende: 416 statt einer leeren 206-Antwort (so erwarten es Player laut RFC 9110)
        db_schliessen();
        http_response_code(416);
        header('Content-Range: bytes */' . $groesse);
        header('Content-Length: 0');
        exit;
    }
    $mime =['opus' => 'audio/ogg', 'm4a' => 'audio/mp4', 'flac' => 'audio/flac', 'mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg', 'wav' => 'audio/wav'][$kopf['endung']] ?? 'application/octet-stream';
    db_schliessen();
    header('Content-Type: ' . $mime);
    header('Accept-Ranges: bytes');
    header('Cache-Control: no-store');
    if (isset($_SERVER['HTTP_RANGE'])) {
        http_response_code(206);
        header("Content-Range: bytes {$start}-{$bis}/{$groesse}");
    }
    header('Content-Length: ' . max(0, $bis - $start + 1));
    $pos = $start;
    while ($pos <= $bis && $bytes !== '' && !connection_aborted()) {
        $teil = substr($bytes, 0, $bis - $pos + 1);
        echo $teil;
        @ob_flush();
        flush();
        $pos += strlen($teil);
        if ($pos > $bis) {
            break;
        }
        [, $bytes] = connect_rufen($peer, 'datei', ['track' => $track, 'qualitaet' => $q, 'ab' => $pos, 'laenge' => $stueck, 'zweck' => 'hoeren'], 120);
    }
    exit;
}

/** GET /connect/server/{id}/bild/{art}/{schluessel}?g=… – Bilder der Gegenstelle, hier zwischengespeichert */
/**
 * Was vom anderen Server kommt, ist Fremddaten: IDs und Zahlen werden zu Zahlen, Bild-Adressen dürfen nur auf unseren
 * eigenen Bild-Proxy zeigen (keine Fremd-URLs, die Nutzer beim Stöbern verraten oder Mixed Content auslösen).
 */
function connect_antwort_saeubern(array &$d, int $serverId): void
{
    static $zahlen = ['id', 'edition_id', 'aufnahme_id', 'album_id', 'jahr', 'nr', 'disc', 'discs', 'laenge_ms', 'tracks', 'anzahl', 'gesamt', 'seite', 'pro_seite', 'alben', 'user_id', 'eintrag_id'];
    static $bilder = ['cover', 'cover_gross', 'bild'];
    $praefix = '/api/v1/connect/server/' . $serverId . '/bild/';
    foreach ($d as $k => &$v) {
        if (is_array($v)) {
            connect_antwort_saeubern($v, $serverId);
        } elseif (is_string($k) && in_array($k, $zahlen, true) && !is_int($v) && $v !== null && !is_bool($v)) {
            $v = is_numeric($v) ? (int) $v : 0;
        } elseif (is_string($k) && in_array($k, $bilder, true) && is_string($v) && $v !== '' && !str_starts_with($v, $praefix)) {
            $v = null;
        } elseif (is_string($k) && $k === 'farbe' && is_string($v) && !preg_match('/^#[0-9a-f]{6}$/', $v)) {
            $v = null;
        }
    }
    unset($v);
}

function connect_bild_senden(int $serverId, string $art, string $schluessel): void
{
    $g = max(32, min(1200, (int) ($_GET['g'] ?? 300)));
    if (!in_array($art, ['cover', 'kuenstler'], true) || !preg_match('/^[A-Za-z0-9_.-]{1,80}$/', $schluessel)) {
        throw new ApiFehler(t('Bild nicht gefunden.'), 404);
    }
    $datei = connect_ordner('bilder/' . $serverId) . "/{$art}-{$schluessel}-{$g}.jpg";
    if (!is_file($datei) || filemtime($datei) < time() - 7 * 86400) {
        try {
            [, $bytes] = connect_rufen(connect_server($serverId), 'bild', ['art' => $art, 'schluessel' => $schluessel, 'g' => $g], 30);
            if (!connect_bild_plausibel($bytes)) {
                throw new ApiFehler(t('Bild nicht gefunden.'), 404);
            }
            file_put_contents($datei, $bytes, LOCK_EX);
        } catch (Throwable $e) {
            if (!is_file($datei)) {
                throw $e;
            }
            @touch($datei);   // Gegenstelle gerade nicht da: das ältere Bild bleibt
        }
    }
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    header('Content-Type: image/jpeg');
    header('Cache-Control: private, max-age=604800');
    header('Content-Length: ' . filesize($datei));
    readfile($datei);
    exit;
}

/** Lesen in der Bibliothek der Gegenstelle – Bild-Adressen auf unseren Zwischenspeicher umgebogen, Titel gekennzeichnet */
const CONNECT_ABDRUCK_ALBUM = 1;
const CONNECT_ABDRUCK_TITEL = 2;
const CONNECT_ABDRUCK_FASSUNG = 1;      // hochzählen, wenn sich connect_schluessel ändert → alles neu rechnen

/**
 * Was haben wir selbst schon? Je Album/Titel mit Dateien steht ein Abdruck (md5 aus „Künstler|Titel“, normalisiert) in
 * connect_abdruecke – für den Künstlernamen und seine Schreibweise im Credit je einer. Gepflegt wird schrittweise: nur Zeilen,
 * die seit dem letzten Mal dazukamen, geändert wurden oder verschwunden sind (Datei weg, Künstler umbenannt). Ohne Änderung
 * an der Bibliothek kostet der Aufruf eine kurze Abfrage; die wird höchstens alle 20 s gemacht.
 */
function connect_abdruecke_pflegen(bool $erzwingen = false): void
{
    static $zuletzt = 0.0;
    if (!$erzwingen && microtime(true) - $zuletzt < 20) {
        return;
    }
    $zuletzt = microtime(true);
    $standDatei = connect_ordner() . '/abdruecke.json';
    $stand = json_decode((string) @file_get_contents($standDatei), true);
    $stand = is_array($stand) ? $stand : [];
    $jetzt = db_zeile("SELECT (SELECT MAX(aktualisiert_am) FROM tracks) AS t, (SELECT MAX(aktualisiert_am) FROM alben) AS a,
        (SELECT MAX(aktualisiert_am) FROM editionen) AS e, (SELECT MAX(aktualisiert_am) FROM kuenstler) AS k,
        (SELECT COUNT(*) FROM tracks) AS tn, (SELECT COUNT(*) FROM alben) AS an,
        (SELECT CONCAT(COUNT(*), '-', COALESCE(MAX(id), 0)) FROM dateien WHERE fehler = '') AS dn") ?: [];
    $marke = CONNECT_ABDRUCK_FASSUNG . '|' . implode('|', array_map('strval', $jetzt));
    if (!$erzwingen && ($stand['marke'] ?? '') === $marke) {
        return;
    }
    $sperre = @fopen(connect_ordner() . '/abdruecke.sperre', 'c');
    if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
        return;     // ein anderer Prozess ist gerade dabei – mit dem alten Stand weitermachen
    }
    try {
        $neu = ($stand['fassung'] ?? 0) !== CONNECT_ABDRUCK_FASSUNG;
        if ($neu) {
            db_tun('DELETE FROM connect_abdruecke');
        }
        $seit = $neu ? '1970-01-01 00:00:00' : (string) ($stand['seit'] ?? '1970-01-01 00:00:00');
        // 1) Zeilen weg, deren Vorlage sich geändert hat oder deren Künstler umbenannt wurde – die werden unten neu gerechnet
        db_tun('DELETE c FROM connect_abdruecke c JOIN tracks t ON t.id = c.ziel_id WHERE c.art = ' . CONNECT_ABDRUCK_TITEL . ' AND t.aktualisiert_am >= :s', ['s' => $seit]);
        db_tun('DELETE c FROM connect_abdruecke c JOIN alben a ON a.id = c.ziel_id LEFT JOIN editionen e ON e.id = a.anzeige_edition_id
            WHERE c.art = ' . CONNECT_ABDRUCK_ALBUM . ' AND (a.aktualisiert_am >= :s OR e.aktualisiert_am >= :s2)', ['s' => $seit, 's2' => $seit]);
        $credits = 'SELECT DISTINCT cn.credit_id FROM credit_namen cn JOIN kuenstler k ON k.id = cn.kuenstler_id WHERE k.aktualisiert_am >= :s';
        db_tun('DELETE c FROM connect_abdruecke c JOIN tracks t ON t.id = c.ziel_id WHERE c.art = ' . CONNECT_ABDRUCK_TITEL . ' AND t.credit_id IN (' . $credits . ')', ['s' => $seit]);
        db_tun('DELETE c FROM connect_abdruecke c JOIN alben a ON a.id = c.ziel_id WHERE c.art = ' . CONNECT_ABDRUCK_ALBUM . ' AND a.credit_id IN (' . $credits . ')', ['s' => $seit]);
        // 2) Zeilen weg, zu denen es nichts mehr gibt (gelöscht, keine brauchbare Datei mehr)
        db_tun('DELETE c FROM connect_abdruecke c LEFT JOIN dateien d ON d.track_id = c.ziel_id AND d.fehler = \'\' WHERE c.art = ' . CONNECT_ABDRUCK_TITEL . ' AND d.id IS NULL');
        db_tun('DELETE c FROM connect_abdruecke c LEFT JOIN alben a ON a.id = c.ziel_id LEFT JOIN editionen e ON e.id = a.anzeige_edition_id AND e.anzahl_dateien > 0
            WHERE c.art = ' . CONNECT_ABDRUCK_ALBUM . ' AND e.id IS NULL');
        // 3) Fehlende rechnen – häppchenweise, damit auch 100.000 Titel beim ersten Mal nicht den Speicher sprengen
        $kuenstlerJoin = 'JOIN credit_namen cn ON cn.credit_id = %s.credit_id AND cn.pos = (SELECT MIN(pos) FROM credit_namen WHERE credit_id = %s.credit_id)
            JOIN kuenstler k ON k.id = cn.kuenstler_id';
        $einfuegen = static function (int $art, array $zeilen): void {
            $werte = $p = [];
            foreach ($zeilen as $i => $r) {
                foreach (array_unique([connect_schluessel((string) $r['name'], (string) $r['titel']), connect_schluessel((string) $r['name_als'], (string) $r['titel'])]) as $j => $s) {
                    $werte[] = "({$art}, :i{$i}_{$j}, UNHEX(:h{$i}_{$j}))";
                    $p["i{$i}_{$j}"] = (int) $r['id'];
                    $p["h{$i}_{$j}"] = md5($s);
                }
            }
            if ($werte) {
                db_tun('INSERT IGNORE INTO connect_abdruecke (art, ziel_id, abdruck) VALUES ' . implode(',', $werte), $p);
            }
        };
        $letzte = 0;
        do {
            $z = db_alle('SELECT a.id, a.titel, k.name, cn.name_als FROM alben a JOIN editionen e ON e.id = a.anzeige_edition_id AND e.anzahl_dateien > 0 '
                . sprintf($kuenstlerJoin, 'a', 'a') . ' WHERE a.id > :l AND NOT EXISTS (SELECT 1 FROM connect_abdruecke c WHERE c.art = ' . CONNECT_ABDRUCK_ALBUM . ' AND c.ziel_id = a.id)
                ORDER BY a.id LIMIT 2000', ['l' => $letzte]);
            $einfuegen(CONNECT_ABDRUCK_ALBUM, $z);
            $letzte = $z ? (int) end($z)['id'] : 0;
        } while (count($z) === 2000);
        $letzte = 0;
        do {
            $z = db_alle('SELECT t.id, t.titel, k.name, cn.name_als FROM tracks t ' . sprintf($kuenstlerJoin, 't', 't') . '
                WHERE t.id > :l AND EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id AND d.fehler = \'\')
                AND NOT EXISTS (SELECT 1 FROM connect_abdruecke c WHERE c.art = ' . CONNECT_ABDRUCK_TITEL . ' AND c.ziel_id = t.id)
                ORDER BY t.id LIMIT 2000', ['l' => $letzte]);
            $einfuegen(CONNECT_ABDRUCK_TITEL, $z);
            $letzte = $z ? (int) end($z)['id'] : 0;
        } while (count($z) === 2000);
        // „seit“ ist der jüngste Zeitstempel, den wir gesehen haben – Änderungen in derselben Sekunde holt der nächste Lauf nach (>=)
        $seitNeu = max(array_filter([$jetzt['t'] ?? '', $jetzt['a'] ?? '', $jetzt['e'] ?? '', $jetzt['k'] ?? ''], 'strlen') ?: ['1970-01-01 00:00:00']);
        @file_put_contents($standDatei, json_encode(['fassung' => CONNECT_ABDRUCK_FASSUNG, 'marke' => $marke, 'seit' => $seitNeu]), LOCK_EX);
    } finally {
        flock($sperre, LOCK_UN);
        fclose($sperre);
    }
}

function connect_schluessel(string $kuenstler, string $titel): string
{
    require_once __DIR__ . '/hilfen.php';
    // Zusätze wie „(Remastered 2011)“ oder „[Deluxe]“ zählen nicht
    $titel = (string) preg_replace('/\s*[\(\[][^\)\]]*(remaster|deluxe|edition|version|expanded|anniversary|bonus)[^\)\]]*[\)\]]/iu', '', $titel);
    return name_norm($kuenstler) . '|' . name_norm($titel);
}

/** Welche dieser Schlüssel haben wir? Liefert je Art die Menge der getroffenen Schlüssel – eine Abfrage für die ganze Seite. */
function connect_abdruecke_treffer(array $schluessel): array
{
    $hash = [];
    foreach (array_unique($schluessel) as $s) {
        $hash[md5($s)] = $s;
    }
    $aus = [CONNECT_ABDRUCK_ALBUM => [], CONNECT_ABDRUCK_TITEL => []];
    foreach (array_chunk(array_keys($hash), 500) as $teil) {
        [$in, $p] = db_in(array_map('hex2bin', $teil), 'h');
        foreach (db_alle('SELECT DISTINCT art, HEX(abdruck) AS h FROM connect_abdruecke WHERE abdruck IN ' . $in, $p) as $r) {
            $aus[(int) $r['art']][$hash[strtolower((string) $r['h'])] ?? ''] = true;
        }
    }
    return $aus;
}

/** Alben und Titel eines anderen Servers markieren, die wir selbst schon haben (_da) */
function connect_markieren(string $methode, array &$d): void
{
    connect_abdruecke_pflegen();
    $schluesselVon = static function (array $x): ?string {
        $k = $x['kuenstler'][0]['name'] ?? '';
        return is_string($x['titel'] ?? null) ? connect_schluessel((string) $k, $x['titel']) : null;
    };
    $alle = [];
    foreach (['alben', 'gast'] as $f) {
        foreach ((array) ($d[$f] ?? []) as $a) {
            if (is_array($a) && ($s = $schluesselVon($a)) !== null) {
                $alle[] = $s;
            }
        }
    }
    foreach ((array) ($d['tracks'] ?? []) as $t) {
        if (is_array($t) && ($s = $schluesselVon($t)) !== null) {
            $alle[] = $s;
        }
    }
    if ($methode === 'album' && ($s = $schluesselVon($d)) !== null) {
        $alle[] = $s;
    }
    $l = $alle ? connect_abdruecke_treffer($alle) : [CONNECT_ABDRUCK_ALBUM => [], CONNECT_ABDRUCK_TITEL => []];
    $album = static function (array &$a) use ($l, $schluesselVon): void {
        if (($s = $schluesselVon($a)) !== null && isset($l[CONNECT_ABDRUCK_ALBUM][$s])) {
            $a['_da'] = true;
        }
    };
    $titel = static function (array &$t) use ($l, $schluesselVon): void {
        if (($s = $schluesselVon($t)) !== null && isset($l[CONNECT_ABDRUCK_TITEL][$s])) {
            $t['_da'] = true;
        }
    };
    foreach (['alben', 'gast'] as $f) {
        foreach ((array) ($d[$f] ?? []) as $i => $_) {
            if (is_array($d[$f][$i])) {
                $album($d[$f][$i]);
            }
        }
    }
    foreach ((array) ($d['tracks'] ?? []) as $i => $_) {
        if (is_array($d['tracks'][$i])) {
            $titel($d['tracks'][$i]);
        }
    }
    if ($methode === 'album') {
        $album($d);
        // Album gilt als da, wenn wir alle seine Titel haben (auch wenn es bei uns anders heißt)
        $n = count((array) ($d['tracks'] ?? []));
        if ($n && count(array_filter((array) $d['tracks'], static fn($t) => !empty($t['_da']))) === $n) {
            $d['_da'] = true;
        }
    }
}

function connect_lesen(int $serverId, string $methode, array $args): array
{
    $erlaubt = ['alben', 'album', 'kuenstler_liste', 'kuenstler', 'playlists', 'playlist', 'suche'];
    if (!in_array($methode, $erlaubt, true)) {
        throw new ApiFehler(t('Unbekannte Anfrage.'), 400);
    }
    $peer = connect_server($serverId);
    [$kopf] = connect_rufen($peer, $methode, $args);
    unset($kopf['ok'], $kopf['z'], $kopf['von'], $kopf['_gesehen']);
    $json = json_encode($kopf, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $json = preg_replace('#"/api/v1/bild/(cover|kuenstler)/([A-Za-z0-9_.-]+)(\?[^"]*)?"#', '"/api/v1/connect/server/' . $serverId . '/bild/$1/$2$3"', $json);
    $daten = json_decode((string) $json, true) ?: [];
    connect_antwort_saeubern($daten, $serverId);
    try {
        connect_markieren($methode, $daten);
    } catch (Throwable $e) {
        error_log('Connect: markieren: ' . log_sauber($e->getMessage()));
    }
    $daten['_server'] = connect_server_objekt(connect_server($serverId));
    return $daten;
}

// ---------- Rückkanal: die Seite ohne Adresse von außen ----------

function connect_rueckkanal_anstossen(): void
{
    if (!connect_rueck_partner()) {
        return;
    }
    $fp = @fopen(connect_ordner() . '/rueckkanal.sperre', 'c');
    if ($fp && flock($fp, LOCK_EX | LOCK_NB)) {
        flock($fp, LOCK_UN);
        fclose($fp);
        aw_hintergrund(aw_arg(aw_php()) . ' ' . aw_arg(__DIR__ . '/../scripts/connect_rueckkanal.php'), konfig()['pfade']['cache'] . '/tmp/connect_rueckkanal.log', true);
    } elseif ($fp) {
        fclose($fp);
    }
}

/**
 * Hält bei jedem erreichbaren Partner eine Anfrage „warten“ offen (alle gleichzeitig) und führt aus, was zurückkommt.
 * Läuft bis zu ~55 Minuten, dann startet der Zeitplan ihn neu (frische Partnerliste, frischer Prozess).
 */
function connect_rueckkanal_laufen(): void
{
    $fp = fopen(connect_ordner() . '/rueckkanal.sperre', 'c');
    if (!$fp || !flock($fp, LOCK_EX | LOCK_NB)) {
        return;
    }
    $ende = time() + 3300;
    $partner = [];
    $liste_am = 0;
    $pause = [];   // id => nicht vor (nach Fehlern)
    $mh = curl_multi_init();
    $griffe = [];  // id => curl
    $zs = [];      // id => Zufallswert der offenen Anfrage
    $weiter = false;
    try {
        while (true) {
            $auslaufen = time() > $ende - 50;   // kurz vor Schluss keine neuen „warten“ mehr – offene zu Ende lesen
            if (!$auslaufen && time() - $liste_am > 120) {
                $partner = [];
                foreach (connect_rueck_partner() as $p) {
                    $partner[(int) $p['id']] = $p;
                }
                $liste_am = time();
                if (!$partner && !$griffe) {
                    break;   // (nicht mehr) nötig
                }
            }
            if (!$auslaufen) {
                // für jeden Partner ohne offene Anfrage eine neue „warten“ stellen
                foreach ($partner as $id => $p) {
                    if (isset($griffe[$id]) || ($pause[$id] ?? 0) > time()) {
                        continue;
                    }
                    $basis = connect_rueck_basis($p);
                    if ($basis === null) {
                        $pause[$id] = time() + 30;
                        continue;
                    }
                    $ch = connect_curl($basis, connect_anfrage_bauen($p, 'warten', [], $z), 45);
                    curl_setopt($ch, CURLOPT_PRIVATE, (string) $id);
                    curl_multi_add_handle($mh, $ch);
                    $griffe[$id] = $ch;
                    $zs[$id] = $z;
                }
            }
            if (!$griffe) {
                if ($auslaufen) {
                    $weiter = (bool) $partner;
                    break;
                }
                sleep(2);
                continue;
            }
            curl_multi_exec($mh, $laufend);
            curl_multi_select($mh, 1.0);
            curl_multi_exec($mh, $laufend);
            while ($info = curl_multi_info_read($mh)) {
                $ch = $info['handle'];
                $id = (int) curl_getinfo($ch, CURLINFO_PRIVATE);
                $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                $roh = curl_multi_getcontent($ch);
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
                unset($griffe[$id]);
                try {
                    $p = $partner[$id] ?? db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => $id]);
                    $r = $p && $info['result'] === CURLE_OK && $code === 200 ? connect_antwort_oeffnen($p, $roh, $zs[$id] ?? null) : null;
                    if (!$r || empty($r[0]['ok'])) {
                        $pause[$id] = time() + 10;   // Partner gerade weg: kurz warten, dann neu (und Weg neu suchen)
                        connect_rueck_status($id, 'fehler', $info['result'] !== CURLE_OK ? curl_strerror($info['result']) : 'HTTP ' . $code);
                        db_tun("UPDATE connect_server SET weg_am = NULL WHERE id = :id", ['id' => $id]);
                        continue;
                    }
                    connect_rueck_status($id, 'ok', '');
                    // Aufträge in eigenen Prozessen ausführen – die Schleife bleibt frei und stellt sofort die nächste „warten“
                    foreach ((array) ($r[0]['auftraege'] ?? []) as $auf) {
                        connect_rueck_auftrag_starten($p, (string) ($auf['id'] ?? ''), (string) ($auf['anfrage'] ?? ''));
                    }
                } catch (Throwable $e) {
                    error_log('Connect Rückkanal ' . $id . ': ' . log_sauber($e->getMessage()));
                    $pause[$id] = time() + 10;
                }
            }
        }
    } finally {
        foreach ($griffe as $ch) {
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);
        flock($fp, LOCK_UN);
        fclose($fp);
    }
    if ($weiter) {
        connect_rueckkanal_anstossen();   // nahtlos weiter mit frischem Prozess
    }
}

/** Letzter Stand je Partner (für die Einstellungen): wann zuletzt eine „warten“ gut durchlief, letzter Fehler */
function connect_rueck_status(int $peerId, string $stand, string $fehler): void
{
    $d = connect_rueck_ordner($peerId);
    $alt = json_decode((string) @file_get_contents($d . '/status.json'), true) ?: [];
    $neu = $stand === 'ok' ? ['ok_am' => time(), 'fehler' => '', 'fehler_am' => $alt['fehler_am'] ?? null]
        : ['ok_am' => $alt['ok_am'] ?? null, 'fehler' => mb_substr($fehler, 0, 200), 'fehler_am' => time()];
    @file_put_contents($d . '/status.json', json_encode($neu), LOCK_EX);
}

/** Eine hereingereichte Anfrage als eigenen Prozess starten (Datei als Übergabe) */
function connect_rueck_auftrag_starten(array $p, string $id, string $anfrageB64): void
{
    if (!preg_match('/^\d+-[0-9a-f]{32}$/', $id) || $anfrageB64 === '') {
        return;
    }
    $d = connect_rueck_ordner((int) $p['id']);
    $datei = $d . '/' . $id . '.auftrag';
    file_put_contents($datei, json_encode(['peer' => (int) $p['id'], 'id' => $id, 'anfrage' => $anfrageB64]), LOCK_EX);
    aw_hintergrund(aw_arg(aw_php()) . ' ' . aw_arg(__DIR__ . '/../scripts/connect_rueckkanal.php') . ' ' . aw_arg($datei), konfig()['pfade']['cache'] . '/tmp/connect_rueckkanal.log', true);
}

/** Vom Kindprozess: Auftragsdatei lesen, ausführen, Antwort hochladen */
function connect_rueck_auftrag_datei(string $datei): void
{
    $j = json_decode((string) @file_get_contents($datei), true);
    @unlink($datei);
    if (!is_array($j)) {
        return;
    }
    $p = db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => (int) ($j['peer'] ?? 0)]);
    if ($p) {
        connect_rueck_ausfuehren($p, (string) ($j['id'] ?? ''), (string) base64_decode((string) ($j['anfrage'] ?? ''), true));
    }
}

/** Über welche Adresse erreichen wir den Partner gerade? (bekannter Weg oder neu gesucht) */
function connect_rueck_basis(array $p): ?string
{
    $p = db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => $p['id']]) ?: $p;   // frisches Adressbuch
    if ($p['weg'] !== '' && $p['weg'] !== 'rueckkanal' && $p['weg_am'] && time() - strtotime((string) $p['weg_am']) < 600) {
        return $p['weg'];
    }
    try {
        $p = connect_weg_suchen($p, false);
        return $p['weg'] !== '' && $p['weg'] !== 'rueckkanal' ? $p['weg'] : null;
    } catch (Throwable $e) {
        connect_rueck_status((int) $p['id'], 'fehler', $e->getMessage());
        return null;
    }
}

/** Eine hereingereichte Anfrage ausführen und die Antwort zum Partner hochladen */
function connect_rueck_ausfuehren(array $p, string $id, string $anfrage): void
{
    if (!preg_match('/^\d+-[0-9a-f]{32}$/', $id) || $anfrage === '') {
        return;
    }
    $r = connect_verarbeiten($anfrage, false);
    if ($r === null) {
        return;
    }
    [$aus, $mitDaten] = $r;
    if ($mitDaten) {
        connect_tempo_warten('hoch', strlen($aus), false);   // Tempogrenze für das Hochladen gilt auch hier
    }
    $basis = connect_rueck_basis($p);
    if ($basis === null) {
        return;
    }
    $ch = curl_init(rtrim($basis, '/') . '/api/v1/connect/rueck/' . $id);
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $aus, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 300,
        CURLOPT_HTTPHEADER => ['Content-Type: application/octet-stream', 'User-Agent: Amberwave-Connect/' . app_version()],
        CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
    curl_exec($ch);
    curl_close($ch);
}

// ---------- Beiwerk: was außer den Dateien mitkommt ----------

function connect_beiwerk_datei(): string
{
    return connect_ordner() . '/beiwerk.json';
}

/** Künstlerbilder, Biografien und Albumtexte zu einem Auftrag bei der Gegenstelle abholen und vormerken */
function connect_beiwerk_holen(array $peer, array $a): void
{
    try {
        [$b] = connect_rufen($peer, 'beiwerk', ['art' => $a['art'], 'id' => (int) $a['ref']], 60);
    } catch (ApiFehler $e) {
        return;   // ältere Gegenstelle ohne Beiwerk
    }
    $ordner = connect_ordner() . '/beiwerk';
    @mkdir($ordner, 0700, true);
    $liste = [];
    foreach ((array) ($b['kuenstler'] ?? []) as $k) {
        if (!is_array($k) || trim((string) ($k['name'] ?? '')) === '') {
            continue;
        }
        $bild = '';
        if (preg_match('/^[A-Za-z0-9_.-]{1,80}$/', (string) ($k['bild'] ?? ''))) {
            try {
                [, $roh] = connect_rufen($peer, 'bild', ['art' => 'kuenstler', 'schluessel' => $k['bild'], 'g' => 1200], 60);
                if (connect_bild_plausibel($roh)) {
                    $bild = sha1($roh) . '.jpg';
                    file_put_contents($ordner . '/' . $bild, $roh);
                }
            } catch (Throwable $e) {
                $bild = '';
            }
        }
        $liste[] = ['art' => 'kuenstler', 'name' => (string) $k['name'], 'mbid' => (string) ($k['mbid'] ?? ''), 'bild' => $bild,
            'bio' => (string) ($k['bio'] ?? ''), 'bio_quelle' => (string) ($k['bio_quelle'] ?? ''), 'bio_maschinell' => !empty($k['bio_maschinell']), 'seit' => time()];
    }
    foreach ((array) ($b['alben'] ?? []) as $al) {
        if (is_array($al) && trim((string) ($al['beschreibung'] ?? '')) !== '') {
            $liste[] = ['art' => 'album', 'titel' => (string) ($al['titel'] ?? ''), 'kuenstler' => (string) ($al['kuenstler'] ?? ''),
                'beschreibung' => (string) $al['beschreibung'], 'quelle' => (string) ($al['beschreibung_quelle'] ?? ''), 'maschinell' => !empty($al['beschreibung_maschinell']), 'seit' => time()];
        }
    }
    if ($liste) {
        connect_json_aendern(connect_beiwerk_datei(), static fn(array $alt) => array_slice(array_merge($alt, $liste), -500));
    }
}

/**
 * Vorgemerktes Beiwerk übernehmen, sobald die Bibliothek die Künstler und Alben kennt (Zeitplan, jede Minute).
 * Nur wo bei uns noch nichts ist – eigene Bilder und Texte werden nie überschrieben. Nach zwei Tagen ohne Treffer: verworfen.
 */
function connect_beiwerk_anwenden(): void
{
    // Unter Sperre herausnehmen; was nicht angewendet werden kann, kommt am Ende wieder dazu
    $liste = is_file(connect_beiwerk_datei()) ? connect_json_entnehmen(connect_beiwerk_datei()) : [];
    if (!$liste) {
        @unlink(connect_beiwerk_datei());
        return;
    }
    $liste = array_values($liste);
    require_once __DIR__ . '/bilder.php';
    require_once __DIR__ . '/hilfen.php';
    $ordner = connect_ordner() . '/beiwerk';
    $rest = [];
    foreach ($liste as $e) {
        $erledigt = false;
        if (($e['art'] ?? '') === 'kuenstler') {
            $k = ($e['mbid'] ?? '') !== '' ? db_zeile('SELECT * FROM kuenstler WHERE mbid = :m LIMIT 1', ['m' => $e['mbid']]) : null;
            $k = $k ?: db_zeile('SELECT * FROM kuenstler WHERE name_norm = :n ORDER BY (mbid IS NULL), id LIMIT 1', ['n' => mb_substr(name_norm((string) $e['name']), 0, 255)]);
            if ($k) {
                $datei = ($e['bild'] ?? '') !== '' ? $ordner . '/' . basename((string) $e['bild']) : '';
                if ((string) $k['bild_datei'] === '' && $datei !== '' && is_file($datei)) {
                    $schl = bild_speichern('kuenstler', 'k' . $k['id'], (string) file_get_contents($datei));
                    if ($schl) {
                        db_tun("UPDATE kuenstler SET bild_datei = :b, bild_quelle = 'connect' WHERE id = :id AND bild_datei = ''", ['b' => $schl, 'id' => $k['id']]);
                    }
                }
                if (trim((string) ($k['bio'] ?? '')) === '' && trim((string) ($e['bio'] ?? '')) !== '') {
                    db_tun('UPDATE kuenstler SET bio = :b, bio_quelle = :q, bio_maschinell = :m WHERE id = :id',
                        ['b' => $e['bio'], 'q' => mb_substr((string) $e['bio_quelle'], 0, 500), 'm' => !empty($e['bio_maschinell']) ? 1 : 0, 'id' => $k['id']]);
                }
                if ($datei !== '') {
                    @unlink($datei);
                }
                $erledigt = true;
            }
        } elseif (($e['art'] ?? '') === 'album') {
            $ziel = connect_schluessel((string) $e['kuenstler'], (string) $e['titel']);
            foreach (db_alle("SELECT a.id, a.titel, a.beschreibung, k.name FROM alben a JOIN credit_namen cn ON cn.credit_id = a.credit_id
                    JOIN kuenstler k ON k.id = cn.kuenstler_id WHERE a.titel = :t", ['t' => $e['titel']]) as $al) {
                if (connect_schluessel((string) $al['name'], (string) $al['titel']) === $ziel) {
                    if (trim((string) ($al['beschreibung'] ?? '')) === '') {
                        db_tun('UPDATE alben SET beschreibung = :b, beschreibung_quelle = :q, beschreibung_maschinell = :m WHERE id = :id',
                            ['b' => $e['beschreibung'], 'q' => mb_substr((string) $e['quelle'], 0, 500), 'm' => !empty($e['maschinell']) ? 1 : 0, 'id' => $al['id']]);
                    }
                    $erledigt = true;
                    break;
                }
            }
        }
        if (!$erledigt && time() - (int) ($e['seit'] ?? 0) < 2 * 86400) {
            $rest[] = $e;
        } elseif (!$erledigt && ($e['bild'] ?? '') !== '') {
            @unlink($ordner . '/' . basename((string) $e['bild']));
        }
    }
    if ($rest) {
        connect_json_aendern(connect_beiwerk_datei(), static fn(array $alt) => array_merge($rest, $alt));
    }
}

/** Angefangene Teil-Dateien eines Auftrags aus dem Musikordner entfernen (Abbrechen/Entfernen) */
function connect_teile_entfernen(int $auftragId): void
{
    $wurzel = rtrim((string) konfig()['pfade']['musik'], '/');
    foreach (db_alle("SELECT ziel FROM connect_dateien WHERE auftrag_id = :a AND status <> 'fertig'", ['a' => $auftragId]) as $d) {
        $teil = $wurzel . '/' . $d['ziel'] . '.amberwave-teil';
        if (str_contains((string) $d['ziel'], '..')) {
            continue;
        }
        @unlink($teil);
    }
}

/** Ist das wirklich ein Bild in vertretbarer Größe? (gegen Müll im Cache und Dekompressionsbomben in GD) */
function connect_bild_plausibel(string $bytes, int $maxBytes = 8 * 1024 * 1024, int $maxPixel = 30000000): bool
{
    if ($bytes === '' || strlen($bytes) > $maxBytes) {
        return false;
    }
    $i = @getimagesizefromstring($bytes);
    return is_array($i) && in_array($i[2] ?? 0, [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP, IMAGETYPE_GIF], true)
        && (int) $i[0] * (int) $i[1] <= $maxPixel;
}

