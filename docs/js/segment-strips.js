/* Segment strips — the segmentation-mode baseline editor (Seth's 2026-08-03 redesign).
 *
 * Each segment renders as a STRIP: [play button | waveform slice | single-line text box], stacked
 * vertically. Enter breaks the waveform at the PLAYHEAD and the text at the CURSOR, starting a new
 * strip beneath; Backspace at the start of a strip (or Delete at the end) merges it with its
 * neighbour — text joins, spans join. A continuous player lives at the bottom of the tab (the
 * app's existing Player); strips are VIEWS onto it, never players of their own.
 *
 * ⚠ ONE DECODE, ONE PEAKS ARRAY, NO PER-STRIP AUDIO. Each strip draws its [start,end) sub-range of
 * a single shared peaks array onto its own small canvas. N wavesurfers would re-open the memory
 * problem the RAM-cap work exists to prevent; peaks are computed once per doc and the decoded
 * AudioBuffer is released immediately after.
 *
 * ⚠ THE MODEL OWNS THE INVARIANTS. Every edit routes through segments.js
 * (boundaryAtPlayhead / mergeSegments / normalizeSegments): segments can never cross, a time is
 * never invented (out-of-range playhead → timePending, text still splits — text is sacred), and
 * strip order IS paragraph order. This file is rendering + wiring only.
 *
 * ⚠ NO AUDIO IS EVER EDITED. Strips are metadata pointing INTO an untouched recording; peaks are a
 * DISPLAY of samples, never a modification of them.
 */

import { normalizeSegments, boundaryAtPlayhead, mergeSegments, syncToLines, isAligned,
         cutAtPlayhead, joinWithPrevious, segmentIndexAt,
         guessSplits, applyGuessedSplits, GUESS_MAX_MS } from './segments.js';
import { peakPlan } from './seg-exports.js';

let deps = null;      // { container, textarea, getPlayer, getDoc, getParagraphs, setParagraphs, persist, t }
let peaksCache = { docId: null, peaks: null, durationMs: 0 };
/* ⚠ A WAVE DRAWN BEFORE THE PEAKS EXISTED MUST REDRAW WHEN THEY ARRIVE (Seth, 2026-08-05: "the
 * first time a text with audio segmentation loads, we get no waveform until we close and re-open
 * the text"). The ResizeObserver and fixStaleWave below only compare WIDTHS — so a canvas drawn at
 * exactly the right width, but with peaks still null, matches on width forever and is never
 * redrawn. This counter closes that hole: every canvas records which generation of peaks it was
 * drawn with, and the ticker redraws anything drawn with an older one. */
let peaksGen = 0;
/* ⚠ AND A RUN TOKEN, because the bucketing loop now YIELDS (see below). Before it did, ensurePeaks
 * was atomic between its `peaksCache = {docId, peaks:null}` reset and the write of the finished
 * array — nothing could interleave. A loop that awaits can be overtaken by a second call for a
 * DIFFERENT doc, and the loser would then publish its peaks over the winner's: one text's waveform
 * under another's segments, which is the exact failure the Cut tab's doc-switch guards exist to
 * prevent. The loser checks this counter and returns without writing. */
let peaksRun = 0;
let rafId = 0;
// Follow-playback state (v326): scroll only on a CHANGE of playing line, and stand off for 4s
// after any user scroll so the view is never fought over (the PAT recipe).
let followRow = null;
let lastUserScroll = 0;
if (typeof window !== 'undefined') {
  for (const ev of ['wheel', 'touchmove']) window.addEventListener(ev, () => { lastUserScroll = Date.now(); }, { passive: true });
}

/* ── THE FOLLOW RULE, in one place (extracted v354) ────────────────────────────────────────────
 * The Baseline strips, the Gloss line-groups and now the Cut tab all "follow" the playing line, and
 * all three had the same four-part rule written out separately. Seth: "reuse whatever common code
 * you can … if it makes things more reliable and consistent without breaking any other tabs."
 *
 * The rule (the PAT recipe, v326): scroll only on a line CHANGE, only while actually PLAYING, only
 * when the row is off screen, and never within 4s of the user scrolling — so the view is never
 * fought over. ⚠ v364 dropped the fifth clause, which exempted span playback; see below.
 *
 * Returns the row to remember as "currently followed". Callers keep their own memory of it, because
 * each tab scrolls its own list independently.
 *
 * ⚠ Extraction only — the behaviour is byte-for-byte what the Baseline ticker already did. Changing
 * the rule here changes it on every tab at once, which is the point and also the risk. */
export function followLine(row, rolling, prevRow, player) {
  if (!rolling || row === prevRow) return prevRow;
  /* ⚠ SPAN PLAYBACK FOLLOWS TOO NOW (Seth, 2026-08-13: "auto-scrolling works if I play the big
   * player, but I want it to work on the play-through behavior too"). v326 exempted it — "the user
   * just clicked it, so they are already looking at it" — which was a guess about where they were
   * looking, and the `offScreen` test below is the same claim MEASURED. If the line really is on
   * screen nothing happens either way; if it is not, the old rule left the user listening to
   * something they could not see. The exemption also stopped being harmless when playback stopped
   * meaning one line: a row's ▶ arms a span, and every other transport does not. */
  if (Date.now() - lastUserScroll > 4000 && offScreen(row)) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return row;
}

function offScreen(row) {
  const r = row.getBoundingClientRect();
  return r.top < 60 || r.bottom > (window.innerHeight - 20);
}

/* ── "TAKE ME TO THAT LINE" ────────────────────────────────────────────────────────────────────
 * Seth, 2026-08-13: "if they select somewhere on the [big player] that is off screen, it should
 * auto scroll to that line so that it's in the middle of the view window."
 *
 * Seeking on the whole-file player is how you find your place in a long recording — and until now it
 * moved the playhead to a line that could be a screenful away, leaving the user to hunt for the row
 * they had just chosen. This is the other half of the synchronisation between the one overview and
 * the strips.
 *
 * ⚠ IT IS A REQUEST, NOT A SCROLL. The row for a given time is something each tab's own ticker
 * already works out (and each does it differently — cut rows, baseline strips, gloss groups), so
 * asking them to honour a pending request reuses three correct implementations instead of adding a
 * fourth that would drift. Every ticker calls takeReveal() with the row it has decided is the
 * playhead's, and the FIRST one to answer clears the request.
 *
 * ⚠ AND IT EXPIRES. A seek into a `timePending` span belongs to no row at all, so the request would
 * otherwise sit armed and fire minutes later, mid-playback, as a scroll nobody asked for. */
let revealAt = 0;
export function requestReveal() { revealAt = Date.now(); }
export function takeReveal(row) {
  if (!revealAt) return;
  if (Date.now() - revealAt > 1500) { revealAt = 0; return; }
  /* ⚠ A ROW ON A HIDDEN TAB IS NOT AN ANSWER. The Baseline strips' rAF loop keeps running behind the
   * Cut tab (nothing stops it on that transition), so it would answer the request first, with a row
   * nobody can see — and the tab the user is actually looking at would never scroll. offsetParent is
   * null for anything inside a hidden ancestor, which is exactly the test needed. */
  if (!row || !row.offsetParent) return;
  /* ⚠ AND THE REQUEST IS ONLY SPENT WHEN IT ACHIEVES SOMETHING. Consuming it on an already-visible
   * row is what broke DRAGGING the whole-file player: wavesurfer emits `interaction` on every drag
   * move but debounces the seek by up to 200ms, so the first tick still finds the row the user
   * STARTED from — on screen, no scroll needed, request gone — and the row they dragged TO never
   * came into view. Leaving it armed lets the real destination claim it a few frames later. */
  if (!offScreen(row)) return;
  revealAt = 0;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function initStrips(d) { deps = d; }

/* ---------------- the loading indicator (Seth, 2026-08-20) ----------------
 * "If there are real constraints with loading speed we can't get around, we need to always make
 * sure our UI is responsive and gives the user some kind of 'loading' response/status bar."
 *
 * Preparing a recording for the Cut and Baseline tabs is genuinely slow and cannot be argued down:
 * a lossy source is decoded and re-encoded to a WAV working copy (the AAC-priming fix), and then
 * every sample is bucketed into the peaks array. On a field phone with a ten-minute take that is
 * seconds of work, and it used to happen behind ONE unchanging line of text — which is
 * indistinguishable from an app that has hung.
 *
 * So the same element now carries a STAGE NAME and a BAR. A stage that can measure itself reports a
 * fraction; one that cannot (a browser-internal decodeAudioData) passes null and the bar runs
 * indeterminate, which still says "working" rather than "stuck".
 *
 * ⚠ THE BAR IS ONLY HALF OF IT. A progress bar that never repaints is a worse lie than no bar at
 * all — it converts "the app is frozen" into "the app is frozen AND lying". Every long loop behind
 * one of these must yield; see the time-sliced bucketing in ensurePeaks. */
export function segProgress(el, message, frac) {
  if (!el) return;
  const text = el.querySelector('.seg-loading-text');
  if (text && message != null) text.textContent = message;
  const bar = el.querySelector('.seg-loading-bar');
  if (!bar) return;
  const known = typeof frac === 'number' && isFinite(frac);
  bar.classList.toggle('is-indeterminate', !known);
  const fill = bar.querySelector('i');
  if (fill) fill.style.width = known ? (Math.max(0, Math.min(1, frac)) * 100) + '%' : '';
}

/* ⚠ setTimeout, NOT requestAnimationFrame. rAF does not fire in a BACKGROUNDED tab, so a user who
 * starts a big text and switches away to do something else would return to a load that had stopped
 * dead half way. A macrotask always runs, and the browser paints between macrotasks — which is the
 * entire requirement here. */
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));
const nowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
/* Yield after this many ms of unbroken work. Small enough that a tap still feels answered on a slow
 * phone, large enough that the yields themselves are not the cost (a clamped timer is ~4ms). */
const SLICE_MS = 12;

/* ---------------- peaks (one decode per doc, buffer released immediately) ---------------- */

// Peak DENSITY scales with duration — a fixed whole-file bucket count is why short segments
// looked blocky: a 2s slice of a 10-min file got ~13 buckets stretched across the strip. 200
// buckets/second = 5ms resolution; a 10-min recording is still only ~470 KB of Float32, computed
// once and far cheaper than keeping the decoded buffer.
// 2000/s = 0.5ms resolution: a HALF-SECOND segment gets ~1000 buckets — at or below one bucket
// per device pixel on any realistic strip width, which is what 'clear and detailed' requires for
// the short segments this workflow produces (Seth: 200/s read blocky at 0.5-2s). A 10-minute file
// is ~4.8 MB of Float32 — trivial beside the decoded buffer we deliberately discard.
const BUCKETS_PER_SEC = 2000;

