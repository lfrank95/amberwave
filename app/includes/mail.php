<?php
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/einstellungen.php';

/**
 * Schlanker SMTP-Client ohne Fremdpakete (Sockets).
 * Zugangsdaten: Admin-Oberfläche (verschlüsselt in einstellungen) → .env (SMTP_*). Übernommen aus einem früheren Projekt.
 * Sicherheit: TLS-Zertifikate werden geprüft, STARTTLS wird erzwungen (kein stilles Downgrade),
 * Zugangsdaten gehen nie unverschlüsselt über öffentliche Netze, Header-Injection ist ausgeschlossen.
 */

function mail_konfig(): array
{
    $c = [
        'host' => trim(einstellung('smtp_host')),
        'port' => (int) einstellung('smtp_port'),
        'krypto' => einstellung('smtp_verschluesselung'),
        'benutzer' => einstellung('smtp_benutzer'),
        'passwort' => einstellung('smtp_passwort'),
        'absender' => trim(einstellung('smtp_absender')),
        'absender_name' => trim(einstellung('smtp_absender_name')),
        'tls_pruefen' => einstellung('smtp_tls_pruefen') !== '0',
    ];
    if (!in_array($c['krypto'], ['tls', 'ssl', 'keine'], true)) $c['krypto'] = 'tls';
    if ($c['port'] < 1 || $c['port'] > 65535) $c['port'] = $c['krypto'] === 'ssl' ? 465 : 587;
    return $c;
}

function mail_konfiguriert(?array $c = null): bool
{
    $c ??= mail_konfig();
    return $c['host'] !== '' && filter_var($c['absender'], FILTER_VALIDATE_EMAIL) !== false;
}

function mail_host_gueltig(string $host): bool
{
    return strlen($host) <= 253 && (bool) preg_match('/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/', $host)
        || filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) !== false;
}

