<?php
declare(strict_types=1);
require_once __DIR__ . '/auth.php';

/**
 * Kern der JSON-API (v1). Die Web-App nutzt ausschließlich diese API – der spätere Windows-Player auch.
 * Anmeldung: Browser-Sitzung (+ X-CSRF-Token bei Änderungen) oder "Authorization: Bearer <Geräte-Schlüssel>".
 */

final class ApiFehler extends RuntimeException
{
    public array $extra;

    public function __construct(string $meldung, int $code = 400, array $extra = [])
    {
        parent::__construct($meldung, $code);
        $this->extra = $extra;
    }
}

function api_antwort($daten, int $code = 200): void
{
    if (!headers_sent()) {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo json_encode($daten, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

/** JSON-Körper der Anfrage (oder Formularfelder). */
function api_eingabe(): array
{
    static $daten = null;
    if ($daten !== null) {
        return $daten;
    }
    $typ = (string) ($_SERVER['CONTENT_TYPE'] ?? '');
    if (str_contains($typ, 'application/json')) {
        $roh = (string) file_get_contents('php://input', false, null, 0, 2 * 1024 * 1024);
        $d = json_decode($roh, true);
        $daten = is_array($d) ? $d : [];
    } else {
        $daten = $_POST;
    }
    return $daten;
}

function api_wert(string $name, $standard = null)
{
    $e = api_eingabe();
    return array_key_exists($name, $e) ? $e[$name] : $standard;
}

function api_int(string $name, int $standard = 0, ?array $quelle = null): int
{
    $q = $quelle ?? $_GET;
    return isset($q[$name]) && is_numeric($q[$name]) ? (int) $q[$name] : $standard;
}

/** Angemeldeter, gültiger Nutzer – sonst 401/403. */
function api_user(bool $admin = false): array
{
    $user = eingeloggter_user();
    if (!$user) {
        throw new ApiFehler(!empty($GLOBALS['geraet_abgemeldet'])
            ? t('Du wurdest auf diesem Gerät abgemeldet, weil dein Konto auf einem weiteren Gerät angemeldet wurde.')
            : t('Nicht angemeldet.'), 401, ['login' => true]);
    }
    if (!account_ist_gueltig($user)) {
        throw new ApiFehler($user['status'] === 'gesperrt' ? sperre_text($user) : t('Dein Konto ist nicht (mehr) gültig.'), 403, ['login' => true]);
    }
    if (!empty($user['muss_passwort_aendern'])) {
        throw new ApiFehler(t('Bitte zuerst ein eigenes Passwort festlegen.'), 403, ['passwort_aendern' => true]);
    }
    if ($admin && $user['rolle'] !== 'admin') {
        throw new ApiFehler(t('Kein Zugriff.'), 403);
    }
    // Verwaltung nie mit dem Direkt-Schlüssel (der liegt im Browser und kann über die Direktadresse mitgehen) – nur mit Sitzung
    if ($admin && !empty($GLOBALS['api_direkt'])) {
        throw new ApiFehler(t('Die Verwaltung geht nur über die normale Adresse.'), 403);
    }
    // Änderungen aus dem Browser brauchen das CSRF-Token (Apps mit Geräte-Schlüssel nicht)
    $methode = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($methode, ['GET', 'HEAD', 'OPTIONS'], true) && empty($GLOBALS['api_token_anmeldung']) && !csrf_pruefen()) {
        throw new ApiFehler(t('Sicherheitsprüfung fehlgeschlagen – bitte die Seite neu laden.'), 403, ['csrf' => true]);
    }
    return $user;
}

/**
 * Für Medien (Streams, Impulsantworten): angemeldet per Sitzung – oder per Stream-Schlüssel ?st=…, wenn die Musik
 * über die Direktadresse im Heimnetz kommt (andere Herkunft, dort gibt es kein Login-Cookie).
 */
function api_user_medien(): array
{
    $st = (string) ($_GET['st'] ?? '');
    if ($st !== '') {
        require_once __DIR__ . '/direktzugang.php';
        $u = direkt_token_user($st);
        if ($u) {
            return $u;
        }
        throw new ApiFehler(t('Stream-Schlüssel ungültig oder abgelaufen.'), 401, ['direkt_token' => true]);
    }
    return api_user();
}

/** Einfacher Router: [Methode, Muster mit {id}, Funktion] */
function api_ausfuehren(array $routen, string $pfad): void
{
    $methode = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($methode === 'HEAD') {
        $methode = 'GET';
    }
    $pfad = '/' . trim($pfad, '/');
    $methode_passt_nicht = false;
    try {
        foreach ($routen as [$m, $muster, $fn]) {
            $regex = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[A-Za-z0-9_.-]+)', $muster) . '$#';
            if (!preg_match($regex, $pfad, $treffer)) {
                continue;
            }
            if ($m !== $methode) {
                $methode_passt_nicht = true;
                continue;
            }
            $param = array_filter($treffer, 'is_string', ARRAY_FILTER_USE_KEY);
            $ergebnis = $fn($param);
            if ($ergebnis !== null) {
                api_antwort($ergebnis);
            }
            return;
        }
        throw new ApiFehler($methode_passt_nicht ? t('Methode nicht erlaubt.') : t('Unbekannter Pfad.'), $methode_passt_nicht ? 405 : 404);
    } catch (ApiFehler $e) {
        api_antwort(['ok' => false, 'fehler' => $e->getMessage()] + $e->extra, $e->getCode() ?: 400);
    } catch (Throwable $e) {
        error_log('API ' . $methode . ' ' . $pfad . ': ' . log_sauber($e->getMessage()) . ' @ ' . $e->getFile() . ':' . $e->getLine());
        api_antwort(['ok' => false, 'fehler' => t('Interner Fehler. Details stehen im Server-Log.')], 500);
    }
}

/** Datums-/Zeitangaben für die API: ISO 8601 (die Oberfläche formatiert deutsch). */
function iso(?string $datum): ?string
{
    if (!$datum) {
        return null;
    }
    $ts = strtotime($datum);
    return $ts ? date('c', $ts) : null;
}

/** Bild-URL für einen gespeicherten Schlüssel */
function bild_url(string $art, ?string $schluessel, int $groesse = 300): ?string
{
    if (!$schluessel) {
        return null;
    }
    return '/api/v1/bild/' . (in_array($art, ['kuenstler', 'profil'], true) ? $art : 'cover') . '/' . rawurlencode($schluessel) . '?g=' . $groesse;
}

/**
 * Bild-Schlüssel für Geräte ohne Anmeldung (Receiver, Fernseher, Cast): gilt nur für dieses eine Bild, nichts sonst –
 * anders als der Direktzugang-Schlüssel, der die ganze API öffnet. Geräte zeigen ihre Adressen jedem im Heimnetz.
 */
function bild_token(string $art, string $schluessel, int $sekunden = 86400): string
{
    $bis = time() + $sekunden;
    return $bis . '.' . bild_token_sig($art, $schluessel, $bis);
}

function bild_token_sig(string $art, string $schluessel, int $bis): string
{
    return rtrim(strtr(base64_encode(substr(hash_hmac('sha256', "bild|{$art}|{$schluessel}|{$bis}", konfig()['app_secret_key'], true), 0, 18)), '+/', '-_'), '=');
}

/** Bild-URL mit Bild-Schlüssel (?bt=…) für Geräte ohne Anmeldung */
function bild_url_geraet(string $art, ?string $schluessel, int $groesse, int $sekunden = 86400): ?string
{
    $u = bild_url($art, $schluessel, $groesse);
    return $u === null ? null : $u . '&bt=' . bild_token($art, (string) $schluessel, $sekunden);
}

/** Zugang zu einem Bild: Bild-Schlüssel ?bt=…, sonst wie Medien (Sitzung oder Stream-Schlüssel) */
function api_bild_zugang(string $art, string $schluessel): void
{
    $bt = (string) ($_GET['bt'] ?? '');
    if ($bt !== '') {
        if (preg_match('/^(\d+)\.([A-Za-z0-9_-]+)$/', $bt, $m) && (int) $m[1] >= time() && hash_equals(bild_token_sig($art, $schluessel, (int) $m[1]), $m[2])) {
            return;
        }
        throw new ApiFehler(t('Bild-Schlüssel ungültig oder abgelaufen.'), 401);
    }
    api_user_medien();
}
