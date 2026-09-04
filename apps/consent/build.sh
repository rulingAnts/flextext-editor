#!/usr/bin/env bash
# Assemble the deployable origin for the consent-collector Worker. Runs via the wrangler.toml [build]
# hook on every deploy/versions-upload (harmless locally — public/ is gitignored).
set -euo pipefail
cd "$(dirname "$0")"

# ⚠ GUARD (structural, not advisory): in Cloudflare CI a NON-production branch may only build
# through deploy.sh, which uploads a preview VERSION. If a dashboard command is ever
# misconfigured back to raw `npx wrangler deploy`, this fails the build rather than letting a
# feature branch overwrite https://consent.flextext.app/ .
BRANCH="${WORKERS_CI_BRANCH:-}"
# ⚠ HELD BACK FROM PRODUCTION while HOLD-BACK exists (Seth, 2026-09-05). deploy.sh already exits 0
# before reaching this script; this second guard is for the case the structural guard below also
# covers — a dashboard command reset to raw `npx wrangler deploy`, which would run this build hook
# directly and then publish. A build that FAILS publishes nothing, so here the exit is non-zero.
if [ "$BRANCH" = "productionWeb" ] && [ -f HOLD-BACK ]; then
  echo "REFUSING TO BUILD: the consent collector is HELD BACK from production (apps/consent/HOLD-BACK)." >&2
  echo "Delete that file to release it. The live site is unchanged." >&2
  exit 1
fi
if [ -n "$BRANCH" ] && [ "$BRANCH" != "productionWeb" ] && [ -z "${FX_CI_ROUTED:-}" ]; then
  echo "REFUSING TO BUILD: branch '$BRANCH' is not productionWeb and was not routed through" >&2
  echo "deploy.sh. Set the dashboard Deploy AND non-production (Version) commands to:" >&2
  echo "    bash deploy.sh" >&2
  exit 1
fi

rm -rf public
mkdir -p public
cp -R ../../satellites/consent-collector/. public/
rm -f public/CLAUDE.md public/README.md public/check-editor-shell.sh
# The satellites load the engine cross-path at /flextext-editor/… — copy it into the SAME
# deployment so the shell and its engine ship atomically and a precached path can never 404.
cp -R ../../docs public/flextext-editor
# A staging deploy under an unchanged VERSION would leave every browser serving the OLD
# cache for ever (cache-first, keyed by VERSION). Preview builds only; production is exempt.
# (repo root is two levels up for apps/*, one for paragraph-analysis — find it rather than assume)
for R in ../.. ..; do [ -f "$R/stamp-preview-cache.sh" ] && bash "$R/stamp-preview-cache.sh" public/sw.js && break; done

echo "assembled public/: $(find public -type f | wc -l | tr -d ' ') files"
