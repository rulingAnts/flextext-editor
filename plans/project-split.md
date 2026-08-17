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
