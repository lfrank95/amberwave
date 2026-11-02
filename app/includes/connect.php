<?php
declare(strict_types=1);
// Amberwave Connect – Amberwave-Server koppeln sich und holen Musik voneinander.
//
// Kopplung: Ein Admin lässt sich einen sechsstelligen Code anzeigen (10 Minuten gültig), auf dem anderen Server gibt ein
// Admin ihn ein. Beide tauschen ihre Ausweise (öffentliche Schlüssel, siehe ausweis.php) aus und beweisen sich dabei mit
// dem Code gegenseitig, dass niemand dazwischensitzt (CPace über ristretto255). Danach kennen sie sich am Schlüssel.
//
// Aufrufe: Jede Anfrage ist mit den Schlüsseln beider Seiten verschlüsselt und unterschrieben (crypto_box) – egal ob sie
// im Heimnetz läuft, über den Direktzugang oder durch den Cloudflare-Tunnel. Wer keinen gekoppelten Schlüssel hat, bekommt
// nur „gibt es nicht“ zu sehen. Jede Anfrage trägt Zeit und Zufallswert (gegen Wiederholung).
//
// Wege: Jeder Server kennt die Adressen des anderen (Heimnetz, Direktzugang, öffentliche Adresse) und schickt seine
// eigenen bei jedem Kontakt mit. Verbunden wird über alle Adressen gleichzeitig; der schnellste Weg, der sich mit dem
// richtigen Schlüssel meldet, gewinnt und wird gemerkt. Fällt er weg, wird neu gesucht – zur Not im ganzen Heimnetz.
require_once __DIR__ . '/ausweis.php';
require_once __DIR__ . '/api.php';
require_once __DIR__ . '/sicherheit.php';

const CONNECT_MAGIE = 'AWC1';
const CONNECT_ZEITFENSTER = 600;          // Sekunden Abweichung der Uhren, die noch angenommen werden
const CONNECT_STUECK = 4 * 1024 * 1024;   // Bytes je Dateistück
const CONNECT_QUALITAETEN = ['original', 'flac1644', 'opus256', 'opus160', 'opus128', 'aac256', 'aac160'];
const CONNECT_RECHTE_STANDARD = ['stoebern' => true, 'holen' => true, 'original' => true, 'senden' => true];

function connect_ordner(string $unter = ''): string
{
    $d = rtrim((string) konfig()['pfade']['cache'], '/') . '/connect' . ($unter !== '' ? '/' . $unter : '');
    if (!is_dir($d)) {
        @mkdir($d, 0700, true);
    }
    return $d;
}

// ---------- Gegenstellen ----------

function connect_server_liste(): array
{
    return array_map('connect_server_objekt', db_alle('SELECT * FROM connect_server ORDER BY name, id'));
}

function connect_server(int $id): array
{
    $z = db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => $id]);
    if (!$z) {
        throw new ApiFehler(t('Diesen Server gibt es nicht (mehr).'), 404);
    }
    return $z;
}

/** Gekoppelt heißt: beide Seiten dürfen alles – stöbern, reinhören, holen (auch verlustfrei) und schicken */
function connect_rechte(array $z): array
{
    return CONNECT_RECHTE_STANDARD;
}

/** Für die Oberfläche – ohne Schlüssel im Ganzen, mit Kennung */
function connect_server_objekt(array $z): array
{
    $ad = json_decode((string) ($z['adressen'] ?? ''), true) ?: [];
    $frisch = $z['zuletzt_am'] ? time() - strtotime((string) $z['zuletzt_am']) : null;
    return [
        'id' => (int) $z['id'], 'name' => (string) $z['name'], 'kennung' => (string) $z['kennung'], 'version' => (string) $z['version'],
        'rechte' => connect_rechte($z), 'gekoppelt' => iso($z['gekoppelt_am']), 'zuletzt' => iso($z['zuletzt_am']),
        'erreichbar' => $frisch !== null && $frisch < 600 && $z['weg'] !== '',
        'weg' => ['art' => (string) $z['weg_art'], 'ms' => $z['weg_ms'] !== null ? (int) $z['weg_ms'] : null, 'am' => iso($z['weg_am'])],
        'adressen' => ['heimnetz' => count($ad['lan'] ?? []), 'direkt' => !empty($ad['direkt']), 'oeffentlich' => !empty($ad['oeffentlich'])],
        // Von außen erreichbar (Tunnel oder öffentliche Adresse)? Sonst nur ausgehend – z. B. hinter CGNAT
        'von_aussen' => !empty($ad['tunnel']) || (!empty($ad['oeffentlich']) && connect_adresse_oeffentlich((string) $ad['oeffentlich'])),
        'tunnel' => !empty($ad['tunnel']),
        'dir_erlaubt' => json_decode((string) ($z['dir_erlaubt'] ?? ''), true) ?: null,
        'rueckkanal' => connect_rueck_stand((int) $z['id']),
    ];
}

// ---------- Eigene Adressen ----------

/** Heimnetz-Adresse dieses Servers merken (aus dem Host-Kopf direkter Anfragen, siehe direkt_ip_beobachten) */
function connect_lan_lernen(string $host, bool $https): void
{
    $datei = connect_ordner() . '/eigene_lan.json';
    $l = json_decode((string) @file_get_contents($datei), true) ?: [];
    $url = ($https ? 'https://' : 'http://') . $host;
    if (($l[0] ?? '') === $url) {
        return;
    }
    $l = array_values(array_unique(array_merge([$url], $l)));
    @file_put_contents($datei, json_encode(array_slice($l, 0, 4)), LOCK_EX);
}

function connect_eigene_adressen(): array
{
    require_once __DIR__ . '/direktzugang.php';
    $lan = json_decode((string) @file_get_contents(connect_ordner() . '/eigene_lan.json'), true) ?: [];
    $os = trim((string) getenv('AMBERWAVE_OS')) === '1' ? ['http://' . (gethostname() ?: 'amberwave') . '.local'] : [];
    $ips = connect_eigene_ips();
    return array_filter([
        'lan' => array_slice(array_values(array_unique(array_merge($lan, connect_lan_aus_ips($lan, $ips['lan'] ?? []), $os))), 0, 6),
        'netz' => $ips['oeffentlich'] ?? null,
        'direkt' => direkt_url() ?: null,
        'oeffentlich' => rtrim((string) konfig()['app_url'], '/') ?: null,
        'tunnel' => connect_tunnel_adresse(),
    ]);
}

/** Adresse des Cloudflare-Tunnels (auch wenn APP_URL etwas anderes nennt, z. B. die Heimnetz-Adresse) */
function connect_tunnel_adresse(): ?string
{
    try {
        require_once __DIR__ . '/tunnel.php';
        $h = tunnel_host();
    } catch (Throwable $e) {
        return null;
    }
    $u = $h !== '' ? 'https://' . $h : '';
    return $u !== '' && $u !== rtrim((string) konfig()['app_url'], '/') ? $u : null;
}

function connect_eigener_name(): string
{
    if (!empty($GLOBALS['connect_name_neu'])) {
        return (string) $GLOBALS['connect_name_neu'];
    }
    $k = konfig();
    return $k['server_name'] !== '' ? $k['server_name'] : (gethostname() ?: 'Amberwave');
}

/**
 * Eigenen Namen ändern (wie in der Einrichtung, gespeichert neben der Zeitzone). Die gekoppelten Server erfahren ihn
 * beim nächsten Kontakt – hier gleich mit einem kurzen „Hallo“ an alle, die gerade erreichbar sind.
 */
function connect_name_setzen(array $admin, string $name): string
{
    $name = trim(preg_replace('/\s+/u', ' ', $name));
    if ($name === '' || mb_strlen($name) > 60) {
        throw new ApiFehler(t('Der Name darf 1 bis 60 Zeichen haben.'));
    }
    if (trim((string) getenv('CLIENT_SERVERNAME')) !== '') {
        throw new ApiFehler(t('Der Name ist in der .env festgelegt (CLIENT_SERVERNAME) – dort ändern.'));
    }
    require_once __DIR__ . '/einrichtung.php';
    $k = konfig();
    einrichtung_server_speichern((string) ($k['zeitzone'] ?? ''), $name);
    $GLOBALS['connect_name_neu'] = $name;
    log_sicherheitsereignis((int) $admin['id'], 'servername', $name);
    foreach (db_alle('SELECT * FROM connect_server') as $peer) {
        try {
            connect_rufen($peer, 'hallo', [], 4);
        } catch (Throwable $e) {
            // nicht erreichbar: erfährt den Namen beim nächsten Mal
        }
    }
    return $name;
}

/**
 * JSON-Datei unter Sperre lesen, ändern, schreiben (lesen-ändern-schreiben ohne Sperre verliert sonst Einträge, wenn
 * Webprozess und Hintergrundjob gleichzeitig daran sind). $aendern bekommt die Daten und gibt die neuen zurück
 * (null = unverändert lassen). Gibt die Daten nach der Änderung zurück.
 */
function connect_json_aendern(string $datei, callable $aendern): array
{
    $fp = @fopen($datei, 'c+');
    if (!$fp) {
        $alt = json_decode((string) @file_get_contents($datei), true) ?: [];
        return $aendern($alt) ?? $alt;
    }
    flock($fp, LOCK_EX);
    $alt = json_decode((string) stream_get_contents($fp), true) ?: [];
    $neu = $aendern($alt);
    if ($neu !== null) {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($neu, JSON_UNESCAPED_UNICODE));
        fflush($fp);
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $neu ?? $alt;
}

/** JSON-Datei unter Sperre leeren und den bisherigen Inhalt zurückgeben (Übergabe an einen Verarbeiter) */
function connect_json_entnehmen(string $datei): array
{
    $alt = [];
    connect_json_aendern($datei, static function (array $a) use (&$alt) {
        $alt = $a;
        return [];
    });
    return $alt;
}

// ---------- Verschlüsselung ----------

function connect_versiegeln(string $klartext, string $peer_pk): string
{
    $paar = sodium_crypto_box_keypair_from_secretkey_and_publickey(ausweis_box_geheim(), ausweis_box_oeffentlich_von($peer_pk));
    $n = random_bytes(SODIUM_CRYPTO_BOX_NONCEBYTES);
    return $n . sodium_crypto_box($klartext, $n, $paar);
}

function connect_oeffnen(string $daten, string $peer_pk): ?string
{
    if (strlen($daten) < SODIUM_CRYPTO_BOX_NONCEBYTES + SODIUM_CRYPTO_BOX_MACBYTES) {
        return null;
    }
    $paar = sodium_crypto_box_keypair_from_secretkey_and_publickey(ausweis_box_geheim(), ausweis_box_oeffentlich_von($peer_pk));
    $r = sodium_crypto_box_open(substr($daten, SODIUM_CRYPTO_BOX_NONCEBYTES), substr($daten, 0, SODIUM_CRYPTO_BOX_NONCEBYTES), $paar);
    return $r === false ? null : $r;
}

