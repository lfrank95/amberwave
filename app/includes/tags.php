<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/tags_flac.php';
require_once __DIR__ . '/i18n.php';

/**
 * Einheitliches Lesen von Tags und Technik für alle Formate.
 * FLAC: eigener, schneller Leser. Alles andere: ffprobe.
 * Rückgabe: ['technik' => [...], 'tags' => ['FELD' => [werte]], 'hat_bild' => bool]
 */
function datei_lesen(string $pfad): array
{
    $endung = strtolower(pathinfo($pfad, PATHINFO_EXTENSION));
    if ($endung === 'flac') {
        try {
            $r = flac_lesen($pfad);
            return ['technik' => $r['technik'], 'tags' => $r['tags'], 'hat_bild' => (bool) $r['bilder']];
        } catch (Throwable $e) {
            // kaputter Kopf o. Ä. -> ffprobe versuchen
        }
    }
    return ffprobe_lesen($pfad);
}

function ffprobe_lesen(string $pfad): array
{
    $cmd = escapeshellarg(konfig()['stream']['ffprobe']) . ' -v error -print_format json -show_format -show_streams ' . escapeshellarg($pfad) . ' 2>/dev/null';
    $json = shell_exec($cmd);
    $d = is_string($json) ? json_decode($json, true) : null;
    if (!is_array($d) || empty($d['streams'])) {
        throw new RuntimeException(t('ffprobe konnte die Datei nicht lesen'));
    }
    $audio = null;
    $hat_bild = false;
    foreach ($d['streams'] as $s) {
        if (($s['codec_type'] ?? '') === 'audio' && $audio === null) {
            $audio = $s;
        }
        if (($s['codec_type'] ?? '') === 'video' && !empty($s['disposition']['attached_pic'])) {
            $hat_bild = true;
        }
    }
    if ($audio === null) {
        throw new RuntimeException(t('Keine Tonspur gefunden'));
    }
    $dauer = (float) ($d['format']['duration'] ?? $audio['duration'] ?? 0);
    $bits = (int) ($audio['bits_per_raw_sample'] ?? 0) ?: (int) ($audio['bits_per_sample'] ?? 0);
    $technik = [
        'format' => strtolower(pathinfo($pfad, PATHINFO_EXTENSION)),
        'codec' => (string) ($audio['codec_name'] ?? ''),
        'abtastrate' => (int) ($audio['sample_rate'] ?? 0),
        'kanaele' => (int) ($audio['channels'] ?? 0),
        'bittiefe' => in_array($audio['codec_name'] ?? '', ['mp3', 'aac', 'opus', 'vorbis'], true) ? 0 : $bits,
        'laenge_ms' => (int) round($dauer * 1000),
        'bitrate' => (int) ($audio['bit_rate'] ?? $d['format']['bit_rate'] ?? 0),
    ];
    $roh = array_merge($d['format']['tags'] ?? [], $audio['tags'] ?? []);
    return ['technik' => $technik, 'tags' => ffprobe_tags_normalisieren($roh), 'hat_bild' => $hat_bild];
}

