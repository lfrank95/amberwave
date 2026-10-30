#!/bin/bash
# Baut „Amberwave Server.exe“ (Programm im Infobereich) mit llvm-mingw. Aufruf: bauen.sh <ziel.exe>
set -euo pipefail
HIER="$(cd "$(dirname "$0")" && pwd)"
LLVM_MINGW="${LLVM_MINGW:-/home/claude/werkzeug/llvm-mingw}"
ZIEL="${1:-$HIER/build/Amberwave Server.exe}"
VERSION="$(grep -oE "'version' => '[^']+'" "$HIER/../app/includes/config.php" | head -1 | sed -E "s/.*'([^']+)'$/\1/")"
mkdir -p "$HIER/build" "$(dirname "$ZIEL")"
"$LLVM_MINGW/bin/x86_64-w64-mingw32-windres" -DAW_VERSION_A="\\\"$VERSION\\\"" -I "$HIER/tray" "$HIER/tray/server.rc" -O coff -o "$HIER/build/server_res.o"
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang++" -O2 -std=c++17 -municode -mwindows -static -DAW_VERSION="L\"$VERSION\"" \
  -o "$ZIEL" "$HIER/tray/server.cpp" "$HIER/build/server_res.o" -lws2_32 -lshell32 -lole32 -luuid -ladvapi32 -lcomctl32 -lwinhttp -lurlmon
# Effekt-Rechner für Geräte im Heimnetz (DLNA/Cast) – dieselbe Klangkette wie die Engine
E="$HIER/../windows-client/engine"
"$LLVM_MINGW/bin/x86_64-w64-mingw32-clang" -O2 -w -static -I"$HIER/../dsp" -o "$(dirname "$ZIEL")/aw-render.exe" \
  "$E/aw_render.c" "$E/klang.c" "$E/vstanbindung.c" "$HIER/../dsp/"*.c -lm -lpthread
echo "gebaut: $ZIEL, aw-render.exe ($VERSION)"
