# The "Potong" (Cut) tab — audio segmentation with nothing else on screen

> Seth, 2026-08-13: *"a 'Potong' ('Cut') tab BEFORE (left of) the Baseline tab that is ONLY audio
> segmenting (big player, cut button below the playhead, enter inserts a cut, backspace joins the
> current segment with the previous one and moves the playhead back to the point where they joined)
> … just an interface for cutting audio … this allows a user to focus on segmentation first with no
> distractions or trying to multi-task."*

**PLAN ONLY — not built. Several decisions still open (see the end).**

## Why this is a small feature wearing a big coat

Almost everything it needs exists. `segments.js` already owns the model and its invariants, and its
two operations are exactly the two gestures asked for:

| gesture | existing function | what it already handles |
|---|---|---|
| **Enter / Cut** | `splitSegment(segments, i, { playheadMs })` | splits at the playhead; refuses below `MIN_SEGMENT_MS`; an unaligned or too-short span yields a `timePending` half rather than a fake time |
| **Backspace** | `mergeSegments(segments, i)` | merges span *i* with *i+1*, re-normalises, clamps monotonic |

So the Cut tab is **a third view over `doc.segments`**, not a new model. That is the whole reason it
is worth building: the risky part (never invent a time, never lose text) is already written, tested,
and shared with the Baseline tab.

## ⚠ THE ONE INVARIANT THAT MAKES OR BREAKS THIS

Segmentation mode's rule is **line == paragraph == phrase == span, 1:1:1:1** (`healFlatSegments`).
`doc.segments[i]` IS baseline paragraph *i*.

