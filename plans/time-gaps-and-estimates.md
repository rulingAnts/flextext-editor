# Plan: audio gaps, untimed lines and estimated times (FlexText Editor v717–v719)

Planning only. Nothing was modified: wt-prod is clean at 4388ef0b (v714, 777/777 tests passing) and wt-rt is clean at 14fea99c (parked v709–v713). This plan was written 2026-10-10. It merges Design A (minimal) with Design B (full) as the verdict recommends, and it closes every adversarial failure case (§5).


> Texts are named by neutral labels (a letter or "ELAN" plus the line count: L29, E78, E19, T53, T151, T18, ELAN40, ELAN52, ELAN43), so that no text title or speaker name goes into this public repo. Seth keeps the key.

> **Release numbers (2026-10-10):** v715 and v716 shipped the operator-notice work from another session, so this plan's three releases are **v717** (truth and safety), **v718** (untimed lines) and **v719** (gaps). Branches `time-truth`, `time-untimed`, `time-gaps`. Releases now go main → `beta` soak → `productionWeb` (CLAUDE.md). Seth's §11 decisions (10 Oct): gap rows with one-click add; 0.35 s threshold; researcher switches; v717 first.

## 0. Short answer

**The old exports are broken. The app reads them faithfully.** v714 opens all 39 timed files with every time exactly as written, and parked v713 re-paired nothing either. Two kinds of file damage:

- **Legend L29, 14 Aug and 17 Aug exports.** Lines 3–28 sit one slot early. The 2026-08-16 bug caused this.
- **the two estimate-only texts (E78 and E19).** These hold the editor's even-spread guesses, exported as times.

The app has three faults of its own:

1. It writes guesses into exports as if they were times.
2. It ignores the `~` mark when reading a file back.
3. It shows nothing for gaps or for untimed lines.

It also has one open hole of the 2026-08-16 kind. Editing a timed text in the plain text box pairs lines with times by position.

This plan does four things:

- fixes the three faults and closes the hole;
- adds both behaviours Seth asked for, plus the "needs fixing" styling;
- never changes a time or adds a line unless the user acts;
- keeps every action to one Undo and one Redo.

## 1. Principles

- **P1. Opening a text writes nothing.**
  - No guessed time is stored, no line is added, and `modified` is never stamped.
  - One exception: a one-line text with audio still stores its whole-file span, as in v714. That write is quiet (no stamp). See D7.
- **P2. Text and times change together.** They change at the same index, through pure functions that take both arrays and return both. Nothing is ever re-paired by position.
- **P3. Every line's time is exactly one of four kinds:**
  - *real*: set by the file or by the user;
  - *estimate*: at least one edge is a guess. It is stored and exported with a marker;
  - *placeholder*: computed for display only. It is never stored and never exported;
  - *none*: no time at all.
- **P4. The file's own times and markers go back out as they came in.**
- **P5. One user action makes exactly one Undo item and one Redo item.**
- **P6. One banner per text.** Marks on individual lines appear only for exceptions.
- **P7. Every new audio-segmenting control can be switched on or off by the researcher.** The listening page is not touched.
- **P8. A stored time is never clamped or shifted to fit the decoded length.** The app clips only when drawing or playing.

## 2. Data model (the merged design)

Span fields. `doc.segments[i]` pairs with `doc.paragraphs[i]`, as now.

| field | stored? | meaning |
|---|---|---|
| `start`, `end`, `timePending` | yes | unchanged |
| `guess: [gs\|null, ge\|null]` | **yes (new)** | The value of each edge that is a guess. An edge counts as a guess only while its current value is still within 1 ms of that recorded value, so any real edit clears it with no flag to remember. |
| `timeEstimated` | yes | Kept as a derived copy: it always equals `isEstimate(span)`. v714, `.fxpa`, PAT and a rollback all still understand it. |
| `estSource` | yes | `'note'`, `'marker'`, `'pattern'`, `'edit'` or `'legacy'`. Used only for the tooltip. |
| `phAt: [s,e]` | **never** | The values a placeholder had when it was computed. It exists only in memory. |

```
edgeGuessed(s, side)  = s.guess?.[side] != null && |s[side?'end':'start'] − s.guess[side]| ≤ 1
isEstimate(s)         = isAligned(s) && (edgeGuessed(s,0) || edgeGuessed(s,1))
isPlaceholder(s)      = isAligned(s) && s.phAt && s.start === s.phAt[0] && s.end === s.phAt[1]
isPlaced(s)           = isAligned(s) && !isPlaceholder(s)          // real or estimate
```

Rules:

- **C0. No operation makes a guess of the first line's start or the last line's end.** Nothing interpolates them; they come only from the file, the user, 0 or D.
  - *(v717 review)* C0 governs where guesses are MADE, not which positions may hold one: delete the first line of an estimated text and the new first line's start is still the interpolated value it was, so it stays a guess. Enforcing C0 by position after every operation laundered exactly that guess.
  - So a recording made in the app keeps solid first and last lines, as in v714.
- **Placeholder status depends on values, not on a flag.**
  - Copying a span with `{...s}` is harmless: once the values change, the copy is no longer a placeholder. This is the fix for adversarial case 10.
  - Only two operations deliberately keep the status:
    - merging two placeholders;
    - splitting a placeholder at a point that is not the playhead.
- **Placeholders do live in memory, in `current.doc.segments`.** Every renderer, ticker and operation therefore sees one consistent array, as with v714's seed.
- **Storage removes them in exactly one place:** `db.putDoc` → `storableRecord`.
  - Placeholders are stored as `{timePending:true}`.
  - Any `phAt` field is dropped, including from `matchDraft.spans`.
  - All 23 `putDoc` call sites pass through it.
- **`timeEstimated` is re-derived after every operation.** `normalizeSegments` does it, plus `placeSeam` for drags, which do not call `normalizeSegments`.
  - Legacy spans that carry `timeEstimated` but no `guess` are migrated in memory in pass 0 of `normalizeSegments`.
  - Each edge of such a span counts as a guess, except:
    - an edge that is C0;
    - an edge that touches a neighbour within 1 ms where that neighbour is not an estimate.
  - So a legacy fraction-split piece keeps its outer edges real, and a v714 seed counts as guessed on its interior edges.
  - *(v717 review)* A **lone** estimate (neither neighbour is one) has every non-C0 edge guessed: a start pushed by normalize is the guess at exactly the edge that meets its real neighbour. Where the phrase still carries the file's offsets, the edge that differs from them is the guess (`readLegacyEstimates`).
  - *(v717 review)* A span whose flag no live guessed edge explains was written by an older build (a rollback to v716 copies `[null, null]` along and sets its own flag) and is migrated the same way, never read as real.

