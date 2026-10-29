<?php
declare(strict_types=1);
// Schreibschutz für den Musikordner: Solange „nur lesen“ eingestellt ist (Einstellungen → Bibliothek, Einrichtung,
// MUSIK_SCHREIBEN in der .env), verändert Amberwave dort nichts – keine Tags, kein Umbenennen/Verschieben, kein Import,
// kein Papierkorb. Die Funktionen mit Benutzer-Einstieg prüfen das über af_schreibtest(); die Schreibroutinen selbst
// prüfen es hier noch einmal (zweite Sicherung, falls ein Weg die erste Prüfung nicht hat).
require_once __DIR__ . '/einstellungen.php';

function musik_schreiben_erlaubt(): bool
{
    try {
        return einstellung('musik_schreiben') === '1';
    } catch (Throwable $e) {
        return false;   // ohne Datenbank lieber nichts verändern
    }
}

function musik_schreibschutz_text(): string
{
    return t('Der Musikordner steht auf „nur lesen“ – Amberwave verändert dort nichts. Schreiben erlauben unter Einstellungen → Bibliothek & Automatik → Musikordner.');
}

/** Liegt der Pfad im Musikordner? (auch noch nicht vorhandene Pfade – dann über den nächsten vorhandenen Elternordner) */
function musik_pfad_drin(string $pfad): bool
{
    $wurzel = rtrim((string) (konfig()['pfade']['musik'] ?? ''), '/');
    if ($wurzel === '') {
        return false;
    }
    $w = realpath($wurzel) ?: $wurzel;
    $p = $pfad;
    while ($p !== '' && $p !== '/' && $p !== '.' && !file_exists($p)) {
        $p = dirname($p);
    }
    $echt = ($p !== '' && file_exists($p) ? realpath($p) : false) ?: $pfad;
    return $echt === $w || str_starts_with($echt . '/', $w . '/') || $pfad === $wurzel || str_starts_with($pfad, $wurzel . '/');
}

/** Vor jedem Schreiben im Musikordner: wirft, wenn „nur lesen“ eingestellt ist. Pfade außerhalb (Temp, Cache) sind frei. */
function musik_schreibschutz(string $pfad): void
{
    if (!musik_schreiben_erlaubt() && musik_pfad_drin($pfad)) {
        $text = musik_schreibschutz_text();
        throw class_exists('ApiFehler') ? new ApiFehler($text, 403) : new RuntimeException($text);
    }
}
