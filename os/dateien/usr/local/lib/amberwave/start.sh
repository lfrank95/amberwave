#!/bin/bash
# Installiertes Amberwave OS beim Start: Einstellungen von der Datenpartition anwenden (Name, Musik), dann den
# Amberwave-Container starten – beim ersten Mal wird er von GitHub geladen. Alles Nutzer-Eigene liegt unter /daten,
# das System selbst kann jederzeit frisch aufgespielt werden.
set -u
S=/run/amberwave/stand; mkdir -p /run/amberwave
stand() { echo "$1" > "$S"; echo "[amberwave] $1"; }
E=/daten/system/einstellungen
[ -f "$E" ] && . "$E"
AW_NAME="${AW_NAME:-amberwave}"; AW_KANAL="${AW_KANAL:-beta}"; AW_MUSIK_ART="${AW_MUSIK_ART:-intern}"
BILD="ghcr.io/lfrank95/amberwave-aio:$AW_KANAL"

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

# Amberwave: vorhanden → starten, sonst laden und anlegen
if docker inspect amberwave >/dev/null 2>&1; then
  docker start amberwave >/dev/null && stand "laeuft"
  exit 0
fi
stand "Amberwave wird geladen … (einmalig, etwa 400 MB)"
gesamt=0; fertig=0
docker pull "$BILD" 2>&1 | while IFS= read -r z; do
  case "$z" in *"Pulling fs layer"*) gesamt=$((gesamt+1)) ;; *"Pull complete"*) fertig=$((fertig+1)) ;; esac
  [ "$gesamt" -gt 0 ] && echo "Amberwave wird geladen … $(( fertig * 100 / gesamt )) %" > "$S"
done
if ! docker image inspect "$BILD" >/dev/null 2>&1; then
  stand "fehler:Amberwave ließ sich nicht laden – Internet erreichbar? Neuer Versuch beim nächsten Start."
  exit 1
fi
stand "Amberwave startet …"
docker run -d --name amberwave --restart unless-stopped --stop-timeout 60 \
  -p 80:80 -p 9950:80 -v /daten/appdata:/appdata -v /musik:/musik \
  -e TZ="${AW_ZEITZONE:-Europe/Berlin}" -e AMBERWAVE_OS=1 \
  "$BILD" >/dev/null || { stand "fehler:Amberwave ließ sich nicht starten."; exit 1; }
for i in $(seq 1 90); do
  curl -fsS -m 3 http://127.0.0.1/api/v1/ping >/dev/null 2>&1 && { stand "laeuft"; exit 0; }
  sleep 2
done
stand "laeuft"