/** Nutzlast: 4 Byte Länge + JSON-Kopf + Binärteil (z. B. ein Dateistück) */
function connect_packen(array $kopf, string $binaer = ''): string
{
    $j = json_encode($kopf, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return pack('N', strlen($j)) . $j . $binaer;
}

function connect_entpacken(string $roh): ?array
{
    if (strlen($roh) < 4) {
        return null;
    }
    $n = unpack('N', substr($roh, 0, 4))[1];
    $kopf = json_decode(substr($roh, 4, $n), true);
    return is_array($kopf) ? [$kopf, (string) substr($roh, 4 + $n)] : null;
}

/** Wiederholte Anfrage? Jeder Zufallswert gilt nur einmal (Merkliste der letzten 20 Minuten) */
function connect_schon_gesehen(string $z): bool
{
    if (!preg_match('/^[0-9a-f]{32}$/', $z)) {
        return true;
    }
    $d = connect_ordner('gesehen/' . substr($z, 0, 2));
    $p = $d . '/' . $z;
    $h = @fopen($p, 'x');   // atomar: gibt es die Datei schon, war der Wert schon da
    if ($h === false) {
        return true;
    }
    fclose($h);
    if (random_int(1, 200) === 1) {   // ab und zu aufräumen
        foreach (glob(connect_ordner('gesehen') . '/*/*') ?: [] as $f) {
            if (filemtime($f) < time() - 1200) {
                @unlink($f);
            }
        }
    }
    return false;
}

// ---------- Empfangen (andere Server rufen uns) ----------

/** POST /api/v1/connect – verschlüsselte Anfrage eines gekoppelten Servers */
function connect_empfangen(): void
{
    $roh = (string) file_get_contents('php://input', false, null, 0, 1024 * 1024);
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_write_close();
    }
    $r = connect_verarbeiten($roh, connect_anfrage_im_heimnetz(), connect_gesehen());
    if ($r === null) {
        http_response_code(404);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'fehler' => t('Unbekannter Pfad.')], JSON_UNESCAPED_UNICODE);
        exit;
    }
    [$aus, $mitDaten] = $r;
    db_schliessen();
    header('Content-Type: application/octet-stream');
    header('Cache-Control: no-store');
    header('Content-Length: ' . strlen($aus));
    if ($mitDaten) {
        require_once __DIR__ . '/connect_uebertragung.php';
        connect_ausgeben($aus, 'hoch', connect_anfrage_im_heimnetz());   // Tempogrenze für das Hochladen
    } else {
        echo $aus;
    }
    exit;
}

/**
 * Eine versiegelte Anfrage einer Gegenstelle ausführen – direkt über HTTP oder über den Rückkanal hereingereicht.
 * Gibt [versiegelte Antwort, enthält Dateidaten] zurück oder null (unbekannt, ungültig, zu alt, schon gesehen).
 */
function connect_verarbeiten(string $roh, bool $heimnetz = false, ?array $gesehen = null): ?array
{
    if (strlen($roh) < 4 + 32 + 40 || substr($roh, 0, 4) !== CONNECT_MAGIE) {
        return null;
    }
    $pk = substr($roh, 4, 32);
    $peer = db_zeile('SELECT * FROM connect_server WHERE schluessel = :s', ['s' => bin2hex($pk)]);
    $klar = $peer ? connect_oeffnen(substr($roh, 36), $pk) : null;
    $a = $klar !== null ? json_decode($klar, true) : null;
    if (!$peer || !is_array($a) || !hash_equals(bin2hex($pk), (string) ($a['von'] ?? ''))
        || abs(time() - (int) ($a['t'] ?? 0)) > CONNECT_ZEITFENSTER || connect_schon_gesehen((string) ($a['z'] ?? ''))) {
        return null;
    }
    // Gegenstelle lebt: Adressbuch und Stand auffrischen
    $upd = ['id' => $peer['id'], 'v' => mb_substr((string) ($a['v'] ?? ''), 0, 40)];
    $sql = 'UPDATE connect_server SET zuletzt_am = NOW(), version = :v';
    if (is_array($a['ad'] ?? null)) {
        $sql .= ', adressen = :ad';
        $upd['ad'] = json_encode(connect_adressen_saeubern($a['ad']));
    }
    if (is_string($a['name'] ?? null) && $a['name'] !== '') {
        $sql .= ', name = :n';
        $upd['n'] = mb_substr($a['name'], 0, 120);
    }
    db_tun($sql . ' WHERE id = :id', $upd);
    if (is_array($a['ad'] ?? null)) {
        $peer['adressen'] = $upd['ad'];
    }
    if ($heimnetz && $peer['weg_art'] !== 'heimnetz') {
        connect_lan_vom_absender($peer);   // gerade nach Hause gekommen?
        $peer = db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => $peer['id']]) ?: $peer;
    } elseif (!$heimnetz && isset($gesehen['oeffentlich']) && $peer['weg_art'] === 'heimnetz' && $peer['weg_am']) {
        // Kommt über das Internet, obwohl wir ihn im Heimnetz wähnen: vermutlich weggefahren – beim nächsten Mal neu prüfen
        db_tun("UPDATE connect_server SET weg_am = NULL WHERE id = :id AND weg_art = 'heimnetz'", ['id' => $peer['id']]);
    }
    try {
        [$kopf, $binaer] = connect_methode($peer, (string) ($a['m'] ?? ''), is_array($a['a'] ?? null) ? $a['a'] : []);
        $kopf = ['ok' => true] + $kopf;
    } catch (ApiFehler $e) {
        [$kopf, $binaer] = [['ok' => false, 'fehler' => $e->getMessage(), 'code' => $e->getCode()], ''];
    } catch (Throwable $e) {
        error_log('Connect ' . ($a['m'] ?? '') . ': ' . log_sauber($e->getMessage()));
        [$kopf, $binaer] = [['ok' => false, 'fehler' => t('Interner Fehler auf dem anderen Server.')], ''];
    }
    if ($gesehen) {
        $kopf['_gesehen'] = $gesehen;   // „du kamst von …“ – so lernt die Gegenstelle ihre eigene Heimnetz- bzw. öffentliche IP
    }
    $kopf['z'] = (string) $a['z'];
    $kopf['von'] = bin2hex(ausweis_oeffentlich());
    return [CONNECT_MAGIE . connect_versiegeln(connect_packen($kopf, $binaer), $pk), $binaer !== ''];
}

function connect_adressen_saeubern(array $ad): array
{
    $url = static fn($u) => is_string($u) && preg_match('#^https?://[^\s/]+$#', rtrim($u, '/')) ? rtrim($u, '/') : null;
    $host = static fn($u) => strtolower((string) parse_url((string) $u, PHP_URL_HOST));
    // Heimnetz-Adressen: nur private IPv4 oder .local-Namen – nichts, was uns ins Internet oder zu anderen Geräten schicken könnte
    $privat = static function ($u) use ($host): bool {
        $h = $host($u);
        return $h !== '' && (str_ends_with($h, '.local') || (filter_var($h, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) && filter_var($h, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE) === false));
    };
    $offen = static fn($u) => $u !== null && connect_adresse_oeffentlich($u) ? $u : null;
    return array_filter([
        'lan' => array_values(array_filter(array_map($url, array_slice((array) ($ad['lan'] ?? []), 0, 6)), $privat)),
        'direkt' => $url($ad['direkt'] ?? null),
        'oeffentlich' => $url($ad['oeffentlich'] ?? null),
        'tunnel' => $offen($url($ad['tunnel'] ?? null)),
        'netz' => is_string($ad['netz'] ?? null) && filter_var($ad['netz'], FILTER_VALIDATE_IP) ? $ad['netz'] : null,
    ]);
}

/**
 * Kam die Anfrage direkt aus dem Heimnetz (nicht über Tunnel oder Proxy)? Ein Proxy ohne Kopfzeilen sähe aus wie ein Gerät im
 * Heimnetz – deshalb zählt eine Absenderadresse nicht, wenn sie ein bekannter Proxy ist (Liste, cloudflared-Container) oder
 * schon einmal weitergeleitete Adressen mitgeschickt hat (Proxy-Beobachtung) – dann wissen wir nur: von irgendwoher.
 */
