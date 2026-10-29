<?php
// Genre-Familien: Pop, Elektro, Rock … – damit „Pop“ nicht nur Alben mit genau dem Genre „Pop“ findet, sondern die ganze
// Familie (Synth-Pop, Dance-Pop, Indie-Pop), und damit einzelne Stimmen für ein fremdes Genre nicht reichen.
//
// Quellen (je Album und je Titel, mit Gewicht):
//   - MusicBrainz-Genres mit Anteil an den Stimmen (album_genres.anteil), eigene Tags/Genres (Anteil 1, gleichmäßig verteilt)
//   - Stil-Erkennung aus dem Klang (aufnahme_stile, nur mit dem erweiterten Klang-Modell): Discogs-Hauptgenre je Stil
// Ergebnis je Album: album_familien (album_id, familie, wert 0–1, Summe ≈ 1). Filter und Radio nutzen eine Schwelle.
declare(strict_types=1);

/** Familien in Anzeigereihenfolge: Schlüssel => Anzeigename */
const GENRE_FAMILIEN = [
    'pop' => 'Pop', 'elektro' => 'Elektro', 'rock' => 'Rock', 'hiphop' => 'Hip-Hop', 'soul' => 'Soul/Funk/R&B', 'jazz' => 'Jazz',
    'klassik' => 'Klassik', 'folk' => 'Folk/Country/Welt', 'reggae' => 'Reggae', 'latin' => 'Latin', 'blues' => 'Blues',
    'soundtrack' => 'Soundtrack/Musical', 'kinder' => 'Kinder',
];

/** Wie GENRE_FAMILIEN, die Anzeigenamen aber in der Sprache der Anfrage (Konstanten können kein t()) */
function genre_familien(): array
{
    $aus = [];
    foreach (GENRE_FAMILIEN as $k => $name) {
        $aus[$k] = t($name);
    }
    return $aus;
}

/** Discogs-Hauptgenre (Teil vor „---“ im Stil-Namen) => Familie; nicht gelistete (Brass & Military, Non-Music) zählen nicht */
const GENRE_DISCOGS_FAMILIE = [
    'pop' => 'pop', 'electronic' => 'elektro', 'rock' => 'rock', 'hip hop' => 'hiphop', 'funk / soul' => 'soul', 'jazz' => 'jazz',
    'classical' => 'klassik', 'folk, world, & country' => 'folk', 'reggae' => 'reggae', 'latin' => 'latin', 'blues' => 'blues',
    'stage & screen' => 'soundtrack', "children's" => 'kinder',
];

/** Schlagwörter je Familie (auf den normalisierten Genre-Namen, Wortanfang; mehrere Treffer teilen das Gewicht) */
const GENRE_FAMILIE_MUSTER = [
    'pop' => '(?:pop|schlager|synthpop|electropop|europop|britpop|dancepop|chanson)',
    'elektro' => '(?:electro|electronic|electronica|elektro|elektronisch|house|techno|trance|edm|dubstep|drum and bass|drum n bass|dnb|jungle|breakbeat|idm|synthwave|vaporwave|downtempo|ambient|chillout|trip hop|triphop|eurodance|hardstyle|garage|dance|synth|disco|italo|new age|industrial)',
    'rock' => '(?:rock|metal|punk|grunge|hardcore|emo|shoegaze|new wave|post punk|alternative|indie|ska punk|britrock)',
    'hiphop' => '(?:hip hop|hiphop|rap|trap|grime|drill|boom bap|trip hop|triphop)',
    'soul' => '(?:soul|r&b|rnb|r and b|funk|motown|gospel|disco|quiet storm|new jack swing)',
    'jazz' => '(?:jazz|bebop|bop|swing|big band|bossa nova|fusion)',
    'klassik' => '(?:classical|klassik|baroque|opera|orchestral|orchestra|symphon\w*|chamber|romantic|choral|renaissance|medieval|minimalism|piano)',
    'folk' => '(?:folk|country|bluegrass|singer songwriter|singer-songwriter|world|celtic|americana|traditional|volksmusik|afro|african|highlife|polka|flamenco)',
    'reggae' => '(?:reggae|ska|dub|dancehall|rocksteady|roots)',
    'latin' => '(?:latin|latino|salsa|bossa nova|samba|tango|reggaeton|bachata|merengue|cumbia|mambo|flamenco|bolero)',
    'blues' => '(?:blues)',
    'soundtrack' => '(?:soundtrack|score|film|movie|video game|game music|musical|stage|theme|anime|ost|tv)',
    'kinder' => '(?:children|childrens|kids|kinder|nursery|lullaby)',
];

