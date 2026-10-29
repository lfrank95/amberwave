<?php
declare(strict_types=1);
require_once __DIR__ . '/hilfen.php';

/** Kopf für die einfachen Seiten außerhalb der App (Login, Registrierung, Passwort). */
function pwa_head(): string
{
    return '<link rel="manifest" href="/manifest.php">'
        . '<meta name="theme-color" content="#120d0a">'
        . '<link rel="icon" type="image/svg+xml" href="' . asset_url('/img/logo.svg') . '">'
        . '<link rel="icon" type="image/png" sizes="32x32" href="/icon.php?s=32">'
        . '<link rel="apple-touch-icon" href="/icon.php?s=180">'
        . '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">'
        . '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
        . '<meta name="apple-mobile-web-app-title" content="' . h(app_name()) . '">';
}

/**
 * Schriften liegen unter /fonts (eigener Server, SIL Open Font License) und werden in app.css eingebunden. Hier nur
 * vorladen: die zwei lateinischen Dateien, die jede Seite sofort braucht – dann steht der Text gleich in der richtigen Schrift.
 */
function schriften_link(): string
{
    return '<link rel="preload" as="font" type="font/woff2" href="/fonts/manrope-latin-v1.woff2" crossorigin>'
        . '<link rel="preload" as="font" type="font/woff2" href="/fonts/spacegrotesk-latin-v1.woff2" crossorigin>';
}

function seite_kopf(string $titel): void
{
    echo '<!DOCTYPE html><html lang="' . sprache() . '"><head><meta charset="UTF-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1' . (konfig()['zoom_sperren'] ? ', maximum-scale=1, user-scalable=no' : '') . ', viewport-fit=cover">'
        . '<title>' . h($titel) . ' – ' . h(app_name()) . '</title>'
        . schriften_link()
        . '<link rel="stylesheet" href="' . asset_url('/css/app.css') . '">'
        . pwa_head()
        . '</head><body class="seite-einfach"><main class="form-glass glass-panel">'
        . '<a class="logo logo-gross" href="/"><img src="' . asset_url('/img/logo.svg') . '" alt="" width="36" height="36"><span>' . h(app_name()) . '</span></a>';
}

function seite_fuss(): void
{
    // kam die Anfrage durch den Cloudflare Tunnel? Dann sagen wir es – mit den Bedingungen, die dafür gelten
    if (!empty($_SERVER['HTTP_CF_RAY']) && client_ip() !== (string) ($_SERVER['REMOTE_ADDR'] ?? '')) {
        echo '<p class="seite-fuss-tunnel">' . t('Verbindung über Cloudflare Tunnel') . ' · <a href="https://www.cloudflare.com/terms/" target="_blank" rel="noopener">' . t('Nutzungsbedingungen') . '</a> · <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">' . t('Datenschutz von Cloudflare') . '</a></p>';
    }
    echo sprachwechsel_html();
    echo '</main></body></html>';
}

/** Kleiner Sprachwechsel „Deutsch · English“ (Links ?sprache=… auf dieselbe Seite; i18n.php setzt das Cookie) */
function sprachwechsel_html(string $attr = ''): string
{
    $aktuell = sprache();
    $basis = strtok((string) ($_SERVER['REQUEST_URI'] ?? ''), '?') ?: '/';
    $teile = [];
    foreach (SPRACHEN as $code => $name) {
        $q = $_GET;
        unset($q['sprache']);
        $q['sprache'] = $code;
        $teile[] = $code === $aktuell
            ? '<span aria-current="true">' . h($name) . '</span>'
            : '<a href="' . h($basis . '?' . http_build_query($q)) . '" lang="' . h($code) . '" hreflang="' . h($code) . '">' . h($name) . '</a>';
    }
    return '<p class="seite-links seite-sprache"' . ($attr !== '' ? ' ' . $attr : '') . '>' . implode(' · ', $teile) . '</p>';
}

function meldung(?string $text, string $art = 'fehler'): string
{
    return $text ? '<div class="' . ($art === 'erfolg' ? 'erfolg' : 'fehler') . '" role="' . ($art === 'erfolg' ? 'status' : 'alert') . '">' . h($text) . '</div>' : '';
}
