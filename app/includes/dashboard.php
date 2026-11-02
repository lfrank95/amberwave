<?php
// Dashboard (nur Admins): was der Server gerade tut, wer verbunden ist, wo seine Daten liegen und wie es ihm geht.
// „Gerade läuft“ kommt aus der Aktivität (/admin/aktivitaet), Übertragungen aus Connect und den Downloads – hier steht der Rest:
// Plattform und Laufzeit, Update, verbundene Geräte (zuhause/unterwegs), Speicher, Hintergrundaufgaben, Rechner.
// Teure Werte (Ordnergrößen, Datenbankgröße) werden eine Stunde gemerkt.
declare(strict_types=1);

require_once __DIR__ . '/api_admin.php';
require_once __DIR__ . '/updatecheck.php';
require_once __DIR__ . '/auftrag.php';

function api_admin_dashboard(): array
{
    return [
        'server' => dashboard_server(),
        'update' => dashboard_update(),
        'geraete' => dashboard_geraete(),
        'speicher' => dashboard_speicher(),
        'hintergrund' => dashboard_hintergrund(),
        'rechner' => dashboard_rechner(),
        'downloads' => dashboard_downloads(),
        'zahlen' => [
            'titel' => (int) db_wert("SELECT COUNT(DISTINCT track_id) FROM dateien WHERE fehler = '' AND track_id IS NOT NULL"),
            'alben' => (int) db_wert('SELECT COUNT(*) FROM alben a JOIN editionen e ON e.id = a.anzeige_edition_id WHERE e.anzahl_dateien > 0'),
            'groesse' => (int) db_wert("SELECT COALESCE(SUM(groesse), 0) FROM dateien WHERE fehler = ''"),
        ],
        'zeit' => iso(date('Y-m-d H:i:s')),
    ];
}

/** Plattform, Name und wie lange der Server schon läuft */
function dashboard_server(): array
{
    $plattform = getenv('AMBERWAVE_OS') === '1' ? 'os' : (getenv('AMBERWAVE_WINDOWS') === '1' ? 'windows' : (getenv('AMBERWAVE_IMAGE') === '1' ? 'docker' : 'php'));
    $host = strtolower((string) getenv('HOST_OS'));   // Unraid setzt HOST_OS=Unraid in seine Container
    $name = '';
    try {
        require_once __DIR__ . '/connect.php';
        $name = connect_eigener_name();
    } catch (Throwable $e) {
        $name = (string) (konfig()['server_name'] ?? '');
    }
    return ['name' => $name !== '' ? $name : (gethostname() ?: 'Amberwave'), 'version' => app_version(), 'plattform' => $plattform,
        'host' => $host === 'unraid' ? 'unraid' : '', 'seit' => dashboard_seit()];
}

/** Startzeit des Servers (Container: Prozess 1; sonst die Datei, die beim Start geschrieben wird) */
function dashboard_seit(): ?string
{
    $stat = @file_get_contents('/proc/1/stat');
    $up = @file_get_contents('/proc/uptime');
    if ($stat && $up && preg_match('/\) \S+ (?:\S+ ){18}(\d+)/', $stat, $m)) {
        $hz = 100;
        $start = time() - (int) floor((float) explode(' ', $up)[0]) + intdiv((int) $m[1], $hz);
        return iso(date('Y-m-d H:i:s', $start));
    }
    $marke = rtrim((string) konfig()['pfade']['cache'], '/\\') . '/tmp/start.txt';
    $t = @filemtime($marke);
    return $t ? iso(date('Y-m-d H:i:s', $t)) : null;
}

/** Neue Version? Und wie sie hier hereinkommt: Windows/OS per Knopf, Docker per Image, sonst als Paket */
function dashboard_update(): array
{
    $p = dashboard_server()['plattform'];
    return ['neu' => update_hinweis(false), 'gesucht' => update_zuletzt_gesucht() ?: null, 'hinweis_an' => einstellung('update_hinweis') !== '0',
        'weg' => in_array($p, ['os', 'windows'], true) ? 'knopf' : ($p === 'docker' ? 'docker' : 'paket'),
        'unraid' => strtolower((string) getenv('HOST_OS')) === 'unraid'];
}

/**
 * Geräte, die gerade mit dem Server sprechen (Lebenszeichen der letzten 3 Minuten): Apps und Browser je Konto, ob sie
 * zuhause oder unterwegs sind (an ihrer letzten Adresse) und ob sie gerade spielen; dazu Receiver & Co. im Heimnetz.
 */