/** Genre-Namen, die für ihre ganze Familie stehen (Klick auf „Pop“ meint die Familie), normalisiert */
const GENRE_FAMILIE_KOEPFE = [
    'pop' => ['pop', 'pop music', 'popmusik'],
    'elektro' => ['electronic', 'electronica', 'elektro', 'elektronisch', 'elektronik', 'electro', 'electronic music', 'elektronische musik'],
    'rock' => ['rock', 'rock music', 'rockmusik'],
    'hiphop' => ['hip hop', 'hiphop', 'rap'],
    'soul' => ['soul', 'r&b', 'rnb', 'rhythm and blues', 'funk', 'funk soul'],
    'jazz' => ['jazz'],
    'klassik' => ['classical', 'klassik', 'klassische musik', 'classical music'],
    'folk' => ['folk', 'world', 'world music', 'weltmusik', 'folk world country'],
    'reggae' => ['reggae'],
    'latin' => ['latin', 'latin music'],
    'blues' => ['blues'],
    'soundtrack' => ['soundtrack', 'score', 'film score', 'filmmusik', 'ost', 'soundtracks'],
    'kinder' => ['children', 'childrens', 'kinder', 'kinderlieder', 'kids'],
];

/** Genre-Name für den Mustervergleich: klein, Trennzeichen als Leerzeichen, „&“ bleibt (r&b) */
function genre_roh_norm(string $name): string
{
    $s = mb_strtolower(trim($name), 'UTF-8');
    $s = (string) preg_replace('/[\-_\/,.;:()]+/u', ' ', $s);
    return trim((string) preg_replace('/\s+/u', ' ', $s));
}

/**
 * Familien eines Genre-Namens mit Gewicht (Summe 1): „Synth-Pop“ → pop 0,5 + elektro 0,5, „Indie Rock“ → rock 1, unbekanntes → [].
 * Ein Treffer des Genre-Namens als ganzer Name in GENRE_FAMILIE_KOEPFE gewinnt direkt (z. B. „Funk“ → soul).
 */
function genre_familien_von_name(string $name): array
{
    static $cache = [];
    if (isset($cache[$name])) {
        return $cache[$name];
    }
    $n = genre_roh_norm($name);
    foreach (GENRE_FAMILIE_KOEPFE as $f => $liste) {
        if (in_array($n, $liste, true)) {
            return $cache[$name] = [$f => 1.0];
        }
    }
    $treffer = [];
    foreach (GENRE_FAMILIE_MUSTER as $f => $muster) {
        if (preg_match('/(?<![\p{L}\p{N}])' . $muster . '(?![\p{L}\p{N}])/u', $n)) {
            $treffer[] = $f;
        }
    }
    // Punk/Metal/Indie mit „Pop“ davor (Pop Punk, Indie Pop): beide Familien, Rest gleich verteilt – bleibt so, wie es ist
    $erg = [];
    foreach ($treffer as $f) {
        $erg[$f] = 1.0 / count($treffer);
    }
    return $cache[$name] = $erg;
}

