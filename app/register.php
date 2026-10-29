<?php
declare(strict_types=1);
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/seiten.php';
require_once __DIR__ . '/includes/mail_texte.php';
starte_sichere_session();

$modus = konfig()['sicherheit']['registrierung_modus'];
$fehler = null;
$erfolg = null;
$w = ['vorname' => '', 'nachname' => '', 'benutzername' => '', 'email' => ''];
$fertig_text = t('Danke! Deine Registrierung ist eingegangen. Sobald der Administrator dein Konto freischaltet, bekommst du eine E-Mail.');

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    foreach ($w as $k => $_) {
        $w[$k] = trim((string) ($_POST[$k] ?? ''));
    }
    $pw = (string) ($_POST['passwort'] ?? '');
    $pw2 = (string) ($_POST['passwort_wiederholen'] ?? '');
    $ip = client_ip();
    if ($modus === 'aus') {
        $fehler = t('Die Registrierung ist derzeit geschlossen.');
    } elseif (!csrf_pruefen()) {
        $fehler = t('Sicherheitsprüfung fehlgeschlagen. Bitte die Seite neu laden.');
    } elseif (!empty($_POST['website'] ?? '')) {
        $erfolg = $fertig_text; // Honeypot: Bots bekommen dieselbe Antwort, gespeichert wird nichts
    } elseif (!registrierung_erlaubt($ip)) {
        $fehler = t('Zu viele Registrierungen von dieser Adresse. Bitte später erneut versuchen.');
    } elseif (in_array('', $w, true) || $pw === '') {
        $fehler = t('Bitte alle Felder ausfüllen.');
    } elseif (!preg_match('/^[A-Za-z0-9._-]{3,50}$/', $w['benutzername'])) {
        $fehler = t('Der Benutzername darf 3–50 Zeichen lang sein und nur Buchstaben, Ziffern sowie . _ - enthalten.');
    } elseif (!filter_var($w['email'], FILTER_VALIDATE_EMAIL)) {
        $fehler = t('Bitte eine gültige E-Mail-Adresse angeben.');
    } elseif ($pw !== $pw2) {
        $fehler = t('Die Passwörter stimmen nicht überein.');
    } elseif (($schwach = passwort_ist_zu_schwach($pw)) !== null) {
        $fehler = $schwach;
    } else {
        registrierungsversuch_protokollieren($ip);
        try {
            db_tun("INSERT INTO users (vorname, nachname, benutzername, email, passwort_hash, rolle, status) VALUES (:v, :n, :b, :e, :p, 'user', 'pending')",
                ['v' => mb_substr($w['vorname'], 0, 100), 'n' => mb_substr($w['nachname'], 0, 100), 'b' => $w['benutzername'], 'e' => mb_substr($w['email'], 0, 255), 'p' => passwort_hashen($pw)]);
            log_sicherheitsereignis(null, 'registrierung', 'Benutzername: ' . $w['benutzername']);
            try {
                mail_ereignis('registrierung_neu', mail_admins(), [
                    'nutzer_name' => $w['vorname'] . ' ' . $w['nachname'], 'nutzer_benutzername' => $w['benutzername'],
                    'nutzer_email' => $w['email'], 'link' => app_link('/verwaltung/konten'),
                ]);
            } catch (Throwable $e) {
                error_log('Mail Registrierung: ' . $e->getMessage());
            }
            $erfolg = $fertig_text;
        } catch (PDOException $e) {
            // Keine Auskunft, ob Name/E-Mail schon existieren (sonst lassen sich Konten erraten)
            if ($e->getCode() === '23000') {
                $erfolg = $fertig_text;
            } else {
                error_log('Registrierung: ' . $e->getMessage());
                $fehler = t('Registrierung fehlgeschlagen. Bitte später erneut versuchen.');
            }
        }
    }
}

seite_kopf(t('Registrieren'));
?>
<h1><?= h(t('Konto registrieren')) ?></h1>
<?= meldung($fehler) ?>
<?php if ($erfolg): ?>
    <?= meldung($erfolg, 'erfolg') ?>
    <p class="seite-links"><a href="/login.php"><?= h(t('Zurück zur Anmeldung')) ?></a></p>
<?php elseif ($modus === 'aus'): ?>
    <p class="hinweis"><?= h(t('Die Registrierung ist derzeit geschlossen.')) ?></p>
<?php else: ?>
<form method="post" class="formular" autocomplete="off">
    <?= csrf_feld() ?>
    <div class="form-zeilen">
        <div><label for="f-vn"><?= h(t('Vorname')) ?></label><input id="f-vn" type="text" name="vorname" value="<?= h($w['vorname']) ?>" required maxlength="100" autocomplete="given-name"></div>
        <div><label for="f-nn"><?= h(t('Nachname')) ?></label><input id="f-nn" type="text" name="nachname" value="<?= h($w['nachname']) ?>" required maxlength="100" autocomplete="family-name"></div>
    </div>
    <label for="f-bn"><?= h(t('Benutzername')) ?></label>
    <input id="f-bn" type="text" name="benutzername" value="<?= h($w['benutzername']) ?>" required maxlength="50" pattern="[A-Za-z0-9._\-]{3,50}" autocapitalize="none" spellcheck="false" autocomplete="username">
    <label for="f-em"><?= h(t('E-Mail-Adresse')) ?></label>
    <input id="f-em" type="email" name="email" value="<?= h($w['email']) ?>" required maxlength="255" autocomplete="email">
    <label for="f-pw"><?= h(t('Passwort')) ?> <small>(<?= h(t('mind. {n} Zeichen', ['n' => (int) konfig()['sicherheit']['passwort_min_laenge']])) ?>)</small></label>
    <input id="f-pw" type="password" name="passwort" required autocomplete="new-password">
    <label for="f-pw2"><?= h(t('Passwort wiederholen')) ?></label>
    <input id="f-pw2" type="password" name="passwort_wiederholen" required autocomplete="new-password">
    <div class="honig" aria-hidden="true"><label>Website</label><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
    <button type="submit" class="btn btn-voll"><?= h(t('Registrieren')) ?></button>
</form>
<p class="seite-links"><a href="/login.php"><?= h(t('Schon ein Konto? Anmelden')) ?></a></p>
<?php endif; ?>
<?php seite_fuss();