/* ⚠ A "DECODED BUFFER" THAT IS REALLY A PICTURE IS WORSE THAN NONE. Player.decodedBuffer() already
 * refuses to hand over a peaks-only load, but this is the module that would be poisoned, so it
 * states its own requirement rather than trusting a caller: real recorded audio, at a real sample
 * rate. Anything under 8 kHz is not a recording — it is somebody's DISPLAY PEAKS wearing an
 * AudioBuffer's shape (wavesurfer's 12000 peaks over a 90-second take ⇒ 136 Hz) — and bucketing it
 * leaves 93% of the buckets zero, which reads to every consumer as a recording that is mostly
 * silence. That is the Snakes_We_Eat.m4a report: ✨ Guess worked on the first open and refused with
 * "no clear pauses" on every open after. */
const realAudio = (buf) => !!(buf && Number.isFinite(buf.sampleRate) && buf.sampleRate >= 8000
                              && Number.isFinite(buf.duration) && buf.duration > 0);

export async function ensurePeaks(docId, blob, playerBuf, onProgress) {
  // Prefer the PLAYER'S decoded buffer: one decode, one timeline (see Player.decodedBuffer).
  // A cache built from our own fallback decode is upgraded when the player's arrives.
  const fromPlayer = realAudio(playerBuf) ? playerBuf : null;
  if (peaksCache.docId === docId && peaksCache.peaks && (peaksCache.fromPlayer || !fromPlayer)) return peaksCache;
  peaksCache = { docId, peaks: null, durationMs: 0 };
  const myRun = ++peaksRun;          // see peaksRun — the loop below yields, so calls can interleave
  if (!blob && !fromPlayer) return peaksCache;
  const say = typeof onProgress === 'function' ? onProgress : () => {};
  /* ⚠ ONE RETRY. decodeAudioData on a long recording fails now and then for reasons that do not
   * recur a second later (memory pressure, a context the browser was still tearing down), and a
   * single failure used to leave every strip blank until the text was closed and opened again —
   * which is what re-ran this. The retry is that reopen, done for the user. */
  const decodeOnce = async () => {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    try { return [await c.decodeAudioData(await blob.arrayBuffer()), c]; }
    catch (e) { try { c.close(); } catch { /* noop */ } throw e; }
  };
  try {
    let buf = fromPlayer, ctx = null;
    if (!buf) {
      /* ⚠ INDETERMINATE ON PURPOSE. decodeAudioData is inside the browser and reports nothing on the
       * way through, so any fraction here would be invented. An honest "working" beats a made-up
       * number that stalls at 40% and teaches the user to distrust the bar. */
      say('decode', null);
      try { [buf, ctx] = await decodeOnce(); }
      catch (first) {
        if (peaksRun !== myRun) return peaksCache;
        await new Promise((r) => setTimeout(r, 1500));
        if (peaksRun !== myRun) return peaksCache;
        try { [buf, ctx] = await decodeOnce(); }
        catch (second) { second.firstAttempt = first; throw second; }
      }
      if (peaksRun !== myRun) { try { ctx.close(); } catch { /* noop */ } return peaksCache; }
    }
    const ch = buf.getChannelData(0);
    const { buckets: BUCKETS, per } = peakPlan(ch.length, buf.sampleRate, buf.duration, { perSec: BUCKETS_PER_SEC });
    const peaks = new Float32Array(BUCKETS);
    // ⚠ THE ALIGNMENT TRUTH: bucket b covers samples [b*per, (b+1)*per) — NOT b/BUCKETS of the
    // duration. flooring `per` leaves a remainder tail unmapped, so any proportional-to-duration
    // mapping accumulates error toward the file end (≈1.4s of skew on a 10-min recording — Seth
    // saw the waveforms 'not aligning perfectly'). msPerBucket is the exact conversion; every
    // consumer must use it, never durationMs proportions.
    /* ⚠ TIME-SLICED, NOT ONE BLOCKING PASS. This is the loop that makes a ten-minute recording feel
     * like a hang: it touches every fourth sample of the whole file on the main thread, so nothing
     * paints and no tap is answered until it finishes. Slicing it by TIME rather than by a fixed
     * bucket count is what makes it adapt — the cheap Android this suite is aimed at gets the same
     * ~12ms of responsiveness per slice as a laptop, it just covers fewer buckets per slice.
     * ⚠ The cost is real and accepted: yielding adds the timer clamp (~4ms) per slice. Measuring
     * peaks a little slower while the app answers is the trade Seth asked for. */
    let sliceStart = nowMs();
    for (let b = 0; b < BUCKETS; b++) {
      let m = 0;
      const off = b * per, end = Math.min(ch.length, off + per);
      for (let i = off; i < end; i += 4) { const v = Math.abs(ch[i]); if (v > m) m = v; }  // stride 4: display, not measurement
      peaks[b] = m;
      if ((b & 255) === 0 && nowMs() - sliceStart > SLICE_MS) {
        say('peaks', b / BUCKETS);
        await yieldToUi();
        if (peaksRun !== myRun) { try { ctx && ctx.close(); } catch { /* noop */ } return peaksCache; }
        sliceStart = nowMs();
      }
    }
    say('peaks', 1);
    peaksCache = { docId, peaks, durationMs: Math.round(buf.duration * 1000),
                   msPerBucket: (per / buf.sampleRate) * 1000, fromPlayer: !!fromPlayer };
    peaksGen++;      // whatever was drawn without these is now stale, whatever its width
    try { ctx && ctx.close(); } catch { /* noop */ }
  } catch (e) {
    // Undecodable (or no Web Audio) → strips render without waveforms. WARN rather than vanish:
    // a silent catch here cost a whole debugging round (every wave flat, no clue why) — the
    // console line is the difference between "decode failed: EncodingError" and guessing.
    try { console.warn('[segment-strips] peaks unavailable for', docId, e); } catch { /* noop */ }
    // Forget the failed attempt, so the NEXT call recomputes instead of returning a cache that says
    // "this text, no peaks" for ever.
    if (peaksRun === myRun) peaksCache = { docId: null, peaks: null, durationMs: 0 };
    say('failed', null);
  }
  return peaksCache;
}

/* ---------------- redraw-on-resize (the 'no waveform, just a slab' fix) ---------------- */

/* drawStrip captures canvas.clientWidth at the INSTANT it runs. A render that races layout — the
 * tab unhidden this same frame, a window resize, phone rotation, fonts landing — bakes a tiny
 * buffer that CSS width:100% then stretches into a featureless slab or a bare midline (Seth:
 * 'line by line previews no longer working', both tabs). One shared ResizeObserver redraws any
 * wave whose on-screen size no longer matches its buffer; detached canvases are swept on each
 * observe call so re-renders never accumulate dead nodes. Redraw only fires when the sizes
 * genuinely disagree, and setting canvas.width does not change its CSS box — no feedback loop. */
let waveRO = null;
const observedWaves = new Set();
function observeWave(canvas, redraw) {
  canvas.__redrawWave = redraw;
  if (typeof ResizeObserver === 'undefined') return;
  if (!waveRO) {
    waveRO = new ResizeObserver((entries) => {
      for (const en of entries) {
        const el = en.target;
        if (!el.isConnected) { waveRO.unobserve(el); observedWaves.delete(el); continue; }
        const want = Math.round(el.clientWidth * (window.devicePixelRatio || 1));
        if (want > 0 && el.width !== want && el.__redrawWave) el.__redrawWave();
      }
    });
  }
  for (const el of observedWaves) if (!el.isConnected) { waveRO.unobserve(el); observedWaves.delete(el); }
  if (!observedWaves.has(canvas)) { waveRO.observe(canvas); observedWaves.add(canvas); }
}

/* Belt-and-braces beside the observer: both tabs already run a ticker (baseline rAF cursor loop,
 * gloss glyph interval) — piggyback a width check there so a stale buffer heals within a tick
 * even where ResizeObserver misbehaves. Reads nothing the loops don't already touch. */
function fixStaleWave(canvas) {
  if (!canvas || !canvas.__redrawWave) return;
  const want = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1));
  // Stale by WIDTH (raced layout) or by PEAKS (drawn before the audio finished decoding).
  if (want > 0 && (canvas.width !== want || canvas.__peaksGen !== peaksGen)) canvas.__redrawWave();
}

/* ---------------- segment state on the doc ---------------- */

// ⚠ Tolerates a missing doc. It is called from a requestAnimationFrame loop that can outlive the
// open document by a frame or two, and throwing there used to kill that loop for good.
export function docSegments(doc) {
  if (!doc) return [];
  if (!doc.segments || !Array.isArray(doc.segments)) doc.segments = [];
  return doc.segments;
}

// Keep segments 1:1 with paragraphs, using the model's own repair (extra → merged, missing →
// timePending), so a doc edited on a non-segmentation device re-opens sane here.
/* ⚠ TAKES ITS DEPS, because the CUT TAB can now be the first screen a text ever shows (a text made
 * from a recording opens there). The seed below is what gives a fresh recording its one whole-file
 * span — and it used to run only from renderStrips, i.e. only if the Baseline tab had been visited.
 * Bypassing Baseline therefore meant a Cut tab with NO rows at all: nothing to play, nothing to cut,
 * on the one screen the user was sent to. */
/* How long is THIS document's recording, according to the peaks cache?
 *
 * ⚠ THE CACHE IS MODULE-GLOBAL AND HOLDS EXACTLY ONE DOCUMENT. Reading `durationMs` without asking
 * whose it is means a text opened straight after another one can be seeded with the PREVIOUS
 * recording's length — a whole-file span that is not the whole file, written to the doc and
 * persisted, with nothing afterwards to notice: the seed only fires on zero segments and the heal
 * only on all-pending ones, and this span is neither. Returns 0 when the cache is somebody else's,
 * which every caller below already treats as "not known yet". */
function peaksDurationFor(d) {
  if (d && typeof d.getDocId === 'function') {
    const id = d.getDocId();
    if (id && peaksCache.docId && id !== peaksCache.docId) return 0;
  }
  return peaksCache.durationMs || 0;
}

