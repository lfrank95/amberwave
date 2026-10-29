<?php
// Stand der Bibliothek: ein kurzer Fingerabdruck, der sich bei jeder Änderung an Alben, Editionen, Titeln, Künstlern, Genres
// oder beim Löschen ändert. Der Rückkanal (/fern/strom) schickt ihn an jede offene App; ändert er sich, holt die App die
// gerade sichtbare Seite und die Angaben der Titel im Player neu – ein frisch abgeglichenes Album erscheint so ohne Neuladen.
// Gerechnet wird höchstens alle BIB_STAND_SEKUNDEN für alle Kanäle zusammen (Datei im Cache), nicht je Kanal.
declare(strict_types=1);

const BIB_STAND_SEKUNDEN = 5.0;   // je Rechnung fünf COUNT über große Tabellen – bei 100.000 Titeln nicht alle 2 s

function bib_stand(): string
{
    $datei = konfig()['pfade']['cache'] . '/tmp/bib-stand.txt';
    $alt = @file_get_contents($datei);
    $zeit = @filemtime($datei);
    if ($alt !== false && $alt !== '' && $zeit !== false && microtime(true) - $zeit < BIB_STAND_SEKUNDEN) {
        return $alt;
    }
    $roh = (string) db_wert("SELECT CONCAT_WS('|',
        (SELECT MAX(aktualisiert_am) FROM alben), (SELECT MAX(aktualisiert_am) FROM editionen), (SELECT MAX(aktualisiert_am) FROM tracks),
        (SELECT MAX(aktualisiert_am) FROM aufnahmen), (SELECT MAX(aktualisiert_am) FROM kuenstler),
        (SELECT COUNT(*) FROM alben), (SELECT COUNT(*) FROM editionen), (SELECT COUNT(*) FROM tracks), (SELECT COUNT(*) FROM album_genres),
        (SELECT COALESCE(MAX(id), 0) FROM geloescht), (SELECT MAX(aktualisiert_am) FROM playlists), (SELECT COUNT(*) FROM playlist_eintraege))");
    $stand = substr(md5($roh), 0, 12);
    if (!is_dir(dirname($datei))) {
        @mkdir(dirname($datei), 0775, true);
    }
    if ($stand !== $alt) {
        @file_put_contents($datei . '.' . getmypid(), $stand);
        @rename($datei . '.' . getmypid(), $datei);
    } else {
        @touch($datei);
    }
    return $stand;
}

/**
 * POST /bibliothek/frisch {tracks: [ids]} – aktuelle Angaben (Titel, Künstler, Album, Cover) zu Titeln, z. B. für die
 * Warteschlange im Player nach einer Änderung. Fehlende IDs (gelöscht) stehen in „weg“.
 */
function api_bibliothek_frisch(array $user): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', (array) api_wert('tracks', [])), static fn($i) => $i > 0)));
    $ids = array_slice($ids, 0, 1500);
    $tracks = tracks_mit_album($ids, (int) $user['id']);
    $da = array_flip(array_column($tracks, 'id'));
    return ['stand' => bib_stand(), 'tracks' => $tracks, 'weg' => array_values(array_filter($ids, static fn($i) => !isset($da[$i])))];
}
