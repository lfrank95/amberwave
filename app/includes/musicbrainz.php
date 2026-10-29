<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/hilfen.php';
require_once __DIR__ . '/einstellungen.php';
require_once __DIR__ . '/dienste.php';
require_once __DIR__ . '/bibliothek.php';
require_once __DIR__ . '/bilder.php';

/**
 * MusicBrainz – Metadaten-Quelle Nr. 1.
 * - Höchstens eine Anfrage pro Sekunde (prozessübergreifend über eine Sperrdatei), eigener User-Agent mit Kontakt.
 * - Antworten werden im Cache-Ordner zwischengespeichert (Suche 1 Tag, Editionen/Künstler 7 Tage).
 * - Übernehmen respektiert gesperrte Felder; Manuelles bleibt immer erhalten.
 */

final class MbFehler extends RuntimeException
{
}

/** Kennung gegenüber MusicBrainz: "Amberwave/0.1.0 ( kontakt )" – Pflicht laut MusicBrainz. */
function mb_user_agent(): string
{
    $ua = trim(einstellung('musicbrainz_user_agent'));
    return $ua !== '' ? (string) preg_replace('/[^\x20-\x7E]/', '', $ua) : amberwave_user_agent(true);
}

/** Einfacher HTTP-Abruf mit curl. Liefert ['status' => int, 'body' => string, 'typ' => string]. */
function http_holen(string $url, array $kopf = [], int $timeout = 20, int $max_bytes = 25 * 1024 * 1024): array
{
    if (!preg_match('#^https?://#i', $url)) {
        throw new MbFehler(t('Ungültige Adresse.'));
    }
    $ch = curl_init($url);
    $puffer = '';
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_HTTPHEADER => $kopf,
        CURLOPT_USERAGENT => dienst_von($url) === 'MusicBrainz' ? mb_user_agent() : amberwave_user_agent(),
        CURLOPT_ENCODING => '',
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_WRITEFUNCTION => static function ($c, string $teil) use (&$puffer, $max_bytes): int {
            if (strlen($puffer) + strlen($teil) > $max_bytes) {
                return 0; // zu groß -> abbrechen
            }
            $puffer .= $teil;
            return strlen($teil);
        },
    ]);
    $ok = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $typ = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $fehler = curl_error($ch);
    curl_close($ch);
    dienst_zaehlen($url, $ok === false ? 0 : $status);
    if ($ok === false && $status === 0) {
        throw new MbFehler(t('Keine Verbindung: {fehler}', ['fehler' => $fehler ?: t('unbekannter Fehler')]));
    }
    return ['status' => $status, 'body' => $puffer, 'typ' => $typ];
}

/** Takt: zwischen zwei MusicBrainz-Anfragen mindestens 1,1 Sekunden – auch über mehrere PHP-Prozesse hinweg. */
function mb_takt_warten(): void
{
    $ordner = konfig()['pfade']['cache'] . '/tmp';
    if (!is_dir($ordner)) {
        @mkdir($ordner, 0775, true);
    }
    $h = @fopen($ordner . '/musicbrainz.takt', 'c+');
    if (!$h) {
        usleep(1100000);
        return;
    }
    flock($h, LOCK_EX);
    $letzte = (float) stream_get_contents($h);
    $warten = 1.1 - (microtime(true) - $letzte);
    if ($warten > 0) {
        usleep((int) ($warten * 1000000));
    }
    ftruncate($h, 0);
    rewind($h);
    fwrite($h, (string) microtime(true));
    fflush($h);
    flock($h, LOCK_UN);
    fclose($h);
}

function mb_cache_datei(string $url): string
{
    $o = konfig()['pfade']['cache'] . '/musicbrainz';
    if (!is_dir($o)) {
        @mkdir($o, 0775, true);
    }
    return $o . '/' . hash('sha256', $url) . '.json';
}

/** Anfrage an die MusicBrainz-API (JSON), mit Cache. $ttl = 0 erzwingt eine frische Abfrage. */
function mb_abfrage(string $pfad, array $param = [], int $ttl = 86400): array
{
    $param['fmt'] = 'json';
    $url = konfig()['quellen']['musicbrainz_url'] . '/' . ltrim($pfad, '/') . '?' . http_build_query($param, '', '&', PHP_QUERY_RFC3986);
    $cache = mb_cache_datei($url);
    if ($ttl > 0 && is_file($cache) && filemtime($cache) > time() - $ttl) {
        $d = json_decode((string) file_get_contents($cache), true);
        if (is_array($d)) {
            return $d;
        }
    }
    for ($versuch = 1; $versuch <= 3; $versuch++) {
        mb_takt_warten();
        $r = http_holen($url, ['Accept: application/json'], 30);
        if ($r['status'] === 503 || $r['status'] === 429) {
            sleep($versuch * 2); // MusicBrainz bremst – kurz warten und erneut versuchen
            continue;
        }
        break;
    }
    if ($r['status'] === 404) {
        throw new MbFehler(t('Bei MusicBrainz nicht gefunden.'));
    }
    if ($r['status'] === 400) {
        throw new MbFehler(t('MusicBrainz hat die Anfrage abgelehnt (ungültige Suche).'));
    }
    if ($r['status'] !== 200) {
        throw new MbFehler(t('MusicBrainz antwortet gerade nicht (Status {status}). Bitte später erneut versuchen.', ['status' => $r['status']]));
    }
    $d = json_decode($r['body'], true);
    if (!is_array($d)) {
        throw new MbFehler(t('Unerwartete Antwort von MusicBrainz.'));
    }
    @file_put_contents($cache . '.tmp', $r['body']);
    @rename($cache . '.tmp', $cache);
    return $d;
}

/** Sonderzeichen für die Lucene-Suche von MusicBrainz entschärfen. */
function mb_lucene(string $s): string
{
    return (string) preg_replace('/([+\-!(){}\[\]^"~*?:\\\\\/]|&&|\|\|)/', '\\\\$1', trim($s));
}

/**
 * Titel in Kern und Editionszusatz zerlegen – Tags schreiben den Zusatz oft in den Titel, MusicBrainz führt ihn als
 * Begriffsklärung („disambiguation“) neben dem schlichten Titel:
 *   „Rumours (Super Deluxe Edition)“ → ['Rumours', 'super deluxe edition']
 *   „Back in Black [2003 Remaster]“  → ['Back in Black', '2003 remaster']
 *   „Thriller - 25th Anniversary Edition“ → ['Thriller', '25th anniversary edition']
 * Nur Zusätze mit typischen Editionswörtern werden abgetrennt („(What's the Story) Morning Glory?“ bleibt ganz).
 * @return array{0:string,1:string} [Kern, Zusatz in Kleinbuchstaben]
 */
function mb_titel_zerlegen(string $titel): array
{
    $w = 'deluxe|edition|editie|edición|edição|édition|ausgabe|version|versión|remaster(?:ed)?|remastered|remix(?:ed)?|anniversary|jubiläum|expanded|bonus|special|collector\'?s?|limited|legacy|reissue|re-?issue'
        . '|mono|stereo|explicit|clean|extended|platinum|gold(?:en)?|tour|japan(?:ese)?|import|digital|hi-?res|24[- ]?bit|96\s*khz|192\s*khz|lp|vinyl|cd|sacd|mfsl|bonus tracks?|instrumental|acoustic|demos?|outtakes|director\'?s cut|super|ultimate|definitive|complete|anniversary|years?'
        . '|\d{4}\s+(?:remaster|mix|version|edition)|\d+(?:st|nd|rd|th)\s+anniversary';
    $kern = trim($titel);
    $zusatz = [];
    for ($i = 0; $i < 4; $i++) {
        // am Ende: (…), […], {…}
        if (preg_match('/^(.+?)\s*[\(\[\{]([^\(\)\[\]\{\}]*)[\)\]\}]\s*$/u', $kern, $m) && preg_match('/\b(?:' . $w . ')\b/iu', $m[2]) && trim($m[1]) !== ''
            && !preg_match("/\\b\\w+'s\\s+version\\b/iu", $m[2])) {   // „(Taylor's Version)“ ist bei MusicBrainz ein eigenes Album, kein Zusatz
            array_unshift($zusatz, trim($m[2]));
            $kern = trim($m[1]);
            continue;
        }
        // am Ende: „ - Deluxe Edition“, „ – Remastered 2011“, „: Expanded Edition“
        if (preg_match('/^(.+?)(?:\s+[-–—]|\s*:)\s+([^-–—:]+)$/u', $kern, $m) && preg_match('/\b(?:' . $w . ')\b/iu', $m[2]) && trim($m[1]) !== '' && mb_strlen($m[2]) <= 50) {
            array_unshift($zusatz, trim($m[2]));
            $kern = trim($m[1]);
            continue;
        }
        break;
    }
    return [$kern, mb_strtolower(implode(' ', $zusatz), 'UTF-8')];
}

/** Künstler für die Suche: Gastbeiträge („feat. …“, „ft. …“, „featuring …“) weglassen – MusicBrainz führt sie beim Titel, nicht beim Album */
function mb_kuenstler_kern(string $k): string
{
    $k = trim((string) preg_replace('/\s+[\(\[]?\s*(?:feat\.?|ft\.?|featuring|mit|with)\s+.*$/iu', '', trim($k)));
    return $k;
}

/** Wörter eines Textes für eine unscharfe Lucene-Suche: „release:(rumours) AND artist:(fleetwood mac)“ (ohne Anführungszeichen, Wörter einzeln) */
function mb_lucene_woerter(string $s): string
{
    $w = preg_split('/[^\p{L}\p{N}\']+/u', mb_strtolower($s, 'UTF-8'), -1, PREG_SPLIT_NO_EMPTY) ?: [];
    $w = array_values(array_filter($w, static fn($x) => mb_strlen($x) >= 2 || ctype_digit($x)));
    return implode(' AND ', array_map('mb_lucene', array_slice($w, 0, 8)));
}

/** Wie ähnlich sind zwei Albumtitel (0–1)? Gemeinsame Wörter nach Normalisierung, Kern ohne Editionszusatz */
function mb_album_aehnlich(string $a, string $b): float
{
    $wa = array_unique(explode(' ', name_norm(mb_titel_zerlegen($a)[0])));
    $wb = array_unique(explode(' ', name_norm(mb_titel_zerlegen($b)[0])));
    $wa = array_filter($wa); $wb = array_filter($wb);
    if (!$wa || !$wb) {
        return 0.0;
    }
    $gemeinsam = count(array_intersect($wa, $wb));
    return $gemeinsam / max(count($wa), count($wb));
}

/** MusicBrainz-Credit [{name, joinphrase, artist{id,name,sort-name}}] als Text */
function mb_credit_text(array $credit): string
{
    $t = '';
    foreach ($credit as $c) {
        $t .= (string) ($c['name'] ?? $c['artist']['name'] ?? '') . (string) ($c['joinphrase'] ?? '');
    }
    return trim($t);
}

/** Medienformate zusammenfassen: "2×CD", "CD + DVD", "Digital" */
function mb_format_text(array $medien): string
{
    $z = [];
    foreach ($medien as $m) {
        $f = (string) ($m['format'] ?? '');
        $f = $f === '' ? '?' : ($f === 'Digital Media' ? 'Digital' : $f);
        $z[$f] = ($z[$f] ?? 0) + 1;
    }
    $teile = [];
    foreach ($z as $f => $n) {
        $teile[] = ($n > 1 ? $n . '×' : '') . $f;
    }
    return implode(' + ', $teile);
}

