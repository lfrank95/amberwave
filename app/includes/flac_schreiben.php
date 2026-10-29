<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/schreibschutz.php';
require_once __DIR__ . '/tags_flac.php';

/**
 * Vorbis-Kommentare einer FLAC-Datei ersetzen (Mehrfachwerte möglich).
 * Sicher: schreibt in eine temporäre Datei daneben, prüft sie und ersetzt erst dann das Original.
 * Wird ab v0.2 für das Zurückschreiben der MusicBrainz-Daten genutzt; in v0.1 nur für Testdaten.
 *
 * @param array $tags ['FELD' => ['wert1', 'wert2'], …]  (Feldnamen werden groß geschrieben)
 */
function flac_tags_schreiben(string $pfad, array $tags, string $vendor = 'Amberwave'): void
{
    musik_schreibschutz($pfad);
    $f = fopen($pfad, 'rb');
    if (!$f || fread($f, 4) !== 'fLaC') {
        throw new RuntimeException(t('Keine FLAC-Datei: {pfad}', ['pfad' => $pfad]));
    }
    $bloecke = [];
    $letzter = false;
    while (!$letzter) {
        $kopf = fread($f, 4);
        if ($kopf === false || strlen($kopf) < 4) {
            throw new RuntimeException(t('Beschädigte Metadaten'));
        }
        $letzter = (ord($kopf[0]) & 0x80) !== 0;
        $typ = ord($kopf[0]) & 0x7f;
        $laenge = (ord($kopf[1]) << 16) | (ord($kopf[2]) << 8) | ord($kopf[3]);
        $daten = $laenge > 0 ? fread($f, $laenge) : '';
        if ($typ !== 4 && $typ !== 1) { // alten Kommentar und Füllblock verwerfen
            $bloecke[] = [$typ, $daten];
        }
    }
    $audio_start = ftell($f);

    $vc = pack('V', strlen($vendor)) . $vendor;
    $eintraege = [];
    foreach ($tags as $feld => $werte) {
        $feld = strtoupper((string) $feld);
        if (!preg_match('/^[\x20-\x3C\x3E-\x7D]+$/', $feld)) {
            continue;
        }
        foreach ((array) $werte as $w) {
            $w = (string) $w;
            if ($w !== '') {
                $eintraege[] = $feld . '=' . $w;
            }
        }
    }
    $vc .= pack('V', count($eintraege));
    foreach ($eintraege as $e) {
        $vc .= pack('V', strlen($e)) . $e;
    }
    // STREAMINFO muss zuerst kommen, Kommentar direkt dahinter, etwas Polster am Ende
    $neu = [];
    foreach ($bloecke as $i => $b) {
        $neu[] = $b;
        if ($i === 0) {
            $neu[] = [4, $vc];
        }
    }
    $neu[] = [1, str_repeat("\0", 4096)];

    $tmp = $pfad . '.amberwave.tmp';
    $o = fopen($tmp, 'wb');
    fwrite($o, 'fLaC');
    $n = count($neu);
    foreach ($neu as $i => [$typ, $daten]) {
        $l = strlen($daten);
        if ($l > 0xFFFFFF) {
            fclose($o);
            @unlink($tmp);
            throw new RuntimeException(t('Metadatenblock zu groß'));
        }
        fwrite($o, chr(($i === $n - 1 ? 0x80 : 0) | $typ) . chr(($l >> 16) & 0xff) . chr(($l >> 8) & 0xff) . chr($l & 0xff) . $daten);
    }
    fseek($f, $audio_start);
    stream_copy_to_stream($f, $o);
    fclose($f);
    fclose($o);

    // Prüfen, dann ersetzen
    $alt = flac_lesen($pfad);
    $pruef = flac_lesen($tmp);
    if ($pruef['technik']['laenge_ms'] !== $alt['technik']['laenge_ms'] || filesize($tmp) - $audio_start < 0) {
        @unlink($tmp);
        throw new RuntimeException(t('Prüfung der neuen Datei fehlgeschlagen'));
    }
    $mtime = filemtime($pfad);
    if (!rename($tmp, $pfad)) {
        @unlink($tmp);
        throw new RuntimeException(t('Datei konnte nicht ersetzt werden'));
    }
}

/** Bild (Vorderseite) in eine FLAC-Datei einbetten – nur für Testdaten. */
function flac_bild_einbetten(string $pfad, string $jpeg): void
{
    musik_schreibschutz($pfad);
    $f = fopen($pfad, 'rb');
    fread($f, 4);
    $bloecke = [];
    $letzter = false;
    while (!$letzter) {
        $kopf = fread($f, 4);
        $letzter = (ord($kopf[0]) & 0x80) !== 0;
        $typ = ord($kopf[0]) & 0x7f;
        $laenge = (ord($kopf[1]) << 16) | (ord($kopf[2]) << 8) | ord($kopf[3]);
        $daten = $laenge > 0 ? fread($f, $laenge) : '';
        if ($typ !== 6) {
            $bloecke[] = [$typ, $daten];
        }
    }
    $start = ftell($f);
    $mime = 'image/jpeg';
    $bild = pack('N', 3) . pack('N', strlen($mime)) . $mime . pack('N', 0) . pack('NNNN', 0, 0, 24, 0) . pack('N', strlen($jpeg)) . $jpeg;
    $bloecke[] = [6, $bild];
    $tmp = $pfad . '.tmp';
    $o = fopen($tmp, 'wb');
    fwrite($o, 'fLaC');
    $n = count($bloecke);
    foreach ($bloecke as $i => [$typ, $daten]) {
        $l = strlen($daten);
        fwrite($o, chr(($i === $n - 1 ? 0x80 : 0) | $typ) . chr(($l >> 16) & 0xff) . chr(($l >> 8) & 0xff) . chr($l & 0xff) . $daten);
    }
    fseek($f, $start);
    stream_copy_to_stream($f, $o);
    fclose($f);
    fclose($o);
    rename($tmp, $pfad);
}
