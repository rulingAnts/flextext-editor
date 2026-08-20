#!/usr/bin/env bash
# PHASE C CONTAINMENT (invariant I6) — every route that touches a project's data must resolve a
# grant through authMember(), and it must do so in the one shape that fails closed.
#
# ⚠ WHY A SCRIPT AND NOT A REVIEW. A shared helper cannot fail a build when a NEW route simply does
# not call it. That is the whole failure mode: authMember is not bypassed by anyone editing it, it is
# bypassed by someone adding route number seventeen next month and reaching for `authResearcher`
# because that is what the sixteen routes above it used to do. Nothing in the language or the tests
# notices. This does.
#
# Modelled on check-native-containment.sh, which exists for the same reason one layer down.
#
#   ./check-project-scoping.sh
set -uo pipefail
cd "$(dirname "$0")"
W=worker/src/v1.js
fail=0
say() { printf '  %s  %s\n' "$1" "$2"; }
bad() { say FAIL "$2"; fail=1; }
good() { say "ok  " "$2"; }
check() { if [ "$1" = 0 ]; then good ok "$2"; else bad x "$2"; fi; }

echo
echo "authMember is the single authority"

# 1. It exists and is exported (the tests import it; an un-exported helper cannot be unit-tested).
grep -q 'export async function authMember(' "$W" \
  && good ok "authMember() is defined and exported" \
  || bad x "authMember() is missing or no longer exported"

# 2. ⚠ THE FAIL-CLOSED SHAPE. Every caller must handle BOTH outcomes: null (401, no identity) and
#    ok:false (not_found). A route that checks only `if (!ctx)` treats a DENIED context as authorized,
#    because { ok:false } is truthy. That single missing check is the whole hole, and it looks
#    completely reasonable on the screen.
calls=$(grep -c 'await authMember(request, env' "$W" || true)
guards=$(grep -c 'if (!ctx.ok' "$W" || true)
if [ "$calls" -gt 0 ] && [ "$guards" -ge "$calls" ]; then
  good ok "all $calls authMember call sites guard on !ctx.ok ($guards guards)"
else
  bad x "⚠ $calls authMember call(s) but only $guards !ctx.ok guard(s) — a denied context is TRUTHY, so a missing guard authorizes it"
fi

# 3. Denial must not be distinguishable from absence. A 403 beside an authMember guard would turn
#    the endpoint into an oracle for which instance and project ids exist.
# ⚠ NO `grep -n` HERE. The first version piped `grep -n` into `grep 403` and matched the LINE
#    NUMBER — line 4030 contains "403" — so it failed on a file with no 403 in it at all. A check
#    that cries wolf gets muted, which this repo's own tests call worse than no check. Match the
#    status ARGUMENT in its actual syntax instead.
if grep 'if (!ctx.ok' "$W" | grep -q '}, 403,'; then
  bad x "⚠ an authMember guard answers 403 — denial must be not_found, or the API enumerates ids"
else
  good ok "no authMember guard answers 403 — denial is indistinguishable from absence"
fi

echo
echo "the converted routes did not quietly revert"

# 4. The instance sub-route block must not go back to account scoping. authResearcher is still
#    correct for the 22 genuinely account-scoped routes (auth, TOTP, reset, settings blob, approval)
#    — this bounds the check to the block that was converted.
start=$(grep -n '^  // Routes under /v1/instances/<id>/\.\.\.' "$W" | cut -d: -f1)
if [ -z "${start:-}" ]; then
  bad x "could not locate the /v1/instances/<id> block — this check has gone stale, fix it rather than deleting it"
else
  # The block runs to the end of the instances handler; bound the scan generously and let the
  # per-line check do the work.
  hits=$(awk -v s="$start" 'NR>s && NR<s+700 && /const r = await authResearcher/' "$W" | wc -l | tr -d ' ')
  if [ "$hits" = 0 ]; then
    good ok "no route under /v1/instances/<id> resolves auth with authResearcher"
  else
    bad x "⚠ $hits route(s) under /v1/instances/<id> still call authResearcher — a new route reached for the old pattern"
  fi
fi

# 5. Wipe and force-remove stay owner-only (round-1 finding 6). These destroy a field device's work
#    and no capability delegates them in v1.
for act in wipe force-remove; do
  if grep -A 12 "isub === '$act'" "$W" | grep -q '!ctx.isOwner'; then
    good ok "$act is still owner-only"
  else
    bad x "⚠ $act no longer checks ctx.isOwner — a capability must never delegate destroying a device's work in v1"
  fi
done

echo
if [ "$fail" = 0 ]; then echo "PASS — project data is reachable only through a resolved grant."; else echo "FAILED"; fi
exit "$fail"
