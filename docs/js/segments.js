/* segments.js — time-aligned segment spans for the Simple-ELAN-style baseline editor.
 *
 * PURE MODULE, NO DOM. Every function here is a total function over plain data, so the whole
 * crossing-prevention story is unit-testable without a browser. That is deliberate: this is the
 * part of the feature that can silently corrupt field data, so it must be the part that is easiest
 * to test exhaustively.
 *
 * WHAT A SEGMENT IS: `{ start, end, timePending?, timeEstimated?, guess?, estSource? }`, milliseconds.
 *   - `timePending: true`  — the user made a break but there was no valid time for it (they scrubbed
 *     backwards, or there was no room between neighbours). The TEXT still exists; the segment simply
 *     carries no time until they set one. NEVER fabricate a time to avoid this state.
 *   - `guess: [gs|null, ge|null]` (v717) — the value of each EDGE that is a guess (interpolated, nudged,
 *     detected by ✨, or read back as an estimate from a file). An edge counts as a guess only while
 *     its value is still within 1 ms of the recorded one, so any real edit clears it with no flag to
 *     remember. `[null, null]` says "both edges are real", explicitly — see readLegacyEstimates.
 *   - `timeEstimated: true` — a DERIVED copy of isEstimate(span), re-derived after every operation, so
 *     v714, the .fxpa, PAT and a rollback keep reading the one flag they know. Rendered dashed.
 *   - `estSource` — where the guess came from ('note' | 'marker' | 'pattern' | 'edit' | 'legacy'),
 *     for the tooltip only.
 *   - `fileTimes: [b, e]` (v717, on a PENDING span only) — the model could not use this line's times
 *     (its phrase overlaps a neighbour, or is shorter than MIN_SEGMENT_MS, or an older build clamped
 *     it), but nobody has changed the line since: while its phrase still carries exactly these offsets,
 *     the export writes them back as they came (P4). Any operation that re-times the line drops it.
 *   - `phAt: [s, e]` (v718, IN MEMORY ONLY) — the values a PLACEHOLDER was given by spreadUntimed: a
 *     line with no time, drawn evenly in the gap its timed neighbours leave. It is a placeholder only
 *     while its values still equal these (isPlaceholder). Never stored, never exported — see below.
 *   - `noRoom: true` (v718, IN MEMORY ONLY, on a pending span) — spreadUntimed found no room for it
 *     between its timed neighbours. A display mark; storage drops it.
 *
 * ⚠ THE INVARIANT THAT MATTERS: aligned segments must be strictly increasing and non-overlapping.
 * That is not merely our internal tidiness — ELAN REQUIRES aligned annotations within a tier to be
 * ordered and non-overlapping, so a crossing segment could not be exported to EAF at all.
 * `normalizeSegments` is the single enforcement point; run it after EVERY structural edit.
 */

/** Shortest span we will accept as a real segment. Below this, a "segment" is a mis-click. */
export const MIN_SEGMENT_MS = 120;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** A segment carries a usable time only if both ends are real numbers and not explicitly pending. */
export function isAligned(seg) {
  return !!seg && !seg.timePending && isNum(seg.start) && isNum(seg.end) && seg.end > seg.start;
}

/* ⚠ A TIER THE USER CANNOT REACH MUST NOT BE REQUIRED (Seth, 2026-09-08).
 *
 * The audio side of a split is placed with the ✂ that hangs under the PLAYHEAD, and the tickers
 * draw that ✂ only while the playhead is actually inside this line's segment. So a line the
 * playhead was nowhere near listed an `audio` tier that had no control anywhere on screen: placing
 * the words tier left the split pending for ever — Seth saw it as "orange border and cancel button
 * show, but not scissors buttons", and as a line that simply refused to cut. Nothing was written,
 * so nothing was corrupted; it just could not be finished, and the ✕ was the only way out.
 *
 * The engine already has the answer for a split with no placed time: splitSegment interpolates by
 * word position and marks the result timeEstimated. So when the playhead is elsewhere the audio
 * tier drops out and that interpolation takes over — which is also what makes it possible to split
 * a line you have not typed a translation or glosses for yet, the thing Seth asked for. With the
 * playhead inside the segment nothing changes: the ✂ is there, so the tier is required and placed.
 *
 * Pass the playhead in milliseconds, or null when there is no audio loaded at all — no playhead is
 * simply the strongest case of "you cannot place it". */
export function audioTierReachable(seg, playheadMs) {
  if (!isAligned(seg)) return false;
  if (!isNum(playheadMs)) return false;
  return playheadMs >= seg.start && playheadMs <= seg.end;
}

/* Clear a segment's times IN PLACE, preserving any non-time fields a caller attached (e.g.
 * phraseIndex). ⚠ In place by deletion: the old `Object.assign(seg, blank(seg))` added timePending
 * but could not REMOVE keys, so a demoted segment kept its stale start/end and its estimate flag. */
function blankInPlace(seg, keepFileTimes = false) {
  delete seg.start; delete seg.end; delete seg.timeEstimated; delete seg.guess; delete seg.estSource;
  delete seg.phAt; delete seg.noRoom;   // display-only (v718): spreadUntimed lays them down afresh
  if (!keepFileTimes) delete seg.fileTimes;
  seg.timePending = true;
  return seg;
}

/* =================================================================================================
 * PER-EDGE GUESSES (v717 — plans/time-gaps-and-estimates.md §2).
 *
 * ⚠ WHY AN EDGE AND NOT A SPAN. `timeEstimated` was one flag for a whole span, and every operation
 * had to decide what happened to it — and each decided differently. A seam dragged by hand deleted the
 * flag on the right-hand span only, so a guessed FAR edge became "real"; a merge kept it if either
 * half had it, so a real outer edge became a guess; a split cleared it on the second half. Those
 * guesses then went into exports as times (E78 and E19 are made of them). Recording the guessed VALUE
 * of each edge makes every one of those questions answer itself: an edge is a guess while it still
 * holds the value that was guessed, and the moment anyone places it, it is not.
 *
 * ⚠ C0 — NO OPERATION MAKES A GUESS OF THE FIRST LINE'S START OR THE LAST LINE'S END. Nothing
 * interpolates them; they come from the file, the user, 0 or the recording's end. A recording made in
 * the app therefore keeps solid first and last lines, as it always has. ⚠ It is a rule about where
 * guesses are MADE (and how an old "estimated" flag is read — estimateEdges), not an eraser applied by
 * position: delete the first line of an estimated text and the new first line's start is still the
 * interpolated value it was, so it stays a guess. Enforcing C0 by position after every operation made
 * exactly that guess "real" and exported it as one (v717 review).
 * ============================================================================================== */
export const GUESS_TOL_MS = 1;

/** Is this edge (0 = start, 1 = end) still the guessed value? */
export function edgeGuessed(s, side) {
  const g = s && Array.isArray(s.guess) ? s.guess[side ? 1 : 0] : null;
  if (!isNum(g)) return false;
  const v = side ? s.end : s.start;
  return isNum(v) && Math.abs(v - g) <= GUESS_TOL_MS;
}

/* A span an OLDER build called an estimate, with no live guessed edge to say which edges: no `guess`
 * at all (v714–v716), or a v717 `guess` that the older build carried along with `{...s}` while it set
 * its own flag (a rollback to v716 and back — v716 fraction-splits a v717 span, and both pieces carry
 * the copied `[null, null]` beside `timeEstimated: true`). Every v717 operation keeps the flag equal to
 * the live edges (settle), so a flag no edge explains was written by an older build, and is migrated
 * per edge like any pre-v717 estimate rather than read as real. */
function flagOnly(s) {
  return isAligned(s) && !!s.timeEstimated && !edgeGuessed(s, 0) && !edgeGuessed(s, 1);
}

/** At least one edge is a guess — or, for a span an older build wrote, its flag says so (flagOnly). */
export function isEstimate(s) {
  if (!isAligned(s)) return false;
  return edgeGuessed(s, 0) || edgeGuessed(s, 1) || !!s.timeEstimated;
}

const copySpan = (s) => {
  if (!s) return { timePending: true };
  const o = { ...s };
  if (Array.isArray(s.guess)) o.guess = s.guess.slice(0, 2);
  if (Array.isArray(s.phAt)) o.phAt = s.phAt.slice(0, 2);
  return o;
};

/* =================================================================================================
 * PLACEHOLDERS (v718 — plans/time-gaps-and-estimates.md §2, D3, D4; Seth's B2, 2026-10-10: "make sure
 * the lines that DO have timing information follow that timing information and only the ones with NO
 * time information are evenly spaced in the gap in between clear lines").
 *
 * A line with no time is drawn in the gap its timed neighbours leave, sharing it evenly with the other
 * untimed lines there (spreadUntimed). That span is a PLACEHOLDER: it plays, it draws, it can be dragged
 * or cut like any span — and it is never stored and never exported. `phAt` holds the values it was
 * given, and it is a placeholder only while its values are still exactly those, so a copy made with
 * `{...s}` that is then dragged, cut or nudged is simply not one any more (case 10) — there is no flag
 * to forget to clear. Two operations keep the status on purpose: joining two placeholders, and dividing
 * one at a point the user did not place (a word fraction, a nudged cut, the Segmenter's midpoint) — a
 * guess inside a guess is still nobody's time (case 2). Anything the user places makes it a real span,
 * or an estimate where an edge is still the spread's guess, and THAT is stored and exported, marked.
 *
 * ⚠ THEY LIVE IN current.doc.segments, IN MEMORY, so every renderer, ticker and operation sees the one
 * array (as v714's seed did) — and storage removes them in exactly ONE place: db.js putDoc →
 * storableRecord → storableSegments, which writes a placeholder as { timePending: true }. Every export
 * reads the same storable form (flextext.js spansForExport). So opening a text stores nothing, and no
 * spread time reaches a .flextext, an EAF or a .fxpa.
 * ============================================================================================== */
/* Each untimed line needs this much of the gap, or the run stays ⋯ with a "no room" mark: 400 ms is
 * the shortest real text line in the corpus (399 ms, D2). */
export const SPREAD_MIN_MS = 400;

/** A span drawn by spreadUntimed and not moved since — display only. */
export function isPlaceholder(s) {
  return isAligned(s) && Array.isArray(s.phAt) && s.start === s.phAt[0] && s.end === s.phAt[1];
}
/** A time somebody has: real, or an estimate (stored and exported, marked). Not a placeholder. */
export function isPlaced(s) { return isAligned(s) && !isPlaceholder(s); }
const PH_FIELDS = ['start', 'end', 'guess', 'estSource', 'timeEstimated', 'phAt', 'noRoom', 'timePending'];
const withoutTime = (s) => { const o = { ...s }; for (const k of PH_FIELDS) delete o[k]; return o; };
// The guess pair a span carries, treating an unmigrated estimate as guessed at both edges.
const guessOf = (s) => {
  if (!s) return null;
  if (flagOnly(s)) return [s.start, s.end];
  return Array.isArray(s.guess) ? s.guess : null;
};

