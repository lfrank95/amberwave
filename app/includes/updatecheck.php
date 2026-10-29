<?php
declare(strict_types=1);
// Hinweis „neue Version verfügbar“: fragt höchstens alle 12 Stunden die Releases auf GitHub ab (auch Vorabversionen,
// solange die installierte selbst eine ist). Abschaltbar unter Einstellungen (update_hinweis) bzw. UPDATE_HINWEIS=0;
// AMBERWAVE_UPDATE_URL zeigt auf die Releases-API (leer = aus). Es wird nichts heruntergeladen oder installiert.
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/hilfen.php';

function update_url(): string
{
    $u = trim((string) (getenv('AMBERWAVE_UPDATE_URL') !== false ? getenv('AMBERWAVE_UPDATE_URL') : 'https://api.github.com/repos/lfrank95/amberwave/releases'));
    return $u;
}

function update_datei(): string
{
    return rtrim((string) konfig()['pfade']['cache'], '/') . '/update_stand.json';
}

/** Neuere Version als die installierte? → ['version', 'url', 'name'] oder null. $holen: bei Bedarf bei GitHub nachfragen (Zeitplan). */
function update_hinweis(bool $holen = false): ?array
{
    if (einstellung('update_hinweis') === '0' || update_url() === '') {
        return null;
    }
    $stand = json_decode((string) @file_get_contents(update_datei()), true) ?: [];
    if ($holen && (int) ($stand['zeit'] ?? 0) < time() - 12 * 3600) {
        $stand = ['zeit' => time()] + (update_abfragen() ?? ['fehler' => true]);
        @file_put_contents(update_datei(), json_encode($stand, JSON_UNESCAPED_SLASHES));
    }
    $neu = (string) ($stand['version'] ?? '');
    if ($neu === '' || version_compare(ltrim($neu, 'vV'), app_version(), '<=')) {
        return null;
    }
    return ['version' => ltrim($neu, 'vV'), 'url' => (string) ($stand['url'] ?? ''), 'name' => (string) ($stand['name'] ?? '')];
}

/** Neueste passende Veröffentlichung; Vorabversionen nur, wenn die installierte selbst eine ist */
function update_abfragen(): ?array
{
    $ch = curl_init(update_url() . '?per_page=20');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_HTTPHEADER => ['Accept: application/vnd.github+json', 'User-Agent: Amberwave/' . app_version()]]);
    $roh = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $liste = $status === 200 ? json_decode((string) $roh, true) : null;
    if (!is_array($liste)) {
        return null;
    }
    $vorab = str_contains(app_version(), '-');
    $best = null;
    foreach (array_is_list($liste) ? $liste : [$liste] as $r) {
        if (!is_array($r) || !empty($r['draft']) || (!empty($r['prerelease']) && !$vorab)) {
            continue;
        }
        $v = ltrim((string) ($r['tag_name'] ?? ''), 'vV');
        if ($v !== '' && preg_match('/^\d+\.\d+\.\d+/', $v) && ($best === null || version_compare($v, $best['version'], '>'))) {
            $best = ['version' => $v, 'url' => (string) ($r['html_url'] ?? ''), 'name' => (string) ($r['name'] ?? '')];
        }
    }
    return $best;
}
