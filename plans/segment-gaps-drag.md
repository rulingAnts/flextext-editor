# Plan: dragging a boundary may leave a gap — "allow unsegmented audio" and the 🔗 stick toggle

Seth, 2026-10-16: *"if the user drags an audio segment boundary INWARD, it only resizes THAT segment.
The segment bordering it stays in place, leaving unsegmented audio in between. However, if the segment
boundary is dragged outward, once it collides with a neighboring segment, it will push that segment
boundary together so that the segments don't end up overlapping."* Plus an optional, very iconic
player toggle that *"drags segment boundaries together once they are actually adjacent."*

Status: **planned, not built.** Branch `segment-gaps` from `main`. Docs only so far.

## 0. Short answer

Today (v717, D11 in `plans/time-gaps-and-estimates.md`) a boundary between two lines that TOUCH
always moves both edges — no gap can ever open — and where a pause already separates them, only the
grabbed edge moves but it STOPS at the neighbour. This plan changes exactly two things in that rule
and adds two switches:

- **Inward at a touching seam opens a gap** (only the grabbed line shrinks) — when gaps are allowed
  and the 🔗 stick toggle is off.
- **Outward into the neighbour pushes it** (the neighbour shrinks, never below its minimum, never
  cascading to a third line) — always, in place of today's hard stop.
- `segmentGaps` — the researcher's switch (device setting): may gaps be CREATED on this device. Off
  by default on a managed device, on when working alone. Gaps that already exist in a text are kept
  either way.
- 🔗 **stick** — the user's toggle on the player, beside ✨: while on, two boundaries that touch (or
  are pushed into touching) move as one. Forced on while `segmentGaps` is off; otherwise defaults on
  for a paired device and off for an unpaired one; the user flips it on the player.

The whole rule lives in ONE place — `moveBoundary` / `dragSeam` in `segments.js` — because every drag
surface already goes through it: the editor's Baseline, Cut and Gloss grips, the Cut tab's player
marks, the Audio Segmenter's row grips and dock marks, and the Paragraph Analysis Tool's grips. One
drag is exactly one Undo, pushed neighbour included.

## 1. Seth's decisions (2026-10-16), numbered for the tests

