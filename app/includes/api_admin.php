<?php
declare(strict_types=1);
require_once __DIR__ . '/api_bibliothek.php';
require_once __DIR__ . '/mail_texte.php';
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/scanner.php';
require_once __DIR__ . '/sicherung.php';

function api_admin_uebersicht(): array
{
    $l = db_zeile('SELECT * FROM scan_laeufe ORDER BY id DESC LIMIT 1');
    return [
        'zahlen' => [
            'alben' => (int) db_wert('SELECT COUNT(*) FROM alben'),
            'editionen' => (int) db_wert('SELECT COUNT(*) FROM editionen'),
            'tracks' => (int) db_wert('SELECT COUNT(*) FROM tracks'),
            'kuenstler' => (int) db_wert('SELECT COUNT(*) FROM kuenstler'),
            'dateien' => (int) db_wert('SELECT COUNT(*) FROM dateien'),
            'dateien_fehler' => (int) db_wert("SELECT COUNT(*) FROM dateien WHERE fehler <> ''"),
            'dateien_ohne_track' => (int) db_wert("SELECT COUNT(*) FROM dateien WHERE track_id IS NULL AND fehler = ''"),
            'groesse' => (int) db_wert('SELECT COALESCE(SUM(groesse), 0) FROM dateien'),
            'laenge_ms' => (int) db_wert('SELECT COALESCE(SUM(laenge_ms), 0) FROM dateien'),
            'ohne_cover' => (int) db_wert("SELECT COUNT(*) FROM alben a JOIN editionen e ON e.id = a.anzeige_edition_id WHERE e.cover_datei = ''"),
            'konten_aktiv' => (int) db_wert("SELECT COUNT(*) FROM users WHERE status = 'aktiv'"),
            'konten_wartend' => (int) db_wert("SELECT COUNT(*) FROM users WHERE status = 'pending'"),
            'konten_bald_ablaufend' => (int) db_wert("SELECT COUNT(*) FROM users WHERE status = 'aktiv' AND rolle <> 'admin' AND gueltig_bis IS NOT NULL AND gueltig_bis BETWEEN NOW() AND (NOW() + INTERVAL 30 DAY)"),
        ],
        'formate' => db_alle("SELECT UPPER(format) AS format, COUNT(*) AS n FROM dateien WHERE fehler = '' GROUP BY UPPER(format) ORDER BY n DESC"),
        'letzter_scan' => $l ? scan_objekt($l) : null,
        'version' => app_version(),
        'update' => (static function () { require_once __DIR__ . '/updatecheck.php'; return update_hinweis(false); })(),
        'image' => getenv('AMBERWAVE_IMAGE') === '1',
        'musikordner' => konfig()['pfade']['musik'],
        'musikordner_ok' => is_dir(konfig()['pfade']['musik']),
        'secret_key' => empty(konfig()['app_secret_key_fluechtig']) && konfig()['app_secret_key'] !== '',
        'mail_eingerichtet' => mail_konfiguriert(),
        'proxy' => api_admin_proxy_offen(),
    ];
}

function scan_objekt(array $l): array
{
    return [
        'id' => (int) $l['id'], 'art' => $l['art'], 'status' => $l['status'], 'gestartet' => iso($l['gestartet_am']), 'beendet' => iso($l['beendet_am']),
        'lebenszeichen' => iso($l['lebenszeichen']), 'gesamt' => (int) $l['dateien_gesamt'], 'geprueft' => (int) $l['dateien_geprueft'],
        'neu' => (int) $l['dateien_neu'], 'geaendert' => (int) $l['dateien_geaendert'], 'entfernt' => (int) $l['dateien_entfernt'],
        'alben_neu' => (int) $l['alben_neu'], 'fehler' => (int) $l['fehler_anzahl'], 'aktuell' => $l['aktuell'], 'meldung' => $l['meldung'],
    ];
}

function api_admin_scan_status(): array
{
    $laeufe = array_map('scan_objekt', db_alle('SELECT * FROM scan_laeufe ORDER BY id DESC LIMIT 10'));
    $letzter = $laeufe[0]['id'] ?? 0;
    $fehler = $letzter ? db_alle('SELECT pfad, fehler FROM scan_fehler WHERE lauf_id = :l ORDER BY id LIMIT 200', ['l' => $letzter]) : [];
    $laufend = scan_laufend();
    $kein_zugriff = $letzter ? (int) db_wert("SELECT COUNT(*) FROM scan_fehler WHERE lauf_id = :l AND fehler LIKE 'Kein Zugriff%'", ['l' => $letzter]) : 0;
    $nutzer = function_exists('posix_geteuid') ? posix_geteuid() . ':' . posix_getegid() : '';
    return ['laufend' => $laufend ? scan_objekt($laufend) : null, 'laeufe' => $laeufe, 'fehler' => $fehler, 'kein_zugriff' => $kein_zugriff, 'benutzer' => $nutzer,
        'auto_stunden' => (int) einstellung('scan_auto_stunden')];
}

