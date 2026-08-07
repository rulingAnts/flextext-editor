# Splitting and joining segments — design (PLAN ONLY, not built)

Seth, 2026-08-07: a guided split ("divorce court") that asks where to cut the **audio**, the
**interlinear line**, the **free translation**, and the **daughter elements**, plus the inverse
join — *"the main thing is to make sure not to skip intervening 'gap' (like unannotated audio space)
or silent/empty line/hidden audio… so that whatever happens audio and written data don't end up out
of sync."*

Nothing here is implemented. Open questions are at the end and I do have several.

---

## What already exists, and why this is not a rewrite

Segmentation mode already splits and joins — Enter breaks text at the cursor and time at the
playhead; Backspace/Delete merges. `segments.js` has `splitSegment`, `mergeSegments`,
`boundaryAtPlayhead`, `normalizeSegments`, `syncToLines`, and they hold the ordering invariants.

**This feature is a WIZARD OVER THOSE PRIMITIVES, not a replacement.** What Enter cannot do is make
four independent decisions at once — it splits text at one point and time at another and guesses
the rest. That is fine while transcribing and wrong when repairing an already-glossed line, which is
exactly when a mistake is expensive.

## The model, because the whole design turns on it

```
doc
├── paragraphs[]      { guid, segments[] }
│   └── segments[]    PHRASES: { attrs{guid}, baseline, words[], free, freeLang,
│   │                            preItemsXML[], postItemsXML[] }
│   └── words[]       { guid, punct, phrase, txt, gls, preservedXML[] }
│                       ⚠ preservedXML = morphemes, POS, unknown children — the DAUGHTER TREE
└── segments[]        TIME SPANS, one per paragraph: { start, end, timePending?, timeEstimated? }
```

⚠ **`doc.segments` and `doc.paragraphs` are parallel arrays indexed together** — in segmentation
mode one line = one paragraph = one phrase = one time span. **Everything Seth is worried about is
this one fact.** A split must add exactly one entry to BOTH arrays; a join must remove one from
BOTH. If an operation can ever fail halfway, every line below the edit is attached to the wrong
audio — silently, and the text still looks perfect.

**So: the operation is computed as a whole new `{paragraphs, segments}` pair and swapped in with one
assignment.** No in-place `splice` on either array. A thrown exception then leaves the doc exactly
as it was rather than half-edited. This is the single most important rule in the document.

---

## Split — the four questions

Modal, one screen, four blocks; each pre-answers itself from the current playhead/caret so the
common case is "looks right, confirm".

### (a) Where in the audio
The segment's waveform at full width with a draggable handle, the ⇥ set-boundary control, and
nudge buttons (±10 ms / ±100 ms). Live "play just the left part / just the right part" — the only
way to actually judge a cut.

Constraint: `seg.start < t < seg.end`, strictly. Not equal to either — a zero-length span is a
segment that can never be played, selected, or repaired.

If the segment is `timePending` (never aligned), **the audio block is disabled with a reason**, per
the standing rule: the text can still be split; the two halves are both pending afterwards.

### (b) Where in the interlinear line
The words as clickable chips with insertion points between them. **Word-level only** — a word is the
unit that carries a gloss and a morpheme tree, and splitting inside one orphans all of it.

If the user genuinely needs to break a word, that is a different operation (split the word first,
then the segment) and the modal should say so rather than silently allowing it.

`baseline` is regenerated from the resulting `words` on each side, never string-sliced independently
— two representations of the same thing must not be edited separately.

### (c) Where in the free translation
A caret position in the free-translation text, defaulting to proportional to the word split.

⚠ **Free translation does not align to words, and pretending otherwise is the trap here.** A free
translation is a whole-utterance rendering; its clauses may be in a different order than the
vernacular. So the wizard must offer, plainly:

- **split at the caret** (default when there is an obvious clause boundary);
- **keep it all on the first half** and leave the second empty;
- **copy it to both** and let the user trim later — honest for a tight couplet;
- **leave it on the first half and flag the second** for review.

Whatever is chosen, the ORIGINAL free text is preserved verbatim in the undo record.

### (d) Daughter elements
Two different problems that the UI must not conflate:

1. **Word-level daughters** (`word.preservedXML` — morphemes, POS, anything FLEx put under the
   word). These travel with their word automatically once (b) is decided. **No question needed**,
   and asking one would invite a wrong answer.
2. **Phrase-level items** (`preItemsXML` / `postItemsXML` — notes, literal translations,
   other-language free translations). These belong to the *phrase*, and after a split there are two
   phrases. They cannot be divided by any rule the app can know.

For (2), the honest default is **keep with the first half**, with a per-item toggle to move it to
the second or duplicate it, shown only when such items exist — which for app-authored texts is
never, and for FLEx-imported ones is the whole reason this feature is being asked for.

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

**Rule 5 — refuse when the range contains a `timePending` segment**, or join text only and mark the
whole result pending. Mixing an aligned and an unaligned span produces a span whose boundaries are
partly invented, which the model is specifically built never to do.

---

## Undo

⚠ **A wizard that gets it wrong is worse than no wizard**, because the user will have accepted it.
So: one undo record per operation, holding the complete pre-operation `{paragraphs, segments}`
slice, restorable with one click from a toast that persists ~30 s. Not a general undo stack —
scoped to this feature, where the risk is.

## Where it lives

- `docs/js/segments.js` — extend the primitives; keep it pure and node-testable.
- New `docs/js/segment-splitjoin.js` — the pure planner: takes the doc slice + the four decisions,
  returns a new slice. **No DOM.** This is what gets tested exhaustively.
- `docs/js/segment-strips.js` — the modal and the wiring.
- ⚠ A new top-level import in `app.js` is **a new SHELL entry in the editor AND all three satellite
  `sw.js` files, in the same commit** (the v108 outage). Importing it from `segment-strips.js`
  instead avoids that entirely — prefer that.

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
5. **The `.fxpa` question**: if a text has an associated Paragraph Analysis file, a split changes
   the line count under it. Do we (a) refuse while one exists, (b) do nothing and let the `.fxpa`
   go stale, or (c) update it? This one genuinely needs your call — (c) is a large amount of work
   and (b) is a silent inconsistency.
6. **Is there a maximum sensible range for a join?** Guarding against a fat-fingered "join lines
   1–400" seems worth a confirmation step at some threshold.
