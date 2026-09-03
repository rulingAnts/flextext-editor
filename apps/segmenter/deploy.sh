#!/usr/bin/env bash
# The ONE deploy entry point for the audio-segmenter Worker. Set BOTH dashboard commands to:
#
#     bash deploy.sh
#
# Branch routing lives HERE, in git:
#   productionWeb  → `npx wrangler deploy`                    → https://audio-segmenter.flextext.app/
#   anything else  → `npx wrangler versions upload
#                      --preview-alias <branch>`              → https://<alias>-audio-segmenter.68mh29kgsd.workers.dev
#                     (production is NEVER touched by a preview upload)
#
# Before deploying anything it verifies release integrity and fails loudly.
set -euo pipefail
cd "$(dirname "$0")"

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
