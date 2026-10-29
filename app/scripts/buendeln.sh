#!/bin/bash
# Oberfläche bündeln: aus den ~40 ES-Modulen unter js/ werden wenige minimierte Dateien unter js/_b/ (bun build, Code-Splitting:
# selten gebrauchte Teile wie Verwaltung, Einstellungen, Effektrack bleiben eigene Stücke und laden erst beim Aufruf).
#
# Die App läuft auch OHNE Bündel – dann lädt der Browser die Quellmodule einzeln (langsamer beim ersten Start). index.php nimmt
# das Bündel nur, wenn es zu den Quellen passt (Prüfsumme in manifest.json); nach jeder Änderung an js/*.js also neu bündeln:
#     bash app/scripts/buendeln.sh
# Braucht bun (https://bun.sh). Quellkarten (.map) liegen daneben – der Browser holt sie nur mit geöffneten Entwicklerwerkzeugen.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP"
command -v bun >/dev/null || { echo "bun fehlt (https://bun.sh)"; exit 1; }
ZIEL="js/_b"
rm -rf "$ZIEL"
mkdir -p "$ZIEL"
bun build ./js/app.js --outdir "$ZIEL" --splitting --format esm --minify --sourcemap=external --target browser >/dev/null
# Prüfsumme der Quellen (Inhalt aller js/*.js) – damit erkennt index.php ein veraltetes Bündel
QUELLE=$(cat $(ls js/*.js | LC_ALL=C sort) | sha1sum | cut -d' ' -f1)
# Startmenge: Einstieg plus alles, was er statisch importiert (rekursiv) – für <link rel="modulepreload">
python3 - "$ZIEL" "$QUELLE" <<'EOF'
import json, os, re, sys
ziel, quelle = sys.argv[1], sys.argv[2]
dateien = sorted(f for f in os.listdir(ziel) if f.endswith('.js'))
start, stapel = [], ['app.js']
while stapel:
    f = stapel.pop()
    if f in start or f not in dateien: continue
    start.append(f)
    code = open(os.path.join(ziel, f), encoding='utf-8').read()
    # statische Importe (import x from"./a.js", import"./a.js", export ... from"./a.js") – keine import("…")
    for m in re.finditer(r'(?:\bfrom\s*|\bimport\s*|\bexport\s*\*\s*from\s*)["\']\./([A-Za-z0-9_.\-]+\.js)["\']', code):
        stapel.append(m.group(1))
groesse = {f: os.path.getsize(os.path.join(ziel, f)) for f in dateien}
json.dump({'quelle': quelle, 'einstieg': 'app.js', 'start': start, 'dateien': dateien, 'groesse': groesse}, open(os.path.join(ziel, 'manifest.json'), 'w'), indent=1)
print(f"Bündel: {len(dateien)} Dateien, Start {len(start)} Dateien / {sum(groesse[f] for f in start)//1024} KB, gesamt {sum(groesse.values())//1024} KB")
EOF
