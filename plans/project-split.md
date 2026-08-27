# Researcher / Project split — REQUIREMENTS (design in progress, 2026-08-17)

> Status: requirements locked with Seth in conversation; the code-facts mapping is running and the
> full design (schema, key re-wrap, sessions, API, migration) lands below it in this file. Nothing
> here is implemented yet.

## Seth's specification, in his words

- *"Each project has one OWNER, one project can have multiple researchers — the owner can invite
  others, and one researcher can have multiple projects (created/owned or invited/joined)."*
- *"One researcher account can be logged into multiple devices at once, though with sane security
  precautions so that that doesn't open a wide exposure hole by being TOO lax."*
  ⚠ **"Devices" here means BROWSER SESSIONS** — the panel signed in on several browsers/computers
  at once. Clarified explicitly (2026-08-17): *"I was referring to different browser sessions with
  the same researcher account logged in"* — NOT the client editor/recorder field devices.
- **Field devices pair with a PROJECT, not a researcher account** (*"the devices need to be paired
  with a project, not a researcher account"*) — and he immediately flagged the constraint that
  rules the design: *"that might be a problem. Or a challenge for us to overcome. Without breaking
  existing things."*
- **Granular, owner-controlled member permissions** (2026-08-17):
  > *"The owner should have granular control over what invited assistant researchers can and can't
  > do: specific devices they can and can't see or manage, specific things they can and can't do on
  > specific devices or by default on all devices or on the Google Drive. Mainly focused on big
  > picture administrative/change/destructive things or read access, not so much random unimportant
  > details like every single user element or text-level choice or setting. More like can or cannot
  > create invites or change device settings for existing invites or devices. Or can or cannot see
  > or modify settings for specific devices. Can or cannot assign or remove texts, etc."*

## The permission model this implies

**Coarse capabilities + per-device exceptions — administrative verbs, not UI micro-permissions.**
Foolproofing outranks features (the suite's standing constraint), so the owner-facing shape should
be a short list of switches with per-device overrides, not a permissions matrix.

Per member, set by the owner:

| Capability | Meaning | Default granularity |
|---|---|---|
| `see` | which of the project's devices this member sees AT ALL | all devices, or an explicit list |
| `manageDevices` | change device settings, push commands, rename, revoke installs | per-device or all |
| `assignTexts` | assign texts to / remove texts from devices | per-device or all |
| `createInvites` | mint new pairing invites (and approve the devices they bring in) | project-wide yes/no |
| `drive` | read (fetch bundles/exports) vs manage (delete/move) on the project's Drive estate | project-wide read / manage |

Owner always holds everything and is the only one who can edit memberships or these switches.

**⚠ The design insight that makes `see` STRONG: under E2EE, visibility = key possession.**
A device's metadata is unreadable without its per-instance key (Ki). So "member cannot see device
X" should be enforced by NEVER WRAPPING X's Ki to that member — cryptographic, not a UI filter the
worker politely applies. Two enforcement tiers, stated honestly:

- **SEE = key delivery.** No Ki, no plaintext — the worker could hand over every ciphertext row and
  the member still reads nothing. This is the strongest guarantee in the design.
- **DO = worker-enforced capability checks** on every mutating endpoint. A member who can see a
  device necessarily holds its Ki, so read-vs-write on a visible device is authorization, not
  crypto — the worker gates the ACTION. This must be enforced worker-side (the panel UI hiding a
  button is not a permission model; the API is the boundary).

**Revocation honesty carries over** (the instance-revocation rule already in the suite): removing a
member's `see` on a device stops FUTURE key delivery and future API access; material they already
held while a member is not retroactively erased. The panel wording must say the true thing.

## Standing constraints (from the session, binding on the design)

1. **Nothing breaks.** Three compatibility surfaces, each with a named strategy:
   - Field devices: no device-facing endpoint changes path, auth, or response shape (APKs never
     auto-update — the worker serves yesterday's native clients indefinitely). Re-parenting an
     instance to a project must be invisible to the device.
   - Panel/API: additive-only schema; runbook order (D1 → worker → smoke → clients); old panel
     works against new worker during the window.
   - E2EE re-wrap: LAZY and CLIENT-DRIVEN — the server cannot re-wrap keys (that is the E2EE
     promise). The owner's panel does the re-wrap on first sign-in after the update; until then a
     single-member project behaves byte-identically to today. Failure degrades to "sharing not
     enabled yet," never to "field data unreachable."
2. **Migration**: every existing researcher gets a default project they own; instances re-parent
   server-side; devices don't notice.
3. **Sessions** (the browser-session half): split `secret_hash`'s two jobs (session token vs legacy
   password hash) FIRST; sessions become rows with the guards — visible session list, revoke-one /
   revoke-others, a cap with oldest-out eviction, per-session expiry independent of stay-signed-in,
   new-sign-in notice. The full guards argument is in BACKLOG ("the guards half").

## Owner key sovereignty (Seth, 2026-08-17: "the owner always able to see and revoke all keys")

**Yes — as three guarantees with different mechanisms, stated honestly:**

1. **The owner can always SEE every key grant.** Grant rows are server-side metadata: which member
   holds which device's wrapped Ki, which installs hold keys, which sessions exist, which invites
   are outstanding. The panel shows the owner the complete ledger. And the owner can always
   DECRYPT everything, structurally: the owner is the key authority — every Ki is wrapped to the
   owner by construction.

2. **THE INVARIANT (worker-enforced): no key grant exists without the owner's copy.** Any key-set
   write — including a new device paired by a member with `createInvites` — is REJECTED by the
   worker unless it includes a wrap-to-owner. So a member can never mint a device key the owner
   cannot read. ⚠ E2EE honesty: the worker can enforce that the owner-copy EXISTS, not that its
   ciphertext is well-formed (it cannot read it). A malicious member could wrap garbage — but that
   is detected the first time the owner opens the device (loud failure, never silent), and the
   remedy is revoking the member and re-keying the device. Sabotage-detectable, not
   silently-subvertible, which is the strongest claim any E2EE sharing scheme can make.

3. **The owner can always REVOKE — with the two meanings kept distinct** (the suite's standing
   revocation-honesty rule):
   - **Cut off (always, instantly):** delete the grant/membership/session row. The party can no
     longer fetch keys, decrypt future deliveries, or call the API. Owner-only, effective on the
     next request.
   - **Un-know (impossible retroactively, by nature):** material already downloaded while trusted
     cannot be erased from someone's machine. No design fixes this; the panel wording must not
     pretend otherwise.
   - **Rotation (the remedy for the future):** the owner can re-key a device — mint a new Ki,
     re-wrap to the remaining members and to the device via the existing command channel — so even
     a kept old key reads nothing new. Rotation is the escalation path after removing a member
     whose trust is actually in doubt; plain removal suffices for an amicable exit. (Phase it
     after the core split if need be, but the schema must allow per-device key VERSIONS from day
     one, so rotation is an addition rather than a migration.)

## Panel UI (Seth, 2026-08-17)

> *"The researcher panel starting with a list of projects. Ordered by most-recently accessed, and
> separated into two broad sections 'Mine' and 'Joined'. Then you click on a project and the page
> loads just like what we see now, except that there's a back button to the main home page
> (projects list)."*

- **Home = the projects list.** Two sections — **Mine** (owned) and **Joined** (member) — each
  ordered by most-recently accessed. Last-access is a client-side timestamp (localStorage, like
  the panel's other per-device prefs); it needs no server column and no sync.
- **Inside a project = today's dashboard, unchanged**, plus a back button to the projects list.
  Everything the panel does today happens INSIDE a project scope; the existing scroll-preservation
  and in-place-refresh rules carry over untouched.
- Labels localized (en + id) like the rest of the panel.
- **Small decision:** with exactly ONE project (every account on day one), does the panel
  auto-open it (back button still present) or always show the list? Recommendation: auto-open the
  sole project — day-one users see zero change from today, and the list appears the day a second
  project exists.

## Trust warnings at grant time (Seth, 2026-08-17)

> *"When inviting a co-researcher to a project, or granting them increased access, our UI should
> warn the user how much trust in that co-researcher they need to have — what you can't revoke or
> undo once you've given them access the first time."*

The revocation-honesty rule, moved UPSTREAM to the moment it actually helps: the owner should learn
what cannot be taken back BEFORE granting, not discover it while revoking. One warning box in the
invite/grant modal, its content assembled from the capabilities being granted, in plain language
(idiot-proof rule; localized en + id). Two honestly different categories, never blurred:

- **Cannot be undone, ever** (knowledge and copies): granting `see` on a device means they can read
  everything it has recorded and reported; granting Drive read means they can download copies.
  Removing them later stops FUTURE access — it cannot take back what they have already seen or
  saved. This is the "how much do you trust this person" warning, and it fires on the FIRST grant
  of each such capability.
- **Stoppable later, but not rewindable** (actions): `manageDevices`, `assignTexts`,
  `createInvites`, Drive manage. Everything they do while trusted — settings changed, texts
  removed, files deleted, devices paired — is real and may not be recoverable. Revoking ends the
  capability from the next request; it does not replay history.

Mechanics: warn on INVITE and on every INCREASE (adding a capability or widening a device list),
never on decrease; keep it one box, not a click-through per switch — the WS-mismatch "Send anyway"
dialog is the house pattern (explicit, plain, one decision). Escalating to a typed confirm (the
erase-data pattern) only for Drive MANAGE, the one grant that hands over destructive power on the
archive itself.

## Decision points for Seth (running list)

- ~~Who can mint pairing invites?~~ → **owner-controlled per member** (`createInvites`), per the
  granular-permissions spec above.
- Whose Drive holds a shared project's uploads — presumably the OWNER's; member Drive access then
  routes through the owner's refresh token server-side. Confirm, incl. the privacy implication.
- Member removal semantics: immediate API cutoff + no future keys (stated above) — confirm wording.
- Session guard tuning: cap count, expiry length, where the new-sign-in notice surfaces (panel
  banner vs email).

*(Design continues below once the code-facts mapping lands.)*

---

# PART II — THE DESIGN (grounded in the verified code-facts map, 2026-08-17)

An 8-agent mapping of worker/schema.sql, all 12 migrations, worker/src/v1.js (2,768 lines),
crypto.js, researcher.js, sync.js and researcher-panel.js, with every load-bearing claim
adversarially re-verified against source. File:line citations are in the map transcript
(session task w949tlidk); the facts below are the verified subset the design stands on.

## II.0 Verified facts that CHANGE the plan

1. **Device re-homing is safe, confirmed at the source.** A field device persists
   `{installId, installSecret, instanceId, …}` and authenticates with `x-fx-install` +
   `x-fx-secret` against `/v1/instances/<instanceId>/…` routes. **No device-side datum names the
   researcher** — `s.researcher` is a display-only name/avatar shown once, pre-accept. Re-homing an
   instance is a server-side UPDATE the device cannot observe. The ONE device-visible key fact:
   the device re-unwraps its Ki only when the poll body's `wrapped_key` CHANGES — so key rotation
   is already absorbed by deployed devices, including old APKs. (sync.js:162–176, 222, 354.)

2. **⚠ The E2EE promise is SOFTER than Part I assumed, and the design must say so honestly.**
   For Google-sign-in accounts (the only sign-in the current client offers), **Kr is minted BY the
   worker and stored worker-decryptable** (`kr_server_enc` under a SERVER_HMAC_KEY-derived AES key),
   and is decrypted + returned on every `GET /v1/researcher`. Password-lane accounts' Kr is
   client-wrapped, but the worker holds `ESCROW_PRIVATE_KEY` and exercises it in `/reset/verify`.
   **So "the server cannot re-wrap keys" is a POLICY line, not physics** — for Google accounts the
   worker could perform the entire Ki re-wrap migration server-side. Decision II.D1 below.

3. **The missing primitive is exactly one thing: researchers have no keypair.** The RSA wrap/unwrap
   primitives (`wrapKeyForInstall`, `unwrapKeyFromResearcher`, SPKI import, fingerprinting) are
   generic and reusable verbatim; installs already live this way. Nothing wraps researcher-to-
   researcher today because there is nothing to wrap TO. Adding a researcher keypair is the whole
   crypto delta.

4. **`secret_hash` is two regimes, not two jobs in one lane.** Password lane: a DURABLE
   password-derived verifier — already multi-session by construction (same authSecret authenticates
   any number of browsers). Google lane: a rotating single-session token hash — each sign-in
   evicts the previous session. The split is **password-verifier vs session-token**. Bonus finding:
   client `signOut()` never calls the server — a Google session hash stays valid in D1 until the
   NEXT sign-in. The session redesign fixes real dead code, not just adds capacity.

5. **The Drive re-route pattern already exists.** Device uploads, crowd submits and `/v1/textfile`
   serving all resolve the OWNING researcher's row from the resource and use THAT refresh token.
   Only the researcher-authed panel routes call `driveAccessToken(env, r)` with the CALLER's row.
   Making member access work = applying the existing pattern to ~13 panel routes. One trap: the
   assignment-finish path mints textfile tokens embedding the CALLER's researcher_id without
   touching Drive — a member-minted token would 410 at serve time; minting must embed the
   project's Drive-owner id.

6. **⚠ A member-visibility landmine already in the panel: the "Unassigned texts" card.** The panel
   classifies a Drive text as unassigned when NO visible inventory reports its docId, and offers
   "Remove from Google Drive" on it. Under partial visibility (a member who sees a subset of
   devices) this would misclassify live work as unassigned and offer to trash the only copy. The
   card (and storageModal's same predicate) must be gated to full-visibility contexts.

7. **Plaintext boundaries to state honestly in the permission model:** instance NICKNAMES, install
   status fields, Drive file/folder NAMES and the approval log are plaintext server-side. So
   member `see` is enforced in two tiers: worker FILTERING for metadata (nickname/status rows) and
   KEY NON-DELIVERY for content (inventories, commands, settings snapshots). Part I's "the worker
   could hand over every ciphertext row and the member reads nothing" is true of content, not of
   nicknames — the filter tier is real enforcement, not cosmetics, and must be tested as such.

8. **Client enumerated-rebuild traps:** `listView()` and `mintInvite()` rebuild server responses
   field-by-field and silently drop anything not named. Every new server field (project ids,
   capabilities, grants, session lists) must be added there or it vanishes client-side.

9. **Terminology collision:** the worker's `isOwner` means DEPLOYMENT OPERATOR
   (ALLOWED_RESEARCHERS). The split's "project owner" is a different role. The code/docs must
   rename the former (→ operator) before the word "owner" appears in project code.

10. **Account deletion must be re-specified.** Today's self-delete cascades over owned instances,
    installs, invites, crowd rows. Under projects: a MEMBER's deletion removes memberships and
    their grants only; an OWNER's deletion is a project-lifecycle question (decision II.D5).

## II.1 Schema (all additive; D1 conventions: run-once files, IF NOT EXISTS, nullable/default)

```sql
-- migrate-projects.sql
CREATE TABLE IF NOT EXISTS project (
  project_id   TEXT PRIMARY KEY,            -- GUID
  owner_id     TEXT NOT NULL,               -- researcher_id of the ONE owner
  name         TEXT NOT NULL,               -- plaintext, like instance.nickname
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_owner ON project(owner_id);

CREATE TABLE IF NOT EXISTS project_member (
  project_id   TEXT NOT NULL,
  researcher_id TEXT NOT NULL,              -- the member
  caps         TEXT NOT NULL DEFAULT '{}',  -- {"see":"all"|["instanceId"...],"manageDevices":...,
                                            --  "assignTexts":...,"createInvites":bool,
                                            --  "drive":"read"|"manage"} — owner-written JSON
  added_at     INTEGER NOT NULL,
  added_by     TEXT NOT NULL,
  PRIMARY KEY (project_id, researcher_id)
);

CREATE TABLE IF NOT EXISTS member_key (     -- the Ki grant ledger (owner-sovereignty ledger)
  project_id   TEXT NOT NULL,
  instance_id  TEXT NOT NULL,
  researcher_id TEXT NOT NULL,              -- grantee (OWNER HAS A ROW TOO — the invariant)
  key_version  INTEGER NOT NULL DEFAULT 1,  -- rotation-ready from day one
  wrapped_ki   TEXT NOT NULL,               -- RSA-OAEP to the grantee's researcher pubkey
  wrapped_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (instance_id, researcher_id, key_version)
);

-- researcher gains a portable keypair (multi-browser: the private key must follow the account):
ALTER TABLE researcher ADD COLUMN pubkey TEXT;          -- SPKI b64, like install.pubkey
ALTER TABLE researcher ADD COLUMN wrapped_privkey TEXT; -- PKCS8 wrapped under Kr (client-side)

-- instance + crowd_recorder gain the project pointer; researcher_id STAYS (dual-read window):
ALTER TABLE instance       ADD COLUMN project_id TEXT;
ALTER TABLE crowd_recorder ADD COLUMN project_id TEXT;

-- migrate-sessions.sql
CREATE TABLE IF NOT EXISTS session (
  session_id   TEXT PRIMARY KEY,
  researcher_id TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,               -- sha256 of the bearer token
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  label        TEXT,                        -- UA-derived, shown in the session list
  expires_at   INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_researcher ON session(researcher_id);
```

Why a separate `member_key` table instead of the owner's `settings_blob.wrappedKis`: the blob is
per-account and opaque; grants must be (a) per-grantee, (b) enumerable by the worker for the
owner's sovereignty ledger and the wrap-to-owner invariant, (c) revocable row-wise. The owner's
own copies MOVE into `member_key` rows (wrapped to their new pubkey) so one mechanism serves
everyone; `settings_blob.wrappedKis` remains readable as the legacy fallback during the window.

## II.2 Sessions (Phase A — independent of projects, ships first)

- Google callback: INSERT a `session` row instead of rotating `secret_hash`; return
  `researcher_id.token` in the fragment exactly as today (client shape unchanged).
- `authResearcher`: try `session` rows first (hash match + not revoked + not expired → touch
  `last_seen_at`); fall back to legacy `secret_hash` compare. Old panels keep working; password
  authSecret keeps working (its regime is unchanged).
- `/login` (password lane): also mints a session row and returns the token; the stored authSecret
  fallback keeps old clients alive.
- Guards: cap 5 sessions/account (oldest evicted), default expiry 90 days sliding
  (`staySignedIn` governs the CLIENT's storage choice exactly as today — it does not extend the
  server expiry), `GET /v1/researcher/sessions` (list: label, created, last_seen, current-marker),
  `DELETE .../sessions/:id` (revoke one), `POST .../sessions/revoke-others`. Panel UI in the
  account modal. New-sign-in notice: a panel banner on other sessions at next poll ("new sign-in
  from <label> at <time>") — no email infra exists, none added.
- `signOut()` finally calls the server (revokes ITS row), fixing the dead code.
- ⚠ secAlert hooks: session create/revoke logged like other auth events.

## II.3 Keys (Phase B)

- On first sign-in after update, the panel generates the researcher keypair (reusing the install
  primitives verbatim), stores pubkey + Kr-wrapped private key on the researcher row, and
  SELF-GRANTS: writes `member_key` rows for every owned instance (wrapped to its own pubkey),
  migrating out of `settings_blob.wrappedKis` (which stays as fallback).
- **Wrap-to-owner invariant** (worker-enforced): any `member_key` INSERT set for an instance must
  include a row for the project's owner_id, else 400. Applies to member-paired devices too.
- `getKi()` resolution order: memory cache → `member_key` row for me (unwrap with my private key)
  → legacy `settings_blob.wrappedKis` (owner only). One chokepoint, as today.
- Rotation (Phase E, schema-ready now): new `key_version` rows + `wrapped_key` redelivery to
  installs (devices absorb it, verified fact II.0.1).

## II.4 Authorization (Phase C)

- The 56 `researcher_id=?` binds, categorized by the map: 22 stay account-scoped (auth, TOTP,
  reset, settings blob, account approval); 6 become "project's Drive owner" resolutions; 28 become
  `project_id` scoping + capability checks.
- One helper, one shape: `authMember(req, env, instanceOrProject, needCap)` → resolves membership
  row, parses caps, enforces per-device overrides; owner passes everything. Every mutating
  endpoint names its capability (`manageDevices`, `assignTexts`, `createInvites`, `driveManage`).
- `GET /v1/researcher` becomes project-scoped: `?project=<id>` returns the instance list FILTERED
  by the member's `see` (tier-1 enforcement), with `has_key` reflecting THEIR grant rows. Without
  `?project`, legacy shape (their default project) — old panels unaffected during the window.
- Invite mint: `createInvites` capability; claim response identity block: project NAME + owner's
  display identity (decision II.D3 confirms wording).
- Drive: panel routes resolve the project's owner row (the existing device-lane pattern);
  `mintTextfileUrl` embeds the owner's researcher_id; member `drive:"read"` gates the proxy/list
  routes, `drive:"manage"` the trash/purge routes.
- The Unassigned card + storageModal predicate: rendered ONLY when the viewer's `see` is "all"
  (owner always; members only with full visibility). Landmine II.0.6 closed by construction.

## II.5 Migration & rollout (each phase independently shippable, old clients never break)

- **A. Sessions** — additive table; fallback auth keeps every old client working. Test: old panel
  (pre-update) against new worker on staging D1.
- **B. Default projects + keypairs + self-grants** — server backfill: one project per researcher
  (`owner_id` = them, name from their display name), `instance.project_id` filled; dual-read
  (`project_id` OR legacy `researcher_id`) everywhere until D. Client lazily generates keypair +
  self-grants. Single-member behavior byte-identical.
- **C. Membership + authorization + scoped panel** — the big client+worker release; runbook order
  (D1 → worker → smoke → clients); CORS same-commit rule for any new headers (v134 lesson: none —
  new params ride the BODY/query, per the house compat pattern).
- **D. Sharing UI** — projects home (Mine/Joined), member management, trust warnings, invites.
- **E. Rotation + polish.**
- **Testing rig:** Seth provisions a STAGING WORKER + STAGING D1 (offered 2026-08-17) — migrations
  rehearsed there first; the compat gate is a scripted probe replaying TODAY'S device calls
  (claim/poll/report/upload with current header/path shapes) against the migrated staging worker —
  it must pass unchanged at every phase. `?devworker=staging` points test clients at it.

## II.5b BUILD STATUS (updated as it lands)

- **Phase A — sessions: BUILT, worker-side, rig-green.** Session rows, legacy fallback, cap 5
  oldest-out, 24h/90d by the stay flag, list + revoke-one + revoke-others, sign-in notice email.
  R2-3 and round-1 finding 1 closed in code with tests that prove it.
- **Phase B — projects: BUILT, worker-side, rig-green.** `migrate-projects.sql` (project,
  project_member, member_key, researcher.pubkey/wrapped_privkey, instance/crowd project_id); the
  operator-gated idempotent backfill endpoint; the conditional keypair write (409 on a race); the
  key-grant ledger with the wrap-to-owner invariant enforced server-side.
- **Still to come for B, and deliberately not started:** the CLIENT half — generating the researcher
  keypair, self-granting existing Ki, and reading grants in `getKi()`. That is the first change to
  `docs/`, so it needs a version bump and Seth's test drive; the plan is to hand it over rather than
  stack client changes behind it.
- ⚠ **STATUS CORRECTED 2026-08-20 — this said "nothing is deployed", and that had stopped being
  true.** Checked against production D1 rather than re-read: `session`, `project`, `project_member`
  and `member_key` all EXIST in `flextext-connectivity`, so **both migrations are applied to
  production**, and the worker serving `connect.flextext.app` is current (deployed 2026-08-20 from
  `e894040`). `project_member` holds **0 rows** — nobody has been invited yet, which is the accurate
  version of "not in use". Phase A is live and in daily use (every researcher sign-in mints a
  session row).
  ⚠ A status line that says less than the truth is as misleading as one that says more: this one
  would have had the next reader re-applying migrations that were already in place. Verify status
  against the database, not against this file.

## II.5c ⚠⚠ ISOLATION IS A LOCKED REQUIREMENT, AT EVERY LEVEL (Seth, 2026-08-19)

> *"An invited researcher shouldn't on ANY level get access to things on the owner's Google Drive
> outside the scope of what they've been given access to. Not UI access, not API access, not Google
> Drive permissions, not worker endpoints or JavaScript functions or objects or anything."*
> *"And it should all be fully revokable."*
> *"the access filter needs to not be paper on the front end."*

This is not a preference to weigh against convenience. It is the property the whole project split
exists to deliver, and it invalidates several shapes that would otherwise be the obvious way to build
this. Written before the client half starts, because every one of these is cheap now and expensive
after a member exists.

### The rules

**1. Scope in the WORKER, at the query, for every endpoint — never in the panel.** A hidden tab is
paper: the names, ids, device nicknames and text titles are still in the response, in devtools, and
in any local cache. §11 of drive-as-truth is explicit that those names are the plaintext this design
protects. Every route that today scopes by `researcher_id` must scope by the caller's PROJECT GRANTS
instead — and the ones that walk Drive wholesale are the dangerous ones:

| route | why it is a hole today |
|---|---|
| `GET /v1/researcher/drive-estate` | builds from `driveListAll` — the owner's ENTIRE Drive |
| `GET /v1/researcher/drive-snapshot` | returns raw `driveListAll` by design (§17.0) |
| `POST /v1/researcher/drive-unassign` | resolves project folders across the whole tree |
| `POST /v1/researcher/projects/{migrate,unmigrate,rename}` | act on the master folder as a whole |
| `/v1/instances/*` | scoped by `researcher_id`, which stops being the boundary |

**2. ✅ DECIDED — BROKERED ONLY. Members get no Google Drive permissions at all.**

Seth supplied the criteria that settle it: *"(1) no drift possible, (2) permissions very precisely and
carefully and consistently scoped and revokable at all levels, (3) minimize UI lag, extra Google Drive
requests, etc."* Scored against those three, brokered-only wins each — and B fails structurally, not
narrowly.

**(1) No drift possible.** A has ONE record of who may see what: the D1 grant. There is no second
representation for it to disagree with, so drift is impossible *by construction* rather than by
diligence. B has two — the Drive ACL and its D1 index — and every pair like that has a window where
they disagree: a permission changed in the Drive UI, a half-failed write, an index not yet refreshed.
Naming Drive the source of truth decides *who wins* a disagreement; it does not stop one happening.

**(3) Minimise lag and Drive requests.** A resolves authorization from a D1 read — no Drive call at
all; Drive is touched only to move actual bytes. B either reads Drive live per decision (a round trip
on every authorization, against a ~50-subrequest ceiling we have already hit twice) or caches the
answer — which is where drift lives.

⚠ **AND THAT IS THE STRUCTURAL PROBLEM: in B, (1) and (3) are the same dial turned opposite ways.**
Live reads buy no-drift and pay in latency and subrequests. A cache buys speed and pays in a drift
window. There is no setting that satisfies both, so B cannot meet Seth's stated bar however carefully
it is built. A does not have the dial.

**(2) Precisely scoped and revocable at every level.** Also A, and by more than expected:

- Drive's model is COARSER than ours, not finer. It shares a folder, inherited by everything inside
  it *including files added later*, with roles Google defines and re-sharing on by default. Ours can
  say exactly what it means, per project, per route.
- Revocation in A is one act with total effect. In B it is TWO acts that must both succeed, one of
  them against an external system — so the failure mode is a member revoked in our records and still
  holding a live Drive ACL, which is the worst of both.
- ⚠ **A's own gap must still be closed before members ship:** `mintTextfileUrl` issues 90-day tokens,
  so revocation is not complete until the deny-list (rule 3 below) exists. The token already carries
  `n` and `iat` for exactly this. It is required, not optional.

⚠ **Why the drive-as-truth analogy DOESN'T transfer, since that is what made B attractive.** For DATA,
Drive genuinely holds the thing and D1 was duplicating derived facts — so making Drive authoritative
removed a copy. For PERMISSIONS, Drive holds nothing we need: the grant is *our* concept, expressed in
our vocabulary, and mirroring it into Drive would ADD a copy rather than remove one. Same words,
opposite effect.

**What is given up, stated plainly:** members get no Drive UI, no desktop sync and no bulk download,
and if the worker is down they have no access at all (the owner still does, through their own Drive).
The middle ground stays available and does not require B: **owner-initiated sharing as a deliberate
one-off** — the owner shares a specific artifact as a human decision about a specific thing, rather
than a standing permission that quietly covers everything added afterwards.

<details><summary>The full two-option comparison, kept because the reasoning is worth more than the verdict</summary>

**2. ⚠ OPEN DECISION — brokered-only vs mirrored into Drive.** Seth raised mirroring, then pulled
back to *"I DON'T want invited researchers to have the same Google Drive permissions the owner does"*
and asked for the trade-off written out. It is not settled, so it is recorded as a decision rather
than a rule. **Recommendation: A.**

⚠ **First, a correction to the framing, because it changes the question:** mirroring would not give a
member "the same permissions the owner does". Drive sharing is graded — Viewer, Commenter, Editor —
and the owner stays owner. Viewer cannot move, rename or delete anything. But the underlying instinct
survives the correction: it still puts a third party with STANDING RIGHTS inside the owner's Drive,
and Viewer does not change that.

**Option A — brokered only.** Members reach nothing directly; every read goes through the worker on
the owner's token, scoped to their grants.

| | |
|---|---|
| **Pros** | One door, so every access is scoped, logged and revocable by our code. Revocation is immediate and total. No Google account needed, so the password lane still works. No `drive.file` scope question. The owner's Drive stays entirely their own — nobody else has any standing in it. |
| **Cons** | Worker down = members have no access (the owner still does). All member traffic costs worker subrequests and the owner's Drive quota. No Drive desktop sync or bulk download for members. Every affordance — browse, download, export — is ours to build. |
| **Risks** | Our authorization code is the ONLY thing between a member and the whole estate, so a bug is a total leak (§16.30). `mintTextfileUrl`'s 90-day tokens make "revocable" false until the deny-list exists. |
| **Cost** | Moderate, and all of it in code we own and can test. |

**Option B — mirror the grant into Drive (optionally as source of truth).**

| | |
|---|---|
| **Pros** | Survives us — if the worker is gone the right people still reach the data, the same instinct as `flextext` being the export format. The owner manages sharing in a UI they already trust. Drive-side revocation kills the Drive path completely. Members get bulk/desktop access for free. Consistent with drive-as-truth: Drive holds, D1 indexes. |
| **Cons** | Sharing a FOLDER grants everything inside it, including everything added later. An Editor could move or delete inside the owner's Drive; Viewer cannot, but can download all of it. Re-sharing is Drive's default behaviour unless explicitly restricted. Members need a Google account, excluding the password lane. Depends on `drive.file` permitting `permissions.*` on app-created folders — likely, unverified. As source of truth, authorization now depends on an external system's availability, and the index must fail closed. |
| **Risks** | ⚠ **The failure modes live outside our system AND outside our audit.** An over-broad ACL, a link-share, a member re-sharing onward — we would not see any of it, and could not report it. |
| **Cost** | Higher, and the residual risk is not in code we can test. |

**Why A, and it is one argument rather than a tally.** Option B's characteristic failure is *we
cannot see what was taken*. For a system whose purpose is protecting the privacy and research
standards of the communities this data comes from, unauditable access is the wrong property to design
in — worse than the inconvenience it removes. Option A's characteristic failure is a bug in our own
authorization: serious, but ours, and testable (§16.30's test is exactly that).

**The middle ground worth naming rather than inventing later:** A, plus **owner-initiated sharing as
a deliberate one-off**. When a member genuinely needs bulk access, the owner shares that artifact
themselves, as a human decision about a specific thing — not a standing permission that quietly
covers everything added to the folder afterwards.

⚠ **If B is ever chosen, verify first, in an afternoon:** that `drive.file` permits
`permissions.create/list/delete` on a folder the app created. And note what it does NOT give: a
folder shared *to* a member is not app-created *for them*, so their own app token still cannot list
it — their client would keep reading through the worker regardless. The ACL would serve the human in
the Drive UI, not the app. That halves B's benefit and is worth knowing before choosing it.

</details>

### II.5d ⚠⚠ NO-DRIFT INVARIANTS — how "consistently in sync" is made structural rather than careful

> *"make extra sure that there's no way anything can drift and that all levels that we adjust are
> always consistently in sync."* (Seth, 2026-08-19)

Choosing brokered-only removed the drift between Drive and D1. It did NOT remove drift between the
levels *inside* our own system, and there are more of those than there look:

| level | what it is | how it could drift from the grant |
|---|---|---|
| the grant | the D1 row saying "X may see project P" | — (this is the authority) |
| minted URLs | `mintTextfileUrl` tokens, 90-day TTL | self-standing today: they carry their own authority and outlive a revoked grant |
| wrapped Ki | `member_key` — the project key wrapped to the member | a revoked member still holds the key bytes |
| the estate response | what `/drive-estate` returns | scoped at request time, so it follows — unless it is cached |
| session / cookie | the member's signed-in session | outlives the grant unless checked per request |

**The design rule that makes drift impossible rather than unlikely: DERIVE, DON'T DUPLICATE.** No
level stores its own copy of the answer. Each one either computes it from the grant at the moment of
use, or is checked against the grant at the moment of use. Then there is only ever one fact, and
"keeping them in sync" is not a job anyone can forget to do.

**The invariants, each with its mechanism — an invariant with no mechanism is a wish:**

- **I1 — ONE AUTHORITY.** Exactly one row answers "may X see project P". Every route resolves it;
  none caches a decision derived from it.
- **I2 — NO SELF-STANDING CAPABILITY.** ⚠ This is the one that requires a change to shipped code.
  `/v1/textfile` today validates the TOKEN and streams; the token's own contents are its authority.
  It must additionally resolve the grant at redemption. That single change turns "a 90-day capability
  that outlives revocation" into "a pointer that is only good while the grant is", and it makes the
  deny-list unnecessary for the revocation case — the grant check IS the deny-list, and it cannot go
  stale because it is read fresh. (Keep `n`/`iat` for retiring a LEAKED link, which is a different
  problem.)
- **I3 — ONE WRITER, ONE ACT.** A grant change is a single D1 batch. There is no second store, so
  there is no partial state to reconcile and no ordering to get wrong.
- **I4 — FAIL CLOSED, EVERYWHERE.** Any check that cannot resolve the grant DENIES. A resolution
  failure must never fall through to the old `researcher_id` scoping, which would silently widen
  access at exactly the moment something is already wrong.
- **I5 — REVOCATION ROTATES.** Dropping a grant re-keys the project: new Ki, re-wrapped for the
  remaining members, the revoked member's `member_key` row deleted. Without rotation the member keeps
  reading anything encrypted under the old key. ⚠ The honest limit stands and must be said to the
  owner at invite time: rotation stops FUTURE reads; it cannot un-download what was already taken.
- **I6 — ENFORCED BY A SCRIPT, NOT BY REVIEW.** The repo already has the right idiom:
  `check-native-containment.sh` fails the build when the native boundary leaks. Do the same here —
  enumerate every route that touches project data and fail when one of them does not resolve a grant.
  ⚠ This is the invariant that keeps the other five true a year from now, when someone adds route
  number forty-one and nobody remembers this section. Write it in the same commit as the first grant
  check, not afterwards.

⚠ **Why a test and not a helper function.** A shared `requireGrant()` helper is worth having, but it
cannot fail a build when a new route simply does not call it. Containment has to be checked from the
outside, by something that enumerates what exists rather than trusting what was written.

**3. Never hand a member the owner's Drive token, or anything derived from it that outlives the
grant.** The existing pattern is right — `mintTextfileUrl` issues opaque, time-boxed, instance- and
doc-scoped URLs — but ⚠ **a 90-day TTL is not revocation.** The token carries `n` (a per-token id)
and `iat` precisely so a deny-list can retire one; that comment calls a deny-list a future
possibility. Under this requirement it is **mandatory before members ship**, or "fully revocable" is
false for up to 90 days.

**4. Revocation must be one act with total effect:** drop the grant, deny-list every URL minted under
it, and rotate the project's Ki with a re-wrap for the remaining members. Any of those missing leaves
a door open.

### ⚠ The honest limit, stated so the plan never implies otherwise

**Revocation cannot un-download.** The data is E2EE and a member legitimately held Ki, so anything
they already synced or exported is theirs and stays theirs. "Fully revocable" can only mean *no
further access from the moment of revocation* — no new reads, no new syncs, no usable cached keys for
anything fetched later.

That is not a gap to fix; it is what revocation means for any system where a person could read the
data at all. **But it must be said out loud to the owner at the moment they invite someone**, because
the natural reading of "revoke" is "undo", and the gap between those two is exactly where an owner
would be surprised. It also argues for granting narrowly in the first place: the blast radius of a
revocation is everything the member could see up to that second.

### What this changes about the work already done

Nothing built so far violates it — there are no members, so every token is its own owner's. The
switcher deliberately does NOT filter (see drive-as-truth §16.30 and its test): it renders whatever
the estate returns, so scoping the estate server-side scopes the tabs for free, and a client-side
filter would only have hidden the server's over-sharing.

## II.6 Decisions still open (the complete list)

- **II.D1 — The E2EE policy line.** Keep the "client-driven re-wrap only" stance (server never
  uses its latent Kr access; strongest story, slowest migration), or allow ONE server-assisted
  migration step for Google accounts (faster, uses capability the worker already has, must be
  documented honestly). Recommendation: client-driven — the code comment "the worker can't unwrap"
  should become TRUE over time, not more false.
- **II.D2 — Drive ownership per project = the OWNER's Drive** (assumed throughout). Confirm, incl.
  member uploads landing there and the quota being the owner's.
- **II.D3 — Claim-screen identity** for project invites: "«Project name» — managed by «owner»"
  (recommended), even when a member minted the link.
- **II.D4 — Sole-project auto-open** (Part I recommendation stands).
- **II.D5 — Owner account deletion**: block while the project has members/devices (recommended),
  vs transfer-ownership flow (later feature).
- **II.D6 — Session guard tuning**: cap 5, 90-day sliding expiry, banner-only notification —
  confirm or adjust.

---

# PART III — AUDIT, ROUND 1 (single-context pass, 2026-08-17)

> ⚠ Provenance: the five-lens fan-out audit DIED on the account's monthly spend limit — zero
> findings produced; that empty result is a failure artifact, not a pass. This section is a
> single-context audit performed with the full verified map in hand. Re-run the fan-out audit
> (script preserved: project-split-audit) when the limit resets/raises, before Phase C ships.

## Confirmed findings (each with its fix folded into the design)

1. **SECURITY — the legacy skeleton key.** After sessions ship, a Google account's OLD
   `secret_hash` (the last pre-migration session token) stays honored by the fallback FOREVER —
   nothing rotates it anymore, so "revoke other sessions" would be a lie while it lives.
   **Fix (now in II.2):** on an account's first session-lane sign-in, rotate `secret_hash` to
   random garbage — for `google_sub` accounts only (the password lane's verifier regime is
   deliberately untouched). The fallback then dies per-account, exactly one sign-in after upgrade.

2. **SECURITY — member pubkey substitution.** Installs defend against a hostile worker swapping
   pubkeys with an out-of-band FINGERPRINT check before key delivery. The member-grant flow has no
   equivalent — a swapped `researcher.pubkey` would make the owner wrap Ki to an attacker.
   **Fix (II.4):** the member-management UI shows each member's pubkey fingerprint (same SHA-256
   SPKI prefix, same wording as installs) and the trust-warning dialog carries it; verification is
   out-of-band exactly like device approval.

3. **CORRECTNESS — concurrent keypair generation.** Multi-session means two browsers of the same
   account can race Phase B's keypair generation; last-write-wins on `pubkey` would strand grants
   wrapped to the clobbered key. **Fix (II.3):** conditional write (`UPDATE … WHERE pubkey IS
   NULL`, worker 409s otherwise); the losing browser fetches the winner's pair and unwraps
   `wrapped_privkey` with Kr. Idempotent by construction.

4. **DESIGN GAP — `instance.researcher_id` must remain TRUE, as the Drive-owner cache.** Device
   uploads and crowd submissions resolve the Drive refresh token via
   `instance JOIN researcher ON researcher_id` — a join old APKs exercise forever. **Rule (II.5):**
   `instance.researcher_id` is redefined as a maintained denormalization: ALWAYS equal to the
   project's `owner_id`, updated in the same transaction as any ownership transfer. Old clients'
   joins then stay correct permanently, and the "dual-read window" for THIS column never has to
   close.

5. **DESIGN GAP — per-device `see` vs project-wide Drive.** Drive folders are named per DEVICE
   ("FlexText Uploads/<Device>/<Story>", plaintext names). A member with `see` restricted to
   device A but `drive: read` can still list device B's folder and file NAMES (and fetch its
   files) through docId-routed Drive routes. Options: accept + say it in the trust dialog
   ("Drive read shows all project files, including devices hidden from them"), or scope the
   estate listing to the member's see-list (leaky against direct docIds unless every Drive route
   filters). **→ Decision II.D7 for Seth; recommendation: accept + disclose** — Drive is
   project-level in his own spec, and the false sense of a filtered estate is worse than an
   honest disclosure.

6. **DESIGN DECISION — remote wipe stays owner-only.** Wipe is the most destructive device action
   and today carries a second-factor step-up on the CALLER's account. A member's TOTP protecting
   the owner's device is the wrong shape. **II.4 amended:** wipe (and force-remove) are owner-only
   in v1 of the split; revisit only if a real need appears.

7. **OPS — the backfill cannot be a plain migration file.** The default-project backfill mints
   GUIDs and derives names — beyond comfortable D1 SQL (`hex(randomblob(16))` is possible but
   non-RFC-4122 and unreviewable). **Fix (II.5):** backfill runs as a worker admin endpoint
   (operator-gated, idempotent: `INSERT … WHERE NOT EXISTS`), rehearsed on the staging D1 first.

8. **OPS — the compat probe does not exist yet.** No harness in test/ replays today's device
   calls. **Deliverable added (II.5):** `test/worker-device-compat.probe.mjs` — drives
   claim → accept → poll → report → upload-target against a worker base URL using TODAY'S header
   and path shapes; run against staging at every phase; must pass byte-identically.

9. **DOCUMENTED CAVEATS (no code change):** (a) for Google-lane accounts the worker can
   transitively read `wrapped_privkey` (via Kr) — member grants add no protection AGAINST THE
   WORKER for those accounts; this is parity with today (the worker already holds Kr→Ki), not a
   regression, and II.D1 governs whether that ever tightens. (b) Password-lane parallel use is
   invisible to the session list (bare authSecret per-call, no session rows) — legacy lane, no
   current client mints it; note in the session UI copy. (c) The OAuth fragment token should be
   stripped via history.replaceState on receipt — today's exposure, slightly longer-lived under
   multi-session; cheap hygiene, added to Phase A.

## Readiness verdict

- **Phase A (sessions) and Phase B (default projects + keypairs + self-grants): build-ready now**,
  pending decisions II.D1 (E2EE policy line) and II.D6 (guard tuning) — both have recommendations
  on the table.
- **Phase C (membership + authorization): design-complete, not build-ready** until (a) the
  fan-out audit re-runs clean (spend limit), (b) II.D2/D3/D5/D7 are decided, and (c) the compat
  probe exists and passes against the staging worker on Phases A–B.
- **Staging worker + staging D1** (Seth, 2026-08-17: "we can implement a staging worker and
  staging D1 for you to test with") is the prerequisite rig for ALL of it — first concrete task.
  ⚠ Superseded in detail by PART IV: **both already exist** in `worker/wrangler.toml [env.staging]`
  (created 2026-08-11), so this is a freshening task, not a provisioning one — and PART V proposes
  doing most of it with no remote rig at all.

---

# PART III — AUDIT, ROUND 2 (2026-08-17)

> ⚠ **Provenance, stated plainly.** The fan-out audit was re-run; its attack phase partly completed
> and then **all 37 verification agents died on the account's monthly spend limit**, and the run's
> output file was lost when the container reset. Two findings had been CONFIRMED before the limit
> hit; both are **re-verified here by hand against source**, with citations, so they stand on their
> own evidence rather than on a lost transcript. Findings R2-3…R2-6 are new, found in this pass.
> **The fan-out audit still owes a clean run** before Phase C ships — the unverified attack findings
> from that run are gone, not cleared.

## R2-1 — SECURITY: member Drive access spans the owner's ENTIRE estate, all projects (CONFIRMED)

Member Drive routes are designed to run on the OWNER's token (II.D2). But the Drive helpers have no
project dimension whatsoever, so "the project's Drive" is not a thing the worker can currently
express:

- `driveMasterFolder()` (v1.js:414) finds ONE `FlexText Uploads` folder per Google account, by
  app-property tag. Every project's device folders are siblings inside it.
- `driveListAll()` (v1.js:428) lists **every file the app ever created in that account** — which is
  precisely the storage manager's design intent today (`drive.file` scope = the whole FlexText
  estate), and precisely wrong once a second researcher can call it (v1.js:1357–1358).
- `POST /v1/researcher/trash` (v1.js:1478) takes arbitrary `fileIds` — bounded to 100, **no
  parentage check**. A member could trash any file in the owner's estate, including other projects'.
- `POST /v1/researcher/drive-purge` (v1.js:1430) takes **no file list at all**. It lists the whole
  trash and permanently deletes it. One click by one member = every trashed file in the owner's
  account gone, across every project, unrecoverably.

**Fix (amends II.4).** Drive authorization for members is scoped by FOLDER PARENTAGE, not by token:
resolve the project's device folders from `instance.oauth_folder_id WHERE project_id=?` (plus the
crowd recorders' `oauth_folder_id`), and (a) filter the estate listing to those parents, (b) verify
every `fileIds` entry's parent is in that set before trashing, (c) give purge an explicit id list
derived from the same filter — a member's purge may never be "empty the trash". The owner keeps
today's account-wide behaviour. ⚠ This makes **II.D7's "accept + disclose" recommendation obsolete
for the DESTRUCTIVE half**: disclosure is a fair answer to a member SEEING more than their project;
it is not a fair answer to a member DELETING another project's archive.

Related, and useful: the "unassigned" Drive folder already exists as a first-class thing
(`appProperties: { flextextRole: 'unassigned' }`, v1.js:535) — the backlog's *Assign to Drive
(Unassigned)* feature has a home, and it must be created per project once folders are project-scoped.

## R2-2 — SECURITY: key rotation never reaches an idle device (CONFIRMED)

`POST /v1/instances/:id/installs/:id/key` stores the new wrapped Ki with a bare
`UPDATE install SET wrapped_key=? WHERE install_id=?` (v1.js:2078) — `instance.desired_rev` is not
touched. The poll then short-circuits **before** the body that would carry it:
`if (inst.desired_rev <= since) return 204` (v1.js:2350), and `wrapped_key` only rides the 200 body
on the next line. A device with nothing else pending therefore never learns its key changed, and
keeps encrypting under the Ki a removed member still holds — indefinitely, silently.

This is latent today (nothing rotates keys yet) and load-bearing the moment rotation ships, which is
the whole remedy path in "Owner key sovereignty".

**Fix (amends II.3).** Key delivery must bump `desired_rev` in the SAME statement batch as the
`wrapped_key` write, so the existing "device re-unwraps when `wrapped_key` changes" path (verified
fact II.0.1) actually fires. Test: set a key on an install whose `desired_rev == since`, poll, assert
200-with-`wrapped_key` rather than 204.

## R2-3 — CORRECTNESS: `signout` destroys a password-lane account (Phase A hazard)

`POST /v1/researcher/signout` rotates the ACCOUNT's `secret_hash` to random (v1.js:1051). For a
Google-lane account that is exactly right (the hash IS the session token). For a **password-lane**
account the same column is the **durable password verifier** compared at `/login` (v1.js:924) — so
signing out would silently destroy the ability to log in, recoverable only by an emailed reset.

It cannot bite today: the client's `signOut()` is purely local (`researcher.js:67` clears storage and
never calls the server), and the password lane is **absent from the shipped client entirely** (no
`authSecret` anywhere in `docs/js/` outside a `crypto.js` comment). II.2 proposes wiring `signOut()`
to the server — which is what would arm it.

**Fix (amends II.2).** `signout` revokes THIS SESSION'S row and nothing else. It may only touch
`secret_hash` when `google_sub IS NOT NULL`, and that clause is what makes round-1 finding 1 (the
legacy skeleton key) safe too — both changes must carry the same lane guard.

## R2-4 — REASSURANCE (with one exception): the ownership binds fail CLOSED for members

Every instance/install/crowd ownership check is a filter — `WHERE … AND researcher_id=?` — that
returns `not_found` when it does not match (v1.js:1206, 1604, 1623, 1653, 1705, 1733, 1792, 1814,
1868, 1911, 1944, 1986, 2032, 2048, 2071, 2088, 2103, 2136, 2473, 2703, 2722, 2728, 2732). With
`instance.researcher_id` maintained as the owner (round-1 finding 4), a member hitting an unconverted
endpoint gets a clean 404, never someone else's data. **So Phase C can convert endpoints one at a
time**: an unconverted route means "members can't do that yet", not a leak. That is the property that
makes the big release survivable, and every conversion must preserve it (filter, never post-hoc
check).

**The one exception, and it is destructive:** account self-delete cascades on
`WHERE researcher_id=?` over instances, installs, invites, crowd rows (v1.js:2754–2762). Under the
maintained denormalization an OWNER's self-delete would silently destroy a project that other
researchers are members of, together with their devices. Round-1 finding 6 / II.D5 already recommends
blocking owner deletion while a project has members or devices — R2-4 upgrades that from a design
preference to a **required guard, with the cascade cited**. A member's self-delete must additionally
remove their `project_member` and `member_key` rows, or the grant ledger orphans.

## R2-5 — CONSTRAINT: `authResearcher`'s return SHAPE is load-bearing

`authResearcher` returns the whole `researcher` row (`SELECT *`, v1.js:328), and callers read
`drive_refresh_enc`, `settings_blob`, `settings_rev`, `drive_email`, `drive_error`, `totp_enabled`,
`approved`, `kr_server_enc` straight off it. The session lane must therefore change only **how the
row is found** (session row → JOIN researcher), never what is returned. Stated as an invariant in
II.2 so nobody "cleans it up" into returning a session object.

## R2-6 — OPS, and the biggest one: there is no migration ledger, and the repo cannot replay itself

Four facts, each verified by running it (2026-08-17), that together mean **no environment can be
reconstructed from this repo deterministically**:

1. **No applied-migrations table exists.** The rule is "run each `migrate-*.sql` exactly once",
   enforced by memory and by the runbook's prose. Nothing can answer "what does that database
   actually have?"
2. **`schema.sql` has been folded FORWARD.** It already declares `researcher.salt … backup_codes`
   (migrate-auth) and `instance.estate` / `crowd_recorder.estate` (migrate-estate). A database
   created from it is not the pre-migration database, and replaying the migrations over it hits
   8 duplicate-column errors that never happened in production.
3. **`wrangler d1 execute --file` is ATOMIC.** A three-statement file whose middle statement
   duplicated a column left NEITHER surrounding `CREATE` behind. So a half-applied database cannot
   be repaired by re-running the file — the duplicate aborts the whole thing and the missing columns
   stay missing. Repair is necessarily statement-by-statement.
4. **Two migrations REBUILD a table** (`migrate-instance-type-unified.sql`,
   `migrate-approved-domains-hashed.sql`) — SQLite cannot ALTER a CHECK, so they create a new table
   with a FIXED column list, copy, drop, rename. Re-running the instance one today destroys
   `estate` and `oauth_folder_id` **and their data**; once the split ships it would destroy
   `project_id` too. Production is fine only because that file ran before those columns existed.

**Consequence for this project.** The staging D1 was created from `schema.sql` alone (the wrangler.toml
comment records exactly that command), so **it is not a copy of production's schema** — rehearsing
migrations there proves nothing about production unless it is topped up first, statement-wise, and
verified. PART IV starts there.

**Fixes landed with this audit (not proposals — they are in the tree):**
- `worker/schema-report.sql` — read-only, safe against production: dumps `sqlite_master` so any
  database can be asked what it really has. `sqlite_master.sql` reflects ALTERed columns, so the
  CREATE text is current, and diffing two outputs names the missing ALTERs exactly.
- `test/worker-schema.test.mjs` — replays `schema.sql` + all 12 migrations **statement-wise** in
  `node:sqlite`, asserts the result against a checked-in snapshot (`worker/schema-expected.json`),
  pins the 8 folded-forward duplicates, requires every table-rebuilding migration to carry a
  run-once warning in its own header, and names the columns a re-run would destroy. Verified to FAIL
  on the real hazard: replaying the rebuild last reports
  `instance: missing [estate, oauth_folder_id]`.

**Rules this imposes on the split's own migrations:** additive `ALTER`/`CREATE` only — **no table
rebuilds, ever**; one concern per file so an abort is legible; and the snapshot test regenerated
deliberately in the same commit, so the expected schema is reviewed as a diff.

## Readiness verdict, revised

- **Phase A (sessions)**: build-ready, with R2-3's lane guard and R2-5's invariant written into the
  work, plus II.D6 confirmed.
- **Phase B (default projects + keypairs + self-grants)**: build-ready once the migration files are
  written to R2-6's rules and rehearsed per PART IV or PART V.
- **Phase C**: unchanged — design-complete, not build-ready. Now additionally gated on R2-1's
  folder-parentage scoping, which is a real chunk of Drive work, and on R2-2 shipping with rotation.

---

# PART IV — freshening the staging rig

> **Steps 1 and 2 are DONE (2026-08-17), run by Claude through the Actions workflow.** Seth has no
> wrangler locally and does not need it: `worker-wrangler.yml` is dispatchable through the GitHub
> API, so the schema work needed no console at all. What is left for Seth is steps 3–6 — four
> secrets, one Google console entry, the deploy, and a test browser.

## Measured results (production and staging, read-only)

**Production's schema is EXACTLY what the repo replays.** All 9 tables, every column, all 7 indexes
match `worker/schema-expected.json` — so `test/worker-schema.test.mjs` is now a test of production
truth, not just of internal consistency. Production also carries the rebuild's fingerprint
(`CREATE TABLE "instance"`, quoted), confirming the reconstruction in R2-6.

**Production inventory** (counts only; sizes the backfill):

| | | | |
|---|---|---|---|
| researchers | **7** (all Google-lane, all approved, all holding a Drive token) | duplicate email keys | **0** — the unique index is safe |
| instances | 34 total, **7 live** | orphaned instances | **0** |
| estate | 21 pages / 13 cloud (all rows) | installs | 28 total, **5 live**, 26 approved, 26 holding a key |
| unclaimed invites | 33 | crowd recorders / approved domains / approval log | 1 / 11 / 150 |

So the Phase B backfill mints **7 projects** and stamps **34 instances** — small enough to rehearse
exhaustively, and small enough that a mistake is repairable by hand.

**Legacy-estate answer** (Seth's open question — *"are there active devices on the GitHub Pages
URLs, and whose?"*): among LIVE instances, **4 are `pages` and 3 are `cloud`**; **2 researcher
accounts** hold the live `pages` devices, and **3 of those devices checked in within 30 days**. So
the satellite-retirement conversation is with two accounts, not a crowd. ⚠ The addresses are
deliberately NOT queried here — a public workflow log is the wrong place for them; read them in the
Cloudflare dashboard's D1 console.

**Staging was drifted, and R2-6 is why — caught in the wild.** Staging matched production on every
table and index EXCEPT `instance`, which had 8 columns to production's 10 (missing `oauth_folder_id`
and `estate`). Its `CREATE TABLE "instance"` is quoted too: `migrate-instance-type-unified.sql`
rebuilt the table and dropped the `estate` that `schema.sql` had just created, and
`migrate-estate.sql` could not restore it because its second statement was a duplicate and `--file`
is atomic — so its good first statement rolled back as well. **Fixed** by `worker/topup-staging.sql`
(applied 2026-08-17); staging and production now agree.

## What is left for Seth (steps 3–6 below): secrets, the Google redirect URI, the deploy, a browser

**The rig already exists.** `worker/wrangler.toml` has had `[env.staging]`
(`flextext-r2-worker-staging`, `routes = []`, `workers_dev = true`) and a bound
`flextext-connectivity-staging` D1 since 2026-08-11. Nothing needs creating. What it needs is a
schema that matches production, secrets, and one Google console entry. ⚠ Per PART V, **none of this
blocks Phases A–B** — do it when convenient.

### 1–2. Schema: asked, diffed, repaired — DONE (kept here for the method)

The two read-only dumps and the repair, exactly as run:

```
d1 execute flextext-connectivity          --remote --command "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
d1 execute flextext-connectivity-staging  --remote --command "…the same query…"
d1 execute flextext-connectivity-staging  --remote --file=topup-staging.sql
```

⚠ **`--remote --file=` silently reads nothing.** Wrangler treats a file against a REMOTE database as
a bulk IMPORT: it uploads it and prints a summary ("Executed 1 queries … 27 rows read") with no rows
at all. `--local --file=` DOES print rows, so the difference is invisible until it costs a run — and
an empty-looking result reads exactly like an empty database. Remote READS go through `--command`;
remote WRITES are fine as `--file`, which is why the top-up ran that way.

⚠ **D1 rejects long compounds.** A 20-term `UNION ALL` inventory came back
`too many terms in compound SELECT [code: 7500]`. One row of scalar subqueries has no such limit —
and the split's own report and migration SQL must avoid long compounds for the same reason.

⚠ **Never put rows in a workflow log.** The repo is public, so the log is public.
`worker-wrangler.yml`'s own header example (`SELECT researcher_id, drive_email, approved FROM
researcher`) was written while the repo was private and would now publish real addresses. The
reports here are schema and counts only; actual rows belong in the dashboard's D1 console.

⚠ **The branch dropdown matters** when using `--file`: the job checks out the ref it is dispatched
with, and these files live on `staging`.

### 3. Secrets for the staging environment (dashboard — `wrangler secret put` needs stdin)

Workers & Pages → **flextext-r2-worker-staging** → Settings → Variables and Secrets:

| Secret | Needed for | Note |
|---|---|---|
| `SERVER_HMAC_KEY` | everything (email lookup keys, at-rest encryption of email/TOTP/state) | any long random string, **chosen once** — changing it later orphans every row it keyed |
| `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` | Google sign-in | the same OAuth client as production is fine (see step 4) |
| `ALLOWED_RESEARCHERS` | auto-approving your test account | your email; otherwise the account signs in PENDING and can do nothing |
| `RELAY_SECRET` | `/drive` downloads only | must equal the client's `DEFAULT_RELAY_TOKEN` or every `/drive` call 401s |

Not needed for Phase A/B testing: `TURNSTILE_SECRET` (password signup + crowd only — Google sign-in
never checks it), `ESCROW_PUBLIC_KEY`/`ESCROW_PRIVATE_KEY` (password lane, absent from the shipped
client), `RESEND_API_KEY`/`RESET_FROM` (reset emails), `ALERT_EMAIL`.

### 3b. ⚠⚠ PRODUCTION's `SERVER_HMAC_KEY` CAN NEVER BE ROTATED (learned 2026-08-17)

Worth stating once, loudly, because the staging work involves pasting keys into dashboards and the
two fields sit next to each other. `SERVER_HMAC_KEY` is not just an HMAC key:

- `emailKey()` derives the `email_sha256` LOGIN LOOKUP from it (v1.js:134). Change it and no account
  can be found — every sign-in fails, and the unique index no longer matches anything.
- `encAtRest()` derives an AES-GCM key from its SHA-256 (v1.js:141), and that encrypts `email_enc`,
  `totp_secret_enc`, **`drive_refresh_enc`** and **`kr_server_enc`**. Change it and every stored
  Google Drive refresh token becomes undecryptable — no uploads, no downloads, for anyone — and for
  Google-lane accounts `kr_server_enc` holds Kr itself, so the metadata keys are simply lost.

So on production it is a one-way setting: rotating it is silent, total, and unrecoverable without a
planned re-encryption migration that does not exist. On STAGING it is free to rotate while the
database is empty, which is exactly why it should be rotated to a value of its own now.

### 4. Google OAuth — use a SEPARATE client for staging, do NOT rotate production's secret

Seth, 2026-08-17: the production client's secret was never saved and Google will not show it again.
The two options are to mint a new secret on the EXISTING client and apply it to both, or to create a
separate client for staging. **Create a separate client.**

⚠ The reason is bigger than sign-in: `GOOGLE_OAUTH_CLIENT_SECRET` is used on every
`driveAccessToken()` refresh (v1.js:358–367), which is the path behind every upload, download,
folder create, trash and purge — including FIELD DEVICE uploads, which route through the owning
researcher's refresh token. A production client secret that the worker does not match takes down all
Drive traffic for everyone, not just researcher logins. Rotating it is therefore a coordinated
production deploy, not a console click, and there is nothing to gain from it here.

- The production **client ID is still readable** in the console (only the secret is hidden), so
  nothing is lost by not knowing the secret — production keeps working with the secret it already
  has, unread.
- A new client in the SAME Google Cloud project inherits the project's consent screen, so no new
  verification work. (`drive.file` is a non-sensitive scope, and production's refresh tokens are not
  expiring weekly, which means the project is published rather than in Testing — the 7-day
  `invalid_grant` case the code already comments on.)
- Both values are visible at creation. Save BOTH to 1Password at that moment; the secret is
  unrecoverable afterwards, which is the whole reason this decision came up.
- Its only redirect URI is staging's:
  `https://flextext-r2-worker-staging.68mh29kgsd.workers.dev/v1/oauth/google/callback` — production's
  client is never touched.

Same principle as the distinct `SERVER_HMAC_KEY`: environments that share no secrets cannot leak
into one another, and a mistake in staging stays in staging.

### 4. One Google console entry (this is the step that silently breaks sign-in if skipped)

The worker derives its OAuth callback from the request host — `redirectUri = url.origin +
'/v1/oauth/google/callback'` (v1.js:958) — so the staging host must be registered or Google answers
`redirect_uri_mismatch`. In the Google Cloud console, on the SAME OAuth client, add to **Authorized
redirect URIs**:

```
https://flextext-r2-worker-staging.68mh29kgsd.workers.dev/v1/oauth/google/callback
```

(Keep the existing production entries. `flextext-r2-worker-staging.68mh29kgsd.workers.dev` is exactly
what the client's `STAGING_WORKER` points at — app.js:146.)

### 5. Deploy the staging worker

Actions → **"wrangler (one-off command)"** → `args`: `deploy --env staging`

⚠ NOT the "Worker deploy" button — that one has no `--env` and always deploys production. Read the
deploy warnings: wrangler prints the route-inheritance warning that caused the 2026-08-11
connect.flextext.app hijack, and `routes = []` is what prevents it.

### 6. Point a test browser at it

Open the staging researcher panel with `?devworker=staging` (persists per device; `?devworker=prod`
reverts). Expect a **completely empty account** — staging D1 shares nothing with production, which is
the point. Sign in, create one instance, enrol one test device; that is the fixture the phase gates
run against.

---

# PART V — PROPOSAL (awaiting Seth's review): migrate safely with NO staging worker or D1

> Seth, 2026-08-17: *"if there's a way to migrate safely WITHOUT creating a staging worker and
> staging D1, that would be amazing (but propose that as a plan, don't implement without my
> review)."*

**Short answer: yes for the risks that actually threaten field users, no for three named things.**
Everything below is verified to run in this container, offline, with no Cloudflare account access —
not proposed on faith.

## Tier 1 — a hermetic local rig (covers migrations, schema, and the compat gate)

Verified working here today:

- `npx wrangler d1 execute DB --local --file=…` applies schema + migrations to a Miniflare-local
  SQLite with no auth and no network. (Used to discover R2-6.)
- `node:sqlite` replays statement-wise and is already the engine of `test/worker-schema.test.mjs`.
- `npx wrangler dev --env staging --local` **boots the real worker in workerd against that local
  D1** — `GET /v1/researcher` answered `401` from the real `authResearcher`, i.e. the actual code
  path, not a mock.

What would be built on it (my work, roughly a day):

1. **`test/worker-seed.mjs`** — writes a realistic fixture set into the local D1: one researcher
   (Google lane), one instance, one approved install with a wrapped key, one invite, one crowd
   recorder.
2. **`test/worker-device-compat.probe.mjs`** — the Phase-gate deliverable already named in II.5,
   pointed at `http://127.0.0.1:8787`: claim → accept → poll → report → assignment fetch, using
   TODAY'S paths, headers (`x-fx-install`, `x-fx-secret`) and body shapes. It must pass
   byte-identically before and after every migration. Being local, it can run on every commit
   instead of once per release.
3. **`test/worker-migration-rehearsal.mjs`** — seed → snapshot → apply the split's migrations →
   re-run the probe → assert no row lost, no column dropped, no response changed.

This is the part that matters: **the failure mode that hurts field users is a migration or a
response-shape change, and all of it is reproducible locally.**

## Tier 2 — real data shapes, on your Mac only, never through Actions

Schema tests cannot catch data-shaped surprises (a duplicate `email_sha256` blocking a unique index,
a NOT NULL default meeting a table with rows, a row count that turns a loop into a timeout). The
rehearsal for that is a read-only export imported locally:

```
wrangler d1 export flextext-connectivity --remote --output prod.sql   # read-only on production
wrangler d1 execute DB --local --file=prod.sql                        # into the local rig
# then Tier 1's rehearsal + probe against real data shapes; delete prod.sql afterwards
```

⚠ **This must never run in a GitHub workflow.** The repo is public: job logs and artifacts are
public, and that export contains emails, encrypted Drive refresh tokens and every ciphertext blob.
Local machine, then delete. (Same thread as the secret-guard work.)

## Tier 3 — what local genuinely cannot cover

Small and specific, so the decision is informed rather than optimistic:

1. **Google OAuth round trip** — real consent screen, real redirect, a real refresh token; and
   **real Drive REST** (folder creation, streaming upload, trash/purge). R2-1's folder-parentage
   scoping is Drive-shaped work, so Phase C's Drive changes DO want a real backend eventually.
2. **Turnstile**, and the `SIGNUP_LIMIT` rate-limit binding (an `unsafe` binding, absent locally).
3. **Edge-real behaviour**: CORS from a genuine browser origin incl. the `originAllows` preview
   patterns, `--remote` D1 limits, and the deploy itself (route inheritance, per-env secrets).

## Recommendation

**Build Tier 1 now and treat it as the gate; do Tier 2 once, immediately before the Phase B backfill
touches production; keep the staging rig for Tier 3 only.** That makes PART IV a convenience rather
than a blocker — Phases A and B can be built, migrated and compat-gated with nothing but this repo —
and it leaves a permanent local harness the suite does not currently have, instead of a rig whose
secrets drift out of date between uses.

Not recommended: skipping a real backend for Phase C's Drive work. R2-1 is exactly the kind of change
that looks right against a stub and deletes an archive against the real API.


---

# PART VI — SETH'S ANSWERS AND THE NEW REQUIREMENTS (2026-08-17)

## VI.1 Decisions now CLOSED

- **II.D1 — E2EE policy line: client-driven re-wrap only.** Agreed. The worker never exercises its
  latent Kr access for migration; the comment "the worker can't unwrap" gets truer over time.
- **II.D2 — the project's Drive is the OWNER's Drive.** Agreed.
- **II.D3 — claim screen reads "«Project» — managed by «owner»"**, even when a member minted the
  link. Agreed.

### ⚠⚠ II.D7 — CLARIFIED, AND IT WAS NEVER A CONFLICT (Seth, 2026-08-20). READ THIS FIRST.

**The decision recorded below was never in tension with project scope. The RECORD over-specified it,
and the over-specification is what scoped "the largest single piece of Phase C".**

Asked directly whether *"blanket access to the project owner's Google Drive folder"* meant other
PROJECTS or other TEXTS within the same project, Seth: **"I meant other projects."**

So the requirement always was, and remains: **a member must not reach another project.** Project
scope satisfies it exactly — not as a compromise, as the thing that was asked for.

Seth, 2026-08-20, after being walked through what per-device scoping would and would not enforce:

> *"I'm really not sure how granular we need our access to be at this point beyond project scope.
> And if an owner researcher needs it to be more specific than that, all he or she has to do is just
> create a separate project for that scope. So yeah, I'm thinking let's not get device and text
> specific for access. Let's have the access be project specific (write access might be more
> specific and various settings the assistant can and can't change, but those are all worker and UI,
> etc issues within our app suite not drive permissions)."*

And: *"for Drive access, per project is good enough."*

| | what the record said | what was meant |
|---|---|---|
| Drive scope for a member | the member's **own grants** — named devices, named texts | **the project**, whole |
| Cross-project access | refused | **refused** — unchanged, and the actual requirement |
| Destructive routes (trash/purge) | scoped | **scoped** — R2-1, unchanged and still required |
| Finer separation than a project | more capability plumbing | **a separate project**, the mechanism that already exists and that Seth's own estate already uses (Fayu Text Corpus, Dani Dictionary) |

⚠ **THE LESSON, worth more than the correction.** One sentence — *"only to texts they've been given
access to"* — was read literally and became a per-text access model, which then justified per-device
filtering across ~13 Drive routes, a `drive_object` table keyed on `instance_id` and `doc_id`, and
*"texts they created themselves"* as an access case the data model could not express. None of that
was asked for. A requirement can be amplified by the act of writing it down carefully, and the
amplified version reads exactly like diligence. **When a recorded requirement implies a large
workstream, re-ask before scoping it** — the cost of the question is one sentence.

⚠ **THE BOUNDARY IS THE PROJECT SUBTREE — NOT THE ACCOUNT ROOT.** Seth, clarifying immediately
after: *"Or the root folder outside of projects shared with them… They shouldn't have access to the
parent folder, I mean, or other projects."*

So a member sees **the project folder(s) they belong to, and nothing above or beside them**. The
master folder ("FlexText Uploads") is itself off limits, not merely its other children. This is
stricter than "scope to the project" naively implemented, and it rules out the obvious shortcut:

⚠ **A member's estate listing must be ROOTED at their project folder, never at master.**
`driveListAll` and `buildDriveEstate` start from `driveMasterFolder` and walk down (v1.js:804 builds
`containerParents` from `masterId` + project ids). Filtering that result *after* the walk still means
the worker enumerated the whole account on the member's behalf, and one forgotten filter leaks it.
Root the walk instead.

**Two consequences that fall out of this, and both are better caught now than discovered:**

1. ⚠ **On a FLAT (unmigrated) estate a member can have no Drive access at all.** Device folders sit
   directly under master with no project folder to root at — which is exactly why `containerParents`
   carries `masterId` (v1.js:802-804). There is no subtree to scope to, so the honest answer is to
   refuse Drive access to members until that owner's estate is migrated. Fail-closed, and it says
   what to do about it.
2. ⚠ **Per-project "Unassigned" stops being tidiness and becomes REQUIRED.** R2-1 already noted the
   Unassigned folder *"must be created per project once folders are project-scoped"*. With this
   boundary it is load-bearing: an account-level Unassigned sits under master, OUTSIDE every project,
   so every finished text swept into it would vanish from a member's view the moment it was swept —
   and a member would watch texts disappear with no explanation. `targetFor` in `drive-unassign`
   already resolves each text's OWN project's Unassigned (v1.js:2959-2981), so the machinery exists;
   what matters is that nothing may fall back to an account-level one while members exist.

⚠ **AND THE OVER-SPECIFIED VERSION WAS UNBUILDABLE ANYWAY.** Drive is addressed by **file id**, and
this codebase deliberately does not treat parentage as an identity fact (VII.1). A per-device `see`
list was built on 2026-08-20 and **removed the same night**: the instance routes honoured it and the
rig proved they did, but no Drive route could, so it would have been a checkbox that SAYS a device is
hidden while it stays reachable through any docId-routed fetch. An owner relies on such a checkbox.
Two independent reasons to drop it, then — it was not wanted, and it could not have been made true.

⚠ **WHAT DOES NOT CHANGE, and must not be read away by this entry:**
1. **No account-wide access for members.** A member must never see, list, or touch another project's
   folders. The earlier decision's core sentence — *"We don't want them having blanket access to the
   project owner's Google Drive folder"* — is satisfied at the PROJECT boundary, not abandoned.
2. **The destructive half is not a disclosure question** (R2-1). `drive-purge` today takes no file
   list and empties the whole trash; `trash` takes an unverified id list. Disclosure is a fair
   answer to a member SEEING more than their project; it is not a fair answer to a member DELETING
   another project's archive.
3. **VII.1's mechanism finding still applies.** Project-level scoping still cannot be resolved by
   folder parentage, because `drive-unassign` re-parents texts into an account-wide Unassigned and
   folders are found by TAG, never by where they sit. Something like the `drive_object` table is
   still needed.

✅ **BUT IT GETS MATERIALLY SMALLER**, which speaks directly to Seth's stated worry that *"getting
into Google Drive access permissions may add layers of complexity that make it harder to implement
successfully and more failure-prone or less secure"*:
- `drive_object` needs `project_id` for authorization — `instance_id` / `doc_id` become display and
  provenance, not access control.
- No per-device filtering on ~13 routes; one project check per route.
- *"Texts they created themselves"* stops being an access case that must be expressible.
- ⚠ And Seth's fallback stands: *"If it turns out integration with Google Drive permissions and
  Google Drive visibility is too fiddly and won't actually float, then the priority is making the
  researcher panel side work and we can drop the Google Drive visibility integration if we need
  to."* Dropping it means members get NO Drive access — which is where the code already sits today
  (the account-wide routes are inert for members), so that fallback needs no work, only a decision.

### WORKING TOWARD: moving texts BETWEEN projects (Seth, 2026-08-20)

> *"We do want to keep at least in consideration a future plan to be able to move texts across
> projects as long as the person doing the move has access to both projects (and the owner should be
> able to allow or disallow permission to an invited researcher to transfer texts out of the project
> to other projects)."* And: *"Doesn't necessarily need to be implemented right now, but it is a
> feature we're working toward."*

Not built. Recorded because three things about it are cheap to note now and expensive to discover
during implementation.

**1. ⚠ It needs TWO grant resolutions, not one — and that is a shape, not a difficulty.** Every
capability so far is *may X do this inside project P*, and `authMember` resolves exactly one project
per call. A cross-project move is the first operation that is a relationship BETWEEN two projects:
it must resolve the SOURCE (with the transfer-out capability) and the DESTINATION (with the right to
receive) separately, then act. Two calls to the existing helper compose into that cleanly; trying to
express it as one resolution is the wrong turn, and the tempting one.

**2. ⚠ The capability is DIRECTIONAL, which is unusual here and easy to make symmetric by accident.**
Seth's phrasing is *"transfer texts OUT of the project"* — the source owner controls whether their
assistant may export work elsewhere. Receiving is governed by the destination's own capabilities.
A single `moveTexts` boolean checked on both ends would collapse that distinction and hand the
source owner's veto to the destination.

**3. ⚠ Cross-project is NOT the existing move.** `/v1/instances/<id>/texts/<docId>/move` moves a text
between DEVICES within one owner's estate (v1.js:3864), and `projects/assign` moves CONTAINERS, never
texts (v1.js:3195). Neither is this operation; both are useful precedent for the Drive mechanics
(re-parent by id, tokens name fileIds so nothing is orphaned).

**Open question to settle when it is built, not now:** Ki is per-instance and `member_key` grants are
per-project, so a text arriving in another project lands where the existing grants do not reach.
Today's `/move` sidesteps this by minting fresh Drive URLs from the OWNER's account rather than
re-wrapping keys — that may extend cleanly, or may not when the two projects have different owners.
Flagged as a question rather than assumed either way.

Nothing in Phase C forecloses it, and the per-project Unassigned that this section already requires
is a prerequisite either way.

### FUTURE, NOT NOW: recursive projects

Seth, 2026-08-20: *"Eventually we may consider having the ability for projects to be recursive — that
is to contain sub-projects AND devices as sisters. But that probably would introduce a whole new
level of complexity and entropy and redesign that might be more than we can handle right now. And
more than we need right now."*

Recorded because **nothing in Phase C forecloses it**, which is worth knowing before anyone designs
around its absence: `parent_project_id` is an additive column (R2-6 permits it), and because
authorization resolves in exactly one function (`authMember`), recursion would mean teaching that
one function to walk a parent chain — not revisiting every route. That is a direct dividend of the
one-authority invariant (I1). Do not build it; do not design against it either.

### II.D7 — the EARLIER record (⚠ over-specified — read the entry above first)


> Seth: *"We do want to make sure that invited/assistant researchers can only see/access what
> they're given access to. We don't want them having blanket access to the project owner's Google
> Drive folder, only to texts they've been given access to (or created themselves if they're allowed
> to do that)."*

⚠ **THE PARAGRAPH BELOW IS THE OVER-SPECIFICATION ITSELF — kept verbatim as the artefact it is, not
as a live requirement.** Seth confirmed on 2026-08-20 that he meant other PROJECTS. Read it as
history; the entry above is the decision.

This **overrides Part III round 1's "accept + disclose"** and goes beyond R2-1's project-level fix:
Drive access is scoped to the member's OWN GRANTS, not to the project, and never to the account.
Concretely, every Drive route becomes grant-scoped:

- **Estate listing** is filtered to the folders of devices in the member's `see` list (plus texts
  they created), never `driveListAll` over the account.
