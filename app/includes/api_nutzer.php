<?php
declare(strict_types=1);
require_once __DIR__ . '/netz.php';
require_once __DIR__ . '/api_bibliothek.php';

function api_ich(): array
{
    $user = eingeloggter_user();
    if (!$user || !account_ist_gueltig($user)) {
        throw new ApiFehler(t('Nicht angemeldet.'), 401, ['login' => true]);
    }
    $offen = 0;
    if (ist_admin($user)) {
        $offen = (int) db_wert("SELECT COUNT(*) FROM users WHERE status = 'pending'");
    }
    return [
        'user' => [
            'id' => (int) $user['id'], 'vorname' => $user['vorname'], 'nachname' => $user['nachname'], 'name' => voller_name($user),
            'benutzername' => $user['benutzername'], 'email' => $user['email'], 'rolle' => $user['rolle'],
            'gueltig_bis' => iso($user['gueltig_bis']), 'muss_passwort_aendern' => (bool) $user['muss_passwort_aendern'],
            'bild' => bild_url('profil', ($user['bild'] ?? '') ?: null, 300), 'sprache' => (string) ($user['sprache'] ?? ''),
        ],
        // Name dieses Geräts (eigener oder erkannter) – fürs Benutzermenü
        'geraet_name' => (function () {
            $id = aktuelles_geraet_id();
            $g = $id ? db_zeile('SELECT name, eigener_name FROM nutzer_geraete WHERE id = :id', ['id' => $id]) : null;
            return $g ? (($g['eigener_name'] ?? '') !== '' ? $g['eigener_name'] : $g['name']) : null;
        })(),
        'csrf' => session_status() === PHP_SESSION_ACTIVE ? csrf_token() : null,
        'geraet_id' => aktuelles_geraet_id(),
        'netz' => netz_info(),
        // Direktzugang im Heimnetz: Adresse + Stream-Schlüssel (die App prüft selbst, ob die Adresse antwortet)
        'direkt' => (function () use ($user) {
            require_once __DIR__ . '/direktzugang.php';
            $url = direkt_url();
            return $url === '' ? null : ['url' => $url] + direkt_token($user);
        })(),
        'app' => [
            'name' => app_name(), 'version' => app_version(), 'image' => getenv('AMBERWAVE_IMAGE') === '1', 'gebuendelt' => buendel() !== null,   // Oberfläche aus js/_b (schneller Start) oder einzelne Module
            'stream_standard' => konfig()['stream']['standard'],
            'offline' => in_array(konfig()['stream']['offline'], ['opus128', 'opus160', 'opus256'], true) ? konfig()['stream']['offline'] : null,
            'downloads' => konfig()['stream']['downloads_erlaubt'] || ist_admin($user),
            'gehoert_ab_prozent' => konfig()['stream']['gehoert_ab_prozent'], 'gehoert_ab_sekunden' => konfig()['stream']['gehoert_ab_sekunden'],
            // Klangradio verfügbar, sobald es einen Index der akustisch ähnlichen Titel gibt
            'klang' => (int) (json_decode((string) einstellung('klang_index'), true)['anzahl'] ?? 0) > 1,
        ],
        'admin' => ist_admin($user) ? ['wartende_konten' => $offen] + dl_menue_stand() : null,
    ];
}

/** App-Anmeldung: Name + Passwort -> Geräte-Schlüssel (für den späteren Windows-Player und andere Apps). */
function api_token_anmelden(): array
{
    $r = anmeldung_pruefen((string) api_wert('benutzername', ''), (string) api_wert('passwort', ''));
    if (!isset($r['user'])) {
        throw new ApiFehler($r['fehler'], isset($r['sperre']) ? 429 : 401);
    }
    if (!empty($r['user']['muss_passwort_aendern'])) {
        throw new ApiFehler(t('Bitte zuerst im Browser ein eigenes Passwort festlegen.'), 403, ['passwort_aendern' => true]);
    }
    [$token, $geraet] = api_token_erstellen($r['user'], (string) api_wert('geraet_name', 'App'));
    log_sicherheitsereignis((int) $r['user']['id'], 'app_anmeldung', 'Gerät #' . $geraet);
    return ['ok' => true, 'token' => $token, 'geraet_id' => $geraet, 'user_id' => (int) $r['user']['id']];
}

