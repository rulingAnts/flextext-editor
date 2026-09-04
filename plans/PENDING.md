# Pending issues — the triage sheet (assembled 2026-08-14)

**What this is:** one screen naming everything outstanding, so a working session starts by *choosing*
rather than by re-reading a 1500-line backlog. Every line points at the entry that holds the real
detail — `plans/BACKLOG.md` unless another file is named. **This file ranks; it does not explain.**

⚠ **The ranking is a proposal, not a decision.** It is ordered by *risk to a field user's work*,
because that is the one currency this suite cannot refund: a lost transcription is somebody's
afternoon in a village, and no amount of feature polish buys it back. Seth's own priorities may
differ and win.

⚠ **Read `CLAUDE.md` first** — branch, version and deploy rules are binding, and two of the items
below touch the worker, where deploy ORDER is the difference between a release and an outage.

---

## 0 — a credential-rotation item lived here

⚠ **Deliberately not described in this repository, which is PUBLIC** (Seth, 2026-09-01: "let's not
post issues that expose security vulnerabilities").

The section that was here named specific accounts and the systems they reach. That is a map for
anyone who finds it, and it bought nothing a private note could not — the people who need it already
know. The same reasoning the section itself applied to the leaked file applies to the section:
publishing the shape of an exposure is its own small exposure.

⚠ **Removing it from the working tree does NOT remove it from history.** It is still reachable in
earlier commits of this public repo, and the text was cloneable for as long as it was pushed. If
purging history is wanted, that is a deliberate, coordinated operation — see
`plans/history-rewrite-runbook.md`; it rewrites every SHA, breaks every existing clone and worktree,
and needs Seth's terminal. It is cleanup, not a fix.

The item itself is tracked privately.

---

## Where things stand (2026-08-16)

- **production (`productionWeb`) = v384** (released 2026-08-17; gates green). Carries everything
  through: the loose-file converter (v377/378), listening-page transport + guards (v379), the
  Interlinear page (v380), the exported-page speed picker (v381), the round-trip blank-line fix
  (v382), Space-over-controls + persistent play speed + worded speed labels (v383) and the
  Indonesian "Biasa" label (v384) — all test-driven by Seth first.
- **`main` = `staging` = `productionWeb` = v384.** No untested code anywhere; clean slate for the
  next feature branch. Everything since is plans-only (no bump, per the docs rule).
- **Next feature work = the project split** (§3.1/3.2), designed in `plans/project-split.md`:
  requirements (I), design (II), two audit rounds (III), **one task that needs Seth's console
  (IV)** and a proposal to do most of it with no staging rig at all (**V — awaiting review**).

---

## 🚩 Legacy (GitHub Pages) estate — RETIREMENT IS BLOCKED (Seth, 2026-08-17)

> *"Iwan is still on the old instance. We have to keep that legacy path live until I can migrate
> him."*

**The legacy estate stays published.** Retirement is deferred, not cancelled, and nothing in the
tree needs changing to defer it — the removal was a plan, never an in-flight change. What continues
unchanged: `sync-satellites.yml` publishes the mirrors on every `productionWeb` push, the
deploy-order law holds (editor live first, every precached path verified 200), and
`test/version-sync.test.mjs` keeps the satellites' declared ENGINE pinned to the editor's.

**Who blocks it — measured per account (live instances only):**

| researcher | live `pages` | live `cloud` | revoked |
|---|---|---|---|
| `7b8d61ed…` — `br***@canil.ca` | **3** | 0 | 0 |
| `200fa5ab…` — `iw***@gmail.com` (Iwan) | **1** | 0 | 0 |
| `1b6dcff6…` — `mk***@gmail.com` | 0 | 2 | 0 |
| `9b330dd2…` — `se***@gmail.com` (Seth) | 0 | 1 | 27 |

**Brendon's three are dormant — the blocker is Iwan alone.** The table shows him holding three live
`pages` instances with nothing on `cloud`, but Seth confirmed with him directly (2026-08-17) that he
is **not using them actively**. So the D1 rows overstate the problem: one active user, one device.

⚠ Two things that still need saying before those rows are dropped:
- **"Not using it actively" is not "nothing on it."** Whatever those three devices hold locally is
  gone the moment they are revoked and reinstalled elsewhere. It needs one explicit confirmation
  from Brendon that nothing on them needs rescuing — not an inference from the dates.
- **Nobody but Brendon can check.** They belong to HIS researcher account, and the device inventory
  in `install.reported_blob` is E2EE ciphertext — the worker cannot read it and neither can Seth's
  panel. Server-side we can see that a device checked in, never what it is holding. That is the
  design working correctly, and it means this question is answered by asking him, not by querying.

⚠ **`instance.estate` is NOT a migration lever — do not "flip" it.** A PWA's identity is its ORIGIN:
Iwan's installed app lives at `rulingants.github.io` with its own IndexedDB, and no database column
can move an installed app or the data inside it. Changing `estate` only changes which URLs FUTURE
links are minted with. The real migration is the procedure Seth already has (*"upload and remove all
their texts, then revoke, send a new invite, and re-assign the texts"*) — get the data OFF the
device first, then pair fresh on the Cloudflare origin, then re-assign. Anything else loses work.

**The legacy set is CLOSED — waiting cannot grow it.** Confirmed at the source: `createInstance`
stamps `estate: 'cloud'` on every new instance (v1.js:1587–1589), and new crowd recorders likewise
(v1.js:2496–2498). The `DEFAULT 'pages'` in the schema exists only so pre-migration rows read
correctly. So the legacy population can only shrink, and Seth's *"any new users or app instances
will be using the new Cloudflare hosted app"* (2026-08-17) is a property of the code, not a habit
anyone has to remember.

⚠ **The panel's origin and the instance's `estate` are DIFFERENT THINGS, and conflating them is the
easy mistake here.** Seth, 2026-08-17: *"I think Iwan is using the Cloudflare site for the researcher
app."* That is entirely compatible with his instance still reading `estate='pages'`, because nothing
anywhere records which origin a researcher opens their panel from — it is just a URL, and the panel
talks to the same worker either way. `estate` decides ONE thing: which URL an invite or assignment
link is minted with, i.e. **where the FIELD DEVICE's app gets installed from**.

So the question that actually gates retirement is not where Iwan's panel runs. It is **where his one
live install is installed from** — and ⚠ **the server cannot answer that.** D1 stores no origin;
`secLog` records method, path, IP hash and country but NOT the `Origin` header, and only fires on
security events rather than ordinary polls (worker/src/seclog.js:33–46); and the device inventory in
`reported_blob` is E2EE, so even if it named the origin the worker could not read it. The answer
comes from Iwan or from looking at the device, not from a query.

**Which way it cuts:** if that install is already running from the Cloudflare origin, the `pages`
stamp is a stale attribute on an instance no installed app depends on — nothing blocks retirement,
and the row can simply be revoked or re-stamped. If it is a `github.io` install, retiring the
mirrors breaks his app. One question to him settles a decision worth several days of caution.

⚠ One nuance: an INVITE inherits its instance's estate (v1.js:1637–1638). So a second device paired
to Iwan's EXISTING instance would still land on `pages`. Closed means no new legacy *instances* —
not that the existing ones are frozen. If Iwan needs another device before he migrates, create a new
instance for it rather than inviting into the old one.

**Half of it is already done (2026-08-17): the Pages RESEARCHER panel now redirects.** Seth:
*"have the GitHub satellite for the researcher panel become an auto-redirect (with a link in case
the auto-redirect doesn't work)… Ideally it silently redirects him so that he doesn't even notice."*
`satellites/flextext-researcher/` now sends `rulingants.github.io/flextext-researcher/` to
`research.flextext.app` and its service worker is a kill switch that unregisters, drops its own
caches and navigates open windows across on the first launch. It costs the researcher one Google
sign-in on the new origin (auth is origin-scoped) and nothing else — Kr is worker-minted and the
wrapped-Ki map lives in `settings_blob`, so keys and devices come back on sign-in. If Iwan is
already using the Cloudflare panel, he notices nothing at all.

⚠ This does NOT touch the field devices, which is the whole point: `/flextext-editor/` is a
different scope with its own worker and its own caches, the kill switch deletes only
`flextext-researcher-*`, and nothing goes near localStorage or IndexedDB. Verified by executing
both guards under each hostname in `test/researcher-legacy-redirect.test.mjs`.

### Migrating Iwan — the ordered runbook (do this FIRST; retirement waits on it)

Seth, 2026-08-17: *"I need to get Iwan migrated first."* His researcher ACCOUNT needs nothing — it
is server-side and origin-independent. Only the field device moves.

0. **Settle the open question first: is his device actually installed from `github.io`?** Nothing
   server-side can tell you (see above). If it is already a Cloudflare install, stop — there is no
   migration, just a stale `estate='pages'` row to revoke or re-stamp once he confirms.

1. **Get everything OFF the device before touching anything else.** Have him upload every text and
   recording, and confirm in the panel's inventory that they are actually uploaded — not "he says
   he did".

   ⚠ **This is the step with no undo.** Revoke is an UNLINK, not a wipe: the device gets a 410 on
   its next poll and auto-releases, **keeping its local texts, which the researcher can then never
   retrieve** (v1.js:2082–2083). Revoking before the upload finishes strands his work on a phone.

2. **Create a NEW instance for the new device — do not invite into the old one.** An invite
   INHERITS its instance's estate (v1.js:1637–1638), so a link minted against his existing instance
   lands him back on `github.io`. A new instance is stamped `estate='cloud'` automatically
   (v1.js:1587–1589), which is what puts the link on the Cloudflare origin.

3. **Send the new invite; he installs from the Cloudflare URL** (`app.flextext.app` /
   `record.flextext.app` — his instance type is `''`, i.e. unified, so either app applies). Approve
   the install and let the key deliver. He must be online for this and for step 4.

4. **Re-assign his texts to the new device** and confirm they arrive.

5. **Only then revoke the old install/instance**, and only after that have him uninstall the old
   PWA — uninstalling can clear its IndexedDB, so it must be last.

### AFTER retirement: delete the dual-estate machinery (Seth, 2026-08-18 — a later release)

> *"After we retire the GitHub Pages hosting path and satellite repos, we should audit our code and
> clean out code that was specifically written to deal with the two hosting paths and the migration.
> But that's a later/future release task."*

Agreed, and inventoried now while it is fresh — a cleanup brief written a year later is a fishing
expedition. **Nothing here is to be touched until Iwan is migrated, the Pages estate is retired, and
every live instance reads `estate='cloud'`.**

**What exists ONLY because there are two estates:**

| Surface | Files |
|---|---|
| The `estate` column and everything that branches on it | `worker/src/v1.js` (stamping, invite inheritance, listView), `docs/js/app.js`, `docs/js/researcher.js`, `docs/js/researcher-panel.js`, `docs/js/paragraph-ui.js`, `docs/js/paragraph-export.js` |
| `rulingants.github.io` in code (not prose) | `worker/src/v1.js` (ALLOWED_ORIGINS + the OAuth `returnTo` default), `docs/js/i18n.js`, `docs/js/app.js`, `docs/js/researcher-panel.js`, `satellites/crowd-recorder/embed.js`, the four `apps/*/wrangler.toml` |
| The satellite source tree and its publishing | `satellites/`, `.github/workflows/sync-satellites.yml`, `check-release-integrity.sh` (`paths` mode), the satellite half of `test/version-sync.test.mjs` |
| The v318 retirement machinery itself | `satellites/flextext-researcher/index.html` + `sw.js` hostname gates, `test/researcher-legacy-redirect.test.mjs`, `satellites/flextext-researcher/help/migrate.html` |
| The SHELL duplication tax | every satellite `sw.js` mirroring `js/app.js`'s import graph — the v108 outage's whole cause |
| The deploy-order law | "editor live first, verify every precached path 200, then the mirrors" — the risk disappears with the mirrors |

⚠ **What must NOT be swept up with it, because it looks similar and is not:**
- `originAllows()` and the `*-…workers.dev` patterns — those are **branch previews**, still needed.
- `apps/*/build.sh` copying `satellites/<name>/` — the Cloudflare apps are BUILT from that tree. It
  is not going away when the mirrors do; the shells simply become its only consumer.

⚠ **Do not DROP the `estate` column.** Stop reading it; leave it. This project has just spent a week
learning what a destructive migration costs (R2-6, and `migrate-instance-type-unified.sql`), and a
column nobody reads is free. Backfill it to `'cloud'` if the inconsistency grates.

**The honest reason this is worth doing** rather than living with: every one of those surfaces is a
place a future change has to be right in two ways at once. The SHELL tax is the sharpest — a new
top-level import in `app.js` must land in every satellite `sw.js` in the same commit or an updated
satellite is dead offline — and it is paid on every engine change until the mirrors are gone.

### What retirement looks like afterwards (Seth, 2026-08-17 — LATER, not now)

> *"Retirement would look like warning banners saying this address is no longer supported and no
> longer receiving updates, with the new URL."*

So the end state for the remaining legacy paths is a **banner, not a redirect** — the editor and
recorder are field apps holding local work, and silently moving them to a new origin would orphan
their IndexedDB. A banner tells the user where to go and lets them migrate deliberately, with their
researcher's help. (The researcher panel could be redirected outright, and was, precisely because it
holds nothing local that a sign-in does not restore.) Not to be built until Iwan is migrated.

**The standing cost of waiting** (worth naming, since "later" is now open-ended): every engine change
keeps paying the satellite tax — a new top-level `import` in `js/app.js` is a new SHELL entry in
`satellites/*/sw.js` AND `paragraph-analysis/sw.js` in the same commit, or an updated satellite is
dead offline (the v108 outage). That tax is the argument for migrating two people sooner rather than
carrying two estates indefinitely.

### The measurement behind it

Queried against production D1 through the Actions wrangler workflow. **Four live instances are
pinned to `estate='pages'`, across TWO researcher accounts — and neither of them is Seth's.**

| instance | researcher | account created | instance created | live installs | last check-in |
|---|---|---|---|---|---|
| `63a84635…` | `200fa5ab…` — `iw***@gmail.com` | 2026-07-12 | 2026-07-12 | 1 | 2026-08-06 |
| `a22faf8b…` | `7b8d61ed…` — `br***@canil.ca` | 2026-07-18 | 2026-07-30 | **0** | never |
| `4aa584b6…` | `7b8d61ed…` — `br***@canil.ca` | 2026-07-18 | 2026-07-30 | 1 | 2026-08-03 |
| `3e9ddd5d…` | `7b8d61ed…` — `br***@canil.ca` | 2026-07-18 | 2026-07-30 | 1 | 2026-07-30 |

⚠ **The assumption to correct: it is NOT "just Seth and Brendon."** `br***@canil.ca` is presumably
Brendon (CanIL), but the other account is a THIRD person, and Seth's own account is not on this
estate at all (his live devices are on `cloud`). Two people to contact, neither of them himself.

**Nothing is old.** The oldest legacy instance is ~5 weeks (2026-07-12); the rest are ~2.5 weeks.
This is not abandoned infrastructure with forgotten users on it — it is recent, active work.

**No outstanding pairing links break.** Two unclaimed invites point at live `pages` instances and
**both are already expired**, so nobody has a valid legacy invite sitting in an inbox.

⚠ **`last_seen_at` only advances on a poll or report, so quiet ≠ retired.** These are village field
devices with intermittent connectivity; eleven days without a check-in is a normal week, not
evidence a device is out of use. Do not read the dates above as "nobody is using it."

Full addresses are deliberately NOT in this file or in any workflow log (the repo is public) — map
the researcher-id prefixes in the Cloudflare dashboard's D1 console.

---

| # | Item | Why it ranks here |
|---|---|---|
| 1.1 | **GUID adoption: a deleted line's guid gets reused by an unrelated new line, and FLEx honours guids** | CONFIRMED against shipped code; corrupts a researcher's FLEx data *silently and downstream*. ⚠ **THE FIX IS ALREADY WRITTEN AND STRANDED** — v320 on branch `guid-identity-gate` (commit `c8e40ac`, 2026-08-08). Verified NOT an ancestor of `productionWeb`, and the similarity gate exists nowhere in the live tree; it was orphaned when `parked-v319-v321` was parked, taking v319–v321 with it. So this is a **rebase + re-verify**, not a rewrite. `v321-hardening` carries the adversarial-audit hardening that followed it. |
| 1.2 | **Lists lose their scroll position on rebuild** — panel texts list FIXED v369 but **unverified live**; the general rule is written | A fix nobody has watched work is a claim. The panel one could not be driven here (no dev worker). |
| 1.3 | **The exported `.fxpa` can go stale and nothing says so** | Silent staleness in an export is the same family as 1.1: wrong data that looks right. |
| 1.5 | **The exported `.flextext` writes a worker URL into `<media-files location=…>`** | An ASSIGNED text exports pointing at a time-boxed `/v1/textfile/` token on an origin we may retire; a file-attached text exports a bare filename. Two provenance stories from one exporter, and the durable one is the accident. Fix = a .flextext PACKAGE with a relative reference, exactly as ELAN and SayMore already do. |
| 1.4 | **Gloss ✂ splits at an unplaced playhead** | Mints slivers/pending spans from a mis-click. Small, well-specified, cheap. |

## 2 — Field-user experience under bad conditions

| # | Item | Why it ranks here |
|---|---|---|
| 2.1 | **Resource + cheap-device audit** — measurements already taken, incl. ~492 MB heap on a 40-min recording | A 44.1 kHz phone recording is ~3× that transiently. Tab-kill territory on the hardware this suite exists for. The one item here that could stop work outright. |
| 2.2 | **A devworker override must be VISIBLE, not a console line** | Cost a whole diagnosis round on 2026-08-14. A device silently on the wrong backend is indistinguishable from a broken release. |
| 2.3 | **Pause / resume / cancel for panel transfers** | Village bandwidth. Long-standing. |
| 2.4 | **Native audio conversion as a device-side fallback** | Unblocks formats the browser cannot decode. |
| 2.5 | **Configurable span-play return-to-playhead** (default: remember) | Seth reversed the always-rewind rule; it makes the chop-and-listen loop work properly. Pairs naturally with 1.4. |
| 2.6 | **Slow playback without pitch change** | Nearly free (`preservesPitch` defaults true); the work is choosing rates and proving the span watcher survives. |

## 3 — Architecture (plan before touching)

| # | Item | Why it ranks here |
|---|---|---|
| 3.1 | **PROJECT ≠ researcher split** — ⭐ **SETH, 2026-08-15: high priority, next working day**, together with 3.2 | Prerequisite for multi-project and for researcher-sharing. Devices must migrate **without re-pairing**; per-project E2EE key re-wrap; panel becomes project-scoped (a client release, worker-first). |
| 3.2 | **Researcher signed in on multiple devices** — ⭐ **same priority, same day as 3.1** (Seth: *"also think through some guards and safeguards to protect that"* — so the deliverable is the session model AND its abuse story, not just the column split; see BACKLOG for what "guards" has to cover) | Blocked by ONE column — which also doubles as the legacy password hash. Sequence WITH 3.1, not before: sessions become "researcher × project" the moment projects exist. Probably needs no outage on its own. |
| 3.3 | **Multiple researchers sharing one project** | Depends on 3.1. The hard parts are key re-wrap and what "revoke" honestly means. |
| 3.4 | **Engine-wide drift / modularisation** | Standing watch item, not a task. |

⚠ **Before any of 3.1–3.3 is built, read `plans/project-split.md` PART III round 2.** Four of its six
findings are pre-existing worker defects the split would arm rather than create — a member's Drive
call reaching the owner's whole estate incl. an account-wide permanent purge (R2-1), key rotation
that never reaches an idle device (R2-2), `signout` destroying a password-lane verifier (R2-3), and
an owner self-delete cascading over a shared project (R2-4). R2-6 (no migration ledger; `schema.sql`
folded forward; `d1 execute --file` is atomic; two migrations rebuild tables and drop later columns)
now has a guard in the tree: `node test/worker-schema.test.mjs` + `worker/schema-report.sql`.

## 4 — Features and polish

**Attribution traces in exports** (Seth, 2026-08-15 — *"that's a later priority"*): stamp
"made with FlexText Editor" where each destination format already keeps provenance — `.fxpa`
`generator`, a `<meta name="generator">` in the listening page, a version + URL on the EAF's
existing `AUTHOR`, the BWF `bext` (which is the STANDARD place for it, so archival quality is not at
risk — the constraint is never touching the original capture and never naming a person). ⚠ The
`.flextext` one is the risky member: FLEx re-imports it against a schema. Detail + the two traps in
`BACKLOG.md`. ·
Assign to "Google Drive (Unassigned)" — park an uploaded text ready to move to any device (Seth 2026-08-17; BACKLOG) · Drive storage footprint + inventory modal · PAT → ELAN EAF export · oral transcription and
back-translation (format problem first) · standalone segmentation/matching app · assignment-URL
collision warning · invite-link-overrides warning · localization expansion (decisions still Seth's) ·
the `.fxed` follow-ons · in-situ "does it save when I leave?" answer.

- **Toolbox / SFM → FLExText import, one text or many per file** (Seth, 2026-09-04: "a quick
  Toolbox/SFM -> FLExText import path (which would need to support either individual texts or
  multiple texts in one file)") — near-future, suite-wide. Scoped in
  [#29](https://github.com/rulingAnts/flextext-editor/issues/29): a pure DOM-free parser beside
  `flextext.js`, marker→line mapping with defaults, `\p`/`\ref` → paragraph/phrase, then
  `normalizePhraseLines` on entry like any `.flextext`.
- **The Audio Segmenter as a THIRD invite kind** (Seth, 2026-09-04: "turn 'audio segmenter' app
  into a third kind of invite link for devices and integrate it into our device/project/assignment
  system") — **built, v575, client-only** (no worker route, schema or origin change: the only
  persisted kind is `instance.type`, and every device the panel creates is untyped). The panel
  prints a third link; the app reports `segmenter`; Done on a paired device marks the text done
  and queues the `.flextext` with its times; ⤓ stays as the unpaired way out. **End-to-end pairing
  is unverified** — it needs a researcher account (staging) or the rig (`./devctl.sh start`);
  `test/segmenter-pairing.test.mjs` pins the static half, and the sheet's §2c has the walk-through.

## 5 — Parked, and parked for reasons

`parked-panel-and-matching` · `parked-v319-v321` · Files ▾ drop-down hidden · the inferred
"Bundle (.zip)" row · consent-message panel parity · no delete-audio button on paired devices ·
`/drive` edge-cache header hygiene.

⚠ **Check these before starting anything adjacent** — several are parked *because* they collide with
work that has since shipped, and one (`parked-v319-v321`) predates the whole v351–v376 line.

---

## Branch hygiene (verified 2026-08-17 — deletion still needs Seth's terminal)

`git push origin --delete` returns **403** from the remote-execution environment (re-confirmed
2026-08-17 with a live attempt): the credentials push but cannot delete refs. Run locally.

> ⚠⚠ **THIS LIST WENT STALE AND BECAME A DESTRUCTIVE COMMAND. Two names were removed on
> 2026-08-24; re-verify ancestry before running it, every time.**
>
> The list was written on 2026-08-17 against `productionWeb` v383 and captioned "every branch below
> re-verified ZERO content difference". That caption stayed true of the *text* while the repository
> moved underneath it. By 2026-08-24 it named:
>
> - **`claude/cut-tab-waveform-displays-2owdfx` — +140 commits, NOT an ancestor of anything.** It
>   carries the entire Phase C authorization layer, `drive_object` phases 1/1b/2 and Phase D, none
>   of it merged anywhere — **and it is the source the LIVE production worker was deployed from**
>   (`worker/src/v1.js` is 5412 lines here against 4151 on `productionWeb`; `authMember` and
>   `drive-object.js` exist on no release branch). Deleting it would have destroyed the only copy
>   of the code currently serving every field device.
> - **`assign-by-upload` — +6 commits, also not an ancestor.**
>
> A list of branches to delete is a loaded command, so it decays in the one direction that costs
> something. **Before running it:** `git fetch origin`, then for each name
> `git merge-base --is-ancestor origin/<name> origin/productionWeb` — delete only what that accepts.

```sh
# ⚠ Re-verify ancestry FIRST (see above). Correct as of 2026-08-24:
for b in segmentation parked-panel-and-matching segmentation2 seg-exports \
         editor-fixes-v322 paragraph-analysis tok-pisin-l10n heads-model cycle-rest \
         claude/assign-by-upload-build-7d5ee8 claude/assign-by-upload-build-uik28u \
         claude/paragraph-analysis-backlog-1bb9bd claude/prompt-too-large-error-d767f1 \
         claude/unpaired-device-setup-w3u9ck claude/worker-cache-poisoning-536b2c; do
  git merge-base --is-ancestor "origin/$b" origin/productionWeb \
    && git push origin --delete "$b" \
    || echo "SKIP $b — NOT an ancestor of productionWeb, it holds unmerged work"
done
```

Takes the repo from 24 branches to 9: the three trunks plus six carrying real decisions.

⚠ **Do NOT delete these six — unique commits, each awaiting a decision:**
`guid-identity-gate` (the v320 GUID fix — rebase + re-verify, PENDING 1.1), `v321-hardening`,
`parked-v319-v321`, `fix-artifact-kinds-and-fxpa-stamp` (v317/v319), `paired-audio-delete-gate`
(its own commit says do not merge without Seth's go-ahead), and
`claude/flextext-import-onestory-1jjm0p` (~15 lines of OneStory-injection plans — cheapest close is
copying the plan into plans/ then deleting).

## What a session should open with

1. **Pick from §1 or §2.1**, or explicitly decide the release comes first.
2. **Re-read the entry** in `BACKLOG.md`. Several record decisions already made and reasons already
   litigated; re-deriving them wastes the session and risks reversing them by accident.
3. **Check whether it touches the worker.** If so, `notes/RELEASE-RUNBOOK.md` owns the order, and
   getting it wrong gives field users 404s.
4. **Write the regression check before the fix, and watch it FAIL.** Twice on 2026-08-14 a test
   passed with the bug still present — once because the fixture was too short to show it, once
   because it measured the wrong thing entirely. A test nobody has seen fail is a comment.

## Audio Segmenter — the matcher is TWO PANES, not the Cut tab (Seth, 2026-09-03)

> *"I'm not sure whether we want to reuse the existing Cut tab exactly... I was thinking a left
> column/area that's roughly the same as the cut tab and a right column/area/frame that has
> interlinear text lines. And then we match them (we can split or join text lines, but have to click
> the two points — the scissors between the word and the gloss, and a space on the free translation
> line)."*

- **Left**: the Cut-tab surface — waveform, spans, guess-the-lines.
- **Right**: the interlinear lines of the text, as lines.
- **Matching** is the product: line ↔ span.
- **Splitting a text line takes TWO clicks, and that is the interesting part.** An interlinear line
  is a word/gloss stack plus a free translation, and the FT is prose that does not align word by
  word — so where the words break does not tell you where the translation breaks. The user says
  both: a point in the word/gloss run (the scissors), and a space in the free translation.
- Joining is the inverse.

### The two sides are INDEPENDENT, and that is the architectural point (Seth, 2026-09-03)

> *"Splitting and joining on the audio segments and on the text lines should be independent of each
> other — and then you map/match the pieces graphically until they're all mapped and the user clicks
> done."*

So the flow is: cut the audio however it falls, cut the text however it reads, **then** map piece to
piece, and finish when everything is mapped.

⚠ **This is NOT the engine's current model, and that is the whole build.** Today `segments[i]` IS
baseline paragraph i (`segments.js` cutAtPlayhead / joinWithPrevious): the two are index-locked, so
cutting audio inserts a paragraph and cutting text moves audio boundaries. Under Seth's design they
are two independently editable lists plus an explicit MAPPING between them, and the index-lock is
only re-established at the end, when the user clicks Done and the mapping is applied.

That means the app needs:
- an audio-span list it can split/join without touching the text,
- a text-line list it can split/join without touching the audio,
- a mapping (span ↔ line) held separately, drawn between the panes,
- a completeness check — "all mapped" is what enables Done,
- and one commit step that writes the mapping back into the index-locked model the rest of the
  suite already understands, so nothing downstream needs to learn a new shape.

Splitting a text line still takes TWO clicks (the scissors in the word/gloss run, and a space in the
free translation), because the FT is prose and does not align word by word.
