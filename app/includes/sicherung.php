<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/../scripts/migrate.php';

/**
 * Backup vor jedem Update (immer nur das letzte): Datenbank-Dump in reinem PHP + Code-Stand als ZIP.
 * Die Musik, Cover und die .env sind nicht Teil des Codes und werden von Updates nie berührt.
 */

function datenbank_dump(string $ziel): void
{
    $pdo = db();
    $f = gzopen($ziel, 'wb6');
    if (!$f) {
        throw new RuntimeException(t('Dump-Datei nicht beschreibbar: {pfad}', ['pfad' => $ziel]));
    }
    gzwrite($f, "-- Amberwave Datenbank-Sicherung " . date('c') . "\nSET FOREIGN_KEY_CHECKS=0;\nSET NAMES utf8mb4;\n\n");
    foreach ($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) as $tabelle) {
        $tabelle = (string) $tabelle;
        if (!preg_match('/^[A-Za-z0-9_]+$/', $tabelle)) {
            continue;
        }
        $create = $pdo->query("SHOW CREATE TABLE `{$tabelle}`")->fetch(PDO::FETCH_NUM);
        gzwrite($f, "DROP TABLE IF EXISTS `{$tabelle}`;\n" . $create[1] . ";\n\n");
        $stmt = $pdo->query("SELECT * FROM `{$tabelle}`", PDO::FETCH_NUM);
        $puffer = [];
        $spalten = null;
        while ($z = $stmt->fetch(PDO::FETCH_NUM)) {
            $puffer[] = '(' . implode(',', array_map(static fn($w) => $w === null ? 'NULL' : (is_int($w) || is_float($w) ? (string) $w : $pdo->quote((string) $w)), $z)) . ')';
            if (count($puffer) >= 200) {
                gzwrite($f, "INSERT INTO `{$tabelle}` VALUES\n" . implode(",\n", $puffer) . ";\n");
                $puffer = [];
            }
        }
        if ($puffer) {
            gzwrite($f, "INSERT INTO `{$tabelle}` VALUES\n" . implode(",\n", $puffer) . ";\n");
        }
        gzwrite($f, "\n");
    }
    gzwrite($f, "SET FOREIGN_KEY_CHECKS=1;\n");
    gzclose($f);
}

// ---------- Tägliche Datensicherung ----------
// Liegt unter <Backup-Ordner>/datenbank: taeglich_* (Zeitplan), hand_* (Knopf „Jetzt sichern“),
// vor-wiederherstellung_* (automatisch direkt vor jeder Wiederherstellung). Die Update-Sicherung im Hauptordner
// (amberwave_*_datenbank.sql.gz) wird mit angezeigt und kann ebenfalls zurückgespielt werden.
// Aufbewahrung: die letzten SICHERUNG_TAGE täglichen + je Woche die letzte für weitere SICHERUNG_WOCHEN Wochen;
// Sicherungen von Hand bleiben, bis du sie löschst; vor einer Wiederherstellung angelegte: die letzten 3.

const SICHERUNG_ARTEN = ['taeglich' => 'Täglich', 'hand' => 'Von Hand', 'vor-wiederherstellung' => 'Vor Wiederherstellung', 'update' => 'Vor Update'];
const SICHERUNG_KOPF = '-- Amberwave Datenbank-Sicherung';

function sicherung_ordner(): string
{
    $o = konfig()['pfade']['backups'] . '/datenbank';
    if (!is_dir($o) && !@mkdir($o, 0770, true)) {
        throw new RuntimeException(t('Backup-Ordner nicht vorhanden/beschreibbar: {pfad}', ['pfad' => $o]));
    }
    return $o;
}

function sicherung_sperrdatei(): string
{
    $o = konfig()['pfade']['cache'] . '/tmp';
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return $o . '/wiederherstellung.lock';
}

/** Läuft gerade eine Wiederherstellung? (Zeitplan und Aufträge warten dann) */
function sicherung_wiederherstellung_laeuft(): bool
{
    $d = sicherung_sperrdatei();
    if (!is_file($d)) {
        return false;
    }
    if (time() - (int) @filemtime($d) > 6 * 3600) { // liegengebliebene Sperre (Absturz) nach 6 h ignorieren
        @unlink($d);
        return false;
    }
    return true;
}

