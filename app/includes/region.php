<?php
declare(strict_types=1);

/**
 * Region des Servers: Land, Sprache, Zeitzone, Datums-/Zeitformat, Währung.
 * Quelle: Einrichtung/Einstellungen (server.json); nur APP_ZEITZONE gilt zusätzlich aus der .env (alt)
 * (PFAD_CACHE/geheimnisse/server.json) → Standard. Gilt für alle Konten, jedes Konto kann seine Sprache selbst wählen.
 *  zeitformat: auto | 24 | 12     datumsformat: auto | dmy | mdy | ymd (auto = nach Land und Sprache)
 */

/** Länder, die in der Auswahl stehen (ISO 3166-1 alpha-2). Namen kommen aus ICU in der Sprache der Seite. */
const REGION_LAENDER = ['DE', 'AT', 'CH', 'LI', 'LU', 'BE', 'NL', 'FR', 'IT', 'ES', 'PT', 'GB', 'IE', 'DK', 'SE', 'NO', 'FI', 'IS', 'PL', 'CZ', 'SK', 'HU',
    'SI', 'HR', 'RO', 'BG', 'GR', 'EE', 'LV', 'LT', 'UA', 'TR', 'CY', 'MT', 'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'AU', 'NZ', 'JP', 'KR', 'CN',
    'TW', 'HK', 'SG', 'IN', 'TH', 'VN', 'PH', 'ID', 'MY', 'IL', 'AE', 'SA', 'EG', 'ZA', 'NG', 'KE', 'MA'];

/** Landessprache je Land (nur für Datums-, Zeit- und Währungsformate; Standard: die gewählte Oberflächensprache) */
const REGION_LANDESSPRACHE = ['FR' => 'fr', 'IT' => 'it', 'ES' => 'es', 'PT' => 'pt', 'BR' => 'pt', 'NL' => 'nl', 'DK' => 'da', 'SE' => 'sv', 'NO' => 'nb', 'FI' => 'fi',
    'IS' => 'is', 'PL' => 'pl', 'CZ' => 'cs', 'SK' => 'sk', 'HU' => 'hu', 'SI' => 'sl', 'HR' => 'hr', 'RO' => 'ro', 'BG' => 'bg', 'GR' => 'el', 'EE' => 'et', 'LV' => 'lv',
    'LT' => 'lt', 'UA' => 'uk', 'TR' => 'tr', 'MX' => 'es', 'AR' => 'es', 'CL' => 'es', 'CO' => 'es', 'PE' => 'es', 'JP' => 'ja', 'KR' => 'ko', 'CN' => 'zh', 'TW' => 'zh',
    'HK' => 'zh', 'TH' => 'th', 'VN' => 'vi', 'ID' => 'id', 'IL' => 'he', 'AE' => 'ar', 'SA' => 'ar', 'EG' => 'ar', 'MA' => 'ar', 'DE' => 'de', 'AT' => 'de', 'CH' => 'de', 'LI' => 'de', 'LU' => 'de',
    'US' => 'en', 'GB' => 'en', 'IE' => 'en', 'CA' => 'en', 'AU' => 'en', 'NZ' => 'en', 'IN' => 'en', 'SG' => 'en', 'ZA' => 'en', 'NG' => 'en', 'KE' => 'en', 'PH' => 'en', 'MY' => 'en', 'BE' => 'nl', 'CY' => 'el', 'MT' => 'en'];

/** Zeitzone, die bei Ländern mit mehreren Zonen vorgeschlagen wird (die bevölkerungsreichste) */
const REGION_HAUPTZONE = ['US' => 'America/New_York', 'CA' => 'America/Toronto', 'AU' => 'Australia/Sydney', 'BR' => 'America/Sao_Paulo', 'MX' => 'America/Mexico_City',
    'CN' => 'Asia/Shanghai', 'ID' => 'Asia/Jakarta', 'AR' => 'America/Argentina/Buenos_Aires', 'CL' => 'America/Santiago', 'PT' => 'Europe/Lisbon', 'ES' => 'Europe/Madrid', 'UA' => 'Europe/Kyiv'];

/** Gewählte Region (mit Vorgaben) */
function region(): array
{
    static $r = null;
    if ($r !== null) {
        return $r;
    }
    $datei = rtrim((string) (getenv('PFAD_CACHE') ?: '/cache'), '/') . '/geheimnisse/server.json';
    $s = is_file($datei) ? json_decode((string) @file_get_contents($datei), true) : null;
    $s = is_array($s) ? $s : [];
    $sprache = strtolower((string) ($s['sprache'] ?? ''));
    $land = strtoupper((string) ($s['land'] ?? ''));
    $zf = (string) ($s['zeitformat'] ?? 'auto');
    $df = (string) ($s['datumsformat'] ?? 'auto');
    $ei = (string) ($s['einheiten'] ?? 'auto');
    $r = [
        'sprache' => isset(SPRACHEN[$sprache]) ? $sprache : '',   // leer = nicht festgelegt (ältere Installation)
        'land' => preg_match('/^[A-Z]{2}$/', $land) ? $land : '',
        'zeitformat' => in_array($zf, ['auto', '24', '12'], true) ? $zf : 'auto',
        'datumsformat' => in_array($df, ['auto', 'dmy', 'mdy', 'ymd'], true) ? $df : 'auto',
        'einheiten' => in_array($ei, ['auto', 'metric', 'imperial'], true) ? $ei : 'auto',
        'waehrung' => preg_match('/^[A-Z]{3}$/', $w = strtoupper((string) ($s['waehrung'] ?? ''))) ? $w : '',
    ];
    if ($r['waehrung'] === '') {
        $r['waehrung'] = region_land_vorgaben($r['land'] ?: ($r['sprache'] === 'de' ? 'DE' : 'GB'))['waehrung'];
    }
    return $r;
}

