#!/bin/bash
# Amberwave Connect zwischen zwei All-in-One-Containern (läuft im Workflow nach dem AIO-Test):
# A hat Musik, B ist leer. Ausweis prüfen → mit Code koppeln (falscher Code wird abgelehnt) → B stöbert bei A, hört rein
# → B holt ein Album im Original (bitgenau) und eins als Opus → A sieht beide als „hast du schon“ → B benennt sich um,
# A erfährt den neuen Namen → A stöbert umgekehrt bei B (Kopplung gilt in beide Richtungen) → Trennen.
# Aufruf: tests/connect_test.sh <image>
set -u
IMG="${1:?Image angeben}"
W="$(mktemp -d)"
NETZ="aw-connect-$$"
mkdir -p "$W/a/appdata" "$W/a/musik" "$W/b/appdata" "$W/b/musik"
chmod 777 "$W/b/musik"   # B legt dort Geholtes ab
FEHLER=0
fehler() { echo "::error title=Connect-Test::$*"; echo "FEHLER: $*"; FEHLER=1; }
ok() { echo "ok: $*"; }
aufraeumen() { docker rm -f aw-a aw-b >/dev/null 2>&1; docker network rm "$NETZ" >/dev/null 2>&1; sudo rm -rf "$W" 2>/dev/null || rm -rf "$W"; }
trap aufraeumen EXIT

echo "== Testmusik für A (zwei Alben, FLAC 24/48)"
for alb in "Erstes Album" "Zweites Album"; do
    mkdir -p "$W/a/musik/Testband/$alb"
    for n in 1 2; do
        docker run --rm --entrypoint ffmpeg -v "$W/a/musik:/m" "$IMG" -v error -f lavfi -i "sine=frequency=$((300 + n * 110)):duration=4" -ar 48000 -sample_fmt s32 -c:a flac \
            -metadata artist=Testband -metadata album_artist=Testband -metadata album="$alb" -metadata title="Lied $n" -metadata track="$n" -metadata date=2024 \
            "/m/Testband/$alb/0$n - Lied $n.flac"
    done
done
[ "$(find "$W/a/musik" -name '*.flac' | wc -l)" = "4" ] && ok "4 Testdateien" || fehler "Testdateien fehlen"

