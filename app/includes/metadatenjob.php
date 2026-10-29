<?php
// „Metadaten vervollständigen“ als Hintergrundauftrag (Typ 'metadaten', Mechanik in auftrag.php). Drei Schritte in
// fester Reihenfolge, jeder baut auf dem vorigen auf:
//   1. Alben     – fehlende Angaben von MusicBrainz + Kennzeichnung „explizit“ (Deezer), nur verknüpfte Editionen
//   2. Künstler  – MusicBrainz-Daten (Typ, Land, Lebensdaten, Aliase, Bandmitglieder) für verknüpfte Künstler, die noch
//                  nie abgeglichen wurden (geschützte Felder bleiben, wie beim Künstler-Abgleich von Hand)
//   3. Bilder    – Künstlerbilder von fanart.tv (nur mit Schlüssel); braucht die MusicBrainz-IDs aus den Schritten davor
// Arten: 'alle'    = die ganze Sammlung (Alben nach Editions-ID, Künstler nach ID; Fortsetzen an derselben Stelle)
//        'auswahl' = bestimmte Alben samt ihrer Künstler (Sammelaktion in der Bibliothek, nach jedem Album-Abgleich)
declare(strict_types=1);
require_once __DIR__ . '/i18n.php';

require_once __DIR__ . '/auftrag.php';
require_once __DIR__ . '/fanart.php';

function mj_zustand(): array { return auftrag_zustand('metadaten'); }
function mj_anstossen(): bool { return auftrag_anstossen('metadaten'); }
function mj_anhalten(): array { return auftrag_anhalten('metadaten'); }
function mj_aussen(): array { return auftrag_aussen('metadaten'); }

/** Wie viele Editionen hat der Abgleich der ganzen Sammlung noch vor sich (ab Position)? */
function mj_alle_offen(int $pos): int
{
    $b = metadaten_luecke_bedingung();
    return (int) db_wert("SELECT COUNT(*) FROM editionen e JOIN alben a ON a.id = e.album_id WHERE {$b} AND e.id > :p", ['p' => $pos]);
}

/** Auftrag anlegen/fortsetzen. $art 'alle' (neu = von vorn) oder 'auswahl' mit Album-IDs (werden an eine laufende Auswahl angehängt). */
function mj_starten(string $art, array $ids = [], bool $neu = false, bool $auto = false): array
{
    $alt = mj_zustand();
    if ($alt['status'] === 'laeuft' && $alt['art'] !== $art) {
        throw new ApiFehler($alt['art'] === 'alle'
            ? t('Gerade läuft schon der Abgleich der ganzen Sammlung – der füllt die Lücken dieser Alben mit.')
            : t('Gerade werden noch ausgewählte Alben abgeglichen. Bitte kurz warten oder dort anhalten.'), 409);
    }
    if ($art === 'auswahl') {
        $laeuft = $alt['status'] === 'laeuft';
        $vorhanden = $laeuft ? array_map('intval', $alt['ids']) : [];
        $neuIds = array_values(array_diff(array_map('intval', $ids), $vorhanden));
        $setzen = ['art' => 'auswahl', 'ids' => array_values(array_merge($vorhanden, $neuIds)), 'gesamt' => ($laeuft ? $alt['gesamt'] : 0) + count($neuIds)];
        if (!$laeuft) {
            $setzen += ['phase' => 'alben', 'k_geprueft' => 0, 'k_geaendert' => 0, 'b_geprueft' => 0, 'b_geholt' => 0];
        }
        return auftrag_beginnen('metadaten', $setzen, $laeuft, $auto);
    }
    if ($neu) {
        einstellung_setzen('metadaten_abgleich_pos', '0');
    }
    $fortsetzen = !$neu && $alt['art'] === 'alle' && in_array($alt['status'], ['laeuft', 'angehalten'], true);
    $geprueft = $fortsetzen ? (int) $alt['geprueft'] : 0;
    $setzen = ['art' => 'alle', 'ids' => [], 'gesamt' => $geprueft + mj_alle_offen((int) einstellung('metadaten_abgleich_pos'))];
    if (!$fortsetzen) {
        $setzen += ['phase' => 'alben', 'k_pos' => 0, 'k_gesamt' => 0, 'k_geprueft' => 0, 'k_geaendert' => 0, 'b_gesamt' => 0, 'b_geprueft' => 0, 'b_geholt' => 0];
    }
    return auftrag_beginnen('metadaten', $setzen, $fortsetzen, $auto);
}