/** Eine Edition (Release) aus Suche/Browse in eine schlanke Form bringen. */
function mb_edition_kurz(array $r): array
{
    $medien = $r['media'] ?? [];
    $tracks = 0;
    $proMedium = [];
    foreach ($medien as $m) {
        $n = (int) ($m['track-count'] ?? 0);
        $tracks += $n;
        $proMedium[] = $n;
    }
    if (!$medien && isset($r['track-count'])) {
        $tracks = (int) $r['track-count'];
    }
    $labels = [];
    foreach ($r['label-info'] ?? [] as $li) {
        $teil = trim((string) ($li['label']['name'] ?? ''));
        $kat = trim((string) ($li['catalog-number'] ?? ''));
        if ($kat !== '' && strtolower($kat) !== '[none]') {
            $teil .= ($teil !== '' ? ' · ' : '') . $kat;
        }
        if ($teil !== '') {
            $labels[] = $teil;
        }
    }
    $datum = (string) ($r['date'] ?? '');
    return [
        'mbid' => (string) $r['id'],
        'titel' => (string) ($r['title'] ?? ''),
        'kuenstler' => mb_credit_text($r['artist-credit'] ?? []),
        'datum' => $datum,
        'jahr' => preg_match('/^(\d{4})/', $datum, $m) ? (int) $m[1] : null,
        'land' => (string) ($r['country'] ?? ''),
        'status' => (string) ($r['status'] ?? ''),
        'barcode' => (string) ($r['barcode'] ?? ''),
        'kommentar' => (string) ($r['disambiguation'] ?? ''),
        'verpackung' => (string) ($r['packaging'] ?? ''),
        'format' => mb_format_text($medien),
        'medien' => $proMedium,
        'tracks' => $tracks,
        'labels' => implode(', ', array_unique($labels)),
        'score' => (int) ($r['score'] ?? 0),
    ];
}

/** Typ einer Release Group -> [typ, zusatz] in unserer Schreibweise */
function mb_album_typ(array $rg): array
{
    $haupt = strtolower((string) ($rg['primary-type'] ?? 'album'));
    $haupt = match ($haupt) {
        'album', 'single', 'ep', 'broadcast' => $haupt,
        'other' => 'sonstiges',
        default => 'album',
    };
    $zusatz = array_map(static fn($s) => strtolower((string) $s), $rg['secondary-types'] ?? []);
    return [$haupt, implode(',', array_unique($zusatz))];
}

/**
 * Alle Editionen suchen, die zu einem Album passen könnten.
 * 1. Suche nach Editionen über Albumtitel (auch Titel der Release Group) + Künstler, bis zu 200 Treffer.
 * 2. Für die besten Release Groups zusätzlich ALLE Editionen nachladen (die Suche liefert nicht immer alle).
 * Ergebnis gruppiert nach Album (Release Group).
 */
function mb_editionen_suchen(string $titel, string $kuenstler, ?string $rg_mbid = null): array
{
    $titel = trim($titel);
    $kuenstler = trim($kuenstler);
    if ($titel === '' && !ist_uuid($rg_mbid)) {
        throw new MbFehler(t('Bitte einen Albumtitel angeben.'));
    }
    $editionen = [];   // mbid => kurz + rg
    $gruppen = [];     // rg mbid => info
    $merken = static function (array $r) use (&$editionen, &$gruppen): void {
        $rg = $r['release-group'] ?? null;
        if (!$rg || empty($rg['id'])) {
            return;
        }
        $id = (string) $r['id'];
        $kurz = mb_edition_kurz($r);
        if (isset($editionen[$id])) {
            $kurz['score'] = max($kurz['score'], $editionen[$id]['score']);
        }
        $kurz['rg'] = (string) $rg['id'];
        $editionen[$id] = $kurz;
        $gid = (string) $rg['id'];
        if (!isset($gruppen[$gid])) {
            [$typ, $zusatz] = mb_album_typ($rg);
            $gruppen[$gid] = ['mbid' => $gid, 'titel' => (string) ($rg['title'] ?? $r['title'] ?? ''), 'typ' => $typ, 'zusatz' => $zusatz !== '' ? explode(',', $zusatz) : [],
                'kuenstler' => mb_credit_text($rg['artist-credit'] ?? $r['artist-credit'] ?? []), 'score' => 0, 'erstjahr' => null, 'vollstaendig' => false];
        }
        $gruppen[$gid]['score'] = max($gruppen[$gid]['score'], $kurz['score']);
        if ($kurz['jahr'] && (!$gruppen[$gid]['erstjahr'] || $kurz['jahr'] < $gruppen[$gid]['erstjahr'])) {
            $gruppen[$gid]['erstjahr'] = $kurz['jahr'];
        }
        if (!empty($rg['first-release-date']) && preg_match('/^(\d{4})/', (string) $rg['first-release-date'], $m)) {
            $gruppen[$gid]['erstjahr'] = (int) $m[1];
        }
    };

    if ($titel !== '') {
        // 1. genau (Phrase): der Titel wie im Tag und – falls er einen Editionszusatz trägt – sein Kern
        [$kern] = mb_titel_zerlegen($titel);
        $kuenstlerKern = mb_kuenstler_kern($kuenstler);
        $phrasen = array_values(array_unique(array_filter([$titel, $kern])));
        $teile = [];
        foreach ($phrasen as $ph) {
            $t = mb_lucene($ph);
            $teile[] = 'release:"' . $t . '"';
            $teile[] = 'releasegroup:"' . $t . '"';
        }
        $titelQ = '(' . implode(' OR ', $teile) . ')';
        $kuenstlerQ = $kuenstlerKern !== '' ? ' AND artist:"' . mb_lucene($kuenstlerKern) . '"' : '';
        $holen = static function (string $q, int $max = 200) use ($merken): int {
            $n = 0;
            for ($offset = 0; $offset < $max; $offset += 100) {
                $d = mb_abfrage('release', ['query' => $q, 'limit' => 100, 'offset' => $offset], 86400);
                foreach ($d['releases'] ?? [] as $r) {
                    $merken($r);
                    $n++;
                }
                if ($offset + 100 >= (int) ($d['count'] ?? 0)) {
                    break;
                }
            }
            return $n;
        };
        $holen($titelQ . $kuenstlerQ);
        // 2. unscharf: Wörter statt Phrase (andere Satzzeichen, „&“ statt „and“, fehlende Wörter im Tag) – nur, wenn die genaue Suche wenig brachte
        $woerter = mb_lucene_woerter($kern);
        if (count($gruppen) < 3 && $woerter !== '') {
            $kw = $kuenstlerKern !== '' ? mb_lucene_woerter($kuenstlerKern) : '';
            $holen('(release:(' . $woerter . ') OR releasegroup:(' . $woerter . '))' . ($kw !== '' ? ' AND artist:(' . $kw . ')' : ''), 100);
        }
        // 3. ohne Künstler (andere Schreibweise des Künstlers, „Various Artists“ falsch getaggt)
        if (!$editionen && $kuenstlerQ !== '') {
            $holen($titelQ, 100);
        }
        // Treffer, die nur zufällig ein Wort teilen, nicht weiter verfolgen: MusicBrainz-Punkte durch eigene Titelähnlichkeit dämpfen
        foreach ($gruppen as $gid => &$g) {
            $aehnlich = mb_album_aehnlich($titel, $g['titel']);
            $g['score'] = (int) round($g['score'] * (0.4 + 0.6 * $aehnlich));
        }
        unset($g);
    }

    // Vollständige Editionslisten für die besten Alben (und eine vorgegebene Release Group)
    $vollstaendig = [];
    if (ist_uuid($rg_mbid)) {
        $vollstaendig[] = strtolower((string) $rg_mbid);
    }
    $nach_score = $gruppen;
    uasort($nach_score, static fn($a, $b) => $b['score'] <=> $a['score']);
    foreach ($nach_score as $gid => $g) {
        if (count($vollstaendig) >= 3) {
            break;
        }
        if ($g['score'] >= 80 && !in_array($gid, $vollstaendig, true)) {
            $vollstaendig[] = $gid;
        }
    }
    foreach ($vollstaendig as $gid) {
        $offset = 0;
        do {
            $d = mb_abfrage('release', ['release-group' => $gid, 'inc' => 'media+labels+artist-credits+release-groups', 'limit' => 100, 'offset' => $offset], 86400);
            $liste = $d['releases'] ?? [];
            foreach ($liste as $r) {
                $r['release-group'] ??= ['id' => $gid];
                $merken($r);
            }
            $offset += count($liste);
        } while ($liste && $offset < (int) ($d['release-count'] ?? 0) && $offset < 500);
        if (isset($gruppen[$gid])) {
            $gruppen[$gid]['vollstaendig'] = true;
        }
    }

    foreach ($editionen as $e) {
        $gruppen[$e['rg']]['editionen'][] = $e;
    }
    return ['gruppen' => array_values(array_filter($gruppen, static fn($g) => !empty($g['editionen']))), 'anzahl' => count($editionen)];
}

/** Editionen bewerten: Wie gut passen sie zu unserer Edition (Trackanzahl, Jahr, Titel, Künstler)? */
function mb_kandidaten_bewerten(array $ergebnis, array $unsere): array
{
    $titel_n = name_norm($unsere['titel']);
    [$kern, $zusatz] = mb_titel_zerlegen($unsere['titel']);
    $kern_n = name_norm($kern);
    // Editionswörter aus dem Tag („deluxe“, „2011“, „remaster“ …): passt eine Edition dazu, steht sie weiter oben
    $zusatzW = array_values(array_filter(explode(' ', name_norm($zusatz)), static fn($x) => $x !== '' && !in_array($x, ['edition', 'version', 'the', 'ed'], true)));
    $kuenstler_n = name_norm(mb_kuenstler_kern($unsere['kuenstler']));
    foreach ($ergebnis['gruppen'] as &$g) {
        $g_titel = name_norm($g['titel']) === $titel_n || name_norm(mb_titel_zerlegen($g['titel'])[0]) === $kern_n;
        $g_kuenstler = $kuenstler_n !== '' && name_norm($g['kuenstler']) === $kuenstler_n;
        $bester = 0;
        foreach ($g['editionen'] as &$e) {
            $p = 0;
            $diff = abs($e['tracks'] - $unsere['tracks']);
            $e['trackanzahl_passt'] = $unsere['tracks'] > 0 && $diff === 0;
            if ($e['trackanzahl_passt']) {
                $p += 45;
            } elseif ($diff <= 2) {
                $p += 15;
            }
            if ($unsere['jahr'] && $e['jahr'] === $unsere['jahr']) {
                $p += 15;
            }
            if ($unsere['medien'] && count($e['medien']) === $unsere['medien']) {
                $p += 5;
            }
            if (name_norm($e['titel']) === $titel_n) {
                $p += 10;
            } elseif (name_norm(mb_titel_zerlegen($e['titel'])[0]) === $kern_n || $g_titel) {
                $p += 7;
            }
            if ($zusatzW) {
                // Zusatz im Titel der Edition oder in ihrer Begriffsklärung (z. B. „deluxe edition“, „2011 remaster“)
                $text = ' ' . name_norm($e['titel'] . ' ' . $e['kommentar']) . ' ';
                $treffer = count(array_filter($zusatzW, static fn($x) => str_contains($text, ' ' . $x . ' ')));
                $e['zusatz_passt'] = $treffer > 0;
                $p += (int) round(12 * $treffer / count($zusatzW));
            }
            if ($g_kuenstler || ($kuenstler_n !== '' && name_norm($e['kuenstler']) === $kuenstler_n)) {
                $p += 10;
            }
            if ($e['status'] === 'Official') {
                $p += 5;
            }
            if ($unsere['barcode'] !== '' && $e['barcode'] === $unsere['barcode']) {
                $p += 40;
            }
            if ($unsere['mbid'] !== '' && $e['mbid'] === $unsere['mbid']) {
                $p += 100;
                $e['verknuepft'] = true;
            }
            $p += (int) round($e['score'] / 10);
            $e['passung'] = $p;
            $bester = max($bester, $p);
        }
        unset($e);
        usort($g['editionen'], static fn($a, $b) => [$b['passung'], $a['datum'] ?: '9999'] <=> [$a['passung'], $b['datum'] ?: '9999']);
        $g['passung'] = $bester;
    }
    unset($g);
    usort($ergebnis['gruppen'], static fn($a, $b) => $b['passung'] <=> $a['passung']);
    return $ergebnis;
}