function connect_anfrage_im_heimnetz(): bool
{
    if (!empty($_SERVER['HTTP_CF_CONNECTING_IP']) || !empty($_SERVER['HTTP_X_FORWARDED_FOR']) || !empty($_SERVER['HTTP_X_REAL_IP']) || !empty($_SERVER['HTTP_FORWARDED'])) {
        return false;
    }
    $von = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (!filter_var($von, FILTER_VALIDATE_IP) || filter_var($von, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false) {
        return false;
    }
    return !connect_absender_ist_proxy($von);
}

/** Absenderadresse, hinter der erfahrungsgemäß ein Proxy steckt (eingetragen, cloudflared im Stack oder beobachtet) */
function connect_absender_ist_proxy(string $ip): bool
{
    if (konfig()['sicherheit']['proxy_vertrauen'] === 'ja' || ist_bekannter_proxy($ip)) {
        return true;
    }
    $b = is_file(proxy_beobachtung_datei()) ? (json_decode((string) @file_get_contents(proxy_beobachtung_datei()), true) ?: []) : [];
    return ($b['ip'] ?? '') === $ip;
}

/** Ein „Gast-Benutzer“ für das Zusammenstellen der Bibliothek (ohne Favoriten, Verlauf o. Ä. eines Kontos) */
function connect_gast(): array
{
    static $g = null;
    if ($g === null) {
        $admin = db_zeile("SELECT * FROM users WHERE rolle = 'admin' ORDER BY id LIMIT 1") ?: [];
        $g = array_merge($admin, ['id' => 0, 'rolle' => 'user']);
    }
    return $g;
}

/** Was eine Gegenstelle bei uns aufrufen darf */
function connect_methode(array $peer, string $m, array $a): array
{
    $r = connect_rechte($peer);
    $darf = static function (string $recht) use ($r): void {
        if (empty($r[$recht])) {
            throw new ApiFehler(t('Das hat der andere Server nicht freigegeben.'), 403);
        }
    };
    // Lese-Methoden der Bibliothek bekommen ihre Parameter wie aus der Adresszeile
    $abfrage = static function (array $erlaubt) use ($a): void {
        $_GET = array_intersect_key(array_map(static fn($v) => is_scalar($v) ? (string) $v : '', $a), array_flip($erlaubt));
    };
    // Die Bibliotheksfunktionen brauchen, was sonst die API lädt – hier auch im Hintergrundprozess (Rückkanal)
    foreach (['api_bibliothek', 'api_nutzer', 'bilder', 'stream', 'lautheit', 'beliebt', 'genres', 'aktivitaet'] as $inc) {
        if (is_file(__DIR__ . '/' . $inc . '.php')) {
            require_once __DIR__ . '/' . $inc . '.php';
        }
    }
    switch ($m) {
        case 'warten':
            // Rückkanal: die Gegenstelle ist von außen nicht erreichbar und hält diese Anfrage offen –
            // wir geben ihr, was wir von ihr wollen (oder nach 25 s nichts)
            return [['auftraege' => connect_rueck_warten($peer)], ''];
        case 'hallo':
            return [['name' => connect_eigener_name(), 'kennung' => ausweis_kennung(), 'version' => app_version(),
                'adressen' => connect_eigene_adressen(), 'rechte' => $r,
                'musik' => ['alben' => (int) db_wert('SELECT COUNT(*) FROM alben a JOIN editionen e ON e.id = a.anzeige_edition_id WHERE e.anzahl_dateien > 0'),
                    'titel' => (int) db_wert('SELECT COUNT(DISTINCT track_id) FROM dateien WHERE fehler = \'\' AND track_id IS NOT NULL')]], ''];
        case 'alben':
            $darf('stoebern');
            $abfrage(['sort', 'seite', 'q', 'typ', 'buchstabe', 'genre', 'familie', 'jahrzehnt', 'kuenstler', 'limit', 'offset', 'ab']);
            return [api_alben_liste(connect_gast()), ''];
        case 'album':
            $darf('stoebern');
            return [api_album(connect_gast(), (int) ($a['id'] ?? 0)), ''];
        case 'kuenstler_liste':
            $darf('stoebern');
            $abfrage(['sort', 'seite', 'q', 'buchstabe', 'limit', 'offset', 'ab', 'rolle']);
            return [api_kuenstler_liste(connect_gast()), ''];
        case 'kuenstler':
            $darf('stoebern');
            return [api_kuenstler(connect_gast(), (int) ($a['id'] ?? 0)), ''];
        case 'playlists':
            $darf('stoebern');
            return [api_playlists(connect_gast()), ''];
        case 'playlist':
            $darf('stoebern');
            return [playlist_objekt(playlist_laden(connect_gast(), (int) ($a['id'] ?? 0)), connect_gast(), true), ''];
        case 'suche':
            $darf('stoebern');
            $abfrage(['q', 'art', 'limit']);
            return [api_suche(connect_gast()), ''];
        case 'bild':
            $darf('stoebern');
            return connect_bild_liefern((string) ($a['art'] ?? ''), (string) ($a['schluessel'] ?? ''), (int) ($a['g'] ?? 300));
        case 'datei':
            // Reinhören gehört zum Stöbern, Kopieren braucht „holen“
            $darf(($a['zweck'] ?? '') === 'hoeren' ? 'stoebern' : 'holen');
            $q = (string) ($a['qualitaet'] ?? 'original');
            if (($q === 'original' || $q === 'flac1644') && empty($r['original'])) {
                $q = 'opus256';   // verlustfrei nicht freigegeben – dann eben klein
            }
            require_once __DIR__ . '/connect_uebertragung.php';
            return connect_datei_liefern((int) ($a['track'] ?? 0), $q, (int) ($a['ab'] ?? 0), (int) ($a['laenge'] ?? CONNECT_STUECK));
        case 'beiwerk':
            // Was zu einem Auftrag außer den Dateien mitkommt: Künstler (Bild, Biografie) und Albumtexte
            $darf('holen');
            return [connect_beiwerk((string) ($a['art'] ?? ''), (int) ($a['id'] ?? 0), (int) $peer['id']), ''];
        case 'liste':
            // Welche Titel gehören zu einem Album / einer Playlist (zum Holen)
            $darf('holen');
            return [connect_titel_liste((string) ($a['art'] ?? ''), (int) ($a['id'] ?? 0), (int) $peer['id']), ''];
        case 'auftrag':
            // Die Gegenstelle möchte uns etwas schicken: wir holen es bei ihr ab
            $darf('senden');
            require_once __DIR__ . '/connect_uebertragung.php';
            $id = connect_auftrag_anlegen((int) $peer['id'], (string) ($a['art'] ?? ''), (int) ($a['id'] ?? 0), (string) ($a['qualitaet'] ?? ''), null,
                (string) ($a['titel'] ?? ''), (string) ($a['unter'] ?? ''));
            return [['auftrag' => $id], ''];
    }
    throw new ApiFehler(t('Unbekannte Anfrage.'), 400);
}

function connect_bild_liefern(string $art, string $schluessel, int $g): array
{
    require_once __DIR__ . '/bilder.php';
    if (!in_array($art, ['cover', 'kuenstler'], true) || !preg_match('/^[A-Za-z0-9_.-]{1,80}$/', $schluessel)) {
        throw new ApiFehler(t('Bild nicht gefunden.'), 404);
    }
    $pfad = bild_pfad($art, $schluessel, max(32, min(1200, $g)));
    if (!$pfad || !is_file($pfad)) {
        throw new ApiFehler(t('Bild nicht gefunden.'), 404);
    }
    return [['mime' => 'image/jpeg'], (string) file_get_contents($pfad)];
}

/** Einen der Plätze für offene „warten“ belegen (Sperrdatei, bis zum Prozessende gehalten); null = alle belegt */
function connect_rueck_platz()
{
    $prozesse = (int) getenv('AW_PHP_PROZESSE');
    $max = $prozesse > 0 ? max(1, intdiv($prozesse, 3)) : 6;
    $d = connect_ordner('rueck');
    for ($i = 0; $i < $max; $i++) {
        $h = @fopen($d . '/platz.' . $i . '.sperre', 'c');
        if ($h && flock($h, LOCK_EX | LOCK_NB)) {
            return $h;      // offen lassen – die Sperre fällt mit dem Prozessende
        }
        if ($h) {
            fclose($h);
        }
    }
    return null;
}

/** Playlists, die wir einer Gegenstelle ausdrücklich geschickt haben (24 Stunden abholbar) */
function connect_freigaben(int $peerId, ?int $neu = null): array
{
    $jetzt = time();
    $alle = connect_json_aendern(connect_ordner() . '/freigaben.json', static function (array $alle) use ($peerId, $neu, $jetzt) {
        foreach ($alle as $k => $f) {
            $alle[$k] = array_filter((array) $f, static fn($bis) => $bis > $jetzt);
        }
        if ($neu !== null) {
            $alle[$peerId][(string) $neu] = $jetzt + 86400;
        }
        return $alle;
    });
    return array_map('intval', array_keys($alle[$peerId] ?? []));
}

/** Beiwerk zu Album, Titel oder Playlist: beteiligte Künstler (Bild-Schlüssel, Biografie) und Albumtexte */
function connect_beiwerk(string $art, int $id, int $peerId = 0): array
{
    $liste = connect_titel_liste($art, $id, $peerId)['titel'] ?? [];
    $tids = array_slice(array_map(static fn($t) => (int) $t['track'], $liste), 0, 300);
    if (!$tids) {
        return ['kuenstler' => [], 'alben' => []];
    }
    $in = implode(',', $tids);
    $kids = array_map('intval', array_column(db_alle("SELECT DISTINCT cn.kuenstler_id FROM tracks t JOIN credit_namen cn ON cn.credit_id = t.credit_id WHERE t.id IN ($in)
        UNION SELECT DISTINCT cn.kuenstler_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id
        JOIN alben a ON a.id = e.album_id JOIN credit_namen cn ON cn.credit_id = a.credit_id WHERE t.id IN ($in)"), 'kuenstler_id'));
    $kuenstler = [];
    $kids = array_slice($kids, 0, 60);
    $zeilen = $kids ? db_alle('SELECT id, name, mbid, bio, bio_quelle, bio_maschinell, bild_datei FROM kuenstler WHERE id IN ' . db_ids($kids)) : [];
    $nachId = array_column($zeilen, null, 'id');
    foreach ($kids as $kid) {       // in der Reihenfolge der Beteiligung
        $k = $nachId[$kid] ?? null;
        if ($k && $k['name'] !== '[unbekannt]' && ($k['bild_datei'] !== '' || trim((string) $k['bio']) !== '')) {
            $kuenstler[] = ['name' => $k['name'], 'mbid' => (string) $k['mbid'], 'bild' => (string) $k['bild_datei'],
                'bio' => (string) $k['bio'], 'bio_quelle' => (string) $k['bio_quelle'], 'bio_maschinell' => (bool) $k['bio_maschinell']];
        }
    }
    $alben = [];
    foreach (db_alle("SELECT DISTINCT a.id, a.titel, a.beschreibung, a.beschreibung_quelle, a.beschreibung_maschinell,
            (SELECT k.name FROM credit_namen cn JOIN kuenstler k ON k.id = cn.kuenstler_id WHERE cn.credit_id = a.credit_id ORDER BY cn.pos LIMIT 1) AS kuenstler
            FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id
            WHERE t.id IN ($in) AND a.beschreibung IS NOT NULL AND a.beschreibung <> '' LIMIT 40") as $al) {
        $alben[] = ['titel' => $al['titel'], 'kuenstler' => (string) $al['kuenstler'], 'beschreibung' => $al['beschreibung'],
            'beschreibung_quelle' => $al['beschreibung_quelle'], 'beschreibung_maschinell' => (bool) $al['beschreibung_maschinell']];
    }
    return ['kuenstler' => $kuenstler, 'alben' => $alben];
}

/** Titel zum Holen: Album (angezeigte Edition), Playlist oder einzelner Titel – mit dem Nötigsten für Ordner und Namen */
function connect_titel_liste(string $art, int $id, int $peerId = 0): array
{
    if ($art === 'album') {
        $ids = array_map('intval', array_column(db_alle('SELECT t.id FROM alben a JOIN datentraeger m ON m.edition_id = a.anzeige_edition_id
            JOIN tracks t ON t.datentraeger_id = m.id WHERE a.id = :a ORDER BY m.pos, t.pos', ['a' => $id]), 'id'));
    } elseif ($art === 'playlist') {
        // Geteilte Playlists sieht jeder Gekoppelte; eine eigene nur, wenn wir sie ihm gerade selbst geschickt haben
        if (!in_array($id, connect_freigaben($peerId), true)) {
            playlist_laden(connect_gast(), $id);
        }
        $ids = array_map('intval', array_column(db_alle('SELECT track_id FROM playlist_eintraege WHERE playlist_id = :p ORDER BY pos, id', ['p' => $id]), 'track_id'));
    } elseif ($art === 'titel') {
        $ids = [$id];
    } else {
        throw new ApiFehler(t('Unbekannte Art.'), 400);
    }
    $ids = array_values(array_unique($ids));
    // Eine Abfrage je 500 Titel statt einer pro Titel (eine Playlist mit 2.000 Titeln wären sonst 2.000 Abfragen);
    // die beste fehlerfreie Datei je Titel kommt ebenfalls gesammelt – dieselbe Wahl wie beim Streamen
    $zeilen = [];
    foreach (array_chunk($ids, 500) as $teil) {
        foreach (db_alle('SELECT t.id, t.titel, t.nummer, t.pos, m.pos AS disc, t.mbid, au.mbid AS aufnahme_mbid, a.id AS album_id, a.titel AS album, a.erstjahr,
                ca.anzeige AS album_kuenstler, ct.anzeige AS kuenstler, e.cover_datei, e.id AS edition_id,
                (SELECT COUNT(*) FROM datentraeger m2 WHERE m2.edition_id = e.id) AS discs
            FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id
            LEFT JOIN aufnahmen au ON au.id = t.aufnahme_id LEFT JOIN credits ca ON ca.id = a.credit_id LEFT JOIN credits ct ON ct.id = t.credit_id
            WHERE t.id IN ' . db_ids($teil)) as $z) {
            $zeilen[(int) $z['id']] = $z;
        }
    }
    $dateien = [];
    foreach (array_chunk(array_keys($zeilen), 1000) as $teil) {
        foreach (db_alle('SELECT d.track_id, d.format, d.groesse, d.laenge_ms FROM dateien d WHERE d.fehler = \'\' AND d.track_id IN ' . db_ids($teil) . '
            ORDER BY d.track_id, d.bittiefe DESC, d.abtastrate DESC, d.id') as $d) {
            $dateien[(int) $d['track_id']] ??= $d;
        }
    }
    $aus = [];
    foreach ($ids as $tid) {
        $z = $zeilen[$tid] ?? null;
        $d = $dateien[$tid] ?? null;
        if ($z && $d) {
            $aus[] = ['track' => (int) $z['id'], 'titel' => (string) $z['titel'], 'nummer' => (string) ($z['nummer'] ?: $z['pos']), 'disc' => (int) $z['disc'],
                'discs' => (int) $z['discs'], 'mbid' => (string) $z['mbid'], 'aufnahme_mbid' => (string) $z['aufnahme_mbid'], 'album_id' => (int) $z['album_id'],
                'album' => (string) $z['album'], 'jahr' => $z['erstjahr'] ? (int) $z['erstjahr'] : null, 'album_kuenstler' => (string) $z['album_kuenstler'],
                'kuenstler' => (string) $z['kuenstler'], 'cover' => (string) $z['cover_datei'], 'format' => (string) $d['format'],
                'groesse' => (int) $d['groesse'], 'laenge_ms' => (int) $d['laenge_ms']];
        }
    }
    return ['titel' => $aus];
}

// ---------- Rufen (wir rufen andere Server) ----------

/** Rohe Anfrage an eine Basisadresse; null = nicht erreichbar oder nicht der erwartete Server */
/**
 * Versiegelte Anfrage an eine Gegenstelle. Der Klartext nennt den Absender („von“), damit niemand ein abgefangenes
 * Chiffrat gespiegelt an den Absender zurückschicken kann (crypto_box ist in beide Richtungen gleich). $z bekommt den
 * Zufallswert der Anfrage – die Antwort muss ihn zurückgeben, sonst gilt sie nicht (keine fremden/alten Antworten).
 */
function connect_anfrage_bauen(array $peer, string $m, array $a, ?string &$z = null): string
{
    $z = bin2hex(random_bytes(16));
    $klar = json_encode(['m' => $m, 'a' => $a, 't' => time(), 'z' => $z, 'von' => bin2hex(ausweis_oeffentlich()), 'v' => app_version(),
        'name' => connect_eigener_name(), 'ad' => connect_eigene_adressen()], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return CONNECT_MAGIE . ausweis_oeffentlich() . connect_versiegeln($klar, hex2bin($peer['schluessel']));
}

function connect_curl(string $basis, string $body, int $zeit = 60)
{
    $ch = curl_init(rtrim($basis, '/') . '/api/v1/connect');
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 4, CURLOPT_TIMEOUT => $zeit, CURLOPT_HTTPHEADER => ['Content-Type: application/octet-stream', 'User-Agent: Amberwave-Connect/' . app_version()],
        // Die Verbindung ist ohnehin Ende zu Ende verschlüsselt; im Heimnetz gibt es oft nur HTTP oder ein Zertifikat für einen anderen Namen
        CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_MAXFILESIZE_LARGE => CONNECT_STUECK + 1024 * 1024, CURLOPT_BUFFERSIZE => 256 * 1024]);
    // Im Heimnetz steht die Verbindung in Millisekunden – antwortet eine Heimnetz-Adresse nicht binnen 1,5 s, sind wir
    // woanders (Ortswechsel) und suchen lieber gleich den neuen Weg
    $host = (string) parse_url($basis, PHP_URL_HOST);
    if (str_ends_with($host, '.local') || (filter_var($host, FILTER_VALIDATE_IP) && filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false)) {
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, 1500);
    }
    return $ch;
}

function connect_antwort_oeffnen(array $peer, $roh, ?string $z = null): ?array
{
    if (!is_string($roh) || strlen($roh) < 44 || substr($roh, 0, 4) !== CONNECT_MAGIE) {
        return null;
    }
    $klar = connect_oeffnen(substr($roh, 4), hex2bin($peer['schluessel']));
    $r = $klar === null ? null : connect_entpacken($klar);
    // Die Antwort gehört zu genau dieser Anfrage und kommt von der Gegenstelle selbst (nicht gespiegelt)
    if ($r && (($z !== null && !hash_equals($z, (string) ($r[0]['z'] ?? ''))) || !hash_equals($peer['schluessel'], (string) ($r[0]['von'] ?? '')))) {
        return null;
    }
    if ($r && is_array($r[0]['_gesehen'] ?? null)) {
        connect_gesehen_merken($r[0]['_gesehen']);
    }
    return $r;
}

/** Kandidaten-Adressen einer Gegenstelle: [[art, basis], …] – Heimnetz zuerst */
function connect_kandidaten(array $peer): array
{
    $ad = json_decode((string) ($peer['adressen'] ?? ''), true) ?: [];
    $k = [];
    foreach (array_unique(array_merge(connect_lan_gefunden((int) $peer['id']), (array) ($ad['lan'] ?? []))) as $u) {
        $k[] = ['heimnetz', $u];
    }
    if (!empty($ad['direkt'])) {
        $k[] = ['direkt', $ad['direkt']];
    }
    if (!empty($ad['oeffentlich'])) {
        $k[] = ['tunnel', $ad['oeffentlich']];
    }
    if (!empty($ad['tunnel']) && $ad['tunnel'] !== ($ad['oeffentlich'] ?? '')) {
        $k[] = ['tunnel', $ad['tunnel']];
    }
    return $k;
}

/**
 * Den besten Weg zu einer Gegenstelle finden: alle Adressen gleichzeitig mit „hallo“ anfragen, die schnellste
 * Antwort mit dem richtigen Schlüssel gewinnt. Findet sich keiner, wird das Heimnetz rund um die bekannten
 * Heimnetz-Adressen abgesucht (neue IP vom Router). Gibt die aktualisierte Zeile zurück oder wirft.
 */
function connect_weg_suchen(array $peer, bool $heimnetz_suchen = true): array
{
    if (connect_rueck_aktiv($peer) && ($lan = connect_lan_weg($peer, true)) !== null) {
        return $lan;
    }
    if (connect_rueck_aktiv($peer)) {
        $t0 = microtime(true);
        [$kopf] = connect_rufen($peer, 'hallo', [], 20);
        db_tun("UPDATE connect_server SET weg = 'rueckkanal', weg_art = 'rueckkanal', weg_ms = :ms, weg_am = NOW(), zuletzt_am = NOW() WHERE id = :id",
            ['ms' => (int) round((microtime(true) - $t0) * 1000), 'id' => $peer['id']]);
        $peer = db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => $peer['id']]);
        $peer['_hallo'] = $kopf;
        return $peer;
    }
    $kand = connect_kandidaten($peer);
    $treffer = connect_parallel_hallo($peer, $kand);
    if (!$treffer && $heimnetz_suchen) {
        // Das Netz absuchen dauert Sekunden: höchstens einmal pro Minute je Gegenstelle, nicht bei jedem Klick
        $marke = connect_rueck_ordner((int) $peer['id']) . '/scan_am';
        $sm = @filemtime($marke);
        if ($sm === false || time() - $sm > 60) {
            @touch($marke);
            $kand2 = connect_heimnetz_absuchen($peer);
            $treffer = $kand2 ? connect_parallel_hallo($peer, $kand2) : null;
        }
    }
    if (!$treffer) {
        db_tun("UPDATE connect_server SET weg = '', weg_art = '', weg_ms = NULL, weg_am = NOW() WHERE id = :id", ['id' => $peer['id']]);
        throw new ApiFehler(t('„{name}“ ist gerade nicht erreichbar.', ['name' => $peer['name']]), 503);
    }
    [$art, $basis, $ms, $kopf] = $treffer;
    if ($art === 'heimnetz') {
        connect_lan_gefunden((int) $peer['id'], $basis);
    }
    $ad = is_array($kopf['adressen'] ?? null) ? connect_adressen_saeubern($kopf['adressen']) : (json_decode((string) $peer['adressen'], true) ?: []);
    if ($art === 'heimnetz' && !in_array($basis, $ad['lan'] ?? [], true)) {
        $ad['lan'] = array_values(array_unique(array_merge([$basis], $ad['lan'] ?? [])));
    }
    $erlaubt = is_array($kopf['rechte'] ?? null) ? array_intersect_key(array_map('boolval', $kopf['rechte']), CONNECT_RECHTE_STANDARD) : null;
    db_tun('UPDATE connect_server SET weg = :w, weg_art = :a, weg_ms = :ms, weg_am = NOW(), zuletzt_am = NOW(), adressen = :ad, name = :n, version = :v, dir_erlaubt = :de WHERE id = :id',
        ['w' => $basis, 'a' => $art, 'ms' => $ms, 'ad' => json_encode($ad), 'n' => mb_substr((string) ($kopf['name'] ?? $peer['name']), 0, 120),
            'v' => mb_substr((string) ($kopf['version'] ?? ''), 0, 40), 'de' => $erlaubt !== null ? json_encode($erlaubt) : $peer['dir_erlaubt'], 'id' => $peer['id']]);
    $peer = db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => $peer['id']]);
    $peer['_hallo'] = $kopf;
    return $peer;
}

/** „hallo“ an mehrere Adressen gleichzeitig; [art, basis, ms, kopf] der schnellsten gültigen Antwort oder null */
function connect_parallel_hallo(array $peer, array $kand, bool $kurz = false): ?array
{
    if (!$kand) {
        return null;
    }
    $mh = curl_multi_init();
    $griffe = [];
    $zs = [];
    foreach ($kand as $i => [$art, $basis]) {
        $ch = connect_curl($basis, connect_anfrage_bauen($peer, 'hallo', [], $z), $kurz ? 3 : 8);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, $kurz ? 900 : 3000);
        curl_multi_add_handle($mh, $ch);
        $griffe[$i] = $ch;
        $zs[$i] = $z;
    }
    $start = microtime(true);
    $best = null;
    do {
        $st = curl_multi_exec($mh, $laufend);
        if ($laufend) {
            curl_multi_select($mh, 0.2);
        }
        while ($info = curl_multi_info_read($mh)) {
            $ch = $info['handle'];
            $i = array_search($ch, $griffe, true);
            if ($info['result'] !== CURLE_OK || curl_getinfo($ch, CURLINFO_RESPONSE_CODE) !== 200) {
                continue;
            }
            $r = connect_antwort_oeffnen($peer, curl_multi_getcontent($ch), $zs[$i]);
            if ($r && !empty($r[0]['ok'])) {
                $ms = (int) round(curl_getinfo($ch, CURLINFO_TOTAL_TIME) * 1000);
                // Gleich schnell (±15 ms)? Dann der direktere Weg: Heimnetz vor Direktzugang vor Tunnel
                $rang = ['heimnetz' => 0, 'direkt' => 1, 'tunnel' => 2][$kand[$i][0]] ?? 3;
                if (!$best || $ms + $rang * 15 < $best[2] + $best[4] * 15) {
                    $best = [$kand[$i][0], $kand[$i][1], $ms, $r[0], $rang];
                }
            }
        }
        // Erste gültige Antwort aus dem Heimnetz: nicht auf langsamere Wege warten
        if ($best && $best[4] === 0) {
            break;
        }
        if ($best && microtime(true) - $start > ($best[2] / 1000) + 0.4) {
            break;   // die anderen sind deutlich langsamer
        }
    } while ($laufend && $st === CURLM_OK);
    foreach ($griffe as $ch) {
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $best ? array_slice($best, 0, 4) : null;
}

/** Neue IP vom Router? Das /24-Netz der bekannten Heimnetz-Adressen nach einem Amberwave mit diesem Schlüssel absuchen */
function connect_heimnetz_absuchen(array $peer): array
{
    $ad = json_decode((string) ($peer['adressen'] ?? ''), true) ?: [];
    $basen = [];
    $ports = [];
    // Nur Netze absuchen, in denen wir selbst stehen – das Heimnetz eines fernen Partners ist von hier aus nicht erreichbar
    $eigeneNetze = [];
    foreach (array_merge((array) (connect_eigene_ips()['lan'] ?? []), array_map(static fn($u) => (string) parse_url((string) $u, PHP_URL_HOST),
        json_decode((string) @file_get_contents(connect_ordner() . '/eigene_lan.json'), true) ?: [])) as $ip) {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $eigeneNetze[implode('.', array_slice(explode('.', $ip), 0, 3))] = true;
        }
    }
    foreach ((array) ($ad['lan'] ?? []) as $u) {
        $t = parse_url($u);
        $ports[] = (int) ($t['port'] ?? 80);
        if (!empty($t['host']) && filter_var($t['host'], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $netz = implode('.', array_slice(explode('.', $t['host']), 0, 3));
            if (isset($eigeneNetze[$netz])) {
                $basen[$netz . '|' . ($t['scheme'] ?? 'http') . '|' . ($t['port'] ?? '')] = [$netz, $t['scheme'] ?? 'http', $t['port'] ?? null];
            }
        }
    }
    // Hinter derselben öffentlichen IP wie wir? Dann steht er sehr wahrscheinlich in unserem Netz – dort suchen,
    // auf den Ports, die er nennt, und den üblichen (9950 Windows/Docker, 80 Amberwave OS, 8095)
    $eigen = connect_eigene_ips();
    if (!empty($ad['netz']) && ($eigen['oeffentlich'] ?? '') === $ad['netz']) {
        foreach ((array) ($eigen['lan'] ?? []) as $ip) {
            $netz = implode('.', array_slice(explode('.', $ip), 0, 3));
            foreach (array_slice(array_values(array_unique(array_merge($ports, [9950, 80, 8095]))), 0, 4) as $port) {
                $basen[$netz . '|http|' . $port] ??= [$netz, 'http', $port === 80 ? null : $port];
            }
        }
    }
    $funde = [];
    foreach (array_slice($basen, 0, 4) as [$netz, $schema, $port]) {
        $mh = curl_multi_init();
        $griffe = [];
        for ($i = 1; $i < 255; $i++) {
            $basis = $schema . '://' . $netz . '.' . $i . ($port ? ':' . $port : '');
            $ch = curl_init($basis . '/api/v1/ping');
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT_MS => 700, CURLOPT_TIMEOUT_MS => 1500,
                CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
            curl_multi_add_handle($mh, $ch);
            $griffe[$basis] = $ch;
        }
        do {
            curl_multi_exec($mh, $laufend);
            if ($laufend) {
                curl_multi_select($mh, 0.2);
            }
        } while ($laufend);
        foreach ($griffe as $basis => $ch) {
            $j = json_decode((string) curl_multi_getcontent($ch), true);
            if (is_array($j) && ($j['schluessel'] ?? '') === $peer['schluessel']) {
                $funde[] = ['heimnetz', $basis];
            }
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);
    }
    return $funde;
}

/**
 * Methode bei einer Gegenstelle aufrufen. Nutzt den gemerkten Weg (höchstens 5 Minuten alt), sonst wird neu gesucht;
 * bricht der Weg weg, einmal neu suchen und wiederholen. Gibt [kopf, binaer] zurück oder wirft ApiFehler.
 */
/** Gemerkten Weg zu einer Gegenstelle verwerfen (in der Datenbank und im übergebenen Datensatz) */
function connect_weg_vergessen(array $peer): array
{
    db_tun("UPDATE connect_server SET weg = '', weg_art = '', weg_am = NULL WHERE id = :id", ['id' => $peer['id']]);
    @unlink(connect_rueck_ordner((int) $peer['id']) . '/lan_geprueft');
    return array_merge($peer, ['weg' => '', 'weg_art' => '', 'weg_am' => null]);
}

/** Antwortet unter dem gemerkten Weg noch genau diese Gegenstelle? (/ping mit Ausweis, höchstens 1,5 s) */
function connect_weg_lebt(array $peer): bool
{
    $ch = curl_init(rtrim((string) $peer['weg'], '/') . '/api/v1/ping');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT_MS => 1500, CURLOPT_TIMEOUT_MS => 1500,
        CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0, CURLOPT_FOLLOWLOCATION => false, CURLOPT_MAXFILESIZE => 65536]);
    $j = json_decode((string) curl_exec($ch), true);
    curl_close($ch);
    return is_array($j) && hash_equals((string) $peer['schluessel'], (string) ($j['schluessel'] ?? ''));
}

/**
 * Netzwechsel-Wächter: Fingerabdruck des eigenen Netzes (Standard-Gateway samt seiner MAC-Adresse und Schnittstelle, unter
 * Windows die eigenen IPs). Ändert er sich – NUC vom Heim-WLAN an den Handy-Hotspot, neue IP –, sind alle gemerkten Wege
 * hinfällig: verwerfen, Heimnetz-Merker zurücksetzen, eigene IPs neu lernen. Höchstens alle 3 s gerechnet (auch über
 * Prozesse hinweg); liefert true, wenn sich das Netz seit dem letzten Mal geändert hat.
 */
function connect_netz_pruefen(): bool
{
    static $zuletzt = 0.0;
    if (microtime(true) - $zuletzt < 3) {
        return false;
    }
    $zuletzt = microtime(true);
    $datei = connect_ordner() . '/netz.json';
    $marke = connect_netz_marke();
    if ($marke === '') {
        return false;
    }
    $alt = (string) (json_decode((string) @file_get_contents($datei), true)['marke'] ?? '');
    if ($alt === $marke) {
        return false;
    }
    @file_put_contents($datei, json_encode(['marke' => $marke, 'am' => time()]), LOCK_EX);
    if ($alt === '') {
        return false;   // erstes Mal: nur merken
    }
    error_log('Connect: Netzwechsel erkannt – Wege werden neu gesucht');
    db_tun("UPDATE connect_server SET weg_am = NULL");
    foreach (glob(connect_ordner('rueck') . '/*/{lan_geprueft,lan_gesucht,scan_am}', GLOB_BRACE) ?: [] as $f) {
        @unlink($f);
    }
    @unlink(connect_ordner() . '/eigene_ips.json');
    return true;
}

function connect_netz_marke(): string
{
    $route = @file('/proc/net/route');
    if ($route) {
        $teile = [];
        foreach ($route as $z) {
            $f = preg_split('/\s+/', trim($z));
            if (($f[1] ?? '') === '00000000' && isset($f[2]) && strlen($f[2]) === 8 && $f[2] !== '00000000') {
                $gw = implode('.', array_reverse(array_map('hexdec', str_split($f[2], 2))));
                $mac = '';
                foreach (@file('/proc/net/arp') ?: [] as $a) {
                    $af = preg_split('/\s+/', trim($a));
                    if (($af[0] ?? '') === $gw) {
                        $mac = (string) ($af[3] ?? '');
                    }
                }
                $teile[] = $f[0] . '>' . $gw . '@' . $mac;
            }
        }
        sort($teile);
        return $teile ? implode(',', $teile) : 'kein-netz';
    }
    // Windows o. Ä.: die eigenen IPv4-Adressen
    $ips = @gethostbynamel((string) gethostname()) ?: [];
    sort($ips);
    return implode(',', $ips);
}

function connect_rufen(array $peer, string $m, array $a = [], int $zeit = 60): array
{
    if (connect_netz_pruefen()) {
        $peer = db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => $peer['id']]) ?: $peer;   // Wege eben verworfen
    }
    // Rückkanal nur, wenn es keinen Weg im Heimnetz gibt – das Heimnetz hat immer Vorrang
    if (connect_rueck_aktiv($peer) && ($lan = connect_lan_weg($peer)) !== null) {
        $peer = $lan;
    } elseif (connect_rueck_aktiv($peer)) {
        $roh = connect_rueck_rufen($peer, connect_anfrage_bauen($peer, $m, $a, $z), $zeit);
        if ($roh === null) {
            throw new ApiFehler(t('„{name}“ hat über den Rückkanal nicht rechtzeitig geantwortet.', ['name' => $peer['name']]), 504);
        }
        $r = connect_antwort_oeffnen($peer, $roh, $z);
        if (!$r) {
            throw new ApiFehler(t('„{name}“ antwortet nicht richtig.', ['name' => $peer['name']]), 503);
        }
        [$kopf, $binaer] = $r;
        if (empty($kopf['ok'])) {
            throw new ApiFehler((string) ($kopf['fehler'] ?? t('Der andere Server hat abgelehnt.')), (int) ($kopf['code'] ?? 400) ?: 400);
        }
        return [$kopf, $binaer];
    }
    $alter = $peer['weg_am'] ? time() - strtotime((string) $peer['weg_am']) : PHP_INT_MAX;
    $alt = $peer['weg'] !== '' && $peer['weg'] !== 'rueckkanal' && $alter < 300;
    // Länger als eine Minute nicht benutzt: erst kurz anklopfen (1,5 s) – ein veralteter Weg (Ortswechsel, neue IP) kostet
    // sonst bis zum Zeitlimit der eigentlichen Anfrage, statt gleich den neuen Weg zu suchen
    if ($alt && $alter > 60 && !connect_weg_lebt($peer)) {
        $peer = connect_weg_vergessen($peer);
        $alt = false;
    }
    if (!$alt) {
        $peer = connect_weg_suchen($peer);
        if ($peer['weg'] === 'rueckkanal') {
            return connect_rufen($peer, $m, $a, $zeit);
        }
    }
    for ($versuch = 0; $versuch < 2; $versuch++) {
        $ch = connect_curl($peer['weg'], connect_anfrage_bauen($peer, $m, $a, $z), $zeit);
        $roh = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $r = $code === 200 ? connect_antwort_oeffnen($peer, $roh, $z) : null;
        if ($r) {
            db_tun('UPDATE connect_server SET weg_am = NOW(), zuletzt_am = NOW() WHERE id = :id', ['id' => $peer['id']]);   // der Weg trägt – nicht alle 5 Minuten neu suchen
            [$kopf, $binaer] = $r;
            if (empty($kopf['ok'])) {
                throw new ApiFehler((string) ($kopf['fehler'] ?? t('Der andere Server hat abgelehnt.')), (int) ($kopf['code'] ?? 400) ?: 400);
            }
            return [$kopf, $binaer];
        }
        if ($versuch === 0) {
            // Weg weg (neue IP, Netzwechsel …): den gemerkten Weg verwerfen – sonst fände die Suche ihn gleich wieder –,
            // neu suchen und noch einmal
            $peer = connect_weg_suchen(connect_weg_vergessen($peer));
            if ($peer['weg'] === 'rueckkanal') {
                return connect_rufen($peer, $m, $a, $zeit);   // nur noch über den Rückkanal erreichbar
            }
        }
    }
    throw new ApiFehler(t('„{name}“ antwortet nicht richtig.', ['name' => $peer['name']]), 503);
}

