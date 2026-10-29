#!/bin/sh
# Start des App-Containers (wird über docker-compose aufgerufen, liegt im Code-Ordner und kommt mit jedem Update).
# PUID/PGID: Webserver, Scanner und Zeitplan laufen als dieser Benutzer – auf Unraid 99:100 (nobody:users),
# so wie Lidarr, Sonarr & Co. Damit kann der Scanner alles lesen, was Lidarr anlegt.
set -u

# ---- Wer bin ich? Webserver, Scanner und Zeitplan laufen NIE als root, sondern als ein normaler Benutzer ----
# Reihenfolge: 1. PUID/PGID aus der .env (gewinnen immer)  2. beim ersten Start Gemerktes (<Cache>/.laufbenutzer)
# 3. der Besitzer des App-Daten-Ordners, sonst der Musiksammlung (so legt Unraid/Lidarr & Co. sie an)  4. Unraid-Standard 99:100.
# Was erkannt wurde, wird gemerkt – ein späteres Ändern der Ordnerrechte lässt Amberwave also nicht plötzlich als anderer Benutzer laufen.
CACHE_DIR="${PFAD_CACHE:-/cache}"
MUSIK_DIR="${PFAD_MUSIK:-/musik}"
MERKDATEI="$CACHE_DIR/.laufbenutzer"
ist_zahl() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
HERKUNFT=""
if ist_zahl "${PUID:-}" && [ "$PUID" != "0" ]; then
    HERKUNFT="env"
    ist_zahl "${PGID:-}" || PGID=""
elif [ "${PUID:-}" = "0" ]; then
    echo "Hinweis: PUID=0 (root) wird nicht verwendet – Amberwave läuft nie als root. Ein Benutzer wird erkannt."
    PUID=""; PGID=""
else
    PUID=""; PGID=""
fi
if [ -z "$HERKUNFT" ] && [ -s "$MERKDATEI" ]; then
    IFS=: read -r M_U M_G M_Q < "$MERKDATEI"
    if ist_zahl "$M_U" && ist_zahl "$M_G" && [ "$M_U" != "0" ]; then
        PUID="$M_U"; PGID="$M_G"; HERKUNFT="gemerkt"
    fi
fi
if [ -z "$HERKUNFT" ]; then
    for d in "$CACHE_DIR" "$MUSIK_DIR"; do
        [ -d "$d" ] || continue
        B_U="$(stat -c %u "$d" 2>/dev/null)"; B_G="$(stat -c %g "$d" 2>/dev/null)"
        if ist_zahl "$B_U" && [ "$B_U" != "0" ]; then
            PUID="$B_U"; PGID="${B_G:-100}"; HERKUNFT="erkannt:$d"
            break
        fi
    done
    if [ -z "$HERKUNFT" ]; then PUID=99; PGID=100; HERKUNFT="standard"; fi
    if [ -d "$CACHE_DIR" ] && [ -w "$CACHE_DIR" ]; then
        printf '%s:%s:%s\n' "$PUID" "$PGID" "${HERKUNFT#erkannt:}" > "$MERKDATEI" 2>/dev/null
    fi
fi
[ -n "$PGID" ] || PGID=100
export PUID PGID
export AW_BENUTZER_HERKUNFT="$HERKUNFT"
echo "Benutzer: UID $PUID / GID $PGID (Quelle: $HERKUNFT)"

if [ "$PUID" != "0" ] && [ "$(id -u www-data)" != "$PUID" -o "$(id -g www-data)" != "$PGID" ]; then
    if getent group "$PGID" >/dev/null 2>&1; then
        usermod -o -u "$PUID" -g "$PGID" www-data
    else
        groupmod -o -g "$PGID" www-data && usermod -o -u "$PUID" www-data
    fi
    echo "Amberwave läuft als UID $PUID / GID $PGID"
fi

# Apache nimmt seine Gruppe aus APACHE_RUN_GROUP (im Image: www-data = GID 33), nicht aus dem Benutzer. apache2-foreground
# liest beim Start /etc/apache2/envvars ein und setzt die Gruppe dort direkt zurück. Deshalb hängen wir die gewünschte
# Gruppe ans ENDE der Datei: Was zuletzt gesetzt wird, gewinnt. Ohne das gehörten neue Ordner/Dateien Gruppe 33
# (auf Unraid „sshd“) statt PGID, und auch der im Hintergrund gestartete Aufräumer liefe mit der falschen Gruppe.
if [ "$PUID" != "0" ] && [ -f /etc/apache2/envvars ]; then
    RUN_GRUPPE="$(id -gn www-data)"
    export APACHE_RUN_USER=www-data
    export APACHE_RUN_GROUP="$RUN_GRUPPE"
    if ! grep -q "^export APACHE_RUN_GROUP=$RUN_GRUPPE\$" /etc/apache2/envvars; then
        printf '\n# von Amberwave gesetzt: Webserver in der PGID-Gruppe laufen lassen\nexport APACHE_RUN_USER=www-data\nexport APACHE_RUN_GROUP=%s\n' "$RUN_GRUPPE" >> /etc/apache2/envvars
    fi
    echo "Apache-Gruppe: $RUN_GRUPPE"