/** Familie, für die ein Genre-Name steht (Klick auf „Pop“, „Elektro“ …), sonst null */
function genre_familie_kopf(string $name): ?string
{
    $n = genre_roh_norm($name);
    foreach (GENRE_FAMILIE_KOEPFE as $f => $liste) {
        if (in_array($n, $liste, true)) {
            return $f;
        }
    }
    return null;
}

/** Familie zu einem Discogs-Stil wie „Electronic---Synth-pop“ (Teil vor „---“), sonst null */
function genre_discogs_familie(string $stil): ?string
{
    $haupt = mb_strtolower(trim(explode('---', $stil)[0]), 'UTF-8');
    return GENRE_DISCOGS_FAMILIE[$haupt] ?? null;
}

/** Stil-Anteile (Liste von [stil, wert]) → Familien-Anteile (Summe 1). Ein einzelner Stil ist unsicher (PR-AUC ≈ 0,2), die Familie robust. */
function genre_stile_zu_familien(array $stile): array
{
    $erg = [];
    $summe = 0.0;
    foreach ($stile as $s) {
        $wert = max(0.0, (float) ($s[1] ?? 0));
        $summe += $wert;
        if ($f = genre_discogs_familie((string) ($s[0] ?? ''))) {
            $erg[$f] = ($erg[$f] ?? 0.0) + $wert;
        }
    }
    if ($summe <= 0 || !$erg) {
        return [];
    }
    foreach ($erg as $f => $v) {
        $erg[$f] = $v / $summe;
    }
    arsort($erg);
    return $erg;
}

/** Gewichtete Familien aus einer Liste [genre-name => anteil] (Summe der Anteile beliebig); Ergebnis auf Summe 1 normiert */
function genre_anteile_zu_familien(array $genre_anteile): array
{
    $erg = [];
    foreach ($genre_anteile as $name => $anteil) {
        foreach (genre_familien_von_name((string) $name) as $f => $gew) {
            $erg[$f] = ($erg[$f] ?? 0.0) + $anteil * $gew;
        }
    }
    $summe = array_sum($erg);
    if ($summe <= 0) {
        return [];
    }
    foreach ($erg as $f => $v) {
        $erg[$f] = $v / $summe;
    }
    arsort($erg);
    return $erg;
}

/** Schwelle: ab diesem Anteil gehört ein Album/Titel zu einer Familie (GENRE_FAMILIE_SCHWELLE in Prozent, Standard 25) */
function genre_familie_schwelle(): float
{
    return max(0.05, min(0.9, (int) (konfig()['genres']['schwelle'] ?? 25) / 100));
}

/**
 * Familien je Album neu berechnen (album_familien). Je Album:
 *   Genre-Teil = eigene/manuelle Genres, sonst MusicBrainz (Anteile) und Tags gemischt (0,7 / 0,3)
 *   Klang-Teil = Mittel der Stil-Familien der Titel mit Stil-Erkennung; zählt bis zu 50 % (nach Anteil der Titel mit Klangdaten),
 *                bei Alben ganz ohne Genres 100 %
 * Gibt die Zahl der Alben mit Familien zurück.
 */