// ---------- Koppeln ----------

function connect_einladung_datei(): string
{
    return connect_ordner() . '/einladung.json';
}

/** Admin: Code anzeigen (10 Minuten gültig, höchstens 5 Fehlversuche) */
function connect_einladung_erzeugen(array $admin): array
{
    $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    $e = ['code' => $code, 'bis' => time() + 600, 'versuche' => 0, 'von' => (int) $admin['id'], 'offen' => []];
    file_put_contents(connect_einladung_datei(), json_encode($e), LOCK_EX);
    @chmod(connect_einladung_datei(), 0600);
    ausweis_oeffentlich();
    log_sicherheitsereignis((int) $admin['id'], 'connect_code', '');
    return ['code' => $code, 'bis' => $e['bis'], 'rest' => 600, 'kennung' => ausweis_kennung(), 'name' => connect_eigener_name(), 'adressen' => connect_eigene_adressen()];
}

/** Läuft gerade ein Code? (für die Einstellungen nach dem Neuladen) */
function connect_einladung_aktiv(): ?array
{
    $e = json_decode((string) @file_get_contents(connect_einladung_datei()), true);
    if (!is_array($e) || ($e['bis'] ?? 0) <= time() || ($e['versuche'] ?? 0) >= 5) {
        return null;
    }
    return ['code' => (string) $e['code'], 'rest' => (int) $e['bis'] - time()];
}

