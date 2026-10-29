<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';
require_once __DIR__ . '/hilfen.php';

/**
 * Cover und Künstlerbilder im Cache-Ordner (SSD).
 * Ablage: /cache/cover/<schluessel>_<groesse>.jpg (Vorschaubilder) und <schluessel>_orig.jpg (max. 1200 px).
 */

function bild_ordner(string $art): string
{
    $o = konfig()['pfade']['cache'] . '/' . ($art === 'kuenstler' ? 'bilder' : ($art === 'profil' ? 'profil' : 'cover'));
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return $o;
}

/**
 * Bilddaten speichern und Vorschaubilder erzeugen. Liefert den Schlüssel (für die Datenbank) oder null.
 * $praefix z. B. "e12" für Edition 12.
 */
function bild_speichern(string $art, string $praefix, string $daten): ?string
{
    if (strlen($daten) < 100 || !function_exists('imagecreatefromstring')) {
        return null;
    }
    $quelle = @imagecreatefromstring($daten);
    if (!$quelle) {
        return null;
    }
    $b = imagesx($quelle);
    $h = imagesy($quelle);
    if ($b < 32 || $h < 32) {
        imagedestroy($quelle);
        return null;
    }
    $schluessel = datei_sicher($praefix) . '_' . substr(hash('sha256', $daten), 0, 12);
    $ordner = bild_ordner($art);
    $groessen = array_unique(array_filter(array_merge(konfig()['scan']['cover_groessen'], [1200]), static fn($g) => $g >= 64 && $g <= 3000));
    sort($groessen);
    foreach ($groessen as $g) {
        $ziel = $ordner . '/' . $schluessel . '_' . $g . '.jpg';
        if (is_file($ziel)) {
            continue;
        }
        $faktor = min(1.0, $g / max($b, $h));
        $nb = max(1, (int) round($b * $faktor));
        $nh = max(1, (int) round($h * $faktor));
        $bild = imagecreatetruecolor($nb, $nh);
        imagefill($bild, 0, 0, imagecolorallocate($bild, 20, 16, 12));
        imagecopyresampled($bild, $quelle, 0, 0, 0, 0, $nb, $nh, $b, $h);
        if (function_exists('imageinterlace')) {
            imageinterlace($bild, true);
        }
        imagejpeg($bild, $ziel . '.tmp', 86);
        imagedestroy($bild);
        @rename($ziel . '.tmp', $ziel);
    }
    imagedestroy($quelle);
    return $schluessel;
}

/**
 * Profilbild: mittig quadratisch zuschneiden (höchstens 512 px) und wie ein Cover ablegen. Liefert den Schlüssel oder null.
 */
function profilbild_speichern(int $userId, string $daten): ?string
{
    if (strlen($daten) < 100 || !function_exists('imagecreatefromstring')) {
        return null;
    }
    $q = @imagecreatefromstring($daten);
    if (!$q) {
        return null;
    }
    $b = imagesx($q);
    $h = imagesy($q);
    $s = min($b, $h);
    if ($s < 32) {
        imagedestroy($q);
        return null;
    }
    $g = min(512, $s);
    $bild = imagecreatetruecolor($g, $g);
    imagefill($bild, 0, 0, imagecolorallocate($bild, 20, 16, 12));
    imagecopyresampled($bild, $q, 0, 0, intdiv($b - $s, 2), intdiv($h - $s, 2), $g, $g, $s, $s);
    imagedestroy($q);
    ob_start();
    imagejpeg($bild, null, 90);
    imagedestroy($bild);
    return bild_speichern('profil', 'u' . $userId, (string) ob_get_clean());
}

/** Pfad zum passenden Vorschaubild (nächstgrößere Stufe) oder null. */
function bild_pfad(string $art, string $schluessel, int $wunsch): ?string
{
    if (!preg_match('/^[A-Za-z0-9._-]+$/', $schluessel)) {
        return null;
    }
    $groessen = array_unique(array_merge(konfig()['scan']['cover_groessen'], [1200]));
    sort($groessen);
    $wahl = end($groessen);
    foreach ($groessen as $g) {
        if ($g >= $wunsch) {
            $wahl = $g;
            break;
        }
    }
    $pfad = bild_ordner($art) . '/' . $schluessel . '_' . $wahl . '.jpg';
    if (is_file($pfad)) {
        return $pfad;
    }
    // Stufe fehlt (z. B. nach neu hinzugekommener Größe): einmalig aus der nächstgrößeren vorhandenen erzeugen und ablegen
    foreach ($groessen as $g) {
        $q = bild_ordner($art) . '/' . $schluessel . '_' . $g . '.jpg';
        if ($g > $wahl && is_file($q) && bild_stufe_erzeugen($q, $pfad, $wahl)) {
            return $pfad;
        }
    }
    foreach (array_reverse($groessen) as $g) {
        $p = bild_ordner($art) . '/' . $schluessel . '_' . $g . '.jpg';
        if (is_file($p)) {
            return $p;
        }
    }
    return null;
}

