# One splitting rule across the editor's tabs (and the other apps)

Seth, 2026-09-06, verbatim in the parts that decide things:

> "Here's the general rule: for a more basic editing tab (cut is more basic than baseline, which is
> more basic than gloss), you cannot cut lines that already have more advanced data associated with
> them (so for example you can't cut lines on the cut tab that have baseline text on them and you
> can't split/cut lines on the baseline tab that have glosses and/or free translation filled in on
> the gloss tab).
>
> For any segment on any tab for which only that tab's level of data or below is entered/non-blank
> …, any cut that's made starts with a cut executed on any of the active tiers and immediately
> requires the user to position that cut on other tiers as well (you can start the split on any of
> the tiers and then select the other(s) in any order. For the free translation or baseline,
> enter/return positions the split on that text tier and then you have to also select it on the
> other tier(s). If you start with audio or interlinear, then you must position the cursor in the
> text box where you want to make the split and press enter. …
>
> On tabs or apps that show the full interlinear, baseline is editable by editing the vernacular
> word in a word gloss pair (and let's add that functionality to the editor's gloss tab so people
> can correct misspelled words without losing their glosses). Only on the editor baseline tab does it
> display as a single textbox control that you just type into freely. … The free translation
> line(s) should be editable as a single text box, not individual editable words. If you start the
> split on a line other than the free translation line, then the free translation (or baseline)
> input box should be highlighted with a red or orange thick border and the text cursor be slightly
> more glow-y, also with a scissors button underneath it. …
>
> Just splitting and joining needs to not work with segments that have more advanced data than the
> current tab."

Status: **designed, not built** (2026-09-06). The overview-player and grip changes decided in the
same message are built separately (v592). This document is the design to build against once the
open points at the end are settled.

## 1. Tiers and levels

A line's **data level** is the most advanced tier that is non-blank:

| level | tier that carries it | where it is edited |
|---|---|---|
| 0 | audio only | Cut tab |
| 1 | baseline text | Baseline tab (one free text box); Gloss tab (per-word, new) |
| 2 | word glosses and/or free translation | Gloss tab |

A tab's **level** is the same number: Cut 0, Baseline 1, Gloss 2.

**Rule A (cutting and joining).** On a tab of level *L*, a line whose data level is greater than
*L* can be neither split nor joined there. The Cut tab already refuses texted lines; the Baseline
tab will refuse lines that carry any gloss or free translation. Joining two lines is refused if
either has data above the tab's level. The refusal is visible before the attempt (the row is drawn
"locked", as the Cut tab already does) and worded when attempted (`cut.no.*` keys already exist).
The existing switch "cut or join lines that already have text" keeps overriding rule A for joins
on the Cut tab only, as it does today.

**Rule B (dragging a boundary).** Never gated by data level: a grip moves timing, not words. The
`adjustBoundaries` switch is the only gate (v591).

## 2. A split is one edit with one position per active tier

Active tiers on a tab, for one line:

| tab | tiers that must each receive a position |
|---|---|
| Cut | audio |
| Baseline | audio, baseline text (only if the line has text; an empty line is audio only) |
| Gloss | audio, word gap in the interlinear (only if the line has words), free translation text (only if non-blank, one box per analysis language that is non-blank) |

A split **starts** on any tier and **completes** when every active tier has a position. Nothing is
written until it completes: the document does not change while a split is pending, so leaving the
tab, opening another text, or pressing Escape cancels it with nothing to undo. When it completes,
one undo step covers the whole split.

How each tier receives its position:

- **audio**: the playhead. Enter with no text box focused, or the scissors under the playhead,
  takes the playhead's time (the Baseline tab's playhead-Enter and the Cut tab's Enter and scissors
  already do this).
- **baseline text** (Baseline tab): the caret in the line's box; Enter or the scissors under the box.
- **word gap** (Gloss tab): the scissors between two words (the existing chain-link/scissors pair).
- **free translation**: the caret in that box; Enter or the scissors under the box.

While a split is pending, every tier that still needs a position is marked: a text box gets a
thick red-orange border, a slightly glowing caret and a scissors button directly under it; the
audio tier shows a pinned dashed marker line at the current playhead on the strip with the
scissors under it; the interlinear shows its word-gap scissors highlighted. A tier already placed
shows its marker in plain colour. A small strip of text under the row says what is still needed
("Now show where the words divide" / "Now show where the sound divides"), in both languages.

Starting on a second tier before the first is placed is impossible by construction (each tier's
gesture is its own). Placing a tier again replaces its position. Escape, or the scissors of a
placed tier tapped again, cancels the whole pending split.

**Time for the new line.** The audio position must fall inside the line's span and leave at least
120 ms on each side (segments.js rules); otherwise the audio tier refuses with the existing
`cut.no.*` reasons and the split stays pending. A line without a time (`timePending`) has no audio
tier: its split is text-only, as today, and the new line is `timePending` too.

## 3. Baseline editing on the Gloss tab

Each vernacular word in a word-gloss pair becomes editable in place (a `contenteditable` cell like
the segmenter's matcher rows). Committing a changed word rewrites the line's baseline text from
its words, keeps the gloss attached to the same word index, and, if the edit adds or removes a
space, re-runs the word split for that line and re-attaches glosses by position (the same rule
`reconcileBaseline` uses today). The single text box stays the Baseline tab's editor. The free
translation stays one text box per language.

## 4. Other apps

- **Audio Segmenter**: unchanged. Its matcher shows audio and text in separate columns and its
  splits already work one tier at a time (Seth: "moot point").
- **Paragraph Analysis Tool**: to be checked. If it can split a line at all, it does so with the
  same pending model (audio, if the text carries timing; text at the caret); if it cannot, nothing
  changes there.

## 5. Where the code goes

- `docs/js/segments.js`: `splitPlan` — pure: given a line's level, the tab's level, and the
  positions received so far, say which tiers are still required and whether the split may complete;
  the existing `cutAtPlayhead` / `splitSegment` stay the writers.
- `docs/js/segment-strips.js`: the pending-split state for the Cut and Baseline tabs (one object:
  line index, positions per tier, markers), the markers on the strip and under the box, Enter and
  scissors routed through it, Escape to cancel.
- `docs/js/app.js`: the Gloss tab's version (word gap, free translation boxes), per-word baseline
  editing, rule A's lock drawing on the Baseline tab (`seg-locked` for lines with gloss data).
- `docs/css/app.css`: the pending styles (border, caret glow, scissors under a box, dashed marker).
- `docs/js/i18n.js`: the prompts and refusals, EN and ID.
- Tests: pure tests for `splitPlan`; source pins for the routing; the smoke test gets a section.

## 6. Open points (answers needed before building)

1. **Atomic or incremental?** Above, nothing is written until every tier is placed. The other
   reading of "immediately requires" is that the first tier's cut is applied at once and the line
   sits half-split until the rest is placed. Atomic is proposed because a half-split line has no
   good on-disk shape and a user who walks away leaves nothing broken.
2. **Cancel gesture.** Escape, tapping a placed tier's scissors again, switching tab, opening
   another text. Any of these to drop?
3. **Gloss tab, free translation empty.** A line with words but no free translation needs only
   audio + word gap. Confirm that an empty tier is skipped rather than required.
4. **Joins under rule A.** Proposed: refuse the join on a tab of level *L* if either line has data
   above *L*; the Cut tab's "join texted lines" switch stays the one override. Confirm.
5. **Paragraph Analysis Tool.** Does it split lines today? If so, which tiers does it show?
