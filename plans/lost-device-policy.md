# Lost-or-stolen device policy — design (Seth, 2026-08-24)

Status: **DESIGN COMPLETE, not built.** Captured from a live design conversation so the intent
survives. All decisions resolved (see the Decisions section). Nothing here is coded yet.

## ⚠ THE CORE ARCHITECTURE: trigger and action are TWO INDEPENDENT SETTINGS (Seth)

*"What triggers a 'lost/stolen' status and what happens when that status is triggered should be two
separate and independent settings."* Do not fuse them. There are two axes, chosen independently:

- **TRIGGER — what marks a device lost/stolen:**
  - the researcher flags it manually in the panel (always available); AND/OR
  - an **offline-time trigger**: the device has gone longer than a set time without a login.
    **OFF by default.** For contexts where the connection is reliable but the stakes and risk are
    higher, a researcher may want a hair-trigger that flags — and can go straight to wiping — after N
    time offline.
- **ACTION — what happens once triggered:** the immediate lock/encrypt/quarantine (below), then the
  wipe policy (preserve-then-wipe vs privacy-first).

⚠ **The offline-timer self-wipe lives on BOTH sides**, and that is what makes it work when the device
is unreachable: the researcher panel can send the wipe request when it can reach the device, OR **the
editor self-wipes locally when its allotted offline time has elapsed without a login** — no server
contact needed. This is the one mechanism that reaches a device that never reconnects, and it
partially answers the honest limit below: a seized device that stays dark still wipes itself when its
own clock runs out. (It does NOT defeat someone who pulls the storage before the timer fires — that
stays the casual-holder bar.)

> ⚠ FRAMING (repo rule, enforced by test/threat-language.test.mjs): describe what this PROTECTS —
> the texts and consent records on a device **that has left the team's hands** — never speculate in
> writing about who or what it protects against. This suite holds the language, voices and consent
> records of indigenous communities; this feature honours the obligation to keep those safe on a
> device no longer in trusted hands. That is the whole and accurate description.

## Two separate problems — do not conflate them

| | Field device (editor / recorder) | Researcher-panel login |
|---|---|---|
| Normal state | Offline for weeks/months is EXPECTED; must auto-upload on return | Online whenever in use |
| Offline tolerance | **Must never be cut off for being offline** — only a human flag changes its treatment | Does not need to be reliably offline |
| Strictness | Preserve-leaning; the bigger field hazard is a legitimate user locked out and unable to sign back in | Can be a lot tighter — short-lived, easy to kill from anywhere |
| This doc | Covers this half | Its own smaller task (shorten session TTL, one-click "sign out everywhere") — deferred until Seth wants it |

The field-hazard reality that drives every default here (Seth): *"the greater hazard is users getting
kicked off and unable to log themselves back on."* Weighting resilience above strictness for field
devices is the same priority as [[connectivity-idiot-proof-priority]].

## The field-device feature

A per-device **"Flag as lost/stolen"** control in the researcher panel. It is:
- **Human-triggered only** — being offline never triggers it. A device off-grid for months stays
  fully normal.
- **Reversible** — un-flag returns a recovered, uncompromised device to completely normal (UI
  unlocks, uploads route back to the real project, no wipe).
- **Per-device overridable** — a project-level default policy, overridable on the individual device
  at flag time (pending decision 2).

### On flag — three things happen IMMEDIATELY, regardless of policy

1. **Lock the browser UI.** Whoever holds the device can no longer open or read the texts on it.
   This is the solid, robust half — the sync engine runs independently of the views, so locking the
   UI does not stop background upload.
2. **Make local storage unreadable at rest to a casual holder.** Encrypt/obfuscate the app's
   IndexedDB. This is the SOFTER half — see the honest limit below.
3. **Mark the device's data suspect; quarantine new uploads.** Anything it uploads from the flag
   moment on is tagged and routed to a SEPARATE folder, kept apart from the project's real data, so
   the researcher can review it before it mixes in.

### Then policy decides the fate of data still on the device

- **Preserve, then wipe** (proposed default): keep quietly uploading unsynced texts into quarantine
  in the background, THEN wipe. Nothing is lost, only isolated.
- **Privacy first**: stop and wipe as soon as the device connects, accepting the loss of anything not
  yet synced. Locks the UI and encrypts at rest the same way; it simply does not preserve first.