/** Alle vorhandenen Datenbank-Sicherungen, neueste zuerst. name = Kennung für die Oberfläche. */
function sicherung_liste(): array
{
    $l = [];
    foreach (glob(sicherung_ordner() . '/*.sql.gz') ?: [] as $p) {
        if (preg_match('/^(taeglich|hand|vor-wiederherstellung)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.sql\.gz$/', basename($p), $m)) {
            $l[] = ['name' => basename($p), 'art' => $m[1], 'zeit' => strtotime("{$m[2]} {$m[3]}:{$m[4]}:{$m[5]}"), 'groesse' => (int) filesize($p), 'pfad' => $p];
        }
    }
    foreach (glob(konfig()['pfade']['backups'] . '/amberwave_*_datenbank.sql.gz') ?: [] as $p) {
        if (preg_match('/^amberwave_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_datenbank\.sql\.gz$/', basename($p), $m)) {
            $l[] = ['name' => 'update/' . basename($p), 'art' => 'update', 'zeit' => strtotime("{$m[1]} {$m[2]}:{$m[3]}:{$m[4]}"), 'groesse' => (int) filesize($p), 'pfad' => $p];
        }
    }
    usort($l, static fn($a, $b) => $b['zeit'] <=> $a['zeit'] ?: strcmp($b['name'], $a['name']));
    return $l;
}

/** Nur Namen aus der Liste sind erlaubt (kein Pfad von außen) */
function sicherung_finden(string $name): ?array
{
    foreach (sicherung_liste() as $s) {
        if ($s['name'] === $name) {
            return $s;
        }
    }
    return null;
}

function sicherung_erstellen(string $art): array
{
    if (!in_array($art, ['taeglich', 'hand', 'vor-wiederherstellung'], true)) {
        throw new InvalidArgumentException('Unbekannte Art');
    }
    $ordner = sicherung_ordner();
    $name = $art . '_' . date('Y-m-d_H-i-s') . '.sql.gz';
    $teil = $ordner . '/.' . $name . '.teil';
    try {
        datenbank_dump($teil);
        if (!rename($teil, $ordner . '/' . $name)) { // erst fertig geschrieben, dann sichtbar
            throw new RuntimeException(t('Sicherung konnte nicht abgelegt werden.'));
        }
    } finally {
        @unlink($teil);
    }
    $geloescht = sicherung_aufraeumen();
    return ['name' => $name, 'groesse' => (int) filesize($ordner . '/' . $name), 'geloescht' => $geloescht];
}

/** Welche Sicherungen behalten werden (Liste der Namen); alles andere der Arten taeglich/vor-wiederherstellung darf weg */
function sicherung_behalten(array $liste, int $tage, int $wochen): array
{
    $behalten = [];
    $taeglich = array_values(array_filter($liste, static fn($s) => $s['art'] === 'taeglich'));
    foreach (array_slice($taeglich, 0, max(1, $tage)) as $s) {
        $behalten[$s['name']] = true;
    }
    // je Kalenderwoche die letzte, für die Wochen nach den täglich aufbewahrten
    $grenze = $taeglich ? $taeglich[min(count($taeglich), max(1, $tage)) - 1]['zeit'] : PHP_INT_MAX;
    $kw = [];
    foreach ($taeglich as $s) {
        if (isset($behalten[$s['name']])) {
            $kw[date('o-W', $s['zeit'])] = true; // Woche ist durch die täglichen schon abgedeckt
            continue;
        }
        $w = date('o-W', $s['zeit']);
        if (!isset($kw[$w]) && $s['zeit'] < $grenze && count(array_filter($behalten, static fn($v) => $v === 'woche')) < $wochen) {
            $kw[$w] = true;
            $behalten[$s['name']] = 'woche';
        }
    }
    $vor = array_values(array_filter($liste, static fn($s) => $s['art'] === 'vor-wiederherstellung'));
    foreach (array_slice($vor, 0, 3) as $s) {
        $behalten[$s['name']] = true;
    }
    foreach ($liste as $s) {
        if (in_array($s['art'], ['hand', 'update'], true)) {
            $behalten[$s['name']] = true;
        }
    }
    return $behalten;
}

