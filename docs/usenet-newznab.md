# Usenet: Newznab-Indexer und mehrere Downloadclients

Ab 0.2.175 kann Amberwave außer über Prowlarr auch direkt bei **Newznab-Indexern** (RSS/XML) suchen und an **mehrere
SABnzbd-kompatible Downloadclients** übergeben. Die bisherige Prowlarr-/SABnzbd-Einrichtung bleibt unverändert erhalten
und ist weiterhin der „Standard“.

Code: `app/includes/downloads.php` (Logik), `app/migrations/044_download_dienste.php` (Tabelle),
`app/js/dl_anbieter.js` (Einstellungen → Downloads), `app/js/verwaltung.js` (Downloadseite).

---

## 1. Begriffe und Aufbau

| Rolle | Arten | Wo gespeichert |
|---|---|---|
| **Suchanbieter** (Indexer) | `prowlarr` (JSON-API), `newznab` (XML) | Standard-Prowlarr: Einstellungen/.env · weitere: Tabelle `download_dienste` |
| **Downloadclient** | `sabnzbd` (SABnzbd oder kompatibel) | Standard-SABnzbd: Einstellungen/.env · weitere: Tabelle `download_dienste` |

- **id 0** ist immer der Standard-Anbieter bzw. Standard-Client. Er liest wie bisher `prowlarr_*` / `sabnzbd_*` aus den
  Einstellungen (Fallback .env). Er lässt sich nicht löschen, nur leeren oder ausschalten.
- **id ≥ 1** sind weitere Einträge aus `download_dienste`.
- Jeder Suchanbieter hat ein Feld `client_id` → **an diesen Client gehen seine NZB-Dateien**. Fehlt der Client
  (gelöscht), fällt er auf den Standard-Client (0) zurück.

```
Suche ──┬─ Prowlarr (0)     ──┐                         ┌─ SABnzbd (0)   → DOWNLOAD_PFAD/
        ├─ Newznab A (1) ─────┼─ Treffer (normalisiert) ─┤
        └─ Newznab B (2) ─────┘   je Treffer: client     └─ NAS-SAB (3)   → DOWNLOAD_PFAD/sab2/
```

### Tabelle `download_dienste`

| Spalte | Bedeutung |
|---|---|
| `art` | `prowlarr`, `newznab` oder `sabnzbd` |
| `name` | Anzeigename („Indexer A“, „NAS-SAB“) |
| `url` | Basisadresse ohne API-Pfad, z. B. `https://indexer.example` |
| `api_pfad` | Pfad der Schnittstelle, Standard `/api` (SABnzbd z. B. `/sabnzbd/api` oder `/api/sabnzbd`) |
| `api_key` | verschlüsselt gespeichert (wie die übrigen Schlüssel), geht **nie** an den Browser |
| `kategorien` | Indexer: Newznab-Kategorien (`3000,3040`) · Client: SAB-Kategorie (`music`) |
| `client_id` | nur Indexer: zugeordneter Downloadclient (0 = Standard) |
| `import_ordner` | nur Client: Unterordner von `DOWNLOAD_PFAD`, in dem dieser Client seine Kategorie ablegt |
| `musiksuche` | nur Newznab: `t=music` nutzen, wenn der Indexer es anbietet |
| `aktiv` | ausgeschaltete Einträge werden nicht durchsucht/benutzt |
| `caps` | gemerkte Antwort von `t=caps` (JSON) |

`downloads` bekommt dazu `client_id` (NULL = Standard-Client – so bleiben alle Alt-Aufträge gültig), `quelle_id`,
`quelle_art` und `guid`.

---

## 2. Newznab-Protokoll

Adresse jeder Anfrage: `url + api_pfad + ?t=…&apikey=…&o=xml`. Es gibt keine anbieterspezifischen Sonderfälle; die
Fähigkeiten kommen ausschließlich aus `t=caps`.

| Endpunkt | Verwendung |
|---|---|
| `t=caps` | beim Speichern, beim Testen und (falls noch unbekannt) vor der ersten Suche. Gelesen werden `searching/search`, `searching/music-search` samt `supportedParams`, `limits/@max` und die Kategorienamen. |
| `t=search&q=…&cat=…` | allgemeine Suche – immer, wenn keine Musiksuche möglich ist |
| `t=music&artist=…&album=…&cat=…` | wenn „Musiksuche“ an ist, der Indexer `music-search available="yes"` meldet und die Suche Künstler/Album kennt (Suche aus Diskografie/Albumseite). Nur Parameter, die in `supportedParams` stehen, werden gesendet; sonst `q`. |

