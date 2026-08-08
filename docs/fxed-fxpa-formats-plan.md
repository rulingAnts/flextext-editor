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

**Conclusion: do not build `.fxed`.** There is no direction it serves. If a use case appears later
it can be argued then, against this record.

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
