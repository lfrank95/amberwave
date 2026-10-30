<?php
declare(strict_types=1);
require_once __DIR__ . '/tagziel.php';
require_once __DIR__ . '/schreibschutz.php';
require_once __DIR__ . '/i18n.php';

/**
 * Tags (und Cover) in Musikdateien schreiben – FLAC (Vorbis-Kommentar), MP3 (ID3v2.4), M4A/MP4 (iTunes-Felder).
 *
 * Sicherheit:
 * - Das Audio wird nie neu kodiert. Reicht der Platz im vorhandenen Kopf (Füllblock/Padding), wird nur der Kopf
 *   überschrieben; sonst wird die Datei daneben neu zusammengesetzt (Audio Byte für Byte kopiert) und erst nach der
 *   Prüfung ausgetauscht.
 * - Prüfung: die dekodierten Audiodaten (MD5 über PCM, ffmpeg) müssen vorher und nachher gleich sein; sonst wird der
 *   alte Zustand zurückgeschrieben.
 * - AUFRAEUMEN_TAGS=sauber (Standard): fremde Tags werden entfernt – außer AUFRAEUMEN_BEHALTEN (Liedtexte, ISRC …) und
 *   Technischem für lückenlose Wiedergabe (iTunSMPB/pgap bei M4A). „ergaenzen“: Fremdes bleibt erhalten.
 */

final class TagFehler extends RuntimeException
{
}

const TAG_FORMATE = ['flac', 'mp3', 'm4a', 'mp4', 'm4b', 'aac'];

