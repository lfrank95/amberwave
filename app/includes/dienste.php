<?php
// Anfragen an fremde Dienste (MusicBrainz, AcoustID, Cover Art Archive, Deezer, fanart.tv, ListenBrainz, Cloudflare,
// Let's Encrypt …): eine gemeinsame Kennung und ein Zähler.
//
// Kennung (User-Agent): „Amberwave/0.2.106 (Pro; Installation 3f9a2c1b; kontakt@…)“ – so sehen die Betreiber in ihren
// Logs, wie viel von Amberwave kommt, wie viele Installationen es sind und wie viel davon aus der Free- bzw. Pro-Version.
// Die Installations-Kennung ist eine zufällige Zeichenfolge ohne Bezug zu Personen.
// Zähler: je Dienst und Tag Anfragen und Fehler (Tabelle dienst_anfragen) – zu sehen unter Einstellungen › Dienste & Schlüssel.
declare(strict_types=1);
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/einstellungen.php';

/** Kontakt des Entwicklers für die Betreiber der Dienste (fest in Amberwave; DIENSTE_KONTAKT in der .env übersteuert) */
// Projektadresse als Kontakt für MusicBrainz & Co. (Pflicht laut deren Regeln) – keine persönlichen Daten
const AMBERWAVE_KONTAKT = 'https://github.com/lfrank95/amberwave';

/** Edition dieser Installation: „Free“ oder „Pro“ (später aus dem Lizenzschlüssel; bis dahin AMBERWAVE_EDITION) */
function amberwave_edition(): string
{
    $e = strtolower(trim((string) (konfig()['edition'] ?? 'free')));
    return $e === 'pro' ? 'Pro' : 'Free';
}

/** Zufällige, dauerhafte Kennung dieser Installation (8 Hex-Zeichen) */
function installation_id(): string
{
    static $id = null;
    if ($id !== null) {
        return $id;
    }
    try {
        // aus der Datenbank; ist dort noch nichts, gilt AMBERWAVE_INSTALLATION_ID aus der .env (z. B. nach Neuinstallation behalten) – danach steht sie fest
        $neu = strtolower(trim(einstellung('installation_id')));
        if (!preg_match('/^[0-9a-f]{8}$/', $neu)) {
            $neu = bin2hex(random_bytes(4));
            einstellung_setzen('installation_id', $neu);
        }
        return $id = $neu;
    } catch (Throwable $e) {
        return '00000000'; // Datenbank (noch) nicht erreichbar – später erneut versuchen
    }
}

/**
 * Kontaktangabe: Entwickler-Kontakt (fest bzw. DIENSTE_KONTAKT), sonst die Adresse der Installation (APP_URL).
 * Die Admin-E-Mail nur, wenn ausdrücklich erlaubt (MusicBrainz verlangt einen Kontakt) – nicht an jeden Dienst.
 */
function dienste_kontakt(bool $admin_mail = false): string
{
    $k = trim((string) (konfig()['dienste_kontakt'] ?? '')) ?: AMBERWAVE_KONTAKT;
    if ($k !== '') {
        return $k;
    }
    $k = konfig()['app_url'];
    if ($k === '' && $admin_mail) {
        try {
            $k = (string) db_wert("SELECT email FROM users WHERE rolle = 'admin' AND status = 'aktiv' AND email NOT LIKE '%@localhost' ORDER BY id LIMIT 1");
        } catch (Throwable $e) {
            $k = '';
        }
    }
    return $k;
}

/** User-Agent für alle Anfragen nach außen */
function amberwave_user_agent(bool $admin_mail = false): string
{
    static $ua = [];
    if (isset($ua[$admin_mail])) {
        return $ua[$admin_mail];
    }
    $teile = [amberwave_edition(), 'Installation ' . installation_id()];
    $k = dienste_kontakt($admin_mail);
    if ($k !== '') {
        $teile[] = $k;
    }
    $text = (string) preg_replace('/[^\x20-\x7E]/', '', 'Amberwave/' . app_version() . ' (' . implode('; ', $teile) . ')');
    if (installation_id() !== '00000000') {
        $ua[$admin_mail] = $text;
    }
    return $text;
}