/** Ein Stapel der ganzen Sammlung (bis $budget Sekunden). Netzfehler stehen in 'meldung' + 'fehler' = 1. */
function mj_stapel_alle(float $budget): array
{
    $pos = (int) einstellung('metadaten_abgleich_pos');
    $start = microtime(true);
    $aus = ['geprueft' => 0, 'geaendert' => 0, 'felder' => 0, 'fehler' => 0, 'meldung' => ''];
    $b = metadaten_luecke_bedingung();
    $liste = db_alle("SELECT e.* FROM editionen e JOIN alben a ON a.id = e.album_id WHERE {$b} AND e.id > :p ORDER BY e.id LIMIT 15", ['p' => $pos]);
    foreach ($liste as $e) {
        if (microtime(true) - $start > $budget) {
            break;
        }
        try {
            $f = metadaten_luecken_fuellen($e);
            if ($f) {
                $aus['geaendert']++;
                $aus['felder'] += count($f);
            }
        } catch (Throwable $ex) {
            $aus['fehler'] = 1;
            $aus['meldung'] = $ex->getMessage(); // diese Edition wird beim nächsten Versuch erneut geholt
            break;
        }
        $pos = (int) $e['id'];
        $aus['geprueft']++;
    }
    $rest = (int) db_wert("SELECT COUNT(*) FROM editionen e JOIN alben a ON a.id = e.album_id WHERE {$b} AND e.id > :p", ['p' => $pos]);
    einstellung_setzen('metadaten_abgleich_pos', $rest > 0 ? (string) $pos : '0');
    return $aus + ['rest' => $rest];
}

function mj_meldung(array $z): string
{
    $g = (int) $z['geprueft'];
    $geprueft = $z['art'] === 'auswahl'
        ? tn($g, '{n} Album geprüft', '{n} Alben geprüft')
        : tn($g, '{n} Edition geprüft', '{n} Editionen geprüft');
    $teile = [t('{geprueft}, bei {geaendert} ergänzt ({felder})', [
        'geprueft' => $geprueft, 'geaendert' => $z['geaendert'], 'felder' => tn((int) $z['felder'], '{n} Angabe', '{n} Angaben')])
        . ($z['ohne_verknuepfung'] ? ', ' . t('{n} ohne MusicBrainz-Verknüpfung', ['n' => $z['ohne_verknuepfung']]) : '')];
    if ((int) ($z['k_geprueft'] ?? 0)) {
        $teile[] = t('Künstler: {n} abgeglichen', ['n' => $z['k_geaendert']]);
    }
    if ((int) ($z['b_geprueft'] ?? 0)) {
        $teile[] = t('Bilder: {n} geholt', ['n' => $z['b_geholt']]);
    }
    return t('Fertig: {teile}.', ['teile' => implode(' · ', $teile)]);
}

/** fanart.tv-Meldung zum fehlenden/falschen Schlüssel (deutscher oder englischer Wortlaut) */
function mj_schluessel_meldung(string $m): bool
{
    return str_contains($m, 'Schlüssel') || stripos($m, ' key') !== false;
}

/** Vorübergehende Störung (Netz, Dienst überlastet) → Pause und später an derselben Stelle weiter; sonst überspringen */
function mj_voruebergehend(Throwable $e): bool
{
    $m = $e->getMessage();
    // Meldungen kommen aus musicbrainz.php & Co. – deutscher und englischer Wortlaut
    foreach (['Keine Verbindung', 'antwortet gerade nicht', 'Unerwartete Antwort', 'No connection', 'not responding right now', 'Unexpected response'] as $n) {
        if (str_contains($m, $n)) {
            return true;
        }
    }
    return false;
}

/** Verknüpfte Künstler, die noch nie mit MusicBrainz abgeglichen wurden und in der Sammlung vorkommen */
function mj_kuenstler_bedingung(): string
{
    return "k.mbid IS NOT NULL AND k.mbid <> '' AND k.mb_abgleich_am IS NULL AND k.name NOT IN ('[unbekannt]', 'Various Artists')
        AND (k.mb_versuch_am IS NULL OR k.mb_versuch_am < NOW() - INTERVAL 30 DAY)
        AND (EXISTS (SELECT 1 FROM credit_namen cn WHERE cn.kuenstler_id = k.id) OR EXISTS (SELECT 1 FROM beziehungen b WHERE b.von_art = 'kuenstler' AND b.von_id = k.id))";
}

