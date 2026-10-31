#!/bin/bash
# Amberwave Windows Client bauen: Engine cross-kompilieren, in Electron (win32-x64) einsetzen, Symbol und Versionsinfo
# eintragen, ungenutzte Grafik-Teile entfernen und als selbstentpackende exe packen (LZMA2, entpackt neben sich).
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
LLVM_MINGW="${LLVM_MINGW:-/home/claude/werkzeug/llvm-mingw}"
ELECTRON_ZIP="${ELECTRON_ZIP:-/home/claude/werkzeug/electron-win32-x64.zip}"
AUS="${AUS:-$HIER/dist}"
VERSION="$(node -p "require('$HIER/client/package.json').version")"

VNUM="${VERSION%%-*}"   # Vorabversion (z. B. 0.9.0-beta.1): Windows-Versionsinfo kennt nur Zahlen
V1="$(echo "$VNUM" | cut -d. -f1)"; V2="$(echo "$VNUM" | cut -d. -f2)"; V3="$(echo "$VNUM" | cut -d. -f3)"
rc_bauen() {   # Ressourcen mit Versionsnummern: rc_bauen quelle.rc ziel.o (symbol.ico liegt in build/)
  sed "s/@V1@/$V1/g; s/@V2@/$V2/g; s/@V3@/$V3/g; s/@VERSION@/$VERSION/g" "$1" > "$HIER/build/$(basename "$1")"
  cp "$(dirname "$1")"/*.manifest "$HIER/build/" 2>/dev/null || true
  (cd "$HIER/build" && "$LLVM_MINGW/bin/x86_64-w64-mingw32-windres" --codepage=65001 "$(basename "$1")" -O coff -o "$2")
}
mkdir -p "$HIER/build"
# Symbol (bis 48 px als BMP, darüber PNG)
python3 "$HIER/werkzeug/assistent_bilder.py" "$HIER/client/bilder/icon-256.png" "$HIER/build"
# Schriften des Installers (feste Schnitte aus den App-Schriften) und Lizenztexte (englisch + deutsche Übersetzung)
PYTHONPATH="${BROTLI_SHIM:-/home/claude/werkzeug/brotli_shim}" python3 "$HIER/werkzeug/schriften.py" "$HIER/../app/fonts" "$HIER/build"
python3 "$HIER/werkzeug/lizenztexte.py" "$HIER/../LICENSE" "$HIER/../THIRD_PARTY_NOTICES.md" "$HIER/sfx/lizenz_agpl_de.txt" "$HIER/build"

echo "Engine …"
rc_bauen "$HIER/engine/engine.rc" "$HIER/build/engine_res.o"
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang" -O2 -Wall -static -o "$HIER/build/amberwave-engine.exe" "$HIER/build/engine_res.o" \
  "$HIER/engine/engine.c" "$HIER/engine/klang.c" "$HIER/engine/vstanbindung.c" "$HIER/engine/ausgabe_wasapi.c" "$HIER/engine/ausgabe_asio.c" "$HIER/engine/geraet.c" "$HIER/engine/netz_win.c" \
  "$HIER/../dsp/gemeinsam.c" "$HIER/../dsp/glow.c" "$HIER/../dsp/iron.c" "$HIER/../dsp/silk.c" "$HIER/../dsp/eq.c" "$HIER/../dsp/schwerpunkt.c" \
  "$HIER/../dsp/upmix.c" "$HIER/../dsp/faltung.c" "$HIER/../dsp/raumgraph.c" "$HIER/../dsp/umrechner.c" \
  -lpthread -lole32 -lwinhttp -lavrt -luuid -lksuser -luser32 -ladvapi32 2>&1 | grep -v "dr_flac.h\|dr_wav.h" | grep -E "warning|error" || true

echo "VST3-Host …"
# VST3-SDK (MIT, Steinberg): nur die Schnittstellen (pluginterfaces + IID-Definitionen); Pfad per VST3_SDK, darin pluginterfaces/ und public.sdk/
VST3_SDK="${VST3_SDK:-/home/claude/werkzeug/vst3sdk}"
rc_bauen "$HIER/vsthost/vsthost.rc" "$HIER/build/vsthost_res.o"
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang++" -O2 -std=c++17 -static -Wall -Wno-unused -Wno-pragma-pack -Wno-format -I"$VST3_SDK" \
  -o "$HIER/build/amberwave-vsthost.exe" "$HIER/vsthost/vsthost.cpp" "$HIER/build/vsthost_res.o" \
  "$VST3_SDK/pluginterfaces/base/funknown.cpp" "$VST3_SDK/pluginterfaces/base/coreiids.cpp" \
  "$VST3_SDK/public.sdk/source/vst/vstinitiids.cpp" "$VST3_SDK/public.sdk/source/common/commoniids.cpp" \
  -Wl,--subsystem,windows -lole32 -luuid -luser32 -lgdi32 2>&1 | grep -E "warning|error" || true

echo "Electron $VERSION …"
ZIEL="$AUS/Amberwave Windows Client"
rm -rf "$ZIEL" && mkdir -p "$ZIEL"
unzip -q "$ELECTRON_ZIP" -d "$ZIEL"
mv "$ZIEL/electron.exe" "$ZIEL/Amberwave Client.exe"
rm -f "$ZIEL/resources/default_app.asar"
# nur deutsche und englische Sprachdateien (spart rund 40 MB)
find "$ZIEL/locales" -name '*.pak' ! -name 'de.pak' ! -name 'en-US.pak' -delete
# ungenutzt: WebGPU-Shadercompiler, Software-Grafik (SwiftShader/Vulkan) – Amberwave zeichnet mit Canvas 2D
rm -f "$ZIEL/dxcompiler.dll" "$ZIEL/dxil.dll" "$ZIEL/vk_swiftshader.dll" "$ZIEL/vk_swiftshader_icd.json" "$ZIEL/vulkan-1.dll"
# Amberwave-Symbol und Versionsinfo in die exe (Explorer, Taskleiste, Task-Manager)
python3 "$HIER/werkzeug/pe_symbol.py" "$ZIEL/Amberwave Client.exe" "$HIER/build/symbol.ico" "$VERSION" "Amberwave Windows Client" "Amberwave Client.exe"
mkdir -p "$ZIEL/resources/app/engine"
cp "$HIER/client/"{main.js,preload.js,suche.js,log.js,vst.js,i18n.js,i18n_en.json,einrichtung.html,package.json} "$ZIEL/resources/app/"
cp -r "$HIER/client/bilder" "$ZIEL/resources/app/"
cp "$HIER/build/amberwave-engine.exe" "$HIER/build/amberwave-vsthost.exe" "$ZIEL/resources/app/engine/"
cat "$HIER/../COPYRIGHT" - "$HIER/../LICENSE" > "$ZIEL/LIZENZ-Amberwave.txt" <<< ""
cp "$HIER/../THIRD_PARTY_NOTICES.md" "$ZIEL/DRITTANBIETER.md"
cat > "$ZIEL/LIESMICH.txt" <<TXT
Amberwave Windows Client $VERSION

Installiert nach %LOCALAPPDATA%\\Programs\\Amberwave (nur für dich, ohne Admin-Rechte), mit Eintrag im Startmenü.
Deinstallieren: Einstellungen → Apps → Amberwave Windows Client (oder „Amberwave deinstallieren.exe“ in diesem Ordner).
Ohne Installation: das Paket mit /portabel starten – dann landet der Ordner neben dem Paket.
Lizenz: AGPL-3.0 (LIZENZ-Amberwave.txt), Fremdkomponenten: DRITTANBIETER.md, Chromium: LICENSES.chromium.html.
Beim ersten Start sucht Amberwave den Server im Heimnetz (dauert ein bis zwei Sekunden). Wird nichts gefunden,
lässt sich die Adresse von Hand eingeben (z. B. 192.168.1.10, Port 9950).

Ausgabegerät und Exklusiv-Modus: Profil & Wiedergabe → Ausgabe (Windows).
Einstellungen liegen unter %APPDATA%\\amberwave-client\\einstellungen.json, Logs in %APPDATA%\\amberwave-client\\log\\.
TXT
echo "Deinstallation …"
rc_bauen "$HIER/sfx/deinstallieren.rc" "$HIER/build/deinst_res.o"
rm -f "$ZIEL/Amberwave deinstallieren.exe" "$HIER/build/sfx.exe"   # ein fehlgeschlagener Build darf keine alte exe einpacken
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang" -O2 -Wall -static -municode -mwindows -o "$ZIEL/Amberwave deinstallieren.exe" "$HIER/build/deinst_res.o" \
  "$HIER/sfx/deinstallieren.c" -lshell32 -ladvapi32 2>&1 | grep -E "warning|error" || true
echo "Paket …"
rc_bauen "$HIER/sfx/sfx.rc" "$HIER/build/sfx_res.o"
SFX_O="$HIER/build/sfx_obj" && mkdir -p "$SFX_O"
for c in sfx_kern xz/xz_crc32 xz/xz_dec_lzma2 xz/xz_dec_stream xz/xz_dec_bcj; do
  "$LLVM_MINGW/bin/x86_64-w64-mingw32-clang" -O2 -Wall -c "$HIER/sfx/$c.c" -o "$SFX_O/$(basename "$c").o"
done
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang++" -O2 -Wall -std=c++17 -static -municode -mwindows -DAW_VERSION="L\"$VERSION\"" -o "$HIER/build/sfx.exe" "$HIER/build/sfx_res.o" \
  "$HIER/sfx/sfx.cpp" "$SFX_O"/*.o \
  -lgdiplus -ldwmapi -lcomctl32 -lshell32 -lole32 -luuid -ladvapi32 -lgdi32 -lpropsys 2>&1 | grep -E "warning|error" || true
for f in "$ZIEL/Amberwave deinstallieren.exe" "$HIER/build/sfx.exe"; do [ -f "$f" ] || { echo "FEHLER: $f wurde nicht gebaut" >&2; exit 1; }; done
rm -f "$AUS/Amberwave-Windows-Client-$VERSION.exe"
python3 "$HIER/sfx/packen.py" "$HIER/build/sfx.exe" "$ZIEL" "$AUS/Amberwave-Windows-Client-$VERSION.exe"
ls -la "$AUS/Amberwave-Windows-Client-$VERSION.exe"