function api_admin_scan_starten(array $user): array
{
    if (!is_dir(konfig()['pfade']['musik'])) {
        throw new ApiFehler(t('Der Musikordner {pfad} ist nicht vorhanden. MUSIK_PFAD in der .env und den Mount prüfen.', ['pfad' => konfig()['pfade']['musik']]));
    }
    $id = scan_starten(api_wert('art') === 'voll', (int) $user['id']);
    return ['ok' => true, 'lauf_id' => $id];
}

// ---------- Konten ----------

function konto_objekt(array $u): array
{
    $g = db_zeile('SELECT COUNT(*) AS n, MAX(zuletzt_am) AS z FROM nutzer_geraete WHERE user_id = :u AND beendet_am IS NULL', ['u' => $u['id']]);
    $abgelaufen = $u['status'] === 'aktiv' && $u['rolle'] !== 'admin' && $u['gueltig_bis'] !== null && strtotime((string) $u['gueltig_bis']) <= time();
    return [
        'id' => (int) $u['id'], 'vorname' => $u['vorname'], 'nachname' => $u['nachname'], 'benutzername' => $u['benutzername'], 'email' => $u['email'],
        'rolle' => $u['rolle'], 'status' => $abgelaufen ? 'abgelaufen' : $u['status'], 'aktiviert_am' => iso($u['aktiviert_am']), 'gueltig_bis' => iso($u['gueltig_bis']),
        'gesperrt_bis' => iso($u['gesperrt_bis']), 'sperr_grund' => $u['sperr_grund'], 'erstellt_am' => iso($u['erstellt_am']),
        'geraete' => (int) ($g['n'] ?? 0), 'zuletzt_aktiv' => iso($g['z'] ?? null),
        'bald_ablaufend' => !$abgelaufen && $u['status'] === 'aktiv' && $u['rolle'] !== 'admin' && $u['gueltig_bis'] !== null && strtotime((string) $u['gueltig_bis']) < time() + 30 * 86400,
    ];
}

function api_admin_konten(): array
{
    $liste = db_alle("SELECT * FROM users ORDER BY FIELD(status, 'pending', 'aktiv', 'gesperrt'), nachname, vorname");
    return ['konten' => array_map('konto_objekt', $liste)];
}

function konto_laden(int $id): array
{
    $u = db_zeile('SELECT * FROM users WHERE id = :id', ['id' => $id]);
    if (!$u) {
        throw new ApiFehler(t('Konto nicht gefunden.'), 404);
    }
    return $u;
}

/** Monate 1–24 oder 0 = unbegrenzt */
function monate_eingabe(): int
{
    $m = (int) api_wert('monate', 12);
    if ($m < 0 || $m > 24) {
        throw new ApiFehler(t('Gültigkeit bitte zwischen 1 und 24 Monaten wählen (oder unbegrenzt).'));
    }
    return $m;
}

