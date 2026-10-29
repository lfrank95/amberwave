# Usenet: Newznab indexers and multiple download clients

Since 0.2.175, besides Prowlarr, Amberwave can also search directly at **Newznab indexers** (RSS/XML) and hand results over to **several
SABnzbd-compatible download clients**. The existing Prowlarr/SABnzbd setup is preserved unchanged
and remains the “Default”.

Code: `app/includes/downloads.php` (logic), `app/migrations/044_download_dienste.php` (table),
`app/js/dl_anbieter.js` (Settings → Downloads), `app/js/verwaltung.js` (downloads page).

---

## 1. Concepts and structure

| Role | Types | Where stored |
|---|---|---|
| **Search provider** (indexer) | `prowlarr` (JSON API), `newznab` (XML) | Default Prowlarr: Settings/.env · others: table `download_dienste` |
| **Download client** | `sabnzbd` (SABnzbd or compatible) | Default SABnzbd: Settings/.env · others: table `download_dienste` |

- **id 0** is always the default provider or default client. As before, it reads `prowlarr_*` / `sabnzbd_*` from the
  settings (fallback .env). It cannot be deleted, only emptied or switched off.
- **id ≥ 1** are further entries from `download_dienste`.
- Every search provider has a field `client_id` → **its NZB files go to this client**. If the client is missing
  (deleted), it falls back to the default client (0).

```
Suche ──┬─ Prowlarr (0)     ──┐                         ┌─ SABnzbd (0)   → DOWNLOAD_PFAD/
        ├─ Newznab A (1) ─────┼─ Treffer (normalisiert) ─┤
        └─ Newznab B (2) ─────┘   je Treffer: client     └─ NAS-SAB (3)   → DOWNLOAD_PFAD/sab2/
```

### Table `download_dienste`

| Column | Meaning |
|---|---|
| `art` | `prowlarr`, `newznab` or `sabnzbd` |
| `name` | Display name (“Indexer A”, “NAS-SAB”) |
| `url` | Base address without API path, e.g. `https://indexer.example` |
| `api_pfad` | Path of the interface, default `/api` (SABnzbd e.g. `/sabnzbd/api` or `/api/sabnzbd`) |
| `api_key` | stored encrypted (like the other keys), **never** goes to the browser |
| `kategorien` | Indexer: Newznab categories (`3000,3040`) · client: SAB category (`music`) |
| `client_id` | indexers only: assigned download client (0 = default) |
| `import_ordner` | clients only: subfolder of `DOWNLOAD_PFAD` in which this client places its category |
| `musiksuche` | Newznab only: use `t=music` if the indexer offers it |
| `aktiv` | switched-off entries are not searched/used |
| `caps` | remembered response of `t=caps` (JSON) |

`downloads` additionally gets `client_id` (NULL = default client – so all old jobs stay valid), `quelle_id`,
`quelle_art` and `guid`.

---

## 2. Newznab protocol

Address of every request: `url + api_pfad + ?t=…&apikey=…&o=xml`. There are no provider-specific special cases; capabilities
come exclusively from `t=caps`.

| Endpoint | Use |
|---|---|
| `t=caps` | when saving, when testing and (if still unknown) before the first search. Read are `searching/search`, `searching/music-search` including `supportedParams`, `limits/@max` and the category names. |
| `t=search&q=…&cat=…` | general search – always when no music search is possible |
| `t=music&artist=…&album=…&cat=…` | when “Music search” is on, the indexer reports `music-search available="yes"` and the search knows artist/album (search from discography/album page). Only parameters listed in `supportedParams` are sent; otherwise `q`. |

Errors are evaluated uniformly: `<error code="…" description="…"/>` (100–102 → “Key not
accepted”), HTTP 429 or limit messages → “Request limit reached”, no XML → hint about address/API path.
An error from one indexer does not abort the search; it appears above the results.

### Normalization (Newznab → internal release format)

