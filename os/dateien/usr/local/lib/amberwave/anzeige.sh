#!/bin/bash
# Bildschirm des Geräts (tty1): groß die Adresse, unter der Amberwave im Browser erreichbar ist, und der aktuelle Stand.
# Niemand muss sich anmelden – das ist alles, was am Gerät selbst zu sehen ist.
A=$'\e[38;5;214m'; H=$'\e[1m'; L=$'\e[38;5;245m'; G=$'\e[38;5;114m'; R=$'\e[38;5;203m'; N=$'\e[0m'
LIVE=0; grep -qw 'boot=live' /proc/cmdline && LIVE=1
VERSION="$(cat /etc/amberwave-version 2>/dev/null)"
vorher=""
setterm --blank 0 --powerdown 0 2>/dev/null
# große, gut lesbare Schrift (auch am Fernseher); fehlt sie, bleibt die Standardschrift
setfont /usr/share/consolefonts/Lat15-TerminusBold32x16.psf.gz 2>/dev/null || setfont /usr/share/consolefonts/Lat15-Terminus24x12.psf.gz 2>/dev/null
while true; do
  NAME="$(hostname)"
  IPS="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|lo)/ {split($4,a,"/"); if (a[1] != "10.42.0.1") print a[1]}' | paste -sd' ')"
  HOTSPOT="$(cat /run/amberwave/hotspot 2>/dev/null)"
  STAND="$(cat /run/amberwave/stand 2>/dev/null)"
  bild="$LIVE|$NAME|$IPS|$STAND|$HOTSPOT"
  if [ "$bild" != "$vorher" ]; then
    vorher="$bild"
    printf '\e[2J\e[H\n\n'
    printf '   %s%sA M B E R W A V E%s   %s%s%s\n\n' "$A" "$H" "$N" "$L" "$VERSION" "$N"
    if [ "$LIVE" = 1 ]; then
      printf '   %sEinrichtung%s - öffne auf einem Handy oder PC im selben Netz:\n\n' "$H" "$N"
    else
      printf '   %sAmberwave%s - im Browser öffnen:\n\n' "$H" "$N"
    fi
    if [ -n "$HOTSPOT" ] && [ -z "$IPS" ]; then
      printf '      Mit dem Handy ins WLAN  %s%s%s%s  gehen -\n' "$A" "$H" "$HOTSPOT" "$N"
      printf '      die Einrichtung öffnet sich von selbst (sonst: %shttp://10.42.0.1%s)\n' "$A" "$N"
      printf '\n      %sOder ein Netzwerkkabel einstecken.%s\n' "$L" "$N"
    elif [ -n "$IPS" ]; then
      printf '      %s%shttp://%s.local%s\n' "$A" "$H" "$NAME" "$N"
      for ip in $IPS; do printf '      %s%shttp://%s%s\n' "$A" "$H" "$ip" "$N"; done
    else
      printf '      %sWarte auf das Netzwerk ... Netzwerkkabel eingesteckt?%s\n' "$R" "$N"
    fi
    printf '\n'
    if [ -n "$STAND" ]; then
      case "$STAND" in fehler:*) printf '   %s%s%s\n' "$R" "$(printf '%s' "${STAND#fehler:}" | sed 's/…/.../g; s/–/-/g')" "$N" ;; laeuft*) printf '   %s* %s%s\n' "$G" "Amberwave läuft" "$N" ;; *) printf '   %s%s%s\n' "$L" "$(printf '%s' "$STAND" | sed 's/…/.../g; s/–/-/g')" "$N" ;; esac
    fi
    printf '\n\n   %sEnglish: open the address above in a browser on your phone or PC.%s\n' "$L" "$N"
  fi
  sleep 2
done
