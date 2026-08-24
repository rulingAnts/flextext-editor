#!/usr/bin/env bash
# THE LOCAL RIG — the real worker, a real D1, no Cloudflare account, no Google, no network.
#
# Boots `wrangler dev --env staging --local` (workerd running worker/src/v1.js against a Miniflare
# D1), seeds synthetic fixtures, and runs the device-compat probe against it. This is the gate the
# researcher/project split is built behind: every phase must leave it green.
#
# Why it exists (Seth, 2026-08-17: "Let's build and test against the local rig"): the failure mode
# that actually hurts a field user is a migration or a response-shape change, and all of it is
# reproducible here. Staging remains for the three things local cannot do — real Google OAuth, real
# Drive, real edge CORS. See plans/project-split.md PART V.
#
#   bash test/local-rig.sh              # start, seed, run the device probe + session tests, stop
#   bash test/local-rig.sh --keep       # leave the worker running afterwards (probe by hand)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${FX_RIG_PORT:-8787}"
# ⚠⚠ PINNED, AND PINNED TO THE VERSION THE DEPLOY USES (.github/workflows/worker-deploy.yml
# `wranglerVersion`). Bare `npx wrangler` resolves to whatever is newest at that moment, so the rig
# silently tested a DIFFERENT wrangler from the one that ships — and it moved on its own on
# 2026-08-24 (4.118.0 -> 4.125.0), whose cold start took long enough to look like a hang. A test rig
# whose toolchain drifts underneath it is not reproducible, which is the one thing a rig is for.
# ⚠ Keep this equal to the deploy's pin; bump both together and re-run the rig afterwards.
WRANGLER_VERSION="${WRANGLER_VERSION:-4.118.0}"
LOG="$(mktemp -t flextext-rig-XXXX.log)"
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1

cleanup() {
  if [ "$KEEP" = "0" ] && [ -n "${WPID:-}" ]; then kill "$WPID" 2>/dev/null || true; fi
}
trap cleanup EXIT

# ⚠⚠ WIPE THE LOCAL D1 FIRST. schema-current.sql is all CREATE TABLE IF NOT EXISTS, and the miniflare
# database PERSISTS between runs in worker/.wrangler/state — so a table that already exists is left
# exactly as it was and a NEWLY ADDED COLUMN never appears. The failure is horrible to read: the
# schema applies "successfully", then every INSERT naming the new column 500s, and the probes report
# a screenful of unrelated-looking device-lane failures. (2026-08-23: cost a full debugging cycle.)
# A fresh clone or CI never sees it; only local re-runs across a schema change do, which is exactly
# when you are least expecting it.
#
# Wiping is free — every row here is a synthetic fixture re-seeded on the next line — so it is
# unconditional rather than a flag nobody would remember to pass. FX_RIG_KEEP_DB=1 opts out.
if [ "${FX_RIG_KEEP_DB:-0}" != "1" ]; then
  echo "== wiping the local D1 (schema is IF NOT EXISTS; a stale table hides new columns) =="
  rm -rf worker/.wrangler/state/v3/d1
fi

echo "== seeding the local D1 (synthetic fixtures — never production rows) =="
node test/worker-seed.mjs

echo "== starting the worker on :$PORT (log: $LOG) =="
# ALLOWED_RESEARCHERS makes the fixture an OPERATOR, which the projects backfill endpoint requires.
# --var overrides the wrangler.toml value for this run only; nothing is written to any config.
( cd worker && npx --yes wrangler@"$WRANGLER_VERSION" dev --env staging --local --port "$PORT" --ip 127.0.0.1 \
    --var ALLOWED_RESEARCHERS:fixture@example.invalid --var SERVER_HMAC_KEY:local-rig-not-a-secret \
    >"$LOG" 2>&1 ) &
WPID=$!

for _ in $(seq 1 60); do
  if curl -s -o /dev/null --noproxy '*' "http://127.0.0.1:$PORT/v1/researcher" 2>/dev/null; then break; fi
  sleep 1
done
if ! curl -s -o /dev/null --noproxy '*' "http://127.0.0.1:$PORT/v1/researcher" 2>/dev/null; then
  echo "worker did not come up; last 20 log lines:" >&2; tail -20 "$LOG" >&2; exit 1
fi
echo "worker is up"

echo
NO_PROXY='*' node test/worker-device-compat.probe.mjs "http://127.0.0.1:$PORT"
STATUS=$?
echo
NO_PROXY='*' node test/worker-sessions.test.mjs "http://127.0.0.1:$PORT" || STATUS=1
echo
NO_PROXY='*' node test/worker-projects.test.mjs "http://127.0.0.1:$PORT" || STATUS=1

if [ "$KEEP" = "1" ]; then
  echo
  echo "worker still running on :$PORT (pid $WPID). Stop it with: kill $WPID"
fi
exit $STATUS
