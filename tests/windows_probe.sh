#!/bin/bash
# Machbarkeitsprüfung „Amberwave Windows Server“ (läuft auf einem Windows-Testrechner von GitHub, Git-Bash + natives PHP):
# Einrichtung, Scan einer kleinen Testsammlung (Umlaute, lange Pfade), Anmelden, Streaming original/Opus, Zeitplan.
# Schreibt jede Beobachtung nach $BERICHT – Fehler beenden den Lauf nicht, es geht um eine vollständige Liste.
set -u
W='C:\aw'; WU=/c/aw
BERICHT="$WU/bericht.txt"; mkdir -p "$WU/musik" "$WU/cache" "$WU/backups"; : > "$BERICHT"
b() { echo "$*" | tee -a "$BERICHT"; }
export DB_HOST=127.0.0.1 DB_PORT=3306 DB_NAME=amberwave DB_USER=amberwave DB_PASSWORD=Probe-Passwort-2026
export PFAD_MUSIK="$W\\musik" PFAD_CACHE="$W\\cache" PFAD_BACKUPS="$W\\backups" APP_SECRET_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export APP_URL=http://127.0.0.1:8095 SICHERHEIT_HSTS=0

b "== System"; b "PHP: $(php -r 'echo PHP_VERSION, " ", PHP_OS_FAMILY;')"
b "Erweiterungen fehlen: $(php -r 'echo implode(",", array_diff(["pdo_mysql","gd","zip","mbstring","openssl","curl","fileinfo","intl","sodium"], array_map("strtolower", get_loaded_extensions())));')"
for w in ffmpeg ffprobe flac metaflac fpcalc python; do b "Werkzeug $w: $(command -v $w >/dev/null && echo da || echo FEHLT)"; done

b "== Testsammlung"
mk() { mkdir -p "$WU/musik/$1"; ffmpeg -v error -y -f lavfi -i "sine=f=$4:d=6" -ac 2 -ar 44100 -metadata title="$3" -metadata artist="$5" -metadata album_artist="$5" -metadata album="$2" -metadata track="$6" -metadata date=2021 "$WU/musik/$1/$7" || b "FEHLER ffmpeg $7"; }
mk "Björk Ångström/2021 - Über Grenzen" "Über Grenzen" "Straße" 440 "Björk Ångström" 1 "01 - Straße.flac"
mk "Björk Ångström/2021 - Über Grenzen" "Über Grenzen" "Ça va" 550 "Björk Ångström" 2 "02 - Ça va.flac"
L="Ein sehr langer Ordnername der Windows an seine Grenzen bringen soll weil Pfade über 260 Zeichen gehen"
mk "$L/$L/$L" "Langes Album" "Langer Titel" 660 "Lang" 1 "01 - Langer Titel mit sehr langem Dateinamen damit es wirklich lang wird.flac"
mkdir -p "$WU/musik/MP3 Test"; ffmpeg -v error -y -f lavfi -i "sine=f=330:d=6" -metadata title="Mp3 Titel" -metadata artist="Mp3 Band" -metadata album="Mp3 Album" -c:a libmp3lame -b:a 192k "$WU/musik/MP3 Test/01 - Mp3 Titel.mp3" || b "FEHLER mp3"
b "Dateien: $(find "$WU/musik" -type f | wc -l)"

b "== Webserver"
php -d error_log="$W\\php-server.log" -d log_errors=1 -d display_errors=0 -S 127.0.0.1:8095 -t app tests/router.php > "$WU/server.out" 2>&1 &
for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:8095/login.php && break; sleep 1; done
b "Login-Seite: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8095/login.php)"

