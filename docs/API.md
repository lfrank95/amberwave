# Amberwave API v1

Basis: `/api/v1`. Antworten sind JSON (Zeitangaben ISO 8601), Fehler: `{"ok": false, "fehler": "…"}` mit HTTP-Status.

## Anmeldung
- **Browser:** Sitzungs-Cookie; ändernde Anfragen brauchen die Kopfzeile `X-CSRF-Token` (aus `GET /ich`).
- **Apps:** `POST /auth/token` mit `{"benutzername", "passwort", "geraet_name"}` → `{"token": "aw_…", "geraet_id"}`.
  Danach `Authorization: Bearer aw_…` (kein CSRF nötig). `DELETE /auth/token` meldet das Gerät ab.
  Gleiche Sperrregeln wie der Login (429 bei zu vielen Fehlversuchen).

## Bibliothek
| Methode | Pfad | Inhalt |
|---|---|---|
| GET | `/ich` | Nutzer, CSRF, App-Infos |
| GET | `/start` | Weiterhören, Neu, Oft gehört, Entdecken |
| GET | `/alben?typ=&genre=&jahrzehnt=&kuenstler=&favoriten=1&q=&buchstabe=&sort=kuenstler\|gruppiert\|titel\|jahr\|neu\|zufall&seite=&pro_seite=` | Albenliste (`gruppiert`: Albumkünstler am Stück, plus `bilder`) |
| GET | `/alben/{id}` (`?edition=` nur Admin) | Album mit Tracks, Mitwirkenden, Verwandtem |
| GET | `/editionen/{id}/tracks` | Tracks einer Edition inkl. Format und ReplayGain |
| GET | `/tracks/{id}` | Track mit Mitwirkenden und Datei-Technik |
| GET | `/kuenstler?q=&buchstabe=&alle=1&typ=person\|gruppe&sort=name\|name_ab\|alben\|neu\|gehoert\|zufall&saat=` · `/kuenstler/{id}` | Künstler, Rollen, Partner, Besetzung |
| GET | `/kuenstler/{id}/beliebt` | Genres (`genres`, Quelle `musicbrainz` oder `alben`), Top 10 weltweit nach ListenBrainz (`welt`: Rang, Titel, Hörer, Album, `track_id` oder null = fehlt), Top 10 bei uns (`bei_uns`), dazu `tracks` je ID für den Player |
| GET | `/suche?q=` · `/genres` | Suche, Genres |
| GET | `/sync/aenderungen?seit=ISO` | geänderte IDs + gelöschte Objekte (für Zwischenspeicher der Apps) |

## Wiedergabe
- `GET /stream/{trackId}?q=original` – Datei unverändert, mit HTTP-Range (bitgenau).
- `GET /stream/{trackId}?art=flac[&t=Sek]` – für den Windows-Client: immer reines FLAC. FLAC-Dateien unverändert mit HTTP-Range (bitgenau), andere Formate verlustfrei nach FLAC dekodiert.
- `GET /stream/{trackId}?q=opus256|opus160|opus128|aac256|aac160&t=Sekunden&g=dB` – live umgewandelt, Spulen über `t`, `g` = Lautheitsangleich in dB (−40 … +24).
- `GET /stream/{trackId}?art=luecken&t=` – für lückenlose Wiedergabe: FLAC in fragmentiertem MP4 (FLAC-Quellen bitgenau kopiert,
  sonst verlustfrei dekodiert), Kopfzeilen `X-Samples`/`X-Rate` (exakte Länge) und `X-Bitgenau`.