- **Any docId-routed fetch** is parentage-verified against that same set before a byte is served —
  filtering the listing alone is cosmetic if a direct id still works.
- **Trash and purge** are restricted to that set, and purge takes an explicit id list (today it takes
  none at all and empties the whole trash — R2-1).
- **Uploads** still land in the owner's Drive (II.D2) but only inside a device folder the member is
  allowed to touch.

⚠ Cost, stated plainly: this is the largest single piece of Phase C. The current Drive helpers have
no project dimension *and* no per-device dimension, so this is new filtering on ~13 routes plus the
storage-manager UI, and it needs the real Drive API to test (PART V Tier 3).

## VI.2 II.D6 in plain language — three knobs, not a design

Seth: *"I would like to understand better D6."* It is only this: a "session" is one browser signed
in to the researcher panel. Multi-device means several at once, so three questions get numbers.

| Knob | What it means in practice | Proposed |
|---|---|---|
| **How many at once** | Sign in on a 6th browser and the oldest one is signed out automatically | **5** |
| **How long a browser stays signed in** | Unused for this long → it must sign in again; each use pushes the clock forward | **90 days, sliding** |
| **How you hear about a new sign-in** | A banner appears in your OTHER open panels: "new sign-in from «browser» at «time»" | **banner only** — there is no email path for this today, and none is being added |