function sicherung_aufraeumen(): int
{
    $liste = sicherung_liste();
    $behalten = sicherung_behalten($liste, (int) einstellung('sicherung_tage'), (int) einstellung('sicherung_wochen'));
    $n = 0;
    foreach ($liste as $s) {
        if (!isset($behalten[$s['name']]) && in_array($s['art'], ['taeglich', 'vor-wiederherstellung'], true) && @unlink($s['pfad'])) {
            $n++;
        }
    }
    foreach (glob(sicherung_ordner() . '/.*.teil') ?: [] as $t) { // Reste abgebrochener Läufe
        if (time() - (int) filemtime($t) > 6 * 3600) {
            @unlink($t);
        }
    }
    return $n;
}

/** Liest einen Dump und liefert die Anweisungen nacheinander (Anweisung endet mit „;“ am Zeilenende). */
function sicherung_anweisungen(string $pfad): Generator
{
    $f = gzopen($pfad, 'rb');
    if (!$f) {
        throw new RuntimeException(t('Sicherung nicht lesbar.'));
    }
    try {
        $puffer = '';
        while (($zeile = gzgets($f)) !== false) {
            if ($puffer === '' && (trim($zeile) === '' || str_starts_with($zeile, '--'))) {
                continue;
            }
            $puffer .= $zeile;
            if (str_ends_with(rtrim($zeile, "\r\n"), ';')) {
                yield rtrim($puffer, ";\r\n");
                $puffer = '';
            }
        }
        if (trim($puffer) !== '') {
            throw new RuntimeException(t('Sicherung endet mitten in einer Anweisung – Datei unvollständig.'));
        }
    } finally {
        gzclose($f);
    }
}

/** Prüft eine Sicherung vollständig, bevor irgendetwas angefasst wird. Liefert die enthaltenen Tabellen. */
function sicherung_pruefen(string $pfad): array
{
    $f = @gzopen($pfad, 'rb');
    $kopf = $f ? (string) gzgets($f) : '';
    if ($f) {
        gzclose($f);
    }
    if (!str_starts_with($kopf, SICHERUNG_KOPF)) {
        throw new RuntimeException(t('Das ist keine Amberwave-Datenbanksicherung.'));
    }
    $tabellen = [];
    $zeilen = [];
    $letzte = '';
    $sicherungVersion = 0;
    foreach (sicherung_anweisungen($pfad) as $a) {
        if (preg_match('/^DROP TABLE IF EXISTS `([A-Za-z0-9_]+)`$/', $a, $m)) {
            $tabellen[] = $m[1];
            $zeilen[$m[1]] = 0;
        } elseif (preg_match('/^INSERT INTO `([A-Za-z0-9_]+)` VALUES\n/', $a, $m)) {
            $zeilen[$m[1]] = ($zeilen[$m[1]] ?? 0) + substr_count($a, "),\n(") + 1;
            if ($m[1] === 'schema_version' && preg_match_all('/\((\d+),/', $a, $v)) {
                $sicherungVersion = max($sicherungVersion, ...array_map('intval', $v[1]));
            }
        }
        $letzte = $a;
    }
    if ($letzte !== 'SET FOREIGN_KEY_CHECKS=1') {
        throw new RuntimeException(t('Die Sicherung ist unvollständig (Ende fehlt) – sie wird nicht eingespielt.'));
    }
    if ($sicherungVersion > migrationen_code_version()) {
        throw new RuntimeException(t('Diese Sicherung stammt von einer neueren Amberwave-Version (Schema {sicherung}, diese App kennt {app}) – sie wird nicht eingespielt. Bitte zuerst die neuere App-Version einspielen.', ['sicherung' => $sicherungVersion, 'app' => migrationen_code_version()]));
    }
    foreach (['users', 'einstellungen', 'schema_version'] as $pflicht) {
        if (!in_array($pflicht, $tabellen, true)) {
            throw new RuntimeException(t('Die Sicherung enthält die Tabelle „{tabelle}“ nicht – sie wird nicht eingespielt.', ['tabelle' => $pflicht]));
        }
    }
    return ['tabellen' => $tabellen, 'zeilen' => $zeilen];
}

/** Spielt einen geprüften Dump ein: Tabellen, die es in der Sicherung nicht gibt, werden entfernt (sonst scheitern spätere Migrationen). */
function sicherung_einspielen(string $pfad, array $tabellen): void
{
    $pdo = db();
    $pdo->exec('SET FOREIGN_KEY_CHECKS=0');
    try {
        foreach ($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) as $t) {
            if (!in_array((string) $t, $tabellen, true) && preg_match('/^[A-Za-z0-9_]+$/', (string) $t)) {
                $pdo->exec("DROP TABLE `{$t}`");
            }
        }
        foreach (sicherung_anweisungen($pfad) as $a) {
            $pdo->exec($a);
        }
    } finally {
        $pdo->exec('SET FOREIGN_KEY_CHECKS=1');
    }
}