function api_admin_konto_aktion(array $admin, int $id, string $aktion): array
{
    $u = konto_laden($id);
    $eigenes = (int) $u['id'] === (int) $admin['id'];
    switch ($aktion) {
        case 'freischalten':
            $m = monate_eingabe();
            db_tun("UPDATE users SET status = 'aktiv', aktiviert_am = NOW(), gueltigkeit_monate = :m, gueltig_bis = " . ($m > 0 ? '(NOW() + INTERVAL ' . $m . ' MONTH)' : 'NULL') . ',
                    gesperrt_bis = NULL, sperr_grund = NULL, gesperrt_am = NULL WHERE id = :id', ['m' => $m ?: null, 'id' => $id]);
            $u2 = konto_laden($id);
            mail_ereignis('freigeschaltet', [(string) $u2['email']], ['vorname' => $u2['vorname'], 'link' => app_link('/'),
                'gueltig_bis' => (string) ($u2['gueltig_bis'] ?? '')]);
            log_sicherheitsereignis((int) $admin['id'], 'konto_freigeschaltet', '#' . $id . ', ' . ($m ?: 'unbegrenzt') . ' Monate');
            break;
        case 'verlaengern':
            $m = monate_eingabe();
            if ($m === 0) {
                db_tun('UPDATE users SET gueltig_bis = NULL, gueltigkeit_monate = NULL WHERE id = :id', ['id' => $id]);
            } else {
                // Noch gültig: auf das bisherige Ablaufdatum addieren. Abgelaufen: ab heute.
                db_tun('UPDATE users SET gueltig_bis = (CASE WHEN gueltig_bis IS NOT NULL AND gueltig_bis > NOW() THEN gueltig_bis ELSE NOW() END) + INTERVAL ' . $m . ' MONTH,
                        gueltigkeit_monate = :m, ablauf_mail_fuer = NULL WHERE id = :id', ['m' => $m, 'id' => $id]);
            }
            $u2 = konto_laden($id);
            if ($u2['gueltig_bis']) {
                mail_ereignis('verlaengert', [(string) $u2['email']], ['vorname' => $u2['vorname'], 'gueltig_bis' => (string) $u2['gueltig_bis'], 'link' => app_link('/')]);
            }
            log_sicherheitsereignis((int) $admin['id'], 'konto_verlaengert', '#' . $id . ', +' . ($m ?: 'unbegrenzt'));
            break;
        case 'sperren':
            if ($eigenes) {
                throw new ApiFehler(t('Das eigene Konto kann nicht gesperrt werden.'));
            }
            $bis = datum_eingabe((string) api_wert('bis', ''));
            if ($bis === null || ($bis !== '' && strlen($bis) !== 10)) {
                throw new ApiFehler(t('Bitte das Datum als TT.MM.JJJJ angeben (oder leer lassen).'));
            }
            $ts = $bis !== '' ? strtotime($bis . ' 23:59:59') : false;
            db_tun("UPDATE users SET status = 'gesperrt', gesperrt_am = NOW(), gesperrt_bis = :b, sperr_grund = :g WHERE id = :id",
                ['b' => $ts ? date('Y-m-d H:i:s', $ts) : null, 'g' => mb_substr(trim((string) api_wert('grund', '')), 0, 500) ?: null, 'id' => $id]);
            foreach (geraete_aktive($id) as $g) {
                geraet_beenden($id, (int) $g['id']);
            }
            db_tun('DELETE FROM remember_tokens WHERE user_id = :u', ['u' => $id]);
            log_sicherheitsereignis((int) $admin['id'], 'konto_gesperrt', '#' . $id);
            break;
        case 'entsperren':
            db_tun("UPDATE users SET status = 'aktiv', gesperrt_am = NULL, gesperrt_bis = NULL, sperr_grund = NULL WHERE id = :id AND status = 'gesperrt'", ['id' => $id]);
            log_sicherheitsereignis((int) $admin['id'], 'konto_entsperrt', '#' . $id);
            break;
        case 'ablehnen':
            if ($u['status'] !== 'pending') {
                throw new ApiFehler(t('Nur wartende Registrierungen können abgelehnt werden.'));
            }
            db_tun('DELETE FROM users WHERE id = :id', ['id' => $id]);
            log_sicherheitsereignis((int) $admin['id'], 'registrierung_abgelehnt', $u['benutzername']);
            return ['ok' => true, 'geloescht' => true];
        case 'passwort':
            $pw = (string) api_wert('passwort', '');
            if (($s = passwort_ist_zu_schwach($pw)) !== null) {
                throw new ApiFehler($s);
            }
            db_tun('UPDATE users SET passwort_hash = :p, muss_passwort_aendern = 1 WHERE id = :id', ['p' => passwort_hashen($pw), 'id' => $id]);
            db_tun('DELETE FROM remember_tokens WHERE user_id = :u', ['u' => $id]);
            if ($id !== (int) $admin['id']) {
                foreach (geraete_aktive($id) as $g) {
                    geraet_beenden_intern((int) $g['id'], 'passwort');
                }
            }
            log_sicherheitsereignis((int) $admin['id'], 'passwort_gesetzt', '#' . $id);
            break;
        case 'geraete_abmelden':
            foreach (geraete_aktive($id) as $g) {
                geraet_beenden($id, (int) $g['id']);
            }
            db_tun('DELETE FROM remember_tokens WHERE user_id = :u', ['u' => $id]);
            break;
        default:
            throw new ApiFehler(t('Unbekannte Aktion.'), 404);
    }
    return ['ok' => true, 'konto' => konto_objekt(konto_laden($id))];
}

function api_admin_konto_aendern(array $admin, int $id): array
{
    $u = konto_laden($id);
    $felder = [];
    foreach (['vorname' => 100, 'nachname' => 100] as $f => $max) {
        $w = trim((string) api_wert($f, $u[$f]));
        if ($w === '') {
            throw new ApiFehler(t('Vor- und Nachname dürfen nicht leer sein.'));
        }
        $felder[$f] = mb_substr($w, 0, $max);
    }
    $email = trim((string) api_wert('email', $u['email']));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) && $email !== 'admin@localhost') {
        throw new ApiFehler(t('Bitte eine gültige E-Mail-Adresse angeben.'));
    }
    $felder['email'] = $email;
    $bn = trim((string) api_wert('benutzername', $u['benutzername']));
    if (!preg_match('/^[A-Za-z0-9._-]{3,50}$/', $bn)) {
        throw new ApiFehler(t('Der Benutzername darf 3–50 Zeichen lang sein (Buchstaben, Ziffern, . _ -).'));
    }
    $felder['benutzername'] = $bn;
    $rolle = (string) api_wert('rolle', $u['rolle']);
    if (!in_array($rolle, ['admin', 'user'], true)) {
        throw new ApiFehler(t('Ungültige Rolle.'));
    }
    if ($rolle !== 'admin' && $u['rolle'] === 'admin' && (int) db_wert("SELECT COUNT(*) FROM users WHERE rolle = 'admin' AND status = 'aktiv'") <= 1) {
        throw new ApiFehler(t('Es muss mindestens ein Admin bleiben.'));
    }
    $felder['rolle'] = $rolle;
    $felder['id'] = $id;
    try {
        db_tun('UPDATE users SET vorname = :vorname, nachname = :nachname, email = :email, benutzername = :benutzername, rolle = :rolle WHERE id = :id', $felder);
    } catch (PDOException $e) {
        throw new ApiFehler($e->getCode() === '23000' ? t('Benutzername oder E-Mail-Adresse ist bereits vergeben.') : t('Speichern fehlgeschlagen.'));
    }
    log_sicherheitsereignis((int) $admin['id'], 'konto_geaendert', '#' . $id);
    return ['ok' => true, 'konto' => konto_objekt(konto_laden($id))];
}