Fehler werden einheitlich ausgewertet: `<error code="…" description="…"/>` (100–102 → „Schlüssel nicht
angenommen“), HTTP 429 bzw. Limit-Meldungen → „Anfrage-Limit erreicht“, kein XML → Hinweis auf Adresse/API-Pfad.
Ein Fehler eines Indexers bricht die Suche nicht ab; er erscheint über den Treffern.

### Normalisierung (Newznab → internes Release-Format)

| Internes Feld | Quelle im Newznab-`<item>` |
|---|---|
| `titel` | `<title>` |
| `guid` | `newznab:attr name="guid"`, sonst `<guid>` |
| `url` (nur serverseitig) | `<enclosure url>`, sonst `<link>` |
| `groesse` | `attr size`, sonst `<enclosure length>` |
| `kategorien` | `attr category` → Namen aus caps bzw. Standardliste (3000 Audio, 3010 MP3, 3040 Lossless …); Oberkategorie entfällt, wenn eine Unterkategorie dabei ist. Ohne Attribute: Text aus `<category>` |
| `datum`, `alter_tage` | `attr usenetdate`, sonst `<pubDate>` |
| `grabs` | `attr grabs` |
| `qualitaet` | wie bisher aus dem Namen (`dl_qualitaet`) plus `attr audio/bitrate/codec/format` |

`torznab:attr` wird genauso gelesen. Prowlarr-Treffer laufen durch `dl_prowlarr_treffer` in dasselbe Format. Danach
greifen unverändert: Torrent-Filter, Relevanzbewertung (`dl_relevanz`), „schon vorhanden“, Sortierung und
**Duplikaterkennung** – zuerst über gleiche GUID, dann wie bisher über den normalisierten Titel (die anderen Quellen
stehen bei „auch:“).

Alle Indexer werden **gleichzeitig** abgefragt (`curl_multi`), die Suche dauert also so lange wie der langsamste.

---

## 3. SABnzbd-Clients

Anfragen gehen an `url + api_pfad` (Standard `/api`) mit `mode=…&apikey=…&output=json`. Damit funktioniert jeder Dienst,
der die SABnzbd-Schnittstelle nachbildet, auch unter einem anderen Basispfad wie `/api/sabnzbd`.

| Befehl | nötig? | wofür |
|---|---|---|
| `version` | Pflicht | Erreichbarkeit, Schlüssel, „ist das eine SABnzbd-API“ |
| `addfile` | Pflicht | NZB übergeben |
| `queue`, `history` | Pflicht | Fortschritt, fertiger Pfad, Wächter |
| `get_cats` | optional | Kategorien prüfen |
| `get_config` | optional | Kategorien (Ersatz für `get_cats`), `misc.complete_dir` und Kategorie-Ordner für den Pfadvergleich |
| `queue&name=delete` | optional | hängende Aufträge entfernen |

Kompatible Clients bieten oft nur eine Teilmenge an. Deshalb gilt (`dl_sab_kategorien`):

1. Zuerst `get_cats` (`{"categories": ["*", "music"]}`).
2. Kennt der Client den Befehl nicht oder antwortet unbrauchbar, kommen die Kategorien aus
   `get_config → config.categories` (Liste von `{name, dir, …}`).
3. Die eingestellte Kategorie wird mit dieser Liste verglichen; im Prüfergebnis steht dann „(laut get_config)“.
4. `complete_dir` (aus `get_config → config.misc.complete_dir`) und der Ordner der Kategorie gehen in den Abgleich
   „legt der Client dort ab, wo Amberwave liest?“ ein – ein absoluter Kategorie-Ordner (z. B. `/downloads`) gilt
   direkt, ein relativer wird an `complete_dir` gehängt.
5. Fehlen beide Befehle, ist die Kategorie nur „nicht prüfbar“ (Hinweis, kein Fehler). Ein fehlender **optionaler**
   Befehl ist nie ein Verbindungsfehler.

### Fehlerarten

`dl_sab` ordnet jeden Fehler ein (`ApiFehler::extra['sab_art']`, abfragbar mit `dl_sab_fehlerart()`), damit Prüfung
und Abgleich unterscheiden können:

| Art | Erkennung | Meldung / Tipp im Test |
|---|---|---|
| `netz` | keine Verbindung | „Keine Verbindung zu …“ – läuft der Client, Adresse/Port, nicht `localhost` |
| `auth` | HTTP 401/403 oder Fehlertext wie „API Key …“, „Unauthorized“ | „API-Schlüssel wird nicht akzeptiert“ – API Key, nicht NZB-Key |
| `pfad` | HTTP 404/405 | „unter … antwortet keine API“ – API-Pfad |
| `modus` | Fehlertext wie „Invalid mode“, „not supported“, „not implemented“, „unknown command“; HTTP 501 | „unterstützt den Befehl … nicht“ |
| `antwort` | kein JSON (z. B. Login-Seite) oder falscher Aufbau (`queue` ohne `queue.slots` …) | „keine SABnzbd-Schnittstelle“ / „unerwartete Antwort auf …“ |
| `http`, `fehler` | sonstige HTTP-Fehler bzw. Fehlertexte | Text des Clients |

Fehler werden sowohl im SABnzbd-Format `{"status": false, "error": "…"}` als auch als bloßes `{"error": "…"}` (ohne
`status`) und als Klartext `error: …` erkannt. Früher wurde eine Antwort ohne `status`-Feld als Erfolg gelesen.

Der Verbindungstest liefert für jeden Client zusätzlich die Zeile **„Warteschlange und Verlauf abrufbar“** (`api`) –
fehlt `queue` oder `history`, ist der Client für Amberwave nicht nutzbar, und der Test sagt das, statt erst beim ersten
Download zu scheitern. Im laufenden Abgleich wird der Aufbau von `queue`/`history` geprüft: Eine unbrauchbare Antwort
wird gemeldet, offene Aufträge gelten dadurch **nicht** als verschwunden und scheitern nicht.

**Import-Ordner:** Amberwave sieht die fertigen Downloads unter `DOWNLOAD_PFAD` (im Container `/downloads`). Der
Standard-Client nutzt den Ordner selbst; jeder weitere Client bekommt einen **Unterordner** davon (`import_ordner`,
z. B. `sab2`). Auf Unraid also z. B. den Musik-Ordner des zweiten SAB als `/mnt/user/downloads/complete/music/sab2`
erreichbar machen oder `DOWNLOAD_PFAD` auf einen gemeinsamen Überordner setzen und beiden Clients einen Unterordner
geben. Absolute Pfade und `..` werden abgelehnt.

---

## 4. Ablauf „Holen“

1. Der Browser schickt nur Suchnummer + Treffernummer; URL und Schlüssel bleiben auf dem Server.
2. `dl_nzb_holen` lädt die NZB **beim Anbieter des Treffers**: Prowlarr mit `X-Api-Key`-Kopf, Newznab über den
   gelieferten Link (der `apikey` wird nur ergänzt, wenn er fehlt und der Link auf denselben Host zeigt).
3. `dl_holen` übergibt die Datei per `mode=addfile` **ausschließlich an den zugeordneten Client** des Anbieters, mit
   dessen Kategorie.
4. Der Auftrag speichert `client_id`, `nzo_id`, `quelle_id`, `quelle_art` und `guid`.

Ist der zugeordnete Client nicht eingerichtet oder ausgeschaltet, ist „Holen“ für diesen Treffer gesperrt.

## 5. Abgleich, Queue, History, Import

`dl_abgleichen_status` gruppiert offene Aufträge nach `client_id` und fragt Queue/History **je Client** ab; eine
`nzo_id` wird nur beim eigenen Client gesucht. Der fertige Pfad aus der History wird über den Import-Ordner dieses
Clients aufgelöst, Wächter, Aufräumen und „Original löschen“ bleiben auf dessen Ordner beschränkt. Meldungen nennen
den Client („Keine Bewegung in NAS-SAB seit …“). Ist ein Client entfernt/ausgeschaltet, bleibt der Auftrag stehen
(„Stand unbekannt“) statt zu scheitern; ein Client mit offenen Aufträgen lässt sich nicht löschen.

---

## 6. Oberfläche

