#!/usr/bin/env bash
# The ONE deploy entry point for the consent-collector Worker. Set BOTH dashboard commands to:
#
#     bash deploy.sh
#
# Branch routing lives HERE, in git:
#   productionWeb  → `npx wrangler deploy`                    → https://consent.flextext.app/
#   anything else  → `npx wrangler versions upload
#                      --preview-alias <branch>`              → https://<alias>-consent-collector.68mh29kgsd.workers.dev
#                     (production is NEVER touched by a preview upload)
#
# Before deploying anything it verifies release integrity and fails loudly.
set -euo pipefail
cd "$(dirname "$0")"
# ⚠ HELD BACK FROM PRODUCTION while HOLD-BACK exists (Seth, 2026-09-05: "hold consent-collector back
# from that release"). The guard lives HERE, not in the Actions workflow, because production has two
# deploy paths — the workflow's matrix and Cloudflare's git-connected build — and both run this
# script. Exit 0, not 1: a held app is not a failed one, and the other apps' jobs must not be
# coloured by it. Delete HOLD-BACK to release.
if [ "${WORKERS_CI_BRANCH:-productionWeb}" = "productionWeb" ] && [ -f HOLD-BACK ]; then
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
else
  ALIAS=$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/^-*//;s/-*$//' | cut -c1-63)
  echo "== PREVIEW upload (branch: $BRANCH → alias: $ALIAS) =="
  npx wrangler versions upload --preview-alias "$ALIAS"
fi
