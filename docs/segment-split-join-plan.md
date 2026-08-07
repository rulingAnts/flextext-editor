# Splitting and joining units in the PARAGRAPH ANALYSIS TOOL — design (PLAN ONLY, not built)

> ## ⚠⚠ SCOPE: PAT ONLY. THE EDITOR'S SPLIT/JOIN ALREADY WORKS AND IS NOT TO BE TOUCHED.
>
> Seth, 2026-08-07: *"the editor's split/join ALREADY WORKS!!! Don't mess with that!!! This is a
> split/join function for PAT ONLY we're talking about."*
>
> Enter/Backspace in the editor's segmentation mode split and join today, correctly, and are not in
> scope for anything in this document. `docs/js/segments.js` and `docs/js/segment-strips.js` are
> **not to be modified** by this feature.
>
> **NOTHING HERE IS IMPLEMENTED.** As of v310 the only files this plan has touched are this document
> and the version stamps.

Seth's original brief: a guided split ("divorce court") that asks where to cut the **audio**, the
**text line**, the **free translation**, and the **daughter elements (propositions)**, plus the
inverse join — *"the main thing is to make sure not to skip intervening 'gap' (like unannotated
audio space) or silent/empty line/hidden audio… so that whatever happens audio and written data
don't end up out of sync."*

---

## What PAT has today

`docs/js/paragraph-model.js` is pure and node-tested, and already has:

- `splitLine(data, id, at)` — splits the baseline at a character offset, inserts the new line
  immediately after, and ⚠ **already handles group membership** ("the new line must join its
  sibling's group, or a split inside a bracket would silently drop half the text out of the
  analysis"). It does **not** handle propositions.
- `deleteLine`, `addLine`, `setLineText`, `addProp`, `checkInvariants`, `repairDocument`.

So this feature is **a wizard over `splitLine`, plus the proposition handling `splitLine` lacks,
plus a join that does not exist yet.**

## The model

```
data.lines[]   { id: 'L1', baseline, words[] }        ← owns the audio span
data.tree[]    { id: 'G1', children: ['L1','L2'], heads?: [...] }
propositions   id 'L1p2'  ⚠ THE ID ENCODES THE LINE (isPropId /^L\d+p\d+$/,
                              lineOfPropId('L1p2') === 'L1')
```

⚠ **A proposition has no time of its own — it inherits its line's**, because the LINE owns the audio
span. That is why playback highlights lines, and it is why a split that moves propositions between
lines silently re-times them.

**The whole operation is computed as a new `data` object and swapped in with one assignment** — no
in-place mutation of `lines` or `tree`. A throw then leaves the analysis exactly as it was rather
than half-edited. `paragraph-model.js` is already written this way (`{ ...data, lines, tree }`), so
this is following the existing grain, not imposing something new.

---

## Split — the questions

### (a) Where in the audio
Only meaningful if the line is time-aligned. The `.fxpa` carries the audio and per-line offsets, so
the wizard shows the line's waveform with a draggable handle and "play left / play right".

Constraint: strictly inside the span. A zero-length span is a line that can never be played.

If the line has no times, the audio block is **disabled with a reason** — the text still splits, and
both halves stay untimed.

### (b) Where in the text line
`splitLine` already takes a character offset. The wizard should offer **word boundaries** as the
click targets rather than a raw caret, because a split inside a word is almost never what is meant —
while still allowing a raw offset for the case where it is.

### (c) Where in the free translation
⚠ **Free translation does not align to words, and pretending otherwise is the trap.** Its clauses may
be ordered differently from the vernacular. Offer, plainly:

- **split at the caret** (default when there is an obvious clause boundary);
- **keep it all on the first half**, second empty;
- **copy to both** and trim later;
- **first half only, flag the second** for review.

The ORIGINAL free text is preserved verbatim in the undo record whatever is chosen.

### (d) Daughter elements — the Paragraph Analysis tree

Seth: *"the daughters I meant were other group members, like propositions. But maybe it's only the
virtual, manually added propositions that would add a problem here…?"* — right, and the reason is
sharper than "they are manual". Two facts make this the hardest part of the feature:

1. **Propositions are AUTHORED, not derived.** `addProp(data, lineId, text)` — the analyst types a
   semantic decomposition. SSA is semantic, not grammatical, so a proposition's text is not a slice
   of the baseline and there is **no mechanical mapping from a character offset to "which
   propositions go left"**. The app cannot infer this. Only the analyst knows.
2. **When a line gains propositions, THE PROPOSITIONS REPLACE THE LINE IN THE TREE** — `data.tree`
   references `L1p1`, `L1p2`, and no longer `L1` at all. So a split does not just move text; it must
   rewrite tree membership for ids that are about to be renamed.

**Therefore block (d) is an ASSIGNMENT, not a cut point.** When the line has propositions, show them
as a list with a left/right toggle each, defaulting to all-left. When it has none — the common case,
and always for texts with no `.fxpa` — **the block does not appear at all**.

⚠ **Propositions moved to the tail must be RENUMBERED into the new line's namespace** (`L1p3` →
`L7p1`), and **every reference rewritten in the same operation**: `tree[].children`, `tree[].heads`,
and anything else holding an id. A rename that updates the proposition but not the `heads` array
leaves an asymmetric group pointing at an id that no longer exists — and that is exactly the class
of bug that has already cost two bad guesses in this area (v230, v232).