/* ⚠ THE RECORDING MUST BE ACCOUNTED FOR, ALL OF IT (Seth, 2026-08-14: "showing part (not all) of the
 * recording on the first and only line such that the segments don't render all of it is not OK").
 *
 * Cuts and joins preserve coverage by construction and the seed spans the whole file, so a tail of
 * unaccounted audio can only come from a disagreement about the duration — a seed written before the
 * decode landed, a cache belonging to another document, a player and a decoder reporting different
 * lengths for the same lossy file. Whatever the route, the result on screen is the same and is
 * indefensible: a single strip showing a fraction of the take, playback running past its end, and no
 * way to reach the rest.
 *
 * So the tail is extended to the end of the recording — but ONLY when doing so cannot lose an
 * alignment somebody meant:
 *   - the last line has no text, so nothing is being re-timed against words;
 *   - it carries no imported `attrs`, so a FLEx/ELAN alignment that deliberately stops early
 *     (trailing room tone left unannotated) is never overwritten;
 *   - and the shortfall is more than a second, so rounding and encoder priming are left alone.
 */
const COVER_TOL_MS = 1000;
function coverTail(segments, paras, durationMs) {
  if (!(durationMs > 0) || !segments.length) return false;
  const i = segments.length - 1;
  const last = segments[i];
  if (!isAligned(last) || last.attrs) return false;
  if (String(paras[i] ?? '').trim()) return false;
  if (durationMs - last.end <= COVER_TOL_MS) return false;
  last.end = durationMs;
  return true;
}

function reconcile(doc, d = deps) {
  const paras = d.getParagraphs(doc);
  const segs = docSegments(doc);
  // SEED: a doc entering segmentation for the first time gets ONE segment spanning the whole
  // recording — that is the truthful starting state (nothing has been divided yet), and it is what
  // makes the first Enter actually have a time span to break. Without it every strip starts
  // timePending and no boundary can ever be real.
  let repaired = false;
  const known = peaksDurationFor(d);   // 0 while the decode is still out, or if the cache is another doc's
  if (!segs.length && known > 0) {
    // Fresh single-line doc: one whole-file span (transcribe-from-scratch; the first Enter
    // needs a real span to break). PRE-TRANSCRIBED multi-line doc (an imported flextext with
    // glosses but no time alignment — Seth's case, 2026-08-03): an even division marked
    // timeEstimated instead. Line 1 claiming the whole recording would be a FALSE alignment;
    // estimated spans are honest (dashed), playable, and correctable with the set-boundary
    // control — and creating them touches doc.segments only, so glosses and free translations
    // cannot be lost by construction.
    const D = known, N = paras.length;
    doc.segments = N > 1
      ? paras.map((_, k) => ({ start: Math.round((k * D) / N), end: Math.round(((k + 1) * D) / N), timeEstimated: true }))
      : [{ start: 0, end: D }];
    repaired = true;
  } else if (known > 0 && segs.length && segs.every((x) => !isAligned(x))) {
    // HEAL a stuck all-pending doc (Seth's '⋯ + no waveform' screenshot): a doc opened while its
    // audio could not be decoded (or under a pre-fix build) persisted pending segments, and the
    // whole-file seed above only fires on ZERO segments — so it never self-repaired once the audio
    // became readable. With a known duration: a single pending becomes the exact whole-file span;
    // several become an even division marked timeEstimated (dashed — scrub + re-break to correct).
    // Only the every-pending case is touched: real alignments are never second-guessed.
    const D = known, N = segs.length;
    doc.segments = N === 1
      ? [{ start: 0, end: D }]
      : segs.map((_, k) => ({ start: Math.round((k * D) / N), end: Math.round(((k + 1) * D) / N), timeEstimated: true }));
    repaired = true;
  }
  doc.segments = syncToLines(docSegments(doc), paras.length, { duration: known || null });
  // …and whatever produced them, they must reach the end of the recording. See coverTail.
  if (coverTail(doc.segments, paras, known)) repaired = true;
  // Persist a seed/heal right away: without this the repair lived only in memory until the next
  // edit, so storage (and everything that syncs from it) kept the broken pending state.
  if (repaired && d.persist) d.persist();
  return doc.segments;
}

/* ---------------- rendering ---------------- */

/* The element whose scroll offset the strip lists live inside — the nearest scrollable ancestor
 * (both tabs sit in <main>, but found rather than assumed so a layout change cannot orphan the
 * scroll-holding below). Shared by renderStrips and renderCut: the two tabs must not drift apart in
 * HOW they hold the view, any more than in what they draw. */
function scrollerFor(host) {
  for (let n = host && host.parentElement; n; n = n.parentElement) {
    const ov = getComputedStyle(n).overflowY;
    if (ov === 'auto' || ov === 'scroll') return n;
  }
  return document.scrollingElement || document.documentElement;
}

export function renderStrips() {
  const doc = deps.getDoc();
  if (!doc) return;
  const segs = reconcile(doc);
  const paras = deps.getParagraphs(doc);
  const host = deps.container;
  /* ⚠ HOLD THE SCROLL ACROSS THE REBUILD — the same v357 rule renderCut lives by, which this
   * function never got. A synchronous empty-and-refill would survive on its own (the clamp only
   * fires at the next layout), but drawStrip reads clientWidth per row, forcing layout MID-rebuild
   * while the container is nearly empty — so the offset dies there. The in-box Enter masked it for
   * a year because focusStrip scrolls the next input into view; the playhead-Enter moves no focus
   * on purpose, and the v368 audit measured every chop landing the user back at the top (8021→0 on
   * a 60-line text). Read BEFORE the empty; restored at the end of this function. */
  const scroller = scrollerFor(host);
  const keepTop = scroller ? scroller.scrollTop : 0;
  host.innerHTML = '';
  const dur = peaksCache.durationMs || (segs.length && isAligned(segs[segs.length - 1]) ? segs[segs.length - 1].end : 0);

  paras.forEach((text, i) => {
    const seg = segs[i] || { timePending: true };
    const row = document.createElement('div');
    row.className = 'seg-strip' + (isAligned(seg) ? '' : ' seg-pending') + (text.trim() ? '' : ' seg-empty')
      + (seg.timeEstimated ? ' seg-est' : '');
    row.dataset.i = i;

    const play = document.createElement('button');
    play.className = 'seg-play';
    /* ⚠ NOT IN THE TAB ORDER (Seth, 2026-08-13): "on baseline and gloss tabs, we don't want play and
     * join and split controls to be part of the tab (keyboard) order. Just next and previous textbox
     * in order." Tab is how a transcriber walks their own text; every control sitting between two
     * boxes was a keypress spent on something they did not ask for. Still clickable, still reachable
     * by pointer — just not a stop on the way to the next line. */
    play.tabIndex = -1;
    // aria-label, NOT title (v322): the native tooltip dropped over the text rows (Seth #10).
    play.setAttribute('aria-label', deps.t(isAligned(seg) ? 'seg.playTip' : 'seg.pendingTip'));
    play.textContent = isAligned(seg) ? '▶' : '⋯';
    play.addEventListener('click', () => {
      if (!isAligned(seg)) return;
      deps.onPlayTarget?.(seg);   // v322: Space toggles / ⏮ rewinds the LAST-used player
      const p = deps.getPlayer();
      if (!p) return;
      // Toggle: if THIS segment is the one rolling, pause IN PLACE — the parked playhead is what
      // the user then breaks at with Enter. Anything else (stopped, or another segment playing)
      // starts this segment's span.
      const t = p.playheadMs?.();
      if (p.playing?.() && typeof t === 'number' && t >= seg.start && t < seg.end) { p.pause(); return; }
      // RESUME from the parked playhead when it sits inside this segment (Seth): pause/scrub then
      // ▶ continues from that spot instead of restarting — restarting would throw away the very
      // position the user just chose. Restart from the top only when the playhead is outside the
      // segment or has effectively reached its end (within 150ms — "finished" for human purposes).
      const from = (typeof t === 'number' && t > seg.start && t < seg.end - 150) ? t : seg.start;
      p.playSpan(from, seg.end, seg.start);   // v332: finishing rewinds to the SEGMENT, not to `from`
    });

    const wave = document.createElement('canvas');
    wave.className = 'seg-wave';
    wave.height = 44;
    wireWaveSeek(wave, seg, deps.getPlayer, (s) => deps.onPlayTarget?.(s));

    const input = document.createElement('input');
    input.className = 'seg-text';
    input.value = text;
    input.spellcheck = false;
    input.addEventListener('input', () => commitTexts());
    input.addEventListener('keydown', (e) => onKey(e, i, input));

    row.append(play, wave, input);
    host.appendChild(row);
    /* ⤙⤚ JOIN, between the two rows it joins (v322, Seth's bug list #7). The baseline tab never
     * had a join button — the ⇥ set-boundary control was being read as one ("join joins the lines
     * incorrectly" was ⇥ moving a boundary). Same control, same glyph, same semantics as the gloss
     * tab's, in its own row OUTSIDE both strips so a missed tap hits nothing destructive; it calls
     * exactly what Backspace calls (mergeAt), so button and key can never disagree. */
    if (i < paras.length - 1 && joinSplitOk()) {
      const joinRow = document.createElement('div');
      joinRow.className = 'seg-joinrow';
      const join = document.createElement('button');
      join.className = 'gseg-join';
      join.tabIndex = -1;            // see the ▶ above: Tab walks TEXT BOXES on this tab
      join.textContent = '⤙⤚';
      join.setAttribute('aria-label', deps.t('seg.joinTip'));
      join.title = deps.t('seg.joinTip');
      join.addEventListener('click', () => mergeAt(i, i + 1));
      joinRow.appendChild(join);
      host.appendChild(joinRow);
    }
    drawStrip(wave, seg, dur);
  });
  // The offset first, then focusStrip (called by our callers) may still bring an edited line into
  // view — restore-then-focus is what keeps both the chop gesture and the typing gesture anchored.
  if (scroller) scroller.scrollTop = keepTop;
  positionCursor();
}

/* Re-TIME without re-TEXTING: set the end of line i (and the start of line i+1) to the playhead.
 * The alignment tool for a pre-transcribed text — it writes doc.segments ONLY, so glosses and
 * free translations can never be touched. Confirms the LEFT segment (its end was just set by
 * ear; its start came from the previously-confirmed chain) and leaves the right one estimated
 * until its own end is confirmed — the natural top-to-bottom listening workflow clears the
 * dashes one line at a time. */