- `GET /stream/kette?ids=1,2,3&q=opus256&t=` – mehrere Titel als EIN durchgehender Opus-Strom (WebM), `X-Dauern` = Längen in Sekunden; `&g=-6.2,-6.2,` = Gain je Titel in dB (leer = keiner).
- `GET /bild/cover/{schluessel}?g=300|600|1200`, `GET /bild/kuenstler/{schluessel}`
- `POST /wiedergabe` `{"track_id", "ereignis": "start|fortschritt|ende|ueberspringen", "sekunden", "position", "wiedergabe_id", "quelle"}` – `ueberspringen` = von Hand weiter vor dem Ende (Signal fürs Radio)
- `POST /radio` `{"saat": null | {"art": "track|album|kuenstler", "id"}, "ausschluss": [track_ids], "anzahl"}` → `{tracks, gruende: {track_id: Text}, titel}`
- `GET|PUT /warteschlange` `{"track_ids", "index", "position"}` – pro Gerät
- `GET|PUT /geraet/einstellungen` `{"einstellungen": {"schluessel": beliebiges JSON}}` – pro Gerät (z. B. Ausgabeprofile, Upmix)

## Nutzerdaten
`GET|POST /favoriten` (`{"art": "album|kuenstler|track|playlist", "id", "an"}`), `GET /verlauf`,
`GET|POST /playlists`, `GET|PUT|DELETE /playlists/{id}`, `POST /playlists/{id}/tracks`, `DELETE /playlists/{id}/eintraege/{eintrag}`,
`GET|PUT /profil`, `POST /profil/passwort`, `DELETE /profil/geraete/{id}`, `POST /abmelden`.

## Verwaltung (nur Admin)
Übersicht, Einlesen (`/admin/scan`), Konten (`/admin/konten…`), Einstellungen, Mailtest, Sicherheitsprotokoll, Update,
Metadaten (`/admin/alben/{id}`, `/admin/editionen/{id}`, `/admin/kuenstler/{id}`), MusicBrainz
(`/admin/editionen/{id}/mb-suche`, `…/mb-vergleich/{mbid}`, `…/mb-uebernehmen`, `…/mb-loesen`, `/admin/kuenstler/{id}/mb-…`),
Mitwirkende von Hand (`/admin/editionen/{id}/mitwirkende`), Titel (`GET|PUT /admin/tracks/{id}` mit `disc`/`pos`, `PUT /admin/editionen/{id}/tracks` mit `[{id, disc, pos, titel}]`; doppelte CD + Nummer → 400). Die genaue Liste steht in `app/api/index.php`.

## Raumklang (Impulsantworten)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/raumklang/irs` | Liste der Impulsantworten `{irs: [{id, name, quelle, quelle_titel, groesse}], voxengo: {installiert, url, lizenz}}` |
| GET | `/raumklang/ir?id=voxengo/Datei.wav` | WAV-Datei einer Impulsantwort |
| POST | `/admin/raumklang/voxengo` | Server lädt das Voxengo-Paket (`RAUMKLANG_IR_URL`) und legt die WAVs unverändert ab |
| POST | `/admin/raumklang/ir` | Eigene WAV hochladen (Formularfeld `ir`) |
| DELETE | `/admin/raumklang/ir?id=…` | Eigene IR löschen; bei `voxengo/…` wird das ganze Paket entfernt |