/** Name des Dienstes zu einer Adresse (für den Zähler) */
function dienst_von(string $url): string
{
    $host = strtolower((string) parse_url($url, PHP_URL_HOST));
    $bekannt = [
        'musicbrainz.org' => 'MusicBrainz', 'coverartarchive.org' => 'Cover Art Archive', 'archive.org' => 'Cover Art Archive',
        'acoustid.org' => 'AcoustID', 'deezer.com' => 'Deezer', 'dzcdn.net' => 'Deezer', 'fanart.tv' => 'fanart.tv',
        'listenbrainz.org' => 'ListenBrainz', 'metabrainz.org' => 'MetaBrainz', 'cloudflare.com' => 'Cloudflare',
        'letsencrypt.org' => "Let's Encrypt", 'anthropic.com' => 'Claude (Übersetzung)', 'wikipedia.org' => 'Wikipedia', 'wikidata.org' => 'Wikidata',
        'upf.edu' => 'Music Technology Group', 'essentia.upf.edu' => 'Music Technology Group', 'github.com' => 'GitHub', 'githubusercontent.com' => 'GitHub',
        'huggingface.co' => 'Hugging Face', 'voxengo.com' => 'Voxengo',
    ];
    foreach ($bekannt as $endung => $name) {
        if ($host === $endung || str_ends_with($host, '.' . $endung)) {
            return $name;
        }
    }
    if ($host === '' || filter_var($host, FILTER_VALIDATE_IP) || $host === 'localhost' || !str_contains($host, '.')) {
        return 'andere';
    }
    // unbekannt: Domain ohne Subdomain
    $t = explode('.', $host);
    return implode('.', array_slice($t, -2));
}

/** Eine Anfrage zählen (Fehler = keine Verbindung oder Status ≥ 400) – nie störend: Fehler beim Zählen werden geschluckt */
function dienst_zaehlen(string $url, int $status): void
{
    try {
        $fehler = $status === 0 || $status >= 400 ? 1 : 0;
        db_tun('INSERT INTO dienst_anfragen (dienst, tag, edition, anzahl, fehler) VALUES (:d, CURDATE(), :e, 1, :f)
                ON DUPLICATE KEY UPDATE anzahl = anzahl + 1, fehler = fehler + :f2',
            ['d' => mb_substr(dienst_von($url), 0, 60), 'e' => amberwave_edition(), 'f' => $fehler, 'f2' => $fehler]);
    } catch (Throwable $e) {
        // Zählen ist Nebensache
    }
}

/** GET /admin/dienste/anfragen – Übersicht je Dienst: heute, 7 Tage, dieser Monat, Vormonat, gesamt */
function api_dienste_anfragen(array $admin): array
{
    $z = db_alle("SELECT dienst,
            SUM(CASE WHEN tag = CURDATE() THEN anzahl ELSE 0 END) AS heute,
            SUM(CASE WHEN tag > CURDATE() - INTERVAL 7 DAY THEN anzahl ELSE 0 END) AS woche,
            SUM(CASE WHEN tag >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN anzahl ELSE 0 END) AS monat,
            SUM(CASE WHEN tag >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01') AND tag < DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN anzahl ELSE 0 END) AS vormonat,
            SUM(CASE WHEN tag >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND edition = 'Pro' THEN anzahl ELSE 0 END) AS monat_pro,
            SUM(anzahl) AS gesamt, SUM(CASE WHEN tag >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN fehler ELSE 0 END) AS fehler_monat, MIN(tag) AS seit
        FROM dienst_anfragen GROUP BY dienst ORDER BY monat DESC, gesamt DESC");
    return [
        'user_agent' => amberwave_user_agent(), 'edition' => amberwave_edition(), 'installation' => installation_id(),
        'dienste' => array_map(static fn($r) => ['dienst' => $r['dienst'], 'heute' => (int) $r['heute'], 'woche' => (int) $r['woche'], 'monat' => (int) $r['monat'], 'monat_pro' => (int) $r['monat_pro'],
            'vormonat' => (int) $r['vormonat'], 'gesamt' => (int) $r['gesamt'], 'fehler_monat' => (int) $r['fehler_monat'], 'seit' => $r['seit']], $z),
    ];
}
