#!/usr/bin/env bash
# The ONE deploy entry point for the flextext-crowd Worker. Set BOTH dashboard commands to:
#
#     bash deploy.sh
#
# Branch routing lives HERE, in git:
#   productionWeb  → `npx wrangler deploy`                    → https://crowd.flextext.app/
#   beta           → `npx wrangler deploy --name <worker>-beta`
#                                                   → https://<worker>-beta.68mh29kgsd.workers.dev
#   anything else  → `npx wrangler versions upload
#                      --preview-alias <branch>`              → https://<alias>-flextext-crowd.68mh29kgsd.workers.dev
#                     (production is NEVER touched by a preview upload)
#
# Before deploying anything it verifies release integrity and fails loudly.
set -euo pipefail
cd "$(dirname "$0")"

export FX_CI_ROUTED=1
bash build.sh

echo "== integrity: version sync =="
node ../../test/version-sync.test.mjs

BRANCH="${WORKERS_CI_BRANCH:-productionWeb}"
if [ "$BRANCH" = "productionWeb" ]; then
  echo "== PRODUCTION deploy (branch: $BRANCH) =="
  npx wrangler deploy
elif [ "$BRANCH" = "beta" ]; then
  # THE BETA TIER (Seth, 2026-10-10): a real `wrangler deploy`, like production, but to a SEPARATE
  # Worker named <this worker>-beta — its own origin, its own version history, its own installed
  # PWAs. Not a preview alias: an alias is a version OF the production Worker, and a beta that real
  # people install for weeks must not sit in the list `rollback` chooses from. --name creates the
  # Worker on first deploy, so no dashboard step is needed. The name comes from wrangler.toml so the
  # two can never disagree.
  NAME=$(grep -m1 -E '^name = "' wrangler.toml | sed 's/^name = "//;s/"$//')
  [ -n "$NAME" ] || { echo "FAIL: no name = \"...\" line in wrangler.toml" >&2; exit 1; }
  echo "== BETA deploy (branch: $BRANCH → Worker: $NAME-beta) =="
  npx wrangler deploy --name "$NAME-beta"
else
  ALIAS=$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/^-*//;s/-*$//' | cut -c1-63)
  echo "== PREVIEW upload (branch: $BRANCH → alias: $ALIAS) =="
  npx wrangler versions upload --preview-alias "$ALIAS"
fi
