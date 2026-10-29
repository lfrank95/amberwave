#!/usr/bin/env bash
# Amberwave: Ordner einer bestehenden Installation sauber auf das neue Schema umziehen.
#
# Neues Schema: ein Ordner APPDATA_PFAD mit  db/  cache/  backups/  – statt drei einzelner Variablen
# (DB_DATA_PFAD, CACHE_PFAD, BACKUP_PFAD). Die alten Variablen funktionieren weiter; dieses Skript räumt nur auf.
# Die Sicherungen dürfen auf ein anderes Laufwerk (SICHERUNG_PFAD).
#
# Läuft AUF DEM SERVER (Unraid: Terminal), nicht im Container:
#   bash scripts/pfade-migrieren.sh                    Trockenlauf: zeigt den Plan, ändert nichts
#   bash scripts/pfade-migrieren.sh --ausfuehren       führt ihn aus
# Optionen:
#   --ziel ORDNER        neuer Basisordner (sonst: der gemeinsame Überordner, falls schon vorhanden, sonst /mnt/cache/appdata/amberwave)
#   --sicherung ORDNER   Sicherungen woandershin (z. B. auf ein anderes Laufwerk) statt nach <ziel>/backups
#   --env DATEI          .env (Standard: die neben docker-compose.yml)
#   --starten            danach den Stack mit den neuen Pfaden starten (sonst: in Unraid „Compose Down → Up“)
#   --ohne-docker        Container nicht anhalten/prüfen (nur wenn sie sicher aus sind)
#
# Sicherheit: Es wird nichts gelöscht. Auf demselben Laufwerk wird verschoben, sonst kopiert, geprüft und der alte Ordner
# umbenannt (<name>.migriert-<Datum>) – den löschst du selbst, wenn alles läuft. Die .env wird vorher gesichert
# (.env.vor-umzug-<Datum>). Die Datenbank-Dateien behalten ihren Besitzer (MariaDB), der Rest bekommt PUID:PGID.
set -eu

AUSFUEHREN=0; STARTEN=0; OHNE_DOCKER=0; ZIEL=""; SICHERUNG=""; ENV_DATEI=""
while [ $# -gt 0 ]; do
    case "$1" in
        --ausfuehren) AUSFUEHREN=1 ;;
        --starten) STARTEN=1 ;;
        --ohne-docker) OHNE_DOCKER=1 ;;
        --ziel) ZIEL="${2:?--ziel braucht einen Ordner}"; shift ;;
        --sicherung) SICHERUNG="${2:?--sicherung braucht einen Ordner}"; shift ;;
        --env) ENV_DATEI="${2:?--env braucht eine Datei}"; shift ;;
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) echo "Unbekannte Option: $1 (Hilfe: --help)" >&2; exit 2 ;;
    esac
    shift
done

HIER="$(cd "$(dirname "$0")" && pwd)"
PROJEKT="$(cd "$HIER/../.." && pwd)"
[ -n "$ENV_DATEI" ] || ENV_DATEI="$PROJEKT/.env"
[ -f "$ENV_DATEI" ] || { echo "Keine .env gefunden: $ENV_DATEI (mit --env angeben)" >&2; exit 1; }
PROJEKT_ENV="$(cd "$(dirname "$ENV_DATEI")" && pwd)"

