#!/bin/bash
# Rauchtest für das All-in-One-Image (läuft im Workflow vor dem Hochladen):
# erster Start mit Admin aus der Vorlage → Anmelden → sauber stoppen → zweiter Start (Daten bleiben, kein zweiter Admin)
# → PUID-Wechsel (Datenordner wird angeglichen). Aufruf: tests/aio_test.sh <image>
set -u
IMG="${1:?Image angeben}"
W="$(mktemp -d)"
mkdir -p "$W/appdata" "$W/musik"
FEHLER=0
fehler() { echo "::error title=AIO-Test::$*"; echo "FEHLER: $*"; FEHLER=1; }
ok() { echo "ok: $*"; }

warten() {   # bis /api/v1/ping antwortet
    for i in $(seq 1 90); do
        curl -fs http://127.0.0.1:19950/api/v1/ping 2>/dev/null | grep -q amberwave && return 0
        sleep 2
    done
    return 1
}
anmelden() {
    curl -fs -X POST http://127.0.0.1:19950/api/v1/auth/token -H 'Content-Type: application/json' \
        -d '{"benutzername":"testadmin","passwort":"Test-Passwort-2026","geraet_name":"CI"}' | grep -q '"token"'
}
starten() {
    docker run -d --name aw-aio --stop-timeout 60 --security-opt no-new-privileges:true -p 19950:80 \
        -e ADMIN_BENUTZER=testadmin -e ADMIN_PASSWORT=Test-Passwort-2026 -e TZ=Europe/Berlin "$@" \
        -v "$W/appdata:/appdata" -v "$W/musik:/musik" "$IMG" >/dev/null
}
log() { docker logs aw-aio 2>&1; }

echo "== 1. Erster Start"
starten
if warten; then ok "Webserver antwortet"; else fehler "Webserver antwortet nicht"; fi
log | grep -q "AIO: MariaDB 11.8" && ok "MariaDB 11.8 läuft" || fehler "MariaDB 11.8 nicht im Log"
log | grep -q "Admin-Konto „testadmin“ angelegt" && ok "Admin aus der Vorlage angelegt" || fehler "Admin nicht angelegt"
log | grep -q "noch nicht eingerichtet" && fehler "Einrichtungshinweis erscheint trotz Admin aus der Vorlage" || ok "kein Einrichtungshinweis"
anmelden && ok "Anmeldung über die API" || fehler "Anmeldung schlägt fehl"
sudo test -s "$W/appdata/cache/geheimnisse/datenbank.json" && ok "Datenbank-Zugang gespeichert" || fehler "geheimnisse/datenbank.json fehlt"
[ "$(sudo stat -c %u "$W/appdata/db/mysql")" != "0" ] && ok "Datenbank-Dateien gehören nicht root ($(sudo stat -c %u:%g "$W/appdata/db/mysql"))" || fehler "Datenbank-Dateien gehören root"
docker exec aw-aio sh -c 'mariadb -h127.0.0.1 -uroot -e "SELECT 1"' >/dev/null 2>&1 && fehler "root kommt ohne Passwort über TCP in die Datenbank" || ok "root nur über den Socket"
LAUSCH="$(docker exec aw-aio cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4=="0A" && $2 ~ /:0CEA$/ {print $2}')"
if [ -z "$LAUSCH" ]; then fehler "MariaDB lauscht nicht auf 3306"
elif echo "$LAUSCH" | grep -qv '^0100007F:'; then fehler "MariaDB lauscht nicht nur auf 127.0.0.1 ($LAUSCH)"
else ok "MariaDB nur auf 127.0.0.1"; fi

docker exec aw-aio sh -c 'for p in $(pgrep -u www-data apache2 | head -3); do tr "\0" "\n" < /proc/$p/environ; done' 2>/dev/null | grep -q '^ADMIN_PASSWORT=' && fehler "Webserver kennt ADMIN_PASSWORT noch" || ok "Passwort aus der Vorlage nicht mehr im Webserver"

echo "== 2. Stoppen und neu starten"
T0=$(date +%s); docker stop aw-aio >/dev/null; T1=$(date +%s)
log | grep -q "AIO: MariaDB beendet" && ok "MariaDB sauber beendet ($((T1 - T0)) s)" || fehler "MariaDB nicht sauber beendet"
docker start aw-aio >/dev/null
if warten; then ok "zweiter Start"; else fehler "zweiter Start: Webserver antwortet nicht"; fi
anmelden && ok "Anmeldung nach Neustart (Daten bleiben)" || fehler "Anmeldung nach Neustart schlägt fehl"
# Umzugspaket für Teil 5
TK="$(curl -fs -X POST http://127.0.0.1:19950/api/v1/auth/token -H 'Content-Type: application/json' -d '{"benutzername":"testadmin","passwort":"Test-Passwort-2026","geraet_name":"CI"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
UN="$(curl -s -X POST http://127.0.0.1:19950/api/v1/admin/umzug -H "Authorization: Bearer $TK" -H 'Content-Type: application/json' -d '{"passwort":"Test-Passwort-2026","paket_passwort":"Umzug-Passwort-1","bilder":true}' | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')"
curl -s -H "Authorization: Bearer $TK" -o "$W/umzug.awumzug" "http://127.0.0.1:19950/api/v1/admin/umzug/datei?name=$UN"
[ -s "$W/umzug.awumzug" ] && ok "Umzugspaket erstellt" || fehler "Umzugspaket fehlt"
[ "$(log | grep -c "Admin-Konto „testadmin“ angelegt")" = "1" ] && ok "kein zweiter Admin" || fehler "Admin doppelt angelegt"
sudo grep -qi "crash recovery\|was not shut down normally" "$W/appdata/db/mariadb-fehler.log" && fehler "MariaDB brauchte eine Wiederherstellung" || ok "keine Wiederherstellung nötig"
docker rm -f aw-aio >/dev/null

