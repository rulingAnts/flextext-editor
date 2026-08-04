#!/usr/bin/env bash
# Assemble the deployable origin for the paragraph-analysis-tool Worker. Runs via the
# wrangler.toml [build] hook on EVERY deploy/versions-upload (and is harmless locally —
# public/ is gitignored).
#
#   public/flextext-editor/     ← ../docs   (the shared engine, COPIED — same atomic deploy)
#   public/paragraph-analysis/  ← this shell (index.html, manifest, sw.js, icons)
#
# Copying docs/ wholesale keeps the engine paths byte-identical to the production editor's, so
# the same-origin engine loading works exactly as it does on github.io — but with no
# deploy-order hazard: the sw.js SHELL here can never precache a path this deployment lacks.
set -euo pipefail
cd "$(dirname "$0")"

# ⚠ GUARD (structural, not advisory): in Cloudflare's CI (WORKERS_CI_BRANCH is set), a
# NON-production branch may only build through deploy.sh (which uploads a preview VERSION).
# If a dashboard command is ever misconfigured back to raw `npx wrangler deploy`, this hook
# fails the build instead of letting a staging/feature branch overwrite https://pat.flextext.app/.
BRANCH="${WORKERS_CI_BRANCH:-}"
if [ -n "$BRANCH" ] && [ "$BRANCH" != "productionWeb" ] && [ -z "${FX_CI_ROUTED:-}" ]; then
  echo "REFUSING TO BUILD: branch '$BRANCH' is not productionWeb and this build was not routed" >&2
  echo "through deploy.sh. Set the dashboard Deploy AND non-production (Version) commands to:" >&2
  echo "    bash deploy.sh" >&2
  exit 1
fi

rm -rf public
mkdir -p public/paragraph-analysis
cp -R ../docs public/flextext-editor
cp index.html manifest.webmanifest sw.js public/paragraph-analysis/
cp -R icons public/paragraph-analysis/icons
echo "assembled public/: $(find public -type f | wc -l | tr -d ' ') files"
