#!/bin/bash
# Installiertes Amberwave OS beim Start: Einstellungen von der Datenpartition anwenden (Name, Musik), dann den
# Amberwave-Container starten – beim ersten Mal wird er von GitHub geladen. Alles Nutzer-Eigene liegt unter /daten,
# das System selbst kann jederzeit frisch aufgespielt werden.
set -u
. /usr/local/lib/amberwave/gemeinsam.sh

# Name im Netz (amberwave.local)
if [ "$(hostname)" != "$AW_NAME" ] || [ "$(cat /etc/hostname 2>/dev/null)" != "$AW_NAME" ]; then
  echo "$AW_NAME" > /etc/hostname
  hostname "$AW_NAME"
  sed -i "s/^127\.0\.1\.1 .*/127.0.1.1 $AW_NAME/" /etc/hosts
  systemctl restart avahi-daemon
fi

# Musik einbinden
musik_einbinden

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
# Amberwave-Paket vom Stick (bei der Installation mitkopiert): auspacken statt aus dem Internet laden
PAKET=/daten/system/amberwave-aio.tar.zst
if [ -f "$PAKET" ] && ! docker image inspect "$BILD" >/dev/null 2>&1; then
  for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; stand "Docker startet …"; sleep 2; done
  stand "Amberwave wird ausgepackt … (einmalig, ein, zwei Minuten)"
  if zstd -dc "$PAKET" | docker load >/dev/null 2>&1 && docker image inspect "$BILD" >/dev/null 2>&1; then
    echo "[amberwave] Paket vom Stick geladen"
  else
    stand "Das Paket vom Stick passt nicht – lade Amberwave stattdessen aus dem Internet …"
  fi
  rm -f "$PAKET"   # Platz zurück; Updates kommen ohnehin aus dem Internet
fi
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