**Einstellungen → Downloads**
- *Suchanbieter*: Liste mit Status, „+ Newznab-Indexer“, „+ Prowlarr“. Je Eintrag: Name, Adresse, API-Pfad, Schlüssel
  (leer lassen = behalten), Kategorien, „Lädt mit“ (Client), Musiksuche, Eingeschaltet. „Verbindung testen“ im Dialog
  prüft die eingegebenen Werte vor dem Speichern (bei Newznab inklusive `t=caps`).
- *Downloadclients*: „+ SABnzbd“; Name, Adresse, API-Pfad, Schlüssel, Kategorie, Import-Ordner.
- *Gesamtprüfung*: prüft jeden Anbieter und Client, ihre Ordner und ob Kategorie-Ordner und Einbindung zusammenpassen.

**Downloads**: Kopfzeile „Suche: … · Laden: …“ mit Status je Dienst; Fehler einzelner Indexer über den Treffern;
bei mehr als einem Client steht am Treffer „→ Client“; die Auftragsliste zeigt den Client.

## 7. API

| Methode | Pfad | |
|---|---|---|
| GET | `/admin/downloads/dienste` | alle Anbieter/Clients (ohne Schlüssel, mit `key_gesetzt`) |
| POST | `/admin/downloads/dienste` | anlegen/ändern (`id` 0 = Standard) |
| POST | `/admin/downloads/dienste/loeschen` | `{art, id}` |
| POST | `/admin/downloads/dienste/test` | Werte prüfen, ohne zu speichern |
| POST | `/admin/downloads/suche` | zusätzlich optional `kuenstler`, `album` (für `t=music`) |

## 8. Konfiguration (.env)

Neu und optional, beides auch in der Oberfläche einstellbar:

```
SABNZBD_API_PFAD=/api          # Standard-Client hinter Proxy: /sabnzbd/api
SABNZBD_IMPORT_ORDNER=         # Unterordner von DOWNLOAD_PFAD für den Standard-Client
```

Weitere Indexer und Clients werden nur in der Oberfläche angelegt.

## 9. Rückwärtskompatibilität

- Vorhandene Prowlarr-/SABnzbd-Werte (Einstellungen oder .env) werden zu „Prowlarr“ (0) und „SABnzbd“ (0) – ohne
  Umzug, die Schlüssel bleiben, wo sie waren.
- Alte Aufträge haben `client_id = NULL` und werden dem Standard-Client zugeordnet; Abgleich und Import laufen wie zuvor.
- Ohne zusätzliche Einträge verhält sich alles wie vor 0.2.175 (gleiche Anfragen an Prowlarr und SABnzbd).
- Echte SABnzbd-Installationen werden weiter über `get_cats` geprüft; neu ist nur die Zeile „Warteschlange und Verlauf
  abrufbar“ (zwei zusätzliche lesende Anfragen beim Test).

## 10. Tests

Gegen einen nachgebauten Prowlarr, zwei Newznab-Indexer (einer mit, einer ohne Musiksuche) und zwei SAB-Clients
(`/sab1/api`, `/sab2/api/sabnzbd`):

| Test | Inhalt | Ergebnis |
|---|---|---|
| Regression Prowlarr/SABnzbd | Prüfung, Suche, Duplikate, Qualität, Holen mit Schlüssel, nzo_id, Abgleich, Import, Original löschen, Fehlerfall, Stand – vor und nach dem Umbau identisch | 19/19 |
| Erweiterung | caps, t=search/t=music, Normalisierung, Fehlercodes, parallele Suche, Dedup über GUID, Zuordnung Indexer→Client, Basispfad `/api/sabnzbd`, Queue/History/Import je Client, gleiche nzo_id in zwei Clients, Löschen/Ausschalten, Schlüssel nie im Ergebnis | 47/47 |
| Wächter | hängende/verschwundene Aufträge | bestanden |
| SABnzbd-kompatible Clients (0.2.176) | Fehlertexte einordnen, Kategorien über get_cats bzw. get_config, complete_dir, Test gegen Client ohne get_cats (Antworten wie oben), ohne get_config, ohne queue, mit falschem queue-Aufbau, Weboberfläche statt API, 403, falscher Schlüssel (status:false), keine Verbindung, 404; Holen/Abgleich/Import über den kompatiblen Client; unbrauchbare Queue lässt Aufträge nicht scheitern | 36/36 |
| Browser | Einstellungen und Downloadseite, Holen eines Newznab-Treffers an den zweiten Client, keine JS-Fehler | bestanden |
