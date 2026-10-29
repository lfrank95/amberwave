<?php
// App-Symbol als PNG (für PWA-Installation, Startbildschirm, Favicon). Ohne Anmeldung abrufbar.
declare(strict_types=1);
require_once __DIR__ . '/includes/config.php';

$s = max(16, min(1024, (int) ($_GET['s'] ?? 192)));
$maskable = !empty($_GET['m']);
$cache = konfig()['pfade']['cache'] . '/tmp/icon-' . $s . ($maskable ? '-m' : '') . '-v1.png';
if (is_file($cache)) {
    header('Content-Type: image/png');
    header('Cache-Control: public, max-age=604800');
    readfile($cache);
    exit;
}

$f = 4; // Supersampling für glatte Kanten
$n = $s * $f;
$im = imagecreatetruecolor($n, $n);
imagesavealpha($im, true);
imagealphablending($im, false);
imagefill($im, 0, 0, imagecolorallocatealpha($im, 0, 0, 0, 127));
imagealphablending($im, true);

$grund = imagecolorallocate($im, 26, 18, 12);
$rand = $maskable ? 0 : (int) ($n * 0.03);
$r = $maskable ? 0 : (int) ($n * 0.24);
$x1 = $rand; $y1 = $rand; $x2 = $n - 1 - $rand; $y2 = $n - 1 - $rand;
if ($r > 0) {
    imagefilledrectangle($im, $x1 + $r, $y1, $x2 - $r, $y2, $grund);
    imagefilledrectangle($im, $x1, $y1 + $r, $x2, $y2 - $r, $grund);
    foreach ([[$x1 + $r, $y1 + $r], [$x2 - $r, $y1 + $r], [$x1 + $r, $y2 - $r], [$x2 - $r, $y2 - $r]] as [$cx, $cy]) {
        imagefilledellipse($im, $cx, $cy, 2 * $r, 2 * $r, $grund);
    }
} else {
    imagefilledrectangle($im, 0, 0, $n - 1, $n - 1, $grund);
}

// Balken (Wellenform) mit Verlauf Bernstein -> Orange
$skala = $maskable ? 0.62 : 0.86;
$feld = $n * $skala;
$ox = ($n - $feld) / 2;
$oy = ($n - $feld) / 2;
$balken = [[11, 27, 10], [19.5, 20, 24], [28, 13, 38], [36.5, 22, 20], [45, 17, 30]];
$a = [255, 195, 90];
$b = [255, 106, 61];
foreach ($balken as [$bx, $by, $bh]) {
    $x = (int) ($ox + ($bx - 6) / 52 * $feld);
    $w = (int) (5 / 52 * $feld);
    $y = (int) ($oy + ($by - 6) / 52 * $feld);
    $h = (int) ($bh / 52 * $feld);
    for ($i = 0; $i < $h; $i++) {
        $t = ($y + $i - $oy) / $feld;
        $c = imagecolorallocate($im, (int) ($a[0] + ($b[0] - $a[0]) * $t), (int) ($a[1] + ($b[1] - $a[1]) * $t), (int) ($a[2] + ($b[2] - $a[2]) * $t));
        $rr = $w / 2;
        // abgerundete Enden
        $dy = min($i, $h - 1 - $i);
        $einzug = $dy < $rr ? (int) ($rr - sqrt(max(0, $rr * $rr - ($rr - $dy) * ($rr - $dy)))) : 0;
        imageline($im, $x + $einzug, $y + $i, $x + $w - $einzug, $y + $i, $c);
    }
}

$out = imagecreatetruecolor($s, $s);
imagesavealpha($out, true);
imagealphablending($out, false);
imagefill($out, 0, 0, imagecolorallocatealpha($out, 0, 0, 0, 127));
imagecopyresampled($out, $im, 0, 0, 0, 0, $s, $s, $n, $n);
ob_start();
imagepng($out);
$png = (string) ob_get_clean();
@mkdir(dirname($cache), 0775, true);
@file_put_contents($cache, $png);
header('Content-Type: image/png');
header('Cache-Control: public, max-age=604800');
echo $png;
