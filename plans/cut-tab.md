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

## The researcher settings (all only visible when segmentation is ON)

| key | default | effect |
|---|---|---|
| `cutTab` | **on** | shows/hides the Potong tab |
| `joinSplitBaseline` | **on** | may the Baseline tab join/split at all |
| `joinSplitGloss` | **on** | may the Gloss tab join/split at all |

⚠ **These are MASTER switches over the whole capability on that tab — buttons and keys alike** —
whereas v351's `backspaceJoin` gates only the keyboard shortcut. The two compose as
`allowed = joinSplit<Tab> && (usingButton || backspaceJoin)`. Turning `joinSplitBaseline` off is how
a researcher says *"segmentation happens on the Cut tab; do not re-cut while transcribing."* Order
matters in one place only: if `joinSplit<Tab>` is off, the join buttons must not render at all — a
button that silently does nothing is the failure mode the suite already has a standing rule against.

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

## OPEN DECISIONS — Seth

1. **Layout**: one big waveform with cut markers, or the Baseline-style strip list (plus a big
   player)? The brief says both ("big player, cut button below the playhead" and "looks very similar
   to … the baseline tab").
2. **Text-bearing segments**: refuse BOTH join and split, or refuse only split? A join concatenates
   two texts safely (`left + glue + right`, already implemented); a split has **no cursor on this
   tab**, so there is no defined place to divide the text — that asymmetry is real.
3. **Where does baseline text show** — caption under every texted row, or only on the current row?
4. **Does the Cut tab become the doc's landing tab** when a doc has audio and no segmentation yet?
