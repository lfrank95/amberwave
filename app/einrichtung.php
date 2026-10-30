<?php
// Einrichtungs-Assistent: Admin-Konto + Datenbank beim allerersten Start. Siehe includes/einrichtung.php.
// Nachholen: Ist schon eingerichtet (All-in-One-Image mit Admin aus der Vorlage) und ein Admin angemeldet, führt dieselbe Seite
// durch Region, Ordner und Servername – ohne Datenbank, Konto und Einrichtungscode.
declare(strict_types=1);
require_once __DIR__ . '/includes/i18n.php';
require_once __DIR__ . '/includes/region.php';
require_once __DIR__ . '/includes/einrichtung.php';
require_once __DIR__ . '/includes/seiten.php';
require_once __DIR__ . '/includes/sicherheit.php';

$GLOBALS['aw_standard_sprache'] = 'en';   // die Einrichtung beginnt immer auf Englisch; die Sprache wählt man auf der Region-Seite
sicherheits_header_senden();
header('Cache-Control: no-store');

/**
 * Zur Sitzung $name wechseln. PHP behält nach session_write_close() die alte Sitzungs-ID und würde sie für die nächste
 * Sitzung weiterverwenden (beide teilten sich dann eine Datei) – daher die ID ausdrücklich aus dem passenden Cookie nehmen.
 */
function einr_sitzung(string $name, string $samesite): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    session_name($name);
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => ist_https(), 'httponly' => true, 'samesite' => $samesite]);
    $c = (string) ($_COOKIE[$name] ?? '');
    session_id(preg_match('/^[A-Za-z0-9,-]{22,256}$/', $c) ? $c : session_create_id());
    session_start();
}

// Angemeldeter Admin (nur bei fertiger Installation) – aus der normalen Sitzung, danach die eigene Sitzung der Einrichtung
$nachAdmin = null;
if (einrichtung_zustand(true)['art'] === 'fertig') {
    require_once __DIR__ . '/includes/auth.php';
    try {
        $u = eingeloggter_user_roh();   // ohne Sprachumschaltung: die Region-Seite wechselt die Sprache selbst
        if ($u && account_ist_gueltig($u) && ist_admin($u) && empty($u['muss_passwort_aendern'])) {
            $nachAdmin = $u;
        }
    } catch (Throwable $e) {
        $nachAdmin = null;
    }
}
einr_sitzung('amberwave_einr', 'Strict');
if (empty($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(24));
}

function einr_json(array $d, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($d, JSON_UNESCAPED_UNICODE);
    exit;
}

$z = einrichtung_zustand(true);