echo "== 3. Anderer Benutzer (PUID/PGID geändert)"
starten -e PUID=1234 -e PGID=1234
if warten; then ok "Start mit PUID 1234"; else fehler "Start mit PUID 1234 scheitert"; fi
anmelden && ok "Anmeldung mit neuem Benutzer" || fehler "Anmeldung mit PUID 1234 schlägt fehl"
[ "$(sudo stat -c %u "$W/appdata/db/mysql")" = "1234" ] && ok "Datenordner angeglichen" || fehler "Datenordner gehört $(sudo stat -c %u "$W/appdata/db/mysql")"

docker rm -f aw-aio >/dev/null

echo "== 4. Ohne Admin in der Vorlage: Einrichtungsseite mit Code (Zugriff über die Docker-Brücke)"
sudo rm -rf "$W/appdata"; mkdir -p "$W/appdata"
docker run -d --name aw-aio --stop-timeout 60 -p 19950:80 -v "$W/appdata:/appdata" -v "$W/musik:/musik" "$IMG" >/dev/null
if warten; then ok "Start ohne Admin"; else fehler "Start ohne Admin scheitert"; fi
for i in $(seq 1 30); do log | grep -q "Setup code:" && break; sleep 2; done
CODE="$(log | sed -n 's/.*Setup code: *//p' | tail -n1 | tr -d '\r ')"
[ -n "$CODE" ] && ok "Einrichtungscode im Log" || fehler "kein Einrichtungscode im Log"
JAR="$W/jar"; SEITE="$(curl -fs -c "$JAR" http://127.0.0.1:19950/einrichtung.php)"
CSRF="$(printf '%s' "$SEITE" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$CSRF" ] && ok "Einrichtungsseite erreichbar" || fehler "Einrichtungsseite liefert kein Formular"
schritt() { curl -s -b "$JAR" -c "$JAR" -X POST "http://127.0.0.1:19950/einrichtung.php?schritt=$1" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
    -d '{"code":"'"$CODE"'","vorname":"Test","nachname":"Admin","benutzername":"testadmin","email":"test@example.org","passwort":"Test-Passwort-2026","passwort2":"Test-Passwort-2026","servername":"CI","sprache":"de","land":"DE","zeitzone":"Europe/Berlin","waehrung":"EUR","zeitformat":"auto","datumsformat":"auto","einheiten":"auto","musik_schreiben":"0"}'; }
for s in pruefen db tabellen admin abschluss; do
    A="$(schritt $s)"
    echo "$A" | grep -q '"ok":true' && ok "Schritt $s" || fehler "Schritt $s: $(echo "$A" | head -c 300)"
    [ "$s" = abschluss ] && { echo "$A" | grep -q '"root_abgesichert":true' && ok "Anzeige: Root-Zugang gesperrt" || fehler "Root-Anzeige falsch"; }
done
anmelden && ok "Anmeldung mit dem Konto aus der Einrichtungsseite" || fehler "Anmeldung nach Einrichtung schlägt fehl"

docker rm -f aw-aio >/dev/null

echo "== 5. Umzug in eine neue All-in-One-Installation (mit Code über die Docker-Brücke)"
sudo rm -rf "$W/appdata"; mkdir -p "$W/appdata"
docker run -d --name aw-aio --stop-timeout 60 -p 19950:80 -v "$W/appdata:/appdata" -v "$W/musik:/musik" "$IMG" >/dev/null
if warten; then ok "neue Installation läuft"; else fehler "neue Installation startet nicht"; fi
for i in $(seq 1 30); do log | grep -q "Setup code:" && break; sleep 2; done
CODE="$(log | sed -n 's/.*Setup code: *//p' | tail -n1 | tr -d '\r ')"
JAR="$W/jar5"; SEITE="$(curl -fs -c "$JAR" http://127.0.0.1:19950/einrichtung.php)"
CSRF="$(printf '%s' "$SEITE" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -n1)"
A="$(curl -s -b "$JAR" -c "$JAR" -X POST "http://127.0.0.1:19950/einrichtung.php?schritt=umzug_teil" -H "X-CSRF-Token: $CSRF" -H 'X-Teil: 0' -H "X-Einrichtung-Code: $CODE" -H 'Content-Type: application/octet-stream' --data-binary @"$W/umzug.awumzug")"
echo "$A" | grep -q '"ok":true' && ok "Paket hochgeladen" || fehler "Hochladen: $A"
for s in db umzug abschluss; do
    A="$(curl -s -b "$JAR" -c "$JAR" -X POST "http://127.0.0.1:19950/einrichtung.php?schritt=$s" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{"code":"'"$CODE"'","umzug":"1","paket_passwort":"Umzug-Passwort-1"}')"
    echo "$A" | grep -q '"ok":true' && ok "Umzug-Schritt $s" || fehler "Umzug-Schritt $s: $(echo "$A" | head -c 300)"
done
anmelden && ok "Anmeldung mit dem übernommenen Konto" || fehler "Anmeldung nach Umzug schlägt fehl"

[ "$FEHLER" = "0" ] || { echo "--- Container-Log ---"; log | tail -n 80; }
docker rm -f aw-aio >/dev/null 2>&1
sudo rm -rf "$W" 2>/dev/null || rm -rf "$W"
exit $FEHLER