## Direktzugang im Heimnetz

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/ping` | Ohne Anmeldung: `{ok, app, version, name, url}` – die App prüft damit, ob die Direktadresse antwortet; der Windows-Client findet so den Server im Heimnetz (`name` aus `CLIENT_SERVERNAME`, sonst Hostname; `url` = `APP_URL`) |
| GET | `/direkt/token` | `{url, token, bis}` – Direktadresse und Stream-Schlüssel (12 h), `url: null` wenn aus |
| GET | `/admin/direktzugang` | Zustand: Token gesetzt, Name, IP, Port, Zertifikat, letzter Lauf mit Schritten |
| POST | `/admin/direktzugang/token` | `{token}` prüfen und verschlüsselt speichern (leer = löschen) |
| GET | `/admin/direktzugang/zonen` | Zonen, auf die das Token Zugriff hat |
| GET | `/admin/datenbank` | Datenbank & Schlüssel: `{host, name, user, quelle: env\|datei, passwort_aenderbar, root_notfall, schluessel_erzeugt, schluessel_gesichert}` (ohne Werte) |
| POST | `/admin/datenbank/zeigen` | `{passwort}` (Anmelde-Passwort des Admins) → `{db_passwort, root_passwort, schluessel}` |
| POST | `/admin/datenbank/passwort` | `{passwort, neu?}` – Datenbank-Passwort ändern (leer = zufällig, mind. 16 Zeichen); nur wenn es aus der Einrichtung stammt, nicht bei `DB_PASSWORD` in der .env |
| GET | `/admin/tunnel` | Cloudflare Tunnel: `{aktiv, host, url, verbunden, status, verbindungen:[{ort, seit}], version, ziel, container_ip, diese_anfrage_im_tunnel, links, lauf}`; `?kurz=1` ohne Abfrage bei Cloudflare |
| POST | `/admin/tunnel/einrichten` | `{host}` – eigener Tunnel: anlegen bzw. weiterverwenden, Weiterleitung auf `TUNNEL_ZIEL`, proxied CNAME, Token nach `PFAD_CACHE/tunnel/token`; `{host, tunnel, ziel}` im Modus vorhanden (`TUNNEL_IM_STACK=0`): Regel in den gewählten Tunnel mischen (Schritte in `lauf`) |
| POST | `/admin/tunnel/entfernen` | eigener Tunnel: Tunnel und DNS-Eintrag bei Cloudflare löschen, Token-Datei entfernen; vorhandener Tunnel: nur Amberwaves Regel und den DNS-Eintrag |
| GET | `/admin/tunnel/liste` | (Modus vorhanden) Tunnel aller Konten des Tokens: `{tunnel:[{id, name, status, konto, konto_name, remote, verbindungen}]}` |
| POST | `/admin/tunnel/proxy` | `{ip}` Adresse/Netz eines vorhandenen cloudflared, dessen Kopfzeilen gelten (leer = löschen) |
| POST | `/admin/direktzugang/einrichten` | `{host, ip, port, email}` – DNS-Eintrag, Zertifikat, Neuladen, Selbsttest |
| POST | `/admin/direktzugang/aus` | `{dns_loeschen}` – abschalten |

Streams (`/stream/{id}`, `/stream/kette`), Downloads, Exporte, Bilder und `/raumklang/ir` akzeptieren statt der Sitzung den Direkt-Schlüssel als
`?st=…`. Alle übrigen Routen akzeptieren ihn in der Kopfzeile `X-Amberwave-Direkt: …` (ohne Sitzung, ohne CSRF; Schlüssel = Nutzer + Gerät + Ablauf, signiert). Anfragen von `APP_URL` an die Direktadresse bekommen passende CORS-Header (inkl. Private Network Access).
| POST | `/admin/direktzugang/erneuern` | Zertifikat sofort erneuern |
| POST | `/admin/direktzugang/auto` | `{an}` – automatische Erneuerung an/aus |

## Aktivität

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/status` | Player meldet `{track_id, position, dauer, spielt, info:{qualitaet, art, lueckenlos, bitgenau, direkt, eq, raumklang, …}}` (alle 10 s und bei Änderungen; `track_id: 0` oder `ereignis: "stopp"` beendet) |
| GET | `/fern/strom` | Rückkanal der Fernsteuerung (Server-Sent Events): `befehl` (an dieses Gerät), `beobachter` (wer steuert mich), `zustand`/`liste`/`online` (des gesteuerten Geräts), `ende` (neu verbinden mit `?ab=&zv=&lv=`). `?einmal=1` = eine Runde als JSON `{ereignisse:[[name, daten]…]}` zum Nachfragen. 503 `{nachfragen:true}` = alle Kanäle belegt |
| GET | `/fern/geraete` | Geräte zum Steuern: eigene (Admins: alle) der letzten 30 Minuten, mit `online`, `steuerbar`/`grund`, Kurz-Zustand, `steuert`, `gesteuert_von`, `max_vol` |
| POST | `/wiedergabe` (offline nachgemeldet) | zusätzlich `zeit` (Unix-ms, Beginn; 1 Minute bis 60 Tage zurück) – dann zählt die Wiedergabe zu diesem Zeitpunkt, „Weiterhören“ bleibt unberührt. Offline-Speichern lädt je Titel `/stream/kette?ids=<id>&q=opus256` (Länge in `X-Dauern`) |
| POST | `/bibliothek/frisch` | `{tracks:[ids]}` – aktuelle Angaben (Titel, Künstler, Album, Cover) zu Titeln, z. B. für die Warteschlange nach einer Änderung; `weg` = nicht mehr vorhandene IDs. Ob sich die Bibliothek geändert hat, meldet `/fern/strom` mit dem Ereignis `bib` `{stand}` (Parameter `bv` = zuletzt bekannter Stand) |
| POST | `/fern/verbinden` | `{ziel}` – dieses Gerät steuert ab jetzt `ziel` (`null`/0 = wieder selbst). Steuert das Ziel gerade uns, endet das |
| POST | `/fern/befehl` | `{befehl, daten, ziel?}` – `play`, `pause`, `pp`, `weiter`, `zurueck`, `springen` (Sek.), `springen_zu` (Index), `stopp`, `vol` (0–1, begrenzt auf `fern_max_lautstaerke` des Ziels), `zufall`, `wdh`, `abspielen` `{tracks, start, kontext}`, `naechstes`/`anhaengen` `{tracks}`, `entfernen` (Index), `holen` (Ziel pausiert) |
| POST | `/fern/zustand` | Eigener Zustand `{zustand:{art, mobil, sichtbar, aktiviert, track, spielt, pos, dauer, vol, …}, liste?}` |
| POST | `/fern/weg` | Seite wird geschlossen (sendBeacon) |
| GET | `/admin/aktivitaet` | Laufende/pausierte Wiedergaben mit Nutzer, Gerät, Titel, Qualität, Weg (`direkt`/`heim`/`extern`), Datenrate; Summen |

