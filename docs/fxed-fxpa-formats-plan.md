# `.fxed` and `.fxpa` — file formats and app boundaries (PLAN ONLY)

Seth, 2026-08-07: *"I think we want .fxed and .fxpa separate but similar file formats. The Editor
can export but not import .fxpa. The PAT can export and import both, but the fxed format removes the
PAT specific structure and flattens it into only objects and data that the Editor app can deal with…
There really should be no reason though, once we've got join/split, why someone WOULD want to go
from PAT back to the Editor if PAT can edit content and join and split lines too."*

Nothing here is implemented. **Two findings below change the shape of the proposal, so read those
before the matrix.**

---

## ⚠ FINDING 1: the flattened format already exists, and it is `.flextext`

`.flextext` is not merely "the Editor's format" — it already carries exactly what Seth describes
`.fxed` as carrying:

| the analyst's data | where `.flextext` puts it |
|---|---|
| baseline text | phrase `<item type="txt">` |
| words + glosses | `<words>` / `<item type="gls">` |
| free translation | `<item type="gls">` on the phrase (free line) |
| **time alignment** | phrase `begin-time-offset` / `end-time-offset` + `<media-files>` |
| notes, literal translations | preserved `<item>` children |

That is "objects and data that the Editor app can deal with", flattened, with no PAT structure —
which is the definition of `.fxed` in the brief.

⚠ **And there is a standing rule against inventing an alternative** (CLAUDE.md, Seth 2026-08-03):

> **`flextext` IS the segmentation format — no proprietary sidecar.**

`.fxed` would be precisely the proprietary sidecar that rule forbids, and it would be the *second*
one after `.fxpa`. Before building it, the question worth answering is concrete:

> **What would `.fxed` carry that `.flextext` cannot?**

Candidates I can see, and none is obviously worth a new format:

- `timePending` / `timeEstimated` flags — currently expressed as the *absence* of offsets plus a
  `~` in the visible note line. Round-trips today, if coarsely.
- The derived-WAV pointer (`<orig>.converted-NOT-ARCHIVAL.wav`) — belongs in the bundle, not the
  document.
- Editor device settings — do not belong in a text file at all.

If the answer turns out to be "nothing", then `.fxed` should not exist and the work reduces to one
missing export (see Finding 2). If there IS something, it argues for **extending `.flextext`'s
preserved items**, not for a new container.

## ⚠ FINDING 2: PAT already IMPORTS `.flextext`. The gap is that it does not EXPORT it

`paragraph-ui.js` accepts `.flextext,.eaf,.fxpa,.csv,.tsv,.txt,audio/*` and reads `.flextext`
directly. So half the proposed matrix is already built — and the other half is one export away.

**So the missing piece is not a format. It is `serializeFlextext` in PAT's export menu.**

---

## ⚠ CORRECTION: there is no PAT → FLEx, and that changes the conclusion

I argued that PAT needed a `.flextext` export so analysis could return to FLEx. **Seth: "Analysis
done in PAT actually CAN'T go to FLEx, at least not the paragraph/ssa analysis that the whole app
exists to do. FLEx won't support that."**

That is decisive, and it kills the argument rather than qualifying it. A `.flextext` export from PAT
would not be "lossy but useful" — it would drop **precisely the thing PAT exists to produce**. An
export that discards the product is not an escape hatch; it is a transcription with extra steps.

So both rationales I offered for `.fxed` are now gone:

- ~~PAT → FLEx round trip~~ — impossible in principle. FLEx has no schema for a semantic-analysis
  bracket, and will not grow one for us.
- ~~PAT → Editor round trip~~ — Seth: unnecessary once PAT can edit content and split/join.

~~**Conclusion: do not build `.fxed`.**~~ — **SUPERSEDED THE SAME DAY. Seth found the use case
neither of us had, and it is a good one:**

> *"our proprietary json format embeds the audio. Which is a useful thing to be able to do. And it is
> useful to be able to move work (with ALL text-specific browser storage) from one FlexText Editor
> app install to another (as long as the writing system codes match…)"*

⚠ **THIS IS A TRANSFER FORMAT, NOT A DOCUMENT FORMAT**, and the distinction is what makes it
legitimate rather than a third interchange format. `.flextext` remains the interchange and archival
format — the thing FLEx and ELAN read, and the thing the no-proprietary-sidecar rule is about.
`.fxed` would be a SUITCASE: one file that moves one text, entire, between two installs of the same
app. Nothing else in the suite can do that, because:

- **`.flextext` cannot embed audio.** It references a media file BY NAME (`<media-files>`), so a
  `.flextext` alone is a text that has lost its recording. `.fxpa` already embeds audio, which is
  exactly the precedent Seth is pointing at.