/* WHICH EDGES OF A SPAN KNOWN TO BE AN ESTIMATE ARE THE GUESSES — for a span whose source said only
 * "estimated" (a `~` note, an equal-length run, a v714 flag). Every edge, except a C0 edge and an edge
 * that meets (within 1 ms) a neighbour that is NOT an estimate: the neighbour's edge is real, and they
 * are one seam. So a legacy fraction-split piece keeps its outer edges real, and a v714 seed is
 * guessed on its interior edges. `isEst(j)` says which neighbours are estimates.
 *
 * ⚠ A LONE estimate — no neighbour is one — gets every non-C0 edge guessed instead. The neighbour rule
 * is for runs (a split's pieces, a seed), where the seams between estimates are the guesses. A lone one
 * is a different animal: a start pushed by normalize in v714–v716 meets the real line before it and is
 * the GUESS at exactly that meeting edge, so "meets a real neighbour, therefore real" laundered it and
 * marked the file's real end instead. With nothing to say which edge it is, both are marked: the source
 * said "estimate", and P4 is that a file's own marks go back out as they came in. (Where the phrase still
 * carries the file's own offsets, readLegacyEstimates knows better and uses them.) */
export function estimateEdges(segs, i, isEst = (j) => isEstimate(segs[j])) {
  const s = segs[i], n = segs.length;
  const near = (j) => j >= 0 && j < n && isAligned(segs[j]);
  const meetsReal = (j, v) => near(j) && !isEst(j)
    && Math.abs(v - (j < i ? segs[j].end : segs[j].start)) <= GUESS_TOL_MS;
  const first = i === 0, last = i === n - 1;
  const lone = !(near(i - 1) && isEst(i - 1)) && !(near(i + 1) && isEst(i + 1));
  let gs = !first && (lone || !meetsReal(i - 1, s.start));
  let ge = !last && (lone || !meetsReal(i + 1, s.end));
  if (!gs && !ge) { gs = !first; ge = !last; }
  return [gs ? s.start : null, ge ? s.end : null];
}

/* Stale guesses dropped, `timeEstimated` re-derived FROM THE EDGES, a time no longer a `fileTimes`
 * hold. In place; pending spans are left alone. Callers migrate flagOnly spans first, so the flag set
 * here always says exactly what the edges say. Exported for flextext.js's read-back. */
export function settleSpan(s) {
  if (!isAligned(s)) return s;
  delete s.fileTimes;
  if (Array.isArray(s.guess)) s.guess = [edgeGuessed(s, 0) ? s.guess[0] : null, edgeGuessed(s, 1) ? s.guess[1] : null];
  if (edgeGuessed(s, 0) || edgeGuessed(s, 1)) s.timeEstimated = true;
  else { delete s.timeEstimated; delete s.estSource; }
  return s;
}
const settle = settleSpan;
// An older build's estimate (flagOnly) given explicit edges, using its neighbours. In place.
function migrateAt(segs, k) {
  const s = segs[k];
  if (!flagOnly(s)) return;
  s.guess = estimateEdges(segs, k);
  if (!s.estSource) s.estSource = 'legacy';
}

/* The array as the per-edge model reads it: COPIES, older builds' estimates migrated (each judged
 * against its neighbours as they were, before any of them changed), the flag re-derived. Every
 * operation below starts here, so a legacy span never reaches one of the primitives unmigrated. */
export function withGuesses(segments) {
  const out = (segments || []).map(copySpan);
  const legacy = out.map(flagOnly);
  if (legacy.some(Boolean)) {
    const was = out.map((s) => isEstimate(s));
    out.forEach((s, k) => {
      if (!legacy[k]) return;
      s.guess = estimateEdges(out, k, (j) => was[j]);
      if (!s.estSource) s.estSource = 'legacy';
    });
  }
  out.forEach(settle);
  return out;
}

/* ---------------------------------------------------------------------------------------------
 * THE THREE PRIMITIVES. Every operation in this file — and the Audio Segmenter's verbs — goes
 * through these, so the per-edge rules live in exactly one place.
 * ------------------------------------------------------------------------------------------- */

/* Move the seam between segs[i] and segs[i+1] to t, IN PLACE (the drag surfaces move the live
 * objects their rows and tickers hold). `edge`: 'seam' moves both sides, 'end' only segs[i].end,
 * 'start' only segs[i+1].start (D11). The placed edge is no longer a guess, on whichever side it
 * moved; the other edges keep whatever they were. Clamping is moveBoundary's job, not this one's. */
export function placeSeam(segs, i, t, edge = 'seam') {
  const a = segs && segs[i], b = segs && segs[i + 1];
  if (!a || !b || !isNum(t)) return segs;
  migrateAt(segs, i); migrateAt(segs, i + 1);
  if (edge !== 'start') { a.end = t; if (Array.isArray(a.guess)) a.guess = [a.guess[0], null]; }
  if (edge !== 'end') { b.start = t; if (Array.isArray(b.guess)) b.guess = [null, b.guess[1]]; }
  settle(a); settle(b);
  return segs;
}

/* Divide one aligned span at `at` → [first, second]. `real: true` — the user placed this point (the
 * playhead); `real: false` — we chose it (nudged, a word fraction, ✨), so it is a guess on both
 * sides. The outer edges keep exactly the guesses the span had. Non-time fields ride with both.
 * `keepPlaceholder` (v718): dividing a PLACEHOLDER at a point nobody placed leaves two placeholders
 * (case 2) — pass it only with `real: false`; ✨ does not, so its pieces become estimates. */
export function splitSpanAt(cur, at, opts = {}) {
  const real = opts.real !== false;
  const keep = !real && !!opts.keepPlaceholder && isPlaceholder(cur);
  const g = guessOf(cur);
  const first = copySpan(cur), second = copySpan(cur);
  first.end = at; second.start = at;
  if (g || !real) {
    first.guess = [g ? g[0] : null, real ? null : at];
    second.guess = [real ? null : at, g ? g[1] : null];
  }
  if (!real) first.estSource = second.estSource = keep ? 'spread' : (opts.source || 'edit');
  if (keep) { first.phAt = [first.start, first.end]; second.phAt = [second.start, second.end]; }
  return [settle(first), settle(second)];
}

/* Join two neighbouring spans into one. The start side's guess comes from `a` and the end side's
 * from `b`, so a guessed INNER boundary simply disappears with the boundary — the old rule ("an
 * estimate if either half was") made a real join of two estimated halves a guess for ever. A merge
 * with a pending side keeps whatever time IS known.
 * ⚠ A join whose every known time is a PLACEHOLDER's is a placeholder (v718, case 2): two untimed lines
 * joined are still one untimed line, and must not leave this function as a stored estimate. Joined to
 * a line somebody timed, it is that line's time with the spread's guess on the far edge — dashed,
 * stored, exported with its `~`: the user joined it, and the edge is honestly a guess. */
export function mergeSpanPair(a, b) {
  const A = isAligned(a), B = isAligned(b);
  if (!A && !B) return { timePending: true };
  const ga = A ? guessOf(a) : null, gb = B ? guessOf(b) : null;
  let m, g = null;
  if (A && B) { m = { start: a.start, end: b.end }; if (ga || gb) g = [ga ? ga[0] : null, gb ? gb[1] : null]; }
  else if (A) { m = { start: a.start, end: a.end }; if (ga) g = ga.slice(0, 2); }
  else { m = { start: b.start, end: b.end }; if (gb) g = gb.slice(0, 2); }
  if (g) {
    m.guess = g;
    const src = (g[0] != null ? (A ? a : b).estSource : null) || (g[1] != null ? (B ? b : a).estSource : null);
    if (src) m.estSource = src;
  }
  if ((!A || isPlaceholder(a)) && (!B || isPlaceholder(b))) m.phAt = [m.start, m.end];
  return settle(m);
}

/* ---------------------------------------------------------------------------------------------
 * normalizeSegments — the one place crossing is prevented.
 *
 * Guarantees on the returned array (same length as the input, order never changed):
 *   0. pre-v717 estimates carry explicit per-edge guesses (withGuesses), and every segment's
 *      `timeEstimated` equals isEstimate() on the way out;
 *   1. every aligned segment has `end >= start + MIN_SEGMENT_MS`, else it becomes `timePending`;
 *   2. aligned segments are strictly increasing and non-overlapping in time;
 *   3. `first.start >= 0`;
 *   4. anything that cannot satisfy the above becomes `timePending` rather than being invented.
 *
 * ⚠ NO DURATION CLAMP ANY MORE (v717, D9; `opts.duration` is accepted and ignored). A stored time is
 * never cut to fit the DECODED length: decoders disagree by tens of milliseconds between devices
 * (T53's m4a decodes 63 ms shorter than its last line's end), and clamping meant every edit on that
 * device shortened the last line for good and stripped an estimate's last edge. Drawing and playback
 * clip at the point of use instead.
 *
 * ⚠ ORDER IS NEVER REARRANGED. Segment order is owned by the text (segment N belongs to line N), so
 * sorting by time here would silently re-associate text with the wrong audio — far worse than an
 * unaligned segment. When a time conflicts with its neighbours we drop the TIME, never move the row.
 * ------------------------------------------------------------------------------------------- */
/* ⚠ "Normalize" in the DATA sense only — this makes the segment ARRAY well-formed (boundaries
 * clamped, monotonic, non-overlapping). It has NOTHING to do with audio level normalization and
 * never reads a single sample. The entire segmentation feature is metadata pointing INTO an
 * untouched recording; the master is never rewritten. (Level normalization exists in this app only
 * as the `norm` recording setting, which archival defaults turn OFF.) */
export function normalizeSegments(segments, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : MIN_SEGMENT_MS;
  // Pass 0 — copies, with pre-v717 estimates migrated to per-edge guesses.
  const out = withGuesses(segments);

  // Pass 1 — per-segment sanity: no negative start, and demote anything too short/invalid.
  for (const seg of out) {
    if (!isAligned(seg)) { blankInPlace(seg, true); continue; }
    if (seg.start < 0) seg.start = 0;
    /* A span shorter than minMs is demoted. When it was a FILE's (an ELAN sliver of 90 ms) its phrase
     * still holds those very times, untouched, and the export writes them back (`fileTimes`, P4) — v716
     * did, and dropping them was a regression. The demoted values ride along so the export can tell:
     * it passes the phrase's offsets through only while they still equal them. */
    if (seg.end - seg.start < minMs) { const was = [seg.start, seg.end]; blankInPlace(seg); seg.fileTimes = was; }
  }

  // Pass 2 — monotonicity, forwards. Each aligned segment must start at or after the previous
  // aligned segment's end. If pushing it forward would leave less than minMs, it has no room to
  // exist here: demote it rather than overlap.
  let prevEnd = null;
  for (const seg of out) {
    if (!isAligned(seg)) continue;
    if (prevEnd !== null && seg.start < prevEnd) {
      seg.start = prevEnd;
      if (seg.end - seg.start < minMs) { blankInPlace(seg); continue; }
      // A start we had to move is no longer the user's chosen time — say so, on that edge.
      seg.guess = [seg.start, Array.isArray(seg.guess) ? seg.guess[1] : null];
      seg.estSource = 'edit';
    }
    prevEnd = seg.end;
  }

  out.forEach(settle);
  return out;
}

