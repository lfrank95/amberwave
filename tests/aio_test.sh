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
log | grep -q "AIO: MariaDB 11.4" && ok "MariaDB 11.4 läuft" || fehler "MariaDB 11.4 nicht im Log"
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

echo "== 2. Stoppen und neu starten"
T0=$(date +%s); docker stop aw-aio >/dev/null; T1=$(date +%s)
log | grep -q "AIO: MariaDB beendet" && ok "MariaDB sauber beendet ($((T1 - T0)) s)" || fehler "MariaDB nicht sauber beendet"
docker start aw-aio >/dev/null
if warten; then ok "zweiter Start"; else fehler "zweiter Start: Webserver antwortet nicht"; fi
anmelden && ok "Anmeldung nach Neustart (Daten bleiben)" || fehler "Anmeldung nach Neustart schlägt fehl"
[ "$(log | grep -c "Admin-Konto „testadmin“ angelegt")" = "1" ] && ok "kein zweiter Admin" || fehler "Admin doppelt angelegt"
sudo grep -qi "crash recovery\|was not shut down normally" "$W/appdata/db/mariadb-fehler.log" && fehler "MariaDB brauchte eine Wiederherstellung" || ok "keine Wiederherstellung nötig"
docker rm -f aw-aio >/dev/null

echo "== 3. Anderer Benutzer (PUID/PGID geändert)"
starten -e PUID=1234 -e PGID=1234
if warten; then ok "Start mit PUID 1234"; else fehler "Start mit PUID 1234 scheitert"; fi
anmelden && ok "Anmeldung mit neuem Benutzer" || fehler "Anmeldung mit PUID 1234 schlägt fehl"
[ "$(sudo stat -c %u "$W/appdata/db/mysql")" = "1234" ] && ok "Datenordner angeglichen" || fehler "Datenordner gehört $(sudo stat -c %u "$W/appdata/db/mysql")"

[ "$FEHLER" = "0" ] || { echo "--- Container-Log ---"; log | tail -n 80; }
docker rm -f aw-aio >/dev/null 2>&1
sudo rm -rf "$W" 2>/dev/null || rm -rf "$W"
exit $FEHLER
