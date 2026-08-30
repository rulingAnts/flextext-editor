#!/usr/bin/env bash
# The ONE deploy entry point for the flextext-researcher Worker. Set BOTH dashboard commands to:
#
#     bash deploy.sh
#
# Branch routing lives HERE, in git:
#   productionWeb  → `npx wrangler deploy`                    → https://research.flextext.app/
#   anything else  → `npx wrangler versions upload
#                      --preview-alias <branch>`              → https://<alias>-flextext-researcher.68mh29kgsd.workers.dev
#                     (production is NEVER touched by a preview upload)
#
# Before deploying anything it verifies release integrity and fails loudly.
set -euo pipefail
cd "$(dirname "$0")"

export FX_CI_ROUTED=1
bash build.sh

echo "== integrity: version sync =="
node ../../test/version-sync.test.mjs

echo "== integrity: the researcher worker caches NOTHING (2026-08-31) =="
# The researcher panel is an online console: its sw.js deliberately has NO SHELL and writes no
# cache (see satellites/flextext-researcher/sw.js and its CLAUDE.md). The old SHELL-paths check is
# replaced by its inverse — the guard now fails if precaching ever creeps back in, because a SHELL
# here re-creates the deploy-order outage surface and the stale-panel window on purpose removed.
node - <<'NODE'
const { readFileSync } = require('node:fs');
const sw = readFileSync('public/sw.js', 'utf8');
const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
let fail = 0;
if (/const SHELL\s*=/.test(code)) { console.error('FAIL: a SHELL array reappeared in the researcher sw.js'); fail++; }
if (/addAll|cache\.put|precache/i.test(code)) { console.error('FAIL: the researcher sw.js writes a cache again'); fail++; }
if (!/OFFLINE_HTML/.test(sw)) { console.error('FAIL: the inlined offline page is missing'); fail++; }
if (fail) process.exit(1);
console.log('ok: non-caching worker, offline page inlined');
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