/* ---------------------------------------------------------------------------------------------
 * moveBoundary — drag the seam between line i and line i+1 to `ms`.
 *
 * ⚠ ONE RULE FOR EVERY DRAG SURFACE (the Cut tab's top-player marks, the grips on the Cut, Baseline
 * and Gloss strips). Seth, on the segmenter's version of this: "we have to make sure you can't drag
 * them BEYOND other boundaries they run into. Like they have to stay in sequence." The clamp is
 * against the NEIGHBOURING SEGMENTS, the constraint in the form that cannot be got wrong: the seam
 * may not pass its own segment's start nor the next segment's end, and must leave a real segment
 * (minMs) on each side. A seam next to a segment without a time is refused rather than guessed. The
 * text is untouched: moving a seam changes when a line is heard, never which words it holds.
 *
 * ⚠ A SEAM WITH A GAP MOVES ONLY THE EDGE BEING DRAGGED (v717, D11). Where the two spans meet (1 ms
 * or less apart) both sides move together, as they always have, so no gap and no overlap can appear.
 * Where there is a pause between them — every ELAN-made text has one at most seams — moving both
 * sides meant a 10 ms nudge of one line's end swallowed a 1.2 s pause into the next line. Then only
 * `opts.edge` moves: 'end' (segs[i].end, within [a.start + minMs, b.start]; the default, as a dock
 * mark is the end edge) or 'start' (segs[i+1].start, within [a.end, b.end − minMs]).
 *
 * The placed edge stops being a guess (placeSeam); the far edges keep theirs. Returns
 * { ok, segments (a NEW array), t, edge } — `edge` is what actually moved ('seam' | 'end' | 'start')
 * so a drag can apply the same thing to its live objects with placeSeam — or { ok: false, reason }.
 * ------------------------------------------------------------------------------------------- */
export function moveBoundary(segments, i, ms, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : MIN_SEGMENT_MS;
  const a = segments ? segments[i] : null, b = segments ? segments[i + 1] : null;
  if (!isAligned(a) || !isAligned(b)) return { ok: false, reason: 'pending' };
  if (!isNum(ms)) return { ok: false, reason: 'time' };
  const edge = b.start - a.end <= GUESS_TOL_MS ? 'seam' : (opts.edge === 'start' ? 'start' : 'end');
  const lo = edge === 'start' ? a.end : a.start + minMs;
  const hi = edge === 'end' ? b.start : b.end - minMs;
  if (hi <= lo) return { ok: false, reason: 'room' };
  const t = Math.round(Math.min(hi, Math.max(lo, ms)));
  if ((edge === 'start' || t === a.end) && (edge === 'end' || t === b.start)) return { ok: false, reason: 'same' };
  const out = withGuesses(segments);
  placeSeam(out, i, t, edge);
  return { ok: true, segments: out, t, edge };
}

/* ONE STEP OF A DRAG: moveBoundary judged against the two spans AS THEY WERE AT PICK-UP (`before`, a
 * copy of [segs[bi], segs[bi+1]] taken when the finger went down), then applied to the LIVE objects
 * with placeSeam — the rows and tickers hold them by reference. `edge` is the grabbed handle's side.
 *
 * ⚠ WHY THE PICK-UP COPY AND NOT THE LIVE SPANS. Whether a seam is a seam or a pause decides which
 * edges move (D11), and the drag itself changes that answer: pull a line's end up against the next
 * line's start and, judged live, the next move is a "seam" — which then drags the neighbour's start
 * back across the pause it was never asked to touch. The mode and the clamp are fixed at pick-up.
 * Returning to the starting point puts the edge back exactly. Returns { t, edge } or null. */
export function dragSeam(live, before, bi, ms, edge) {
  const a = live && live[bi], b = live && live[bi + 1];
  if (!a || !b || !Array.isArray(before) || before.length < 2) return null;
  const r = moveBoundary(before, 0, ms, { edge });
  let t, how;
  if (r.ok) { t = r.t; how = r.edge; }
  else if (r.reason === 'same') {
    how = before[1].start - before[0].end <= GUESS_TOL_MS ? 'seam' : (edge === 'start' ? 'start' : 'end');
    t = how === 'start' ? before[1].start : before[0].end;
  } else return null;
  if ((how === 'start' || a.end === t) && (how === 'end' || b.start === t)) return null;
  placeSeam(live, bi, t, how);
  return { t, edge: how };
}

/* ---------------------------------------------------------------------------------------------
 * boundaryAtPlayhead — "the user pressed Enter at time t between line i and line i+1".
 *
 * Returns a NEW segments array. The break always happens in the text; the only question is whether
 * this playhead can legally become the boundary time. If it cannot, the new segment is `timePending`
 * — the user can scrub to a sensible spot and set it later.
 * ------------------------------------------------------------------------------------------- */
export function boundaryAtPlayhead(segments, index, playheadMs, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : MIN_SEGMENT_MS;
  const out = withGuesses(segments);
  const cur = out[index];

  // Splitting an unaligned segment can only produce unaligned halves — there is no time to divide.
  if (!cur || !isAligned(cur) || !isNum(playheadMs)) {
    out.splice(index + 1, 0, { timePending: true });
    return normalizeSegments(out, opts);
  }

  // The boundary must leave a viable segment on BOTH sides, or it is not usable as it stands.
  const lo = cur.start + minMs;
  const hi = cur.end - minMs;
  let at = playheadMs;
  let nudged = false;
  if (at < lo || at > hi) {
    /* ⚠ A CUT NEAR THE EDGE IS NUDGED INWARD, NOT ABANDONED (Seth, 2026-09-08).
     *
     * This used to give up for every out-of-range position: keep the segment whole and splice in a
     * `{ timePending: true }` one, on the reasoning that we should not invent a boundary the user
     * did not choose. For a cut the user placed INSIDE the line, within minMs of one of its ends,
     * that reasoning cost more than it saved, and silently. The original segment stayed intact, so
     * the line kept ALL of its sound INCLUDING the part that belonged to the new line, while the
     * new line got none — one line holding two lines' audio, and nothing said so. Seth: "on a long
     * text, that'll really add up."
     *
     * A boundary moved by less than minMs is a far smaller lie than a line with no time at all, and
     * a guessed edge is exactly how this file says "we moved this, it is not your chosen time" (see
     * normalizeSegments pass 2). So a position inside the segment is clamped into range.
     *
     * ⚠ THE TWO CASES THAT STILL REFUSE, both covered by segments-ordering:
     *   · a position OUTSIDE the segment entirely (the user scrubbed away, or past the media end) —
     *     clamping that really would be inventing a boundary, "not a clamp-fudge";
     *   · a segment with no room at all, shorter than 2 * minMs, where hi < lo and there is no legal
     *     boundary to clamp to — refusing beats creating a sub-minimum segment. */
    const inside = at >= cur.start && at <= cur.end;
    if (!inside || hi < lo) {
      out.splice(index + 1, 0, { timePending: true });
      return normalizeSegments(out, opts);
    }
    at = Math.min(hi, Math.max(lo, at));
    nudged = true;
  }

  /* The playhead is a real edge on both sides of the new boundary; a boundary we had to move inward
   * is not the user's chosen time, on either side of it. The outer edges keep what they were. A
   * PLACEHOLDER cut at the playhead becomes two placed lines; nudged, it stays two placeholders (v718). */
  out.splice(index, 1, ...splitSpanAt(cur, at, { real: !nudged, keepPlaceholder: true }));
  return normalizeSegments(out, opts);
}

/* ---------------------------------------------------------------------------------------------
 * mergeSegments — join segment i with i+1 into one span.
 *
 * ONE operation with TWO entry points: deleting a line break on the baseline tab, and the gloss-tab
 * "merge with next" button. Sharing this function is what keeps the two tabs consistent and means
 * EAF export only ever sees one, already-verified merge case.
 *
 * A merge with a pending neighbour keeps whatever time IS known — merging should never lose an
 * alignment the user already established.
 * ------------------------------------------------------------------------------------------- */
export function mergeSegments(segments, i, opts = {}) {
  const src = segments || [];
  if (i < 0 || i + 1 >= src.length) return src.map(copySpan);
  const out = withGuesses(src);
  // The merged span is an estimate only if one of its OUTER edges is a guess (mergeSpanPair): the
  // boundary that was a guess is gone, and a real edge does not become a guess by being joined.
  out.splice(i, 2, mergeSpanPair(out[i], out[i + 1]));
  return normalizeSegments(out, opts);
}

/* ---------------------------------------------------------------------------------------------
 * splitSegment — divide segment i in two.
 *
 * Time source, in priority order (see the plan's two-step rule):
 *   1. `opts.playheadMs` when it falls INSIDE the segment — an exact, user-chosen boundary.
 *   2. otherwise interpolate from `opts.fraction` (0..1, e.g. wordsBefore/wordsTotal) and record the
 *      new boundary as a GUESS on both sides, so the UI renders it dashed.
 * Interpolating is not a fabricated claim: ELAN itself interpolates unaligned annotations for
 * display. This just makes that explicit and labels it.
 * ------------------------------------------------------------------------------------------- */
export function splitSegment(segments, i, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : MIN_SEGMENT_MS;
  const src = segments || [];
  if (i < 0 || i >= src.length) return src.map(copySpan);
  const out = withGuesses(src);
  const cur = out[i];

  if (!isAligned(cur)) {
    out.splice(i + 1, 0, { timePending: true });
    return normalizeSegments(out, opts);
  }

  const lo = cur.start + minMs;
  const hi = cur.end - minMs;
  if (hi < lo) {
    // Too short to divide at all — the second half gets no time rather than a fake one.
    out.splice(i + 1, 0, { timePending: true });
    return normalizeSegments(out, opts);
  }

  let at = null;
  let estimated = false;
  if (isNum(opts.playheadMs) && opts.playheadMs > lo && opts.playheadMs < hi) {
    at = opts.playheadMs;                       // the user's real, chosen position
  } else if (isNum(opts.fraction)) {
    const f = Math.min(1, Math.max(0, opts.fraction));
    at = Math.round(cur.start + f * (cur.end - cur.start));
    at = Math.min(hi, Math.max(lo, at));        // keep both halves viable
    estimated = true;
  }

  if (at === null) {
    out.splice(i + 1, 0, { timePending: true });
    return normalizeSegments(out, opts);
  }

  // A placeholder divided by word fraction is two placeholders (v718, case 2); at the playhead, two lines.
  out.splice(i, 1, ...splitSpanAt(cur, at, { real: !estimated, keepPlaceholder: true }));
  return normalizeSegments(out, opts);
}

/* ---------------------------------------------------------------------------------------------
 * syncToLines — keep `segments.length === lineCount` after any text edit.
 *
 * The text is authoritative: if the user pasted five lines, there are five segments. New rows are
 * `timePending` (never invented times); surplus rows are dropped from the END, because a shorter
 * text means trailing lines were removed.
 *
 * ⚠ This is a fallback for edits we could not observe structurally (paste, select-all-delete,
 * autocorrect). Prefer boundaryAtPlayhead / mergeSegments / splitSegment when the edit IS known —
 * those preserve alignment, whereas this can only preserve counts.
 * ------------------------------------------------------------------------------------------- */
export function syncToLines(segments, lineCount, opts = {}) {
  const out = (segments || []).map((s) => ({ ...s }));
  const n = Math.max(0, lineCount | 0);
  while (out.length < n) out.push({ timePending: true });
  if (out.length > n) out.length = n;
  return normalizeSegments(out, opts);
}