| Internal field | Source in the Newznab `<item>` |
|---|---|
| `titel` | `<title>` |
| `guid` | `newznab:attr name="guid"`, otherwise `<guid>` |
| `url` (server-side only) | `<enclosure url>`, otherwise `<link>` |
| `groesse` | `attr size`, otherwise `<enclosure length>` |
| `kategorien` | `attr category` → names from caps or default list (3000 Audio, 3010 MP3, 3040 Lossless …); the parent category is omitted if a subcategory is present. Without attributes: text from `<category>` |
| `datum`, `alter_tage` | `attr usenetdate`, otherwise `<pubDate>` |
| `grabs` | `attr grabs` |
| `qualitaet` | as before from the name (`dl_qualitaet`) plus `attr audio/bitrate/codec/format` |

`torznab:attr` is read in the same way. Prowlarr results go through `dl_prowlarr_treffer` into the same format. After that,
the following apply unchanged: torrent filter, relevance scoring (`dl_relevanz`), “already present”, sorting and
**duplicate detection** – first by identical GUID, then as before by normalized title (the other sources
are shown under “also:”).

All indexers are queried **simultaneously** (`curl_multi`), so the search takes as long as the slowest one.

---

## 3. SABnzbd clients

Requests go to `url + api_pfad` (default `/api`) with `mode=…&apikey=…&output=json`. This makes any service that
emulates the SABnzbd interface work, even under a different base path such as `/api/sabnzbd`.

| Command | Required? | Purpose |
|---|---|---|
| `version` | mandatory | Reachability, key, “is this a SABnzbd API” |
| `addfile` | mandatory | Hand over NZB |
| `queue`, `history` | mandatory | Progress, finished path, watchdog |
| `get_cats` | optional | Check categories |
| `get_config` | optional | Categories (substitute for `get_cats`), `misc.complete_dir` and category folder for the path comparison |
| `queue&name=delete` | optional | Remove stuck jobs |

Compatible clients often offer only a subset. Therefore the following applies (`dl_sab_kategorien`):

1. First `get_cats` (`{"categories": ["*", "music"]}`).
2. If the client does not know the command or responds unusably, the categories come from
   `get_config → config.categories` (list of `{name, dir, …}`).
3. The configured category is compared against this list; the test result then says “(per get_config)”.
4. `complete_dir` (from `get_config → config.misc.complete_dir`) and the category's folder feed into the check
   “does the client place files where Amberwave reads?” – an absolute category folder (e.g. `/downloads`) counts
   directly, a relative one is appended to `complete_dir`.
5. If both commands are missing, the category is merely “not verifiable” (a hint, not an error). A missing **optional**
   command is never a connection error.

### Error types

`dl_sab` classifies every error (`ApiFehler::extra['sab_art']`, queryable with `dl_sab_fehlerart()`) so that the test
and the reconciliation can distinguish them:

| Type | Detection | Message / tip in the test |
|---|---|---|
| `netz` | no connection | “No connection to …” – is the client running, address/port, not `localhost` |
| `auth` | HTTP 401/403 or error text such as “API Key …”, “Unauthorized” | “API key is not accepted” – API key, not NZB key |
| `pfad` | HTTP 404/405 | “no API responds at …” – API path |
| `modus` | error text such as “Invalid mode”, “not supported”, “not implemented”, “unknown command”; HTTP 501 | “does not support the command …” |
| `antwort` | no JSON (e.g. login page) or wrong structure (`queue` without `queue.slots` …) | “not a SABnzbd interface” / “unexpected response to …” |
| `http`, `fehler` | other HTTP errors or error texts | Text from the client |

Errors are recognized both in the SABnzbd format `{"status": false, "error": "…"}`, as a bare `{"error": "…"}` (without
`status`) and as plain text `error: …`. Previously, a response without a `status` field was read as success.

For every client, the connection test additionally returns the line **“Queue and history retrievable”** (`api`) –
if `queue` or `history` is missing, the client is not usable for Amberwave, and the test says so instead of failing only at the first
download. During the ongoing reconciliation, the structure of `queue`/`history` is checked: an unusable response
is reported, and open jobs are thereby **not** considered vanished and do not fail.

**Import folder:** Amberwave sees the finished downloads under `DOWNLOAD_PFAD` (in the container `/downloads`). The
default client uses the folder itself; every further client gets a **subfolder** of it (`import_ordner`,
e.g. `sab2`). On Unraid, for example, make the second SAB's music folder reachable as `/mnt/user/downloads/complete/music/sab2`
or set `DOWNLOAD_PFAD` to a shared parent folder and give both clients a subfolder. Absolute paths and `..` are rejected.

---

## 4. “Get” flow