/** Vorgaben eines Landes: Sprache (de/en), Währung, 12/24 Stunden, Datumsreihenfolge, Zeitzonen */
function region_land_vorgaben(string $land): array
{
    $land = strtoupper($land);
    $sprache = in_array($land, ['DE', 'AT', 'CH', 'LI', 'LU'], true) ? 'de' : 'en';
    $loc = (REGION_LANDESSPRACHE[$land] ?? $sprache) . '_' . $land;   // Landessprache für Formate (JP → ja_JP)
    $waehrung = 'EUR';
    $zeit = '24';
    $datum = 'dmy';
    if (class_exists('NumberFormatter')) {
        $nf = new NumberFormatter($loc, NumberFormatter::CURRENCY);
        $c = (string) $nf->getTextAttribute(NumberFormatter::CURRENCY_CODE);
        if (preg_match('/^[A-Z]{3}$/', $c) && $c !== 'XXX') {
            $waehrung = $c;
        }
    }
    if (class_exists('IntlDateFormatter')) {
        $f = new IntlDateFormatter($loc, IntlDateFormatter::SHORT, IntlDateFormatter::SHORT);
        $p = (string) $f->getPattern();
        $zeit = str_contains($p, 'a') || str_contains($p, 'h') ? '12' : '24';
        $y = strpos($p, 'y');
        $m = strpos(str_replace('MMM', '', $p), 'M');
        $d = strpos($p, 'd');
        $datum = $y !== false && $d !== false && $m !== false ? ($y < $m && $m < $d ? 'ymd' : ($m < $d ? 'mdy' : 'dmy')) : 'dmy';
    }
    $zonen = DateTimeZone::listIdentifiers(DateTimeZone::PER_COUNTRY, $land) ?: [];
    $einheiten = in_array($land, ['US', 'LR', 'MM'], true) ? 'imperial' : 'metric';
    return ['einheiten' => $einheiten, 'land' => $land, 'sprache' => $sprache, 'waehrung' => $waehrung, 'zeitformat' => $zeit, 'datumsformat' => $datum, 'zeitzonen' => $zonen];
}

/** Länderliste für die Auswahl: [{code, name, …Vorgaben}] sortiert nach Name in der Seitensprache */
function region_laender_liste(): array
{
    $l = [];
    foreach (REGION_LAENDER as $c) {
        $name = class_exists('Locale') ? (string) Locale::getDisplayRegion('-' . $c, sprache()) : $c;
        $v = region_land_vorgaben($c);
        $l[] = ['code' => $c, 'name' => $name !== '' ? $name : $c, 'sprache' => $v['sprache'], 'waehrung' => $v['waehrung'], 'zeitformat' => $v['zeitformat'],
            'datumsformat' => $v['datumsformat'], 'einheiten' => $v['einheiten'], 'zeitzonen' => $v['zeitzonen'],
            'zone' => REGION_HAUPTZONE[$c] ?? ($v['zeitzonen'][0] ?? '')];
    }
    usort($l, static fn($a, $b) => strcoll($a['name'], $b['name']));
    return $l;
}

/** Währungen für die Auswahl: Code → Name in der Seitensprache */
function region_waehrungen(): array
{
    $codes = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'JPY', 'CNY', 'KRW', 'INR', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN',
        'TRY', 'ISK', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'ZAR', 'NGN', 'KES', 'MAD', 'EGP', 'AED', 'SAR', 'ILS', 'SGD', 'HKD', 'TWD', 'THB', 'VND', 'PHP', 'IDR', 'MYR', 'UAH'];
    $o = [];
    foreach ($codes as $c) {
        $o[$c] = $c;
    }
    if (class_exists('ResourceBundle')) {
        $rb = ResourceBundle::create(sprache(), 'ICUDATA-curr');
        $cur = $rb ? $rb->get('Currencies') : null;
        foreach ($codes as $c) {
            $e = $cur ? $cur->get($c) : null;
            if ($e && $e->get(1) !== null) {
                $o[$c] = (string) $e->get(1);
            }
        }
    }
    return $o;
}

