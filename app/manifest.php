<?php
// Web-App-Manifest (installierbare App). Ohne Anmeldung abrufbar, enthält nur Name und feste Pfade.
declare(strict_types=1);
require_once __DIR__ . '/includes/hilfen.php';
header('Content-Type: application/manifest+json; charset=utf-8');
header('Cache-Control: no-cache');
$name = app_name();
echo json_encode([
    'name' => $name,
    'short_name' => mb_strlen($name) > 14 ? mb_substr($name, 0, 12) . '…' : $name,
    'description' => t('Deine Musiksammlung – überall hören.'),
    'lang' => sprache(),
    'id' => '/',
    'start_url' => '/',
    'scope' => '/',
    'display' => 'standalone',
    'orientation' => 'any',
    'background_color' => '#120d0a',
    'theme_color' => '#120d0a',
    'icons' => [
        ['src' => '/icon.php?s=192', 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'any'],
        ['src' => '/icon.php?s=512', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'any'],
        ['src' => '/icon.php?s=512&m=1', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable'],
    ],
    'shortcuts' => [
        ['name' => t('Alben'), 'url' => '/alben'],
        ['name' => t('Künstler'), 'url' => '/kuenstler'],
        ['name' => t('Suche'), 'url' => '/suche'],
    ],
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
