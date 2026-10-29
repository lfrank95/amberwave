<?php
// Läuft jede Minute im Container (siehe docker-compose.yml): Mails, Ablauf-Erinnerungen, automatischer Scan.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit;
}
require_once __DIR__ . '/../includes/hilfen.php';
require_once __DIR__ . '/migrate.php';
require_once __DIR__ . '/../includes/sicherung.php';
require_once __DIR__ . '/../includes/mail_texte.php';
require_once __DIR__ . '/../includes/scanner.php';
require_once __DIR__ . '/../includes/einrichtung.php';

// Während einer Wiederherstellung ruht alles – die Datenbank wird gerade ausgetauscht
if (sicherung_wiederherstellung_laeuft()) {
    exit(0);
}

// Solange die Einrichtung (Datenbank, erstes Konto) nicht durch ist, ruht der Zeitplan
if (!ist_eingerichtet()) {
    exit(0);
}
schluessel_sichern(); // Kopie des automatisch erzeugten Schlüssels neben die Sicherungen (nur wenn er sich geändert hat)

try {
    migrationen_ausfuehren();
} catch (Throwable $e) {
    echo date('c') . ' Migration: ' . log_sauber($e->getMessage()) . "\n";
    exit(0); // Datenbank noch nicht bereit – nächste Minute erneut
}

// Tägliche Datensicherung (eigener Prozess, damit der Zeitplan nicht wartet)
try {
    $stunde = (int) einstellung('sicherung_stunde');
    if ($stunde >= 0 && (int) date('G') >= $stunde && einstellung('zeitplan_sicherung_lauf') !== date('Y-m-d')) {
        einstellung_setzen('zeitplan_sicherung_lauf', date('Y-m-d'));
        $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
        exec(escapeshellarg($php) . ' ' . escapeshellarg(__DIR__ . '/sicherung.php') . ' >> ' . escapeshellarg(konfig()['pfade']['cache'] . '/tmp/sicherung.log') . ' 2>&1 &');
    }
} catch (Throwable $e) {
    echo date('c') . ' Datensicherung: ' . log_sauber($e->getMessage()) . "\n";
}

// 1. Mail-Warteschlange
try {
    [$ok, $fehler] = mail_warteschlange_abarbeiten();
    if ($ok || $fehler) {
        echo date('c') . " Mails: {$ok} gesendet, {$fehler} fehlgeschlagen\n";
    }
} catch (Throwable $e) {
    echo date('c') . ' Mails: ' . log_sauber($e->getMessage()) . "\n";
}

// 2. Einmal täglich (ab 9 Uhr): Erinnerung an bald ablaufende Konten
try {
    $heute = date('Y-m-d');
    if ((int) date('G') >= 9 && einstellung('zeitplan_ablauf_lauf') !== $heute && mail_konfiguriert()) {
        einstellung_setzen('zeitplan_ablauf_lauf', $heute);
        $n = ablauf_mails_senden();
        if ($n) {
            echo date('c') . " Ablauf-Erinnerungen: {$n}\n";
        }
    }
} catch (Throwable $e) {
    echo date('c') . ' Ablauf-Mails: ' . log_sauber($e->getMessage()) . "\n";
}

// 3. Automatischer Scan nach neuen/geänderten Dateien
try {
    $stunden = (int) einstellung('scan_auto_stunden');
    if ($stunden > 0 && !scan_laufend()) {
        $letzter = (string) einstellung('zeitplan_scan_lauf');
        if ($letzter === '' || strtotime($letzter) < time() - $stunden * 3600) {
            einstellung_setzen('zeitplan_scan_lauf', date('Y-m-d H:i:s'));
            $id = scan_starten(false, null);
            echo date('c') . " Automatischer Scan gestartet (#{$id})\n";
        }
    }
} catch (Throwable $e) {
    echo date('c') . ' Auto-Scan: ' . log_sauber($e->getMessage()) . "\n";
}

// 4. Künstlerbilder: laufen jetzt als Schritt 3 von „Metadaten vervollständigen“ (nach dem Einlesen, nach jedem
//    Album-Abgleich und nachts) – kein eigener Takt mehr, damit nie zwei Dinge gleichzeitig gegen die Dienste laufen.