function genre_familien_neu_berechnen(): int
{
    $genres = db_alle('SELECT ag.album_id, ag.quelle, ag.anteil, g.name FROM album_genres ag JOIN genres g ON g.id = ag.genre_id');
    $je_album = [];
    foreach ($genres as $z) {
        $je_album[(int) $z['album_id']][(string) $z['quelle']][(string) $z['name']] = (float) $z['anteil'];
    }
    // Klang: je Album die Stil-Familien der Titel mitteln
    $klang = [];
    $abdeckung = [];
    if (db_wert("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'aufnahme_stile'")) {
        $stile = [];
        foreach (db_alle('SELECT aufnahme_id, stil, wert FROM aufnahme_stile ORDER BY aufnahme_id, rang') as $s) {
            $stile[(int) $s['aufnahme_id']][] = [(string) $s['stil'], (float) $s['wert']];
        }
        if ($stile) {
            $zeilen = db_alle('SELECT DISTINCT e.album_id AS album_id, t.aufnahme_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id
                JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id AND (e.id = a.anzeige_edition_id OR a.editionen_einzeln = 1)
                WHERE t.aufnahme_id IS NOT NULL');
            $gesamt = [];
            $summen = [];
            foreach ($zeilen as $z) {
                $al = (int) $z['album_id'];
                $gesamt[$al] = ($gesamt[$al] ?? 0) + 1;
                $fam = genre_stile_zu_familien($stile[(int) $z['aufnahme_id']] ?? []);
                if ($fam) {
                    $abdeckung[$al] = ($abdeckung[$al] ?? 0) + 1;
                    foreach ($fam as $f => $v) {
                        $summen[$al][$f] = ($summen[$al][$f] ?? 0.0) + $v;
                    }
                }
            }
            foreach ($summen as $al => $s) {
                $n = array_sum($s);
                $klang[$al] = array_map(static fn($v) => $v / $n, $s);
                $abdeckung[$al] = $abdeckung[$al] / max(1, $gesamt[$al]);
            }
        }
    }
    $ids = array_unique(array_merge(array_keys($je_album), array_keys($klang)));
    $neu = [];
    foreach ($ids as $al) {
        $q = $je_album[$al] ?? [];
        $genre = [];
        if (!empty($q['manuell'])) {
            $genre = genre_anteile_zu_familien($q['manuell']);
        } else {
            $mb = genre_anteile_zu_familien($q['musicbrainz'] ?? []);
            $tags = genre_anteile_zu_familien($q['tags'] ?? []);
            if ($mb && $tags) {
                foreach (array_unique(array_merge(array_keys($mb), array_keys($tags))) as $f) {
                    $genre[$f] = 0.7 * ($mb[$f] ?? 0) + 0.3 * ($tags[$f] ?? 0);
                }
            } else {
                $genre = $mb ?: $tags;
            }
        }
        $k = $klang[$al] ?? [];
        if ($k) {
            $gk = $genre ? 0.5 * ($abdeckung[$al] ?? 0) : 1.0;
            $erg = [];
            foreach (array_unique(array_merge(array_keys($genre), array_keys($k))) as $f) {
                $erg[$f] = (1 - $gk) * ($genre[$f] ?? 0) + $gk * ($k[$f] ?? 0);
            }
        } else {
            $erg = $genre;
        }
        foreach ($erg as $f => $v) {
            if ($v >= 0.05) {
                $neu[] = [$al, $f, round($v, 4)];
            }
        }
    }
    // Nichts geändert? Dann weder neu schreiben noch den Radio-Katalog verwerfen (der würde sonst bei jedem Lauf
    // über die ganze Bibliothek neu gebaut)
    $alt = db_alle('SELECT album_id, familie, wert FROM album_familien ORDER BY album_id, familie');
    $sortiert = $neu;
    usort($sortiert, static fn($a, $b) => [$a[0], $a[1]] <=> [$b[0], $b[1]]);
    if (md5(json_encode(array_map(static fn($z) => [(int) $z['album_id'], (string) $z['familie'], round((float) $z['wert'], 4)], $alt)))
        === md5(json_encode(array_map(static fn($z) => [(int) $z[0], (string) $z[1], (float) $z[2]], $sortiert)))) {
        return count($ids);
    }
    db()->beginTransaction();
    try {
        db()->exec('DELETE FROM album_familien');
        foreach (array_chunk($neu, 500) as $teil) {
            $platz = implode(',', array_fill(0, count($teil), '(?,?,?)'));
            $st = db()->prepare("INSERT INTO album_familien (album_id, familie, wert) VALUES {$platz}");
            $st->execute(array_merge(...$teil));
        }
        db()->commit();
    } catch (Throwable $e) {
        db()->rollBack();
        throw $e;
    }
    @unlink(konfig()['pfade']['cache'] . '/tmp/radio-katalog3.ser');
    return count($ids);
}
