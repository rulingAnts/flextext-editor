#!/usr/bin/env bash
# The ONE deploy entry point for the consent-collector Worker. Set BOTH dashboard commands to:
#
#     bash deploy.sh
#
# Branch routing lives HERE, in git:
#   productionWeb  → `npx wrangler deploy`                    → https://consent.flextext.app/
#   beta           → `npx wrangler deploy --name <worker>-beta`
#                                                   → https://<worker>-beta.68mh29kgsd.workers.dev
#   anything else  → `npx wrangler versions upload
#                      --preview-alias <branch>`              → https://<alias>-consent-collector.68mh29kgsd.workers.dev
#                     (production is NEVER touched by a preview upload)
#
# Before deploying anything it verifies release integrity and fails loudly.
set -euo pipefail
cd "$(dirname "$0")"
# ⚠ HELD BACK FROM PRODUCTION while HOLD-BACK exists. Used once (Seth, 2026-09-05: "hold
# consent-collector back from that release"), released the same day in v584; without the marker
# this guard is inert. Re-create the file to hold the app back again. The guard lives HERE, not in the Actions workflow, because production has two
# deploy paths — the workflow's matrix and Cloudflare's git-connected build — and both run this
# script. Exit 0, not 1: a held app is not a failed one, and the other apps' jobs must not be
# coloured by it. Delete HOLD-BACK to release. Beta is held too: beta rehearses the release, so an
# app that will not ship must not be on it either.
if { [ "${WORKERS_CI_BRANCH:-productionWeb}" = "productionWeb" ] || [ "${WORKERS_CI_BRANCH:-}" = "beta" ]; } && [ -f HOLD-BACK ]; then
  echo "== consent collector is HELD BACK from production (apps/consent/HOLD-BACK) — nothing deployed; the live site is unchanged =="
  exit 0
fi

export FX_CI_ROUTED=1
bash build.sh

echo "== integrity: version sync =="
node ../../test/version-sync.test.mjs

echo "== integrity: every sw.js SHELL path exists in public/ =="
node - <<'NODE'
const { readFileSync, existsSync } = require('node:fs');
const sw = readFileSync('public/sw.js', 'utf8');
const m = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!m) { console.error('FAIL: no SHELL array in sw.js'); process.exit(1); }
const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
let fail = 0;
for (const e of entries) {
  const p = e === './' ? 'public/index.html' : e.startsWith('/') ? 'public' + e : 'public/' + e;
  if (!existsSync(p)) { console.error('FAIL: SHELL entry not in build: ' + e + ' (' + p + ')'); fail++; }
}
if (fail) process.exit(1);
console.log('ok: all ' + entries.length + ' SHELL paths present');
NODE

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
