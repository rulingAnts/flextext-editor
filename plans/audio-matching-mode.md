# Audio Matching mode — align existing text to audio, nothing else (PLAN)

**Status: design agreed in principle (Seth, 2026-08-08), not built.** Part of the editor-fixes
cycle; the bug-list items about Enter/Space/join behaviour (see BACKLOG) are prerequisites in
spirit — this mode depends on the key discipline they establish.

## 1. The problem, in Seth's words

> *"We need an easy way for the user to do just audio segmentation/matching without disrupting
> existing glosses/free translations (other than split join). So like if they open a flextext file
> (either previously saved or sent by the researcher) that's already got work in progress, but not
> audio annotations, we need an easy way for them to split the audio and match it to existing
> baseline/gloss lines. And do that before they go back to editing. Ideally it's a separate step
> from the editor. And also VERY intuitive for low-skilled users."*

And the deliberate scope cut:

> *"Actually for THIS step, let's not include joining and splitting. Just matching the lines of
> text that already exist with audio segments."*

## 2. What it is

A **separate, guided step** — not a tab state of the editor — for exactly one situation: a doc that
has **text lines** (baseline, possibly glosses and free translations, in any state of progress) and
**attached audio**, but **no alignment**. The user listens and cuts; each cut matches the audio
heard so far to the next existing line. Text is never touched. When every line has its span, the
step is done and they land in the normal editor.

**⚠ Safe by construction, not by care:** the mode writes `doc.segments` ONLY (via `segments.js`,
same as every alignment edit). There is no text input anywhere on the screen, so glosses and free
translations cannot be disturbed — the property Seth asked for is structural, not a guard.

## 3. The screen (Seth's sketch, adopted)

- **Top: the full-recording player** — the one waveform, with the playhead.
- **Below: two columns.**
  - **Left:** the audio segments as they are created — each with its own small player, top-to-bottom
    in time order.
  - **Right:** the text lines of the doc, one row per line, in order — baseline + glosses + free
    translation rendered read-only (render on what the line HAS; blank lines show as their
    placeholder, because a FLEx-quirk blank line is a real silence span and gets matched like any
    other).
  - The **current line** (the one the next cut will complete) is highlighted; rows above it are
    matched (span on the left), rows below wait.
