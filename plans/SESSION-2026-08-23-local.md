# SESSION LOG — Phase C, LOCAL session, 2026-08-23

Picks up from `HANDOFF-2026-08-23.md`. This is the first session with a **real browser** and a
**live local backend** (`local-rig.sh --keep`), which is what the handoff §11 said was the biggest
gap. Nothing here is deployed. Branch `claude/cut-tab-waveform-displays-2owdfx`, still `v443`,
`BUILD_TAG='phase-c-authz v1'`.

## 1. Browser verification — the §11 gap, closed for the guard

The `changeSettings` device-side guard (`REMOTE_FORBIDDEN` in `docs/js/app.js`) — the real fix for
the critical finding — was **run in a real browser for the first time** and behaves exactly as the
source tests claimed, in **both languages**:

- A pushed `changeSettings` containing `relayWorker` has `relayWorker` **stripped**, keeps the
  legitimate key (`vernName`), and toasts BOTH `sync.settingsKeyRefused` and `sync.settingsUpdated`.
  Strings render with `{keys}` interpolated:
  - en: *"A setting your researcher sent was not applied (relayWorker) — that one can only be
    changed on this device."*
  - id: *"Satu pengaturan yang dikirim peneliti tidak diterapkan (relayWorker) — …"*
- v443 loads clean (device mode AND researcher mode), zero console errors. Badge reads
  `phase-c-authz v1 · v443`.