## Lautheit (EBU R128)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/lautheit?ids=1,2,3` | Je Titel `{e: Edition, o: Position im Album, t/ttp: Titel-LUFS/True-Peak, a/atp: Album-LUFS/True-Peak, q: messung\|tags\|fehlt}`, dazu `ziel` und `decke` (dBTP) |
| GET | `/tracks/{id}/nerd` | Alles für die Nerd-Ansicht: `datei`, `titel`/`album` (LUFS, LRA, True-/Sample-Peak), `kurve {schritt: 0.2, m, s, p}` in dB (−120 = keine Messung); fehlt die Kurve, wird der Titel sofort gemessen |
| GET | `/admin/lautheit` | Fortschritt der Analyse: gemessen/gesamt, Alben, Fehler, Rest in Stunden Musik, Durchschnitt |
| POST | `/admin/lautheit/neu` | `{nur_fehler}` – alles (bzw. nur Fehlgeschlagene) neu messen |

Album (`GET /alben/{id}`): `edition.lautheit = {lufs, lra, true_peak, sample_peak, plr}`; Titel: `lautheit {lufs, lra, true_peak}`.
Gain im Player: Album-Gain, wenn der Titel mit Vorgänger oder Nachfolger in der Warteschlange im Album direkt
zusammenhängt (`e` gleich, `o` um 1 verschieden), sonst Titel-Gain; `gain = ziel − LUFS`, Anheben höchstens bis `decke − TP`.

## WAV-Export

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/export` | `{art: "playlist", id}` oder `{art: "tracks", track_ids, quelle}`, dazu `name` und `optionen {rate: 44100\|48000, lautheit: auto\|titel\|aus, ziel, pause, ueberblenden, stille}` – startet den Hintergrund-Job (nur mit Download-Recht) |
| GET | `/export` · `/export/{id}` | eigene Exporte: Status, Fortschritt (%), Teile mit Download-URL |
| GET | `/export/{id}/datei/{nr}` | WAV-Datei (Range-fähig) |
| GET | `/export/{id}/titelliste` | Titelliste mit Startzeiten (.txt) |
| DELETE | `/export/{id}` | Export abbrechen bzw. löschen |

## Erkennung am Klang (nur Admin)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/admin/erkennung` | Stand: Schlüssel/Werkzeug vorhanden, läuft, Zähler (Alben erledigt/verknüpft/offen, Titel abgefragt/erkannt), je Status die Anzahl und die Liste zum Prüfen mit Kandidaten (`mbid`, Titel, Format, Land, Datum, Titelzahl, `sicherheit`, mittlere Laufzeitabweichung `abw`) |
| POST | `/admin/erkennung/start` | Hintergrund-Lauf sofort anstoßen (läuft sonst jede Minute vom Zeitplan) |
| POST | `/admin/erkennung/neu` | `{was: "unsicher" \| "alle"}` – unsichere/nicht erkannte (bzw. alle nicht übernommenen) Alben neu prüfen, AcoustID neu fragen |
| POST | `/admin/erkennung/{edition}/ignorieren` · `/erledigt` | Vorschlag verwerfen bzw. automatisch Übernommenes als geprüft markieren |