function api_admin_konto_anlegen(array $admin): array
{
    $vn = trim((string) api_wert('vorname', ''));
    $nn = trim((string) api_wert('nachname', ''));
    $bn = trim((string) api_wert('benutzername', ''));
    $em = trim((string) api_wert('email', ''));
    $pw = (string) api_wert('passwort', '');
    $m = monate_eingabe();
    if ($vn === '' || $nn === '' || !preg_match('/^[A-Za-z0-9._-]{3,50}$/', $bn) || !filter_var($em, FILTER_VALIDATE_EMAIL)) {
        throw new ApiFehler(t('Bitte Vorname, Nachname, gültigen Benutzernamen und E-Mail-Adresse angeben.'));
    }
    if (($s = passwort_ist_zu_schwach($pw)) !== null) {
        throw new ApiFehler($s);
    }
    try {
        $id = db_einfuegen("INSERT INTO users (vorname, nachname, benutzername, email, passwort_hash, rolle, status, aktiviert_am, gueltigkeit_monate, gueltig_bis, muss_passwort_aendern)
            VALUES (:v, :n, :b, :e, :p, :r, 'aktiv', NOW(), :m, " . ($m > 0 ? '(NOW() + INTERVAL ' . $m . ' MONTH)' : 'NULL') . ', 1)', [
            'v' => mb_substr($vn, 0, 100), 'n' => mb_substr($nn, 0, 100), 'b' => $bn, 'e' => $em, 'p' => passwort_hashen($pw),
            'r' => api_wert('rolle') === 'admin' ? 'admin' : 'user', 'm' => $m ?: null,
        ]);
    } catch (PDOException $e) {
        throw new ApiFehler($e->getCode() === '23000' ? t('Benutzername oder E-Mail-Adresse ist bereits vergeben.') : t('Anlegen fehlgeschlagen.'));
    }
    log_sicherheitsereignis((int) $admin['id'], 'konto_angelegt', '#' . $id);
    return ['ok' => true, 'konto' => konto_objekt(konto_laden($id))];
}

function api_admin_konto_loeschen(array $admin, int $id): array
{
    if ($id === (int) $admin['id']) {
        throw new ApiFehler(t('Das eigene Konto kann nicht gelöscht werden.'));
    }
    $u = konto_laden($id);
    if ($u['rolle'] === 'admin' && (int) db_wert("SELECT COUNT(*) FROM users WHERE rolle = 'admin'") <= 1) {
        throw new ApiFehler(t('Der letzte Admin kann nicht gelöscht werden.'));
    }
    db_tun('DELETE FROM users WHERE id = :id', ['id' => $id]);
    log_sicherheitsereignis((int) $admin['id'], 'konto_geloescht', $u['benutzername']);
    return ['ok' => true];
}

// ---------- Einstellungen ----------

const ADMIN_EINSTELLUNGEN = ['smtp_host', 'smtp_port', 'smtp_verschluesselung', 'smtp_benutzer', 'smtp_passwort', 'smtp_absender', 'smtp_absender_name', 'smtp_tls_pruefen',
    'mail_ablauf_tage', 'scan_auto_stunden', 'kuenstler_standardnamen', 'erkennung_modus', 'auto_metadaten', 'auto_vorschau', 'nachtlauf_stunde', 'sicherung_stunde', 'sicherung_tage', 'sicherung_wochen', 'klang_aktiv', 'musicbrainz_user_agent', 'fanart_api_key', 'acoustid_api_key', 'claude_api_key', 'lidarr_url', 'lidarr_api_key',
    'prowlarr_url', 'prowlarr_api_key', 'prowlarr_kategorien', 'sabnzbd_url', 'sabnzbd_api_key', 'sabnzbd_kategorie', 'download_ziel', 'download_nach_import', 'download_einsortieren', 'download_wav_flac',
    'download_haengt_min', 'download_weg_min', 'download_reiter', 'usenet_aktiv', 'musik_schreiben', 'update_hinweis'];

