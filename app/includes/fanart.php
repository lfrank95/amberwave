<?php
declare(strict_types=1);

require_once __DIR__ . '/i18n.php';
require_once __DIR__ . '/musicbrainz.php';
require_once __DIR__ . '/bilder.php';

/**
 * Künstlerbilder von fanart.tv (braucht einen kostenlosen Projekt-Schlüssel und die MusicBrainz-ID des Künstlers).
 * Künstler ohne MBID bekommen sie vorher über eine eindeutige MusicBrainz-Suche (gleicher Name, sonst nichts Gleichnamiges).
 * Von Hand hochgeladene Bilder werden nie ersetzt.
 */

function fanart_aktiv(): bool
{
    return einstellung('fanart_api_key') !== '';
}

/** MBID für einen Künstler ohne ID suchen – nur bei eindeutigem Treffer. */
function fanart_mbid_finden(array $k): ?string
{
    $treffer = mb_kuenstler_suchen((string) $k['name']);
    $gleich = array_values(array_filter($treffer, static fn($t) => name_norm($t['name']) === name_norm((string) $k['name']) && $t['score'] >= 90));
    if (count($gleich) !== 1) {
        return null; // keiner oder mehrere Gleichnamige: lieber nichts raten
    }
    $mbid = strtolower($gleich[0]['mbid']);
    if (db_wert('SELECT id FROM kuenstler WHERE mbid = :m AND id <> :id', ['m' => $mbid, 'id' => $k['id']])) {
        return null;
    }
    db_tun('UPDATE kuenstler SET mbid = :m WHERE id = :id AND mbid IS NULL', ['m' => $mbid, 'id' => $k['id']]);
    return $mbid;
}

/**
 * Bild für einen Künstler holen. $erzwingen: auch wenn schon ein fanart-Bild da ist bzw. kürzlich geprüft.
 * Liefert ['status' => ok|kein_bild|ohne_mbid|manuell|aus|fehler, 'meldung' => …, 'bild' => url|null]
 */
function fanart_bild_holen(int $kid, bool $erzwingen = false): array
{
    $r = fanart_bild_holen_intern($kid, $erzwingen);
    if ($r['status'] === 'fehler') {
        // vorübergehender Fehler (Netz, Schlüssel): beim nächsten Durchlauf wieder versuchen
        db_tun('UPDATE kuenstler SET bild_geprueft_am = NULL WHERE id = :id', ['id' => $kid]);
    }
    return $r;
}

function fanart_bild_holen_intern(int $kid, bool $erzwingen): array
{
    if (!fanart_aktiv()) {
        return ['status' => 'aus', 'meldung' => t('Kein fanart.tv-Schlüssel eingetragen (Verwaltung → Einstellungen).')];
    }
    $k = db_zeile('SELECT id, mbid, name, bild_datei, bild_quelle FROM kuenstler WHERE id = :id', ['id' => $kid]);
    if (!$k) {
        return ['status' => 'fehler', 'meldung' => t('Künstler nicht gefunden.')];
    }
    if ($k['bild_quelle'] === 'manuell' && !$erzwingen) {
        return ['status' => 'manuell', 'meldung' => t('Eigenes Bild bleibt.')];
    }
    db_tun('UPDATE kuenstler SET bild_geprueft_am = NOW(), aktualisiert_am = aktualisiert_am WHERE id = :id', ['id' => $kid]);
    $mbid = ist_uuid($k['mbid']) ? strtolower((string) $k['mbid']) : null;
    try {
        if (!$mbid) {
            $mbid = fanart_mbid_finden($k);
        }
        if (!$mbid) {
            return ['status' => 'ohne_mbid', 'meldung' => t('Keine eindeutige MusicBrainz-ID – Künstler zuerst mit MusicBrainz verknüpfen.')];
        }
        $url = rtrim(konfig()['quellen']['fanart_url'], '/') . '/music/' . $mbid . '?api_key=' . rawurlencode(einstellung('fanart_api_key'));
        $r = http_holen($url, ['Accept: application/json'], 20, 2 * 1024 * 1024);
        if ($r['status'] === 404) {
            return ['status' => 'kein_bild', 'meldung' => t('fanart.tv kennt keine Bilder zu diesem Künstler.')];
        }
        if ($r['status'] === 401 || $r['status'] === 403) {
            return ['status' => 'fehler', 'meldung' => t('fanart.tv lehnt den API-Schlüssel ab.')];
        }
        if ($r['status'] !== 200) {
            return ['status' => 'fehler', 'meldung' => t('fanart.tv antwortet mit Status {status}.', ['status' => $r['status']])];
        }
        $d = json_decode($r['body'], true);
        $bilder = is_array($d) ? ($d['artistthumb'] ?? []) : [];
        if (!$bilder) {
            return ['status' => 'kein_bild', 'meldung' => t('fanart.tv hat kein Künstlerbild (artistthumb).')];
        }
        usort($bilder, static fn($a, $b) => (int) ($b['likes'] ?? 0) <=> (int) ($a['likes'] ?? 0));
        foreach (array_slice($bilder, 0, 3) as $b) {
            $bild_url = (string) ($b['url'] ?? '');
            if (!preg_match('#^https?://#i', $bild_url)) {
                continue;
            }
            $bd = http_holen($bild_url, [], 30, 15 * 1024 * 1024);
            if ($bd['status'] !== 200) {
                continue;
            }
            $schluessel = bild_speichern('kuenstler', 'k' . $kid, $bd['body']);
            if (!$schluessel) {
                continue;
            }
            if ($k['bild_datei'] !== '' && $k['bild_datei'] !== $schluessel) {
                bild_loeschen('kuenstler', (string) $k['bild_datei']);
            }
            db_tun("UPDATE kuenstler SET bild_datei = :b, bild_quelle = 'fanart' WHERE id = :id", ['b' => $schluessel, 'id' => $kid]);
            return ['status' => 'ok', 'meldung' => t('Bild von fanart.tv übernommen.'), 'bild' => function_exists('bild_url') ? bild_url('kuenstler', $schluessel, 300) : null];
        }
        return ['status' => 'fehler', 'meldung' => t('Das Bild von fanart.tv konnte nicht geladen werden.')];
    } catch (MbFehler $e) {
        return ['status' => 'fehler', 'meldung' => $e->getMessage()];
    }
}