function dashboard_geraete(): array
{
    $heim = function_exists('heim_ips') ? heim_ips() : [];
    $zuhause = static function (string $ip) use ($heim): bool {
        if ($ip === '' || !filter_var($ip, FILTER_VALIDATE_IP)) {
            return false;
        }
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return true;
        }
        return in_array($ip, $heim, true);
    };
    $spielend = [];
    foreach (db_alle("SELECT geraet_id, spielt, verbindung, TIMESTAMPDIFF(SECOND, aktualisiert_am, NOW()) AS alter_sek FROM aktive_wiedergaben WHERE geraet_id IS NOT NULL") as $w) {
        $spielend[(int) $w['geraet_id']] = ['spielt' => (int) $w['spielt'] === 1 && (int) $w['alter_sek'] < 40, 'heim' => $w['verbindung'] !== 'extern'];
    }
    $online = [];
    foreach (db_alle('SELECT geraet_id FROM fern_praesenz WHERE zuletzt_am > NOW(3) - INTERVAL 90 SECOND') as $f) {
        $online[(int) $f['geraet_id']] = true;
    }
    $aus = [];
    foreach (db_alle("SELECT g.id, g.art, COALESCE(NULLIF(g.eigener_name, ''), g.name) AS name, g.name AS roh_name, g.ip, g.zuletzt_am,
            TIMESTAMPDIFF(SECOND, g.zuletzt_am, NOW()) AS vor, u.vorname, u.benutzername
            FROM nutzer_geraete g JOIN users u ON u.id = g.user_id
            WHERE g.beendet_am IS NULL AND (g.zuletzt_am > NOW() - INTERVAL 3 MINUTE OR g.id IN " . db_ids(array_keys($online + $spielend)) . ')
            ORDER BY g.zuletzt_am DESC LIMIT 30') as $g) {
        $id = (int) $g['id'];
        $s = $spielend[$id] ?? null;
        $aus[] = ['id' => $id, 'name' => (string) $g['name'], 'art' => dashboard_geraet_art((string) $g['roh_name'], (string) $g['art']),
            'user' => (string) ($g['vorname'] ?: $g['benutzername']), 'ort' => ($s ? $s['heim'] : $zuhause((string) $g['ip'])) ? 'heim' : 'unterwegs',
            'spielt' => (bool) ($s['spielt'] ?? false), 'aktiv' => isset($online[$id]) || (int) $g['vor'] < 120, 'zuletzt' => iso($g['zuletzt_am'])];
    }
    $heimgeraete = [];
    try {
        foreach (db_alle("SELECT id, name, hersteller, modell, zuletzt_ok, (zuletzt_ok > NOW() - INTERVAL 15 MINUTE) AS da FROM heimgeraete WHERE aktiv = 1 ORDER BY name LIMIT 12") as $h) {
            $heimgeraete[] = ['id' => (int) $h['id'], 'name' => (string) ($h['name'] ?: trim($h['hersteller'] . ' ' . $h['modell'])), 'modell' => trim($h['hersteller'] . ' ' . $h['modell']), 'da' => (bool) $h['da']];
        }
    } catch (Throwable $e) {
        // Tabelle fehlt (alte Installation) – dann eben keine
    }
    return ['apps' => $aus, 'heim' => $heimgeraete];
}

function dashboard_geraet_art(string $name, string $art): string
{
    if (stripos($name, 'Windows Client') !== false || preg_match('/Amberwave.*Windows/i', $name)) {
        return 'windows';
    }
    if (stripos($name, 'Android') !== false && $art === 'app') {
        return 'android';
    }
    return $art === 'app' ? 'app' : 'browser';
}

/** Speicher: Musikordner und Datenordner (Datenbank, Bilder, Zwischenspeicher, Sicherungen) – mit Belegung des Laufwerks */
function dashboard_speicher(): array
{
    $k = konfig()['pfade'];
    $platte = static function (string $pfad): array {
        $g = @disk_total_space($pfad);
        $f = @disk_free_space($pfad);
        return ['gesamt' => $g !== false ? (int) $g : 0, 'frei' => $f !== false ? (int) $f : 0];
    };
    $teile = dashboard_merken('speicher', 3600, static function () use ($k) {
        $db = 0;
        try {
            $db = (int) db_wert('SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()');
        } catch (Throwable $e) {
        }
        $cache = rtrim((string) $k['cache'], '/\\');
        return [
            'datenbank' => $db,
            'bilder' => dashboard_ordner_groesse($cache . '/cover') + dashboard_ordner_groesse($cache . '/bilder') + dashboard_ordner_groesse($cache . '/mb-cover') + dashboard_ordner_groesse($cache . '/profil'),
            'zwischenspeicher' => dashboard_ordner_groesse($cache . '/umwandlung') + dashboard_ordner_groesse($cache . '/stream') + dashboard_ordner_groesse($cache . '/tmp'),
            'sicherungen' => dashboard_ordner_groesse((string) ($k['backups'] ?? '')),
        ];
    });
    $musik = $platte((string) $k['musik']);
    $daten = $platte((string) $k['cache']);
    return [
        'musik' => ['pfad' => (string) $k['musik'], 'belegt_musik' => (int) db_wert("SELECT COALESCE(SUM(groesse), 0) FROM dateien WHERE fehler = ''")] + $musik,
        'daten' => ['pfad' => (string) $k['cache'], 'teile' => $teile] + $daten,
    ];
}

function dashboard_ordner_groesse(string $pfad): int
{
    if ($pfad === '' || !is_dir($pfad)) {
        return 0;
    }
    $n = 0;
    try {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($pfad, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
        $max = 400000;
        foreach ($it as $f) {
            if ($f->isFile()) {
                $n += $f->getSize();
            }
            if (--$max <= 0) {
                break;
            }
        }
    } catch (Throwable $e) {
    }
    return $n;
}

/** Was im Hintergrund läuft oder als Nächstes kommt */
function dashboard_hintergrund(): array
{
    $l = db_zeile('SELECT * FROM scan_laeufe ORDER BY id DESC LIMIT 1');
    $mj = auftrag_zustand('metadaten');
    $stunde = (int) einstellung('sicherung_stunde');
    $naechste = null;
    if ($stunde >= 0) {
        $ts = mktime($stunde, 0, 0);
        if ($ts <= time()) {
            $ts = strtotime('+1 day', $ts);
        }
        $naechste = iso(date('Y-m-d H:i:s', $ts));
    }
    $dl = 0;
    try {
        $dl = (int) db_wert("SELECT COUNT(*) FROM downloads WHERE status IN ('gesendet', 'laeuft', 'fertig')");
    } catch (Throwable $e) {
    }
    return [
        'scan' => $l ? scan_objekt($l) : null,
        'scan_laeuft' => scan_laufend() !== null,
        'metadaten' => ['status' => $mj['status'], 'gesamt' => (int) $mj['gesamt'], 'geprueft' => (int) $mj['geprueft'], 'meldung' => (string) $mj['meldung']],
        'sicherung' => $naechste,
        'downloads' => $dl,
    ];
}

/** Laufende Downloads (nur aus der Datenbank – den Downloadclient fragt die Downloads-Seite selbst) */
function dashboard_downloads(): array
{
    try {
        return array_map(static fn($d) => ['id' => (int) $d['id'], 'titel' => (string) $d['titel'], 'indexer' => (string) $d['indexer'], 'groesse' => (int) $d['groesse'],
            'status' => (string) $d['status'], 'prozent' => (float) $d['prozent'], 'meldung' => (string) $d['meldung'], 'angelegt' => iso($d['angelegt_am'])],
            db_alle("SELECT id, titel, indexer, groesse, status, prozent, meldung, angelegt_am FROM downloads WHERE status IN ('gesendet', 'laeuft', 'fertig') ORDER BY id DESC LIMIT 10"));
    } catch (Throwable $e) {
        return [];
    }
}

/** Rechner: Prozessor, Last, Arbeitsspeicher (Container: was Amberwave belegt), Versionen */
function dashboard_rechner(): array
{
    $cpu = '';
    $kerne = 0;
    foreach (@file('/proc/cpuinfo') ?: [] as $z) {
        if ($cpu === '' && preg_match('/^model name\s*:\s*(.+)$/', $z, $m)) {
            $cpu = trim(preg_replace('/\s+/', ' ', $m[1]));
        }
        if (str_starts_with($z, 'processor')) {
            $kerne++;
        }
    }
    if ($cpu === '' && getenv('PROCESSOR_IDENTIFIER')) {
        $cpu = (string) getenv('PROCESSOR_IDENTIFIER');
        $kerne = (int) getenv('NUMBER_OF_PROCESSORS');
    }
    $last = function_exists('sys_getloadavg') ? (sys_getloadavg() ?: [0])[0] : null;
    $mem = [];
    foreach (@file('/proc/meminfo') ?: [] as $z) {
        if (preg_match('/^(MemTotal|MemAvailable):\s+(\d+)/', $z, $m)) {
            $mem[$m[1]] = (int) $m[2] * 1024;
        }
    }
    $belegt = null;
    foreach (['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'] as $d) {
        $w = @file_get_contents($d);
        if ($w !== false && is_numeric(trim($w))) {
            $belegt = (int) trim($w);
            break;
        }
    }
    $dbv = '';
    try {
        $dbv = (string) db_wert('SELECT VERSION()');
    } catch (Throwable $e) {
    }
    return ['cpu' => $cpu, 'kerne' => $kerne, 'last' => $last !== null ? round((float) $last, 2) : null,
        'auslastung' => $last !== null && $kerne ? min(100, (int) round($last / $kerne * 100)) : null,
        'ram_gesamt' => $mem['MemTotal'] ?? null, 'ram_frei' => $mem['MemAvailable'] ?? null, 'ram_amberwave' => $belegt,
        'php' => PHP_VERSION, 'datenbank' => preg_replace('/-.*$/', '', $dbv), 'betriebssystem' => PHP_OS_FAMILY === 'Windows' ? php_uname('s') . ' ' . php_uname('r') : ''];
}

/** Teure Werte eine Weile merken (Datei im Cache) */
function dashboard_merken(string $name, int $sekunden, callable $rechnen): array
{
    $d = rtrim((string) konfig()['pfade']['cache'], '/\\') . '/tmp/dashboard-' . $name . '.json';
    $w = json_decode((string) @file_get_contents($d), true);
    if (is_array($w) && (int) ($w['zeit'] ?? 0) > time() - $sekunden) {
        return $w['wert'];
    }
    $wert = $rechnen();
    @file_put_contents($d, json_encode(['zeit' => time(), 'wert' => $wert]), LOCK_EX);
    return $wert;
}