All three are just defaults to accept or change; none affects field devices, which do not have
sessions at all. The account modal also gets a session list with "sign out this one" and "sign out
all others", which is the part that makes the cap safe rather than annoying.

## VI.2b II.D6 — the RECOMMENDATION, refined (2026-08-17)

Seth: *"What are your recommendations? … I think you know best security practices better than I do."*
Two of the three proposals stand; one changes, and one earlier claim was simply wrong.

**The threat model this is actually defending against.** A researcher panel session is high value —
it reaches every device inventory, every text, and the project's whole Drive estate. But the
realistic attack is not remote credential-stuffing: Google-lane accounts have no password to stuff.
It is **physical**: a borrowed or shared computer left signed in, a stolen laptop, malware on a
machine. That shapes every answer below.

1. **Cap: keep 5, with oldest-out eviction.** A cap is not much of an attack control — eviction is
   oldest-first, so an intruder's new session silently pushes out the victim's oldest, which reads
   as "I got randomly signed out" rather than "someone got in". Its real value is bounding forgotten
   sessions and keeping the list short enough to actually read. ⚠ Do NOT instead refuse the 6th
   sign-in: that locks someone out of their new browser with the revoke button sitting inside the
   session they cannot reach.

2. **Expiry: CHANGED — tie it to the user's own "stay signed in" choice** rather than one number.
   - **Unchecked** ("this is a borrowed/shared machine", which is what that box already means) →
     **24 hours** server-side. The client already keeps the token in sessionStorage here, so it dies
     at browser close anyway; the 24-hour server cap closes the gap where the token was copied out
     of a machine that is not theirs.
   - **Checked** ("this is my machine") → **90 days, sliding.**

   This is strictly better than a single number because it maps the control onto a statement the
   user has already made, and needs no explanation in the UI. Part I said `staySignedIn` governs
   only the CLIENT's storage and not the server expiry; that is the line being revised.