/** ffprobe-Tagnamen (ID3, MP4, Vorbis) auf Vorbis-/Picard-Namen abbilden. */
function ffprobe_tags_normalisieren(array $roh): array
{
    $karte = [
        'ALBUM_ARTIST' => 'ALBUMARTIST', 'ALBUM ARTIST' => 'ALBUMARTIST', 'TPE2' => 'ALBUMARTIST', 'AART' => 'ALBUMARTIST',
        'TRACK' => 'TRACKNUMBER', 'DISC' => 'DISCNUMBER', 'DISK' => 'DISCNUMBER', 'TPOS' => 'DISCNUMBER',
        'YEAR' => 'DATE', 'TDRC' => 'DATE', 'TYER' => 'DATE', 'ORIGINALYEAR' => 'ORIGINALDATE', 'TDOR' => 'ORIGINALDATE',
        'TCOM' => 'COMPOSER', 'TEXT' => 'LYRICIST', 'TCON' => 'GENRE', 'TPUB' => 'LABEL', 'PUBLISHER' => 'LABEL',
        'MUSICBRAINZ ALBUM ID' => 'MUSICBRAINZ_ALBUMID', 'MUSICBRAINZ ARTIST ID' => 'MUSICBRAINZ_ARTISTID',
        'MUSICBRAINZ ALBUM ARTIST ID' => 'MUSICBRAINZ_ALBUMARTISTID', 'MUSICBRAINZ RELEASE GROUP ID' => 'MUSICBRAINZ_RELEASEGROUPID',
        'MUSICBRAINZ RELEASE TRACK ID' => 'MUSICBRAINZ_RELEASETRACKID', 'MUSICBRAINZ TRACK ID' => 'MUSICBRAINZ_TRACKID',
        'MUSICBRAINZ WORK ID' => 'MUSICBRAINZ_WORKID', 'MUSICBRAINZ ALBUM TYPE' => 'RELEASETYPE', 'MUSICBRAINZ ALBUM STATUS' => 'RELEASESTATUS',
        'MUSICBRAINZ ALBUM RELEASE COUNTRY' => 'RELEASECOUNTRY', 'MUSICBRAINZ_ALBUMTYPE' => 'RELEASETYPE', 'MUSICBRAINZ_ALBUMSTATUS' => 'RELEASESTATUS',
        'CATALOGNUMBER' => 'CATALOGNUMBER', 'CATALOG NUMBER' => 'CATALOGNUMBER', 'ARTISTSORT' => 'ARTISTSORT', 'SORT_ARTIST' => 'ARTISTSORT',
        'ALBUMARTISTSORT' => 'ALBUMARTISTSORT', 'SORT_ALBUM_ARTIST' => 'ALBUMARTISTSORT', 'COMPILATION' => 'COMPILATION', 'TCMP' => 'COMPILATION', 'CPIL' => 'COMPILATION',
        'REPLAYGAIN_TRACK_GAIN' => 'REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_ALBUM_GAIN' => 'REPLAYGAIN_ALBUM_GAIN',
    ];
    $tags = [];
    foreach ($roh as $k => $w) {
        $k = strtoupper(trim((string) $k));
        if (str_starts_with($k, 'ID3V2_PRIV') || $k === 'ENCODER' || $k === 'MAJOR_BRAND' || $k === 'MINOR_VERSION' || $k === 'COMPATIBLE_BRANDS') {
            continue;
        }
        $k = $karte[$k] ?? $karte[str_replace('_', ' ', $k)] ?? $k;
        $werte = preg_split('/\s*;\s*/u', (string) $w) ?: [];
        // Nur Felder, die erfahrungsgemäß Listen sind, werden an ";" getrennt; Titel/Album bleiben unberührt
        if (!in_array($k, ['ARTISTS', 'ALBUMARTISTS', 'GENRE', 'MUSICBRAINZ_ARTISTID', 'MUSICBRAINZ_ALBUMARTISTID', 'COMPOSER', 'LYRICIST', 'PERFORMER', 'PRODUCER', 'MUSICBRAINZ_WORKID'], true)) {
            $werte = [(string) $w];
        }
        foreach ($werte as $e) {
            $e = trim(str_replace("\0", '', $e));
            if ($e !== '') {
                $tags[$k][] = $e;
            }
        }
    }
    return $tags;
}

/** Eingebettetes Cover als [daten, mime] oder null. Bevorzugt Typ 3 (Vorderseite). */
function eingebettetes_bild(string $pfad): ?array
{
    if (strtolower(pathinfo($pfad, PATHINFO_EXTENSION)) === 'flac') {
        try {
            $r = flac_lesen($pfad, true);
            $wahl = null;
            foreach ($r['bilder'] as $b) {
                if (!empty($b['daten']) && ($wahl === null || ($b['typ'] === 3 && $wahl['typ'] !== 3))) {
                    $wahl = $b;
                }
            }
            if ($wahl) {
                return [$wahl['daten'], $wahl['mime'] ?: 'image/jpeg'];
            }
            return null;
        } catch (Throwable $e) {
        }
    }
    $cmd = escapeshellarg(konfig()['stream']['ffmpeg']) . ' -v error -i ' . escapeshellarg($pfad) . ' -an -map 0:v:0 -frames:v 1 -c:v copy -f image2pipe pipe:1 2>/dev/null';
    $daten = shell_exec($cmd);
    if (!is_string($daten) || strlen($daten) < 100) {
        return null;
    }
    $mime = str_starts_with($daten, "\x89PNG") ? 'image/png' : 'image/jpeg';
    return [$daten, $mime];
}

/** Erster Wert eines Tags oder ''. */
function tag1(array $tags, string ...$felder): string
{
    foreach ($felder as $f) {
        if (!empty($tags[$f][0])) {
            return trim((string) $tags[$f][0]);
        }
    }
    return '';
}

/** Alle Werte eines Tags (Mehrfachfelder und mit "/" oder ";" verbundene IDs aufgetrennt, falls gewünscht). */
function tagliste(array $tags, string $feld, bool $trennen = false): array
{
    $aus = [];
    foreach ($tags[$feld] ?? [] as $w) {
        foreach ($trennen ? (preg_split('#\s*[;/]\s*#', $w) ?: []) : [$w] as $t) {
            $t = trim($t);
            if ($t !== '') {
                $aus[] = $t;
            }
        }
    }
    return $aus;
}

/** "3/12" -> [3, 12] */
function nummer_paar(string $s): array
{
    if (preg_match('/^\s*(\d+)\s*(?:\/\s*(\d+))?/', $s, $m)) {
        return [(int) $m[1], isset($m[2]) ? (int) $m[2] : 0];
    }
    return [0, 0];
}

/** "1982-11-30" / "1982" / "30.11.1982" -> ['1982-11-30', 1982] */
function datum_aus_tag(string $s): array
{
    $s = trim($s);
    if (preg_match('/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/', $s, $m)) {
        $d = $m[1] . (isset($m[2]) ? '-' . $m[2] : '') . (isset($m[3]) ? '-' . $m[3] : '');
        return [$d, (int) $m[1]];
    }
    if (preg_match('/(\d{4})/', $s, $m)) {
        return [$m[1], (int) $m[1]];
    }
    return ['', null];
}
