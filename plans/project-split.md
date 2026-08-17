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

## Decision points for Seth (running list)

- ~~Who can mint pairing invites?~~ → **owner-controlled per member** (`createInvites`), per the
  granular-permissions spec above.
- Whose Drive holds a shared project's uploads — presumably the OWNER's; member Drive access then
  routes through the owner's refresh token server-side. Confirm, incl. the privacy implication.
- Member removal semantics: immediate API cutoff + no future keys (stated above) — confirm wording.
- Session guard tuning: cap count, expiry length, where the new-sign-in notice surfaces (panel
  banner vs email).

*(Design continues below once the code-facts mapping lands.)*
