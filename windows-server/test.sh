#!/bin/bash
# Rauchtest des fertigen Windows-Server-Pakets (GitHub-Windows-Rechner): erster Start mit leerer Datenbank → Einrichtung
# im Browser-Ablauf → Scan → Streaming → sauber beenden → zweiter Start (Daten bleiben). Aufruf: test.sh <Paketordner>
set -u
PAKET="$1"; W='C:\aw'; WU=/c/aw
mkdir -p "$WU/musik"; FEHLER=0; : > "$WU/ergebnis.txt"
ok() { echo "ok: $*" | tee -a /c/aw/ergebnis.txt; }
# Logs als Hinweise am Lauf (die Ausgabe selbst ist nur im Browser lesbar)
melden() { for f in "$@"; do [ -f "$f" ] || continue; echo "::warning title=$(basename "$f")::$(tail -c 2500 "$f" | tr -d '\r' | tr '\n' '|' | sed 's/%/%25/g')"; done; }
fehler() { echo "::error title=Windows-Server::$*"; echo "FEHLER: $*" >> /c/aw/ergebnis.txt; FEHLER=1; }
trap 'melden /c/aw/ergebnis.txt' EXIT
FF="$PAKET/ffmpeg/bin/ffmpeg.exe"
mk() { mkdir -p "$WU/musik/$1"; "$FF" -v error -y -f lavfi -i "sine=f=$3:d=8" -ac 2 -ar 44100 -metadata title="$2" -metadata artist="Björk Ångström" -metadata album_artist="Björk Ångström" -metadata album="Über Grenzen" -metadata track="$4" -metadata date=2021 "$WU/musik/$1/$5"; }
mk "Björk Ångström/2021 - Über Grenzen" "Straße" 440 1 "01 - Straße.flac"
mk "Björk Ångström/2021 - Über Grenzen" "Wham! 100%" 550 2 "02 - Wham! 100%.flac"

starten() { ( cd "$PAKET" && ./"Amberwave Server.exe" --konsole --dauer 1200 --musik "$W\\musik" --daten "$W\\daten" > "$WU/konsole_$1.txt" 2>&1 ) & }
warten() { for i in $(seq 1 120); do curl -s -o /dev/null http://127.0.0.1:9950/login.php && return 0; sleep 2; done; return 1; }
stoppen() {
    touch "$WU/daten/stopp"
    for i in $(seq 1 90); do [ -f "$WU/daten/stopp" ] || break; sleep 1; done
    for i in $(seq 1 90); do tasklist //FI "IMAGENAME eq Amberwave Server.exe" | grep -q "Amberwave" || return 0; sleep 1; done
    return 1
}
log() { cat "$WU/daten/logs/server.log" 2>/dev/null; }

echo "== 0. Effekt-Rechner (Geräte im Heimnetz)"
echo '{"c":"kette"}' > "$WU/kette.jsonl"
N="$("$FF" -v error -f lavfi -i "sine=f=440:d=1" -f f32le -ac 2 -ar 48000 - | "$PAKET/app/bin/aw-render.exe" 48000 2 24 "$W\\kette.jsonl" 0 2>/dev/null | wc -c)"
[ "$N" = 288000 ] && ok "aw-render.exe rechnet (1 s 24 Bit Stereo = $N Bytes)" || fehler "aw-render.exe: $N Bytes statt 288000"

echo "== 1. Erster Start"
T0=$(date +%s); starten 1
if warten; then ok "Server antwortet nach $(( $(date +%s) - T0 )) s"; else fehler "Server antwortet nicht"; melden "$WU/daten/logs/"*.log "$WU/konsole_1.txt" "$WU/daten/nginx/logs/error.log"; exit 1; fi
log | grep -q "MariaDB läuft" && ok "MariaDB läuft" || fehler "MariaDB nicht im Log"
JAR="$WU/jar"; SEITE="$(curl -s -c "$JAR" http://127.0.0.1:9950/einrichtung.php)"
CSRF="$(printf '%s' "$SEITE" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$CSRF" ] && ok "Einrichtungsseite" || fehler "Einrichtungsseite: $(printf '%s' "$SEITE" | head -c 300)"
printf '%s' "$SEITE" | grep -q 'data-code="0"' && ok "kein Code nötig (direkt am PC)" || fehler "Einrichtung verlangt einen Code"
schritt() { curl -s --max-time 120 -b "$JAR" -c "$JAR" -X POST "http://127.0.0.1:9950/einrichtung.php?schritt=$1" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"vorname":"Test","nachname":"Admin","benutzername":"testadmin","email":"t@example.org","passwort":"Test-Passwort-2026","passwort2":"Test-Passwort-2026","servername":"Win","sprache":"de","land":"DE","zeitzone":"Europe/Berlin","waehrung":"EUR","zeitformat":"auto","datumsformat":"auto","einheiten":"auto","musik_schreiben":"0"}'; }
A="$(schritt system)"; echo "$A" | grep -q '"bereit":true' && ok "Systemprüfung bereit" || fehler "Systemprüfung: $(echo "$A" | head -c 400)"
W2="$(echo "$A" | python -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(w["name"]+("=ok" if w["ok"] else "=FEHLT") for w in d.get("werkzeuge",[])))' 2>/dev/null)"; echo "Werkzeuge: $W2"
echo "$W2" | grep -q "FEHLT" && fehler "Werkzeug fehlt: $W2" || ok "alle Werkzeuge gefunden"
for s in pruefen db tabellen admin abschluss; do A="$(schritt $s)"; echo "$A" | grep -q '"ok":true' && ok "Schritt $s" || fehler "Schritt $s: $(echo "$A" | head -c 300)"; done
A="$(schritt scan_start)"; echo "$A" | grep -q '"ok":true' && ok "Scan gestartet" || fehler "scan_start: $A"
for i in $(seq 1 60); do A="$(schritt scan_status)"; echo "$A" | grep -q '"laeuft":false' && break; sleep 2; done
echo "$A" | grep -q '"titel":2' && echo "$A" | grep -q '"fehler_anzahl":0' && ok "Scan: 2 Titel, keine Fehler" || fehler "Scan: $(echo "$A" | head -c 300)"
TOKEN="$(curl -s --max-time 30 -X POST http://127.0.0.1:9950/api/v1/auth/token -H 'Content-Type: application/json' -d '{"benutzername":"testadmin","passwort":"Test-Passwort-2026","geraet_name":"CI"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] && ok "Anmeldung (API)" || fehler "Anmeldung schlägt fehl"
ALB="$(curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9950/api/v1/alben)"
echo "$ALB" | grep -q 'Über Grenzen' && ok "Album mit Umlauten in der Liste" || fehler "Albenliste: $(echo "$ALB" | head -c 300)"
TID="$(echo "$ALB" | python -c 'import json,sys; print(json.load(sys.stdin)["alben"][0]["id"])' 2>/dev/null)"
TR="$(curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:9950/api/v1/alben/$TID" | python -c 'import json,sys; d=json.load(sys.stdin); t=[x for x in json.dumps(d).split("\"id\": ")]; print(d["tracks"][1]["id"] if "tracks" in d else d["album"]["tracks"][1]["id"])' 2>/dev/null)"
[ -n "$TR" ] || TR=2
for q in original opus128; do
  R="$(curl -s --max-time 60 -H "Authorization: Bearer $TOKEN" -o "$WU/s_$q" -w '%{http_code} %{content_type}' "http://127.0.0.1:9950/api/v1/stream/$TR?q=$q")"; GR=$(wc -c < "$WU/s_$q")
  [ "${R%% *}" = 200 ] && [ "$GR" -gt 20000 ] && ok "Stream $q ($R, $GR Bytes) – Titel „Wham! 100%“" || fehler "Stream $q: $R, $GR Bytes"
