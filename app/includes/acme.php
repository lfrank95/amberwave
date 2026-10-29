<?php
// Schlanker ACME-Client (RFC 8555) für Let's Encrypt mit DNS-Challenge über Cloudflare.
// Kontoschlüssel und Zertifikatsschlüssel: ECDSA P-256 (ES256). Kein offener Port nötig – Let's Encrypt prüft nur
// einen TXT-Eintrag im DNS, den wir über die Cloudflare-API setzen und danach wieder löschen.
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

require_once __DIR__ . '/cloudflare.php';

final class AcmeFehler extends RuntimeException
{
    public string $typ = '';
}

function b64u(string $d): string
{
    return rtrim(strtr(base64_encode($d), '+/', '-_'), '=');
}

final class Acme
{
    private array $verz = [];
    private ?string $nonce = null;
    private $schluessel;          // OpenSSLAsymmetricKey (Konto)
    private ?string $kid = null;
    /** @var callable */
    private $melden;

    public function __construct(private string $verzeichnisUrl, string $kontoPem, ?string $kid, callable $melden)
    {
        $this->schluessel = openssl_pkey_get_private($kontoPem);
        if (!$this->schluessel) {
            throw new AcmeFehler(t('Kontoschlüssel unlesbar.'));
        }
        $this->kid = $kid;
        $this->melden = $melden;
    }

    public static function neuerSchluessel(): string
    {
        $k = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
        openssl_pkey_export($k, $pem);
        return $pem;
    }

    public function kid(): ?string { return $this->kid; }

