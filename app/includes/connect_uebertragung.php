<?php
declare(strict_types=1);
// Amberwave Connect – Übertragung: liefern (Datei oder umgewandelte Fassung in Stücken), holen (Aufträge in der
// Warteschlange, fortsetzbar), Tempogrenze (für alle Übertragungen zusammen) und Reinhören über den eigenen Server.
require_once __DIR__ . '/connect.php';
require_once __DIR__ . '/schreibschutz.php';

const CONNECT_ENDUNG = ['opus256' => 'opus', 'opus160' => 'opus', 'opus128' => 'opus', 'aac256' => 'm4a', 'aac160' => 'm4a', 'flac1644' => 'flac'];

// ---------- Tempo ----------

/** Grenze in Mbit/s für eine Richtung (0 = keine), unter Berücksichtigung von „nachts frei“ und „im Heimnetz frei“ */
function connect_grenze(string $richtung, bool $heimnetz): float
{
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
function connect_arbeiten(): void
{
    $fp = fopen(connect_ordner() . '/arbeiter.sperre', 'c');
    if (!$fp || !flock($fp, LOCK_EX | LOCK_NB)) {
        return;
    }
    $ende = time() + 3000;
    try {
        while (time() < $ende) {
            $a = db_zeile("SELECT * FROM connect_auftraege WHERE status IN ('laeuft', 'wartet') ORDER BY status = 'laeuft' DESC, id LIMIT 1");
            if (!$a) {
                break;
            }
            try {
                connect_auftrag_ausfuehren($a, $ende);
            } catch (Throwable $e) {
                $fehler = mb_substr($e->getMessage(), 0, 500);
                $neu = (int) db_wert('SELECT COUNT(*) FROM connect_dateien WHERE auftrag_id = :a AND status = \'fertig\'', ['a' => $a['id']]);
                // Netz weg o. Ä.: Auftrag bleibt offen und geht später weiter – erst nach wiederholtem Scheitern als Fehler
                $versuche = (int) (json_decode((string) @file_get_contents(connect_ordner() . '/versuche.json'), true)[$a['id']] ?? 0) + 1;
                // Dauerhafte Hindernisse (Schreibschutz, Rechte) gleich als Fehler – Wiederholen bringt da nichts
                if (!musik_schreiben_erlaubt() || ($e instanceof ApiFehler && in_array($e->getCode(), [400, 403, 404], true))) {
                    $versuche = 30;
                }
                $alle = json_decode((string) @file_get_contents(connect_ordner() . '/versuche.json'), true) ?: [];
                $alle[$a['id']] = $versuche;
                @file_put_contents(connect_ordner() . '/versuche.json', json_encode($alle));
                db_tun('UPDATE connect_auftraege SET status = :s, fehler = :f, fertig = :n WHERE id = :id',
                    ['s' => $versuche >= 30 ? 'fehler' : 'laeuft', 'f' => $fehler, 'n' => $neu, 'id' => $a['id']]);
                if ($versuche < 30) {
                    break;   // später weiter (der Zeitplan stößt jede Minute an)
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
                ['f' => t('Alles schon vorhanden.'), 'id' => $a['id']]);
            return;
        }
        // Cover für den Album-Ordner
        if ($erster && $erster['cover'] !== '') {
            try {
                [, $bild] = connect_rufen($peer, 'bild', ['art' => 'cover', 'schluessel' => $erster['cover'], 'g' => 1200]);
                $z1 = db_wert('SELECT ziel FROM connect_dateien WHERE auftrag_id = :a ORDER BY id LIMIT 1', ['a' => $a['id']]);
                $abs = konfig()['pfade']['musik'] . '/' . dirname((string) $z1);
                if ($bild !== '' && af_ordner_anlegen($abs) && !is_file($abs . '/cover.jpg')) {
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
        $ab = is_file($teil) ? (int) filesize($teil) : 0;
        $groesse = (int) $d['groesse'];
        while ($groesse === 0 || $ab < $groesse) {
            $stand = (string) db_wert('SELECT status FROM connect_auftraege WHERE id = :id', ['id' => $a['id']]);
            if ($stand !== 'laeuft') {
                return;   // abgebrochen oder pausiert
            }
            if (time() > $ende) {
                throw new RuntimeException(t('Zeit für diesen Lauf um – geht gleich weiter.'));
            }
            $heim = $peer['weg_art'] === 'heimnetz';
            $stueck = connect_stueck_groesse($heim);
            [$kopf, $bytes] = connect_rufen($peer, 'datei', ['track' => (int) $d['track_ref'], 'qualitaet' => $a['qualitaet'], 'ab' => $ab, 'laenge' => $stueck], 300);
            $peer = connect_server((int) $a['server_id']);
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
            file_put_contents($teil, $bytes, FILE_APPEND);
            $ab += strlen($bytes);
            db_tun('UPDATE connect_dateien SET bytes = :b, status = \'laeuft\' WHERE id = :id', ['b' => $ab, 'id' => $d['id']]);
            db_tun('UPDATE connect_auftraege SET bytes = (SELECT COALESCE(SUM(bytes), 0) FROM connect_dateien WHERE auftrag_id = :a),
                gesamt = GREATEST(gesamt, (SELECT COALESCE(SUM(groesse), 0) FROM connect_dateien WHERE auftrag_id = :a2)), fehler = \'\' WHERE id = :id',
                ['a' => $a['id'], 'a2' => $a['id'], 'id' => $a['id']]);
            if ($groesse === 0) {
                break;
            }
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
    $q = (string) ($_GET['q'] ?? 'opus160');
    if (!in_array($q, CONNECT_QUALITAETEN, true)) {
        $q = 'opus160';
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
    $mime = ['opus' => 'audio/ogg', 'm4a' => 'audio/mp4', 'flac' => 'audio/flac', 'mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg', 'wav' => 'audio/wav'][$kopf['endung']] ?? 'application/octet-stream';
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
function connect_bild_senden(int $serverId, string $art, string $schluessel): void
{
    $g = max(32, min(1200, (int) ($_GET['g'] ?? 300)));
    if (!in_array($art, ['cover', 'kuenstler'], true) || !preg_match('/^[A-Za-z0-9_.-]{1,80}$/', $schluessel)) {
        throw new ApiFehler(t('Bild nicht gefunden.'), 404);
    }
    $datei = connect_ordner('bilder/' . $serverId) . "/{$art}-{$schluessel}-{$g}.jpg";
    if (!is_file($datei) || filemtime($datei) < time() - 7 * 86400) {
        [, $bytes] = connect_rufen(connect_server($serverId), 'bild', ['art' => $art, 'schluessel' => $schluessel, 'g' => $g], 30);
        file_put_contents($datei, $bytes, LOCK_EX);
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
function connect_lesen(int $serverId, string $methode, array $args): array
{
    $erlaubt = ['alben', 'album', 'kuenstler_liste', 'kuenstler', 'playlists', 'playlist', 'suche'];
    if (!in_array($methode, $erlaubt, true)) {
        throw new ApiFehler(t('Unbekannte Anfrage.'), 400);
    }
    $peer = connect_server($serverId);
    [$kopf] = connect_rufen($peer, $methode, $args);
    unset($kopf['ok']);
    $json = json_encode($kopf, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $json = preg_replace('#"/api/v1/bild/(cover|kuenstler)/([A-Za-z0-9_.-]+)(\?[^"]*)?"#', '"/api/v1/connect/server/' . $serverId . '/bild/$1/$2$3"', $json);
    $daten = json_decode((string) $json, true) ?: [];
    $daten['_server'] = connect_server_objekt(connect_server($serverId));
    return $daten;
}
