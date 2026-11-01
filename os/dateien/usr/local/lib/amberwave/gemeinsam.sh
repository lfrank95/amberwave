# Gemeinsam für start.sh und aktualisieren.sh: Einstellungen lesen, Container anlegen, auf Antwort warten
S=/run/amberwave/stand; mkdir -p /run/amberwave
stand() { echo "$1" > "$S"; echo "[amberwave] $1"; }
E=/daten/system/einstellungen
[ -f "$E" ] && . "$E"
AW_NAME="${AW_NAME:-amberwave}"; AW_KANAL="${AW_KANAL:-beta}"; AW_MUSIK_ART="${AW_MUSIK_ART:-intern}"
BILD="ghcr.io/lfrank95/amberwave-aio:$AW_KANAL"

# Netz des Geräts direkt (kein Docker-NAT): Amberwave ist auf Port 80 (http://amberwave.local) und 8443 (Direktzugang)
# erreichbar, Heimnetz-Funktionen (DLNA, Cast, Suche der Apps) sehen das echte Netz
amberwave_anlegen() {
  docker run -d --name amberwave --restart unless-stopped --stop-timeout 60 --network host \
    -v /daten/appdata:/appdata -v /musik:/musik \
    -e TZ="${AW_ZEITZONE:-Europe/Berlin}" -e AMBERWAVE_OS=1 -e EINRICHTUNG_FENSTER_MINUTEN=0 \
    "$BILD" >/dev/null
}

# wartet bis zu $1 Sekunden, bis Amberwave auf Port 80 antwortet
amberwave_antwortet() {
  local ende=$(( $(date +%s) + ${1:-180} ))
  while [ "$(date +%s)" -lt "$ende" ]; do
    curl -fsS -m 3 http://127.0.0.1/api/v1/ping 2>/dev/null | grep -q '"app":"amberwave"' && return 0
    sleep 2
  done
  return 1
}