/* The waveform colour of a span that CANNOT be cut (the Cut tab's texted rows). Grey is the whole
 * message: Seth, 2026-08-13 — "the grayed out part should only be parts that have text assigned and
 * so can't be split … Right now our setup is the opposite." Light enough to read as inactive beside
 * the working blue, dark enough to still show the shape of the audio underneath it. */
const LOCKED_WAVE = 'rgba(120,130,150,.6)';

function drawStrip(canvas, seg, durationMs, opts) {
  observeWave(canvas, () => drawStrip(canvas, seg, durationMs, opts));
  canvas.__peaksGen = peaksGen;      // what this drawing was based on
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  // Scale BOTH axes by devicePixelRatio. The vertical buffer used to stay at CSS pixels, which
  // blurred every wave slightly on retina — and at the gloss tab's half height that blur eats the
  // little amplitude detail there is. CSS fixes the on-screen size; the buffer carries the detail.
  const cssH = canvas.clientHeight || canvas.height || 44;
  canvas.width = w * dpr;
  canvas.height = cssH * dpr;
  const g = canvas.getContext('2d');
  const H = canvas.height, W = canvas.width;
  g.clearRect(0, 0, W, H);
  const peaks = peaksCache.peaks;
  if (!peaks || !isAligned(seg) || !durationMs) {
    // No waveform available (pending segment, undecoded, or no audio): a flat midline says so
    // honestly instead of drawing invented shape.
    g.fillStyle = 'rgba(120,130,150,.45)';
    g.fillRect(0, H / 2 - 1, W, 2);
    return;
  }
  const B = peaks.length;
  // Exact time→bucket mapping (see ensurePeaks): proportional-to-duration drifts toward the end.
  const mpb = peaksCache.msPerBucket || (durationMs / B);
  // A span starting BEYOND the peaks' covered range would stretch the last bucket into a
  // misleading solid bar — draw the honest no-data midline instead (guards timeline mismatches).
  if (seg.start >= B * mpb) {
    g.fillStyle = 'rgba(120,130,150,.45)';
    g.fillRect(0, H / 2 - 1, W, 2);
    return;
  }
  const b0 = Math.min(B - 1, Math.max(0, Math.floor(seg.start / mpb)));
  const b1 = Math.min(B, Math.max(b0 + 1, Math.ceil(seg.end / mpb)));
  g.fillStyle = (opts && opts.color) || '#1f4f8f';
  const n = b1 - b0;
  for (let x = 0; x < W; x++) {
    // MAX over this pixel's whole bucket range, not nearest-neighbour — nearest is what made the
    // strips read blocky/blurry: adjacent pixels sampled the same bucket in steps. Range-max keeps
    // transients (a plosive is one bucket) and draws a crisp column per pixel.
    // Two regimes per pixel column: more buckets than pixels → MAX over the range (transients stay
    // crisp); more pixels than buckets (short segments drawn wide) → LINEAR INTERPOLATION between
    // neighbouring buckets, so a flat-topped block becomes a slope.
    const fpos = (x / W) * n + b0;
    const i0 = Math.floor(fpos);
    const i1 = Math.max(i0 + 1, b0 + Math.ceil(((x + 1) / W) * n));
    let m = 0;
    if (i1 - i0 <= 1) {
      const fr = fpos - i0;
      m = (peaks[i0] || 0) * (1 - fr) + (peaks[Math.min(i0 + 1, b0 + n - 1)] || 0) * fr;
    } else {
      for (let i = i0; i < i1; i++) { const v = peaks[i] || 0; if (v > m) m = v; }
    }
    // Perceptual DISPLAY curve (m^0.6): linear amplitude hides quiet-but-real detail — a stop
    // burst or fricative at -30 dB is a couple of pixels tall in a 44px strip and reads as
    // silence (Seth's report). The power curve lifts low-level signal into visibility while TRUE
    // silence stays flat. Display-only: the cached peaks and the audio are untouched — this is a
    // rendering choice, not processing (see the header: no audio is ever edited).
    const h = Math.max(2, Math.pow(m, 0.6) * (H - 4));
    g.fillRect(x, (H - h) / 2, 1, h);
  }
}

/* ---------------- edits: Enter splits, Backspace/Delete merges ---------------- */

/* The researcher's MASTER switch for this tab (joinSplitBaseline). Unlike `joinKeys`, which gates
 * only the keyboard shortcut, this removes the capability outright — keys AND buttons — which is how
 * a researcher says "segmentation happens on the Cut tab; do not reshape lines while transcribing".
 * Absent means allowed, so an older host that never passes it behaves exactly as before. */
function joinSplitOk() { return !(deps.joinSplit && !deps.joinSplit()); }

/* BREAK LINE i IN TWO: text at `caret`, time at the playhead. The one implementation behind BOTH of
 * this tab's Enter gestures, so they cannot drift apart.
 *
 * @param caret  where to divide the WORDS; null means "at the end", i.e. keep them all on this line
 *               and start the next one empty.
 * @param focusNext whether to put the cursor in the new line's box afterwards.
 *
 * ⚠ THE TEXT COMES FROM THE INPUT, NOT THE MODEL. A transcriber's most recent keystrokes live in the
 * DOM until the next commit, and splitting the model's copy would silently drop them.
 *
 * ⚠ AN OUT-OF-RANGE PLAYHEAD CANNOT WRITE A BOUNDARY — Seth, 2026-08-14: "if the playhead is on a
 * different segment than the currently selected textbox … don't allow a split unless the playhead
 * position is on the current segment". boundaryAtPlayhead already enforces exactly that: a playhead
 * outside this segment (or with no room on both sides) gives the new line a timePending span instead
 * of a time nobody chose. Which is why the WORDS still split there — the caret is the transcriber's
 * own intent and blocking it would make Enter stop working whenever nothing is playing — while the
 * playhead-driven gesture below, which has no such intent behind it, refuses outright. */
function splitLineAt(i, caret, focusNext) {
  const doc = deps.getDoc();
  if (!doc) return false;
  const input = deps.container.querySelectorAll('.seg-text')[i];
  const text = input ? input.value : String(deps.getParagraphs(doc)[i] ?? '');
  const c = caret == null ? text.length : Math.max(0, Math.min(text.length, caret));
  const paras = deps.getParagraphs(doc).slice();
  paras.splice(i, 1, text.slice(0, c), text.slice(c));
  doc.segments = boundaryAtPlayhead(docSegments(doc), i, deps.getPlayer()?.playheadMs?.() ?? null,
                                    { duration: peaksDurationFor(deps) || null });
  deps.setParagraphs(doc, paras);
  deps.persist();
  renderStrips();
  if (focusNext) focusStrip(i + 1, 0);
  return true;
}

/* ENTER WITH FOCUS OUTSIDE THE TEXT BOXES — "listen and chop", on the Baseline tab (Seth,
 * 2026-08-14: "if the segment audio is active, pressing enter splits at the playhead and splits the
 * text at the end of the baseline, rather than wherever the cursor was last").
 *
 * ⚠ IT ACTS ON THE LINE THE PLAYHEAD IS IN, not on a remembered selection — the same rule the Cut
 * tab runs on, and the reason the two tabs cannot disagree about which line Enter meant. When the
 * playhead is in no line at all there is nothing to break and nothing to guess, so it refuses.
 *
 * ⚠ AND IT DOES NOT MOVE FOCUS. Dropping the cursor into the new box would hand the NEXT Enter to
 * the text-box path, which acts on the FOCUSED line — and by then the recording has played on, so
 * the two would be talking about different lines. Leaving focus where it is keeps every Enter of a
 * chopping run on the playhead's own line, which is the whole gesture. */
export function stripSplitAtPlayhead() {
  const doc = deps && deps.getDoc();
  if (!doc || !joinSplitOk()) return false;
  const i = segmentIndexAt(docSegments(doc), deps.getPlayer()?.playheadMs?.());
  if (i < 0) return false;
  /* ⚠ AND IT IS AN UNDO STEP, unlike the text-box Enter beside it — which is not an inconsistency but
   * the reason this one needs it. Typing is what creates undo points on this tab, so a split made
   * while typing is always recoverable by the entry either side of it. A chopping run types NOTHING:
   * a dozen Enters in a row would leave a dozen structural edits with no way back to any of them.
   * Same rule, and the same reason, as the Cut tab's cutHere. */
  if (deps.capture) deps.capture();
  return splitLineAt(i, null, false);
}

function onKey(e, i, input) {
  const doc = deps.getDoc();
  if (e.key === 'Enter') {
    if (!joinSplitOk()) return;
    e.preventDefault();
    splitLineAt(i, input.selectionStart ?? input.value.length, true);
  /* ⚠ RESEARCHER-GATED, DEFAULT OFF (Seth, 2026-08-13): "some users are finding it too easy to
   * accidentally join lines and then they don't want to split them again." When disabled these keys
   * are simply not intercepted — Backspace deletes a character and Delete deletes forward, i.e. what
   * the key normally does — rather than being swallowed, which would read as a broken keyboard.
   *
   * Absent `joinKeys` (an older host that never passed it) means OFF, matching the setting's own
   * default, so the two can never disagree. The ⧉ join buttons are unaffected and remain the
   * reliable route; they call the same mergeAt, so nothing about joining is lost. */
  } else if (e.key === 'Backspace' && (input.selectionStart ?? 0) === 0 && (input.selectionEnd ?? 0) === 0 && i > 0) {
    if (!joinSplitOk()) return;
    if (!(deps.joinKeys && deps.joinKeys())) return;
    e.preventDefault();
    mergeAt(i - 1, i);
  } else if (e.key === 'Delete' && input.selectionStart === input.value.length && input.selectionEnd === input.value.length
             && i < deps.getParagraphs(doc).length - 1) {
    if (!joinSplitOk()) return;
    if (!(deps.joinKeys && deps.joinKeys())) return;
    e.preventDefault();
    mergeAt(i, i + 1, /* caretAtJoin */ true);
  }
}