/* ---------------------------------------------------------------------------------------------
 * segmentsFollowLines — the times for a text edit we DID observe line by line (v717, D10).
 *
 * ⚠ THE 2026-08-16 LESSON, CLOSED FOR THE PLAIN TEXT BOX. That box edits text only, and syncToLines
 * then paired the new lines with the old times BY POSITION: insert one line after line 6 and every
 * later line played the line before it, and the export wrote those times out as fact. Text and times
 * have to move together at the same index. reconcileBaselineWithOrigins (flextext.js) says, for every
 * new line, which old line(s) it came from; this builds the time list from that and nothing else:
 *   kept / exact / edit → that old line's span, as it was;
 *   join                → the old spans folded with mergeSpanPair (the inner seams disappear);
 *   split               → the old span divided by WORD fraction, the inner edges guessed;
 *   new                 → { timePending } — never a neighbour's time.
 * Then normalizeSegments. Returns a NEW array, one span per origin; the inputs are not mutated.
 *
 * ⚠ A LINE MOVED TO ANOTHER PLACE KEEPS ITS WORDS, NOT ITS TIME. Its audio is still where it was in
 * the recording, and the recording's order is fixed: cut "ii jj" and paste it two lines up, and its
 * span 5100–6900 now sits before lines timed 1300–5100. Carried along, that span made normalize push
 * and demote every unchanged line it passed until the times caught up — three lines lost their times
 * and the next export lost the cuts for good (v717 review). So only the longest run of origins whose
 * OLD positions still increase keeps its times; a line off that run (`moved`, or out of order however
 * it got there) becomes { timePending } — the banner then counts it as a line with no time, which is
 * the truth. (Which of two crossing lines MOVED is the reconcile's call, made with the text in view: a
 * worded line outweighs a blank one there. The run here is the backstop for anything else.) */
export function segmentsFollowLines(oldSegs, origins, opts = {}) {
  const old = withGuesses(oldSegs);
  const at = (k) => (Number.isInteger(k) && k >= 0 && k < old.length ? old[k] : null);
  const clamp01 = (f) => (isNum(f) ? Math.min(1, Math.max(0, f)) : null);
  const keep = inOrderOrigins(origins || []);
  const out = (origins || []).map((o, j) => {
    if (!keep[j]) return { timePending: true };
    const kind = o && o.kind;
    if (kind === 'kept' || kind === 'exact' || kind === 'edit') {
      const s = at(o.from);
      return s ? copySpan(s) : { timePending: true };
    }
    if (kind === 'join') {
      const list = (Array.isArray(o.from) ? o.from : []).map(at).filter(Boolean);
      return list.length ? list.slice(1).reduce((m, s) => mergeSpanPair(m, s), copySpan(list[0])) : { timePending: true };
    }
    if (kind === 'split') {
      const s = at(o.from);
      const f0 = clamp01(o.frac && o.frac[0]), f1 = clamp01(o.frac && o.frac[1]);
      if (!isAligned(s) || f0 === null || f1 === null || f1 <= f0) return { timePending: true };
      const len = s.end - s.start;
      const g = guessOf(s) || [null, null];
      const start = f0 === 0 ? s.start : Math.round(s.start + f0 * len);
      const end = f1 === 1 ? s.end : Math.round(s.start + f1 * len);
      const piece = { start, end, guess: [f0 === 0 ? g[0] : start, f1 === 1 ? g[1] : end] };
      // A placeholder's word-fraction pieces are placeholders still (v718, case 2): nobody placed them.
      const ph = isPlaceholder(s);
      const src = ph ? 'spread' : (f0 > 0 || f1 < 1) ? 'edit' : s.estSource;
      if (src) piece.estSource = src;
      if (ph) piece.phAt = [start, end];
      return settle(piece);
    }
    return { timePending: true };
  });
  return normalizeSegments(out, opts);
}

/* Which origins may keep their times: the longest run whose old positions increase, in the order of
 * the new lines. A line's place in the OLD text is an interval — [i, i+1) for a kept/exact/edit line,
 * the whole of a join, its word-fraction slice of a split — so a split's pieces chain one after another.
 * A line the reconcile kept untouched weighs a hair more, so ties fall to the lines nobody edited.
 * `moved` origins never keep a time. */
function inOrderOrigins(origins) {
  const iv = origins.map((o) => {
    if (!o || o.moved) return null;
    if ((o.kind === 'kept' || o.kind === 'exact' || o.kind === 'edit') && Number.isInteger(o.from)) return [o.from, o.from + 1];
    if (o.kind === 'join' && Array.isArray(o.from) && o.from.length) return [Math.min(...o.from), Math.max(...o.from) + 1];
    if (o.kind === 'split' && Number.isInteger(o.from) && o.frac) return [o.from + (+o.frac[0] || 0), o.from + (+o.frac[1] || 0)];
    return null;
  });
  const w = origins.map((o) => 1 + (o && o.kind === 'kept' ? 0.001 : 0));
  const n = iv.length, best = new Array(n).fill(0), prev = new Array(n).fill(-1);
  let top = -1;
  for (let j = 0; j < n; j++) {
    if (!iv[j]) continue;
    best[j] = w[j];
    for (let q = 0; q < j; q++) {
      if (iv[q] && iv[q][1] <= iv[j][0] + 1e-9 && best[q] + w[j] > best[j]) { best[j] = best[q] + w[j]; prev[j] = q; }
    }
    if (top < 0 || best[j] > best[top]) top = j;
  }
  const keep = new Array(n).fill(false);
  for (let j = top; j >= 0; j = prev[j]) keep[j] = true;
  // A 'new' line has no time to keep or lose; it is never on the run and never needs to be.
  return keep;
}

/* ---------------------------------------------------------------------------------------------
 * spreadUntimed — Seth's B2 (v718, D3, D4): every line with no time, shown in the gap it belongs to.
 *
 * A RUN is a stretch of lines with no placed time. Its ROOM runs from the end of the placed line
 * before it (or 0) to the start of the placed line after it (or D, the recording's decoded length),
 * and the run shares the room evenly: line m of k gets [round(lo + m(hi−lo)/k), round(lo + (m+1)(hi−lo)/k)].
 * Each becomes a placeholder (phAt), guessed on every edge but a C0 one — the first line's start and the
 * last line's end are 0 and D, which are facts. An all-untimed text is the same rule with one room,
 * [0, D]: exactly v714's even spread, round(kD/N), now drawn and never written (D4). Placed lines are
 * never changed; they bound the rooms and that is all.
 *
 * ⚠ NO ROOM, NO SPREAD. A room shorter than k × minMs (400 ms a line, the shortest real text line)
 * leaves its lines pending, each marked `noRoom` for the renderer (⋯ and an amber mark): nothing is
 * squeezed into a sliver to make the picture look complete.
 * ⚠ A LINE HOLDING THE FILE'S OWN TIMES (`fileTimes`) IS NOT UNTIMED: the model could not place them,
 * but they are times (P4). It stays pending, keeps its hold, and takes no share of the room.
 * ⚠ A ONE-LINE TEXT IS LEFT ALONE: its whole-file span is D7's, a real one, laid down by the caller.
 * D unknown (0) → no spread at all. Deterministic: the same spans and D give the same placeholders, so
 * every draw of every tab shows the same thing. Returns a NEW array (copies); the input is untouched.
 * ------------------------------------------------------------------------------------------- */
export function spreadUntimed(segments, D, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : SPREAD_MIN_MS;
  const out = withGuesses(segments);
  const n = out.length;
  out.forEach((s) => { delete s.noRoom; });
  if (!(isNum(D) && D > 0) || n < 2) return out;
  for (let k = 0; k < n;) {
    if (isPlaced(out[k])) { k++; continue; }
    let j = k;
    while (j + 1 < n && !isPlaced(out[j + 1])) j++;
    const lo = k > 0 ? out[k - 1].end : 0;
    const hi = j < n - 1 ? out[j + 1].start : D;
    const members = [];
    for (let q = k; q <= j; q++) if (!Array.isArray(out[q].fileTimes)) members.push(q);
    const m = members.length;
    const room = m > 0 && hi - lo >= m * minMs;
    members.forEach((idx, q) => {
      const cur = out[idx];
      if (!room) { if (isAligned(cur)) blankInPlace(cur); cur.timePending = true; cur.noRoom = true; return; }
      const s = withoutTime(cur);
      s.start = Math.round(lo + (q * (hi - lo)) / m);
      s.end = Math.round(lo + ((q + 1) * (hi - lo)) / m);
      s.guess = [idx > 0 ? s.start : null, idx < n - 1 ? s.end : null];
      s.estSource = 'spread';
      s.phAt = [s.start, s.end];
      out[idx] = settle(s);
    });
    k = j + 1;
  }
  return out;
}

/* ═══ v719 — THE AUDIO NOBODY HAS CLAIMED (plans/time-gaps-and-estimates.md §4 v719, D1, D2) ═══
 *
 * ⚠ DISPLAY ROWS, NOT LINES. Seth asked for a line in every pause; the cost of taking that literally
 * is in D1 — ELAN40 would grow from 40 lines to 79, 93–100% of the new ones silence, every later
 * line number out of step with FLEx, and about 40 empty phrases going to FLEx on the next export, all
 * without anyone asking. So the pause is DRAWN, with a one-click Add, and `doc` is untouched until a
 * finger lands. Opening a text still writes nothing (P1).
 *
 * A gap row is named by the index it would INSERT AT, which is the only number the Add path needs:
 *   k = 0   the lead  — [0, segs[0].start)
 *   0<k<n   interior  — [segs[k-1].end, segs[k].start)
 *   k = n   the tail  — [segs[n-1].end, D)
 *
 * ⚠ BOTH NEIGHBOURS MUST BE PLACED. A pending line or a placeholder means the room is already
 * spoken for — spreadUntimed has shared it out among the untimed run (D3) — and drawing a gap row
 * inside that room would offer the user audio that a line already claims. So a gap is only ever
 * between two REAL times, which is also why `isPlaced` and not `isAligned` is the test.
 *
 * 350 ms (D2) excludes all 22 ELAN holes under it (snapping slivers) and the 48–70 ms differences
 * between decoders. On the three real ELAN texts it gives 39, 51 and 33 rows; on every healthy
 * contiguous text, 0. */
export const GAP_MIN_MS = 350;
export function gapRowsFor(spans, D, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : GAP_MIN_MS;
  const segs = Array.isArray(spans) ? spans : [];
  const n = segs.length;
  const out = [];
  if (!n) return out;
  const placed = segs.map(isPlaced);
  const add = (k, start, end) => { if (end - start >= minMs) out.push({ k, start, end, ms: end - start }); };
  if (placed[0]) add(0, 0, segs[0].start);
  for (let k = 1; k < n; k++) if (placed[k - 1] && placed[k]) add(k, segs[k - 1].end, segs[k].start);
  /* The tail replaces v718's coverTail, which SILENTLY stretched the last line to the end of the
   * recording. That write was defensible while nothing else accounted for the tail; now something
   * does, and a 2.1 s tail on the damaged L29 export is exactly the evidence a user needs to see
   * rather than have absorbed into a line (case 16). */
  if (placed[n - 1] && isNum(D) && D > 0) add(n, segs[n - 1].end, D);
  return out;
}

/* Is there VOICE in this stretch, or only room tone? Reuses the ✨ detector's framing and its
 * relative levels — every threshold measured from the recording's own distribution, because a
 * whispered take and a shouted one share no absolute number (see guessSplits).
 *
 * D2: a gap of ≥ 1000 ms with ≥ 400 ms voiced. On the corpus that picks 11 of 197 holes and every
 * large speech hole — the ones where a sentence really is sitting unclaimed. Short gaps are not
 * tested at all: a 400 ms pause cannot hold 400 ms of speech, and tinting every breath would make
 * the mark mean nothing. */
