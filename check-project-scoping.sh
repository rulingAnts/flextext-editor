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
# ⚠ CHECKED PER CALL SITE, NOT BY GLOBAL COUNT. Comparing totals was the original form, and the
#   completeness critic named its flaw: two guards in one route mask a route with none, and the
#   totals still balance. Each call must have its own guard within a few lines of it.
# ⚠ MATCH `await authMember(` — ANY args — not `authMember(request, env`. The narrow form was blind
#   to a call whose first parameter a formatter renamed or a helper spelled differently, which is
#   exactly a NEW unguarded call site sliding past the check that exists to find it (sweep #11).
calls=$(grep -c 'await authMember(' "$W" || true)
unguarded=0
while IFS= read -r ln; do
  [ -z "$ln" ] && continue
  if ! sed -n "${ln},$((ln + 5))p" "$W" | grep -q 'if (!ctx.ok'; then unguarded=$((unguarded + 1)); fi
done < <(grep -n 'await authMember(' "$W" | cut -d: -f1)
if [ "$unguarded" = 0 ]; then
  good ok "each of the $calls authMember call sites has its OWN !ctx.ok guard"
else
  bad x "⚠ $unguarded authMember call site(s) have no !ctx.ok guard — a denied context is TRUTHY, so one missing guard authorizes it"
fi

# ⚠ THE DEFERRAL MUST BE ENFORCED AT READ TIME TOO. validateCaps is a WRITE-time filter and
#   authMember never calls it, so a project_member row already carrying a deferred capability would
#   otherwise be honoured — reopening every finding the deferral closed. One list, both paths.
if grep -q 'export const DEFERRED_CAPS' "$W" && [ "$(grep -c 'for (const k of DEFERRED_CAPS)' "$W")" -ge 2 ]; then
  good ok "DEFERRED_CAPS is refused on BOTH the write path and the read path"
else
  bad x "⚠ DEFERRED_CAPS is enforced in only one place — a stored row would reopen what the deferral closed"
fi

# ⚠⚠ THE NINE DRIVE FINDINGS ARE GATED, NOT REPAIRED. `assignTexts` and `drive` sitting in
#   DEFERRED_CAPS is the ONLY thing keeping the account-wide docId Drive-search routes unreachable —
#   validateCaps refuses to write them and authMember refuses to honour a stored row carrying them.
#   Removing either name re-arms all nine at once, at a line with no other review. This is the loud
#   stop (completeness critic, 2026-08-24). They come back only AFTER Drive access is resolved per
#   project (the drive_object table), never by editing this list alone.
for cap in assignTexts drive; do
  if grep -qE "DEFERRED_CAPS = \\[[^]]*'$cap'" "$W"; then
    good ok "'$cap' is still ungrantable — in DEFERRED_CAPS, so the nine Drive routes stay unreachable"
  else
    bad x "⚠⚠ '$cap' has LEFT DEFERRED_CAPS — this re-arms nine audit findings at once. Project-scope the Drive routes (drive_object) BEFORE shipping this."
  fi
done

# ⚠ THE TEXT-COMMAND GATE. Without it manageDevices reaches the text lane through queued commands,
#   including `delete`, which destroys a field worker's transcription.
# ⚠ THE LIST AS WELL AS THE GATE. Checking only for the gate line let an EMPTIED list survive a
#   mutation — the `if` was still there and gated nothing. A guard that checks a mechanism exists,
#   without checking it has anything to act on, is the same species of false pass as the grep that
#   missed `asResearcher`.
tc_gate=$(grep -c "TEXT_COMMANDS.includes(cmd.type) && !ctx.isOwner && !ctx.caps.assignTexts" "$W" || true)
tc_all=0
for c in assign delete uploadDelete setDone; do
  grep "const TEXT_COMMANDS = \[" "$W" | grep -q "'$c'" || tc_all=1
done
if [ "$tc_gate" -ge 1 ] && [ "$tc_all" = 0 ]; then
  good ok "text-scoped commands still require assignTexts, and all four are still listed"
else
  bad x "⚠ the TEXT_COMMANDS gate is gone or its list was emptied — manageDevices would reach assign/delete/uploadDelete/setDone"
fi

# ⚠ A PAYLOAD-BEARING changeSettings MUST BE ENCRYPTED. Settings are E2EE so the worker cannot
#   allow-list keys; refusing a plaintext payload is the half it CAN enforce, and it is what stops a
#   caller holding no Ki from repointing a field device's entire backend.
if grep -q "cmd.type === 'changeSettings' && !cmd.enc" "$W"; then
  good ok "a plaintext changeSettings payload is refused"
else
  bad x "⚠ changeSettings accepts a plaintext payload — that is the backend-repointing attack"
fi

