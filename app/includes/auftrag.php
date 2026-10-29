<?php
// Hintergrundaufträge auf dem Server: laufen weiter, wenn die Seite gewechselt oder die App geschlossen wird.
// Ein Auftrag (Typ: metadaten = Alben/Künstler/Bilder, vorschau = Aufräum-Vorschau) wird angelegt, ein eigener PHP-Prozess (scripts/auftrag.php <typ>)
// arbeitet ihn ab; der Zeitplan setzt ihn jede Minute fort, solange er „läuft“ (nach Container-Neustart, nach der
// Laufzeitgrenze von ~10 Minuten oder nach einer Fehlerpause). Je Typ höchstens ein Prozess (Dateisperre).
// Zustand als JSON-Datei im Cache (kein Datenbank-Schema nötig); Änderungen unter Sperre, damit Oberfläche und
// Prozess sich nicht gegenseitig überschreiben. Die Arbeit selbst steckt in auftrag_schritt_<typ>().
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

const AUFTRAG_TYPEN = ['metadaten', 'vorschau', 'flac'];
const AUFTRAG_LAUFZEIT = 600;      // Sekunden je Prozess, dann übernimmt der nächste Zeitplan-Lauf
const AUFTRAG_PAUSE_FEHLER = 120;  // Sekunden Pause, wenn ein Dienst nicht antwortet

function auftrag_datei(string $typ, string $endung): string
{
    $o = konfig()['pfade']['cache'] . '/tmp';
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return "{$o}/auftrag_{$typ}.{$endung}";
}

function auftrag_leer(): array
{
    return ['art' => '', 'status' => 'bereit', 'auto' => false, 'ids' => [], 'neu' => false, 'gesamt' => 0, 'geprueft' => 0, 'geaendert' => 0,
        'felder' => 0, 'ohne_verknuepfung' => 0, 'meldung' => '', 'fehler' => '', 'warten_bis' => 0, 'gestartet' => null, 'beendet' => null, 'aktualisiert' => null];
}

function auftrag_zustand(string $typ): array
{
    $j = @file_get_contents(auftrag_datei($typ, 'json'));
    $z = $j ? json_decode($j, true) : null;
    return is_array($z) ? $z + auftrag_leer() : auftrag_leer();
}

function auftrag_aendern(string $typ, callable $fn): array
{
    $h = @fopen(auftrag_datei($typ, 'sperre'), 'c');
    if ($h) {
        flock($h, LOCK_EX);
    }
    try {
        $z = $fn(auftrag_zustand($typ));
        $z['aktualisiert'] = date('c');
        $tmp = auftrag_datei($typ, 'json') . '.' . getmypid();
        file_put_contents($tmp, json_encode($z));
        rename($tmp, auftrag_datei($typ, 'json'));
        return $z;
    } finally {
        if ($h) {
            flock($h, LOCK_UN);
            fclose($h);
        }
    }
}

function auftrag_prozess_laeuft(string $typ): bool
{
    $h = @fopen(auftrag_datei($typ, 'lock'), 'c');
    if (!$h) {
        return false;
    }
    $frei = flock($h, LOCK_EX | LOCK_NB);
    if ($frei) {
        flock($h, LOCK_UN);
    }
    fclose($h);
    return !$frei;
}

/** Prozess starten, wenn der Auftrag läuft, keiner arbeitet, keine Fehlerpause ansteht und nicht gerade eingelesen wird */
function auftrag_anstossen(string $typ): bool
{
    $z = auftrag_zustand($typ);
    if ($z['status'] !== 'laeuft' || (int) $z['warten_bis'] > time() || auftrag_prozess_laeuft($typ)) {
        return false;
    }
    if (function_exists('scan_laufend') && scan_laufend()) {
        return false; // während des Einlesens ändern sich die Editionen noch – danach geht es von selbst weiter
    }
    $skript = realpath(__DIR__ . '/../scripts/auftrag.php');
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) $skript) . ' ' . escapeshellarg($typ) . ' > /dev/null 2>&1 &');
    return true;
}

/** Neuen Auftrag anlegen bzw. einen angehaltenen fortsetzen. $setzen: Felder für den Typ (art, ids, neu, gesamt …). */
function auftrag_beginnen(string $typ, array $setzen, bool $fortsetzen, bool $auto = false): array
{
    $z = auftrag_aendern($typ, static function ($z) use ($setzen, $fortsetzen, $auto) {
        if (!$fortsetzen) {
            $z = ['gestartet' => date('c')] + auftrag_leer();
        }
        $z = array_merge($z, $setzen);
        $z['status'] = 'laeuft';
        $z['auto'] = $auto;
        $z['fehler'] = '';
        $z['meldung'] = '';
        $z['warten_bis'] = 0;
        $z['beendet'] = null;
        return $z;
    });
    auftrag_anstossen($typ);
    return $z;
}

function auftrag_anhalten(string $typ): array
{
    return auftrag_aendern($typ, static function ($z) {
        if ($z['status'] === 'laeuft') {
            $z['status'] = 'angehalten';
            $z['meldung'] = t('Angehalten – „Fortsetzen“ macht an derselben Stelle weiter.');
        }
        return $z;
    });
}