function connect_einladung_beenden(): void
{
    @unlink(connect_einladung_datei());
}

function connect_cpace_g(string $code): string
{
    return sodium_crypto_core_ristretto255_from_hash(hash('sha512', 'amberwave-connect-v1|' . $code, true));
}

function connect_cpace_schluessel(string $K, string $Ya, string $Yb, string $pkA, string $pkB): array
{
    $T = 'awc1' . $Ya . $Yb . $pkA . $pkB;
    $k = hash('sha256', $K . $T, true);
    return [hash_hmac('sha256', 'A' . $T, $k), hash_hmac('sha256', 'B' . $T, $k)];
}

/** POST /api/v1/connect/koppeln (öffentlich): Schritte „start“ und „bestaetigen“ – nur solange ein Code gilt */
function connect_koppeln_empfangen(): array
{
    $fp = fopen(connect_einladung_datei(), 'c+');
    if (!$fp || !flock($fp, LOCK_EX)) {
        throw new ApiFehler(t('Kein Code aktiv.'), 404);
    }
    try {
        $e = json_decode((string) stream_get_contents($fp), true);
        if (!is_array($e) || (int) ($e['bis'] ?? 0) < time() || (int) ($e['versuche'] ?? 0) >= 5) {
            throw new ApiFehler(t('Kein Code aktiv – auf dem anderen Server einen neuen anzeigen lassen.'), 404);
        }
        $schritt = (string) api_wert('schritt', '');
        $pkB = hex2bin((string) api_wert('schluessel', '')) ?: '';
        if (strlen($pkB) !== 32 || hash_equals(bin2hex($pkB), bin2hex(ausweis_oeffentlich()))) {
            throw new ApiFehler(t('Ungültige Anfrage.'), 400);
        }
        if ($schritt === 'start') {
            $Yb = hex2bin((string) api_wert('y', '')) ?: '';
            if (strlen($Yb) !== 32 || !sodium_crypto_core_ristretto255_is_valid_point($Yb)) {
                throw new ApiFehler(t('Ungültige Anfrage.'), 400);
            }
            $e['versuche'] = (int) $e['versuche'] + 1;   // jeder Versuch zählt – Raten bringt nichts
            $ya = sodium_crypto_core_ristretto255_scalar_random();
            $Ya = sodium_crypto_scalarmult_ristretto255($ya, connect_cpace_g((string) $e['code']));
            $K = sodium_crypto_scalarmult_ristretto255($ya, $Yb);
            $pkA = ausweis_oeffentlich();
            [$macA, $macB] = connect_cpace_schluessel($K, $Ya, $Yb, $pkA, $pkB);
            $e['offen'][bin2hex($pkB)] = ['mac' => $macB];
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($e));
            // Name und Adressen gibt es erst, wenn die Gegenseite den Code bewiesen hat (Schritt „bestaetigen“)
            return ['y' => bin2hex($Ya), 'schluessel' => bin2hex($pkA), 'mac' => $macA];
        }
        if ($schritt === 'bestaetigen') {
            $o = $e['offen'][bin2hex($pkB)] ?? null;
            if (!$o || !hash_equals((string) $o['mac'], (string) api_wert('mac', ''))) {
                throw new ApiFehler(t('Der Code stimmt nicht.'), 403);
            }
            $name = mb_substr((string) api_wert('name', ''), 0, 120);
            $adressen = is_array(api_wert('adressen')) ? connect_adressen_saeubern(api_wert('adressen')) : [];
            $id = connect_server_speichern(bin2hex($pkB), $name, $adressen, (int) $e['von']);
            ftruncate($fp, 0);
            fclose($fp);
            $fp = null;
            connect_einladung_beenden();
            log_sicherheitsereignis((int) $e['von'], 'connect_gekoppelt', $name . ' ' . ausweis_kennung($pkB));
            return ['ok' => true, 'server' => $id, 'name' => connect_eigener_name(), 'adressen' => connect_eigene_adressen()];
        }
        throw new ApiFehler(t('Ungültige Anfrage.'), 400);
    } finally {
        if ($fp) {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }
}