# ⚠ KEY DELIVERY IS OWNER-ONLY. wrapped_key is opaque ciphertext the worker cannot inspect, and the
#   route bumps desired_rev so the device ADOPTS it — so a member could install a Ki they chose and
#   lock the owner out of their own device.
if grep -A 30 "isub === 'key' && seg.length === 6" "$W" | grep -q 'ctx.isOwner'; then
  good ok "install key delivery is owner-only"
else
  bad x "⚠ key delivery is not owner-only — a member could install a Ki of their own choosing"
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
  missing=0; total=0
  while IFS= read -r ln; do
    [ -z "$ln" ] && continue
    total=$((total + 1))
    if ! sed -n "${ln},$((ln + 12))p" "$W" | grep -q '!ctx.isOwner'; then missing=$((missing + 1)); fi
  done < <(grep -n "isub === '$act'" "$W" | cut -d: -f1)
  if [ "$total" -ge 1 ] && [ "$missing" = 0 ]; then
    good ok "$act is still owner-only (each of $total handler(s) checks ctx.isOwner)"
  else
    bad x "⚠ $act: $missing of $total handler(s) miss the ctx.isOwner check (0 handlers also fails) — one guarded site must not mask an unguarded one"
  fi
done

# 6. CREATION ⟹ STAMPED (drive-object.js). Phase 3 authorizes Drive objects by their drive_object
#    row, so a folder the worker creates WITHOUT stamping becomes invisible to that authorization —
#    a fail-closed hole a member hits as "denied with no way to reach it", healed only by an
#    operator backfill nobody knows is needed. Two shapes to pin:
#
#    a) Every INLINE folder-creation POST must have a stampFolder/stampChild within 15 lines after
#       it. Exempt, by name and for a reason:
#         driveMasterFolder      — the master is not a project object (the backfill skips it too)
#         driveSelfTest          — creates-and-deletes an ephemeral probe folder
#         driveEnsureTextFolder / driveEnsureChildFolder / driveEnsureDefaultProject /
#         driveEnsureDeviceFolder — helpers; they lack instance/project context, so their CALLERS
#         stamp (checked in b). driveEnsureDeviceFolder and driveUnassignedFolder stamp inside.
#    b) Every CALL SITE of the caller-stamps helpers must have a stamp within 14 lines after it.
#
#    ⚠ The line windows are deliberately tight. If a legitimate stamp ends up further away,
#    restructure the code to keep creation and stamp adjacent — distance is how the invariant rots.
creations=$(grep -n "driveJson(access, 'POST', 'https://www.googleapis.com/drive/v3/files?fields=id'" "$W" | cut -d: -f1)
unstamped=0; stamped_inline=0
for ln in $creations; do
  # Only folder creations: the metadata body names the folder mimeType within the next 4 lines.
  if ! sed -n "${ln},$((ln + 4))p" "$W" | grep -q "vnd.google-apps.folder"; then continue; fi
  # Which function is this site inside? (nearest preceding function definition)
  fn=$(awk -v n="$ln" 'NR<=n && /^(async )?function [A-Za-z]/ { f=$0 } END { print f }' "$W" | sed 's/.*function \([A-Za-z0-9_]*\).*/\1/')
  case "$fn" in
    driveMasterFolder|driveSelfTest|driveEnsureTextFolder|driveEnsureChildFolder|driveEnsureDefaultProject) continue ;;
  esac
  if sed -n "${ln},$((ln + 15))p" "$W" | grep -q "stampFolder\|stampChild"; then
    stamped_inline=$((stamped_inline + 1))
  else
    unstamped=$((unstamped + 1))
    say FAIL "  folder creation at line $ln (in ${fn:-top level}) has no stamp within 15 lines"
  fi
done
if [ "$unstamped" = 0 ] && [ "$stamped_inline" -ge 4 ]; then
  good ok "every inline folder creation stamps a drive_object row ($stamped_inline site(s))"
else
  bad x "⚠ $unstamped folder creation(s) never stamp drive_object — invisible to per-project authorization (or the sites count collapsed: $stamped_inline)"
