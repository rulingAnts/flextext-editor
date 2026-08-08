# Backlog additions (2026-08-07) — paste into notes/BACKLOG.md

## Warn the researcher that an invite link OVERRIDES a device's existing setup (Seth, 2026-08-07)
**Where:** researcher-panel.js, the invite-link generation flow. NOT built — deliberately deferred.

A standalone editor can now be set up entirely on the device (Settings tab → device setup, v289).
When that device later claims an invite, the researcher's pushed settings replace ALL of it —
writing systems, recording, consent prompts, and the consent audio (their Drive URL outranks the
locally-picked file by construction; see consentLocalAudio()).

So the researcher should be told, at the moment they generate an invite, that pairing will overwrite
whatever setup already exists on that app.

⚠ WARN THE RESEARCHER, NEVER THE EDITOR USER. Seth's reasoning: "The logic of this suite is that
that user should not be expected to be tech savvy enough to understand what that means and make an
informed decision." A prompt on the device would ask a field worker to arbitrate a question that is
not theirs, at the worst possible moment.

## Read and edit .fxpa in the FlexText Editor without breaking the analysis (Seth, 2026-08-07)
**Not started. Next up after the current settings work.**

The editor should import a .fxpa, expose ONLY lines, free translations and glosses for editing, and
write it back with the paragraph-analysis tree as close to untouched as possible.

- It does NOT need to render any paragraph-analysis structure. No brackets, no diagram, no grouping UI.
- The hard part is the seams: combining or splitting lines must auto-adjust groupings, making the
  MINIMAL change needed to smooth over the break rather than re-deriving the tree.
- So the editor needs enough of the .fxpa model to keep the invariants (single parent, adjacency, no
  dangling ids) true across a line split/join — checkInvariants and repairDocument already exist in
  paragraph-model.js and are the natural seam.

## Expand localization across the whole Flextext Editor Suite (Seth, 2026-08-07)
**Next, after the current settings work ships.**

Baseline as of v290: en and id are at exact key parity (1267 each) across the editor, the recorder,
the researcher panel and PAT — verified both directions, plus every CONCATENATED label expanded
(`panel.opt.<group>.<value>`, `panel.grp.<id>`, `panel.f.<k>`, `setup.off.<k>`).

⚠ The failure mode to design against: a key built by concatenation renders its own raw name when it
is missing — "panel.opt.abm.30" where a label should be. Nothing throws, and it shows up in the
SECOND language first, because that is the side nobody reads while developing. test/device-setup
now expands the setup form's prefixes for exactly that reason; whatever comes next should do the
same for the surfaces it touches rather than trusting a count of literal t('x') calls.