/**
 * Wiederherstellung: 1. Sicherung vollständig prüfen, 2. aktuellen Stand sichern (vor-wiederherstellung_*),
 * 3. laufende Aufträge anhalten, 4. einspielen, 5. ausstehende Migrationen (ältere Sicherung), 6. Aufträge fortsetzen.
 * Schlägt das Einspielen fehl, wird automatisch der eben gesicherte Stand zurückgespielt.
 */
/** Datum und Uhrzeit für Meldungen, nach Sprache (de: 24.10.2026, 14:30 · en: 24 Oct 2026, 14:30) */
function sicherung_datum(int $ts): string
{
    return date(sprache() === 'en' ? 'd M Y, H:i' : 'd.m.Y, H:i', $ts);
}

function sicherung_wiederherstellen(string $name, array &$log): bool
{
    require_once __DIR__ . '/auftrag.php';
    $s = sicherung_finden($name);
    if (!$s) {
        $log[] = t('Sicherung nicht gefunden.');
        return false;
    }
    if (sicherung_wiederherstellung_laeuft()) {
        $log[] = t('Es läuft bereits eine Wiederherstellung.');
        return false;
    }
    try {
        $inhalt = sicherung_pruefen($s['pfad']);
    } catch (Throwable $e) {
        $log[] = $e->getMessage();
        return false;
    }
    $log[] = t('Sicherung geprüft: {n} Tabellen, vollständig.', ['n' => count($inhalt['tabellen'])]);
    try {
        $vorher = sicherung_erstellen('vor-wiederherstellung');
        $log[] = t('Aktueller Stand gesichert als {name} – damit lässt sich die Wiederherstellung rückgängig machen.', ['name' => $vorher['name']]);
    } catch (Throwable $e) {
        $log[] = t('Der aktuelle Stand konnte nicht gesichert werden ({fehler}) – abgebrochen, nichts verändert.', ['fehler' => $e->getMessage()]);
        return false;
    }
    file_put_contents(sicherung_sperrdatei(), (string) getmypid());
    $angehalten = [];
    foreach (AUFTRAG_TYPEN as $typ) {
        if (auftrag_zustand($typ)['status'] === 'laeuft') {
            auftrag_anhalten($typ);
            $angehalten[] = $typ;
        }
    }
    // laufende Prozesse kurz ausklingen lassen
    for ($i = 0; $i < 20 && array_filter(AUFTRAG_TYPEN, 'auftrag_prozess_laeuft'); $i++) {
        sleep(1);
    }
    $ok = true;
    try {
        sicherung_einspielen($s['pfad'], $inhalt['tabellen']);
        $log[] = t('Datenbank auf den Stand vom {datum} zurückgesetzt.', ['datum' => sicherung_datum((int) $s['zeit'])]);
        $neu = migrationen_ausfuehren();
        if ($neu) {
            $log[] = t('Auf die aktuelle Version gebracht: {liste}', ['liste' => implode(', ', $neu)]);
        }
    } catch (Throwable $e) {
        $ok = false;
        $log[] = t('Einspielen fehlgeschlagen: {fehler}', ['fehler' => $e->getMessage()]);
        try {
            $vp = sicherung_ordner() . '/' . $vorher['name'];
            sicherung_einspielen($vp, sicherung_pruefen($vp)['tabellen']);
            migrationen_ausfuehren();
            $log[] = t('Der vorherige Stand wurde wiederhergestellt – es ist nichts verloren.');
        } catch (Throwable $e2) {
            $log[] = t('ACHTUNG: Auch der vorherige Stand ließ sich nicht automatisch zurückspielen ({fehler}). Er liegt als {name} im Backup-Ordner.', ['fehler' => $e2->getMessage(), 'name' => $vorher['name']]);
        }
    } finally {
        foreach ($angehalten as $typ) {
            auftrag_aendern($typ, static function ($z) {
                if ($z['status'] === 'angehalten') {
                    $z['status'] = 'laeuft';
                    $z['meldung'] = '';
                }
                return $z;
            });
        }
        @unlink(sicherung_sperrdatei());
    }
    return $ok;
}

