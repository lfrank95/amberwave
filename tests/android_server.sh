#!/bin/bash
# Testserver für den Rauchtest der Android-App: All-in-One-Image mit dem aktuellen app/ darüber, drei kleine Alben,
# eingelesen. Lauscht auf 127.0.0.1:8080 (im Emulator über „adb reverse“ dieselbe Adresse – ein sicherer Kontext).
set -euo pipefail
W="$(mktemp -d)"
mkdir -p "$W/appdata" "$W/musik"
IMG="${AW_AIO_IMAGE:-ghcr.io/lfrank95/amberwave-aio:beta}"
docker pull -q "$IMG" >/dev/null

# Musik: kurze Töne mit Tags (FLAC, MP3) – ffmpeg aus dem Image
mk() {   # Ordner Titel Frequenz Nr Datei Album Interpret
    mkdir -p "$W/musik/$1"
    docker run --rm --entrypoint ffmpeg -v "$W/musik:/m" "$IMG" -v error -f lavfi -i "sine=f=$3:d=40" -ac 2 -ar 44100 \
        -metadata title="$2" -metadata artist="$7" -metadata album_artist="$7" -metadata album="$6" -metadata track="$4" -metadata date=2021 "/m/$1/$5"
}
mk "Testband/2021 - Unterwegs" "Erster Titel" 440 1 "01 - Erster Titel.flac" "Unterwegs" "Testband"
mk "Testband/2021 - Unterwegs" "Zweiter Titel" 550 2 "02 - Zweiter Titel.flac" "Unterwegs" "Testband"
mk "Testband/2021 - Unterwegs" "Dritter Titel" 660 3 "03 - Dritter Titel.mp3" "Unterwegs" "Testband"
sudo chmod -R a+rwX "$W"

docker run -d --name aw-test -p 127.0.0.1:8080:80 -e ADMIN_BENUTZER=testadmin -e ADMIN_PASSWORT=Test-Passwort-2026 -e TZ=Europe/Berlin \
    -e OFFLINE_QUALITAET=original -v "$W/appdata:/appdata" -v "$W/musik:/musik" -v "$PWD/app:/var/www/html" "$IMG" >/dev/null
for i in $(seq 1 90); do curl -fs http://127.0.0.1:8080/api/v1/ping | grep -q amberwave && break; sleep 2; done
curl -fs http://127.0.0.1:8080/api/v1/ping >/dev/null || { docker logs aw-test | tail -50; echo "::error title=Android-Test::Testserver startet nicht"; exit 1; }

TK="$(curl -s -X POST http://127.0.0.1:8080/api/v1/auth/token -H 'Content-Type: application/json' -d '{"benutzername":"testadmin","passwort":"Test-Passwort-2026","geraet_name":"CI"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
curl -s -X POST http://127.0.0.1:8080/api/v1/admin/scan -H "Authorization: Bearer $TK" -H 'Content-Type: application/json' -d '{}' >/dev/null
for i in $(seq 1 60); do
    curl -s http://127.0.0.1:8080/api/v1/alben -H "Authorization: Bearer $TK" | grep -q Unterwegs && break
    sleep 2
done
curl -s http://127.0.0.1:8080/api/v1/alben -H "Authorization: Bearer $TK" | grep -q Unterwegs || { echo "::error title=Android-Test::Album nicht eingelesen"; docker logs aw-test | tail -30; exit 1; }
# Einrichtungsassistent nach der ersten Anmeldung (Admin aus der Vorlage) überspringen – hier geht es um die App
docker exec aw-test rm -f /appdata/cache/geheimnisse/assistent_offen
echo "Testserver bereit"
