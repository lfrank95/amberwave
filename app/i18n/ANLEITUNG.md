# Übersetzung (Deutsch → Englisch)

Der **deutsche Text ist der Schlüssel**. Der Quelltext bleibt lesbar, Fehlendes fällt auf Deutsch zurück.

## Aufrufe
| | PHP (`includes/i18n.php`) | JS (`import { t, tn, zahl, locale, sprache } from './i18n.js'`) |
|---|---|---|
| Text | `t('Titel speichern')` | `t('Titel speichern')` |
| Platzhalter | `t('{n} Titel in {name}', ['n' => 3, 'name' => $x])` | `t('{n} Titel in {name}', { n: 3, name: x })` |
| Mehrzahl | `tn($n, 'ein Titel', '{n} Titel')` | `tn(n, 'ein Titel', '{n} Titel')` (`{n}` ist automatisch gesetzt, sprachrichtig formatiert) |
| Zahl | `zahl_fmt($v, 1)` | `zahl(v, 1)` |
| Gebietsschema | `sprache_locale()` | `locale` (statt festem `'de-DE'`) |
| Sprache | `sprache()` → `'de'`/`'en'` | `sprache` |

Wörterbuch: je Quelldatei-Gruppe eine Datei `i18n/quelle/<gruppe>.json` mit `{"deutscher Text": "English text"}`.
Zusammenbauen: `python3 scripts/i18n_bauen.py`, prüfen: `python3 scripts/i18n_pruefen.py <Dateien>` (zeigt fehlende Einträge).
Die Schlüssel müssen **Zeichen für Zeichen** dem Text im Aufruf entsprechen (nach Auflösen der Escapes, `\'` → `'`).

## Regeln
- Nur **sichtbare Texte** (Oberfläche, Meldungen, Tooltips, `aria-label`, `title`, `placeholder`, `alt`, E-Mail- und Fehlertexte der API).
- **Nicht** übersetzen: Code-Bezeichner, Schlüssel, CSS-Klassen, URLs, Enum-/Datenbankwerte, Log-Zeilen und Kommentare für Entwickler,
  Texte, die mit Servermeldungen oder gespeicherten Werten per Gleichheit verglichen werden (erst prüfen, ob ein Vergleich daran hängt!),
  Nachrichten an die Engine, Dateipfade, Eigennamen (Amberwave, FLAC, MusicBrainz …).
- Texte stets ganz übersetzen, nicht in Wortteile zerlegen. HTML-Tags aus dem Schlüssel heraushalten, wo es geht
  (`<b>${t('Achtung')}</b>`); bei Sätzen mit Link/Fettdruck mittendrin darf das HTML im Schlüssel stehen. Interpolationen `${x}` → `{x}`-Platzhalter.
- Texte, die aus **mehreren Teilen zusammengesetzt** werden („Anzahl“ + „ Titel“), zu einem Satz mit Platzhalter machen – Englisch hat andere Wortstellung.
- `toLocaleString('de-DE')`, `Intl…('de-DE')`, `toFixed()` + Komma-Ersetzung u. Ä. durch `locale`/`zahl()` ersetzen. Datumsformate `dd.mm.yyyy` entsprechend.
- Von Server **gespeicherte** deutsche Texte (in Datenbank-Zeilen) nicht anfassen, aber im Abschlussbericht nennen.
- Neue Zeichenketten gleich beim Anfassen mit `t()` versehen. Nichts Funktionales ändern.

## Englisch – Stil
Natürliches, knappes Produkt-Englisch (britisch: „colour“ nur wo nötig, aber „Settings“, „Sign in“, „Playlist“). Kein Wort-für-Wort.
Tonfall: freundlich, direkt; Du-Form → neutral/„you“. Knöpfe: Verb zuerst („Save“, „Add to queue“). Kurze Meldungen ohne Schlusspunkt,
vollständige Sätze mit Punkt wie im Deutschen. Großschreibung: UI-Beschriftungen „Sentence case“.

### Glossar (verbindlich)
Titel (Lied) = track · Interpret/Künstler = artist · Album = album · Wiedergabeliste = playlist · Warteschlange = queue · Bibliothek = library ·
Sammlung = collection · Einlesen/Scan = scan · Metadaten = metadata · Angleich/Lautstärkeangleich = loudness matching · Lückenlos = gapless ·
Ausgang = output · Ausgänge & Lautsprecher = Outputs & speakers · Lautsprecher = speaker · Bassmanagement = bass management ·
Entzerrer/Equalizer = equaliser (UI: „EQ“) · Reserve = headroom · Raumklang/Space = „Space“ (Produktname, bleibt) · Plug-in = plug-in ·
Anfrage = request · Nutzer/Benutzer = user · Konto = account · Gerät = device · Heimnetz = home network · Direktzugang = direct access ·
Aufräumen = tidy up · Erkennung = identification · Sicherung = backup · Hörverlauf = listening history · Beliebt = popular ·
Neu hinzugekommen = recently added · Zufall = shuffle · Wiederholen = repeat · Stumm = mute · Pegel = level · Spitze = peak ·
Röhre/Wärme/Band/Trafo: Namen der Klangmodule bleiben wie in der UI (Tube/Warmth/Tape/Transformer siehe `i18n/quelle/*.json`, sonst: Warmth, Tube, Tape, Transformer).
Neue Begriffe: konsistent halten und im Abschlussbericht nennen.
