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
| `test_vm.py` | Test in QEMU: Stick → Einrichtung → Installation → Neustart → Amberwave antwortet |

Gebaut und getestet wird in GitHub Actions (`.github/workflows/os.yml`).

Noch offen: Secure Boot (signierter shim), Updates des Containers mit Rollback, Bereich „Gerät“ in den Einstellungen,
Systemupdates, USB-Ersteller für Windows, Raspberry Pi.
