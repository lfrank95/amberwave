# Free code signing via SignPath Foundation – prepared, not yet applied

Goal: Windows client and Windows server installers signed by SignPath Foundation (free for OSS), so SmartScreen
reputation is tied to one certificate instead of resetting with every release.

Apply when Amberwave has a visible user base (SignPath requires "verifiable reputation" for executable programs).
Signals to point to: stars/forks on GitHub, release download counts, Unraid Community Applications listing, forum threads.

Terms: https://signpath.org/terms · Apply: https://signpath.org/apply

## Checklist

| Condition | Status |
|---|---|
| OSI license, no commercial dual licensing | AGPL-3.0-only ✓ |
| No proprietary components | ✓ – all bundled parts are OSS (THIRD_PARTY_NOTICES.md); ASIO via own header, no Steinberg ASIO SDK; VST3 SDK interfaces are MIT; Voxengo impulses are not shipped |
| Released in the form to be signed, documented | ✓ – GitHub releases, https://amberwave.app |
| Binaries built from source in CI | ✓ – `.github/workflows/windows-client.yml`, `.github/workflows/windows-server.yml` |
| File metadata on all own binaries | ✓ – product name, description, version, copyright on every exe (checked in CI) |
| Privacy policy for the software | ✓ – https://amberwave.app/datenschutz-app.html |
| Uninstaller | ✓ – client and server, entry under Settings › Apps |
| No hidden system changes | ✓ – per-user install without admin rights |
| MFA for all team members (GitHub, SignPath) | ☐ – enable on GitHub before applying |
| Code signing policy on homepage and download pages | ☐ – `code-signing-policy.html` is ready; publish **only after approval** (it states that signing is provided) |
| Upstream binaries in packages | Unsigned upstream DLLs/exes (PHP, nginx, MariaDB, ffmpeg, cloudflared, Electron) are allowed inside signed packages |

## After approval

1. Copy `code-signing-policy.html` to `site/`, link it in the footer and next to the downloads ("Code signing policy").
2. SignPath project: product name "Amberwave", enforce metadata restrictions on all signed binaries.
3. Workflows: after the build, submit the installer (and own exes) with `signpath/github-action-submit-signing-request`,
   wait for manual approval (Lorenzo), upload the signed result as artifact. Secret: `SIGNPATH_API_TOKEN`.

## Draft application text

**Project:** Amberwave – self-hosted music server with web app, Windows client, Windows server and Android app.
**Repository:** https://github.com/lfrank95/amberwave · **Homepage:** https://amberwave.app
**License:** AGPL-3.0-only
**What we sign:** the Windows client installer (Electron shell, own audio engine `amberwave-engine.exe`, VST3 host) and the
Windows server installer (tray program, renderer, bundled PHP/nginx/MariaDB/ffmpeg/cloudflared).
**Build:** GitHub Actions from the public repository, cross-compiled with llvm-mingw; no local builds for releases.
**Team:** Lorenzo Frank (author, reviewer, approver).
