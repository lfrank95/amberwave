# Amberwave – Concept & Decisions

This file records all decisions so that work can continue seamlessly in a new chat.

## Principles
- Standalone app (not part of the book archive), same design language (Liquid Glass Dark, Space Grotesk + Manrope), **amber** accent.
- Name **Amberwave** (changeable via `APP_NAME`). Run a trademark search (DPMA/EUIPO) before any commercial use.
- Stack: PHP 8.3 + Apache + MariaDB in Docker on Unraid, reachable via Cloudflare Tunnel.
- Music on the array (mounted read-only), database and cache (covers, images, MusicBrainz responses) on the SSD.
- All configuration values via the `.env`; admin settings in the UI take precedence, secrets encrypted.
- Own account management with the building blocks of the book archive (approval, 1–24 months, renewal adds up, blocking, rate limits, 8-character passwords without mandatory special characters, no 2FA, no external services).

## Data model (modeled on MusicBrainz)
- Album = release group, edition = release, disc = medium, track, recording, work.
- Artist credits are lists of real artist objects with a join word (“Bruno Mars & Lady Gaga” is attached to both).
- Relationships: one general table *artist –role→ album/edition/recording/work/artist* with instruments and attributes (guest, co-, additional).
- MBIDs optional everywhere; source per object (tags / musicbrainz / manual) and locked fields against overwriting.
- The database is the source of truth; tags are not (yet) written back to files.

## Workflows
- **Import** without prompts; artists are only split if the tags name them individually (ARTISTS/multi-values).
- **MusicBrainz matching** only via “Edit metadata / Match”: show all editions (search + full reload of the best release groups), filters, row-by-row comparison, then apply. At most 1 request/second, custom user agent.
- **Displayed edition** for the family: most tracks, newest on a tie; admin can override. If the displayed edition lacks contributors, those of a matched sibling edition are shown.
- **Editing** works directly from the library (album, track, artist). Changed track fields are locked automatically (`tracks.gesperrte_felder`), scan and matching leave them alone.
- **Requests** will run via Lidarr in future (v0.2), low priority.
- **Texts** (bios, album descriptions) preferably in German: German Wikipedia, otherwise English + AI translation, labeled as such (v0.2).
- **Artist images** from fanart.tv (free project key), otherwise upload (v0.2).

## Playback
- Family: streaming only (downloads off, `DOWNLOADS_ERLAUBT`), PWA, no Subsonic.
- Original (FLAC, with range) or transcoded live with ffmpeg: Opus 256/160/128, AAC as fallback for browsers without Opus.
- Gapless via Media Source Extensions: one continuous timeline in the browser; at home FLAC per track attached sample-accurately
  (length from STREAMINFO), on the go Opus chains per album (one encoder pass across the track boundaries). Files remain unchanged.
- Single-page app so the music keeps playing while navigating; tab bar at the bottom on phones; start page: Continue listening + New arrivals.

## Phase 2: Windows player (native, e.g. JUCE)
- Uses the same API `/api/v1` with a device key (`POST /auth/token`), fetches files bit-perfect (`q=original`).
- ASIO / WASAPI exclusive, output profiles with freely named channels (e.g. 1+2 front, 3–6 C/Sub/SL/SR, 7+8 headphones), optional bass management.
- Optional M/S upmix (stereo → surround) with a strength control 0–150 % (dB curve; delay/filter/decorrelation fixed in the preset), A/B with level matching, automatically off for multichannel/mono, memorable per album, shown in the signal path. Values from the Cubase experiments become the preset “Subtle”.
- VST3 chain per profile/output pair (“for seasoning”), signal path display, fixed or digital volume.
- Settings per device are stored by the server (`/geraet/einstellungen`); live channel for remote control is planned.

## Ideas for later (discussed, not yet built)

### Warmth EQ and transient/sustain for AmberGlow (later also AmberSilk) – as of 21.10.2026
- **Drive curve (“where does it saturate”):** EQ-like curve with draggable points. Before the nonlinearity the signal is boosted according to the curve,
  afterwards lowered again exactly (principle of recording equalization on tape) – no band splitting, no
  crossover artifacts, no phase problems. Example: +6 dB at 100 Hz → bass saturates strongly, the rest hardly.
- **Mix curve (“where is it audible”):** only the difference between tube and original is filtered:
  output = original + curve × (tube − original). Both paths run in sync, so it is exactly the original wherever the curve
  is at 0. Example: harmonics in the mids yes, in the highs no.
- UI: reuse the existing EQ editor (eqansicht.js, draggable points).
- **Transient/sustain separated:** fast and slow envelope → mask 0…1 that splits the signal into attack and decay
  (sum = original). Separate drive and mix per part, e.g. attack clean (punch is kept), decay
  saturated (density) – or the other way around (bite on the attack).
- Combined: two-dimensional “warmth map” (frequency × attack/decay).
- Presets for beginners (“Keep punch”, “Thicken bass”, “Clean highs”), curves for advanced users.
- Order, if built: transient/sustain first (two controls under Advanced, audible immediately), then the warmth EQ.
- Low CPU load (a few filters and envelopes), runs in the browser as in a later plug-in.
- Classification: multiband saturators (e.g. FabFilter Saturn) and transient-dependent saturation exist individually; the
  combination with difference mix and curve editor would be unique (not researched).

## Versions
- v0.1: skeleton, accounts, import, library, player, MusicBrainz matching, admin.
- v0.2: fanart.tv, Wikipedia + translation, Lidarr, write back tags, gapless.