3. **Notification: email AND banner — and the earlier "no email path exists" was WRONG.** Resend is
   already wired in this worker: `sendEmail()` for password resets (v1.js:231–237) and `secAlert()`
   to `ALERT_EMAIL` (seclog.js:72–90). So the infrastructure is there and needs no new dependency.

   A new-sign-in email is the one control that reaches the owner when **no panel is open**, which is
   exactly when an intruder would sign in — a banner cannot, by construction. Volume is tiny (a
   handful a year against a cap of 5), it goes to `drive_email` which is already on the row for
   Google-lane accounts, and Seth's own point applies: *"the researcher panel is likely to have at
   least marginally more reliable internet access than the editor and recorder"* — so unlike the
   field apps, these users will actually receive it. Keep the banner too; it is the faster signal
   when a panel IS open.

**Two more that matter more than the numbers, added on the same reasoning:**

- ⚠ **Do NOT bind sessions to an IP address.** It is the obvious hardening and it is wrong here:
  mobile and village connectivity changes IP constantly, so binding produces spurious sign-outs at
  the worst moments and teaches people to ignore them. Record an IP HASH for display in the session
  list if useful (`secLog` already hashes one) — display, never enforcement.
- **Strip the OAuth token from the URL fragment on receipt** (`history.replaceState`), already noted
  as round-1 finding 9c. Cheap, and it matters slightly more once a token has a longer life.
