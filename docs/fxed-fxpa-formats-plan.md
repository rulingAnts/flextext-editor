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

## The direction that actually matters is not PAT → Editor. It is PAT → FLEx

Seth is right that once PAT can edit content and split/join, nobody needs to go back to the Editor
*to keep working*. But that is not why the export matters:

1. **FLEx is the destination.** The analyst's work has to land back in FLEx, or in an archive that
   accepts a standard format. `.flextext` is what FLEx imports; `.fxpa` is not, and never will be.
   Without a `.flextext` export from PAT, **analysis done in PAT can never return to FLEx** —
   which makes PAT a place where work goes and does not come back.
2. **`.fxpa` is a lock-in risk.** It is our JSON, read by one app we maintain. If PAT is abandoned,
   unavailable offline, or broken by a bad release, a `.fxpa`-only analysis is stranded. A standard
   export is the insurance policy — and for the SIL/Payap adopters this suite is aimed at, "can we
   get our data out without your software" is a procurement question, not a nicety.
3. **The Editor is a fine consumer, incidentally**, since it already opens `.flextext`. That falls
   out for free rather than being designed for.

⚠ **The lossy direction must be labelled as lossy.** A `.flextext` exported from PAT necessarily
drops the tree and the propositions — there is nowhere in FLEx's schema to put a semantic-analysis
bracket. So the export must say so ("groups and propositions are not carried into FLEx; keep the
`.fxpa` as the analysis of record"), and PAT should keep the `.fxpa` alongside rather than treating
the export as a save.

---

## The matrix, if `.fxed` is dropped

| | `.flextext` | `.fxpa` | `.eaf` |
|---|---|---|---|
| **Editor** | import ✅ · export ✅ | export ✅ · **import ✗** (Seth: correct — the Editor has nowhere to put a tree) | export ✅ |
| **PAT** | import ✅ · **export — THE GAP** | import ✅ · export ✅ | import ✅ |

One cell to fill. `serializeFlextext` is already pure and lives in `flextext.js`, which PAT loads.

## The matrix, if `.fxed` is kept

Then it needs a purpose the table above cannot serve, and a written answer to "why not extend
`.flextext`". If that answer exists it should be recorded here before any code — a third format in
a suite that already has two is a permanent tax on every export path, every test, and every
adopter's documentation.

---

## Questions

1. **Is there something `.fxed` must carry that `.flextext` cannot?** If yes, what — that is the
   whole decision. If no, I would drop `.fxed` and add the PAT `.flextext` export instead.
2. **Should PAT's `.flextext` export be "Export for FLEx"** rather than "Export .flextext"? It names
   the actual purpose, and makes the lossiness warning land where it is understood.
3. **Does the Editor's inability to import `.fxpa` need saying out loud** when a user tries? Right
   now the file picker simply will not accept it, which reads as "broken" rather than "wrong app" —
   the same standing rule as every other disabled control.
