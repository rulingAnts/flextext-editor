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

### II.D7 — DECIDED, and STRICTER than the earlier recommendation

> Seth: *"We do want to make sure that invited/assistant researchers can only see/access what
> they're given access to. We don't want them having blanket access to the project owner's Google
> Drive folder, only to texts they've been given access to (or created themselves if they're allowed
> to do that)."*

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
