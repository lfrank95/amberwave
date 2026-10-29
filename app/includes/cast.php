<?php
// Google Cast (CASTV2): Android TV/Google TV, Nest Hub und Nest Audio, Chromecast (auch Audio und Gruppen), Fernseher und
// Lautsprecher mit „Chromecast built-in“.
//
// Finden: mDNS-Anfrage „_googlecast._tcp.local“ direkt an jede Adresse (Unicast, Port 5353 – das Gerät antwortet an den
// Absender, so klappt es auch aus einem Docker-Netz ohne Multicast). Steuern: TLS-Verbindung auf Port 8009, Nachrichten als
// Protobuf „CastMessage“ mit JSON darin. Abgespielt wird mit dem Standard-Empfänger von Google (App CC1AD845), der die
// Musik wie ein DLNA-Gerät selbst vom Server holt; der nächste Titel wird in dessen Warteschlange vorgeladen (lückenlos,
// soweit das Gerät es kann).
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

const CAST_APP = 'CC1AD845';   // Default Media Receiver (Standard-Empfänger von Google)

/**
 * App-ID des eigenen Amberwave-Empfängers (cast/empfaenger.html, in der Google Cast SDK Developer Console registriert;
 * CAST_APP_ID in der .env oder in den Einstellungen). Leer = Standard-Empfänger von Google.
 */
function cast_app_id(): string
{
    require_once __DIR__ . '/einstellungen.php';
    $id = strtoupper(trim(einstellung('cast_app_id')));
    return preg_match('/^[0-9A-F]{8}$/', $id) ? $id : '';
}

/** Ist das eine unserer Apps (eigener Empfänger oder Standard-Empfänger)? */
function cast_ist_unsere_app(?string $id): bool { return $id !== null && ($id === CAST_APP || ($id !== '' && $id === cast_app_id())); }

/**
 * Adresse, unter der Cast-Geräte Cover und Empfänger-Seite laden: möglichst HTTPS (der Empfänger ist eine HTTPS-Seite –
 * Bilder über http lädt sie nicht immer). Direktzugang im Heimnetz, sonst APP_URL mit https, sonst die Heimnetz-Adresse.
 */
function cast_https_basis(): string
{
    require_once __DIR__ . '/direktzugang.php';
    $d = direkt_url();
    if ($d !== '') return $d;
    $a = konfig()['app_url'];
    if (str_starts_with($a, 'https://')) return $a;
    return hn_basis()['url'];
}
const CAST_NS_CON = 'urn:x-cast:com.google.cast.tp.connection';
const CAST_NS_HB = 'urn:x-cast:com.google.cast.tp.heartbeat';
const CAST_NS_RCV = 'urn:x-cast:com.google.cast.receiver';
const CAST_NS_MEDIA = 'urn:x-cast:com.google.cast.media';
const CAST_ICH = 'sender-amberwave';
const CAST_NS_AW = 'urn:x-cast:de.amberwave';   // eigener Kanal zum Amberwave-Empfänger (Warteschlange, Sprung)

/* ---------------------------------------------------------------------------------------------------------------- */
/* Protobuf (nur das Nötige für CastMessage)                                                                         */

function cast_varint(int $n): string
{
    $s = '';
    do {
        $b = $n & 0x7f;
        $n >>= 7;
        $s .= chr($n ? $b | 0x80 : $b);
    } while ($n);
    return $s;
}

function cast_kodieren(string $quelle, string $ziel, string $ns, string $text): string
{
    $feld = static fn(int $nr, string $s) => chr(($nr << 3) | 2) . cast_varint(strlen($s)) . $s;
    $pb = "\x08\x00" . $feld(2, $quelle) . $feld(3, $ziel) . $feld(4, $ns) . "\x28\x00" . $feld(6, $text);
    return pack('N', strlen($pb)) . $pb;
}