export const GAP_SPEECH_MIN_MS = 1000;
export const GAP_SPEECH_VOICED_MS = 400;
export function gapHasSpeech(peaks, msPerBucket, s, e, opts = {}) {
  const mpb = isNum(msPerBucket) && msPerBucket > 0 ? msPerBucket : 0;
  if (!peaks || !peaks.length || !mpb) return false;
  const minMs = isNum(opts.minMs) ? opts.minMs : GAP_SPEECH_MIN_MS;
  const voicedMs = isNum(opts.voicedMs) ? opts.voicedMs : GAP_SPEECH_VOICED_MS;
  if (!(isNum(s) && isNum(e)) || e - s < minMs) return false;
  const { env, frameMs } = frames(peaks, mpb, isNum(opts.frameMs) ? opts.frameMs : 10);
  if (!env.length || !(frameMs > 0)) return false;
  /* ⚠ THE LEVELS COME FROM THE WHOLE RECORDING, THE COUNT FROM THE GAP. Measuring the floor inside
   * the gap alone would normalise the gap against itself: a stretch of pure room tone has a floor
   * and a "speech level" too, and its loudest 5% would read as voice every time. */
  const sorted = Array.from(env).sort((a, b) => a - b);
  const floor = pct(sorted, 0.1);
  const speech = pct(sorted, 0.95);
  if (!(speech > floor)) return false;
  const gate = floor + (speech - floor) * 0.35;
  const from = Math.max(0, Math.floor(s / frameMs));
  const to = Math.min(env.length, Math.ceil(e / frameMs));
  let voiced = 0;
  for (let f = from; f < to; f++) if (env[f] >= gate) voiced++;
  return voiced * frameMs >= voicedMs;
}

/* The gap stretches, for the dock player's own layer (Player.setGapMarks).
 *
 * ⚠ A SEPARATE LAYER, NOT MORE BOUNDARIES (case 15). `setBoundaries` holds exactly one entry per
 * SEAM and hands a drag the seam's own number; pushing gap marks into that list would renumber every
 * seam after the first gap, so dragging mark k would move a boundary the user never touched. */
export function gapMarks(spans, D, opts = {}) {
  return gapRowsFor(spans, D, opts).map(({ start, end }) => ({ start, end }));
}

/* WHAT STORAGE AND EXPORTS SEE (v718): every placeholder written as { timePending: true } (any non-time
 * field it carried — a Segmenter row's id — kept), and the display-only marks (`phAt`, `noRoom`)
 * dropped from every span. db.js putDoc runs each record through this — the ONE chokepoint — and
 * flextext.js spansForExport too, so a spread time reaches neither IndexedDB nor a file (case 5).
 * `matcher: true` keeps the Audio Segmenter's own shape for a row with no audio ({ start: 0, end: 0 }).
 * A span with nothing to drop is passed through as the same object: it must serialize exactly as it
 * did before this existed. Returns a NEW array; nothing is mutated. */
export function storableSegments(segments, opts = {}) {
  return (Array.isArray(segments) ? segments : []).map((s) => {
    if (!s || typeof s !== 'object') return s;
    if (isPlaceholder(s)) {
      const o = withoutTime(s);
      if (opts.matcher) { o.start = 0; o.end = 0; }
      o.timePending = true;
      return o;
    }
    const spread = s.estSource === 'spread';
    if (!('phAt' in s) && !('noRoom' in s) && !spread) return s;
    const o = { ...s };
    delete o.phAt; delete o.noRoom;
    /* ⚠ 'spread' IS THIS BUILD'S OWN WORD (v718 review). A placeholder somebody placed one edge of is an
     * estimate whose other edge is the spread's interpolation — stored as 'edit', the source every build
     * since v717 knows (its tooltip already names "an even spread"), so a rollback to v717 never shows a
     * raw key ("seg.estTip.spread") on a line this build stored. In memory it keeps its own tooltip. */
    if (spread) o.estSource = 'edit';
    return o;
  });
}

/* v714's SEED, RECOGNISED (v718, case 12). v714 — and v717, quietly — stored an untimed text opened
 * with its recording as an even spread of estimates: guesses that every later export then wrote out as
 * times (E78 was made that way). They are turned back into what they always were, lines with no time,
 * and spreadUntimed draws them again as placeholders that nothing stores or exports.
 * An UNTOUCHED seed span is an estimate whose length is within 2 ms of `step` and whose start is within
 * 2 ms of k × step. `step` comes from the spans themselves, never from this device's decoded length:
 * decoders disagree by tens of milliseconds, and a ±70 ms difference must not hide a seed (BM6). A seed
 * somebody had begun correcting in v714–v716 is recognised by v714SeedLines, below. */
export function isV714Seed(span, k, step) {
  if (!isEstimate(span) || isPlaceholder(span) || !(step > 0) || !Number.isInteger(k) || k < 0) return false;
  return Math.abs((span.end - span.start) - step) <= 2 && Math.abs(span.start - k * step) <= 2;
}
/* The seed spans of a stored text, made pending (copies; the rest unchanged). Candidates are estimates
 * whose line carries no offsets of its own (`hasOffsets(i)`): a seed was never in a file, and a FILE's
 * even spread (E78) is that file's own estimate, kept and exported as one (D5).
 *
 * ⚠ TWO WRITERS LEFT SEEDS, AND ONLY ONE OF THEM CAN BE TOLD APART LINE BY LINE.
 *   · v714–v716 stored a bare flag (read back as estSource 'legacy'). Those are recognised span by span,
 *     on the seed's GRID (v714SeedLines below) — including the seeds a user had begun correcting in
 *     those builds, which is the common case: dragging a seam is how a seed was meant to be fixed.
 *     Two hits at least — a seed is never one line (D7's whole-file span is real).
 *   · v717 stored the spread per edge, exactly as this model writes a word-fraction split — the same
 *     guesses, the same source. A split of a real line into equal pieces must stay an estimate and be
 *     exported (case 6), so a v717 seed is recognised only WHOLE: every line of the text a candidate, and
 *     the spans exactly its even division of [0, last end]. (Which is also what dividing a one-line
 *     recording into equal parts by words amounts to — "a text whose spans are all estimates is uncut".) */
export function seedsToPending(segments, hasOffsets = () => false) {
  const segs = Array.isArray(segments) ? segments : [];
  const n = segs.length;
  const cand = [];
  segs.forEach((s, i) => { if (isEstimate(s) && !isPlaceholder(s) && !hasOffsets(i)) cand.push(i); });
  if (cand.length < 2) return segs.map(copySpan);
  const legacy = cand.filter((i) => segs[i].estSource === 'legacy' || flagOnly(segs[i]));
  let hit = legacy.length >= 2 ? v714SeedLines(segs, legacy) : new Set();
  if (hit.size < 2) hit = new Set();
  if (!hit.size && cand.length === n) {
    const D = segs[n - 1].end;
    const even = segs.every((s, k) => Math.abs(s.start - Math.round((k * D) / n)) <= 2 && Math.abs(s.end - Math.round(((k + 1) * D) / n)) <= 2);
    if (even) hit = new Set(cand);
  }
  if (!hit.size) return segs.map(copySpan);
  return segs.map((s, i) => (hit.has(i) ? { ...withoutTime(s), timePending: true } : copySpan(s)));
}

/* WHICH OF A v714–v716 TEXT'S FLAGGED LINES ARE ITS SEED (v718 review). v714 laid an untimed text down
 * as [round(kD/N), round((k+1)D/N)], every line flagged — and then let the user correct it, and its own
 * corrections reshaped the flagged lines without saying so:
 *   · a seam drag kept the flag on the line before the seam, at a new length, and deleted it from the
 *     line after (which is the user's from that seam on);
 *   · a ✂ at the playhead kept the flag on the first piece only; a word-fraction split or a nudged cut
 *     flagged both pieces; a join kept the flag on the joined line;
 *   · a device that decoded shorter clamped the last line's end, and saved it.
 * The first version of this took the grid's step from the MEAN length of the flagged lines and checked
 * each start against k × step — so one dragged line skewed the mean, the error grew with k, and a text
 * with a single correction was recognised nowhere: every seed line went on to FLEx as a time (the v718
 * review measured 0 of 19). So:
 *   1. THE STEP COMES FROM THE UNTOUCHED LINES ONLY — the biggest cluster of flagged lengths within 1 ms
 *      of each other (a seed's lengths are the floor and ceiling of D/N; an edited line is the odd one
 *      out) — refined by least squares through the starts of that cluster, so k × step stays within a
 *      millisecond of the grid at the far end of a long text;
 *   2. A SEED LINE IS A FLAGGED LINE WITH AN EDGE ON THE GRID AND NO SEAM ANYBODY PLACED. v714 un-flagged
 *      exactly one line per placement — the line AFTER a seam it moved, or after a cut it made at the
 *      playhead — so a flagged line meeting an un-flagged one AFTER it was placed at that seam. The
 *      un-flagged line's own END is still the seed's value (it sits on the grid), so the flagged line
 *      after THAT is seed again. A seam guessed on both sides (the seed's own, a split nobody placed) is
 *      nobody's; any other seam is somebody's unless it sits on the seed's grid — which also covers a
 *      v717 drag between two seed lines (both still estimates, the seam real on both sides). So a joined
 *      pair of seed lines is seed (two placeholders joined, v718's own rule), both pieces of a split
 *      nobody placed are seed, the last line after a clamp is seed (its end is the recording's end, a
 *      fact); the line BEFORE a dragged seam is not — it keeps its estimate, guessed at the start, real
 *      at the seam, exactly as a drag on a placeholder leaves it today;
 *   3. THE GRID MUST REACH THE TEXT'S END: v714 seeded [0, D], so the last timed end sits on the grid —
 *      or within 100 ms of it, where a device clamped it to its own decode (BM6). A real text's last end
 *      seldom does: one more guard, after the seams, for a real line v714 divided into equal pieces by
 *      words — those stay estimates and are exported (case 6).
 * Returns the set of indices; the caller asks for two at least. */
const SEED_TOL_MS = 2;
const SEED_END_TOL_MS = 100;
function v714SeedLines(segs, legacy) {
  const n = segs.length;
  const len = (i) => segs[i].end - segs[i].start;
  let L0 = 0, best = 0;
  for (const i of legacy) {
    const c = legacy.filter((j) => Math.abs(len(j) - len(i)) <= 1).length;
    if (c > best || (c === best && len(i) < L0)) { best = c; L0 = len(i); }
  }
  if (best < 2 || !(L0 > 0)) return new Set();
  const members = legacy.filter((i) => Math.abs(len(i) - L0) <= 1);
  let step = L0;
  for (let pass = 0; pass < 2; pass++) {   // k judged by the current step, then the step refitted through 0
    let sk = 0, kk = 0;
    for (const i of members) { const k = Math.round(segs[i].start / step); if (k > 0) { sk += k * segs[i].start; kk += k * k; } }
    if (kk > 0) step = sk / kk;
  }
  const off = (v) => Math.abs(v - Math.round(v / step) * step);
  let lastEnd = -1;
  for (let i = n - 1; i >= 0; i--) if (isAligned(segs[i])) { lastEnd = segs[i].end; break; }
  if (!(lastEnd > 0) || off(lastEnd) > SEED_END_TOL_MS) return new Set();
  const guessedAt = (s, side) => flagOnly(s) || edgeGuessed(s, side);
  // Did somebody place the seam between line j and line j+1? Not a seam at all where they do not meet.
  const seamPlaced = (j) => {
    const a = segs[j], b = segs[j + 1];
    if (!isAligned(a) || !isAligned(b) || Math.abs(a.end - b.start) > GUESS_TOL_MS) return false;
    if (isEstimate(a) && !isEstimate(b)) return true;   // v714 un-flagged the line after a placement
    if (guessedAt(a, 1) && guessedAt(b, 0)) return false;
    /* An un-flagged line before a flagged one: its end is the seed's value only if v714 made it — by a
     * placement at its START, which then sits off the grid. One that starts on the grid (the first line,
     * at 0, among them) was never a seed line: a real line, and its end is real. */
    if (!isEstimate(a) && (j === 0 || off(a.start) <= SEED_TOL_MS)) return true;
    return off(b.start) > SEED_TOL_MS;
  };
  return new Set(legacy.filter((i) => {
    const s = segs[i];
    if (off(s.start) > SEED_TOL_MS && off(s.end) > SEED_TOL_MS) return false;
    return !(i > 0 && seamPlaced(i - 1)) && !(i < n - 1 && seamPlaced(i));
  }));
}

