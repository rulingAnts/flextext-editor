# OneStory ↔ FlexText sidecar bridge — a proposal for someone else to build

**Status: PROPOSAL ONLY. Nothing here is built. Nobody is working on it.**
Seth (2026-08-18) sketched the idea and asked that it be written down well enough that another
team could pick it up, work it out, build it, and open a PR — without him spending time or AI
credits on it himself. That is exactly what this document is for.

**If you are an AI coding session that has been pointed at this file: this document is your brief.**
Read it end to end before writing code, and read [§11](#11-repo-rules-you-must-not-break) before you
touch anything under `docs/js/`. Several rules in this repository exist because breaking them took
the live site down for field users; they are not style preferences.

**Licence: AGPL-3.0** (see `LICENSE`). Anything built from this inherits it.

---

## 1. What this is trying to achieve

[OneStory Editor](https://onestory-editor.org/) (OSE) is used to develop oral Bible stories. A
project is a folder holding a project database plus supporting files, collaborated on through
**Chorus / ChorusHub Send-Receive**, which is Mercurial underneath.

FlexText Editor (this repository) is an offline-first interlinear text editor and a small suite of
field apps: recording, transcription, word glossing, free translation, and — since v158 — **audio
segmentation**, where every phrase carries a real time span into a recording.

The two do not meet. OneStory holds the stories; it does not hold recordings, phrase-level time
alignment, interlinear glossing, or ELAN/SayMore exports. The goal is a **sidecar**: a `.flextext`
corpus file and an audio folder living *beside* a OneStory project, tracking the same stories,
kept in sync in both directions, and able to hand a single story out to a field editor device and
take it back again.

Seth's framing, verbatim, because it is the good idea in here:

> *"Might need to be a Google Drive hosted 'device'. But a 'Device' that is the OneStory editor
> database. And somehow keeping it in sync with the same stories that are in the database.
> Tracking and syncing changes. And then making it easy to assign one of those texts to an editor
> device and then check it back in."*

That is the insight this whole design turns on. See [§5](#5-the-key-insight-the-onestory-project-is-a-device).

---

## 2. The three constraints that kill the obvious answers

Read these first. Each one eliminates a design an implementer will otherwise reach for on day one.

### 2.1 The sidecar must NOT ride along with Chorus Send-Receive

Seth: *"it couldn't ride along with ChorusHub based send and receive."* He is right, for two
independent reasons:

- **Audio in Mercurial is a mistake you cannot undo.** Every revision of every WAV is retained
  forever in `.hg`. A project with fifty stories and a few hundred MB of recordings becomes a repo
  that field users on a village connection cannot clone, and history rewriting is not an option once
  it has been distributed to teammates.
- **Chorus cannot merge what it does not model.** Chorus merges by file-type handler. A `.flextext`
  it does not understand is either treated as binary (conflict-copy on every collision, silently
  producing `foo.flextext.orig` files nobody reads) or line-merged as XML, which is worse — a
  successful textual merge of two interlinear files can produce a document that parses and is wrong.

So: **the sidecar exists in the project folder but does not travel through Send-Receive.**
Its own sync channel is this repository's connectivity backend (Cloudflare Worker + D1 + Google
Drive), which is built for exactly this — offline field devices, large audio, per-text folders.

⚠ **And the reverse hazard, which is the one that actually eats projects:** *never put a Chorus /
Mercurial working folder inside a Google Drive, Dropbox, or OneDrive synced directory.* A file
syncer racing Mercurial's working-directory writes corrupts `.hg`. If the design puts any part of
the sidecar in a Drive-synced folder, that folder must be **outside** the hg-tracked project, or
the whole thing must go through the **Drive API** rather than a desktop sync client. Verify how
your target sites actually have Drive configured before you choose. This is not theoretical; it is
the single most likely way a first version destroys someone's real project.

### 2.2 You cannot join stories to texts by title

Titles get edited, translated, renumbered and re-cased, on both sides, by different people, offline.
A title-matched sync will silently create duplicate texts and silently orphan real work. **A stable
identity map is mandatory** — see [§6.2](#62-the-join-manifest).

### 2.3 You cannot resolve conflicts by timestamp

Field devices have wrong clocks — routinely by hours, occasionally by years after a battery
change. Every "last write wins" scheme in this domain eventually deletes somebody's day of work and
reports success. This repository has already made this decision once and it holds here: **state is
derived from facts and content, never from a clock.** (`test/panel-pending-cmds.test.mjs` exists to
stop that specific regression from coming back.)

---

## 3. What you MUST measure before designing anything

This document deliberately does **not** assert how OneStory Editor stores its data, because the
author has not verified it and a plan built on a guess is worse than no plan. Your first deliverable
is a short written findings document — put it in `plans/onestory-bridge-findings.md` in your PR.
Answer at least:

1. **The project file.** What is actually in a `.onestory` project (or whatever the current
   extension is)? XML? SQLite? One file or several? Is there a published schema, an XSD, or only
   the source of the editor itself?
2. **Story identity.** Does a story carry a stable GUID that survives renaming and Send-Receive
   merges? If it does not, the join must be anchored on something you create — say so, and design
   for it (see [§6.2](#62-the-join-manifest)).
3. **The text you actually want.** OneStory carries several parallel lines per story (vernacular,
   back-translation, retelling, consultant notes — verify the real list). Which of them corresponds
   to a FlexText *baseline*? Which, if any, corresponds to a *free translation*? Getting this wrong
   makes every later decision wrong.
4. **Whether OSE tolerates a foreign file in its project folder.** Does it enumerate the folder and
   complain, prune, or move unknown files? Test with a real installation, not by reading code.
5. **How to exclude files from Send-Receive.** Confirm the mechanism — `.hgignore` in the project
   root is the likely answer, but verify whether OSE regenerates or overwrites it, and whether
   Chorus honours it in the specific S/R path OSE uses.
6. **Whether OSE is scriptable at all.** Is there a CLI, a plugin surface, or is the file the only
   interface? This decides whether write-back to OneStory is even possible, or whether the bridge is
   read-only into OneStory and write-only into the sidecar (a perfectly respectable v1 — see
   [§10 Phase 1](#phase-1--read-only-mirror-the-one-that-cannot-lose-data)).
7. **Concurrency.** What happens if the bridge writes a file while OSE has the project open? Is
   there a lock file? Does OSE hold the database open?

If any answer is "no stable identity" or "OSE rewrites the folder", say so loudly in the findings
document and **stop before building** — the design changes shape and Seth would want to know.

---

## 4. Deliverable shape: fork, build, PR

- **Fork `rulingAnts/flextext-editor`.** Do not ask for push access; do not push to `main`,
  `staging`, or `productionWeb`. Those branches have specific meanings documented in `CLAUDE.md`
  and a live site hangs off one of them.
- Work on a feature branch in your fork. The repo's own standing policy is that a major feature is
  built and tested **on its own branch preview**, not on `staging` (see `CLAUDE.md`, *FEATURE
  BRANCHES — standing policy*).
- Open **one PR per phase** from [§10](#10-phased-delivery), not one giant PR. Each phase below has a
  gate that is testable without a OneStory installation, on purpose, so a reviewer can verify it.
- Expect review to be about **blast radius** more than style. A change to `docs/js/` changes five
  apps at once; the first question on any PR will be "which apps reach this code path?"

---

## 5. The key insight: the OneStory project is a *device*

This repository already has, deployed and in field use, a complete model of *a thing that holds
texts, is often offline, is told what to do, and reports what it has*:

| Concept | Where it lives | What it means |
|---|---|---|
| `instance` | D1 table `instance` | one logical device/workstation, owned by a researcher |
| `install` | D1 table `install` | one app installation bound to that instance (editor + recorder can share one instance) |
| `desired_blob` / `desired_rev` | `instance` row | the command queue, E2EE under the instance key `Ki` |
| `ack_seq` | `install` row | the highest command seq that install has executed |
| inventory report | `install.inventory` | what texts this device currently holds, and their state |
| `assign` / `triggerUpload` / `uploadDelete` / `setDone` | commands | hand a text out, ask for it back, remove it, mark it done |
| per-text Drive folder | `driveFolderId` on the doc | where a text's artifacts accumulate |

**A OneStory project is exactly this shape.** Model it as an `instance` whose single `install` is a
headless bridge process. Then:

- "assign a text to an editor device" is the **existing** `assign` command, unchanged.
- "check it back in" is the **existing** `triggerUpload` + per-text Drive folder, unchanged.
- "track and sync changes" is the **existing** inventory-report + command-ack lane, unchanged.
- the researcher panel already renders all of it — device cards, pending markers, checked-out state,
  history, tombstones — with **no UI work at all** for the core loop.

That is the whole reason this proposal is worth writing down. The hard, already-solved,
already-field-tested part is the sync fabric. What is missing is one adapter.

⚠ **Do not build a second sync system.** If you find yourself inventing a new command lane, a new
conflict format, or a new "pending" concept, stop and re-read this section. The correct amount of
new sync machinery in this project is zero.

---

## 6. Proposed architecture

### 6.1 On-disk layout

Proposal, to be adjusted by your [§3](#3-what-you-must-measure-before-designing-anything) findings:

```
<OneStory project>/
  Project.onestory                 # OSE's own database — the bridge NEVER writes this in Phase 1
  .hgignore                        # must exclude everything below (verify per §3.5)
  flextext/
    corpus.flextext                # the sidecar corpus: one <interlinear-text> per story
    bridge-manifest.json           # the join map + sync bookkeeping (§6.2, §6.4)
    audio/
      <docId>/<basename>.wav       # one folder per text, mirroring the Drive per-text folder
    exports/                       # generated, disposable: .eaf, .pfsx, SayMore, preview.html
```

Notes:

- **One corpus file, not one file per story.** `.flextext` is a container of `<interlinear-text>`
  elements and FLEx imports a multi-text file happily; a single file is also what a linguist wants
  to drag into FLEx. If the findings show OSE or Chorus behaves badly with one large file, split —
  but do it because you measured, not because it felt tidier.
- **`exports/` is derived and must be regenerable from scratch.** Never let anything in it become an
  input. This repository already generates all of these — see [§8](#8-what-to-reuse-in-this-repository).
- **Audio filenames must be stable.** `docs/js` already has a filename policy and a test
  (`test/media-filenames.test.mjs`); follow it rather than inventing a scheme.

### 6.2 The join manifest

`bridge-manifest.json` is the only thing standing between this design and silent data loss. It maps,
per story, a tuple that never changes:

```jsonc
{
  "schema": 1,
  "instanceId": "…",                 // the D1 instance this project is registered as
  "texts": [{
    "oneStoryKey":  "…",             // OSE's stable id — or a bridge-minted id if §3.2 says there is none
    "flextextGuid": "…",             // <interlinear-text guid="…"> in corpus.flextext
    "docId":        "…",             // this suite's doc id — the key for commands and Drive folders
    "driveFolderId":"…",             // per-text Drive folder (see the dedupe contract in CLAUDE.md)
    "base": {                        // the last state BOTH sides agreed on — the merge base (§6.4)
      "oneStoryHash": "sha256:…",
      "flextextHash": "sha256:…",
      "syncedAt":     "…"            // diagnostics ONLY. Never an input to a merge decision.
    },
    "lease": null                    // or { deviceInstanceId, docId, seq, since } while checked out (§6.5)
  }]
}
```

- **`flextextGuid`** is real and already handled: `docs/js/flextext.js` mints and preserves
  `<interlinear-text guid>`, paragraph guids and segment guids (`newGuid()`, and the preservation
  rules around line 429 and 492 — read them; imported documents keep their own).
- If [§3.2](#3-what-you-must-measure-before-designing-anything) finds no stable OneStory id, mint
  one and store it somewhere OSE round-trips (a custom field, if one exists) or, failing that, keep
  the manifest itself authoritative and accept that a story deleted-and-recreated in OSE reads as a
  new story. **Document whichever you choose and its failure mode.**
- The manifest is **not** the sync channel. It is local bookkeeping. The server remains the
  authority on commands and the Drive folder remains the authority on artifacts.

### 6.3 Where the bridge process runs — three shapes

| Shape | How it reaches the folder | Pros | Cons |
|---|---|---|---|
| **A. Browser app, File System Access API** | `showDirectoryPicker()`, handle persisted in IndexedDB | No install. Reuses the entire engine as-is. This repo is **already Chromium-only** (`CLAUDE.md`), so the API's browser support is a non-issue here | Needs a human to open a tab and grant the folder once per browser; not a daemon |
| **B. Electron desktop app** | Node `fs` | Runs unattended, can watch the folder, sits next to ChorusHub on the same machine | New build/distribution surface; the repo has an `electron/` shell already, so not from zero |
| **C. Google-Drive-hosted** | Drive API, project folder in Drive | Matches Seth's instinct; nothing installed at the site; the "device" is genuinely serverless | ⚠ collides head-on with [§2.1](#21-the-sidecar-must-not-ride-along-with-chorus-send-receive) if the hg working folder is Drive-synced |

**Recommendation: build A first, structure the code so B is a repackaging, and treat C as a
deployment variant of the same adapter rather than a separate product.** Reasons: A gets you a
testable end-to-end loop in the least code, it inherits the engine, the file-system access is
explicit and revocable (which matters for the hostile-context threat model this suite takes
seriously), and the Chromium-only policy removes the usual objection.

Whichever you pick, the adapter must be a **pure, node-testable module** — parse/serialize/diff with
no I/O — plus a thin I/O shell. That is the pattern this repo already uses for
`docs/js/seg-exports.js` and `docs/js/paragraph-model.js`, and it is what will let you test the
merge logic without a OneStory installation.

### 6.4 The sync model: field ownership + three-way merge

**Field ownership.** Do not try to merge everything. Assign each field an owner, and let the
non-owner's changes be *displayed* but never *written*:

| Field | Owner | Why |
|---|---|---|
| story existence, story order | **OneStory** | it is the storying workflow; the sidecar follows |
| vernacular baseline text | **contested — see below** | both sides legitimately edit it |
| back-translation / consultant notes | **OneStory** | no FlexText representation worth round-tripping |
| word glosses, morphology | **sidecar** | OneStory has no model for them |
| free translation (interlinear) | **sidecar** | ditto |
| audio files | **sidecar** | see [§2.1](#21-the-sidecar-must-not-ride-along-with-chorus-send-receive) |
| phrase time offsets / segmentation | **sidecar** | ditto; and this is the feature that motivates the whole thing |

**The contested field is the baseline, and this repo already solved it.** `reconcileBaseline()` in
`docs/js/flextext.js:561` exists to reapply edited paragraph text onto an interlinear document
*without losing the glosses and translations already attached to the words*. That function is the
heart of a OneStory→sidecar text update, and reusing it is the difference between a weekend of work
and a rewrite. Read it, and read the v320 guid gate around it before you call it.

**Three-way, never two-way.** Every sync compares:

- `oneStoryNow` vs `base.oneStoryHash` → did OneStory change?
- `flextextNow` vs `base.flextextHash` → did the sidecar change?

with four outcomes: neither (no-op) · only OneStory (apply via `reconcileBaseline`) · only sidecar
(write back, or queue for a human if OneStory is read-only) · **both** (conflict).

**On conflict, do not merge and do not pick.** Write the incoming version alongside as a clearly
named artifact, mark the text conflicted in the manifest, surface it in the researcher panel, and
require a human. A story with a `.conflict` file beside it is an annoyance; a story where an
automatic merge quietly discarded a consultant's session is a catastrophe. The repository's own
standard is stated in `CLAUDE.md` — *"text is sacred"*, and alignment edits never touch text.

### 6.5 Check-out / check-in as a lease

"Assign to an editor device and check it back in" is the existing command lane plus one new idea:
a **lease**, so two people cannot both be editing the same story.

1. **Check out.** The researcher issues the existing `assign` command to the field device. The
   bridge records `lease = { deviceInstanceId, docId, seq, since }` and — this is the part that
   needs care — makes the story **visibly read-only on the OneStory side**. How, or whether that is
   even possible, is [§3.6](#3-what-you-must-measure-before-designing-anything). If it is not, the
   lease is advisory and the panel is the only place it is visible; **say so in the UI rather than
   implying a guarantee you cannot enforce.**
2. **While out.** The bridge stops writing that text. It keeps polling; the panel already shows
   queued vs taken state derived from `ack_seq` (never from a clock).
3. **Check in.** The device uploads to the per-text Drive folder (existing `triggerUpload`). The
   bridge sees the new artifacts, absorbs the `.flextext` + audio into the sidecar, runs the
   three-way merge of [§6.4](#64-the-sync-model-field-ownership--three-way-merge) against the base,
   clears the lease, and regenerates `exports/`.
4. **Never delete before absorbing.** This repo has an explicit rule for the native path —
   *absorb-then-delete* — and it applies identically here: bytes that exist in only one place are
   not moved, they are copied, verified, and only then released.

⚠ **A lease is not a lock, and a stale lease is guaranteed** — a device is lost, reflashed, or
simply never comes back. Design the release path (researcher force-releases from the panel, with the
same "are you sure, this may lose work" honesty the wipe flow already uses) **before** you ship the
acquire path. A system that can check out but not force check-in is a system that accumulates
permanently stuck stories.

### 6.6 Audio and segmentation

Almost entirely already built. Reuse, do not reimplement:

- **Reference from the flextext** via the FLEx-native `<media-files>` block (`docs/js/flextext.js:229`,
  `:492`; `docs/js/app.js:1618`). This is the format's own mechanism — do not invent a sidecar
  pointer file for something the format already expresses.
- **Time spans** ride as phrase `begin-time-offset` / `end-time-offset` plus visible `note` items,
  and are derived back on open by `segmentsFromOffsets()` (`docs/js/flextext.js:519`). `.flextext`
  **is** the segmentation format in this suite; there is deliberately no proprietary sidecar
  format, and adding one would be a regression.
- **Lossy sources** already have a policy: segmentation runs on a derived WAV working copy, the
  original is never touched, and the derived copy carries a BWF `bext` chunk naming its lossy
  origin. Read the segmentation section of `CLAUDE.md` in full before touching any of this.
- **Exports** (`docs/js/seg-exports.js`) already produce ELAN `.eaf` + `.pfsx`, the SayMore
  annotations profile, the self-contained preview HTML, and `.fxpa`. `exports/` should call these,
  not reimplement them.

---

## 7. Backend changes: additive only

This repo has a standing policy (`CLAUDE.md`, *BACKEND-FIRST, ADDITIVELY*): **D1 migration →
worker deploy → then clients**, with the property that the *currently deployed* worker keeps working
against the migrated database, and every existing endpoint keeps its path, auth and response shape.
Plan for that; a PR that changes a response shape will be sent back.

What this feature plausibly needs, all additive:

- **A new `instance.type` value**, e.g. `'onestory'`. The column exists; the validation at
  `worker/src/v1.js:2029` currently accepts only `''`, `'editor'`, `'recorder'` and must be widened.
  Note `cmd.forType` at `:2108` already gates commands by instance type — that is the mechanism for
  "this command only makes sense for a bridge".
- **Nullable columns** on `instance` for bridge bookkeeping, if any are truly needed. Prefer putting
  state in the E2EE inventory report over adding server-readable columns; the metadata in D1 is
  ciphertext by design and this feature should not be the reason that changes.
- **Origin allow-listing** for a new app origin, in `originAllows()` / `ALLOWED_ORIGINS`
  (`worker/src/v1.js`). Branch previews are already pre-authorized for staging.

⚠ **Do not touch `SERVER_HMAC_KEY` or anything derived from it.** It is unrotatable in production —
it derives both the `email_sha256` login lookup and the at-rest key for stored refresh tokens.

The repo has a hermetic local rig — `test/local-rig.sh` runs the real worker under Miniflare with a
real D1 — so all of this is testable without any cloud resources or any account. Use it.

---

## 8. What to reuse in this repository

| Need | Already exists | File |
|---|---|---|
| Parse / serialize `.flextext` losslessly | `parseFlextext`, `serializeFlextext` | `docs/js/flextext.js` |
| Reapply edited text without losing glosses | `reconcileBaseline` | `docs/js/flextext.js:561` |
| Derive time spans from a file | `segmentsFromOffsets` | `docs/js/flextext.js:519` |
| Time-span model + ordering invariants | — | `docs/js/segments.js` |
| ELAN / SayMore / preview / `.fxpa` exports | pure, node-testable | `docs/js/seg-exports.js` |
| Device command lane, inventory, ack | — | `docs/js/sync.js`, `worker/src/v1.js` |
| Researcher UI for devices/texts/commands | — | `docs/js/researcher-panel.js` |
| E2EE primitives, instance key `Ki` | — | `docs/js/crypto.js`, `docs/js/researcher.js` |
| Drive upload incl. chunked + per-text folders | — | `docs/js/upload.js`, worker `/drive` lanes |
| Local worker + D1 rig, no cloud needed | — | `test/local-rig.sh` |

Architecture background for all of it: **`DEVELOPERS.md`** (§3 engine/satellite model, §4 data
model, §6 connectivity). Read it before `CLAUDE.md`; `CLAUDE.md` is the rules, `DEVELOPERS.md` is
the explanation.

---

## 9. Threat model — read this before designing the sync

This suite is used by field translators in contexts where a device may be seized. That is not
decoration; it shapes the code:

- Device inventories are **attacker-controllable input**. Everything reported by a device is
  escaped at every call site and allow-listed where it lands in an attribute. A bridge that reads
  OneStory files and reports them upward inherits this: treat story titles and file paths from disk
  as hostile strings.
- Metadata in D1 is **E2EE ciphertext**. Do not add a feature that requires the server to read story
  content. If the bridge needs the server to understand something, that is a design smell — the
  worker routes, it does not comprehend.
- **The nuclear option exists.** There is a planned remote-wipe path. A new device type must behave
  correctly when wiped, which for a bridge means: release the lease, stop writing, and do **not**
  delete the OneStory project. Deciding what a wipe means for a bridge is a design question you must
  answer explicitly, not discover in production.

---

## 10. Phased delivery

Each phase ships independently and has a gate a reviewer can run.

### Phase 0 — findings
Produce `plans/onestory-bridge-findings.md` answering [§3](#3-what-you-must-measure-before-designing-anything).
**Gate:** a maintainer can read it and tell whether the rest of this plan still stands.
No code. If the answers invalidate the design, the PR is *still valuable* — say so plainly.

### Phase 1 — read-only mirror (the one that cannot lose data)
OneStory → sidecar only. Generate `corpus.flextext` + `bridge-manifest.json` from a project. Never
write to the OneStory database. Re-running is idempotent: identical input produces a byte-identical
corpus, and an edited story updates in place via `reconcileBaseline` with glosses intact.
**Gate:** a node test that takes a fixture project (anonymised or synthetic — see [§12](#12-out-of-scope)),
generates the sidecar, mutates one story's text, regenerates, and asserts that word glosses on
untouched words survived and that guids are stable. No OneStory installation required to run it.

### Phase 2 — register as a device
The bridge enrols as an `instance` of type `onestory`, reports inventory, appears in the researcher
panel as a device card with its texts listed.
**Gate:** runs green against `test/local-rig.sh` — real worker, real D1, no cloud, no account.

### Phase 3 — check-out / check-in
`assign` a story to a field device; the lease appears; the device uploads; the bridge absorbs the
returned `.flextext` and audio; the lease clears; `exports/` regenerate. Includes the
**force-release** path from [§6.5](#65-check-out--check-in-as-a-lease).
**Gate:** an end-to-end test through the local rig covering the round trip *and* the stale-lease
force-release. Plus an explicit test that a conflict produces a conflict artifact and never a
silent merge.

### Phase 4 — write-back to OneStory (only if [§3.6](#3-what-you-must-measure-before-designing-anything) allows)
Sidecar → OneStory for the fields the sidecar owns. Behind a setting, **off by default**, with a
dry-run mode that reports what it would change and writes nothing.
**Gate:** dry-run output reviewed against a real project by a OneStory user before the write path is
enabled for anyone.

### Phase 5 — audio through Drive at field bandwidth
Chunked upload/download of the audio folder, resumable, with the existing per-text Drive folder
dedupe contract honoured (`driveFolderId` echoed back, verified by `files.get`, never re-searched
per upload — the reason is in `CLAUDE.md`).
**Gate:** a resumed interrupted transfer produces a byte-identical file and does **not** mint a
duplicate `Title (n)` Drive folder.

---

## 11. Repo rules you must not break

These have all been paid for once. Full text in `CLAUDE.md`; the short version:

1. **`docs/` IS the website.** Only what is in `docs/` is ever served. Design docs go in `plans/`,
   never `docs/` — three of them were accidentally published from there.
2. **A new top-level `import` in `docs/js/app.js` is a new SHELL entry in the editor *and every
   satellite `sw.js`*, in the same commit.** Miss one and an updated satellite is dead offline —
   this took production down on 2026-07-20.
3. **Version bumps are atomic across four files** and are done only via `./bump-version.sh vNNN`.
   Commit with `git add -A` or not at all; a half-bump fails the build integrity gate.
4. **`docs/js/native-audio.js` is the only file allowed to touch `window.Capacitor`.** Do not tidy,
   inline, or refactor it. Run `./check-native-containment.sh` after touching capture code.
   Installed Android APKs wrap this engine and do not auto-update.
5. **Never commit secrets.** `./check-secrets.sh` and the tracked `hooks/pre-push` enforce it, and
   the secrets guard deliberately has **no override**. Install hooks with `./install-hooks.sh`.
6. **Never trigger billable GitHub usage** — no workflow changes, no non-standard `runs-on:`, no
   cron triggers — without the maintainer's explicit approval and a stated cost estimate.
7. **Do not push `productionWeb`.** Ever, from a fork or otherwise. It is the live field site.
8. **Chromium only.** Do not add Safari or iOS work-arounds, and do not list Safari as a gap.
9. **Generalize on the second use, not the first.** A premature abstraction spanning five apps costs
   five apps to unpick.

---

## 12. Out of scope

- **Any real project data in the repository.** Fixtures must be synthetic or fully anonymised.
  `samples/` is gitignored for this reason and `plans/` explicitly forbids personal data, real
  speaker names, and consent records.
- **Changing OneStory Editor itself.** This is a bridge. If it needs OSE to change, that is a
  finding, not a task.
- **Replacing Chorus.** The teams using it will keep using it.
- **A new sync protocol.** See [§5](#5-the-key-insight-the-onestory-project-is-a-device).
- **Merging audio.** Audio is copied, versioned by filename, and never merged.

---

## 13. Open questions for the maintainer

Ask these in the PR that lands Phase 0 rather than guessing:

1. Should the bridge be a **new app folder** (`apps/onestory-bridge`, its own Worker and PWA
   identity) or a **mode of the existing editor** (`window.__MODE = 'onestory'`)? The repo's design
   principle — *"modularize what is app specific, generalize what is shared"* — argues for a
   separate app with its own identity, but that is a five-Worker estate to extend and the
   maintainer's call, not yours.
2. Does a OneStory project belong to a **`project`** in the new projects/researchers model (the
   `project` / `project_member` / `member_key` tables now exist), and if so should assistant
   researchers be able to check stories in and out? Seth's stated position is that invited
   researchers see only what they are given access to.
3. Is write-back to OneStory ([Phase 4](#phase-4--write-back-to-onestory-only-if-36-allows)) wanted
   at all, or is a read-only mirror plus check-out/check-in the whole ask?
4. Who operates the bridge in practice — the researcher on a laptop, or an always-on machine at the
   site? That decides between shapes A and B in [§6.3](#63-where-the-bridge-process-runs--three-shapes).

---

## 14. Provenance

Idea and constraints: Seth Johnston, 2026-08-18. Written up by an AI assistant working in this
repository from the maintainer's sketch, as a starting brief for an outside contributor. **The
OneStory-side facts in this document are deliberately stated as questions, not answers** — nobody
here has verified them, and [§3](#3-what-you-must-measure-before-designing-anything) exists so that
whoever builds this establishes them first.