# Wert aus der .env lesen (letzte nicht auskommentierte Zeile gewinnt, Anführungszeichen weg)
env_wert() {
    local w
    w="$(grep -E "^[[:space:]]*$1=" "$ENV_DATEI" | tail -n1 | sed -E "s/^[[:space:]]*$1=//; s/[[:space:]]+#.*$//; s/^[\"']//; s/[\"']$//")" || true
    printf '%s' "$w"
}
absolut() { # relative Pfade gelten wie bei Compose: relativ zum Ordner der .env
    case "$1" in /*) printf '%s' "${1%/}" ;; ./*) printf '%s' "$PROJEKT_ENV/${1#./}" ;; *) printf '%s' "$PROJEKT_ENV/$1" ;; esac
}

APPDATA="$(env_wert APPDATA_PFAD)"; SICH_ALT="$(env_wert SICHERUNG_PFAD)"
AB="${APPDATA:-.}"
DB_VAR="$(env_wert DB_DATA_PFAD)"; CA_VAR="$(env_wert CACHE_PFAD)"; BA_VAR="$(env_wert BACKUP_PFAD)"; [ -n "$BA_VAR" ] || BA_VAR="$SICH_ALT"
if [ -n "$DB_VAR" ]; then DB_ALT="$(absolut "$DB_VAR")"; else DB_ALT="$(absolut "$AB/db")"; fi
if [ -n "$CA_VAR" ]; then CA_ALT="$(absolut "$CA_VAR")"; else CA_ALT="$(absolut "$AB/cache")"; fi
if [ -n "$BA_VAR" ]; then BA_ALT="$(absolut "$BA_VAR")"; else BA_ALT="$(absolut "$AB/backups")"; fi
PUID_ENV="$(env_wert PUID)"; PGID_ENV="$(env_wert PGID)"

# Zielordner wählen
if [ -z "$ZIEL" ]; then
    if [ -n "$APPDATA" ]; then ZIEL="$(absolut "$APPDATA")"
    elif [ "$(dirname "$DB_ALT")" = "$(dirname "$CA_ALT")" ]; then ZIEL="$(dirname "$DB_ALT")"
    elif [ -d /mnt/cache ]; then ZIEL="/mnt/cache/appdata/amberwave"
    else ZIEL="$PROJEKT_ENV/daten"; fi
fi
ZIEL="$(absolut "$ZIEL")"
DB_NEU="$ZIEL/db"; CA_NEU="$ZIEL/cache"
# Sicherungen: ausdrücklich gewählter eigener Ort (z. B. anderes Laufwerk) bleibt, sonst <ziel>/backups
if [ -n "$SICHERUNG" ]; then BA_NEU="$(absolut "$SICHERUNG")"
elif [ -n "$BA_VAR" ] && [ "$BA_ALT" != "$ZIEL/backups" ]; then BA_NEU="$BA_ALT"
else BA_NEU="$ZIEL/backups"; fi
BA_SEPARAT=0; [ "$BA_NEU" = "$ZIEL/backups" ] || BA_SEPARAT=1

echo "Amberwave – Ordner umziehen"
echo "  .env:        $ENV_DATEI"
printf '  %-12s %s\n' "Datenbank:" "$DB_ALT  →  $DB_NEU" "App-Daten:" "$CA_ALT  →  $CA_NEU" "Sicherungen:" "$BA_ALT  →  $BA_NEU"
[ "$AUSFUEHREN" = 1 ] || echo "  (Trockenlauf – mit --ausfuehren wird es umgesetzt)"

# ---- Prüfungen ----
fehler=0
pruefe_paar() { # name alt neu
    local n="$1" a="$2" z="$3"
    [ "$a" = "$z" ] && return 0
    case "$z/" in "$a"/*) echo "FEHLER $n: Ziel liegt im alten Ordner" >&2; fehler=1; return ;; esac
    case "$a/" in "$z"/*) echo "FEHLER $n: der alte Ordner liegt im Ziel – bitte anderes --ziel wählen" >&2; fehler=1; return ;; esac
    if [ -d "$z" ] && [ -n "$(ls -A "$z" 2>/dev/null)" ]; then
        echo "FEHLER $n: Zielordner ist nicht leer: $z" >&2; fehler=1
    fi
    if [ ! -d "$a" ]; then echo "  Hinweis $n: alter Ordner fehlt ($a) – es wird nichts verschoben, nur der neue Pfad eingetragen."; fi
}
if [ "$DB_ALT" = "$DB_NEU" ] && [ "$CA_ALT" = "$CA_NEU" ] && [ "$BA_ALT" = "$BA_NEU" ] && [ -n "$APPDATA" ] && [ "$(absolut "$APPDATA")" = "$ZIEL" ]; then
    echo; echo "Schon sauber: die Ordner liegen bereits so, wie es das neue Schema vorsieht. Nichts zu tun."; exit 0
fi
pruefe_paar Datenbank "$DB_ALT" "$DB_NEU"
pruefe_paar App-Daten "$CA_ALT" "$CA_NEU"
pruefe_paar Sicherungen "$BA_ALT" "$BA_NEU"
[ "$fehler" = 0 ] || exit 1

DOCKER=0
if [ "$OHNE_DOCKER" = 0 ] && command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then DOCKER=1; fi
if [ "$OHNE_DOCKER" = 0 ] && [ "$DOCKER" = 0 ]; then
    echo "Docker ist nicht erreichbar. Sind die Container sicher aus, dann mit --ohne-docker weitermachen." >&2
    [ "$AUSFUEHREN" = 1 ] && exit 1
fi

if [ "$AUSFUEHREN" = 0 ]; then
    echo; echo "Bei --ausfuehren passiert:"
    echo "  1. amberwave_app, amberwave_tunnel und amberwave_db werden angehalten"
    echo "  2. Ordner werden verschoben (gleiches Laufwerk) bzw. kopiert und geprüft; Alt-Ordner → *.migriert-<Datum>"
    echo "  3. Besitzer von App-Daten und Sicherungen auf ${PUID_ENV:-<erkannt>}:${PGID_ENV:-<erkannt>} setzen (Datenbank bleibt unberührt)"
    echo "  4. .env: Sicherung der alten, APPDATA_PFAD=$ZIEL$( [ "$BA_SEPARAT" = 1 ] && echo ", SICHERUNG_PFAD=$BA_NEU" ), alte Zeilen auskommentiert"
    exit 0
fi

# ---- Ausführen ----
[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen (Unraid-Terminal), sonst lassen sich Besitzer nicht setzen." >&2; exit 1; }
DATUM="$(date +%Y%m%d-%H%M%S)"
PROJ_NAME=""; PROJ_DIR=""
if [ "$DOCKER" = 1 ]; then
    PROJ_NAME="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' amberwave_app 2>/dev/null || true)"
    PROJ_DIR="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' amberwave_app 2>/dev/null || true)"
    echo "Container anhalten …"
    docker stop amberwave_app amberwave_tunnel >/dev/null 2>&1 || true
    docker stop amberwave_db >/dev/null 2>&1 || true
fi

verschieben() { # name alt neu
    local n="$1" a="$2" z="$3"
    [ "$a" = "$z" ] && { mkdir -p "$z"; return 0; }
    if [ ! -d "$a" ]; then mkdir -p "$z"; return 0; fi
    mkdir -p "$(dirname "$z")"
    rmdir "$z" 2>/dev/null || true
    if [ "$(stat -c %d "$a")" = "$(stat -c %d "$(dirname "$z")")" ]; then
        mv "$a" "$z"
        echo "  $n: verschoben"
    else
        echo "  $n: kopiere auf anderes Laufwerk …"
        if command -v rsync >/dev/null 2>&1; then rsync -aH "$a"/ "$z"/; else mkdir -p "$z"; cp -a "$a"/. "$z"/; fi
        [ "$(find "$a" | wc -l)" = "$(find "$z" | wc -l)" ] && [ "$(du -sb "$a" | cut -f1)" = "$(du -sb "$z" | cut -f1)" ] \
            || { echo "FEHLER $n: Kopie stimmt nicht mit dem Original überein – nichts geändert, Original unberührt: $a" >&2; exit 1; }
        mv "$a" "$a.migriert-$DATUM"
        echo "  $n: kopiert und geprüft; Original liegt noch als $a.migriert-$DATUM"
    fi
}
verschieben Datenbank "$DB_ALT" "$DB_NEU"
verschieben App-Daten "$CA_ALT" "$CA_NEU"
verschieben Sicherungen "$BA_ALT" "$BA_NEU"

# Besitzer: App-Daten und Sicherungen gehören dem Benutzer, als der Amberwave läuft (PUID:PGID aus der .env, sonst der bisherige Besitzer)
U="$PUID_ENV"; G="$PGID_ENV"
[ -n "$U" ] && [ -n "$G" ] || { U="$(stat -c %u "$CA_NEU")"; G="$(stat -c %g "$CA_NEU")"; }
if [ "$U" != "0" ]; then
    chown -R "$U:$G" "$CA_NEU" "$BA_NEU" && echo "  Besitzer App-Daten/Sicherungen: $U:$G"
else
    echo "  Besitzer bleibt root – Amberwave erkennt beim Start selbst einen passenden Benutzer (oder PUID/PGID in die .env)."
fi

# .env umschreiben
cp -p "$ENV_DATEI" "$ENV_DATEI.vor-umzug-$DATUM"
TMP="$(mktemp)"
awk -v z="$ZIEL" -v sep="$BA_SEPARAT" -v ba="$BA_NEU" '
    /^[[:space:]]*(DB_DATA_PFAD|CACHE_PFAD|BACKUP_PFAD|APPDATA_PFAD|SICHERUNG_PFAD)=/ { print "# (alt, durch APPDATA_PFAD ersetzt) " $0; next }
    { print }
' "$ENV_DATEI" > "$TMP"
{
    cat "$TMP"
    printf '\n# ---- Ordner (umgezogen mit scripts/pfade-migrieren.sh am %s) ----\n' "$DATUM"
    printf '# Ein Ordner für Datenbank (db), App-Daten (cache) und Sicherungen (backups)\nAPPDATA_PFAD=%s\n' "$ZIEL"
    [ "$BA_SEPARAT" = 1 ] && printf '# Sicherungen auf einem anderen Laufwerk\nSICHERUNG_PFAD=%s\n' "$BA_NEU"
} > "$ENV_DATEI"
rm -f "$TMP"
echo "  .env aktualisiert (alte: $ENV_DATEI.vor-umzug-$DATUM)"

echo
if [ "$STARTEN" = 1 ] && [ "$DOCKER" = 1 ]; then
    if [ -n "$PROJ_NAME" ]; then
        docker compose -p "$PROJ_NAME" --project-directory "${PROJ_DIR:-$PROJEKT_ENV}" --env-file "$ENV_DATEI" up -d && echo "Stack gestartet."
    else
        docker compose --project-directory "$PROJEKT_ENV" --env-file "$ENV_DATEI" up -d && echo "Stack gestartet."
    fi
else
    echo "Fertig. Jetzt den Stack neu erstellen: in Unraid „Compose Down“ und „Compose Up“ (nicht nur Start – die Ordner stecken in den Containern)."
fi
echo "Kontrolle: Einstellungen › System & Ordner zeigt alle Ordner mit Herkunft. Läuft alles, dürfen die *.migriert-* Ordner weg."