1. The browser sends only the search number + result number; URL and key stay on the server.
2. `dl_nzb_holen` loads the NZB **from the result's provider**: Prowlarr with the `X-Api-Key` header, Newznab via the
   supplied link (the `apikey` is only appended if it is missing and the link points to the same host).
3. `dl_holen` hands the file over via `mode=addfile` **exclusively to the provider's assigned client**, with
   its category.
4. The job stores `client_id`, `nzo_id`, `quelle_id`, `quelle_art` and `guid`.

If the assigned client is not set up or is switched off, “Get” is blocked for this result.

## 5. Reconciliation, queue, history, import

`dl_abgleichen_status` groups open jobs by `client_id` and queries queue/history **per client**; an
`nzo_id` is searched only at its own client. The finished path from the history is resolved via that client's import folder,
watchdog, cleanup and “Delete original” remain restricted to its folder. Messages name the client (“No movement in NAS-SAB since …”). If a client is removed/switched off, the job stays put
(“State unknown”) instead of failing; a client with open jobs cannot be deleted.

---

## 6. User interface

**Settings → Downloads**
- *Search providers*: list with status, “+ Newznab indexer”, “+ Prowlarr”. Per entry: name, address, API path, key
  (leave empty = keep), categories, “Downloads with” (client), music search, enabled. “Test connection” in the dialog
  checks the entered values before saving (for Newznab including `t=caps`).
- *Download clients*: “+ SABnzbd”; name, address, API path, key, category, import folder.
- *Full check*: checks every provider and client, their folders and whether category folder and mount match.

**Downloads**: header line “Search: … · Download: …” with status per service; errors of individual indexers above the results;
with more than one client, the result shows “→ client”; the job list shows the client.

## 7. API

| Method | Path | |
|---|---|---|
| GET | `/admin/downloads/dienste` | all providers/clients (without keys, with `key_gesetzt`) |
| POST | `/admin/downloads/dienste` | create/change (`id` 0 = default) |
| POST | `/admin/downloads/dienste/loeschen` | `{art, id}` |
| POST | `/admin/downloads/dienste/test` | check values without saving |
| POST | `/admin/downloads/suche` | additionally optional `kuenstler`, `album` (for `t=music`) |

## 8. Configuration (.env)

New and optional, both also configurable in the interface:

```
SABNZBD_API_PFAD=/api          # Default client behind a proxy: /sabnzbd/api
SABNZBD_IMPORT_ORDNER=         # Subfolder of DOWNLOAD_PFAD for the default client
```

Further indexers and clients are created only in the interface.

## 9. Backward compatibility

- Existing Prowlarr/SABnzbd values (settings or .env) become “Prowlarr” (0) and “SABnzbd” (0) – without
  migration, the keys stay where they were.
- Old jobs have `client_id = NULL` and are assigned to the default client; reconciliation and import run as before.
- Without additional entries, everything behaves as before 0.2.175 (same requests to Prowlarr and SABnzbd).
- Real SABnzbd installations continue to be checked via `get_cats`; the only new thing is the line “Queue and history
  retrievable” (two additional read requests during the test).

## 10. Tests

Against a replica Prowlarr, two Newznab indexers (one with, one without music search) and two SAB clients
(`/sab1/api`, `/sab2/api/sabnzbd`):

| Test | Content | Result |
|---|---|---|
| Regression Prowlarr/SABnzbd | Check, search, duplicates, quality, get with key, nzo_id, reconciliation, import, delete original, error case, state – identical before and after the rework | 19/19 |
| Extension | caps, t=search/t=music, normalization, error codes, parallel search, dedup via GUID, indexer→client assignment, base path `/api/sabnzbd`, queue/history/import per client, same nzo_id in two clients, delete/switch off, key never in the result | 47/47 |
| Watchdog | stuck/vanished jobs | passed |
| SABnzbd-compatible clients (0.2.176) | classify error texts, categories via get_cats or get_config, complete_dir, test against client without get_cats (responses as above), without get_config, without queue, with wrong queue structure, web interface instead of API, 403, wrong key (status:false), no connection, 404; get/reconciliation/import via the compatible client; unusable queue does not make jobs fail | 36/36 |
| Browser | Settings and downloads page, getting a Newznab result to the second client, no JS errors | passed |