- Session create / revoke / evict all go through `secLog`, so there is a server-side trail
  independent of the rows themselves.

## VI.2c Sign-in and project-access notifications (Seth, 2026-08-17) — D6 extended

> *"We should have e-mails notifying a researcher whenever someone has signed into their account
> with as many details as possible about the client/location/etc without requesting location
> permissions, etc. And also optionally notification about when projects they own are being accessed
> by other researchers (just log in and open)."*

Accepted. Two notices, one mandatory and one opt-in, both sent through the Resend path that already
exists (`sendEmail`, v1.js:231–237; `secAlert`, seclog.js:72–90) — no new dependency.

### A. NEW SIGN-IN on your own account (always on)

Fires when a `session` row is created. Everything in it comes from the request itself, so **no
browser permission is ever requested** — the constraint Seth set is satisfied by construction, since
none of this is asked of the client:

| Detail | Source | Note |
|---|---|---|
| Approximate location | `request.cf.country`, and `city` / `region` / `timezone` where populated | Cloudflare's edge geo. `country` is already used (v1.js:2609); the finer fields must be **verified populated in practice, not assumed** |
| Network | `request.cf.asOrganization` | "Telkomsel", "Starlink" — often the most recognisable detail of all |
| Device / browser | `User-Agent`, reduced to a label ("Chrome on Windows") | ⚠ client-controlled and increasingly redacted by UA-CH; treat as a hint, never as evidence |
| Time | server clock | in the account's timezone if known, else UTC |
| IP address | `CF-Connecting-IP` | see the decision below |