const MB_INC_EDITION = 'artist-credits+labels+recordings+release-groups+media+genres+isrcs+artist-rels+recording-rels+work-rels+recording-level-rels+work-level-rels+url-rels';

/** Vollständige Edition mit Tracks, Aufnahmen, Werken und allen Mitwirkenden. */
function mb_edition_laden(string $mbid, int $ttl = 7 * 86400): array
{
    if (!ist_uuid($mbid)) {
        throw new MbFehler(t('Ungültige MusicBrainz-ID.'));
    }
    return mb_abfrage('release/' . strtolower($mbid), ['inc' => MB_INC_EDITION], $ttl);
}

/** Unsere Tracks einer Edition (mit Dateilänge) */
function edition_tracks_fuer_vergleich(int $editionId): array
{
    return db_alle(
        'SELECT t.id, t.titel, t.laenge_ms, t.aufnahme_id, t.gesperrte_felder, m.pos AS disc, t.pos,
                (SELECT d.laenge_ms FROM dateien d WHERE d.track_id = t.id ORDER BY d.bittiefe DESC, d.id LIMIT 1) AS datei_ms,
                (SELECT d.pfad FROM dateien d WHERE d.track_id = t.id ORDER BY d.bittiefe DESC, d.id LIMIT 1) AS datei
         FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e ORDER BY m.pos, t.pos, t.id',
        ['e' => $editionId]
    );
}

/**
 * Titel-Kern: Schreibweise eines Titels (Tag oder Dateiname) so verkürzen, dass „05 - Beat_It (2003 Remaster).flac“,
 * „Michael Jackson - Beat It“ und „01-michael_jackson-beat_it-WEB-2012-GRP“ vergleichbar werden.
 * Liefert mehrere Kandidaten (ganzer Text und jedes Teilstück zwischen Trennstrichen), jeweils normalisiert.
 */
function mb_titel_kandidaten(string $roh): array
{
    $s = preg_replace('/\.(flac|mp3|m4a|ogg|opus|wav|aiff?|ape|wv)$/iu', '', trim($roh)) ?? $roh;
    $s = str_replace('_', ' ', $s);
    $s = preg_replace('/^\s*(?:cd\s*)?\d{1,2}[-.]\d{2}(?=[\s._\-]|$)[\s._\-]*/iu', '', $s) ?? $s;   // „1-05 “, „2.03 “
    $s = preg_replace('/^\s*(?:cd\s*)?\d{1,3}(?=[\s._\-]|$)[\s._\-]*/iu', '', $s) ?? $s;           // „05 - “, „05. “, „05-“
    $teile = [$s];
    // Teilstücke an Trennstrichen: „Interpret - Titel - Zusatz“ oder Scene-Stil „interpret-titel-WEB-2012-GRP“
    foreach (preg_split('/\s+[-–—]\s+|(?<=\w)-(?=\w)/u', $s) ?: [] as $stueck) {
        $teile[] = $stueck;
    }
    $teile = array_merge($teile, [implode(' ', array_slice(preg_split('/\s+[-–—]\s+/u', $s) ?: [], 1))]);
    $aus = [];
    foreach ($teile as $t) {
        $t = preg_replace('/[\(\[\{][^\)\]\}]*[\)\]\}]/u', ' ', (string) $t) ?? $t;               // (Remaster), [Live] …
        $t = preg_replace('/\b(?:feat|ft|featuring)\b\.?.*$/iu', '', $t) ?? $t;                   // „feat. X“ und alles danach
        $t = preg_replace('/\b(?:19|20)\d{2}\s+remaster(?:ed)?\b|\bremaster(?:ed)?(?:\s+(?:19|20)\d{2})?\b|\bmono\b|\bstereo\b/iu', ' ', $t) ?? $t;
        $k = name_norm($t);
        if ($k !== '' && !in_array($k, $aus, true)) {
            $aus[] = $k;
        }
    }
    return $aus;
}

/** Ähnlichkeit zweier Titel-Kerne, 0…1. */
function mb_titel_aehnlich(string $a, string $b): float
{
    if ($a === '' || $b === '') {
        return 0.0;
    }
    if ($a === $b) {
        return 1.0;
    }
    $ca = str_replace(' ', '', $a);
    $cb = str_replace(' ', '', $b);
    if ($ca === $cb) {
        return 0.98;
    }
    $kurz = min(mb_strlen($ca), mb_strlen($cb));
    if ($kurz >= 5 && (str_contains($ca, $cb) || str_contains($cb, $ca))) {
        return 0.88;
    }
    $la = mb_substr($ca, 0, 200);
    $lb = mb_substr($cb, 0, 200);
    $max = max(strlen($la), strlen($lb));
    return $max > 0 ? max(0.0, 1.0 - levenshtein($la, $lb) / $max) : 0.0;
}

/**
 * Automatische Zuordnung nach Namen: vergleicht Tag-Titel und Dateinamen mit den MusicBrainz-Titeln, unabhängig von Nummern.
 * Gibt [Index in $wir => Index in $mb] zurück (nur sichere Treffer).
 */
function mb_zuordnung_nach_namen(array $wir, array $mb): array
{
    $mb_k = [];
    foreach ($mb as $i => $t) {
        $mb_k[$i] = mb_titel_kandidaten($t['titel'])[0] ?? '';
        $mb_k[$i] = $mb_k[$i] !== '' ? [$mb_k[$i]] : [name_norm($t['titel'])];
        // auch die Fassung ohne Klammerzusatz zulassen
        foreach (mb_titel_kandidaten($t['titel']) as $k) {
            if (!in_array($k, $mb_k[$i], true)) {
                $mb_k[$i][] = $k;
            }
        }
    }
    $paare = [];
    foreach ($wir as $n => $t) {
        $kand = array_merge(mb_titel_kandidaten((string) $t['titel']), mb_titel_kandidaten(basename((string) $t['datei'])));
        $wl = (int) ($t['datei_ms'] ?? $t['laenge_ms'] ?? 0);
        foreach ($mb as $i => $m) {
            $best = 0.0;
            foreach ($kand as $k) {
                foreach ($mb_k[$i] as $mk) {
                    $best = max($best, mb_titel_aehnlich($k, $mk));
                }
            }
            if ($best < 0.7) {
                continue;
            }
            $diff = ($m['laenge_ms'] !== null && $wl > 0) ? abs($wl - $m['laenge_ms']) / 1000 : null;
            if ($best < 0.85 && ($diff === null || $diff > 4)) {
                continue; // unsichere Namensähnlichkeit zählt nur, wenn auch die Länge passt
            }
            $bonus = ($diff !== null && $diff <= 3 ? 0.03 : 0) + (((int) $t['disc'] === $m['disc'] && (int) $t['pos'] === $m['pos']) ? 0.02 : 0)
                - ($diff !== null && $diff > 15 ? 0.05 : 0);
            $paare[] = [$best + $bonus, $n, $i];
        }
    }
    usort($paare, static fn($a, $b) => $b[0] <=> $a[0]);
    $res = [];
    $mb_belegt = [];
    foreach ($paare as [, $n, $i]) {
        if (isset($res[$n]) || isset($mb_belegt[$i])) {
            continue;
        }
        $res[$n] = $i;
        $mb_belegt[$i] = true;
    }
    return $res;
}

/**
 * Unsere Tracks und die Tracks einer MusicBrainz-Edition zeilenweise gegenüberstellen.
 * Zuordnung über Datenträger + Position; passt die Datenträger-Struktur nicht, der Reihe nach.
 * $manuell (optional): von Hand angepasste Zuordnung [track_id => Index des MusicBrainz-Titels oder null = ohne Gegenstück].
 * Sie hat Vorrang vor der automatischen; jeder MusicBrainz-Titel hat höchstens eine Datei (Konflikte räumt der Aufrufer auf).
 */
