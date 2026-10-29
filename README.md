# Amberwave

**A self-hosted music server for your family's collection** – listen in the browser, as an installable web app (PWA) or
in a bit-perfect Windows client. At home you get the original files, on the go a smooth stream; every device can
remote-control every other one. Metadata comes from MusicBrainz, with credits down to producers and session musicians.

> **Public beta – 0.9.0-beta.4.** Please back up your music before you try it. Amberwave only **reads** your music
> by default; it writes nothing until you allow it. *Deutsche Anleitung: [README.de.md](README.de.md)*

<!-- Screenshots: add docs/screenshots/*.png here (record crate, now playing, remote control, effects rack) -->

## What it does

- **Your library, cleaned up:** FLAC, ALAC, MP3, Opus, OGG, WAV, AIFF, WavPack and more. Albums are matched against
  MusicBrainz (all editions, track-by-track comparison), plus recognition by sound (AcoustID) for untagged files.
  Credits link artists, producers, songwriters and musicians with their instruments.
- **Plays everywhere:** web app for desktop, tablet and phone (installable, lock-screen controls, offline listening),
  gapless playback, loudness normalisation (EBU R128), "now playing" with a record-crate view of your queue.
- **Remote streaming:** at home the original file, on the go Opus 256/160/128 depending on device and network –
  remembered per device. Remote access via the built-in Cloudflare Tunnel, Tailscale/WireGuard or your own reverse proxy.
- **Remote control:** your phone controls the PC, the PC controls the living-room client – queue, volume, skip.
  Also plays to DLNA/UPnP renderers (AV receivers, streamers) and Google Cast devices.
- **Windows client:** bit-perfect output via WASAPI exclusive or ASIO, sample rate follows the file, gapless,
  plus effects (tube, transformer, tape, EQ, 5.1 upmix with real room responses) and your own VST3 plug-ins.
- **Family accounts:** registration with approval, expiry, per-user history, favourites, shared playlists, radios.
- **Optional:** tidy up files and tags (preview first, then your approval), Usenet search via Prowlarr/Newznab with
  SABnzbd (off by default), WAV export for mixing desks.

## Quick start (Docker)

You need Docker with Compose on a Linux host or NAS with an x86-64 CPU (Unraid, Synology, TrueNAS, a plain Linux box).
ARM devices such as a Raspberry Pi are not supported yet.

1. Create a folder, e.g. `/opt/amberwave`, and put [`docker-compose.yml`](docker-compose.yml) and
   [`.env.example`](.env.example) into it.
2. Copy `.env.example` to `.env` and set the paths: `MUSIK_PFAD` (your music), `APPDATA_PFAD` (Amberwave's own data –
   SSD recommended) and, if you like, `APP_PORT` (default 9950). Leave `PUID`/`PGID` empty unless you know you need them
   (Unraid: `99`/`100`).
3. `docker compose up -d`
4. Open the setup link from `docker logs amberwave_app` (e.g. `http://<server>:9950/einrichtung.php?code=…`). The assistant
   checks folders and permissions, asks whether Amberwave may write to your music folder (default: no), creates the
   database and your admin account, and scans your music.
   - The link in the log already contains the **setup code**; without it the page asks for the code. The setup window
     closes 30 minutes after the container starts (restart the container to reopen it).
5. Match albums with MusicBrainz ("Match" on an album, or automatically by sound with a free AcoustID key).

**Update:** `docker compose pull && docker compose up -d` – database changes run automatically. The admin overview tells
you when a new release is out (switch off under Settings → Backup & update).

**Unraid:** install the **Docker Compose Manager** plugin from Apps, then Docker tab → **Add New Stack** (`amberwave`)
→ ⚙ **Edit Stack → Compose File** (paste `docker-compose.yml`) and **Edit Stack → ENV File** (paste `.env.example`, e.g.
`MUSIK_PFAD=/mnt/user/music`, `APPDATA_PFAD=/mnt/cache/appdata/amberwave`, `PUID=99`, `PGID=100`) → **Compose Up**.
The setup link is in the logs of the `amberwave_app` container. Update with **Update Stack**.

**Self-build instead of the image:** [`docker-compose.build.yml`](docker-compose.build.yml) (mounts the code as a folder;
updates then come as a zip under Settings → Backup & update). Every `.env` option is documented (in German) in
[`.env.reference`](.env.reference) – almost all of them can also be changed in the app.

## Safety defaults

- **Music folder read-only:** writing tags, tidy-up, download import and the trash folder stay locked until you allow
  writing (setup assistant or Settings → Library & automation → Music folder, or `MUSIK_SCHREIBEN=1`). For a hard
  guarantee also mount it read-only: `MUSIK_MOUNT_MODUS=ro`.
- Even with writing allowed nothing happens on its own: tidy-up always shows a preview and only runs what you approve;
  replaced files go to `.amberwave-papierkorb` inside your music folder.
- **Usenet downloads are off** until you switch them on (Settings → Downloads). You are responsible for what you download.
- No telemetry. Amberwave talks to MusicBrainz, Cover Art Archive, AcoustID, fanart.tv, Deezer and ListenBrainz for
  metadata, to GitHub for the update notice, and – only if you set them up – to Cloudflare and your own services.

## Remote access

- **Cloudflare Tunnel** (included in the stack, needs your own domain on Cloudflare): Settings → Access & network →
  "When you are away: Cloudflare Tunnel". Amberwave creates the tunnel and DNS record; no open router port, works behind CGNAT. Cloudflare's
  [terms](https://www.cloudflare.com/terms/) apply – streaming household amounts of music is a grey area there.
  Not using it? Set `TUNNEL_IM_STACK=0`.
- **Tailscale / WireGuard:** open `http://<vpn-ip>:9950`. Without HTTPS the web app can't be installed or used offline –
  put a proxy with a certificate in front, or use Tailscale's HTTPS.
- **Your own reverse proxy** (Nginx Proxy Manager, Traefik, Caddy): point it at `http://<server>:9950` and set
  `APP_URL=https://music.example.com` and `PROXY_IPS=<proxy IP>` in `.env`.

## Windows client

Download it from the [releases](../../releases). It is not code-signed yet, so Windows SmartScreen shows "Windows
protected your PC" on first start: click **More info → Run anyway**. The client finds your server in the home network by
itself. Details (German): [windows-client/README.md](windows-client/README.md).

## Known limitations of the beta

- Docker image for amd64 only (arm64 needs the effects renderer ported).
- Code comments and parts of the documentation are German; the app itself is German and English.
- The Windows client is unsigned and has no auto-update yet.

## Feedback

- Bugs: [GitHub issues](../../issues) (templates included) · questions and ideas: [r/Amberwave](https://www.reddit.com/r/Amberwave)
- Security problems: please report privately, see [SECURITY.md](SECURITY.md).
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) (includes a short CLA).

## License

Amberwave is licensed under the **GNU Affero General Public License v3.0** – see [LICENSE](LICENSE).
Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). History: [CHANGELOG.md](CHANGELOG.md).
