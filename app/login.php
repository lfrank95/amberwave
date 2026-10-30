<?php
declare(strict_types=1);
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/seiten.php';
starte_sichere_session(); // leitet bei einer noch nicht eingerichteten Installation zu /einrichtung.php; sonst Schema-Migrationen

if (($u = eingeloggter_user()) && account_ist_gueltig($u)) {
    header('Location: /');
    exit;
}

$fehler = null;
$grund = (string) ($_GET['grund'] ?? '');
$hinweis = match ($grund) {
    'geraet' => t('Du wurdest auf diesem Gerät abgemeldet, weil dein Konto auf einem weiteren Gerät angemeldet wurde. Bitte neu anmelden.'),
    'abgelaufen' => t('Deine Sitzung ist abgelaufen. Bitte neu anmelden.'),
    'abgemeldet' => null,
    default => null,
};
$name_wert = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $name_wert = trim((string) ($_POST['benutzername'] ?? ''));
    if (!csrf_pruefen()) {
        $fehler = t('Sicherheitsprüfung fehlgeschlagen. Bitte die Seite neu laden.');
    } else {
        $r = anmeldung_pruefen($name_wert, (string) ($_POST['passwort'] ?? ''));
        if (isset($r['user'])) {
            anmelden($r['user'], !empty($_POST['geraet_merken']));
            $ziel = (string) ($_POST['ziel'] ?? '/');
            header('Location: ' . (preg_match('#^/(?!/)[A-Za-z0-9/_\-]*$#', $ziel) ? $ziel : '/'));
            exit;
        }
        $fehler = $r['fehler'];
    }
}

seite_kopf(t('Anmelden'));
$tage = (int) konfig()['sicherheit']['remember_me_tage'];
?>
<h1><?= h(t('Anmelden')) ?></h1>
<?= meldung(!$fehler ? $hinweis : null) ?>
<?= meldung($fehler) ?>
<form method="post" class="formular">
    <?= csrf_feld() ?>
    <input type="hidden" name="ziel" value="<?= h((string) ($_GET['ziel'] ?? '/')) ?>">
    <label for="f-name"><?= h(t('Benutzername oder E-Mail')) ?></label>
    <input id="f-name" type="text" name="benutzername" value="<?= h($name_wert) ?>" required autofocus autocomplete="username" autocapitalize="none" spellcheck="false">
    <label for="f-pw"><?= h(t('Passwort')) ?></label>
    <input id="f-pw" type="password" name="passwort" required autocomplete="current-password">
    <label class="checkbox-zeile"><input type="checkbox" name="geraet_merken" value="1"<?= str_contains((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 'AmberwaveAndroid/') ? ' checked' : '' ?>> <?= h(t('Dieses Gerät merken ({n} Tage)', ['n' => $tage])) ?></label>
    <button type="submit" class="btn btn-voll"><?= h(t('Anmelden')) ?></button>
</form>
<p class="seite-links">
    <a href="/passwort-vergessen.php"><?= h(t('Passwort vergessen?')) ?></a>
    <?php if (konfig()['sicherheit']['registrierung_modus'] !== 'aus'): ?> · <a href="/register.php"><?= h(t('Neu registrieren')) ?></a><?php endif; ?>
</p>
<?php seite_fuss();
