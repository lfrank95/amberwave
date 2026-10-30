# All-in-One-Image (ghcr.io/lfrank95/amberwave-aio): eingebaute MariaDB 11.4 LTS und cloudflared im App-Container.
# Wird von start.sh eingelesen (nicht direkt ausführen), nachdem PUID/PGID gesetzt sind.
#
#  - MariaDB läuft als derselbe Benutzer wie Amberwave (PUID/PGID) – die Dateien in appdata gehören also nicht root und
#    überstehen „Fix Permissions“ auf Unraid. Sie lauscht nur auf 127.0.0.1, ist von außen nicht erreichbar.
#  - root der Datenbank meldet sich nur über den Unix-Socket an (= nur root im Container), ohne Passwort im Netz.
#  - Datenbank, Benutzer und Passwort legt dieses Skript selbst an (geheimnisse/datenbank.json) – keine Einrichtung nötig.
#  - Nach einem Image-Update mit neuer MariaDB-Version läuft mariadb-upgrade (Systemtabellen), die Daten bleiben.

AIO_DB_DIR="${AIO_DB_PFAD:-/appdata/db}"
AIO_SOCK=/run/mysqld/mysqld.sock
AIO_DB_PID=""
AIO_TUNNEL_PID=""

aio_sql() { mariadb --protocol=socket --socket="$AIO_SOCK" -uroot -N -B "$@"; }

aio_datenbank_starten() {
    WEB_GRUPPE="$(id -gn www-data)"
    mkdir -p "$AIO_DB_DIR" /run/mysqld "$CACHE_DIR/geheimnisse"
    rm -f /run/mysqld/beenden
    chown www-data:"$WEB_GRUPPE" "$AIO_DB_DIR" /run/mysqld
    chmod 700 "$CACHE_DIR/geheimnisse"; chown www-data:"$WEB_GRUPPE" "$CACHE_DIR/geheimnisse"
    # Gehört der Datenordner (z. B. nach PUID-Wechsel) jemand anderem: angleichen, sonst startet MariaDB nicht
    find "$AIO_DB_DIR" \( ! -user www-data -o ! -group "$WEB_GRUPPE" \) -exec chown www-data:"$WEB_GRUPPE" {} + 2>/dev/null

    cat > /etc/mysql/mariadb.conf.d/99-amberwave.cnf <<KONF
[mysqld]
user = www-data
datadir = $AIO_DB_DIR
socket = $AIO_SOCK
bind-address = 127.0.0.1
port = 3306
skip-name-resolve
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
innodb_buffer_pool_size = ${DB_PUFFER:-512M}
log_error = $AIO_DB_DIR/mariadb-fehler.log
[client]
socket = $AIO_SOCK
KONF

    NEU=0
    if [ ! -d "$AIO_DB_DIR/mysql" ]; then
        echo "AIO: lege die Datenbank in $AIO_DB_DIR an …"
        if ! mariadb-install-db --user=www-data --datadir="$AIO_DB_DIR" --auth-root-authentication-method=socket \
            --skip-test-db >/tmp/aio-install.log 2>&1; then
            cat /tmp/aio-install.log; return 1
        fi
        NEU=1
    fi

    mariadbd --defaults-file=/etc/mysql/my.cnf &
    AIO_DB_PID=$!
    i=0
    until mariadb-admin --socket="$AIO_SOCK" -uroot ping >/dev/null 2>&1; do
        i=$((i + 1))
        if [ $i -gt 120 ] || ! kill -0 "$AIO_DB_PID" 2>/dev/null; then
            echo "AIO: MariaDB startet nicht. Letzte Zeilen aus $AIO_DB_DIR/mariadb-fehler.log:"
            tail -n 20 "$AIO_DB_DIR/mariadb-fehler.log" 2>/dev/null
            return 1
        fi
        sleep 1
    done
    echo "AIO: MariaDB $(aio_sql -e 'SELECT VERSION()') läuft"
    # Neue MariaDB-Version im Image → Systemtabellen nachziehen (macht nichts, wenn schon aktuell)
    [ "$NEU" = "1" ] || mariadb-upgrade --socket="$AIO_SOCK" -uroot --silent >/dev/null 2>&1 || true

    # Zugang für Amberwave: aus geheimnisse/datenbank.json – fehlt die Datei, neu erzeugen. Bei jedem Start angleichen,
    # so passt alles wieder zusammen, falls nur der Datenbank- oder nur der Cache-Ordner neu ist.
    DATEI="$CACHE_DIR/geheimnisse/datenbank.json"
    if [ ! -s "$DATEI" ]; then
        php -r 'echo json_encode(["name" => "amberwave", "user" => "amberwave", "passwort" => bin2hex(random_bytes(20))]), "\n";' > "$DATEI.tmp" \
            && chmod 600 "$DATEI.tmp" && chown www-data:"$WEB_GRUPPE" "$DATEI.tmp" && mv "$DATEI.tmp" "$DATEI"
    fi
    # Werte als SQL-Literale (Name/Benutzer nur [A-Za-z0-9_], Passwort hex) – php prüft und baut das SQL
    SQL="$(php -r '
        $d = json_decode((string) file_get_contents($argv[1]), true) ?: [];
        $n = (string) ($d["name"] ?? ""); $u = (string) ($d["user"] ?? ""); $p = (string) ($d["passwort"] ?? "");
        if (!preg_match("/^\w{1,64}$/", $n) || !preg_match("/^\w{1,32}$/", $u) || !preg_match("/^[\w.-]{12,128}$/", $p)) { exit(1); }
        echo "CREATE DATABASE IF NOT EXISTS `$n` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n";
        foreach (["127.0.0.1", "localhost"] as $h) {
            echo "CREATE USER IF NOT EXISTS \x27$u\x27@\x27$h\x27 IDENTIFIED BY \x27$p\x27;\n";
            echo "ALTER USER \x27$u\x27@\x27$h\x27 IDENTIFIED BY \x27$p\x27;\n";
            echo "GRANT ALL PRIVILEGES ON `" . str_replace("_", "\\_", $n) . "`.* TO \x27$u\x27@\x27$h\x27;\n";
        }
        echo "FLUSH PRIVILEGES;\n";
    ' "$DATEI")" || { echo "AIO: $DATEI ist ungültig – Datei löschen und Container neu starten."; return 1; }
    printf '%s\n' "$SQL" | aio_sql || { echo "AIO: Konnte Datenbank/Benutzer nicht anlegen."; return 1; }
    [ "$NEU" = "1" ] && echo "AIO: Datenbank „amberwave“ und Zugang angelegt (geheimnisse/datenbank.json)"
    return 0
}