    // ---------- HTTP ----------
    private function http(string $methode, string $url, ?string $body = null, array $kopfExtra = []): array
    {
        $ch = curl_init($url);
        $kopf = [];
        $kopfZeilen = [];
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $methode,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => 60,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_USERAGENT => amberwave_user_agent(),
            CURLOPT_HEADERFUNCTION => static function ($c, $zeile) use (&$kopfZeilen) {
                $kopfZeilen[] = $zeile;
                return strlen($zeile);
            },
            CURLOPT_HTTPHEADER => array_merge($body !== null ? ['Content-Type: application/jose+json'] : [], $kopfExtra),
        ]);
        if ($methode === 'HEAD') {
            curl_setopt($ch, CURLOPT_NOBODY, true);
        }
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $ca = konfig()['direkt']['ca_datei'];
        if ($ca !== '') {
            curl_setopt($ch, CURLOPT_CAINFO, $ca);
        }
        $antwort = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $fehler = curl_error($ch);
        curl_close($ch);
        dienst_zaehlen($url, $antwort === false ? 0 : $status);
        if ($antwort === false) {
            throw new AcmeFehler(t('Let\'s Encrypt nicht erreichbar: ') . $fehler);
        }
        foreach ($kopfZeilen as $z) {
            if (str_contains($z, ':')) {
                [$k, $v] = explode(':', $z, 2);
                $kopf[strtolower(trim($k))] = trim($v);
            }
        }
        if (isset($kopf['replay-nonce'])) {
            $this->nonce = $kopf['replay-nonce'];
        }
        return ['status' => $status, 'kopf' => $kopf, 'body' => (string) $antwort];
    }

    private function verzeichnis(): array
    {
        if (!$this->verz) {
            $r = $this->http('GET', $this->verzeichnisUrl);
            $this->verz = json_decode($r['body'], true) ?: [];
            if (empty($this->verz['newNonce'])) {
                throw new AcmeFehler('ACME-Verzeichnis unerwartet (HTTP ' . $r['status'] . ').');
            }
        }
        return $this->verz;
    }

    private function holeNonce(): string
    {
        if ($this->nonce === null) {
            $this->http('HEAD', $this->verzeichnis()['newNonce']);
        }
        if ($this->nonce === null) {
            throw new AcmeFehler(t('Keine Nonce erhalten.'));
        }
        $n = $this->nonce;
        $this->nonce = null;
        return $n;
    }

    // ---------- JWS ----------
    public function jwk(): array
    {
        $d = openssl_pkey_get_details($this->schluessel)['ec'];
        return ['crv' => 'P-256', 'kty' => 'EC', 'x' => b64u(str_pad($d['x'], 32, "\0", STR_PAD_LEFT)), 'y' => b64u(str_pad($d['y'], 32, "\0", STR_PAD_LEFT))];
    }

    /** JWK-Fingerabdruck (RFC 7638): Felder in fester Reihenfolge, ohne Leerzeichen */
    public function fingerabdruck(): string
    {
        $j = $this->jwk();
        return b64u(hash('sha256', '{"crv":"' . $j['crv'] . '","kty":"' . $j['kty'] . '","x":"' . $j['x'] . '","y":"' . $j['y'] . '"}', true));
    }

    /** ECDSA-Signatur von DER (SEQUENCE{r,s}) in das JWS-Format r||s (je 32 Byte) */
    private static function derZuRoh(string $der): string
    {
        $pos = 2;
        if (ord($der[1]) & 0x80) {
            $pos += ord($der[1]) & 0x7f;
        }
        $teile = [];
        for ($i = 0; $i < 2; $i++) {
            $pos++; // 0x02 INTEGER
            $len = ord($der[$pos++]);
            $zahl = substr($der, $pos, $len);
            $pos += $len;
            $zahl = ltrim($zahl, "\0");
            $teile[] = str_pad($zahl, 32, "\0", STR_PAD_LEFT);
        }
        return $teile[0] . $teile[1];
    }

    private function jws(string $url, ?array $nutzlast, bool $mitJwk): string
    {
        $schutz = ['alg' => 'ES256', 'nonce' => $this->holeNonce(), 'url' => $url];
        if ($mitJwk || !$this->kid) {
            $schutz['jwk'] = $this->jwk();
        } else {
            $schutz['kid'] = $this->kid;
        }
        $p = b64u(json_encode($schutz, JSON_UNESCAPED_SLASHES));
        // POST-as-GET: leere Nutzlast ""; sonst JSON (leeres Objekt als {})
        $n = $nutzlast === null ? '' : b64u($nutzlast === [] ? '{}' : json_encode($nutzlast, JSON_UNESCAPED_SLASHES));
        if (!openssl_sign($p . '.' . $n, $sig, $this->schluessel, OPENSSL_ALGO_SHA256)) {
            throw new AcmeFehler(t('Signieren fehlgeschlagen.'));
        }
        return json_encode(['protected' => $p, 'payload' => $n, 'signature' => b64u(self::derZuRoh($sig))], JSON_UNESCAPED_SLASHES);
    }

    /** Signierte Anfrage; bei „badNonce“ einmal mit frischer Nonce wiederholen */
    private function post(string $url, ?array $nutzlast, bool $mitJwk = false, array $kopf = []): array
    {
        for ($versuch = 0; $versuch < 3; $versuch++) {
            $r = $this->http('POST', $url, $this->jws($url, $nutzlast, $mitJwk), $kopf);
            $j = json_decode($r['body'], true);
            if ($r['status'] === 400 && is_array($j) && ($j['type'] ?? '') === 'urn:ietf:params:acme:error:badNonce') {
                continue;
            }
            if ($r['status'] >= 400) {
                $text = is_array($j) ? (($j['detail'] ?? '') ?: ($j['type'] ?? '')) : $r['body'];
                $f = new AcmeFehler("Let's Encrypt: " . trim((string) $text) . " (HTTP {$r['status']})");
                $f->typ = is_array($j) ? (string) ($j['type'] ?? '') : '';
                throw $f;
            }
            $r['json'] = is_array($j) ? $j : null;
            return $r;
        }
        throw new AcmeFehler(t('Let\'s Encrypt lehnt die Anfrage wiederholt ab (Nonce).'));
    }

    // ---------- Ablauf ----------
    public function konto(string $email): void
    {
        $daten = ['termsOfServiceAgreed' => true];
        if ($email !== '') {
            $daten['contact'] = ['mailto:' . $email];
        }
        $r = $this->post($this->verzeichnis()['newAccount'], $daten, true);
        $this->kid = $r['kopf']['location'] ?? null;
        if (!$this->kid) {
            throw new AcmeFehler(t('Konto angelegt, aber keine Konto-Adresse erhalten.'));
        }
    }

    /**
     * Zertifikat für $name holen. $txtSetzen($name, $wert) legt den TXT-Eintrag an und gibt eine ID zurück,
     * $txtLoeschen($id) räumt auf, $warten($name, $wert) wartet, bis der Eintrag sichtbar ist.
     * Gibt [Zertifikatskette PEM, privater Schlüssel PEM] zurück.
     */
    public function zertifikat(string $name, callable $txtSetzen, callable $txtLoeschen, callable $warten): array
    {
        $m = $this->melden;
        $bestellung = $this->post($this->verzeichnis()['newOrder'], ['identifiers' => [['type' => 'dns', 'value' => $name]]]);
        $orderUrl = $bestellung['kopf']['location'] ?? '';
        $order = $bestellung['json'];
        $txtIds = [];
        try {
            foreach ($order['authorizations'] ?? [] as $authUrl) {
                $auth = $this->post($authUrl, null)['json'];
                if (($auth['status'] ?? '') === 'valid') {
                    continue; // schon bestätigt (z. B. kürzlich erneuert)
                }
                $ch = null;
                foreach ($auth['challenges'] ?? [] as $c) {
                    if (($c['type'] ?? '') === 'dns-01') {
                        $ch = $c;
                    }
                }
                if (!$ch) {
                    throw new AcmeFehler(t('Keine DNS-Challenge angeboten.'));
                }
                $wert = b64u(hash('sha256', $ch['token'] . '.' . $this->fingerabdruck(), true));
                $txtName = '_acme-challenge.' . $name;
                $m(t('Prüfeintrag im DNS anlegen …'));
                $txtIds[] = $txtSetzen($txtName, $wert);
                $m(t('Warten, bis der Prüfeintrag weltweit sichtbar ist …'));
                $warten($txtName, $wert);
                $m(t('Let\'s Encrypt prüft den Eintrag …'));
                $this->post($ch['url'], []);
                $this->abwarten($authUrl, ['valid'], ['invalid', 'deactivated', 'expired', 'revoked'], 120, t('Bestätigung'));
            }
            // Schlüssel und CSR für das Zertifikat
            $m(t('Zertifikat anfordern …'));
            $key = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
            openssl_pkey_export($key, $keyPem);
            $csrDer = self::csr($name, $key);
            $this->post($order['finalize'], ['csr' => b64u($csrDer)]);
            $fertig = $this->abwarten($orderUrl, ['valid'], ['invalid'], 120, t('Ausstellung'));
            if (empty($fertig['certificate'])) {
                throw new AcmeFehler(t('Zertifikat ausgestellt, aber keine Download-Adresse erhalten.'));
            }
            $kette = $this->post($fertig['certificate'], null, false, ['Accept: application/pem-certificate-chain'])['body'];
            if (!str_contains($kette, 'BEGIN CERTIFICATE')) {
                throw new AcmeFehler(t('Zertifikat konnte nicht geladen werden.'));
            }
            return [$kette, $keyPem];
        } finally {
            foreach ($txtIds as $id) {
                try { $txtLoeschen($id); } catch (Throwable $e) { /* Aufräumen ist nicht kritisch */ }
            }
        }
    }

    private function abwarten(string $url, array $gut, array $schlecht, int $sekunden, string $was): array
    {
        $ende = time() + $sekunden;
        do {
            $j = $this->post($url, null)['json'] ?? [];
            $s = $j['status'] ?? '';
            if (in_array($s, $gut, true)) {
                return $j;
            }
            if (in_array($s, $schlecht, true)) {
                $detail = $j['error']['detail'] ?? '';
                foreach ($j['challenges'] ?? [] as $c) {
                    if (!empty($c['error']['detail'])) {
                        $detail = $c['error']['detail'];
                    }
                }
                throw new AcmeFehler($detail !== '' ? t('{was} abgelehnt: {detail}', ['was' => $was, 'detail' => $detail]) : t('{was} abgelehnt.', ['was' => $was]));
            }
            sleep(2);
        } while (time() < $ende);
        throw new AcmeFehler(t('{was}: keine Antwort von Let\'s Encrypt in {sekunden} Sekunden.', ['was' => $was, 'sekunden' => $sekunden]));
    }

    /** CSR (DER) mit dem Namen als CN und subjectAltName */
    private static function csr(string $name, $key): string
    {
        $cnf = tempnam(sys_get_temp_dir(), 'awcsr');
        file_put_contents($cnf, "[req]\ndistinguished_name=dn\nreq_extensions=ext\n[dn]\n[ext]\nsubjectAltName=DNS:{$name}\n");
        try {
            $csr = openssl_csr_new(['commonName' => $name], $key, ['config' => $cnf, 'req_extensions' => 'ext', 'digest_alg' => 'sha256']);
            if (!$csr || !openssl_csr_export($csr, $pem)) {
                throw new AcmeFehler(t('CSR konnte nicht erzeugt werden: ') . openssl_error_string());
            }
        } finally {
            @unlink($cnf);
        }
        $b64 = preg_replace('/-----[^-]+-----|\s+/', '', $pem);
        return base64_decode($b64);
    }
}