function mb_vergleich(int $editionId, array $rel, ?array $manuell = null): array
{
    $wir = array_values(array_filter(edition_tracks_fuer_vergleich($editionId), static fn($t) => $t['datei'] !== null));
    $mb = [];
    foreach ($rel['media'] ?? [] as $m) {
        foreach ($m['tracks'] ?? [] as $t) {
            $mb[] = [
                'disc' => (int) ($m['position'] ?? 1), 'pos' => (int) ($t['position'] ?? 0), 'nummer' => (string) ($t['number'] ?? ''),
                'titel' => (string) ($t['title'] ?? ''), 'laenge_ms' => isset($t['length']) ? (int) $t['length'] : (isset($t['recording']['length']) ? (int) $t['recording']['length'] : null),
                'kuenstler' => mb_credit_text($t['artist-credit'] ?? []), 'track_mbid' => (string) ($t['id'] ?? ''), 'aufnahme_mbid' => (string) ($t['recording']['id'] ?? ''),
                'format' => (string) ($m['format'] ?? ''),
            ];
        }
    }
    // Zuordnungsart bestimmen
    $wir_discs = array_unique(array_map(static fn($t) => (int) $t['disc'], $wir));
    $mb_schluessel = [];
    foreach ($mb as $i => $t) {
        $mb_schluessel[$t['disc'] . '-' . $t['pos']] = $i;
    }
    $treffer_disc = 0;
    foreach ($wir as $t) {
        if (isset($mb_schluessel[(int) $t['disc'] . '-' . (int) $t['pos']])) {
            $treffer_disc++;
        }
    }
    // Datenträger + Position passen, wenn (fast) alle eigenen oder alle MusicBrainz-Tracks einen Partner finden
    $art = ($wir && ($treffer_disc === count($wir) || $treffer_disc === count($mb) || $treffer_disc >= count($wir) * 0.8)) ? 'disc' : 'reihe';
    unset($wir_discs);

    // Automatische Zuordnung: Index des eigenen Tracks in $wir => Index des MusicBrainz-Titels (oder null)
    $zuordnung = [];
    foreach ($wir as $n => $t) {
        $i = $art === 'disc' ? ($mb_schluessel[(int) $t['disc'] . '-' . (int) $t['pos']] ?? null) : (isset($mb[$n]) ? $n : null);
        $zuordnung[$n] = $i;
    }
    // Der Name zählt mehr als die Nummer: Stimmen genug Titel (Tag oder Dateiname) mit MusicBrainz überein, gilt die Zuordnung nach Namen.
    // Dateien ohne Namenstreffer behalten nur dann ihren Platz nach Nummer, wenn der Platz frei ist und die Länge passt.
    if ($wir && $manuell === null) {
        $nach_namen = mb_zuordnung_nach_namen($wir, $mb);
        if (count($nach_namen) >= max(1, (int) ceil(count($wir) * 0.5))) {
            $belegt = array_flip($nach_namen);
            $neu = [];
            foreach ($wir as $n => $t) {
                if (isset($nach_namen[$n])) {
                    $neu[$n] = $nach_namen[$n];
                    continue;
                }
                $i = $mb_schluessel[(int) $t['disc'] . '-' . (int) $t['pos']] ?? null;
                $wl = (int) ($t['datei_ms'] ?? $t['laenge_ms'] ?? 0);
                $passt = $i !== null && !isset($belegt[$i]) && ($mb[$i]['laenge_ms'] === null || $wl <= 0 || abs($wl - $mb[$i]['laenge_ms']) <= 5000);
                $neu[$n] = $passt ? $i : null;
                if ($passt) {
                    $belegt[$i] = true;
                }
            }
            $zuordnung = $neu;
            $art = 'namen';
        }
    }
    if ($manuell !== null) {
        // Von Hand angepasst: gilt für die genannten Tracks; wer sonst denselben MusicBrainz-Titel hätte, verliert ihn
        $nach_id = [];
        foreach ($wir as $n => $t) {
            $nach_id[(int) $t['id']] = $n;
        }
        $vergeben = [];
        foreach ($manuell as $tid => $mi) {
            $n = $nach_id[(int) $tid] ?? null;
            if ($n === null) {
                continue;
            }
            $mi = ($mi !== null && isset($mb[(int) $mi])) ? (int) $mi : null;
            $zuordnung[$n] = $mi;
            if ($mi !== null) {
                $vergeben[$mi] = $n;
            }
        }
        foreach ($zuordnung as $n => $mi) {
            if ($mi !== null && isset($vergeben[$mi]) && $vergeben[$mi] !== $n) {
                $zuordnung[$n] = null; // nicht genannt, aber der Titel ist von Hand anderweitig vergeben
            }
        }
        $art = 'hand';
    }
    $zeilen = [];
    $benutzt = [];
    foreach ($wir as $n => $t) {
        $i = $zuordnung[$n];
        $zeilen[] = ['wir' => $t, 'mb' => $i !== null ? $mb[$i] : null, 'mb_i' => $i];
        if ($i !== null) {
            $benutzt[$i] = true;
        }
    }
    foreach ($mb as $i => $t) {
        if (!isset($benutzt[$i])) {
            $zeilen[] = ['wir' => null, 'mb' => $t, 'mb_i' => $i];
        }
    }
    // Nach MusicBrainz-Reihenfolge sortieren, eigene Extras ans Ende
    usort($zeilen, static fn($a, $b) => [$a['mb_i'] ?? PHP_INT_MAX, (int) ($a['wir']['disc'] ?? 0), (int) ($a['wir']['pos'] ?? 0)]
        <=> [$b['mb_i'] ?? PHP_INT_MAX, (int) ($b['wir']['disc'] ?? 0), (int) ($b['wir']['pos'] ?? 0)]);

    $aus = [];
    $sum = ['passend' => 0, 'abweichend' => 0, 'fehlt' => 0, 'extra' => 0, 'max_diff_sek' => 0];
    foreach ($zeilen as $z) {
        $w = $z['wir'];
        $m = $z['mb'];
        $status = 'gut';
        $diff = null;
        $titel_gleich = null;
        if ($w && $m) {
            $wl = (int) ($w['datei_ms'] ?? $w['laenge_ms'] ?? 0);
            if ($m['laenge_ms'] !== null && $wl > 0) {
                $diff = (int) round(abs($wl - $m['laenge_ms']) / 1000);
                $sum['max_diff_sek'] = max($sum['max_diff_sek'], $diff);
            }
            $titel_gleich = name_norm((string) $w['titel']) === name_norm($m['titel']);
            if (($diff !== null && $diff > 5) || !$titel_gleich) {
                $status = ($diff !== null && $diff > 15) ? 'falsch' : 'abweichend';
                $sum['abweichend']++;
            } else {
                $sum['passend']++;
            }
        } elseif ($m) {
            $status = 'fehlt';
            $sum['fehlt']++;
        } else {
            $status = 'extra';
            $sum['extra']++;
        }
        $aus[] = [
            'status' => $status, 'diff_sek' => $diff, 'titel_gleich' => $titel_gleich,
            'wir' => $w ? ['track_id' => (int) $w['id'], 'disc' => (int) $w['disc'], 'pos' => (int) $w['pos'], 'titel' => $w['titel'],
                'laenge_ms' => (int) ($w['datei_ms'] ?? $w['laenge_ms'] ?? 0), 'datei' => basename((string) $w['datei']),
                'gesperrt' => array_values(array_filter(explode(',', (string) ($w['gesperrte_felder'] ?? '')), static fn($f) => in_array($f, ['titel', 'kuenstler', 'nummer'], true)))] : null,
            'mb' => $m, 'mb_i' => $z['mb_i'],
        ];
    }
    return ['zuordnung' => $art, 'zeilen' => $aus, 'zusammenfassung' => $sum];
}

/** Künstler aus einem MusicBrainz-Objekt anlegen/finden und – solange nicht gesperrt – vervollständigen. */
function mb_kuenstler(array $a): int
{
    $mbid = (string) ($a['id'] ?? '');
    $id = kuenstler_holen((string) ($a['name'] ?? ''), ist_uuid($mbid) ? $mbid : null, (string) ($a['sort-name'] ?? ''), 'musicbrainz');
    static $erledigt = [];
    if (isset($erledigt[$id])) {
        return $id;
    }
    $erledigt[$id] = true;
    $k = db_zeile('SELECT quelle, gesperrte_felder, typ, sortname, unterscheidung FROM kuenstler WHERE id = :id', ['id' => $id]);
    if (!$k) {
        return $id;
    }
    $gesperrt = gesperrte_felder($k['gesperrte_felder']);
    $setz = [];
    $p = ['id' => $id];
    if (!empty($a['name']) && !in_array('sortname', $gesperrt, true)) {
        $setz[] = 'sortname = :s'; // nicht die MusicBrainz-Sortierform „Nachname, Vorname“, sondern Vorname Nachname
        $p['s'] = mb_substr(sortname_aus((string) $a['name']), 0, 500);
    }
    if (isset($a['disambiguation']) && !in_array('unterscheidung', $gesperrt, true)) {
        $setz[] = 'unterscheidung = :u';
        $p['u'] = mb_substr((string) $a['disambiguation'], 0, 255);
    }
    if (!empty($a['type']) && !in_array('typ', $gesperrt, true)) {
        $setz[] = 'typ = :t';
        $p['t'] = mb_kuenstler_typ((string) $a['type']);
    }
    if ($k['quelle'] === 'tags') {
        $setz[] = "quelle = 'musicbrainz'";
    }
    if ($setz) {
        db_tun('UPDATE kuenstler SET ' . implode(', ', $setz) . ' WHERE id = :id', $p);
    }
    return $id;
}

function mb_kuenstler_typ(string $t): ?string
{
    return match (strtolower($t)) {
        'person' => 'person', 'group' => 'gruppe', 'orchestra' => 'orchester', 'choir' => 'chor', 'character' => 'figur', '' => null, default => 'sonstiges',
    };
}

/**
 * Genres eines Albums von MusicBrainz: Die meisten Stimmen liegen auf der Release Group, das einzelne Release hat oft keine.
 * Darum beides zusammenführen (Stimmen addiert); sind beide leer, die Release Group gezielt abfragen.
 * Liefert [['name' => …, 'count' => …], …] absteigend nach Stimmen.
 */
function mb_album_genres(array $rel, array $rg, bool $fehler_still = true): array
{
    $sammeln = static function (array $quellen): array {
        $z = [];
        foreach ($quellen as $liste) {
            foreach ((array) $liste as $g) {
                $n = mb_genre_name((string) ($g['name'] ?? ''));
                if ($n !== '') {
                    $z[$n] = ($z[$n] ?? 0) + max(1, (int) ($g['count'] ?? 0));
                }
            }
        }
        return $z;
    };
    $z = $sammeln([$rg['genres'] ?? [], $rel['genres'] ?? []]);
    if (!$z && ist_uuid($rg['id'] ?? null)) {
        try {
            $r = mb_abfrage('release-group/' . strtolower((string) $rg['id']), ['inc' => 'genres'], 7 * 86400);
            $z = $sammeln([$r['genres'] ?? []]);
        } catch (Throwable $e) {
            if (!$fehler_still) {
                throw $e; // Sammelabgleich: Fehler sichtbar machen
            }
            // keine Genres ist besser als ein abgebrochener Abgleich
        }
    }
    arsort($z);
    return array_map(static fn($n, $c) => ['name' => $n, 'count' => $c], array_keys($z), array_values($z));
}

/** Genres von MusicBrainz (die besten 6) beim Album eintragen; frühere MusicBrainz-Genres werden ersetzt, eigene bleiben */
function album_genres_von_mb_setzen(int $albumId, array $genres): void
{
    db_tun("DELETE FROM album_genres WHERE album_id = :a AND quelle = 'musicbrainz'", ['a' => $albumId]);
    $top = array_slice($genres, 0, 6);
    $summe = 0;
    foreach ($top as $g) {
        $summe += max(1, (int) ($g['count'] ?? 1));
    }
    foreach ($top as $g) {
        if ($gid = genre_holen(mb_genre_name((string) ($g['name'] ?? '')))) {
            $c = max(1, (int) ($g['count'] ?? 1));
            db_tun("INSERT IGNORE INTO album_genres (album_id, genre_id, quelle, stimmen, anteil) VALUES (:a, :g, 'musicbrainz', :s, :n)",
                ['a' => $albumId, 'g' => $gid, 's' => $c, 'n' => round($c / max(1, $summe), 4)]);
        }
    }
    db_tun('UPDATE alben SET genre_stimmen_am = NOW() WHERE id = :a', ['a' => $albumId]);
}

/**
 * Stimmen der MusicBrainz-Genres für schon vorhandene Alben nachholen (kleine Stücke, Abfragen sind 7 Tage gecacht).
 * Betrifft nur Genres mit Quelle MusicBrainz – eigene, getaggte und manuelle Genres bleiben unberührt.
 * Gibt die Zahl der bearbeiteten Alben zurück.
 */
