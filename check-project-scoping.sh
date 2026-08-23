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

# 3b. ⚠ `allowRevoked` MUST ALWAYS BE OWNER-ONLY. It lets authMember resolve a REVOKED instance,
#     which cleanup routes need (you cannot withdraw a grant against a device you can no longer
#     address) — but a capability reaching a revoked device through that door would mean "revoked"
#     stopped meaning revoked. Enforced here rather than trusted, because the flag is one word and
#     reads as harmless at the call site.
ar=$(grep -c 'allowRevoked: true' "$W" || true)
if [ "$ar" = 0 ]; then
  good ok "no route opts into resolving revoked instances"
else
  bad_sites=0
  while IFS= read -r ln; do
    # the isOwner requirement must appear within a few lines of the opt-in
    if ! sed -n "${ln},$((ln + 6))p" "$W" | grep -q 'ctx.isOwner'; then bad_sites=$((bad_sites + 1)); fi
  done < <(grep -n 'allowRevoked: true' "$W" | cut -d: -f1)
  if [ "$bad_sites" = 0 ]; then
    good ok "all $ar allowRevoked call site(s) also require ctx.isOwner"
  else
    bad x "⚠ $bad_sites allowRevoked call site(s) do NOT require ctx.isOwner — a capability must never reach a revoked device"
  fi
fi

echo
echo "the converted routes did not quietly revert"

# 4. The instance sub-route block must not go back to account scoping. authResearcher is still
#    correct for the 22 genuinely account-scoped routes (auth, TOTP, reset, settings blob, approval)
#    — this bounds the check to the block that was converted.
start=$(grep -n '^  // Routes under /v1/instances/<id>/\.\.\.' "$W" | cut -d: -f1)
# ⚠ BOUND THE BLOCK PROPERLY. An earlier version scanned a guessed window of N lines past the start;
#   too small and it missed routes, too large and it swept in unrelated ones and cried wolf. The
#   block closes at the first line that is exactly two spaces and a brace.
blockend=$(awk -v s="${start:-0}" 'NR>s && /^  \}$/ {print NR; exit}' "$W")
if [ -z "${start:-}" ] || [ -z "${blockend:-}" ]; then
  bad x "could not delimit the /v1/instances/<id> block — this check has gone stale, fix it rather than deleting it"
else
  # ⚠ MATCH ANY BINDING FORM, not `const r = await`. The first version grepped that exact text and
  #   MISSED `else asResearcher = await authResearcher(request, env);` in the desired-lane route —
  #   reporting "no route resolves auth with authResearcher" while one did, and while that route
  #   answered 403 and leaked both the existence and the revocation state of any instance id
  #   (2026-08-21 sweep). A guard that passes over the thing it guards is worse than none, because
  #   it gets quoted as evidence.
  hits=$(awk -v s="$start" -v e="$blockend" 'NR>s && NR<e && /await authResearcher\(/' "$W" | wc -l | tr -d ' ')
  # Exactly one is expected: the desired-lane route serves BOTH the install and the panel from one
  # path, so it legitimately resolves a researcher identity. What it must not do is answer 403.
  if [ "$hits" -le 1 ]; then
    good ok "only the dual-lane desired route resolves a researcher identity here ($hits)"
  else
    bad x "⚠ $hits route(s) under /v1/instances/<id> call authResearcher — a new route reached for the old pattern"
  fi

  # ⚠ A 403 THAT DECIDES OWNERSHIP IS AN ID ORACLE; a 403 for a caller who has ALREADY proved a
  #   binding to this resource is not. Both live in this block, so the rule is stated by ERROR CODE
  #   rather than by status alone: `bad_upload` (a mismatched upload-session token) and
  #   `not_approved` (an install that authenticated but is not approved yet) are the two that are
  #   about state, not about whether you may address this id. Anything else answering 403 here is an
  #   authorization denial and must be not_found.
  rogue=$(awk -v s="$start" -v e="$blockend" 'NR>s && NR<e && /\}, 403,/ && !/bad_upload/ && !/not_approved/' "$W" | wc -l | tr -d ' ')
  if [ "$rogue" = 0 ]; then
    good ok "no authorization denial under /v1/instances/<id> answers 403 — ids stay unenumerable"
  else
    bad x "⚠ $rogue authorization denial(s) under /v1/instances/<id> answer 403 — that enumerates instance ids"
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
