<?php
// Hülle der Single-Page-App. Alles Weitere lädt die App über die JSON-API.
declare(strict_types=1);
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/seiten.php';

$pfad = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
if (str_starts_with($pfad, '/api/')) {
    // Unbekannter API-Pfad (z. B. ohne v1) – nicht die App ausliefern
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"ok":false,"fehler":"Unbekannter Pfad."}';
    exit;
}
$user = eingeloggter_user();
if (!$user || !account_ist_gueltig($user)) {
    $ziel = $pfad !== '/' && preg_match('#^/[A-Za-z0-9/_\-]*$#', $pfad) ? '?ziel=' . rawurlencode($pfad) : '';
    header('Location: /login.php' . $ziel . (!empty($GLOBALS['geraet_abgemeldet']) ? ($ziel ? '&' : '?') . 'grund=geraet' : ''));
    exit;
}
if (!empty($user['muss_passwort_aendern'])) {
    header('Location: /passwort-erzwingen.php');
    exit;
}
// All-in-One mit Admin aus der Vorlage: beim ersten Öffnen durch den Assistenten (Region, Ordner, Servername)
if (ist_admin($user) && is_file(konfig()['pfade']['cache'] . '/geheimnisse/assistent_offen')) {
    header('Location: /einrichtung.php');
    exit;
}
header('Cache-Control: no-store');
// Nutzerdaten (/ich) gleich mitliefern: die App spart beim Start eine volle Laufzeit zum Server
$ich_json = '';
try {
    require_once __DIR__ . '/includes/api_nutzer.php';
    require_once __DIR__ . '/includes/heimnetz.php';
    $ich_json = json_encode(api_ich(), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP);
    hn_basis_lernen($user);   // wie bei GET /ich: von einem Admin im Heimnetz geöffnet? Dann kennen wir die Adresse für Receiver & Co.
} catch (Throwable $e) {
    $ich_json = '';
    error_log('index.php: /ich einbetten fehlgeschlagen: ' . $e->getMessage());
}
?><!DOCTYPE html>
<html lang="<?= h(sprache()) ?>">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="<?= konfig()['zoom_sperren'] ? 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover' : 'width=device-width, initial-scale=1, viewport-fit=cover' ?>">
<meta name="aw-zoom-sperre" content="<?= konfig()['zoom_sperren'] ? '1' : '0' ?>">
<meta name="aw-sprache" content="<?= h(sprache()) ?>">
<meta name="aw-locale" content="<?= h(sprache_locale()) ?>">
<meta name="aw-region" content="<?= h(json_encode(region_fuer_skript())) ?>">
<meta name="csrf-token" content="<?= h(csrf_token()) ?>">
<title><?= h(app_name()) ?></title>
<?= schriften_link() ?>
<link rel="stylesheet" href="<?= asset_url('/css/app.css') ?>">
<?php if ($pfad === '/') : ?><link rel="preload" as="fetch" href="/api/v1/start" crossorigin>
<?php endif; ?>
<?= pwa_head() ?>
<meta name="aw-worklet-stand" content="<?= h(preg_match("/const STAND = '([^']+)'/", (string) @file_get_contents(__DIR__ . '/js/raumklang-worklet.js'), $m) ? $m[1] : '') ?>">
<meta name="aw-worklet-raum" content="<?= h(asset_url('/js/raumklang-worklet.js')) ?>">
<meta name="aw-raumklang" content="<?= h(json_encode(['neustart' => konfig()['raumklang']['neustart'], 'trennung' => konfig()['raumklang']['lcr_trennung'], 'lfe' => konfig()['raumklang']['lcr_lfe'], 'center' => konfig()['raumklang']['lcr_center'], 'rear' => konfig()['raumklang']['rear_delay'], 'mittel' => konfig()['raumklang']['mittel'], 'prozent' => konfig()['raumklang']['prozent']])) ?>">
<meta name="aw-worklet-eq" content="<?= h(asset_url('/js/eq-worklet.js')) ?>">
<meta name="aw-worklet-waerme" content="<?= h(asset_url('/js/waerme-worklet.js')) ?>">
<meta name="aw-worklet-band" content="<?= h(asset_url('/js/band-worklet.js')) ?>">
<meta name="aw-band" content="<?= h(json_encode(['vorgabe' => konfig()['band']['vorgabe'], 'bezug' => konfig()['band']['bezug_lufs'], 'sorte' => konfig()['band']['sorte'], 'norm' => konfig()['band']['norm']])) ?>">
<meta name="aw-worklet-trafo" content="<?= h(asset_url('/js/trafo-worklet.js')) ?>">
<meta name="aw-worklet-dsp" content="<?= h(asset_url('/js/dsp-worklet.js')) ?>">
<meta name="aw-worklet-wasm" content="<?= h(asset_url('/js/aw-dsp.wasm')) ?>">
<meta name="aw-trafo" content="<?= h(json_encode(['vorgabe' => konfig()['trafo']['vorgabe'], 'kern' => konfig()['trafo']['kern'], 'bezug' => konfig()['trafo']['bezug_lufs']])) ?>">
<meta name="aw-waerme" content="<?= h(json_encode(['vorgabe' => konfig()['waerme']['vorgabe'], 'bezug' => konfig()['waerme']['bezug_lufs'], 'roehre' => konfig()['waerme']['roehre'], 'schaltung' => konfig()['waerme']['schaltung']])) ?>">
<script type="importmap"><?= import_map_json() ?></script>
<?php foreach (module_vorladen() as $mu) : ?><link rel="modulepreload" href="<?= h($mu) ?>">
<?php endforeach; ?>
<?php if ($bd = buendel()) : ?><meta name="aw-buendel" content="<?= h(implode(' ', array_map(static fn($f) => asset_url('/js/_b/' . $f), array_values(array_diff($bd['dateien'], $bd['start']))))) ?>">
<?php endif; ?>
<script type="module" src="<?= app_modul_url() ?>"></script>
<?php if ($ich_json !== '') : ?><script type="application/json" id="aw-ich"><?= $ich_json ?></script>
<?php endif; ?>
</head>
<body>
<div id="app" class="app" data-app-name="<?= h(app_name()) ?>">
    <div class="start-lade"><img src="<?= asset_url('/img/logo.svg') ?>" alt="" width="64" height="64"><span><?= h(app_name()) ?></span></div>
</div>
<noscript><p class="fehler" style="margin:40px"><?= h(t('Bitte JavaScript aktivieren – {app} ist eine Web-App.', ['app' => app_name()])) ?></p></noscript>
</body>
</html>
