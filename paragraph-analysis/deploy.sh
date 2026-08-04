#!/usr/bin/env bash
# The ONE deploy entry point for the paragraph-analysis-tool Worker — set BOTH Cloudflare
# dashboard commands (Deploy command AND the non-production "Version" command) to:
#
#     bash deploy.sh
#
# Branch routing lives HERE, in git (Seth's rule: safety guarded in the workflow, not in
# dashboard state or AI memory):
#   productionWeb  → `npx wrangler deploy`                      → https://pat.flextext.app/
#   anything else  → `npx wrangler versions upload
#                      --preview-alias <branch>`                → preview version at
#                     https://<alias>-paragraph-analysis-tool.68mh29kgsd.workers.dev
#                     (production is NEVER touched by a preview upload)
#
# Before deploying ANYTHING it verifies release integrity and fails loudly:
#   1. version-sync: every version site agrees (the repo's own test, run from the full clone);
#   2. every path in this app's sw.js SHELL exists in the assembled public/ — the local,
#      by-construction equivalent of check-release-integrity.sh (a precached 404 = dead offline).
set -euo pipefail
cd "$(dirname "$0")"

export FX_CI_ROUTED=1          # tells build.sh this build went through the router
bash build.sh

echo "== integrity: version sync =="
node ../test/version-sync.test.mjs

echo "== integrity: sw.js SHELL paths exist in public/ =="
node - <<'NODE'
const { readFileSync, existsSync } = require('node:fs');
const sw = readFileSync('sw.js', 'utf8');
const m = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!m) { console.error('FAIL: no SHELL array in sw.js'); process.exit(1); }
const entries = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
let fail = 0;
for (const e of entries) {
  const p = e === './' ? 'public/paragraph-analysis/index.html'
    : e.startsWith('/') ? 'public' + e
    : 'public/paragraph-analysis/' + e;
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
  # A stable, branch-named preview URL; alias chars: lowercase alphanumerics + hyphens.
  ALIAS=$(printf '%s' "$BRANCH" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/^-*//;s/-*$//' | cut -c1-63)
  echo "== PREVIEW upload (branch: $BRANCH → alias: $ALIAS) =="
  npx wrangler versions upload --preview-alias "$ALIAS"
fi