**⚠ Decision — the IP address.** Today the codebase deliberately only ever HASHES it (`ipHash`).
A hash is useless in a notice: "someone signed in, ip 9f3a…" tells the owner nothing. Recommendation:
**put the full IP in the EMAIL to the account owner (their own activity, and the single most
recognisable detail), while the session row and `secLog` keep storing only the hash.** Useful notice,
no new PII at rest. If Seth prefers, the email can carry city + network only and drop the IP entirely.

**⚠ The honest limit, which must not be papered over:** this email goes to the researcher's Google
address — often the very account an attacker would have had to compromise to sign in at all. So it
is the best available detection and still not sufficient on its own. That is exactly why the in-panel
banner and the revocable session list stay in the design rather than being replaced by email.

Rate-limit and coalesce (an attacker cannot trigger these without the victim's Google credentials, so
the risk is nuisance rather than attack), and send via `waitUntil` so a mail failure can never block
or fail a sign-in — the pattern `secAlert` already uses.

### A.1 ⚠ Does the existing approval alert prove we can send these? PARTLY — and the gap matters

Seth, 2026-08-17: *"We already have automatic notifications to me for new users pending approval. I
feel like that probably exposes whatever permissions or privileges this new notification would
need."* Checked. It proves **two of the three things** required, and the missing one is the one that
decides whether the feature works at all.