function api_admin_einstellungen(): array
{
    require_once __DIR__ . '/downloads.php';
    return ['einstellungen' => einstellungen_fuer_oberflaeche(ADMIN_EINSTELLUNGEN), 'secret_key' => empty(konfig()['app_secret_key_fluechtig']) && konfig()['app_secret_key'] !== '',
        'downloads_bereit' => dl_prowlarr_bereit() && dl_sab_bereit()];
}

function api_admin_einstellungen_speichern(array $admin): array
{
    $werte = api_wert('einstellungen', []);
    if (!is_array($werte)) {
        throw new ApiFehler(t('Ungültige Angaben.'));
    }
    foreach ($werte as $k => $w) {
        if (!in_array($k, ADMIN_EINSTELLUNGEN, true)) {
            continue;
        }
        $def = einstellung_def($k);
        if ($w === null) {
            einstellung_loeschen($k); // zurück auf .env / Standard
            continue;
        }
        $w = trim((string) $w);
        if ($def['geheim'] && $w === '') {
            continue; // leeres Geheimfeld = unverändert lassen
        }
        if ($k === 'smtp_port' && ($w !== '' && ((int) $w < 1 || (int) $w > 65535))) {
            throw new ApiFehler(t('Ungültiger Port.'));
        }
        if ($k === 'smtp_verschluesselung' && !in_array($w, ['tls', 'ssl', 'keine'], true)) {
            throw new ApiFehler(t('Ungültige Verschlüsselung.'));
        }
        if ($k === 'smtp_absender' && $w !== '' && !filter_var($w, FILTER_VALIDATE_EMAIL)) {
            throw new ApiFehler(t('Bitte eine gültige Absender-Adresse angeben.'));
        }
        if (in_array($k, ['prowlarr_url', 'sabnzbd_url'], true) && $w !== '' && !preg_match('#^https?://#', $w)) {
            throw new ApiFehler(t('Die Adresse muss mit http:// oder https:// beginnen.'));
        }
        if ($k === 'prowlarr_kategorien' && $w !== '' && !preg_match('/^\d+(\s*,\s*\d+)*$/', $w)) {
            throw new ApiFehler(t('Kategorien als Zahlen mit Komma, z. B. 3000 oder 3010,3040.'));
        }
        if ($k === 'sabnzbd_kategorie' && !preg_match('/^[\w .-]{1,60}$/u', $w)) {
            throw new ApiFehler(t('Ungültige SABnzbd-Kategorie.'));
        }
        if ($k === 'download_ziel' && ($w === '' || str_contains($w, '..') || str_starts_with($w, '/') || mb_strtolower($w) === 'neu' || str_starts_with($w, '.'))) {
            throw new ApiFehler(t('Zielordner: ein Unterordner im Musikordner, z. B. „Downloads“ (nicht „neu“, kein „..“).'));
        }
        if (in_array($k, ['download_haengt_min', 'download_weg_min'], true) && (!preg_match('/^\d+$/', $w) || (int) $w < 5 || (int) $w > 1440)) {
            throw new ApiFehler(t('Wartezeit in Minuten, 5 bis 1440.'));
        }
        if (in_array($k, ['download_einsortieren', 'download_wav_flac', 'download_reiter', 'usenet_aktiv', 'musik_schreiben', 'update_hinweis'], true) && !in_array($w, ['0', '1'], true)) {
            throw new ApiFehler(t('Ungültiger Wert für „einsortieren“.'));
        }
        if ($k === 'download_nach_import' && !in_array($w, ['behalten', 'loeschen'], true)) {
            throw new ApiFehler(t('Ungültiger Wert für „nach dem Import“.'));
        }
        if ($k === 'lidarr_url' && $w !== '' && !preg_match('#^https?://#', $w)) {
            throw new ApiFehler(t('Die Lidarr-Adresse muss mit http:// oder https:// beginnen.'));
        }
        if (in_array($k, ['auto_metadaten', 'auto_vorschau', 'klang_aktiv'], true) && !in_array($w, ['0', '1'], true)) {
            throw new ApiFehler(t('Ungültiger Wert für {name}.', ['name' => $k]));
        }
        if ($k === 'erkennung_modus' && !in_array($w, ['anhalt', 'gruendlich'], true)) {
            throw new ApiFehler(t('Erkennung: „anhalt“ oder „gruendlich“.'));
        }
        if ($k === 'nachtlauf_stunde' && (!preg_match('/^-?\d+$/', $w) || (int) $w < -1 || (int) $w > 23)) {
            throw new ApiFehler(t('Nachtlauf: Stunde 0–23 oder −1 für aus.'));
        }
        if ($k === 'sicherung_stunde' && (!preg_match('/^-?\d+$/', $w) || (int) $w < -1 || (int) $w > 23)) {
            throw new ApiFehler(t('Datensicherung: Stunde 0–23 oder −1 für aus.'));
        }
        if ($k === 'sicherung_tage' && (!ctype_digit($w) || (int) $w < 1 || (int) $w > 365)) {
            throw new ApiFehler(t('Tägliche Sicherungen aufbewahren: 1 bis 365.'));
        }
        if ($k === 'sicherung_wochen' && (!ctype_digit($w) || (int) $w > 104)) {
            throw new ApiFehler(t('Wöchentliche Sicherungen aufbewahren: 0 bis 104.'));
        }
        if ($k === 'scan_auto_stunden' && ((int) $w < 0 || (int) $w > 720)) {
            throw new ApiFehler(t('Automatischer Scan: 0 bis 720 Stunden.'));
        }
        if ($def['geheim'] && (konfig()['app_secret_key'] === '' || !empty(konfig()['app_secret_key_fluechtig']))) {
            throw new ApiFehler(t('Zum Speichern von Passwörtern und Schlüsseln braucht Amberwave einen festen Schlüssel: Der App-Daten-Ordner ist nicht beschreibbar – bitte die Rechte prüfen oder APP_SECRET_KEY in der .env setzen.'));
        }
        einstellung_setzen($k, $w);
    }
    log_sicherheitsereignis((int) $admin['id'], 'einstellungen_geaendert', implode(',', array_keys($werte)));
    return api_admin_einstellungen();
}

