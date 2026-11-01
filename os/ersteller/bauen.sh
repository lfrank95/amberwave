#!/bin/bash
# Amberwave USB-Ersteller (Windows) mit llvm-mingw bauen. Aufruf: bauen.sh <ausgabeordner>
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
LLVM_MINGW="${LLVM_MINGW:-/home/claude/werkzeug/llvm-mingw}"
AUS="${1:-$HIER/aus}"; B="$AUS/bau"; mkdir -p "$B"
VERSION="$(grep -oE "'version' => '[^']+'" "$HIER/../../app/includes/config.php" | head -1 | sed -E "s/.*'([^']+)'$/\1/")"
VNUM="${VERSION%%-*}"; V1="$(echo "$VNUM" | cut -d. -f1)"; V2="$(echo "$VNUM" | cut -d. -f2)"; V3="$(echo "$VNUM" | cut -d. -f3)"
PYTHONPATH="${BROTLI_SHIM:-/home/claude/werkzeug/brotli_shim}" python3 "$HIER/../../windows-client/werkzeug/schriften.py" "$HIER/../../app/fonts" "$B" >/dev/null
cp "$HIER/../../windows-client/sfx/symbol.ico" "$HIER/ersteller.manifest" "$B/"
sed "s/@V1@/$V1/g; s/@V2@/$V2/g; s/@V3@/$V3/g; s/@VERSION@/$VERSION/g" "$HIER/ersteller.rc" > "$B/ersteller.rc"
(cd "$B" && "$LLVM_MINGW/bin/x86_64-w64-mingw32-windres" --codepage=65001 ersteller.rc -O coff -o ersteller_res.o)
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang++" -O2 -Wall -std=c++17 -static -municode -mwindows -DAW_VERSION="L\"$VERSION\"" \
  -o "$AUS/Amberwave-USB-Ersteller-$VERSION.exe" "$HIER/ersteller.cpp" "$B/ersteller_res.o" \
  -lgdiplus -lwinhttp -lcomdlg32 -ldwmapi -lshell32 -lole32 -luser32 -lgdi32 2>&1 | grep -E "warning|error" || true
ls -la "$AUS/Amberwave-USB-Ersteller-$VERSION.exe"