**The safety net that makes this tractable:** `paragraph-model.js` already exports
`checkInvariants(data)` and `repairDocument(data)`. So the rule is:

> The planner produces a candidate `.fxpa`, runs `checkInvariants()` on it, and **refuses to commit
> if it does not pass**. The user sees "this split would break the analysis: <reason>" and nothing
> changes.

That converts a whole family of silent tree-corruption bugs into a visible refusal, which is the
only acceptable outcome for a structure the analyst has invested hours in. `repairDocument()` is
NOT run automatically — repairing a tree the user did not ask to change would hide the very problem
the check just found.

⚠ **`attrs.guid`**: the first half KEEPS the original guid, the second gets a new one. Reversing
that would silently re-point any external reference (an EAF annotation id, a `.fxpa` node) at the
wrong half.

---

## Join — the inverse, and the dangerous one

Seth's instruction is the whole specification: **never skip what lies between.**

**Rule 1 — only ADJACENT entries may join.** Selecting lines 3 and 7 must not produce a span from
3's start to 7's end while 4–6 keep their own (now overlapping) spans. Either refuse, or offer
"join all of 3–7" explicitly. Recommend: the modal takes a RANGE, not a pair, and shows every line
in it including the ones the user did not think about.

**Rule 2 — blank lines in the range are real, timed spans.** A blank line is silence that was
deliberately given a duration. Joining across one absorbs that silence into the merged audio, which
is usually right (the audio is contiguous) but must be *stated*: "this will also absorb 2 silent
lines (4.1 s)". Never drop them from the count as if they were nothing.

**Rule 3 — a gap between `a.end` and `b.start` joins into the result.** The merged span is
`[first.start, last.end]`, so any unannotated audio between them is now inside the segment. That is
the only coherent answer — a segment is a contiguous span — but the wizard must show the total
duration gained so nobody merges a 30-second gap by accident.

**Rule 4 — concatenation order is array order**, and text joins with a single space (or nothing
after an opening punctuation word). Free translations join with a space; empties collapse rather
than leaving "  ". Phrase-level items concatenate in order, first half's first.

**Rule 5 — propositions merge into ONE namespace, in order.** Joining L1 (props p1,p2) with L2
(props p1,p2) gives L1 with p1,p2,p3,p4 — L2's renumbered — and every `tree[].children` /
`tree[].heads` reference rewritten in the same operation. Order is array order; reversing it
reorders the analyst's semantic decomposition silently.