function mergeAt(a, b, caretAtJoin) {
  const doc = deps.getDoc();
  const paras = deps.getParagraphs(doc).slice();
  // ⚠ Joined lines get a SPACE between them (Seth): without it "…akhir" + "Mulai…" mashes into one
  // orthographic word — data corruption from the transcriber's point of view. The caret lands
  // AFTER the glue space, so a second Backspace removes the space when mashing genuinely is the
  // intent. No glue when either side is empty (silence strips) or a boundary space already exists.
  const left = paras[a] ?? '', right = paras[b] ?? '';
  const glue = left && right && !/\s$/.test(left) && !/^\s/.test(right) ? ' ' : '';
  const joinPos = left.length + glue.length;
  paras.splice(a, 2, left + glue + right);
  doc.segments = mergeSegments(docSegments(doc), a, { duration: peaksCache.durationMs || null });
  deps.setParagraphs(doc, paras);
  deps.persist();
  renderStrips();
  focusStrip(a, caretAtJoin ? joinPos : joinPos);
}

function commitTexts() {
  const doc = deps.getDoc();
  const inputs = deps.container.querySelectorAll('.seg-text');
  deps.setParagraphs(doc, [...inputs].map((el) => el.value));
  deps.persist();
}

function focusStrip(i, caret) {
  const el = deps.container.querySelectorAll('.seg-text')[i];
  if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* noop */ } }
}

/* ---------------- playhead cursor across strips ---------------- */

/* ⚠ THIS LOOP IS NOT ONLY THE PLAYHEAD. It is also the ONLY thing that ever redraws a canvas which
 * was drawn before its peaks existed — fixStaleWave below compares __peaksGen, and nothing else
 * calls it on the baseline strips. So if this loop stops, a strip that rendered during the decode
 * stays blank for as long as the tab is open, and the only cure is leaving and coming back, which
 * runs positionCursor() again.
 *
 * ⚠ AND IT COULD BE KILLED BY A SINGLE EXCEPTION. `rafId = requestAnimationFrame(tick)` used to sit
 * at the END of the body, so anything that threw above it never re-armed the loop — permanently,
 * silently, with no error visible unless a console was open. docSegments(null) does exactly that
 * ("Cannot read properties of null (reading 'segments')", thrown on every run of the segmentation
 * repro when the editor is left), and any future throw in here would do the same.
 * Both halves are fixed: the doc is checked before it is dereferenced, AND the re-arm moved into a
 * `finally` so that no exception, present or future, can ever end the loop. A dropped frame is a
 * dropped frame; a dead ticker is a blank waveform nobody can explain. */
function positionCursor() {
  cancelAnimationFrame(rafId);
  const tick = () => {
    try {
    const doc = deps.getDoc();
    // The editor was left (or the doc closed) between frames — nothing to paint, but keep the loop
    // alive: strips can still be in the DOM, and the next entry re-uses it.
    if (!doc) return;
    const p = deps.getPlayer();
    const t = p?.playheadMs?.();
    const dur = peaksCache.durationMs;
    deps.container.querySelectorAll('.seg-strip').forEach((row, i) => {
      const seg = docSegments(doc)[i];
      fixStaleWave(row.querySelector('.seg-wave'));
      let cur = row.querySelector('.seg-cursor');
      const inSeg = seg && isAligned(seg) && typeof t === 'number' && t >= seg.start && t < seg.end;
      const btn = row.querySelector('.seg-play');
      if (btn && seg && isAligned(seg)) {
        const rolling = p?.playing?.() && inSeg;
        const want = rolling ? '⏸' : '▶';
        if (btn.textContent !== want) {
          btn.textContent = want;
          btn.setAttribute('aria-label', deps.t(rolling ? 'seg.pauseTip' : 'seg.playTip'));
        }
      }
      /* v326 (Seth #9): the playing line is HIGHLIGHTED, and during CONTINUOUS play the view
       * follows it — only on a line CHANGE, only when actually playing, only when the row is out
       * of sight, and never within 4s of the user scrolling (the PAT recipe). Span playback also
       * highlights (it IS the playing line) but never scrolls — the user just clicked it. */
      const rolling = p?.playing?.() && inSeg;
      if (row.classList.contains('seg-on') !== inSeg) row.classList.toggle('seg-on', inSeg);
      if (inSeg) { takeReveal(row); followRow = followLine(row, rolling, followRow, p); }
      if (inSeg) {
        if (!cur) { cur = document.createElement('div'); cur.className = 'seg-cursor'; row.appendChild(cur); }
        const wave = row.querySelector('.seg-wave');
        const frac = (t - seg.start) / (seg.end - seg.start);
        cur.style.left = (wave.offsetLeft + frac * wave.offsetWidth) + 'px';
        cur.style.top = wave.offsetTop + 'px';
        cur.style.height = wave.offsetHeight + 'px';
      } else if (cur) cur.remove();
    });
    } finally {
      // ⚠ ALWAYS re-arm. This is the line whose position is the bug — see the note above.
      rafId = requestAnimationFrame(tick);
    }
  };
  rafId = requestAnimationFrame(tick);
}

export function stopStrips() { cancelAnimationFrame(rafId); }

/* ---------------- gloss-tab decorations (shared machinery, skinnier clothes) ---------------- */

/* Draw one segment's span on any canvas — the gloss tab's mini strips reuse the exact peaks,
 * mapping and perceptual curve of the baseline strips, just shorter. */
export function drawSpanWave(canvas, seg) {
  drawStrip(canvas, seg, peaksCache.durationMs);
}

/* The two halves of "a waveform that STAYS drawn", as one call. drawSpanWave alone paints once and
 * is then at the mercy of two races the Cut and Baseline tabs already lost and fixed: a canvas laid
 * out after the paint (zero width, blank strip) and peaks that finish decoding after it (a
 * plausible-looking wave of the wrong length). Every strip surface needs both, so the pair ships
 * together — the matcher is the third list of waveforms in this suite, and adding it without these
 * would have reproduced the same two bugs a fourth time.
 *
 * Pairs with healSpanWave() below, which the caller's own ticker calls. */
export function attachSpanWave(canvas, seg) {
  observeWave(canvas, () => drawSpanWave(canvas, seg));
  drawSpanWave(canvas, seg);
}

/* Redraw a strip whose buffer no longer matches its box or its peaks. Exported for surfaces outside
 * this module that run their own rAF loop (the segmenter's matcher); the Cut and Baseline tickers
 * call the internal fixStaleWave directly. */
export function healSpanWave(canvas) { fixStaleWave(canvas); }

/* THE RECORDING'S LENGTH, AND WHERE ITS PAUSES ARE — as plain numbers, for a caller that keeps its
 * OWN segment model.
 *
 * cutGuessSplits() cannot serve the matcher: it applies the result to the document through cutDeps
 * and the index-locked model (N spans and N empty paragraphs, 1:1), which is precisely what the
 * matcher exists not to do — its whole point is that audio and text are cut independently and
 * reconciled at the end. What it needs is the boundary TIMES; what it does with them is its own
 * business, and nothing is written to the doc until the user presses Done.
 *
 * Same peaks the waveforms are drawn from, so what it cuts on is what the user can see. */
export function peaksDurationMs() { return peaksCache.durationMs || 0; }
export function guessedBoundaries() {
  const dur = peaksCache.durationMs || 0;
  if (!peaksCache.peaks || !dur) return [];
  return guessCuts(dur);
}

/* CLICK A WAVEFORM TO POSITION THE PLAYHEAD INSIDE ITS SEGMENT; DRAG TO SCRUB (Seth).
 * Position only — play/pause stays whatever it was, so the flow is: click (or drag) to park, then
 * Enter to break there, or ▶ to listen from there.
 *
 * ⚠ SHARED, BECAUSE THE CUT TAB SHIPPED WITHOUT IT. v354–v356 drew Cut-tab strips that looked
 * exactly like the Baseline ones and were dead to the pointer, so the only way to place a cut was
 * the whole-file overview — Seth: "I can't click on individual segment waveforms to position the
 * playhead and make cuts anymore … which isn't precise enough." One helper, used by every strip
 * surface, is what stops the next waveform list from being added without it.
 *
 * An unaligned (timePending) span has no timeline to seek into, so it is wired to nothing at all. */
export function wireWaveSeek(wave, seg, getPlayer, onTarget) {
  if (!isAligned(seg)) return;
  const seekAt = (ev) => {
    const r = wave.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    getPlayer()?.seekMs?.(seg.start + f * (seg.end - seg.start));
  };
  wave.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    try { wave.setPointerCapture(ev.pointerId); } catch { /* capture is drag comfort, not required */ }
    onTarget?.(seg);   // v326: touching a WAVEFORM selects it for Space/rewind
    /* ⚠ PLACING THE PLAYHEAD STOPS PLAYBACK (Seth, 2026-08-13: "if the user clicks on a player at
     * all (to place a playhead) playback should pause … that probably should apply on the baseline
     * and gloss tabs as well"). Before this, a click during playback moved the playhead and the
     * audio immediately ran on from it, so the parked position the user was aiming at — the place
     * they were about to cut — had already slid away by the time they pressed the key. Pausing makes
     * the click mean "here", which is what it looks like it means. */
    getPlayer()?.pause?.();
    seekAt(ev);
    const move = (e2) => seekAt(e2);
    const up = () => { wave.removeEventListener('pointermove', move); wave.removeEventListener('pointerup', up); };
    wave.addEventListener('pointermove', move);
    wave.addEventListener('pointerup', up);
  });
}

/* The strip transport behaviour (toggle pause-in-place, resume-from-playhead, restart near end)
 * as a wire-up any button can adopt — the gloss line buttons must feel IDENTICAL to the baseline
 * ones or the two tabs teach different habits. */
export function wireSegPlay(btn, seg, getPlayer, onTarget) {
  btn.addEventListener('click', () => {
    if (!isAligned(seg)) return;
    onTarget?.(seg);   // v322: Space/⏮ act on the last-used player
    const p = getPlayer();
    if (!p) return;
    const t = p.playheadMs?.();
    if (p.playing?.() && typeof t === 'number' && t >= seg.start && t < seg.end) { p.pause(); return; }
    const from = (typeof t === 'number' && t > seg.start && t < seg.end - 150) ? t : seg.start;
    p.playSpan(from, seg.end, seg.start);   // v332: finishing rewinds to the SEGMENT, not to `from`
  });
}