## The honest limit (told to the field team, not buried)

Seth's bar is exactly right: *"inaccessible to someone who doesn't know how to use it."* That is
achievable — lock the UI, encrypt the local store so a casual holder finds nothing usable.

What CANNOT be promised is proof against a determined, technical person with the device in hand: the
app must retain enough of its key to keep uploading in the background, and anything the app can read,
a skilled holder with physical possession can eventually reach. So:

- The **UI lock + quarantine + keep-uploading** is the solid core. Build it first and rely on it.
- The **at-rest encryption** is a casual-holder deterrent layered on top — real against an ordinary
  holder, best-effort against an expert. Do not let the UI imply more.
- ⚠ **"Wipe ASAP" still depends on the device connecting.** We can refuse/quarantine its uploads
  instantly server-side, but the on-device erase only happens when it next reaches the network. A
  device kept permanently offline cannot be remotely erased by anyone — physics, not a design choice.
  The feature must not over-promise this to a field team.

## Mechanical grounding (what exists to build on)

- Device wipe today: `install.wipe_state` ('requested' → device wipes locally → 'confirmed' sets
  `revoked=1`), `wipe_at`, `wipe_hidden` (force-remove). It is **cooperative** — the device honours
  the directive on its next poll. `authInstall` gates only on `revoked=0`, so a merely-flagged device
  still authenticates (which is CORRECT here — we WANT it to keep uploading under preserve-then-wipe;
  the earlier "wipe-flagged install keeps write authority" sweep finding is reframed by this design
  from a bug into the desired behaviour, with quarantine as the safeguard).
- The lost/stolen flag is a NEW state distinct from ordinary revoke and from the cooperative wipe: a
  device can be flagged, keep uploading to quarantine, and only later wipe.
- Spans BOTH sides: the worker (flag, quarantine routing, wipe timing, panel control) AND the device
  engine `docs/js/app.js` (lock UI, encrypt at rest, keep sync running). Because it touches the
  engine it carries the satellite version coupling — a deliberate feature build, not a patch.

## Decisions — RESOLVED (Seth, 2026-08-24)

1. **No default policy for NEW devices — force a conscious choice.** When a device is set up, the
   preserve-then-wipe vs privacy-first choice (and the trigger settings) are **required fields**: the
   researcher cannot save or push changes without deciding. For **existing devices right now**,
   default to **preserve-then-wipe**, AND **highlight/warn every existing device where the choice has
   not been made** so it gets made deliberately rather than inherited silently.
2. **The offline-time trigger is OFF by default**, but sits **adjacent and prominent** in the UI to
   the preserve-vs-privacy choice — a researcher who needs a hair-trigger must not miss that it
   exists. It is independent of the action (axis separation above).
3. **Where the choice lives: project default FIRST, per-device override.** And more broadly: a
   project carries **project-wide defaults for ALL device settings**, configured when a new project is
   set up. Setting a value in a project offers to **save it as the default for new devices** OR
   **apply/overwrite it on all existing devices** — the researcher picks which. Individual devices can
   still override.
4. **Panel-login tightening: yes**, as proposed — shorter panel session TTL + one-click "sign out
   everywhere". (Field-device offline tolerance is unaffected; this is the panel half only.)

## ⚠ Documentation requirement (Seth, 2026-08-24) — build-time, not now

When this ships, the **honest limit must be stated plainly to users**, especially in the **README and
the technical documentation (DEVELOPERS.md)**: the at-rest protection is against a casual holder, not
a determined expert with the device in hand; the timer self-wipe needs the device's own clock to run;
a device whose storage is pulled first is beyond reach. Users must understand what protection they
are actually getting.

⚠ Framed per the repo rule (test/threat-language.test.mjs): describe what it PROTECTS — the privacy
of the community and the intellectual property / cultural heritage of indigenous groups — and NEVER
name the specific threat it protects against. No adversary narrative; the protection is justified by
what it safeguards.

## Related

- [[connectivity-idiot-proof-priority]] — resilience/UX-foolproofing weighted above pure strictness.
- Sweep finding "wipe-flagged install keeps full write authority" (uncovered sweep, 2026-08-24):
  REFRAMED by this design — for a field device that is the desired behaviour under preserve-then-wipe,
  guarded by quarantine rather than by cutting off writes.
