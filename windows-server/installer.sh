#!/bin/bash
# Installationsassistent für den Amberwave Windows Server: derselbe Assistent wie beim Client (windows-client/sfx), mit
# -DAW_SERVER übersetzt. Ergebnis in <ausgabe>: sfx.exe (Assistent ohne Inhalt) und „Amberwave Server deinstallieren.exe“.
# Gepackt wird später mit windows-client/sfx/packen.py (Assistent + fertiger Paketordner → Installer-exe).
# Aufruf: installer.sh <ausgabe>   (braucht llvm-mingw, Python mit Pillow und fontTools)
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
CL="$HIER/../windows-client"
LLVM_MINGW="${LLVM_MINGW:-/home/claude/werkzeug/llvm-mingw}"
AUS="$1"; B="$AUS/bau"
mkdir -p "$B"
VERSION="$(grep -oE "'version' => '[^']+'" "$HIER/../app/includes/config.php" | head -1 | sed -E "s/.*'([^']+)'$/\1/")"
VNUM="${VERSION%%-*}"; V1="$(echo "$VNUM" | cut -d. -f1)"; V2="$(echo "$VNUM" | cut -d. -f2)"; V3="$(echo "$VNUM" | cut -d. -f3)"
rc_bauen() {
  sed "s/@V1@/$V1/g; s/@V2@/$V2/g; s/@V3@/$V3/g; s/@VERSION@/$VERSION/g; s/Amberwave Windows Client/Amberwave Server/g; s/Amberwave-Windows-Client/Amberwave-Windows-Server/g" "$1" > "$B/$(basename "$1")"
  cp "$(dirname "$1")"/*.manifest "$B/" 2>/dev/null || true
  (cd "$B" && "$LLVM_MINGW/bin/x86_64-w64-mingw32-windres" "$(basename "$1")" -O coff -o "$2")
}
python3 "$CL/werkzeug/assistent_bilder.py" "$HIER/../templates/amberwave.png" "$B"
PYTHONPATH="${BROTLI_SHIM:-}" python3 "$CL/werkzeug/schriften.py" "$HIER/../app/fonts" "$B"
python3 "$CL/werkzeug/lizenztexte.py" "$HIER/../LICENSE" "$HIER/../THIRD_PARTY_NOTICES.md" "$CL/sfx/lizenz_agpl_de.txt" "$B"

rc_bauen "$CL/sfx/deinstallieren.rc" "$B/deinst_res.o"
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang" -O2 -Wall -static -municode -mwindows -DAW_SERVER -o "$AUS/Amberwave Server deinstallieren.exe" "$B/deinst_res.o" \
  "$CL/sfx/deinstallieren.c" -lshell32 -ladvapi32 2>&1 | grep -E "warning|error" || true
rc_bauen "$CL/sfx/sfx.rc" "$B/sfx_res.o"
mkdir -p "$B/obj"
for c in sfx_kern xz/xz_crc32 xz/xz_dec_lzma2 xz/xz_dec_stream xz/xz_dec_bcj; do
  "$LLVM_MINGW/bin/x86_64-w64-mingw32-clang" -O2 -Wall -c "$CL/sfx/$c.c" -o "$B/obj/$(basename "$c").o"
done
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang++" -O2 -Wall -std=c++17 -static -municode -mwindows -DAW_SERVER -DAW_VERSION="L\"$VERSION\"" -I "$CL/sfx" \
  -o "$AUS/sfx.exe" "$B/sfx_res.o" "$CL/sfx/sfx.cpp" "$B/obj"/*.o \
  -lgdiplus -ldwmapi -lcomctl32 -lshell32 -lole32 -luuid -ladvapi32 -lgdi32 -lpropsys 2>&1 | grep -E "warning|error" || true
for f in "$AUS/sfx.exe" "$AUS/Amberwave Server deinstallieren.exe"; do [ -f "$f" ] || { echo "FEHLER: $f fehlt" >&2; exit 1; }; done
rm -rf "$B"
echo "Assistent gebaut ($VERSION): $AUS"