Übernommen wird über `POST /admin/editionen/{id}/mb-uebernehmen` (setzt den Eintrag auf „von Hand übernommen“).
Status: `uebernommen`, `bestaetigt`, `regeln` (gleiche Titelliste auf mehreren Editionen, nach Regeln gewählt), `eindeutig`
(nur wenn `ERKENNUNG_AUTO=aus`), `unsicher`, `nichts`, `doppelt`, `fehler`, `ignoriert`.

## Dateien aufräumen (nur Admin)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/admin/aufraeumen` | Stand: Pläne je Album (Status `offen` = Vorschau, `freigegeben`, `laeuft`, `fertig`, `fehler`), Zusammenfassung, Anzahl Änderungen/Hinweise, Schema, Papierkorb-Größe |
| POST | `/admin/aufraeumen/vorschau` | `{edition_id}` – Vorschau für ein Album; ohne: Vorschau für alle abgeglichenen Alben in Schüben von ~15 s (`{neu: true}` = alle neu), Antwort mit `rest` |
| GET | `/admin/aufraeumen/{edition}` | Plan im Detail: Ordner alt/neu, je Datei neuer Name, Tag-Unterschiede `[feld, bisher, neu]`, Cover, Hinweise; Müll; mitwandernde Dateien; Protokoll |
| POST | `/admin/aufraeumen/freigeben` | `{edition_ids: [...]}` oder `{alle: true}` – Vorschauen mit Änderungen freigeben, der Hintergrund-Job startet |
| POST | `/admin/aufraeumen/verwerfen` | `{edition_ids: [...]}` |
| POST | `/admin/aufraeumen/papierkorb-leeren` | Papierkorb-Ordner sofort leeren |