b "== Einrichtung"
JAR="$WU/jar"; SEITE="$(curl -s -c "$JAR" http://127.0.0.1:8095/einrichtung.php)"
CSRF="$(printf '%s' "$SEITE" | sed -n 's/.*data-csrf="\([^"]*\)".*/\1/p' | head -n1)"
b "Einrichtungsseite: $([ -n "$CSRF" ] && echo ok || echo "FEHLER: $(printf '%s' "$SEITE" | head -c 400)")"
b "Code nötig: $(printf '%s' "$SEITE" | sed -n 's/.*data-code="\([01]\)".*/\1/p' | head -n1)"
schritt() { curl -s -b "$JAR" -c "$JAR" -X POST "http://127.0.0.1:8095/einrichtung.php?schritt=$1" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"vorname":"Probe","nachname":"Admin","benutzername":"probe","email":"probe@example.org","passwort":"Probe-Passwort-2026","passwort2":"Probe-Passwort-2026","servername":"Win","sprache":"de","land":"DE","zeitzone":"Europe/Berlin","waehrung":"EUR","zeitformat":"auto","datumsformat":"auto","einheiten":"auto","musik_schreiben":"1"}'; }
A="$(schritt system)"; b "Werkzeuge laut Systemprüfung: $(echo "$A" | php -r '$d=json_decode(stream_get_contents(STDIN),true); foreach($d["werkzeuge"]??[] as $w) echo $w["name"],"=",$w["ok"]?"ok":"FEHLT","; ";')"
for s in pruefen db tabellen admin abschluss; do A="$(schritt $s)"; echo "$A" | grep -q '"ok":true' && b "Schritt $s: ok" || b "FEHLER Schritt $s: $(echo "$A" | head -c 400)"; done

b "== Scan (im Hintergrund gestartet, wie nach der Einrichtung)"
A="$(schritt scan_start)"; b "scan_start: $(echo "$A" | head -c 200)"
for i in $(seq 1 40); do A="$(schritt scan_status)"; echo "$A" | grep -q '"laeuft":false\|"status":"fertig"' && break; sleep 3; done
b "scan_status: $(echo "$A" | head -c 400)"
b "Scan-Fehler: $(php -r 'require "app/includes/db.php"; foreach (db_alle("SELECT * FROM scan_fehler ORDER BY id DESC LIMIT 5") as $z) echo json_encode($z, JSON_UNESCAPED_UNICODE), " | ";' 2>&1 | head -c 1200)"
b "== Scan (CLI)"
T0=$(date +%s); php -d error_log="$W\\php-cli.log" -d log_errors=1 app/scripts/scan.php voll > "$WU/scan.out" 2>&1; b "scan.php rc=$? in $(( $(date +%s) - T0 )) s: $(tail -c 600 "$WU/scan.out")"
b "Titel in der DB: $(php -r 'require "app/includes/db.php"; echo db_wert("SELECT COUNT(*) FROM tracks");' 2>&1 | head -c 300)"
b "Titelpfade: $(php -r 'require "app/includes/db.php"; foreach (db_alle("SELECT pfad FROM dateien LIMIT 5") as $z) echo $z["pfad"], " | ";' 2>&1 | head -c 800)"

b "== API"
TOKEN="$(curl -s -X POST http://127.0.0.1:8095/api/v1/auth/token -H 'Content-Type: application/json' -d '{"benutzername":"probe","passwort":"Probe-Passwort-2026","geraet_name":"Probe"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
b "Token: $([ -n "$TOKEN" ] && echo ok || echo FEHLT)"
AL="$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8095/api/v1/alben)"; b "Alben: $(echo "$AL" | head -c 500)"
TID="$(php -r 'require "app/includes/db.php"; echo db_wert("SELECT track_id FROM dateien ORDER BY id LIMIT 1");' 2>/dev/null)"
for q in original opus128; do
  curl -s -H "Authorization: Bearer $TOKEN" -o "$WU/strom_$q" -D "$WU/kopf_$q" "http://127.0.0.1:8095/api/v1/stream/$TID?q=$q" --max-time 60
  b "Stream $q: Status $(head -1 "$WU/kopf_$q" | tr -d '\r') Typ $(grep -i '^content-type' "$WU/kopf_$q" | tr -d '\r') Bytes $(wc -c < "$WU/strom_$q")"
done
curl -s -H "Authorization: Bearer $TOKEN" -o /dev/null -w "Cover-Liste: %{http_code}\n" http://127.0.0.1:8095/api/v1/alben | tee -a "$BERICHT" >/dev/null

b "== Zeitplan / Hintergrund"
php -d error_log="$W\\php-cli.log" -d log_errors=1 app/scripts/zeitplan.php > "$WU/zeitplan.out" 2>&1; b "zeitplan.php rc=$?: $(tail -c 600 "$WU/zeitplan.out")"
sleep 20
b "Prozesse php: $(tasklist //FI "IMAGENAME eq php.exe" 2>/dev/null | grep -c php.exe)"

b "== PHP-Fehler (Server)"; b "$(tail -c 3000 "$WU/php-server.log" 2>/dev/null)"
b "== PHP-Fehler (CLI)"; b "$(tail -c 3000 "$WU/php-cli.log" 2>/dev/null)"
b "== Server-Ausgabe"; b "$(grep -iv ' \[200\]: \| \[30[0-9]\]: \|Accepted\|Closing' "$WU/server.out" | tail -c 2500)"
exit 0