# Wächter im Hintergrund: startet MariaDB neu, falls sie abstürzt, und cloudflared (Fernzugriff): startet, sobald Amberwave unter Einstellungen › Zugang & Netz den Tunnel angelegt hat
# (Token in <Cache>/tunnel/token), und startet neu, wenn es beendet wurde. Ohne Token läuft nichts.
aio_waechter() {
    TOKEN="$CACHE_DIR/tunnel/token"
    while true; do
        sleep 20
        if ! pgrep -x mariadbd >/dev/null 2>&1 && [ ! -f /run/mysqld/beenden ]; then
            echo "AIO: MariaDB lief nicht mehr – starte neu"
            mariadbd --defaults-file=/etc/mysql/my.cnf &
        fi
        command -v cloudflared >/dev/null 2>&1 || continue
        if [ -s "$TOKEN" ]; then
            if [ -z "$AIO_TUNNEL_PID" ] || ! kill -0 "$AIO_TUNNEL_PID" 2>/dev/null; then
                runuser -u www-data -- cloudflared tunnel --no-autoupdate run --token-file "$TOKEN" &
                AIO_TUNNEL_PID=$!
            fi
        elif [ -n "$AIO_TUNNEL_PID" ]; then
            kill "$AIO_TUNNEL_PID" 2>/dev/null; AIO_TUNNEL_PID=""
        fi
    done
}

# Container wird gestoppt: Webserver, dann Datenbank sauber herunterfahren (kein Wiederherstellungslauf beim nächsten Start)
aio_beenden() {
    trap '' TERM INT
    [ -n "${AIO_WEB:-}" ] && kill -WINCH "$AIO_WEB" 2>/dev/null   # Apache: sanft beenden
    sleep 1
    [ -n "${AIO_WEB:-}" ] && kill -TERM "$AIO_WEB" 2>/dev/null
    : > /run/mysqld/beenden   # Wächter startet sie nicht wieder
    [ -n "${AIO_WACHE:-}" ] && kill "$AIO_WACHE" 2>/dev/null
    pkill -x cloudflared 2>/dev/null
    if pgrep -x mariadbd >/dev/null 2>&1; then
        echo "AIO: fahre MariaDB herunter …"
        mariadb-admin --socket="$AIO_SOCK" -uroot shutdown >/dev/null 2>&1 || pkill -TERM -x mariadbd
        i=0; while pgrep -x mariadbd >/dev/null 2>&1 && [ $i -lt 60 ]; do sleep 1; i=$((i + 1)); done
        echo "AIO: MariaDB beendet"
    fi
    exit 0
}