/* Keep a set of gloss-line buttons' glyphs live (▶/⏸). Light interval, not rAF — glyphs need
 * ~300ms fidelity, and the gloss tab has no moving cursor to justify a frame loop.
 *
 * ⚠ NOTHING CALLS THIS. The gloss tab grew its own rAF loop (startGlossCursor in app.js) when it
 * gained a cursor and follow-scroll, and this was left behind, exported and unused — which is how a
 * "take me to that line" hook added here in v360 reached no user at all. Kept only because deleting
 * an exported function is a separate decision from the fix; do not add behaviour to it. */
let glossTick = 0;
export function startGlossTicker(entries, getPlayer, t) {
  stopGlossTicker();
  glossTick = setInterval(() => {
    document.querySelectorAll('.gseg-wave').forEach(fixStaleWave);
    const p = getPlayer();
    const time = p?.playheadMs?.();
    for (const { btn, seg } of entries) {
      if (!isAligned(seg)) continue;
      const rolling = p?.playing?.() && typeof time === 'number' && time >= seg.start && time < seg.end;
      const want = rolling ? '⏸' : '▶';
      if (btn.textContent !== want) { btn.textContent = want; btn.setAttribute('aria-label', t(rolling ? 'seg.pauseTip' : 'seg.playTip')); }
    }
  }, 300);
}
export function stopGlossTicker() { if (glossTick) { clearInterval(glossTick); glossTick = 0; } }


/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE "POTONG" (CUT) TAB — the Baseline tab with the typing taken out.
 *
 * Seth, 2026-08-13: "I'd like the cut tab to look and work almost identically to the baseline tab,
 * except that text can't be edited or selected and cuts and joins can't be made if there's text …
 * I don't want cut and join buttons on the top player. Instead … a place the user can use for
 * navigation. It shows a playhead and segment boundaries where splits have been made, but they
 * can't be created or edited up there."
 *
 * So the shape is: the SHARED DOCK PLAYER at the top for navigating, wearing dotted marks where the
 * cuts already are, and the real work on the STRIPS — Enter cuts the segment at ITS playhead,
 * Backspace joins it with the one before. Same gestures, same rows, same follow-scroll and
 * highlight as the Baseline tab. The differences are that the text is a caption instead of an
 * input, that a segment carrying text is drawn grey and refuses to be cut, and that this tab has a
 * second, CONTINUOUS transport: Space and the dock's ⏵ run straight through the boundaries
 * (playThrough), while a row's own ▶ still plays just that line, exactly as everywhere else.
 *
 * ⚠ THERE IS ONE WHOLE-FILE WAVEFORM ON THIS SCREEN, AND IT IS THE DOCK PLAYER'S. v354–v356 drew a
 * second one here; Seth: "there's TWO waveform displays at the top of the whole audio file. I don't
 * want that." Two also meant two zoom states and two places to click, which is how the strips'
 * missing click handler went unnoticed. The marks moved onto the player (Player.setBoundaries).
 *
 * ⚠ IT LIVES IN THIS FILE ON PURPOSE. A separate module would be a new top-level import in
 * js/app.js — a new SHELL entry in the editor AND every satellite sw.js in the same commit, which
 * is the v108 outage. Everything the Cut tab draws (peaks, drawStrip, wireSegPlay) is already here.
 *
 * ⚠ AND IT EDITS TEXT DESPITE SHOWING NONE. segments[i] IS baseline paragraph i, so a cut inserts
 * an empty paragraph and a join merges two — both via segments.js, which returns BOTH arrays so
 * half an edit cannot be applied.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

let cutDeps = null;
let cutRaf = 0;
let cutFollowRow = null;
export function initCut(d) { cutDeps = d; }
export function stopCut() {
  if (cutRaf) cancelAnimationFrame(cutRaf);
  cutRaf = 0;
  cutFollowRow = null;
  // The boundary marks belong to THIS tab: leaving takes them off the shared dock player, so the
  // Baseline and Gloss tabs are exactly what they were.
  try { cutDeps?.getPlayer?.()?.setBoundaries?.([]); } catch { /* the player may already be gone */ }
}

function cutSay(msg) {
  const el = document.getElementById('cut-say');
  if (el) el.textContent = msg || '';
}
function cutSegs() { return docSegments(cutDeps.getDoc()); }
/* The segment the playhead is in — Seth: "enter breaks the segment where the segment playhead
 * currently is". The playhead IS the selection on this tab; there is no cursor to disagree with it. */
function cutCurrentIndex() {
  return segmentIndexAt(cutSegs(), cutDeps.getPlayer()?.playheadMs?.());
}
function cutJoinOk() { return !(cutDeps.allowJoinTexted && !cutDeps.allowJoinTexted()); }

/* ── the cuts already made, drawn ON THE ONE PLAYER ────────────────────────────────────────────
 * Seth, 2026-08-13: "there's TWO waveform displays at the top of the whole audio file. I don't want
 * that. I only wanted the top player to add lines representing segment boundaries."
 *
 * So the Cut tab no longer draws a whole-file waveform of its own: it hands the boundary times to
 * the dock player, which marks them inside its own waveform (Player.setBoundaries). The player was
 * always there, above this tab, showing the same audio — the second copy was duplication, and it
 * duplicated the ZOOM and the SEEKING too, which is why there were two places to click.
 *
 * The file's own end is not a boundary, and neither is 0: only the seams BETWEEN spans are marks. */
function cutBoundaryTimes() {
  const segs = cutSegs();
  const marks = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (isAligned(s)) marks.push(s.end);
  }
  return marks;
}
function syncCutBoundaries() {
  const p = cutDeps && cutDeps.getPlayer && cutDeps.getPlayer();
  if (!p || !p.setBoundaries) return;
  p.setBoundaries(cutBoundaryTimes());
}

/* THE LIST IS REBUILT WHOLESALE ON EVERY CUT AND JOIN, and emptying it collapses the page height —
 * at which point the browser clamps the scroll offset to the new maximum, i.e. the top. That is why
 * every cut threw the user back to the beginning of a long recording (Seth: "I definitely don't want
 * that. It should remember and hold its position").
 *
 * So the rebuild is bracketed: remember where the scroller was AND where the row being edited sat on
 * screen, then put the row back under the same pixel. Restoring the raw offset alone would be off by
 * whatever the edit changed above the fold — a caption rewrapping, a row appearing — and "nearly
 * where I was" is still lost when every row looks alike. */
function cutScroller() { return scrollerFor(document.getElementById('cut-strips')); }

export function renderCut(anchorIdx) {
  if (!cutDeps) return;
  const host = document.getElementById('cut-strips');
  const doc = cutDeps.getDoc();
  if (!host || !doc) return;
  const segs = reconcile(doc, cutDeps);   // seeds a fresh recording's whole-file span — see reconcile
  const paras = cutDeps.getParagraphs(doc);
  const scroller = cutScroller();
  const keepTop = scroller ? scroller.scrollTop : 0;
  const anchor = Number.isInteger(anchorIdx) ? host.querySelector(`.cut-row[data-i="${anchorIdx}"]`) : null;
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
  host.replaceChildren();
  cutFollowRow = null;

  segs.forEach((seg, i) => {
    const row = document.createElement('div');
    /* ⚠ .seg-strip IS THE BASELINE ROW CLASS — not .seg-row, which does not exist. Getting this
     * wrong cost the whole layout: no grid (so the wave and caption ignored their columns), no
     * border, and no `position: relative`, which meant the absolutely-positioned .seg-cursor
     * resolved against a distant ancestor and drew ABOVE the waveform instead of on it. Reusing the
     * class is the point — the two tabs must not drift apart. */
    row.className = 'seg-strip cut-row';
    /* Focusable, because this tab has no text box to hold focus and the keys must land somewhere.
     * The row IS the control. */
    row.tabIndex = 0;
    row.dataset.i = String(i);

    const play = document.createElement('button');
    play.className = 'seg-play';
    play.textContent = seg.timePending ? '⋯' : '▶';
    play.setAttribute('aria-label', cutDeps.t(seg.timePending ? 'seg.pendingTip' : 'seg.playTip'));
    const wave = document.createElement('canvas');
    wave.className = 'seg-wave cut-wave';
    row.append(play, wave);

    const text = String(paras[i] ?? '').trim();
    /* ⚠ GREY MEANS LOCKED, AND ONLY LOCKED (Seth, 2026-08-13: "the grayed out part should only be
     * parts that have text assigned and so can't be split … Right now our setup is the opposite").
     * A span carrying text refuses to be cut — there is no cursor on this tab, so there is no
     * defined place to divide its words — so the one thing the colour has to say is "not this one".
     * Drawing every strip in the same working blue said nothing at all. */
    if (text) {
      row.classList.add('cut-locked');
      /* ⚠ A CAPTION, NEVER AN INPUT, and not selectable (CSS) — Seth: "text can't be edited or
       * selected". Its presence is also what makes the cut refusal legible: you can see which
       * segments are transcribed, and therefore locked, before you try. */
      const cap = document.createElement('div');
      cap.className = 'cut-cap';
      cap.textContent = text;
      row.appendChild(cap);
    }
    host.appendChild(row);

    row.addEventListener('pointerdown', () => { if (cutDeps.onPlayTarget) cutDeps.onPlayTarget(seg); });
    /* ⚠ THE SAME click-to-position/drag-to-scrub as the Baseline strips, and the reason the tab
     * works at all: the playhead IS the cursor here, so a strip you cannot click is a cut you
     * cannot place. It was missing from v354–v356. */
    wireWaveSeek(wave, seg, cutDeps.getPlayer, (s) => { if (cutDeps.onPlayTarget) cutDeps.onPlayTarget(s); });
    /* ⚠ THE ROW'S ▶ PLAYS ONLY ITS OWN SPAN — the SAME wiring as the Baseline and Gloss tabs, so
     * "press play on a line" means one thing everywhere in the suite. Play-through belongs to Space
     * and to the dock player's own ⏵ (see cutTogglePlay): a row button that ran past its own end
     * left no way to hear a single span in isolation, which is how you judge whether the span is
     * right. Seth, 2026-08-13, on the cut tab only. */
    wireSegPlay(play, seg, cutDeps.getPlayer, (s) => { if (cutDeps.onPlayTarget) cutDeps.onPlayTarget(s); });
    const paint = { color: text ? LOCKED_WAVE : null };
    observeWave(wave, () => drawStrip(wave, seg, peaksCache.durationMs, paint));
    drawStrip(wave, seg, peaksCache.durationMs, paint);

    // The join control sits BETWEEN the rows it joins, exactly as on the Baseline tab.
    if (i < segs.length - 1) {
      const jr = document.createElement('div');
      jr.className = 'seg-joinrow';
      const j = document.createElement('button');
      j.className = 'gseg-join';
      j.textContent = '⤙⤚';
      j.title = cutDeps.t('seg.joinTip');
      j.setAttribute('aria-label', cutDeps.t('seg.joinTip'));
      j.addEventListener('click', () => cutJoinPrev(i + 1));
      jr.appendChild(j);
      host.appendChild(jr);
    }
  });

  /* The Guess button is dead once the text has words, so it says so by being disabled rather than by
   * refusing on click — the suite's standing rule against controls that look live and do nothing.
   * (cutGuessSplits still refuses, as the backstop.) */
  const guess = document.getElementById('btn-guess-splits');
  const guessLabel = document.getElementById('cut-tools-label');
  if (guess) {
    // GONE, not greyed, over manual work — see guessAllowedHere for the whole rule.
    const allowed = guessAllowedHere(segs, paras, doc);
    guess.hidden = !allowed;
    if (guessLabel) guessLabel.hidden = !allowed;
    if (allowed) {
      const why = guessBlockedBecause(paras, doc);
      guess.disabled = !!why;
      if (guessLabel) guessLabel.classList.toggle('is-off', guess.disabled);
      guess.title = why || cutDeps.t('cut.guessTip');
    }
  }

  syncCutBoundaries();
  /* Put the view back where it was — see cutScroller(). The offset first (correct whenever nothing
   * above the fold changed height), then the anchor row's own pixel, which is correct even when
   * something did. Both reads are after the rebuild, so layout is final. */
  if (scroller) {
    scroller.scrollTop = keepTop;
    if (anchorTop != null) {
      const again = host.querySelector(`.cut-row[data-i="${anchorIdx}"]`);
      if (again) scroller.scrollTop = keepTop + (again.getBoundingClientRect().top - anchorTop);
    }
  }
  startCutTicker();
}