function code_zip(string $code_dir, string $ziel): void
{
    $zip = new ZipArchive();
    if ($zip->open($ziel, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        throw new RuntimeException(t('Code-Sicherung konnte nicht angelegt werden.'));
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($code_dir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $datei) {
        $rel = substr((string) $datei, strlen($code_dir) + 1);
        if ($datei->isFile()) {
            $zip->addFile((string) $datei, 'app/' . $rel);
        }
    }
    $zip->close();
}

function backup_erstellen(array &$log): string
{
    $ordner = konfig()['pfade']['backups'];
    if (!is_dir($ordner) && !@mkdir($ordner, 0770, true)) {
        throw new RuntimeException(t('Backup-Ordner nicht vorhanden/beschreibbar: {pfad}', ['pfad' => $ordner]));
    }
    foreach (glob($ordner . '/amberwave_*') ?: [] as $alt) {
        @unlink($alt); // nur das letzte Backup wird aufgehoben
    }
    $stempel = date('Y-m-d_H-i-s');
    $db = $ordner . "/amberwave_{$stempel}_datenbank.sql.gz";
    datenbank_dump($db);
    $log[] = t('Datenbank gesichert ({kb} KB).', ['kb' => round(filesize($db) / 1024)]);
    $code = $ordner . "/amberwave_{$stempel}_code.zip";
    code_zip(dirname(__DIR__), $code);
    $log[] = t('Code gesichert.');
    return $stempel;
}

/**
 * Update-Archiv einspielen. Akzeptiert ein ZIP, das "app/…" enthält (auch "amberwave/app/…").
 * Schutz gegen Pfade außerhalb des Code-Ordners (Zip-Slip).
 */
function update_einspielen(string $zipdatei, array &$log): bool
{
    $zip = new ZipArchive();
    if ($zip->open($zipdatei) !== true) {
        $log[] = t('Archiv konnte nicht geöffnet werden.');
        return false;
    }
    // Präfix bis einschließlich "app/" finden
    $praefix = null;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $n = (string) $zip->getNameIndex($i);
        if (preg_match('#^((?:[^/]+/)?app/)index\.php$#', $n, $m)) {
            $praefix = $m[1];
            break;
        }
    }
    if ($praefix === null) {
        $zip->close();
        $log[] = t('Das Archiv enthält keinen Ordner "app" mit index.php – ist es wirklich ein Amberwave-Update?');
        return false;
    }
    try {
        backup_erstellen($log);
    } catch (Throwable $e) {
        $zip->close();
        $log[] = t('Backup fehlgeschlagen: {fehler} – Update abgebrochen, nichts verändert.', ['fehler' => $e->getMessage()]);
        return false;
    }
    $code_dir = dirname(__DIR__);
    $n_dateien = 0;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = (string) $zip->getNameIndex($i);
        if (!str_starts_with($name, $praefix) || str_ends_with($name, '/')) {
            continue;
        }
        $rel = substr($name, strlen($praefix));
        if ($rel === '' || str_contains($rel, '..') || str_starts_with($rel, '/') || str_contains($rel, "\0") || preg_match('#(^|/)\.env$#', $rel)) {
            continue;
        }
        $ziel = $code_dir . '/' . $rel;
        if (!is_dir(dirname($ziel)) && !@mkdir(dirname($ziel), 0775, true)) {
            $log[] = t('Ordner nicht anlegbar: {pfad}', ['pfad' => dirname($rel)]);
            continue;
        }
        $inhalt = $zip->getFromIndex($i);
        if ($inhalt === false || file_put_contents($ziel . '.neu', $inhalt) === false || !rename($ziel . '.neu', $ziel)) {
            $log[] = t('Datei nicht schreibbar: {pfad}', ['pfad' => $rel]);
            continue;
        }
        $n_dateien++;
    }
    $zip->close();
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }
    $log[] = t('Code aktualisiert ({n} Dateien).', ['n' => $n_dateien]);
    try {
        $neu = migrationen_ausfuehren();
        $log[] = $neu ? t('Datenbank-Migrationen angewendet: {liste}', ['liste' => implode(', ', $neu)]) : t('Keine Datenbank-Migrationen nötig.');
    } catch (Throwable $e) {
        $log[] = t('Migration fehlgeschlagen: {fehler} – Backup liegt im Backup-Ordner.', ['fehler' => $e->getMessage()]);
        return false;
    }
    return true;
}