function connect_server_speichern(string $pk_hex, string $name, array $adressen, ?int $von): int
{
    $kennung = ausweis_kennung(hex2bin($pk_hex));
    $vorhanden = db_wert('SELECT id FROM connect_server WHERE schluessel = :s', ['s' => $pk_hex]);
    if ($vorhanden) {
        db_tun('UPDATE connect_server SET name = :n, adressen = :a, gekoppelt_am = NOW() WHERE id = :id',
            ['n' => $name ?: $kennung, 'a' => json_encode($adressen), 'id' => $vorhanden]);
        return (int) $vorhanden;
    }
    return (int) db_einfuegen('INSERT INTO connect_server (schluessel, kennung, name, adressen, rechte, gekoppelt_von) VALUES (:s, :k, :n, :a, :r, :v)',
        ['s' => $pk_hex, 'k' => $kennung, 'n' => $name ?: $kennung, 'a' => json_encode($adressen), 'r' => json_encode(CONNECT_RECHTE_STANDARD), 'v' => $von]);
}

/** Admin auf diesem Server: Code des anderen eingeben und koppeln */
function connect_koppeln_mit(array $admin, string $adresse, string $code): array
{
    $adresse = rtrim(trim($adresse), '/');
    if (!preg_match('#^https?://#i', $adresse)) {
        $adresse = (filter_var(preg_replace('/:\d+$/', '', $adresse), FILTER_VALIDATE_IP) || str_ends_with(preg_replace('/:\d+$/', '', $adresse), '.local') ? 'http://' : 'https://') . $adresse;
    }
    if (!preg_match('#^https?://[^\s/]+$#i', $adresse)) {
        throw new ApiFehler(t('Bitte die Adresse des anderen Servers angeben, z. B. 192.168.178.20:8095 oder musik.example.de.'));
    }
    if (!preg_match('/^\d{6}$/', $code)) {
        throw new ApiFehler(t('Der Code hat sechs Ziffern.'));
    }
    $yb = sodium_crypto_core_ristretto255_scalar_random();
    $Yb = sodium_crypto_scalarmult_ristretto255($yb, connect_cpace_g($code));
    $pkB = ausweis_oeffentlich();
    $post = static function (array $daten) use ($adresse): array {
        $ch = curl_init($adresse . '/api/v1/connect/koppeln');
        curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($daten), CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_TIMEOUT => 20, CURLOPT_HTTPHEADER => ['Content-Type: application/json'], CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0]);
        $roh = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $j = is_string($roh) ? json_decode($roh, true) : null;
        if (!is_array($j)) {
            throw new ApiFehler(t('Unter dieser Adresse antwortet kein Amberwave.'));
        }
        if ($code !== 200 || ($j['ok'] ?? true) === false) {
            throw new ApiFehler((string) ($j['fehler'] ?? t('Der andere Server hat abgelehnt.')));
        }
        return $j;
    };
    $a = $post(['schritt' => 'start', 'y' => bin2hex($Yb), 'schluessel' => bin2hex($pkB)]);
    $Ya = hex2bin((string) ($a['y'] ?? '')) ?: '';
    $pkA = hex2bin((string) ($a['schluessel'] ?? '')) ?: '';
    if (strlen($Ya) !== 32 || strlen($pkA) !== 32 || !sodium_crypto_core_ristretto255_is_valid_point($Ya)) {
        throw new ApiFehler(t('Unerwartete Antwort des anderen Servers.'));
    }
    $K = sodium_crypto_scalarmult_ristretto255($yb, $Ya);
    [$macA, $macB] = connect_cpace_schluessel($K, $Ya, $Yb, $pkA, $pkB);
    if (!hash_equals($macA, (string) ($a['mac'] ?? ''))) {
        throw new ApiFehler(t('Der Code stimmt nicht.'));
    }
    $b = $post(['schritt' => 'bestaetigen', 'schluessel' => bin2hex($pkB), 'mac' => $macB, 'name' => connect_eigener_name(), 'adressen' => connect_eigene_adressen()]);
    $a['name'] = $b['name'] ?? '';
    $ad = is_array($b['adressen'] ?? null) ? connect_adressen_saeubern($b['adressen']) : [];
    // Die Adresse, über die es gerade geklappt hat, kommt sicher ins Adressbuch
    $h = (string) parse_url($adresse, PHP_URL_HOST);
    if (filter_var($h, FILTER_VALIDATE_IP) && filter_var($h, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE) === false) {
        $ad['lan'] = array_values(array_unique(array_merge([$adresse], $ad['lan'] ?? [])));
    } elseif (empty($ad['oeffentlich']) && empty($ad['direkt'])) {
        $ad['oeffentlich'] = $adresse;
    }
    $id = connect_server_speichern(bin2hex($pkA), (string) ($a['name'] ?? ''), $ad, (int) $admin['id']);
    log_sicherheitsereignis((int) $admin['id'], 'connect_gekoppelt', ($a['name'] ?? '') . ' ' . ausweis_kennung($pkA));
    try {
        connect_weg_suchen(connect_server($id), false);
    } catch (Throwable $e) {
        // gekoppelt ist gekoppelt – den Weg sucht er beim nächsten Mal
    }
    return connect_server_objekt(connect_server($id));
}