/** Daten für die Region-Auswahl (Einrichtung und Einstellungen), als JSON für das Skript */
function region_auswahl_json(): string
{
    $r = region();
    return json_encode([
        'laender' => region_laender_liste(),
        'waehrungen' => region_waehrungen(),
        'alle_zonen' => timezone_identifiers_list(),
        'aktuell' => $r + ['zeitzone' => date_default_timezone_get()],
        'sprachen' => SPRACHEN,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?: '{}';
}

/** Eingaben prüfen und bereinigen; Fehler → [Feld → Meldung] */
function region_pruefen(array $in): array
{
    $f = [];
    $o = [];
    $o['sprache'] = strtolower(trim((string) ($in['sprache'] ?? '')));
    if (!isset(SPRACHEN[$o['sprache']])) {
        $f['sprache'] = t('Bitte eine Sprache wählen.');
    }
    $o['land'] = strtoupper(trim((string) ($in['land'] ?? '')));
    if ($o['land'] !== '' && !in_array($o['land'], REGION_LAENDER, true)) {
        $f['land'] = t('Dieses Land steht nicht zur Auswahl.');
    }
    $o['zeitzone'] = trim((string) ($in['zeitzone'] ?? ''));
    if ($o['zeitzone'] !== '' && !in_array($o['zeitzone'], timezone_identifiers_list(), true)) {
        $f['zeitzone'] = t('Diese Zeitzone kennt der Server nicht.');
    }
    $o['zeitformat'] = (string) ($in['zeitformat'] ?? 'auto');
    $o['datumsformat'] = (string) ($in['datumsformat'] ?? 'auto');
    if (!in_array($o['zeitformat'], ['auto', '24', '12'], true) || !in_array($o['datumsformat'], ['auto', 'dmy', 'mdy', 'ymd'], true)) {
        $f['format'] = t('Ungültiges Datums- oder Zeitformat.');
    }
    $o['einheiten'] = (string) ($in['einheiten'] ?? 'auto');
    if (!in_array($o['einheiten'], ['auto', 'metric', 'imperial'], true)) {
        $f['einheiten'] = t('Ungültige Einheiten.');
    }
    $o['waehrung'] = strtoupper(trim((string) ($in['waehrung'] ?? '')));
    if ($o['waehrung'] !== '' && !preg_match('/^[A-Z]{3}$/', $o['waehrung'])) {
        $f['waehrung'] = t('Ungültige Währung.');
    }
    return [$o, $f];
}

/** Region in server.json ablegen (bestehende Angaben, z. B. Servername, bleiben) */
function region_speichern(array $o): bool
{
    require_once __DIR__ . '/einrichtung.php';
    $datei = rtrim((string) (getenv('PFAD_CACHE') ?: '/cache'), '/') . '/geheimnisse/server.json';
    $a = is_file($datei) ? json_decode((string) @file_get_contents($datei), true) : [];
    $a = is_array($a) ? $a : [];
    foreach (['sprache', 'land', 'zeitzone', 'zeitformat', 'datumsformat', 'einheiten', 'waehrung'] as $k) {
        if (($o[$k] ?? '') !== '') {
            $a[$k] = $o[$k];
        }
    }
    return geheimnis_schreiben('server.json', json_encode($a, JSON_UNESCAPED_UNICODE));
}

/** Datum nach Region: $zeit = mit Uhrzeit */
function region_datum(?string $datum, bool $zeit = false): string
{
    if (!$datum) {
        return '–';
    }
    $ts = strtotime($datum);
    if (!$ts) {
        return '–';
    }
    $r = region();
    $v = region_land_vorgaben($r['land'] ?: (sprache() === 'de' ? 'DE' : 'GB'));
    $df = $r['datumsformat'] === 'auto' ? $v['datumsformat'] : $r['datumsformat'];
    $zf = $r['zeitformat'] === 'auto' ? $v['zeitformat'] : $r['zeitformat'];
    $d = match ($df) { 'mdy' => date('m/d/Y', $ts), 'ymd' => date('Y-m-d', $ts), default => sprache() === 'de' ? date('d.m.Y', $ts) : date('d/m/Y', $ts) };
    return $zeit ? $d . ' ' . ($zf === '12' ? date('g:i A', $ts) : date('H:i', $ts)) : $d;
}

/** Angaben für das Browser-Skript (meta aw-region): Formate und Währung, bereits aufgelöst */
function region_fuer_skript(): array
{
    $r = region();
    $v = region_land_vorgaben($r['land'] ?: (sprache() === 'de' ? 'DE' : 'GB'));
    return ['land' => $r['land'], 'zeitformat' => $r['zeitformat'] === 'auto' ? $v['zeitformat'] : $r['zeitformat'],
        'datumsformat' => $r['datumsformat'] === 'auto' ? $v['datumsformat'] : $r['datumsformat'],
        'einheiten' => $r['einheiten'] === 'auto' ? $v['einheiten'] : $r['einheiten'], 'waehrung' => $r['waehrung'], 'zeitzone' => date_default_timezone_get()];
}
