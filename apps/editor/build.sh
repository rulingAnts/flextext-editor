#!/usr/bin/env bash
# Assemble the deployable origin for the flextext-editor Worker. Runs via the wrangler.toml [build]
# hook on every deploy/versions-upload (harmless locally — public/ is gitignored).
set -euo pipefail
cd "$(dirname "$0")"

# ⚠ GUARD (structural, not advisory): in Cloudflare CI a NON-production branch may only build
# through deploy.sh, which uploads a preview VERSION. If a dashboard command is ever
# misconfigured back to raw `npx wrangler deploy`, this fails the build rather than letting a
# feature branch overwrite https://app.flextext.app/ .
BRANCH="${WORKERS_CI_BRANCH:-}"
if [ -n "$BRANCH" ] && [ "$BRANCH" != "productionWeb" ] && [ -z "${FX_CI_ROUTED:-}" ]; then
  echo "REFUSING TO BUILD: branch '$BRANCH' is not productionWeb and was not routed through" >&2
  echo "deploy.sh. Set the dashboard Deploy AND non-production (Version) commands to:" >&2
  echo "    bash deploy.sh" >&2
  exit 1
fi

rm -rf public
mkdir -p public
cp -R ../../docs/. public/
# A staging deploy under an unchanged VERSION would leave every browser serving the OLD
# cache for ever (cache-first, keyed by VERSION). Preview builds only; production is exempt.
# (repo root is two levels up for apps/*, one for paragraph-analysis — find it rather than assume)
for R in ../.. ..; do [ -f "$R/stamp-preview-cache.sh" ] && bash "$R/stamp-preview-cache.sh" public/sw.js && break; done

echo "assembled public/: $(find public -type f | wc -l | tr -d ' ') files"