function api_admin_mailtest(array $admin): array
{
    $an = trim((string) api_wert('an', $admin['email']));
    if (!filter_var($an, FILTER_VALIDATE_EMAIL)) {
        throw new ApiFehler(t('Bitte eine gültige Empfänger-Adresse angeben.'));
    }
    if (!rate_erlaubt('mailtest', (string) $admin['id'], 10, 3600)) {
        throw new ApiFehler(t('Zu viele Testmails. Bitte später erneut versuchen.'), 429);
    }
    $v = mail_vorlage('test', []);
    $r = smtp_senden(mail_konfig(), $an, $v[0], $v[1]);
    return ['ok' => $r['ok'], 'fehler' => $r['fehler'], 'schritte' => $r['schritte']];
}

function api_admin_sicherheitslog(): array
{
    return ['eintraege' => array_map(static fn($z) => [
        'zeit' => iso($z['zeitstempel']), 'ereignis' => $z['ereignis'], 'details' => $z['details'], 'ip' => $z['ip_adresse'],
        'nutzer' => $z['benutzername'],
    ], db_alle('SELECT l.*, u.benutzername FROM sicherheits_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 300'))];
}

function api_admin_album_edition(array $admin, int $albumId): array
{
    if (($einzeln = api_wert('einzeln')) !== null) {
        db_tun('UPDATE alben SET editionen_einzeln = :e WHERE id = :a', ['e' => $einzeln ? 1 : 0, 'a' => $albumId]);
    }
    $ed = api_wert('edition_id');
    if ($ed === null || $ed === '' || (int) $ed === 0) {
        db_tun('UPDATE alben SET edition_wahl_id = NULL WHERE id = :a', ['a' => $albumId]);
    } else {
        if (!db_wert('SELECT id FROM editionen WHERE id = :e AND album_id = :a', ['e' => (int) $ed, 'a' => $albumId])) {
            throw new ApiFehler(t('Diese Edition gehört nicht zum Album.'));
        }
        db_tun('UPDATE alben SET edition_wahl_id = :e WHERE id = :a', ['e' => (int) $ed, 'a' => $albumId]);
    }
    album_anzeige_aktualisieren($albumId);
    return ['ok' => true, 'anzeige_edition_id' => (int) db_wert('SELECT anzeige_edition_id FROM alben WHERE id = :a', ['a' => $albumId])];
}