fi
#    ⚠ THE STAMP MUST NAME THE VARIABLE THE HELPER RETURNED — proximity alone is not enough. The
#    first version of this loop only required "a stamp within 14 lines", and its own mutation test
#    caught the hole: deleting the TEXT-folder stamp at a site that also stamps `originals/` two
#    lines later still passed, because the originals stamp sat inside the window. A guard that a
#    neighbouring stamp can satisfy guards nothing.
for helper in driveEnsureTextFolder driveEnsureChildFolder driveEnsureDefaultProject; do
  miss=0; total=0
  while IFS= read -r ln; do
    [ -z "$ln" ] && continue
    total=$((total + 1))
    # The variable receiving the helper's return: last `<name> =` on the call line or the two lines
    # above it (covers `const x = await helper(...)` and the multi-line ternary assignments).
    from=$((ln - 2)); [ "$from" -lt 1 ] && from=1
    # ` = [^=]` so a comparison (`sub === 'originals'`) can never read as an assignment — the first
    # version grabbed `sub` from exactly that and flagged two healthy sites.
    var=$(sed -n "${from},${ln}p" "$W" | grep -oE '[A-Za-z_][A-Za-z0-9_]* = [^=]' | tail -1 | awk '{print $1}')
    if [ -z "$var" ]; then
      miss=$((miss + 1)); say FAIL "  $helper call at line $ln: could not find the receiving variable — check gone stale"
    elif ! sed -n "${ln},$((ln + 14))p" "$W" | grep -Eq "objectId: ${var}[,.\}]"; then
      miss=$((miss + 1)); say FAIL "  $helper call at line $ln: no stamp names \`objectId: ${var}\` within 14 lines"
    fi
  done < <(grep -n "await ${helper}(" "$W" | grep -v "function ${helper}" | cut -d: -f1)
  if [ "$total" -ge 1 ] && [ "$miss" = 0 ]; then
    good ok "$helper: all $total call site(s) stamp the object it returned"
  else
    bad x "⚠ $helper: $miss of $total call site(s) never stamp what it returned (0 sites also fails — the helper or this check went stale)"
  fi
done

# 7. MOVE ⟹ SYNCED (drive-object.js move helpers). Every Drive re-parent the worker performs must
#    update the drive_object rows it moved, or resolveDriveObject authorizes against the project the
#    object just LEFT — stale in the dangerous direction (and the D1 half of issue #13). Two shapes
#    of re-parent exist: driveReparent() calls, and the one inline addParents= PATCH in /move.
#    Each must have a moveDriveObjectText/Container within 10 lines before or 22 after (the
#    drive-unassign sync deliberately runs BEFORE its re-parent; projects/assign's sits after a
#    batch). driveTextHousekeeping's own body and the driveReparent definition are the exemptions.
#    Site enumeration: every driveReparent(access…) CALL — the definition is excluded BY NAME,
#    because its first parameter is also `access` (the first version of this check assumed the
#    signature differed and flagged the definition itself) — plus /move's inline addParents PATCH
#    found by its own `movedFolder = true` marker; that marker is load-bearing for this check, so
#    renaming it must update both.
syncmiss=0; synctotal=0
while IFS= read -r ln; do
  [ -z "$ln" ] && continue
  synctotal=$((synctotal + 1))
  from=$((ln - 10)); [ "$from" -lt 1 ] && from=1
  if ! sed -n "${from},$((ln + 22))p" "$W" | grep -q "moveDriveObjectText\|moveDriveObjectContainer"; then
    syncmiss=$((syncmiss + 1)); say FAIL "  re-parent at line $ln has no drive_object move-sync within its window"
  fi
done < <(grep -n "driveReparent(access\|movedFolder = true" "$W" | grep -v "function driveReparent" | cut -d: -f1)
if [ "$synctotal" -ge 7 ] && [ "$syncmiss" = 0 ]; then
  good ok "every Drive re-parent syncs drive_object in the same act ($synctotal site(s))"
else
  bad x "⚠ $syncmiss re-parent site(s) never sync drive_object (or the site count collapsed: $synctotal, expected ≥7) — project_id goes stale on move"
fi

# 8. DRIVE ROUTES GATE THE OBJECT, NOT JUST THE INSTANCE (Phase 3). Every route that resolves auth
#    with the assignTexts or drive:read capability acts on a caller-supplied doc/file id afterwards
#    — the shared root of the nine 2026-08-21 findings. Each must call authorizeDocForProject within
#    30 lines of its authMember. The one exemption: the chunk relay, whose authority is the
#    encrypted upload-session token (sess.rr) minted by an already-gated start — identified here by
#    its x-fx-upload header read, so renaming that header must update this check.
gmiss=0; gtotal=0
while IFS= read -r ln; do
  [ -z "$ln" ] && continue
  if sed -n "${ln},$((ln + 12))p" "$W" | grep -q "x-fx-upload"; then continue; fi
  gtotal=$((gtotal + 1))
  if ! sed -n "${ln},$((ln + 30))p" "$W" | grep -q "authorizeDocForProject"; then
    gmiss=$((gmiss + 1)); say FAIL "  capability-gated Drive route at line $ln never gates the doc id"
  fi
done < <(grep -n "authMember(request, env, { instance: instanceId }, 'assignTexts')\|authMember(request, env, { instance: instanceId }, 'drive:read')" "$W" | cut -d: -f1)
if [ "$gtotal" -ge 6 ] && [ "$gmiss" = 0 ]; then
  good ok "every assignTexts/drive:read route gates the caller-supplied doc id ($gtotal site(s))"
else
  bad x "⚠ $gmiss capability-gated Drive route(s) act on a doc id without the Phase 3 gate (or the count collapsed: $gtotal, expected ≥6)"
fi

echo
if [ "$fail" = 0 ]; then echo "PASS — project data is reachable only through a resolved grant."; else echo "FAILED"; fi
exit "$fail"
