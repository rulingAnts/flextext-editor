# OneStory ↔ FlexText sidecar bridge — a brief for an outside team

**Status: PROPOSAL. Nothing is built and nobody is working on it.** Seth sketched the idea on
2026-08-18 and asked that it be written down well enough that another team could pick it up, work it
out, build it and open a PR. The OneStory-side facts here are deliberately stated as **questions**,
not answers — nobody in this repository has verified them, and §4 exists so that whoever builds this
establishes them first. Everything asserted about *this* repository has been checked against the
tree.

**If you are an AI coding session pointed at this file: this is your brief, not a specification.**
It frames the problem and names the traps. The design is yours to finish. `CLAUDE.md` at the repo
root auto-loads and is the authoritative list of rules — read it; several exist because breaking
them took the live field site down.

**Licence: AGPL-3.0.** Anything built from this inherits it.

---

## 1. The idea

[OneStory Editor](https://onestory-editor.org/) (OSE) is used to develop oral Bible stories. A
project is a folder collaborated on through **Chorus / ChorusHub Send-Receive**, which is Mercurial
underneath. OSE is a storying workflow tool, not an interlinear or time-alignment tool.

This repository is an offline-first interlinear editor and a small suite of field apps: recording,
transcription, glossing, free translation, and **audio segmentation** — every phrase carrying a real
time span into a recording.

The goal is a **sidecar**: a `.flextext` corpus plus an audio folder living beside a OneStory
project, tracking the same stories, syncing both ways, and able to hand one story to a field editor
device and take it back. Seth's framing, verbatim:

> *"Might need to be a Google Drive hosted 'device'. But a 'Device' that is the OneStory editor
> database. And somehow keeping it in sync with the same stories that are in the database. Tracking
> and syncing changes. And then making it easy to assign one of those texts to an editor device and
> then check it back in."*

⚠ **Prior art exists and you must start from it.** Seth has OneStory import/export code in other
repositories — *URLs to be supplied; ask before starting.* There is also an unmerged branch
`claude/flextext-import-onestory-1jjm0p` in this repo with early sketching. Do not re-derive the
OneStory file handling from scratch.

---

## 2. The key insight: a OneStory project is already a *device*

This suite already has, deployed and in field use, a complete model of *a thing that holds texts, is
often offline, is told what to do, and reports what it has*:

| Concept | Means |
|---|---|
| `instance` | one logical device/workstation, owned by a researcher |
| the command queue on it | how it is told what to do (E2EE under the instance key) |
| the inventory report | what it says it holds, and in what state |
| the per-text Drive folder | where that text's artifacts accumulate |

A OneStory project is that shape. Model it as an `instance`, and check-out/check-in is the
**existing** assign / triggerUpload machinery — no new sync protocol, and the researcher panel
already renders device cards, pending markers, checked-out state, history and tombstones.

**So the correct amount of new *sync machinery* is zero.** Two honest corrections to that, both of
which a first design gets wrong:

- ⚠ **It is not zero UI.** Enrolment is not headless: a device claims a one-time invite and a human
  on that device accepts, with a key fingerprint confirmed out of band. The panel's invite modal
  offers only editor and recorder links today. Leases, conflict surfacing and force-release are all
  net-new. Any change to the device-side accept step is a change to a **consent mechanism** and needs
  the maintainer's sign-off, not a plumbing decision.
- ⚠ **A device is a command RECEIVER, not an issuer, and it cannot read a Drive folder.** Every
  command-queue write is researcher-authenticated, and per-text Drive folders live in the
  *researcher's* Drive. So "the bridge notices the returned artifacts" is **not reachable with device
  credentials as the backend stands.** Deciding which of these the bridge is — a
  researcher-authenticated session that also adapts a folder, or a device needing a genuinely new
  read lane — is the first architectural question, and it changes the backend work substantially.

---

## 3. Three constraints that kill the obvious answers

**3.1 The sidecar must not ride Send-Receive.** Audio in Mercurial is irreversible: every revision of
every WAV is retained forever, and you cannot un-distribute that history. Chorus merges by registered
file-type handler and has none for `.flextext`, so a collision becomes an unmerged conflict rather
than a correct merge — confirm the exact behaviour in §4. The sidecar's own sync channel already
exists: this repo's worker + D1 + Drive, built for offline field devices and large audio.

⚠ **And the reverse hazard, which is what actually destroys projects.** Two separate cases:
(a) the *sidecar* may live in Drive and be reached by API; (b) an **hg working folder may never live
inside a Drive/Dropbox/OneDrive synced directory, by any mechanism** — a file syncer racing
Mercurial's writes corrupts `.hg`, and no API choice changes that. Make it a design decision, not a
hope: the bridge detects an `.hg` directory under a known sync-client root and **refuses to run**.

Related, and easy to get wrong: **`.hgignore` is a tracked file.** Writing it is a commit to shared
project history that reaches every teammate on the next Send-Receive — which would contradict a
read-only first version. The untracked alternative is a local ignore referenced from `.hg/hgrc`,
which does not travel but means writing inside `.hg`. Which to use is a §4 finding. Either way, one
hard rule: **the bridge never runs `hg` and never writes inside `.hg`.** Mercurial state belongs to
Chorus.

**3.2 You cannot join stories to texts by title.** Titles get edited, translated, renumbered and
re-cased, on both sides, by different people, offline. Title matching silently creates duplicates and
silently orphans real work. A stable identity map is mandatory.

**3.3 You cannot resolve conflicts by timestamp.** Field devices have wrong clocks — routinely by
hours, occasionally by years after a battery change. State is derived from facts and content, never
from a clock. This repo has already made that decision once and has tests that exist to stop it
being undone.

---

## 4. Two tracks — and this is the real choice

Seth's request, and the fork in the road:

> *"Two possible plans: one that works with OneStory Editor as it is, with no further changes from
> Bob Eaton, and a second one that is allowed to propose and work with OneStory XML schema changes
> such that everything our app needs can be preserved in the OSE XML and recovered from there.
> (Specifically audio segmentation and protecting the placeholders to make sure morphemes align
> correctly.)"*

**Both tracks are worth writing up. Track A is what ships; Track B is what you take to Bob Eaton.**
They are not alternatives so much as now and later — and Track A's ceiling is the argument for B.

### What plain text cannot carry — the thing both tracks are about

In `.flextext`, a phrase is a sequence of `<word>` elements. Some are lexical; some are **punctuation
tokens**. Each word may carry morphemes, part-of-speech, and other analysis, which this engine
preserves verbatim without editing. Glosses attach **positionally, to words**.

So the word sequence *is* the alignment. Re-deriving it by tokenizing a plain-text line produces a
*different* sequence — one punctuation mark split differently, one clitic joined — and every
morpheme and gloss after that point attaches to the wrong word. That is what Seth means by
*"protecting the placeholders to make sure morphemes align correctly."* Plain text has nowhere to
put: word boundaries as authored, punctuation-token positions, morpheme breakdowns, phrase time
offsets, or media references.

### Track A — OneStory unchanged

**The rule that makes Track A safe: structure must never make the round trip.** Text flows *out* of
OSE into the sidecar; the sidecar is the sole custodian of structure, alignment and audio, and never
tries to store any of it in OSE.

When an OSE-side text edit arrives, `reconcileBaseline()` (`docs/js/flextext.js`) reapplies edited
paragraph text onto the interlinear document, keeping glosses attached to words whose text did not
change. That is the correct reuse and the reason this is a weekend of work rather than a rewrite.

⚠ **But it does not carry the time spans, and this is the trap that would bite hardest.** Two
different things in this codebase are called *segments*: a paragraph's **text** segments (phrases),
which `reconcileBaseline()` reconciles, and `doc.segments`, the **time spans**, which it does not
touch at all. Time spans are a *positional array* — `segments[i]` is baseline paragraph `i` — and
their only reconciler (`syncToLines()` in `docs/js/segments.js`) blindly pads with `timePending` and
truncates from the end. It says so in its own header: it preserves counts, not alignment.

**So an OSE-side paragraph insert or delete slides every later time span onto the wrong line,
silently** — a transcriber finds their text on someone else's waveform. Track A must therefore treat
a *structural* change from OSE differently from a wording change: carry the spans with the edit where
the mapping is knowable, and otherwise mark the affected spans pending rather than let them slide.
**Refusing to guess is a correct outcome here.** Do not let this be discovered in Phase 2.

Track A's honest ceiling, which should be stated plainly to users: **OSE remains unaware of audio and
alignment.** Nothing is recoverable from a Send-Receive alone, so the sidecar is the only copy of the
most expensive work, and its backup story *is* the whole story.

### Track B — with OSE schema changes

The instinct to avoid: "model interlinear text in OneStory." That is a large ask, it duplicates
FLEx, and it will not be accepted. **Ask for round-tripping instead, in rungs, smallest first, so the
conversation can stop at any one of them:**

1. **Preserve unknown, namespaced elements and attributes verbatim** across load, save and merge.
   OSE need not understand them — only not destroy them. This is exactly the round-trip policy this
   repository's own `flextext.js` implements for FLEx (*"anything this app does not edit is
   preserved"*), so there is precedent to cite rather than a novel demand. **This rung alone unlocks
   everything else**, because the bridge can then park a namespaced payload per story carrying what
   plain text cannot hold — word/morph structure including punctuation placeholders, phrase time
   offsets, and the media reference — plus a hash of the plain text it corresponds to, so an OSE-side
   edit makes the payload detectably **stale** rather than silently wrong.
2. **A stable per-story and per-line id** that survives renaming, editing and merge. This is the rung
   that makes *segmentation* survivable rather than merely storable: with line ids, an OSE-side
   insert is a known mapping instead of the silent slide described above. If only one rung beyond 1
   is winnable, this is the one to spend it on.
3. **Per-line time offsets and a media reference as first-class fields.** Propose the *FLEx-native*
   attribute shape this suite already writes (`begin-time-offset` / `end-time-offset` plus a
   media-files reference) rather than inventing new vocabulary — it is the same thing ELAN and FLEx
   already interoperate on.
4. **Explicit word-boundary preservation**, so morpheme alignment survives an OSE-side edit rather
   than being re-derived by tokenizing.

Rung 1 gives storage. Rung 2 gives resilience. Rungs 3–4 make OSE genuinely interoperable with the
ELAN/FLEx/SayMore world. **Write Track B as a proposal document addressed to Bob Eaton**, with the
rungs separable, each justified by a concrete failure it prevents — that is a far better artifact
than a patch.

---

## 5. What you must measure before designing

Your first deliverable is a short findings document — `plans/onestory-bridge-findings.md` in your PR.
Mark which answers came from reading OSE's code and which from observing a running installation.

1. **Audio.** Does OSE record, store or reference audio per story or per line *today* — in what
   format, where, and does it travel through Send-Receive? Answer this first: it decides whether a
   first version mirrors text alone or text plus audio OSE already holds.
2. **The project file.** What is actually in it? One file or several? Is there a published schema?
3. **Story identity.** Is there a stable id that survives renaming *and* a Send-Receive merge? If
   not, say so — it changes the shape of everything downstream.
4. **Granularity.** What is a story's internal unit, is it stable under editing, and does one OSE
   line map one-to-one onto a flextext paragraph? If OSE owns line boundaries, an OSE-side split
   re-flows everything downstream and moves every time offset with it (§4, Track A).
5. **Which lines you want.** OSE carries several parallel lines per story. Which is a *baseline*?
   Which, if any, is a *free translation*? Getting this wrong makes every later decision wrong.
6. **Foreign files.** Does OSE enumerate its project folder and complain, prune, or move unknown
   files? Test with a real installation.
7. **Excluding from Send-Receive.** Confirm the mechanism, and whether OSE regenerates it (§3.1).
8. **Concurrency.** What happens if the bridge writes while OSE has the project open? Is there a lock
   file? This is also what decides whether a checked-out story can be made read-only in OSE at all.
9. **Round-trip fidelity** (for Track B rung 1): does OSE preserve unknown elements today, by
   accident? Test it. If it already does, rung 1 is a documentation change, not a code change.

Also worth answering: does FLEx's Import Interlinear match on guid and update in place on
**re-import**, or create a duplicate text every time the corpus is regenerated?

⚠ **This work cannot start without** a OSE installation (a Windows .NET desktop app), at least one
real project folder you may inspect, and a OneStory user who can answer the behavioural questions
above. Lacking those, a code-and-schema reading plus a synthetic project is a legitimate start —
provided the findings say which is which.

**If the answers invalidate the design, say so and stop.** That PR is still valuable.

---

## 6. Architecture sketch

Deliberately a sketch. The shape is Phase 0's output, not this document's.

**On disk.** A `flextext/` subfolder holding the corpus, a join map, `audio/`, and a regenerable
`exports/`. Nothing in `exports/` may ever become an input.

**Addressing.** Audio is addressed by an id that does not change (docId/guid). **Titles are display
only and never part of a path** — §3.2 — and a second recording for a story is an additional file,
never a replacement.

**The join map.** Local bookkeeping that survives renaming on both sides, recording the last state
both sides agreed on so merges are three-way. It must be written atomically and must be
**reconstructible** from data living elsewhere — the guids already in the corpus, the ids the Drive
folders already carry. Any id the map is the sole holder of is a design error, and "rebuild the map"
is a required tested path, not an improvisation. Any timestamp in it is diagnostics only.

**Where it runs.** A browser app using the File System Access API is the least code and is viable
because this repo is already Chromium-only; an Electron repackaging follows for unattended operation.
A Drive-hosted variant applies to the *sidecar* only, never to the hg-bearing project (§3.1), and a
browser-less one would mean reimplementing the sync layer — the second sync system §2 forbids. Build
the adapter as a **pure, node-testable module** (parse/serialize/diff, no I/O) plus a thin I/O shell:
that is how you test merge logic without a OneStory installation, and it is the pattern this repo
already uses.

**Ownership, not merging.** OSE owns story existence and order; the sidecar owns glosses, morphology,
free translation, audio and time spans. The baseline text is the one genuinely contested field.

**Hash each side's *owned projection*, not whole content** — a consultant editing a back-translation
while a device adds glosses moves both whole-content hashes and would be declared a conflict, which
in real use is the common case, not the rare one. This repo's own tests state the principle: a check
that cries wolf gets muted, which is worse than no check.

**On conflict, do not merge and do not pick.** Write the incoming version alongside, freeze the text
— no further automatic writes, no further check-ins absorbed — and require a human. Conflict
artifacts never go in a directory the bridge may regenerate or prune.

**Leases.** Check-out records who holds a story; check-in absorbs and clears it. **Design the
force-release path before the acquire path** — devices are lost and reflashed, so a stale lease is
guaranteed, and a system that can check out but not force check-in accumulates permanently stuck
stories. If §5 finds a story cannot be made read-only in OSE, the lease is advisory: **say so in the
UI rather than implying a guarantee you cannot enforce.**

**Two safety rules that are not optional.** Every sync operates on a consistent snapshot taken when
hg and OSE are quiescent; a read that cannot be shown consistent is abandoned rather than merged, and
an implausible change (story count dropping sharply, the corpus emptying) refuses and asks a human —
that turns a partial read from a mass-deletion event into a no-op. And **nothing deletes anything on
the basis of the bridge having absorbed it**: state what must be present and verified before a lease
clears, or a `.flextext` absorbed before its audio finished uploading, followed by a routine remove,
loses the audio from both sides.

---

## 7. What to reuse, and what will bite

Reuse by symbol name — `parseFlextext`/`serializeFlextext`, `reconcileBaseline`,
`segmentsFromOffsets`, `syncToLines`, the segmentation model in `docs/js/segments.js`, the exports in
`docs/js/seg-exports.js`, the sync and worker layers, and `test/local-rig.sh`, which runs the real
worker against a real D1 with no cloud and no account. `DEVELOPERS.md` explains the architecture;
`CLAUDE.md` is the rules.

**Segmentation and audio are done.** `.flextext` **is** the segmentation format here — adding a
sidecar format for time spans is a regression. Read CLAUDE.md's segmentation section in full before
touching any of it.

Four things that will bite, all verified in the tree:

- **`reconcileBaseline()` does not touch `doc.segments`.** See §4, Track A. This is the big one.
- **`instance.type` carries a SQL `CHECK (type IN ('editor','recorder',''))` constraint.** Adding an
  `onestory` type is therefore **not** an additive migration — SQLite requires a table rebuild, which
  is the shape `worker/migrate-instance-type-unified.sql` opens by warning against in capitals. Do
  not assume a new device type is cheap. It may be better to enrol as an existing type, or to carry
  the distinction in the E2EE inventory rather than in a server-readable column.
- **The standing backend policy is additive-first:** D1 migration → worker deploy → then clients,
  with the currently deployed worker still working against the migrated database. Prefer putting
  state in the E2EE inventory over adding server-readable columns; the metadata in D1 is ciphertext
  by design and this feature should not be why that changes.
- **Remote wipe is shipping, not planned.** A new device type must behave correctly when wiped, which
  for a bridge means: release the lease, stop writing, and **do not delete the OneStory project.**
  Decide that explicitly rather than discovering it.

**And the threat model, because it changes a decision here rather than being decoration:** this suite
assumes a device may leave the team's control. Today that costs one device holding a handful of assigned
stories; **a bridge concentrates an entire project — every story, every recording, in plaintext on
disk — plus the instance key on one machine.** That blast radius is a real input to where the bridge
should run. The hostile-input surface for a bridge is **path injection**, not markup: story titles
become path components, and nothing the bridge writes may resolve outside its own folder.

---

## 8. Delivery

Fork `rulingAnts/flextext-editor`, work on a feature branch in your fork, and open **one PR per
phase against `main`** — never against `staging` or `productionWeb`. Expect review to be about blast
radius, not style: a change to `docs/js/` changes five apps at once. **Design so the bridge adds no
top-level `import` to `docs/js/app.js`**, which keeps its blast radius at zero — a new top-level
import there is a new service-worker SHELL entry in the editor *and every satellite*, in the same
commit, and getting that wrong took production down on 2026-07-20.

You deploy nothing: the Workers and D1 are on the maintainer's account. **Do not bump versions in
your PR** — the maintainer bumps at merge. What you can run locally: `./check-native-containment.sh`
(which also runs `test/*.test.mjs`; there is no root `package.json` and no PR CI),
`bash test/local-rig.sh`, and `bash dev-serve.sh 8012`. Your reviewer runs these by hand, so they
must pass from a clean clone. Never commit secrets — `./check-secrets.sh` guards it and has no
override.

Roughly:

- **Phase 0 — findings.** Answer §5. No code. Gate: a maintainer can tell whether this plan stands.
- **Phase 1 — read-only mirror.** OSE → sidecar only; never write the OneStory database. Idempotent,
  and an edited story updates in place with glosses intact. Gate: a node test over a synthetic
  project asserting that glosses on untouched words survive, guids are stable, and a *structural*
  change is refused or marked pending rather than sliding the time spans.
- **Phase 2 — register as a device.** Enrol, report, appear in the panel. Gate: (a) the enrol/report/
  ack round trip green on `test/local-rig.sh`; (b) panel rendering checked in a browser — the rig has
  no DOM.
- **Phase 3 — check-out / check-in.** Including force-release, and a test that a conflict produces an
  artifact and never a silent merge. State what happens to a returned *baseline* edit while
  write-back does not exist: either assigned stories are glossing/segmentation-only with the
  baseline read-only on the device (probably right for v1), or the edit is held in a named state.
  Otherwise the next apply silently reverts the field edit.
- **Later, if §5 allows.** Write-back to OSE, off by default with a dry-run mode reviewed by a
  OneStory user. Audio rides the existing per-text Drive lane, whose dedupe contract must be honoured;
  that gate needs live Drive, so the maintainer runs it at merge.

Phases 1–3 run without OneStory Editor. Phase 0 and write-back do not.

---

## 9. Out of scope

Real project data in the repository (fixtures are synthetic or fully anonymised; `plans/` forbids
personal data and real speaker names). Changing OSE itself in Track A — if it needs OSE to change,
that is Track B. Replacing Chorus. A new sync protocol (§2). Merging audio: audio is copied,
addressed by id, never merged.

---

## 10. Open questions for the maintainer

Ask in the Phase 0 PR rather than guessing.

1. Is the bridge a **researcher-authenticated session** or a **device**? §2's second warning makes
   this the first thing to settle, and it decides how much backend work exists.
2. New app folder with its own PWA identity, or a mode of the existing editor? The repo's design
   principle argues for a separate app; that is a five-Worker estate to extend and the maintainer's
   call.
3. Does a OneStory project belong to a **project** in the new projects/researchers model, and may
   assistant researchers check stories in and out? Seth's position is that invited researchers see
   only what they are given access to.
4. Is write-back to OSE wanted at all, or is a read-only mirror plus check-out/check-in the whole ask?
5. **Who operates the bridge in practice** — a researcher's laptop, or an always-on machine at the
   site? This is the fact that could overturn the browser-app recommendation in §6.
6. How far is Track B worth pushing with Bob Eaton, and does Seth want to make that approach himself?