/** Heimnetz nach anderen Amberwave-Servern absuchen (für „Koppeln“: Liste zum Antippen) */
function connect_heimnetz_finden(): array
{
    $eigen = json_decode((string) @file_get_contents(connect_ordner() . '/eigene_lan.json'), true) ?: [];
    $netze = [];
    foreach ($eigen as $u) {
        $t = parse_url($u);
        if (!empty($t['host']) && filter_var($t['host'], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $netze[implode('.', array_slice(explode('.', $t['host']), 0, 3))] = true;
        }
    }
    foreach ((array) (connect_eigene_ips()['lan'] ?? []) as $ip) {   // von Gegenstellen gelernt
        $netze[implode('.', array_slice(explode('.', $ip), 0, 3))] = true;
    }
    $ports = [80, 9950, 8095, 8080];
    foreach ($eigen as $u) {
        $p = parse_url($u, PHP_URL_PORT);
        if ($p) {
            array_unshift($ports, (int) $p);
        }
    }
    $ports = array_slice(array_values(array_unique($ports)), 0, 4);
    $mein = bin2hex(ausweis_oeffentlich());
    $gekoppelt = array_flip(array_column(db_alle('SELECT schluessel FROM connect_server'), 'schluessel'));
    $funde = [];
    foreach (array_slice(array_keys($netze), 0, 2) as $netz) {
        $mh = curl_multi_init();
        $griffe = [];
        for ($i = 1; $i < 255; $i++) {
            foreach ($ports as $port) {
                $basis = 'http://' . $netz . '.' . $i . ($port === 80 ? '' : ':' . $port);
                $ch = curl_init($basis . '/api/v1/ping');
                curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT_MS => 700, CURLOPT_TIMEOUT_MS => 1500]);
                curl_multi_add_handle($mh, $ch);
                $griffe[$basis] = $ch;
            }
        }
        do {
            curl_multi_exec($mh, $laufend);
            if ($laufend) {
                curl_multi_select($mh, 0.2);
            }
        } while ($laufend);
        foreach ($griffe as $basis => $ch) {
            $j = json_decode((string) curl_multi_getcontent($ch), true);
            if (is_array($j) && ($j['app'] ?? '') === 'amberwave' && !empty($j['schluessel']) && $j['schluessel'] !== $mein && !isset($funde[$j['schluessel']])) {
                $funde[$j['schluessel']] = ['adresse' => $basis, 'name' => (string) ($j['name'] ?? ''), 'kennung' => (string) ($j['kennung'] ?? ''),
                    'version' => (string) ($j['version'] ?? ''), 'gekoppelt' => isset($gekoppelt[$j['schluessel']])];
            }
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);
    }
    return ['server' => array_values($funde), 'netze' => array_keys($netze)];
}

// ---------- Rückkanal ----------
// Ein Server ohne Adresse von außen (z. B. hinter CGNAT/Starlink, ohne Tunnel) hält bei gekoppelten Servern, die von
// außen erreichbar sind, ständig eine Anfrage „warten“ offen. Will so ein Server etwas von ihm, legt er die (schon
// versiegelte) Anfrage in eine Warteschlange; sie geht als Antwort auf „warten“ hinaus, die Antwort kommt per Upload
// an /api/v1/connect/rueck/<id> zurück. Alles bleibt Ende zu Ende verschlüsselt – der Weg ist nur umgedreht.

function connect_rueck_ordner(int $peerId): string
{
    $d = connect_ordner() . '/rueck/' . $peerId;
    if (!is_dir($d)) {
        @mkdir($d, 0700, true);
    }
    return $d;
}

/** Hält die Gegenstelle gerade einen Rückkanal zu uns offen? (zuletzt vor höchstens 75 s) */
function connect_rueck_aktiv(array $peer): bool
{
    $m = @filemtime(connect_ordner() . '/rueck/' . (int) $peer['id'] . '/lebt');
    return $m !== false && time() - $m < 75;
}

/**
 * Gibt es zu einer Gegenstelle mit Rückkanal einen direkten Weg im Heimnetz? Ein frisch gefundener gilt 5 Minuten;
 * sonst werden ihre Heimnetz-Adressen kurz angefragt (höchstens alle 60 s). Gibt die Zeile mit diesem Weg zurück oder null.
 */
function connect_lan_weg(array $peer, bool $erzwingen = false, array $extra = []): ?array
{
    if (!$erzwingen && $peer['weg_art'] === 'heimnetz' && $peer['weg'] !== '' && $peer['weg_am'] && time() - strtotime((string) $peer['weg_am']) < 300) {
        return $peer;
    }
    $merker = connect_rueck_ordner((int) $peer['id']) . '/lan_geprueft';
    $m = @filemtime($merker);
    if (!$erzwingen && $m !== false && time() - $m < 60) {
        return null;
    }
    @touch($merker);
    $kand = array_merge($extra, array_values(array_filter(connect_kandidaten($peer), static fn($k) => $k[0] === 'heimnetz')));
    $kand = array_values(array_intersect_key($kand, array_unique(array_column($kand, 1))));
    $treffer = $kand ? connect_parallel_hallo($peer, $kand, true) : null;   // im Heimnetz antwortet er sofort – kurz warten
    if (!$treffer) {
        $ad = json_decode((string) ($peer['adressen'] ?? ''), true) ?: [];
        $suche = connect_rueck_ordner((int) $peer['id']) . '/lan_gesucht';
        $sm = @filemtime($suche);
        if (!empty($ad['netz']) && (connect_eigene_ips()['oeffentlich'] ?? '') === $ad['netz'] && ($sm === false || time() - $sm > 600)) {
            @touch($suche);
            $funde = connect_heimnetz_absuchen($peer);
            $treffer = $funde ? connect_parallel_hallo($peer, $funde, true) : null;
        }
    }
    if (!$treffer) {
        return null;
    }
    connect_lan_gefunden((int) $peer['id'], $treffer[1]);
    [, $basis, $ms] = $treffer;
    db_tun("UPDATE connect_server SET weg = :w, weg_art = 'heimnetz', weg_ms = :ms, weg_am = NOW(), zuletzt_am = NOW() WHERE id = :id",
        ['w' => $basis, 'ms' => $ms, 'id' => $peer['id']]);
    $neu = db_zeile('SELECT * FROM connect_server WHERE id = :id', ['id' => $peer['id']]);
    $neu['_hallo'] = $treffer[3];
    return $neu;
}

/**
 * Eine Anfrage kam direkt aus dem Heimnetz, die Gegenstelle steht bei uns aber nicht auf „Heimnetz“: sie ist gerade nach Hause
 * gekommen (oder hat eine neue IP). Gleich unter ihrer Absender-Adresse anklopfen (900 ms, höchstens alle 10 s), statt auf die
 * minütliche Prüfung oder einen Klick auf „Verbindung prüfen“ zu warten.
 */
function connect_lan_vom_absender(array $peer): void
{
    $merker = connect_rueck_ordner((int) $peer['id']) . '/lan_absender';
    $m = @filemtime($merker);
    if ($m !== false && time() - $m < 10) {
        return;
    }
    @touch($merker);
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) || str_starts_with($ip, '127.')) {
        return;
    }
    $ad = json_decode((string) ($peer['adressen'] ?? ''), true) ?: [];
    $ports = [];
    foreach (array_merge(connect_lan_gefunden((int) $peer['id']), (array) ($ad['lan'] ?? [])) as $u) {
        $ports[] = (int) (parse_url((string) $u, PHP_URL_PORT) ?: 80);
    }
    $ports = array_slice(array_values(array_unique(array_merge($ports, [9950, 8095, 80]))), 0, 4);
    $extra = array_map(static fn($p) => ['heimnetz', 'http://' . $ip . ($p === 80 ? '' : ':' . $p)], $ports);
    try {
        connect_lan_weg($peer, true, $extra);
    } catch (Throwable $e) {
        error_log('Connect: Heimnetz-Probe: ' . log_sauber($e->getMessage()));
    }
}