function api_favorit_setzen(array $user): array
{
    $art = (string) api_wert('art', '');
    $id = (int) api_wert('id', 0);
    $an = (bool) api_wert('an', true);
    if (!in_array($art, ['album', 'kuenstler', 'track', 'playlist'], true) || $id < 1) {
        throw new ApiFehler(t('Ungültige Angaben.'));
    }
    if ($an) {
        db_tun('INSERT IGNORE INTO favoriten (user_id, art, objekt_id) VALUES (:u, :a, :i)', ['u' => $user['id'], 'a' => $art, 'i' => $id]);
    } else {
        db_tun('DELETE FROM favoriten WHERE user_id = :u AND art = :a AND objekt_id = :i', ['u' => $user['id'], 'a' => $art, 'i' => $id]);
    }
    return ['ok' => true, 'an' => $an];
}

function api_favoriten(array $user): array
{
    $uid = (int) $user['id'];
    $alben = db_alle('SELECT ' . ALBUM_SPALTEN . " FROM favoriten f JOIN alben a ON a.id = f.objekt_id JOIN editionen e ON e.id = a.anzeige_edition_id
        WHERE f.user_id = :u AND f.art = 'album' AND e.anzahl_dateien > 0 ORDER BY f.erstellt_am DESC", ['u' => $uid]);
    $kuenstler = db_alle("SELECT k.id, k.name, k.bild_datei FROM favoriten f JOIN kuenstler k ON k.id = f.objekt_id WHERE f.user_id = :u AND f.art = 'kuenstler' ORDER BY k.sortname", ['u' => $uid]);
    $tracks = db_alle("SELECT t.id FROM favoriten f JOIN tracks t ON t.id = f.objekt_id WHERE f.user_id = :u AND f.art = 'track' ORDER BY f.erstellt_am DESC LIMIT 500", ['u' => $uid]);
    return [
        'alben' => album_items($alben, $uid),
        'kuenstler' => array_map(static fn($z) => ['id' => (int) $z['id'], 'name' => $z['name'], 'bild' => bild_url('kuenstler', $z['bild_datei'], 300)], $kuenstler),
        'tracks' => tracks_mit_album(array_map('intval', array_column($tracks, 'id')), $uid),
    ];
}

/** Tracks (beliebige Editionen) mit Album- und Cover-Angaben, in der übergebenen Reihenfolge. */
function tracks_mit_album(array $ids, int $userId): array
{
    if (!$ids) {
        return [];
    }
    [$in, $p] = db_in($ids, 'tr');
    $zeilen = db_alle("SELECT t.id, t.titel, t.credit_id, t.laenge_ms, t.explizit, t.pos, m.pos AS disc, e.id AS edition_id, e.cover_datei, a.id AS album_id, a.titel AS album_titel,
            (SELECT COUNT(*) FROM dateien d WHERE d.track_id = t.id) AS dateien
        FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id JOIN editionen e ON e.id = m.edition_id JOIN alben a ON a.id = e.album_id WHERE t.id IN {$in}", $p);
    $credits = credit_listen(array_column($zeilen, 'credit_id'));
    $p['u'] = $userId;
    $fav = array_flip(array_map('intval', array_column(db_alle("SELECT objekt_id FROM favoriten WHERE user_id = :u AND art = 'track' AND objekt_id IN {$in}", $p), 'objekt_id')));
    $nach = [];
    foreach ($zeilen as $z) {
        $nach[(int) $z['id']] = [
            'id' => (int) $z['id'], 'titel' => $z['titel'], 'kuenstler' => $credits[(int) $z['credit_id']] ?? [], 'laenge_ms' => (int) $z['laenge_ms'],
            'disc' => (int) $z['disc'], 'nr' => (int) $z['pos'], 'verfuegbar' => (int) $z['dateien'] > 0, 'favorit' => isset($fav[(int) $z['id']]), 'explizit' => $z['explizit'] !== null ? (int) $z['explizit'] : null,
            'album' => ['id' => (int) $z['album_id'], 'titel' => $z['album_titel'], 'edition_id' => (int) $z['edition_id'], 'cover' => bild_url('cover', $z['cover_datei'], 300)],
        ];
    }
    $aus = [];
    foreach ($ids as $id) {
        if (isset($nach[$id])) {
            $aus[] = $nach[$id];
        }
    }
    return $aus;
}

/**
 * Wiedergabe melden. ereignis: start | fortschritt | ende
 * Zählt als "gehört" ab GEHOERT_AB_PROZENT der Länge oder GEHOERT_AB_SEKUNDEN.
 */
function api_wiedergabe(array $user): array
{
    $track = (int) api_wert('track_id', 0);
    $sek = max(0, (int) api_wert('sekunden', 0));
    $position = max(0, (int) api_wert('position', $sek));
    $ereignis = (string) api_wert('ereignis', 'fortschritt');
    $wid = (int) api_wert('wiedergabe_id', 0);
    $t = db_zeile('SELECT t.id, t.laenge_ms, m.edition_id FROM tracks t JOIN datentraeger m ON m.id = t.datentraeger_id WHERE t.id = :t', ['t' => $track]);
    if (!$t) {
        throw new ApiFehler(t('Titel nicht gefunden.'), 404);
    }
    $uid = (int) $user['id'];
    $quelle = preg_replace('/[^a-z]/', '', (string) api_wert('quelle', '')) ?: '';
    // Offline gehört und später nachgemeldet: „zeit“ = Beginn (Unix-Millisekunden, höchstens 60 Tage zurück)
    $zeit = (int) api_wert('zeit', 0);
    $nachgemeldet = $zeit > 0 && $zeit < (time() - 60) * 1000 && $zeit > (time() - 60 * 86400) * 1000;
    if ($nachgemeldet && !$wid) {
        // Nachgereicht: dieselbe Wiedergabe (Nutzer, Titel, Beginn) nicht doppelt anlegen, falls die Antwort beim ersten Mal verloren ging
        $wid = (int) db_wert('SELECT id FROM wiedergaben WHERE user_id = :u AND track_id = :t AND gestartet_am = FROM_UNIXTIME(:z) ORDER BY id DESC LIMIT 1',
            ['u' => $uid, 't' => $track, 'z' => intdiv($zeit, 1000)]);
    }
    if ($ereignis === 'start' || !$wid) {
        $wid = db_einfuegen('INSERT INTO wiedergaben (user_id, track_id, edition_id, geraet_id, quelle' . ($nachgemeldet ? ', gestartet_am' : '') . ') VALUES (:u, :t, :e, :g, :q' . ($nachgemeldet ? ', FROM_UNIXTIME(:z)' : '') . ')',
            ['u' => $uid, 't' => $track, 'e' => $t['edition_id'], 'g' => aktuelles_geraet_id(), 'q' => mb_substr($quelle, 0, 20)] + ($nachgemeldet ? ['z' => intdiv($zeit, 1000)] : []));
    }
    // Übersprungen (von Hand weiter, bevor der Titel zu Ende war) – wichtigstes Gegen-Signal fürs Radio
    if ($ereignis === 'ueberspringen') {
        db_tun('UPDATE wiedergaben SET uebersprungen = 1 WHERE id = :id AND user_id = :u', ['id' => $wid, 'u' => $uid]);
    }
    $s = konfig()['stream'];
    $laenge = max(1, (int) $t['laenge_ms'] / 1000);
    $gezaehlt = $sek >= $s['gehoert_ab_sekunden'] || $sek >= $laenge * $s['gehoert_ab_prozent'] / 100 ? 1 : 0;
    db_tun('UPDATE wiedergaben SET gehoert_sekunden = GREATEST(gehoert_sekunden, :s), gezaehlt = GREATEST(gezaehlt, :g) WHERE id = :id AND user_id = :u',
        ['s' => $sek, 'g' => $gezaehlt, 'id' => $wid, 'u' => $uid]);
    if ($nachgemeldet) {
        return ['ok' => true, 'wiedergabe_id' => $wid, 'gezaehlt' => (bool) $gezaehlt];
    }
    db_tun('INSERT INTO weiterhoeren (user_id, edition_id, track_id, position_sek) VALUES (:u, :e, :t, :p)
            ON DUPLICATE KEY UPDATE track_id = VALUES(track_id), position_sek = VALUES(position_sek), aktualisiert_am = NOW()',
        ['u' => $uid, 'e' => $t['edition_id'], 't' => $track, 'p' => $ereignis === 'ende' ? 0 : $position]);
    return ['ok' => true, 'wiedergabe_id' => $wid, 'gezaehlt' => (bool) $gezaehlt];
}

function api_verlauf(array $user): array
{
    $z = db_alle('SELECT w.track_id, MAX(w.gestartet_am) AS zuletzt FROM wiedergaben w WHERE w.user_id = :u GROUP BY w.track_id ORDER BY zuletzt DESC LIMIT 200', ['u' => $user['id']]);
    $tracks = tracks_mit_album(array_map('intval', array_column($z, 'track_id')), (int) $user['id']);
    $zeit = array_column($z, 'zuletzt', 'track_id');
    foreach ($tracks as &$t) {
        $t['zuletzt'] = iso($zeit[$t['id']] ?? null);
    }
    unset($t);
    return ['tracks' => $tracks];
}

// ---------- Playlists ----------

function playlist_laden(array $user, int $id, bool $schreiben = false): array
{
    $p = db_zeile('SELECT p.*, u.vorname, u.nachname FROM playlists p JOIN users u ON u.id = p.user_id WHERE p.id = :id', ['id' => $id]);
    if (!$p || ((int) $p['user_id'] !== (int) $user['id'] && (!$p['familie'] || $schreiben) && !($schreiben && ist_admin($user) && $p['familie']))) {
        throw new ApiFehler(t('Playlist nicht gefunden.'), 404);
    }
    return $p;
}

function playlist_objekt(array $p, array $user, bool $mit_tracks): array
{
    $n = db_zeile('SELECT COUNT(*) AS n, COALESCE(SUM(t.laenge_ms), 0) AS l FROM playlist_eintraege pe JOIN tracks t ON t.id = pe.track_id WHERE pe.playlist_id = :p', ['p' => $p['id']]);
    $cover = array_column(db_alle('SELECT DISTINCT e.cover_datei FROM playlist_eintraege pe JOIN tracks t ON t.id = pe.track_id JOIN datentraeger m ON m.id = t.datentraeger_id
        JOIN editionen e ON e.id = m.edition_id WHERE pe.playlist_id = :p AND e.cover_datei <> \'\' ORDER BY pe.pos LIMIT 4', ['p' => $p['id']]), 'cover_datei');
    $aus = [
        'id' => (int) $p['id'], 'name' => $p['name'], 'beschreibung' => $p['beschreibung'], 'familie' => (bool) $p['familie'],
        'eigene' => (int) $p['user_id'] === (int) $user['id'], 'besitzer' => trim(($p['vorname'] ?? '') . ' ' . ($p['nachname'] ?? '')),
        'anzahl' => (int) ($n['n'] ?? 0), 'laenge_ms' => (int) ($n['l'] ?? 0),
        'cover' => array_map(static fn($c) => bild_url('cover', $c, 300), $cover), 'aktualisiert' => iso($p['aktualisiert_am']),
    ];
    if ($mit_tracks) {
        $eintraege = db_alle('SELECT id, track_id FROM playlist_eintraege WHERE playlist_id = :p ORDER BY pos, id', ['p' => $p['id']]);
        $tracks = tracks_mit_album(array_map('intval', array_column($eintraege, 'track_id')), (int) $user['id']);
        $nach = [];
        foreach ($tracks as $t) {
            $nach[$t['id']] = $t;
        }
        $aus['eintraege'] = [];
        foreach ($eintraege as $e) {
            if (isset($nach[(int) $e['track_id']])) {
                $aus['eintraege'][] = ['eintrag_id' => (int) $e['id']] + $nach[(int) $e['track_id']];
            }
        }
    }
    return $aus;
}

function api_playlists(array $user): array
{
    $liste = db_alle('SELECT p.*, u.vorname, u.nachname FROM playlists p JOIN users u ON u.id = p.user_id WHERE p.user_id = :u OR p.familie = 1 ORDER BY p.aktualisiert_am DESC', ['u' => $user['id']]);
    return ['playlists' => array_map(static fn($p) => playlist_objekt($p, $user, false), $liste)];
}

function api_playlist_anlegen(array $user): array
{
    $name = trim((string) api_wert('name', ''));
    if ($name === '') {
        throw new ApiFehler(t('Bitte einen Namen angeben.'));
    }
    if (!rate_erlaubt('playlist_neu', (string) $user['id'], 60, 3600)) {
        throw new ApiFehler(t('Zu viele neue Playlists in kurzer Zeit.'), 429);
    }
    $id = db_einfuegen('INSERT INTO playlists (user_id, name, beschreibung, familie) VALUES (:u, :n, :b, :f)',
        ['u' => $user['id'], 'n' => mb_substr($name, 0, 200), 'b' => mb_substr((string) api_wert('beschreibung', ''), 0, 5000), 'f' => api_wert('familie') ? 1 : 0]);
    $ids = array_map('intval', (array) api_wert('track_ids', []));
    if ($ids) {
        playlist_tracks_hinzu($id, $ids);
    }
    return playlist_objekt(playlist_laden($user, $id), $user, true);
}

function playlist_tracks_hinzu(int $playlistId, array $ids): int
{
    $ids = array_slice(array_values(array_filter($ids, static fn($i) => $i > 0)), 0, 2000);
    if (!$ids) {
        return 0;
    }
    [$in, $p] = db_in($ids, 'tr');
    $gueltig = array_flip(array_map('intval', array_column(db_alle("SELECT id FROM tracks WHERE id IN {$in}", $p), 'id')));
    $pos = (int) db_wert('SELECT COALESCE(MAX(pos), 0) FROM playlist_eintraege WHERE playlist_id = :p', ['p' => $playlistId]);
    $n = 0;
    foreach ($ids as $id) {
        if (isset($gueltig[$id])) {
            db_tun('INSERT INTO playlist_eintraege (playlist_id, track_id, pos) VALUES (:p, :t, :o)', ['p' => $playlistId, 't' => $id, 'o' => ++$pos]);
            $n++;
        }
    }
    db_tun('UPDATE playlists SET aktualisiert_am = NOW() WHERE id = :p', ['p' => $playlistId]);
    return $n;
}

function api_playlist_aendern(array $user, int $id): array
{
    $p = playlist_laden($user, $id, true);
    if ((int) $p['user_id'] !== (int) $user['id']) {
        throw new ApiFehler(t('Nur die eigene Playlist kann umbenannt werden.'), 403);
    }
    $name = trim((string) api_wert('name', $p['name']));
    db_tun('UPDATE playlists SET name = :n, beschreibung = :b, familie = :f WHERE id = :id', [
        'n' => mb_substr($name !== '' ? $name : $p['name'], 0, 200), 'b' => mb_substr((string) api_wert('beschreibung', (string) $p['beschreibung']), 0, 5000),
        'f' => api_wert('familie', (bool) $p['familie']) ? 1 : 0, 'id' => $id,
    ]);
    if (is_array(api_wert('reihenfolge'))) {
        foreach (array_values(api_wert('reihenfolge')) as $i => $eintrag) {
            db_tun('UPDATE playlist_eintraege SET pos = :p WHERE id = :e AND playlist_id = :pl', ['p' => $i + 1, 'e' => (int) $eintrag, 'pl' => $id]);
        }
    }
    return playlist_objekt(playlist_laden($user, $id), $user, true);
}

// ---------- Profil ----------

function api_profil(array $user): array
{
    $geraete = array_map(static fn($g) => [
        'id' => (int) $g['id'], 'art' => $g['art'], 'name' => ($g['eigener_name'] ?? '') !== '' ? $g['eigener_name'] : $g['name'],
        'erkannt' => $g['name'], 'eigener_name' => (string) ($g['eigener_name'] ?? ''), 'zuletzt' => iso($g['zuletzt_am']), 'seit' => iso($g['erstellt_am']),
        'dieses' => (int) $g['id'] === (int) aktuelles_geraet_id(),
    ], geraete_aktive((int) $user['id']));
    $stat = db_zeile('SELECT COUNT(*) AS n, COALESCE(SUM(gehoert_sekunden), 0) AS s FROM wiedergaben WHERE user_id = :u AND gezaehlt = 1', ['u' => $user['id']]);
    return [
        'vorname' => $user['vorname'], 'nachname' => $user['nachname'], 'benutzername' => $user['benutzername'], 'email' => $user['email'],
        'rolle' => $user['rolle'], 'gueltig_bis' => iso($user['gueltig_bis']), 'aktiviert_am' => iso($user['aktiviert_am']),
        'mail_info' => (bool) $user['mail_info'], 'sprache' => (string) ($user['sprache'] ?? ''), 'geraete' => $geraete, 'max_geraete' => geraete_max($user),
        'bild' => bild_url('profil', ($user['bild'] ?? '') ?: null, 300),
        'statistik' => ['gehoert' => (int) ($stat['n'] ?? 0), 'stunden' => round((int) ($stat['s'] ?? 0) / 3600, 1)],
    ];
}

function api_passwort_aendern(array $user): array
{
    $alt = (string) api_wert('alt', '');
    $neu = (string) api_wert('neu', '');
    if (!rate_erlaubt('passwort_aendern', (string) $user['id'], 10, 3600)) {
        throw new ApiFehler(t('Zu viele Versuche. Bitte später erneut versuchen.'), 429);
    }
    if (!password_verify($alt, (string) $user['passwort_hash'])) {
        throw new ApiFehler(t('Das bisherige Passwort stimmt nicht.'));
    }
    if (($s = passwort_ist_zu_schwach($neu)) !== null) {
        throw new ApiFehler($s);
    }
    db_tun('UPDATE users SET passwort_hash = :p WHERE id = :id', ['p' => passwort_hashen($neu), 'id' => $user['id']]);
    // Andere Geräte abmelden, dieses bleibt angemeldet
    db_tun('DELETE FROM remember_tokens WHERE user_id = :u', ['u' => $user['id']]);
    foreach (geraete_aktive((int) $user['id']) as $g) {
        if ((int) $g['id'] !== (int) aktuelles_geraet_id()) {
            geraet_beenden((int) $user['id'], (int) $g['id']);
        }
    }
    log_sicherheitsereignis((int) $user['id'], 'passwort_geaendert');
    return ['ok' => true];
}

/** Einstellungen dieses Geräts (Streaming-Qualität; später Ausgabeprofile, Upmix … des Windows-Players). */
function api_geraet_einstellungen_lesen(array $user): array
{
    $g = aktuelles_geraet_id();
    if (!$g) {
        return ['einstellungen' => new stdClass()];
    }
    $aus = [];
    foreach (db_alle('SELECT schluessel, wert FROM geraet_einstellungen WHERE geraet_id = :g', ['g' => $g]) as $z) {
        $aus[$z['schluessel']] = json_decode((string) $z['wert'], true);
    }
    return ['einstellungen' => $aus ?: new stdClass()];
}

function api_geraet_einstellungen_schreiben(array $user): array
{
    $g = aktuelles_geraet_id();
    if (!$g) {
        throw new ApiFehler(t('Kein Gerät erkannt.'));
    }
    $werte = api_wert('einstellungen', []);
    if (!is_array($werte) || count($werte) > 50) {
        throw new ApiFehler(t('Ungültige Einstellungen.'));
    }
    foreach ($werte as $k => $w) {
        if (!preg_match('/^[a-z0-9_.-]{1,60}$/', (string) $k)) {
            continue;
        }
        $json = json_encode($w, JSON_UNESCAPED_UNICODE);
        if ($json === false || strlen($json) > 200000) {
            continue;
        }
        db_tun('INSERT INTO geraet_einstellungen (geraet_id, schluessel, wert) VALUES (:g, :k, :w) ON DUPLICATE KEY UPDATE wert = VALUES(wert)', ['g' => $g, 'k' => $k, 'w' => $json]);
    }
    return api_geraet_einstellungen_lesen($user);
}

function api_warteschlange_lesen(array $user): array
{
    $g = aktuelles_geraet_id();
    $z = $g ? db_zeile('SELECT inhalt, aktualisiert_am FROM warteschlangen WHERE geraet_id = :g AND user_id = :u', ['g' => $g, 'u' => $user['id']]) : null;
    $inhalt = $z ? (json_decode((string) $z['inhalt'], true) ?: []) : [];
    $ids = array_map('intval', $inhalt['track_ids'] ?? []);
    return ['track_ids' => $ids, 'index' => (int) ($inhalt['index'] ?? 0), 'position' => (float) ($inhalt['position'] ?? 0),
        'tracks' => tracks_mit_album(array_slice($ids, 0, 1000), (int) $user['id']), 'aktualisiert' => $z ? iso($z['aktualisiert_am']) : null];
}

function api_warteschlange_schreiben(array $user): array
{
    $g = aktuelles_geraet_id();
    if (!$g) {
        throw new ApiFehler(t('Kein Gerät erkannt.'));
    }
    $ids = array_slice(array_map('intval', (array) api_wert('track_ids', [])), 0, 1000);
    $inhalt = json_encode(['track_ids' => $ids, 'index' => (int) api_wert('index', 0), 'position' => (float) api_wert('position', 0)]);
    db_tun('INSERT INTO warteschlangen (geraet_id, user_id, inhalt) VALUES (:g, :u, :i) ON DUPLICATE KEY UPDATE inhalt = VALUES(inhalt), user_id = VALUES(user_id)',
        ['g' => $g, 'u' => $user['id'], 'i' => $inhalt]);
    return ['ok' => true];
}

/** Ist das Gerät gerade zuhause? (Für die automatische Qualität; wird bei Netzwechsel erneut abgefragt.) */
function api_netz(): array
{
    return netz_info();
}

/** Für das Hauptmenü (Admins): Downloads als eigener Punkt? Und wie viele laufen gerade (Zahl am Punkt) */
function dl_menue_stand(): array
{
    $usenet = einstellung('usenet_aktiv') === '1';
    $an = $usenet && einstellung('download_reiter') === '1';
    $n = 0;
    if ($an) {
        try {
            $n = (int) db_wert("SELECT COUNT(*) FROM downloads WHERE status IN ('gesendet', 'laeuft', 'fertig')");
        } catch (Throwable $e) {
            $n = 0;
        }
    }
    return ['download_reiter' => $an, 'downloads_laufen' => $n, 'usenet' => $usenet, 'musik_schreiben' => einstellung('musik_schreiben') === '1'];
}
