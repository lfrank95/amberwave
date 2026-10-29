<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

/**
 * Schneller FLAC-Leser in reinem PHP: STREAMINFO (Technik), VORBIS_COMMENT (Tags) und PICTURE (Cover).
 * Liest nur die Metadaten-Blöcke am Dateianfang – kein Dekodieren, deshalb sehr schnell auch bei großen Sammlungen.
 * Rückgabe: ['technik' => [...], 'tags' => ['TITLE' => ['…'], …], 'bilder' => [['typ'=>3,'mime'=>…,'offset'=>…,'laenge'=>…], …]]
 */
function flac_lesen(string $pfad, bool $bilddaten = false): array
{
    $f = @fopen($pfad, 'rb');
    if (!$f) {
        throw new RuntimeException(t('Datei nicht lesbar'));
    }
    try {
        $kopf = fread($f, 4);
        if ($kopf === 'ID3') {
            // ID3v2 vor dem FLAC-Kopf (kommt vor) überspringen
            $id3 = fread($f, 6);
            $groesse = ((ord($id3[2]) & 0x7f) << 21) | ((ord($id3[3]) & 0x7f) << 14) | ((ord($id3[4]) & 0x7f) << 7) | (ord($id3[5]) & 0x7f);
            fseek($f, 10 + $groesse);
            $kopf = fread($f, 4);
        }
        if ($kopf !== 'fLaC') {
            throw new RuntimeException(t('Keine gültige FLAC-Datei'));
        }
        $technik = [];
        $tags = [];
        $bilder = [];
        $letzter = false;
        $bloecke = 0;
        while (!$letzter && $bloecke++ < 128) {
            $bkopf = fread($f, 4);
            if ($bkopf === false || strlen($bkopf) < 4) {
                break;
            }
            $letzter = (ord($bkopf[0]) & 0x80) !== 0;
            $typ = ord($bkopf[0]) & 0x7f;
            $laenge = (ord($bkopf[1]) << 16) | (ord($bkopf[2]) << 8) | ord($bkopf[3]);
            $start = ftell($f);
            if ($typ === 0 && $laenge >= 34) { // STREAMINFO
                $d = fread($f, 34);
                $x = unpack('J', substr($d, 10, 8))[1]; // 20 Bit Rate, 3 Bit Kanäle-1, 5 Bit Bits-1, 36 Bit Samples
                $rate = ($x >> 44) & 0xFFFFF;
                $kanaele = (($x >> 41) & 0x7) + 1;
                $bits = (($x >> 36) & 0x1F) + 1;
                $samples = $x & 0xFFFFFFFFF;
                $technik = [
                    'format' => 'flac', 'codec' => 'flac', 'abtastrate' => $rate, 'kanaele' => $kanaele, 'bittiefe' => $bits,
                    'laenge_ms' => $rate > 0 ? (int) round($samples * 1000 / $rate) : 0,
                    'samples' => $samples,
                ];
            } elseif ($typ === 4 && $laenge > 8) { // VORBIS_COMMENT
                $d = fread($f, min($laenge, 16 * 1024 * 1024));
                $tags = vorbis_kommentare_parsen($d);
            } elseif ($typ === 6 && $laenge > 32) { // PICTURE
                $d = fread($f, min($laenge, 4096));
                $p = 0;
                $bildtyp = unpack('N', substr($d, $p, 4))[1]; $p += 4;
                $ml = unpack('N', substr($d, $p, 4))[1]; $p += 4;
                $mime = substr($d, $p, min($ml, 100)); $p += $ml;
                $dl = unpack('N', substr($d, $p, 4))[1]; $p += 4 + $dl;
                $p += 16; // Breite, Höhe, Farbtiefe, Farben
                $datenlaenge = unpack('N', substr($d, $p, 4))[1]; $p += 4;
                $bild = ['typ' => $bildtyp, 'mime' => strtolower($mime), 'offset' => $start + $p, 'laenge' => $datenlaenge];
                if ($bilddaten && $datenlaenge > 0 && $datenlaenge < 30 * 1024 * 1024) {
                    fseek($f, $start + $p);
                    $bild['daten'] = fread($f, $datenlaenge);
                }
                $bilder[] = $bild;
            }
            fseek($f, $start + $laenge);
        }
        if (!$technik) {
            throw new RuntimeException(t('FLAC ohne STREAMINFO'));
        }
        $groesse = filesize($pfad) ?: 0;
        $audio_bytes = max(0, $groesse - ftell($f));
        $technik['bitrate'] = $technik['laenge_ms'] > 0 ? (int) round($audio_bytes * 8 / ($technik['laenge_ms'] / 1000)) : 0;
        return ['technik' => $technik, 'tags' => $tags, 'bilder' => $bilder];
    } finally {
        fclose($f);
    }
}

/** Vorbis-Kommentar-Block in ['FELD' => [werte…]] (Feldnamen groß, Mehrfachwerte bleiben erhalten). */
function vorbis_kommentare_parsen(string $d): array
{
    $tags = [];
    $p = 0;
    $n = strlen($d);
    if ($n < 8) {
        return $tags;
    }
    $vl = unpack('V', substr($d, $p, 4))[1];
    $p += 4 + $vl;
    if ($p + 4 > $n) {
        return $tags;
    }
    $anzahl = unpack('V', substr($d, $p, 4))[1];
    $p += 4;
    for ($i = 0; $i < $anzahl && $p + 4 <= $n; $i++) {
        $l = unpack('V', substr($d, $p, 4))[1];
        $p += 4;
        if ($l > $n - $p) {
            break;
        }
        $eintrag = substr($d, $p, $l);
        $p += $l;
        $gleich = strpos($eintrag, '=');
        if ($gleich === false || $gleich === 0) {
            continue;
        }
        $feld = strtoupper(substr($eintrag, 0, $gleich));
        $wert = substr($eintrag, $gleich + 1);
        if (!mb_check_encoding($wert, 'UTF-8')) {
            $wert = mb_convert_encoding($wert, 'UTF-8', 'ISO-8859-1');
        }
        $wert = trim(str_replace("\0", '', $wert));
        if ($wert !== '') {
            $tags[$feld][] = $wert;
        }
    }
    return $tags;
}