## Dateien aufräumen (nur Admin)

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/admin/aufraeumen` | Stand: Schema, Pläne je Album (Status, Zusammenfassung, Zahl der Änderungen), Papierkorb (Dateien, Größe, Aufbewahrung) |
| POST | `/admin/aufraeumen/vorschau` | `{neu}` Vorschau für alle abgeglichenen Alben (in Schüben, `rest` = noch offen) oder `{edition_id}` für ein Album |
| GET | `/admin/aufraeumen/{edition}` | Plan im Detail: Ordner alt → neu, je Datei Name alt → neu, Tag-Änderungen (alt/neu), Cover, Müll |
| POST | `/admin/aufraeumen/freigeben` | `{edition_ids}` oder `{alle: true}` – Hintergrund-Worker führt aus (Tags/Cover schreiben, umbenennen, Müll in den Papierkorb) |
| POST | `/admin/aufraeumen/verwerfen` | `{edition_ids}` – Plan verwerfen |
| POST | `/admin/aufraeumen/papierkorb-leeren` | Papierkorb-Ordner `.amberwave-papierkorb` endgültig leeren |

Nur Alben mit Quelle MusicBrainz oder von Hand gepflegt. Das Audio wird nie neu kodiert; vor und nach dem Schreiben wird eine
Prüfsumme über die dekodierten Audiodaten verglichen, bei Abweichung wird der alte Stand zurückgeschrieben. Alte Tags landen als JSON im Papierkorb.

## Geräte im Heimnetz (DLNA)

Geräte erscheinen in `/fern/geraete` als `heim: true` mit IDs ab 2 000 000 000 und werden wie andere Geräte über `/fern/verbinden` und `/fern/befehl` gesteuert (alle Konten dürfen abspielen). Ein Hintergrund-Dienst (`scripts/heimnetz_agent.php`) spricht die Geräte per UPnP an (AVTransport, RenderingControl, SetNext für lückenlos) und schaltet bei Denon/Marantz (HTTP), Yamaha MusicCast (YXC) und Onkyo/Pioneer (eISCP) Ein, Eingang, Lautstärke und Tonmodus.

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/heimnetz` | (Admin) Geräte mit Fähigkeiten, Zustand, Einstellungen, Protokoll; `basis` `{url, quelle}`, `netze`, `agent`, `render` |
| POST | `/heimnetz/suchen` | (Admin) `{netz?}` Unicast-SSDP an jede Adresse (geht auch aus einem Docker-Bridge-Netz) → `{funde:[{ip, ort, name, hersteller, modell, bekannt}], netze, adressen}` |
| PUT | `/heimnetz/cast` | (Admin) `{app_id}` App-ID des eigenen Cast-Empfängers (8 Hex-Zeichen, leer = Standard-Empfänger); `GET /heimnetz` liefert dazu `cast` `{app_id, quelle, empfaenger, https, geraete}` |
| GET | `/admin/dienste/anfragen` | (Admin) Anfragen an fremde Dienste: `{user_agent, edition, installation, dienste: [{dienst, heute, woche, monat, monat_pro, vormonat, gesamt, fehler_monat, seit}]}` |
| PUT | `/heimnetz/basis` | (Admin) `{url}` Adresse, unter der Geräte den Server erreichen (leer = selbst erkennen) |
| POST | `/heimnetz/geraete` | (Admin) `{ip}` oder `{ort}` (URL der Gerätebeschreibung) – prüfen und hinzufügen |
| PUT | `/heimnetz/geraete/{id}` | (Admin) `{name?, aktiv?, einst?:{einschalten, eingang, tonmodus, aus_minuten, start_vol, max_vol, max_rate, max_bits}}` |
| DELETE | `/heimnetz/geraete/{id}` | (Admin) entfernen |
| POST | `/heimnetz/geraete/{id}/pruefen` | (Admin) Beschreibung, Formate und Steuerung neu lesen |
| POST | `/heimnetz/geraete/{id}/klang` | (Admin) `{weg:'original'\|'effekte', befehle, bezug, beschreibung, lautheit, ziel, space}` – `befehle` sind die Engine-Befehle (`fx`, `kette`), der Server rechnet sie mit `bin/aw-render`; `space` = `{an, preset, name, kanaele: 6\|4, raten: {44100: hash, 48000: hash}}` (Hashes aus `POST /heimnetz/raum`) |
| POST | `/heimnetz/raum` | (Admin, Formular mit Datei `kette`) Space-Befehle für eine Abtastrate (`raum`, `raum_ir`, `raum_p`, `raum_m` als JSON-Zeilen, bis 16 MB) speichern → `{hash}` |
| POST | `/heimnetz/geraete/{id}/space` | (Admin) gemerkte Ablehnung von Space vergessen; der laufende Titel startet neu und probiert 5.1 erneut. `GET /heimnetz` liefert je Gerät `klang.space` `{an, preset, name, kanaele, geht: true\|false\|null, grund, zeit}` |
| POST | `/heimnetz/geraete/{id}/tonmodus` | (Admin) `{modus}` – `pure`, `direct`, `stereo`, `mch`, `auto` je nach Hersteller |
| GET | `/heim/s/{token}` | Stream fürs Gerät (signiert, ohne Anmeldung): Original oder WAV (umgerechnet/mit Effekten), mit `Range` und DLNA-Köpfen |

## Einrichtung (vor dem ersten Konto)

Solange Amberwave nicht eingerichtet ist (`/einrichtung.php`), antwortet die API auf jede Anfrage mit `503` und `{ok:false, einrichtung:true, fehler}`. Clients zeigen dann „Server noch nicht eingerichtet“ und versuchen es später erneut.