/* ---------------------------------------------------------------------------------------------
 * THE CUT TAB'S TWO EDITS — segments and PARAGRAPHS moved together, or not at all.
 *
 * ⚠ WHY THESE LIVE HERE, AND WHY THEY TAKE PARAGRAPHS (Seth agreed, 2026-08-13: "every cut edit
 * goes through the same setParagraphs + segments.js pair").
 *
 * Segmentation mode's invariant is line == paragraph == phrase == span, 1:1:1:1 — `segments[i]` IS
 * baseline paragraph i. The Cut tab shows NO TEXT, which makes it the single most likely place for
 * someone to edit `segments` alone and leave the paragraph count behind. The moment those two
 * lengths disagree, every index-driven edit on the Baseline and Gloss tabs addresses the WRONG
 * line — the v322 field bug ("gloss join collapsed ALL segments on the first line") reached by a
 * new route, and silent until a transcriber finds their text on someone else's waveform.
 *
 * So the operations take BOTH arrays and return BOTH. A caller cannot apply half of one. That is
 * the whole reason they are here rather than in the view: `segments.js` imports nothing, so this
 * stays pure and node-testable, and no new module enters any sw.js SHELL.
 *
 * Both are non-destructive: they return new arrays and never mutate their inputs.
 * ------------------------------------------------------------------------------------------- */

/* Which span contains `ms`? -1 when it falls outside every ALIGNED span (a timePending span has no
 * time to be inside). Ends are exclusive so a playhead exactly on a boundary belongs to the span it
 * is starting, which is what a listener expects. */
export function segmentIndexAt(segments, ms) {
  if (!isNum(ms)) return -1;
  const src = segments || [];
  for (let i = 0; i < src.length; i++) {
    const s = src[i];
    if (!isAligned(s)) continue;
    if (ms >= s.start && ms < s.end) return i;
  }
  return -1;
}

/* CUT at the playhead. Returns { ok, reason, index, segments, paragraphs }.
 *
 * Refuses rather than degrading, because on this tab a refusal is honest and a degraded result is
 * not: `splitSegment` would happily hand back a `timePending` half when the halves are too short,
 * and an untimed segment appearing where the user asked for a cut reads as a bug. The Baseline tab
 * can afford that fallback because its split is driven by TEXT (the cursor) and the text must go
 * somewhere; here the cut IS the time, so a cut with no time is nothing. */
export function cutAtPlayhead(segments, paragraphs, playheadMs, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : MIN_SEGMENT_MS;
  const segs = (segments || []).map((s) => ({ ...s }));
  const paras = (paragraphs || []).slice();
  const fail = (reason) => ({ ok: false, reason, index: -1, segments: segs, paragraphs: paras });

  const i = segmentIndexAt(segs, playheadMs);
  if (i < 0) return fail('outside');
  /* ⚠ A SPLIT OF A TEXTED SEGMENT IS REFUSED, ALWAYS (Seth). There is no cursor on the Cut tab, so
   * there is no defined place to divide the text — any rule we invented would put half a sentence
   * in the wrong span silently. A JOIN is different and IS allowed (see below): concatenation loses
   * nothing. Refusing the undefined operation, permitting the safe one. */
  if (String(paras[i] || '').trim()) return fail('hasText');

  const cur = segs[i];
  if (playheadMs - cur.start < minMs || cur.end - playheadMs < minMs) return fail('tooShort');

  const out = splitSegment(segs, i, { ...opts, playheadMs });
  if (out.length !== segs.length + 1) return fail('tooShort');   // belt and braces
  paras.splice(i + 1, 0, '');                                    // the new span starts empty
  return { ok: true, reason: '', index: i, segments: out, paragraphs: paras };
}

/* JOIN span i with the one before it. Returns { ok, reason, index, segments, paragraphs, playheadMs }
 * where `playheadMs` is THE POINT THEY JOINED AT — Seth: "moves the playhead back to the point where
 * they joined". That is not decoration: it drops the user exactly where they must listen to judge
 * the join, which turns join/re-cut into a loop instead of a hunt. Null when the old boundary had no
 * time to report. */
export function joinWithPrevious(segments, paragraphs, i, opts = {}) {
  const segs = (segments || []).map((s) => ({ ...s }));
  const paras = (paragraphs || []).slice();
  const fail = (reason) => ({ ok: false, reason, index: i, segments: segs, paragraphs: paras, playheadMs: null });

  if (!(i > 0) || i >= segs.length) return fail('first');
  const left = String(paras[i - 1] ?? '');
  const right = String(paras[i] ?? '');
  // Researcher-gated (`cutJoinTexted`): joining is SAFE, but a researcher may still forbid it so
  // that segmentation cannot be reshaped once transcription has started.
  if (opts.allowTexted === false && (left.trim() || right.trim())) return fail('hasText');

  const prev = segs[i - 1];
  const joinAt = isAligned(prev) ? prev.end : null;

  /* ⚠ THE GLUE SPACE IS NOT COSMETIC (Seth, from the strips): without it "…akhir" + "Mulai…" mashes
   * into one orthographic word, which is data corruption from the transcriber's point of view. No
   * glue when either side is empty (a silence span) or a boundary space already exists. */
  const glue = left && right && !/\s$/.test(left) && !/^\s/.test(right) ? ' ' : '';
  paras.splice(i - 1, 2, left + glue + right);
  const out = mergeSegments(segs, i - 1, opts);
  return { ok: true, reason: '', index: i - 1, segments: out, paragraphs: paras, playheadMs: joinAt };
}

/* =================================================================================================
 * GUESS SPLITS — where does this recording pause for breath?
 *
 * Seth, 2026-08-13: "make default segment breaks for a new text … based on where the audio appears
 * to have pauses in speech … We would want a 'Guess Splits' button at the top."
 *
 * ⚠ IT READS THE SAME ARRAY THE WAVEFORMS ARE DRAWN FROM (segment-strips' peaks cache: one entry per
 * bucket, each the MAX ABSOLUTE SAMPLE in that bucket, ~0.5ms per bucket). That is the whole reason
 * this belongs here and not in a DSP library: what it splits on is exactly what the user can SEE.
 * No decode, no Web Audio, no dependency — a pure function over a Float32Array, so it is testable in
 * node (test/guess-splits.test.mjs) against synthetic recordings with known pauses.
 *
 * ⚠ THE ALGORITHM IS EASY; THE THRESHOLD IS THE WORK. A fixed amplitude cutoff tuned in a quiet room
 * finds NO pauses at all in a village recording with a generator running, and finds pauses
 * everywhere in a whispered one. So every level here is RELATIVE to the recording's own
 * distribution: the noise floor and the speech level are measured from the file itself, and the gate
 * sits between them.
 *
 * ⚠ IT ERRS TOWARD UNDER-CUTTING, deliberately and asymmetrically. A missed boundary costs the user
 * one keypress (park the playhead, press Enter). A spurious one costs a join AND the confusion of a
 * line that is half an utterance — and fifty of them cost more than doing the whole job by hand.
 * Hence a long minimum gap, a long minimum line, and a threshold near the floor rather than near
 * the speech level.
 * ============================================================================================== */

/* A pause shorter than this is a breath, a stop closure or a hesitation — not the end of a line.
 * 350ms is the low end of what reads as "she finished saying that": below ~300ms you start cutting
 * inside words (a Fayu glottal stop can hold 150ms), above ~500ms you miss the brisk speakers. */
export const GUESS_MIN_GAP_MS = 350;
/* And nothing shorter than this is offered as a line, however long the pause around it was. A
 * one-second line is usually a false positive around a cough or a door; a real utterance in this
 * work is a clause. */
export const GUESS_MIN_LINE_MS = 900;
/* ⚠ THE LONGEST RECORDING THIS IS OFFERED FOR (Seth, 2026-08-13: "cap the number of guessed lines or
 * rather the length of a recording that allows auto-guessing lines. Maybe let's cap that at 10
 * minutes?").
 *
 * The DETECTION is cheap and scales fine — 40 minutes of peaks is ~45ms of work, measured. What did
 * not scale, when this was a CAP (v364–v705), was what came after: one press turned a 40-minute
 * recording into ~650 lines, and the Cut tab built a live <canvas> bitmap for every one of them, on
 * a phone — past the browser's canvas budget new canvases silently got no bitmap (#31). So ✨ refused
 * any recording over ten minutes, and the user cut it into pieces by hand first.
 *
 * ⚠ THAT REASON IS GONE (v580/v581, #31): strips are parked without a bitmap while off screen and
 * drawn from the cached peaks as they scroll near, so a 650-row Cut tab holds about ten bitmaps at
 * any time, however long the recording. What remains of the number is the thing Seth asked for in
 * #93 — "look for convenient points to split them in half or quarters first and then auto segment
 * each large segment one at a time" — which is what guessSplitsWindowed does below: a recording (or
 * a piece) longer than this is first divided at real pauses into windows of about this length, and
 * each window is then guessed as a recording of its own, with its own noise floor and speech level.
 * The number is the WINDOW, not a limit: nothing is refused for being long any more (v707). */
export const GUESS_WINDOW_MS = 10 * 60 * 1000;

/** Percentile of a SORTED copy — used for the floor and the speech level alike. */
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

/* Frame the peaks into ~10ms windows of MEAN amplitude.
 *
 * ⚠ MEAN, not max. The peaks array is a max per 0.5ms bucket, which is exactly what makes waveforms
 * look crisp and exactly what makes gating them unreliable: one click, one chair creak, one keyboard
 * tap inside a genuine two-second pause is a single tall bucket, and a max-based gate would call the
 * whole pause speech. Averaging over 10ms is the cheapest way to make a transient cost what it
 * should — a little — while leaving real speech well above the floor. */