/** CastMessage → [quelle, ziel, namespace, text] */
function cast_dekodieren(string $pb): array
{
    $aus = [2 => '', 3 => '', 4 => '', 6 => ''];
    $i = 0;
    $n = strlen($pb);
    $lies = static function () use ($pb, &$i, $n): int {
        $v = 0; $sh = 0;
        while ($i < $n) {
            $b = ord($pb[$i++]);
            $v |= ($b & 0x7f) << $sh;
            if (!($b & 0x80)) break;
            $sh += 7;
        }
        return $v;
    };
    while ($i < $n) {
        $tag = $lies();
        $nr = $tag >> 3;
        $wt = $tag & 7;
        if ($wt === 0) {
            $lies();
        } elseif ($wt === 2) {
            $len = $lies();
            $wert = substr($pb, $i, $len);
            $i += $len;
            if (isset($aus[$nr])) $aus[$nr] = $wert;
        } else {
            break;
        }
    }
    return [$aus[2], $aus[3], $aus[4], $aus[6]];
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Verbindung                                                                                                        */

class CastFehler extends RuntimeException {}

final class CastVerbindung
{
    /** @var resource|null */
    public $s = null;
    public string $puffer = '';
    public int $req = 1;
    public array $empfaenger = [];      // letzter RECEIVER_STATUS
    public array $media = [];           // letzter MEDIA_STATUS (ein Eintrag)
    public ?string $transport = null;   // Verbindung zur laufenden App
    public ?string $sitzung = null;
    public array $warten = [];          // requestId → Antwort
    public array $nachrichten = [];     // sonstige (QUEUE_CHANGE …)
    public float $pingZeit = 0.0;
    public float $lebt = 0.0;

    public function __construct(public string $ip, public int $port = 8009, float $timeout = 3.0)
    {
        $ctx = stream_context_create(['ssl' => ['verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true]]);
        $s = @stream_socket_client("tls://{$ip}:{$port}", $nr, $text, $timeout, STREAM_CLIENT_CONNECT, $ctx);
        if (!$s) {
            throw new CastFehler(t('Cast-Gerät {ip}:{port} antwortet nicht', ['ip' => $ip, 'port' => $port]) . ($text ? " ({$text})" : ''));
        }
        stream_set_blocking($s, false);
        $this->s = $s;
        $this->lebt = microtime(true);
        $this->senden(CAST_NS_CON, 'receiver-0', ['type' => 'CONNECT', 'origin' => (object) []]);
    }

    public function offen(): bool { return is_resource($this->s) && !feof($this->s) && microtime(true) - $this->lebt < 30; }

    public function schliessen(): void
    {
        if (is_resource($this->s)) {
            try { $this->senden(CAST_NS_CON, 'receiver-0', ['type' => 'CLOSE']); } catch (Throwable $e) {}
            @fclose($this->s);
        }
        $this->s = null;
    }

    public function senden(string $ns, string $ziel, array $daten): void
    {
        if (!is_resource($this->s)) {
            throw new CastFehler(t('Verbindung zum Cast-Gerät getrennt'));
        }
        $roh = cast_kodieren(CAST_ICH, $ziel, $ns, json_encode($daten, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        stream_set_blocking($this->s, true);
        $ok = @fwrite($this->s, $roh);
        stream_set_blocking($this->s, false);
        if ($ok === false || $ok < strlen($roh)) {
            throw new CastFehler(t('Senden an das Cast-Gerät fehlgeschlagen'));
        }
    }

    /** Ankommendes lesen und verarbeiten (Herzschlag beantworten, Zustände merken); $sek > 0: so lange auf Daten warten */
    public function pumpen(float $sek = 0.0): void
    {
        if (!is_resource($this->s)) {
            return;
        }
        $ende = microtime(true) + $sek;
        do {
            $r = [$this->s]; $w = $x = null;
            $rest = max(0.0, $ende - microtime(true));
            $bereit = @stream_select($r, $w, $x, (int) $rest, (int) (fmod($rest, 1.0) * 1e6));
            for ($k = 0; $k < 50; $k++) {
                $d = @fread($this->s, 65536);
                if ($d === false || $d === '') break;
                $this->puffer .= $d;
                $this->lebt = microtime(true);
            }
            $neu = false;
            while (strlen($this->puffer) >= 4) {
                $len = unpack('N', substr($this->puffer, 0, 4))[1];
                if (strlen($this->puffer) < 4 + $len) break;
                $pb = substr($this->puffer, 4, $len);
                $this->puffer = substr($this->puffer, 4 + $len);
                $this->verarbeiten(...cast_dekodieren($pb));
                $neu = true;
            }
            if ($neu && $sek > 0 && $this->warten) {
                return;   // jemand wartet auf eine Antwort – nachsehen lassen
            }
        } while (microtime(true) < $ende && $bereit !== false);
    }

    private function verarbeiten(string $quelle, string $ziel, string $ns, string $text): void
    {
        $j = json_decode($text, true);
        if (!is_array($j)) return;
        $typ = (string) ($j['type'] ?? '');
        if ($ns === CAST_NS_HB) {
            if ($typ === 'PING') $this->senden(CAST_NS_HB, $quelle, ['type' => 'PONG']);
            return;
        }
        if ($ns === CAST_NS_CON && $typ === 'CLOSE') {
            if ($quelle === $this->transport) { $this->transport = null; }
            else { @fclose($this->s); $this->s = null; }
            return;
        }
        if ($typ === 'RECEIVER_STATUS') $this->empfaenger = $j['status'] ?? [];
        if ($typ === 'MEDIA_STATUS') {
            $m = $j['status'][0] ?? null;
            if ($m) {
                // Teilmeldungen ergänzen das Bekannte (media steht nicht in jeder Meldung)
                $this->media = ($m['mediaSessionId'] ?? null) === ($this->media['mediaSessionId'] ?? null) ? array_merge($this->media, $m) : $m;
            } elseif (isset($j['status'])) {
                $this->media = [];
            }
        }
        if (isset($j['requestId']) && array_key_exists((int) $j['requestId'], $this->warten)) {
            $this->warten[(int) $j['requestId']] = $j;
        } elseif (!in_array($typ, ['RECEIVER_STATUS', 'MEDIA_STATUS'], true)) {
            $this->nachrichten[] = $j + ['_ns' => $ns];
            $this->nachrichten = array_slice($this->nachrichten, -20);
        }
    }

    /** Anfrage mit requestId senden und auf die Antwort warten */
    public function anfrage(string $ns, string $ziel, array $daten, float $timeout = 5.0): array
    {
        $id = $this->req++;
        $daten['requestId'] = $id;
        $this->warten[$id] = null;
        $this->senden($ns, $ziel, $daten);
        $ende = microtime(true) + $timeout;
        while (microtime(true) < $ende) {
            $this->pumpen(min(0.25, max(0.01, $ende - microtime(true))));
            if ($this->warten[$id] !== null) {
                $a = $this->warten[$id];
                unset($this->warten[$id]);
                return $a;
            }
            if (!is_resource($this->s)) break;
        }
        unset($this->warten[$id]);
        throw new CastFehler($daten['type'] ?? null ? t('Cast-Gerät antwortet nicht auf {art}', ['art' => $daten['type']]) : t('Cast-Gerät antwortet nicht auf die Anfrage'));
    }

    public function herzschlag(): void
    {
        if (microtime(true) - $this->pingZeit > 5) {
            $this->pingZeit = microtime(true);
            try { $this->senden(CAST_NS_HB, 'receiver-0', ['type' => 'PING']); } catch (Throwable $e) {}
        }
    }

    // ---------- Empfänger ----------
    public function empfaengerStatus(): array
    {
        $a = $this->anfrage(CAST_NS_RCV, 'receiver-0', ['type' => 'GET_STATUS']);
        return $a['status'] ?? [];
    }

    /** Läuft gerade eine App? ['appId', 'displayName', 'transportId', 'sessionId'] oder null */
    public function app(): ?array
    {
        $apps = $this->empfaenger['applications'] ?? [];
        foreach ($apps as $a) {
            if (!($a['isIdleScreen'] ?? false)) return $a;
        }
        return null;
    }

    public ?string $hinweis = null;
    public bool $eigenGescheitert = false;
    public string $appId = '';     // z. B. „eigener Empfänger startet nicht – Standard-Empfänger“

    /** Amberwave-Empfänger (sonst Standard-Empfänger) starten oder übernehmen und verbinden */
    public function mediaApp(): string
    {
        $this->empfaengerStatus();
        $a = $this->app();
        $eigen = cast_app_id();
        if (!$a || !cast_ist_unsere_app($a['appId'] ?? null) || ($eigen !== '' && ($a['appId'] ?? '') === CAST_APP && !$this->eigenGescheitert)) {
            $a = null;
            foreach (array_values(array_unique(array_filter([$this->eigenGescheitert ? '' : $eigen, CAST_APP]))) as $id) {
                $r = $this->anfrage(CAST_NS_RCV, 'receiver-0', ['type' => 'LAUNCH', 'appId' => $id], 15.0);
                if (($r['type'] ?? '') === 'LAUNCH_ERROR') {
                    if ($id !== CAST_APP) {
                        // nicht veröffentlicht und Gerät nicht als Testgerät eingetragen, oder Seite nicht erreichbar
                        $this->eigenGescheitert = true;
                        $this->hinweis = t('Amberwave-Bildschirm startet nicht ({grund}) – Standard-Empfänger von Google', ['grund' => $r['reason'] ?? t('unbekannt')]);
                        continue;
                    }
                    throw new CastFehler(t('Player startet nicht: {grund}', ['grund' => $r['reason'] ?? t('unbekannt')]));
                }
                $this->empfaenger = $r['status'] ?? $this->empfaenger;
                $a = $this->app();
                for ($i = 0; $i < 30 && (!$a || ($a['appId'] ?? '') !== $id); $i++) {
                    $this->pumpen(0.3);
                    $a = $this->app();
                }
                if ($a && ($a['appId'] ?? '') === $id) break;
                if ($id !== CAST_APP) { $this->eigenGescheitert = true; $this->hinweis = t('Amberwave-Bildschirm startet nicht – Standard-Empfänger von Google'); }
                $a = null;
            }
            if (!$a) throw new CastFehler(t('Player startet nicht'));
        }
        if ($this->transport !== $a['transportId']) {
            $this->transport = (string) $a['transportId'];
            $this->appId = (string) ($a['appId'] ?? '');
            $this->sitzung = (string) ($a['sessionId'] ?? '');
            $this->senden(CAST_NS_CON, $this->transport, ['type' => 'CONNECT', 'origin' => (object) []]);
            $this->media = [];
        }
        return $this->transport;
    }

    /** Ist unsere App (noch) dran? */
    public function unsere(): bool
    {
        $a = $this->app();
        return $a && cast_ist_unsere_app($a['appId'] ?? null) && $this->transport === ($a['transportId'] ?? null);
    }

    /** Läuft der eigene Amberwave-Empfänger (nicht der Standard-Empfänger)? */
    public function eigener(): bool { return $this->transport !== null && $this->appId !== '' && $this->appId !== CAST_APP && $this->unsere(); }

    /** Nachricht an den Amberwave-Empfänger (nur wenn er läuft) */
    public function anEmpfaenger(array $daten): void
    {
        if ($this->eigener()) $this->senden(CAST_NS_AW, $this->transport, $daten);
    }

    /** Nachrichten des Amberwave-Empfängers abholen (z. B. „springen“ nach Doppeltipp am Nest Hub) */
    public function vomEmpfaenger(): array
    {
        $aus = [];
        $rest = [];
        foreach ($this->nachrichten as $n) {
            if (($n['_ns'] ?? '') === CAST_NS_AW) $aus[] = $n; else $rest[] = $n;
        }
        $this->nachrichten = $rest;
        return $aus;
    }

    public function lautstaerke(float $level): void
    {
        $this->anfrage(CAST_NS_RCV, 'receiver-0', ['type' => 'SET_VOLUME', 'volume' => ['level' => max(0.0, min(1.0, $level))]]);
    }

    public function appStoppen(): void
    {
        $a = $this->app();
        if ($a && cast_ist_unsere_app($a['appId'] ?? null)) {
            $this->anfrage(CAST_NS_RCV, 'receiver-0', ['type' => 'STOP', 'sessionId' => $a['sessionId']]);
        }
        $this->transport = null;
        $this->media = [];
    }

    // ---------- Medien ----------
    /** Titel laden (ersetzt die Warteschlange des Geräts) – wirft CastFehler bei LOAD_FAILED */
    public function laden(array $media, float $ab = 0.0, bool $autoplay = true): array
    {
        $t = $this->mediaApp();
        $a = $this->anfrage(CAST_NS_MEDIA, $t, ['type' => 'LOAD', 'media' => $media, 'autoplay' => $autoplay, 'currentTime' => max(0.0, $ab)], 15.0);
        if (in_array($a['type'] ?? '', ['LOAD_FAILED', 'LOAD_CANCELLED', 'INVALID_REQUEST', 'ERROR'], true)) {
            throw new CastFehler(($a['type'] ?? '') . (isset($a['detailedErrorCode']) ? ' ' . $a['detailedErrorCode'] : '') . (isset($a['reason']) ? ' ' . $a['reason'] : ''));
        }
        if (($a['type'] ?? '') === 'MEDIA_STATUS') {
            $this->media = $a['status'][0] ?? $this->media;
        }
        return $this->media;
    }

    /** Titel hinten an die Warteschlange des Geräts (vorladen); gibt die Item-ID zurück oder null */
    public function einreihen(array $media, float $vorlauf = 10.0): ?int
    {
        $sid = $this->media['mediaSessionId'] ?? null;
        if (!$sid || !$this->transport) return null;
        $a = $this->anfrage(CAST_NS_MEDIA, $this->transport, ['type' => 'QUEUE_INSERT', 'mediaSessionId' => $sid,
            'items' => [['media' => $media, 'autoplay' => true, 'preloadTime' => $vorlauf]]], 6.0);
        if (in_array($a['type'] ?? '', ['INVALID_REQUEST', 'ERROR'], true)) {
            throw new CastFehler(t('Warteschlange: {grund}', ['grund' => $a['reason'] ?? $a['type']]));
        }
        $ids = $this->anfrage(CAST_NS_MEDIA, $this->transport, ['type' => 'QUEUE_GET_ITEM_IDS', 'mediaSessionId' => $sid], 4.0);
        $l = $ids['itemIds'] ?? [];
        return $l ? (int) end($l) : null;
    }

    public function entfernen(array $itemIds): void
    {
        $sid = $this->media['mediaSessionId'] ?? null;
        if (!$sid || !$this->transport || !$itemIds) return;
        $this->anfrage(CAST_NS_MEDIA, $this->transport, ['type' => 'QUEUE_REMOVE', 'mediaSessionId' => $sid, 'itemIds' => array_values($itemIds)], 4.0);
    }

    /** PLAY, PAUSE, STOP, SEEK (mit currentTime) */
    public function befehl(string $typ, array $extra = []): void
    {
        $sid = $this->media['mediaSessionId'] ?? null;
        if (!$sid || !$this->transport) throw new CastFehler(t('Nichts geladen'));
        $this->anfrage(CAST_NS_MEDIA, $this->transport, ['type' => $typ, 'mediaSessionId' => $sid] + $extra, 5.0);
    }

    public function mediaStatus(): array
    {
        if (!$this->transport) return [];
        $a = $this->anfrage(CAST_NS_MEDIA, $this->transport, ['type' => 'GET_STATUS'], 4.0);
        if (($a['type'] ?? '') === 'MEDIA_STATUS') {
            $m = $a['status'][0] ?? null;
            $this->media = $m ? array_merge($this->media, $m) : [];
        }
        return $this->media;
    }
}

/** Verbindung je Gerät (im Agenten dauerhaft, in einer API-Anfrage für deren Dauer) */
function cast_verbindung(array $g, bool $neu = false): CastVerbindung
{
    $k = $g['ip'] . ':' . ((int) ($g['steuer_port'] ?: 8009));
    $alle = &$GLOBALS['cast_verbindungen'];
    $alle ??= [];
    if (!$neu && isset($alle[$k]) && $alle[$k]->offen()) {
        return $alle[$k];
    }
    if (isset($alle[$k])) $alle[$k]->schliessen();
    unset($alle[$k]);
    $alle[$k] = new CastVerbindung($g['ip'], (int) ($g['steuer_port'] ?: 8009));
    return $alle[$k];
}

/** Agent: alle offenen Verbindungen lesen und den Herzschlag halten; tote entfernen */
function cast_verbindungen_pumpen(): void
{
    foreach ($GLOBALS['cast_verbindungen'] ?? [] as $k => $c) {
        try {
            $c->pumpen(0);
            $c->herzschlag();
        } catch (Throwable $e) {
        }
        if (!$c->offen()) {
            $c->schliessen();
            unset($GLOBALS['cast_verbindungen'][$k]);
        }
    }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Finden                                                                                                            */

/** DNS-Name lesen (mit Komprimierung) ab $i; $i wird weitergesetzt */
function cast_dns_name(string $d, int &$i): string
{
    $teile = [];
    $sprung = -1;
    for ($n = 0; $n < 40 && $i < strlen($d); $n++) {
        $l = ord($d[$i]);
        if ($l === 0) { $i++; break; }
        if (($l & 0xc0) === 0xc0) {
            $ziel = (($l & 0x3f) << 8) | ord($d[$i + 1]);
            if ($sprung < 0) $sprung = $i + 2;
            $i = $ziel;
            continue;
        }
        $teile[] = substr($d, $i + 1, $l);
        $i += 1 + $l;
    }
    if ($sprung >= 0) $i = $sprung;
    return implode('.', $teile);
}

/** mDNS-Antwort → ['name', 'modell', 'id', 'port', 'ca'] (aus TXT und SRV) */
function cast_mdns_lesen(string $d): ?array
{
    if (strlen($d) < 12) return null;
    $q = unpack('n', substr($d, 4, 2))[1];
    $rr = unpack('n', substr($d, 6, 2))[1] + unpack('n', substr($d, 8, 2))[1] + unpack('n', substr($d, 10, 2))[1];
    $i = 12;
    for ($k = 0; $k < $q; $k++) { cast_dns_name($d, $i); $i += 4; }
    $txt = [];
    $port = 0;
    $cast = false;
    for ($k = 0; $k < $rr && $i < strlen($d); $k++) {
        $name = cast_dns_name($d, $i);
        if ($i + 10 > strlen($d)) break;
        $typ = unpack('n', substr($d, $i, 2))[1];
        $len = unpack('n', substr($d, $i + 8, 2))[1];
        $rd = substr($d, $i + 10, $len);
        $i += 10 + $len;
        if (str_contains(strtolower($name), '_googlecast')) $cast = true;
        if ($typ === 16) {
            for ($j = 0; $j < strlen($rd);) {
                $l = ord($rd[$j]);
                $kv = substr($rd, $j + 1, $l);
                $j += 1 + $l;
                if (str_contains($kv, '=')) { [$a, $b] = explode('=', $kv, 2); $txt[$a] = $b; }
            }
        } elseif ($typ === 33 && strlen($rd) >= 6) {
            $port = unpack('n', substr($rd, 4, 2))[1];
        }
    }
    if (!$cast && !isset($txt['fn'])) return null;
    return ['name' => (string) ($txt['fn'] ?? ''), 'modell' => (string) ($txt['md'] ?? ''), 'id' => (string) ($txt['id'] ?? ''),
        'port' => $port ?: 8009, 'ca' => (int) ($txt['ca'] ?? 0), 'gruppe' => ((int) ($txt['ca'] ?? 0) & 32) === 32 || ($port && $port !== 8009)];
}

/** mDNS direkt an jede Adresse; Ergebnis: ip → Fund (bei Gruppen mehrere je IP: Schlüssel ip:port) */
function cast_suchen(array $ips, float $sekunden = 2.0): array
{
    $sock = @stream_socket_server('udp://0.0.0.0:0', $e1, $e2, STREAM_SERVER_BIND);
    if (!$sock) return [];
    stream_set_blocking($sock, false);
    $frage = pack('nnnnnn', 0, 0, 1, 0, 0, 0);
    foreach (['_googlecast', '_tcp', 'local'] as $t) $frage .= chr(strlen($t)) . $t;
    $frage .= "\x00" . pack('nn', 12, 0x8001);   // PTR, IN mit „Antwort bitte per Unicast“
    $ips = array_values($ips);
    $funde = [];
    $ende = microtime(true) + $sekunden;
    $k = 0;
    while (microtime(true) < $ende) {
        // gestaffelt senden (nicht alle 254 Pakete auf einmal), zweite Runde für Verlorenes
        for ($n = 0; $n < 64 && $k < 2 * count($ips); $n++, $k++) {
            @stream_socket_sendto($sock, $frage, 0, $ips[$k % count($ips)] . ':5353');
        }
        $r = [$sock]; $w = $x = null;
        if (@stream_select($r, $w, $x, 0, 100000) > 0) {
            while (($d = @stream_socket_recvfrom($sock, 9000, 0, $von)) !== false && $d !== '') {
                $ip = explode(':', (string) $von)[0];
                $f = cast_mdns_lesen($d);
                if ($f) $funde[$ip . ':' . $f['port']] = $f + ['ip' => $ip];
            }
        }
    }
    fclose($sock);
    return $funde;
}

/** Gerät unter einer IP (bzw. ip:port) untersuchen – mDNS, sonst direkt per Cast-Verbindung */
function cast_untersuchen(string $wo): ?array
{
    [$ip, $port] = array_pad(explode(':', preg_replace('#^cast://#', '', $wo)), 2, '');
    $port = (int) $port;
    if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) return null;
    $f = cast_suchen([$ip], 1.2);
    $fund = null;
    foreach ($f as $x) {
        if (!$port || $x['port'] === $port) { $fund = $x; break; }
    }
    if (!$fund) {
        // ohne mDNS: Cast-Verbindung versuchen; Name aus der Einrichtungs-Schnittstelle (Port 8008), wenn vorhanden
        try {
            $c = new CastVerbindung($ip, $port ?: 8009, 2.0);
            $c->empfaengerStatus();
            $c->schliessen();
        } catch (Throwable $e) {
            return null;
        }
        [$st, $b] = hn_http('GET', "http://{$ip}:8008/setup/eureka_info?params=name,device_info", null, [], 1.5);
        $j = $st === 200 ? json_decode($b, true) : null;
        $fund = ['ip' => $ip, 'port' => $port ?: 8009, 'name' => (string) ($j['name'] ?? ''), 'modell' => (string) ($j['device_info']['model_name'] ?? ''), 'id' => '', 'ca' => 0, 'gruppe' => false];
    }
    $md = $fund['modell'];
    $tv = (bool) preg_match('/tv|bravia|shield|chromecast(?! audio)/i', $md) || (($fund['ca'] & 1) === 1 && !preg_match('/nest hub|home hub|display/i', $md));
    return [
        'art' => 'cast', 'ip' => $ip, 'steuer_port' => (int) $fund['port'], 'name' => $fund['name'] ?: ($md ?: t('Cast-Gerät {ip}', ['ip' => $ip])),
        'hersteller' => $fund['gruppe'] ? 'Google Cast · Gruppe' : 'Google Cast', 'modell' => $md, 'udn' => $fund['id'], 'ort' => "cast://{$ip}:{$fund['port']}",
        'avt' => '', 'rc' => '', 'cm' => '', 'steuerung' => 'cast',
        // Standard-Empfänger: FLAC bis 24/96, WAV, MP3, AAC; Stereo. Lehnt ein Gerät FLAC ab, rechnet der Server um (WAV)
        'faehig' => ['formate' => ['audio/flac', 'audio/wav', 'audio/mpeg'], 'flac' => true, 'wav' => true, 'l16' => false,
            'max_rate' => 96000, 'max_bits' => 24, 'mehrkanal' => false, 'setnext' => true, 'tv' => $tv, 'avr' => false, 'cast' => true, 'gruppe' => $fund['gruppe']],
    ];
}

/** Zustand fürs Anzeigen: erreichbar, an, Lautstärke (0–100), laufende App */
function cast_status(array $g): array
{
    try {
        $c = cast_verbindung($g);
        $st = $c->empfaengerStatus();
        $a = $c->app();
        $vol = isset($st['volume']['level']) ? round((float) $st['volume']['level'] * 100) : null;
        return ['erreichbar' => true, 'an' => true, 'vol' => $vol, 'stumm' => !empty($st['volume']['muted']),
            'eingang' => $a ? (cast_ist_unsere_app($a['appId'] ?? null) ? 'Amberwave' : (string) ($a['displayName'] ?? '')) : '', 'app' => $a['appId'] ?? null];
    } catch (Throwable $e) {
        return ['erreichbar' => false];
    }
}

/** Media-Objekt für den Standard-Empfänger */
function cast_media(string $url, string $mime, array $t, string $cover, float $dauer, array $extra = []): array
{
    $kuenstler = implode(', ', array_map(static fn($x) => is_array($x) ? (string) ($x['name'] ?? '') : (string) $x, (array) ($t['kuenstler'] ?? [])));
    $meta = ['metadataType' => 3, 'title' => (string) ($t['titel'] ?? ''), 'artist' => $kuenstler, 'albumName' => (string) ($t['album']['titel'] ?? '')];
    if ($cover !== '') $meta['images'] = [['url' => $cover]];
    // customData: für den Amberwave-Empfänger (Format, Klang); der Standard-Empfänger übergeht es
    return ['contentId' => $url, 'contentType' => $mime, 'streamType' => 'BUFFERED', 'duration' => round($dauer, 3), 'metadata' => $meta,
        'customData' => ['amberwave' => $extra + ['id' => (int) ($t['id'] ?? 0)]]];
}
