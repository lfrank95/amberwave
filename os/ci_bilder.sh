#!/bin/bash
# Bildschirmfotos eines CI-Laufs in den Zweig „ci-bilder“ legen (zum Ansehen ohne Anmeldung bei den Artefakten).
#   ci_bilder.sh <name> <ordner mit .png>
set -u
NAME="$1"; ORDNER="$2"
command -v cygpath >/dev/null && ORDNER="$(cygpath -u "$ORDNER")"
ls "$ORDNER"/*.png >/dev/null 2>&1 || { echo "keine Bilder"; exit 0; }
for versuch in 1 2 3 4; do
  D="$(mktemp -d)"
  (
    set -e
    cd "$D"
    git init -q
    git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
    if git fetch -q --depth 1 origin ci-bilder 2>/dev/null; then git checkout -q FETCH_HEAD; else git checkout -q --orphan ci-bilder; fi
    mkdir -p "$NAME"; rm -f "$NAME"/*.png
    cp "$ORDNER"/*.png "$NAME/"
    git add -A
    git -c user.name="Amberwave CI" -c user.email="ci@users.noreply.github.com" commit -qm "Bilder: $NAME (Lauf $GITHUB_RUN_ID)" || exit 0
    git push -q origin HEAD:ci-bilder
  ) && { echo "Bilder hochgeladen: $NAME"; exit 0; }
  sleep $((versuch * 3))
done
echo "::warning title=Bilder::konnten nicht hochgeladen werden"