/* One rAF loop: strip cursor, row highlight and follow-scroll. The whole-file playhead is the DOCK
 * PLAYER's own cursor now that the tab has no second waveform — one player, one clock, nothing to
 * drift against. */
function startCutTicker() {
  if (cutRaf) cancelAnimationFrame(cutRaf);
  const tick = () => {
    try {
      const p = cutDeps && cutDeps.getPlayer && cutDeps.getPlayer();
      const t = p?.playheadMs?.();
      const host = document.getElementById('cut-strips');
      if (!host) return;
      const segs = cutSegs();

      /* The marks on the dock player are DOM inside wavesurfer's wrapper, so a reload of the player
       * (a doc switch, a re-attached recording) takes them with it and nothing else would put them
       * back until the next edit. Comparing counts is one property read per frame; re-pushing only
       * when they disagree keeps it to a handful of DOM writes per redraw. */
      if (p && p.boundaryCount && p.durationMs?.()) {   // …once the player knows the length to scale by
        const want = cutBoundaryTimes();
        if (p.boundaryCount() !== want.length) p.setBoundaries(want);
      }

      host.querySelectorAll('.cut-row').forEach((row) => {
        const idx = +row.dataset.i;
        const seg = segs[idx];
        /* ⚠ The LAST segment includes its own end. Every other span uses a half-open range so a
         * playhead on a boundary belongs to the span it is starting — but the final span has no
         * successor, so the strict `< end` left the playhead homeless for the last instant of the
         * recording, and the cursor vanished exactly where a user is most likely to be looking
         * (Seth: "it seems to disappear on the final segment"). */
        const last = idx === segs.length - 1;
        const inSeg = seg && isAligned(seg) && typeof t === 'number'
          && t >= seg.start && (t < seg.end || (last && t <= seg.end));
        const btn = row.querySelector('.seg-play');
        const rolling = p?.playing?.() && inSeg;
        if (btn && seg && isAligned(seg)) {
          const want = rolling ? '⏸' : '▶';
          if (btn.textContent !== want) btn.textContent = want;
        }
        // Same repair the Baseline ticker does: a canvas drawn before its peaks landed (or before
        // the player's own decode upgraded them) is redrawn here, and nowhere else.
        fixStaleWave(row.querySelector('.seg-wave'));
        if (row.classList.contains('seg-on') !== inSeg) row.classList.toggle('seg-on', inSeg);
        // Same follow rule as the Baseline tab: on a line CHANGE, only while playing, only when
        // off screen, and never within 4s of the user scrolling. Plus a pending "take me there"
        // from a seek on the whole-file player — see requestReveal.
        if (inSeg) { takeReveal(row); cutFollowRow = followLine(row, rolling, cutFollowRow, p); }
        let cur = row.querySelector('.seg-cursor');
        let sc = row.querySelector('.cut-scissors');
        if (inSeg) {
          if (!cur) { cur = document.createElement('div'); cur.className = 'seg-cursor'; row.appendChild(cur); }
          const w = row.querySelector('.seg-wave');
          const frac = Math.min(1, Math.max(0, (t - seg.start) / Math.max(1, seg.end - seg.start)));
          const x = w.offsetLeft + frac * w.offsetWidth;
          cur.style.left = x + 'px';
          cur.style.top = w.offsetTop + 'px';
          cur.style.height = w.offsetHeight + 'px';
          /* ✂ RIDES THE PLAYHEAD (Seth: "a scissors button under the playhead that does a split when
           * clicked"). It exists only on the row the playhead is in, and sits exactly under the
           * cursor, so the control and the thing it acts on are the same place on screen — the
           * gesture needs no explanation. A keyboard user has Enter; this is for a thumb. */
          if (!sc) {
            sc = document.createElement('button');
            sc.className = 'cut-scissors';
            sc.type = 'button';
            sc.textContent = '\u2702';
            sc.title = cutDeps.t('cut.cut');
            sc.setAttribute('aria-label', cutDeps.t('cut.cut'));
            sc.addEventListener('click', (ev) => { ev.stopPropagation(); cutHere(); });
            row.appendChild(sc);
          }
          sc.style.left = x + 'px';
          sc.style.top = (w.offsetTop + w.offsetHeight) + 'px';
        } else { if (cur) cur.remove(); if (sc) sc.remove(); }
      });
    } finally {
      cutRaf = requestAnimationFrame(tick);
    }
  };
  cutRaf = requestAnimationFrame(tick);
}

/* ENTER / ✂ — cut the segment holding the playhead, AT the playhead. */
export function cutHere() {
  const doc = cutDeps && cutDeps.getDoc();
  if (!doc) return;
  const ms = cutDeps.getPlayer()?.playheadMs?.();
  const at = cutCurrentIndex();                    // the row to hold still across the rebuild
  const r = cutAtPlayhead(cutSegs(), cutDeps.getParagraphs(doc), ms, { duration: peaksCache.durationMs || null });
  if (!r.ok) { cutSay(cutDeps.t('cut.no.' + r.reason)); return; }
  /* ⚠ A SPAN WATCHER ARMED BEFORE THE CUT NOW DESCRIBES A SPAN THAT NO LONGER EXISTS. playSpan
   * captures its stop time and its rewind-home when the button is pressed, so auditioning a line and
   * then cutting it — the tab's core loop, listen and cut on the fly — would pause playback at the
   * OLD boundary and throw the playhead back to the OLD start, undoing the cut you were listening
   * for. Dropping it lets playback simply run on past the new cut, which is what a person cutting by
   * ear is doing anyway. (cutJoinPrev gets this for free: its seekMs clears the span.) */
  cutDeps.getPlayer()?.clearSpan?.();
  if (cutDeps.capture) cutDeps.capture();
  doc.segments = r.segments;                       // ⚠ BOTH, from the one result
  cutDeps.setParagraphs(doc, r.paragraphs);
  cutDeps.persist();
  cutSay('');
  renderCut(at);
}

/* Space, from the document-level key handler. Toggles the one player from wherever the playhead
 * is — no target, no span, so it runs on through every cut.
 *
 * ⚠ THE TWO TRANSPORTS ON THIS TAB MEAN DIFFERENT THINGS, and that is the point (Seth, 2026-08-13:
 * "if the user clicks a segment play button, play-through behavior shouldn't happen … but spacebar
 * or the big player play button will play through"):
 *
 *   a row's ▶  → THIS LINE, and stop at its end (wireSegPlay → playSpan) — "is this span right?"
 *   Space / ⏵  → run on through the cuts (playThrough) — "does this seam sound right?"
 *
 * One question each, and each has a control. Making the row button play through too collapsed them
 * into one and left no way to hear a single span in isolation. */
export function cutTogglePlay() {
  const p = cutDeps && cutDeps.getPlayer && cutDeps.getPlayer();
  if (!p) return;
  if (p.playing?.()) { p.pause(); return; }
  p.playThrough();
}

/* IS THERE ANY WORK IN THIS DOCUMENT AT ALL — not just baseline text?
 *
 * ⚠ THE BASELINE STRING IS NOT THE ONLY PLACE WORK LIVES. A phrase carries words (each with its own
 * gloss) and a free translation, and the Guess button destroys the paragraph array wholesale. Asking
 * only "is the baseline text empty?" would let a document whose baselines happen to be blank — but
 * which carries glosses or free translations — be re-cut, and those go with it. Import fills the
 * baseline from the words, so the two agree in practice; this is the belt to that braces, on a path
 * where being wrong is unrecoverable. */
function docHasWork(doc) {
  for (const p of (doc && doc.paragraphs) || []) {
    for (const s of p.segments || []) {
      if (String(s.baseline || '').trim()) return true;
      if (String(s.free || '').trim()) return true;
      for (const w of s.words || []) if (String(w.txt || '').trim() || String(w.gls || '').trim()) return true;
    }
  }
  return false;
}

