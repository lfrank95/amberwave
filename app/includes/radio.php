<?php
// Radio, das aus dem Hören lernt – ohne Daumen, ohne Einstellungen, ohne fremde Interessen.
//
// Signale (nur aus dem eigenen Server, nichts geht nach außen):
//   - komplett gehört (+), zur Hälfte gehört (+ wenig), früh übersprungen (−−), spät übersprungen (− wenig)
//   - Wiederholen: kurz hintereinander nochmal gehört (+ extra), an vielen verschiedenen Tagen gehört (+)
//   - alles verblasst mit der Zeit (Halbwertszeit RADIO_HALBWERT Tage), damit sich der Geschmack verschieben darf
//   - Favoriten zählen mit
// Ähnlichkeit ohne Cloud: gleicher Künstler, gemeinsame Mitwirkende (Produzent, Musiker … aus MusicBrainz), Genre,
// Ära, und was in der Familie oft direkt nacheinander gehört wird (nur als Summe, niemand sieht, wer was hört).
// Dazu – wenn die Klanganalyse gelaufen ist – akustische Ähnlichkeit (klingt ähnlich wie die Saat). Saat 'klang' = Klangradio:
// dort entscheidet vor allem der Klang, Metadaten und eigene Vorlieben zählen weniger.
// Ausgewählt wird aus der ganzen Sammlung – mit einem festen Anteil an noch nie Gehörtem (Entdecken).
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';

require_once __DIR__ . '/genres.php';

const RADIO_HALBWERT = 45;        // Tage
const RADIO_FRUEH = 30;           // bis so viele Sekunden gilt Überspringen als „gefällt nicht“
const RADIO_SPERRE_STUNDEN = 6;   // so lange kommt ein gerade gehörter Titel nicht wieder

/** Katalog (für alle Nutzer gleich), 10 Minuten zwischengespeichert */
/**
 * @param bool $altOk  Startseite: ein bis zu 6 h alter Katalog reicht (die Themen-Knöpfe ändern sich selten) – sonst zahlte alle
 *                     10 Minuten der erste Aufruf der Startseite den kompletten Neuaufbau (bei großen Sammlungen Sekunden)
 */
