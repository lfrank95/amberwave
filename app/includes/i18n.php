<?php
declare(strict_types=1);

/**
 * Sprachen (Deutsch = Quellsprache, Englisch). Der deutsche Text selbst ist der Schlüssel: t('Titel speichern').
 * Platzhalter: {name} → t('{n} Titel', ['n' => 3]). Fehlt eine Übersetzung, erscheint der deutsche Text.
 * Wörterbuch: includes/i18n_en.php (erzeugt aus i18n/quelle/*.json mit scripts/i18n_bauen.py).
 * Sprache: Konto (users.sprache) → Cookie aw_sprache → Server (Einrichtung, siehe region.php) → Browser (Accept-Language) → de.
 */
const SPRACHEN = ['de' => 'Deutsch', 'en' => 'English'];

/** Sprache der laufenden Anfrage; $setzen überschreibt (Konto, Skripte, E-Mails an andere Nutzer) */
function sprache(?string $setzen = null): string
{
    static $s = null;
    if ($setzen !== null) {
        $s = isset(SPRACHEN[$setzen]) ? $setzen : 'de';
        return $s;
    }
    if ($s !== null) {
        return $s;
    }
    $g = (string) ($_GET['sprache'] ?? '');
    if (isset(SPRACHEN[$g]) && PHP_SAPI !== 'cli') {
        if (!headers_sent()) {
            setcookie('aw_sprache', $g, ['expires' => time() + 31536000, 'path' => '/', 'samesite' => 'Lax']);
        }
        return $s = $g;
    }
    $c = (string) ($_COOKIE['aw_sprache'] ?? '');
    if (isset(SPRACHEN[$c])) {
        return $s = $c;
    }
    // Einrichtung: immer zuerst Englisch (erst danach wählt man die Sprache)
    if (!empty($GLOBALS['aw_standard_sprache']) && isset(SPRACHEN[$GLOBALS['aw_standard_sprache']])) {
        return $s = (string) $GLOBALS['aw_standard_sprache'];
    }
    // Sprache des Servers: die Wahl aus der Einrichtung/den Einstellungen (server.json)
    require_once __DIR__ . '/region.php';
    $serverSprache = region()['sprache'];
    if ($serverSprache !== '') {
        return $s = $serverSprache;
    }
    $al = strtolower((string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));
    if ($al !== '') {
        foreach (explode(',', $al) as $teil) {
            $code = substr(trim(explode(';', $teil)[0]), 0, 2);
            if (isset(SPRACHEN[$code])) {
                return $s = $code;
            }
        }
    }
    return $s = 'de';
}

/** Gebietsschema für Zahlen/Datum im Browser (BCP 47) */
function sprache_locale(): string
{
    require_once __DIR__ . '/region.php';
    $land = region()['land'];
    return $land !== '' ? sprache() . '-' . $land : (sprache() === 'en' ? 'en-GB' : 'de-DE');
}

function i18n_woerter(): array
{
    static $w = null;
    if ($w === null) {
        $d = __DIR__ . '/i18n_' . sprache() . '.php';
        $w = sprache() !== 'de' && is_file($d) ? (require $d) : [];
    }
    return $w;
}

/** Übersetzt einen deutschen Text; $p = Platzhalter {name} */
function t(string $de, array $p = []): string
{
    $text = sprache() === 'de' ? $de : (i18n_woerter()[$de] ?? $de);
    if ($p) {
        $ers = [];
        foreach ($p as $k => $v) {
            $ers['{' . $k . '}'] = (string) $v;
        }
        $text = strtr($text, $ers);
    }
    return $text;
}

/** Einzahl/Mehrzahl: tn(3, 'ein Titel', '{n} Titel') – {n} ist automatisch gesetzt */
function tn(int $n, string $eins, string $viele, array $p = []): string
{
    return t($n === 1 ? $eins : $viele, ['n' => $n] + $p);
}

/** Zahl nach Sprache formatiert */
function zahl_fmt(float $v, int $nachkomma = 0): string
{
    return sprache() === 'en' ? number_format($v, $nachkomma, '.', ',') : number_format($v, $nachkomma, ',', '.');
}
