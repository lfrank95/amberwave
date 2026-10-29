<?php
// Automatik-Kette (läuft im Zeitplan jede Minute einen Takt weiter). Reihenfolge, damit jeder Schritt auf dem
// Ergebnis des vorigen aufbaut:
//   1. Einlesen (automatisch alle SCAN_AUTO_STUNDEN oder von Hand) – die Kette startet erst, wenn es fertig ist
//      und dabei etwas neu, geändert oder entfernt wurde
//   2. Erkennung (läuft ohnehin selbstständig): erst über die Tags, AcoustID nur ohne Anhaltspunkt – die Kette wartet,
//      bis keine neuen Alben mehr offen sind (höchstens 3 Stunden), denn die Erkennung verknüpft mit MusicBrainz
//   3. Metadaten vervollständigen (Schalter AUTO_METADATEN) – Alben, dann Künstler, dann Künstlerbilder
//   4. Aufräum-Vorschau (Schalter AUTO_AUFRAEUM_VORSCHAU) – plant mit den fertigen Metadaten; ausgeführt wird
//      weiterhin nur, was du freigibst
// Dazu einmal pro Nacht (NACHTLAUF_STUNDE, −1 = aus) dieselbe Kette ab Schritt 2 – fängt alles auf, was liegen blieb
// (z. B. Kennzeichnung „explizit“, die Deezer nach einiger Zeit erneut nachfragt).
// Von Hand angehaltene Aufträge werden nicht überstimmt; läuft gerade einer von Hand, wartet die Kette darauf.
declare(strict_types=1);

require_once __DIR__ . '/metadatenjob.php';
require_once __DIR__ . '/i18n.php';

function automatik_kette(): array
{
    $z = json_decode((string) einstellung('automatik_kette'), true);
    return (is_array($z) ? $z : []) + ['scan_id' => 0, 'phase' => 'fertig', 'seit' => 0, 'grund' => '', 'md' => false, 'vs' => false];
}

function automatik_neu(int $scanId, string $grund): array
{
    return ['scan_id' => $scanId, 'phase' => 'erkennung', 'seit' => time(), 'grund' => $grund, 'md' => false, 'vs' => false];
}

function automatik_erkennung_beschaeftigt(): bool
{
    if (!function_exists('erk_bereit')) {
        require_once __DIR__ . '/erkennung.php';
    }
    if (!erk_aktiv()) {
        return false;
    }
    if (erk_laeuft()) {
        return true;
    }
    return (int) db_wert("SELECT COUNT(*) FROM editionen e LEFT JOIN erkennung k ON k.edition_id = e.id
        WHERE e.quelle = 'tags' AND e.anzahl_dateien > 0 AND (k.edition_id IS NULL OR k.weg = 'klang_offen')") > 0;
}

/** Ein Takt der Kette. Gibt Protokollzeilen zurück. */
function automatik_takt(): array
{
    $log = [];
    if (scan_laufend()) {
        return $log;
    }
    $k = automatik_kette();
    $alt = json_encode($k);

    // Neues Einlesen fertig → neue Kette (nur wenn sich etwas geändert hat)
    $scan = db_zeile("SELECT id, dateien_neu + dateien_geaendert + dateien_entfernt AS aenderungen FROM scan_laeufe
        WHERE status IN ('fertig', 'abgebrochen', 'fehler') ORDER BY id DESC LIMIT 1");
    if ($scan && (int) $scan['id'] > (int) $k['scan_id']) {
        if ((int) $scan['aenderungen'] > 0) {
            $k = automatik_neu((int) $scan['id'], 'scan');
            $log[] = 'nach dem Einlesen gestartet';
        } else {
            $k['scan_id'] = (int) $scan['id'];
        }
    }
    // Nachtlauf (einmal am Tag zur eingestellten Stunde)
    $stunde = (int) einstellung('nachtlauf_stunde');
    if ($stunde >= 0 && (int) date('G') === $stunde && einstellung('zeitplan_nacht_lauf') !== date('Y-m-d')) {
        einstellung_setzen('zeitplan_nacht_lauf', date('Y-m-d'));
        if ($k['phase'] === 'fertig') {
            $k = automatik_neu((int) $k['scan_id'], 'nacht');
            $log[] = 'Nachtlauf gestartet';
        }
    }

    // Schritt 2: auf die Erkennung am Klang warten
    if ($k['phase'] === 'erkennung') {
        if (!automatik_erkennung_beschaeftigt() || time() - (int) $k['seit'] > 3 * 3600) {
            $k['phase'] = 'metadaten';
            $k['seit'] = time();
        }
    }
    // Schritt 3: Metadaten abgleichen
    if ($k['phase'] === 'metadaten') {
        if (einstellung('auto_metadaten') !== '1') {
            $k['phase'] = 'vorschau';
        } else {
            $z = mj_zustand();
            if (!$k['md']) {
                if ($z['status'] === 'angehalten') {
                    $k['phase'] = 'vorschau'; // von Hand angehalten – nicht überstimmen
                    $log[] = 'Metadaten vervollständigen übersprungen (von Hand angehalten)';
                } elseif ($z['status'] === 'laeuft') {
                    $k['md'] = true;          // läuft schon (von Hand) – abwarten
                } else {
                    mj_starten('alle', [], true, true);
                    $k['md'] = true;
                    $log[] = 'Metadaten vervollständigen gestartet';
                }
            } elseif ($z['status'] !== 'laeuft') {
                $k['phase'] = 'vorschau';
            }
        }
    }
    // Schritt 4: Aufräum-Vorschau für neue oder geänderte Alben
    if ($k['phase'] === 'vorschau') {
        if (einstellung('auto_vorschau') !== '1') {
            $k['phase'] = 'fertig';
        } else {
            require_once __DIR__ . '/aufraeumen.php';
            $z = auftrag_zustand('vorschau');
            if (!$k['vs']) {
                if ($z['status'] === 'angehalten') {
                    $k['phase'] = 'fertig';
                    $log[] = 'Aufräum-Vorschau übersprungen (von Hand angehalten)';
                } elseif ($z['status'] === 'laeuft') {
                    $k['vs'] = true;
                } elseif (af_ohne_vorschau() > 0) {
                    auftrag_vorschau_starten(false, true);
                    $k['vs'] = true;
                    $log[] = 'Aufräum-Vorschau gestartet';
                } else {
                    $k['phase'] = 'fertig';
                }
            } elseif ($z['status'] !== 'laeuft') {
                $k['phase'] = 'fertig';
            }
        }
    }
    if (json_encode($k) !== $alt) {
        einstellung_setzen('automatik_kette', json_encode($k));
    }
    return $log;
}

/** Für die Oberfläche: wo steht die Kette gerade? */
function automatik_stand(): array
{
    $k = automatik_kette();
    $texte = ['erkennung' => t('wartet auf die Erkennung am Klang'), 'metadaten' => t('Metadaten vervollständigen'), 'vorschau' => t('Aufräum-Vorschau'), 'fertig' => ''];
    return ['phase' => $k['phase'], 'text' => $texte[$k['phase']] ?? '', 'grund' => $k['grund'],
        'auto_metadaten' => einstellung('auto_metadaten') === '1', 'auto_vorschau' => einstellung('auto_vorschau') === '1',
        'nachtlauf_stunde' => (int) einstellung('nachtlauf_stunde')];
}
