<?php
// Läuft beim Start des App-Containers (scripts/start.sh, im Hintergrund): wartet auf die Datenbank, merkt sich bei einer
// schon eingerichteten Installation die Marke „eingerichtet“ und öffnet sonst das Einrichtungsfenster neu (Portainer-Weg:
// nach EINRICHTUNG_FENSTER_MINUTEN sperrt sich die Seite bis zum nächsten Containerstart). Schreibt den Einstieg ins Log.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/einrichtung.php';

for ($i = 0; $i < 90; $i++) {
    $z = einrichtung_zustand(true);
    if ($z['art'] !== 'wartet') {
        break;
    }
    sleep(2);
}
if ($z['art'] === 'wartet') {
    echo "Einrichtung: Die Datenbank ist nach 3 Minuten nicht erreichbar (" . ($z['meldung'] ?? '') . "). Prüfe: docker logs amberwave_db\n";
    exit(0);
}
if ($z['art'] === 'fertig') {
    schluessel_sichern();
    // Einrichtung ohne Abschluss unterbrochen (Browser zu)? Dann ist Root noch offen – jetzt absichern
    if (einrichtung_root_absichern(true)) {
        echo "Einrichtung: Der Verwaltungszugang der Datenbank (root) hat jetzt ein zufälliges Passwort (geheimnisse/db_root_passwort).\n";
    }
    exit(0);
}

einrichtung_fenster_neu();
geheimnis_loeschen('code_versuche');
$code = einrichtung_code();
$k = konfig();
$basis = $k['app_url'] !== '' ? rtrim($k['app_url'], '/') : 'http://<Server-IP>:' . $k['heimnetz']['app_port'];
$min = (int) $k['einrichtung']['fenster_minuten'];
echo "\n==================================================================\n"
    . " Amberwave ist noch nicht eingerichtet / is not set up yet.\n"
    . ' Öffne / Open:  ' . $basis . '/einrichtung.php?code=' . $code . "\n"
    . ' Einrichtungscode / Setup code: ' . $code . "\n"
    . ($min > 0 ? " Das Fenster ist {$min} Minuten offen / Open for {$min} minutes. Danach / Afterwards: "
        . (getenv('AMBERWAVE_WINDOWS') === '1' ? "Infobereich → Server neu starten / Tray → Restart server\n" : "docker restart amberwave_app\n")
        : " Das Fenster bleibt offen (EINRICHTUNG_FENSTER_MINUTEN=0).\n")
    . "==================================================================\n\n";
