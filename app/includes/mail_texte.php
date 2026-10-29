<?php
declare(strict_types=1);
require_once __DIR__ . '/mail.php';

/** E-Mail-Adressen aller aktiven Admins (ohne Platzhalter-Adresse). */
function mail_admins(): array
{
    $liste = [];
    foreach (db_alle("SELECT email FROM users WHERE rolle = 'admin' AND status = 'aktiv'") as $z) {
        if (filter_var($z['email'], FILTER_VALIDATE_EMAIL) && !str_ends_with((string) $z['email'], '@localhost')) {
            $liste[] = (string) $z['email'];
        }
    }
    return $liste;
}

/**
 * Texte der App-Mails (in der aktuell gesetzten Sprache). Platzhalter {name} usw. werden ersetzt.
 * 'gueltig_bis' darf als Rohdatum (JJJJ-MM-TT …) kommen und wird hier sprachrichtig formatiert.
 */
function mail_vorlage(string $ereignis, array $d): ?array
{
    $v = [
        'registrierung_neu' => [
            t('Neue Registrierung bei {app}: {nutzer_name}'),
            t("Hallo,\n\n{nutzer_name} (@{nutzer_benutzername}, {nutzer_email}) hat sich registriert und wartet auf Freischaltung.\n\nFreischalten: {link}\n"),
        ],
        'freigeschaltet' => [
            t('Dein Zugang zu {app} ist freigeschaltet'),
            t("Hallo {vorname},\n\ndein Konto bei {app} ist jetzt freigeschaltet{gueltig_text}.\n\nHier geht's los: {link}\n\nViel Spaß beim Hören!\n"),
        ],
        'verlaengert' => [
            t('Dein Zugang zu {app} wurde verlängert'),
            t("Hallo {vorname},\n\ndein Konto bei {app} gilt jetzt bis zum {gueltig_bis}.\n\n{link}\n"),
        ],
        'ablauf_bald' => [
            t('Dein Zugang zu {app} läuft bald ab'),
            t("Hallo {vorname},\n\ndein Konto bei {app} läuft am {gueltig_bis} ab. Wenn du weiter hören möchtest, melde dich einfach beim Administrator.\n"),
        ],
        'passwort_reset' => [
            t('Passwort zurücksetzen – {app}'),
            t("Hallo {vorname},\n\nfür dein Konto wurde ein neues Passwort angefordert. Über diesen Link kannst du es festlegen (gültig {minuten} Minuten):\n\n{link}\n\nWenn du das nicht warst, kannst du diese Mail ignorieren.\n"),
        ],
        'test' => [
            t('Testmail von {app}'),
            t("Hallo,\n\ndiese Testmail zeigt, dass der E-Mail-Versand von {app} funktioniert.\n"),
        ],
    ];
    if (!isset($v[$ereignis])) {
        return null;
    }
    $app = app_name();
    if (!empty($d['gueltig_bis']) && preg_match('/^\d{4}-\d{2}-\d{2}/', (string) $d['gueltig_bis'])) {
        $d['gueltig_bis'] = formatiere_datum((string) $d['gueltig_bis']);
    }
    if ($ereignis === 'freigeschaltet') {
        $d['gueltig_text'] = !empty($d['gueltig_bis']) ? ' (' . t('gültig bis {datum}', ['datum' => $d['gueltig_bis']]) . ')' : '';
    }
    $ersetzen = ['{app}' => $app];
    foreach ($d as $k => $w) {
        $ersetzen['{' . $k . '}'] = (string) $w;
    }
    [$betreff, $text] = $v[$ereignis];
    $fuss = "\n-- \n{$app}" . (konfig()['app_url'] !== '' ? ' · ' . konfig()['app_url'] : '') . "\n";
    return [strtr($betreff, $ersetzen), strtr($text, $ersetzen) . $fuss];
}

/** Sprache des Kontos mit dieser E-Mail-Adresse (leer = Serversprache bzw. Deutsch) */
function mail_sprache_von(string $adresse): ?string
{
    try {
        $s = db_zeile('SELECT sprache FROM users WHERE email = :e LIMIT 1', ['e' => $adresse]);
    } catch (Throwable $e) {
        return null;
    }
    return $s && !empty($s['sprache']) ? (string) $s['sprache'] : null;
}

/** Mail an eine oder mehrere Adressen (über die Warteschlange), jeweils in der Sprache des Empfängers. */
function mail_ereignis(string $ereignis, array $an, array $daten): void
{
    foreach (array_unique($an) as $adresse) {
        if (!filter_var($adresse, FILTER_VALIDATE_EMAIL)) {
            continue;
        }
        $vorlage = mit_sprache(mail_sprache_von((string) $adresse), static fn() => mail_vorlage($ereignis, $daten));
        if ($vorlage) {
            sende_mail($adresse, $vorlage[0], $vorlage[1]);
        }
    }
}

/** Einmal täglich: Erinnerung an Konten, die in MAIL_ABLAUF_TAGE ablaufen (je Ablaufdatum nur einmal). */
function ablauf_mails_senden(): int
{
    $tage = max(1, (int) einstellung('mail_ablauf_tage'));
    $n = 0;
    $faellig = db_alle(
        "SELECT * FROM users WHERE status = 'aktiv' AND rolle <> 'admin' AND mail_info = 1 AND gueltig_bis IS NOT NULL
           AND gueltig_bis > NOW() AND gueltig_bis <= (NOW() + INTERVAL {$tage} DAY)
           AND (ablauf_mail_fuer IS NULL OR ablauf_mail_fuer <> gueltig_bis)"
    );
    foreach ($faellig as $u) {
        mail_ereignis('ablauf_bald', [(string) $u['email']], ['vorname' => $u['vorname'], 'gueltig_bis' => (string) $u['gueltig_bis']]);
        db_tun('UPDATE users SET ablauf_mail_fuer = gueltig_bis WHERE id = :id', ['id' => $u['id']]);
        $n++;
    }
    return $n;
}
