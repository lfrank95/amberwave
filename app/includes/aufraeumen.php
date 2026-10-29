<?php
declare(strict_types=1);
require_once __DIR__ . '/schreibschutz.php';
require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/tagziel.php';
require_once __DIR__ . '/tagschreiber.php';
require_once __DIR__ . '/tags.php';
require_once __DIR__ . '/zeichen.php';
require_once __DIR__ . '/bilder.php';
require_once __DIR__ . '/scanner.php';

/**
 * Dateien aufräumen – für abgeglichene Alben (MusicBrainz oder von Hand gepflegt):
 * 1. Tags und Cover in die Dateien schreiben (FLAC, MP3, M4A; Audio bleibt bitgenau, siehe tagschreiber.php)
 * 2. Ordner und Dateien nach Schema benennen (AUFRAEUMEN_ORDNER / AUFRAEUMEN_DATEI)
 * 3. Müll (.nfo, .sfv, .m3u, .log, .cue, Thumbs.db …) entfernen
 * Immer erst als Vorschau (Plan je Album), ausgeführt wird nur Freigegebenes. Gelöschtes und alte Tags (als JSON)
 * landen im Papierkorb-Ordner „.amberwave-papierkorb“ im Musikordner und werden nach AUFRAEUMEN_PAPIERKORB_TAGE gelöscht.
 */

const AF_PAPIERKORB = '.amberwave-papierkorb';

function af_wurzel(): string
{
    return konfig()['pfade']['musik'];
}

/** Pfad des Debug-Protokolls (Aufräumen) */
function af_debug_pfad(): string
{
    return konfig()['pfade']['cache'] . '/tmp/aufraeumen-debug.log';
}

/**
 * Eine Zeile ins Debug-Protokoll schreiben (immer an, sehr sparsam). Zeigt, was nach dem Klick auf Freigabe genau
 * passiert und wo es hängt. Rollt bei ~256 KB einmal um, damit es nicht wächst.
 */
