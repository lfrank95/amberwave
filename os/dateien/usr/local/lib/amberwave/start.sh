#!/bin/bash
# Installiertes Amberwave OS beim Start: Einstellungen von der Datenpartition anwenden (Name, Musik), dann den
# Amberwave-Container starten – beim ersten Mal wird er von GitHub geladen. Alles Nutzer-Eigene liegt unter /daten,
# das System selbst kann jederzeit frisch aufgespielt werden.
set -u
. /usr/local/lib/amberwave/gemeinsam.sh

# Name im Netz (amberwave.local)
if [ "$(hostname)" != "$AW_NAME" ]; then
  hostnamectl set-hostname "$AW_NAME"
  sed -i "s/^127\.0\.1\.1 .*/127.0.1.1 $AW_NAME/" /etc/hosts
  systemctl restart avahi-daemon
fi

# Musik einbinden
mkdir -p /musik /daten/appdata
case "$AW_MUSIK_ART" in
  platte)
    mountpoint -q /musik || mount -o "${AW_MUSIK_OPTIONEN:-defaults}" "UUID=$AW_MUSIK_UUID" /musik || stand "fehler:Die Musik-Platte wurde nicht gefunden – ist sie angesteckt?" ;;
  nas)
    for i in $(seq 1 30); do
      mountpoint -q /musik && break
      mount -t cifs "$AW_NAS_PFAD" /musik -o "credentials=/daten/system/nas.zugang,iocharset=utf8,vers=3.0,file_mode=0664,dir_mode=0775" 2>/dev/null && break
      stand "Warte auf die Musik-Freigabe $AW_NAS_PFAD …"; sleep 4
    done
    mountpoint -q /musik || stand "fehler:Die Musik-Freigabe $AW_NAS_PFAD ist nicht erreichbar." ;;
  *)
    mkdir -p /daten/musik; mountpoint -q /musik || mount --bind /daten/musik /musik ;;
esac

# Bis Amberwave selbst antwortet: Statusseite auf Port 80 (wer die Adresse schon öffnet, sieht, was passiert)
status_an() { python3 /usr/local/lib/amberwave/status.py & STATUS_PID=$!; }
status_aus() { [ -n "${STATUS_PID:-}" ] && kill "$STATUS_PID" 2>/dev/null; wait "$STATUS_PID" 2>/dev/null; STATUS_PID=; sleep 1; }
trap status_aus EXIT

# Amberwave: vorhanden → starten, sonst laden und anlegen
# (Strom weg mitten im Update: der alte Container heißt noch amberwave-alt → zurückbenennen)
if ! docker inspect amberwave >/dev/null 2>&1 && docker inspect amberwave-alt >/dev/null 2>&1; then
  docker rename amberwave-alt amberwave
fi
if docker inspect amberwave >/dev/null 2>&1; then
  docker start amberwave >/dev/null && stand "laeuft"
  exit 0
fi
# laden – geduldig: direkt nach dem Start ist das Netz oft noch nicht ganz da, und Docker braucht einen Moment
command -v docker >/dev/null || { stand "fehler:Docker fehlt im System – bitte neu installieren."; exit 1; }
status_an
versuch=0
until docker image inspect "$BILD" >/dev/null 2>&1; do
  versuch=$((versuch+1))
  if ! docker info >/dev/null 2>&1; then
    stand "Docker startet …"
    # hängt Docker? Einmal nach einer Minute die Gründe auf die Konsole (Fehlersuche ohne Anmeldung)
    if [ "$versuch" = 20 ]; then systemctl --no-pager -l status docker containerd 2>&1 | tail -n 25; journalctl -u docker -b --no-pager -n 25 2>&1; fi
    [ "$versuch" = 10 ] && systemctl start docker
    sleep 3; continue
  fi
  if ! curl -fsS -m 8 -o /dev/null https://ghcr.io/v2/ 2>/dev/null && ! curl -sS -m 8 -o /dev/null -w '%{http_code}' https://ghcr.io/v2/ 2>/dev/null | grep -q '^[24]'; then
    stand "fehler:Warte auf das Internet … (Amberwave wird beim ersten Start einmalig geladen)"; sleep 10; continue
  fi
  stand "Amberwave wird geladen … (einmalig, etwa 400 MB)"
  gesamt=0; fertig=0
  docker pull "$BILD" 2>&1 | while IFS= read -r z; do
    case "$z" in *"Pulling fs layer"*) gesamt=$((gesamt+1)) ;; *"Pull complete"*) fertig=$((fertig+1)) ;; esac
    [ "$gesamt" -gt 0 ] && echo "Amberwave wird geladen … $(( fertig * 100 / gesamt )) %" > "$S"
  done
  docker image inspect "$BILD" >/dev/null 2>&1 && break
  stand "fehler:Laden unterbrochen – neuer Versuch in 30 Sekunden (Versuch $versuch)"
  sleep 30
done
stand "Amberwave startet …"
status_aus   # Port 80 freigeben
amberwave_anlegen || { stand "fehler:Amberwave ließ sich nicht starten."; exit 1; }
amberwave_antwortet 180 && { stand "laeuft"; exit 0; }
# antwortet nicht: Gründe auf die Konsole (Fehlersuche ohne Anmeldung), Amberwave läuft trotzdem weiter
docker ps -a --format '{{.Names}} {{.Status}} {{.Ports}}' 2>&1
docker logs --tail 40 amberwave 2>&1
stand "fehler:Amberwave antwortet noch nicht – es startet vermutlich noch. Seite in ein paar Minuten neu laden."
