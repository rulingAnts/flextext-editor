#!/usr/bin/env bash
# Assemble the deployable origin for the flextext-paragraph Worker (run by Cloudflare's
# git-connected build; harmless to run locally — public/ is gitignored).
#
#   public/flextext-editor/     ← ../docs   (the shared engine, COPIED — same atomic deploy)
#   public/paragraph-analysis/  ← this shell (index.html, manifest, sw.js, icons)
#
# Copying docs/ wholesale keeps the engine paths byte-identical to the production editor's, so
# the same-origin engine loading works exactly as it does on github.io — but with no
# deploy-order hazard: the sw.js SHELL here can never precache a path this deployment lacks.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf public
mkdir -p public/paragraph-analysis
cp -R ../docs public/flextext-editor
cp index.html manifest.webmanifest sw.js public/paragraph-analysis/
cp -R icons public/paragraph-analysis/icons
echo "assembled public/: $(find public -type f | wc -l | tr -d ' ') files"