/** Kleinere Stufe aus einer größeren Datei berechnen (nur verkleinern). */
function bild_stufe_erzeugen(string $quelle, string $ziel, int $g): bool
{
    if (!function_exists('imagecreatefromjpeg')) {
        return false;
    }
    $q = @imagecreatefromjpeg($quelle);
    if (!$q) {
        return false;
    }
    $b = imagesx($q);
    $h = imagesy($q);
    $f = min(1.0, $g / max($b, $h));
    $nb = max(1, (int) round($b * $f));
    $nh = max(1, (int) round($h * $f));
    $bild = imagecreatetruecolor($nb, $nh);
    imagecopyresampled($bild, $q, 0, 0, 0, 0, $nb, $nh, $b, $h);
    imagedestroy($q);
    if (function_exists('imageinterlace')) {
        imageinterlace($bild, true);
    }
    $tmp = $ziel . '.' . getmypid() . '.tmp';
    $ok = @imagejpeg($bild, $tmp, 86) && @rename($tmp, $ziel);
    imagedestroy($bild);
    if (!$ok) {
        @unlink($tmp);
    }
    return $ok;
}

/**
 * Durchschnittsfarbe eines Bildes (#rrggbb) als Platzhalter, solange das Bild lädt. Wird einmal berechnet und neben dem Bild abgelegt.
 */
function bild_farbe(string $art, ?string $schluessel): ?string
{
    if (!$schluessel || !preg_match('/^[A-Za-z0-9._-]+$/', $schluessel)) {
        return null;
    }
    $datei = bild_ordner($art) . '/' . $schluessel . '.farbe';
    if (is_file($datei)) {
        $f = trim((string) @file_get_contents($datei));
        return preg_match('/^#[0-9a-f]{6}$/', $f) ? $f : null;
    }
    $pfad = bild_pfad($art, $schluessel, 300);
    if (!$pfad || !function_exists('imagecreatefromjpeg')) {
        return null;
    }
    $q = @imagecreatefromjpeg($pfad);
    if (!$q) {
        return null;
    }
    $eins = imagecreatetruecolor(1, 1);
    imagecopyresampled($eins, $q, 0, 0, 0, 0, 1, 1, imagesx($q), imagesy($q));
    $c = imagecolorat($eins, 0, 0);
    imagedestroy($q);
    imagedestroy($eins);
    $f = sprintf('#%02x%02x%02x', ($c >> 16) & 255, ($c >> 8) & 255, $c & 255);
    @file_put_contents($datei, $f);
    return $f;
}

/** Alle Dateien eines Bild-Schlüssels löschen. */
function bild_loeschen(string $art, string $schluessel): void
{
    if ($schluessel === '' || !preg_match('/^[A-Za-z0-9._-]+$/', $schluessel)) {
        return;
    }
    foreach (glob(bild_ordner($art) . '/' . $schluessel . '_*.{jpg,webp}', GLOB_BRACE) ?: [] as $f) {
        @unlink($f);
    }
    @unlink(bild_ordner($art) . '/' . $schluessel . '.farbe');
}

/** Ein Bild im Albumordner finden (cover.jpg, folder.png …). */
function ordner_bild_finden(string $ordner): ?string
{
    $namen = konfig()['scan']['cover_namen'];
    $treffer = [];
    foreach (@scandir($ordner) ?: [] as $f) {
        $info = pathinfo($f);
        $ext = strtolower($info['extension'] ?? '');
        if (!in_array($ext, ['jpg', 'jpeg', 'png', 'webp'], true)) {
            continue;
        }
        $stamm = strtolower($info['filename']);
        $rang = array_search($stamm, $namen, true);
        if ($rang !== false) {
            $treffer[$rang] = $ordner . '/' . $f;
        }
    }
    if (!$treffer) {
        return null;
    }
    ksort($treffer);
    return reset($treffer);
}
