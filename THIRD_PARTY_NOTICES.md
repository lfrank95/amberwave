# Third-party components

Amberwave itself is licensed under AGPL-3.0-only (see `LICENSE`). It ships with or downloads the components below, each under
its own license. Please check the upstream projects for the exact, current terms.

## Bundled in this repository

| Component | Where | License |
|---|---|---|
| dr_flac, dr_wav (David Reid) | `windows-client/engine/dr_flac.h`, `dr_wav.h` | Public domain or MIT-0 (your choice) |
| VST3 SDK interfaces (Steinberg) – only `pluginterfaces` and IID definitions, not shipped as source here | built into `amberwave-vsthost.exe` | MIT |
| Manrope (Mikhail Sharanda) | `app/fonts/manrope-*.woff2` | SIL Open Font License 1.1 (`app/fonts/OFL-Manrope.txt`) |
| Space Grotesk (Florian Karsten) | `app/fonts/spacegrotesk-*.woff2` | SIL Open Font License 1.1 (`app/fonts/OFL-SpaceGrotesk.txt`) |

## Part of the Docker image / stack

| Component | Used for | License |
|---|---|---|
| PHP (official `php:8.3-apache` image) | runtime | PHP License 3.01 |
| Apache HTTP Server | web server | Apache-2.0 |
| FFmpeg (Debian package) | decoding, transcoding, analysis | GPL-2.0-or-later (Debian builds enable GPL parts) |
| Python 3, NumPy (Debian packages) | built-in sound analysis | PSF-2.0, BSD-3-Clause |
| MariaDB (official image, separate container) | database | GPL-2.0 |
| cloudflared (official image, separate container, optional) | Cloudflare Tunnel | Apache-2.0 |
| Debian base packages | operating system | various (see `/usr/share/doc/*/copyright` in the image) |

## Windows client

| Component | License |
|---|---|
| Electron | MIT |
| Chromium (inside Electron) | BSD-3-Clause and others (see `LICENSES.chromium.html` next to the exe) |
| Node.js (inside Electron) | MIT |

## Downloaded only on the admin's request

These are not shipped. Amberwave fetches them only after an admin clicks the corresponding button and confirms the license shown.

| Component | Used for | License |
|---|---|---|
| Essentia + TensorFlow (`essentia-tensorflow`, pip) | extended sound analysis | AGPL-3.0 (Essentia), Apache-2.0 (TensorFlow) |
| Discogs-EffNet models (MTG, Universitat Pompeu Fabra) | extended sound analysis | CC BY-NC-SA 4.0 – **non-commercial use only** |
| Voxengo IM Reverbs impulse responses | AmberSpace room simulation | Voxengo license, shown before download |

## Online services

Amberwave talks to these services; their terms apply to that use (each needs your own key where noted):
MusicBrainz and Cover Art Archive (data CC0 / per image), AcoustID (own API key, non-commercial use free),
fanart.tv (own API key), Deezer API (public endpoints), ListenBrainz, Cloudflare (tunnel and DNS, optional),
Let's Encrypt (certificates, optional), your own Prowlarr / Newznab indexers / SABnzbd (optional, off by default).
