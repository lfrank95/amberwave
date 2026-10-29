<?php
declare(strict_types=1);
require_once __DIR__ . '/config.php';

/** Eine gemeinsame PDO-Verbindung pro Request (echte Prepared Statements, kein Emulieren). */
function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $c = konfig()['db'];
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['host'], $c['port'], $c['name']);
    $pdo = new PDO($dsn, $c['user'], $c['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);
    // Zeitzone der Sitzung = Zeitzone von PHP, damit NOW() und date() übereinstimmen
    $pdo->exec("SET time_zone = '" . (new DateTime())->format('P') . "'");
    return $pdo;
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
