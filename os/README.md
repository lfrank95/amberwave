# Amberwave OS

Amberwave als eigenes Gerät: USB-Stick erstellen, davon starten, im Browser einrichten, auf die interne SSD installieren.
Für Leute, die nie ein Terminal öffnen wollen.

- **Unterbau:** Debian 13 (minimal), Docker, Avahi (`amberwave.local`). Amberwave selbst ist der All-in-One-Container
  (`ghcr.io/lfrank95/amberwave-aio`) und wird beim ersten Start geladen – das Image muss nur für neue Debian-Versionen
  neu gebaut werden.
- **Platte:** `aw-efi` (Start) · `aw-system` (8 GB, jederzeit neu aufspielbar) · `aw-daten` (Einstellungen, Datenbank,
  Cover, Docker-Images, auf Wunsch Musik). Alles, was der Nutzer einstellt, liegt auf `aw-daten` – eine Neuinstallation
  mit dem Stick erkennt die Datenpartition und behält sie.
- **Bildschirm:** zeigt immer die Adresse (`http://amberwave.local` und die IP) und den Stand; keine Anmeldung.

| Datei | Zweck |
|---|---|
| `bauen.sh` | baut `amberwave-os-<version>.img` (mmdebstrap, squashfs, GRUB für UEFI) |
| `grub-stick.cfg` | Startmenü des Sticks (Live-System, läuft im RAM) |
| `dateien/` | wird ins System kopiert: Dienste, Netzwerk, Docker-Einstellungen |
| `dateien/usr/local/lib/amberwave/installer.py` | Einrichtung im Browser (nur vom Stick) |
| `dateien/usr/local/lib/amberwave/installieren.sh` | Partitionieren, System kopieren, GRUB, Einstellungen |
| `dateien/usr/local/lib/amberwave/start.sh` | installiertes System: Name, Musik einbinden, Amberwave laden und starten |
| `dateien/usr/local/lib/amberwave/anzeige.sh` | Bildschirm des Geräts |
| `ersteller/` | USB-Ersteller für Windows: nur USB-Sticks/SD-Karten, Image von GitHub oder Datei, schreiben und prüfen |
| `ci_bilder.sh` | Bildschirmfotos der Tests in den Zweig `ci-bilder` |
| `test_vm.py` | Test in QEMU: Stick → Einrichtung → Installation → Neustart → Amberwave antwortet |

Gebaut und getestet wird in GitHub Actions (`.github/workflows/os.yml`).

## Auf echter Hardware testen

1. Image laden: Actions › *Amberwave OS* › letzter erfolgreicher Lauf › Artefakt `amberwave-os-img` (ZIP mit der `.img`).
2. Auf einen USB-Stick (≥ 2 GB) schreiben – mit dem **Amberwave USB-Ersteller** (Artefakt `usb-ersteller`, „Image-Datei
   wählen …“), Rufus (Modus „DD-Image“) oder balenaEtcher. Ab dem nächsten Release lädt der Ersteller das Image selbst.
3. PC mit Netzwerkkabel am Router, Stick einstecken, beim Start das Startmenü der Firmware öffnen (meist F11, F12, F8
   oder Esc) und den Stick wählen. Secure Boot darf an bleiben; der PC muss UEFI können (praktisch alles ab ~2012).
4. Am Bildschirm steht die Adresse – auf Handy oder PC öffnen, Platte wählen, installieren, Stick abziehen.

Voraussetzungen: x86-64 mit UEFI, ≥ 2 GB RAM (4 GB empfohlen), interne Platte ≥ 16 GB, Netzwerkkabel (WLAN folgt).

Noch offen: Updates des Containers mit Rollback, Bereich „Gerät“ in den Einstellungen,
Systemupdates, Raspberry Pi.