// ---------- Schritte (JSON) ----------
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $in = json_decode((string) file_get_contents('php://input'), true);
    $in = is_array($in) ? $in : [];
    if (!hash_equals($_SESSION['csrf'], (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
        einr_json(['ok' => false, 'fehler' => t('Sicherheitsprüfung fehlgeschlagen. Bitte die Seite neu laden.')], 403);
    }
    $schritt = (string) ($_GET['schritt'] ?? '');

    // Nach dem Abschluss darf nur die Sitzung, die eingerichtet hat, noch das erste Einlesen begleiten (zwei Stunden lang)
    if (in_array($schritt, ['scan_start', 'scan_status', 'zusammenfassung'], true)) {
        if (empty($_SESSION['einr_nachlauf']) || (int) $_SESSION['einr_nachlauf'] < time()) {
            einr_json(['ok' => false, 'fehler' => t('Diese Sitzung gehört nicht zur Einrichtung. Bitte normal anmelden.')], 403);
        }
        try {
            require_once __DIR__ . '/includes/db.php';
            if ($schritt === 'scan_start') {
                require_once __DIR__ . '/includes/scanner.php';
                if (!is_dir(konfig()['pfade']['musik'])) {
                    einr_json(['ok' => false, 'fehler' => t('Der Musikordner {pfad} ist nicht vorhanden. MUSIK_PFAD in der .env und den Mount prüfen.', ['pfad' => konfig()['pfade']['musik']])], 409);
                }
                $id = scan_starten(false, (int) ($_SESSION['einr_admin'] ?? 0));
                einr_json(['ok' => true, 'lauf_id' => $id]);
            }
            einr_json(['ok' => true] + ($schritt === 'scan_status' ? einrichtung_scan_status() : einrichtung_scan_zusammenfassung()));
        } catch (Throwable $e) {
            error_log('Einrichtung (' . $schritt . '): ' . $e->getMessage());
            einr_json(['ok' => false, 'fehler' => $e->getMessage()], 500);
        }
    }

    // Nachholen (schon eingerichtet, Admin angemeldet): Ordner prüfen, Region/Server speichern, „später“
    if ($nachAdmin !== null && $z['art'] === 'fertig' && in_array($schritt, ['system', 'nachholen', 'spaeter'], true)) {
        try {
            if ($schritt === 'system') {
                einr_json(['ok' => true] + einrichtung_systempruefung());
            }
            if ($schritt === 'spaeter') {
                geheimnis_loeschen('assistent_offen');
                einr_json(['ok' => true]);
            }
            $f = einrichtung_eingaben_pruefen($in, 'fertig', false);
            [$reg, $regFehler] = region_pruefen($in);
            $f += $regFehler;
            if ($f) {
                einr_json(['ok' => false, 'felder' => $f, 'fehler' => t('Bitte die markierten Angaben prüfen.')], 422);
            }
            einrichtung_server_speichern((string) ($in['zeitzone'] ?? ''), (string) ($in['servername'] ?? ''));
            region_speichern($reg);
            require_once __DIR__ . '/includes/einstellungen.php';
            einstellung_setzen('musik_schreiben', (string) ($in['musik_schreiben'] ?? '0') === '1' ? '1' : '0');
            db_tun('UPDATE users SET sprache = :s WHERE id = :id', ['s' => $reg['sprache'] ?: null, 'id' => $nachAdmin['id']]);
            // Den Schlüssel nur beim ersten Mal zeigen (direkt nach dem Anlegen aus der Vorlage), nicht bei jedem erneuten Aufruf
            $erstesMal = geheimnis_lesen('assistent_offen') !== '';
            geheimnis_loeschen('assistent_offen');
            $_SESSION['einr_nachlauf'] = time() + 7200;
            $_SESSION['einr_admin'] = (int) $nachAdmin['id'];
            $k = konfig();
            einr_json(['ok' => true, 'name' => trim((string) ($nachAdmin['vorname'] ?? '')), 'benutzername' => (string) $nachAdmin['benutzername'],
                'schluessel' => $erstesMal && !empty($k['app_secret_key_erzeugt']) ? $k['app_secret_key'] : null,
                'schluessel_gesichert' => schluessel_sichern(), 'root_abgesichert' => true, 'angemeldet' => true, 'nachgeholt' => true,
                'db_user' => (string) $k['db']['user']]);
        } catch (Throwable $e) {
            error_log('Einrichtung nachholen (' . $schritt . '): ' . $e->getMessage());
            einr_json(['ok' => false, 'fehler' => $e->getMessage()], 500);
        }
    }

    // Nach dem Anlegen des Kontos gilt die Installation als eingerichtet; nur die Sitzung, die es angelegt hat, darf noch abschließen
    $laeuft = !empty($_SESSION['einr_laeuft']);
    if ($z['art'] === 'fertig' && !($schritt === 'abschluss' && $laeuft)) {
        einr_json(['ok' => false, 'fertig' => true, 'fehler' => t('{app} ist bereits eingerichtet.', ['app' => app_name()])], 409);
    }
    if ($z['art'] === 'wartet' && $schritt !== 'system') {
        einr_json(['ok' => false, 'fehler' => t('Die Datenbank startet noch. Bitte einen Moment warten und es erneut versuchen.')], 503);
    }
    if (($nein = einrichtung_zugang((string) ($in['code'] ?? ''))) !== null) {
        einr_json(['ok' => false, 'zugang' => $nein['art'], 'fehler' => $nein['meldung']], 403);
    }
    $ausEnv = konfig()['db']['quelle'] === 'env';
    try {
        if ($schritt === 'code') {
            einr_json(['ok' => true]);
        }
        if ($schritt === 'system') {
            einr_json(['ok' => true] + einrichtung_systempruefung());
        }
        if ($schritt === 'pruefen') {
            $f = einrichtung_eingaben_pruefen($in, $ausEnv ? 'leer' : $z['art'], true);
            $f += region_pruefen($in)[1];
            einr_json(['ok' => !$f, 'felder' => $f, 'fehler' => $f ? t('Bitte die markierten Angaben prüfen.') : null], $f ? 422 : 200);
        }
        if ($schritt === 'db') {
            if ($z['art'] === 'db_fehlt') {
                $f = einrichtung_eingaben_pruefen($in, $ausEnv ? 'leer' : 'db_fehlt', true);
                if ($f) {
                    einr_json(['ok' => false, 'felder' => $f, 'fehler' => t('Bitte die markierten Angaben prüfen.')], 422);
                }
                $c = konfig()['db'];
                if ($ausEnv) {
                    einrichtung_datenbank_anlegen((string) $c['name'], (string) $c['user'], (string) $c['password'], false);
                } else {
                    einrichtung_datenbank_anlegen((string) $in['db_name'], (string) $in['db_user'], (string) $in['db_passwort']);
                }
            }
            einr_json(['ok' => true]);
        }
        if ($schritt === 'tabellen') {
            if ($z['art'] !== 'leer') {
                einr_json(['ok' => false, 'fehler' => t('Die Datenbank ist noch nicht bereit (Zugang). Bitte den Schritt „Datenbank“ wiederholen.')], 409);
            }
            require_once __DIR__ . '/scripts/migrate.php';
            $neu = migrationen_ausfuehren();
            einr_json(['ok' => true, 'migrationen' => count($neu)]);
        }
        if ($schritt === 'admin') {
            if ($z['art'] !== 'leer') {
                einr_json(['ok' => false, 'fehler' => t('Die Datenbank ist noch nicht bereit.')], 409);
            }
            $f = einrichtung_eingaben_pruefen($in, 'leer', true);
            [$reg, $regFehler] = region_pruefen($in);
            $f += $regFehler;
            if ($f) {
                einr_json(['ok' => false, 'felder' => $f, 'fehler' => t('Bitte die markierten Angaben prüfen.')], 422);
            }
            $in['sprache'] = $reg['sprache'];
            $angelegt = einrichtung_admin_anlegen($in);
            einrichtung_server_speichern((string) ($in['zeitzone'] ?? ''), (string) ($in['servername'] ?? ''));
            region_speichern($reg);
            require_once __DIR__ . '/includes/einstellungen.php';
            einstellung_setzen('musik_schreiben', (string) ($in['musik_schreiben'] ?? '0') === '1' ? '1' : '0');
            $_SESSION['einr_laeuft'] = true;
            einr_json(['ok' => true, 'angelegt' => $angelegt]);
        }
        if ($schritt === 'abschluss') {
            require_once __DIR__ . '/includes/db.php';
            $admin = db_zeile("SELECT * FROM users WHERE rolle = 'admin' ORDER BY id LIMIT 1");
            if (!$admin) {
                einr_json(['ok' => false, 'fehler' => t('Das Konto wurde noch nicht angelegt.')], 409);
            }
            unset($_SESSION['einr_laeuft']);
            // All-in-One: root der eingebauten Datenbank kommt ohnehin nur über den Socket im Container hinein
            // All-in-One und Windows-Server: root der mitgelieferten Datenbank ist nur lokal erreichbar und hat schon ein zufälliges Passwort
            $abgesichert = getenv('AMBERWAVE_AIO') === '1' || getenv('AMBERWAVE_WINDOWS') === '1' ? true : einrichtung_root_absichern();
            $gesichert = schluessel_sichern();
            geheimnis_schreiben('eingerichtet', (string) time());
            geheimnis_loeschen('einrichtungscode');
            geheimnis_loeschen('fenster');
            geheimnis_loeschen('code_versuche');
            error_log('Einrichtung abgeschlossen (Anfrage von ' . ($_SERVER['REMOTE_ADDR'] ?? '?') . ').');
            // Die Sitzung, die eingerichtet hat, darf das erste Einlesen begleiten; außerdem sofort anmelden (kein zweiter Login nötig)
            $_SESSION['einr_nachlauf'] = time() + 7200;
            $_SESSION['einr_admin'] = (int) $admin['id'];
            $angemeldet = false;
            try {
                require_once __DIR__ . '/includes/auth.php';
                einr_sitzung('amberwave', 'Lax');
                anmelden($admin, false);
                $angemeldet = true;
            } catch (Throwable $e) {
                error_log('Einrichtung: automatische Anmeldung fehlgeschlagen: ' . $e->getMessage());
            }
            einr_sitzung('amberwave_einr', 'Strict');
            $k = konfig();
            einr_json(['ok' => true, 'name' => trim((string) ($admin['vorname'] ?? '')), 'benutzername' => (string) $admin['benutzername'],
                'schluessel' => !empty($k['app_secret_key_erzeugt']) ? $k['app_secret_key'] : null,
                'schluessel_gesichert' => $gesichert, 'root_abgesichert' => $abgesichert, 'angemeldet' => $angemeldet,
                'db_user' => (string) $k['db']['user']]);
        }
        einr_json(['ok' => false, 'fehler' => t('Unbekannter Schritt.')], 400);
    } catch (Throwable $e) {
        error_log('Einrichtung (' . $schritt . '): ' . $e->getMessage());
        einr_json(['ok' => false, 'fehler' => $e->getMessage()], 500);
    }
}

// ---------- Seite ----------
// Nach der Einrichtung führt die Anzeige im Programm (?einlesen=1 / ?zusammenfassung=1) die Sitzung, die eingerichtet hat, zurück zum Einlesen
$nachlauf = !empty($_SESSION['einr_nachlauf']) && (int) $_SESSION['einr_nachlauf'] >= time();
$startSeite = $nachlauf && isset($_GET['zusammenfassung']) ? 'scanfertig' : ($nachlauf && isset($_GET['einlesen']) ? 'scan' : '');
$nachholen = $z['art'] === 'fertig' && $startSeite === '' && $nachAdmin !== null;
if ($z['art'] === 'fertig' && $startSeite === '' && !$nachholen) {
    header('Location: /login.php');
    exit;
}


function einr_kopf(string $titel): void
{
    echo '<!DOCTYPE html><html lang="' . h(sprache()) . '"><head><meta charset="UTF-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
        . '<meta name="aw-sprache" content="' . h(sprache()) . '"><meta name="aw-locale" content="' . h(sprache_locale()) . '">'
        . '<meta name="robots" content="noindex"><meta name="theme-color" content="#120d0a"><title>' . h($titel) . ' – ' . h(app_name()) . '</title>'
        . schriften_link() . '<link rel="stylesheet" href="' . asset_url('/css/einrichtung.css') . '">'
        . '<link rel="icon" type="image/svg+xml" href="' . asset_url('/img/logo.svg') . '"></head><body>'
        . '<main><div id="b">';
}
function einr_fuss(): void
{
    echo '</div></main></body></html>';
}
/** Eine Seite ohne Skript (Datenbank startet, Fenster abgelaufen): Bild links, Text rechts, wie im Assistenten */
function einr_statisch(string $symbol, string $titel, string $inhalt): void
{
    echo '<div class="kopf"><img src="' . h(asset_url('/img/logo.svg')) . '" alt="" width="30" height="30">' . h(app_name()) . '</div>'
        . '<div class="karte kurz"><div class="kb"><div class="ill">' . $symbol . '</div><div class="kc"><h1>' . h($titel) . '</h1>' . $inhalt . '</div></div></div>';
}

if ($z['art'] === 'wartet') {
    http_response_code(503);
    header('Refresh: 5');
    einr_kopf(t('Datenbank startet'));
    einr_statisch('⏳', t('Die Datenbank startet noch …'), '<p class="sub">' . h(t('Beim allerersten Start dauert das bis zu einer Minute. Diese Seite lädt von selbst neu.')) . '</p>'
        . '<p class="mini">' . t('Dauert es länger: <code>docker logs amberwave_db</code> zeigt, was die Datenbank macht.') . '</p>');
    echo sprachwechsel_html('style="text-align:center;margin:18px 0;font-size:.85rem;opacity:.75"');
    einr_fuss();
    exit;
}

$rest = $startSeite !== '' || $nachholen ? PHP_INT_MAX : einrichtung_fenster_rest();
if ($rest <= 0) {
    einr_kopf(t('Einrichtung gesperrt'));
    einr_statisch('🔒', t('Einrichtungsfenster abgelaufen'), '<p class="sub">' . h(t('Aus Sicherheitsgründen ist die Einrichtung nur {n} Minuten nach dem Start offen. Niemand hat sie in dieser Zeit abgeschlossen.', ['n' => (int) konfig()['einrichtung']['fenster_minuten']])) . '</p>'
        . '<div class="hinweis"><span>🔄</span><span>' . t('<b>So öffnest du sie wieder</b>Starte den Container neu: <code>docker restart amberwave_app</code> (in Unraid: Docker-Tab → amberwave_app → Neustart). Danach läuft das Fenster erneut.') . '</span></div>'
        . '<p class="mini">' . t('Das Fenster lässt sich mit <code>EINRICHTUNG_FENSTER_MINUTEN</code> in der .env ändern (0 = immer offen).') . '</p>');
    echo sprachwechsel_html('style="text-align:center;margin:18px 0;font-size:.85rem;opacity:.75"');
    einr_fuss();
    exit;
}

$ausEnv = konfig()['db']['quelle'] === 'env';
$zeigeDb = $z['art'] === 'db_fehlt' && !$ausEnv;
$codeNoetig = !$nachholen && einrichtung_code_noetig();
$herkunft = einrichtung_herkunft();
$pw = einrichtung_zufallspasswort(20);
$k = konfig();
einr_kopf(t('Einrichtung'));
?>
</div></main>
<?= sprachwechsel_html('style="text-align:center;margin:18px 0;font-size:.85rem;opacity:.75"') ?>
<div id="einr" hidden data-csrf="<?= h($_SESSION['csrf']) ?>" data-code="<?= $codeNoetig ? '1' : '0' ?>" data-db="<?= $zeigeDb ? '1' : '0' ?>"
     data-rest="<?= $rest === PHP_INT_MAX ? 0 : $rest ?>" data-minlaenge="<?= (int) $k['sicherheit']['passwort_min_laenge'] ?>"
     data-zone="<?= h($k['zeitzone']) ?>" data-servername="<?= h($k['server_name']) ?>" data-dbpw="<?= h($pw) ?>" data-app="<?= h(app_name()) ?>"
     data-logo="<?= h(asset_url('/img/logo.svg')) ?>" data-region="<?= h(region_auswahl_json()) ?>" data-sprache="<?= h(sprache()) ?>" data-start="<?= h($startSeite) ?>" data-nach="<?= $nachholen ? '1' : '0' ?>"></div>

<!-- Start -->
<template id="t-start">
<div class="karte start">
 <div class="hero2">
  <div class="logo-wrap ani" style="--d:.1s">
   <span class="welle"></span><span class="welle"></span>
   <svg class="logo2" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="g3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc35a"/><stop offset="1" stop-color="#ff6a3d"/></linearGradient></defs>
    <rect x="2" y="2" width="60" height="60" rx="16" fill="#1a120c"/><rect x="2.5" y="2.5" width="59" height="59" rx="15.5" fill="none" stroke="url(#g3)" stroke-opacity=".6"/>
    <g fill="url(#g3)"><rect class="st" x="11" y="27" width="5" height="10" rx="2.5"/><rect class="st" x="19.5" y="20" width="5" height="24" rx="2.5"/><rect class="st" x="28" y="13" width="5" height="38" rx="2.5"/><rect class="st" x="36.5" y="22" width="5" height="20" rx="2.5"/><rect class="st" x="45" y="17" width="5" height="30" rx="2.5"/></g></svg>
  </div>
  <h1 class="name ani" style="--d:.3s"><?= h(app_name()) ?></h1>
  <p class="claim ani" style="--d:.45s"><?= h(t('Deine Musik. Dein Server. Deine Familie.')) ?></p>
  <p class="text ani" style="--d:.6s"><?= h(t('Schön, dass du da bist. In zwei Minuten ist alles bereit: Wir schauen kurz nach deinen Ordnern, du legst dein Konto an – fertig.')) ?></p>
  <ol class="weg ani" style="--d:.8s"><li><i>1</i><?= h(t('Ordner prüfen')) ?></li><li><i>2</i><?= h(t('Konto anlegen')) ?></li><li><i>3</i><?= h(t('Loshören')) ?></li></ol>
  <button class="btn gross ani" style="--d:1s" id="los" type="button"><?= h(t('Los geht’s')) ?></button>
 </div>
</div>
</template>

<!-- Region -->
<template id="t-region">
<div class="karte">
 <div class="schritte"><div class="ok"><?= h(t('Willkommen')) ?></div><div class="jetzt ok"><?= h(t('Region')) ?></div><div><?= h(t('Ordner')) ?></div><div><?= h(t('Konto')) ?></div><div><?= h(t('Fertig')) ?></div></div>
 <h1><?= h(t('Wo bist du zu Hause?')) ?></h1>
 <p class="sub"><?= h(t('Land, Sprache und Zeitzone legen fest, wie {app} Texte, Datum, Uhrzeit und Preise zeigt. Jede Person kann ihre Sprache später selbst ändern.', ['app' => app_name()])) ?></p>
 <div class="zwei">
  <div class="sp"><label for="r-land"><?= h(t('Land')) ?></label><select id="r-land" name="land"></select></div>
  <div class="sp"><label for="r-sprache"><?= h(t('Sprache / Language')) ?></label><select id="r-sprache" name="sprache"></select></div>
 </div>
 <div class="zwei">
  <div class="sp"><label for="r-zeitzone"><?= h(t('Zeitzone')) ?></label><select id="r-zeitzone" name="zeitzone"></select></div>
  <div class="sp"><label for="r-waehrung"><?= h(t('Währung')) ?></label><select id="r-waehrung" name="waehrung"></select></div>
 </div>
 <div class="zwei">
  <div class="sp"><label for="r-datum"><?= h(t('Datumsformat')) ?></label><select id="r-datum" name="datumsformat"></select></div>
  <div class="sp"><label for="r-zeit"><?= h(t('Uhrzeit')) ?></label><select id="r-zeit" name="zeitformat"></select></div>
 </div>
 <div class="zwei">
  <div class="sp"><label for="r-einheiten"><?= h(t('Einheiten')) ?></label><select id="r-einheiten" name="einheiten"></select></div>
 </div>
 <p class="mini" id="r-vorschau"></p>
 <button class="btn" id="region-weiter" type="button"><?= h(t('Weiter')) ?></button>
</div>
</template>

<!-- Code -->
<template id="t-code">
<div class="karte">
 <div class="schritte"><div class="ok"><?= h(t('Willkommen')) ?></div><div class="ok"><?= h(t('Region')) ?></div><div class="jetzt ok"><?= h(t('Einrichtungscode')) ?></div><div><?= h(t('Ordner')) ?></div><div><?= h(t('Konto')) ?></div></div>
 <h1><?= h(t('Einrichtungscode')) ?></h1>
 <p class="sub"><?= h(t('Damit niemand außer dir einrichten kann, braucht es hier einen Code.')) ?> <?= h(match ($herkunft['grund']) {
     'proxy' => t('Deine Anfrage kommt über einen Proxy oder Tunnel.'),
     'bruecke' => t('Deine Anfrage kommt über die Docker-Brücke ({ip}) – so kommen auch Zugriffe aus dem Internet über Dockers Portweiterleitung an.', ['ip' => $herkunft['ip']]),
     'lokal' => t('So ist es in der .env eingestellt (EINRICHTUNG_CODE_IMMER=1).'),
     default => t('Deine Adresse {ip} gehört nicht zum Heimnetz.', ['ip' => $herkunft['ip']]),
 }) ?></p>
 <div class="hinweis"><span>🔑</span><span><?= t('<b>Wo steht der Code?</b>Im Log von <code>amberwave_app</code> (Unraid: Docker-Tab → Logs) oder in der Datei <code>cache/geheimnisse/einrichtungscode</code>.') ?></span></div>
 <label for="f-code"><?= h(t('Einrichtungscode')) ?></label><input id="f-code" name="code" type="text" placeholder="<?= h(t('z. B. K7QM-4TXP')) ?>" autocapitalize="characters" spellcheck="false" autocomplete="off">
 <div class="hinweis rot" id="code-fehler" style="margin-top:10px" hidden><span>⚠️</span><span id="code-fehler-text"></span></div>
 <button class="btn" id="code-weiter" type="button"><?= h(t('Weiter')) ?></button>
</div>
</template>

<!-- Ordner und Rechte -->
<template id="t-check">
<div class="karte">
 <div class="schritte"><div class="ok"><?= h(t('Willkommen')) ?></div><div class="ok"><?= h(t('Region')) ?></div><div class="jetzt ok"><?= h(t('Ordner')) ?></div><div><?= h(t('Konto')) ?></div><div><?= h(t('Fertig')) ?></div></div>
 <h1><?= h(t('Ordner und Rechte')) ?></h1>
 <p class="sub" id="ck-sub"><?= h(t('Alles, was {app} auf deinem Server anfasst – und als wer.', ['app' => app_name()])) ?></p>
 <div id="ck-inhalt"><p class="mini mitte" style="margin:40px 0"><?= h(t('Einen Moment, ich schaue nach …')) ?></p></div>
</div>
</template>

<!-- Konto -->
<template id="t-konto">
<div class="karte">
 <div class="schritte"><div class="ok"><?= h(t('Willkommen')) ?></div><div class="ok"><?= h(t('Region')) ?></div><div class="ok"><?= h(t('Ordner')) ?></div><div class="jetzt ok"><?= h(t('Konto')) ?></div><div><?= h(t('Fertig')) ?></div></div>
 <h1><?= h(t('Dein Konto')) ?></h1>
 <p class="sub"><?= h(t('Du bist der Administrator – du verwaltest Bibliothek, Nutzer und Einstellungen.')) ?></p>
 <div class="hinweis rot" id="k-meldung" role="alert" hidden></div>
 <div class="zwei">
  <div class="sp">
   <div class="zeile"><div><label for="f-vorname"><?= h(t('Vorname')) ?></label><input id="f-vorname" name="vorname" type="text" autocomplete="given-name"></div><div><label for="f-nachname"><?= h(t('Nachname')) ?></label><input id="f-nachname" name="nachname" type="text" autocomplete="family-name" placeholder="<?= h(t('Nachname')) ?>"></div></div>
   <label for="f-benutzername"><?= h(t('Benutzername')) ?> <span class="leise">(<?= h(t('aus dem Vornamen vorgeschlagen')) ?>)</span></label><input id="f-benutzername" name="benutzername" type="text" autocapitalize="none" spellcheck="false" autocomplete="username">
   <label for="f-email"><?= h(t('E-Mail')) ?> <span class="leise">(<?= h(t('für „Passwort vergessen“')) ?>)</span></label><input id="f-email" name="email" type="email" autocomplete="email" placeholder="<?= h(t('du@example.de')) ?>">
  </div>
  <div class="sp">
   <label for="f-passwort"><?= h(t('Passwort')) ?></label>
   <div class="feld"><input id="f-passwort" name="passwort" type="password" autocomplete="new-password"><button class="auge" type="button" id="auge"><?= h(t('anzeigen')) ?></button></div>
   <div class="staerke"><b id="staerke" style="width:0"></b></div>
   <p class="mini" id="pw-hinweis"><?= h(t('Mindestens 8 Zeichen. Gut: ein Satz, den nur du kennst.')) ?></p>
   <div id="pw2zeile"><label for="f-passwort2"><?= h(t('Passwort wiederholen')) ?></label><input id="f-passwort2" name="passwort2" type="password" autocomplete="new-password"></div>
  </div>
 </div>
 <h2><?= h(t('Dein Server')) ?></h2>
 <div class="zwei">
  <div class="sp"><label for="f-servername" style="margin-top:6px"><?= h(t('Name deines Servers')) ?> <span class="leise">(<?= h(t('so erscheint er im Windows-Client')) ?>)</span></label><input id="f-servername" name="servername" type="text" placeholder="<?= h(app_name()) ?>" autocomplete="off"></div>
 </div>
 <details class="erw" id="k-db" hidden>
  <summary><?= h(t('Erweitert: Datenbank')) ?></summary>
  <p class="mini" style="margin-top:0"><?= h(t('Normalerweise nichts ändern – {app} legt die Datenbank mit einem zufälligen Passwort an.', ['app' => app_name()])) ?></p>
  <div class="zeile"><div><label for="f-db_name"><?= h(t('Datenbank')) ?></label><input id="f-db_name" name="db_name" type="text" value="amberwave" autocapitalize="none" spellcheck="false"></div><div><label for="f-db_user"><?= h(t('Benutzer')) ?></label><input id="f-db_user" name="db_user" type="text" value="amberwave" autocapitalize="none" spellcheck="false"></div><div><label for="f-db_passwort"><?= h(t('Datenbank-Passwort')) ?></label>
   <div class="pwzeile"><input id="f-db_passwort" name="db_passwort" type="text" spellcheck="false" autocapitalize="none"><button class="btn2" type="button" id="wuerfeln"><?= h(t('Neu würfeln')) ?></button></div></div></div>
  <p class="mini"><?= t('Wird nur als Datei im App-Daten-Ordner gespeichert (<code>geheimnisse/datenbank.json</code>). Später unter Einstellungen › Dienste &amp; Schlüssel einsehbar.') ?></p>
 </details>
 <p class="mini" id="k-dbnotiz" hidden></p>
 <button class="btn" id="einrichten" type="button"><?= h(t('Einrichten')) ?></button>
</div>
</template>

<!-- Nachholen: Servername (statt Konto) -->
<template id="t-server">
<div class="karte">
 <div class="schritte"><div class="ok"><?= h(t('Willkommen')) ?></div><div class="ok"><?= h(t('Region')) ?></div><div class="ok"><?= h(t('Ordner')) ?></div><div class="jetzt ok"><?= h(t('Server')) ?></div><div><?= h(t('Fertig')) ?></div></div>
 <h1><?= h(t('Dein Server')) ?></h1>
 <p class="sub"><?= h(t('Dein Konto ist schon angelegt. Fehlt nur noch ein Name für deinen Server.')) ?></p>
 <div class="hinweis rot" id="s-meldung" role="alert" hidden></div>
 <div class="zwei">
  <div class="sp"><label for="s-servername"><?= h(t('Name deines Servers')) ?> <span class="leise">(<?= h(t('so erscheint er im Windows-Client')) ?>)</span></label><input id="s-servername" name="servername" type="text" placeholder="<?= h(app_name()) ?>" autocomplete="off"></div>
 </div>
 <button class="btn" id="s-fertig" type="button"><?= h(t('Fertigstellen')) ?></button>
</div>
</template>

<!-- Läuft / Fehler -->
<template id="t-lauf">
<div class="karte">
 <div class="schritte"><div class="ok"><?= h(t('Willkommen')) ?></div><div class="ok"><?= h(t('Region')) ?></div><div class="ok"><?= h(t('Ordner')) ?></div><div class="ok"><?= h(t('Konto')) ?></div><div class="jetzt ok"><?= h(t('Fertig')) ?></div></div>
 <h1 id="l-titel"><?= h(t('Wird eingerichtet …')) ?></h1>
 <p class="sub" id="l-sub"><?= h(t('Das dauert etwa eine halbe Minute. Bitte die Seite offen lassen.')) ?></p>
 <ul class="liste" id="l-liste"></ul>
 <div class="hinweis rot" id="l-fehler" role="alert" style="margin-top:14px" hidden><span>⚠️</span><span id="l-fehler-text"></span></div>
 <button class="btn" id="l-nochmal" type="button" hidden><?= h(t('Nochmal versuchen')) ?></button>
</div>
</template>

<!-- Fertig -->
<template id="t-fertig">
<div class="karte fertig">
 <canvas id="konf"></canvas>
 <div class="buehne">
  <span class="welle"></span><span class="welle"></span><span class="welle"></span>
  <svg class="ring" viewBox="0 0 150 150" aria-hidden="true">
   <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc35a"/><stop offset="1" stop-color="#ff6a3d"/></linearGradient></defs>
   <circle class="grund" cx="75" cy="75" r="62"/>
   <circle class="bogen" cx="75" cy="75" r="62"/>
   <rect class="st" x="37" y="60" width="9" height="30" rx="4.5"/>
   <rect class="st" x="52" y="48" width="9" height="54" rx="4.5"/>
   <rect class="st" x="70.5" y="36" width="9" height="78" rx="4.5"/>
   <rect class="st" x="89" y="50" width="9" height="50" rx="4.5"/>
   <rect class="st" x="104" y="42" width="9" height="66" rx="4.5"/>
  </svg>
  <span class="badge"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>
 </div>
 <h1 class="mitte ani" style="--d:1.5s" id="f-titel"><?= h(t('Fertig!')) ?></h1>
 <p class="sub mitte ani" style="--d:1.65s" id="f-sub"><?= h(t('Du bist angemeldet – {app} ist bereit.', ['app' => app_name()])) ?></p>
 <ul class="erg">
  <li class="ani" style="--d:1.9s"><i>✓</i><span><?= h(t('Datenbank läuft')) ?><small id="f-db">MariaDB</small></span></li>
  <li class="ani" style="--d:2.05s"><i>✓</i><span id="f-konto"><?= h(t('Konto angelegt')) ?><small><?= h(t('Administrator')) ?></small></span></li>
  <li class="ani" style="--d:2.2s"><i>✓</i><span><?= h(t('Ordner bereit')) ?><small><?= h(t('Musik, App-Daten, Sicherungen')) ?></small></span></li>
  <li class="ani" style="--d:2.35s"><i>✓</i><span><?= h(t('Zugänge abgesichert')) ?><small id="f-root"><?= h(t('Root-Zugang gesperrt')) ?></small></span></li>
 </ul>
 <div class="zwei unten ani" style="--d:2.7s">
  <div class="sp" id="f-links">
   <div id="f-schluesselbox" hidden>
    <div class="hinweis"><span>🔐</span><span><?= t('<b>Dein Schlüssel – einmal sichern</b>Er schützt gespeicherte Zugangsdaten (Mail, API-Schlüssel, Cloudflare). Geht er verloren, musst du sie neu eintragen – deine Musik und Konten sind nicht betroffen.') ?></span></div>
    <div class="schluessel" id="f-schluessel"></div>
    <div class="pwzeile"><button class="btn2" type="button" id="f-kopieren"><?= h(t('Kopieren')) ?></button><button class="btn2" type="button" id="f-datei"><?= h(t('Als Datei speichern')) ?></button></div>
    <p class="mini" id="f-ort"></p>
    <label class="haken"><input type="checkbox" id="f-haken"> <?= h(t('Ich habe den Schlüssel gesichert.')) ?></label>
   </div>
   <div class="hinweis" id="f-envschluessel" hidden><span>🔐</span><span><?= t('<b>Dein Schlüssel steht in der .env</b>Die Zeile <code>APP_SECRET_KEY</code> verschlüsselt gespeicherte Zugangsdaten. Sichere sie zusammen mit deiner .env.') ?></span></div>
  </div>
  <div class="sp">
   <div class="zahl" id="f-zahl"><b id="zz">0</b><span id="f-zahltext"><?= h(t('Titel warten darauf, eingelesen zu werden')) ?></span></div>
   <button class="btn" id="f-scan" type="button"><?= h(t('Bibliothek jetzt einlesen')) ?></button>
   <button class="btn zweit" id="f-spaeter" type="button"><?= h(t('Später – zur Bibliothek')) ?></button>
   <p class="mini mitte" style="margin-top:12px" id="f-dauer"><?= h(t('Einlesen läuft im Hintergrund; du kannst schon stöbern.')) ?></p>
  </div>
 </div>
</div>
</template>

<!-- Einlesen läuft -->
<template id="t-scan">
<div class="karte scankarte">
 <h1 class="mitte" id="sc-titel"><?= h(t('Deine Musik wird eingelesen …')) ?></h1>
 <p class="sub mitte"><?= h(t('Amberwave liest Tags, Cover und Spielzeiten – dabei wird nichts verändert.')) ?></p>
 <div class="zwei sc2">
  <div class="sp">
   <div class="spek" id="spek"></div>
   <div class="zaehler"><div><b id="z-t">0</b><span><?= h(t('Titel{pl}', ['pl' => ''])) ?></span></div><div><b id="z-a">0</b><span><?= h(t('Alben')) ?></span></div><div><b id="z-k">0</b><span><?= h(t('Künstler{pl}', ['pl' => ''])) ?></span></div></div>
   <div class="fort"><b id="sc-bar"></b></div>
   <p class="mini mitte" id="sc-text"><?= h(t('Zähle Dateien …')) ?></p>
   <div id="erstes"></div>
   <div class="hinweis rot" id="sc-fehler" style="margin-top:10px" hidden><span>⚠️</span><span id="sc-fehler-text"></span></div>
  </div>
  <div class="sp"><div class="wand" id="wand"></div></div>
 </div>
 <div class="zweig unten">
  <button class="btn aus" id="sc-bib" disabled type="button"><?= h(t('Schon stöbern')) ?></button>
  <button class="btn zweit" id="sc-hinten" type="button"><?= h(t('Im Hintergrund weiterscannen – Bibliothek öffnen')) ?></button>
 </div>
 <p class="mini mitte" style="margin-top:12px"><?= h(t('Du kannst die Seite verlassen: Das Einlesen läuft auf dem Server weiter, auch wenn du den Browser schließt.')) ?></p>
</div>
</template>

<!-- Einlesen fertig -->
<template id="t-scanfertig">
<div class="karte scankarte">
 <canvas id="konf" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3"></canvas>
 <div class="mitte" style="font-size:40px;margin-top:2px">🎶</div>
 <h1 class="mitte ani" style="--d:.2s"><?= h(t('Deine Sammlung ist da')) ?></h1>
 <p class="sub mitte ani" style="--d:.35s"><?= h(t('Alles eingelesen – das ist deine Musik in Zahlen.')) ?></p>
 <div class="kachel" id="sf-kacheln"></div>
 <div class="zwei ani" style="--d:1.5s">
  <div class="sp" id="sf-top"></div>
  <div class="sp" id="sf-hinweis"></div>
 </div>
 <div class="zweig unten ani" style="--d:2.8s"><button class="btn" id="sf-bib" type="button"><?= h(t('Zur Bibliothek')) ?></button>
 <button class="btn zweit" id="sf-aufraeumen" type="button"><?= h(t('Aufräumliste ansehen')) ?></button></div>
</div>
</template>

<script type="importmap"><?= import_map_json() ?></script>
<script type="module" src="<?= h(asset_url('/js/einrichtung.js')) ?>"></script>
</body></html>