function af_log(string $text, array $daten = []): void
{
    $datei = af_debug_pfad();
    @mkdir(dirname($datei), 0775, true);
    if (@filesize($datei) > 256 * 1024) {
        @rename($datei, $datei . '.alt');
    }
    $wer = function_exists('posix_geteuid') ? posix_geteuid() . ':' . (function_exists('posix_getegid') ? posix_getegid() : '?') : '?';
    $zeile = date('H:i:s') . ' [' . $wer . '] ' . $text;
    if ($daten) {
        $zeile .= ' ' . json_encode($daten, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    @file_put_contents($datei, $zeile . "\n", FILE_APPEND);
}

/** Fassung der Planberechnung – erhöhen, wenn sich ändert, wie Pläne gerechnet werden (alte werden dann neu erstellt) */
const AF_PLAN_LOGIK = 6;

/**
 * Fingerabdruck der Vorschau: nur aus Einstellungen, die den INHALT des Plans ändern (Pfade, Namen, welche Dateien,
 * welche Tags, Müll). Reine Ausführungs-Einstellungen wie Dateirechte oder Papierkorb-Aufbewahrung zählen NICHT mit,
 * sonst gälten Vorschauen grundlos als veraltet, nur weil eine solche Option dazukam.
 */
function af_plan_stand(): string
{
    $k = konfig()['aufraeumen'];
    $relevant = [];
    foreach (['ordner', 'datei', 'cd_immer', 'name_max', 'pfad_max', 'tags', 'behalten', 'muell', 'cover', 'cover_groesse', 'zeichen'] as $f) {
        $relevant[$f] = $k[$f] ?? null;
    }
    $relevant['standardnamen'] = standardnamen_aktiv(); // ändert Tags und Ordnernamen
    return substr(sha1(json_encode([AF_PLAN_LOGIK, $relevant, af_wurzel()], JSON_UNESCAPED_UNICODE)), 0, 16);
}

/**
 * Kann Amberwave im Musikordner schreiben? Prüft Einbindung (nur lesend?) und Rechte des laufenden Benutzers. Liefert eine verständliche Meldung samt Abhilfe.
 */
function af_schreibtest(): array
{
    $k = konfig()['aufraeumen'];
    $wurzel = rtrim(af_wurzel(), '/');
    $uid = function_exists('posix_geteuid') ? posix_geteuid() : null;
    $gid = function_exists('posix_getegid') ? posix_getegid() : null;
    $nurLesen = false;
    $mounts = @file('/proc/mounts', FILE_IGNORE_NEW_LINES) ?: [];
    $best = '';
    foreach ($mounts as $z) {
        $t = preg_split('/\s+/', $z);
        if (count($t) < 4) {
            continue;
        }
        $mp = str_replace('\\040', ' ', $t[1]);
        if (($wurzel === $mp || str_starts_with($wurzel . '/', rtrim($mp, '/') . '/')) && strlen($mp) >= strlen($best)) {
            $best = $mp;
            $nurLesen = in_array('ro', explode(',', $t[3]), true);
        }
    }
    $pruef = $wurzel;
    $besitzer = @fileowner($pruef);
    $gruppe = @filegroup($pruef);
    $rechte = @fileperms($pruef);
    $info = ['uid' => $uid, 'gid' => $gid, 'ordner' => $pruef, 'besitzer' => $besitzer === false ? null : $besitzer,
        'gruppe' => $gruppe === false ? null : $gruppe, 'rechte' => $rechte === false ? null : substr(sprintf('%o', $rechte), -3)];
    if (!is_dir($wurzel)) {
        return ['ok' => false, 'nur_lesen' => false, 'meldung' => t('Der Musikordner {pfad} ist im Container nicht vorhanden.', ['pfad' => $wurzel])] + $info;
    }
    if (!musik_schreiben_erlaubt()) {
        return ['ok' => false, 'nur_lesen' => true, 'gesperrt' => true, 'meldung' => musik_schreibschutz_text()] + $info;
    }
    if ($nurLesen) {
        return ['ok' => false, 'nur_lesen' => true, 'meldung' => t('Der Musikordner ist im Container nur lesend eingebunden. In der .env MUSIK_MOUNT_MODUS=rw setzen und den Stack neu starten (Compose Down/Up).')] + $info;
    }
    // Echter Schreibversuch (is_writable lügt bei manchen Netz-/FUSE-Dateisystemen)
    $probe = $pruef . '/.amberwave-schreibtest-' . bin2hex(random_bytes(4));
    $ok = @mkdir($probe, 0775);
    if ($ok) {
        @rmdir($probe);
        return ['ok' => true, 'nur_lesen' => false, 'meldung' => ''] + $info;
    }
    $wer = $uid !== null ? "UID {$uid}/GID {$gid}" : t('der Webserver-Benutzer');
    $hat = $info['besitzer'] !== null ? ' ' . t('(gehört UID {uid}/GID {gid}, Rechte {rechte})', ['uid' => $info['besitzer'], 'gid' => $info['gruppe'], 'rechte' => $info['rechte']]) : '';
    return ['ok' => false, 'nur_lesen' => false, 'meldung' => t('Keine Schreibrechte in {pfad}{hat} für {wer}. Auf Unraid: Tools → New Permissions für die Musik-Freigabe ausführen, oder im Terminal: chown -R 99:100 und chmod -R u+rwX,g+rwX auf den Musikordner. PUID/PGID in der .env müssen dazu passen.',
        ['pfad' => $pruef, 'hat' => $hat, 'wer' => $wer])] + $info;
}

/** Ordner (mit allen fehlenden Ebenen) anlegen und jeder neuen Ebene die eingestellten Rechte geben */
function af_ordner_anlegen(string $abs): bool
{
    musik_schreibschutz($abs);
    if (is_dir($abs)) {
        return true;
    }
    $fehlend = [];
    for ($d = $abs; $d !== '' && $d !== '/' && !is_dir($d); $d = dirname($d)) {
        $fehlend[] = $d;
    }
    $modus = (int) konfig()['aufraeumen']['rechte_ordner'];
    $alt = umask(0);
    try {
        foreach (array_reverse($fehlend) as $d) {
            if (!@mkdir($d, $modus) && !is_dir($d)) {
                return false;
            }
            @chmod($d, $modus);
        }
    } finally {
        umask($alt);
    }
    return true;
}

/** Datei auf die eingestellten Rechte bringen (geht nur bei eigenen Dateien – fremde bleiben, wie sie sind) */
function af_datei_rechte(string $abs): void
{
    if (is_file($abs) && function_exists('posix_geteuid') && @fileowner($abs) === posix_geteuid()) {
        @chmod($abs, (int) konfig()['aufraeumen']['rechte_datei']);
    }
}

/**
 * Alles im Musikordner, was Amberwave gehört, auf die eingestellten Rechte bringen (z. B. Ordner aus älteren Versionen,
 * die Windows nicht öffnen konnte). Fremde Dateien kann nur root ändern – die werden nur gezählt.
 */
function af_rechte_reparieren(): array
{
    set_time_limit(600);
    $k = konfig()['aufraeumen'];
    $ich = function_exists('posix_geteuid') ? posix_geteuid() : -1;
    // Zielgruppe ist die gewünschte PGID (aus der .env, Unraid-Standard 100) – NICHT die Gruppe, mit der Amberwave
    // gerade läuft: läuft es mit falscher Gruppe (z. B. „sshd“), würde sonst in die falsche Richtung korrigiert.
    $pgid = getenv('PGID');
    $sollGruppe = ($pgid !== false && $pgid !== '') ? (int) $pgid : (function_exists('posix_getegid') ? posix_getegid() : -1);
    $n = ['geaendert' => 0, 'gruppe' => 0, 'fremd' => 0, 'unlesbar' => 0, 'geprueft' => 0];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(af_wurzel(), FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST, RecursiveIteratorIterator::CATCH_GET_CHILD);
    foreach ($it as $f) {
        $n['geprueft']++;
        $soll = $f->isDir() ? (int) $k['rechte_ordner'] : (int) $k['rechte_datei'];
        $p = $f->getPathname();
        if (!$f->isReadable()) {
            $n['unlesbar']++;
        }
        if (@fileowner($p) !== $ich) {
            $n['fremd']++;
            continue; // Fremde Dateien kann nur root ändern
        }
        // Falsche Gruppe (z. B. „sshd“ aus älteren Versionen) auf PGID bringen – geht, weil wir Mitglied der Gruppe sind
        if ($sollGruppe >= 0 && @filegroup($p) !== $sollGruppe && @chgrp($p, $sollGruppe)) {
            $n['gruppe']++;
            clearstatcache(true, $p);
        }
        if ((@fileperms($p) & 0777) !== $soll && @chmod($p, $soll)) {
            $n['geaendert']++;
        }
    }
    return $n;
}

function af_sperre_pfad(): string
{
    return konfig()['pfade']['cache'] . '/tmp/aufraeumen.lock';
}

function af_laeuft(): bool
{
    $h = @fopen(af_sperre_pfad(), 'c');
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

function af_anstossen(): void
{
    if (af_laeuft()) {
        af_log('Anstoß übersprungen: Aufräumer läuft bereits (Sperre belegt)');
        return;
    }
    $skript = realpath(__DIR__ . '/../scripts/aufraeumen.php');
    $php = is_executable(PHP_BINDIR . '/php') ? PHP_BINDIR . '/php' : 'php';
    $execAn = function_exists('exec') && !in_array('exec', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true);
    af_log('Anstoß: starte Hintergrund-Aufräumer', ['exec_verfügbar' => $execAn, 'php' => $php, 'skript' => $skript]);
    if (!$execAn) {
        af_log('FEHLER: exec() ist deaktiviert – der Hintergrund-Aufräumer kann nicht gestartet werden');
        return;
    }
    exec(escapeshellarg($php) . ' ' . escapeshellarg((string) $skript) . ' > ' . escapeshellarg(konfig()['pfade']['cache'] . '/tmp/aufraeumen-worker.log') . ' 2>&1 &');
}

/** Ein Pfadbestandteil, der auf Linux, Windows (SMB) und macOS gültig ist */
function af_sicher(string $s): string
{
    $s = text_nfc($s);                                                                  // é statt e + ´
    $s = (string) preg_replace('/[\x{00AD}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{FEFF}]/u', '', $s); // Unsichtbares
    $s = (string) preg_replace('/[\x00-\x1F\x7F\x{2028}\x{2029}]/u', ' ', $s);        // Steuerzeichen, Tabs → Leerzeichen
    $s = (string) preg_replace('/(\d+)\s*(?:"|″|”)/u', '$1 Zoll', $s); // 12" Vinyl → 12 Zoll Vinyl
    $s = strtr($s, ['/' => '-', '\\' => '-', ':' => ' -', '*' => '', '?' => '', '"' => "'", '<' => '(', '>' => ')', '|' => '-']);
    $s = (string) preg_replace('/\s+/u', ' ', $s);
    $s = (string) preg_replace('/ - -/u', ' -', $s);
    if (konfig()['aufraeumen']['zeichen'] === 'ascii') {
        $s = (string) preg_replace('/\s+/', ' ', text_ascii($s));
    }
    $s = trim($s, " .\t");
    // Unter Windows reservierte Gerätenamen (auch mit Endung) gehen dort weder zu öffnen noch zu löschen
    if (preg_match('/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/iu', $s)) {
        $s = preg_replace('/^([^.]+)/u', '$1_', $s);
    }
    $max = max(40, min(240, (int) (konfig()['aufraeumen']['name_max'] ?? 180)));
    if (strlen($s) > $max) {
        $s = rtrim(mb_strcut($s, 0, $max, 'UTF-8'), ' .');
    }
    return $s !== '' ? $s : '_';
}

/** Schema füllen: {albumkuenstler}, {album}, {titel} … ; „{ [edition]}“ = Zusatztext nur, wenn der Wert nicht leer ist */
function af_schema(string $schema, array $werte): string
{
    return (string) preg_replace_callback('/\{([^{}]*?)(albumkuenstler|kuenstler|album|originaljahr|jahr|edition|land|format|katalognummer|disc|nr|titel)([^{}]*?)\}/u',
        static function ($m) use ($werte) {
            $w = trim((string) ($werte[$m[2]] ?? ''));
            return $w === '' ? '' : $m[1] . $w . $m[3];
        }, $schema);
}

function af_pfad(string $schema, array $werte): string
{
    // Schrägstriche in Werten („AC/DC“, „Live/Love“) sind Text, keine Ordnergrenze – nur die des Schemas trennen Ordner
    $werte = array_map(static fn($w) => is_string($w) ? str_replace(['/', '\\'], '-', $w) : $w, $werte);
    $teile = array_filter(array_map('trim', explode('/', af_schema($schema, $werte))), 'strlen');
    return implode('/', array_map('af_sicher', $teile));
}

/**
 * Name auf höchstens $max Zeichen bringen, ohne ihn zu zerhacken: zuerst angehängte Klammerzusätze wie „(Remastered 2011)“
 * von hinten weg, dann an der letzten Wortgrenze abschneiden. Der Anfang (z. B. die Titelnummer) bleibt immer erhalten.
 */
function af_kuerzen(string $s, int $max): string
{
    if (mb_strlen($s) <= $max) {
        return $s;
    }
    while (mb_strlen($s) > $max && preg_match('/^(.{3,}?)\s*[\(\[][^()\[\]]*[\)\]]$/u', $s, $m)) {
        $s = rtrim($m[1]);
    }
    if (mb_strlen($s) <= $max) {
        return $s;
    }
    $cut = mb_substr($s, 0, $max);
    $pos = mb_strrpos($cut, ' ');
    if ($pos !== false && $pos >= $max * 0.5) {
        $cut = mb_substr($cut, 0, $pos);
    }
    $cut = rtrim($cut, " .-,;:_");
    return $cut !== '' ? $cut : mb_substr($s, 0, $max);
}

function af_ist_muell(string $name): bool
{
    foreach (konfig()['aufraeumen']['muell'] as $muster) {
        if ($muster !== '' && fnmatch(mb_strtolower($muster), mb_strtolower($name))) {
            return true;
        }
    }
    return false;
}

/** Alle Dateien unterhalb eines Ordners (relativ zur Musik-Wurzel), ohne Papierkorb */
function af_dateien_unter(string $rel): array
{
    $wurzel = af_wurzel();
    $abs = $rel === '' || $rel === '.' ? $wurzel : $wurzel . '/' . $rel;
    if (!is_dir($abs)) {
        return [];
    }
    $aus = [];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($abs, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if ($f->isFile()) {
            $r = ltrim(substr($f->getPathname(), strlen($wurzel)), '/');
            if (!str_starts_with($r, AF_PAPIERKORB)) {
                $aus[] = $r;
            }
        }
    }
    sort($aus);
    return $aus;
}

/** Cover der Edition als JPEG (größte Stufe bis AUFRAEUMEN_COVER_GROESSE) */
function af_cover(array $e): ?string
{
    if (!konfig()['aufraeumen']['cover'] || ($e['cover_datei'] ?? '') === '') {
        return null;
    }
    $p = bild_pfad('cover', (string) $e['cover_datei'], konfig()['aufraeumen']['cover_groesse']);
    return $p ? ((string) file_get_contents($p) ?: null) : null;
}

/**
 * Plan (Vorschau) für eine Edition erstellen und speichern.
 */
function af_plan_erstellen(int $editionId): array
{
    $k = konfig()['aufraeumen'];
    $e = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $editionId]);
    $a = db_zeile('SELECT * FROM alben WHERE id = :id', ['id' => $e['album_id']]);
    $credit = tag_credit($e['credit_id'] ? (int) $e['credit_id'] : ($a['credit_id'] ? (int) $a['credit_id'] : null));
    $labels = db_alle('SELECT el.katalognummer FROM edition_labels el WHERE el.edition_id = :e AND el.katalognummer <> \'\'', ['e' => $editionId]);
    $andere = (int) db_wert('SELECT COUNT(*) FROM editionen WHERE album_id = :a AND id <> :e AND anzahl_dateien > 0', ['a' => $a['id'], 'e' => $editionId]);
    $editionText = trim((string) $e['kommentar']);
    if ($editionText === '' && $andere > 0) {
        // Steht das Editionsjahr schon im Schema ({jahr}), nicht noch einmal im Editionsnamen
        $jahrImSchema = (bool) preg_match('/\{[^{}]*?(?<!original)jahr[^{}]*\}/u', $k['ordner'] . $k['datei']);
        $editionText = trim(implode(' ', array_filter([$jahrImSchema ? '' : (string) ($e['jahr'] ?? ''), (string) $e['land'], (string) $e['format_text']])));
    }
    $discs = (int) db_wert('SELECT COUNT(DISTINCT m.id) FROM datentraeger m JOIN tracks t ON t.datentraeger_id = m.id WHERE m.edition_id = :e', ['e' => $editionId]);
    $werte = [
        'albumkuenstler' => $credit['anzeige'] ?: 'Unbekannt', 'album' => (string) ($e['titel'] ?: $a['titel']),
        'originaljahr' => (string) ($a['erstjahr'] ?: ($e['jahr'] ?? '')), 'jahr' => (string) (($e['jahr'] ?? null) ?: ($a['erstjahr'] ?: '')), // Editionsjahr, sonst Erstveröffentlichung
        'edition' => $editionText, 'land' => (string) $e['land'], 'format' => (string) $e['format_text'],
        'katalognummer' => (string) ($labels[0]['katalognummer'] ?? ''),
    ];
    $basis = trim((string) $e['ordner'], '/');
    // Ziel liegt direkt im Wurzelordner der Bibliothek, z. B. „Bruno Mars/2012 - Unorthodox Jukebox“
    $ziel = af_pfad($k['ordner'], $werte);
    // Gesamtlänge des Pfads im Rahmen halten (Windows-Programme: ca. 260 Zeichen, verschlüsselte NAS-Ordner: 143 je Name)
    $pfadMax = max(80, (int) ($k['pfad_max'] ?? 200));
    $gekuerzt = 0;
    $ordnerMax = max(40, $pfadMax - 70);
    if (mb_strlen($ziel) > $ordnerMax) {
        $seg = explode('/', $ziel);
        $letzt = array_pop($seg);
        $neuLetzt = af_kuerzen($letzt, max(10, mb_strlen($letzt) - (mb_strlen($ziel) - $ordnerMax)));
        if ($neuLetzt !== $letzt) {
            $seg[] = $neuLetzt;
            $ziel = implode('/', $seg);
            $gekuerzt++;
        }
    }
    $dateien = db_alle('SELECT d.id, d.pfad, d.format, d.track_id, d.tags_json, d.bild_eingebettet, t.pos, t.titel, t.credit_id, m.pos AS disc
        FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
        WHERE m.edition_id = :e ORDER BY m.pos, t.pos, d.id', ['e' => $editionId]);
    $wurzel = af_wurzel();
    $probleme = [];
    $ohneMb = ($e['mbid'] ?? '') === '' || $e['mbid'] === null;
    if ($ohneMb) {
        $probleme[] = t('Nicht mit MusicBrainz abgeglichen: Namen kommen aus den Datei-Tags (bei Downloads oft unvollständig). „Alle freigeben“ überspringt dieses Album – bitte Vorschau prüfen und einzeln freigeben.');
    }
    // Gehört der Ordner nur diesem Album?
    $typen = array_flip(konfig()['scan']['dateitypen']);
    $eigene = array_flip(array_column($dateien, 'pfad'));
    $imOrdner = ($basis === '' || $basis === '.') ? [] : af_dateien_unter($basis);
    $fremdeAudio = array_filter($imOrdner, static fn($r) => isset($typen[strtolower(pathinfo($r, PATHINFO_EXTENSION))]) && !isset($eigene[$r]));
    $geteilt = $basis === '' || $basis === '.' || $fremdeAudio;
    if ($geteilt) {
        $probleme[] = t('Der Ordner enthält auch andere Alben – nur die Dateien dieses Albums werden verschoben.');
    }
    // Zielordner frei?
    if ($ziel !== $basis) {
        $versuch = $ziel;
        for ($n = 2; is_dir($wurzel . '/' . $versuch) && mb_strtolower($versuch) !== mb_strtolower($basis) && af_dateien_unter($versuch); $n++) {
            $versuch = $ziel . ' (' . $n . ')';
        }
        if ($versuch !== $ziel) {
            $probleme[] = t('Zielordner „{ziel}“ ist schon belegt – stattdessen „{versuch}“.', ['ziel' => $ziel, 'versuch' => $versuch]);
        }
        $ziel = $versuch;
    }
    $soll = tags_fuer_edition($editionId);
    $hatCover = $k['cover'] && ($e['cover_datei'] ?? '') !== '';
    $nrBreite = max(2, strlen((string) db_wert('SELECT MAX(t.pos) FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $editionId])));
    $plan = ['ordner_alt' => $basis, 'ordner_neu' => $ziel, 'geteilt' => (bool) $geteilt, 'modus' => 'verschieben',
        'dateien' => [], 'sonstige' => [], 'muell' => [], 'probleme' => []];
    $belegt = [];
    $felderGesamt = 0;
    $coverNeu = 0;
    $tagsNeu = 0;
    $bewegt = 0;
    foreach ($dateien as $d) {
        $ext = strtolower(pathinfo((string) $d['pfad'], PATHINFO_EXTENSION));
        $tw = $werte + ['disc' => ($discs > 1 || $k['cd_immer']) ? (string) $d['disc'] : '', 'nr' => str_pad((string) $d['pos'], $nrBreite, '0', STR_PAD_LEFT), 'titel' => (string) $d['titel']];
        $name = af_pfad($k['datei'], $tw);
        $schraeg = strrpos($name, '/');
        $namVerz = $schraeg === false ? '' : substr($name, 0, $schraeg + 1);
        $namDatei = $schraeg === false ? $name : substr($name, $schraeg + 1);
        $platz = max(12, $pfadMax - mb_strlen($ziel) - 1 - mb_strlen($namVerz) - mb_strlen($ext) - 1 - 6);
        $kurz = af_kuerzen($namDatei, $platz);
        if ($kurz !== $namDatei) {
            $gekuerzt++;
        }
        $name = $namVerz . $kurz;
        $nach = $ziel . '/' . $name . '.' . $ext;
        for ($n = 2; isset($belegt[mb_strtolower($nach)]); $n++) {
            $nach = $ziel . '/' . $name . ' (' . $n . ').' . $ext;
        }
        $belegt[mb_strtolower($nach)] = true;
        $abs = $wurzel . '/' . $d['pfad'];
        $eintrag = ['datei_id' => (int) $d['id'], 'von' => (string) $d['pfad'], 'nach' => $nach, 'format' => $ext, 'tags' => false, 'cover' => false, 'unterschiede' => [], 'hinweis' => ''];
        if (!is_file($abs)) {
            $eintrag['hinweis'] = t('Datei fehlt auf der Platte');
            $plan['dateien'][] = $eintrag;
            continue;
        }
        if (!is_writable($abs) || !is_writable(dirname($abs))) {
            $eintrag['hinweis'] = t('Keine Schreibrechte');
        }
        if (in_array($ext, TAG_FORMATE, true)) {
            $ist = json_decode((string) $d['tags_json'], true) ?: [];
            $diff = tags_unterschiede($ist, $soll[(int) $d['track_id']] ?? []);
            $eintrag['unterschiede'] = $diff;
            $eintrag['tags'] = (bool) $diff;
            $eintrag['cover'] = $hatCover && !(int) $d['bild_eingebettet'];
            $felderGesamt += count($diff);
            $tagsNeu += $diff ? 1 : 0;
            $coverNeu += $eintrag['cover'] ? 1 : 0;
        } else {
            $eintrag['hinweis'] = trim($eintrag['hinweis'] . ' · ' . t('Format .{ext}: Tags werden nicht geschrieben', ['ext' => $ext]), ' ·');
        }
        if ($eintrag['von'] === $eintrag['nach']) {
            $eintrag['nach'] = null;
        } else {
            $bewegt++;
        }
        $plan['dateien'][] = $eintrag;
    }
    // Sonstiges und Müll
    $verzeichnisse = $geteilt ? array_values(array_unique(array_map(static fn($d) => dirname((string) $d['pfad']), $dateien))) : [$basis];
    foreach ($verzeichnisse as $v) {
        $liste = $geteilt ? array_values(array_filter(array_map(static fn($n) => ($v === '.' ? '' : $v . '/') . $n, @scandir($wurzel . '/' . $v) ?: []), static fn($r) => is_file($wurzel . '/' . $r))) : $imOrdner;
        foreach ($liste as $r) {
            if (isset($eigene[$r]) || isset($typen[strtolower(pathinfo($r, PATHINFO_EXTENSION))])) {
                continue;
            }
            if (af_ist_muell(basename($r))) {
                $plan['muell'][] = $r;
            } elseif (!$geteilt && $ziel !== $basis) {
                $plan['sonstige'][] = ['von' => $r, 'nach' => $ziel . substr($r, strlen($basis))];
            }
        }
    }
    if ($gekuerzt) {
        $probleme[] = tn($gekuerzt, '{n} Name gekürzt (Pfad sonst länger als {max} Zeichen) – der volle Titel bleibt in den Tags.', '{n} Namen gekürzt (Pfad sonst länger als {max} Zeichen) – der volle Titel bleibt in den Tags.', ['max' => $pfadMax]);
    }
    $plan['probleme'] = $probleme;
    $nichtSchreibbar = count(array_filter($plan['dateien'], static fn($x) => $x['hinweis'] !== ''));
    $teile = [];
    if ($tagsNeu) {
        $teile[] = t('{n}× Tags ({felder} Felder)', ['n' => $tagsNeu, 'felder' => $felderGesamt]);
    }
    if ($coverNeu) {
        $teile[] = t('{n}× Cover', ['n' => $coverNeu]);
    }
    if ($bewegt) {
        $teile[] = t('{n} umbenennen', ['n' => $bewegt]) . ($ziel !== $basis ? ' → ' . $ziel : '');
    }
    if ($plan['muell']) {
        $teile[] = t('{n} Müll', ['n' => count($plan['muell'])]);
    }
    $aenderungen = $tagsNeu + $coverNeu + $bewegt + count($plan['muell']) + count($plan['sonstige']);
    $zus = $teile ? implode(' · ', $teile) : t('Alles in Ordnung – nichts zu tun');
    db_tun("INSERT INTO aufraeum_plaene (edition_id, status, plan_json, zusammenfassung, aenderungen, probleme, erstellt_am, stand)
            VALUES (:e, 'offen', :p, :z, :a, :pr, NOW(), :st)
            ON DUPLICATE KEY UPDATE status = 'offen', plan_json = VALUES(plan_json), zusammenfassung = VALUES(zusammenfassung), aenderungen = VALUES(aenderungen),
                probleme = VALUES(probleme), erstellt_am = NOW(), ausgefuehrt_am = NULL, log = NULL, stand = VALUES(stand)",
        ['st' => af_plan_stand(), 'e' => $editionId, 'p' => json_encode($plan, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'z' => mb_substr($zus, 0, 500),
         'a' => $aenderungen, 'pr' => count($probleme) + $nichtSchreibbar]);
    return $plan;
}

/** Vorschau für noch nicht geplante Alben (bzw. alle neu) in einem Zeitfenster; liefert die Anzahl noch offener */
function af_vorschau_stapel(bool $neu, float $sekunden = 15.0): int
{
    if ($neu) {
        db_tun("DELETE FROM aufraeum_plaene WHERE status IN ('offen', 'freigegeben', 'fertig', 'fehler')");
    }
    $bis = microtime(true) + $sekunden;
    $sql = "SELECT e.id FROM editionen e LEFT JOIN aufraeum_plaene p ON p.edition_id = e.id
            WHERE e.quelle IN ('musicbrainz', 'manuell') AND e.anzahl_dateien > 0
              AND (p.edition_id IS NULL OR (p.stand <> :st AND p.status IN ('offen', 'freigegeben', 'fehler'))) ORDER BY e.id LIMIT 50";
    while (microtime(true) < $bis) {
        $ids = array_map('intval', array_column(db_alle($sql, ['st' => af_plan_stand()]), 'id'));
        if (!$ids) {
            break;
        }
        foreach ($ids as $id) {
            try {
                af_plan_erstellen($id);
            } catch (Throwable $e) {
                db_tun("INSERT INTO aufraeum_plaene (edition_id, status, zusammenfassung, probleme) VALUES (:e, 'fehler', :z, 1)
                        ON DUPLICATE KEY UPDATE status = 'fehler', zusammenfassung = VALUES(zusammenfassung)", ['e' => $id, 'z' => mb_substr(t('Vorschau fehlgeschlagen: {grund}', ['grund' => $e->getMessage()]), 0, 500)]);
            }
            if (microtime(true) >= $bis) {
                break 2;
            }
        }
    }
    return af_ohne_vorschau();
}

/** Alben ohne aktuelle Vorschau (nie erstellt oder mit älteren Einstellungen) */
function af_ohne_vorschau(): int
{
    return (int) db_wert("SELECT COUNT(*) FROM editionen e LEFT JOIN aufraeum_plaene p ON p.edition_id = e.id
        WHERE e.quelle IN ('musicbrainz', 'manuell') AND e.anzahl_dateien > 0
          AND (p.edition_id IS NULL OR (p.stand <> :st AND p.status IN ('offen', 'freigegeben', 'fehler')))", ['st' => af_plan_stand()]);
}

// ---------- Ausführen ----------

function af_protokoll(?int $editionId, string $art, string $von, string $nach = '', string $info = ''): void
{
    db_tun('INSERT INTO aufraeum_protokoll (edition_id, art, von, nach, info) VALUES (:e, :a, :v, :n, :i)',
        ['e' => $editionId, 'a' => $art, 'v' => mb_substr($von, 0, 2000), 'n' => mb_substr($nach, 0, 2000), 'i' => mb_substr($info, 0, 500)]);
}

/** Datei verschieben (rename, notfalls kopieren + löschen); Zielordner wird angelegt */
function af_verschieben(string $vonAbs, string $nachAbs): void
{
    musik_schreibschutz($vonAbs);
    musik_schreibschutz($nachAbs);
    if (!af_ordner_anlegen(dirname($nachAbs))) {
        $t = af_schreibtest();
        throw new RuntimeException(t('Ordner konnte nicht angelegt werden: {pfad}', ['pfad' => dirname($nachAbs)]) . ($t['ok'] ? '' : ' – ' . $t['meldung']));
    }
    if (file_exists($nachAbs) && mb_strtolower($vonAbs) !== mb_strtolower($nachAbs)) {
        throw new RuntimeException(t('Ziel existiert schon: {pfad}', ['pfad' => $nachAbs]));
    }
    if (mb_strtolower($vonAbs) === mb_strtolower($nachAbs) && $vonAbs !== $nachAbs) {
        // nur Groß-/Kleinschreibung anders: über einen Zwischennamen
        $zw = $vonAbs . '.amberwave-umbenennen';
        if (!@rename($vonAbs, $zw) || !@rename($zw, $nachAbs)) {
            throw new RuntimeException(t('Umbenennen fehlgeschlagen'));
        }
        return;
    }
    if (@rename($vonAbs, $nachAbs)) {
        af_datei_rechte($nachAbs);
        return;
    }
    if (!@copy($vonAbs, $nachAbs) || filesize($vonAbs) !== filesize($nachAbs) || !@unlink($vonAbs)) {
        @unlink($nachAbs);
        throw new RuntimeException(t('Verschieben fehlgeschlagen (Rechte?)'));
    }
    af_datei_rechte($nachAbs);
}

function af_in_papierkorb(string $rel, string $tag = ''): string
{
    $ziel = AF_PAPIERKORB . '/' . date('Y-m-d') . ($tag !== '' ? '/' . $tag : '') . '/' . $rel;
    $nachAbs = af_wurzel() . '/' . $ziel;
    for ($n = 2; file_exists($nachAbs); $n++) {
        $nachAbs = af_wurzel() . '/' . $ziel . '.' . $n;
    }
    af_verschieben(af_wurzel() . '/' . $rel, $nachAbs);
    return $ziel;
}

/** Leere Ordner von $rel aufwärts entfernen (nie die Wurzel) */
function af_leere_ordner_weg(string $rel): void
{
    $wurzel = af_wurzel();
    $abs = $wurzel . '/' . $rel;
    if ($rel === '' || $rel === '.' || !is_dir($abs)) {
        return;
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($abs, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) {
        if ($f->isDir()) {
            @rmdir($f->getPathname());
        }
    }
    while ($rel !== '' && $rel !== '.' && @rmdir($wurzel . '/' . $rel)) {
        $rel = dirname($rel);
    }
}

/** Freigegebenen Plan einer Edition ausführen */
function af_ausfuehren(int $editionId): array
{
    $p = db_zeile('SELECT * FROM aufraeum_plaene WHERE edition_id = :e', ['e' => $editionId]);
    if (!$p || $p['status'] !== 'freigegeben') {
        af_log('Ausführen abgebrochen: Plan nicht freigegeben', ['edition' => $editionId, 'status' => $p['status'] ?? '(keiner)']);
        return ['ok' => false];
    }
    if (($p['stand'] ?? '') !== af_plan_stand()) {
        af_log('Ausführen abgebrochen: Vorschau veraltet (Stand passt nicht) – wird neu gerechnet', ['edition' => $editionId, 'stand_plan' => $p['stand'] ?? '', 'stand_jetzt' => af_plan_stand()]);
        // Mit anderen Einstellungen oder älterer Programmlogik erstellt: nicht ausführen, neu rechnen, neu freigeben lassen
        af_plan_erstellen($editionId);
        db_tun("UPDATE aufraeum_plaene SET log = :l WHERE edition_id = :e",
            ['l' => t('Vorschau war veraltet (Einstellungen oder Programm geändert) und wurde neu erstellt – bitte prüfen und erneut freigeben.'), 'e' => $editionId]);
        return ['ok' => false];
    }
    // Freigabe zu alt? Dann nicht mehr still ausführen, sondern neu prüfen lassen
    $stunden = (int) (konfig()['aufraeumen']['freigabe_stunden'] ?? 12);
    if (!$p['freigegeben_am'] || strtotime((string) $p['freigegeben_am']) < time() - $stunden * 3600) {
        af_log('Ausführen abgebrochen: Freigabe abgelaufen', ['edition' => $editionId, 'freigegeben_am' => $p['freigegeben_am']]);
        db_tun("UPDATE aufraeum_plaene SET status = 'offen', freigegeben_am = NULL, log = :l WHERE edition_id = :e",
            ['l' => t('Freigabe abgelaufen (älter als {n} Stunden, nicht ausgeführt) – bitte Vorschau prüfen und erneut freigeben.', ['n' => $stunden]), 'e' => $editionId]);
        return ['ok' => false];
    }
    // Passt der Plan noch zum Album? Seit der Freigabe kann es neu eingelesen oder mit MusicBrainz abgeglichen worden sein
    // (andere Namen, andere Datei-Einträge). Dann frisch rechnen: Ist alles gleich geblieben, läuft er weiter; sonst nicht –
    // ein alter Plan würde Dateien verschieben, deren Einträge nicht mehr stimmen.
    $alt = json_decode((string) $p['plan_json'], true) ?: [];
    $kern = static fn(array $pl): string => json_encode([
        $pl['ordner_neu'] ?? '', array_map(static fn($d) => [$d['datei_id'] ?? 0, $d['von'] ?? '', $d['nach'] ?? '', $d['tags'] ?? null, $d['cover'] ?? null, $d['unterschiede'] ?? []], $pl['dateien'] ?? []),
        $pl['sonstige'] ?? [], $pl['muell'] ?? [],
    ]);
    $neuPlan = af_plan_erstellen($editionId); // setzt den Plan auf „offen“
    if ($kern($neuPlan) !== $kern($alt)) {
        af_log('Ausführen abgebrochen: Album hat sich seit der Freigabe geändert', ['edition' => $editionId]);
        db_tun("UPDATE aufraeum_plaene SET log = :l WHERE edition_id = :e",
            ['l' => t('Das Album hat sich seit der Freigabe geändert (neu eingelesen oder abgeglichen) – die Vorschau ist neu berechnet, bitte prüfen und erneut freigeben.'), 'e' => $editionId]);
        return ['ok' => false];
    }
    db_tun("UPDATE aufraeum_plaene SET status = 'freigegeben', freigegeben_am = :f WHERE edition_id = :e", ['f' => $p['freigegeben_am'], 'e' => $editionId]);
    $p = db_zeile('SELECT * FROM aufraeum_plaene WHERE edition_id = :e', ['e' => $editionId]);
    // Läuft gerade ein Titel dieses Albums (oder wurde er eben gespielt)? Dann nichts anfassen – später wieder.
    $plan = json_decode((string) $p['plan_json'], true);
    $schon = max(0, (int) konfig()['aufraeumen']['schonzeit_min']);
    $ids = array_map(static fn($d) => (int) $d['datei_id'], $plan['dateien'] ?? []);
    if ($schon > 0 && $ids && (int) db_wert('SELECT COUNT(*) FROM dateien WHERE id IN (' . implode(',', $ids) . ') AND zuletzt_gespielt > NOW() - INTERVAL ' . $schon . ' MINUTE') > 0) {
        af_log('Ausführen verschoben: Album wird gerade gespielt', ['edition' => $editionId, 'schonzeit_min' => $schon]);
        return ['ok' => false, 'spaeter' => true];
    }
    db_tun("UPDATE aufraeum_plaene SET status = 'laeuft' WHERE edition_id = :e", ['e' => $editionId]);
    af_log('Ausführen: Plan geladen', ['edition' => $editionId, 'modus_plan' => $plan['modus'] ?? '(keiner)',
        'dateien' => count($plan['dateien'] ?? []), 'ziel' => $plan['ordner_neu'] ?? '']);
    if (($plan['modus'] ?? '') !== 'verschieben') {
        // Vorschau aus einer älteren Version (Testmodus): nicht ausführen, neu rechnen lassen
        db_tun("UPDATE aufraeum_plaene SET status = 'fehler', log = :l WHERE edition_id = :e",
            ['l' => t('Vorschau veraltet – bitte neu erstellen.'), 'e' => $editionId]);
        return ['ok' => false];
    }
    $e = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $editionId]);
    $wurzel = af_wurzel();
    $log = [];
    $fehler = 0;
    $soll = tags_fuer_edition($editionId);
    $cover = af_cover($e);
    $trackVon = [];
    foreach (db_alle('SELECT id, track_id FROM dateien WHERE id IN (' . implode(',', array_map(static fn($d) => (int) $d['datei_id'], $plan['dateien']) ?: [0]) . ')') as $z) {
        $trackVon[(int) $z['id']] = (int) $z['track_id'];
    }
    // 1. Tags und Cover
    foreach ($plan['dateien'] as $d) {
        if (!$d['tags'] && !$d['cover']) {
            continue;
        }
        $abs = $wurzel . '/' . $d['von'];
        if (!is_file($abs)) {
            $log[] = '✗ ' . $d['von'] . ': ' . t('Datei fehlt');
            $fehler++;
            continue;
        }
        try {
            $r = datei_tags_schreiben($abs, $soll[$trackVon[$d['datei_id']] ?? 0] ?? [], $cover);
            af_datei_rechte($abs);
            // alte Tags sichern (zum Nachsehen/Zurückholen)
            $sicher = AF_PAPIERKORB . '/' . date('Y-m-d') . '/_alte-tags/' . $d['von'] . '.json';
            af_ordner_anlegen(dirname($wurzel . '/' . $sicher));
            @file_put_contents($wurzel . '/' . $sicher, json_encode($r['alt'], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            af_datei_rechte($wurzel . '/' . $sicher);
            af_protokoll($editionId, 'tags', $d['von'], $sicher, ($r['art'] === 'kopf' ? t('nur Kopf geschrieben') : t('Datei neu zusammengesetzt')) . ($cover ? t(', mit Cover') : ''));
            $log[] = '✓ Tags' . ($cover ? ' + Cover' : '') . ': ' . basename($d['von']);
            clearstatcache(true, $abs);
            $info = datei_lesen($abs);
            db_tun('UPDATE dateien SET mtime = :m, groesse = :g, tags_json = :t, bild_eingebettet = :b WHERE id = :id', [
                'm' => filemtime($abs), 'g' => filesize($abs), 't' => json_encode($info['tags'] ?? [], JSON_UNESCAPED_UNICODE),
                'b' => !empty($info['hat_bild']) ? 1 : 0, 'id' => $d['datei_id']]);
            db_tun('UPDATE fingerabdruecke SET datei_mtime = :m WHERE datei_id = :id', ['m' => filemtime($abs), 'id' => $d['datei_id']]);
        } catch (Throwable $ex) {
            $log[] = '✗ ' . basename($d['von']) . ': ' . $ex->getMessage();
            $fehler++;
        }
    }
    // 2. Müll in den Papierkorb
    foreach ($plan['muell'] as $m) {
        if (!is_file($wurzel . '/' . $m)) {
            continue;
        }
        try {
            $wo = af_in_papierkorb($m);
            af_protokoll($editionId, 'muell', $m, $wo);
            $log[] = '🗑 ' . $m;
        } catch (Throwable $ex) {
            $log[] = '✗ ' . $m . ': ' . $ex->getMessage();
            $fehler++;
        }
    }
    // 3. Umbenennen / verschieben
    $neuOrdner = $plan['ordner_neu'];
    $basisHash = hash('sha256', $neuOrdner);
    foreach ($plan['dateien'] as $d) {
        if (!$d['nach']) {
            continue;
        }
        try {
            af_verschieben($wurzel . '/' . $d['von'], $wurzel . '/' . $d['nach']);
            db_tun('UPDATE dateien SET pfad = :p, pfad_hash = :h, ordner_hash = :o WHERE id = :id',
                ['p' => $d['nach'], 'h' => hash('sha256', $d['nach']), 'o' => $basisHash, 'id' => $d['datei_id']]);
            af_protokoll($editionId, 'umbenannt', $d['von'], $d['nach']);
        } catch (Throwable $ex) {
            $log[] = '✗ ' . $d['von'] . ': ' . $ex->getMessage();
            $fehler++;
        }
    }
    foreach ($plan['sonstige'] as $s) {
        try {
            if (is_file($wurzel . '/' . $s['von'])) {
                af_verschieben($wurzel . '/' . $s['von'], $wurzel . '/' . $s['nach']);
                af_protokoll($editionId, 'umbenannt', $s['von'], $s['nach']);
            }
        } catch (Throwable $ex) {
            $log[] = '✗ ' . $s['von'] . ': ' . $ex->getMessage();
            $fehler++;
        }
    }
    if ($plan['ordner_alt'] !== $neuOrdner) {
        $alt = $plan['geteilt'] ? array_values(array_unique(array_map(static fn($d) => dirname($d['von']), $plan['dateien']))) : [$plan['ordner_alt']];
        foreach ($alt as $o) {
            af_leere_ordner_weg($o);
        }
        $album = (string) ($e['titel'] ?: db_wert('SELECT titel FROM alben WHERE id = :a', ['a' => $e['album_id']]));
        $tn = name_norm(scan_albumtitel_bereinigen($album)) ?: mb_strtolower($album);
        db_tun('UPDATE editionen SET ordner = :o, ordner_hash = :oh, gruppe_hash = :g WHERE id = :id',
            ['o' => $neuOrdner, 'oh' => $basisHash, 'g' => hash('sha256', $neuOrdner . '||' . $tn), 'id' => $editionId]);
        $log[] = '📁 ' . $plan['ordner_alt'] . ' → ' . $neuOrdner;
    }
    db_tun('UPDATE aufraeum_plaene SET status = :s, ausgefuehrt_am = NOW(), log = :l WHERE edition_id = :e',
        ['s' => $fehler ? 'fehler' : 'fertig', 'l' => implode("\n", $log), 'e' => $editionId]);
    return ['ok' => !$fehler, 'log' => $log];
}

/** Alle freigegebenen Pläne abarbeiten (Hintergrund) */
function af_stapel(): int
{
    $h = fopen(af_sperre_pfad(), 'c');
    if (!$h || !flock($h, LOCK_EX | LOCK_NB)) {
        af_log('Stapel: Sperre belegt oder nicht aufzumachen – breche ab', ['datei_offen' => (bool) $h]);
        return 0;
    }
    $offen = (int) db_wert("SELECT COUNT(*) FROM aufraeum_plaene WHERE status = 'freigegeben'");
    af_log('Stapel gestartet', ['freigegebene_plaene' => $offen]);
    $n = 0;
    $spaeter = [0];
    try {
        while (($id = (int) db_wert("SELECT edition_id FROM aufraeum_plaene WHERE status = 'freigegeben' AND edition_id NOT IN (" . implode(',', $spaeter) . ') ORDER BY edition_id LIMIT 1')) > 0) {
            if (scan_laufend()) {
                af_log('Stapel pausiert: Einlesen (Scan) läuft gerade – Aufräumen wartet');
                break; // nicht gleichzeitig mit dem Einlesen
            }
            af_log('Stapel: bearbeite Edition', ['edition' => $id]);
            try {
                $r = af_ausfuehren($id);
                af_log('Stapel: Edition fertig', ['edition' => $id, 'ergebnis' => $r]);
                if (!empty($r['spaeter'])) {
                    $spaeter[] = $id; // bleibt freigegeben, kommt beim nächsten Lauf dran
                    continue;
                }
            } catch (Throwable $e) {
                af_log('FEHLER beim Ausführen', ['edition' => $id, 'meldung' => $e->getMessage(), 'datei' => basename($e->getFile()), 'zeile' => $e->getLine()]);
                db_tun("UPDATE aufraeum_plaene SET status = 'fehler', log = :l WHERE edition_id = :e", ['l' => $e->getMessage(), 'e' => $id]);
            }
            $n++;
        }
    } finally {
        flock($h, LOCK_UN);
        fclose($h);
    }
    af_log('Stapel beendet', ['bearbeitet' => $n]);
    return $n;
}

/** Papierkorb: Tagesordner älter als AUFRAEUMEN_PAPIERKORB_TAGE löschen */
function af_papierkorb_leeren(bool $alles = false): int
{
    $basis = af_wurzel() . '/' . AF_PAPIERKORB;
    if (!is_dir($basis)) {
        return 0;
    }
    $grenze = date('Y-m-d', time() - max(1, konfig()['aufraeumen']['papierkorb_tage']) * 86400);
    $n = 0;
    foreach (scandir($basis) ?: [] as $tag) {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $tag) || (!$alles && $tag >= $grenze)) {
            continue;
        }
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($basis . '/' . $tag, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $f) {
            $f->isDir() ? @rmdir($f->getPathname()) : (@unlink($f->getPathname()) && $n++);
        }
        @rmdir($basis . '/' . $tag);
    }
    return $n;
}

function af_papierkorb_groesse(): array
{
    $basis = af_wurzel() . '/' . AF_PAPIERKORB;
    $n = 0;
    $b = 0;
    if (is_dir($basis)) {
        foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($basis, FilesystemIterator::SKIP_DOTS)) as $f) {
            if ($f->isFile()) {
                $n++;
                $b += $f->getSize();
            }
        }
    }
    return ['dateien' => $n, 'bytes' => $b];
}

function af_stand(): array
{
    $status = [];
    foreach (db_alle('SELECT status, COUNT(*) AS n FROM aufraeum_plaene GROUP BY status') as $z) {
        $status[$z['status']] = (int) $z['n'];
    }
    $liste = db_alle("SELECT p.edition_id, p.status, (p.stand <> :st AND p.status IN ('offen', 'freigegeben', 'fehler')) AS veraltet, p.log, p.zusammenfassung, p.aenderungen, p.probleme, p.ausgefuehrt_am, e.album_id, e.ordner, a.titel AS album_titel, COALESCE(c.anzeige, '') AS kuenstler,
            (e.mbid IS NULL OR e.mbid = '') AS ohne_mb
        FROM aufraeum_plaene p JOIN editionen e ON e.id = p.edition_id JOIN alben a ON a.id = e.album_id LEFT JOIN credits c ON c.id = a.credit_id
        ORDER BY FIELD(p.status, 'laeuft', 'freigegeben', 'offen', 'fehler', 'fertig'), (p.aenderungen > 0) DESC, a.titel LIMIT 1000", ['st' => af_plan_stand()]);
    foreach ($liste as &$l) {
        $l['veraltet'] = (bool) $l['veraltet'];
        $l['ohne_mb'] = (bool) $l['ohne_mb'];
        foreach (['edition_id', 'album_id', 'aenderungen', 'probleme'] as $f) {
            $l[$f] = (int) $l[$f];
        }
    }
    unset($l);
    $offen = af_ohne_vorschau();
    $k = konfig()['aufraeumen'];
    static $test = null; // pro Anfrage einmal
    $test ??= af_schreibtest();
    return ['status' => $status, 'liste' => $liste, 'ohne_vorschau' => $offen, 'laeuft' => af_laeuft(), 'schreibtest' => $test,
        'schema' => ['ordner' => $k['ordner'], 'datei' => $k['datei'], 'cover' => $k['cover'], 'papierkorb_tage' => $k['papierkorb_tage'],
            'tags' => $k['tags'], 'behalten' => $k['behalten'],
            'rechte' => sprintf('%o/%o', $k['rechte_ordner'], $k['rechte_datei'])],
        'papierkorb' => af_papierkorb_groesse()];
}
