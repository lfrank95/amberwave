<?php
declare(strict_types=1);

require_once __DIR__ . '/../includes/i18n.php';
require_once __DIR__ . '/../includes/db.php';

/** Die Datenbank gehört zu einer neueren Amberwave-Version als dieser Code – nichts anfassen */
class SchemaZuNeu extends RuntimeException
{
}

/** Höchste Schema-Version, die dieser Code kennt (größte Nummer unter /migrations) */
function migrationen_code_version(): int
{
    $max = 0;
    foreach (array_merge(glob(__DIR__ . '/../migrations/*.sql') ?: [], glob(__DIR__ . '/../migrations/*.php') ?: []) as $d) {
        if (preg_match('/^(\d+)_/', basename($d), $t)) {
            $max = max($max, (int) $t[1]);
        }
    }
    return $max;
}

function schema_zu_neu_text(int $db, int $code): string
{
    return t('Die Datenbank gehört zu einer neueren Amberwave-Version (Schema {db}, diese App kennt nur {code}). ', ['db' => $db, 'code' => $code])
        . t('Zum Schutz deiner Daten startet diese ältere Version nicht und ändert nichts. ')
        . t('Bitte die neuere App-Version einspielen (Ordner app/ ersetzen und neu starten) – oder bewusst zurück: erst eine Sicherung dieser älteren Version wiederherstellen.');
}

/**
 * Wendet alle Migrationen in /migrations an, die noch nicht in schema_version stehen.
 * Dateien heißen NNN_name.sql (reines SQL) oder NNN_name.php (bekommt $pdo).
 * Gibt die neu angewendeten Versionsnummern zurück.
 */
function migrationen_ausfuehren(): array
{
    $pdo = db();
    // Nur ein Prozess gleichzeitig migriert (mehrere Seitenaufrufe direkt nach einem Update)
    $sperre = false;
    try {
        $sperre = (int) $pdo->query("SELECT GET_LOCK('amberwave_migration', 30)")->fetchColumn() === 1;
    } catch (Throwable $e) {
    }
    try {
        return migrationen_ausfuehren_intern($pdo);
    } finally {
        if ($sperre) {
            try { $pdo->query("SELECT RELEASE_LOCK('amberwave_migration')"); } catch (Throwable $e) {}
        }
    }
}

function migrationen_ausfuehren_intern(PDO $pdo): array
{
    $vorhanden = (bool) $pdo->query("SHOW TABLES LIKE 'schema_version'")->fetch();
    $angewendet = $vorhanden ? array_map('intval', $pdo->query('SELECT version FROM schema_version')->fetchAll(PDO::FETCH_COLUMN)) : [];

    // Harte Sperre: Datenbank neuer als dieser Code → nicht anfassen (alte Version kennt neue Spalten und Daten nicht)
    $dbVersion = $angewendet ? max($angewendet) : 0;
    $codeVersion = migrationen_code_version();
    if ($dbVersion > $codeVersion) {
        throw new SchemaZuNeu(schema_zu_neu_text($dbVersion, $codeVersion));
    }

    $dateien = array_merge(glob(__DIR__ . '/../migrations/*.sql') ?: [], glob(__DIR__ . '/../migrations/*.php') ?: []);
    usort($dateien, static fn($a, $b) => strnatcmp(basename($a), basename($b)));

    $neu = [];
    foreach ($dateien as $datei) {
        if (!preg_match('/^(\d+)_/', basename($datei), $t)) {
            continue;
        }
        $version = (int) $t[1];
        if (in_array($version, $angewendet, true)) {
            continue;
        }
        // Hinweis: DDL beendet bei MySQL/MariaDB jede Transaktion von selbst. Deshalb hier keine Transaktion;
        // alle Migrationen sind so geschrieben, dass ein erneuter Lauf nichts kaputt macht (IF NOT EXISTS, INSERT IGNORE).
        try {
            if (str_ends_with($datei, '.sql')) {
                $sql = (string) file_get_contents($datei);
                $sql = preg_replace('/^\s*--.*$/m', '', $sql) ?? $sql;
                foreach (array_filter(array_map('trim', explode(';', $sql))) as $statement) {
                    $pdo->exec($statement);
                }
            } else {
                (static function () use ($datei, $pdo): void {
                    require $datei;
                })();
            }
            $pdo->exec('CREATE TABLE IF NOT EXISTS schema_version (version INT NOT NULL PRIMARY KEY, angewendet_am DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
            $pdo->prepare('INSERT IGNORE INTO schema_version (version) VALUES (:v)')->execute(['v' => $version]);
            $neu[] = $version;
        } catch (Throwable $e) {
            throw new RuntimeException(t('Migration {version} ({datei}) fehlgeschlagen: {fehler}', ['version' => $version, 'datei' => basename($datei), 'fehler' => $e->getMessage()]));
        }
    }
    return $neu;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === realpath(__FILE__)) {
    try {
        $r = migrationen_ausfuehren();
    } catch (SchemaZuNeu $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(2);
    }
    echo $r ? 'Angewendet: ' . implode(', ', $r) . "\n" : "Keine neuen Migrationen.\n";
}
