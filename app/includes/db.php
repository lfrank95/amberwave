<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

/** Eine gemeinsame PDO-Verbindung pro Request (echte Prepared Statements, kein Emulieren). */
function db(): PDO
{
    $pdo = &$GLOBALS['__aw_pdo'];
    if ($pdo !== null) {
        return $pdo;
    }
    $c = konfig()['db'];
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['host'], $c['port'], $c['name']);
    $optionen = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ];
    // Entwickler-Messung (SQL_PROFIL=Datei): Anzahl und Dauer aller Abfragen je Request in diese Datei schreiben
    $profil = (string) getenv('SQL_PROFIL');
    if ($profil !== '') {
        $optionen[PDO::ATTR_STATEMENT_CLASS] = [DbProfilStatement::class, []];
        register_shutdown_function(static fn() => DbProfilStatement::schreiben($profil));
    }
    $pdo = new PDO($dsn, $c['user'], $c['password'], $optionen);
    // Zeitzone der Sitzung = Zeitzone von PHP, damit NOW() und date() übereinstimmen
    $pdo->exec("SET time_zone = '" . (new DateTime())->format('P') . "'");
    return $pdo;
}

/** Verbindung schließen, z. B. bevor ein Stream minutenlang Daten schickt (der nächste db()-Aufruf öffnet neu) */
function db_schliessen(): void
{
    $GLOBALS['__aw_pdo'] = null;
}

/** Nur für Messungen (SQL_PROFIL): misst jede ausgeführte Anweisung */
class DbProfilStatement extends PDOStatement
{
    public static array $liste = [];
    protected function __construct() {}
    public function execute(?array $params = null): bool
    {
        $t = hrtime(true);
        try {
            return parent::execute($params);
        } finally {
            $sql = preg_replace('/\s+/', ' ', $this->queryString);
            $e = &self::$liste[$sql];
            $e = ['n' => ($e['n'] ?? 0) + 1, 'ms' => ($e['ms'] ?? 0) + (hrtime(true) - $t) / 1e6];
        }
    }
    public static function schreiben(string $datei): void
    {
        $n = array_sum(array_column(self::$liste, 'n'));
        $ms = array_sum(array_column(self::$liste, 'ms'));
        uasort(self::$liste, static fn($a, $b) => $b['ms'] <=> $a['ms']);
        $kopf = sprintf("%s %s  %d Abfragen  %.0f ms\n", $_SERVER['REQUEST_METHOD'] ?? 'CLI', $_SERVER['REQUEST_URI'] ?? implode(' ', $GLOBALS['argv'] ?? []), $n, $ms);
        $zeilen = '';
        foreach (array_slice(self::$liste, 0, 6, true) as $sql => $e) {
            $zeilen .= sprintf("    %6.0f ms %5dx  %s\n", $e['ms'], $e['n'], mb_substr($sql, 0, 160));
        }
        @file_put_contents($datei, $kopf . $zeilen, FILE_APPEND | LOCK_EX);
    }
}

/** Führt eine Anweisung aus und liefert die Zahl der betroffenen Zeilen. */
function db_tun(string $sql, array $p = []): int
{
    $st = db()->prepare($sql);
    $st->execute($p);
    return $st->rowCount();
}

/** INSERT ausführen und die neue ID liefern. */
function db_einfuegen(string $sql, array $p = []): int
{
    db_tun($sql, $p);
    return (int) db()->lastInsertId();
}

/** Erster Wert der ersten Zeile (oder null). */
function db_wert(string $sql, array $p = []): mixed
{
    $st = db()->prepare($sql);
    $st->execute($p);
    $w = $st->fetchColumn();
    return $w === false ? null : $w;
}

/** Erste Zeile als Array (oder null). */
function db_zeile(string $sql, array $p = []): ?array
{
    $st = db()->prepare($sql);
    $st->execute($p);
    $z = $st->fetch();
    return $z === false ? null : $z;
}

/** Alle Zeilen. */
function db_alle(string $sql, array $p = []): array
{
    $st = db()->prepare($sql);
    $st->execute($p);
    return $st->fetchAll();
}

/**
 * Beste Datei je Titel (höchste Bittiefe, dann Abtastrate, dann kleinste ID) – dieselbe Wahl wie beim Streamen.
 * Eine Abfrage je 1000 Titel statt einer Unterabfrage pro Zeile (die bei großen Bibliotheken Sekunden kostet).
 * @return array<int, array> track_id => Zeile (Spalten aus dateien, Alias d)
 */
function db_beste_dateien(array $trackIds, string $spalten): array
{
    $trackIds = array_values(array_unique(array_filter(array_map('intval', $trackIds))));
    $aus = [];
    foreach (array_chunk($trackIds, 1000) as $teil) {
        [$in, $p] = db_in($teil, 'bd');
        foreach (db_alle("SELECT d.track_id AS __tid, {$spalten} FROM dateien d WHERE d.track_id IN {$in}
            ORDER BY d.track_id, d.bittiefe DESC, d.abtastrate DESC, d.id", $p) as $z) {
            $tid = (int) $z['__tid'];
            if (!isset($aus[$tid])) {
                unset($z['__tid']);
                $aus[$tid] = $z;
            }
        }
    }
    return $aus;
}

/**
 * Platzhalter für IN (...): liefert ['(:i0,:i1,…)', ['i0' => …]].
 * Leere Liste ergibt (NULL), damit die Abfrage gültig bleibt und nichts findet.
 */
function db_in(array $werte, string $praefix = 'i'): array
{
    $werte = array_values($werte);
    if (!$werte) {
        return ['(NULL)', []];
    }
    $namen = [];
    $p = [];
    foreach ($werte as $i => $w) {
        $namen[] = ':' . $praefix . $i;
        $p[$praefix . $i] = $w;
    }
    return ['(' . implode(',', $namen) . ')', $p];
}