fi

mkdir -p /cache/cover /cache/bilder /cache/tmp /cache/musicbrainz
# Merkdateien „Datenbank geprüft“ verwerfen – nach einem Neustart prüft der erste Aufruf die Migrationen einmal
rm -f /cache/tmp/schema-*.ok "${CACHE_DIR}/tmp/"schema-*.ok 2>/dev/null
# Eigene Ordner (Cache, Backups, Code für Updates) gehören dem Webserver-Benutzer – nur ändern, was nicht passt
for d in /cache /backups /var/www/html; do
    [ -d "$d" ] && find "$d" \( ! -user www-data -o ! -group "$(id -gn www-data)" \) -exec chown www-data:"$(id -gn www-data)" {} + 2>/dev/null
done

# ---- Direktzugang im Heimnetz: HTTPS auf Port 8443 im Container ----
# Das Zertifikat holt Amberwave selbst (Verwaltung → System → Direktzugang). Bis dahin liegt ein selbst
# signierter Platzhalter da, damit der Webserver starten kann. Im Stack den Port 8443 freigeben (nur im Heimnetz,
# keine Weiterleitung im Router nötig).
TLS="${PFAD_CACHE:-/cache}/tls"
mkdir -p "$TLS"
if [ ! -s "$TLS/fullchain.pem" ] || [ ! -s "$TLS/privkey.pem" ]; then
    php -r '
        $k = openssl_pkey_new(["private_key_type" => OPENSSL_KEYTYPE_EC, "curve_name" => "prime256v1"]);
        $csr = openssl_csr_new(["commonName" => "amberwave-platzhalter"], $k, ["digest_alg" => "sha256"]);
        $crt = openssl_csr_sign($csr, null, $k, 3650, ["digest_alg" => "sha256"]);
        openssl_x509_export($crt, $c); openssl_pkey_export($k, $p);
        file_put_contents($argv[1] . "/fullchain.pem", $c); file_put_contents($argv[1] . "/privkey.pem", $p);
    ' "$TLS" && echo "Direktzugang: Platzhalter-Zertifikat angelegt"
fi
chown -R www-data:"$(id -gn www-data)" "$TLS" 2>/dev/null
chmod 600 "$TLS/privkey.pem" 2>/dev/null
if [ -f /usr/lib/apache2/modules/mod_ssl.so ]; then
    a2enmod -q ssl >/dev/null 2>&1
    cat > /etc/apache2/sites-enabled/amberwave-direkt.conf <<KONF
Listen 8443
<VirtualHost *:8443>
    DocumentRoot /var/www/html
    SSLEngine on
    SSLCertificateFile $TLS/fullchain.pem
    SSLCertificateKeyFile $TLS/privkey.pem
    SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1
</VirtualHost>
KONF
    # Neues Zertifikat (die App legt die Datei „neu_laden“ an) → Webserver sanft neu laden, ohne laufende Streams abzubrechen
    (while true; do
        if [ -f "$TLS/neu_laden" ]; then rm -f "$TLS/neu_laden"; apache2ctl -k graceful >/dev/null 2>&1 && echo "Direktzugang: Zertifikat neu geladen"; fi
        sleep 3
    done) &
fi

# Einrichtung: wartet im Hintergrund auf die Datenbank. Eingerichtet → nichts weiter; sonst öffnet es das Einrichtungsfenster
# und schreibt den Link samt Code ins Log (docker logs amberwave_app).
(runuser -u www-data -- php /var/www/html/scripts/einrichtung_start.php 2>&1 &)

# Datenbank-Update (Migrationen samt Sicherung vorher) vor dem Webserver – nicht im ersten Seitenaufruf, wo Zeit- und
# Speichergrenzen gelten. Bricht den Start nie ab; Fehler stehen im Log und auf der Seite.
runuser -u www-data -- php /var/www/html/scripts/migrate.php --start || true

# Zeitplan (Mails, Ablauf-Erinnerungen, geplanter Scan, fanart.tv) jede Minute
(while true; do [ "$(stat -c %s /tmp/zeitplan.log 2>/dev/null || echo 0)" -gt 5000000 ] && : > /tmp/zeitplan.log; runuser -u www-data -- php /var/www/html/scripts/zeitplan.php >> /tmp/zeitplan.log 2>&1; sleep 60; done) &

exec apache2-foreground
