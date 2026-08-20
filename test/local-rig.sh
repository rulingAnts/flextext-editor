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
LOG="$(mktemp -t flextext-rig-XXXX.log)"
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1

cleanup() {
  if [ "$KEEP" = "0" ] && [ -n "${WPID:-}" ]; then kill "$WPID" 2>/dev/null || true; fi
}
trap cleanup EXIT

echo "== seeding the local D1 (synthetic fixtures — never production rows) =="
node test/worker-seed.mjs

echo "== starting the worker on :$PORT (log: $LOG) =="
# ALLOWED_RESEARCHERS makes the fixture an OPERATOR, which the projects backfill endpoint requires.
# --var overrides the wrangler.toml value for this run only; nothing is written to any config.
( cd worker && npx wrangler dev --env staging --local --port "$PORT" --ip 127.0.0.1 \
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
NO_PROXY='*' node test/worker-route-scoping.probe.mjs "http://127.0.0.1:$PORT" || STATUS=1
NO_PROXY='*' node test/worker-members.probe.mjs "http://127.0.0.1:$PORT" || STATUS=1

if [ "$KEEP" = "1" ]; then
  echo
  echo "worker still running on :$PORT (pid $WPID). Stop it with: kill $WPID"
fi
exit $STATUS