**How the guard was driven** (the full E2EE push is untestable on the hermetic rig — no Google, no
seeded Kr, and the poll path won't dispatch without a delivered Ki): a new **dev-host-only** console
hook, `window.__app.syncDispatch`, exposes the real device command handler. Added to the existing
`isDevHost` block in `app.js` (never on production origins), documented in DEVELOPERS.md. This is
the way to re-verify device handlers in a browser without standing up the whole pairing dance.

⚠ **Item 4 (the researcher PANEL against the converted routes) was NOT browser-verified** — it needs
the panel to bootstrap, which needs Kr from `GET /v1/researcher`, which the rig does not seed, AND
the rig worker's `ALLOWED_ORIGINS` does not include a localhost dev origin (CORS-blocks the panel).
The wire contract is proven by the rig probes; the panel UI is best test-driven by Seth on staging
(real Google/Kr). Standing up a panel-capable local rig (seed a `kr_server_enc`, add a localhost
origin) is a deliberate build worth doing before Phase D.

## 2. The sweep (§10 step 1, the gate) — re-run, and what it found

The committed `plans/audit-sweep-workflow.js` was re-run against the code as it stood.

**Round A (before fixes): 1 confirmed finding, unanimously (3/3 refuters CONFIRMED).**
- *member_key removal leaves a live grant when the device was project-unassigned at grant time and
  has since moved to a DIFFERENT project than the one the member is removed from.* Real SQL gap: the
  snapshot clause (`''≠id`) and the subquery (device now in another project, not NULL) BOTH miss the
  `''`-sentinel-AND-moved intersection. `worker/src/v1.js:2624`. Medium; unreachable by a v1 member
  (deferred caps), inherited by whoever widens them; compounds with the still-open unscoped
  `GET /v1/researcher/keys` (open item 1).
- Critic verdict: **NOT a clean run** (a round that finds a real bug is not the clean round). Gate =
  fix it, then a sweep that finds nothing. Critic also (not new defects, worth carrying): the
  one-item `REMOTE_FORBIDDEN` denylist is unenumerated; `check-project-scoping.sh` only scans the
  `/v1/instances/<id>` block, so `/v1/researcher/keys`, `/v1/projects/<id>/members`, `/v1/crowd` are
  outside its authResearcher-reversion + 403-oracle checks.

**Round B (after fixes): _pending — see the addendum at the bottom of this file._**

## 3. Two fixes landed (worker only, additive, NOT deployed)

Both mutation-tested (neuter the fix, confirm the new assertion fails **by name**).

**Fix 1 — the sweep finding.** `worker/src/v1.js` member_key DELETE gained a third ORed arm:
`OR (project_id='' AND instance_id IN (SELECT instance_id FROM instance WHERE researcher_id=owner))`.
Removes the removed member's `''`-sentinel grants on any of the owner's devices regardless of where
the device now sits — consistent with the statement's already-documented "over-delete on revocation
is the safe direction" philosophy. Corrected the comment, which had *claimed* completeness the code
did not have. Test: new section in `worker-members.probe.mjs`, seeded via a second migrated project
+ moved device + `''` grant in `worker-seed.mjs` (the rig can't reach that state through the API).

**Fix 2 — §5.5 anti-phishing identity.** New nullable column `invite.invited_by`
(`worker/migrate-invite-inviter.sql`, additive; `schema-current.sql` + `schema-expected.json` +
schema-test FILES list updated). Invite mint stamps `ctx.caller.researcher_id` (the actual minter,
not the owner). New `pairingIdentity(env, inv)` helper resolves the pairing-response identity via
`COALESCE(invited_by, instance.researcher_id)` — the enrolling MEMBER when set, the owner when NULL
(legacy/owner-minted, unchanged). Test: member mints an invite, a device claims it, and the claim
response's identity is the MEMBER's email, not the owner's.

**Fix 3 — a hazard THIS SESSION widened, found by auditing my own change.** The `/v1/projects/<id>/members`
route is owner-only, and its `POST` branch has always refused `who === ctx.owner.researcher_id`
(`owner_is_not_a_member`, `v1.js:2564`). **`DELETE` had no such guard**, so removing "the owner" as a
member ran the member_key DELETE with `researcher_id = the owner` — destroying the owner's own
wrap-to-owner copies, which are wrapped to keys the worker cannot read and therefore unrecoverable.
That is the exact end `DELETE /v1/researcher/keys` refuses by name (`owner_grant_required`), reached
through another door.

It pre-existed, but **Fix 1's third arm widened it**: the owner's legacy-`''` copies on devices that
have since been ASSIGNED were missed by arms 1 and 2 and are caught by arm 3. Fixed by mirroring
POST's guard in DELETE. Owner-only route, so a footgun rather than an escalation — but an
unrecoverable one.

⚠ **The mutation test caught my own TEST being wrong here, and this is the lesson worth keeping.**
The first version seeded the owner's grant through `POST /v1/researcher/keys` — which stamps the
device's REAL project_id, a value arm 3 (`project_id=''`) can never match. So the key-survival
assertion **passed with the guard removed**: right conclusion, wrong reason. The fixture now SEEDS an
owner `''`-sentinel row (`OWNER-MOVED-SENTINEL-COPY`), and with the guard removed **both** halves
fail by name. An assertion about a sentinel value cannot be set up through an API that never writes
that value.

**Fix 4 — v440 NEVER WORKED, AND IT IS LIVE ON PRODUCTION.** (Found by the third sweep; verified by
me in source AND demonstrated empirically against the rig; Seth approved the fix 2026-08-23.)

The desired-lane instance read selected `desired_blob, desired_rev, type, revoked, researcher_id` —
**without `nickname`**. Both response branches send `nickname: inst.nickname || ''`, so an absent
column made that `undefined || ''`: **every device was told its name was the empty string**, on the
pending/pairing screen and after approval. Demonstrated before the fix:

```
researcher named the device : "Tablet A"
pending  poll -> nickname   : ""
approved poll -> nickname   : ""
```

The same SELECT is on `origin/main` AND `origin/productionWeb` (line 3584 there), so the feature
shipped broken in v440 and has never once worked in the field. It is precisely the check Seth asked
for — *"100% sure that the device we're using DOES in fact match the device listed in the tile"* — and
it silently returned nothing at the one moment two people are trying to confirm they hold the same
device. Fix: add `nickname` to the column list.

⚠⚠ **WHY NOTHING CAUGHT IT, and this is the most transferable lesson of the session.**
`test/pair-code.test.mjs` asserted that the SOURCE STRING `nickname: inst.nickname || ''` appeared in
the worker, twice. It did — the whole time, while always evaluating to `''`. **A source-text
assertion cannot distinguish "the code says it" from "the code does it", so it certified a feature
that did nothing.** This is trap #5, and it did not merely break on an improvement this time: it
vouched for a live bug for weeks.

Replaced with:
- **The real check** in `test/worker-device-compat.probe.mjs` — asserts the VALUE a real device
  receives, on BOTH the pending and approved polls, against a real worker. Neuter the column and both
  fail by name with `got ""`, which is exactly the production symptom.
- **The static half that a source read can honestly establish** in `pair-code.test.mjs`: that the
  column is SELECTED and that it is SENT on each branch — the exact pairing that was broken.

⚠ A footnote worth keeping: the original static assertion was a COUNT of the string across the file,
and adding the fix's explanatory comment (which mentions the field) pushed the count to 3 and failed
it. An assertion a prose edit can break is one people learn to "fix" without reading, so it now
matches the two RESPONSE SHAPES instead of counting occurrences.

**Two test/tooling fixes made in passing:**
- `pair-code.test.mjs` pinned the literal inline `researcher: inst ? { name: inst.display_name` —
  broke when Fix 2 refactored it into `pairingIdentity`. Updated to check the current behaviour
  (trap #5 in the handoff). Real behavioural coverage is in `worker-members.probe.mjs`.
- `secret-guard.test.mjs` used `new URL('..', import.meta.url).pathname`, which leaves the SPACE in
  this repo's path (`flextext editor`) `%20`-encoded — every `existsSync` missed. Swapped to
  `fileURLToPath`. ⚠ It STILL fails one assertion further in (`catches a PEM private key`) because
  **`git add -A` stages nothing in a `/tmp` dir in this sandbox**, so its temp-repo harness can't
  exercise the scanner. Pre-existing + environmental, unrelated to Phase C; `check-secrets.sh`
  itself passes clean on the real tree (`bash ./check-secrets.sh` → `clean`).

## 4. Rig gotchas that cost time — write them down (handoff §11 was partly wrong)

- ⚠ **`bash dev-serve.sh 8012` serves the MAIN checkout, not this worktree.** `dev-serve.sh` hardcodes
  `EDITOR="${FLEXTEXT_DOCS:-$HOME/GIT/flextext editor/docs}"`. On 8012 the badge read `v441` (main).
  Use the **`flextext-devrig-8013`** launch config (it sets `FLEXTEXT_DOCS="$PWD/docs"`) →
  `http://localhost:8013/flextext-editor/`, badge `phase-c-authz v1 · v443`. The badge is how you
  catch this — trust it.
- ⚠ **`devctl.sh` is dead.** It tunnels to the KDE-neon VM (`10.211.55.15`), which was deliberately
  DELETED. Use **`bash test/local-rig.sh --keep`** instead: real `workerd` + Miniflare D1 on
  `127.0.0.1:8787`, exactly where a `localhost` client points. Kill a stale one with
  `lsof -ti :8787 | xargs kill` before re-running (two workers collide on the port).
- ⚠ **The local `--local` D1 is STATEFUL and `schema-current.sql` is `CREATE TABLE IF NOT EXISTS`.**
  Adding a COLUMN does NOT reach a table that already exists locally — the fresh column silently
  isn't there and every INSERT that names it 500s. After any schema change:
  `rm -rf worker/.wrangler/state/v3/d1` then re-run. (A fresh CI clone is fine; only local re-runs
  across a schema change hit this.)
- ⚠ **No backticks inside `worker-seed.mjs`'s SQL template literal** — a stray one ends the string
  (the file's own header says so; I hit it anyway). Cost one failed run.

## 5. State / what's next

- **Green:** `local-rig.sh` (166 ok, device-compat byte-compatible), `check-project-scoping.sh`,
  `check-secrets.sh`, `version-sync`, `worker-schema`, `pair-code`.
- **NOT deployed.** Same rules as the handoff: Seth's explicit sign-off, satellite version coupling
  (v443 touched `docs/`), maintenance flag before any worker deploy. `docs/js/app.js` changed (the
  dev hook) — dev-gated, no SHELL import added, so no satellite impact — but IF this ships it rides
  the next `./bump-version.sh` and `BUILD_TAG` clears to `''`.
- **Open, unchanged:** the six §5 items minus §5.5 (now fixed). Root of the member_key cluster is the
  unscoped `GET /v1/researcher/keys` (open item 1) — fix the whole cluster as a unit before
  re-enabling `assignTexts`/`drive`. The containment-script coverage gap the critic named is worth
  closing before Phase D.

---

### Addendum — Round B sweep result (post-fix)

**Round B: `candidates: 0, confirmed: 0, refuted: 0` — all three lenses returned EMPTY.** By the
gate's own stated definition (§5 item 0: *"a clean run means a sweep that finds nothing"*), **the
gate is met.**

**The critic independently verified both of this session's fixes** (it re-derived them from source,
having been told only that they landed):
- member_key clause 3 — the outer `researcher_id=?` binds to the REMOVED MEMBER (`who`), so it can
  only ever delete that member's grants; the owner's wrap-to-owner copy is untouched. The three arms
  do cover minted-here / moved-away / legacy-`''` as claimed. **Sound.**
- `invited_by` / `pairingIdentity` — both call sites `SELECT * FROM invite`, so `inv.invited_by` is
  populated; column exists in schema + migration; set server-side from `ctx.caller`, unspoofable.
  **Sound.**

⚠ **The critic still answers "No" to the clean-run question, and it is half right.** Its argument:
*"an empty result from a sweep that never looked at the open surface is not a clean run — it is an
un-run one."* Judge that carefully, because it partly misreads the sweep's design:

- The sweep is **deliberately scoped** to "what did nobody think to look for". Its own CTX instructs
  agents NOT to re-report the known findings. So "it did not re-sweep the six STILL OPEN items" is by
  construction, not an omission — those are **known and filed**, not unexamined.
- **So the stated gate IS met.** What is NOT true, and must not be claimed, is that this makes Phase C
  "audited safe" in general. The six open items are open **by choice**; the nine Drive findings remain
  **unreachable, not repaired**.

⚠ **One critic claim is FALSE and should not be carried forward:** it asserts *"changeSettings's real
fix is device-side (app.js) and unbuilt; the worker enc-check is a partial."* The device-side fix
**is built** (`REMOTE_FORBIDDEN`, `app.js:3860`) and this session **ran it in a real browser in both
languages** (§1). The critic only read `worker/src/v1.js`. This is a good illustration of the house
rule: verify every claim, including a reviewer's.

### NEW, genuinely uncovered by both rounds — `cancelOthers` is grantable but inert

Verified against source (not taken from the critic):
- `validateCaps` **accepts and stores** `cancelOthers` (`v1.js:554-558`).
- The only cancel route **gates on `manageDevices`**, never on `cancelOthers` (`v1.js:3865-3875`).

⚠ **It is NOT undocumented** — the route carries a deliberate comment explaining it as an interim
(the own/other split needs commands to name their issuer; `by` only started being written at
`v1.js:3833`, so the pre-existing backlog has no `by` and either answer would be wrong), and the
handoff's §4 table already says *"currently grants nothing extra"*. The critic overstated this as
"neither round touched this."

**But the substantive point stands**, and it is an internal inconsistency with the file's own rule
twenty lines above (`v1.js:543-545`): *"REFUSED, NEVER SILENTLY DROPPED … An owner who ticks 'can
assign texts' and is quietly given nothing believes their assistant has access they do not have."*
`cancelOthers` is exactly that — accepted, stored, and granting nothing.

- **Severity: low, and it fails SAFE** (under-delivers authority, never over-grants). It is an
  owner-expectation bug, not a security hole.
- **Second-order:** a `manageDevices`-only member can currently cancel a command the OWNER queued.
  That is the documented interim, but it is worth Seth knowing it is the live behaviour.
- **NOT fixed here** — the options (refuse `cancelOthers` like the other ungrantables until the `by`
  split lands, vs. implement the split now and decide what authorless backlog commands mean) are a
  design decision, and the second changes behaviour for existing queued commands. **Seth's call.**

### Also named by the critic, and worth carrying (not fixed, not new defects)

- **`{crowd}` target still has zero call sites** (STILL OPEN #4 — confirmed still true); every
  `/v1/crowd` route is `WHERE researcher_id=?`, and `check-project-scoping.sh` never scans it.
- **The `authInstall` write/upload lanes** (report, chunked upload start/chunk/finish) have had no
  lens across either round; STILL OPEN #2 named only the GET install lane.
- **`check-project-scoping.sh` only scans the `/v1/instances/<id>` block**, so `/v1/researcher/keys`,
  `/v1/projects/<id>/members` and `/v1/crowd` are outside its authResearcher-reversion and
  403-oracle checks. A future revert in those routes would not trip the guard. **Worth closing
  before Phase D** — it is the class of gap the handoff's trap #3 is about.
- **Refutations are unrecorded.** Round-1's 16 and the sweep's refutations exist as vote counts with
  no enumerated rationale, so nobody can distinguish a sound refutation from a missed bug. (Round B
  refuted nothing, so nothing was lost this time.)