**Proven by those alerts arriving:** the `RESEND_API_KEY` is valid, and the `from` address
(`RESET_FROM`, defaulting to `FlexText <noreply@flextext.app>`) is accepted by Resend. Both email
paths use the identical fetch and the identical `from` (v1.js:230–247; seclog.js:72–107).

**NOT proven — sending to a THIRD PARTY.** `secAlert` sends to `env.ALERT_EMAIL`: one fixed address,
Seth's own. Resend restricts an **unverified sending domain** to the account owner's own address; a
verified domain can send anywhere. So every alert that has ever arrived is consistent with the domain
being unverified. A sign-in notice goes to each researcher's own address — a third party by that
rule — so the approval alerts cannot demonstrate it.

The one path that WOULD prove it is the password reset (`sendResetEmail`, arbitrary recipient), and
it has almost certainly never fired in anger: the password lane is absent from the shipped client
entirely (no `authSecret` anywhere in `docs/js/`).

**How to settle it in a minute, no code:** Resend dashboard → Domains → is `flextext.app` verified? If
yes, nothing to do. If not, it is a few DKIM/SPF records on a zone Seth already controls — the
`flextext.app` zone lives in the same Cloudflare account as the worker (worker/wrangler.toml), so
both halves are already in hand. Afterwards, send one test to a NON-`ALERT_EMAIL` address and check
it lands in the inbox rather than spam: a security notice that is filtered is worse than absent,
because its silence reads as safety.

### A.2 ⚠ A live bug found while checking: a failed reset email is INVISIBLE

`secAlert` carries a hard-won comment — *"LOG THE OUTCOME, NOT THE ATTEMPT … a monitoring system that
lies about its own delivery is worse than none"* — and logs `alert_sent` / `alert_failed` with
Resend's own status and body. **`sendResetEmail` never got that fix**, and its call site discards the
return value entirely (`await sendResetEmail(env, to, …)`, v1.js:1229). So a rejected reset email —
unverified domain, bad key, Resend down — produces no log line, no alert, and the endpoint still
answers its deliberate "if that account exists, we sent a link". Nobody would ever learn.

**Therefore the sign-in notice must NOT become a third copy of that fetch.** One
`sendEmail(env, ctx, { to, subject, html, event })` helper that sends AND logs the outcome, with all
three callers using it — the reset path gaining the logging it never had. This is the suite's own
"generalize on the second use" rule arriving on the third.

### B. PROJECT ACCESSED by another researcher (opt-in per project, owner-facing)

Fires for the project OWNER when a MEMBER touches their project. Two events, per Seth: the member
signing in, and the member opening the project.

**⚠ The design constraint that decides the whole feature: "opens the project" cannot mean "makes a
project-scoped request".** The panel polls every few seconds, so that would be hundreds of emails a
day and the feature would be turned off within an hour. **One notice per (member, project, SESSION)
— the first access inside a session** — which naturally bounds it to at most the session cap (5) per
member per expiry window. A daily digest is the alternative if even that proves noisy.

- Opt-in per project, owner-controlled, default OFF.
- Same detail set as (A), for the member's request.
- ⚠ **Disclose it to the member.** This is access logging of a colleague; it belongs in the invite /
  trust dialog alongside the other things the owner can see, both because it is fair and because an
  undisclosed access log discovered later poisons the working relationship the feature exists to
  support. It fits the two-category trust warning already designed in Part I.

### Implementation notes

- Both notices are per-EVENT, not per-request: (A) hangs off session creation, (B) off a
  `session × project` first-touch marker. Neither belongs in the poll path.
- Reuse `logApproval` / `secLog` so the same facts land in the server-side trail, not only in an
  inbox that can be deleted.
- The session list in the account modal shows the same fields, so the owner can audit after the
  fact even if an email was missed.

## VI.2d Pending state is PROJECT-level, and cancelling someone else's action is a capability

> Seth, 2026-08-18: *"Once our projects and researchers split is ready, we need it to be a
> project-level pending thing that all researcher browsers connected can pick up."* And: *"(And also
> have the ability to cancel an action initiated by the owner be a permission that the owner can
> disable)."*

**A. Project-level pending — mostly falls out, with one honest gate.** The pending indicator built in
v386/v387 is derived from SERVER state (desired_rev vs ack_seq, then the instance's outstanding
commands) rather than from any browser's localStorage, so it already generalises from "this account's
browsers" to "everyone who can see this device" the moment membership exists. Nothing about the
derivation is account-scoped.

⚠ The gate is the one the whole design rests on: the command payload is ENCRYPTED under Ki, so a
member can only read pending work for a device whose Ki they hold. That is `see` doing its job — a
member who cannot see a device cannot see its pending commands either, and that is correct rather
than a shortfall. It does mean the panel must render "something is pending here" from the un-encrypted
facts (desired_rev vs ack_seq, both plaintext) even when it cannot say WHAT, for a device the viewer
can list but not decrypt. Decide that presentation when Phase C's filtering lands.

**B. `cancelOthers` — a new capability for the table.** Today the panel offers a cancel whenever
`seq > maxAck`, on the reasoning that the device has not taken the command yet. With several
researchers on one project that becomes "an assistant can withdraw the owner's instruction", which
the owner should be able to switch off. Add to the caps in Part I:

