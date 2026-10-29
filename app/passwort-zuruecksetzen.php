<?php
declare(strict_types=1);
require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/seiten.php';
starte_sichere_session();

$roh = (string) ($_POST['t'] ?? $_GET['t'] ?? '');
$fehler = null;
$erfolg = null;
$token = preg_match('/^[a-f0-9]{64}$/', $roh)
    ? db_zeile('SELECT * FROM password_reset_tokens WHERE token_hash = :h AND benutzt = 0 AND gueltig_bis > NOW()', ['h' => hash('sha256', $roh)])
    : null;

if ($token && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $pw = (string) ($_POST['passwort'] ?? '');
    if (!csrf_pruefen()) {
        $fehler = t('Sicherheitsprüfung fehlgeschlagen. Bitte die Seite neu laden.');
    } elseif ($pw !== (string) ($_POST['passwort_wiederholen'] ?? '')) {
        $fehler = t('Die Passwörter stimmen nicht überein.');
    } elseif (($schwach = passwort_ist_zu_schwach($pw)) !== null) {
        $fehler = $schwach;
    } else {
        db_tun('UPDATE users SET passwort_hash = :p, muss_passwort_aendern = 0 WHERE id = :id', ['p' => passwort_hashen($pw), 'id' => $token['user_id']]);
        db_tun('UPDATE password_reset_tokens SET benutzt = 1 WHERE user_id = :u', ['u' => $token['user_id']]);
        db_tun('DELETE FROM remember_tokens WHERE user_id = :u', ['u' => $token['user_id']]);
        // Wer das alte Passwort kannte, fliegt überall raus: alle Geräte abmelden, App-Schlüssel widerrufen
        require_once __DIR__ . '/includes/geraete.php';
        foreach (db_alle('SELECT id FROM nutzer_geraete WHERE user_id = :u AND beendet_am IS NULL', ['u' => $token['user_id']]) as $g) {
            geraet_beenden_intern((int) $g['id'], 'passwort');
        }
        log_sicherheitsereignis((int) $token['user_id'], 'passwort_zurueckgesetzt');
        $erfolg = t('Dein neues Passwort ist gespeichert. Du kannst dich jetzt anmelden.');
        $token = null;
    }
}

seite_kopf(t('Neues Passwort'));
?>
<h1><?= h(t('Neues Passwort')) ?></h1>
<?= meldung($fehler) ?>
<?php if ($erfolg): ?>
    <?= meldung($erfolg, 'erfolg') ?>
    <p class="seite-links"><a href="/login.php"><?= h(t('Zurück zur Anmeldung')) ?></a></p>
<?php elseif (!$token): ?>
    <?= meldung(t('Dieser Link ist ungültig oder abgelaufen. Bitte fordere einen neuen an.')) ?>
    <p class="seite-links"><a href="/passwort-vergessen.php"><?= h(t('Neuen Link anfordern')) ?></a></p>
<?php else: ?>
<form method="post" class="formular">
    <?= csrf_feld() ?>
    <input type="hidden" name="t" value="<?= h($roh) ?>">
    <label for="f-pw"><?= h(t('Neues Passwort')) ?> <small>(<?= h(t('mind. {n} Zeichen', ['n' => (int) konfig()['sicherheit']['passwort_min_laenge']])) ?>)</small></label>
    <input id="f-pw" type="password" name="passwort" required autocomplete="new-password" autofocus>
    <label for="f-pw2"><?= h(t('Wiederholen')) ?></label>
    <input id="f-pw2" type="password" name="passwort_wiederholen" required autocomplete="new-password">
    <button type="submit" class="btn btn-voll"><?= h(t('Speichern')) ?></button>
</form>
<?php endif; ?>
<?php seite_fuss();