/** Interner Relay (Docker-Name ohne Punkt, localhost oder private IP)? */
function mail_host_intern(string $host): bool
{
    $h = trim($host, '[]');
    if (filter_var($h, FILTER_VALIDATE_IP)) {
        return filter_var($h, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
    }
    return !str_contains($h, '.') || strtolower($h) === 'localhost';
}

function mail_kopf_sauber(string $s): string
{
    return trim(preg_replace('/[\r\n\0]+/', ' ', $s) ?? '');
}

function mail_kopf_kodieren(string $s): string
{
    $s = mail_kopf_sauber($s);
    return preg_match('/^[\x20-\x7E]*$/', $s) ? $s : '=?UTF-8?B?' . base64_encode($s) . '?=';
}

/** Zugangsdaten und Serverantworten nie in Meldungen durchreichen. */
function mail_meldung_bereinigen(string $m, array $c): string
{
    foreach ([$c['passwort'] ?? '', base64_encode((string) ($c['passwort'] ?? '')), base64_encode((string) ($c['benutzer'] ?? ''))] as $g) {
        if ($g !== '') $m = str_replace($g, '***', $m);
    }
    return mb_substr(preg_replace('/\s+/', ' ', $m) ?? '', 0, 300);
}

/**
 * Sendet eine Textmail. Rückgabe: ['ok' => bool, 'fehler' => string, 'schritte' => string[]]
 */
function smtp_senden(array $c, string $an, string $betreff, string $text): array
{
    $schritte = [];
    $fehler = static fn(string $m) => ['ok' => false, 'fehler' => mail_meldung_bereinigen($m, $c), 'schritte' => $schritte];

    if (!mail_konfiguriert($c)) return $fehler(t('E-Mail ist nicht eingerichtet (Server oder Absender fehlt).'));
    if (!mail_host_gueltig($c['host'])) return $fehler(t('Der Servername ist ungültig.'));
    if (!filter_var($an, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $an)) return $fehler(t('Ungültige Empfänger-Adresse.'));
    $hat_login = $c['benutzer'] !== '';
    if ($c['krypto'] === 'keine' && $hat_login && !mail_host_intern($c['host'])) {
        return $fehler(t('Ohne Verschlüsselung werden keine Zugangsdaten an öffentliche Server gesendet. Bitte SSL oder STARTTLS wählen.'));
    }

    $ctx = stream_context_create(['ssl' => [
        'verify_peer' => $c['tls_pruefen'], 'verify_peer_name' => $c['tls_pruefen'],
        'peer_name' => $c['host'], 'SNI_enabled' => true, 'allow_self_signed' => !$c['tls_pruefen'],
        'crypto_method' => STREAM_CRYPTO_METHOD_TLS_CLIENT,
    ]]);
    $ziel = ($c['krypto'] === 'ssl' ? 'ssl://' : 'tcp://') . $c['host'] . ':' . $c['port'];
    $socket = @stream_socket_client($ziel, $errno, $errstr, 8, STREAM_CLIENT_CONNECT, $ctx);
    if (!$socket) return $fehler(t('Verbindung zu {ziel} fehlgeschlagen ({grund}). Port, Verschlüsselung, Firewall und Zertifikat prüfen.', ['ziel' => $c['host'] . ':' . $c['port'], 'grund' => $errstr !== '' ? $errstr : t('TLS-Aufbau oder Zertifikat')]));
    stream_set_timeout($socket, 12);
    $schritte[] = t('Verbunden mit {ziel}', ['ziel' => $c['host'] . ':' . $c['port']]);

    $lesen = static function () use ($socket): array {
        $text = ''; $code = 0;
        for ($i = 0; $i < 50; $i++) {
            $zeile = fgets($socket, 1024);
            if ($zeile === false) break;
            $text .= rtrim($zeile) . "\n";
            $code = (int) substr($zeile, 0, 3);
            if (strlen($zeile) < 4 || $zeile[3] !== '-') break;
        }
        return [$code, trim($text)];
    };
    $senden = static function (string $cmd) use ($socket): void { fwrite($socket, $cmd . "\r\n"); };
    $schluss = function (array $r) use ($socket, &$schritte, $c) {
        @fwrite($socket, "QUIT\r\n"); @fclose($socket);
        return ['ok' => false, 'fehler' => mail_meldung_bereinigen($r[0] === 0 ? $r[1] : t('Server antwortet: {antwort}', ['antwort' => $r[0] . ' ' . $r[1]]), $c), 'schritte' => $schritte];
    };

    $r = $lesen();
    if ($r[0] !== 220) return $schluss($r);
    $senden('EHLO ' . (preg_replace('/[^A-Za-z0-9.-]/', '', (string) parse_url('http://' . ($_SERVER['HTTP_HOST'] ?? 'amberwave.local'), PHP_URL_HOST)) ?: 'amberwave.local'));
    $r = $lesen();
    if ($r[0] !== 250) return $schluss($r);

    if ($c['krypto'] === 'tls') {
        if (!str_contains(strtoupper($r[1]), 'STARTTLS')) { return $schluss([0, t('Der Server bietet kein STARTTLS an – Verschlüsselung "SSL" oder anderen Port versuchen.')]); }
        $senden('STARTTLS');
        $r = $lesen();
        if ($r[0] !== 220) return $schluss($r);
        if (!@stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
            return $schluss([0, t('TLS-Aufbau fehlgeschlagen (Zertifikat ungültig oder Name passt nicht). Für interne Server mit eigenem Zertifikat die Zertifikatsprüfung abschalten.')]);
        }
        $senden('EHLO amberwave.local');
        $r = $lesen();
        if ($r[0] !== 250) return $schluss($r);
    }
    if ($c['krypto'] !== 'keine') {
        $meta = stream_get_meta_data($socket);
        $schritte[] = t('Verschlüsselt ({protokoll})', ['protokoll' => $meta['crypto']['protocol'] ?? 'TLS']);
    } else {
        $schritte[] = t('Unverschlüsselte Verbindung (nur interner Relay)');
    }

    if ($hat_login) {
        $kann_login = (bool) preg_match('/AUTH[ =].*LOGIN/i', $r[1]);
        $kann_plain = (bool) preg_match('/AUTH[ =].*PLAIN/i', $r[1]);
        if ($kann_plain) {
            $senden('AUTH PLAIN ' . base64_encode("\0" . $c['benutzer'] . "\0" . $c['passwort']));
            $a = $lesen();
        } elseif ($kann_login || !str_contains(strtoupper($r[1]), 'AUTH')) {
            $senden('AUTH LOGIN');
            $a = $lesen();
            if ($a[0] === 334) { $senden(base64_encode($c['benutzer'])); $a = $lesen(); }
            if ($a[0] === 334) { $senden(base64_encode($c['passwort'])); $a = $lesen(); }
        } else {
            return $schluss([0, t('Der Server unterstützt weder AUTH PLAIN noch AUTH LOGIN.')]);
        }
        if ($a[0] !== 235) return $schluss([$a[0], t('Anmeldung abgelehnt – Benutzername oder Passwort falsch? ({antwort})', ['antwort' => $a[1]])]);
        $schritte[] = t('Anmeldung erfolgreich');
    }

    $senden('MAIL FROM:<' . $c['absender'] . '>');
    $r = $lesen();
    if ($r[0] !== 250) return $schluss($r);
    $senden('RCPT TO:<' . $an . '>');
    $r = $lesen();
    if (!in_array($r[0], [250, 251], true)) return $schluss($r);
    $senden('DATA');
    $r = $lesen();
    if ($r[0] !== 354) return $schluss($r);

    $domain = substr(strrchr($c['absender'], '@') ?: '@amberwave.local', 1);
    $von_name = mail_kopf_kodieren($c['absender_name']);
    $kopf = 'Date: ' . date('r') . "\r\n"
        . 'From: ' . ($von_name !== '' ? $von_name . ' ' : '') . '<' . $c['absender'] . ">\r\n"
        . 'To: <' . $an . ">\r\n"
        . 'Subject: ' . mail_kopf_kodieren($betreff) . "\r\n"
        . 'Message-ID: <' . bin2hex(random_bytes(12)) . '@' . $domain . ">\r\n"
        . "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n"
        . "Auto-Submitted: auto-generated\r\n\r\n";
    fwrite($socket, $kopf . chunk_split(base64_encode(str_replace(["\r\n", "\r"], "\n", $text)), 76, "\r\n") . ".\r\n");
    $r = $lesen();
    if ($r[0] !== 250) return $schluss($r);
    $schritte[] = t('Mail vom Server angenommen');
    $senden('QUIT');
    @fclose($socket);
    return ['ok' => true, 'fehler' => '', 'schritte' => $schritte];
}

/** Direkter Versand ohne Warteschlange; true bei Erfolg, sonst Eintrag im Server-Log (ohne Geheimnisse). */
function sende_mail_sofort(string $an, string $betreff, string $text): bool
{
    $c = mail_konfig();
    if (!mail_konfiguriert($c)) {
        error_log('SMTP nicht konfiguriert, Mail nicht gesendet: ' . mail_kopf_sauber($betreff));
        return false;
    }
    try {
        $r = smtp_senden($c, $an, $betreff, $text);
    } catch (Throwable $e) {
        error_log('SMTP-Fehler: ' . mail_meldung_bereinigen($e->getMessage(), $c));
        return false;
    }
    if (!$r['ok']) {
        error_log('SMTP-Versand fehlgeschlagen: ' . $r['fehler']);
    }
    return $r['ok'];
}

/** Legt eine Mail in die Warteschlange (Inhalt verschlüsselt). */
function mail_einreihen(string $an, string $betreff, string $text): bool
{
    try {
        db()->prepare('INSERT INTO mail_warteschlange (an, betreff, inhalt) VALUES (:a, :b, :i)')
            ->execute(['a' => mb_substr($an, 0, 255), 'b' => mb_substr(mail_kopf_sauber($betreff), 0, 255), 'i' => verschluessle($text)]);
        return true;
    } catch (Throwable $e) {
        error_log('Mail-Warteschlange: ' . $e->getMessage());
        return false;
    }
}

/** Startet den Versand-Prozess im Hintergrund (einmal pro Anfrage, nach der Antwort). */
function mail_worker_starten(): bool
{
    static $geplant = false;
    if ($geplant) return true;
    $skript = aw_realpath(__DIR__ . '/../scripts/mail-versand.php');
    $php = aw_php();
    $verfuegbar = $skript !== false && function_exists('exec')
        && !in_array('exec', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true);
    if (!$verfuegbar) return false;
    $geplant = true;
    register_shutdown_function(static function () use ($php, $skript): void {
        aw_hintergrund(aw_arg($php) . ' ' . aw_arg($skript));
    });
    return true;
}

/**
 * Bisherige Schnittstelle: reiht die Mail ein, der Versand läuft im Hintergrund (die Seite wartet nicht auf den Mailserver).
 * Ohne Hintergrund-Möglichkeit wird direkt gesendet. true = eingereiht bzw. gesendet.
 */
function sende_mail(string $an, string $betreff, string $text): bool
{
    if (!mail_konfiguriert()) {
        error_log('SMTP nicht konfiguriert, Mail nicht gesendet: ' . mail_kopf_sauber($betreff));
        return false;
    }
    if (mail_einreihen($an, $betreff, $text) && mail_worker_starten()) {
        return true;
    }
    // Kein Hintergrund-Start möglich: Mail direkt senden und wieder aus der Warteschlange nehmen
    $ok = sende_mail_sofort($an, $betreff, $text);
    if ($ok) {
        try { db()->prepare('DELETE FROM mail_warteschlange WHERE an = :a AND betreff = :b ORDER BY id DESC LIMIT 1')->execute(['a' => $an, 'b' => mb_substr(mail_kopf_sauber($betreff), 0, 255)]); } catch (Throwable $e) {}
    }
    return $ok;
}

/** Arbeitet fällige Mails ab (max. $max). Rückgabe: [gesendet, fehlgeschlagen]. Wiederholung nach 5/10/15/20 Minuten, dann als fehlgeschlagen markiert. */
function mail_warteschlange_abarbeiten(int $max = 30): array
{
    $gesendet = 0; $fehler = 0;
    $c = mail_konfig();
    if (!mail_konfiguriert($c)) return [0, 0];
    try {
        db()->exec("DELETE FROM mail_warteschlange WHERE erstellt_am < (NOW() - INTERVAL 7 DAY)");
        $ids = db()->query(
            "SELECT id FROM mail_warteschlange WHERE versuche < 5 AND naechster_versuch <= NOW()
               AND (in_arbeit_seit IS NULL OR in_arbeit_seit < (NOW() - INTERVAL 10 MINUTE)) ORDER BY id LIMIT " . (int) $max
        )->fetchAll(PDO::FETCH_COLUMN);
    } catch (Throwable $e) {
        error_log('Mail-Warteschlange: ' . $e->getMessage());
        return [0, 0];
    }
    foreach ($ids as $id) {
        $claim = db()->prepare("UPDATE mail_warteschlange SET in_arbeit_seit = NOW() WHERE id = :id AND (in_arbeit_seit IS NULL OR in_arbeit_seit < (NOW() - INTERVAL 10 MINUTE))");
        $claim->execute(['id' => $id]);
        if ($claim->rowCount() === 0) continue; // ein anderer Prozess war schneller
        $z = db()->prepare('SELECT * FROM mail_warteschlange WHERE id = :id');
        $z->execute(['id' => $id]);
        $m = $z->fetch();
        if (!$m) continue;
        try {
            $r = smtp_senden($c, (string) $m['an'], (string) $m['betreff'], entschluessle((string) $m['inhalt']));
        } catch (Throwable $e) {
            $r = ['ok' => false, 'fehler' => mail_meldung_bereinigen($e->getMessage(), $c)];
        }
        if ($r['ok']) {
            db()->prepare('DELETE FROM mail_warteschlange WHERE id = :id')->execute(['id' => $id]);
            $gesendet++;
        } else {
            $fehler++;
            $v = (int) $m['versuche'] + 1;
            db()->prepare("UPDATE mail_warteschlange SET versuche = :v, in_arbeit_seit = NULL, letzter_fehler = :f,
                           naechster_versuch = (NOW() + INTERVAL :min MINUTE) WHERE id = :id")
                ->execute(['v' => $v, 'f' => mb_substr($r['fehler'], 0, 300), 'min' => $v * 5, 'id' => $id]);
            error_log('Mail an Nutzer #' . $id . ' fehlgeschlagen (Versuch ' . $v . '): ' . $r['fehler']);
        }
    }
    return [$gesendet, $fehler];
}
