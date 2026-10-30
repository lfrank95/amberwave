<?php
// Erweitertes Klang-Modell installieren (vom Admin per Knopf ausgelöst, nach Bestätigung der Lizenz):
//  1. eigene Python-Umgebung im Cache (/cache/klang/venv)
//  2. Python-Paket des Herstellers (KLANG_PIP_PAKET, Standard essentia-tensorflow) von PyPI
//  3. Modell direkt von der MTG (KLANG_MODELL_URL) und den Lizenztext (KLANG_LIZENZ_URL)
//  3b. Stil-Kopf (genre_discogs400: 400 Discogs-Stile je Titel) mit Beschriftung
//  4. Probelauf; erst wenn er klappt, wird das Modell eingeschaltet – sonst bleibt das eingebaute Verfahren aktiv.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/i18n.php';
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/api.php';
require_once __DIR__ . '/../includes/musicbrainz.php';
require_once __DIR__ . '/../includes/klang.php';
set_time_limit(0);
$sperre = fopen(konfig()['pfade']['cache'] . KLANG_INSTALL_SPERRE, 'c');
if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
    exit(0);
}
$k = konfig()['klang'];
$log = '';
$stand = static function (string $status, string $schritt) use (&$log) {
    file_put_contents(kl_ordner('installation.json'), json_encode(['status' => $status, 'schritt' => $schritt, 'log' => mb_substr($log, -4000), 'aktualisiert' => date('c')]));
};
$aufruf = static function (string $befehl, string $schritt) use (&$log, $stand): bool {
    $stand('laeuft', $schritt);
    $log .= "\n$ {$schritt}\n";
    $aus = [];
    exec($befehl . ' 2>&1', $aus, $rc);
    $log .= implode("\n", array_slice($aus, -25)) . "\n";
    return $rc === 0;
};
try {
    @mkdir(kl_ordner('modell'), 0775, true);
    $venv = kl_ordner('venv');
    $py = aw_arg((string) $k['python']);
    if (!is_file($venv . '/bin/python') && !$aufruf("{$py} -m venv " . aw_arg($venv), t('Python-Umgebung anlegen'))) {
        throw new RuntimeException(t('Python-Umgebung konnte nicht angelegt werden (python3-venv im Image?).'));
    }
    $pip = aw_arg($venv . '/bin/pip');
    // Ist das Paket schon da (z. B. nur der Stil-Kopf wird nachinstalliert), entfällt dieser Schritt
    $schon = is_file($venv . '/bin/python') && trim((string) shell_exec(aw_arg($venv . '/bin/python') . ' -c "import essentia.standard; print(1)"' . aw_ohne_fehler())) === '1';
    if (!$schon) {
    $aufruf("{$pip} install --no-cache-dir --upgrade pip", t('pip aktualisieren'));
    if (!$aufruf("{$pip} install --no-cache-dir " . aw_arg((string) $k['pip_paket']), t('Paket {paket} vom Hersteller laden (kann einige Minuten dauern)', ['paket' => $k['pip_paket']]))) {
        throw new RuntimeException(t('Das Paket {paket} ließ sich nicht installieren (Internet? Prozessor mit AVX?).', ['paket' => $k['pip_paket']]));
    }
    }
    foreach ([['url' => $k['modell_url'], 'datei' => KLANG_MODELL_DATEI, 'name' => t('Modell')], ['url' => $k['stil_url'], 'datei' => KLANG_STIL_DATEI, 'name' => t('Stil-Kopf'), 'optional' => true], ['url' => $k['stil_json_url'], 'datei' => KLANG_STIL_LABELS, 'name' => t('Stil-Beschriftung'), 'optional' => true], ['url' => $k['lizenz_url'], 'datei' => 'LIZENZ.txt', 'name' => t('Lizenztext')]] as $x) {
        if (is_file(kl_ordner('modell/' . $x['datei'])) && filesize(kl_ordner('modell/' . $x['datei'])) > 1000 && $x['datei'] !== 'LIZENZ.txt') {
            continue; // schon da
        }
        $stand('laeuft', t('{name} vom Hersteller laden', ['name' => $x['name']]));
        $log .= "\n$ {$x['name']}: {$x['url']}\n";
        $r = http_holen((string) $x['url'], [], 300, 200 * 1024 * 1024);
        if (($r['status'] !== 200 || $r['body'] === '') && !empty($x['optional'])) {
            $log .= "nicht ladbar (HTTP {$r['status']}) – ohne Stil-Erkennung weiter\n";
            continue;
        }
        if ($r['status'] !== 200 || $r['body'] === '') {
            throw new RuntimeException(t('{name} nicht ladbar (HTTP {status}).', ['name' => $x['name'], 'status' => $r['status']]));
        }
        file_put_contents(kl_ordner('modell/' . $x['datei']), $r['body']);
        $log .= strlen($r['body']) . " Bytes\n";
    }
    $probe = aw_arg($venv . '/bin/python') . ' ' . aw_arg(kl_skript()) . ' pruefen --laden --modell ' . aw_arg(kl_ordner('modell'));
    $stand('laeuft', t('Probelauf'));
    $j = json_decode((string) shell_exec(aw_mit_umgebung(['TF_CPP_MIN_LOG_LEVEL' => 3], $probe) . aw_ohne_fehler()), true);
    $log .= "\n$ Probelauf\n" . json_encode($j) . "\n";
    if (empty($j['essentia']) || empty($j['geladen'])) {
        throw new RuntimeException(t('Probelauf fehlgeschlagen: {fehler}', ['fehler' => $j['fehler'] ?? t('Modell ließ sich nicht laden')]));
    }
    einstellung_setzen('klang_modell', '1');
    einstellung_setzen('klang_meldung', '');
    $stand('fertig', t('Installiert – die Sammlung wird jetzt im Hintergrund mit dem Modell analysiert.'));
} catch (Throwable $e) {
    einstellung_setzen('klang_modell', '0');
    $log .= "\nFEHLER: " . $e->getMessage() . "\n";
    $stand('fehler', $e->getMessage() . ' ' . t('Es bleibt beim eingebauten Verfahren.'));
} finally {
    flock($sperre, LOCK_UN);
    fclose($sperre);
}
