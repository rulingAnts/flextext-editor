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

## v357 — the test-drive round: ONE waveform, clickable strips, and a view that stays put

Seth's v356 test drive, 2026-08-13. Six findings, all in the same family: **the tab looked right and
was not usable**, because the things a cutter actually does had been given to the wrong element.

| finding | what shipped in v354–v356 | v357 |
|---|---|---|
| *"there's TWO waveform displays … I don't want that"* | the tab drew its OWN whole-file overview (`#cut-big`) above the dock player, which was already showing the same audio | the overview is **gone**. The dock player carries the cuts as **light-grey dotted 2px marks** (`Player.setBoundaries`) |
| *"I can't click on individual segment waveforms … the second big waveform is the one I can click"* | the strips were never wired to the pointer at all; only the overview seeked | the Baseline strips' click-to-position/drag-to-scrub is now **one shared `wireWaveSeek`**, used by both tabs |
| *"every cut … the page jumps back up to the top"* | `renderCut` rebuilt the list wholesale; emptying it collapses the page height, so the browser clamps the scroll to the top | the rebuild is bracketed: scroll offset **and** the edited row's own screen position are restored |
| *"spacebar to play/pause doesn't work"* | the global Space handler stands down on any focused BUTTON — and on this tab focus is nearly always on one (the tab button that got you here, a row's ▶) | the Cut tab **owns Space**, with `preventDefault` so the focused button cannot also fire. The global handler defers |
| *"playback … keep going through segment boundaries … on the cut tab only"* | every play was span-limited (`playSpan`), so it stopped dead at each cut | `Player.playThrough` — no span watcher. **Cut tab only**; Baseline and Gloss keep `playSpan` |
| *"the grayed out part should only be parts that have text … right now our setup is the opposite"* | every strip drew in the same working blue; grey meant nothing | a texted (⇒ uncuttable) strip draws in `LOCKED_WAVE` grey and its row recedes. Grey means locked, and only that |

Also decided in the same round, **reversing a v356 decision**: Backspace on the Cut tab is now gated
on `backspaceJoin` like everywhere else (Seth: *"joins … with join buttons or backspace if backspace
to join is enabled"*). v356 had exempted this tab because there is no text box to Backspace inside
of, so a join could not be an accident — but the setting is the researcher saying *this key does not
join on this device*, and one tab reaching around it is the drift the setting exists to prevent.
⚠ `backspaceJoin` **defaults OFF**, so out of the box the Cut tab joins by the ⤙⤚ buttons only; the
hint text switches to `cut.hintNoJoinKey` and names the button, so the screen never promises a key
that does nothing.

⚠ **Why the marks go inside wavesurfer's shadow-DOM wrapper, positioned in per cent**: the wrapper is
the full ZOOMED width and scrolls with the waveform, so a percentage is the same instant of audio at
every zoom level. Marks laid over the container would slide out of register the moment anyone touched
the zoom slider. The corollary is that app.css cannot reach them — those styles are inline in
`audio.js` deliberately, and "tidying" them into the stylesheet would silently unstyle them.

## v358 — what a preflight review found in v357, before it reached staging

v357 was reviewed by four independent readers (blast-radius across the suite, runtime correctness,
release integrity, settings/i18n) before the push to `staging`, and every finding was then handed to
two skeptics whose job was to REFUTE it. Twelve findings; one survived both skeptics unanimously.
The rest were mostly refuted as *"pre-existing, not a regression"* — a fair verdict about the diff,
and the wrong reason to leave them alone when the behaviour they describe defeats the thing Seth had
just asked for. Fixed in v358:

| what | why it mattered |
|---|---|
| **Boundary marks survived a document switch** (the one unanimous finding) | `destroyWs()` dropped the layer but kept `_bounds`, and `'ready'` re-drew it. The Player is a SINGLETON: cut text A, press Back, open uncut text B, and B's waveform wore A's cuts — for the whole of B's decode, which on a phone with a long recording is many seconds. Boundary times mean nothing outside the file they were measured in, so a destroyed waveform now forgets them, and the ticker re-pushes if a reload takes them away |
| **The Cut tab's keys were taken from every control on the page** | Enter/Backspace/Space are claimed at DOCUMENT level (that is what makes them work with focus on the tab button). A Send/consent/record dialog sits OVER this tab with `activeTab` still `'cut'`, so Space on the dialog's own button started the recording playing behind it and Enter cut the audio. `cutKeysApply()` now bounds the reach: an open `.modal` keeps its keys, controls outside the tab's surface (the Cut view + the dock player + the tab button) keep theirs |
| **Entering the tab left a live span watcher armed** | The most ordinary route to this tab is "listen to a line on Baseline, come over to re-cut it" — and that line's `playSpan` watcher was still armed, so playback paused at its end. On the one tab whose whole promise is that playback runs on through the cuts |
| **Undo still threw the view to the top** | Same complaint as the cut jump, by another route: `applyUndoState` re-enters through `switchTab('cut')` → `prepareCutAudio`, which hid `#cut-main` to show "Loading…", collapsing the height and clamping the scroll. Re-entry for the SAME doc no longer hides anything — which also removes the undo flicker this plan predicted |
| **The dock ZOOM slider ate Space** | Fiddle with zoom, press Space, nothing happens: a second way for "spacebar doesn't work" to be true. A range input has no native Space behaviour, so it no longer blocks the key. `<select>` (the speed picker) still does — Space opens its list |
| **A pushed `backspaceJoin` left the hint lying** | The hint names the key or the button depending on the setting, and a researcher push lands mid-session. `applyCutHint()` is now called from `applyLiveSettings` as well as on tab entry. The setting's own researcher-facing note also says, at last, that it covers the Cut tab |

⚠ **Left deliberately alone**: on the Baseline tab a dimmed/quiet strip means EMPTY, while on the Cut
tab grey means HAS TEXT — the same visual reading for opposite states. That is a real inconsistency,
but Seth asked for the Cut tab's meaning specifically, and changing Baseline's is a shipped-tab
change nobody has asked for. Worth raising before it is discovered.

## v359 — the two transports, split back apart (Seth, 2026-08-13)

> *"If the user clicks a segment play button, play-through behavior shouldn't happen. The segment
> play button should play only the segment. But spacebar or the big player play button will play
> through."*

v357 gave the row buttons play-through as well, which collapsed two different questions into one
control and left no way to hear a single span in isolation. Split back:

| control | question it answers | how |
|---|---|---|
| a row's **▶** | *is this span right?* | `wireSegPlay` → `playSpan` — the SAME wiring as Baseline and Gloss, so "play this line" means one thing across the suite. Stops at the span's end and rewinds to its start |
| **Space** and the dock's **⏵** | *does this seam sound right?* | `playThrough` — no span watcher, runs on through every cut |

⚠ The Cut tab still DISARMS any watcher on entry (v358), and that is not in tension with this: the
watcher a row button arms is one the user asked for on THIS tab, while the one carried in from a
Baseline line still playing is left over from another tab and would stop playback at a boundary
nobody chose. Both browser assertions are kept, from the same parked position just inside a seam:
the row button stops (▶), Space runs on to 0:14 past the 12s boundary.

## v360 — placing the playhead means "here", and a text opens where you left it

Three more from the same test drive, two of which deliberately reach BEYOND the Cut tab.

**Clicking a player pauses it.** Seth: *"if the user clicks on a player at all (to place a playhead)
playback should pause. And I think that probably should apply on the baseline and gloss tabs as
well."* A click used to move the playhead and let the audio run straight on from it, so the spot the
user was aiming at had already slid away before they could cut at it. Now every place a playhead can
be placed pauses first: the strips on all three tabs (one shared `wireWaveSeek` — the gloss tab's own
copy is gone, which is why this needed writing only once) and the whole-file player, via a new
`onSeekInteraction` hook. ⚠ It listens for wavesurfer's **`interaction`** event, which fires ONLY for
a click or drag on the waveform; `seeking` would also fire for the app's own `seekMs` calls and would
pause the player in the middle of doing what it had been told.

**A seek on the big player brings that line into the middle.** *"If they select somewhere on the
[big player] that is off screen, it should auto scroll to that line so that it's in the middle of the
view window."* This is the other half of "the one overview and the strips stay in sync": seeking is
how you find your place in a long recording, and landing there with the line off screen leaves you
hunting for the row you just chose. ⚠ Implemented as a REQUEST (`requestReveal`) that each tab's own
ticker honours with the row IT has decided holds the playhead — three correct implementations reused
rather than a fourth that would drift. It expires after 1.5s, so a seek into a `timePending` span
cannot fire a surprise scroll minutes later.

**Which tab a text opens on**, in Seth's own order:
1. the last tab used in THAT text (remembered per text, on the record — not on `doc`, which is the
   flextext model and gets serialised into the export);
2. failing that, and only when there are **no words yet**: the Cut tab if enabled, else Baseline.

⚠ (1) beating (2) is the point of it. Without the memory, a text with no words — every text at the
start of the job — would drag the user back to Cut every time they opened it, however many times they
had left for Baseline. A remembered tab is still subject to the gates: the researcher can turn the Cut
tab off after a device has already used it.

### Two more from the v359 review, in the same release

- **A cut during an audition left a stale span watcher.** `playSpan` captures its stop time and its
  rewind-home when the button is pressed, so auditioning a line and then cutting it — listen and cut
  on the fly, the tab's core loop — paused playback at the OLD boundary and threw the playhead back
  to the OLD start. `cutHere` drops the watcher.
- **v358's disarm-on-entry was too broad**: it fired on every re-entry, including the undo/redo
  re-render, silently cancelling an audition the user had just started. Now scoped to arrivals from
  another tab (`fromTab !== 'cut'`), which is the case it was written for.

## v362 — the spacebar jam on Baseline and Gloss: it was FOCUS, not the player

Seth, testing v358 on staging: *"spacebar to play/pause is jammed and doesn't work (the page
glitches/appears to re-render and nothing plays) until I click the big player and then click the
segment player again. Same on the gloss tab."* And: *"The cut tab works flawlessly with spacebar."*

**The cause was in the report all along.** You arrive on a tab by CLICKING ITS TAB BUTTON, so the
button keeps focus — and the global Space handler stood down on *any* focused button (v322's rule: a
focused button Space-clicks itself natively, so handling it too would double-toggle). So Space went
to the tab button, `switchTab` re-rendered the list — **that is the "glitch"** — and nothing played.
Clicking the big player cured it only because that moved focus to `<body>`. The Cut tab was flawless
because v357 had already given it a focus-independent handler.

⚠ **The v322 rule was right about ordinary buttons and wrong about this one.** Re-opening the tab you
are already on is worth nothing; playing the audio is the entire point of the key. So the blanket
"any button" exemption is gone, replaced by the bounded rule the Cut tab was already using, now
shared by both handlers (`transportKeysApply`):

| focus is on… | who gets Space |
|---|---|
| a text field, a `<select>` | the field — a transcriber typing a space must get a space |
| anything inside an open `.modal` | the dialog, full stop |
| a control outside the editor's surface (topbar Save, Done—send, ⟵ Back) | the control |
| **a tab button** | **the transport** — this was the jam |
| a strip's ▶, a ⤙⤚ join, ✂, the dock's own controls, the zoom slider | the transport |

⚠ A pleasant side effect: Space can no longer re-fire a DESTRUCTIVE button. Focus sits on ✂ or ⤙⤚
the instant after you use one, and a native re-click there would cut or join again with no gesture
from the user.

⚠ **Found by reproducing it, not by reading.** Three earlier hypotheses (an autoplay-policy failure,
wavesurfer's `interaction` event firing for our own seeks, a stale span watcher) were each tested in
Chromium against BOTH the staging build and the current tree, and each was wrong — the builds behaved
identically. Only scripting the actual user path — click the tab button, then press Space — showed
it. `test/browser/cut-tab.playwright.mjs` now drives exactly that, on Baseline and Gloss, and checks
that the topbar's own buttons keep their Space.

## v363 — what the v360/v361 preflight review found

Same four-lens review as before v357 shipped, run before this batch went to staging. The findings
that mattered, in descending order of what they would have cost a field user:

| finding | why it was real |
|---|---|
| **`guessSplits` converted frame indices back to time with the NOMINAL 10ms** | `peakPlan` CEILS buckets, so a 44.1kHz recording gives `msPerBucket ≈ 0.5215` and a "10ms" frame is really 9.909ms — ~1% drift, about **20 seconds by the end of a 40-minute recording**, every boundary landing earlier than the pause it was measured at. ⚠ **My own test could not see it**: every synthetic case used 16kHz, where `msPerBucket` is exactly 0.5 and the nominal value is right. Case (g2) now uses a real 44.1kHz value, and was checked BOTH ways — 305ms drift at 35s in with the old conversion, 6ms with the fix |
| **The Guess guard read only the phrase BASELINE string** | a document whose baselines are blank but which carries words, glosses or free translations would have been re-cut and part of its work destroyed. `docHasWork()` now looks at words, glosses and free translations too. Import fills the baseline from the words, so the two agree in practice — this is the belt to that braces, on a path where being wrong is unrecoverable |
| **Remembering the tab stamped `modified`** | `schedulePersist()` goes through `persist()`, which sets `modified = Date.now()`. Merely LOOKING at a tab would mark a text changed: a text already safely on Drive would report as changed, the next Save would upload a duplicate over a village connection, and the researcher's "unchanged since upload" checks would stop agreeing with reality. It writes the record quietly now |
| **The remembered tab was the tab the APP chose** | `enterEditor`'s own landing switch was recorded as the user's choice, so the first auto-land on Cut became permanent and a researcher later turning `landOnCut` off had no effect on any text ever opened. Seth's rule (1) is *"the last tab the USER had open"* — the landing switch is now marked as such and not remembered |
| **A remembered `cut` was not gated on the text HAVING audio** | one curious tap on Cut, and a text with no recording opened on the dead "nothing to cut" screen for ever |
| **"Take me to that line" never fired on the Gloss tab** | it was wired into `startGlossTicker` in segment-strips.js — which nothing calls. The gloss tab grew its own rAF loop (`startGlossCursor` in app.js) and that one was left behind, exported and unused. The hook moved to the live loop; the dead function now says so at the top |
| **The Baseline ticker swallowed the reveal on the Cut tab** | nothing stops the Baseline rAF when switching to Cut, so it answered the request first with a row nobody could see. `takeReveal` now ignores rows whose `offsetParent` is null (a hidden ancestor) |
| **Dragging the dock revealed the row you started FROM** | wavesurfer emits `interaction` on every drag move but debounces the seek by up to 200ms, so the first tick found the old row — on screen, no scroll needed, request consumed. The request is now spent only when it actually scrolls |
| **`cutGuessSplits` and UNDO left stale span watchers** | the same defect v360 fixed in `cutHere`, reached by two more routes: a watcher captures its stop time and rewind-home when playback starts, and both of these replace every segment underneath it |
| **The browser test's boundary check was a tautology** | its comment claimed every boundary sits in a silence; the assertion counted rows. It now reads the boundary times off the player's own marks and asserts `1.15 ≤ (t mod 2) ≤ 2.0` — inside the recording's silences |

## v364 — the drift, measured; and a 10-minute cap on guessing

**The drift is fixed and now proven at length.** v363 corrected the frame→time conversion; this
release adds the guard that would have caught it in the first place. Case (g3) builds a **ten-minute**
recording at a real 44.1kHz `msPerBucket` and asserts that the END is no less accurate than the
BEGINNING — because a 1% error is invisible at 30 seconds and 20 seconds wrong at the end of a long
one. Measured at 40 minutes: **6.2ms average error in the first 20 pauses, 6.6ms in the last** — flat.
The ~6ms that remains is frame quantisation (frames are ~10ms), inside a pause of at least 350ms.

⚠ **The first attempt at that measurement blamed the detector for the TEST's rounding**, reporting
5ms early and 113ms late. The synthetic signal writes each block as a whole number of buckets, so the
SCRIPT and the SIGNAL drift apart by ~100ms over ten minutes. The truth has to be taken from the
bucket layout the detector actually sees. Any future accuracy test here must do the same.

**And guessing is capped at ten minutes of recording** (Seth: *"cap the number of guessed lines or
rather the length of a recording that allows auto-guessing lines. Maybe let's cap that at 10
minutes?"*).

⚠ **The cap is on the INPUT, and it is about MEMORY, not about the detector.** Detection is ~45ms on
40 minutes of peaks — measured. What does not scale is the RESULT: one press would turn that into
~650 lines, and the Cut tab builds a live `<canvas>` for every one, on a phone. The device would run
out *after* the edit had already replaced the document. Capping the input refuses before anything
happens and can say why, with the limit and the recording's actual length; capping the OUTPUT would
mean silently dropping boundaries the user can see in the waveform. `guessSplits` itself is
uncapped — the limit belongs to the tab that has to render the result, not to the model.

### Following the playing line, whichever transport started it

Seth: *"auto-scrolling works if I play the big player, but I want it to work on the play-through
behavior too."* Play-through already followed — measured on the Cut tab: 650px of scroll under Space,
275px under the dock ⏵. What never scrolled was **span playback**, because v326's follow rule
exempted it: *"the user just clicked it, so they are already looking at it."*

⚠ **That was a guess about where the user was looking, and `offScreen` is the same claim MEASURED.**
If the line really is on screen, dropping the exemption changes nothing; if it is not, the old rule
left someone listening to a line they could not see — press ▶ on line 8 of a long text and the view
stayed at the top. The exemption also stopped being harmless once playback stopped meaning "one
line": a row's ▶ arms a span, and no other transport does.

The Gloss tab had kept a FOURTH copy of the follow rule (in `startGlossCursor`), which is how it
would have kept the exemption after the others dropped it. It uses the shared `followLine` now.
Verified on all three tabs: playing line 8 of 11 scrolls it into view from the top (Cut 649px,
Baseline 837px, Gloss 706px).

⚠ Unchanged, and stated because it is easy to break: **play-through is still only the big player and
Space, and only on the Cut tab.** On Baseline and Gloss, a segment selected and played with the
spacebar plays THAT segment and rewinds at its end, exactly as before (Seth, 2026-08-13).

### v365 — Tab walks the text boxes, and the dock's drag lands with the gesture

**Tab order** (Seth: *"on baseline and gloss tabs, we don't want play and join and split controls to
be part of the tab (keyboard) order. Just next and previous textbox in order"*). Tab is how a
transcriber walks their own text, and every control between two boxes was a keypress spent on
something they did not ask for. The ▶, ⤙⤚, ✂ and unchain controls on Baseline and Gloss are
`tabIndex = -1` now — still clickable, no longer stops — and the free translation joined the same
walk the glosses use, so the last gloss of a line tabs INTO it and it tabs on to the next line's
first gloss, Shift+Tab exactly in reverse.

Measured in Chromium, before → after:

| | before | after |
|---|---|---|
| Baseline, from a text box | `text → BODY → topbar icon → title` | `text → text → text` |
| Gloss, from the first gloss | `gloss → gloss → free → BODY → icon → title` | `gloss → gloss → free → gloss` |

⚠ The **Cut tab is deliberately untouched**: it has no text boxes, its rows ARE the controls, and
they are focusable on purpose — the row is what Enter and Backspace act on.

**And drag-to-seek on the dock lands with the gesture.** wavesurfer's `dragToSeek: true` defers the
real seek by 200ms after the last pointermove, moving only the progress bar meanwhile — so for a
fifth of a second after the user let go, `getCurrentTime()` still reported where the drag STARTED.
Invisible in a music player; on the Cut tab an Enter pressed straight after a drag read the stale
playhead and put the cut back at the old position. `dragToSeek: { debounceTime: 0 }`. Measured: on
v363 a drag released at ~18s reported **0:00** at release and only reached 0:17 after ~460ms; now it
reports 0:17 immediately. (Found by the v360/v361 preflight review, which also confirmed the four
other findings v363 had already fixed.)

### NEXT: resource limits, gracefully (Seth, 2026-08-13)

> *"At some point with that we'll need to think about memory/system resource limitations and be able
> to handle those gracefully."*

The ten-minute cap is one instance of a general problem this suite already meets in three places, all
solved separately: the PCM RAM budget while recording (`pcmRamBudgetBytes`), the oversize-conversion
ladder (`plans/oversize-conversions.md`), and now this. What is missing is a shared answer to *"how
much can this device do?"* and a habit of asking before starting rather than failing partway.

Worth doing when it is next touched, not before:
- one place that estimates cost per operation (rows × canvas, peaks bytes, decode bytes) against
  something real (`navigator.deviceMemory`, `performance.memory` where present, a measured fallback);
- refusals that state the limit and the actual figure, as this one does — never a silent truncation;
- and the rule this release used: **fail BEFORE the edit, never after**, because the destructive step
  is the one that cannot be undone by the user's next tap.

### And the tab is verified in a BROWSER now

v355 and v356 both shipped saying *"still unverified in a browser"*, and both were wrong in ways no
source-grep could see (a row class that did not exist; strips wired to nothing). So there are two
tests, and the second is the one that would have caught them:

- `test/cut-tab-ui.test.mjs` — structural, runs in the node suite.
- `test/browser/cut-tab.playwright.mjs` — opens the app in Chromium, imports a generated recording,
  clicks a strip, cuts, and asserts on what actually happened. Needs a server and `playwright-core`,
  so it is run deliberately, like the electron test beside it.

⚠ **Two of its assertions were checked BOTH ways** — reverted the fix, watched the test fail, put it
back. That is the difference between a test and a comment: the scroll guard reads 509 → 509 with the
fix and 509 → 0 without it, and the span-watcher guard plays to 0:13 with the fix and stops dead at
0:00 without it. Any assertion added here should earn its place the same way.

## v369 — what the v368 audit found, fixed

The full audit (reversions, blast radius, the v368 fix's edges, scroll-on-rebuild, resources) is in
the session record; four findings, three fixed here, one deferred:

**1. The playhead-Enter threw the Baseline view back to the top — fixed.** `renderStrips` never got
the v357 scroll rule; a synchronous rebuild would survive on its own, but `drawStrip` reads
`clientWidth` per row and forces layout MID-rebuild, so the clamp fires against a near-empty
container. The in-box Enter masked it for a year because `focusStrip` pulls the next input into
view; the chop gesture moves no focus on purpose. Measured 8021→0; now held (keepTop, restored at
the end, `scrollerFor` shared with `renderCut` so the tabs cannot drift). Regression-tested in the
browser suite — and the first version of that check twice failed for APP-CORRECT reasons (the
span-rewind rule near the end of the recording), which is worth remembering: a red test is a claim,
not a verdict.

**2. Leaving the text leaked the tab tickers — fixed.** Only `switchTab` ever stopped them, so
⟵ Back (and the v352 return-after-send) left a 60fps rAF loop doing ~3,600 DOM queries a second
against hidden nodes, plus ~25MB of strip/gloss canvas backing store idling behind the texts list.
One shared `leaveEditor()` now stops all three tickers, drops the canvases, clears `cutShownFor`
(so the next open rebuilds through its loading state), and hides the player. Measured after:
0 rAF/s, 0 queries, 0 canvases, 0.0% CPU on the texts list. Safe by construction — every tab
rebuilds its own view on entry.

**3. The researcher panel's texts-list bounce (Seth's known bug) — fixed, ⚠ NEEDS THE PANEL TEST
DRIVE.** `renderDashboard` repainted the whole panel to a one-line "loading…" note BEFORE the
network round trip, and the browser clamps the scroll against that near-empty layout — the 12s poll
path never had the bug because it swaps `.rp-body` in one task. A full render now borrows the poll's
shape when a dashboard is already on screen (`.rp-metrics` is the marker): leave the old content up
while fetching, swap when the data lands, and restore the captured offset across the swap. ⚠ This
one could NOT be driven in the audit environment (no dev worker); it is code-reviewed and
syntax-checked only, so the panel needs a deliberate scroll-and-delete test before release.

**4. The 40-minute heap (~492MB at 16kHz mono, ~3× that for a 44.1kHz phone recording) — NOT fixed,
deliberately.** That is decode architecture, not a patch; it stays with the deferred
resource/cheap-device audit in `plans/BACKLOG.md`, now with measured numbers.

## v368 — the Snakes_We_Eat.m4a report: peaks that were a PICTURE of the audio

> Seth, 2026-08-14: *"a new text that I import only shows a short (truncated) single line, seems like
> the rest is off screen, guess isn't working, and it looks like it plays through past the end of the
> segment, but the final segment that hasn't been split yet … should show the whole segment."* Then:
> *"showing part (not all) of the recording on the first and only line such that the segments don't
> render all of it is not OK."*

### What it actually was

**`Player.load` caches `exportPeaks({maxLength: 12000})` and the duration on the media record the
first time a recording is loaded, so later loads can draw without decoding again.** On every load
after that, wavesurfer is handed `peaks` + `duration` and never decodes — and `getDecodedData()` then
returns an AudioBuffer-shaped object wrapping exactly those 12000 display samples, whose
`sampleRate` is `12000 / duration`. About **136 Hz** for a 90-second take.

`ensurePeaks` prefers the player's decoded buffer (one decode, one timeline — the encoder-priming
rule) and had no way to tell the difference. It bucketed 12000 samples at 2000 buckets a second, so
**93% of the buckets held nothing**, both amplitude percentiles that decide "pause vs speech" landed
on zero, and `guessSplits` refused — correctly, given what it was shown — with *"no clear pauses"*.

⚠ **It only bites recordings over about a minute**, which is why nothing caught it: the share of
frames carrying real data is `12000 / (2000 × seconds)` = 6/seconds — 30% at twenty seconds, where
the 90th percentile still lands on real audio, and under 10% past a minute, where it does not. Every
fixture in the suite was twenty seconds. **And only on the SECOND open**, because the first one has
no cached peaks to be poisoned by.

### The fix, in three places

| | |
|---|---|
| `Player._peaksOnly` + `decodedBuffer()` returns null | the player knows it did not decode; it is the only thing that does. A picture of the audio is not the audio |
| `ensurePeaks` requires `sampleRate >= 8000` | the module that would be poisoned states its own requirement rather than trusting a caller |
| `coverTail()` in `reconcile()` | **the invariant Seth actually asked for**: an untexted, un-imported tail segment is extended to the end of the recording. Whatever disagrees about the duration, the strips account for all of it |

`peaksDurationFor()` also went in beside them: `reconcile` read the module-global peaks cache without
asking WHOSE recording it held, so a text opened straight after another one could be seeded with the
previous recording's length — a whole-file span that is not the whole file, persisted, with nothing
afterwards able to notice (the seed only fires on zero segments, the heal only on all-pending ones,
and such a span is neither).

### ✨ greys out when it cannot help

Seth, on the same recording (*"lots of background noise (crowded workshop)"*): *"If the background
noise is too high to make easy splits, then graying out the guess button is fine."* So the detector
is now asked BEFORE the press, cached per (document, peaks generation), and its refusal becomes a
disabled button carrying the reason — joining the two states that already greyed it (text present,
over ten minutes). A live button that always answers "no" reads as a broken feature.

### ⚠ How this was found, and the lesson

The .m4a itself is **healthy** — 3810 AAC frames × 1024 = exactly 88.468s, sample table consistent
with the mdat to the byte. Four hypotheses about the container, the decode and the WAV working copy
were all wrong, and every reproduction attempt with a synthetic file PASSED. What broke it open was
reproducing the *sequence* rather than the file: guess, reload, guess again.

⚠ **The first version of the regression test passed with the bug still in**, twice — once because it
reused the 20-second fixture (too short to show it), once because it reopened the text without
letting the player finish loading first (so the Cut tab decoded the blob itself and never asked the
player). Both were caught by disabling the fix and watching the test go on passing. **A regression
test nobody has watched FAIL is a comment.**

## v368 — Enter on the Baseline tab, outside a text box

> Seth, 2026-08-14: *"if the segment audio is active, pressing enter splits at the playhead and
> splits the text at the end of the baseline (rather than wherever the cursor was last). If the text
> box is focused, pressing enter splits wherever the play head is (on the current segment) as it does
> now."*

The tab already had half of this. Inside a box the caret decides where the WORDS divide; outside one
there is no caret to consult, and the honest answer is that none of them move — the line keeps them
all and the new line starts empty. That turns transcribe-then-align into **listen and chop** without
ever touching the text, on the tab where the text lives.

- **One implementation** (`splitLineAt`) behind both, so the TIME can never break differently for the
  two. `caret == null` means "at the end".
- **It acts on the line the PLAYHEAD is in**, not on a remembered selection — the same rule the Cut
  tab runs on. Playhead in no line ⇒ it refuses.
- **It does not move focus.** Dropping the cursor into the new box would hand the next Enter to the
  text-box path, which acts on the FOCUSED line — and by then the recording has played on, so the two
  would be talking about different lines.
- **It is its own undo step**, unlike the text-box Enter beside it. That is not an inconsistency:
  typing is what creates undo points on this tab, so a split made while typing is always recoverable
  by the entry either side of it. A chopping run types nothing.

⚠ **Seth's guard — "don't allow a split unless the playhead position is on the current segment" — was
already enforced, and deliberately only for the TIME.** `boundaryAtPlayhead` gives the new line a
`timePending` span when the playhead is outside the segment, rather than a time nobody chose. The
words still split at the caret in that case, and must: blocking it would make Enter stop working
whenever nothing is playing, which is most of transcription. The playhead-driven gesture, which has
no typing intent behind it, refuses outright.

## v361 — "Guess the lines" is BUILT (was the NEXT section below; kept for the reasoning)

Seth: *"where's my 'Guess' (default auto-segment based on pauses) button/feature for new texts?"* It
had been specified below and never built. It is now `guessSplits()` in `segments.js` — pure, no DOM,
no decode — plus a button at the top of the Cut tab.

**What was actually decided, beyond the sketch below:**

| decision | why |
|---|---|
| **10ms frames of MEAN amplitude**, not the raw 0.5ms max buckets | the peaks array is a MAX per bucket, which is what makes waveforms crisp and gating unreliable: one click or chair creak inside a two-second pause is a single tall bucket, and a max-based gate calls the whole pause speech |
| **floor = 20th percentile, speech = 90th**, both of the file itself | in any recording of speech at least a fifth of frames are between words; the 90th is the speech level, where the MAX is one plosive that tells you nothing |
| **hysteresis, gates at 12% and 25%** of floor→speech | one gate chatters where the level wobbles across it, breaking a genuine long pause into short ones that each fail the minimum-gap test — so the pause is missed entirely. Both gates sit near the FLOOR, per the under-cutting rule |
| **refuse when `speech < floor × 1.6`** | continuous speech, a wall of noise, or silence: no dynamic range means any threshold is a coin toss applied fifty times. Returning nothing leaves the user exactly where they were |
| **min gap 350ms, min line 900ms** | below ~300ms you cut inside words (a glottal stop can hold 150ms); a sub-second "line" is usually a cough or a door |
| **minimum line enforced LAST, over the whole set** | enforcing it pairwise as boundaries are found lets a chain of near-misses accumulate into a run of slivers |
| **a text with WORDS is refused wholesale** | guessed spans cannot carry existing text — `segments[i]` IS paragraph i, and there is no defensible way to redistribute words across new spans. The button is disabled in that state AND the function refuses |
| **already cut by hand ⇒ confirm first** | that hand work is precisely what this throws away |

⚠ **The threshold was measured, not asserted.** `test/guess-splits.test.mjs` synthesises peaks with
known pauses and scores the detector: clean, a **village noise floor at 8%**, a loud room at 25%,
80–140ms stop closures that must NOT be cut, continuous speech, silence, a wall of noise, and lines
too short to mint. **Zero spurious cuts in every case** — the expensive error — with full recall on
(a)–(d). The browser test then proves the whole path on genuinely decoded audio: 10 bursts → 10
lines, boundaries in the silences, and **one Ctrl+Z undoes the entire guess**.

## (built — see above) "Guess Splits" — silence detection (Seth, 2026-08-13)

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