function frames(peaks, msPerBucket, frameMs) {
  const per = Math.max(1, Math.round(frameMs / msPerBucket));
  const n = Math.floor(peaks.length / per);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const off = f * per;
    for (let i = 0; i < per; i++) sum += peaks[off + i];
    out[f] = sum / per;
  }
  /* ⚠ THE FRAME'S REAL LENGTH, NOT THE ONE WE ASKED FOR. `per` is a whole number of buckets, so a
   * frame lasts per × msPerBucket ms — which equals the nominal 10ms only when msPerBucket divides
   * it exactly. It usually does not: peakPlan CEILS buckets-per-sample, so a 44.1kHz recording gives
   * msPerBucket ≈ 0.5215, per = 19, and a "10ms" frame is really 9.909ms. Converting frame indices
   * back with the nominal value drifts ~1%, which is 20 SECONDS by the end of a 40-minute recording:
   * every guessed boundary progressively earlier than the pause it was measured at. This is the same
   * trap ensurePeaks documents ("msPerBucket is the exact conversion; every consumer must use it,
   * never durationMs proportions") reached from a new direction. */
  return { env: out, frameMs: per * msPerBucket };
}

/**
 * Where should this recording be cut into lines?
 *
 * @param {Float32Array|number[]} peaks  max-abs amplitude per bucket (segment-strips' peaks cache)
 * @param {number} msPerBucket          exact ms per bucket (peaksCache.msPerBucket — NOT a duration
 *                                      proportion; see the alignment note in ensurePeaks)
 * @param {object} [opts]               { durationMs, minGapMs, minLineMs, frameMs }
 * @returns {number[]} boundary times in ms, ascending, strictly inside the recording
 */
export function guessSplits(peaks, msPerBucket, opts = {}) {
  const mpb = isNum(msPerBucket) && msPerBucket > 0 ? msPerBucket : 0;
  if (!peaks || !peaks.length || !mpb) return [];
  const minGap = isNum(opts.minGapMs) ? opts.minGapMs : GUESS_MIN_GAP_MS;
  const minLine = isNum(opts.minLineMs) ? opts.minLineMs : GUESS_MIN_LINE_MS;
  const frameMs = isNum(opts.frameMs) ? opts.frameMs : 10;
  const total = isNum(opts.durationMs) && opts.durationMs > 0 ? opts.durationMs : peaks.length * mpb;

  const { env, frameMs: perFrameMs } = frames(peaks, mpb, frameMs);
  if (env.length < 4) return [];

  /* THE TWO LEVELS THIS RECORDING ACTUALLY HAS. The 20th percentile is the noise floor: in any
   * recording of speech, at least a fifth of the frames are between words. The 90th is the speech
   * level — not the max, which is one plosive and tells you nothing about the rest. */
  const sorted = Float32Array.from(env).sort();
  const floor = pct(sorted, 0.20);
  const speech = pct(sorted, 0.90);

  /* ⚠ REFUSE RATHER THAN GUESS when the recording has no dynamic range to speak of: a continuous
   * unbroken utterance, a wall of noise, or silence. `speech` barely above `floor` means there is
   * nothing here that distinguishes a pause from speech, and any threshold would be a coin toss
   * applied fifty times. Returning [] leaves the user exactly where they were — one whole-file span
   * — which is honest and costs them nothing. */
  const range = speech - floor;
  if (!(range > 0) || speech < floor * 1.6) return [];

  /* HYSTERESIS. One gate would chatter wherever the level wobbles across it, splitting a single
   * pause into three short ones that each fail the minimum-gap test — so a genuine two-second pause
   * could be missed entirely. Silence must fall BELOW the low gate; it takes the higher gate to call
   * it speech again. The gates sit near the floor because of the under-cutting rule: at 12%/25% of
   * the way up to the speech level, a hum or a distant rooster stays "silence" and only real voice
   * closes the gap. */
  const gateLo = floor + range * 0.12;
  const gateHi = floor + range * 0.25;

  const cuts = [];
  let runStart = -1;                 // frame index where the current silence run began
  let inSilence = env[0] < gateHi;   // start in whichever state the first frame suggests
  if (inSilence) runStart = 0;
  for (let f = 1; f < env.length; f++) {
    const v = env[f];
    if (inSilence) {
      if (v >= gateHi) {             // speech resumes: close the run
        const len = (f - runStart) * perFrameMs;
        if (len >= minGap && runStart > 0) cuts.push(Math.round((runStart + f) / 2 * perFrameMs));
        inSilence = false;
      }
    } else if (v < gateLo) {
      inSilence = true;
      runStart = f;
    }
  }
  /* A trailing silence is NOT a boundary: cutting there would mint a final line that is nothing but
   * room tone. The recording's own end already bounds the last span. */

  /* ⚠ MINIMUM LINE LENGTH IS ENFORCED LAST, over the whole set, walking forward and keeping only
   * boundaries far enough from the previously KEPT one. Enforcing it pairwise as they were found
   * would let a chain of near-misses accumulate into a run of slivers. */
  const kept = [];
  let prev = 0;
  for (const c of cuts) {
    if (c - prev < minLine) continue;
    if (total - c < minLine) break;            // …and never leave a sliver at the end
    kept.push(c);
    prev = c;
  }
  return kept;
}

/* Turn guessed boundaries into a whole document: N spans and N EMPTY paragraphs, 1:1:1:1 like
 * everything else here.
 *
 * ⚠ IT REFUSES ANY DOCUMENT THAT HAS WORDS IN IT. Re-cutting a transcribed text would leave every
 * line's words sitting on somebody else's audio — the 1:1 invariant is what makes segments[i] mean
 * paragraph i, and there is no defensible way to redistribute existing text across guessed spans.
 * The Cut tab already locks texted spans for the same reason; this is that rule applied wholesale.
 *
 * Returns { ok, reason, segments, paragraphs } so a caller cannot apply half of it — the same shape
 * as cutAtPlayhead and joinWithPrevious. */
export function applyGuessedSplits(paragraphs, boundaries, opts = {}) {
  const paras = (paragraphs || []).slice();
  const fail = (reason) => ({ ok: false, reason, segments: null, paragraphs: paras });
  if (paras.some((p) => String(p || '').trim())) return fail('hasText');
  const duration = isNum(opts.duration) && opts.duration > 0 ? opts.duration : null;
  if (!duration) return fail('noAudio');
  const cuts = (boundaries || []).filter((b) => isNum(b) && b > 0 && b < duration).sort((a, b) => a - b);
  if (!cuts.length) return fail('none');

  const segs = [];
  let start = 0;
  for (const c of cuts) { segs.push({ start, end: c }); start = c; }
  segs.push({ start, end: duration });
  const out = normalizeSegments(segs, { duration });
  return { ok: true, reason: '', segments: out, paragraphs: out.map(() => '') };
}

/* THE SAME DETECTOR, INSIDE ONE PIECE (Seth, 2026-10-04: "the ability to 'guess' split a single
 * segment … one way to work around the ten-minute limit"). The peaks are sliced to [startMs, endMs)
 * and the detector sees the slice as a recording of its own — its noise floor and speech level come
 * from this piece alone, its minimum-line rule runs from the piece's start, its "no sliver at the
 * end" rule ends at the piece's end — and the boundaries are moved back to file time. Only
 * boundaries strictly inside the piece come back, so the piece's own edges never move.
 *
 * ⚠ `base` is the slice's first bucket in file time, not startMs: the slice starts on a bucket
 * boundary, and adding startMs to bucket-measured offsets would drift by up to one bucket.
 *
 * @returns {number[]} boundary times in ms (file time), ascending, strictly inside (startMs, endMs) */
export function guessSplitsWithin(peaks, msPerBucket, startMs, endMs, opts = {}) {
  const mpb = isNum(msPerBucket) && msPerBucket > 0 ? msPerBucket : 0;
  if (!peaks || !peaks.length || !mpb || !isNum(startMs) || !isNum(endMs) || endMs <= startMs) return [];
  const from = Math.max(0, Math.floor(startMs / mpb));
  const to = Math.min(peaks.length, Math.ceil(endMs / mpb));
  if (to - from < 4) return [];
  const slice = typeof peaks.subarray === 'function' ? peaks.subarray(from, to) : peaks.slice(from, to);
  const base = from * mpb;
  return guessSplits(slice, mpb, { ...opts, durationMs: endMs - base })
    .map((c) => Math.round(base + c))
    .filter((c) => c > startMs && c < endMs);
}

/* ✨ AT ANY LENGTH (#93, Seth 2026-10-02: "Auto-segmentation doesn't work on audio recordings longer
 * than ten minutes … Maybe our auto segmentation for longer texts can look for convenient points to
 * split them in half or quarters first and then auto segment each large segment one at a time").
 *
 * The span [startMs, endMs) — the whole recording, or one piece of it — is guessed in WINDOWS of
 * about GUESS_WINDOW_MS:
 *   1. a coarse pass over the whole span finds where its pauses are at all;
 *   2. the span is divided into k = ceil(length / window) parts, and each ideal dividing point is
 *      moved to the NEAREST coarse pause — so the windows meet at real silences, never mid-word;
 *   3. each window is guessed as a recording of its own (guessSplitsWithin), so its noise floor and
 *      speech level come from that stretch alone — a long field recording drifts, the speaker turns,
 *      a generator starts, and one set of levels for forty minutes serves none of it well;
 *   4. the window edges and every window's boundaries are stitched into one ascending list.
 *
 * A span no longer than one window is simply guessSplitsWithin — nothing changes for the recordings
 * the detector always handled. A coarse pass that finds nothing returns [] (the honest "no clear
 * pauses" answer, as before). The minimum-line rule holds across the stitch by construction: every
 * window's boundaries keep GUESS_MIN_LINE_MS from that window's edges, and the edges are coarse
 * boundaries that kept it from each other.
 *
 * ⚠ A window can come out longer than GUESS_WINDOW_MS when pauses are sparse near a dividing point;
 * that is fine — the detector works at any length (step 1 just ran it over the whole span). The
 * window is for LOCAL levels, not a limit. Pure, so it is measurable (test/guess-long.test.mjs).
 *
 * @returns {number[]} boundary times in ms (file time), ascending, strictly inside (startMs, endMs) */