done
# gleichzeitig zwei Umwandlungen + eine API-Anfrage (mehrere PHP-Prozesse hinter nginx)
( curl -s --max-time 60 -H "Authorization: Bearer $TOKEN" -o /dev/null "http://127.0.0.1:9950/api/v1/stream/$TR?q=opus128" & curl -s --max-time 60 -H "Authorization: Bearer $TOKEN" -o /dev/null "http://127.0.0.1:9950/api/v1/stream/$TR?q=opus160" & wait ) &
PARALLEL=$!
sleep 1; T1=$(date +%s%N); curl -s --max-time 20 -o /dev/null -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9950/api/v1/alben; T2=$(( ($(date +%s%N) - T1) / 1000000 ))
[ "$T2" -lt 3000 ] && ok "API antwortet während zwei Umwandlungen in $T2 ms" || fehler "API blockiert während Umwandlungen ($T2 ms)"
wait $PARALLEL   # nur die beiden Ströme – ein bloßes „wait“ wartete auch auf den Server
C="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9950/includes/config.php)"; [ "$C" = 403 ] || [ "$C" = 404 ] && ok "interne Ordner gesperrt ($C)" || fehler "includes/ erreichbar ($C)"
C="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9950/)"; [ "$C" = 302 ] && ok "Startseite leitet zur Anmeldung" || fehler "Startseite: $C"
sleep 70; [ -s "$WU/daten/logs/zeitplan.log" ] && ok "Zeitplan läuft: $(tail -1 "$WU/daten/logs/zeitplan.log")" || fehler "Zeitplan hat nichts geschrieben"
if stoppen; then ok "beendet"; else fehler "Server beendet sich nicht"; fi
log | grep -q "MariaDB sauber beendet" && ok "MariaDB sauber beendet" || fehler "MariaDB nicht sauber beendet"

echo "== 2. Zweiter Start (Daten bleiben)"
starten 2
if warten; then ok "zweiter Start"; else fehler "zweiter Start scheitert"; fi
TOKEN="$(curl -s --max-time 30 -X POST http://127.0.0.1:9950/api/v1/auth/token -H 'Content-Type: application/json' -d '{"benutzername":"testadmin","passwort":"Test-Passwort-2026","geraet_name":"CI"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$TOKEN" ] && ok "Anmeldung nach Neustart" || fehler "Anmeldung nach Neustart schlägt fehl"
stoppen || fehler "zweites Beenden"
echo "--- PHP-Fehler"; tail -c 3000 "$WU/daten/logs/php-fehler.log" 2>/dev/null
echo "--- server.log"; log | tail -40
[ "$FEHLER" = 0 ] || melden "$WU/daten/logs/"*.log "$WU/daten/nginx/logs/error.log"
exit $FEHLER