function mj_kuenstler_offen(): int
{
    return (int) db_wert('SELECT COUNT(*) FROM kuenstler k WHERE ' . mj_kuenstler_bedingung());
}

function mj_bilder_offen(): int
{
    return fanart_aktiv() ? (int) db_wert('SELECT COUNT(*) FROM kuenstler k WHERE ' . fanart_offen_bedingung()) : 0;
}

/** Künstler eines Albums: Album-, Editions- und Titelkünstler sowie Mitwirkende (Produzenten, Musiker …) */
function mj_album_kuenstler(int $albumId): array
{
    $editionen = array_map('intval', array_column(db_alle('SELECT id FROM editionen WHERE album_id = :a', ['a' => $albumId]), 'id'));
    if (!$editionen) {
        return [];
    }
    [$inE, $pE] = db_in($editionen, 'e');
    $tracks = db_alle("SELECT t.credit_id, t.aufnahme_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE m.edition_id IN {$inE}", $pE);
    $credits = array_merge(
        array_column(db_alle('SELECT credit_id FROM alben WHERE id = :a', ['a' => $albumId]), 'credit_id'),
        array_column(db_alle("SELECT credit_id FROM editionen WHERE id IN {$inE}", $pE), 'credit_id'),
        array_column($tracks, 'credit_id'));
    $credits = array_values(array_unique(array_filter(array_map('intval', $credits))));
    $ids = [];
    foreach (array_chunk($credits, 200) as $teil) {
        [$in, $p] = db_in($teil, 'c');
        foreach (db_alle("SELECT DISTINCT kuenstler_id FROM credit_namen WHERE credit_id IN {$in}", $p) as $z) $ids[] = (int) $z['kuenstler_id'];
    }
    foreach (db_alle("SELECT DISTINCT von_id FROM beziehungen WHERE von_art = 'kuenstler' AND zu_art = 'edition' AND zu_id IN {$inE}", $pE) as $z) $ids[] = (int) $z['von_id'];
    $aufnahmen = array_values(array_unique(array_filter(array_map('intval', array_column($tracks, 'aufnahme_id')))));
    foreach (array_chunk($aufnahmen, 200) as $teil) {
        [$in, $p] = db_in($teil, 'n');
        foreach (db_alle("SELECT DISTINCT von_id FROM beziehungen WHERE von_art = 'kuenstler' AND zu_art = 'aufnahme' AND zu_id IN {$in}", $p) as $z) $ids[] = (int) $z['von_id'];
    }
    return array_values(array_unique($ids));
}

/** Künstler mit MusicBrainz abgleichen und den Versuch vermerken (auch erfolglos). Wirft nur bei vorübergehenden Störungen. */
function mj_kuenstler_abgleichen(int $id): bool
{
    try {
        mb_kuenstler_uebernehmen($id, null);
        $ok = true;
    } catch (Throwable $e) {
        if (mj_voruebergehend($e)) throw $e;
        $ok = false;
    }
    db_tun('UPDATE kuenstler SET mb_versuch_am = NOW(), aktualisiert_am = aktualisiert_am WHERE id = :id', ['id' => $id]);
    return $ok;
}

/** Künstler abgleichen (nur nie abgeglichene mit MBID) und Bilder holen (nur ohne Bild). Liefert Zähler. Wirft bei Netzproblemen. */
function mj_kuenstler_und_bilder(array $ids): array
{
    $aus = ['k_geprueft' => 0, 'k_geaendert' => 0, 'b_geprueft' => 0, 'b_geholt' => 0];
    if (!$ids) {
        return $aus;
    }
    [$in, $p] = db_in($ids, 'k');
    foreach (db_alle('SELECT k.id FROM kuenstler k WHERE k.id IN ' . $in . ' AND ' . mj_kuenstler_bedingung(), $p) as $k) {
        $aus['k_geprueft']++;
        if (mj_kuenstler_abgleichen((int) $k['id'])) {
            $aus['k_geaendert']++;
        }
    }
    if (fanart_aktiv()) {
        foreach (db_alle('SELECT k.id FROM kuenstler k WHERE k.id IN ' . $in . ' AND ' . fanart_offen_bedingung(), $p) as $k) {
            $aus['b_geprueft']++;
            if ((fanart_bild_holen((int) $k['id'])['status'] ?? '') === 'ok') {
                $aus['b_geholt']++;
            }
        }
    }
    return $aus;
}