**Rule 6 — ⚠ REFUSE when the lines being joined sit in DIFFERENT groups.** The merged line is one
unit and cannot be a child of two brackets. Merging the groups is a decision about the ANALYSIS, not
about the audio, and the wizard must not make it — say which groups conflict and let the analyst
resolve the tree first. `checkInvariants()` would catch it afterwards, but refusing up front is a
better error than an undoable one.

**Rule 7 — refuse when the range contains a `timePending` segment**, or join text only and mark the
whole result pending. Mixing an aligned and an unaligned span produces a span whose boundaries are
partly invented, which the model is specifically built never to do.

---

## Undo

⚠ **A wizard that gets it wrong is worse than no wizard**, because the user will have accepted it.
So: one undo record per operation, holding the complete pre-operation `{paragraphs, segments}`
slice, restorable with one click from a toast that persists ~30 s. Not a general undo stack —
scoped to this feature, where the risk is.

## Where it lives

- `docs/js/paragraph-model.js` — extend `splitLine` for propositions; add `joinLines`. Pure and
  already node-tested, which is where the invariants belong.
- New `docs/js/paragraph-splitjoin.js` — the pure planner: takes `data` + the decisions, returns a
  new `data`. **No DOM.** This is what gets tested exhaustively.
- `docs/js/paragraph-ui.js` — the modal and the wiring.
- ⚠ **NOT `segments.js` and NOT `segment-strips.js`** — those are the editor's working split/join,
  which already works and is out of scope.
- ⚠ A new module must be imported by **`paragraph-ui.js`**, not by `app.js`. A new top-level
  `app.js` import is a new SHELL entry in the editor AND all three satellite `sw.js` files in the
  same commit (the v108 outage). PAT's own `sw.js` still needs the new path in its SHELL — it
  deploys atomically with its engine copy so it cannot 404, but a missing entry leaves it dead
  offline.

## Order of work

1. The pure planner + tests (split/join, gaps, blanks, guid rules, pending). No UI.
2. Join first — it is the operation with the data-loss risk, and the simpler UI.
3. Split wizard, blocks (a)–(c).
4. Block (d), phrase-level items — only worth it once a real FLEx-imported text is on hand to test.
5. Undo.

---

## Questions I need answered before building

1. **Does this replace Enter/Backspace, or sit alongside?** I assume alongside — Enter stays the
   fast path while transcribing, the wizard is for repairing already-glossed lines. Confirm, because
   it changes whether the wizard needs to be fast.
2. **Where is it invoked from?** A per-strip "⋯" menu, a toolbar button, a long-press? The strips
   are already dense on a phone.
3. **Split across a paragraph boundary** — is a segment ever more than one phrase in practice? The
   model allows `paragraphs[].segments[]` to hold several, but segmentation mode assumes one. If
   FLEx imports can bring in multi-phrase paragraphs, the wizard has a fifth question and the
   parallel-array invariant needs restating.
4. **Gloss tab parity** — should split/join be reachable from the Gloss tab too, or only Baseline?
   The gloss tab already has join buttons.
5. ~~The `.fxpa` question~~ — **ANSWERED by your clarification: (c), update it.** That is what
   block (d) now is. Two things I still need from you:
   - ✅ **"All propositions stay with the first half" is the default** (Seth) — "a good default as
     long as it is just a default", so every proposition is individually overridable.
   - ✅ ~~Should a split be offered while the `.fxpa` is open in PAT?~~ **Moot — the premise was
     wrong.** The editor holds no `.fxpa` and PAT is a separate origin, so there is no shared live
     state to desynchronise. What replaces it is the staleness problem above, which is about a FILE
     going out of date, not about concurrent editing.
6. **Is there a maximum sensible range for a join?** Guarding against a fat-fingered "join lines
   1–400" seems worth a confirmation step at some threshold.