- **The scissors** ✂ sit at the bottom of the playhead on the top player. Clicking cuts NOW.
- **ENTER also cuts** — and this is **the ONLY place in the app where Enter acts** (Seth: "this
  should be the ONLY place where enter works"; bug item #4 removes Enter-as-play everywhere).
- **Space** = play/pause (consistent with the whole suite after this cycle's key fixes).
- **No join. No split. No text editing.** A wrong cut is corrected by **UNDO** (the new suite
  undo/redo, bug item #6): Ctrl+Z/⌘Z or the ↶ button un-cuts — removes the last boundary and steps
  the highlight back one line. That is the entire correction model, and it is one gesture.

## 4. Cut semantics (exact)

State: `cuts = [t1, t2, …]`, lines `L1..Ln` in doc order.

- Cut at playhead `t`: current line `L(k)` gets span `[prevCut, t]`; highlight advances to
  `L(k+1)`; audio keeps playing (no pause on cut — the user is listening ahead).
- Cuts are **monotonic**: a cut at or before the previous boundary (or within `MIN_SEGMENT_MS`) is
  refused with a gentle nudge, not an error dialog.
- **The last line never needs a cut**: when `k === n`, the remaining audio `[lastCut, end]` is its
  span and the mode shows Done. (Cutting n times for n lines is the classic off-by-one users hit;
  n−1 cuts is the rule.)
- **Finish early** (audio ended, lines remain): remaining lines become `timePending` — the model's
  existing state for "not known yet"; the editor's existing healing applies. Never guess.
- Progress is always visible: "line k of n", and the right column IS the progress bar.

All writes go through `segments.js` (never invent a time; monotonic clamp; `timePending` for the
rest) — this mode adds NO new mutation primitives.

## 5. Entry and exit

- **NO SKIP (Seth, 2026-08-08):** *"the user will likely click 'skip' if it's unfamiliar and then
  they don't have a way to go back and edit."* When a doc opens with (≥1 text line) AND (attached
  audio) AND (no aligned span other than seeds/estimates), the matching step IS the way in — a
  full-screen intro in the user's language with one button: Start. This matches the original
  framing ("do that BEFORE they go back to editing"); the population is already researcher-gated
  (settings.segmentation), so everyone who reaches it is meant to align.
  ⚠ The one escape that must exist is the FAILURE path, not a skip: if the audio cannot decode,
  the mode must fall through to the normal editor with a plain message — a trap that requires
  working audio to leave is worse than a skipped alignment.
- **Exit:** Done → normal editor, segmentation strips now showing the matched spans. Leaving
  mid-way keeps completed spans (they are real `doc.segments` entries) and the rest stays pending —
  re-entering resumes at the first unmatched line.
- Researcher-gated the same way segmentation is (`settings.segmentation`): this step IS a
  segmentation workflow; OFF means classic editor, untouched.

## 6. Explicit non-goals (v1)

- No joining or splitting of audio spans in-mode (undo covers the mistake case).
- No text split/join, no gloss editing, no FT editing.
- No re-matching UI for a doc that is already fully aligned (the editor's strips own that).
- No auto-alignment/VAD "smart" suggestions — this tool's value is that the human is the aligner.

## 7. Segmentation mode becomes the DEFAULT — for the right installs only (Seth, 2026-08-08)

> *"Let's have 'audio-segmentation mode' be the new default for unpaired editor apps and for NEW
> device installations (not necessarily existing ones). Let's have our Researcher panel 'up-sell'
> that feature though to researchers. Also for unpaired flextext editor instances, slightly subtly
> 'up-sell' that feature."*

Three distinct behaviours, and the middle one is the trap:

| install | behaviour |
|---|---|
| **NEW install** (first run, no stored settings) | `segmentation: true` stamped EXPLICITLY at settings creation |
| **EXISTING install** (stored settings, key absent or false) | **unchanged** — absent keeps meaning OFF, exactly as today. No silent flip on update. |
| **researcher-managed** | whatever the researcher pushes, exactly as today |

⚠ **The stamp must be explicit, not a default-interpretation change.** Existing devices store a
settings object in which `segmentation` is simply ABSENT; if the code's reading of "absent" flipped
from off to on, every installed device would flip on the next engine update — precisely what Seth
excluded ("not necessarily existing ones"). So: first-run creation writes `segmentation: true`;
the read path's falsy-means-off stays byte-identical.

**The two up-sells** (promotion, never a silent change):
- **Researcher panel**: promote the feature where segmentation is pushed from (the Buttons group) —
  a short "what this gives your transcribers" note + link to help. A researcher deciding for a
  device should know the feature exists and what it buys.
- **Unpaired editor, existing installs**: a SUBTLE nudge (Seth's word) — e.g. a one-line dismissible
  hint on the Baseline tab when a doc has audio and segmentation is off. Dismiss = never again
  (stored). No modal, no repeat nagging: these are field users mid-work.

## 8. ✅ The TRIGGER is the seed path itself (Seth, 2026-08-08)

> *"Our audio segmentation just takes those texts and splits them up randomly--average. If it can
> recognize that segmentation data/times are missing and supply them averaged out, then it can also
> recognize that they're missing, and trigger the matching mode instead, right?"*

Right — and it is ONE code path. `reconcile()` in segment-strips.js already detects exactly this
state (multi-line text + audio + no alignment) and responds with the even-division seed marked
`timeEstimated`. The Matching mode reuses that detection verbatim: same condition → OFFER the
matching step instead of silently guessing. The estimate seed remains the FALLBACK when the user
skips (strips still need spans to draw), and `timeEstimated` spans count as "unmatched" — an
estimate is a placeholder by definition, so a doc full of dashed seeds still gets the offer. This
answers old open question 3, and it covers Seth's real fleet: existing devices hold texts done
before segmentation existed, with no recorded times — those are precisely the docs the seed path
fires on today.

Also confirmed: *"undo without join may be good enough"* — the §3 correction model stands.

**And the auto-detect is a REQUIREMENT, not a nicety** (Seth): a text that was transcribed — and
maybe glossed or translated — but never segmented must be recognized on open and offered the mode,
so the user can match segments to the lines of text. The ⇥ set-boundary button was REMOVED in v323
(confusing; blast radius too big), so this mode is now the ONLY owner of the fix-up-estimates job.

**RE-segmentation on researcher request** (Seth, 2026-08-08): the researcher can mark a text for
re-segmentation — a pushed per-text command (same channel as the existing panel→device commands)
that demotes the text's spans to `timeEstimated` and re-arms the offer, so the device walks the
matching step again. Demote, don't delete: if the user dismisses, the old alignment still renders
as estimates rather than vanishing.

## 9. Open questions for Seth

1. When some (not all) lines already carry imported offsets: offer matching for just the pending
   tail, or only offer when NOTHING is aligned? (Suggest: resume-style — start at the first
   unmatched line.)
2. Should the researcher be able to REQUIRE the step (a device-setup flag pushed with the
   assignment), or is the offer always dismissible? (Suggest: always dismissible in v1.)
3. Estimated seeds (`timeEstimated`, dashed) — treat as "unmatched" for the offer? (Suggest: yes;
   estimates are placeholders by definition.)
