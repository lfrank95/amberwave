<?php
declare(strict_types=1);
require_once __DIR__ . '/includes/auth.php';
starte_sichere_session();
// Abmelden nur per POST mit gültigem CSRF-Token (verhindert Abmelden über fremde Links);
// ein einfacher Aufruf zeigt eine Bestätigung.
if ($_SERVER['REQUEST_METHOD'] === 'POST' && csrf_pruefen()) {
    $u = eingeloggter_user();
    if ($u) {
        log_sicherheitsereignis((int) $u['id'], 'logout');
    }
    abmelden();
    header('Location: /login.php?grund=abgemeldet');
    exit;
}
require_once __DIR__ . '/includes/seiten.php';
seite_kopf(t('Abmelden'));
?>
<h1><?= h(t('Abmelden?')) ?></h1>
<form method="post" class="formular">
    <?= csrf_feld() ?>
    <button type="submit" class="btn btn-voll"><?= h(t('Ja, abmelden')) ?></button>
</form>
<p class="seite-links"><a href="/"><?= h(t('Zurück')) ?></a></p>
<?php require_once __DIR__ . '/includes/seiten.php'; seite_fuss();
