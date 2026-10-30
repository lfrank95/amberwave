#!/bin/bash
# Baut app/js/aw-dsp.wasm aus der C-Bibliothek (clang mit wasm32-Ziel und wasm-ld, keine C-Bibliothek nötig).
set -e
HIER=$(cd "$(dirname "$0")" && pwd)
DSP="$HIER/.."
ZIEL="${1:-$DSP/../app/js/aw-dsp.wasm}"
clang --target=wasm32 -O3 -flto -nostdlib -nostdlibinc -isystem "$HIER/include" -isystem "$(clang -print-resource-dir)/include" \
  -mbulk-memory -mnontrapping-fptoint -msign-ext -mmutable-globals -fno-builtin-sin -ffp-contract=off -Wall -Wno-unknown-pragmas \
  -Wl,--no-entry -Wl,--allow-undefined-file="$HIER/importe.txt" -Wl,-z,stack-size=262144 -Wl,--initial-memory=4194304 \
  -o "$ZIEL" "$HIER/laufzeit.c" "$HIER/schnitt.c" "$DSP/gemeinsam.c" "$DSP/glow.c" "$DSP/iron.c" "$DSP/silk.c" "$DSP/eq.c" "$DSP/schwerpunkt.c"
echo "$(basename "$ZIEL"): $(stat -c %s "$ZIEL") Bytes"
