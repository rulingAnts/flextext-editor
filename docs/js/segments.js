/* segments.js — time-aligned segment spans for the Simple-ELAN-style baseline editor.
 *
 * PURE MODULE, NO DOM. Every function here is a total function over plain data, so the whole
 * crossing-prevention story is unit-testable without a browser. That is deliberate: this is the
 * part of the feature that can silently corrupt field data, so it must be the part that is easiest
 * to test exhaustively.
 *
 * WHAT A SEGMENT IS: `{ start, end, timePending?, timeEstimated? }`, milliseconds.
 *   - `timePending: true`  — the user made a break but there was no valid time for it (they scrubbed
 *     backwards, or there was no room between neighbours). The TEXT still exists; the segment simply
 *     carries no time until they set one. NEVER fabricate a time to avoid this state.
 *   - `timeEstimated: true` — the time was interpolated (e.g. a gloss-tab split with the playhead
 *     elsewhere) rather than chosen by the user. Playable, but rendered dashed so the user knows it
 *     is a guess they can correct.
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

function blank(seg) {
  // Preserve any non-time fields a caller attached (e.g. phraseIndex) while clearing the times.
  const out = { ...seg, timePending: true };
  delete out.start; delete out.end; delete out.timeEstimated;
  return out;
}

/* ---------------------------------------------------------------------------------------------
 * normalizeSegments — the one place crossing is prevented.
 *
 * Guarantees on the returned array (same length as the input, order never changed):
 *   1. every aligned segment has `end >= start + MIN_SEGMENT_MS`, else it becomes `timePending`;
 *   2. aligned segments are strictly increasing and non-overlapping in time;
 *   3. `first.start >= 0` and `last.end <= duration` (when a duration is known);
 *   4. anything that cannot satisfy the above becomes `timePending` rather than being invented.
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
  const duration = isNum(opts.duration) ? opts.duration : null;
  const minMs = isNum(opts.minMs) ? opts.minMs : MIN_SEGMENT_MS;
  const out = (segments || []).map((s) => (s ? { ...s } : { timePending: true }));

  // Pass 1 — per-segment sanity. Clamp into [0, duration] and demote anything too short/invalid.
  for (const seg of out) {
    if (!isAligned(seg)) { Object.assign(seg, blank(seg)); continue; }
    if (seg.start < 0) seg.start = 0;
    if (duration !== null && seg.end > duration) seg.end = duration;
    if (duration !== null && seg.start > duration) { Object.assign(seg, blank(seg)); continue; }
    if (seg.end - seg.start < minMs) Object.assign(seg, blank(seg));
  }

  // Pass 2 — monotonicity, forwards. Each aligned segment must start at or after the previous
  // aligned segment's end. If pushing it forward would leave less than minMs, it has no room to
  // exist here: demote it rather than overlap.
  let prevEnd = null;
  for (const seg of out) {
    if (!isAligned(seg)) continue;
    if (prevEnd !== null && seg.start < prevEnd) {
      seg.start = prevEnd;
      if (seg.end - seg.start < minMs) { Object.assign(seg, blank(seg)); continue; }
      // A start we had to move is no longer the user's chosen time — say so.
      seg.timeEstimated = true;
    }
    prevEnd = seg.end;
  }

  return out;
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
  const src = segments || [];
  const cur = src[index];
  const out = src.map((s) => ({ ...s }));

  // Splitting an unaligned segment can only produce unaligned halves — there is no time to divide.
  if (!cur || !isAligned(cur) || !isNum(playheadMs)) {
    out.splice(index + 1, 0, { timePending: true });
    return normalizeSegments(out, opts);
  }

  // The playhead must leave a viable segment on BOTH sides, or it is not a usable boundary.
  const lo = cur.start + minMs;
  const hi = cur.end - minMs;
  if (playheadMs < lo || playheadMs > hi) {
    // No room (or the playhead is outside this segment entirely, e.g. the user scrubbed backwards).
    // Keep the existing segment intact and give the new line a pending segment: text is never lost,
    // and we have not invented a boundary the user did not choose.
    out.splice(index + 1, 0, { timePending: true });
    return normalizeSegments(out, opts);
  }

  const first = { ...cur, end: playheadMs };
  const second = { ...cur, start: playheadMs, end: cur.end };
  delete second.timeEstimated;
  out.splice(index, 1, first, second);
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
  if (i < 0 || i + 1 >= src.length) return src.map((s) => ({ ...s }));
  const a = src[i];
  const b = src[i + 1];

  let merged;
  if (isAligned(a) && isAligned(b)) merged = { start: a.start, end: b.end };
  else if (isAligned(a)) merged = { start: a.start, end: a.end };
  else if (isAligned(b)) merged = { start: b.start, end: b.end };
  else merged = { timePending: true };

  // The merged span inherits "estimated" if either side was a guess — the result is no more
  // trustworthy than its least trustworthy half.
  if (merged.start !== undefined && (a.timeEstimated || b.timeEstimated)) merged.timeEstimated = true;

  const out = src.map((s) => ({ ...s }));
  out.splice(i, 2, merged);
  return normalizeSegments(out, opts);
}

/* ---------------------------------------------------------------------------------------------
 * splitSegment — divide segment i in two.
 *
 * Time source, in priority order (see the plan's two-step rule):
 *   1. `opts.playheadMs` when it falls INSIDE the segment — an exact, user-chosen boundary.
 *   2. otherwise interpolate from `opts.fraction` (0..1, e.g. wordsBefore/wordsTotal) and mark the
 *      result `timeEstimated` so the UI can render it dashed.
 * Interpolating is not a fabricated claim: ELAN itself interpolates unaligned annotations for
 * display. This just makes that explicit and labels it.
 * ------------------------------------------------------------------------------------------- */
export function splitSegment(segments, i, opts = {}) {
  const minMs = isNum(opts.minMs) ? opts.minMs : MIN_SEGMENT_MS;
  const src = segments || [];
  if (i < 0 || i >= src.length) return src.map((s) => ({ ...s }));
  const cur = src[i];
  const out = src.map((s) => ({ ...s }));

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

  const first = { ...cur, end: at };
  const second = { ...cur, start: at, end: cur.end };
  if (estimated) { first.timeEstimated = true; second.timeEstimated = true; }
  out.splice(i, 1, first, second);
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