| Capability | Meaning | Default |
|---|---|---|
| `cancelOthers` | may cancel a queued command **issued by someone else** (the owner's included) | OFF |

Cancelling one's OWN queued command stays ungated — that is undo, not authority. Worker-enforced like
every other DO capability: the cancel endpoint learns who issued the command, which means the command
record must carry its issuer. ⚠ **That is a schema note, not a UI note** — commands live in
`instance.desired_blob` and currently record no author, so Phase C must add one when it writes them,
or `cancelOthers` cannot be enforced at all.

## VI.3 II.D5 REOPENED AND EXPANDED — transfer, deletion, and the panic button

> Seth: *"We need an option for an owner to transfer ownership to another researcher (which in an
> ideal world … would involve transferring Google Drive folder ownership and location to that new
> owner's Google Drive) … if a researcher tries to delete a project or their account our app needs
> to ask them what to do with existing projects, recommend transfer ownership, but deleting them and
> unlinking or wiping all paired devices is also an option. Some of our researchers may need the
> nuclear option available quickly and easily if they're working in more hostile contexts."*

Three features, in increasing difficulty. **The first is easy, the second is the hard one, and the
third is mostly already built.**

### (a) Transfer the PROJECT — straightforward

Reassign `project.owner_id`, move the `member_key` grants so the new owner holds every Ki, and
update the maintained `instance.researcher_id` denormalization (round-1 finding 4) in the same
transaction so old APKs' joins stay correct.

⚠ **Ordering that cannot be fixed later: the OLD owner must perform the key re-wrap while they can
still decrypt.** Under client-driven re-wrap (II.D1) the server cannot do it for them, so a transfer
attempted after the old owner has lost access is impossible — the devices would have to be re-keyed
from scratch. The UI must therefore treat transfer as an action the old owner *completes*, not a
request the new owner accepts later.

### (b) Transfer the GOOGLE DRIVE estate — the hard part, do NOT promise it in UI copy yet

Three mechanisms, honestly ranked:

1. **Share with the new owner** — trivial, but the files stay in the old owner's Drive, on their
   quota, still readable by them. That is not a handover; it is co-access. Fine as a stopgap, wrong
   as the headline.
2. **Copy into the new owner's Drive** — the new owner's panel re-creates the folder tree and copies
   the files, then the old copies are deleted once verified. Costs bandwidth and the new owner's
   quota, and every `oauth_folder_id` / `driveFolderId` must be re-stamped because ids change. This
   is the mechanism most likely to actually work under the `drive.file` scope, since the app can act
   on files it created.
3. **True Drive ownership transfer** (`permissions` with `transferOwnership=true`) — the ideal, but
   constrained: the recipient must accept, consumer (non-Workspace) accounts have limits, and it is
   NOT verified that `drive.file` scope permits it at all. **Research item — verify against the live
   API before it appears in any dialog.**

**Recommendation: ship (a) + mechanism 2, and keep 3 as an investigation.** Say what actually
happens in the dialog ("the files are copied into their Drive and removed from yours") rather than
"ownership transferred", which we cannot yet guarantee.

### (c) Deletion must ASK — and the panic button is mostly assembled already

**On delete of a project or an account:** enumerate what the researcher owns, recommend transfer,
and offer per-project: transfer / delete-and-unlink devices / delete-and-WIPE devices.

**The nuclear option is an orchestration of primitives that already exist** — this is the good news:

| Piece | Already there |
|---|---|
| Remote wipe of a device | `POST …/wipe` sets a sticky `wipe_state='requested'`, with TOTP step-up when 2FA is on (v1.js:2099–2117) |
| Delivery to any device state | the wipe directive is checked BEFORE the cursor/pending/key gates, so it lands even on a device that was never keyed (v1.js:2338) |
| Proof it happened | the device acks before erasing (`wipe-ack`, v1.js:2121–2126) |
| Server-side erasure | the account cascade over instances, installs, invites, crowd rows (v1.js:2754–2762) |
| Drive erasure | trash (v1.js:1478) + permanent purge (v1.js:1430) |
| Local erasure | `?devreset` wipes the origin's settings, docs, service worker and caches |

So the feature is ONE guarded action that fans out: flag wipe on every install in every owned
project → trash + purge the project's Drive files → delete the server rows → wipe this browser.

⚠ **The ordering trap, and it is the whole feature:** deleting the account first removes the
credentials that command the devices, leaving them unreachable and therefore unwipeable, forever.
**Wipe first, confirm acks, delete last.** A panic flow that gets this backwards is worse than none,
because it looks like it worked.

⚠ **What it cannot promise, and the copy must say so:**
- A device only wipes **when it next connects**. Offline or seized-and-airplaned devices stay intact
  until then — though the flag is sticky, so it fires whenever they do reappear.
- Purge removes the files from Drive; Google may retain server-side copies for a period, and
  anything already downloaded, synced or shared elsewhere cannot be recalled.
- Guarded by a typed confirmation (the erase-data pattern) plus the existing TOTP step-up: fast to
  reach, hard to hit by accident.
- ⚠ Worth naming once: in a genuinely hostile context a one-touch erase is also a liability for
  someone compelled to unlock the app. Solving duress is out of scope here; being aware of it should
  shape the wording, not add a feature.

## VI.4 Mirroring production into staging — what is safe, and what must never be copied

> Seth: *"have a path to make it basically mirror production exactly before we make and test
> modifications to it. And have that be our normal workflow. Have actions or wrangler scripts … to
> overwrite our staging worker and staging D1 database with a copy of production."*

**Two of the three parts are right and should be automated. The third is the one thing that must not
be done.**

- ✅ **The CODE already mirrors exactly.** `deploy --env staging` from the same commit deploys the
  same worker bundle; only bindings and secrets differ, and that difference is the safety property.
- ✅ **The SCHEMA can now be mirrored in one shot.** `worker/schema-current.sql` (new) is a canonical
  generated CREATE-only file, verified equal to production's live schema and guarded against drift by
  `test/worker-schema.test.mjs`. The historical files cannot do this — schema.sql is folded forward,
  `--file` is atomic, and the `instance` rebuild drops later columns. That combination is exactly how
  the staging D1 drifted.
- ❌ **The DATA must NOT be copied, and the reason is not squeamishness.** At-rest encryption is
  keyed by `SERVER_HMAC_KEY`, so there are only two outcomes:
  1. **Staging has a different key** → `email_enc`, `totp_secret_enc`, `drive_refresh_enc` and
     `kr_server_enc` are all undecryptable. The copy is inert — you get rows you cannot log in as,
     accounts whose Drive cannot be reached, a fixture that tests nothing.
  2. **Staging shares production's key** → staging becomes a second production. It can decrypt real
     researchers' emails and holds LIVE Google Drive refresh tokens, while its `ALLOWED_ORIGINS`
     deliberately admits every feature-branch preview alias. That is a strictly worse-protected copy
     of the most sensitive data in the system, sitting behind the door we open most often.

  There is a third, quieter cost: with real rows in staging, a test action (assign, revoke, wipe,
  purge) can reach a REAL device or a REAL Drive folder. Test databases exist so that cannot happen.

**So the workflow he wants, in the form that is safe** — reset staging to production's SHAPE plus a
synthetic seed, before each cycle:

1. `d1 execute flextext-connectivity-staging --remote --file=schema-current.sql` — fresh shape,
   atomic, no ALTERs, no rebuilds, a no-op against tables that already exist.
2. `--file=seed-staging.sql` (to be written) — synthetic fixtures shaped like production: one
   researcher, one instance, one approved install with a wrapped key, one invite, one crowd recorder.
   Row SHAPES are what tests need; real values are what they must not have.
3. `--file=schema-report.sql` against both databases + `node test/worker-schema.test.mjs` — proof
   they match, which is the property "mirror production exactly" was really asking for.
4. `deploy --env staging` from the commit under test.

All four run through the existing "wrangler (one-off command)" workflow, so no local wrangler and no
new billable machinery. If the reset should also CLEAR stale test rows, that wants an explicit
`reset-staging.sql` with `DELETE FROM` per table — deliberately separate from the schema file, and
deliberately never pointed at production. **Proposed; not built** — say the word.

---

# PART VII — audit round 3: the worker + this plan, before Phase C starts (2026-08-18)

Run against the worker and this document together, adversarially verified (five claims refuted, most
of the rest narrowed). **Verdict: Phase C is safe to start.** Nothing here is a redesign. What
follows is what must land first, what must be built INTO Phase C, and what is merely live-and-small.

## VII.1 — R2-1 / II.D7 specify the WRONG Drive-scoping mechanism ⚠ SPEC FIX, DO THIS FIRST

R2-1 and II.D7 scope Phase C's largest workstream as *"resolve device folders from
`instance.oauth_folder_id WHERE project_id=?`, then verify each file's parent is in that set."*
**This codebase deliberately does not maintain parentage as an identity fact:**

- `driveEnsureTextFolder`'s own header says the `flextextDoc` tag search is deliberately NOT
  parent-scoped, so a researcher-moved folder keeps receiving uploads;
- `buildDriveEstate` identifies text folders by tag, *"never by where they sit"*;
- `drive-unassign` **re-parents** finished texts into an account-wide "Unassigned" folder belonging
  to no device;
- `GET /v1/instances/<id>/texts/<docId>/files` already resolves a text folder purely by tag and
  never checks it sits under the named instance.

Build to the spec as written and an assistant with Drive read loses exactly the texts the owner
swept, and any hand-filed folder is denied. It fails **closed**, so it is a wrong mechanism rather
than a hole — but it is the mechanism the whole Drive workstream is scoped around.

**Replacement:** move Drive authorization into D1. One additive table — `drive_object(file_or_folder_id
PK, kind, doc_id, instance_id, project_id, created_by_researcher_id, created_at)` — stamped when the
worker creates each device/text/originals folder and each uploaded file, authorized by one indexed
lookup. Parentage becomes display only. Two things to write down rather than discover: it starts
EMPTY against the existing estate and needs a one-time idempotent backfill from `driveListAll` (same
operator-gated pattern as `backfill-projects`) or every pre-existing file is denied on day one; and
it persists a `doc_id ↔ instance_id` map in D1 plaintext — consistent with II.0.7's plaintext tier,
but record it as a deliberate widening. Bonus: `created_by` makes *"texts they created themselves"*
expressible, which nothing in the current model can express at all.

## VII.2 — R2-4 had a second, unnamed exception, and it failed OPEN ✅ FIXED

`POST /v1/instances/<id>/revoke` was a two-statement D1 batch in which only the first carried
`AND researcher_id=?`; the second was a bare `UPDATE install SET revoked=1 WHERE instance_id=?`.
A D1 batch is sequential, not conditional, so it landed regardless, and the route answered `ok:true`.
Knowing an instance GUID was enough to unlink every install of another researcher's instance: the
device's next poll takes a 410 and auto-releases mid-assignment.

R2-4 asserts every instance/install/crowd ownership check is a fail-CLOSED filter and names the
account self-delete cascade as *the* exception — the staged endpoint-conversion argument rests on
that. **This was a second exception, and R2-4 should be read as amended.** Unguessable ids were the
only barrier; under Phase C every member legitimately sees those ids, so a see-only member with no
capability would have gained a device-unlinking primitive on day one.

Fixed to match its own sibling (`installs/<iid>/revoke`): resolve ownership, 404 on a miss, then
write. Backend-only, no client change, re-revoking still returns 200. Pinned by
`test/worker-ownership-scoping.test.mjs`. **Committed, not deployed** — rides the next worker deploy
with R2-2.

## VII.3 — build INTO Phase C

- **Finish Phase B first, in the same deploy as the backfill.** `backfillProjectsFor()` is the ONLY
  writer of `project_id`; `POST /v1/instances` and `POST /v1/crowd` insert without it and neither
  signup path mints a project. So the moment the sweep finishes, every new device and researcher is
  permanently project-less. It bites Phase B's CLIENT half now: `member_key.project_id` is
  `TEXT NOT NULL`, so the keys route's `{project_id: null}` fallback throws on the bind and 500s —
  the self-grant never lands and the owner limps on the legacy `wrappedKis` path Phase B exists to
  retire. Fails closed and loudly, so it is not a hole. Stamp `project_id` at creation, mint the
  default project in both signup paths, and replace the NULL fallback with a named refusal.
  ⚠ `test/worker-projects.test.mjs` creates its instance BEFORE the backfill, so that branch has
  zero coverage.
- **Minted `/v1/textfile` URLs are unscoped at mint and unrevocable at serve.** The payload is
  `{r,f,x,e}`; serving checks only that it decrypts, has not expired, and the named researcher still
  has a refresh token. The file id comes straight from the request body at all three mint sites, and
  II.D7 read literally covers docId-routed fetches but not ids arriving in a body — implement it as
  written and destruction and listing close while READ stays open. Put the scope INTO the token
  (owner, project, instance, doc, granting member, jti), re-check against live D1 at serve, and clamp
  member-minted TTLs well below the 400 days `clampTtlDays` allows.
- **`settings_blob.moves` is project state in a per-account row.** II.4 lists the settings blob among
  the binds that stay account-scoped and VI.2d says pending state is server-derived; both were true
  when written, and v388–v391 then put the in-flight move ledger in `settings_blob` under the
  researcher's own Kr. Members never hold Kr, so a member's `getMoves()` reads an empty map *by
  construction* — a member sees a live Move button on a text already moving, and an owner-started
  move stalls whenever only members are online. ⚠ Do NOT fix this with a project-wide blob under a
  shared key: a move record carries the text TITLE plus both instance ids, which leaks texts on
  devices a member's `see` excludes. Put it per-INSTANCE under Ki (any actor entitled to move a text
  already holds both endpoints' Ki), or make it server-derived.
- **The key-grant ledger has no lifecycle.** The delete-to-revoke contract is stated four times and
  implemented nowhere — no `DELETE FROM member_key` exists — and `GET /v1/researcher/keys` has no
  membership predicate, so a member narrowed from `see:all` to `[i1]` can still fetch `i2`'s key they
  never previously held. That is key DELIVERY after revocation, which is the one thing revocation
  actually promises. Build removal as ONE owner-only batch, and add the membership join to the read.
  (Keys already fetched are un-knowable regardless — Phase E rotation, already documented.)
- **Freeze `member_key.key_version` now, while the endpoint is deployed to no database.** It comes
  from `body.key_version||1` with `INSERT OR REPLACE`, no server allocation, no CAS. Once rotation
  ships, any client predating it resolves Ki via `ORDER BY key_version DESC`, gets v2, then
  self-grants with the version omitted — writing v2 ciphertext into the v1 slot and destroying the
  only stored copy of the v1 generation, which is exactly what the column exists to prevent.
  Server-allocate it (or CAS on a client `base_version`), while still REPLACING on an exact
  re-submit, because `test/worker-projects.test.mjs` asserts that retry-idempotency.
- **Rotation eats and ACKs commands queued under the old Ki — amend II.0.1, no code change.**
  `sync.js` obtains the new key BEFORE the command loop, and the loop's catch does
  `ackSeq = max(ackSeq, c.seq); continue` — drop AND ack. Acked commands are never pruned, and R2-2
  delivers the new key in the SAME poll body as the stale commands, so a destroyed assignment renders
  as *completed* and cancel then refuses `already_delivered`. II.0.1's "key rotation is already
  safe" needs qualifying. The remedy is ORDER, written into the plan: cancel every unacked command,
  re-key ALL installs, then re-push under Ki_new. Add `install.key_version` (additive) so the panel
  can refuse to issue commands to a partially re-keyed instance.
- **Make `driveEnsureTextFolder` the single write-side chokepoint** before members can drive it: give
  it an allowed-parents argument so the echoed folder id and the tag search are hints, not authority.
  ⚠ KEEP the `files.get`-by-id echo — replacing it with a parent-scoped search runs on the
  eventually-consistent index and re-opens the v167 duplicate-folder bug.

## VII.4 — live now, small, unrelated to Phase C

- **`ack_seq` can move BACKWARDS.** `authInstall()` SELECTs the row, then — after an `await
  readJson()` that streams an encrypted inventory over a slow uplink — the handler writes
  `SET ack_seq=?` with a JS `Math.max` against that earlier read. Two overlapping reports from one
  install last-writer-wins on a column every comment and `test/command-seq-invariant.test.mjs`
  assume can only rise; `reportNow()` is explicitly not gated by `sync.js`'s `inFlight`, so the race
  is reachable. Fix in SQL: `ack_seq=MAX(ack_seq, ?)`. Worker-only, no migration, safe against every
  deployed client.
- **`POST /v1/researcher/trash` can blow the subrequest cap.** It accepts 100 ids and issues 100
  sequential Drive PATCHes against the same ~50-subrequest free-plan cap that killed `drive-purge`
  twice — and the failure is a runtime error the try/catch cannot catch. Reachable today from the
  panel's backup cleanup on a text with ~49+ older backups. Give it `drive-purge`'s wave/cap/budget
  treatment and return a resumable partial result.

## VII.5 — checked and found sound

`authInstall` binds the secret to the exact `(install_id, instance_id, revoked=0)` triple. Every
researcher-lane `installs/*` route resolves ownership through a JOIN and 404s on a miss, so an
unconverted endpoint means "members cannot do that yet", never a leak. The session lane: eviction
runs after the insert so the signing-in browser is never evicted, expired-but-unrevoked rows are
consumed first, and the Google callback rotates `secret_hash` on every sign-in — which does close
round-1's legacy skeleton-key concern. The core Phase C crypto question — can a device's Ki reach a
member without the owner handing over Kr — is sound: the owner unwraps under Kr locally and re-wraps
RSA-OAEP to the member's pubkey, and the worker stores a blob it cannot open. The chunk-relay and
token layer: route-distinct ownership keys, mutually non-satisfying payload shapes, server-authoritative
TTL clamping. `drive.file` scope genuinely bounds the whole Drive lane to app-created files, which is
what keeps every Drive finding above an intra-FlexText-estate problem. Command append and cancel share
a correct `desired_rev` CAS loop, and the invite claim's prior-install revoke is properly guarded on
having won the claim.