docker network create "$NETZ" >/dev/null
starten() {   # name port app_url extra…
    local n="$1" p="$2" u="$3"; shift 3
    docker run -d --name "$n" --network "$NETZ" --network-alias "$n" --stop-timeout 60 -p "$p:80" \
        -e ADMIN_BENUTZER=testadmin -e ADMIN_PASSWORT=Test-Passwort-2026 -e TZ=Europe/Berlin -e APP_URL="$u" "$@" \
        -v "$W/${n#aw-}/appdata:/appdata" -v "$W/${n#aw-}/musik:/musik" "$IMG" >/dev/null
}
starten aw-a 19951 http://aw-a
starten aw-b 19952 http://aw-b -e MUSIK_SCHREIBEN=1
warten() { for i in $(seq 1 90); do curl -fs "http://127.0.0.1:$1/api/v1/ping" 2>/dev/null | grep -q amberwave && return 0; sleep 2; done; return 1; }
warten 19951 && ok "A läuft" || fehler "A antwortet nicht"
warten 19952 && ok "B läuft" || fehler "B antwortet nicht"
token() { curl -fs -X POST "http://127.0.0.1:$1/api/v1/auth/token" -H 'Content-Type: application/json' \
    -d '{"benutzername":"testadmin","passwort":"Test-Passwort-2026","geraet_name":"CI"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
TA="$(token 19951)"; TB="$(token 19952)"
[ -n "$TA" ] && [ -n "$TB" ] && ok "Anmeldung auf beiden" || fehler "Anmeldung scheitert"
api() {   # port token methode pfad [json]
    local p="$1" tk="$2" m="$3" pf="$4"; shift 4
    curl -s -X "$m" "http://127.0.0.1:$p/api/v1$pf" -H "Authorization: Bearer $tk" -H 'Content-Type: application/json' ${1:+-d "$1"}
}
api 19951 "$TA" PUT /connect/name '{"name":"Zuhause"}' | grep -q '"ok":true' && ok "A heißt „Zuhause“" || fehler "Name für A"
api 19952 "$TB" PUT /connect/name '{"name":"Wohnwagen"}' | grep -q '"ok":true' && ok "B heißt „Wohnwagen“" || fehler "Name für B"
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1" 2>/dev/null; }

echo "== Ausweis"
PING="$(curl -fs http://127.0.0.1:19951/api/v1/ping)"
SCHL="$(printf '%s' "$PING" | j "d['schluessel']")"
[ ${#SCHL} = 64 ] && ok "A nennt seinen Ausweis ($(printf '%s' "$PING" | j "d['kennung']"))" || fehler "kein Ausweis in /ping: $PING"
Z="$(openssl rand -hex 16)"
BEWEIS="$(curl -fs "http://127.0.0.1:19951/api/v1/ausweis?z=$Z")"
python3 - "$BEWEIS" "$Z" "$SCHL" <<'PY' && ok "Unterschrift des Ausweises stimmt" || fehler "Unterschrift falsch: $BEWEIS"
import sys, json, subprocess, tempfile, os
b, z, pk = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
assert b['schluessel'] == pk and b['zufall'] == z
d = tempfile.mkdtemp()
open(f'{d}/pk.der', 'wb').write(bytes.fromhex('302a300506032b6570032100' + pk))
open(f'{d}/sig', 'wb').write(bytes.fromhex(b['unterschrift']))
open(f'{d}/msg', 'wb').write(f'amberwave-ausweis-v1|{z}|{pk}'.encode())
r = subprocess.run(['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', f'{d}/pk.der', '-keyform', 'DER', '-rawin', '-in', f'{d}/msg', '-sigfile', f'{d}/sig'], capture_output=True)
sys.exit(r.returncode)
PY

echo "== A liest seine Musik ein"
api 19951 "$TA" POST /admin/scan '{}' >/dev/null
for i in $(seq 1 60); do [ "$(api 19951 "$TA" GET '/alben?sort=titel' | j "d['gesamt']")" = "2" ] && break; sleep 2; done
[ "$(api 19951 "$TA" GET '/alben?sort=titel' | j "d['gesamt']")" = "2" ] && ok "A hat 2 Alben" || fehler "Scan auf A: $(api 19951 "$TA" GET '/alben' | head -c 300)"

echo "== Koppeln"
CODE="$(api 19951 "$TA" POST /connect/code | j "d['code']")"
[ ${#CODE} = 6 ] && ok "A zeigt einen Code" || fehler "kein Code"
FALSCH="$(printf '%06d' $(( (10#$CODE + 1) % 1000000 )))"
A="$(api 19952 "$TB" POST /connect/koppeln/mit '{"adresse":"http://aw-a","code":"'"$FALSCH"'"}')"
echo "$A" | grep -q '"ok":false' && ok "falscher Code abgelehnt" || fehler "falscher Code angenommen: $A"
A="$(api 19952 "$TB" POST /connect/koppeln/mit '{"adresse":"http://aw-a","code":"'"$CODE"'"}')"
[ "$(printf '%s' "$A" | j "d['name']")" = "Zuhause" ] && ok "B ist mit A gekoppelt" || fehler "Koppeln: $A"
SID="$(printf '%s' "$A" | j "d['id']")"
[ "$(api 19951 "$TA" GET /connect/server | j "d['server'][0]['name']")" = "Wohnwagen" ] && ok "A kennt B" || fehler "A kennt B nicht"

echo "== Stöbern und reinhören"
ALBEN="$(api 19952 "$TB" GET "/connect/server/$SID/lesen/alben?sort=titel")"
[ "$(printf '%s' "$ALBEN" | j "len(d['alben'])")" = "2" ] && ok "B sieht A's Alben" || fehler "Stöbern: $(printf '%s' "$ALBEN" | head -c 300)"
AID1="$(printf '%s' "$ALBEN" | j "[a['id'] for a in d['alben'] if a['titel']=='Erstes Album'][0]")"
AID2="$(printf '%s' "$ALBEN" | j "[a['id'] for a in d['alben'] if a['titel']=='Zweites Album'][0]")"
TID="$(api 19952 "$TB" GET "/connect/server/$SID/lesen/album?id=$AID1" | j "d['tracks'][0]['id']")"
CODE_HTTP="$(curl -s -o "$W/hoeren.ogg" -w '%{http_code}' -H "Authorization: Bearer $TB" -H 'Range: bytes=0-' "http://127.0.0.1:19952/api/v1/connect/server/$SID/stream/$TID?q=opus128")"
[ "$CODE_HTTP" = "206" ] && head -c 4 "$W/hoeren.ogg" | grep -q OggS && ok "Reinhören (Opus, $(stat -c %s "$W/hoeren.ogg") Bytes)" || fehler "Reinhören: HTTP $CODE_HTTP"

echo "== Holen: Original und Opus"
api 19952 "$TB" POST "/connect/server/$SID/holen" '{"art":"album","id":'"$AID1"',"qualitaet":"original","titel":"Erstes Album"}' >/dev/null
api 19952 "$TB" POST "/connect/server/$SID/holen" '{"art":"album","id":'"$AID2"',"qualitaet":"opus256","titel":"Zweites Album"}' >/dev/null
for i in $(seq 1 90); do
    OFFEN="$(api 19952 "$TB" GET /connect/auftraege | j "sum(1 for a in d['auftraege'] if a['status'] in ('wartet','laeuft'))")"
    [ "$OFFEN" = "0" ] && break; sleep 2
done
api 19952 "$TB" GET /connect/auftraege | j "'\n'.join(a['titel']+': '+a['status']+' '+a['fehler'] for a in d['auftraege'])"
[ "$(api 19952 "$TB" GET /connect/auftraege | j "sorted(a['status'] for a in d['auftraege'])")" = "['fertig', 'fertig']" ] && ok "beide Aufträge fertig" || fehler "Aufträge nicht fertig"
for n in 1 2; do
    Q="$W/a/musik/Testband/Erstes Album/0$n - Lied $n.flac"
    Z="$(sudo find "$W/b/musik/Connect" -path '*Erstes Album*' -name "0$n *.flac" | head -n1)"
    [ -n "$Z" ] && [ "$(md5sum < "$Q")" = "$(sudo md5sum < "$Z")" ] && ok "Original bitgenau: $(basename "$Z")" || fehler "Original $n fehlt oder weicht ab ($Z)"
done
[ "$(sudo find "$W/b/musik/Connect" -path '*Zweites Album*' -name '*.opus' | wc -l)" = "2" ] && ok "Opus-Album: 2 Dateien" || fehler "Opus-Dateien fehlen"
sudo test -s "$(sudo find "$W/b/musik/Connect" -path '*Erstes Album*' -name cover.jpg | head -n1)" 2>/dev/null && ok "Cover dabei" || echo "hinweis: kein Cover (Testdateien haben keins)"
for i in $(seq 1 30); do [ "$(api 19952 "$TB" GET '/alben?sort=titel' | j "d['gesamt']")" = "2" ] && break; sleep 2; done
[ "$(api 19952 "$TB" GET '/alben?sort=titel' | j "d['gesamt']")" = "2" ] && ok "B hat die Alben eingelesen" || fehler "B hat nicht eingelesen"

echo "== Schon da, Name, beide Richtungen"
DA="$(api 19952 "$TB" GET "/connect/server/$SID/lesen/alben?sort=titel" | j "sorted(a['titel'] for a in d['alben'] if a.get('_da'))")"
[ "$DA" = "['Erstes Album', 'Zweites Album']" ] && ok "B sieht beide Alben als „hast du schon“" || fehler "Markierung: $DA"
api 19952 "$TB" PUT /connect/name '{"name":"Wohnwagen Süd"}' >/dev/null
[ "$(curl -fs http://127.0.0.1:19952/api/v1/ping | j "d['name']")" = "Wohnwagen Süd" ] && ok "B heißt jetzt „Wohnwagen Süd“" || fehler "Umbenennen schlägt fehl"
[ "$(api 19951 "$TA" GET /connect/server | j "d['server'][0]['name']")" = "Wohnwagen Süd" ] && ok "A kennt den neuen Namen" || fehler "A kennt den neuen Namen nicht"
BID="$(api 19951 "$TA" GET /connect/server | j "d['server'][0]['id']")"
[ "$(api 19951 "$TA" GET "/connect/server/$BID/lesen/alben" | j "d['gesamt']")" = "2" ] && ok "A stöbert bei B (beide Richtungen)" || fehler "A kann bei B nicht stöbern"
api 19952 "$TB" DELETE "/connect/server/$SID" >/dev/null
[ "$(api 19952 "$TB" GET /connect/server | j "len(d['server'])")" = "0" ] && ok "Getrennt" || fehler "Trennen schlägt fehl"

[ "$FEHLER" = "0" ] || { echo "--- Log A ---"; docker logs aw-a 2>&1 | tail -n 40; echo "--- Log B ---"; docker logs aw-b 2>&1 | tail -n 40; }
exit $FEHLER