// Direktzugang im Heimnetz: Zertifikat einmal am Tag prüfen und rechtzeitig erneuern
try {
    $heute = date('Y-m-d');
    if (einstellung('zeitplan_direkt_lauf') !== $heute) {
        einstellung_setzen('zeitplan_direkt_lauf', $heute);
        require_once __DIR__ . '/../includes/direktzugang.php';
        $m = direkt_erneuern_wenn_noetig();
        if ($m) {
            echo date('c') . " Direktzugang: {$m}\n";
        }
    }
} catch (Throwable $e) {
    echo date('c') . ' Direktzugang: ' . log_sauber($e->getMessage()) . "\n";
}

// Lautheitsanalyse (EBU R128): ungemessene Titel im Hintergrund messen, höchstens ~50 s je Minute
try {
    require_once __DIR__ . '/../includes/lautheit.php';
    $n = lh_stapel(50);
    if ($n) {
        echo date('c') . " Lautheit: {$n} Titel gemessen\n";
    }
} catch (Throwable $e) {
    echo date('c') . ' Lautheit: ' . log_sauber($e->getMessage()) . "\n";
}

// Automatik-Kette (nach dem Einlesen und nachts: Erkennung → Metadaten abgleichen → Aufräum-Vorschau) und
// Hintergrundaufträge weiterlaufen lassen, falls ein Prozess beendet wurde (Neustart, Laufzeitgrenze, Fehlerpause)
try {
    require_once __DIR__ . '/../includes/api.php';
    require_once __DIR__ . '/../includes/api_metadaten.php';
    require_once __DIR__ . '/../includes/automatik.php';
    foreach (automatik_takt() as $zeile) {
        echo date('c') . " Automatik: {$zeile}\n";
    }
    foreach (AUFTRAG_TYPEN as $typ) {
        if (auftrag_anstossen($typ)) {
            echo date('c') . " Auftrag {$typ}: fortgesetzt\n";
        }
    }
} catch (Throwable $e) {
    echo date('c') . ' Automatik/Aufträge: ' . log_sauber($e->getMessage()) . "\n";
}

// Klanganalyse (akustische Ähnlichkeit): eigener Hintergrund-Prozess, solange Aufnahmen offen sind oder der Index veraltet ist
try {
    require_once __DIR__ . '/../includes/klang.php';
    kl_anstossen();
} catch (Throwable $e) {
    echo date('c') . ' Klanganalyse: ' . log_sauber($e->getMessage()) . "\n";
}

// Genres: MusicBrainz-Stimmen für ältere Alben nachholen und die Genre-Familien (Pop, Elektro …) neu berechnen
try {
    require_once __DIR__ . '/../includes/bibliothek.php';
    require_once __DIR__ . '/../includes/musicbrainz.php';
    require_once __DIR__ . '/../includes/genres.php';
    $nachgeholt = scan_laufend() ? 0 : mb_genre_stimmen_nachholen(8);
    if ($nachgeholt || einstellung('genre_familien_lauf') !== date('Y-m-d') || !db_wert('SELECT COUNT(*) FROM album_familien')) {
        genre_familien_neu_berechnen();
        einstellung_setzen('genre_familien_lauf', date('Y-m-d'));
    }
    if ($nachgeholt) {
        echo date('c') . " Genres: Stimmen für {$nachgeholt} Alben nachgeholt\n";
    }
} catch (Throwable $e) {
    echo date('c') . ' Genres: ' . log_sauber($e->getMessage()) . "\n";
}

// Sortier-Assistent (unsortierte Musik): Analyse/Einsortieren im eigenen Prozess fortsetzen. Vor der Erkennung, damit
// frisch einsortierte Alben direkt nach dem Einlesen vom Assistenten verknüpft werden (er kennt das Release schon).
try {
    if (db_wert("SELECT COUNT(*) FROM einstellungen WHERE schluessel = 'sortieren_stand'")) {
        require_once __DIR__ . '/../includes/sortieren.php';
        srt_anstossen();
    }
} catch (Throwable $e) {
    echo date('c') . ' Sortieren: ' . log_sauber($e->getMessage()) . "\n";
}

// Erkennung am Klang (Fingerabdruck → AcoustID → MusicBrainz): eigener Hintergrund-Prozess, wenn ein Schlüssel da ist
try {
    require_once __DIR__ . '/../includes/erkennung.php';
    if (!scan_laufend()) {
        erk_anstossen();
    }
} catch (Throwable $e) {
    echo date('c') . ' Erkennung: ' . log_sauber($e->getMessage()) . "\n";
}

