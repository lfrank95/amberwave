<?php
// Migration 045 (PHP): Beta-Standards. Neue Installationen starten mit „Musikordner nur lesen“ und ohne Usenet-Downloads.
// Bestehende Installationen (es gibt schon Konten) behalten ihr bisheriges Verhalten: Schreiben im Musikordner erlaubt,
// Usenet an, sofern es eingerichtet war oder schon Downloads gab. Ein Wert aus der .env (MUSIK_SCHREIBEN, USENET_AKTIV)
// gilt weiter, wenn er gesetzt ist – deshalb nur eintragen, wo weder Datenbank noch .env etwas vorgeben.
declare(strict_types=1);
$hatKonten = (int) $pdo->query("SELECT COUNT(*) FROM users")->fetchColumn() > 0;
if ($hatKonten) {
    $schon = $pdo->query("SELECT schluessel FROM einstellungen WHERE schluessel IN ('musik_schreiben', 'usenet_aktiv')")->fetchAll(PDO::FETCH_COLUMN);
    $setzen = $pdo->prepare("INSERT INTO einstellungen (schluessel, wert_verschluesselt) VALUES (:k, :w) ON DUPLICATE KEY UPDATE wert_verschluesselt = wert_verschluesselt");
    $envLeer = static fn(string $n) => trim((string) (getenv($n) ?: '')) === '';
    if (!in_array('musik_schreiben', $schon, true) && $envLeer('MUSIK_SCHREIBEN')) {
        $setzen->execute(['k' => 'musik_schreiben', 'w' => 'p:1']);
    }
    if (!in_array('usenet_aktiv', $schon, true) && $envLeer('USENET_AKTIV')) {
        $eingerichtet = (int) $pdo->query("SELECT COUNT(*) FROM einstellungen WHERE schluessel IN ('prowlarr_url', 'sabnzbd_url') AND wert_verschluesselt NOT IN ('', 'p:')")->fetchColumn() > 0
            || trim((string) (getenv('PROWLARR_URL') ?: getenv('SABNZBD_URL') ?: '')) !== ''
            || (int) $pdo->query("SELECT COUNT(*) FROM downloads")->fetchColumn() > 0;
        if ($eingerichtet) {
            $setzen->execute(['k' => 'usenet_aktiv', 'w' => 'p:1']);
        }
    }
}