/** Für die Oberfläche: Zustand plus Fortschritt (ohne interne Listen) */
function auftrag_aussen(string $typ): array
{
    $z = auftrag_zustand($typ);
    $offen = $z['art'] === 'auswahl' ? count($z['ids']) : (in_array($z['status'], ['laeuft', 'angehalten'], true) ? max(0, $z['gesamt'] - $z['geprueft']) : 0);
    unset($z['ids']);
    return $z + ['offen' => $offen, 'prozess' => auftrag_prozess_laeuft($typ), 'pause' => max(0, (int) $z['warten_bis'] - time())];
}

function auftrag_fertig(string $typ, string $meldung): void
{
    auftrag_aendern($typ, static function ($z) use ($meldung) {
        if ($z['status'] === 'laeuft') {
            $z['status'] = 'fertig';
            $z['beendet'] = date('c');
            $z['meldung'] = $meldung;
            $z['ids'] = [];
        }
        return $z;
    });
}

/** Dienst nicht erreichbar: kurze Pause, dann setzt der Zeitplan an derselben Stelle fort */
function auftrag_fehler(string $typ, string $meldung): void
{
    auftrag_aendern($typ, static function ($z) use ($meldung) {
        $z['fehler'] = $meldung !== '' ? $meldung : t('Dienst nicht erreichbar');
        $z['warten_bis'] = time() + AUFTRAG_PAUSE_FEHLER;
        return $z;
    });
}

/**
 * Arbeitet einen Auftrag ab (im Hintergrund-Prozess). Je Schritt ruft er auftrag_schritt_<typ>($zustand) auf, das liefert
 * ['zaehler' => [feld => +n], 'setzen' => [...], 'fertig' => bool, 'meldung' => Text bei fertig, 'fehler' => Text oder ''].
 */
function auftrag_ausfuehren(string $typ, int $maxSek = AUFTRAG_LAUFZEIT): void
{
    $sperre = @fopen(auftrag_datei($typ, 'lock'), 'c');
    if (!$sperre || !flock($sperre, LOCK_EX | LOCK_NB)) {
        return; // läuft schon
    }
    $fn = 'auftrag_schritt_' . $typ;
    $start = time();
    try {
        while (time() - $start < $maxSek) {
            $z = auftrag_zustand($typ);
            if ($z['status'] !== 'laeuft' || (int) $z['warten_bis'] > time()) {
                return;
            }
            try {
                $r = $fn($z);
            } catch (Throwable $ex) {
                $r = ['fehler' => $ex->getMessage() ?: t('Fehler')];
            }
            $z = auftrag_aendern($typ, static function ($z) use ($r) {
                foreach ($r['zaehler'] ?? [] as $k => $n) {
                    $z[$k] = (int) ($z[$k] ?? 0) + (int) $n;
                }
                foreach ($r['setzen'] ?? [] as $k => $w) {
                    $z[$k] = $w;
                }
                if (empty($r['fehler'])) {
                    $z['fehler'] = '';
                }
                return $z;
            });
            if (!empty($r['fehler'])) {
                auftrag_fehler($typ, (string) $r['fehler']);
                return;
            }
            if (!empty($r['fertig'])) {
                auftrag_fertig($typ, (string) ($r['meldung'] ?? t('Fertig.')));
                return;
            }
        }
    } finally {
        flock($sperre, LOCK_UN);
        fclose($sperre);
    }
}

// ---------- Aufräumen: Vorschau für alle Alben berechnen ----------

function auftrag_vorschau_starten(bool $neu, bool $auto = false): array
{
    require_once __DIR__ . '/aufraeumen.php';
    $alt = auftrag_zustand('vorschau');
    if ($alt['status'] === 'laeuft') {
        return $alt;
    }
    $fortsetzen = !$neu && $alt['status'] === 'angehalten';
    return auftrag_beginnen('vorschau', ['art' => 'alle', 'neu' => $neu, 'gesamt' => ($fortsetzen ? $alt['geprueft'] : 0) + af_ohne_vorschau()], $fortsetzen, $auto);
}

function auftrag_schritt_vorschau(array $z): array
{
    require_once __DIR__ . '/aufraeumen.php';
    $neu = !empty($z['neu']);
    if ($neu) {
        // „Alles neu berechnen“: erst beim ersten Schritt löschen, danach normal weiter
        db_tun("DELETE FROM aufraeum_plaene WHERE status IN ('offen', 'freigegeben', 'fertig', 'fehler')");
    }
    $vor = af_ohne_vorschau();
    $rest = af_vorschau_stapel(false, 20.0);
    $erledigt = max(0, $vor - $rest);
    $r = ['zaehler' => ['geprueft' => $erledigt], 'setzen' => ['neu' => false]];
    if ($neu) {
        $r['setzen']['gesamt'] = $vor;
    }
    if ($rest === 0 || $erledigt === 0) {
        $g = $z['geprueft'] + $erledigt;
        $r['fertig'] = true;
        $r['meldung'] = tn($g, 'Vorschau für {n} Album berechnet.', 'Vorschau für {n} Alben berechnet.') . ($rest ? ' ' . t('{rest} ließen sich nicht berechnen.', ['rest' => $rest]) : '');
    }
    return $r;
}