export function guessSplitsWindowed(peaks, msPerBucket, startMs, endMs, opts = {}) {
  if (!isNum(startMs) || !isNum(endMs) || endMs <= startMs) return [];
  const windowMs = isNum(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : GUESS_WINDOW_MS;
  const span = endMs - startMs;
  if (span <= windowMs) return guessSplitsWithin(peaks, msPerBucket, startMs, endMs, opts);
  const coarse = guessSplitsWithin(peaks, msPerBucket, startMs, endMs, opts);
  if (!coarse.length) return [];
  const k = Math.ceil(span / windowMs);
  const edges = [];
  for (let j = 1; j < k; j++) {
    const ideal = startMs + (span * j) / k;
    let best = coarse[0];
    for (const c of coarse) if (Math.abs(c - ideal) < Math.abs(best - ideal)) best = c;
    if (!edges.includes(best)) edges.push(best);
  }
  edges.sort((a, b) => a - b);
  const bounds = [startMs, ...edges, endMs];
  const out = new Set(edges);
  for (let w = 0; w < bounds.length - 1; w++) {
    for (const c of guessSplitsWithin(peaks, msPerBucket, bounds[w], bounds[w + 1], opts)) out.add(c);
  }
  return [...out].sort((a, b) => a - b);
}

/* Apply such a guess to ONE piece: segments[i] becomes k+1 pieces and paragraphs[i] becomes k+1
 * empty lines, 1:1 like everything else here, and every other segment and paragraph is carried
 * over untouched. That is what makes it allowed while OTHER lines already have words: the
 * whole-file applyGuessedSplits refuses any document with text in it; this refuses only a texted
 * piece. Boundaries closer than minMs to the piece's edges or to each other are dropped rather
 * than minting a sliver. Same { ok, reason, segments, paragraphs } shape as cutAtPlayhead, so a
 * caller cannot apply half of it; `added` is how many boundaries went in.
 *
 * The detector's boundaries are GUESSES (v717): each piece is an estimate on its inner edges, and the
 * piece's own outer edges keep whatever they were. */
export function applyGuessedSplitsWithin(segments, paragraphs, i, boundaries, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : MIN_SEGMENT_MS;
  const segs = withGuesses(segments);
  const paras = (paragraphs || []).slice();
  const fail = (reason) => ({ ok: false, reason, index: i, segments: segs, paragraphs: paras, added: 0 });
  if (!Number.isInteger(i) || i < 0 || i >= segs.length) return fail('outside');
  if (String(paras[i] || '').trim()) return fail('hasText');
  const cur = segs[i];
  if (!isAligned(cur)) return fail('noAudio');
  const cuts = [];
  for (const b of (boundaries || []).filter(isNum).sort((x, y) => x - y)) {
    const prev = cuts.length ? cuts[cuts.length - 1] : cur.start;
    if (b - prev < minMs || cur.end - b < minMs) continue;
    cuts.push(b);
  }
  if (!cuts.length) return fail('none');
  const pieces = [];
  let rest = cur;
  for (const c of cuts) { const [piece, after] = splitSpanAt(rest, c, { real: false }); pieces.push(piece); rest = after; }
  pieces.push(rest);
  segs.splice(i, 1, ...pieces);
  paras.splice(i, 1, ...pieces.map(() => ''));
  const out = normalizeSegments(segs, opts);
  if (out.length !== segs.length) return fail('none');          // belt and braces, as cutAtPlayhead
  return { ok: true, reason: '', index: i, segments: out, paragraphs: paras, added: cuts.length };
}

/* WHICH LINE TRAVELS WITH YOU TO THE NEXT TAB (Seth, 2026-10-05, #39: "if I'm halfway through on
 * the baseline tab, when I switch to the gloss tab, then whichever segment I had active should be
 * active and scrolled-to on the gloss tab. And same for cut tab").
 *
 * Three candidates, in order: the line whose field you last focused or whose row you last pressed
 * (`touched`, with where the playhead was at that moment), the playhead's own line, and the topmost
 * line on screen. The touched line wins — that is the line you were WORKING on — unless the playhead
 * has moved since you touched it (a drag on the overview, a play-through on the Cut tab), in which
 * case where you are LISTENING wins. `seek` says whether the playhead must be moved into the chosen
 * line so every tab's highlight, Space and ▶ agree with it. Pure, so the rule is testable.
 *
 * @returns {{i:number, seek:boolean}|null} */
export function pickActiveLine({ touched, playheadIdx, playheadMs, fallback } = {}) {
  const t = touched && Number.isInteger(touched.i) && touched.i >= 0 ? touched : null;
  const p = Number.isInteger(playheadIdx) && playheadIdx >= 0 ? playheadIdx : -1;
  const moved = isNum(playheadMs) && isNum(t && t.playheadMs) && playheadMs !== t.playheadMs;
  if (t && (p < 0 || p === t.i || !moved)) return { i: t.i, seek: p !== t.i };
  if (p >= 0) return { i: p, seek: false };
  return Number.isInteger(fallback) && fallback >= 0 ? { i: fallback, seek: false } : null;
}

/* ---------------------------------------------------------------------------------------------
 * ONE SPLITTING RULE ACROSS THE TABS (Seth, 2026-09-06; plans/split-tiers.md).
 *
 * A line's LEVEL is the most advanced tier it carries: 0 audio only, 1 baseline text, 2 glosses or
 * a free translation. A tab of level L may split or join only lines at or below L: "for a more
 * basic editing tab (cut is more basic than baseline, which is more basic than gloss), you cannot
 * cut lines that already have more advanced data associated with them". A split is ONE edit that
 * needs ONE POSITION PER ACTIVE TIER — the playhead for audio, the caret for the baseline text or
 * the free translation, the word gap for the interlinear — started on any tier and completed when
 * every tier has its position; nothing is written before that. A tier a line does not carry (no
 * time yet, no words yet, no translation yet) needs no position. These are the pure parts; the
 * pending state and its markers live in segment-strips.js (splitPlace) and the tabs.
 * ------------------------------------------------------------------------------------------- */
export const TAB_LEVEL = { cut: 0, baseline: 1, gloss: 2 };
export function lineLevel(info) {
  if (info && info.hasGloss) return 2;
  if (info && String(info.text || '').trim()) return 1;
  return 0;
}
export function splitAllowed(tab, info) { return lineLevel(info) <= (TAB_LEVEL[tab] ?? 0); }
export function splitTiers(info) {
  const tiers = [];
  if (info && info.aligned) tiers.push('audio');
  if (info && info.tab === 'gloss') {
    if ((info.words || 0) > 0) tiers.push('words');
    if (String(info.free || '').trim()) tiers.push('free');
  } else if (info && info.tab === 'baseline') {
    if (String(info.text || '').trim()) tiers.push('text');
  } else if (info && info.tab === 'interlinear') {
    // The Paragraph Analysis Tool: one view of the whole interlinear. Words when the line has them
    // (an imported text), else its text (an authored chart); the translation when there is one.
    if ((info.words || 0) > 0) tiers.push('words');
    else if (String(info.text || '').trim()) tiers.push('text');
    if (String(info.free || '').trim()) tiers.push('free');
  }
  return tiers;
}
export function splitPlan(tiers, placed) {
  const have = placed || {};
  const missing = (tiers || []).filter((t) => !Object.prototype.hasOwnProperty.call(have, t));
  return { missing, complete: missing.length === 0 };
}

/* =================================================================================================
 * timingReport — what the one timing banner says about a text (v717, P6: one banner per text; marks
 * on individual lines only for the exceptions). PURE: the spans, the line texts, the recording's
 * decoded length, and whether this session already had to fall back to positional pairing.
 *
 * Signals, each { kind, level, … }, most severe first:
 *   red      'timeSync'  — a text edit's lines could not be followed and syncToLines paired by position;
 *            'dense'     — a line with ≥ 2 words and ≤ 100 ms per word (`lines`, `first`). Only lines
 *                          with at least one REAL edge: a span both of whose edges are guesses says
 *                          nothing about how fast anyone spoke (case 17);
 *            'tailShort' — an editor-made text (every line timed, contiguous from 0) whose recording
 *                          runs ≥ 1 s past its last line (`ms`). Lines can only lose the tail like that
 *                          by being shifted against their audio (the damaged L29 exports);
 *            'pastEnd'   — the last time is more than 350 ms past the recording's end (`ms`): the
 *                          right recording? (Below that it is decoder spread — T53 is 63 ms over.)
 *   amber    'partly'    — some lines have a time and these (`lines`) do not (v718: shown as placeholders
 *                          in their gap, "needs timing"). ⚠ Amber only while they are the EXCEPTION — at
 *                          most half the lines (P6). A text still mostly untimed is a text being cut, not
 *                          a damaged one: `most: true` and level info, and no line is marked (needsMarks);
 *            'noRoom'    — of those, these (`lines`) had no room in their gap and stay ⋯ (v718);
 *   estimate 'estimated' — `n` lines are estimates, `bySource` counts them by where the guess came from;
 *   info     'noTimes'   — nothing in the text has a time yet (`spread`: the lines are drawn evenly, as
 *                          placeholders — v718's one quiet banner for every FLEx export with no times).
 * ⚠ "HAS A TIME" MEANS PLACED (v718): a placeholder is drawn and plays, but it is nobody's time, so it
 * counts as untimed here, is never an estimate, and is never checked for density (case 17).
 * `level` is the most severe item's; `sig` changes whenever what the banner would say changes, so a
 * dismissal can be remembered against it and the banner come back when the text changes under it.
 * ============================================================================================== */
export const TIMING_DENSE_MS_PER_WORD = 100;
export const TIMING_TAIL_SHORT_MS = 1000;
export const TIMING_PAST_END_MS = 350;
const TIMING_RANK = { red: 4, amber: 3, estimate: 2, info: 1 };

export function timingReport(spans, texts, opts = {}) {
  const segs = Array.isArray(spans) ? spans : [];
  const lines = Array.isArray(texts) ? texts : [];
  const n = Math.max(segs.length, lines.length);
  const D = isNum(opts.durationMs) && opts.durationMs > 0 ? opts.durationMs : null;
  const items = [];
  const aligned = Array.from({ length: n }, (_, k) => isPlaced(segs[k]));
  const words = (k) => String(lines[k] || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

  if (opts.timeSync) items.push({ kind: 'timeSync', level: 'red' });
  if (n && !aligned.some(Boolean)) items.push({ kind: 'noTimes', level: 'info', n, spread: segs.some(isPlaceholder) });
  else if (n) {
    const dense = [];
    for (let k = 0; k < n; k++) {
      if (!aligned[k]) continue;
      const s = segs[k];
      if (Array.isArray(s.guess) ? edgeGuessed(s, 0) && edgeGuessed(s, 1) : !!s.timeEstimated) continue;
      const w = words(k), ms = s.end - s.start;
      if (w >= 2 && ms / w <= TIMING_DENSE_MS_PER_WORD) dense.push({ line: k, words: w, ms });
    }
    if (dense.length) items.push({ kind: 'dense', level: 'red', lines: dense.map((d) => d.line), first: dense[0] });

    const timed = segs.filter(isPlaced);
    const lastEnd = Math.max(...timed.map((s) => s.end));
    if (D && aligned.every(Boolean) && segs[0].start <= GUESS_TOL_MS
        && segs.every((s, k) => k === 0 || Math.abs(s.start - segs[k - 1].end) <= GUESS_TOL_MS)) {
      const tail = D - segs[n - 1].end;
      if (tail >= TIMING_TAIL_SHORT_MS) items.push({ kind: 'tailShort', level: 'red', ms: Math.round(tail) });
    }
    if (D && lastEnd - D > TIMING_PAST_END_MS) items.push({ kind: 'pastEnd', level: 'red', ms: Math.round(lastEnd - D) });

    const untimed = [];
    for (let k = 0; k < n; k++) if (!aligned[k]) untimed.push(k);
    if (untimed.length) {
      const most = 2 * untimed.length > n;
      items.push({ kind: 'partly', level: most ? 'info' : 'amber', n: untimed.length, lines: untimed, ...(most ? { most: true } : {}) });
    }
    const cramped = untimed.filter((k) => segs[k] && segs[k].noRoom);
    if (cramped.length) items.push({ kind: 'noRoom', level: 2 * untimed.length > n ? 'info' : 'amber', n: cramped.length, lines: cramped });

    const bySource = {};
    let est = 0;
    for (let k = 0; k < n; k++) {
      if (!isEstimate(segs[k]) || isPlaceholder(segs[k])) continue;
      est++;
      const src = segs[k].estSource || (Array.isArray(segs[k].guess) ? 'edit' : 'legacy');
      bySource[src] = (bySource[src] || 0) + 1;
    }
    if (est) items.push({ kind: 'estimated', level: 'estimate', n: est, total: n, bySource });
  }
  items.sort((a, b) => TIMING_RANK[b.level] - TIMING_RANK[a.level]);
  const sig = items.map((it) => [it.kind, it.n ?? '', (it.lines || []).join('.'), it.ms ?? ''].join(':')).join('|');
  return { level: items.length ? items[0].level : '', items, sig };
}