Open questions for that round: which languages beyond en/id; whether the id copy gets a native
review pass (much of it is mine, not a speaker's); and whether the satellites' own shell strings
(index.html in satellites/*) are in scope — they are separate from the engine's i18n.js.

## ~~Drop the "Share" send option?~~ — DECIDED: KEEP IT (Seth, 2026-08-07)

**"Don't drop share."** Closed. Share stays exactly as it is: offered where the browser supports
it, disabled-with-a-reason where it does not, and never counted as a way to get the WORK out (its
allowlist covers neither XML nor ZIP). No migration needed. The original reasoning is kept below
only so nobody re-opens this from scratch.

### (superseded — original entry)
> "Yeah, the reason for share is for one more sending route over mobile devices. We actually don't
> really need it anymore."

NOT ACTED ON — flagged mid-test-cycle rather than ripped out under Seth's feet. What removing it
would touch, so the decision is a decision and not a surprise:

- `SETUP_SEND_OPTS` in the editor, the panel's `sendOptions` field, `allowedSend()`,
  `sendCapabilities()`, `canShareFiles()` and the `setup.off.share` reason line.
- Devices in the field with `sendOptions: ['share', ...]` already stored. Dropping the option
  without a migration leaves them configured for a route that no longer exists — `allowedSend()`
  would simply not offer it, which is safe, but a device configured ONLY for share would become a
  dead end. The dead-end validator catches that on the form; it does not catch it on a device
  nobody opens the form on. A migration that adds 'save' wherever 'share' was the only route is the
  honest version.
- The researcher panel offers it to MANAGED devices, whose browsers it cannot see. Its own reason
  for existing (a phone can hand a file to WhatsApp; a desktop cannot) is exactly the mobile route
  Seth says is no longer needed — so the panel side goes with it, not separately.

Its current state is already correct-if-kept: disabled with a reason on any browser without
`navigator.canShare({files})`, and excluded from counting as "a way to get work out" because
Chromium's share allowlist covers neither XML nor ZIP.

## PARKED: Panel parity — "Written reminder" ⇒ Consent message (Seth, 2026-08-07)

**"A good idea but not mission critical. We can park that."**
The editor's Settings tab now greys the Consent message box while "Written reminder" is unticked
(`dynOff` + `setupDynOff`, v298). The researcher panel has the identical field pair
(`consentAsk` / `consentMsg`, researcher-panel.js ~line 388) and does NOT do this.

Deliberately left alone: the ask named the editor, and Seth is mid-test on both apps. The panel's
case is also genuinely weaker — its Save-blocking validator already refuses a blank message when
text is asked for, which is the guarantee the greying buys in the editor now that nothing can
block. Worth doing for consistency, not for correctness.

## PARKED: the "FlexText Editor" item in the panel's Files drop-down does nothing (Seth, 2026-08-07)

Reported during the v301 test round; parked by Seth, not investigated.

Where it is: `researcher-panel.js` → `fileMenuHtml`/its filler (~line 1250). The label is the i18n
key **`panel.dl.bundle`** = "FlexText Editor" — so it is the row for the artifact of kind `bundle`,
emitted by the `resolveArtifacts(item, null)` loop as a plain link:

    <a class="rp-dl-item" href="${f.url}" target="_blank" rel="noopener noreferrer">

⚠ NOT the "Download all" button (`data-zipall` → `downloadAllZip`), which is a different code path
and was the double-zip fixed in v301. Do not conflate the two when picking this up.

### DIAGNOSED 2026-08-07 (not fixed — still parked)

**The menu has TWO kinds of row and only one of them is authenticated.**

- The folder-listing rows carry `data-drivefile` + `data-fname` and NO real href. The click handler
  (researcher-panel.js ~1409) intercepts them and calls `Researcher.fetchDriveFile(id)` — through the
  WORKER, on the researcher's stored token. Its own comment says why: *"a plain drive URL would work
  for the owner, but this behaves identically signed in or not, and never leaves a preview page."*
- The `resolveArtifacts` rows — **including "FlexText Editor"** (`panel.dl.bundle`), plus the audio
  row and the last-upload row — are plain `<a href="${f.url}">`, where `f.url` is
  `driveLink(id)` = `https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t`.

That is a DIRECT browser request to Drive. It authenticates with whatever Google session the
researcher's browser happens to have — not the Worker token the rest of the panel uses. If the
browser is signed out, signed into a different Google account, or the file simply is not shared with
the human (uploads are placed by the Worker's own credentials), the link is dead. The Worker-routed
rows in the SAME menu keep working, which is exactly the reported shape.

**The fix, mirroring code that already works two rows away:** give the artifact rows
`data-drivefile`/`data-fname` instead of an href, so the existing handler picks them up. That needs
the file ID, which `resolveArtifacts` currently discards into the URL — so either add `id` to the
objects it returns (additive, `artifacts.js` is pure and node-tested) or recover it with
`driveIdFrom(f.url)` at the call site. Prefer the former; `driveIdFrom` on a URL we just built is a
round trip that can silently return ''.

⚠ Verify against a real panel before believing it. This diagnosis is from reading, not from a
reproduction — the sandbox has no Drive.

Also worth doing while in there: the label. "FlexText Editor" names an APP but the row is a FILE
(the uploaded bundle), which is misleading whatever the cause.

Note the label is misleading regardless of the bug: "FlexText Editor" names an APP, but the row is
a FILE (the uploaded bundle). Worth renaming whatever the cause turns out to be.


## PARKED (built, not shipped): no "delete audio" button on paired devices (Seth, 2026-08-07)

> "The other thing we don't want is the 'delete audio' button on paired devices. On unpaired devices
> it SHOULD be there." … then, before it shipped: "let's park this on our backlog and leave it."

**DONE AND VERIFIED — on branch `paired-audio-delete-gate`** (from staging, v303). Merge `--no-ff`
into staging when it is wanted; nothing else needed. Not on main, not on staging, cannot ship by
accident.

What it does: a new `canRemoveAudio(rec)` predicate gates BOTH the ✕ button and the onRemove action.
Paired ⇒ no button and the action refuses. Unpaired ⇒ unchanged. Same principle as `allowDeleteOn()`
and `deleteAllAllowed()`, which already short-circuit on `hasSession()`.

⚠ **THE OBVIOUS IMPLEMENTATION IS A TRAP** — worth reading before anyone "simplifies" it. Adding
`Sync.hasSession()` to `isAudioLocked()` is what a reviewer would suggest, and it is wrong: that
function also decides `userAudio` in `buildBundleFor`, i.e. whether the recording rides the
upload/save bundle at all. That version silently stops PAIRED DEVICES UPLOADING THEIR OWN AUDIO —
the entire purpose of pairing — and surfaces far from its cause, as "the researcher's Drive has the
text but never the recording". `test/audio-remove-gate.test.mjs` asserts isAudioLocked stays
ignorant of pairing, for exactly this reason.

Verified in a browser on one doc, both ways: visible unpaired, hidden paired, forcing the hidden
button through deletes nothing, and buildBundleFor still yields a zip containing the audio while
paired.

## Localization: the audit is done, the DECISIONS are still yours (2026-08-07)

Nothing is broken. `test/i18n-parity.test.mjs` now enforces, on every run:
- **1273 keys in en, 1273 in id, key-for-key identical**, no duplicates in either;
- no multi-word English string sitting untranslated in the id block, with a 7-entry allowlist where
  identical IS correct, each carrying its reason.

⚠ **One of those seven is load-bearing and must not be "fixed"**: `para.csvHowRow1`
("Speaker · Start · End · Text · Glosses · Free translation") is not prose — those are the LITERAL
column headings `csv.js` auto-detects, and its patterns are English-only
(`/^(speaker|participant|who|voice)$/i` and friends). Translating that sentence would instruct an
Indonesian user to type headings that will NOT be recognised, silently losing the auto-detection it
promises and dropping them into manual column mapping with no explanation.

**A real improvement available here:** teach `csv.js` the Indonesian words (penutur, mulai, selesai,
teks, gloss, terjemahan) — THEN the sentence can be translated. Do it in that order; the test's
allowlist comment says so too. Small, self-contained, genuinely useful for the field.

Still needing your decisions, which is why the rest is not started:
- which languages beyond en/id;
- whether the id copy gets a native-speaker review pass (much of it is Claude's, not a speaker's) —
  the parity test cannot judge QUALITY, only presence;
- whether the satellites' own shell strings (`satellites/*/index.html`) are in scope; they are
  separate from the engine's i18n.js and not covered by the parity test.


## The exported `.fxpa` can go stale, and nothing says so (found 2026-08-07)

Not part of the PAT split/join feature — a separate, pre-existing risk found while planning it.

Independent of split/join, and arguably overdue: the editor exports a `.fxpa` whose line ids are
positional. Any later line-count change — Enter, Backspace, or this wizard — makes a previously
exported `.fxpa` describe a document that no longer exists, and re-importing it into PAT would
attach an analysis to the wrong lines.

The editor cannot fix that file. It can, cheaply:

- stamp the exported `.fxpa` with the doc's `modified` timestamp and line count (it already carries
  a version field), so PAT can compare on import and say "this analysis was made against 47 lines;
  this text now has 49";
- warn at export time when the doc has changed since the last `.fxpa` export.

The first is the one that matters — it puts the detection where the damage would occur, in PAT, and
does not depend on anyone reading a warning in the editor weeks earlier.


## PAT → ELAN EAF export (Seth, 2026-08-07 — "to do later")

> "The other export path that's eventually planned and on the backlog is PAT → ELAN EAF (using
> annotation segments and tiers to represent paragraph, segment, word, morpheme, proposition
> groupings), but that's also a to do later plan."

⚠ **This is the answer to the durability/lock-in question the formats discussion raised**, and it
changes that conclusion: `docs/fxed-fxpa-formats-plan.md` says PAT is TERMINAL because SSA cannot
go to FLEx. EAF is the standard format that CAN hold it — tiers and nested annotations are exactly
a bracket structure — so PAT is terminal only until this exists. Worth cross-referencing when either
is picked up.

Groundwork already in place:
- `seg-exports.js` `serializeEaf()` already emits two EAF profiles (ELAN-for-FLEx and SayMore) with
  a schema-validated `.pfsx` sidecar, and `test/seg-exports.test.mjs` covers them.
- PAT already IMPORTS `.eaf`, so the reader exists.

The design question when it comes up: ELAN tiers are *typed and hierarchical* (Symbolic Subdivision,
Symbolic Association, Included In), and the mapping from an SSA bracket — which can be asymmetric
(`heads`) and can nest arbitrarily — onto that type system is the whole job. A group with heads is
not a plain subdivision, and flattening it to one would lose the asymmetry that makes it an
analysis.

⚠ Also relevant: **NO segnum in EAFs** (standing rule), and ELAN reads display settings from a
same-basename `.pfsx` — without one, ELAN's remembered `sortAlphabetically` reorders tiers wrongly.
Both already handled by the editor's exports; a PAT exporter must not rediscover them the hard way.

## Planning notes to chew on (Seth, 2026-08-07) — `.fxed` follow-ons

### ✅ DECIDED: consent material, if it exists, MUST be included
> "Consent Material if it exists MUST be included."

Supersedes the opt-out proposed in `fxed-format-spec.md` §5.1 — **remove that checkbox from the
spec when it is implemented.** The reasoning is the stronger one: an IRB record that can be
separated from the text it documents is worse than one that travels. A `.fxed` is therefore always
a file containing personal data, and the UI should say so at export rather than offering a way to
make it not true.

### Writing systems need a JS-object twin of the XML functions — and that is a real tension
> "we'd need a JavaScript object/data/browserStorage/etc version or adaptation of those functions.
> And ideally avoid having duplicate things that could diverge easily, but also JSON/browser objects
> and XML are genuinely different things when it comes to modifying/writing especially."

Both halves are true and they pull against each other, so the resolution should be deliberate:

- `surveyWritingSystems` is a READ. It can stay XML-only if the object side derives its survey from
  `text.flextext` — one implementation, no twin.
- `remapWritingSystems` is a WRITE, and this is where a twin becomes hard to avoid: the doc object
  in `fxed.json` carries WS codes too, and rewriting XML then re-deriving the object is only safe
  if the derivation is lossless. **It is not** — `parseFlextext` keeps `preservedXML`, but a
  round-trip through serialise→parse is not proven identical.
- Suggested shape: **one pure function over a WS-code map** (`{oldCode: newCode}`) with two thin
  adapters — one that walks a DOM, one that walks the object. The decision logic lives once; only
  the traversal differs, which is exactly the part that genuinely differs. Test them against each
  other on the same input.

### Multi-text `.fxed` as an OPTION — and flextext already supports it
> "having the option of multi-text .fxed is a good idea (as an option). And the flextext format
> itself already supports this."

Right — a `.flextext` holds several `<interlinear-text>` elements. So `text.flextext` inside the zip
can carry the whole set with no format change, and `fxed.json` grows from `doc`/`media` to
`docs[]`/`media{}` keyed by doc id. Worth designing v1 so the singular case is just N=1, rather than
adding a second shape later.

### ⚠⚠ WHOLE-PROFILE EXPORT, AND THE PAIRING IDENTITY PROBLEM — the important one
> "exporting an entire browser/PWA profile (corpus/library, consent prompts, settings, and all) and
> transplanting it… but we would need to think about what to do with the pairing with the researcher
> app at that point. We shouldn't have the same pairing key/identity pointing to two duplicate app
> instances. Our whole suite system needs to guard against and handle that somehow."

**This is a suite-wide correctness problem, not a `.fxed` feature**, and it exists TODAY without any
export: anything that duplicates a profile (a browser profile copy, a device image restore, a
synced browser) already clones a session. The `.fxed` spec dodges it by refusing to carry the
session at all (§5) — a whole-profile export cannot dodge it.

Three shapes, roughly in order of honesty:

1. **Move, not copy.** The export invalidates the source's session as it writes, so only one live
   instance exists by construction. Clean, and unhelpful if the source device is already dead.
2. **Re-claim on import.** The imported profile arrives UNPAIRED with its texts intact, and the
   researcher issues a fresh invite. Safe, and costs one round trip with the researcher — probably
   the right default.
3. **Server-side detection.** The worker notices two devices presenting one identity (differing
   install ids, overlapping heartbeats) and flags it in the panel. ⚠ Needed **regardless** of
   which of the above is chosen, because profile duplication happens without our involvement — and
   because the failure is currently silent: two devices would each upload, each mark texts done, and
   the researcher would see one device behaving impossibly.

⚠ Whatever is chosen, **the researcher must be able to see it and act on it.** A duplicated identity
that only the worker knows about is the same class of problem as everything else this suite has hit
this week: true, silent, and discovered late.

## PARKED: the whole Files ▾ drop-down is HIDDEN (Seth, 2026-08-08) — supersedes the row-level park below

> "The download files function is kind of all out of whack and needs more attention. I pushed it
> before it was really working. For now let's hide that drop-down and let researchers go to Google
> Drive directly until I have time to really develop that feature."

**How:** `const FILES_MENU_ENABLED = false;` in researcher-panel.js, read by `filesMenuHtml` (which
early-returns `''`, so BOTH call sites — device rows and History rows — go dark from one flag) and by
`histHasMenu()`. Flip it to `true` to bring the whole feature back.

**⚠ Hidden, NOT deleted.** `populateFilesMenu`, `latestPerKind`, `cleanupCandidates`,
`downloadAllZip`, the `data-zipall` / `data-cleanup` handlers and all their tests stay live and
correct. Do not "clean up" the now-unreachable code — it is the feature being deferred, not removed,
and deleting it turns a one-line restore into a rewrite.

**⚠ The trap that hiding it nearly sprang.** On History rows the plain audio + last-upload links were
gated on `!(e.instanceId && e.docId)` — meaning *"the menu is showing instead of me"*. Hiding the
menu without touching that gate would have left those rows with **no link at all**, silently removing
more than the drop-down. Both now read `!histHasMenu(e)`, which is tied to the flag, so hiding the
menu restores exactly the pre-menu behaviour. `test/artifact-links.test.mjs` pins this, including
that the old raw condition is gone (leaving one behind is how a row ends up empty).

**What researchers lose meanwhile:** per-file download from a text's Drive folder, Download-all, and
the older-backup cleanup. All three are reachable in Drive itself, which is the interim answer.

**Why not replace it with an "Open in Drive" link:** the per-text folder id is not in the inventory
report — the device stamps `driveFolderId` on the doc but does not send it — so a folder link would
need the same Worker round-trip the menu already makes, and a link built from anything else would be
another link that looks authoritative and may not resolve. That is the failure being backed out of,
so it is not the fix. Reporting `driveFolderId` in the inventory is the cheap enabler if a direct
folder link is wanted before the menu returns.

**When picking this back up — the design problem to solve, not just the bugs:** the menu mixes rows
of genuinely different reliability and does not tell the person clicking which is which. Folder rows
fetch through the Worker on the researcher's stored token and work. `resolveArtifacts` rows are plain
Drive hrefs authenticated by whatever Google session the browser holds. Half a menu working is worse
than none of it working, because the failure looks like the app is broken rather than like the link
was never real. v317 (branch `fix-artifact-kinds-and-fxpa-stamp`) fixes one input to that — the
device now reports which KIND it uploaded instead of the panel inferring it — and is worth keeping
regardless, because it makes the data correct for whenever the menu returns.

## PARKED: the inferred "Bundle (.zip)" row promised a zip and delivered XML (2026-08-07)

⚠ **Superseded by the entry above — the whole menu is hidden as of v318, so this row is doubly
unreachable.** Kept because the diagnosis is still the live one, and the row-level suppression is
still what protects legacy texts if the menu is ever restored before the device-side fix ships.


Seth clicked **"Bundle (.zip, includes audio)"** in the panel's Files menu and got raw `.flextext`
XML. Row suppressed in v316; the underlying bug is NOT fixed.

**Cause — a guess that artifacts.js itself predicted.** `uploadedMap()`'s legacy branch has only the
old report's `hasAudio` flag to work with, and reasons *"the device uploads a ZIP when the text has
audio attached, a bare .flextext otherwise"*. But `hasAudio` is ALSO true when the audio is a
researcher-**ASSIGNED** Drive URL the device never uploaded — Seth's text's `media-files` block
points at `connect.flextext.app/drive?src=…`. So the device had uploaded a bare `.flextext` while
the row promised a zip with audio in it.

artifacts.js already says *"only the label could mislead"* — what it got wrong was calling that
harmless. Renaming the row to "Bundle (.zip)" in v304 made the false promise louder, not the bug
newer.

**What v316 does:** the panel skips any artifact with `inferred: true`. Costs a legacy text nothing —
the folder-listing rows above it are REAL (they come from the Drive listing) and Download-all still
fetches everything. `resolveArtifacts` is unchanged, so the model still reports the artifact and
still flags it; only the UI declines to render a guess.

**⚠ THE ACTUAL FIX is on the DEVICE, not in the panel.** `uploadedMap()` already reads an explicit
per-kind `uploaded` map (`{bundle: id, 'eaf-flex': id, …}`) — the device just does not send one yet,
so every older text falls back to the scalar `uploadedFileId` and the inference. Making the device
report per-kind ids RETIRES the inference instead of hiding it, and un-parks the row for free.
⚠ Both shapes must stay readable forever: field devices update on their own schedule.

Test: `test/artifact-links.test.mjs` pins that inferred artifacts are suppressed, that EXPLICIT
per-kind artifacts still render with their Drive ids, and that the folder-listing rows and
Download-all are untouched.

## Engine-wide drift is worth watching — and modularisation (Seth, 2026-08-07)

> "Latent drifts like that (engine wide things that are in the editor code) are worth keeping an eye
> on. Modularizing our code (shared, engine, various apps, etc) is worth thinking about doing as it
> makes sense (but carefully, and well planned/tested first)."

**The live example, found in the v315 release audit:** v305 made the editor's language picker derive
from `LANGS`, but `setup()` returns early for `RECORD_MODE` **before** `fillLangPickers()` runs — and
`satellites/text-recorder/index.html` and `satellites/crowd-recorder/index.html` each carry their own
`<select id="lang-select">` with hardcoded `en`/`id` options. Nothing is broken today because
hardcoded en/id happens to equal `LANGS` exactly. The moment a third language completes, the editor
gains it and the recorders silently do not — the gating rule leaking round the side.

That is the shape to watch for: **a rule enforced in `app.js` that the satellites reach by a
different path, or not at all.** Others of the same shape worth auditing when this is picked up:
`applyI18n` coverage, `allowedButtons`, and anything gated on `RECORD_MODE`/`CROWD_MODE` early
returns.

On modularisation: the honest constraint is that `app.js` is BOTH the editor and the satellites'
engine, and the early-return-per-mode pattern is how one file serves four apps. A split (shared
core / editor / recorder / crowd) would make drift structurally visible rather than something to
remember — but it touches every sw.js SHELL and the v108 outage is what happens when that goes
wrong. Plan and test first, exactly as Seth says.