/** MD5 über die dekodierten Audiodaten (erste Tonspur) */
function audio_pruefsumme(string $pfad): string
{
    $cmd = [konfig()['stream']['ffmpeg'], '-nostdin', '-v', 'error', '-threads', '1', '-i', $pfad, '-map', '0:a:0', '-f', 'md5', '-'];
    $p = proc_open($cmd, [0 => ['file', aw_null(), 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($p)) {
        throw new TagFehler(t('ffmpeg konnte nicht gestartet werden'));
    }
    $aus = stream_get_contents($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $st = proc_close($p);
    if ($st !== 0 || !preg_match('/MD5=([0-9a-f]{32})/', (string) $aus, $m)) {
        throw new TagFehler(t('Audio nicht lesbar: {grund}', ['grund' => trim(mb_substr((string) $err, -200))]));
    }
    return $m[1];
}

/** Bytes an Position schreiben (Datei bleibt sonst unverändert) */
function datei_bereich_schreiben(string $pfad, int $pos, string $daten): void
{
    musik_schreibschutz($pfad);
    $f = fopen($pfad, 'r+b');
    if (!$f) {
        throw new TagFehler(t('Datei nicht beschreibbar (Rechte?)'));
    }
    fseek($f, $pos);
    $n = fwrite($f, $daten);
    fflush($f);
    fclose($f);
    if ($n !== strlen($daten)) {
        throw new TagFehler(t('Schreiben unvollständig'));
    }
}

/** Neue Datei aus Kopf + Rest der alten zusammensetzen, prüfen, austauschen */
function datei_neu_zusammensetzen(string $pfad, string $kopf, int $restAb, string $vorher, ?callable $rest = null): void
{
    musik_schreibschutz($pfad);
    $tmp = dirname($pfad) . '/.' . basename($pfad) . '.amberwave.tmp';
    $o = @fopen($tmp, 'wb');
    if (!$o) {
        throw new TagFehler(t('Ordner nicht beschreibbar (Rechte?)'));
    }
    fwrite($o, $kopf);
    $f = fopen($pfad, 'rb');
    if ($rest) {
        $rest($f, $o);
    } else {
        fseek($f, $restAb);
        stream_copy_to_stream($f, $o);
    }
    fclose($f);
    fflush($o);
    fclose($o);
    try {
        $nachher = audio_pruefsumme($tmp);
    } catch (Throwable $e) {
        @unlink($tmp);
        throw new TagFehler(t('Prüfung der neuen Datei fehlgeschlagen: {grund}', ['grund' => $e->getMessage()]));
    }
    if ($nachher !== $vorher) {
        @unlink($tmp);
        throw new TagFehler(t('Prüfung fehlgeschlagen: Audio wäre verändert worden – Datei bleibt unangetastet.'));
    }
    @chmod($tmp, fileperms($pfad) & 0777);
    if (!@rename($tmp, $pfad)) {
        @unlink($tmp);
        throw new TagFehler(t('Datei konnte nicht ersetzt werden (Rechte?)'));
    }
}

/** Cover (JPEG) mit Abmessungen */
function cover_info(?string $jpeg): ?array
{
    if ($jpeg === null || $jpeg === '') {
        return null;
    }
    $g = @getimagesizefromstring($jpeg);
    return ['daten' => $jpeg, 'b' => (int) ($g[0] ?? 0), 'h' => (int) ($g[1] ?? 0), 'mime' => (string) ($g['mime'] ?? 'image/jpeg')];
}

/**
 * Soll-Tags (+ optional Cover) in eine Datei schreiben. Liefert ['art' => 'kopf'|'neu', 'alt' => Ist-Tags (für das Protokoll)].
 */
function datei_tags_schreiben(string $pfad, array $soll, ?string $coverJpeg = null): array
{
    musik_schreibschutz($pfad);
    if (!is_writable($pfad) || !is_writable(dirname($pfad))) {
        throw new TagFehler(t('Keine Schreibrechte'));
    }
    $ext = strtolower(pathinfo($pfad, PATHINFO_EXTENSION));
    $vorher = audio_pruefsumme($pfad);
    $cover = cover_info($coverJpeg);
    $r = match (true) {
        $ext === 'flac' => flac_schreiben($pfad, $soll, $cover, $vorher),
        $ext === 'mp3' => mp3_schreiben($pfad, $soll, $cover, $vorher),
        in_array($ext, ['m4a', 'mp4', 'm4b', 'aac'], true) && mp4_ist($pfad) => mp4_schreiben($pfad, $soll, $cover, $vorher),
        default => throw new TagFehler(t('Format .{ext} wird nicht beschrieben', ['ext' => $ext])),
    };
    clearstatcache(true, $pfad);
    if ($r['art'] === 'kopf' && audio_pruefsumme($pfad) !== $vorher) {
        // sollte nie passieren (nur der Kopf wurde ersetzt) – trotzdem: alten Kopf zurück
        datei_bereich_schreiben($pfad, 0, $r['alter_kopf']);
        throw new TagFehler(t('Prüfung fehlgeschlagen – alter Zustand wiederhergestellt.'));
    }
    unset($r['alter_kopf']);
    return $r;
}

// =====================================================================================================
// FLAC
// =====================================================================================================

function flac_bloecke_lesen($f): array
{
    fseek($f, 0);
    if (fread($f, 4) !== 'fLaC') {
        throw new TagFehler(t('Keine FLAC-Datei'));
    }
    $bloecke = [];
    $letzter = false;
    while (!$letzter) {
        $kopf = fread($f, 4);
        if ($kopf === false || strlen($kopf) < 4) {
            throw new TagFehler(t('Beschädigte FLAC-Metadaten'));
        }
        $letzter = (ord($kopf[0]) & 0x80) !== 0;
        $typ = ord($kopf[0]) & 0x7f;
        $laenge = (ord($kopf[1]) << 16) | (ord($kopf[2]) << 8) | ord($kopf[3]);
        $daten = $laenge > 0 ? (string) fread($f, $laenge) : '';
        if (strlen($daten) !== $laenge) {
            throw new TagFehler(t('Beschädigte FLAC-Metadaten'));
        }
        $bloecke[] = [$typ, $daten];
    }
    return [$bloecke, ftell($f)];
}

function vorbis_lesen(string $d): array
{
    $tags = [];
    $p = 0;
    $vl = unpack('V', substr($d, $p, 4))[1];
    $p += 4 + $vl;
    $n = unpack('V', substr($d, $p, 4))[1];
    $p += 4;
    for ($i = 0; $i < $n && $p + 4 <= strlen($d); $i++) {
        $l = unpack('V', substr($d, $p, 4))[1];
        $e = substr($d, $p + 4, $l);
        $p += 4 + $l;
        $gl = strpos($e, '=');
        if ($gl === false) {
            continue;
        }
        $tags[strtoupper(substr($e, 0, $gl))][] = substr($e, $gl + 1);
    }
    return $tags;
}

function vorbis_bauen(array $tags, string $vendor = 'Amberwave'): string
{
    $eintraege = [];
    foreach ($tags as $feld => $werte) {
        $feld = strtoupper((string) $feld);
        if (!preg_match('/^[\x20-\x3C\x3E-\x7D]+$/', $feld)) {
            continue;
        }
        foreach ((array) $werte as $w) {
            if ((string) $w !== '') {
                $eintraege[] = $feld . '=' . $w;
            }
        }
    }
    $vc = pack('V', strlen($vendor)) . $vendor . pack('V', count($eintraege));
    foreach ($eintraege as $e) {
        $vc .= pack('V', strlen($e)) . $e;
    }
    return $vc;
}

function flac_schreiben(string $pfad, array $soll, ?array $cover, string $vorher): array
{
    $f = fopen($pfad, 'rb');
    [$bloecke, $audioStart] = flac_bloecke_lesen($f);
    fseek($f, 0);
    $alterKopf = (string) fread($f, $audioStart);
    fclose($f);
    $ist = [];
    $vendor = 'Amberwave';
    foreach ($bloecke as [$typ, $d]) {
        if ($typ === 4) {
            $ist = vorbis_lesen($d);
            $vl = unpack('V', substr($d, 0, 4))[1];
            $vendor = substr($d, 4, $vl) ?: 'Amberwave';
        }
    }
    $neueTags = tags_zusammenfuehren($ist, $soll);
    $neu = [];
    foreach ($bloecke as $i => [$typ, $d]) {
        if ($typ === 1 || $typ === 4) {
            continue; // Füllblock und alter Kommentar
        }
        if ($typ === 6 && $cover && unpack('N', substr($d, 0, 4))[1] === 3) {
            continue; // altes Frontcover wird ersetzt
        }
        $neu[] = [$typ, $d];
        if ($i === 0) {
            $neu[] = [4, vorbis_bauen($neueTags, $vendor)];
        }
    }
    if ($cover) {
        $mime = $cover['mime'];
        $neu[] = [6, pack('N', 3) . pack('N', strlen($mime)) . $mime . pack('N', 0) . pack('NNNN', $cover['b'], $cover['h'], 24, 0)
            . pack('N', strlen($cover['daten'])) . $cover['daten']];
    }
    $roh = static function (array $bl, bool $mitLetzt) {
        $s = '';
        $n = count($bl);
        foreach ($bl as $i => [$typ, $d]) {
            $l = strlen($d);
            if ($l > 0xFFFFFF) {
                throw new TagFehler(t('Metadatenblock zu groß'));
            }
            $s .= chr(($mitLetzt && $i === $n - 1 ? 0x80 : 0) | $typ) . chr(($l >> 16) & 0xff) . chr(($l >> 8) & 0xff) . chr($l & 0xff) . $d;
        }
        return $s;
    };
    $ohnePolster = $roh($neu, false);
    $platz = $audioStart - 4; // alles zwischen „fLaC“ und dem Audio
    if (strlen($ohnePolster) === $platz) {
        datei_bereich_schreiben($pfad, 4, $roh($neu, true));
        return ['art' => 'kopf', 'alt' => $ist, 'alter_kopf' => $alterKopf];
    }
    if (strlen($ohnePolster) + 4 <= $platz) {
        $polster = $platz - strlen($ohnePolster) - 4;
        datei_bereich_schreiben($pfad, 4, $roh(array_merge($neu, [[1, str_repeat("\0", $polster)]]), true));
        return ['art' => 'kopf', 'alt' => $ist, 'alter_kopf' => $alterKopf];
    }
    // passt nicht: neu zusammensetzen, mit großzügigem Füllblock für das nächste Mal
    datei_neu_zusammensetzen($pfad, 'fLaC' . $roh(array_merge($neu, [[1, str_repeat("\0", 16384)]]), true), $audioStart, $vorher);
    return ['art' => 'neu', 'alt' => $ist];
}

// =====================================================================================================
// MP3 – ID3v2.4
// =====================================================================================================

/** Feld → ID3-Rahmen (Picard-Zuordnung) */
const ID3_TEXT = [
    'TITLE' => 'TIT2', 'ARTIST' => 'TPE1', 'ALBUM' => 'TALB', 'ALBUMARTIST' => 'TPE2', 'DATE' => 'TDRC', 'ORIGINALDATE' => 'TDOR',
    'GENRE' => 'TCON', 'LABEL' => 'TPUB', 'COMPOSER' => 'TCOM', 'LYRICIST' => 'TEXT', 'CONDUCTOR' => 'TPE3', 'REMIXER' => 'TPE4',
    'MEDIA' => 'TMED', 'DISCSUBTITLE' => 'TSST', 'ARTISTSORT' => 'TSOP', 'ALBUMARTISTSORT' => 'TSO2',
];
const ID3_TXXX = [
    'ARTISTS' => 'ARTISTS', 'ALBUMARTISTS' => 'ALBUMARTISTS', 'CATALOGNUMBER' => 'CATALOGNUMBER', 'BARCODE' => 'BARCODE',
    'RELEASECOUNTRY' => 'MusicBrainz Album Release Country', 'RELEASETYPE' => 'MusicBrainz Album Type', 'RELEASESTATUS' => 'MusicBrainz Album Status',
    'MUSICBRAINZ_ALBUMID' => 'MusicBrainz Album Id', 'MUSICBRAINZ_RELEASEGROUPID' => 'MusicBrainz Release Group Id',
    'MUSICBRAINZ_RELEASETRACKID' => 'MusicBrainz Release Track Id', 'MUSICBRAINZ_ARTISTID' => 'MusicBrainz Artist Id',
    'MUSICBRAINZ_ALBUMARTISTID' => 'MusicBrainz Album Artist Id', 'MUSICBRAINZ_WORKID' => 'MusicBrainz Work Id',
    'ORIGINALYEAR' => 'originalyear', 'WRITER' => 'Writer', 'WORK' => 'WORK',
    'REPLAYGAIN_TRACK_GAIN' => 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK' => 'REPLAYGAIN_TRACK_PEAK',
    'REPLAYGAIN_ALBUM_GAIN' => 'REPLAYGAIN_ALBUM_GAIN', 'REPLAYGAIN_ALBUM_PEAK' => 'REPLAYGAIN_ALBUM_PEAK', 'AMBERWAVE_EDITION' => 'AMBERWAVE_EDITION',
];
const ID3_TIPL = ['PRODUCER' => 'producer', 'ENGINEER' => 'engineer', 'MIXER' => 'mix', 'ARRANGER' => 'arranger', 'DJMIXER' => 'DJ-mix'];

function synchsafe_lesen(string $b): int
{
    return ((ord($b[0]) & 0x7f) << 21) | ((ord($b[1]) & 0x7f) << 14) | ((ord($b[2]) & 0x7f) << 7) | (ord($b[3]) & 0x7f);
}

function synchsafe(int $n): string
{
    return chr(($n >> 21) & 0x7f) . chr(($n >> 14) & 0x7f) . chr(($n >> 7) & 0x7f) . chr($n & 0x7f);
}

/** Text in ID3 dekodieren (Kodierung im ersten Byte); Rückgabe Liste (Nullbyte trennt Mehrfachwerte) */
function id3_text(string $d): array
{
    if ($d === '') {
        return [];
    }
    $enc = ord($d[0]);
    $s = substr($d, 1);
    if ($enc === 1 || $enc === 2) {
        $s = (string) @mb_convert_encoding($s, 'UTF-8', $enc === 1 ? 'UTF-16' : 'UTF-16BE');
    } elseif ($enc === 0) {
        $s = (string) @mb_convert_encoding($s, 'UTF-8', 'ISO-8859-1');
    }
    return array_values(array_filter(explode("\0", $s), static fn($x) => $x !== ''));
}

/** Vorhandenes ID3v2 einlesen: ['laenge' => Bytes inkl. Kopf, 'rahmen' => [[id, daten]], 'ist' => Felder fürs Protokoll] */
function id3_lesen(string $pfad): array
{
    $f = fopen($pfad, 'rb');
    $kopf = (string) fread($f, 10);
    if (strlen($kopf) < 10 || substr($kopf, 0, 3) !== 'ID3') {
        fclose($f);
        return ['laenge' => 0, 'rahmen' => [], 'ist' => []];
    }
    $ver = ord($kopf[3]);
    $flags = ord($kopf[5]);
    $groesse = synchsafe_lesen(substr($kopf, 6, 4));
    $laenge = 10 + $groesse + (($ver === 4 && ($flags & 0x10)) ? 10 : 0);
    $daten = (string) fread($f, $groesse);
    fclose($f);
    if ($ver < 3) {
        return ['laenge' => $laenge, 'rahmen' => [], 'ist' => []]; // ID3v2.2: wird komplett ersetzt
    }
    if ($ver === 3 && ($flags & 0x80)) {
        $daten = str_replace("\xFF\x00", "\xFF", $daten); // Unsynchronisation rückgängig
    }
    $p = 0;
    if ($flags & 0x40) { // erweiterter Kopf
        $p += $ver === 4 ? synchsafe_lesen(substr($daten, 0, 4)) : 4 + unpack('N', substr($daten, 0, 4))[1];
    }
    $rahmen = [];
    $ist = [];
    while ($p + 10 <= strlen($daten)) {
        $id = substr($daten, $p, 4);
        if (!preg_match('/^[A-Z0-9]{4}$/', $id)) {
            break; // Polster erreicht
        }
        $l = $ver === 4 ? synchsafe_lesen(substr($daten, $p + 4, 4)) : unpack('N', substr($daten, $p + 4, 4))[1];
        $fl = unpack('n', substr($daten, $p + 8, 2))[1];
        $inhalt = substr($daten, $p + 10, $l);
        $p += 10 + $l;
        if ($ver === 4) {
            if ($fl & 0x0001) { // Längenangabe vorangestellt
                $inhalt = substr($inhalt, 4);
            }
            if ($fl & 0x0002) {
                $inhalt = str_replace("\xFF\x00", "\xFF", $inhalt);
            }
            if ($fl & 0x000C) {
                continue; // komprimiert/verschlüsselt: nicht übernehmen
            }
        } elseif ($fl & 0x00C0) {
            continue;
        }
        $rahmen[] = [$id, $inhalt];
        if ($id[0] === 'T' && $id !== 'TXXX') {
            $ist[$id] = id3_text($inhalt);
        } elseif ($id === 'TXXX') {
            $t = id3_text($inhalt);
            if ($t) {
                $ist['TXXX:' . array_shift($t)] = $t;
            }
        }
    }
    return ['laenge' => $laenge, 'rahmen' => $rahmen, 'ist' => $ist];
}

function id3_rahmen(string $id, string $daten): string
{
    return $id . synchsafe(strlen($daten)) . "\0\0" . $daten;
}

function id3_textrahmen(string $id, array $werte): string
{
    return id3_rahmen($id, "\x03" . implode("\0", $werte));
}

function mp3_schreiben(string $pfad, array $soll, ?array $cover, string $vorher): array
{
    $alt = id3_lesen($pfad);
    $f = fopen($pfad, 'rb');
    $alterKopf = $alt['laenge'] ? (string) fread($f, $alt['laenge']) : '';
    fclose($f);
    // Welche alten Rahmen ersetzt werden
    $ersetzen = ['TYER' => 1, 'TDAT' => 1, 'TIME' => 1, 'TORY' => 1, 'TRDA' => 1];
    $txxxWeg = [];
    foreach (ID3_TEXT as $feld => $id) {
        if (isset($soll[$feld])) {
            $ersetzen[$id] = 1;
        }
    }
    if (isset($soll['TRACKNUMBER'])) {
        $ersetzen['TRCK'] = 1;
    }
    if (isset($soll['DISCNUMBER'])) {
        $ersetzen['TPOS'] = 1;
    }
    foreach (ID3_TXXX as $feld => $desc) {
        if (isset($soll[$feld])) {
            $txxxWeg[mb_strtolower($desc)] = 1;
        }
    }
    $tipl = array_intersect_key($soll, ID3_TIPL);
    if ($tipl) {
        $ersetzen['TIPL'] = 1;
        $ersetzen['IPLS'] = 1;
    }
    if (isset($soll['PERFORMER'])) {
        $ersetzen['TMCL'] = 1;
    }
    $rahmen = '';
    $sauber = tags_sauber();
    // beim sauberen Schreiben bleiben nur: Liedtexte (USLT/SYLT), ISRC (TSRC) – je nach AUFRAEUMEN_BEHALTEN –,
    // weitere Bilder, wenn kein neues Cover kommt, und TXXX-Felder, die behalten werden sollen
    $id3Behalten = [];
    if (tag_behalten('LYRICS') || tag_behalten('UNSYNCEDLYRICS')) {
        $id3Behalten['USLT'] = 1;
        $id3Behalten['SYLT'] = 1;
    }
    if (tag_behalten('ISRC')) {
        $id3Behalten['TSRC'] = 1;
    }
    foreach ($alt['rahmen'] as [$id, $d]) {
        if (isset($ersetzen[$id])) {
            continue;
        }
        if ($sauber && !isset($id3Behalten[$id]) && $id !== 'TXXX' && !($id === 'APIC' && !$cover)) {
            continue;
        }
        if ($sauber && $id === 'TXXX') {
            $t = id3_text($d);
            if (!$t || !tag_behalten((string) $t[0])) {
                continue;
            }
        }
        if ($id === 'TXXX') {
            $t = id3_text($d);
            if ($t && isset($txxxWeg[mb_strtolower($t[0])])) {
                continue;
            }
        }
        if ($id === 'UFID' && isset($soll['MUSICBRAINZ_TRACKID']) && str_starts_with($d, "http://musicbrainz.org\0")) {
            continue;
        }
        if ($id === 'APIC' && $cover) {
            $nach = strpos($d, "\0", 1);
            if ($nach !== false && ord($d[$nach + 1] ?? "\0") === 3) {
                continue; // altes Frontcover
            }
        }
        $rahmen .= id3_rahmen($id, $d);
    }
    foreach (ID3_TEXT as $feld => $id) {
        if (isset($soll[$feld])) {
            $rahmen .= id3_textrahmen($id, $soll[$feld]);
        }
    }
    if (isset($soll['TRACKNUMBER'])) {
        $rahmen .= id3_textrahmen('TRCK', [$soll['TRACKNUMBER'][0] . (isset($soll['TRACKTOTAL']) ? '/' . $soll['TRACKTOTAL'][0] : '')]);
    }
    if (isset($soll['DISCNUMBER'])) {
        $rahmen .= id3_textrahmen('TPOS', [$soll['DISCNUMBER'][0] . (isset($soll['DISCTOTAL']) ? '/' . $soll['DISCTOTAL'][0] : '')]);
    }
    foreach (ID3_TXXX as $feld => $desc) {
        if (isset($soll[$feld])) {
            $rahmen .= id3_rahmen('TXXX', "\x03" . $desc . "\0" . implode("\0", $soll[$feld]));
        }
    }
    if ($tipl) {
        $paare = [];
        foreach ($tipl as $feld => $namen) {
            foreach ($namen as $n) {
                $paare[] = ID3_TIPL[$feld];
                $paare[] = $n;
            }
        }
        $rahmen .= id3_textrahmen('TIPL', $paare);
    }
    if (isset($soll['PERFORMER'])) {
        $paare = [];
        foreach ($soll['PERFORMER'] as $p) {
            if (preg_match('/^(.*) \(([^()]*)\)$/u', $p, $m)) {
                $paare[] = $m[2];
                $paare[] = $m[1];
            } else {
                $paare[] = 'performer';
                $paare[] = $p;
            }
        }
        $rahmen .= id3_textrahmen('TMCL', $paare);
    }
    if (isset($soll['MUSICBRAINZ_TRACKID'])) {
        $rahmen .= id3_rahmen('UFID', "http://musicbrainz.org\0" . $soll['MUSICBRAINZ_TRACKID'][0]);
    }
    if ($cover) {
        $rahmen .= id3_rahmen('APIC', "\x03" . $cover['mime'] . "\0" . "\x03" . "\0" . $cover['daten']);
    }
    $kopf = static fn(int $inhalt) => 'ID3' . "\x04\x00\x00" . synchsafe($inhalt);
    if ($alt['laenge'] > 0 && strlen($rahmen) + 10 <= $alt['laenge']) {
        $polster = $alt['laenge'] - 10 - strlen($rahmen);
        datei_bereich_schreiben($pfad, 0, $kopf(strlen($rahmen) + $polster) . $rahmen . str_repeat("\0", $polster));
        return ['art' => 'kopf', 'alt' => $alt['ist'], 'alter_kopf' => $alterKopf];
    }
    $polster = 4096;
    datei_neu_zusammensetzen($pfad, $kopf(strlen($rahmen) + $polster) . $rahmen . str_repeat("\0", $polster), $alt['laenge'], $vorher);
    return ['art' => 'neu', 'alt' => $alt['ist']];
}

// =====================================================================================================
// MP4 / M4A – iTunes-Metadaten (moov/udta/meta/ilst)
// =====================================================================================================

/** iTunes-Atome; \xA9 = „©“ als ein Byte (wie in der Datei) */
const MP4_TEXT = [
    'TITLE' => "\xA9nam", 'ARTIST' => "\xA9ART", 'ALBUM' => "\xA9alb", 'ALBUMARTIST' => 'aART', 'DATE' => "\xA9day", 'GENRE' => "\xA9gen",
    'COMPOSER' => "\xA9wrt", 'WORK' => "\xA9wrk", 'ARTISTSORT' => 'soar', 'ALBUMARTISTSORT' => 'soaa',
];
const MP4_FREI = [
    'ARTISTS' => 'ARTISTS', 'ALBUMARTISTS' => 'ALBUMARTISTS', 'LYRICIST' => 'LYRICIST', 'CONDUCTOR' => 'CONDUCTOR', 'REMIXER' => 'REMIXER',
    'MEDIA' => 'MEDIA', 'DISCSUBTITLE' => 'DISCSUBTITLE', 'LABEL' => 'LABEL', 'CATALOGNUMBER' => 'CATALOGNUMBER', 'BARCODE' => 'BARCODE',
    'ORIGINALDATE' => 'ORIGINALDATE', 'ORIGINALYEAR' => 'ORIGINALYEAR', 'WRITER' => 'WRITER', 'PRODUCER' => 'PRODUCER', 'ENGINEER' => 'ENGINEER',
    'MIXER' => 'MIXER', 'ARRANGER' => 'ARRANGER', 'DJMIXER' => 'DJMIXER', 'PERFORMER' => 'PERFORMER',
    'RELEASECOUNTRY' => 'MusicBrainz Album Release Country', 'RELEASETYPE' => 'MusicBrainz Album Type', 'RELEASESTATUS' => 'MusicBrainz Album Status',
    'MUSICBRAINZ_ALBUMID' => 'MusicBrainz Album Id', 'MUSICBRAINZ_RELEASEGROUPID' => 'MusicBrainz Release Group Id',
    'MUSICBRAINZ_TRACKID' => 'MusicBrainz Track Id', 'MUSICBRAINZ_RELEASETRACKID' => 'MusicBrainz Release Track Id',
    'MUSICBRAINZ_ARTISTID' => 'MusicBrainz Artist Id', 'MUSICBRAINZ_ALBUMARTISTID' => 'MusicBrainz Album Artist Id', 'MUSICBRAINZ_WORKID' => 'MusicBrainz Work Id',
    'REPLAYGAIN_TRACK_GAIN' => 'replaygain_track_gain', 'REPLAYGAIN_TRACK_PEAK' => 'replaygain_track_peak',
    'REPLAYGAIN_ALBUM_GAIN' => 'replaygain_album_gain', 'REPLAYGAIN_ALBUM_PEAK' => 'replaygain_album_peak', 'AMBERWAVE_EDITION' => 'AMBERWAVE_EDITION',
];
const MP4_CONTAINER = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'mvex', 'ilst'];

function mp4_ist(string $pfad): bool
{
    $f = fopen($pfad, 'rb');
    $k = (string) fread($f, 12);
    fclose($f);
    return substr($k, 4, 4) === 'ftyp';
}

/** Atome einer Ebene: [[typ, start, laenge, kopflaenge]] */
function mp4_atome(string $d, int $von = 0, ?int $bis = null): array
{
    $bis ??= strlen($d);
    $aus = [];
    $p = $von;
    while ($p + 8 <= $bis) {
        $l = unpack('N', substr($d, $p, 4))[1];
        $typ = substr($d, $p + 4, 4);
        $kl = 8;
        if ($l === 1) {
            $l = (int) unpack('J', substr($d, $p + 8, 8))[1];
            $kl = 16;
        } elseif ($l === 0) {
            $l = $bis - $p;
        }
        if ($l < $kl || $p + $l > $bis) {
            throw new TagFehler(t('Beschädigte MP4-Struktur'));
        }
        $aus[] = [$typ, $p, $l, $kl];
        $p += $l;
    }
    return $aus;
}

/** Oberste Ebene direkt aus der Datei (ohne alles einzulesen) */
function mp4_atome_datei($f, int $groesse): array
{
    $aus = [];
    $p = 0;
    while ($p + 8 <= $groesse) {
        fseek($f, $p);
        $k = (string) fread($f, 16);
        $l = unpack('N', substr($k, 0, 4))[1];
        $typ = substr($k, 4, 4);
        $kl = 8;
        if ($l === 1) {
            $l = (int) unpack('J', substr($k, 8, 8))[1];
            $kl = 16;
        } elseif ($l === 0) {
            $l = $groesse - $p;
        }
        if ($l < $kl || $p + $l > $groesse) {
            throw new TagFehler(t('Beschädigte MP4-Struktur'));
        }
        $aus[] = [$typ, $p, $l, $kl];
        $p += $l;
    }
    return $aus;
}

function mp4_atom(string $typ, string $inhalt): string
{
    return pack('N', 8 + strlen($inhalt)) . $typ . $inhalt;
}

function mp4_daten(int $typ, string $wert): string
{
    return mp4_atom('data', pack('N', $typ) . "\0\0\0\0" . $wert);
}

/** Vorhandene ilst-Einträge: [[schluessel, roh]] – schluessel = Atomtyp oder „----:name“ */
function mp4_ilst_eintraege(string $ilst): array
{
    $aus = [];
    foreach (mp4_atome($ilst, 8) as [$typ, $s, $l]) {
        $roh = substr($ilst, $s, $l);
        $schluessel = $typ;
        if ($typ === '----') {
            foreach (mp4_atome($roh, 8) as [$t2, $s2, $l2]) {
                if ($t2 === 'name') {
                    $schluessel = '----:' . substr($roh, $s2 + 12, $l2 - 12);
                }
            }
        }
        $aus[] = [$schluessel, $roh];
    }
    return $aus;
}

function mp4_ilst_ist(array $eintraege): array
{
    $ist = [];
    foreach ($eintraege as [$k, $roh]) {
        $werte = [];
        foreach (mp4_atome($roh, 8) as [$t, $s, $l]) {
            if ($t === 'data') {
                $typ = unpack('N', substr($roh, $s + 8, 4))[1];
                if ($typ === 1) {
                    $werte[] = substr($roh, $s + 16, $l - 16);
                }
            }
        }
        if ($werte) {
            $ist[$k] = $werte;
        }
    }
    return $ist;
}

/** In einem moov-Puffer alle stco/co64-Einträge verschieben: $verschiebe(int alterOffset): int */
function mp4_offsets_anpassen(string &$moov, callable $verschiebe): void
{
    $lauf = function (int $von, int $bis) use (&$moov, &$lauf, $verschiebe): void {
        foreach (mp4_atome($moov, $von, $bis) as [$typ, $s, $l, $kl]) {
            if (in_array($typ, ['trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex'], true)) {
                $lauf($s + $kl, $s + $l);
            } elseif ($typ === 'stco' || $typ === 'co64') {
                $n = unpack('N', substr($moov, $s + $kl + 4, 4))[1];
                $p = $s + $kl + 8;
                for ($i = 0; $i < $n; $i++) {
                    if ($typ === 'stco') {
                        $alt = unpack('N', substr($moov, $p, 4))[1];
                        $neu = $verschiebe($alt);
                        if ($neu > 0xFFFFFFFF) {
                            throw new TagFehler(t('Datei zu groß für stco'));
                        }
                        $moov = substr_replace($moov, pack('N', $neu), $p, 4);
                        $p += 4;
                    } else {
                        $alt = (int) unpack('J', substr($moov, $p, 8))[1];
                        $moov = substr_replace($moov, pack('J', $verschiebe($alt)), $p, 8);
                        $p += 8;
                    }
                }
            }
        }
    };
    $k = mp4_atome($moov)[0];
    $lauf($k[3], $k[2]);
}

function mp4_schreiben(string $pfad, array $soll, ?array $cover, string $vorher): array
{
    $groesse = filesize($pfad);
    $f = fopen($pfad, 'rb');
    $oben = mp4_atome_datei($f, $groesse);
    $moovI = null;
    foreach ($oben as $i => $a) {
        if ($a[0] === 'moov') {
            $moovI = $i;
        }
    }
    if ($moovI === null) {
        fclose($f);
        throw new TagFehler(t('Kein moov-Atom'));
    }
    [, $moovStart, $moovLaenge, $moovKl] = $oben[$moovI];
    fseek($f, $moovStart);
    $moov = (string) fread($f, $moovLaenge);
    fclose($f);
    if ($moovKl !== 8) {
        throw new TagFehler(t('moov mit 64-Bit-Länge wird nicht unterstützt'));
    }
    // udta/meta/ilst suchen
    $kinder = mp4_atome($moov, 8);
    $udta = null;
    foreach ($kinder as $k) {
        if ($k[0] === 'udta') {
            $udta = substr($moov, $k[1], $k[2]);
        }
    }
    $meta = null;
    $udtaRest = '';
    if ($udta !== null) {
        foreach (mp4_atome($udta, 8) as [$t, $s, $l]) {
            if ($t === 'meta' && $meta === null) {
                $meta = substr($udta, $s, $l);
            } else {
                $udtaRest .= substr($udta, $s, $l);
            }
        }
    }
    $ilst = null;
    $hdlr = null;
    $metaRest = '';
    if ($meta !== null) {
        foreach (mp4_atome($meta, 12) as [$t, $s, $l]) {
            $roh = substr($meta, $s, $l);
            if ($t === 'ilst') {
                $ilst = $roh;
            } elseif ($t === 'hdlr') {
                $hdlr = $roh;
            } elseif ($t !== 'free') {
                $metaRest .= $roh;
            }
        }
    }
    $hdlr ??= mp4_atom('hdlr', "\0\0\0\0" . "\0\0\0\0" . 'mdir' . 'appl' . str_repeat("\0", 8) . "\0");
    $eintraege = $ilst !== null ? mp4_ilst_eintraege($ilst) : [];
    $ist = mp4_ilst_ist($eintraege);
    // ersetzen, was wir setzen
    $weg = [];
    foreach (MP4_TEXT as $feld => $atom) {
        if (isset($soll[$feld])) {
            $weg[$atom] = 1;
        }
    }
    foreach (MP4_FREI as $feld => $name) {
        if (isset($soll[$feld])) {
            $weg['----:' . mb_strtolower($name)] = 1;
        }
    }
    if (isset($soll['TRACKNUMBER'])) {
        $weg['trkn'] = 1;
    }
    if (isset($soll['DISCNUMBER'])) {
        $weg['disk'] = 1;
    }
    if (isset($soll['GENRE'])) {
        $weg['gnre'] = 1;
    }
    if ($cover) {
        $weg['covr'] = 1;
    }
    $neuIlst = '';
    $sauber = tags_sauber();
    foreach ($eintraege as [$k, $roh]) {
        $kk = str_starts_with($k, '----:') ? '----:' . mb_strtolower(substr($k, 5)) : $k;
        if (isset($weg[$kk])) {
            continue;
        }
        if ($sauber) {
            // immer behalten: Angaben für lückenlose Wiedergabe (iTunSMPB, pgap); sonst nur Liedtexte/ISRC/Kennzeichnung und Bilder ohne neues Cover
            $technik = $kk === '----:itunsmpb' || $k === 'pgap';
            $text = $k === "\xA9lyr" && (tag_behalten('LYRICS') || tag_behalten('UNSYNCEDLYRICS'));
            $frei = str_starts_with($kk, '----:') && tag_behalten(substr($k, 5));
            $bild = $k === 'covr' && !$cover;
            $rating = $k === 'rtng' && tag_behalten('ITUNESADVISORY'); // Kennzeichnung „explizit“ (iTunes-Atom)
            if (!$technik && !$text && !$frei && !$bild && !$rating) {
                continue;
            }
        }
        $neuIlst .= $roh;
    }
    foreach (MP4_TEXT as $feld => $atom) {
        if (isset($soll[$feld])) {
            $neuIlst .= mp4_atom($atom, implode('', array_map(static fn($w) => mp4_daten(1, $w), $soll[$feld])));
        }
    }
    if (isset($soll['TRACKNUMBER'])) {
        $neuIlst .= mp4_atom('trkn', mp4_daten(0, pack('nnnn', 0, (int) $soll['TRACKNUMBER'][0], (int) ($soll['TRACKTOTAL'][0] ?? 0), 0)));
    }
    if (isset($soll['DISCNUMBER'])) {
        $neuIlst .= mp4_atom('disk', mp4_daten(0, pack('nnn', 0, (int) $soll['DISCNUMBER'][0], (int) ($soll['DISCTOTAL'][0] ?? 0))));
    }
    foreach (MP4_FREI as $feld => $name) {
        if (isset($soll[$feld])) {
            $neuIlst .= mp4_atom('----', mp4_atom('mean', "\0\0\0\0com.apple.iTunes") . mp4_atom('name', "\0\0\0\0" . $name)
                . implode('', array_map(static fn($w) => mp4_daten(1, $w), $soll[$feld])));
        }
    }
    if ($cover) {
        $neuIlst .= mp4_atom('covr', mp4_daten($cover['mime'] === 'image/png' ? 14 : 13, $cover['daten']));
    }
    $neuMeta = mp4_atom('meta', "\0\0\0\0" . $hdlr . mp4_atom('ilst', $neuIlst) . $metaRest);
    $neuUdta = mp4_atom('udta', $udtaRest . $neuMeta);
    $neuMoovInhalt = '';
    $udtaDa = false;
    foreach ($kinder as [$t, $s, $l]) {
        if ($t === 'udta') {
            $neuMoovInhalt .= $neuUdta;
            $udtaDa = true;
        } else {
            $neuMoovInhalt .= substr($moov, $s, $l);
        }
    }
    if (!$udtaDa) {
        $neuMoovInhalt .= $neuUdta;
    }
    $neuMoov = mp4_atom('moov', $neuMoovInhalt);
    $delta = strlen($neuMoov) - $moovLaenge;

    // 1. Passt es in moov + direkt folgenden free-Block? Dann nur diesen Bereich überschreiben (Offsets bleiben gleich)
    $danach = $oben[$moovI + 1] ?? null;
    $frei = $danach && $danach[0] === 'free' ? $danach[2] : 0;
    $rest = $frei - $delta; // neue Größe des free-Blocks dahinter (0 = keiner)
    {
        if ($rest === 0 || $rest >= 8) {
            $f = fopen($pfad, 'rb');
            fseek($f, $moovStart);
            $alterKopf = (string) fread($f, $moovLaenge + $frei);
            fclose($f);
            $daten = $neuMoov . ($rest >= 8 ? pack('N', $rest) . 'free' . str_repeat("\0", $rest - 8) : '');
            datei_bereich_schreiben($pfad, $moovStart, $daten);
            // alter Kopf für die Wiederherstellung ab Dateianfang aufbereiten
            $f = fopen($pfad, 'rb');
            $vorne = (string) fread($f, $moovStart);
            fclose($f);
            return ['art' => 'kopf', 'alt' => $ist, 'alter_kopf' => $vorne . $alterKopf];
        }
    }
    // 2. Neu zusammensetzen: moov ersetzen, folgendes free weglassen, eigenes Polster dahinter; Chunk-Offsets anpassen
    $polster = 4096;
    $neuBlock = $neuMoov . pack('N', $polster) . 'free' . str_repeat("\0", $polster - 8);
    $altBlockEnde = $moovStart + $moovLaenge + $frei;
    $verschiebung = strlen($neuBlock) - ($moovLaenge + $frei);
    // Daten hinter moov rücken um $verschiebung; davor bleibt alles
    mp4_offsets_anpassen($neuMoov, static fn(int $o) => $o >= $altBlockEnde ? $o + $verschiebung : $o);
    $neuBlock = $neuMoov . pack('N', $polster) . 'free' . str_repeat("\0", $polster - 8);
    $f = fopen($pfad, 'rb');
    $vorne = (string) fread($f, $moovStart);
    fclose($f);
    datei_neu_zusammensetzen($pfad, $vorne . $neuBlock, $altBlockEnde, $vorher);
    return ['art' => 'neu', 'alt' => $ist];
}