/* ✨ IS VISIBLE ONLY WHILE THERE IS NOTHING TO LOSE (Seth, 2026-08-14: "having that button still
 * active after manual adjustments have been made is WAY too easy for a native speaker who isn't tech
 * savvy to accidentally ruin all the work they put in and then just be confused as to what happened
 * and stuck"). A confirm dialog is not protection for that user — they click through it. So the
 * button exists in exactly two states of the document, and is GONE, not greyed, in every other:
 *
 *   - the untouched whole-file seed (nothing has been divided yet), or
 *   - a guess with nothing manual after it — the segments still match, end for end, the signature
 *     the guess stamped on the doc (re-rolling a pristine guess is harmless: the detector is
 *     deterministic, so it cannot even change anything). Seth: "if they guessed and didn't do
 *     anything else manual it's OK to re-guess."
 *
 * THE SIGNATURE IS THE WHOLE MECHANISM. cutGuessSplits stores the guessed boundary ends on the doc
 * (doc.guessSig); any manual edit — a cut, a join, a set-boundary nudge, on ANY tab — changes
 * doc.segments and breaks the match, with no edit path needing to know this feature exists. That is
 * why it is a comparison and not a flag: a flag would need every current and future edit gesture to
 * remember to set it, and the one that forgot would be the disaster. Undo works unaided too, and it
 * is worth being precise about HOW, because it is NOT via snapshots — docSnap() captures only
 * paragraphs and segments, so the signature simply stays on the doc. Undoing manual edits back to
 * the pristine guess restores segments that MATCH the lingering signature (button returns); undoing
 * past the guess restores the one-segment seed, which is visible by the seed rule regardless of any
 * signature left behind. A stale signature can never wrongly SHOW the button: hand-cuts would have
 * to reproduce the guessed boundaries to the millisecond, end for end, to match it.
 *
 * Typed text also hides it (Seth named "text entry" explicitly); docHasWork is the same test the
 * refusal path uses. The signature is app-internal state: serializeFlextext reads only the fields it
 * knows, so it never reaches a .flextext — an exported-and-reimported text simply starts over. */
function guessAllowedHere(segs, paras, doc) {
  if (paras.some((p) => String(p || '').trim()) || docHasWork(doc)) return false;
  if (segs.length <= 1) return true;                       // the untouched seed
  const sig = doc && doc.guessSig;
  if (!Array.isArray(sig) || sig.length !== segs.length) return false;
  return segs.every((sg, i) => isAligned(sg) && sg.end === sig[i]);
}

/* WHY IS ✨ GREY? Returns the sentence to put in its tooltip, or '' when the button should work.
 *
 * ⚠ THE LAST CASE IS THE ONE SETH ASKED FOR (2026-08-14, on a recording made in a crowded workshop:
 * "If the background noise is too high to make easy splits, then graying out the guess button is
 * fine"). guessSplits refuses to guess when a recording has no usable dynamic range — a wall of room
 * noise gives no honest answer to "where does speech stop?" — and until now that refusal arrived
 * only AFTER a press, as a message. A live button that always answers "no" reads as a broken
 * feature; a grey one with the reason on it reads as an answer, which is what it is.
 *
 * ⚠ THE PROBE IS CACHED PER (document, peaks generation). Running the detector is one pass over
 * ~177000 buckets — cheap once, but renderCut runs on every cut, join, undo and settings push, and
 * this is called from inside it. The peaks are the only input that can change the answer, and
 * peaksGen already counts exactly that.
 *
 * ⚠ THE CONTRACT THAT KEEPS THE CACHE HONEST: peaksGen only ever advances inside ensurePeaks, and
 * every current ensurePeaks call is awaited by a flow that then renders (prepareCutAudio → renderCut,
 * the Baseline entry → renderStrips) — so a bumped generation is always followed by the re-render
 * that re-probes, and the button can never sit stale on screen. If a future caller ever bumps the
 * generation WITHOUT rendering (a background upgrade, say), the ✨ state will lag until the next
 * renderCut — re-render after any such call, or this cache is where the bug will live (v368 audit). */
let guessProbe = { docId: null, gen: -1, cuts: -1 };
function guessBlockedBecause(paras, doc) {
  const T = cutDeps.t;
  if (paras.some((p) => String(p || '').trim()) || docHasWork(doc)) return T('cut.no.guessText');
  const dur = peaksDurationFor(cutDeps);
  if (!peaksCache.peaks || !dur) return T('cut.no.guessAudio');
  if (dur > GUESS_MAX_MS) {
    return T('cut.no.guessLong', { max: Math.round(GUESS_MAX_MS / 60000), mins: Math.ceil(dur / 60000) });
  }
  if (guessProbe.docId !== peaksCache.docId || guessProbe.gen !== peaksGen) {
    guessProbe = { docId: peaksCache.docId, gen: peaksGen, cuts: guessCuts(dur).length };
  }
  return guessProbe.cuts > 0 ? '' : T('cut.no.guessNone');
}
// The one call site's worth of argument assembly, shared so the probe and the press cannot disagree
// about what the detector was asked.
function guessCuts(dur) {
  return guessSplits(peaksCache.peaks, peaksCache.msPerBucket || (dur / peaksCache.peaks.length),
                     { durationMs: dur });
}

/* "GUESS THE LINES" — cut the whole recording at its pauses, in one step, for a text nobody has
 * started yet (Seth: "make default segment breaks for a new text … based on where the audio appears
 * to have pauses in speech").
 *
 * The detection is a pure function in segments.js, measured against synthetic recordings with known
 * pauses (test/guess-splits.test.mjs) — including the village case, a high noise floor, which is
 * what makes a FIXED amplitude threshold useless. It reads the same peaks array the waveforms are
 * drawn from, so what it cuts on is what the user can see.
 *
 * ⚠ THREE GUARDS, because this replaces the whole document's segmentation in one press:
 *   1. a text with WORDS in it is refused outright — guessed spans cannot carry existing text, since
 *      segments[i] IS paragraph i and there is no defensible way to redistribute words across new
 *      spans. (The button is also disabled in that state; this is the backstop.)
 *   2. a text that has already been cut by hand asks first — that work is exactly what this throws
 *      away.
 *   3. ONE undo step covers the lot, so a bad guess is one Ctrl+Z rather than fifty joins.
 */
/* ⚠ ASYNC SINCE THE CONFIRM BECAME AN IN-APP DIALOG. Its one caller is a click handler that
 * ignores the return value, so the promise costs nothing — but the await introduces a gap between
 * asking and acting that a blocking native confirm() did not have, which is why the doc identity is
 * re-checked below before anything is replaced. */
export async function cutGuessSplits() {
  const doc = cutDeps && cutDeps.getDoc();
  if (!doc) return;
  const paras = cutDeps.getParagraphs(doc);
  if (paras.some((p) => String(p || '').trim()) || docHasWork(doc)) { cutSay(cutDeps.t('cut.no.guessText')); return; }
  // The backstop for the visibility rule above — the button is hidden over manual work, but this
  // function must refuse on its own for the keyboard, for scripts, and for docs from older builds.
  if (!guessAllowedHere(cutSegs(), paras, doc)) { cutSay(cutDeps.t('cut.no.guessManual')); return; }
  const dur = peaksDurationFor(cutDeps);   // 0 unless the peaks really are THIS recording's
  if (!peaksCache.peaks || !dur) { cutSay(cutDeps.t('cut.no.guessAudio')); return; }
  /* ⚠ LONG RECORDINGS ARE CUT BY HAND. The detection itself is cheap at any length; what is not is
   * the result — one press on a 40-minute recording is ~650 rows, each a live canvas on a phone, and
   * the memory would run out AFTER the document had already been replaced. Refused up front, with
   * the limit and the actual length, so it is a decision rather than a mystery. */
  if (dur > GUESS_MAX_MS) {
    cutSay(cutDeps.t('cut.no.guessLong', { max: Math.round(GUESS_MAX_MS / 60000), mins: Math.ceil(dur / 60000) }));
    return;
  }
  // Already cut by hand? Ask before replacing it. `> 1` rather than a segmentation-state test: one
  // whole-file span is the seed, i.e. nobody has cut anything yet.
  if (cutSegs().length > 1 && cutDeps.confirmReplace) {
    if (!await cutDeps.confirmReplace()) return;
    /* ⚠ THE DOC MAY HAVE MOVED WHILE THE DIALOG WAS OPEN. A native confirm() froze the whole thread,
     * so "asked" and "acted" were one instant; an in-app dialog does not. The dialog owns the
     * keyboard and covers the screen, so a human cannot switch texts underneath it — but a remote
     * command (a researcher's delete or reassign, arriving on a sync tick) can, and replacing the
     * paragraphs of a document that is no longer the open one would destroy work in a text the
     * transcriber is not even looking at. Cheap to check, catastrophic to skip. */
    if (cutDeps.getDoc() !== doc) return;
  }
  // Same reason as cutHere: a span watcher armed before this describes spans that are about to stop
  // existing, and would pause playback at a boundary that is no longer there.
  cutDeps.getPlayer()?.clearSpan?.();

  const r = applyGuessedSplits(paras, guessCuts(dur), { duration: dur });
  if (!r.ok) { cutSay(cutDeps.t('cut.no.guess' + (r.reason === 'none' ? 'None' : r.reason === 'hasText' ? 'Text' : 'Audio'))); return; }
  if (cutDeps.capture) cutDeps.capture();
  doc.segments = r.segments;                       // ⚠ BOTH, from the one result
  /* The signature that keeps ✨ on screen only while these exact boundaries survive. Undo does NOT
   * erase it (docSnap carries only paragraphs+segments) and does not need to — see guessAllowedHere:
   * the undone doc is back to one seed segment, which is visible by the seed rule. */
  doc.guessSig = r.segments.map((sg) => sg.end);
  cutDeps.setParagraphs(doc, r.paragraphs);
  cutDeps.persist();
  cutSay(cutDeps.t('cut.guessDone', { n: r.segments.length }));
  renderCut();
}

/* BACKSPACE / ⤙⤚ — join segment i with the one before it, then put the playhead where they joined,
 * so judging the join is a matter of pressing play rather than hunting for the seam. */
export function cutJoinPrev(idx) {
  const doc = cutDeps && cutDeps.getDoc();
  if (!doc) return;
  const i = Number.isInteger(idx) ? idx : cutCurrentIndex();
  const r = joinWithPrevious(cutSegs(), cutDeps.getParagraphs(doc), i,
    { allowTexted: cutJoinOk(), duration: peaksCache.durationMs || null });
  if (!r.ok) { cutSay(cutDeps.t('cut.no.' + r.reason)); return; }
  if (cutDeps.capture) cutDeps.capture();
  doc.segments = r.segments;
  cutDeps.setParagraphs(doc, r.paragraphs);
  cutDeps.persist();
  cutSay('');
  if (r.playheadMs != null) cutDeps.getPlayer()?.seekMs?.(r.playheadMs);
  renderCut(Math.max(0, i - 1));   // the surviving row — hold IT still, not the one that is gone
}
