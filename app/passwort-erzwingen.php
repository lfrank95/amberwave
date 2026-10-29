<?php
declare(strict_types=1);
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/seiten.php';

$user = benoetige_login_seite(true);
if (empty($user['muss_passwort_aendern'])) {
    header('Location: /');
    exit;
}
$fehler = null;
$ist_werks_admin = $user['rolle'] === 'admin' && $user['benutzername'] === 'admin' && $user['email'] === 'admin@localhost';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $pw = (string) ($_POST['passwort'] ?? '');
    $email = trim((string) ($_POST['email'] ?? ''));
    if (!csrf_pruefen()) {
        $fehler = t('Sicherheitsprüfung fehlgeschlagen. Bitte die Seite neu laden.');
    } elseif ($pw !== (string) ($_POST['passwort_wiederholen'] ?? '')) {
        $fehler = t('Die Passwörter stimmen nicht überein.');
    } elseif (($schwach = passwort_ist_zu_schwach($pw)) !== null) {
        $fehler = $schwach;
    } elseif (password_verify($pw, (string) $user['passwort_hash'])) {
        $fehler = t('Bitte ein anderes Passwort als das bisherige wählen.');
    } elseif ($ist_werks_admin && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $fehler = t('Bitte eine gültige E-Mail-Adresse für Benachrichtigungen angeben.');
    } else {
        db_tun('UPDATE users SET passwort_hash = :p, muss_passwort_aendern = 0 WHERE id = :id', ['p' => passwort_hashen($pw), 'id' => $user['id']]);
        if ($ist_werks_admin) {
            try {
                db_tun('UPDATE users SET email = :e WHERE id = :id', ['e' => $email, 'id' => $user['id']]);
            } catch (PDOException $e) {
                // Adresse schon vergeben – Passwort ist trotzdem geändert
            }
        }
        log_sicherheitsereignis((int) $user['id'], 'passwort_geaendert', 'Pflichtwechsel');
        header('Location: /');
        exit;
    }
}

seite_kopf(t('Passwort festlegen'));
?>
<h1><?= h(t('Eigenes Passwort festlegen')) ?></h1>
<p class="hinweis"><?= h(t('Bevor es losgeht, lege bitte ein eigenes Passwort fest.')) ?></p>
<?= meldung($fehler) ?>
<form method="post" class="formular">
    <?= csrf_feld() ?>
    <?php if ($ist_werks_admin): ?>
    <label for="f-em"><?= h(t('Deine E-Mail-Adresse')) ?> <small>(<?= h(t('für Benachrichtigungen, z. B. neue Registrierungen')) ?>)</small></label>
    <input id="f-em" type="email" name="email" required autocomplete="email">
    <?php endif; ?>
    <label for="f-pw"><?= h(t('Neues Passwort')) ?> <small>(<?= h(t('mind. {n} Zeichen', ['n' => (int) konfig()['sicherheit']['passwort_min_laenge']])) ?>)</small></label>
    <input id="f-pw" type="password" name="passwort" required autocomplete="new-password" autofocus>
    <label for="f-pw2"><?= h(t('Wiederholen')) ?></label>
    <input id="f-pw2" type="password" name="passwort_wiederholen" required autocomplete="new-password">
    <button type="submit" class="btn btn-voll"><?= h(t('Speichern und weiter')) ?></button>
</form>
<p class="seite-links"><a href="/logout.php"><?= h(t('Abmelden')) ?></a></p>
<?php seite_fuss();