function radio_katalog(bool $altOk = false): array
{
    $datei = konfig()['pfade']['cache'] . '/tmp/radio-katalog3.ser';
    if (is_file($datei) && filemtime($datei) > time() - ($altOk ? 21600 : 600)) {
        $k = @unserialize((string) file_get_contents($datei));
        if (is_array($k)) {
            return $k;
        }
    }
    // Pro Aufnahme (Song) ein Titel – bevorzugt aus der angezeigten Edition; andere Fassungen zählen für denselben Song
    $songs = [];      // key => [track, album, jahr, kuenstler[], genres[], personen[], titel, laenge]
    $trackKey = [];   // jede track_id (auch andere Editionen) => key
    $zeilen = db_alle("SELECT t.id, t.aufnahme_id, t.titel, t.credit_id, t.laenge_ms, a.id AS album_id, a.credit_id AS a_credit,
            COALESCE(a.erstjahr, e.jahr) AS jahr, a.zusatz_typen, (e.id = a.anzeige_edition_id OR a.editionen_einzeln = 1) AS sichtbar,
            EXISTS (SELECT 1 FROM dateien d WHERE d.track_id = t.id) AS da
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id");
    $credits = [];
    foreach (db_alle('SELECT credit_id, kuenstler_id FROM credit_namen') as $c) {
        $credits[(int) $c['credit_id']][] = (int) $c['kuenstler_id'];
    }
    $genreNamen = array_column(db_alle('SELECT id, name FROM genres'), 'name', 'id');
    $genreAlbum = [];
    $genreAlbumAnteil = [];
    foreach (db_alle('SELECT album_id, genre_id, anteil FROM album_genres') as $g) {
        $genreAlbum[(int) $g['album_id']][] = (int) $g['genre_id'];
        $genreAlbumAnteil[(int) $g['album_id']][(int) $g['genre_id']] = (float) $g['anteil'];
    }
    $genreAufn = [];
    $genreAufnAnteil = [];
    foreach (db_alle('SELECT aufnahme_id, genre_id, anteil FROM aufnahme_genres') as $g) {
        $genreAufn[(int) $g['aufnahme_id']][] = (int) $g['genre_id'];
        $genreAufnAnteil[(int) $g['aufnahme_id']][(string) ($genreNamen[(int) $g['genre_id']] ?? '')] = (float) $g['anteil'];
    }
    // Familien (Pop, Elektro …): Album aus album_familien, Titel aus dem Klang-Modell (aufnahme_stile)
    $famAlbum = [];
    foreach (db_alle('SELECT album_id, familie, wert FROM album_familien') as $f) {
        $famAlbum[(int) $f['album_id']][(string) $f['familie']] = (float) $f['wert'];
    }
    $stileAufn = [];
    foreach (db_alle('SELECT aufnahme_id, stil, wert FROM aufnahme_stile ORDER BY aufnahme_id, rang') as $f) {
        $stileAufn[(int) $f['aufnahme_id']][] = [(string) $f['stil'], (float) $f['wert']];
    }
    // Künstler-Genres (MusicBrainz, die 3 meistgenannten) – nur ein schwacher Hinweis, nie für Themenradios
    $genreKuenstler = [];
    foreach (db_alle('SELECT kuenstler_id, genre_id FROM kuenstler_genres ORDER BY kuenstler_id, stimmen DESC') as $g) {
        if (count($genreKuenstler[(int) $g['kuenstler_id']] ?? []) < 3) $genreKuenstler[(int) $g['kuenstler_id']][] = (int) $g['genre_id'];
    }
    $personAufn = [];
    $personAlbum = [];
    foreach (db_alle("SELECT von_id, zu_art, zu_id FROM beziehungen WHERE von_art = 'kuenstler' AND zu_art IN ('aufnahme','album')") as $b) {
        if ($b['zu_art'] === 'aufnahme') {
            $personAufn[(int) $b['zu_id']][(int) $b['von_id']] = true;
        } else {
            $personAlbum[(int) $b['zu_id']][(int) $b['von_id']] = true;
        }
    }
    foreach ($zeilen as $z) {
        $key = $z['aufnahme_id'] !== null ? 'a' . $z['aufnahme_id'] : 't' . $z['id'];
        $trackKey[(int) $z['id']] = $key;
        if (!$z['da']) {
            continue;
        }
        $besser = !isset($songs[$key]) || ($z['sichtbar'] && !$songs[$key]['sichtbar']);
        if (!$besser) {
            continue;
        }
        $kuenstler = $credits[(int) ($z['credit_id'] ?? $z['a_credit'])] ?? ($credits[(int) $z['a_credit']] ?? []);
        $personen = array_keys(($z['aufnahme_id'] !== null ? ($personAufn[(int) $z['aufnahme_id']] ?? []) : []) + ($personAlbum[(int) $z['album_id']] ?? []));
        $personen = array_values(array_diff($personen, $kuenstler));
        $ag = $genreAlbum[(int) $z['album_id']] ?? [];
        $tg = $z['aufnahme_id'] !== null ? ($genreAufn[(int) $z['aufnahme_id']] ?? []) : [];
        $kg = [];
        foreach ($kuenstler as $x) foreach ($genreKuenstler[$x] ?? [] as $g) $kg[$g] = true;
        $genres = array_values(array_unique(array_merge($ag, $tg)));
        // Familien des Songs: Klang-Modell 1,0 · Titel-Genres 0,9 · Album-Familien 0,6 · Künstler-Genres 0,2 (nur vorhandene Teile zählen)
        $teile = [];
        if ($z['aufnahme_id'] !== null && !empty($stileAufn[(int) $z['aufnahme_id']])) {
            $teile[] = [1.0, genre_stile_zu_familien($stileAufn[(int) $z['aufnahme_id']])];
        }
        if ($z['aufnahme_id'] !== null && !empty($genreAufnAnteil[(int) $z['aufnahme_id']])) {
            $teile[] = [0.9, genre_anteile_zu_familien($genreAufnAnteil[(int) $z['aufnahme_id']])];
        }
        if (!empty($famAlbum[(int) $z['album_id']])) {
            $teile[] = [0.6, $famAlbum[(int) $z['album_id']]];
        }
        if ($kg) {
            $kn = [];
            foreach (array_keys($kg) as $gid) $kn[(string) ($genreNamen[$gid] ?? '')] = 1.0;
            $teile[] = [0.2, genre_anteile_zu_familien($kn)];
        }
        $fam = [];
        $wsum = array_sum(array_column($teile, 0));
        foreach ($teile as [$w, $f]) {
            foreach ($f as $name => $v) $fam[$name] = ($fam[$name] ?? 0.0) + $w * $v / $wsum;
        }
        arsort($fam);
        // „Welt“ des Albums: Soundtracks (Film, Spiel) und Wortbeiträge sind eine eigene Welt – klanglich mögen sie Pop
        // ähneln (Synth-Score ↔ Dance-Pop), gehören aber nicht ins selbe Radio
        $zus = strtolower((string) ($z['zusatz_typen'] ?? ''));
        $welt = str_contains($zus, 'soundtrack') ? 'soundtrack' : (preg_match('/spokenword|audiobook|audio drama|interview/', $zus) ? 'wort' : '');
        $songs[$key] = ['welt' => $welt, 'track' => (int) $z['id'], 'album' => (int) $z['album_id'], 'jahr' => $z['jahr'] !== null ? (int) $z['jahr'] : null,
            'kuenstler' => $kuenstler, 'personen' => array_slice($personen, 0, 20), 'genres' => $genres,
            'agenres' => $ag, 'tgenres' => $tg, 'kgenres' => array_keys($kg), 'agw' => $genreAlbumAnteil[(int) $z['album_id']] ?? [], 'fam' => array_map(static fn($v) => round($v, 3), array_slice($fam, 0, 5, true)), 'titel' => $z['titel'],
            'laenge' => max(1, (int) $z['laenge_ms'] / 1000), 'sichtbar' => (bool) $z['sichtbar']];
    }
    $k = ['songs' => $songs, 'track_key' => $trackKey];
    @file_put_contents($datei, serialize($k), LOCK_EX);
    return $k;
}

function radio_jahrzehnt_name(int $j): string
{
    $en = sprache() === 'en';
    return $j >= 2000 ? ($j === 2000 ? '2000' : (string) $j) . ($en ? 's' : 'er') : substr((string) $j, 2) . ($en ? 's' : 'er');
}

/** Genre-Namen von MusicBrainz (klein geschrieben) für die Anzeige: „synth-pop“ → „Synth-Pop“, „r&b“ → „R&B“ */
function radio_genre_name(string $n): string
{
    $sonder = ['r&b' => 'R&B', 'edm' => 'EDM', 'idm' => 'IDM', 'uk garage' => 'UK Garage', 'hip hop' => 'Hip-Hop'];
    if (isset($sonder[$n])) return $sonder[$n];
    return (string) preg_replace_callback('/(^|[\s\-\/])(\p{L})/u', static fn($m) => $m[1] . mb_strtoupper($m[2]), $n);
}

/** So viele Songs braucht ein Jahrzehnt oder Genre für einen eigenen Radio-Knopf (RADIO_THEMA_MIN, Standard 25) */
function radio_thema_min(): int
{
    return max(1, (int) (konfig()['radio']['thema_min'] ?? 25));
}

/**
 * Wie stark gehört der Song zur Familie (Pop, Elektro …)? 0 = gar nicht, sonst der Familien-Anteil (0–1).
 * Streng (Standard): die Familie ist seine stärkste und hat mind. RADIO_FAMILIE_MIN (40 %), oder sie hat mind. RADIO_FAMILIE_SICHER (55 %).
 * Locker (kleine Sammlungen): ab 30 %, oder stärkste Familie ab 15 % – so wie früher.
 */
function radio_familie_staerke(array $s, string $familie, bool $streng = true): float
{
    $f = $s['fam'] ?? [];
    $v = (float) ($f[$familie] ?? 0);
    $erste = array_key_first($f) === $familie;
    $k = konfig()['radio'];
    if ($streng) {
        return ($v >= ($k['familie_sicher'] ?? 0.55) || ($erste && $v >= ($k['familie_min'] ?? 0.40))) ? $v : 0.0;
    }
    return ($v >= 0.30 || ($erste && $v >= 0.15)) ? $v : 0.0;
}
function radio_in_familie(array $s, string $familie, bool $streng = true): bool
{
    return radio_familie_staerke($s, $familie, $streng) > 0;
}

/**
 * Wie stark gehört der Song zu diesem einzelnen Genre? 1 = Titel-Genre; sonst der Anteil des Album-Genres, wenn es eines der
 * zwei stärksten ist und mind. RADIO_GENRE_MIN (35 %) der Stimmen hat (locker: 20 %, jeder Rang). Künstler-Genres zählen nie.
 */
function radio_genre_staerke(array $s, int $genreId, bool $streng = true): float
{
    if (in_array($genreId, $s['tgenres'] ?? [], true)) {
        return 1.0;
    }
    $agw = $s['agw'] ?? [];
    $v = (float) ($agw[$genreId] ?? 0);
    if ($v <= 0) {
        return 0.0;
    }
    if (!$streng) {
        return $v >= 0.2 ? $v : 0.0;
    }
    arsort($agw);
    $rang = array_search($genreId, array_keys($agw), true);
    return ($v >= (konfig()['radio']['genre_min'] ?? 0.35) && $rang !== false && $rang <= 1) ? $v : 0.0;
}
function radio_in_genre(array $s, int $genreId, bool $streng = true): bool
{
    return radio_genre_staerke($s, $genreId, $streng) > 0;
}

/**
 * Themen für die Radio-Knöpfe: Jahrzehnte, Genre-Familien (Pop, Elektro …) und einzelne Genres mit genug Songs
 * (mind. RADIO_THEMA_MIN). Aus dem zwischengespeicherten Katalog – kostet fast nichts.
 */
function radio_themen(bool $altOk = false): array
{
    $songs = radio_katalog($altOk)['songs'];
    $jz = [];
    $gz = [];
    $fz = [];
    foreach ($songs as $s) {
        if ($s['jahr']) $jz[intdiv($s['jahr'], 10) * 10] = ($jz[intdiv($s['jahr'], 10) * 10] ?? 0) + 1;
        foreach (array_keys(GENRE_FAMILIEN) as $f) if (radio_in_familie($s, $f)) $fz[$f] = ($fz[$f] ?? 0) + 1;
        foreach (array_unique(array_merge($s['tgenres'] ?? [], array_keys(array_filter($s['agw'] ?? [], static fn($v) => $v >= 0.2)))) as $g) $gz[$g] = ($gz[$g] ?? 0) + 1;
    }
    ksort($jz);
    $jahrzehnte = [];
    foreach ($jz as $j => $n) {
        if ($n >= radio_thema_min()) $jahrzehnte[] = ['art' => 'jahrzehnt', 'id' => $j, 'name' => radio_jahrzehnt_name($j), 'songs' => $n];
    }
    $genres = [];
    foreach (genre_familien() as $f => $name) {
        if (($fz[$f] ?? 0) >= radio_thema_min()) $genres[] = ['art' => 'familie', 'id' => $f, 'name' => $name, 'songs' => $fz[$f]];
    }
    arsort($gz);
    $gz = array_filter($gz, static fn($n) => $n >= radio_thema_min());
    if ($gz) {
        [$in, $p] = db_in(array_keys(array_slice($gz, 0, 30, true)), 'tg');
        $namen = array_column(db_alle("SELECT id, name FROM genres WHERE id IN {$in}", $p), 'name', 'id');
        $n_spez = 0;
        foreach (array_slice($gz, 0, 30, true) as $g => $n) {
            if (!isset($namen[$g]) || genre_familie_kopf((string) $namen[$g]) !== null) continue; // „Pop“, „Elektro“ … sind schon als Familie da
            $genres[] = ['art' => 'genre', 'id' => (int) $g, 'name' => radio_genre_name((string) $namen[$g]), 'songs' => $n];
            if (++$n_spez >= 10) break;
        }
    }
    return ['jahrzehnte' => $jahrzehnte, 'genres' => $genres];
}

/**
 * Wie ähnlich sind zwei Songs nach den Metadaten (0–1)? Gewichtete Genre-Übereinstimmung (Track-Genre 1,0, Album 0,8,
 * Künstler 0,5), dazu Ära (±12 Jahre), gemeinsame Mitwirkende und Künstler. Ergänzt die Klanganalyse beim Klangradio:
 * der Klang findet Kandidaten, die Metadaten sortieren Stilbrüche nach hinten.
 */
function radio_meta_aehnlich(array $a, array $b): float
{
    $gew = static function (array $s): array {
        $w = [];
        foreach ($s['kgenres'] ?? [] as $g) $w[$g] = 0.2;
        foreach ($s['agenres'] ?? [] as $g) $w[$g] = max($w[$g] ?? 0, 0.8);
        foreach ($s['tgenres'] ?? [] as $g) $w[$g] = 1.0;
        return $w;
    };
    $ga = $gew($a);
    $gb = $gew($b);
    $min = 0.0;
    $max = 0.0;
    foreach ($ga + $gb as $g => $_) {
        $x = $ga[$g] ?? 0.0;
        $y = $gb[$g] ?? 0.0;
        $min += min($x, $y);
        $max += max($x, $y);
    }
    $genre = $max > 0 ? $min / $max : 0.0;
    // Genre-Familien (Pop ↔ Synth-Pop zählt, Pop ↔ Klassik nicht): Überlappung der Familien-Anteile
    $fa = $a['fam'] ?? [];
    $fb = $b['fam'] ?? [];
    if ($fa && $fb) {
        $fm = 0.0;
        foreach ($fa as $f => $v) $fm += min($v, $fb[$f] ?? 0.0);
        $fs = max(array_sum($fa), array_sum($fb));
        $genre = 0.5 * $genre + 0.5 * ($fs > 0 ? $fm / $fs : 0.0);
    }
    $aera = ($a['jahr'] ?? null) && ($b['jahr'] ?? null) ? max(0.0, 1 - abs($a['jahr'] - $b['jahr']) / 12) : 0.4;
    $person = array_intersect($a['personen'] ?? [], $b['personen'] ?? []) ? 1.0 : 0.0;
    $kuenstler = array_intersect($a['kuenstler'] ?? [], $b['kuenstler'] ?? []) ? 1.0 : 0.0;
    $wert = 0.6 * $genre + 0.2 * $aera + 0.1 * $person + 0.1 * $kuenstler;
    if (($a['welt'] ?? '') !== ($b['welt'] ?? '')) {
        $wert *= 0.35; // Soundtrack ↔ Nicht-Soundtrack: deutlich ferner, auch bei gleicher Epoche
    }
    return $wert;
}

/** Was in der ganzen Familie oft direkt nacheinander (bis 20 min Abstand) gehört wurde – Song-Paare mit Gewicht */
function radio_nacheinander(array $trackKey): array
{
    $datei = konfig()['pfade']['cache'] . '/tmp/radio-paare.ser';
    if (is_file($datei) && filemtime($datei) > time() - 1800) {
        $p = @unserialize((string) file_get_contents($datei));
        if (is_array($p)) {
            return $p;
        }
    }
    $paare = [];
    $vorher = null;
    foreach (db_alle('SELECT user_id, track_id, UNIX_TIMESTAMP(gestartet_am) AS zeit, gehoert_sekunden, uebersprungen FROM wiedergaben
            WHERE gestartet_am > NOW() - INTERVAL 180 DAY ORDER BY user_id, gestartet_am') as $w) {
        $key = $trackKey[(int) $w['track_id']] ?? null;
        $gut = $key && !$w['uebersprungen'] && (int) $w['gehoert_sekunden'] >= 30;
        if ($gut && $vorher && $vorher['u'] === (int) $w['user_id'] && (int) $w['zeit'] - $vorher['zeit'] < 1200 && $vorher['key'] !== $key) {
            $paare[$vorher['key']][$key] = ($paare[$vorher['key']][$key] ?? 0) + 1;
            $paare[$key][$vorher['key']] = ($paare[$key][$vorher['key']] ?? 0) + 1;
        }
        $vorher = $gut ? ['u' => (int) $w['user_id'], 'zeit' => (int) $w['zeit'], 'key' => $key] : null;
    }
    @file_put_contents($datei, serialize($paare), LOCK_EX);
    return $paare;
}

/** Vorliebe des Nutzers je Song (aus Hören, Überspringen, Wiederholen, Favoriten) und wann zuletzt gehört */
function radio_vorlieben(int $uid, array $trackKey, array $songs): array
{
    $jetzt = time();
    $aff = [];
    $zuletzt = [];
    $tage = [];
    $letzteZeit = [];
    foreach (db_alle('SELECT track_id, UNIX_TIMESTAMP(gestartet_am) AS zeit, gehoert_sekunden, uebersprungen FROM wiedergaben
            WHERE user_id = :u AND gestartet_am > NOW() - INTERVAL 400 DAY ORDER BY gestartet_am', ['u' => $uid]) as $w) {
        $key = $trackKey[(int) $w['track_id']] ?? null;
        if (!$key) {
            continue;
        }
        $zeit = (int) $w['zeit'];
        $sek = (int) $w['gehoert_sekunden'];
        $laenge = $songs[$key]['laenge'] ?? 240;
        $anteil = min(1, $sek / $laenge);
        if ($w['uebersprungen']) {
            $wert = ($sek < RADIO_FRUEH || $anteil < 0.25) ? -1.0 : -0.25;
        } elseif ($anteil >= 0.85) {
            $wert = 1.0;
        } elseif ($anteil >= 0.4) {
            $wert = 0.4;
        } else {
            $wert = 0.0; // kurz angespielt und dann pausiert/Seite zu – sagt wenig
        }
        if ($wert > 0 && isset($letzteZeit[$key]) && $zeit - $letzteZeit[$key] < 7200) {
            $wert += 0.5; // gleich nochmal gehört
        }
        $verfall = 0.5 ** (($jetzt - $zeit) / 86400 / RADIO_HALBWERT);
        $aff[$key] = ($aff[$key] ?? 0) + $wert * $verfall;
        if ($wert > 0) {
            $tage[$key][(int) floor($zeit / 86400)] = true;
            $letzteZeit[$key] = $zeit;
        }
        $zuletzt[$key] = max($zuletzt[$key] ?? 0, $zeit);
    }
    // an vielen verschiedenen Tagen gehört = echtes Lieblingsstück, nicht nur eine Phase
    foreach ($tage as $key => $t) {
        $aff[$key] += 0.15 * max(0, count($t) - 1);
    }
    // Favoriten
    foreach (db_alle("SELECT art, objekt_id FROM favoriten WHERE user_id = :u", ['u' => $uid]) as $f) {
        if ($f['art'] === 'track' && isset($trackKey[(int) $f['objekt_id']])) {
            $k = $trackKey[(int) $f['objekt_id']];
            $aff[$k] = ($aff[$k] ?? 0) + 2.0;
        }
    }
    return [$aff, $zuletzt];
}

/** Vorliebe gesammelt je Künstler / Mitwirkendem / Genre (aus den Song-Vorlieben) */
function radio_summen(array $aff, array $songs, int $uid): array
{
    $kuenstler = [];
    $personen = [];
    $genres = [];
    foreach ($aff as $key => $a) {
        $s = $songs[$key] ?? null;
        if (!$s) {
            continue;
        }
        foreach ($s['kuenstler'] as $k) { $kuenstler[$k] = ($kuenstler[$k] ?? 0) + $a; }
        foreach ($s['personen'] as $k) { $personen[$k] = ($personen[$k] ?? 0) + $a * 0.5; }
        foreach ($s['genres'] as $g) { $genres[$g] = ($genres[$g] ?? 0) + $a; }
    }
    foreach (db_alle("SELECT objekt_id FROM favoriten WHERE user_id = :u AND art = 'kuenstler'", ['u' => $uid]) as $f) {
        $kuenstler[(int) $f['objekt_id']] = ($kuenstler[(int) $f['objekt_id']] ?? 0) + 3;
    }
    // Genres relativ zur Gesamtmenge (sonst gewinnt immer das häufigste Genre der Sammlung)
    $summe = array_sum(array_map('abs', $genres)) ?: 1;
    foreach ($genres as $g => $v) {
        $genres[$g] = $v / $summe * 10;
    }
    return [$kuenstler, $personen, $genres];
}

/**
 * Radio-Titel auswählen.
 * $saat: null (= „Mein Radio“) oder ['art' => 'track'|'klang'|'album'|'kuenstler'|'jahrzehnt'|'genre', 'id' => …]
 *        ('klang' = Klangradio ab einem Titel; 'jahrzehnt' = z. B. 1980 für das 80er-Radio; 'genre' = Genre-ID)
 * $ausschluss: Track-IDs, die gerade in der Warteschlange sind / waren
 * Rückgabe: ['tracks' => [...], 'gruende' => [track_id => Text], 'titel' => …]
 */
function radio_mix(array $user, ?array $saat, array $ausschluss, int $anzahl = 25): array
{
    $uid = (int) $user['id'];
    $kat = radio_katalog();
    $songs = $kat['songs'];
    $trackKey = $kat['track_key'];
    if (!$songs) {
        return ['tracks' => [], 'gruende' => new stdClass(), 'titel' => 'Radio'];
    }
    [$aff, $zuletzt] = radio_vorlieben($uid, $trackKey, $songs);
    [$affK, $affP, $affG] = radio_summen($aff, $songs, $uid);
    $paare = radio_nacheinander($trackKey);
    $jetzt = time();
    $aus = [];
    foreach ($ausschluss as $t) {
        if (isset($trackKey[(int) $t])) {
            $aus[$trackKey[(int) $t]] = true;
        }
    }

    // Saat: welche Songs, Künstler, Mitwirkenden, Genres, Ära stehen für „mehr davon“?
    $saatSongs = [];
    $titel = t('Mein Radio');
    $radioName = '';   // Name der Saat für „Radio: …“ und die Begründungen
    $klangRadio = $saat && ($saat['art'] ?? '') === 'klang';
    if ($saat && in_array($saat['art'] ?? '', ['track', 'klang'], true) && isset($trackKey[(int) $saat['id']])) {
        $k = $trackKey[(int) $saat['id']];
        $saatSongs = [$k => 1.0];
        $radioName = (string) ($songs[$k]['titel'] ?? t('Titel'));
        $titel = $klangRadio ? t('Klangradio: {name}', ['name' => $radioName]) : t('Radio: {name}', ['name' => $radioName]);
    } elseif ($saat && ($saat['art'] ?? '') === 'album') {
        foreach ($songs as $k => $s) {
            if ($s['album'] === (int) $saat['id']) { $saatSongs[$k] = 1.0; }
        }
        $radioName = (string) db_wert('SELECT titel FROM alben WHERE id = :a', ['a' => (int) $saat['id']]);
        $titel = t('Radio: {name}', ['name' => $radioName]);
    } elseif ($saat && ($saat['art'] ?? '') === 'kuenstler') {
        foreach ($songs as $k => $s) {
            if (in_array((int) $saat['id'], $s['kuenstler'], true)) { $saatSongs[$k] = 1.0; }
        }
        $radioName = (string) db_wert('SELECT name FROM kuenstler WHERE id = :k', ['k' => (int) $saat['id']]);
        $titel = t('Radio: {name}', ['name' => $radioName]);
    }
    // Themenradio (Jahrzehnt oder Genre): nur Songs, die dazu passen; Saat = deine Lieblinge daraus (wenn es welche gibt)
    $thema = null;
    $themaGrund = '';
    if ($saat && in_array($saat['art'] ?? '', ['jahrzehnt', 'genre', 'familie'], true)) {
        $id = (int) $saat['id'];
        $fkey = (string) ($saat['familie'] ?? '');
        if ($saat['art'] === 'genre') {
            // Heißt das Genre wie eine Familie (Pop, Elektro …), gilt die ganze Familie
            $kopf = genre_familie_kopf((string) db_wert('SELECT name FROM genres WHERE id = :g', ['g' => $id]));
            if ($kopf !== null) { $saat = ['art' => 'familie', 'id' => 0, 'familie' => $kopf]; $fkey = $kopf; }
        }
        $themaStaerke = null; // Song → 0 (passt nicht) … 1 (ganz klar); fließt in die Reihenfolge ein
        if ($saat['art'] === 'jahrzehnt') {
            $thema = static fn(array $s): bool => $s['jahr'] !== null && $s['jahr'] >= $id && $s['jahr'] <= $id + 9;
            $titel = t('{name}-Radio', ['name' => radio_jahrzehnt_name($id)]);
            $themaGrund = t('aus den {name}n', ['name' => radio_jahrzehnt_name($id)]);
        } else {
            $istFamilie = $saat['art'] === 'familie' && isset(GENRE_FAMILIEN[$fkey]);
            $staerke = $istFamilie
                ? static fn(array $s, bool $streng): float => radio_familie_staerke($s, $fkey, $streng)
                : static fn(array $s, bool $streng): float => radio_genre_staerke($s, $id, $streng);
            // Streng, solange genug Songs klar dazugehören; sonst die lockere Regel von früher
            $nStreng = 0;
            foreach ($songs as $s) { if ($staerke($s, true) > 0 && ++$nStreng >= 4 * $anzahl) break; }
            $streng = $nStreng >= 4 * $anzahl;
            $themaStaerke = static fn(array $s): float => $staerke($s, $streng);
            $thema = static fn(array $s): bool => $staerke($s, $streng) > 0;
            if ($istFamilie) {
                $titel = t('Radio: {name}', ['name' => genre_familien()[$fkey]]);
                $themaGrund = genre_familien()[$fkey];
            } else {
                $themaGrund = radio_genre_name((string) db_wert('SELECT name FROM genres WHERE id = :g', ['g' => $id]));
                $titel = t('Radio: {name}', ['name' => $themaGrund]);
            }
        }
        $kand = $aff;
        arsort($kand);
        foreach ($kand as $k => $a) {
            if ($a > 0 && isset($songs[$k]) && $thema($songs[$k])) $saatSongs[$k] = $a;
            if (count($saatSongs) >= 20) break;
        }
    }
    if (!$saatSongs && !$thema) {
        // Mein Radio: die stärksten Lieblinge der letzten Zeit sind die Saat
        $kand = $aff;
        arsort($kand);
        foreach (array_slice($kand, 0, 30, true) as $k => $a) {
            if ($a > 0 && isset($songs[$k])) { $saatSongs[$k] = $a; }
        }
        $saat = null;
    }
    $sK = []; $sP = []; $sG = []; $jahre = [];
    foreach ($saatSongs as $k => $w) {
        $s = $songs[$k] ?? null;
        if (!$s) { continue; }
        foreach ($s['kuenstler'] as $x) { $sK[$x] = ($sK[$x] ?? 0) + $w; }
        foreach ($s['personen'] as $x) { $sP[$x] = ($sP[$x] ?? 0) + $w; }
        foreach ($s['genres'] as $x) { $sG[$x] = ($sG[$x] ?? 0) + $w; }
        if ($s['jahr']) { $jahre[] = $s['jahr']; }
    }
    $normiere = static function (array $a): array { $m = max($a ?: [1]) ?: 1; return array_map(static fn($v) => $v / $m, $a); };
    $sK = $normiere($sK); $sP = $normiere($sP); $sG = $normiere($sG);
    sort($jahre);
    $jahrMitte = $jahre ? $jahre[intdiv(count($jahre), 2)] : null;
    // Saat-Radio (Künstler, Album, Titel): ein Profil der Saat – Genres mit Gewicht, Genre-Familien, Ära, Mitwirkende, Welt.
    // Jeder Kandidat muss diesem Profil ähnlich genug sein (sonst spielt das Michael-Jackson-Radio Rihanna, nur weil beides
    // „Pop“ ist und man Rihanna gern hört); die eigenen Vorlieben entscheiden nur noch innerhalb der passenden Menge.
    $saatRadio = $saat && !$klangRadio && !$thema && $saatSongs;
    $saatProfil = null;
    $saatName = $saatRadio ? $radioName : '';
    if ($saatRadio) {
        $fam = [];
        $welten = [];
        $wsum = 0.0;
        foreach ($saatSongs as $k => $w) {
            $s0 = $songs[$k] ?? null;
            if (!$s0) { continue; }
            foreach ($s0['fam'] ?? [] as $f => $v) { $fam[$f] = ($fam[$f] ?? 0.0) + $w * $v; }
            $welten[$s0['welt'] ?? ''] = ($welten[$s0['welt'] ?? ''] ?? 0) + $w;
            $wsum += $w;
        }
        foreach ($fam as $f => $v) { $fam[$f] = $wsum > 0 ? $v / $wsum : $v; }
        arsort($welten);
        $tg = []; $ag = []; $kg = [];
        foreach ($sG as $g => $w) { if ($w >= 0.5) $tg[] = $g; elseif ($w >= 0.2) $ag[] = $g; else $kg[] = $g; }
        $saatProfil = ['tgenres' => $tg, 'agenres' => $ag, 'kgenres' => $kg, 'fam' => $fam, 'jahr' => $jahrMitte,
            'personen' => array_keys($sP), 'kuenstler' => array_keys($sK), 'welt' => (string) (array_key_first($welten) ?? '')];
    }

    // Akustische Ähnlichkeit zur Saat (Klanganalyse). Ohne Index: leer – dann zählt nur der Rest.
    $klang = [];
    if (function_exists('kl_aehnliche')) {
        $saatAufn = [];
        foreach (array_keys($saatSongs) as $k) {
            if (str_starts_with((string) $k, 'a')) $saatAufn[] = (int) substr((string) $k, 1);
        }
        try {
            $klang = kl_aehnliche($saatAufn, count($saatAufn) <= 3 ? 2 : 1);
        } catch (Throwable $e) {
            $klang = [];
        }
    }
    $klangMix = function_exists('kl_verfahren') && kl_verfahren() === 'modell' ? [0.8, 0.2] : [0.55, 0.45];
    if ($klangRadio && !$klang) {
        $titel = t('Radio: {name}', ['name' => $radioName]); // noch keine Klanganalyse für diesen Titel – normales Radio
    }

    // Bewerten
    $kandidaten = [];
    // Klangradio: der Ausgangstitel läuft zuerst (nur beim Start, beim Nachfüllen ist er schon in der Liste)
    $erster = null;
    if ($klangRadio && $klang) {
        $sk = array_key_first($saatSongs);
        if ($sk !== null && !isset($aus[$sk]) && isset($songs[$sk])) {
            $erster = $sk;
            $anzahl = max(1, $anzahl - 1);
        }
    }
    // Klangradio bleibt in der Welt des Ausgangstitels (Soundtrack bzw. Musik), sobald sie genug Titel hat
    $saatWelt = null;
    if ($klangRadio && $klang && ($sk0 = array_key_first($saatSongs)) !== null && isset($songs[$sk0])) {
        $w0 = $songs[$sk0]['welt'] ?? '';
        $nWelt = 0;
        foreach ($songs as $s) { if (($s['welt'] ?? '') === $w0) { $nWelt++; } }
        if ($nWelt >= 3 * $anzahl) { $saatWelt = $w0; }
    }
    foreach ($songs as $k => $s) {
        if (isset($aus[$k]) || ($klangRadio && $klang && isset($saatSongs[$k]))) { continue; }
        if ($saatWelt !== null && ($s['welt'] ?? '') !== $saatWelt) { continue; }
        if ($thema && !$thema($s)) { continue; }
        if ($klangRadio && count($klang) >= 30 && !isset($klang[str_starts_with((string) $k, 'a') ? (int) substr((string) $k, 1) : -1])) { continue; }
        $a = $aff[$k] ?? 0.0;
        if (isset($zuletzt[$k]) && $jetzt - $zuletzt[$k] < RADIO_SPERRE_STUNDEN * 3600) { continue; }
        $teile = [];
        // Saat-Radio: Ähnlichkeit zum Saat-Profil (Genres, Familien, Ära, Mitwirkende); weit entfernte Jahrzehnte zusätzlich gedämpft
        $meta = 0.0;
        if ($saatProfil) {
            $meta = radio_meta_aehnlich($s, $saatProfil);
            if ($jahrMitte && $s['jahr']) {
                $dj = abs($s['jahr'] - $jahrMitte);
                if ($dj > 15) { $meta *= max(0.4, 1 - ($dj - 15) / 30); }
            }
        }
        // eigene Vorliebe für genau diesen Song (bekannt und geliebt / oft übersprungen)
        $teile['song'] = 1.1 * tanh($a / 2);
        // Künstler, Mitwirkende, Genre – aus dem eigenen Hören
        $kw = 0.0; $kBest = null;
        foreach ($s['kuenstler'] as $x) { $v = tanh(($affK[$x] ?? 0) / 4); if ($v > $kw) { $kw = $v; $kBest = $x; } }
        $teile['kuenstler'] = 0.6 * $kw;
        $pw = 0.0; $pBest = null;
        foreach ($s['personen'] as $x) { $v = tanh(($affP[$x] ?? 0) / 4); if ($v > $pw) { $pw = $v; $pBest = $x; } }
        $teile['person'] = 0.3 * $pw;
        $gw = 0.0; $gBest = null;
        foreach ($s['genres'] as $x) { $v = tanh(($affG[$x] ?? 0) / 2); if ($v > $gw) { $gw = $v; $gBest = $x; } }
        $teile['genre'] = 0.3 * $gw;
        // Nähe zur Saat
        $nah = 0.0; $nahGrund = null;
        foreach ($s['kuenstler'] as $x) { if (isset($sK[$x]) && $sK[$x] * 0.9 > $nah) { $nah = $sK[$x] * 0.9; $nahGrund = ['kuenstler', $x]; } }
        foreach ($s['personen'] as $x) { if (isset($sP[$x]) && $sP[$x] * 0.6 > $nah) { $nah = $sP[$x] * 0.6; $nahGrund = ['person', $x]; } }
        if (!$saatProfil) {
            $g = 0.0; foreach ($s['genres'] as $x) { $g = max($g, $sG[$x] ?? 0); }
            if ($g * 0.45 > $nah) { $nah = $g * 0.45; $nahGrund = ['genre', null]; }
        }
        $paar = 0.0; $paarSong = null;
        foreach ($saatSongs as $sk => $w) {
            $v = $paare[$sk][$k] ?? 0;
            if ($v > $paar) { $paar = $v; $paarSong = $sk; }
        }
        $paarWert = $paar > 0 ? 0.25 + 0.6 * tanh($paar / 3) : 0.0;
        if ($saatProfil) { $paarWert *= 0.5 + 0.5 * $meta; } // nacheinander gehört zählt nur, wenn es auch stilistisch passt
        if ($paarWert > $nah) { $nah = $paarWert; $nahGrund = ['paar', $paarSong]; }
        $era = ($jahrMitte && $s['jahr']) ? max(0, 1 - abs($s['jahr'] - $jahrMitte) / 15) : 0.0;
        if ($saatProfil) {
            $teile['saat'] = 1.6 * $nah + 1.8 * $meta;
            if ($nahGrund === null && $meta > 0) { $nahGrund = ['stil', null]; }
            // eigene Vorlieben nur noch als Feinsortierung innerhalb des Passenden
            $teile['song'] *= 0.5; $teile['kuenstler'] *= 0.5; $teile['person'] *= 0.5; $teile['genre'] *= 0.4;
        } else {
            $teile['saat'] = ($saat ? 1.6 : 0.9) * $nah + 0.25 * $era;
        }
        // Klang: Ähnlichkeit (Kosinus der Nachbarn, typisch 0,5–1) auf 0–1 strecken
        $kl = str_starts_with((string) $k, 'a') ? ($klang[(int) substr((string) $k, 1)] ?? null) : null;
        $klWert = $kl ? max(0.0, ($kl[0] - 0.5) / 0.5) : 0.0;
        if ($klangRadio && $klang) {
            // Klangradio: Klang findet, Metadaten sortieren (beim eingebauten Verfahren zählen sie mehr, das Modell erkennt Stil selbst)
            $quelle = $kl ? ($songs['a' . $kl[1]] ?? null) : ($songs[array_key_first($saatSongs)] ?? null);
            $meta = $quelle ? radio_meta_aehnlich($s, $quelle) : 0.0;
            $teile['klang'] = 2.6 * ($klangMix[0] * $klWert + $klangMix[1] * $meta);
            if ($quelle && ($quelle['welt'] ?? '') !== ($s['welt'] ?? '')) {
                $teile['klang'] *= 0.15; // andere Welt (Soundtrack/Wort ↔ Musik): praktisch nie, egal wie ähnlich es klingt
            }
            $teile['saat'] *= 0.4;
            $teile['song'] *= 0.5;
        } else {
            $teile['klang'] = ($saat ? 0.8 : 0.5) * $klWert;
        }
        // Genre-Radio: wie klar der Song dazugehört (reines Genre vor Grenzfällen)
        if (isset($themaStaerke)) { $teile['thema'] = 1.3 * $themaStaerke($s); }
        // Wiederholungs-Bremse: kürzlich gehört → seltener (aber nicht verboten)
        $her = isset($zuletzt[$k]) ? ($jetzt - $zuletzt[$k]) / 86400 : 999;
        $teile['frisch'] = $her < 1 ? -1.2 : ($her < 3 ? -0.5 : ($her < 7 ? -0.2 : 0.0));
        $neu = !isset($zuletzt[$k]);
        $wert = array_sum($teile);
        if (defined('RADIO_DEBUG')) { $GLOBALS['radio_debug'][$k] = ['meta' => round($meta, 3), 'wert' => round($wert, 2), 'teile' => array_map(static fn($v) => round($v, 2), $teile)]; }
        $kandidaten[] = ['key' => $k, 'wert' => $wert, 'neu' => $neu, 'teile' => $teile, 'kBest' => $kBest, 'pBest' => $pBest, 'gBest' => $gBest, 'nah' => $nahGrund,
            'klang' => $kl ? 'a' . $kl[1] : null, 'meta' => $meta, 'saatNah' => $nahGrund !== null && in_array($nahGrund[0], ['kuenstler', 'person'], true)];
    }
    if ($saatProfil) {
        // Untergrenze: nur, was dem Saat-Profil ähnlich genug ist (Künstler und Mitwirkende der Saat immer). Hat die Sammlung
        // zu wenig Passendes, wird die Grenze schrittweise gelockert – lieber ferner als Stille.
        foreach ([0.38, 0.3, 0.22, 0.15, 0.0] as $grenze) {
            $passend = array_values(array_filter($kandidaten, static fn($c) => $c['saatNah'] || $c['meta'] >= $grenze));
            if (count($passend) >= 3 * $anzahl || $grenze === 0.0) { $kandidaten = $passend; break; }
        }
    }
    usort($kandidaten, static fn($x, $y) => $y['wert'] <=> $x['wert']);
    $vorne = array_slice($kandidaten, 0, 800);
    $neue = array_values(array_filter($kandidaten, static fn($x) => $x['neu']));
    $neue = array_slice($neue, 0, 400);

    // Künstler-Radio: nur der Künstler selbst (Standard, deine Lieblinge von ihm zuerst); mit RADIO_KUENSTLER_ANTEIL < 100
    // kommt dazwischen Passendes von anderen. Eigene Titel werden nach deiner Vorliebe gezogen (Favoriten, oft gehört), nicht nach Saat-Nähe (die ist bei allen gleich).
    $kuenstlerRadio = $saat && ($saat['art'] ?? '') === 'kuenstler';
    $anteilEigen = $kuenstlerRadio ? (konfig()['radio']['kuenstler_anteil'] ?? 100) / 100 : 0.0;
    $eigene = [];
    if ($kuenstlerRadio) {
        $saatId = (int) $saat['id'];
        $rest = [];
        foreach ($kandidaten as $c) {
            if (in_array($saatId, $songs[$c['key']]['kuenstler'], true)) {
                $c['wert'] = 2 * $c['teile']['song'] + $c['teile']['frisch'] + 0.3 * $c['teile']['kuenstler'];
                $c['eigen'] = true;
                $eigene[] = $c;
            } else {
                $rest[] = $c;
            }
        }
        if ($anteilEigen >= 1 && count($eigene) < $anzahl) {
            // Nur der Künstler, und seine Titel sind (fast) alle kürzlich gelaufen oder schon in der Liste: wieder von vorn,
            // neu gemischt – nur die letzten paar der Warteschlange bleiben außen vor
            $schonDrin = array_flip(array_keys($eigene));
            $zuletztGelaufen = array_slice(array_values(array_filter(array_map(static fn($t) => $trackKey[(int) $t] ?? null, $ausschluss))), -3);
            foreach ($songs as $k => $s) {
                if (isset($schonDrin[$k]) || !in_array($saatId, $s['kuenstler'], true) || in_array($k, $zuletztGelaufen, true)) { continue; }
                $a0 = $aff[$k] ?? 0.0;
                $eigene[] = ['key' => $k, 'wert' => 1.1 * tanh($a0 / 2) - 0.3, 'neu' => !isset($zuletzt[$k]), 'teile' => ['song' => 0.55 * tanh($a0 / 2), 'kuenstler' => 0, 'person' => 0, 'genre' => 0, 'saat' => 0, 'frisch' => -0.3, 'klang' => 0],
                    'kBest' => null, 'pBest' => null, 'gBest' => null, 'nah' => null, 'klang' => null, 'meta' => 1.0, 'saatNah' => true, 'eigen' => true];
            }
        }
        usort($eigene, static fn($x, $y) => $y['wert'] <=> $x['wert']);
        $vorne = array_slice($rest, 0, 800);
        $neue = array_slice(array_values(array_filter($rest, static fn($x) => $x['neu'])), 0, 400);
    }

    $sollEigen = 1.0; // der erste Titel ist vom Künstler
    $fremdeGezogen = 0;

    // Ziehen: zufällig, aber nach Wert gewichtet (Softmax), mit Regeln für Abwechslung; jeder 4. Titel ist neu für dich
    $gewaehlt = [];
    $kuenstlerZuletzt = [];
    $albumZuletzt = [];
    $nimm = static function (array &$pool, array $kuenstlerZuletzt, array $albumZuletzt, array $songs, float $temp): ?array {
        $gewichte = [];
        $summe = 0.0;
        foreach ($pool as $i => $c) {
            $s = $songs[$c['key']];
            if (array_intersect($s['kuenstler'], $kuenstlerZuletzt) || in_array($s['album'], $albumZuletzt, true)) {
                continue;
            }
            $g = exp(($c['wert'] - $pool[0]['wert']) / $temp);
            $gewichte[$i] = $g;
            $summe += $g;
        }
        if (!$gewichte) {
            return null;
        }
        $r = mt_rand() / mt_getrandmax() * $summe;
        foreach ($gewichte as $i => $g) {
            $r -= $g;
            if ($r <= 0) {
                $c = $pool[$i];
                array_splice($pool, $i, 1);
                return $c;
            }
        }
        $i = array_key_last($gewichte);
        $c = $pool[$i];
        array_splice($pool, $i, 1);
        return $c;
    };
    $schon = [];
    $versuche = 0;
    while (count($gewaehlt) < $anzahl && $versuche++ < $anzahl * 4) {
        $entdecken = false;
        $c = null;
        if ($kuenstlerRadio) {
            // Takt: so viele eigene, wie der Anteil vorgibt (der erste Titel ist immer vom Künstler), sonst ein fremder
            $sollEigen += $anteilEigen;
            $eigenDran = $eigene && ($sollEigen >= 1 || !$vorne || $anteilEigen >= 1);
            if ($anteilEigen >= 1 && !$eigene) { break; } // nur der Künstler – wenn er durch ist, ist Schluss (keine Fremdtitel auffüllen)
            if ($eigenDran) {
                $sollEigen -= 1;
                // nicht dasselbe Album wie zuletzt (Künstler-Regel gilt hier natürlich nicht); Temperatur höher = mehr Mischung
                $c = $nimm($eigene, [], $albumZuletzt, $songs, 0.45) ?: $nimm($eigene, [], [], $songs, 0.45);
            } else {
                $entdecken = ($fremdeGezogen % 3 === 2) && $neue;
                $c = $entdecken ? $nimm($neue, $kuenstlerZuletzt, $albumZuletzt, $songs, 0.35) : $nimm($vorne, $kuenstlerZuletzt, $albumZuletzt, $songs, 0.25);
                if (!$c) { $c = $entdecken ? $nimm($neue, [], [], $songs, 0.35) : $nimm($vorne, [], [], $songs, 0.25); }
                if ($c) { $fremdeGezogen++; }
                elseif ($eigene) { $c = $nimm($eigene, [], $albumZuletzt, $songs, 0.45) ?: $nimm($eigene, [], [], $songs, 0.45); }
            }
            if (!$c) { break; }
        } else {
            $entdecken = (count($gewaehlt) % 4 === 3) && $neue;
            $c = $entdecken ? $nimm($neue, $kuenstlerZuletzt, $albumZuletzt, $songs, 0.35) : $nimm($vorne, $kuenstlerZuletzt, $albumZuletzt, $songs, 0.25);
            if (!$c) {
                // Regeln zu streng (kleine Sammlung): ohne Abwechslungsregel weiter
                $c = $entdecken ? $nimm($neue, [], [], $songs, 0.35) : $nimm($vorne, [], [], $songs, 0.25);
                if (!$c) { break; }
            }
        }
        if (isset($schon[$c['key']])) { continue; }
        $schon[$c['key']] = true;
        $gewaehlt[] = $c + ['entdecken' => $entdecken];
        $s = $songs[$c['key']];
        $kuenstlerZuletzt = array_slice(array_merge($kuenstlerZuletzt, $s['kuenstler']), -3 * max(1, count($s['kuenstler'])));
        $albumZuletzt = array_slice(array_merge($albumZuletzt, [$s['album']]), -5);
        // aus dem jeweils anderen Pool auch entfernen
        $vorne = array_values(array_filter($vorne, static fn($x) => $x['key'] !== $c['key']));
        $neue = array_values(array_filter($neue, static fn($x) => $x['key'] !== $c['key']));
        if ($kuenstlerRadio) { $eigene = array_values(array_filter($eigene, static fn($x) => $x['key'] !== $c['key'])); }
    }

    if ($erster !== null) {
        array_unshift($gewaehlt, ['key' => $erster, 'wert' => 0, 'neu' => false, 'teile' => ['song' => 0, 'kuenstler' => 0, 'person' => 0, 'genre' => 0, 'saat' => 0, 'frisch' => 0, 'klang' => 0],
            'kBest' => null, 'pBest' => null, 'gBest' => null, 'nah' => null, 'klang' => null, 'entdecken' => false, 'start' => true]);
    }
    // Gründe in Worten
    $namen = [];
    $ids = [];
    foreach ($gewaehlt as $c) {
        foreach ([$c['kBest'], $c['pBest'], ($c['nah'][0] ?? '') === 'kuenstler' || ($c['nah'][0] ?? '') === 'person' ? $c['nah'][1] : null] as $x) {
            if ($x) { $ids[$x] = true; }
        }
    }
    if ($ids) {
        [$in, $p] = db_in(array_keys($ids), 'rk');
        $namen = array_column(db_alle("SELECT id, name FROM kuenstler WHERE id IN {$in}", $p), 'name', 'id');
    }
    $genreNamen = array_column(db_alle('SELECT id, name FROM genres'), 'name', 'id');
    $gruende = [];
    $trackIds = [];
    foreach ($gewaehlt as $c) {
        $s = $songs[$c['key']];
        $trackIds[] = $s['track'];
        $t = $c['teile'];
        $kurz = static fn($x) => mb_strlen($x) > 40 ? mb_substr($x, 0, 38) . '…' : $x;
        $klangQuelle = $c['klang'] && isset($songs[$c['klang']]) ? $songs[$c['klang']]['titel'] : null;
        if (!empty($c['start'])) {
            $grund = t('Ausgangstitel – danach Ähnliches im Klang');
        } elseif (!empty($c['eigen'])) {
            $grund = $t['song'] > 0.4 ? t('dein Liebling von {name}', ['name' => $saatName]) : ($c['neu'] ? t('von {name} · noch nie gehört', ['name' => $saatName]) : t('von {name}', ['name' => $saatName]));
        } elseif ($klangQuelle && ($klangRadio || $t['klang'] >= max($t['song'], $t['kuenstler'], $t['person'], $t['genre'], 0.35))) {
            $grund = t('klingt wie „{titel}“', ['titel' => $kurz($klangQuelle)]) . ($c['entdecken'] ? ' · ' . t('neu für dich') : '');
        } elseif ($c['entdecken']) {
            $was = $c['kBest'] && $c['teile']['kuenstler'] > 0.15 ? t('von {name}', ['name' => $namen[$c['kBest']] ?? '']) : ($c['gBest'] ? ($genreNamen[$c['gBest']] ?? '') : '');
            $grund = t('Neu für dich') . ($was !== '' ? ' · ' . $was : '');
        } elseif ($saat && ($c['nah'][0] ?? '') === 'paar') {
            $grund = t('wird oft nach „{titel}“ gehört', ['titel' => $kurz($songs[$c['nah'][1]]['titel'] ?? '')]);
        } elseif ($saat && ($c['nah'][0] ?? '') === 'kuenstler') {
            $grund = t('mehr von {name}', ['name' => $namen[$c['nah'][1]] ?? '']);
        } elseif ($saat && ($c['nah'][0] ?? '') === 'person') {
            $grund = t('auch mit {name}', ['name' => $namen[$c['nah'][1]] ?? '']);
        } elseif ($saat && ($c['nah'][0] ?? '') === 'stil' && $saatName !== '') {
            $grund = t('im Stil von {name}', ['name' => $saatName]) . ($t['song'] > 0.3 ? ' · ' . t('magst du') : '');
        } elseif ($t['song'] >= max($t['kuenstler'], $t['person'], $t['genre']) && $t['song'] > 0.3) {
            $grund = ($zuletzt[$c['key']] ?? 0) > $jetzt - 14 * 86400 ? t('hörst du gerade oft') : t('eins deiner Lieblingsstücke');
        } elseif (($c['nah'][0] ?? '') === 'paar') {
            $grund = t('passt zu „{titel}“', ['titel' => $kurz($songs[$c['nah'][1]]['titel'] ?? '')]);
        } elseif ($t['kuenstler'] >= max($t['person'], $t['genre']) && $c['kBest']) {
            $grund = t('weil du {name} gern hörst', ['name' => $namen[$c['kBest']] ?? t('diesen Künstler')]);
        } elseif ($t['person'] >= $t['genre'] && $c['pBest']) {
            $grund = t('mit {name} – den hörst du oft', ['name' => $namen[$c['pBest']] ?? '']);
        } elseif ($c['gBest']) {
            $grund = ($genreNamen[$c['gBest']] ?? t('dein Genre'));
        } else {
            $grund = $thema ? $themaGrund : t('aus deiner Sammlung');
        }
        $gruende[$s['track']] = $grund;
    }
    return ['tracks' => tracks_mit_album($trackIds, $uid), 'gruende' => (object) $gruende, 'titel' => $titel];
}