function api_admin_dateien_probleme(): array
{
    return [
        'fehler' => db_alle("SELECT id, pfad, fehler, format FROM dateien WHERE fehler <> '' ORDER BY pfad LIMIT 500"),
        'ohne_track' => db_alle("SELECT id, pfad, format FROM dateien WHERE track_id IS NULL AND fehler = '' ORDER BY pfad LIMIT 500"),
        // Dateien, die nur in einer nicht angezeigten Edition stecken – die Familie sieht sie nicht
        'versteckt' => array_map(static fn($z) => ['album_id' => (int) $z['album_id'], 'album' => $z['album'], 'edition' => $z['edition'], 'ordner' => $z['ordner'], 'dateien' => (int) $z['dateien']],
            db_alle("SELECT a.id AS album_id, a.titel AS album, e.titel AS edition, e.ordner, e.anzahl_dateien AS dateien
                FROM editionen e JOIN alben a ON a.id = e.album_id WHERE e.id <> a.anzeige_edition_id AND e.anzahl_dateien > 0 ORDER BY a.titel LIMIT 500")),
        'ohne_cover' => array_map(static fn($z) => ['album_id' => (int) $z['id'], 'titel' => $z['titel'], 'ordner' => $z['ordner']],
            db_alle("SELECT a.id, a.titel, e.ordner FROM alben a JOIN editionen e ON e.id = a.anzeige_edition_id WHERE e.cover_datei = '' ORDER BY a.titel LIMIT 500")),
    ];
}

// ---------- Datensicherung ----------

/** Anzeigename der Sicherungsart in der Sprache der Anfrage (SICHERUNG_ARTEN ist eine Konstante und kann kein t()) */
function sicherung_art_text(string $art): string
{
    return match ($art) {
        'taeglich' => t('Täglich'),
        'hand' => t('Von Hand'),
        'vor-wiederherstellung' => t('Vor Wiederherstellung'),
        'update' => t('Vor Update'),
        default => SICHERUNG_ARTEN[$art] ?? $art,
    };
}

function api_admin_sicherungen(): array
{
    $liste = sicherung_liste();
    $behalten = sicherung_behalten($liste, (int) einstellung('sicherung_tage'), (int) einstellung('sicherung_wochen'));
    return [
        'liste' => array_map(static fn($s) => ['name' => $s['name'], 'art' => $s['art'], 'art_text' => sicherung_art_text((string) $s['art']),
            'woche' => ($behalten[$s['name']] ?? null) === 'woche', 'zeit' => date('c', $s['zeit']), 'groesse' => $s['groesse']], $liste),
        'stunde' => (int) einstellung('sicherung_stunde'), 'tage' => (int) einstellung('sicherung_tage'), 'wochen' => (int) einstellung('sicherung_wochen'),
        'ordner' => konfig()['pfade']['backups'] . '/datenbank', 'meldung' => (string) einstellung('sicherung_meldung'),
        'laeuft' => sicherung_wiederherstellung_laeuft(),
    ];
}

function api_admin_sicherung_jetzt(array $admin): array
{
    if (!rate_erlaubt('sicherung', (string) $admin['id'], 10, 3600)) {
        throw new ApiFehler(t('Zu viele Sicherungen in kurzer Zeit. Bitte später erneut versuchen.'), 429);
    }
    set_time_limit(0);
    ignore_user_abort(true);
    try {
        $r = sicherung_erstellen('hand');
    } catch (Throwable $e) {
        throw new ApiFehler(t('Sicherung fehlgeschlagen: {fehler}', ['fehler' => $e->getMessage()]), 500);
    }
    log_sicherheitsereignis((int) $admin['id'], 'sicherung_erstellt', $r['name']);
    return api_admin_sicherungen() + ['neu' => $r['name']];
}

function api_admin_sicherung_loeschen(array $admin): array
{
    $s = sicherung_finden((string) ($_GET['name'] ?? ''));
    if (!$s || $s['art'] === 'update') {
        throw new ApiFehler(t('Diese Sicherung kann hier nicht gelöscht werden.'), 404);
    }
    @unlink($s['pfad']);
    log_sicherheitsereignis((int) $admin['id'], 'sicherung_geloescht', $s['name']);
    return api_admin_sicherungen();
}

function api_admin_sicherung_datei(): never
{
    $s = sicherung_finden((string) ($_GET['name'] ?? ''));
    if (!$s) {
        throw new ApiFehler(t('Sicherung nicht gefunden.'), 404);
    }
    header('Content-Type: application/gzip');
    header('Content-Length: ' . $s['groesse']);
    header('Content-Disposition: attachment; filename="amberwave_' . basename($s['name']) . '"');
    header('Cache-Control: no-store');
    readfile($s['pfad']);
    exit;
}

/** Umzugspaket erstellen (Passwort des Admins zur Bestätigung, eigenes Paket-Passwort) */
function api_admin_umzug(array $admin): array
{
    require_once __DIR__ . '/einrichtung.php';
    require_once __DIR__ . '/umzug.php';
    datenbank_admin_bestaetigen($admin);
    $pw = (string) api_wert('paket_passwort', '');
    if (mb_strlen($pw) < 8) {
        throw new ApiFehler(t('Bitte ein Passwort mit mindestens 8 Zeichen wählen.'));
    }
    set_time_limit(0);
    ignore_user_abort(true);
    try {
        $p = umzug_erstellen($pw, (bool) api_wert('bilder', false));
    } catch (Throwable $e) {
        throw new ApiFehler(t('Umzugspaket fehlgeschlagen: {fehler}', ['fehler' => $e->getMessage()]), 500);
    }
    log_sicherheitsereignis((int) $admin['id'], 'umzug_erstellt', basename($p));
    return ['name' => basename($p), 'groesse' => (int) filesize($p)];
}

function api_admin_umzug_datei(): never
{
    require_once __DIR__ . '/umzug.php';
    $name = basename((string) ($_GET['name'] ?? ''));
    $p = umzug_tmp() . '/' . $name;
    if (!preg_match('/^amberwave-umzug_[0-9A-Za-z_-]+\.awumzug$/', $name) || !is_file($p)) {
        throw new ApiFehler(t('Umzugspaket nicht gefunden – bitte neu erstellen.'), 404);
    }
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . filesize($p));
    header('Content-Disposition: attachment; filename="' . $name . '"');
    header('Cache-Control: no-store');
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    readfile($p);
    exit;
}

function api_admin_sicherung_wiederherstellen(array $admin): array
{
    $name = (string) api_wert('name', '');
    // Bestätigungswort: die Oberfläche zeigt je nach Sprache WIEDERHERSTELLEN oder RESTORE – beides gilt
    if (!in_array(trim((string) api_wert('bestaetigung', '')), ['WIEDERHERSTELLEN', 'RESTORE'], true)) {
        throw new ApiFehler(t('Bitte zur Bestätigung WIEDERHERSTELLEN eintippen.'));
    }
    require_once __DIR__ . '/einrichtung.php';
    datenbank_admin_bestaetigen($admin);
    set_time_limit(0);
    ignore_user_abort(true); // einmal begonnen, läuft es zu Ende – auch wenn der Browser die Verbindung trennt
    $log = [];
    $ok = sicherung_wiederherstellen($name, $log);
    try {
        log_sicherheitsereignis((int) $admin['id'], $ok ? 'sicherung_wiederhergestellt' : 'wiederherstellung_fehlgeschlagen', $name . ' | ' . implode(' | ', $log));
    } catch (Throwable) {
        // das Konto gibt es im zurückgespielten Stand evtl. nicht – Protokoll ist dann zweitrangig
    }
    return ['ok' => $ok, 'log' => $log];
}

function api_admin_update(array $admin): array
{
    if (getenv('AMBERWAVE_IMAGE') === '1') {
        throw new ApiFehler(t('Diese Installation läuft als fertiges Docker-Image – ein Zip-Update ginge beim nächsten Neustart verloren. Update auf dem Server: docker compose pull && docker compose up -d'));
    }
    if (empty($_FILES['archiv']['tmp_name']) || ($_FILES['archiv']['error'] ?? 1) !== UPLOAD_ERR_OK) {
        throw new ApiFehler(t('Bitte ein gültiges .zip-Archiv auswählen (max. {max}).', ['max' => ini_get('upload_max_filesize')]));
    }
    if (!str_ends_with(strtolower((string) $_FILES['archiv']['name']), '.zip')) {
        throw new ApiFehler(t('Nur .zip-Archive werden akzeptiert.'));
    }
    // Ein Update tauscht Programmcode aus – nur mit dem Passwort des Admins (eine offene Sitzung allein reicht nicht)
    require_once __DIR__ . '/einrichtung.php';
    datenbank_admin_bestaetigen($admin);
    set_time_limit(600);
    $log = [];
    $r = update_einspielen((string) $_FILES['archiv']['tmp_name'], $log);
    log_sicherheitsereignis((int) $admin['id'], $r ? 'update_durchgefuehrt' : 'update_fehlgeschlagen', implode(' | ', $log));
    return ['ok' => $r, 'log' => $log];
}


/** Unbestätigter Reverse Proxy für die Übersicht (null = nichts zu entscheiden) */
function api_admin_proxy_offen(): ?array
{
    if (konfig()['sicherheit']['proxy_vertrauen'] !== 'auto' || vertraute_proxys() || proxy_entscheidung() !== '') {
        return null;
    }
    $b = json_decode((string) @file_get_contents(proxy_beobachtung_datei()), true);
    if (!is_array($b) || empty($b['ip']) || time() - (int) ($b['zeit'] ?? 0) > 14 * 86400 || ist_bekannter_proxy((string) $b['ip'])) {
        return null;
    }
    return ['ip' => (string) $b['ip'], 'gateway' => docker_gateway_ip() === $b['ip'], 'cf' => !empty($b['cf'])];
}

/** POST /admin/proxy {aktion: vertrauen|ablehnen|zuruecksetzen, ip} */
function api_admin_proxy(): array
{
    require_once __DIR__ . '/einstellungen.php';
    $aktion = (string) api_wert('aktion', '');
    if ($aktion === 'vertrauen') {
        $ip = trim((string) api_wert('ip', ''));
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 | FILTER_FLAG_IPV6) || filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false) {
            throw new ApiFehler(t('Bitte eine private IP-Adresse angeben.'));
        }
        $liste = array_values(array_filter(array_map('trim', explode(',', einstellung('tunnel_proxy_ip')))));
        if (!in_array($ip, $liste, true)) {
            $liste[] = $ip;
        }
        einstellung_setzen('tunnel_proxy_ip', implode(',', $liste));
        einstellung_loeschen('proxy_entscheidung');
    } elseif ($aktion === 'ablehnen') {
        einstellung_setzen('proxy_entscheidung', 'nein');
    } elseif ($aktion === 'zuruecksetzen') {
        einstellung_loeschen('proxy_entscheidung');
        einstellung_loeschen('tunnel_proxy_ip');
        @unlink(proxy_beobachtung_datei());
    } else {
        throw new ApiFehler(t('Unbekannte Aktion.'));
    }
    return ['ok' => true];
}