**Therefore: a tab that shows no text still has to EDIT text.** A cut must insert an empty paragraph
at *i+1*; a join must merge paragraph *i* into *i-1*. If the Cut tab touched only `doc.segments`, the
counts would drift and every later index-driven edit on the Baseline and Gloss tabs would address the
**wrong line** — which is precisely the v322 field bug ("gloss join collapsed ALL segments on the
first line"), reached by a new route.

**"Shows no text" ≠ "does not touch text."** This is the sentence to keep in the implementation.

So every Cut-tab edit goes through the SAME pair the Baseline strips use —
`deps.setParagraphs(doc, paras)` (→ `reconcileBaseline`) plus the `segments.js` call — never one
without the other. Reusing `segment-strips.js`'s `mergeAt`/split path rather than writing new ones is
how that stays true by construction.

## What the user sees

A new tab **left of Baseline**, labelled with the device's app language (`Potong` in id, `Cut` in en).
It appears only when segmentation is on AND the researcher has not disabled it AND the doc has audio.

- **A large player at the top** — the existing dock player, given more height, with the whole
  recording's waveform, playhead, play/pause, ↺3s and speed.
- **A CUT button directly below the playhead**, plus **Enter** as its keyboard equivalent.
- **Below that, the segment list**: one row per span, same waveform strips as the Baseline tab, with
  per-row play — **and no text inputs at all**.
- Rows that already carry baseline text show it as **plain, uneditable caption text** beneath the
  waveform, so the user can see what is already attached without being invited to edit it.
- The current row (the one containing the playhead) is highlighted; that is what "the current
  segment" means for Backspace.

## How each gesture behaves

**Enter / Cut** — split the segment containing the playhead, at the playhead.
`splitSegment(segments, i, { playheadMs })` + insert an empty paragraph at *i+1*. Playhead stays put,
so repeated cuts walk forward naturally. If the playhead is not inside a span, or the split would
leave either half under `MIN_SEGMENT_MS`, the cut is refused with a brief reason rather than making a
sliver.

**Backspace** — join the current segment with the previous one, then **move the playhead to the
point where they joined** (i.e. the former boundary = the old `segments[i-1].end`).
`mergeSegments(segments, i-1)` + merge paragraph *i* into *i-1*. On the first segment it does nothing.

⚠ The playhead move is not cosmetic: it puts the user exactly where they need to listen to judge
whether the join was right, and is what makes join/re-cut a fast loop rather than a hunt.

## The researcher settings — 🔒 DECIDED (Seth, 2026-08-13). All visible ONLY when segmentation is ON

| key | default | effect |
|---|---|---|
| `cutTab` | **on** | shows/hides the Potong tab. ⚠ ON for existing devices too — Seth: *"Cut tab enabled by default on existing devices."* |
| `landOnCut` | **on** | a doc with audio and **no segmentation work yet** opens on Potong instead of Baseline. Seth: *"Let the researcher decide. Existing devices default to Cut tab, but the researcher has a setting for that."* |
| `joinSplitBaseline` | **on** | may the Baseline tab join/split at all |
| `joinSplitGloss` | **on** | may the Gloss tab join/split at all |
| `cutJoinTexted` | **on** | may the Cut tab JOIN two segments that already carry baseline text. Seth: *"refuse split, allow join (but give the researcher a setting to allow or disallow that)."* Splitting a texted segment is refused **regardless** — see below |

⚠ **`landOnCut` is a visible behaviour change for every existing device**, in the same class as
v351's `backspaceJoin` default: people who open a text tomorrow will land somewhere new. It is
deliberately scoped to docs that have audio AND are **not yet segmented beyond the seed** (one
whole-file span, or all `timePending`/`timeEstimated`) — landing a half-transcribed text on the
cutting screen every morning would be a different and much worse feature. A doc with no audio never
lands there, because there is nothing to cut.

⚠ **These are MASTER switches over the whole capability on that tab — buttons and keys alike** —
whereas v351's `backspaceJoin` gates only the keyboard shortcut. They compose as
`allowed = joinSplit<Tab> && (usingButton || backspaceJoin)`. Turning `joinSplitBaseline` off is how
a researcher says *"segmentation happens on the Cut tab; do not re-cut while transcribing."* If
`joinSplit<Tab>` is off the join buttons must not RENDER — a button that silently does nothing is
the failure mode this suite already has a standing rule against.

⚠ Five settings is a lot for one feature. They are all researcher-facing policy rather than
preferences, and each answers a different question, but the settings form is getting long: worth
grouping them under the existing `segmentation` group rather than adding a new one.

## 🔒 The other three decisions (Seth, 2026-08-13)

1. **Layout: big player + strip list.** A large whole-recording waveform with playhead and Cut button
   on top; the Baseline-style per-segment strips underneath, with no text inputs. Reuses
   `drawSpanWave`, `wireSegPlay` and the peaks cache unchanged — it reads as "the Baseline tab minus
   the typing", which is the point.
2. **Texted segments: refuse SPLIT, allow JOIN** (subject to `cutJoinTexted`). The asymmetry is real
   rather than cautious: a join concatenates safely (`left + glue + right`, already implemented in
   `mergeAt`), while a split has **no cursor on this tab** and therefore no defined place to divide
   the text. Refusing the genuinely undefined operation, permitting the safe one.
3. **Caption under EVERY texted segment** — plain, uneditable, beneath the strip. It is what makes the
   split refusal legible instead of mysterious: you can see at a glance which spans are transcribed
   and therefore locked.

## What is reused, and what is new

| | |
|---|---|
| **Reused unchanged** | `segments.js` (`splitSegment`, `mergeSegments`, `normalizeSegments`, `isAligned`), `segment-strips.js` peaks + `drawSpanWave` + `wireSegPlay`, the dock player, `reconcileBaseline` |
| **New** | one view (`#view-cut`), its tab button, a `cut-ui` render/edit module, three settings in both forms, i18n in en + id |
| **Touched** | `VIEWS` + `switchTab` (a fourth editor tab), `applyBaseline`'s DOM-truth guard (see below) |

⚠ **No new top-level `import` in `js/app.js` if the module is imported by `segment-strips.js`** — but
if it is imported by `app.js` directly it is **a new SHELL entry in the editor and every satellite
`sw.js`**, which is the v108 outage. Decide that deliberately at build time; the cheapest answer is
to put the Cut view inside `segment-strips.js` (it already owns peaks, strips and the merge path) and
add no new file at all.

## ⚠ Traps this will walk into if nobody names them first

1. **`applyBaseline` is gated on DOM truth** (`#baseline-text` hidden ⇒ skip), not on a setting —
   because during a live flip the setting changes before the DOM and the guard wiped a doc's text.
   Adding a fourth tab adds a fourth way for `#view-baseline` to be hidden. `switchTab` must not let
   a Cut→Baseline transition run `applyBaseline` against a stale/hidden textarea.
2. **Peaks and canvases**: strip canvases redraw via ResizeObserver + the tickers; a draw that races
   layout bakes a tiny buffer CSS then stretches into a blank slab. The Cut tab must reuse that
   machinery rather than drawing on first paint.
3. **Undo**: the Baseline strips call `deps.capture()` before structural edits. Cut and join must too,
   or the Cut tab becomes the one place edits cannot be undone.
4. **An unaligned / all-`timePending` doc**: the Cut tab is the natural place to fix one, so it must
   render `timePending` spans rather than refusing to open.

## Tests (all node-runnable — the model is pure)

- Cut at a playhead inside span *i* → `segments.length + 1` **and** `paragraphs.length + 1`, with the
  new paragraph empty and every later paragraph's text unmoved. **The paragraph count is the
  assertion that matters** — it is the invariant a text-free UI is most likely to break.
- Backspace on span *i* → counts drop by one, paragraph *i-1* text is `left + glue + right`, and the
  returned playhead equals the old `segments[i-1].end`.
- Cut refused when either half would be under `MIN_SEGMENT_MS`.
- The three settings: default on; each off hides its capability; `joinSplitBaseline: false` removes
  the join BUTTONS as well as the keys; `backspaceJoin` still gates only the keys.
- Cut tab hidden when segmentation is off, when `cutTab` is off, and when the doc has no audio.

## (spent) OPEN DECISIONS

All four resolved above on 2026-08-13. Kept as a heading only so the plan reads as settled rather
than as if the questions were never asked.


## Undo/redo — ALREADY does what Seth described (verified 2026-08-13)

> "that undo/redo history I feel like ideally would persist across tabs, it would be all changes
> made on this text, regardless of which tab … All changes made to the text data (text inserted,
> modified in a field after that field loses focus, joins, splits, etc)"

**That is the v326 design, and it is already in place.** The stack is per-DOCUMENT, never per-tab:

| change | how it is captured |
|---|---|
| **joins / splits / unchain / cut** | `captureUndo()` immediately before the edit |
| **text typed in a field** | `focusin` snapshots the doc; `focusout` → `commitFieldUndo()` pushes that snapshot **only if the value actually changed** — i.e. exactly "after that field loses focus" |
| **anything on the Cut tab** | `capture: () => captureUndo()`, since the tab has no fields |

`applyUndoState` restores **both** `paragraphs` and `segments` and re-renders through
`switchTab(activeTab)`, so a cut made on Potong is undone from Baseline and vice versa. One history,
whole text, all tabs.

⚠ `captureUndo()` calls `commitFieldUndo()` FIRST so a pending typing session is pushed before the
structural edit's snapshot — otherwise undo would replay the two in the wrong order.

### ⚠ THE ONE REAL GAP: field-level undo is gated on segmentation mode

`document.addEventListener('focusin', …)` early-returns on `!segmentationEnabled()`, so in the
CLASSIC textarea workflow a text edit creates no app-level undo entry. The browser's native textarea
undo covers it within one focus session, which is why nobody has noticed — but "all changes to the
text data, regardless of tab" is not true there yet. Small fix (the gate is one condition); worth
doing deliberately rather than by accident, because the hybrid native/app rule is subtle and
`test/undo-*.mjs` pins parts of it.

### A rough edge, not a bug

Undo while ON the Cut tab re-enters via `switchTab('cut')`, which re-runs `prepareCutAudio()`. Peaks
are cached so it is fast, but it can flicker. Rendering in place instead of re-entering would fix it.

## NEXT: "Guess Splits" — silence detection (Seth, 2026-08-13)

> "make default segment breaks for a new text … based on where the audio appears to have pauses in
> speech? How hard is that to implement? … We would want a 'Guess Splits' button at the top."

**Not hard, because the data already exists.** `ensurePeaks` computes a peaks array at 2000
buckets/second with an exact `msPerBucket`. Silence detection over that is a pure function: find runs
below a threshold lasting longer than a minimum gap, and put a boundary at the middle of each run.
~30 lines in `segments.js`, node-testable, no decode, no dependency — and it cuts on **the same array
the waveforms are drawn from**, so what it splits on is what the user sees.

⚠ **The algorithm is easy; the THRESHOLD is the actual work.** A fixed amplitude cutoff tuned in a
quiet room finds no pauses at all in a village recording with a high noise floor. Use a RELATIVE
threshold — a fraction of that recording's own median/peak level — and a minimum gap around
300–400 ms so it splits at breaths rather than between words.

Two rules it must have:
1. **Unsegmented texts only** (Seth's own framing). On a segmented text it would silently destroy
   hand-made boundaries; if ever offered there, it must confirm first.
2. **One undo step**, so a bad guess is one Ctrl+Z rather than fifty joins.
