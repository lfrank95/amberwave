#!/bin/bash
# Update von Amberwave aus der App heraus (Verwaltung › Übersicht › „Update installieren“): die App legt den Auftrag
# /appdata/cache/update-installieren ab, aw-update.path startet dieses Skript. Es lädt das neue Paket vollständig,
# tauscht dann erst den Container und geht zurück auf den alten, wenn der neue nicht antwortet.
# Den Stand liest die App aus /appdata/cache/update-stand.json.
set -u
. /usr/local/lib/amberwave/gemeinsam.sh
C=/daten/appdata/cache
exec 9>/run/amberwave/update.lock; flock -n 9 || exit 0
rm -f "$C/update-installieren"
melden() {  # melden <stand> [fehler]
  local f=${2:-}; f=${f//\\/\\\\}; f=${f//\"/\\\"}
  printf '{"stand":"%s"%s}\n' "$1" "${2:+,\"fehler\":\"$f\"}" > "$C/update-stand.json.neu" && mv -f "$C/update-stand.json.neu" "$C/update-stand.json"
  chmod 666 "$C/update-stand.json" 2>/dev/null
  echo "[update] $1 ${2:-}"
}

melden laedt
gesamt=0; fertig=0
docker pull "$BILD" 2>&1 | while IFS= read -r z; do
  case "$z" in *"Pulling fs layer"*) gesamt=$((gesamt+1)) ;; *"Pull complete"*) fertig=$((fertig+1)) ;; esac
  [ "$gesamt" -gt 0 ] && printf '{"stand":"laedt","prozent":%d}\n' $(( fertig * 100 / gesamt )) > "$C/update-stand.json"
done
neu="$(docker image inspect -f '{{.Id}}' "$BILD" 2>/dev/null)"
[ -n "$neu" ] || { melden fehler "Das neue Paket ließ sich nicht laden – besteht eine Internetverbindung?"; exit 1; }
if [ "$(docker inspect -f '{{.Image}}' amberwave 2>/dev/null)" = "$neu" ]; then
  melden fehler "Das neue Paket ist noch nicht fertig gebaut. Bitte in ein paar Minuten erneut versuchen."
  exit 0
fi

# nie zurück auf eine ältere Version (z. B. nach dem Wechsel von Beta auf Stabil) – die Datenbank ist schon weiter
vers() { docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null; }
alt_v="$(vers "$(docker inspect -f '{{.Image}}' amberwave 2>/dev/null)")"; neu_v="$(vers "$BILD")"
if [ -n "$alt_v" ] && [ -n "$neu_v" ] && ! python3 /usr/local/lib/amberwave/version_neuer.py "$neu_v" "$alt_v"; then
  melden fehler "Auf diesem Kanal gibt es noch keine neuere Version als $alt_v."
  exit 0
fi

melden startet
docker rm -f amberwave-alt >/dev/null 2>&1
docker rename amberwave amberwave-alt && docker stop -t 60 amberwave-alt >/dev/null
if amberwave_anlegen && amberwave_antwortet 300; then
  docker rm amberwave-alt >/dev/null
  docker image prune -f >/dev/null 2>&1
  rm -f "$C/update-stand.json"
  echo "[update] fertig"
  exit 0
fi
# zurück auf die alte Version
docker logs --tail 40 amberwave 2>&1
docker rm -f amberwave >/dev/null 2>&1
docker rename amberwave-alt amberwave && docker start amberwave >/dev/null
amberwave_antwortet 180
melden fehler "Die neue Version ist nicht gestartet – Amberwave läuft wieder in der bisherigen Version."
exit 1