## 3. Decisions and reasons

| # | Decision | Reason |
|---|---|---|
| D1 | **Gaps appear as display-only "unassigned audio" rows.** Each has ▶, a waveform, "Add a line here", and "Add a line for every gap (N)" with a confirm step. Nothing is inserted on open. | Inserting lines on open (Seth's literal wording) would grow ELAN40 from 40 to 79 lines, ELAN52 from 52 to 103 and ELAN43 from 43 to 76. 93–100% of the added lines are silence, every later line number would stop matching FLEx, and about 40 empty phrases per text would go to FLEx on the next export. It would also be a silent change to new users' data. The rows put an empty line in every gap on screen, and adding one is a click. **Seth decides (§11-1).** |
| D2 | **Thresholds:** gap row ≥ 350 ms (lead, interior and tail); end tolerance ±350 ms; spread minimum 400 ms per untimed line; "dense" ≤ 100 ms per word; equal-length run ≥ 3 lines within ±2 ms; tail-short ≥ 1 s; speech in a gap means a gap ≥ 1000 ms with ≥ 400 ms voiced. | **350 ms** excludes all 22 ELAN holes under 350 ms (snapping slivers) and the 48–70 ms decoder differences. **400 ms** is the shortest real text line (399 ms). **100 ms per word** matches 1 of 931 real lines, the L29 damage. In real files the shortest and longest lines differ by at least 2,450 ms; in estimate files by 1 ms. **Tail-short** fires only on the damaged legend L29 files. **The speech rule** picks 11 of 197 holes, including every large speech hole. |
| D3 | **Untimed lines are spread only within their own room.** The room runs from the previous placed end (or 0) to the next placed start (or D). The lines become placeholders. If the room is less than k × 400 ms, they stay ⋯ with a "no room" mark. | This is Seth's B2 rule. Placed lines are never read for change. A guess becomes stored only through a user's edit. |
| D4 | **The all-untimed seed is the same rule with one room, [0, D].** It gives exactly v714's values, `round(kD/N)`. | The 131 untimed files look the same as today, but nothing is written and nothing is exported. |
| D5 | **Import reads estimate markers back**, in this order: per-edge processing-instruction (PI) entry, then the `~` note, then an equal-length pattern from the file. The note or pattern counts only when its times equal the file's offsets and the current span within 1 ms. | Fixes E78, E19 and the 4 partly estimated files (257 lines). The equality check means an edited time is never re-flagged (case 11). |
| D6 | **Estimates are exported with offsets, the `~` note (when notes are on), and a PI that carries each guessed edge, regardless of `timeNotes`.** | Keeps every user cut through a device move (#111), and keeps the estimate status across our own round trips. FLEx and ELAN drop PIs without error (v713) — so the PI survives only our own round trips. *(v717 review)* Through FLEx only the `~` note survives (read back per line, conservatively); with notes off nothing does except the equal-length rule. A device with segmentation off passes the file's PI through with its offsets. |
| D7 | **A one-line text keeps v714's real whole-file span, written quietly.** | A single line over one recording is a fact. Recording-mode transcription depends on it, and `exportBlob` may not have a decoded length available. |
| D8 | **The export writes offsets only from the live span** (when `segTimes` is on). A pending line or placeholder is written with no begin/end offsets and no "audio" note. With `segTimes` off, offsets pass through as in v714. *(v717 review)* One exception, for P4: a line the model could not place but nobody changed (`fileTimes` — a phrase nested in the one before, a sliver under 120 ms, a tail an older build clamped to a short decode) writes the file's own offsets back while its phrase still carries exactly them; the EAF uses them only where the tier stays ordered. | Ends the stale pass-through: no overlapping offsets (both-miss 3), no stale times on a line the Segmenter left without audio (`mgCommit`), and no guessed offsets reaching EAF through `phraseRows` (case 4). |
| D9 | **Stored times are never clamped to the decoded length.** `normalizeSegments` drops the duration clamp, and drawing and playback clip at use. Ends more than 350 ms past D raise a "right recording?" banner. | T53's 87,818 ms end survives any edit (case 18). E19' last line keeps its estimate status (case 19). |
| D10 | **Text edits in the plain text box move the times with the lines** (`reconcileBaseline` origins). Mismatched sections between unchanged lines pair by shared words, not by position. *(v717 review)* Word evidence first even when the counts match; only a gap the evidence leaves pairs in order (a line rewritten in place). A line moved past others keeps its words but not its time (`moved`): the recording's order is fixed. | Closes the open 2026-08-16-class hole (cases 1 and 8). |
| D11 | **A seam with a gap moves only the edge being dragged.** | A 10 ms nudge must not swallow a 1.2 s pause (case 13). |
| D12 | **EAF, CSV and SayMore exports:** placeholders and pending lines are written without times; estimates keep their values, since EAF has no estimate marker. | Writing guessed edges as unaligned EAF slots needs a manual check in ELAN first, so it is deferred (§10). |
| D13 | **The Audio Segmenter agrees with the editor:**<br>• in a partly timed text, untimed rows get the same spread, so no tail span is invented after them;<br>• its whole-file starting span is a placeholder;<br>• **Done** writes placeholders back as untimed. | Fixes case 3, and fixes v714's false "line 1 = whole recording" after an untouched Done. |
| D14 | **Repair is manual and never positional.** A later donor-file dialog matches lines only when guid **and** text agree. | The 2026-08-16 lesson, and case 9. |
| D15 | **Gating.** New researcher keys, each with the shape `!Sync.hasSession() \|\| settings.X === true` (on for a lone worker, off on managed devices until the researcher enables it):<br>• `timingBanner`;<br>• `keepTimes`;<br>• `gapLines` (Add here, Add all, and ✂ in a gap).<br>The device preference `showGaps` defaults to on. These are separate from `allowBlankLines`. | The project rule: every audio-segmenting control can be toggled on its own. A kiosk can stay plain. |
| D16 | **Public test fixtures are timing skeletons only.** Real offsets, notes and guids are kept; every word becomes `w`. | No Fayu text goes into the public repo. |
| D17 | **v713's `blank-lines` PI is not read.** | Only staging-v713 exports carry it. A one-off restore can be done if Seth needs one. |
| D18 | **Three releases.** v717 makes the truth visible and adds the safety fixes. v718 handles untimed lines (B2). v719 handles gaps (B1). | Each release can be tested on its own and rolled back on its own. v718 changes the data model and v719 adds UI rows. |

## 4. Releases and exact changes (all under `docs/js/` unless noted)

### v717 — truth and safety (no lines added, no time changed, no new editing controls)

| file | function | change |
|---|---|---|
| segments.js | new `edgeGuessed`, `isEstimate`, `placeSeam(a,b,t,edge)`, `splitSpanAt(cur,at,{real})`, `mergeSpanPair(a,b)` | Per-edge bookkeeping. Every operation below, and the Segmenter's verbs, use these so the rules live in one place. |
| segments.js | `normalizeSegments` | Pass 0: legacy migration (§2). Pass 1: the duration clamp is removed (`start<0` and the minimum length stay). Pass 2: a pushed start sets `guess[0]` and `estSource:'edit'`. End: derive `timeEstimated`. |
| segments.js | `moveBoundary` | `opts.edge` is `'end'`, `'start'` or `'seam'`. When the gap between the two spans is 1 ms or less, both sides move (as now). Otherwise only the named edge moves: the end within [a.start+min, b.start], the start within [a.end, b.end−min]. The placed edge is un-guessed on both sides, then `timeEstimated` is derived. |
| segments.js | `boundaryAtPlayhead`, `splitSegment`, `mergeSegments`, `applyGuessedSplitsWithin` | Built on `splitSpanAt` / `mergeSpanPair`. Playhead edges are real; nudged, fraction and ✨ interior edges set `guess`. A merge takes its start-side guess from a and its end-side guess from b, so a guessed inner boundary disappears. |
| segments.js | new `segmentsFollowLines(oldSegs, origins, {minMs})` | Builds the time list from the line origins: kept, exact or edit lines take the old span; a join takes `mergeSpanPair` folded; a split interpolates by word fraction (guessed interior edges); a new line is `{timePending}`. Then `normalizeSegments`. |
| segments.js | new `timingReport(spans, texts, {durationMs})` → `{level, items[]}` | Pure. Signals: dense (placed lines with ≥ 2 words only), tail-short (editor-made contiguous text), pastEnd, partly timed, no room, estimated count by source, no times, timeSync. |
| flextext.js | `parseInterlinearText` | Reads `<?flextext-editor v="2" time-estimates="GUID@[~]S-[~]E …"?>` into `doc.timeEstimatesPi`, using the same PI target as parked v713 with a different pseudo-attribute. If the test helper `test/lib/mini-xml-dom.mjs` lacks processing-instruction support, port it from wt-rt. |
| flextext.js | `segmentsFromOffsets` | Per span: a PI entry, used only if the guid is unique in the doc and S/E match the offsets within 1 ms; else a `~` note equal to the offsets within 1 ms; else an equal-length run (≥ 3 contiguous spans within ±2 ms). Each sets `guess`/`estSource`. Real spans get `guess:[null,null]`. The existing clamp now sets `guess[0]` on a start it moves (other finding 2). Applies to every caller listed in code map §1.2. |
| flextext.js | new `readLegacyEstimates(doc)` | For stored docs from before v717, it acts only on spans with **no `guess` field**. Same tests as above, comparing the note with **the current span and the phrase offsets**. Runs in memory; the result is saved with the next real edit (case 11). |
| flextext.js | `serializeFlextext` | `timed = isAligned(span)` (v718 adds `&& !isPlaceholder`). The note's `~` comes from `isEstimate`. When `segTimes` is on, a single-phrase untimed paragraph loses `begin/end-time-offset` (D8). The PI lists every estimated phrase that has a guid, regardless of `timeNotes`. |
| flextext.js | `reconcileBaseline` + new `reconcileBaselineWithOrigins` | Returns `origins[]`. The Pass-2 fallback works **per stretch between exact anchors**: when the counts match, lines pair in order (typo fixes); when they don't, they pair by the order-preserving best shared-word score, needing ≥ 50% of the old line's words. Unpaired new lines are fresh, with no offsets, guid or free translation copied. This also stops v714's cross-document fallback, where deleting line 2 and inserting at line 30 handed line 2's offsets and free translation to line 30. |
| seg-exports.js | `phraseRows`, `buildFxpa`, `buildSegPreviewHtml`, `serializeEaf` | A single-phrase paragraph never falls back to its offsets: the live span decides. The estimate flag comes from `isEstimate`. |
| segment-strips.js | `reconcile` | Calls `readLegacyEstimates`; calls `syncToLines` without a duration clamp; the `coverTail` guard now reads `doc.paragraphs[i].segments[0].attrs['end-time-offset']` (EX4); seed, heal and cover save through the new `deps.persistQuiet`, with no `modified` stamp. |
| segment-strips.js | `renderStrips`, `renderCut` (v714 has no state classes here), `drawStrip`, `wireWaveSeek`, `wireSegPlay`, `overviewMarks`, `attachEdgeHandles`/`makeBoundaryDrag` | Adds classes `seg-pending`, `seg-est`, `seg-check`. Clips to D when drawing and playing. The drag passes the handle side as `edge`; a dock mark is the `end` edge. |
| app.js | `applyBaseline` | When `docCarriesTime`: `reconcileBaselineWithOrigins` then `segmentsFollowLines`. If the counts still disagree, it falls back to `syncToLines` and sets `rec.timeSync` quietly, which turns the banner red. |
| app.js | new `saveQuiet()` | `rememberTab`'s pattern made general: `db.putDoc(current)` without stamping. Used by `reconcile`, `rec.timingAck` and `rec.timeSync`. |
| app.js | `decorateGlossSegments`, `mgDraw` | The same state classes. |
| app.js | `mgMoveBoundary`, `mgSplitSpan`, `mgJoinSpan`, `mgCommit` | Use `placeSeam` / `splitSpanAt` / `mergeSpanPair`. A midpoint split with no playhead now records a guessed edge (in v714 it was saved as real). `mgCommit` carries `guess` and derives `timeEstimated`. |
| app.js | new `renderTimingBanner()` beside `#ws-banner` (APP:609) | One severity-ordered message with **Details** (the list), **Show** (first flagged line) and **Dismiss** (`rec.timingAck` = signature, saved quietly; the banner returns when the signature changes). Editor tabs only, with audio attached and `timingBanner` on. |
| db.js | `spanCount` (80-81) | Gets the same rule as `docIsUncut`: a text whose spans are all estimates counts as uncut. lameta.js:366 gets the same change. |
| css/app.css | next to 321-322 and 3551 | Distinct styles: pending (dotted, muted, ⋯), estimate (dashed), check (red left bar and badge). Added to `.seg-strip`, `.cut-row`, `.gseg-bar` and `.mg-span`. |
| i18n.js | next to `seg.pendingTip` (1297 / 4006) | New EN and ID strings: `seg.estTip.{note,marker,pattern,edit,legacy}`, `seg.checkTip`, `timing.{noTimes,estimated,check,pastEnd,timeSync,details,show,dismiss}`. `seg.pendingTip` is reworded (case 20): "No time yet. Join it with the line before, then split it again with the playhead at the right moment." |

### v718 — untimed lines (Seth's B2) on the placeholder model

| file | function | change |
|---|---|---|
| segments.js | new `spreadUntimed(segs, D, {minMs:400})` | For each run of lines that are not placed: lo is the previous placed end (or 0), hi is the next placed start (or D). The run is divided evenly with `round(lo + m(hi−lo)/k)`. Sets `phAt` and `guess` on the interior edges and on edges that touch a neighbour; C0 edges stay real. If hi − lo < k × 400, the lines stay `{timePending}`. A single untimed line in a one-line text is left to D7. Deterministic. |
| segments.js | new `isPlaceholder`, `isPlaced`, `storableSegments`, `isV714Seed(span, k, step)` | Seed recognition: a legacy estimate whose phrase has no offsets, whose length is within 2 ms of `step` and whose start is within 2 ms of k × step. `step` is taken from the spans' own mean length, not this device's D, so a ±70 ms decoder difference can't hide a seed (case 12). |
| segments.js | `splitSpanAt`, `mergeSpanPair` | Opt in to keeping placeholder status: when splitting a placeholder at a point that is not the playhead, both pieces get `phAt` = their own values; merging two placeholders gives `phAt=[a.start,b.end]` (case 2). |
| segment-strips.js | `reconcile` → exported as `prepareDisplaySpans(doc, d)` | Order: `readLegacyEstimates`, then v714 seeds become pending, then `syncToLines`, then `spreadUntimed`. The seed and heal branches are removed and **nothing is saved**, except D7's quiet one-line write and `coverTail` until v719. |
| segment-strips.js / app.js | renderers | Classes `seg-needs` (a placeholder in a partly timed text: amber bar plus "needs timing" badge, dashed), `seg-noroom` (amber, ⋯) and `seg-spread` (a placeholder in an all-untimed text: dashed only). `docIsUncut`, `landingTab` and `guessAllowedHere` treat placeholders as uncut. ✨ is still allowed on them; its pieces become estimates. |
| db.js | `putDoc` → `storableRecord(record)` | Works on a shallow copy, so the in-memory `current` is never touched. Covers `doc.segments` and `matchDraft.spans` (case 5, both-miss 1). |
| flextext.js / seg-exports.js | `serializeFlextext`, `phraseRows`, `serializeEaf`, `buildFxpa`, `buildSegPreviewHtml` | A placeholder is exported as untimed (D8 and D12). |
| app.js | Gloss entry (APP:2358-2365) | After `ensurePeaks`, calls `prepareDisplaySpans`, so the Gloss tab shows the same bars as the Baseline tab. |
| app.js | `mgLoad`, `mgPrepareAudio` (10712-10737), `mgCommit`, `mgSaveDraft`, `mgOpen` (10842) | Partly timed texts get `spreadUntimed` over `MG.spans`. The tail span is added only when the last row is placed. The whole-file starting span gets `phAt=[0,dur]`. `mgCommit` carries `phAt` and `guess`. A draft stores `baseSig` (paragraph guids plus span values); if the doc changed since, the draft does not resume silently and offers "Resume matching (discards later edits)" or "Start from the text" (case 22). |
| app.js | new `keepLineTimes(i)` | **Keep these times**, shown only on the active row, when `adjustBoundariesAllowed() && keepTimes`. Sets `guess=[null,null]`, drops `phAt`, and removes our `audio …` note from that phrase's `postItemsXML` (case 7). One `captureUndo` and one save. |
| css / i18n | — | Adds `seg-needs`, `seg-noroom`, `seg-spread`, `timing.{partly,noRoom}`, `keep.*` and `mg.needsTiming` (replacing "No audio for this line" for placeholder rows). |

*(v718, as built — branch `time-untimed`.)* Where the build settled a question the table left open:

- **A line holding the file's own times (`fileTimes`) is not untimed.** `spreadUntimed` leaves it pending, with its hold, and gives it no share of the room (P4).
- **A placeholder joined to a line with no room stays a placeholder**; joined to a placed line it is that line's time with the spread's guess on the far edge — dashed, stored, exported with `~`. A nudged cut counts as "not the playhead".
- **Seeds:** `seedsToPending` recognises v714–v716's flag-only seeds (read back as `legacy`) span by span: `step` from their mean length (a drag between two seed lines leaves it unchanged), `k` the grid point nearest each start, two hits at least. v717's seed is written per edge exactly like a word-fraction split, so it is recognised only WHOLE — every line a candidate, exactly the even division of [0, last end] — and an even split of a real line stays an estimate and is exported (case 6). The Segmenter's `mgLoad` and every export apply it too.
- **Gloss:** `prepareDisplaySpans` runs inside `decorateGlossSegments`, so every decorate after a Gloss edit re-spreads.
- **"Already on Drive":** `uploadContentSig` hashes the stored form (`db.storableRecord`), and `prepareDisplaySpans` tells the host (`keepInSync`) when it changed what storage would hold, so drawing an untimed text is not an edit.
- **Keep's durability (case 7 and 17):** a writer that holds no estimates writes an instruction listing none (`time-estimates=""`) whenever the times it writes contain an even run the equal-length rule would misread, and a classic device passes that claim on; the reader skips the rule for any file carrying our instruction. Without it, a Kept even run came back dashed after our own export and import. It affects no corpus file (the gate: 170 untouched exports identical to v717's).
- **Case 22:** `baseSig` hashes the paragraphs (not only their guids) and the stored span values. A changed text asks "Resume matching (discards later edits)" / "Start from the text" (`confirmDialog` gained named buttons); "Start from the text" leaves the old draft untouched until the first edit, so Escape or a look-and-leave loses nothing.
- **Amber only for the exception (P6):** `seg-needs`/`seg-noroom` and an amber 'partly' apply while untimed lines are at most half the text. Driving U60 showed why: after one drag on seam 5|6, the next render turned the other 58 lines amber. A mostly untimed text keeps the dashed spread and an info line ("Most lines have no audio time yet"). A drag restyles every row on release (`restyleRows`), since it rebuilds none.
- **Browser (§6.4, headless Firefox, the scratchpad rig — element clicks; file picks, focus and drags synthetic and labelled):** R6 on U60 — 60 dashed rows, the info banner, nothing stored or exported as a time, a pure reopen leaves `modified` alone, seam 5|6 times lines 5–6 only (every other row to the millisecond), one Undo and one Redo; R7 on a partly timed T18 (lines 5–6 untimed) — amber rows, badge and banner, the Gloss bars the same, Keep shown only on the active line, one Undo and one Redo; R8 — the case-3 text in the Audio Segmenter shows rows 5–8 "Needs timing", no ninth row, and Done stores 8 lines with rows 5–8 untimed; R12 — 375 px, no horizontal scroll. Not driven: R11's managed-device gating (node-tested). Re-run at the finish (Firefox 157, same harness): R6, R7, R8 and R12 as above; R7 also checked against the file — all 16 timed lines exactly their file times, lines 5–6 inside their neighbours' room and stored untimed.
- **A stored seed is no time on export either:** `spansForExport` applies `seedsToPending` too, so a record v714 seeded and nobody reopened (sent from the list, auto-backup) exports no times.
- **The remembered Cut tab** accepts the attached recording as proof of audio (an untimed text stores no span any more).
- **Gate (§6.5):** untimed texts opened at 60 s: 101 drawn evenly, 3 "no room" (over 150 lines), 27 one-line (D7), nothing else written, no times exported; v714's stored seed on a device decoding 70 ms longer: 104 texts, 3,797 lines, 0 missed, none exported as times whether reopened or not (v717's stored seed, with `--baseline` at v717: the same 104, 0 missed). Against v717: 170 untouched exports identical. *(Finish)* The gate also opens every timed text as a PARTLY timed copy (lines k % 6 = 2, 3 made untimed by our own export, at the recording's length): 38 texts, 492 lines, every one drawn inside its own room and the room shared evenly, 0 timed lines moved or re-guessed, 0 written, stored or exported with a time, amber on all 38 (all at most a third untimed). And each of the 104 multi-line untimed texts shows exactly one info banner and no marked line.

### v719 — gaps (Seth's B1) as display rows plus one-click add

| file | function | change |
|---|---|---|
| segments.js | new `gapRowsFor(spans, D, {minMs:350})` | Lead gap (before line 0, when line 0 is placed), gaps between two placed lines, and the tail gap (after the last line, when it is placed); each ≥ 350 ms. Never next to a pending line or placeholder, because that room belongs to the run (D3). |
| segments.js | new `gapHasSpeech(peaks, msPerBucket, s, e)` | Reuses `frames`/`pct` from the ✨ code: a gap ≥ 1000 ms with ≥ 400 ms voiced. |
| app.js | new `insertLineAt(doc, k, span)`, `addGapLine(k)`, `addAllGapLines()` | Splices `doc.paragraphs` and `doc.segments` at the same index **directly**, not through `reconcileBaseline`, because LCS could pair a new blank line with a neighbouring blank. `paraOf` is inherited only when both neighbours share it. Add all works from the end backwards. Each is one `captureUndo` and one save. Add all confirms first: "Adds N empty lines. They become part of the text and go into FLEx exports like any line. Undo removes them all." |
| segment-strips.js | `renderStrips`, `renderCut`, `cutAtPlayhead` caller | Rows `.gap-row[data-gap=k]` with **no** `.seg-strip`, `.cut-row`, `.seg-text` or `data-i`, so `focusStripAfter` (SS:1403), the ticker (SS:1535) and `linesOf` (APP:2111) still count only lines (case 15). They show ▶, a waveform, a range label, Add, and `gap-speech` when there is speech. ✂/Enter with the playhead in a gap calls `addGapLine` instead of refusing with 'outside'. `coverTail` and its call are removed; the tail gap row replaces it. |
| segment-strips.js / audio.js | new `gapMarks(spans,D)` plus `Player.setGapMarks(list)` | A separate layer. `setBoundaries` keeps exactly one entry per seam, so dragging mark k still moves seam k (case 15). |
| app.js | toolbar | "Show gaps (N)" uses the `showGaps` preference. While an unacknowledged red signal is showing, Add is hidden on the gap rows and the row says "Check alignment first" (case 16). |
| css / i18n | — | Adds `gap.*` and `gap.addAll.confirm`. |

### Later (not in v717–v719)

- The repair dialog (§10).
- Typing into a gap row.
- Writing guessed edges as unaligned EAF slots.
- A pairing score.
- Gap rows in the Segmenter.
- Untimed and estimated lines in PAT.
- A library status chip.
- Performance on texts over 165 lines.

## 5. Every adversarial case, resolved

| # | Case | Resolution | Release |
|---|---|---|---|
| 1 | Textarea insert, then `syncToLines` re-pairs by position | **Fixed.** D10: origins plus `segmentsFollowLines`; `syncToLines` is only a last resort and turns the banner red (`timeSync`). | v717 |
| 2 | Joins, splits without the playhead, and drags turn guesses into exported times | **Fixed.** Joining two placeholders, or splitting one without the playhead, keeps them as placeholders, which are not exported. A drag makes only the dragged edge real; the other edge stays guessed, so the line stays dashed and is exported with `~` plus the per-edge PI. **Accepted residual:** ELAN receives the guessed edge's value, because EAF has no marker (D12). | v717/718 |
| 3 | Segmenter **Done** replaces the stand-in lines with a tail blank | **Fixed.** D13: untimed rows are spread, so no tail span appears after untimed rows, and placeholders are written back as untimed. | v718 |
| 4 | EAF falls back to the phrase offsets | **Fixed.** `phraseRows` uses only the live span for single-phrase paragraphs, and placeholders are untimed. **Accepted:** E78's stored estimates still go to EAF as values, and the banner says so. | v717/718 |
| 5 | Placeholders reach storage through `rememberTab` and the other 22 `putDoc` calls | **Fixed.** `storableRecord` sits inside `db.putDoc`. A source test checks that `docs/js` has no IndexedDB `put` outside db.js. | v718 |
| 6 | Three equal splits become placeholders | **Fixed.** The equal-length rule runs only on spans from the file (equal to the offsets) and only marks them as estimates, never placeholders. Estimates are always exported. | v717 |
| 7 | "Keep" is undone by re-reading the note | **Fixed.** `guess=[null,null]` is explicit, the legacy reader skips spans that have the field, and Keep removes our note. | v718 |
| 8 | Design B's origins inherit through the in-order fallback | **Fixed.** Stretch pairing by shared words: "c x" takes c d's time, guid and free translation; "NEW LINE" is fresh. | v717 |
| 9 | Repair mis-pairs split and joined lines | **Fixed by design (later release).** Lines match only when guid and normalised text both agree. Placed times are never overwritten without a tick. Everything is previewed, and the whole repair is one Undo. | later |
| 10 | Copied flags make ✨ and ✂ pieces get re-spread | **Fixed.** Placeholder status depends on values, so copies don't count. | v718 |
| 11 | The migration compares the note with the old offsets | **Fixed.** The note must equal both the current span and the offsets. | v717 |
| 12 | v714 seeds keep producing E78-like files | **Fixed.** In v717 opening no longer stamps `modified` (no upload); in v718 `isV714Seed` turns them into placeholders. **Accepted for one release:** an edited v714-seeded doc exported from v717 still carries estimates, marked with `~` and the PI. | v717/718 |
| 13 | A seam drag swallows a gap | **Fixed.** D11, in `moveBoundary` and `mgMoveBoundary`. | v717 |
| 14 | Typing in a gap row creates two Undo items | **Avoided.** Typing into a gap row is not shipped; the explicit Add creates one item. Before it ever ships, a browser test must show one Undo and one Redo, including during IME composition. | later |
| 15 | Code that finds rows by order miscounts gap rows | **Fixed.** Gap rows don't use the line classes, and gap marks are in a separate layer (source test). | v719 |
| 16 | The L29 tail row invites retyping the last sentence | **Fixed.** The red check-alignment banner shows, and Add is hidden until it is acknowledged. | v717/719 |
| 17 | The dense check flags spread lines; the equal-length check flags genuine annotations | **Fixed / accepted.** Dense applies only to placed lines with ≥ 2 words. An equal-length false positive is only dashed with a tooltip, and Keep clears it. | v717 |
| 18 | Every edit clamps T53's end | **Fixed.** D9. | v717 |
| 19 | E19' last line is clamped and loses its `~` | **Fixed.** The mark is read at import, before D is known, and nothing is clamped. | v717 |
| 20 | The "no room" tooltip can't be followed | **Fixed.** Reworded (join, then split with the playhead). | v717 |
| 21 | Rolling back leaves lines pending | **Accepted.** Storage only holds pending for lines with no known time, which is the truth. All-untimed docs store nothing, so v714 re-seeds them. v714 can still join, play and export them. The policy is to fix forward (v718.1), not roll back. | — |
| 22 | Resuming a draft discards later editor changes | **Fixed.** The `baseSig` check. | v718 |
| 23 | `segTimeNotes` is on by default | **Noted.** The PI is written regardless of notes, and the equal-length rule covers devices that had notes off. | v717 |
| BM1 | Storage chokepoint | `db.putDoc` | v718 |
| BM2 | The equal-length rule must use spans from the file | Guarded: the span must equal the offsets, and split pieces never carry offsets. | v717 |
| BM3 | Stale pass-through offsets overlap | D8 | v717 |
| BM4 | The one-line seed is a stamped write | D7: a quiet write | v717 |
| BM5 | Gating | D15 | all |
| BM6 | Decoder spread between devices | Test tolerances; seed step taken from the spans; the pastEnd banner. | v717/718 |
| BM7 | Be honest about pass-through | Banner wording: "This text carries estimated times from an earlier version. They are kept and written back marked as estimates until you re-cut them." | v717 |
| Other 1–3 | `coverTail` guard; clamp with no flag; textarea | All fixed: the guard reads the offsets; the clamp sets `guess[0]`; D10. | v717 |

## 6. Tests

### 6.1 New node tests (`node --test "test/*.test.mjs"`)

| file | asserts |
|---|---|
| `time-guess-edges.test.mjs` | • Each op: playhead edges real; nudge, fraction and ✨ edges guessed; a merge drops the inner guess.<br>• `moveBoundary` with `edge` across ELAN40-shaped spans [2230–4153, 5346–6846]: a 10 ms nudge of the end leaves the next start at 5346 (case 13); a contiguous seam moves both sides.<br>• Legacy migration (seed, fraction pieces, merge-inherit).<br>• Property test over random op sequences: `timeEstimated === isEstimate` after every op, and C0 edges are never guessed. |
| `spread-untimed.test.mjs` | • EX1: "dua" gets 2000–5000. Two lines in that room get 2000–3500 and 3500–5000.<br>• A leading run gets [0, first.start]; a trailing run gets [last.end, D].<br>• A room under k × 400 stays pending ("no room").<br>• All-untimed gives exactly `round(kD/N)`. N=1 follows D7.<br>• Placed spans are never changed (property). Deterministic. D=0 gives no spread. |
| `time-placeholders.test.mjs` | • Merging two placeholders gives a placeholder. A split without the playhead gives two placeholders.<br>• A ✂ at 5000 inside a placeholder stays 5000 after re-spreading (case 10).<br>• ✨ at 4000/7000 stays 4000/7000.<br>• Three equal fraction splits of a real line are estimates, not placeholders, and are exported (case 6).<br>• `isV714Seed` with D off by ±70 ms. |
| `time-estimate-readback.test.mjs` | • E78 skeleton: 78/78 estimates (note); E19 skeleton: 19/19, with the last line still an estimate when D=45990 (case 19).<br>• A note that disagrees with the offsets is not an estimate. A PI entry with a duplicate guid is ignored.<br>• Pattern: 3 equal lines are flagged, 2 are not.<br>• Legacy reader: a dragged seam is not re-flagged (case 11); a span with `guess` is skipped (case 7).<br>• Export → import → export keeps every `~`. With `timeNotes:false` the PI carries the per-edge state and re-import is identical. |
| `time-export-gate.test.mjs` | • Placeholders and pending lines carry no offsets and no audio note (D8).<br>• `mgCommit`-pending with stale offsets is exported untimed.<br>• E78 skeleton with line 10 re-cut: no two exported phrases overlap, and re-import gives identical spans (BM3).<br>• `phraseRows` and EAF: no fallback to offsets, placeholders untimed (case 4).<br>• With `segTimes:false`, offsets pass through exactly as in v714. |
| `baseline-lockstep.test.mjs` | • ELAN40 skeleton, one line inserted after line 6 through `applyBaseline`: all 40 original lines keep identical times (case 1).<br>• Case 8: "c x" keeps c d's guid, free translation and time; NEW LINE has no offsets.<br>• Delete line 2 and insert at line 30: no offsets or free translation cross the document.<br>• The 2026-08-16 replay: the 53-line, 23-blank T53 skeleton through the textarea keeps 53 lines with identical times.<br>• Joins and splits are recognised.<br>• The forced fallback sets `timeSync`. |
| `no-duration-clamp.test.mjs` | • T53 skeleton at D=87755: the 87818 end survives a split anywhere (case 18).<br>• Draw and play clip to D.<br>• pastEnd fires only beyond 350 ms. |
| `timing-report.test.mjs` | On the skeletons:<br>• the damaged legend L29 is red (dense line 3, tail-short 2076 ms);<br>• L29 (13 Aug export): no signal;<br>• T53, T151, T18: none;<br>• E78: estimates (note);<br>• untimed: one info item and no per-line marks;<br>• partly timed: amber count;<br>• dense ignores placeholders and estimates (case 17). |
| `storage-chokepoint.test.mjs` | • `storableRecord` removes `phAt`, stores placeholders as pending and does not mutate its input; `matchDraft.spans` too.<br>• Source scan: no IndexedDB `put(` outside db.js; `reconcile` and `prepareDisplaySpans` never call `schedulePersist` (BM1, case 5). |
| `segmenter-placeholders.test.mjs` | • Case 3 replay (8 lines, first 3 seams dragged): Done adds no line and no stored time for rows 5–8.<br>• An untouched whole-file span on Done stores nothing.<br>• Split and join in the Segmenter use the helpers.<br>• A `baseSig` mismatch stops auto-resume (case 22). |
| `gap-rows.test.mjs` | • ELAN40 skeleton: 39 rows at 350 ms (1 lead, 37 interior, 1 tail); none next to pending lines or placeholders.<br>• `insertLineAt` splices both arrays at k; `paraOf` only when shared.<br>• Add all on ELAN40 gives 79 lines, with every original time unchanged.<br>• Source checks: `.gap-row` has none of the line classes or `data-i`; `setBoundaries` length equals the seam count (case 15).<br>• `coverTail` is gone. |
| `time-undo.test.mjs` | • For Keep, Add here, Add all, ✂ in a gap, an edge drag, and a textarea apply: exactly one `captureUndo` before the change and one save.<br>• Lifted `applyUndoState` → `prepareDisplaySpans` with a stub save: no write and no `modified` change after Undo or Redo. |
| `timing-fixtures-clean.test.mjs` | Every fixture under `test/fixtures/timing/` contains only the tokens `w`, `g`, `ft`, `Skeleton` and `-` (D16). |
| `i18n-parity.test.mjs` (existing) | Covers every new key in EN and ID. |

### 6.2 Fixtures (real files, timing skeletons)

- **Where:** `test/fixtures/timing/`.
- **Skeletons already built:** elan40, e19, t151, l29 (14 Aug, damaged), l29-13aug, e78, t53, t18. They are in `plan-work/minimal-design/skel`, made by `skeleton.mjs`.
- **To add:** an all-untimed 60-line FLEx skeleton (U60).
- **Recording lengths for each skeleton** come from `v713-audit/durations.json`, entered as constants: T53 m4a 87,755, E19 45,990, ELAN40 125.5 s.

### 6.3 Existing tests to update (everything else must stay green, 777/777)

| file | lines | update |
|---|---|---|
| adjust-boundaries.test.mjs | 35-36 | Per-edge: the dragged edge becomes real, and the far edge stays guessed when it touches an estimate. |
| segments-ordering.test.mjs | 87-117 | No duration clamp. |
| cut-tab-ui.test.mjs | 283-296 | v717: guard regex; v719: removal. |
| matcher-audio.test.mjs | 172-182 | `spanCount` rule. |
| matcher-audio.test.mjs | 311-314 | Tail only after a placed last row. |
| seg-exports.test.mjs | 143-166 | Pending lines carry no offsets; `~` from `isEstimate`; the PI. |
| seg-exports.test.mjs | 358-364 | The overlap-demoted line is exported untimed. |
| lameta-progress.test.mjs | 93 | Aligned count. |
| edge-cut-nudge.test.mjs, guess-piece.test.mjs | — | Assert `guess` edges in addition to `timeEstimated`. |
| roundtrip-blanks.playwright.mjs | — | Unchanged: 6 lines and 6 spans, last end 12000. |

### 6.4 Browser checks with real clicks

Run in Chromium (Playwright) and in the Firefox headless harness. Synthetic steps are labelled. Undo and redo are read the way `cut-tab.playwright.mjs:402-410` reads them.

- **R1.** Open the E78 skeleton with audio:
  - 78 rows dashed, with the estimate tooltip;
  - export, then re-import: still dashed;
  - nothing saved on open (`modified` unchanged).
- **R2.** Damaged L29 skeleton:
  - red banner;
  - **Show** jumps to line 3;
  - Dismiss is quiet and persists across a reload.
- **R3.** ELAN40 skeleton, drag line 1's right edge by 10 ms:
  - line 2's start is unchanged;
  - one Ctrl+Z restores it and one redo re-applies it.
- **R4.** Classic textarea on ELAN40 before the audio arrives: insert a line, attach the audio, and every worded line plays its own audio.
- **R5.** T53: split line 10, then reload. The last end is still 87818.
- **R6 (v718).** Untimed 60-line skeleton:
  - dashed rows, one info banner, no amber;
  - export has no offsets;
  - dragging seam 5|6 makes only lines 5–6 estimates; the other lines are unchanged;
  - one Undo restores it.
- **R7 (v718).** Partly timed doc:
  - amber "needs timing" rows at the spread times;
  - Gloss shows the same bars;
  - Keep makes the row solid, with one Undo and one Redo.
- **R8 (v718).** Segmenter on the case-3 doc: Done adds no line.
- **R9 (v719).** ELAN40:
  - 39 gap rows;
  - ▶ plays the gap;
  - Add here gives 41 lines, one Undo gives 40;
  - Add all asks for confirmation, gives 79, and one Undo returns to 40;
  - Enter at the end of a line jumps to the next **line**, not to a gap row;
  - dragging dock mark k moves seam k.
- **R10 (v719).** ✂ with the playhead in a gap on the Cut tab adds a line (one Undo).
- **R11.** Researcher toggles off: Keep, Add, Add all and the banner all disappear; the listening page is unchanged (`listening-page.playwright.mjs` still green).
- **R12.** Phone width (375 px): the banner and gap rows have no horizontal scroll.

### 6.5 Corpus gate

`tools/corpus-timing.mjs <folder>` is new. It is local only, reads files without writing, prints counts and no text, and is never run in CI. It runs on the read-only originals before every staging hand-off and must show:

- 0 time changes on placed lines across all 170 files, 0 lines gained on open, and both opens identical.
- Classes: 24 contiguous, 3 ELAN-with-gaps, 4 fully estimated, 4 partly estimated, 4 damaged, 131 untimed.
- Exactly 257 estimate lines in 12 files.
- Red on exactly the 4 damaged L29 files.
- v719 gap rows: ELAN40 39, ELAN52 51, ELAN43 33, each damaged L29 1, everything else 0.
- An untouched export is byte-identical to v714's, apart from an expected-diff list:
  - timed files: the `~` restored on 257 notes, and one PI line in those 12 files;
  - v717 only: one PI line in untimed texts opened with audio, which still carry v714's seed;
  - from v718: untimed texts are exported with no seeded offsets at all.

## 7. Rollout

1. **Branches.** One feature branch per release, from current `main`: `time-truth` (v717), `time-untimed` (v718) and `time-gaps` (v719). Each later branch starts after the previous release is on `main`. Commits come only from scratch worktrees, never from Seth's checkout, which is on his own branch.
2. **Before each hand-off:**
   - all node tests;
   - Playwright and the Firefox harness;
   - the corpus gate;
   - an `xmllint` check of an exported file carrying the PI against FlexInterlinear.xsd, as v713 did.
3. **Testing.** Each release goes to its own branch preview, because these are major engine changes. Then it is merged with `--no-ff` into `staging` as the integration check, and Seth tests it there with §6.4 and his own files.
   - The Deploy-to-staging/preview workflow runs only when Seth asks. The repo is public and uses standard runners, but the GitHub-cost rule still means asking first.
4. **Release.** Fast-forward into `main`, then `productionWeb`, **only when Seth says "release it"**. Then verify the live engine version twice. If staging fails, revert the merge on `staging`; the feature branch keeps the work.
5. **Rollback.** Fix forward (`v71x.1`) rather than roll back. Stored data stays truthful in every release (case 21).

## 8. What new users see

They are on v714 today.

- **v717**
  - Timed texts look exactly as before.
  - Texts with guessed times show them dashed, with a short banner.
  - Opening a text with audio no longer marks it as changed, so it no longer triggers a re-upload.
  - Nothing is added and no time moves.
- **v718**
  - An untimed text still shows the familiar even spread, now with one info banner.
  - Opening saves nothing, and exports no longer contain guessed times.
  - A line without a time in a timed text sits in its gap and is marked "needs timing".
  - On a managed device, Keep appears only if the researcher enables it.
- **v719**
  - Pauses of 0.35 s or more in ELAN-made texts show as "unassigned audio" rows.
  - Nothing is added unless the user clicks Add, which managed devices also need enabled by the researcher.

## 9. What you will see, Seth (plain language)

- **Fully timed file** (T53, T151):
  - No change. Every line is solid and plays its own audio.
  - No banner, no new rows. T53's last line keeps its time, even though the m4a decodes 63 ms shorter.
- **ELAN file with gaps** (ELAN40):
  - From v717: dragging the edge next to a pause moves only that edge.
  - From v719:
    - each pause of 0.35 s or more shows as a thin "unassigned audio" row with ▶ and "Add a line here", 39 in ELAN40;
    - pauses that hold speech are tinted amber;
    - "Show gaps (39)" hides them, and "Add a line for every gap" adds them all after asking, all undone with one Undo.
  - Nothing is added and the export doesn't change until you click.
- **Partly timed file** (made in the app, e.g. a line typed while segmentation was off):
  - From v718: each untimed line gets an even share of the audio between its timed neighbours, drawn dashed with an amber "needs timing" mark.
  - With no audio between them, it shows ⋯ and "no room".
  - Timed lines never move. Exports leave untimed lines untimed until you set them.
- **File with no times** (every FLEx export, 131 files):
  - The same even spread you see now, dashed, with one quiet banner: "No audio times yet — lines are spread evenly as a placeholder."
  - No warning on each line.
  - From v718, opening saves nothing and exports stay untimed until you cut.
- **File with `~` estimates** (E78, E19):
  - From v717: every line is dashed, with the banner "This text's times are estimates (78 of 78). They are kept and written back marked as estimates until you re-cut them."
  - Each seam you drag becomes real on both sides.
- **The damaged legend L29** (14 and 17 Aug):
  - From v717, a red banner: "Lines and audio look out of step. Line 3 has 4 words in 0.12 s, and the recording runs 2.1 s past the last line. Files saved around 14–17 Aug 2026 can have this. Compare with an earlier export before editing."
  - Nothing is changed automatically.
  - In v719 the 2.1 s at the end shows as a gap row, but with no Add button until you dismiss the warning.

## 10. Left for later, and what not to ship

**Later:**

- **Repair dialog.** Takes a donor .flextext or .eaf. It matches lines by guid **and** text, refuses below 50%, previews every change, can optionally put back empty lines, and is one Undo.
- **Typing into gap rows.** Needs the one-Undo browser test, including IME.
- **Unaligned EAF slots for guessed edges.** Needs a manual check in ELAN.
- **Pairing score.** Behind a researcher flag, since only one damaged text exists.
- **The N=2 seed pattern** (two lines exactly covering [0, D]).
- **Gaps in the Segmenter.**
- **PAT reading estimates and untimed lines.**
- **Library status chip.**
- **Texts over 165 lines** (performance).
- **Reading the v713 `blank-lines` PI.**

**Do not ship:**

- the parked `healGapLines` / `settleTail` (they add lines on tab entry with no Undo item);
- `BLANK_LINES_PI`;
- any positional shifting;
- times read from the note text when the offsets are missing;
- automatic gap lines on open.

## 11. Decisions for Seth

1. **Gaps:** display rows with one-click add (recommended), or lines inserted on open as literally asked (cost: D1).
2. **Gap threshold:** 350 ms (recommended; 120 rows across the three ELAN texts), or 1 s (75 rows).
3. **Gating:** the new controls follow the researcher-toggle pattern of `allowBlankLines` (recommended), or are always on.
4. **Fixtures:** timing skeletons only in the public repo (recommended), or real text.
5. **Order:** ship v717 first (recommended). It closes the textarea hole that new users can hit today, before B2 and B1.

## 12. Data actions meanwhile (no code needed)

- **L29:** repair the 17 Aug file using the 13 Aug times, line by line. Don't just switch to the 13 Aug file: that would lose 78 glosses and 18 free translations added since.
- **the two estimate-only texts (E78 and E19):** these need real cutting, because their times are guesses.
- **A 38-cut text:** the 14 Aug export lost all 38 cuts. Use the latest timed export, 2026-08-18-1428; every export from 17 Aug on has the cuts.
