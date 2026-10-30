<?php
declare(strict_types=1);
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/seiten.php';
require_once __DIR__ . '/includes/mail_texte.php';
starte_sichere_session();

$fehler = null;
$erfolg = null;
$antwort = t('Falls ein Konto mit dieser Adresse existiert, ist eine E-Mail mit einem Link zum Zurücksetzen unterwegs.');

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $email = trim((string) ($_POST['email'] ?? ''));
    $s = konfig()['sicherheit'];
    if (!csrf_pruefen()) {
        $fehler = t('Sicherheitsprüfung fehlgeschlagen. Bitte die Seite neu laden.');
    } elseif (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $fehler = t('Bitte eine gültige E-Mail-Adresse angeben.');
    } elseif (!rate_erlaubt('reset_ip', client_ip(), $s['reset_max_pro_ip_stunde'], 3600)) {
        $fehler = t('Zu viele Anfragen. Bitte später erneut versuchen.');
    } else {
        // Antwort ist immer gleich – verrät nicht, ob die Adresse existiert; auch die Dauer nicht (beide Wege mind. 0,6 s)
        $erfolg = $antwort;
        $start = hrtime(true);
        if (rate_erlaubt('reset_mail', mb_strtolower($email), $s['reset_max_pro_mail_stunde'], 3600)) {
            $u = db_zeile("SELECT * FROM users WHERE email = :e AND status = 'aktiv'", ['e' => $email]);
            if ($u) {
                $roh = bin2hex(random_bytes(32));
                $min = (int) $s['reset_gueltig_minuten'];
                db_tun('UPDATE password_reset_tokens SET benutzt = 1 WHERE user_id = :u AND benutzt = 0', ['u' => $u['id']]);
                db_tun('INSERT INTO password_reset_tokens (user_id, token_hash, gueltig_bis) VALUES (:u, :h, (NOW() + INTERVAL ' . $min . ' MINUTE))',
                    ['u' => $u['id'], 'h' => hash('sha256', $roh)]);
                mail_ereignis('passwort_reset', [(string) $u['email']], [
                    'vorname' => $u['vorname'], 'minuten' => $min, 'link' => app_link('/passwort-zuruecksetzen.php?t=' . $roh),
                ]);
                log_sicherheitsereignis((int) $u['id'], 'passwort_reset_angefordert');
            }
        }
        $rest = 600_000 - intdiv(hrtime(true) - $start, 1000) + random_int(0, 80_000);
        if ($rest > 0) {
            usleep($rest);
        }
    }
}

seite_kopf(t('Passwort vergessen'));
?>
<h1><?= h(t('Passwort vergessen')) ?></h1>
<?= meldung($fehler) ?>
<?php if ($erfolg): ?>
    <?= meldung($erfolg, 'erfolg') ?>
<?php else: ?>
<p class="hinweis"><?= h(t('Gib die E-Mail-Adresse deines Kontos an. Du bekommst einen Link, mit dem du ein neues Passwort festlegen kannst.')) ?></p>
<form method="post" class="formular">
    <?= csrf_feld() ?>
    <label for="f-em"><?= h(t('E-Mail-Adresse')) ?></label>
    <input id="f-em" type="email" name="email" required autocomplete="email" autofocus>
    <button type="submit" class="btn btn-voll"><?= h(t('Link anfordern')) ?></button>
</form>
<?php endif; ?>
<p class="seite-links"><a href="/login.php"><?= h(t('Zurück zur Anmeldung')) ?></a></p>
<?php seite_fuss();