function auftrag_schritt_metadaten(array $z): array
{
    if ($z['art'] === 'auswahl') {
        $albumId = (int) ($z['ids'][0] ?? 0);
        if (!$albumId) {
            return ['fertig' => true, 'meldung' => mj_meldung($z)];
        }
        $editionen = db_alle("SELECT * FROM editionen WHERE album_id = :a AND mbid IS NOT NULL AND mbid <> ''", ['a' => $albumId]);
        $n = 0;
        foreach ($editionen as $e) {
            $n += count(metadaten_luecken_fuellen($e)); // Fehler → Pause, dieses Album wird danach erneut versucht
        }
        $kb = mj_kuenstler_und_bilder(mj_album_kuenstler($albumId));
        $ids = array_values(array_filter($z['ids'], static fn($i) => (int) $i !== $albumId));
        $zaehler = ['geprueft' => 1, 'ohne_verknuepfung' => $editionen ? 0 : 1, 'geaendert' => $n ? 1 : 0, 'felder' => $n] + $kb;
        $r = ['zaehler' => $zaehler, 'setzen' => ['ids' => $ids]];
        if (!$ids) {
            $fertig = $z;
            foreach ($zaehler as $k => $v) $fertig[$k] = (int) ($fertig[$k] ?? 0) + $v;
            $r += ['fertig' => true, 'meldung' => mj_meldung($fertig)];
        }
        return $r;
    }
    $phase = $z['phase'] ?? 'alben';
    // Schritt 1: Alben
    if ($phase === 'alben') {
        $s = mj_stapel_alle(25.0);
        $r = ['zaehler' => ['geprueft' => $s['geprueft'], 'geaendert' => $s['geaendert'], 'felder' => $s['felder']],
            'setzen' => ['gesamt' => max((int) $z['gesamt'], (int) $z['geprueft'] + $s['geprueft'] + $s['rest'])]];
        if ($s['fehler']) {
            return $r + ['fehler' => $s['meldung'] ?: t('MusicBrainz nicht erreichbar')];
        }
        if (!$s['rest'] || !$s['geprueft']) {
            $r['setzen'] += ['phase' => 'kuenstler', 'k_pos' => 0, 'k_gesamt' => mj_kuenstler_offen()];
        }
        return $r;
    }
    // Schritt 2: Künstler (nie abgeglichene, nach ID; bei Netzproblemen Pause an derselben Stelle)
    if ($phase === 'kuenstler') {
        $pos = (int) ($z['k_pos'] ?? 0);
        $start = microtime(true);
        $geprueft = 0;
        $ok = 0;
        $fehler = '';
        foreach (db_alle('SELECT k.id FROM kuenstler k WHERE ' . mj_kuenstler_bedingung() . ' AND k.id > :p ORDER BY k.id LIMIT 20', ['p' => $pos]) as $k) {
            if (microtime(true) - $start > 25) break;
            try {
                if (mj_kuenstler_abgleichen((int) $k['id'])) $ok++;
            } catch (Throwable $e) {
                $fehler = $e->getMessage();
                break;
            }
            $pos = (int) $k['id'];
            $geprueft++;
        }
        $rest = (int) db_wert('SELECT COUNT(*) FROM kuenstler k WHERE ' . mj_kuenstler_bedingung() . ' AND k.id > :p', ['p' => $pos]);
        $r = ['zaehler' => ['k_geprueft' => $geprueft, 'k_geaendert' => $ok], 'setzen' => ['k_pos' => $pos]];
        if ($fehler !== '') {
            return $r + ['fehler' => $fehler];
        }
        if (!$rest || !$geprueft) {
            $r['setzen'] += ['phase' => 'bilder', 'b_gesamt' => mj_bilder_offen()];
        }
        return $r;
    }
    // Schritt 3: Künstlerbilder (nur mit fanart.tv-Schlüssel)
    if (!fanart_aktiv()) {
        return ['fertig' => true, 'meldung' => mj_meldung($z)];
    }
    $f = fanart_stapel(25, 25.0);
    $r = ['zaehler' => ['b_geprueft' => $f['geprueft'], 'b_geholt' => $f['geholt']]];
    if (!$f['geprueft'] || !$f['rest'] || mj_schluessel_meldung((string) $f['meldung'])) {
        $fertig = $z;
        foreach ($r['zaehler'] as $k => $v) $fertig[$k] = (int) ($fertig[$k] ?? 0) + $v;
        $r += ['fertig' => true, 'meldung' => mj_meldung($fertig) . (mj_schluessel_meldung((string) $f['meldung']) ? ' ' . $f['meldung'] : '')];
    }
    return $r;
}
