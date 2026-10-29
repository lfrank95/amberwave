# Amberwave API v1

Base: `/api/v1`. Responses are JSON (timestamps in ISO 8601), errors: `{"ok": false, "fehler": "…"}` with an HTTP status.

## Authentication
- **Browser:** session cookie; requests that change data need the header `X-CSRF-Token` (from `GET /ich`).
- **Apps:** `POST /auth/token` with `{"benutzername", "passwort", "geraet_name"}` → `{"token": "aw_…", "geraet_id"}`.
  After that, `Authorization: Bearer aw_…` (no CSRF needed). `DELETE /auth/token` signs the device out.
  Same lockout rules as the login (429 after too many failed attempts).

## Library
| Method | Path | Content |
|---|---|---|
| GET | `/ich` | User, CSRF, app info |
| GET | `/start` | Continue listening, New, Frequently played, Discover |
| GET | `/alben?typ=&genre=&jahrzehnt=&kuenstler=&favoriten=1&q=&buchstabe=&sort=kuenstler\|gruppiert\|titel\|jahr\|neu\|zufall&seite=&pro_seite=` | Album list (`gruppiert`: album artists kept together, plus `bilder`) |
| GET | `/alben/{id}` (`?edition=` admin only) | Album with tracks, contributors, related items |
| GET | `/editionen/{id}/tracks` | Tracks of an edition incl. format and ReplayGain |
| GET | `/tracks/{id}` | Track with contributors and file technical details |
| GET | `/kuenstler?q=&buchstabe=&alle=1&typ=person\|gruppe&sort=name\|name_ab\|alben\|neu\|gehoert\|zufall&saat=` · `/kuenstler/{id}` | Artists, roles, partners, line-up |
| GET | `/kuenstler/{id}/beliebt` | Genres (`genres`, source `musicbrainz` or `alben`), top 10 worldwide according to ListenBrainz (`welt`: rank, title, listeners, album, `track_id` or null = missing), top 10 on our server (`bei_uns`), plus `tracks` by ID for the player |
| GET | `/suche?q=` · `/genres` | Search, genres |
| GET | `/sync/aenderungen?seit=ISO` | changed IDs + deleted objects (for the apps' caches) |

## Playback
- `GET /stream/{trackId}?q=original` – file unchanged, with HTTP Range (bit-perfect).
- `GET /stream/{trackId}?art=flac[&t=Sek]` – for the Windows client: always pure FLAC. FLAC files unchanged with HTTP Range (bit-perfect), other formats losslessly decoded to FLAC.
- `GET /stream/{trackId}?q=opus256|opus160|opus128|aac256|aac160&t=Sekunden&g=dB` – transcoded live, seeking via `t`, `g` = loudness adjustment in dB (−40 … +24).
- `GET /stream/{trackId}?art=luecken&t=` – for gapless playback: FLAC in fragmented MP4 (FLAC sources copied bit-perfect,
  otherwise losslessly decoded), headers `X-Samples`/`X-Rate` (exact length) and `X-Bitgenau`.
- `GET /stream/kette?ids=1,2,3&q=opus256&t=` – several tracks as ONE continuous Opus stream (WebM), `X-Dauern` = lengths in seconds; `&g=-6.2,-6.2,` = gain per track in dB (empty = none).
- `GET /bild/cover/{schluessel}?g=300|600|1200`, `GET /bild/kuenstler/{schluessel}`
- `POST /wiedergabe` `{"track_id", "ereignis": "start|fortschritt|ende|ueberspringen", "sekunden", "position", "wiedergabe_id", "quelle"}` – `ueberspringen` = manually skipping ahead before the end (signal for the radio)
- `POST /radio` `{"saat": null | {"art": "track|album|kuenstler", "id"}, "ausschluss": [track_ids], "anzahl"}` → `{tracks, gruende: {track_id: text}, titel}`
- `GET|PUT /warteschlange` `{"track_ids", "index", "position"}` – per device
- `GET|PUT /geraet/einstellungen` `{"einstellungen": {"schluessel": any JSON}}` – per device (e.g. output profiles, upmix)

## User data
`GET|POST /favoriten` (`{"art": "album|kuenstler|track|playlist", "id", "an"}`), `GET /verlauf`,
`GET|POST /playlists`, `GET|PUT|DELETE /playlists/{id}`, `POST /playlists/{id}/tracks`, `DELETE /playlists/{id}/eintraege/{eintrag}`,
`GET|PUT /profil`, `POST /profil/passwort`, `DELETE /profil/geraete/{id}`, `POST /abmelden`.

## Admin (admin only)
Overview, scanning (`/admin/scan`), accounts (`/admin/konten…`), settings, mail test, security log, update,
metadata (`/admin/alben/{id}`, `/admin/editionen/{id}`, `/admin/kuenstler/{id}`), MusicBrainz
(`/admin/editionen/{id}/mb-suche`, `…/mb-vergleich/{mbid}`, `…/mb-uebernehmen`, `…/mb-loesen`, `/admin/kuenstler/{id}/mb-…`),
contributors by hand (`/admin/editionen/{id}/mitwirkende`), titles (`GET|PUT /admin/tracks/{id}` with `disc`/`pos`, `PUT /admin/editionen/{id}/tracks` with `[{id, disc, pos, titel}]`; duplicate disc + number → 400). The exact list is in `app/api/index.php`.

## Room acoustics (impulse responses)

| Method | Path | Description |
|---|---|---|
| GET | `/raumklang/irs` | List of impulse responses `{irs: [{id, name, quelle, quelle_titel, groesse}], voxengo: {installiert, url, lizenz}}` |
| GET | `/raumklang/ir?id=voxengo/Datei.wav` | WAV file of an impulse response |
| POST | `/admin/raumklang/voxengo` | The server downloads the Voxengo package (`RAUMKLANG_IR_URL`) and stores the WAVs unchanged |
| POST | `/admin/raumklang/ir` | Upload your own WAV (form field `ir`) |
| DELETE | `/admin/raumklang/ir?id=…` | Delete your own IR; for `voxengo/…` the whole package is removed |

## Direct access on the home network

| Method | Path | Description |
|---|---|---|
| GET | `/ping` | Without login: `{ok, app, version, name, url}` – the app uses it to check whether the direct address responds; this is how the Windows client finds the server on the home network (`name` from `CLIENT_SERVERNAME`, otherwise the hostname; `url` = `APP_URL`) |
| GET | `/direkt/token` | `{url, token, bis}` – direct address and stream key (12 h), `url: null` if off |
| GET | `/admin/direktzugang` | State: token set, name, IP, port, certificate, last run with steps |
| POST | `/admin/direktzugang/token` | Check `{token}` and store it encrypted (empty = delete) |
| GET | `/admin/direktzugang/zonen` | Zones the token has access to |
| GET | `/admin/datenbank` | Database & keys: `{host, name, user, quelle: env\|datei, passwort_aenderbar, root_notfall, schluessel_erzeugt, schluessel_gesichert}` (without values) |
| POST | `/admin/datenbank/zeigen` | `{passwort}` (the admin's login password) → `{db_passwort, root_passwort, schluessel}` |
| POST | `/admin/datenbank/passwort` | `{passwort, neu?}` – change the database password (empty = random, at least 16 characters); only if it comes from the setup, not with `DB_PASSWORD` in the .env |
| GET | `/admin/tunnel` | Cloudflare Tunnel: `{aktiv, host, url, verbunden, status, verbindungen:[{ort, seit}], version, ziel, container_ip, diese_anfrage_im_tunnel, links, lauf}`; `?kurz=1` without querying Cloudflare |
| POST | `/admin/tunnel/einrichten` | `{host}` – own tunnel: create or reuse, forwarding to `TUNNEL_ZIEL`, proxied CNAME, token to `PFAD_CACHE/tunnel/token`; `{host, tunnel, ziel}` in existing mode (`TUNNEL_IM_STACK=0`): merge the rule into the chosen tunnel (steps in `lauf`) |
| POST | `/admin/tunnel/entfernen` | own tunnel: delete the tunnel and DNS entry at Cloudflare, remove the token file; existing tunnel: only Amberwave's rule and the DNS entry |
| GET | `/admin/tunnel/liste` | (existing mode) Tunnels of all accounts of the token: `{tunnel:[{id, name, status, konto, konto_name, remote, verbindungen}]}` |
| POST | `/admin/tunnel/proxy` | `{ip}` address/network of an existing cloudflared whose headers are trusted (empty = delete) |
| POST | `/admin/direktzugang/einrichten` | `{host, ip, port, email}` – DNS entry, certificate, reload, self-test |
| POST | `/admin/direktzugang/aus` | `{dns_loeschen}` – switch off |

Streams (`/stream/{id}`, `/stream/kette`), downloads, exports, images and `/raumklang/ir` accept the direct key as `?st=…` instead of the session. All other routes accept it in the header `X-Amberwave-Direkt: …` (without session, without CSRF; key = user + device + expiry, signed). Requests from `APP_URL` to the direct address get the appropriate CORS headers (incl. Private Network Access).
| POST | `/admin/direktzugang/erneuern` | Renew the certificate immediately |
| POST | `/admin/direktzugang/auto` | `{an}` – automatic renewal on/off |

## Activity

| Method | Path | Description |
|---|---|---|
| POST | `/status` | Player reports `{track_id, position, dauer, spielt, info:{qualitaet, art, lueckenlos, bitgenau, direkt, eq, raumklang, …}}` (every 10 s and on changes; `track_id: 0` or `ereignis: "stopp"` ends it) |
| GET | `/fern/strom` | Return channel of the remote control (Server-Sent Events): `befehl` (to this device), `beobachter` (who is controlling me), `zustand`/`liste`/`online` (of the controlled device), `ende` (reconnect with `?ab=&zv=&lv=`). `?einmal=1` = one round as JSON `{ereignisse:[[name, daten]…]}` for polling. 503 `{nachfragen:true}` = all channels busy |
| GET | `/fern/geraete` | Devices to control: your own (admins: all) from the last 30 minutes, with `online`, `steuerbar`/`grund`, short state, `steuert`, `gesteuert_von`, `max_vol` |
| POST | `/wiedergabe` (reported later, offline) | additionally `zeit` (Unix ms, start; 1 minute to 60 days in the past) – the playback is then counted at that time, “Continue listening” stays untouched. Offline saving loads `/stream/kette?ids=<id>&q=opus256` per track (length in `X-Dauern`) |
| POST | `/bibliothek/frisch` | `{tracks:[ids]}` – current details (title, artist, album, cover) for tracks, e.g. for the queue after a change; `weg` = IDs that no longer exist. Whether the library has changed is reported by `/fern/strom` with the event `bib` `{stand}` (parameter `bv` = last known state) |
| POST | `/fern/verbinden` | `{ziel}` – this device now controls `ziel` (`null`/0 = control itself again). If the target is currently controlling us, that ends |
| POST | `/fern/befehl` | `{befehl, daten, ziel?}` – `play`, `pause`, `pp`, `weiter`, `zurueck`, `springen` (sec.), `springen_zu` (index), `stopp`, `vol` (0–1, limited to the target's `fern_max_lautstaerke`), `zufall`, `wdh`, `abspielen` `{tracks, start, kontext}`, `naechstes`/`anhaengen` `{tracks}`, `entfernen` (index), `holen` (target pauses) |
| POST | `/fern/zustand` | Own state `{zustand:{art, mobil, sichtbar, aktiviert, track, spielt, pos, dauer, vol, …}, liste?}` |
| POST | `/fern/weg` | Page is being closed (sendBeacon) |
| GET | `/admin/aktivitaet` | Running/paused playbacks with user, device, track, quality, route (`direkt`/`heim`/`extern`), data rate; totals |

## Loudness (EBU R128)

| Method | Path | Description |
|---|---|---|
| GET | `/lautheit?ids=1,2,3` | Per track `{e: edition, o: position in the album, t/ttp: track LUFS/true peak, a/atp: album LUFS/true peak, q: messung\|tags\|fehlt}`, plus `ziel` and `decke` (dBTP) |
| GET | `/tracks/{id}/nerd` | Everything for the nerd view: `datei`, `titel`/`album` (LUFS, LRA, true/sample peak), `kurve {schritt: 0.2, m, s, p}` in dB (−120 = no measurement); if the curve is missing, the track is measured immediately |
| GET | `/admin/lautheit` | Analysis progress: measured/total, albums, errors, remainder in hours of music, average |
| POST | `/admin/lautheit/neu` | `{nur_fehler}` – re-measure everything (or only the failed ones) |

Album (`GET /alben/{id}`): `edition.lautheit = {lufs, lra, true_peak, sample_peak, plr}`; track: `lautheit {lufs, lra, true_peak}`.
Gain in the player: album gain if the track is directly connected within the album to its predecessor or successor in the queue
(`e` equal, `o` differing by 1), otherwise track gain; `gain = ziel − LUFS`, boosting at most up to `decke − TP`.

## WAV export

| Method | Path | Description |
|---|---|---|
| POST | `/export` | `{art: "playlist", id}` or `{art: "tracks", track_ids, quelle}`, plus `name` and `optionen {rate: 44100\|48000, lautheit: auto\|titel\|aus, ziel, pause, ueberblenden, stille}` – starts the background job (only with download permission) |
| GET | `/export` · `/export/{id}` | your own exports: status, progress (%), parts with download URL |
| GET | `/export/{id}/datei/{nr}` | WAV file (Range-capable) |
| GET | `/export/{id}/titelliste` | Track list with start times (.txt) |
| DELETE | `/export/{id}` | Cancel or delete the export |

## Recognition by sound (admin only)

| Method | Path | Description |
|---|---|---|
| GET | `/admin/erkennung` | State: key/tool present, running, counters (albums done/linked/open, tracks queried/recognized), count per status and the list for review with candidates (`mbid`, title, format, country, date, track count, `sicherheit`, mean runtime deviation `abw`) |
| POST | `/admin/erkennung/start` | Trigger the background run immediately (otherwise it runs every minute on schedule) |
| POST | `/admin/erkennung/neu` | `{was: "unsicher" \| "alle"}` – re-check uncertain/unrecognized (or all non-adopted) albums, query AcoustID again |
| POST | `/admin/erkennung/{edition}/ignorieren` · `/erledigt` | Discard the suggestion or mark automatically adopted items as reviewed |

Adoption happens via `POST /admin/editionen/{id}/mb-uebernehmen` (sets the entry to “adopted manually”).
Statuses: `uebernommen`, `bestaetigt`, `regeln` (same track list on several editions, chosen by rules), `eindeutig`
(only if `ERKENNUNG_AUTO=aus`), `unsicher`, `nichts`, `doppelt`, `fehler`, `ignoriert`.

## Tidy up files (admin only)

| Method | Path | Description |
|---|---|---|
| GET | `/admin/aufraeumen` | State: plans per album (status `offen` = preview, `freigegeben`, `laeuft`, `fertig`, `fehler`), summary, number of changes/notes, scheme, trash size |
| POST | `/admin/aufraeumen/vorschau` | `{edition_id}` – preview for one album; without it: preview for all matched albums in batches of ~15 s (`{neu: true}` = all anew), response with `rest` |
| GET | `/admin/aufraeumen/{edition}` | Plan in detail: folder old/new, new name per file, tag differences `[field, before, new]`, cover, notes; junk; files moving along; log |
| POST | `/admin/aufraeumen/freigeben` | `{edition_ids: [...]}` or `{alle: true}` – approve previews with changes, the background job starts |
| POST | `/admin/aufraeumen/verwerfen` | `{edition_ids: [...]}` |
| POST | `/admin/aufraeumen/papierkorb-leeren` | Empty the trash folder immediately |

## Tidy up files (admin only)

| Method | Path | Description |
|---|---|---|
| GET | `/admin/aufraeumen` | State: scheme, plans per album (status, summary, number of changes), trash (files, size, retention) |
| POST | `/admin/aufraeumen/vorschau` | `{neu}` preview for all matched albums (in batches, `rest` = still open) or `{edition_id}` for one album |
| GET | `/admin/aufraeumen/{edition}` | Plan in detail: folder old → new, name old → new per file, tag changes (old/new), cover, junk |
| POST | `/admin/aufraeumen/freigeben` | `{edition_ids}` or `{alle: true}` – background worker executes (write tags/cover, rename, move junk to the trash) |
| POST | `/admin/aufraeumen/verwerfen` | `{edition_ids}` – discard plan |
| POST | `/admin/aufraeumen/papierkorb-leeren` | Permanently empty the trash folder `.amberwave-papierkorb` |

Only albums whose source is MusicBrainz or maintained by hand. The audio is never re-encoded; before and after writing, a
checksum over the decoded audio data is compared, and if it differs the old state is written back. Old tags end up in the trash as JSON.

## Home network devices (DLNA)

Devices appear in `/fern/geraete` as `heim: true` with IDs starting at 2 000 000 000 and are controlled like other devices via `/fern/verbinden` and `/fern/befehl` (all accounts may play). A background service (`scripts/heimnetz_agent.php`) talks to the devices via UPnP (AVTransport, RenderingControl, SetNext for gapless) and, for Denon/Marantz (HTTP), Yamaha MusicCast (YXC) and Onkyo/Pioneer (eISCP), switches power on, input, volume and sound mode.

| Method | Path | Description |
|---|---|---|
| GET | `/heimnetz` | (Admin) Devices with capabilities, state, settings, log; `basis` `{url, quelle}`, `netze`, `agent`, `render` |
| POST | `/heimnetz/suchen` | (Admin) `{netz?}` Unicast SSDP to every address (also works from a Docker bridge network) → `{funde:[{ip, ort, name, hersteller, modell, bekannt}], netze, adressen}` |
| PUT | `/heimnetz/cast` | (Admin) `{app_id}` app ID of your own Cast receiver (8 hex characters, empty = default receiver); `GET /heimnetz` returns `cast` `{app_id, quelle, empfaenger, https, geraete}` for it |
| GET | `/admin/dienste/anfragen` | (Admin) Requests to third-party services: `{user_agent, edition, installation, dienste: [{dienst, heute, woche, monat, monat_pro, vormonat, gesamt, fehler_monat, seit}]}` |
| PUT | `/heimnetz/basis` | (Admin) `{url}` address at which devices reach the server (empty = detect itself) |
| POST | `/heimnetz/geraete` | (Admin) `{ip}` or `{ort}` (URL of the device description) – check and add |
| PUT | `/heimnetz/geraete/{id}` | (Admin) `{name?, aktiv?, einst?:{einschalten, eingang, tonmodus, aus_minuten, start_vol, max_vol, max_rate, max_bits}}` |
| DELETE | `/heimnetz/geraete/{id}` | (Admin) remove |
| POST | `/heimnetz/geraete/{id}/pruefen` | (Admin) Re-read description, formats and control |
| POST | `/heimnetz/geraete/{id}/klang` | (Admin) `{weg:'original'\|'effekte', befehle, bezug, beschreibung, lautheit, ziel, space}` – `befehle` are the engine commands (`fx`, `kette`), the server renders them with `bin/aw-render`; `space` = `{an, preset, name, kanaele: 6\|4, raten: {44100: hash, 48000: hash}}` (hashes from `POST /heimnetz/raum`) |
| POST | `/heimnetz/raum` | (Admin, form with file `kette`) Store Space commands for one sample rate (`raum`, `raum_ir`, `raum_p`, `raum_m` as JSON lines, up to 16 MB) → `{hash}` |
| POST | `/heimnetz/geraete/{id}/space` | (Admin) Forget the remembered rejection of Space; the current track restarts and tries 5.1 again. `GET /heimnetz` returns per device `klang.space` `{an, preset, name, kanaele, geht: true\|false\|null, grund, zeit}` |
| POST | `/heimnetz/geraete/{id}/tonmodus` | (Admin) `{modus}` – `pure`, `direct`, `stereo`, `mch`, `auto` depending on the manufacturer |
| GET | `/heim/s/{token}` | Stream for the device (signed, without login): original or WAV (converted/with effects), with `Range` and DLNA headers |

## Setup (before the first account)

As long as Amberwave has not been set up (`/einrichtung.php`), the API answers every request with `503` and `{ok:false, einrichtung:true, fehler}`. Clients then show “Server not set up yet” and try again later.