/** Künstler, die noch ein Bild brauchen (ohne Bild, nicht in den letzten 30 Tagen vergeblich geprüft). */
function fanart_offen_bedingung(): string
{
    return "k.bild_datei = '' AND (k.bild_geprueft_am IS NULL OR k.bild_geprueft_am < NOW() - INTERVAL 30 DAY)
        AND (EXISTS (SELECT 1 FROM credit_namen cn WHERE cn.kuenstler_id = k.id) OR EXISTS (SELECT 1 FROM beziehungen b WHERE b.von_art = 'kuenstler' AND b.von_id = k.id))
        AND k.name NOT IN ('[unbekannt]', 'Various Artists')";
}

/** Einen Schwung Künstler abarbeiten (Albumkünstler zuerst). Hält sich an $max_sekunden. */
function fanart_stapel(int $max = 25, float $max_sekunden = 20.0): array
{
    $start = microtime(true);
    $aus = ['geprueft' => 0, 'geholt' => 0, 'ohne_mbid' => 0, 'kein_bild' => 0, 'fehler' => 0, 'meldung' => ''];
    if (!fanart_aktiv()) {
        $aus['meldung'] = t('Kein fanart.tv-Schlüssel eingetragen.');
        $aus['rest'] = 0;
        return $aus;
    }
    $liste = db_alle('SELECT k.id FROM kuenstler k WHERE ' . fanart_offen_bedingung() . '
        ORDER BY EXISTS (SELECT 1 FROM credit_namen cn JOIN alben a ON a.credit_id = cn.credit_id WHERE cn.kuenstler_id = k.id) DESC, (k.mbid IS NULL), k.id LIMIT ' . $max);
    foreach ($liste as $z) {
        if (microtime(true) - $start > $max_sekunden) {
            break;
        }
        $r = fanart_bild_holen((int) $z['id']);
        $aus['geprueft']++;
        match ($r['status']) {
            'ok' => $aus['geholt']++,
            'ohne_mbid' => $aus['ohne_mbid']++,
            'kein_bild' => $aus['kein_bild']++,
            default => $aus['fehler']++,
        };
        if ($r['status'] === 'fehler') {
            $aus['meldung'] = $r['meldung'];
            if ($r['meldung'] === t('fanart.tv lehnt den API-Schlüssel ab.')) {
                break; // falscher Schlüssel: nicht weiter anfragen
            }
        }
    }
    $aus['rest'] = (int) db_wert('SELECT COUNT(*) FROM kuenstler k WHERE ' . fanart_offen_bedingung());
    return $aus;
}