| # | Decision |
|---|---|
| G1 | **Inward** drag of an edge moves only that edge; the neighbour stays. Audio between them is a gap. |
| G2 | **Outward** drag that reaches the neighbour **pushes** its facing edge along; the two never overlap. |
| G3 | The push **stops** when the neighbour is at its minimum length (`MIN_SEGMENT_MS`, 120 ms). It never cascades to the next line. |
| G4 | **Elastic** within one drag (stick off): drag back and the pushed edge returns to where it was at pick-up, then stays; the gap reopens past that point. |
| G5 | **Stick on:** two edges that touch — or that this drag pushed into touching — move as one for the rest of the drag and in every later drag. Touching = within `GUESS_TOL_MS` (1 ms), the model's own tolerance. Separating them again means turning stick off. |
| G6 | **Snap:** on release, a dragged edge that ends within **40 ms** of its neighbour closes onto it exactly (gap = 0, not 1 ms) — the "micro gap" that would otherwise never count as touching. |
| G7 | Merging two lines across a gap keeps the gap's audio inside the merged line — confirmed in the code: `mergeSpanPair` → `{start: a.start, end: b.end}`. Times are absolute offsets into the recording, so no boundary edit can misalign audio and text. |
| G8 | Only **drag** surfaces change. Merge, split and cut keep producing touching seams; ⇥ (set this line's end at the playhead) keeps today's clamp to the neighbour. |
| G9 | A **pushed** edge is a user-set time, not a `~` estimate: it sits at exactly the time the finger chose. |
| G10 | Applies to the **editor and the Segmenter** alike, under the device's settings. |
| G11 | **Settings:** `segmentGaps` off by default on a paired device (the user never sees gaps unless the researcher switches it on), on by default unpaired. Stick: forced on while gaps are off; otherwise on by default paired, off by default unpaired; a player toggle, very iconic, beside ✨. |
| G12 | A text that arrives WITH gaps on a gaps-off device keeps them. The user can close them (drag together, snap) but never reopen them until gaps are enabled and stick is off. |
| G13 | **One Undo, exactly**, for a drag — both edges when a push happened. |

## 2. Model

Terms: `a = segs[i]`, `b = segs[i+1]`; the grabbed edge is `a.end` (`'end'`, the default — a dock mark
is an end edge) or `b.start` (`'start'`). `before = [a0, b0]` is the copy taken at pick-up, which the
drag is judged against (unchanged from v717 — it is what makes G4 free). `minMs = 120`. *Touching*
means `b.start − a.end ≤ 1`.

Per drag step, target time `t`, with `gaps = segmentGapsOn()`, `stick = seamStickOn()`:

| At pick-up | Grabbed | Direction | Result |
|---|---|---|---|
| touching, and (`!gaps` or `stick`) | either | any | **seam mode (today):** both edges = clamp(t, a.start+min, b.end−min). |
| touching, `gaps && !stick` | `end` | inward (t < a0.end) | `a.end = max(t, a.start+min)`; b untouched → a gap opens (G1). |
| touching, `gaps && !stick` | `end` | outward (t > a0.end) | `a.end = min(t, b.end−min)`; `b.start = a.end` (push, G2/G3). |
| pause | `end` | inward | `a.end = max(t, a.start+min)` — only this edge, as today. |
| pause | `end` | outward, `t ≤ b0.start` | `a.end = t`; b untouched (closing the pause, as today). |
| pause | `end` | outward, `t > b0.start` | `a.end = min(t, b.end−min)`; `b.start = max(b0.start, a.end)` → push while past it, **elastic** back to `b0.start` (G4). With `stick`: the step that first reaches `b0.start` sets `drag.stuck = true`; every later step of this drag is **seam mode** (G5), so dragging back now pulls `b.start` with it. |
| pause | `start` | — | the mirror image: `b.start = min(t, b.end−min)` inward; outward `b.start = max(t, a.start+min)` and `a.end = min(a0.end, b.start)` while past it. |
| any edge unaligned / `timePending` | — | — | refused (`reason: 'pending'`), as today. |

**Snap (G6), on release only, `gaps && !stick`:** if `0 < b.start − a.end ≤ SNAP_MS (40)` after the
drag, the **dragged** edge is set to the neighbour's (the neighbour was never touched by the user).
It can only lengthen the dragged line, so minMs cannot be violated. A pause that this drag did not
bring under 40 ms is left exactly as imported. In seam mode and with stick on there is nothing to snap.

**Edges and estimates (G9):** `placeSeam` already makes the placed edge real and keeps the far edges;
the push places TWO edges (`a.end` and `b.start`) at the same `t` — both real. A pushed edge of a v718
**placeholder** line gets a stored time, so that line becomes a placed line (its `phAt` no longer
matches by value — exactly how `isPlaceholder` is meant to flip).

**Push limit (G3):** `min(t, b.end − min)` — the neighbour is never shorter than 120 ms and the line
beyond it is never consulted. One finger, at most two edges.

**What the user sees during the drag:** the two touched strips redraw per move as today (`o.redraw(bi)`,
`o.redraw(bi+1)`), the dock marks follow (`syncMarks`), and the gap band / gap row (v719,
`gapRowsFor`, ≥ 350 ms) appears on the persist at release — not mid-drag, so nothing reflows under the
finger.

## 3. Settings

Two, in the shapes this file already uses:

```js
// app.js — the researcher's switch. Same shape as keepTimes / gapLines / timingBanner:
// on for a lone worker, off on a managed device until the researcher switches it on.
function segmentGapsOn() { return adjustBoundariesAllowed() && (!Sync.hasSession() || settings.segmentGaps === true); }
// app.js — the user's toggle. A device preference like showGaps, with a pairing-dependent default,
// and FORCED ON while gaps are off (the toggle is hidden then: nothing to choose).
function seamStickOn() {
  if (!segmentGapsOn()) return true;
  if (typeof settings.seamStick === 'boolean') return settings.seamStick;
  return Sync.hasSession();   // paired: stuck by default; alone: free by default
}
function toggleSeamStick() { settings.seamStick = !seamStickOn(); saveSettings(settings); /* repaint the toggle */ }
```

- Panel: `{ k: 'segmentGaps', type: 'checkbox', note: 'panel.f.segmentGapsNote' }` in the Buttons
  group right under `adjustBoundaries` (it is meaningless without it), pushed like every other
  switch, and the settings-link form `?segmentGaps=on`. The device-setup form mirrors it
  (`v.segmentGaps = s.segmentGaps === true`, the keepTimes shape).
- No device-side checkbox for `segmentGaps`: like keepTimes/gapLines, a lone worker simply has it.
  The user's control is the 🔗 toggle.
- **The caveat in G11, read as two settings, not three.** *"The user's ability to toggle stick on/off
  is also a device setting, dependent on gaps being enabled, and on automatically if gaps are
  disabled"* — the ability exists exactly when gaps are enabled; when gaps are disabled stick is on
  and there is nothing to toggle. A separate researcher switch "may the coworker toggle stick" would
  be redundant: pinning stick on while gaps are enabled behaves identically to gaps disabled (existing
  gaps kept, closable, never reopenable). So it is not built. **Seth: say so if you do want a third
  switch**, e.g. to let the researcher pin stick OFF.
- `?devreset` and "Erase all data" take both with everything else; nothing new to clear.

## 4. UI

- **The toggle: 🔗.** Emoji 1.0 (2015), so it renders on every Android in the field — the same test
  `index.html` records for ✨ (🧲 is Emoji 11, 🔗 is the safe one). Lit = stuck together; dimmed =
  free, like the other dock toggles. Tooltip + aria-label carry the words (`seg.stickOn` /
  `seg.stickOff`); never a sentence on the button (Seth, 2026-08-14).
- **Editor:** its own `<button id="btn-seam-stick" class="icon-btn2">` beside `#btn-guess-splits` in
  the player dock — but NOT tied to the Cut tab the way ✨ is (✨ is shown by renderCut and hidden by
  stopCut). Shown whenever grips can exist and gaps are on: `segmentationEnabled() &&
  adjustBoundariesAllowed() && segmentGapsOn()`, repainted by `applyLiveSettings` (a pushed
  `segmentGaps` flip shows or hides it live).
- **Audio Segmenter:** `#mg-stick` in the `.mg-bar` beside `#mg-guess`, same rule.
- **PAT:** has grips (`paragraph-ui.js` → `makeBoundaryDrag`). Decision 11.3 below.
- The grips themselves are unchanged: left grip = this line's start, right grip = this line's end, so
  "inward/outward" is always unambiguous — and with stick on it does not matter which line's grip you
  took (G5: either one moves both).
- No grip on the first line's left edge or the last line's right edge, as today (`bi < 0 ||
  bi >= n−1` in `attachEdgeHandles`). Gaps at the file's ends still come only from import or cuts.
  Decision 11.4.

## 5. Exact changes (all under `docs/js/`)

**`segments.js`**
- `moveBoundary(segments, i, ms, opts)` gains `opts.gaps`, `opts.stick`, `opts.stuck` and implements
  the table in §2. Returns `{ ok, segments, t, edge, pushed: bool, touched: bool }` — `touched` is
  "the grabbed edge reached the neighbour's pick-up edge this step", which the drag controller turns
  into `stuck` when stick is on. `edge` stays `'seam' | 'end' | 'start'` for the placed edge;
  `pushed` says the neighbour's facing edge was placed too.
- `dragSeam(live, before, bi, ms, edge, opts)` passes `opts` through; on a push it `placeSeam`s the
  neighbour's facing edge as well (both real, G9). The `'same'` short-circuit stays.
- New `export function snapSeam(live, bi, edge, snapMs = SNAP_MS)` — the release-time close (G6);
  returns the new `t` or null. `export const SNAP_MS = 40`.
- `withGuesses` / `placeSeam` / `settle` unchanged.

**`segment-strips.js` — `makeBoundaryDrag(o)`**
- Per-drag state grows one flag: `stuck = false` at `'start'`. `o` gains `gaps()` and `stick()`
  (functions, read at pick-up and held for the drag — the mode is fixed at pick-up, as the v717
  comment insists). On `'move'`: `const r = dragSeam(segs, before, bi, ms, grabbed, { gaps, stick, stuck })`;
  `if (r.touched && stick) stuck = true`. On `'end'`, before `o.persist()`: `if (moved && gaps &&
  !stick) snapSeam(segs, bi, grabbed)`. Capture stays at the first effective move — the snapshot is the
  whole array, so a push is inside the one Undo (G13).
- Its four consumers (`stripsDrag`, `cutDrag` here; `glossDrag` in app.js; `paDragFn` in
  paragraph-ui.js) pass `gaps: deps.gapsOn, stick: deps.stickOn` from the app's two readers.

**`app.js`**
- `segmentGapsOn()`, `seamStickOn()`, `toggleSeamStick()` (§3); the Segmenter's `mgBoundaryDrag`
  mirrors the controller: `mgDragFrom.stuck`, `snapSeam` on `'end'` before `mgDraw()`.
- `#btn-seam-stick` / `#mg-stick` wiring and `renderStickToggle()` called from `applyLiveSettings`,
  `renderCut`/`renderStrips`/`renderGloss` and `mgLoad`.
- `syncGatherInventory`'s `settings` snapshot already carries `settings`; nothing to add.

**`researcher-panel.js`** — the Buttons-group field, the settings-link param, the device-setup mirror
(three one-liners, the `keepTimes` pattern), and a `RELEASES` entry when it ships.

**`i18n.js`** (EN + ID): `panel.f.segmentGaps` *"Let the coworker leave audio between lines"*,
`panel.f.segmentGapsNote` *"Dragging a boundary inward leaves the audio between the two lines
unassigned to either, shown as a gap row; dragging outward pushes the neighbouring line along rather
than overlapping it. Off: boundaries that touch stay touching, and existing gaps are kept but cannot
be reopened once closed. On when working alone; off on a managed device until you switch it on."*;
`seg.stickOn` *"Boundaries that touch move together — tap to let them separate"*; `seg.stickOff`
*"Boundaries move on their own — tap to make touching ones move together"*.

**`index.html`, `satellites/audio-segmenter/index.html`** — the button element. No new module, so no
SHELL change in any `sw.js` (the v108 rule is not engaged).

## 6. Every adversarial case, resolved

1. **Outward past a neighbour that is already at minimum.** `min(t, b.end − min)` clamps; the drag
   simply stops. Not a cascade (G3).
2. **Stick on, pause, inward.** Only the grabbed edge moves — stick applies to touching edges only
   (G5 as Seth stated it: *"only applies once the boundaries push into each other, or are already
   basically at the same position"*).
3. **Stick on, pushed into touching, then dragged back.** `stuck` → seam mode: the neighbour's start
   follows back and the neighbour GROWS at its front. That is "either one moves both"; it is not a bug.
   Covered by a test with the exact numbers.
4. **Stick off, pushed, dragged back (G4).** `b.start = max(b0.start, a.end)`: elastic, exact return.
5. **Release 30 ms short of the neighbour, stick off.** Snap closes it (G6). Release 50 ms short:
   a 50 ms gap, invisible (below the 350 ms gap-row threshold), honest, and a later drag can close it.
6. **A 20 ms pause that came from ELAN, never dragged.** Untouched: snap acts only on the dragged edge
   at release.
7. **Gaps off, text with gaps (G12).** Pause edges move as today (free within their span), closing is
   allowed, snap does not apply (stick is on), and a touching seam is seam mode — so a closed gap can
   never reopen. ⚠ **Decision 11.2:** today a pause edge dragged inward WIDENS the pause even with
   gaps off (v717 behaviour, shipped). Kept, since "no new gaps" is read as "no gap where none was".
8. **Neighbour is a v718 placeholder.** It is drawn, not stored; `isAligned` is true so the drag is
   allowed as today; a push writes its start and `storableRecord` stores it as a placed line. The
   gloss/baseline redraw shows it solid. Pushing a placeholder is a real edit, stamped.
9. **Neighbour has no time (`timePending`).** Refused, as today — nothing to push against.
10. **Gloss-tab grip while the gloss cursor is in a field.** Unchanged path (`glossDrag`); one Undo.
11. **Undo after a push.** The capture at the first effective move snapshots `doc.segments`; Undo
    restores both edges and, if the neighbour was a placeholder, its placeholder status (status is by
    value). One Redo re-applies both (G13).
12. **A drag that ends where it began.** No capture, no persist, no snap (nothing moved) — the v717
    "dead Undo" fix holds.
13. **Dock mark on the Cut tab's player.** Marks are END edges; a mark dragged left opens a gap after
    its line, right pushes the next line. Same controller, same opts.
14. **Export.** FLEx `begin/end-time-offset` are per phrase and already non-contiguous for imported
    pauses; EAF the same; `uploadContentSig` hashes the stored form. Nothing changes shape.
15. **Timing banner / `timingReport`.** A gap is not "out of step"; `timeSync` is untouched.
16. **A `segmentGaps` push arriving mid-drag.** The mode was fixed at pick-up; the toggle repaints on
    `applyLiveSettings` after the drag's persist. Nothing moves under the finger.
17. **Corpus gate.** `tools/corpus-timing.mjs` over the real files must show 0 time changes on open:
    this plan writes nothing on open — only on a drag's release.

## 7. Tests

- **`test/segment-gaps.test.mjs` (new):** table-driven over §2 — every row with exact ms, the stuck
  state machine (case 3), elastic (case 4), snap at 40/41 ms and the untouched-pause case, push limit
  at minMs, placeholder neighbour becomes placed, pushed edges are real (no `guess`), one Undo
  (capture count across a push), settings shapes (`segmentGapsOn` false when paired and unset, true
  unpaired; `seamStickOn` true when gaps off whatever `settings.seamStick` says; pairing defaults),
  toggle visibility pins (shown by segmentation+adjust+gaps, not by the Cut tab), panel field present,
  i18n keys in both languages.
- **Update:** `test/adjust-boundaries.test.mjs` (today pins "never past its neighbour" — becomes
  "never overlapping, and never below the neighbour's minimum"), `test/segments-ordering.test.mjs`
  (the seam-mode row is unchanged; the pause rows gain the push).
- **Browser (real clicks, Chromium):** open a gap by inward drag → gap row appears at ≥ 350 ms; push
  → neighbour shrinks, stops at 120 ms; elastic return; stick on → stuck; snap at 30 ms; toggle flips
  the glyph and persists across reload; exactly one Undo per drag; the same on the Segmenter's row
  grip and dock mark.
- **Corpus gate** (`tools/corpus-timing.mjs`, local — the samples are gitignored): Seth runs it before
  the branch goes to staging.

## 8. Rollout

Branch `segment-gaps` from `main` → `./bump-version.sh`, `BUILD_TAG = 'segment-gaps v1'` → own
preview estate (a MAJOR feature tests on its own branch first — Seth, 2026-08-11) → `--no-ff` into
`staging` for the integration check → adversarial review (both waves, fixes with failing-then-passing
tests) → Seth's checklist → `main` → **beta** (this touches the engine and three apps: it is not a
"small, self-contained" change) → `productionWeb`, with the `RELEASES` entry and DEVELOPERS.md §8
updated in the same commit, and one bullet in CLAUDE.md's segmentation section.

## 9. What you will see, Seth

Open a text with audio, Segmentation on, on an unpaired device: 🔗 sits dimmed beside ✨. Grab the
right edge of a line's wave and pull it left: that line gets shorter, the next line does not move, and
if the space you opened is more than a third of a second a gap row appears there with its own ▶. Pull
it right instead: it meets the next line and pushes its start along; pull back and the next line
springs back to where it was. Tap 🔗 so it lights: now two edges that meet stay together — pull back
and the next line comes with you. On a device you manage, none of this is there until you tick "Let
the coworker leave audio between lines" in the panel; until then boundaries behave as they do today,
and 🔗 is not shown.

## 10. Left for later

- Grips on the first line's start and the last line's end (a gap at the file's ends by dragging).
- ⇥ pushing rather than clamping (G8 says drag heads only, for now).
- Keyboard nudging of a boundary.

## 11. Decisions for Seth

1. **Two settings, not three** (§3): confirm, or ask for a researcher switch that pins stick off.
2. **Gaps off at an existing pause** (§6 case 7): keep today's free movement (a pause can widen), or
   make the pause edge one-way (only toward the neighbour)? Recommendation: keep today's.
3. **PAT:** same rule under the same settings (it is the same engine and already has grips), or stays
   stick-on? Recommendation: same rule.
4. **🔗 as the glyph** (Emoji 1.0, field-safe) — or something else from the 2015 set.
5. **File-edge grips** (§10) — later, or never.
