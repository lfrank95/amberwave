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
    $( [ "$AW_MUSIK_ART" = intern ] && echo "-e MUSIK_SCHREIBEN=1" ) \
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

# Musik nach den Einstellungen unter /musik einbinden (intern, USB-Platte oder Netzwerkfreigabe).
# Amberwave läuft im Container als UID 99 / GID 100 (Standard, solange der Ordner niemand anderem gehört) – damit es dort schreiben darf (Tags, Aufräumen, Downloads,
# Amberwave Connect), gehört ihm der Musikordner auf dem Gerät; Platten ohne Linux-Rechte (FAT, exFAT, NTFS) und
# Freigaben werden für diesen Benutzer eingebunden. Ob Amberwave wirklich schreibt, entscheidet die Einstellung in der App.
musik_einbinden() {
  mkdir -p /musik /daten/appdata
  case "$AW_MUSIK_ART" in
    platte)
      local opt="${AW_MUSIK_OPTIONEN:-defaults}" typ
      typ="$(blkid -s TYPE -o value "/dev/disk/by-uuid/$AW_MUSIK_UUID" 2>/dev/null)"
      case "$typ" in vfat|exfat|ntfs|ntfs3) opt="$opt,uid=99,gid=100,umask=002" ;; esac
      mountpoint -q /musik || mount -o "$opt" "UUID=$AW_MUSIK_UUID" /musik || stand "fehler:Die Musik-Platte wurde nicht gefunden – ist sie angesteckt?"
      # Linux-Dateisystem, nicht schreibgeschützt: der oberste Ordner gehört Amberwave (für neue Ordner wie „Connect“)
      if mountpoint -q /musik && [ "$opt" != ro ] && [ "$(stat -c %u /musik)" = 0 ]; then chown 99:100 /musik; chmod 775 /musik; fi ;;
    nas)
      for i in $(seq 1 30); do
        mountpoint -q /musik && break
        mount -t cifs "$AW_NAS_PFAD" /musik -o "credentials=/daten/system/nas.zugang,iocharset=utf8,vers=3.0,uid=99,gid=100,file_mode=0664,dir_mode=0775" 2>/dev/null && break
        stand "Warte auf die Musik-Freigabe $AW_NAS_PFAD …"; sleep 4
      done
      mountpoint -q /musik || stand "fehler:Die Musik-Freigabe $AW_NAS_PFAD ist nicht erreichbar." ;;
    *)
      mkdir -p /daten/musik
      [ "$(stat -c %u /daten/musik)" = 0 ] && chown -R 99:100 /daten/musik
      mountpoint -q /musik || mount --bind /daten/musik /musik ;;
  esac
}
