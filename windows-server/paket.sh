#!/bin/bash
# Stellt den Amberwave Windows Server zusammen (läuft auf einem Windows-Rechner von GitHub, Git-Bash):
# lädt PHP, nginx, MariaDB, ffmpeg, flac, fpcalc, cloudflared und Python, legt Amberwave (app/) und das
# Programm für den Infobereich dazu. Aufruf: paket.sh <Zielordner> <Pfad zu „Amberwave Server.exe“>
set -euo pipefail
ZIEL="$1"; TRAY="$2"
HIER="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
mkdir -p "$ZIEL"
laden() { echo "lade $1"; curl -fsSL --retry 3 -o "$2" "$1"; }
auspacken() { mkdir -p "$2"; unzip -q -o "$1" -d "$2"; }

# PHP 8.3 (Nicht-Threadsafe, für php-cgi) – neueste Version aus der Liste von windows.php.net
PHPZIP="$(curl -fsSL https://windows.php.net/downloads/releases/releases.json | python -c "import json,sys; d=json.load(sys.stdin)['8.3']; print(d['nts-vs16-x64']['zip']['path'])")"
laden "https://windows.php.net/downloads/releases/$PHPZIP" "$TMP/php.zip"
auspacken "$TMP/php.zip" "$ZIEL/php"
cp /c/Windows/System32/vcruntime140.dll /c/Windows/System32/vcruntime140_1.dll /c/Windows/System32/msvcp140.dll "$ZIEL/php/"
cp "$HIER/php.ini" "$ZIEL/php/php.ini"
rm -rf "$ZIEL/php/dev" "$ZIEL/php/extras" "$ZIEL/php/"*.pdb "$ZIEL/php/phpdbg"* "$ZIEL/php/php-win.exe"

# nginx (stabile Linie)
NGINX="$(curl -fsSL https://nginx.org/en/download.html | grep -oE 'nginx-1\.[0-9]+\.[0-9]+\.zip' | sed -n 2p)"
laden "https://nginx.org/download/$NGINX" "$TMP/nginx.zip"
auspacken "$TMP/nginx.zip" "$TMP/nginx"
mv "$TMP/nginx/"nginx-*/ "$ZIEL/nginx"
rm -rf "$ZIEL/nginx/html" "$ZIEL/nginx/contrib" "$ZIEL/nginx/docs/"*.html

# MariaDB 11.8 LTS (ZIP für Windows x64)
MDB="$(curl -fsSL https://downloads.mariadb.org/rest-api/mariadb/11.8/latest/ | python -c "
import json,sys
d=json.load(sys.stdin)
for rel in d['releases'].values():
    for f in rel['files']:
        if f['file_name'].endswith('-winx64.zip') and 'debug' not in f['file_name']:
            print(f['file_download_url']); raise SystemExit
")"
laden "$MDB" "$TMP/mariadb.zip"
auspacken "$TMP/mariadb.zip" "$TMP/mariadb"
mv "$TMP/mariadb/"mariadb-*/ "$ZIEL/mariadb"
rm -rf "$ZIEL/mariadb/mysql-test" "$ZIEL/mariadb/sql-bench" "$ZIEL/mariadb/include" "$ZIEL/mariadb/data"
find "$ZIEL/mariadb" -name '*.pdb' -delete -o -name '*.lib' -delete
cp /c/Windows/System32/vcruntime140.dll /c/Windows/System32/vcruntime140_1.dll /c/Windows/System32/msvcp140.dll "$ZIEL/mariadb/bin/"

# ffmpeg (Build von gyan.dev, „essentials“: Opus, AAC, MP3 …)
laden https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip "$TMP/ffmpeg.zip"
auspacken "$TMP/ffmpeg.zip" "$TMP/ffmpeg"
mkdir -p "$ZIEL/ffmpeg/bin"
cp "$TMP/ffmpeg/"ffmpeg-*/bin/ffmpeg.exe "$TMP/ffmpeg/"ffmpeg-*/bin/ffprobe.exe "$ZIEL/ffmpeg/bin/"
cp "$TMP/ffmpeg/"ffmpeg-*/LICENSE "$ZIEL/ffmpeg/LICENSE.txt" 2>/dev/null || true

# flac / metaflac
laden https://ftp.osuosl.org/pub/xiph/releases/flac/flac-1.4.3-win.zip "$TMP/flac.zip"
auspacken "$TMP/flac.zip" "$TMP/flac"
mkdir -p "$ZIEL/flac"
cp "$TMP/flac/"flac-*/Win64/flac.exe "$TMP/flac/"flac-*/Win64/metaflac.exe "$ZIEL/flac/"
cp "$TMP/flac/"flac-*/COPYING.Xiph "$ZIEL/flac/" 2>/dev/null || true

# fpcalc (Chromaprint – Erkennung am Klang)
laden https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-windows-x86_64.zip "$TMP/fpcalc.zip"
auspacken "$TMP/fpcalc.zip" "$TMP/fpcalc"
mkdir -p "$ZIEL/fpcalc"; cp "$TMP/fpcalc/"*/fpcalc.exe "$ZIEL/fpcalc/"

# cloudflared (Fernzugriff)
mkdir -p "$ZIEL/cloudflared"
laden https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe "$ZIEL/cloudflared/cloudflared.exe"

# Python (eingebettete Fassung) mit numpy für die Klanganalyse
PYV=3.12.8
laden "https://www.python.org/ftp/python/$PYV/python-$PYV-embed-amd64.zip" "$TMP/python.zip"
auspacken "$TMP/python.zip" "$ZIEL/python"
python -m pip download --quiet --only-binary=:all: --platform win_amd64 --python-version 3.12 numpy -d "$TMP/raeder"
mkdir -p "$ZIEL/python/Lib/site-packages"
for r in "$TMP/raeder/"*.whl; do unzip -q -o "$r" -d "$ZIEL/python/Lib/site-packages"; done
PTH="$(ls "$ZIEL/python/"python*._pth)"
printf 'python312.zip\r\n.\r\nLib\\site-packages\r\nimport site\r\n' > "$PTH"

# Amberwave selbst + Programm für den Infobereich
cp -r "$HIER/../app" "$ZIEL/app"
rm -rf "$ZIEL/app/bin"   # Linux-Programme (Effekt-Rechner) – folgt als Windows-Fassung
cp "$TRAY" "$ZIEL/Amberwave Server.exe"
cp "$HIER/../LICENSE" "$ZIEL/LICENSE.txt"
cp "$HIER/../COPYRIGHT" "$ZIEL/COPYRIGHT.txt"
cp "$HIER/LIESMICH.txt" "$ZIEL/LIESMICH.txt"
rm -rf "$TMP"
du -sh "$ZIEL"