- **The save bundle is close but not sufficient.** The `.zip` already carries flextext + audio +
  consent receipt + EAFs, and segment times ride as offsets — so most of the *document* travels
  today. What does NOT travel is the DOC RECORD: title, created/modified, `done`, `audioSource`,
  `audioLocked`, `capture` (the recording provenance), `consentReceipt`, `driveFolderId`. Losing
  those turns a moved text into a text that looks the same and has forgotten where it came from.

### ⚠ What must NOT travel, and this is the important half

A suitcase that carries too much re-creates the two-sources-of-truth problem in a new place:

- **device settings** — the receiving install has its own, chosen for that device and that worker.
  A transfer that overwrote them would be the invite-link override, unannounced.
- **pairing / session** — a session belongs to a device, not a text. Carrying it would clone an
  identity.
- **upload queue state** — the destination has a different worker target and a different queue.

The rule that falls out: **`.fxed` carries the TEXT and its media. It never carries the DEVICE.**

### Writing systems: the capability is already built

Seth: *"as long as the writing system codes match and adding the ability to check and adjust that one
way or another isn't difficult"*. It is not difficult, because it already exists and ships in both
apps: `flextext.js` exports **`surveyWritingSystems(xmlString)`** and
**`remapWritingSystems(dom, mappings)`**, used today by the editor's Utilities checker and by the
researcher panel. An import would survey the incoming codes against the destination's settings and
offer the same remap UI that already exists — no new machinery, just a new caller.

### ⚠ One thing to decide before building: consent receipts are personal data

A `consentReceipt` carries a best-effort IP/location capture. Moving it between the researcher's own
installs is unremarkable; a `.fxed` handed to someone else is a transfer of a speaker's data. Either
the export asks, or receipts are excluded by default with an explicit opt-in — but it should not be
silent.

**Revised conclusion: `.fxed` is worth building, as a transfer format only.** The original rationales
(PAT → FLEx, PAT → Editor) remain dead; this is a different feature that happens to want a similar
container. Future plan, per Seth.

### What the lock-in concern becomes instead

The concern was real even though the answer was wrong. If no standard format can hold SSA, then the
answer is not "export to a standard" — it is **make `.fxpa` itself durable**:

- an OPEN, documented, versioned schema — `FXPA_FORMAT`, `FXPA_VERSION`, `validateFxpa()` already
  exist, and the whole engine is AGPL, so the format is readable by anyone who wants to write a
  reader;
- ⚠ what is missing is the DOCUMENT. The schema lives only in `paragraph-model.js`. For the
  SIL/Payap adopters this suite is aimed at, "here is the format spec" is the answer to "what
  happens if you stop maintaining this", and it does not exist yet. **That is the deliverable the
  `.fxed` idea was really reaching for**, and it is a page of Markdown rather than a new format.

### ⚠ AND A CONSEQUENCE WORTH FACING: PAT BECOMES TERMINAL

If the analysis can go nowhere else, then **the `.fxpa` is the only copy of work that may represent
many hours**, held in one browser origin's storage, with:

- no researcher-panel sync (that is the editor/recorder estate, not PAT);
- no upload path;
- the same "clear site data and it is gone" exposure every browser app has.

The editor mitigates this with uploads, auto-backup and the Drive estate. **PAT has none of it.**
That is not a formats question, but it is the risk the formats question was standing in front of,
and it is worth its own plan: at minimum an explicit "save your `.fxpa`" discipline, at most a sync
path of its own.

## The matrix, as it should stand

| | `.flextext` | `.fxpa` | `.eaf` |
|---|---|---|---|
| **Editor** | import ✅ · export ✅ | export ✅ · **import ✗** (correct — nowhere to put a tree) | export ✅ |
| **PAT** | **import ✅ (already works)** · export ✗ *(and no longer wanted)* | import ✅ · export ✅ | import ✅ |

**Nothing to build.** Data flows FLEx → Editor → PAT, and PAT is where analysis lives. The one
direction Seth confirmed is useful — FLEx → PAT — is already supported: `paragraph-ui.js` accepts
`.flextext` and reads it directly.

---

## Questions

1. ✅ ~~Is there something `.fxed` must carry that `.flextext` cannot?~~ **Moot — `.fxed` has no
   direction left to serve. Recommend not building it.**
2. **Is a written `.fxpa` format spec worth a page?** I think yes, and that it is what the `.fxed`
   idea was actually reaching for — the answer to an adopter asking "what if you stop maintaining
   this". Cheap: the schema already exists in code and is already validated and versioned.
3. **PAT is now terminal for analysis. What is the durability plan?** No sync, no upload, no
   backup — one browser origin holding the only copy of hours of work. This is the biggest thing
   the formats discussion surfaced and it deserves its own plan.
4. **Does the Editor's inability to import `.fxpa` need saying out loud** when a user tries? The
   file picker simply will not accept it, which reads as "broken" rather than "wrong app" — the
   same standing rule as every other disabled control.