function mb_genre_stimmen_nachholen(int $max = 8): int
{
    $n = 0;
    $alben = db_alle("SELECT a.id, a.mbid, (SELECT e.mbid FROM editionen e WHERE e.album_id = a.id AND e.mbid IS NOT NULL ORDER BY e.id LIMIT 1) AS rel
        FROM alben a WHERE a.genre_stimmen_am IS NULL AND a.mbid IS NOT NULL
          AND EXISTS (SELECT 1 FROM album_genres g WHERE g.album_id = a.id AND g.quelle = 'musicbrainz')
        ORDER BY a.id LIMIT " . max(1, $max));
    foreach ($alben as $a) {
        try {
            $rg = ist_uuid($a['mbid']) ? ['id' => $a['mbid']] : [];
            $rel = ist_uuid($a['rel'] ?? null) ? mb_abfrage('release/' . strtolower((string) $a['rel']), ['inc' => 'genres'], 7 * 86400) : [];
            $genres = mb_album_genres($rel, $rg, false);
            if ($genres) {
                album_genres_von_mb_setzen((int) $a['id'], $genres);
            } else {
                db_tun('UPDATE alben SET genre_stimmen_am = NOW() WHERE id = :a', ['a' => $a['id']]);
            }
            $n++;
        } catch (Throwable $e) {
            break; // MusicBrainz nicht erreichbar → nächster Lauf
        }
    }
    return $n;
}

/**
 * Genres je Aufnahme (Track) von MusicBrainz: eine Abfrage je 100 Aufnahmen einer Edition (Browse über das Release).
 * Bei vielen Aufnahmen leer – dann bleiben Album- und Künstler-Genres maßgeblich. Ersetzt nur Genres mit Quelle MusicBrainz.
 * Gibt die Zahl der Aufnahmen zurück, die Genres bekommen haben.
 */
function mb_aufnahme_genres_holen(int $editionId, string $releaseMbid): int
{
    $aufn = [];
    foreach (db_alle('SELECT DISTINCT a.id, a.mbid FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN aufnahmen a ON a.id = t.aufnahme_id
            WHERE m.edition_id = :e AND a.mbid IS NOT NULL', ['e' => $editionId]) as $z) {
        $aufn[strtolower((string) $z['mbid'])][] = (int) $z['id'];
    }
    $n = 0;
    for ($offset = 0, $seiten = 0; $aufn && $seiten < 5; $offset += 100, $seiten++) {
        $r = mb_abfrage('recording', ['release' => strtolower($releaseMbid), 'inc' => 'genres', 'limit' => 100, 'offset' => $offset], 7 * 86400);
        foreach ($r['recordings'] ?? [] as $rec) {
            $ids = $aufn[strtolower((string) ($rec['id'] ?? ''))] ?? [];
            $genres = $rec['genres'] ?? [];
            if (!$ids || !$genres) continue;
            usort($genres, static fn($x, $y) => (int) ($y['count'] ?? 0) <=> (int) ($x['count'] ?? 0));
            foreach ($ids as $aid) {
                db_tun("DELETE FROM aufnahme_genres WHERE aufnahme_id = :a AND quelle = 'musicbrainz'", ['a' => $aid]);
                $top = array_slice($genres, 0, 4);
                $summe = 0;
                foreach ($top as $g) {
                    $summe += max(1, (int) ($g['count'] ?? 1));
                }
                foreach ($top as $g) {
                    if ($gid = genre_holen(mb_genre_name((string) ($g['name'] ?? '')))) {
                        $c = max(1, (int) ($g['count'] ?? 1));
                        db_tun("INSERT IGNORE INTO aufnahme_genres (aufnahme_id, genre_id, quelle, stimmen, anteil) VALUES (:a, :g, 'musicbrainz', :s, :n)",
                            ['a' => $aid, 'g' => $gid, 's' => $c, 'n' => round($c / max(1, $summe), 4)]);
                    }
                }
                $n++;
            }
        }
        if (count($r['recordings'] ?? []) < 100) break;
    }
    db_tun('UPDATE editionen SET mb_aufnahme_genres_am = NOW() WHERE id = :e', ['e' => $editionId]);
    return $n;
}

/** MusicBrainz-Credit -> unsere Credit-ID */
function mb_credit(array $credit): ?int
{
    $teile = [];
    foreach ($credit as $c) {
        if (empty($c['artist'])) {
            continue;
        }
        // Anzeige in Amberwave: immer die „credited as“-Schreibweise. Standardnamen betreffen nur die Dateien (tag_credit).
        $alsName = (string) ($c['name'] ?? $c['artist']['name'] ?? '');
        $teile[] = ['kuenstler_id' => mb_kuenstler($c['artist']), 'name_als' => $alsName, 'verbindung' => (string) ($c['joinphrase'] ?? '')];
    }
    return $teile ? credit_holen($teile, 'musicbrainz') : null;
}

/** Werk (Komposition) finden oder anlegen */
function werk_holen(array $w): int
{
    $mbid = strtolower((string) ($w['id'] ?? ''));
    $id = ist_uuid($mbid) ? db_wert('SELECT id FROM werke WHERE mbid = :m', ['m' => $mbid]) : null;
    $titel = mb_substr((string) ($w['title'] ?? ''), 0, 500);
    $sprache = mb_substr((string) ($w['language'] ?? (($w['languages'] ?? [])[0] ?? '')), 0, 10);
    if ($id) {
        db_tun("UPDATE werke SET titel = :t, typ = :ty, sprache = :s WHERE id = :id AND quelle <> 'manuell'", ['t' => $titel, 'ty' => mb_substr((string) ($w['type'] ?? ''), 0, 40), 's' => $sprache, 'id' => $id]);
        return (int) $id;
    }
    return db_einfuegen("INSERT INTO werke (mbid, titel, typ, sprache, quelle) VALUES (:m, :t, :ty, :s, 'musicbrainz')",
        ['m' => ist_uuid($mbid) ? $mbid : null, 't' => $titel, 'ty' => mb_substr((string) ($w['type'] ?? ''), 0, 40), 's' => $sprache]);
}

/** Zuordnung MusicBrainz-Beziehungstyp -> unser Schlüssel (null = ignorieren) */
function mb_beziehungstyp(string $typ, array $attribute): ?string
{
    $typ = strtolower($typ);
    if ($typ === 'producer') {
        return in_array('executive', $attribute, true) ? 'exec_producer' : 'producer';
    }
    return match ($typ) {
        'mix', 'mixer' => 'mix',
        'mastering' => 'mastering',
        'recording', 'recording engineer' => 'recording',
        'engineer', 'sound', 'audio', 'balance', 'editor' => 'engineer',
        'programming' => 'programming',
        'instrument' => 'instrument',
        'vocal' => 'vocal',
        'performer', 'performing' => 'performer',
        'performing orchestra' => 'orchestra',
        'conductor' => 'conductor',
        'chorus master' => 'chorus_master',
        'arranger', 'instrument arranger', 'vocal arranger', 'orchestrator' => $typ === 'orchestrator' ? 'orchestrator' : 'arranger',
        'remixer' => 'remixer',
        'mix-dj' => 'dj_mix',
        'composer' => 'composer',
        'lyricist' => 'lyricist',
        'writer' => 'writer',
        'librettist' => 'librettist',
        default => null,
    };
}

/** Eigenschaften einer Beziehung, die keine Instrumente sind */
const MB_NEBEN_ATTRIBUTE = ['guest', 'additional', 'solo', 'co', 'executive', 'minor', 'assistant', 'associate', 'translated', 'partial', 'instrumental', 'live', 'medley', 'original', 'founder', 'eponymous', 'cover', 'pre', 'task'];

/** Künstler-Beziehungen (Produzent, Musiker, Songwriter …) eines MusicBrainz-Objekts an unser Objekt hängen. Liefert die Anzahl. */
function mb_beziehungen_anlegen(array $relationen, string $zuArt, int $zuId): int
{
    $n = 0;
    $pos = 0;
    foreach ($relationen as $r) {
        if (($r['target-type'] ?? '') !== 'artist' || empty($r['artist'])) {
            continue;
        }
        $attr = array_map(static fn($a) => strtolower((string) $a), $r['attributes'] ?? []);
        $schluessel = mb_beziehungstyp((string) ($r['type'] ?? ''), $attr);
        if ($schluessel === null) {
            continue;
        }
        $instrumente = [];
        $neben = [];
        foreach ($r['attributes'] ?? [] as $a) {
            $al = strtolower((string) $a);
            if (in_array($al, MB_NEBEN_ATTRIBUTE, true)) {
                $neben[] = $al;
            } elseif (in_array($schluessel, ['instrument', 'vocal', 'performer'], true)) {
                $instrumente[] = (string) $a;
            } else {
                $neben[] = $al;
            }
        }
        if ($schluessel === 'vocal' && !$instrumente) {
            $instrumente[] = 'vocals';
        }
        beziehung_anlegen($schluessel, 'kuenstler', mb_kuenstler($r['artist']), $zuArt, $zuId, [
            'instrumente' => $instrumente, 'attribute' => implode(',', array_unique($neben)), 'name_als' => (string) ($r['target-credit'] ?? ''),
            'beginn' => (string) ($r['begin'] ?? ''), 'ende' => (string) ($r['end'] ?? ''), 'quelle' => 'musicbrainz', 'pos' => $pos++,
        ]);
        $n++;
    }
    return $n;
}

function gesperrte_felder(?string $s): array
{
    return array_values(array_filter(array_map('trim', explode(',', (string) $s)), 'strlen'));
}

/** Genre-Namen von MusicBrainz ("post-disco") lesbar schreiben ("Post-Disco") */
function mb_genre_name(string $g): string
{
    $g = trim($g);
    return (string) preg_replace_callback('/(^|[\s\-\/&])(\p{Ll})/u', static fn($m) => $m[1] . mb_strtoupper($m[2]), $g);
}

/**
 * Vorschaubild des Covers, das MusicBrainz (Cover Art Archive) zu einer Edition hat – für den Abgleich.
 * Läuft über den Server (Bilder von außen sind per CSP gesperrt) und wird zwischengespeichert; „kein Cover“ merkt sich ein Tag lang.
 * Liefert ['body' => …, 'mime' => …] oder null.
 */
function mb_cover_vorschau(string $mbid, int $groesse = 250, string $art = 'release'): ?array
{
    $art = $art === 'release-group' ? 'release-group' : 'release';
    $mbid = strtolower($mbid);
    if (!ist_uuid($mbid)) {
        return null;
    }
    $groesse = $groesse >= 500 ? 500 : 250;
    $dir = konfig()['pfade']['cache'] . '/mb-cover';
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    $vor = $art === 'release-group' ? 'rg-' : '';
    $datei = "{$dir}/{$vor}{$mbid}-{$groesse}.img";
    $nein = "{$dir}/{$vor}{$mbid}.nein";
    $mime = static fn(string $b): string => str_starts_with($b, "\x89PNG") ? 'image/png' : (str_starts_with($b, 'GIF8') ? 'image/gif' : 'image/jpeg');
    if (is_file($datei) && filemtime($datei) > time() - 30 * 86400) {
        $b = (string) file_get_contents($datei);
        return ['body' => $b, 'mime' => $mime($b)];
    }
    if (is_file($nein) && filemtime($nein) > time() - 86400) {
        return null;
    }
    try {
        $r = http_holen(konfig()['quellen']['coverart_url'] . "/{$art}/{$mbid}/front-{$groesse}", ['Accept: image/*'], 25, 4 * 1024 * 1024);
    } catch (Throwable $e) {
        return null; // Fehler nicht merken: beim nächsten Mal wird neu versucht
    }
    if ($r['status'] !== 200 || strlen($r['body']) < 200) {
        if ($r['status'] === 404) {
            @file_put_contents($nein, '1');
        }
        return null;
    }
    @file_put_contents($datei, $r['body']);
    return ['body' => $r['body'], 'mime' => $mime($r['body'])];
}

/** Cover einer Edition aus dem Cover Art Archive laden. */
function mb_cover_laden(int $editionId, string $mbid): bool
{
    try {
        $r = http_holen(konfig()['quellen']['coverart_url'] . '/release/' . strtolower($mbid) . '/front-1200', ['Accept: image/*'], 40);
    } catch (Throwable $e) {
        return false;
    }
    if ($r['status'] !== 200 || strlen($r['body']) < 1000) {
        return false;
    }
    $schluessel = bild_speichern('cover', 'e' . $editionId, $r['body']);
    if (!$schluessel) {
        return false;
    }
    $alt = (string) db_wert('SELECT cover_datei FROM editionen WHERE id = :id', ['id' => $editionId]);
    db_tun("UPDATE editionen SET cover_datei = :c, cover_quelle = 'musicbrainz', cover_signatur = :s WHERE id = :id", ['c' => $schluessel, 's' => 'mb:' . $mbid, 'id' => $editionId]);
    if ($alt !== '' && $alt !== $schluessel && !db_wert('SELECT 1 FROM editionen WHERE cover_datei = :c LIMIT 1', ['c' => $alt])) {
        bild_loeschen('cover', $alt);
    }
    return true;
}

/**
 * Eine MusicBrainz-Edition für unsere Edition übernehmen.
 * Übernimmt Album (Release Group), Edition, Datenträger, Tracks, Aufnahmen, Werke und alle Mitwirkenden.
 * Fehlende Tracks werden ergänzt (ohne Datei), eigene Extras bleiben erhalten. Gesperrte Felder bleiben unberührt.
 */
function mb_edition_uebernehmen(int $editionId, string $mbid, string $cover_modus = 'fehlend', ?array $zuordnung = null, bool $sperren_loesen = false): array
{
    $log = [];
    $ed = db_zeile('SELECT * FROM editionen WHERE id = :id', ['id' => $editionId]);
    if (!$ed) {
        throw new MbFehler(t('Edition nicht gefunden.'));
    }
    $mbid = strtolower($mbid);
    $andere = (int) db_wert('SELECT id FROM editionen WHERE mbid = :m AND id <> :id', ['m' => $mbid, 'id' => $editionId]);
    $verwaist = 0;
    if ($andere) {
        // Hat die andere Edition gar keine Dateien mehr (Ordner weg, verschoben, oder ein Doppel aus dem Download-Ordner,
        // das nicht mehr eingelesen wird), übernimmt diese Edition die Verknüpfung; Hörverlauf, Playlists und Favoriten
        // ziehen mit um. Liegen dort noch Dateien, ist es ein echtes Doppel – dann nicht anfassen.
        $dateienDort = (int) db_wert('SELECT COUNT(*) FROM dateien d JOIN tracks t ON t.id = d.track_id JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $andere]);
        if ($dateienDort > 0) {
            $o = (string) db_wert('SELECT ordner FROM editionen WHERE id = :id', ['id' => $andere]);
            throw new MbFehler(t('Diese MusicBrainz-Edition ist schon mit einer anderen Edition verknüpft (Ordner „{ordner}“, {n} Dateien). Liegt das Album doppelt vor?', ['ordner' => $o, 'n' => $dateienDort]));
        }
        $verwaist = $andere;
    }
    $rel = mb_edition_laden($mbid, 3600);
    $rg = $rel['release-group'] ?? [];
    $vergleich = mb_vergleich($editionId, $rel, $zuordnung);
    $genres_mb = mb_album_genres($rel, $rg);

    db()->beginTransaction();
    try {
        if ($verwaist) {
            db_tun('UPDATE editionen SET mbid = NULL WHERE id = :id', ['id' => $verwaist]); // Verknüpfung freigeben (eindeutige MBID)
        }
        // Von Hand verschobene Dateien: Haben sie gesperrte Angaben (Titel, Künstler, Nummer von Hand gesetzt), bleiben die
        // sonst, wie sie sind – dann würde die Datei auf dem neuen Platz ihre alte Nummer behalten. Nur auf ausdrücklichen
        // Wunsch (Haken im Dialog) und nur für Dateien, die tatsächlich einen anderen Platz bekommen, werden diese Sperren aufgehoben.
        if ($zuordnung !== null && $sperren_loesen) {
            $auto = [];
            foreach (mb_vergleich($editionId, $rel)['zeilen'] as $z) {
                if ($z['wir']) {
                    $auto[(int) $z['wir']['track_id']] = $z['mb_i'];
                }
            }
            $gelockert = 0;
            foreach ($vergleich['zeilen'] as $z) {
                $tid = $z['wir'] ? (int) $z['wir']['track_id'] : 0;
                if (!$tid || !array_key_exists($tid, $auto) || $auto[$tid] === $z['mb_i'] || !$z['wir']['gesperrt']) {
                    continue;
                }
                $rest = array_diff(array_filter(explode(',', (string) db_wert('SELECT gesperrte_felder FROM tracks WHERE id = :t', ['t' => $tid]), ), 'strlen'), ['titel', 'kuenstler', 'nummer']);
                db_tun('UPDATE tracks SET gesperrte_felder = :g WHERE id = :t', ['g' => implode(',', $rest), 't' => $tid]);
                $gelockert++;
            }
            if ($gelockert) {
                $log[] = tn($gelockert, 'Sperre von einer verschobenen Datei auf Wunsch aufgehoben.', 'Sperren von {n} verschobenen Dateien auf Wunsch aufgehoben.');
            }
        }
        $alt_album = (int) $ed['album_id'];
        // ---- Album (Release Group) ----
        $rg_mbid = ist_uuid($rg['id'] ?? null) ? strtolower((string) $rg['id']) : null;
        $ziel_album = $rg_mbid ? db_wert('SELECT id FROM alben WHERE mbid = :m', ['m' => $rg_mbid]) : null;
        if ($ziel_album && (int) $ziel_album !== $alt_album) {
            db_tun('UPDATE editionen SET album_id = :a WHERE id = :e', ['a' => $ziel_album, 'e' => $editionId]);
            $log[] = t('Edition zum vorhandenen Album verschoben (gleiche Release Group).');
            $album_id = (int) $ziel_album;
        } else {
            $album_id = $alt_album;
            if ($rg_mbid) {
                db_tun('UPDATE alben SET mbid = :m WHERE id = :a', ['m' => $rg_mbid, 'a' => $album_id]);
            }
        }
        $a = db_zeile('SELECT * FROM alben WHERE id = :a', ['a' => $album_id]);
        $gesperrt = gesperrte_felder($a['gesperrte_felder'] ?? '');
        [$typ, $zusatz] = mb_album_typ($rg);
        $setz = ["quelle = 'musicbrainz'", 'mb_abgleich_am = NOW()', 'mb_ohne = 0'];
        $p = ['a' => $album_id];
        if (!in_array('titel', $gesperrt, true) && !empty($rg['title'])) {
            $setz[] = 'titel = :t';
            $p['t'] = mb_substr((string) $rg['title'], 0, 500);
        }
        if (!in_array('kuenstler', $gesperrt, true)) {
            $c = mb_credit($rg['artist-credit'] ?? $rel['artist-credit'] ?? []);
            if ($c) {
                $setz[] = 'credit_id = :c';
                $p['c'] = $c;
            }
        }
        if (!in_array('typ', $gesperrt, true)) {
            $setz[] = 'typ = :ty';
            $setz[] = 'zusatz_typen = :z';
            $p['ty'] = $typ;
            $p['z'] = $zusatz;
        }
        if (!in_array('jahr', $gesperrt, true) && !empty($rg['first-release-date']) && preg_match('/^(\d{4})/', (string) $rg['first-release-date'], $m)) {
            $setz[] = 'erstjahr = :j';
            $setz[] = 'erst_datum = :d';
            $p['j'] = (int) $m[1];
            $p['d'] = mb_substr((string) $rg['first-release-date'], 0, 10);
        }
        db_tun('UPDATE alben SET ' . implode(', ', $setz) . ' WHERE id = :a', $p);
        $log[] = t('Album: {titel} ({typ})', ['titel' => $rg['title'] ?? $a['titel'], 'typ' => $typ . ($zusatz !== '' ? ', ' . str_replace(',', ', ', $zusatz) : '')]);

        // Genres
        if (!in_array('genres', $gesperrt, true)) {
            $genres = $genres_mb;
            if ($genres) {
                album_genres_von_mb_setzen($album_id, $genres);
            }
        }

        // ---- Edition (Release) ----
        $eg = gesperrte_felder($ed['gesperrte_felder']);
        $datum = (string) ($rel['date'] ?? '');
        $setz = ['mbid = :m', "quelle = 'musicbrainz'", 'mb_abgleich_am = NOW()', 'mb_aufnahme_genres_am = NULL'];
        $p = ['m' => $mbid, 'id' => $editionId];
        $felder = [
            'titel' => ['titel', mb_substr((string) ($rel['title'] ?? $ed['titel']), 0, 500)],
            'datum' => ['datum', mb_substr($datum, 0, 10)],
            'land' => ['land', mb_substr((string) ($rel['country'] ?? ''), 0, 10)],
            'kommentar' => ['kommentar', mb_substr((string) ($rel['disambiguation'] ?? ''), 0, 255)],
        ];
        foreach ($felder as $f => [$spalte, $wert]) {
            if (!in_array($f, $eg, true)) {
                $setz[] = "{$spalte} = :{$spalte}";
                $p[$spalte] = $wert;
            }
        }
        if (!in_array('datum', $eg, true)) {
            $setz[] = 'jahr = :jahr';
            $p['jahr'] = preg_match('/^(\d{4})/', $datum, $m) ? (int) $m[1] : null;
        }
        $setz[] = 'status = :st';
        $setz[] = 'barcode = :bc';
        $setz[] = 'format_text = :ft';
        $p['st'] = mb_substr(strtolower((string) ($rel['status'] ?? '')), 0, 30);
        $p['bc'] = mb_substr((string) ($rel['barcode'] ?? ''), 0, 40);
        $p['ft'] = mb_substr(mb_format_text($rel['media'] ?? []), 0, 120);
        if (!in_array('kuenstler', $eg, true) && ($c = mb_credit($rel['artist-credit'] ?? []))) {
            $setz[] = 'credit_id = :c';
            $p['c'] = $c;
        }
        db_tun('UPDATE editionen SET ' . implode(', ', $setz) . ' WHERE id = :id', $p);

        // Labels
        db_tun('DELETE FROM edition_labels WHERE edition_id = :e', ['e' => $editionId]);
        foreach ($rel['label-info'] ?? [] as $li) {
            $kat = trim((string) ($li['catalog-number'] ?? ''));
            $lid = !empty($li['label']['name']) ? label_holen((string) $li['label']['name'], $li['label']['id'] ?? null) : null;
            if ($lid || ($kat !== '' && strtolower($kat) !== '[none]')) {
                db_tun('INSERT INTO edition_labels (edition_id, label_id, katalognummer) VALUES (:e, :l, :k)', ['e' => $editionId, 'l' => $lid, 'k' => mb_substr(strtolower($kat) === '[none]' ? '' : $kat, 0, 100)]);
            }
        }

        // ---- Datenträger, Tracks, Aufnahmen ----
        $dt_ids = [];
        foreach ($rel['media'] ?? [] as $m) {
            $pos = (int) ($m['position'] ?? 1);
            $dt = db_wert('SELECT id FROM datentraeger WHERE edition_id = :e AND pos = :p', ['e' => $editionId, 'p' => $pos]);
            if (!$dt) {
                $dt = db_einfuegen('INSERT INTO datentraeger (edition_id, pos, format, titel) VALUES (:e, :p, :f, :t)',
                    ['e' => $editionId, 'p' => $pos, 'f' => mb_substr((string) ($m['format'] ?? ''), 0, 40), 't' => mb_substr((string) ($m['title'] ?? ''), 0, 500)]);
            } else {
                db_tun('UPDATE datentraeger SET format = :f, titel = :t WHERE id = :id', ['f' => mb_substr((string) ($m['format'] ?? ''), 0, 40), 't' => mb_substr((string) ($m['title'] ?? ''), 0, 500), 'id' => $dt]);
            }
            $dt_ids[$pos] = (int) $dt;
        }
        // Rohdaten der MusicBrainz-Tracks nach Disc/Position
        $mb_tracks = [];
        foreach ($rel['media'] ?? [] as $m) {
            foreach ($m['tracks'] ?? [] as $t) {
                $mb_tracks[(int) ($m['position'] ?? 1) . '-' . (int) ($t['position'] ?? 0)] = $t;
            }
        }
        $zugeordnet = 0;
        $ergaenzt = 0;
        $beruehrt = [];
        $aufnahmen = [];
        foreach ($vergleich['zeilen'] as $z) {
            if (!$z['mb']) {
                continue; // eigene Extras bleiben, wie sie sind
            }
            $roh = $mb_tracks[$z['mb']['disc'] . '-' . $z['mb']['pos']] ?? null;
            if (!$roh) {
                continue;
            }
            $rec = $roh['recording'] ?? [];
            $rec_mbid = ist_uuid($rec['id'] ?? null) ? strtolower((string) $rec['id']) : null;
            $track_credit = mb_credit($roh['artist-credit'] ?? $rec['artist-credit'] ?? []) ?? ($p['c'] ?? null);
            $rec_credit = mb_credit($rec['artist-credit'] ?? $roh['artist-credit'] ?? []) ?? $track_credit;
            $dt = $dt_ids[$z['mb']['disc']] ?? reset($dt_ids);
            $titel = mb_substr((string) ($roh['title'] ?? ''), 0, 500);

            $track = $z['wir'] ? db_zeile('SELECT * FROM tracks WHERE id = :t', ['t' => $z['wir']['track_id']]) : null;
            // Aufnahme: vorhandene mit gleicher MBID (z. B. aus einer anderen Edition) teilen
            $aufnahme_id = $rec_mbid ? db_wert('SELECT id FROM aufnahmen WHERE mbid = :m', ['m' => $rec_mbid]) : null;
            if (!$aufnahme_id && $track && $track['aufnahme_id']) {
                $aufnahme_id = $track['aufnahme_id'];
                db_tun("UPDATE aufnahmen SET mbid = :m, quelle = 'musicbrainz' WHERE id = :a", ['m' => $rec_mbid, 'a' => $aufnahme_id]);
            }
            if (!$aufnahme_id) {
                $aufnahme_id = db_einfuegen("INSERT INTO aufnahmen (mbid, titel, credit_id, laenge_ms, quelle) VALUES (:m, :t, :c, :l, 'musicbrainz')",
                    ['m' => $rec_mbid, 't' => mb_substr((string) ($rec['title'] ?? $titel), 0, 500), 'c' => $rec_credit, 'l' => isset($rec['length']) ? (int) $rec['length'] : null]);
            } else {
                db_tun("UPDATE aufnahmen SET titel = :t, credit_id = :c, laenge_ms = COALESCE(:l, laenge_ms), kommentar = :k, quelle = 'musicbrainz' WHERE id = :a", [
                    't' => mb_substr((string) ($rec['title'] ?? $titel), 0, 500), 'c' => $rec_credit, 'l' => isset($rec['length']) ? (int) $rec['length'] : null,
                    'k' => mb_substr((string) ($rec['disambiguation'] ?? ''), 0, 255), 'a' => $aufnahme_id,
                ]);
            }
            $aufnahme_id = (int) $aufnahme_id;
            $aufnahmen[$aufnahme_id] = $rec;

            $namen = array_column(credit_liste($track_credit), 'name');
            $werte = [
                'm' => ist_uuid($roh['id'] ?? null) ? strtolower((string) $roh['id']) : null, 'd' => $dt, 'p' => (int) ($roh['position'] ?? 0),
                'n' => mb_substr((string) ($roh['number'] ?? ''), 0, 20), 't' => $titel, 'c' => $track_credit, 'a' => $aufnahme_id,
                's' => such_norm($titel, ...$namen),
            ];
            if ($track) {
                $sperre = array_filter(explode(',', (string) ($track['gesperrte_felder'] ?? '')), 'strlen');
                if (in_array('titel', $sperre, true)) {
                    $werte['t'] = $track['titel'];
                }
                if (in_array('kuenstler', $sperre, true)) {
                    $werte['c'] = $track['credit_id'] !== null ? (int) $track['credit_id'] : null;
                }
                if (in_array('nummer', $sperre, true)) {
                    $werte['n'] = $track['nummer'];
                    $werte['p'] = (int) $track['pos'];
                    $werte['d'] = (int) $track['datentraeger_id']; // auch die CD bleibt, wie von Hand gesetzt
                }
                $werte['s'] = such_norm($werte['t'], ...array_column(credit_liste($werte['c']), 'name'));
                $werte['l'] = $z['wir']['laenge_ms'] ?: (isset($roh['length']) ? (int) $roh['length'] : null);
                $werte['id'] = $track['id'];
                db_tun('UPDATE tracks SET mbid = :m, datentraeger_id = :d, pos = :p, nummer = :n, titel = :t, credit_id = :c, aufnahme_id = :a, laenge_ms = :l, suchtext = :s WHERE id = :id', $werte);
                $beruehrt[] = (int) $track['id'];
                $zugeordnet++;
            } else {
                $werte['l'] = isset($roh['length']) ? (int) $roh['length'] : null;
                $beruehrt[] = (int) db_einfuegen('INSERT INTO tracks (mbid, datentraeger_id, pos, nummer, titel, credit_id, aufnahme_id, laenge_ms, suchtext) VALUES (:m, :d, :p, :n, :t, :c, :a, :l, :s)', $werte);
                $ergaenzt++;
            }
        }
        // Titel ohne Datei, die in der neu gewählten MusicBrainz-Edition nicht vorkommen (Reste der vorherigen Edition), entfernen –
        // sonst bleibt das Album „unvollständig“. Titel mit Datei werden nie gelöscht.
        $veraltet = db_alle('SELECT t.id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e AND NOT EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id)', ['e' => $editionId]);
        $veraltet = array_values(array_diff(array_map(static fn($r) => (int) $r['id'], $veraltet), $beruehrt));
        foreach (array_chunk($veraltet, 200) as $teil) {
            [$in, $pin] = db_in($teil, 'v');
            db_tun("DELETE FROM tracks WHERE id IN {$in}", $pin);
        }
        if ($veraltet) {
            $log[] = tn(count($veraltet), 'Ein Titel der vorherigen Edition ohne Datei entfernt.', '{n} Titel der vorherigen Edition ohne Datei entfernt.');
        }
        db_tun('DELETE FROM datentraeger WHERE edition_id = :e AND id NOT IN (SELECT datentraeger_id FROM tracks)', ['e' => $editionId]);
        $log[] = tn((int) $zugeordnet, 'Ein Titel zugeordnet', '{n} Titel zugeordnet')
            . ($ergaenzt ? ', ' . tn((int) $ergaenzt, 'ein fehlender Titel ergänzt (ohne Datei)', '{n} fehlende Titel ergänzt (ohne Datei)') : '')
            . ($vergleich['zusammenfassung']['extra'] ? ', ' . tn((int) $vergleich['zusammenfassung']['extra'], 'ein eigener Titel ohne Gegenstück behalten', '{n} eigene Titel ohne Gegenstück behalten') : '') . '.';

        // ---- Mitwirkende ----
        $auf_ids = array_keys($aufnahmen);
        // Bisherige automatische Rollen dieser Edition und ihrer Aufnahmen ersetzen (Manuelles bleibt)
        db_tun("DELETE FROM beziehungen WHERE quelle IN ('tags','musicbrainz') AND zu_art = 'edition' AND zu_id = :e", ['e' => $editionId]);
        foreach (array_chunk($auf_ids, 200) as $teil) {
            [$in, $pin] = db_in($teil, 'a');
            db_tun("DELETE FROM beziehungen WHERE quelle IN ('tags','musicbrainz') AND zu_art = 'aufnahme' AND zu_id IN {$in}", $pin);
        }
        $anzahl = mb_beziehungen_anlegen($rel['relations'] ?? [], 'edition', $editionId);
        $werke_neu = [];
        foreach ($aufnahmen as $aid => $rec) {
            $anzahl += mb_beziehungen_anlegen($rec['relations'] ?? [], 'aufnahme', $aid);
            foreach ($rec['relations'] ?? [] as $r) {
                if (($r['target-type'] ?? '') === 'work' && !empty($r['work']['id'])) {
                    $wid = werk_holen($r['work']);
                    db_tun('INSERT IGNORE INTO aufnahme_werke (aufnahme_id, werk_id) VALUES (:a, :w)', ['a' => $aid, 'w' => $wid]);
                    if (!isset($werke_neu[$wid])) {
                        $werke_neu[$wid] = true;
                        db_tun("DELETE FROM beziehungen WHERE quelle = 'musicbrainz' AND zu_art = 'werk' AND zu_id = :w", ['w' => $wid]);
                        $anzahl += mb_beziehungen_anlegen($r['work']['relations'] ?? [], 'werk', $wid);
                    }
                }
            }
        }
        $log[] = tn((int) $anzahl, 'Ein Mitwirkender übernommen', '{n} Mitwirkende übernommen') . ($werke_neu ? ' (' . tn(count($werke_neu), 'eine Komposition', '{n} Kompositionen') . ')' : '') . '.';

        db()->commit();
    } catch (Throwable $e) {
        if (db()->inTransaction()) {
            db()->rollBack();
        }
        throw $e;
    }

    if ($verwaist) {
        $log[] = edition_nutzerdaten_umziehen($verwaist, $editionId);
        $alt_album_verwaist = (int) db_wert('SELECT album_id FROM editionen WHERE id = :id', ['id' => $verwaist]);
        edition_loeschen($verwaist);
        if ($alt_album_verwaist && $alt_album_verwaist !== $album_id && !db_wert('SELECT id FROM editionen WHERE album_id = :a LIMIT 1', ['a' => $alt_album_verwaist])) {
            db_tun('DELETE FROM alben WHERE id = :a', ['a' => $alt_album_verwaist]);
            geloescht_merken('album', $alt_album_verwaist);
        }
    }

    // ---- Cover ----
    $hat_cover = (string) db_wert('SELECT cover_datei FROM editionen WHERE id = :id', ['id' => $editionId]) !== '';
    if ($cover_modus === 'immer' || ($cover_modus === 'fehlend' && !$hat_cover)) {
        $log[] = mb_cover_laden($editionId, $mbid) ? t('Cover von MusicBrainz übernommen.') : t('Kein Cover bei MusicBrainz vorhanden.');
    }

    // ---- ISRC und Kennzeichnung „explizit“ (Deezer, läuft still mit; Fehler halten den Abgleich nicht auf) ----
    mb_isrcs_uebernehmen($editionId, $rel);
    try {
        $n = deezer_edition_explizit($editionId, false);
        if ($n) {
            $log[] = t('Kennzeichnung „explizit“ für {n} Titel von Deezer.', ['n' => $n]);
        }
    } catch (Throwable $e) {
        // Deezer nicht erreichbar – beim nächsten „Metadaten abgleichen“ wird es erneut versucht
    }

    // ---- Aufräumen und Kennzahlen ----
    edition_kennzahlen($editionId);
    album_anzeige_aktualisieren($album_id);
    album_suchtext_aktualisieren($album_id);
    if ($alt_album !== $album_id) {
        if (!db_wert('SELECT id FROM editionen WHERE album_id = :a LIMIT 1', ['a' => $alt_album])) {
            db_tun('DELETE FROM alben WHERE id = :a', ['a' => $alt_album]);
            geloescht_merken('album', $alt_album);
        } else {
            album_anzeige_aktualisieren($alt_album);
        }
    }
    bibliothek_aufraeumen();

    // Bands des Albumkünstlers mit Mitgliedern ergänzen (nur wenn noch nie abgeglichen)
    foreach (credit_liste((int) db_wert('SELECT credit_id FROM alben WHERE id = :a', ['a' => $album_id])) as $k) {
        $z = db_zeile('SELECT id, mbid, typ, mb_abgleich_am FROM kuenstler WHERE id = :id', ['id' => $k['id']]);
        if ($z && $z['mbid'] && $z['mb_abgleich_am'] === null) {
            try {
                mb_kuenstler_uebernehmen((int) $z['id'], null);
            } catch (Throwable $e) {
                $log[] = t('Künstler „{name}“ konnte nicht ergänzt werden: {fehler}', ['name' => $k['name'], 'fehler' => $e->getMessage()]);
            }
        }
    }
    return ['album_id' => $album_id, 'edition_id' => $editionId, 'log' => $log];
}

/** Künstler bei MusicBrainz suchen (für Künstler ohne MBID). */
function mb_kuenstler_suchen(string $name): array
{
    $d = mb_abfrage('artist', ['query' => 'artist:"' . mb_lucene($name) . '" OR alias:"' . mb_lucene($name) . '"', 'limit' => 25], 86400);
    return array_map(static fn($a) => [
        'mbid' => (string) $a['id'], 'name' => (string) ($a['name'] ?? ''), 'sortname' => (string) ($a['sort-name'] ?? ''),
        'typ' => mb_kuenstler_typ((string) ($a['type'] ?? '')), 'land' => (string) ($a['country'] ?? ''), 'unterscheidung' => (string) ($a['disambiguation'] ?? ''),
        'beginn' => (string) ($a['life-span']['begin'] ?? ''), 'ende' => (string) ($a['life-span']['end'] ?? ''), 'score' => (int) ($a['score'] ?? 0),
    ], $d['artists'] ?? []);
}

/**
 * Künstler-Details von MusicBrainz übernehmen: Typ, Land, Lebensdaten, Aliase, Bandmitgliedschaften.
 * $mbid = null -> die gespeicherte MBID verwenden.
 */
function mb_kuenstler_uebernehmen(int $kid, ?string $mbid): array
{
    $k = db_zeile('SELECT * FROM kuenstler WHERE id = :id', ['id' => $kid]);
    if (!$k) {
        throw new MbFehler(t('Künstler nicht gefunden.'));
    }
    $mbid = strtolower((string) ($mbid ?? $k['mbid'] ?? ''));
    if (!ist_uuid($mbid)) {
        throw new MbFehler(t('Für diesen Künstler ist keine MusicBrainz-ID bekannt – bitte zuerst suchen und auswählen.'));
    }
    $anderer = db_wert('SELECT id FROM kuenstler WHERE mbid = :m AND id <> :id', ['m' => $mbid, 'id' => $kid]);
    if ($anderer) {
        throw new MbFehler(t('Dieser MusicBrainz-Künstler ist bereits mit „{name}“ verknüpft.', ['name' => db_wert('SELECT name FROM kuenstler WHERE id = :id', ['id' => $anderer])]));
    }
    $a = mb_abfrage('artist/' . $mbid, ['inc' => 'aliases+artist-rels+url-rels+genres'], 7 * 86400);
    $gesperrt = gesperrte_felder($k['gesperrte_felder']);
    $log = [];
    $setz = ['mbid = :m', "quelle = IF(quelle = 'manuell', 'manuell', 'musicbrainz')", 'mb_abgleich_am = NOW()'];
    $p = ['m' => $mbid, 'id' => $kid];
    $felder = [
        'name' => (string) ($a['name'] ?? $k['name']), 'sortname' => sortname_aus((string) ($a['name'] ?? $k['name'])),
        'typ' => mb_kuenstler_typ((string) ($a['type'] ?? '')), 'unterscheidung' => (string) ($a['disambiguation'] ?? ''),
        'land' => (string) ($a['country'] ?? ''), 'beginn' => (string) ($a['life-span']['begin'] ?? ''), 'ende' => (string) ($a['life-span']['end'] ?? ''),
    ];
    foreach ($felder as $f => $w) {
        if (in_array($f, $gesperrt, true)) {
            continue;
        }
        $setz[] = "{$f} = :{$f}";
        $p[$f] = $f === 'typ' ? $w : mb_substr($w, 0, $f === 'name' || $f === 'sortname' ? 500 : 255);
        if ($f === 'name') {
            $setz[] = 'name_norm = :nn';
            $p['nn'] = name_norm($w) ?: mb_strtolower($w);
        }
    }
    db_tun('UPDATE kuenstler SET ' . implode(', ', $setz) . ' WHERE id = :id', $p);

    // Genres (für die Badges auf der Künstlerseite)
    if (function_exists('kuenstler_genres_speichern')) {
        try {
            kuenstler_genres_speichern($kid, $a['genres'] ?? []);
        } catch (Throwable $e) {
            // Tabelle evtl. noch nicht migriert
        }
    }

    // Aliase
    db_tun('DELETE FROM kuenstler_aliase WHERE kuenstler_id = :k', ['k' => $kid]);
    foreach (array_slice($a['aliases'] ?? [], 0, 60) as $al) {
        if (trim((string) ($al['name'] ?? '')) === '') {
            continue;
        }
        db_tun('INSERT INTO kuenstler_aliase (kuenstler_id, name, sortname, sprache, typ, primaer) VALUES (:k, :n, :s, :l, :t, :p)', [
            'k' => $kid, 'n' => mb_substr((string) $al['name'], 0, 500), 's' => mb_substr((string) ($al['sort-name'] ?? ''), 0, 500),
            'l' => mb_substr((string) ($al['locale'] ?? ''), 0, 10), 't' => mb_substr((string) ($al['type'] ?? ''), 0, 30), 'p' => !empty($al['primary']) ? 1 : 0,
        ]);
    }

    // Bandmitgliedschaften (in beide Richtungen)
    $member = beziehungstyp_id('member');
    db_tun("DELETE FROM beziehungen WHERE typ_id = :t AND quelle = 'musicbrainz' AND ((von_art = 'kuenstler' AND von_id = :k1) OR (zu_art = 'kuenstler' AND zu_id = :k2))",
        ['t' => $member, 'k1' => $kid, 'k2' => $kid]);
    $n = 0;
    foreach ($a['relations'] ?? [] as $r) {
        if (($r['type'] ?? '') !== 'member of band' || empty($r['artist'])) {
            continue;
        }
        $andererId = mb_kuenstler($r['artist']);
        $instr = array_values(array_filter($r['attributes'] ?? [], static fn($x) => !in_array(strtolower((string) $x), MB_NEBEN_ATTRIBUTE, true)));
        $neben = array_values(array_filter(array_map('strtolower', $r['attributes'] ?? []), static fn($x) => in_array($x, MB_NEBEN_ATTRIBUTE, true)));
        $rueck = ($r['direction'] ?? '') === 'backward'; // backward: der andere ist Mitglied in dieser Band
        beziehung_anlegen('member', 'kuenstler', $rueck ? $andererId : $kid, 'kuenstler', $rueck ? $kid : $andererId, [
            'instrumente' => $instr, 'attribute' => implode(',', $neben), 'beginn' => (string) ($r['begin'] ?? ''), 'ende' => (string) ($r['end'] ?? ''),
            'quelle' => 'musicbrainz', 'pos' => $n++,
        ]);
    }
    if ($n) {
        $log[] = tn((int) $n, 'Eine Bandmitgliedschaft übernommen.', '{n} Bandmitgliedschaften übernommen.');
    }
    $log[] = t('Künstlerdaten übernommen.');
    return ['log' => $log, 'urls' => array_values(array_filter(array_map(static fn($r) => ($r['target-type'] ?? '') === 'url' ? ['typ' => (string) ($r['type'] ?? ''), 'url' => (string) ($r['url']['resource'] ?? '')] : null, $a['relations'] ?? [])))];
}

require_once __DIR__ . '/deezer.php';

/**
 * Nutzerdaten einer Edition ohne Dateien auf eine andere Edition desselben Releases umziehen, bevor sie gelöscht wird:
 * Hörverlauf, Playlist-Einträge, Track-Favoriten, „Weiterhören“. Titel werden über die MusicBrainz-Track-ID zugeordnet,
 * ersatzweise über Datenträger und Position.
 */
function edition_nutzerdaten_umziehen(int $von, int $nach): string
{
    $neu = [];
    $neuPos = [];
    foreach (db_alle('SELECT t.id, t.mbid, m.pos mp, t.pos FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $nach]) as $t) {
        if ($t['mbid']) $neu[strtolower((string) $t['mbid'])] = (int) $t['id'];
        $neuPos[$t['mp'] . ':' . $t['pos']] = (int) $t['id'];
    }
    $n = 0;
    foreach (db_alle('SELECT t.id, t.mbid, m.pos mp, t.pos FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id = :e', ['e' => $von]) as $t) {
        $ziel = ($t['mbid'] ? ($neu[strtolower((string) $t['mbid'])] ?? null) : null) ?? ($neuPos[$t['mp'] . ':' . $t['pos']] ?? null);
        if (!$ziel) {
            continue;
        }
        $p = ['a' => (int) $t['id'], 'z' => $ziel];
        $n += db_tun('UPDATE wiedergaben SET track_id = :z WHERE track_id = :a', $p);
        $n += db_tun('UPDATE playlist_eintraege SET track_id = :z WHERE track_id = :a', $p);
        // Favorit: doppelte (schon beim neuen Titel gesetzt) einfach weglassen
        db_tun("DELETE f1 FROM favoriten f1 JOIN favoriten f2 ON f2.user_id = f1.user_id AND f2.art = 'track' AND f2.objekt_id = :z WHERE f1.art = 'track' AND f1.objekt_id = :a", $p);
        $n += db_tun("UPDATE favoriten SET objekt_id = :z WHERE art = 'track' AND objekt_id = :a", $p);
        db_tun('UPDATE weiterhoeren SET track_id = :z WHERE track_id = :a', $p);
    }
    db_tun('UPDATE wiedergaben SET edition_id = :n WHERE edition_id = :v', ['n' => $nach, 'v' => $von]);
    db_tun('DELETE w1 FROM weiterhoeren w1 JOIN weiterhoeren w2 ON w2.user_id = w1.user_id AND w2.edition_id = :n WHERE w1.edition_id = :v', ['n' => $nach, 'v' => $von]);
    db_tun('UPDATE weiterhoeren SET edition_id = :n WHERE edition_id = :v', ['n' => $nach, 'v' => $von]);
    $ordner = (string) db_wert('SELECT ordner FROM editionen WHERE id = :id', ['id' => $von]);
    return t('Verknüpfung von der Edition ohne Dateien übernommen ({ordner})', ['ordner' => $ordner !== '' ? '„' . $ordner . '“' : t('Ordner fehlt')])
        . ($n ? ', ' . tn((int) $n, 'ein Eintrag aus Verlauf/Playlists/Favoriten umgezogen', '{n} Einträge aus Verlauf/Playlists/Favoriten umgezogen') : '') . '.';
}