/** „warten“ der Gegenstelle: bis zu 25 s auf Anfragen an sie warten, dann zurückgeben, was anliegt */
function connect_rueck_warten(array $peer): array
{
    $d = connect_rueck_ordner((int) $peer['id']);
    // Je Gegenstelle höchstens eine offene „warten“ – sonst könnte ein Partner alle Webserver-Prozesse belegen. Ein neues
    // „warten“ löst ein noch offenes ab: das alte hängt meist an einer Verbindung, die nach einem Netzwechsel der Gegenstelle
    // tot ist – es gibt sofort auf (Marke „neueste“), statt Anfragen in die tote Leitung zu schicken.
    $ich = bin2hex(random_bytes(8));
    @file_put_contents($d . '/warten.neueste', $ich, LOCK_EX);
    $sp = @fopen($d . '/warten.sperre', 'c');
    $hab = false;
    for ($i = 0; $sp && $i < 30 && !($hab = flock($sp, LOCK_EX | LOCK_NB)); $i++) {
        usleep(100000);
        if (@file_get_contents($d . '/warten.neueste') !== $ich) {
            break;   // ein noch neueres ist schon da
        }
    }
    if (!$hab) {
        if ($sp) {
            fclose($sp);
        }
        return [];
    }
    // … und insgesamt nur so viele, dass für Nutzer und Apps genug PHP-Prozesse frei bleiben (Windows Server: php-cgi hat
    // eine feste Zahl, ein Drittel davon; sonst 6). Wer keinen Platz bekommt, fragt nach einer kurzen Pause wieder.
    $platz = connect_rueck_platz();
    if ($platz === null) {
        flock($sp, LOCK_UN);
        fclose($sp);
        usleep(500000);
        return [];
    }
    @touch($d . '/lebt');
    // Liegengebliebenes (abgebrochene Webprozesse) wegräumen – älter als 10 Minuten
    foreach (glob($d . '/*.{anfrage,geholt,antwort,tmp,teil,auftrag}', GLOB_BRACE) ?: [] as $f) {
        if (@filemtime($f) < time() - 600) {
            @unlink($f);
        }
    }
    // Weg „Rückkanal“ vermerken – außer die Gegenstelle ist im Heimnetz zu haben (das hat Vorrang). Das prüfen wir hier
    // selbst (höchstens einmal pro Minute, 900 ms): sonst bliebe bei einem Server, der nie von sich aus anruft, dauerhaft
    // „Rückkanal“ stehen, obwohl beide im selben Netz sind – der andere hält den Kanal ja trotzdem offen.
    if (connect_lan_weg($peer) === null) {
        db_tun("UPDATE connect_server SET weg = 'rueckkanal', weg_art = 'rueckkanal', weg_am = NOW() WHERE id = :id
            AND NOT (weg_art = 'heimnetz' AND weg_am > NOW() - INTERVAL 300 SECOND)", ['id' => $peer['id']]);
    }
    db_schliessen();
    @set_time_limit(60);
    $ende = microtime(true) + 25;
    do {
        $liste = glob($d . '/*.anfrage') ?: [];
        if ($liste) {
            $aus = [];
            $groesse = 0;
            foreach ($liste as $f) {
                $id = basename($f, '.anfrage');
                $roh = (string) @file_get_contents($f);
                if (!@rename($f, $d . '/' . $id . '.geholt')) {
                    continue;   // hat schon ein anderes „warten“ genommen
                }
                $aus[] = ['id' => $id, 'anfrage' => base64_encode($roh)];
                $groesse += strlen($roh);
                if (count($aus) >= 8 || $groesse > 2 * 1024 * 1024) {
                    break;
                }
            }
            if ($aus) {
                return $aus;
            }
        }
        usleep(100000);
        if ((int) (microtime(true) * 10) % 10 === 0) {
            @touch($d . '/lebt');
        }
        if (@file_get_contents($d . '/warten.neueste') !== $ich) {
            return [];   // abgelöst (die Gegenstelle hat neu angeklopft, vermutlich über einen neuen Weg)
        }
    } while (microtime(true) < $ende && !connection_aborted());
    return [];
}

/** Anfrage über den Rückkanal schicken und auf die Antwort warten (rohe Bytes, oder null nach Ablauf) */
function connect_rueck_rufen(array $peer, string $anfrage, int $zeit = 60): ?string
{
    $d = connect_rueck_ordner((int) $peer['id']);
    $id = (int) $peer['id'] . '-' . bin2hex(random_bytes(16));
    file_put_contents($d . '/' . $id . '.tmp', $anfrage);
    rename($d . '/' . $id . '.tmp', $d . '/' . $id . '.anfrage');
    db_schliessen();
    $ende = microtime(true) + $zeit;
    $antwort = $d . '/' . $id . '.antwort';
    while (microtime(true) < $ende) {
        if (is_file($antwort)) {
            $roh = (string) file_get_contents($antwort);
            @unlink($antwort);
            @unlink($d . '/' . $id . '.geholt');
            return $roh;
        }
        usleep(50000);
    }
    foreach (['anfrage', 'geholt'] as $e) {
        @unlink($d . '/' . $id . '.' . $e);
    }
    return null;
}

/** Antwort der Gegenstelle auf eine Rückkanal-Anfrage annehmen (POST /api/v1/connect/rueck/<id>) */
function connect_rueck_antwort(string $id): void
{
    if (!preg_match('/^(\d+)-[0-9a-f]{32}$/', $id, $m)) {
        throw new ApiFehler(t('Ungültige Anfrage.'), 400);
    }
    $d = connect_ordner() . '/rueck/' . (int) $m[1];
    if (!is_file($d . '/' . $id . '.geholt')) {
        throw new ApiFehler(t('Ungültige Anfrage.'), 404);   // nur Antworten auf Anfragen, die wirklich abgeholt wurden
    }
    $in = fopen('php://input', 'rb');
    $tmp = $d . '/' . $id . '.teil';
    $out = @fopen($tmp, 'wb');
    if (!$in || !$out) {
        throw new ApiFehler(t('Interner Fehler auf dem anderen Server.'), 500);
    }
    $n = stream_copy_to_stream($in, $out, 20 * 1024 * 1024 + 1);
    fclose($out);
    $erwartet = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($n === false || $n > 20 * 1024 * 1024 || ($erwartet > 0 && $n !== $erwartet)) {
        @unlink($tmp);   // unvollständig angekommen – lieber Zeitablauf als eine halbe Antwort
        throw new ApiFehler(t('Ungültige Anfrage.'), 413);
    }
    rename($tmp, $d . '/' . $id . '.antwort');
}

/** Ist dieser Server von außen erreichbar (Tunnel oder öffentliche Adresse)? Ohne: Rückkanal zu Partnern mit Adresse */
function connect_von_aussen_erreichbar(): bool
{
    $modus = strtolower(trim((string) getenv('CONNECT_RUECKKANAL')));
    if ($modus === 'immer') {
        return false;
    }
    if ($modus === 'nie') {
        return true;
    }
    $ad = connect_eigene_adressen();
    return !empty($ad['tunnel']) || (!empty($ad['oeffentlich']) && connect_adresse_oeffentlich($ad['oeffentlich']));
}

/** Zeigt eine Adresse ins Internet (kein Heimnetz, kein localhost, kein .local)? */
function connect_adresse_oeffentlich(string $url): bool
{
    $h = strtolower((string) parse_url($url, PHP_URL_HOST));
    if ($h === '' || $h === 'localhost' || str_ends_with($h, '.local') || !str_contains($h, '.')) {
        return false;
    }
    if (filter_var($h, FILTER_VALIDATE_IP)) {
        return filter_var($h, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false;
    }
    return true;
}

/** Gekoppelte Server, über die wir einen Rückkanal halten (leer, wenn wir selbst erreichbar sind) */
function connect_rueck_partner(): array
{
    if (connect_von_aussen_erreichbar()) {
        return [];
    }
    $erzwungen = strtolower(trim((string) getenv('CONNECT_RUECKKANAL'))) === 'immer';
    return array_values(array_filter(db_alle('SELECT * FROM connect_server ORDER BY id'), static function ($p) use ($erzwungen) {
        $ad = json_decode((string) ($p['adressen'] ?? ''), true) ?: [];
        return $erzwungen || !empty($ad['tunnel']) || (!empty($ad['oeffentlich']) && connect_adresse_oeffentlich($ad['oeffentlich']));
    }));
}

// ---------- Heimnetz besser erkennen ----------

/** Von wo kam die Anfrage? Im Heimnetz die private IP des Anrufers, über Tunnel/Internet seine öffentliche */
function connect_gesehen(): ?array
{
    $cf = (string) ($_SERVER['HTTP_CF_CONNECTING_IP'] ?? '');
    if ($cf !== '' && filter_var($cf, FILTER_VALIDATE_IP)) {
        return ['oeffentlich' => $cf];
    }
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR']) || !empty($_SERVER['HTTP_X_REAL_IP']) || !empty($_SERVER['HTTP_FORWARDED'])) {
        return null;   // hinter einem anderen Proxy: nicht sicher zu sagen
    }
    $von = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (!filter_var($von, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        return null;
    }
    $privat = filter_var($von, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
    if ($privat && connect_absender_ist_proxy($von)) {
        return null;   // ein Proxy ohne Kopfzeilen: weder Heimnetz noch eine brauchbare öffentliche Adresse
    }
    return $privat ? (str_starts_with($von, '127.') ? null : ['lan' => $von]) : ['oeffentlich' => $von];
}

/** Eigene IPs, wie Gegenstellen sie gesehen haben: lan (bis zu 3) und oeffentlich */
function connect_eigene_ips(): array
{
    static $c = null;
    return $c ??= (json_decode((string) @file_get_contents(connect_ordner() . '/eigene_ips.json'), true) ?: []);
}

function connect_gesehen_merken(array $g): void
{
    $alt = connect_eigene_ips();
    $neu = $alt;
    $lan = (string) ($g['lan'] ?? '');
    if ($lan !== '' && filter_var($lan, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)
        && filter_var($lan, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE) === false && !preg_match('/^172\.(1[7-9]|2\d|3[01])\./', $lan)) {
        // (Docker-Netze 172.17–31 sind die eigene Brücke, nicht das Heimnetz)
        $neu['lan'] = array_slice(array_values(array_unique(array_merge([$lan], (array) ($alt['lan'] ?? [])))), 0, 3);
    }
    $oe = (string) ($g['oeffentlich'] ?? '');
    if ($oe !== '' && filter_var($oe, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
        $neu['oeffentlich'] = $oe;
    }
    if ($neu != $alt) {
        @file_put_contents(connect_ordner() . '/eigene_ips.json', json_encode($neu), LOCK_EX);
    }
}

/** Aus gelernten Heimnetz-IPs Adressen bauen: mit den Ports, unter denen wir bekannt sind, sonst den üblichen */
function connect_lan_aus_ips(array $urls, array $ips): array
{
    $ports = [];
    foreach ($urls as $u) {
        $ports[] = (int) (parse_url((string) $u, PHP_URL_PORT) ?: 80);
    }
    $app = parse_url((string) konfig()['app_url']);
    if (!empty($app['port'])) {
        $ports[] = (int) $app['port'];
    }
    $ports = array_slice(array_values(array_unique($ports ?: [9950, 80])), 0, 2);
    $aus = [];
    foreach ($ips as $ip) {
        foreach ($ports as $p) {
            $u = 'http://' . $ip . ($p === 80 ? '' : ':' . $p);
            $da = false;
            foreach ($urls as $x) {
                $da = $da || parse_url((string) $x, PHP_URL_HOST) === $ip;
            }
            if (!$da) {
                $aus[] = $u;
            }
        }
    }
    return $aus;
}

/** Heimnetz-Adressen einer Gegenstelle, unter denen wir sie selbst schon erreicht haben (bleiben, auch wenn sie sie nicht nennt) */
function connect_lan_gefunden(int $peerId, ?string $neu = null): array
{
    $datei = connect_ordner() . '/lan_gefunden.json';
    if ($neu === null) {
        return (array) ((json_decode((string) @file_get_contents($datei), true) ?: [])[$peerId] ?? []);
    }
    $alle = connect_json_aendern($datei, static function (array $alle) use ($peerId, $neu) {
        $l = (array) ($alle[$peerId] ?? []);
        if (($l[0] ?? '') === $neu) {
            return null;
        }
        $alle[$peerId] = array_slice(array_values(array_unique(array_merge([$neu], $l))), 0, 3);
        return $alle;
    });
    return (array) ($alle[$peerId] ?? []);
}

/** Stand des Rückkanals zu einer Gegenstelle (von beiden Seiten aus gesehen): hält sie einen offen? Halten wir einen? */
function connect_rueck_stand(int $peerId): ?array
{
    $d = connect_ordner() . '/rueck/' . $peerId;
    $lebt = @filemtime($d . '/lebt');
    $st = json_decode((string) @file_get_contents($d . '/status.json'), true) ?: [];
    if ($lebt === false && !$st) {
        return null;
    }
    return ['haelt_zu_uns' => $lebt !== false && time() - $lebt < 75, 'zuletzt_ok' => isset($st['ok_am']) ? iso(date('Y-m-d H:i:s', (int) $st['ok_am'])) : null,
        'fehler' => (string) ($st['fehler'] ?? ''), 'fehler_am' => isset($st['fehler_am']) ? iso(date('Y-m-d H:i:s', (int) $st['fehler_am'])) : null];
}

/** Beim Trennen: alles weg, was zu dieser Gegenstelle gehört (Rückkanal-Ordner, Bild-Cache, gemerkte Heimnetz-Wege) */
function connect_aufraeumen_nach_trennen(int $peerId): void
{
    foreach ([connect_ordner() . '/rueck/' . $peerId, connect_ordner() . '/bilder/' . $peerId] as $o) {
        foreach (glob($o . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($o);
    }
    connect_json_aendern(connect_ordner() . '/lan_gefunden.json', static function (array $a) use ($peerId) { unset($a[$peerId]); return $a; });
    connect_json_aendern(connect_ordner() . '/freigaben.json', static function (array $a) use ($peerId) { unset($a[$peerId]); return $a; });
}