// Downloads (SABnzbd): Status übernehmen, Fertiges im Hintergrund kopieren, danach einlesen
try {
    if (db_wert("SELECT COUNT(*) FROM downloads WHERE status IN ('gesendet', 'laeuft', 'fertig')")) {
        require_once __DIR__ . '/../includes/downloads.php';
        dl_abgleichen_status();
        dl_import_anstossen();
    }
    // Importierte, abgeglichene Alben einsortieren (/Künstler/Jahr - Album)
    if (!scan_laufend() && db_wert("SELECT COUNT(*) FROM downloads WHERE status = 'importiert' AND einsortiert_am IS NULL")) {
        require_once __DIR__ . '/../includes/downloads.php';
        if (($n = dl_einsortieren()) > 0) {
            echo date('c') . " Downloads: {$n} Album/Alben zum Einsortieren freigegeben\n";
        }
    }
    // Originale schon importierter Downloads nachträglich löschen (alle 10 Minuten, nur wenn noch welche da sind)
    if ((int) date('i') % 10 === 0 && db_wert("SELECT COUNT(*) FROM downloads WHERE status = 'importiert' AND original_weg = 0")) {
        require_once __DIR__ . '/../includes/downloads.php';
        if (($n = dl_originale_aufraeumen()) > 0) {
            echo date('c') . " Downloads: {$n} Original(e) im Download-Ordner gelöscht\n";
        }
    }
    if (einstellung('download_scan_noetig') === '1' && !scan_laufend()) {
        einstellung_setzen('download_scan_noetig', '0');
        scan_starten(false, null);
        echo date('c') . " Downloads: Einlesen gestartet\n";
    }
} catch (Throwable $e) {
    echo date('c') . ' Downloads: ' . log_sauber($e->getMessage()) . "\n";
}

// Dateien aufräumen: freigegebene Pläne abarbeiten (eigener Prozess), Papierkorb einmal täglich leeren
try {
    require_once __DIR__ . '/../includes/aufraeumen.php';
    if (!scan_laufend() && db_wert("SELECT COUNT(*) FROM aufraeum_plaene WHERE status = 'freigegeben'")) {
        af_anstossen();
    }
    if (einstellung('zeitplan_papierkorb_lauf') !== date('Y-m-d')) {
        einstellung_setzen('zeitplan_papierkorb_lauf', date('Y-m-d'));
        $n = af_papierkorb_leeren();
        if ($n) {
            echo date('c') . " Papierkorb: {$n} alte Dateien gelöscht\n";
        }
    }
} catch (Throwable $e) {
    echo date('c') . ' Aufräumen: ' . log_sauber($e->getMessage()) . "\n";
}

// Geräte im Heimnetz: alte Kettendateien und Space-Graphen im Cache löschen
try {
    require_once __DIR__ . '/../includes/heimnetz.php';
    $n = hn_cache_aufraeumen();
    if ($n) {
        echo date('c') . " Heimnetz: {$n} alte Dateien aus dem Cache entfernt\n";
    }
} catch (Throwable $e) {
    echo date('c') . ' Heimnetz: ' . log_sauber($e->getMessage()) . "\n";
}

// WAV-Exporte: abgelaufene Dateien löschen, liegengebliebene Aufträge anstoßen
try {
    require_once __DIR__ . '/../includes/api.php';
    require_once __DIR__ . '/../includes/export.php';
    $n = export_aufraeumen();
    if ($n) {
        echo date('c') . " Export: {$n} alte Exporte entfernt\n";
    }
} catch (Throwable $e) {
    echo date('c') . ' Export: ' . log_sauber($e->getMessage()) . "\n";
}

// Neue Version verfügbar? (einmal pro Stunde nachsehen; die Abfrage selbst geht höchstens alle 12 Stunden raus)
if ((int) date('i') === 17) {
    try {
        require_once __DIR__ . '/../includes/updatecheck.php';
        update_hinweis(true);
    } catch (Throwable $e) {
        echo date('c') . ' Update-Hinweis: ' . log_sauber($e->getMessage()) . "\n";
    }
}
