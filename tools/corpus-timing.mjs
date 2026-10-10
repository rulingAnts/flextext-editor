#!/usr/bin/env node
/* THE CORPUS GATE for the time model (plans/time-gaps-and-estimates.md §6.5) — local, read-only.
 *
 *   node tools/corpus-timing.mjs <folder> [--durations d.json] [--baseline <older checkout>]
 *                                [--expect classes.json] [--audio-ms 60000] [--paths]
 *
 * Opens every .flextext under <folder> the way the editor does (parse → normalizePhraseLines →
 * the strips' reconcile, with the recording's length when it is known) and prints COUNTS: how many
 * placed times changed, how many lines were gained, whether two opens agree, the class of each text,
 * the estimate lines, the red banners, and what an untouched export changes against an older engine.
 *
 * ⚠ IT PRINTS NO TEXT. The corpus is real language data from real people; the counts are all a gate
 * needs, and a log is easy to paste somewhere public. `--paths` adds the relative path of each file
 * an ANOMALY names, for the person running it on their own machine — never in CI, never committed.
 *
 * ⚠ IT WRITES NOTHING. Files are read once each; every check runs on the parsed copy. The folder is
 * usually a cloud-synced one, and a gate that touched it would be the bug it exists to catch.
 *
 * --durations  JSON of the recordings' lengths: { "<path relative to folder>": ms } or the v713
 *              audit's shape { "<path>": [{ "dur": seconds }] }. A timed text without one opens as
 *              if its audio had not decoded yet.
 * --baseline   the root of an older checkout (e.g. a v714 worktree). Its engine opens and exports the
 *              same files; the two exports are diffed line by line and every difference must be one of
 *              the expected kinds (a `~` restored on an audio note, the time-estimates instruction).
 * --audio-ms   untimed texts are opened twice: without audio (nothing may change) and as if a
 *              recording of this length had decoded (default 60 000 ms). Since v718 that second open
 *              must draw every line evenly as a placeholder (or, past 400 ms a line, leave them all ⋯),
 *              write nothing but a one-line text's whole-file span (D7), and export exactly what the
 *              open without audio exports — no offsets. With --baseline, the older engine's stored
 *              seed is also handed to this one (on a device decoding 70 ms longer) and must come back
 *              untimed: `untimed.v714Seeds.missed` 0, nothing exported as times — and so must the same
 *              seed after one v714 correction each (a drag, a cut, a join, a clamp — made with the
 *              baseline's own functions): `v714Seeds.corrected` missed, placedLost and both export
 *              counts 0, only the corrected lines keeping a time (v718 review).
 * --expect     { "<path>": "a"|"b"|"d"|"e-full"|"e-partial"|"f" } from the planning audit; the
 *              classes found here are checked against it file by file.
 *
 * GAPS (v719, `gaps`): every pause of 350 ms or more between two PLACED lines, before the first or
 * after the last. `byFile` gives the per-text counts the plan names; `addAllKeepsTimes` must equal
 * `texts` and `addAllBroken` must be 0 — adding a line in every gap may never move an existing time.
 * `addedOnOpen` must be 0: the rows are a view, and opening still writes nothing.
 *
 * PARTLY TIMED (v718, `partly`): the corpus has no partly timed text of its own, so every timed text is
 * also opened as one — its lines 2, 3, 8, 9, 14, 15… (k % 6 of 2 or 3) made untimed by our own export,
 * as a line typed while segmentation was off would be — at its recording's length (or, without one, its
 * last time). Each untimed line must sit in its own room, the room shared evenly (or all ⋯ when it is
 * under 400 ms a line); no timed line may move; nothing may be written, stored or exported as a time;
 * and the banner must be amber exactly while the untimed lines are at most half the text.
 *
 * Runs the engine under node with test/lib's minimal XML DOM, and lifts normalizePhraseLines and
 * reconcile out of the DOM modules' source (test/lib/lift.mjs) — the same code the app runs. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMiniXmlDom } from '../test/lib/mini-xml-dom.mjs';
import { liftDecl } from '../test/lib/lift.mjs';

const VALUED = new Set(['--durations', '--baseline', '--expect', '--audio-ms']);
const args = { positional: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (VALUED.has(a)) args[a] = process.argv[++i];
  else if (a.startsWith('--')) args[a] = true;
  else args.positional.push(a);
}
const opt = (name) => args[name] ?? null;
const FOLDER = args.positional[0];
if (!FOLDER) { console.error('usage: node tools/corpus-timing.mjs <folder> [--durations d.json] [--baseline dir] [--expect c.json] [--audio-ms N] [--paths]'); process.exit(2); }
const SHOW_PATHS = !!opt('--paths');
const AUDIO_MS = Number(opt('--audio-ms') || 60000);
const readJson = (p) => (p ? JSON.parse(readFileSync(p, 'utf8')) : null);
const DUR = Object.fromEntries(Object.entries(readJson(opt('--durations')) || {}).map(([k, v]) => {
  const ms = Array.isArray(v) ? (v.find((a) => a && a.dur > 0) || {}).dur * 1000 : Number(v);
  return [k, ms > 0 ? Math.round(ms) : 0];
}));
const EXPECT = readJson(opt('--expect'));

installMiniXmlDom();
/* Deterministic guids, so two engines (or two opens) that mint the same guids in the same order
 * produce byte-comparable exports. Reset before every open. */
let guidN = 0;
const realCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: {
  getRandomValues: realCrypto.getRandomValues.bind(realCrypto), subtle: realCrypto.subtle,
  randomUUID: () => `00000000-0000-4000-8000-${String(++guidN).padStart(12, '0')}`,
} });

const SETTINGS = { vernLang: 'fau', analLang: 'id' };
const has = (src, name) => new RegExp(`\\n(?:export )?(?:const|let|function) ${name}\\b`).test(src);

/** One engine (this checkout, or --baseline): open a file, export a doc. */
async function loadEngine(root) {
  const js = (f) => pathToFileURL(join(root, 'docs/js', f)).href;
  const ft = await import(js('flextext.js'));
  const SEG = await import(js('segments.js'));
  const SS = await import(js('segment-strips.js'));
  const APP = readFileSync(join(root, 'docs/js/app.js'), 'utf8');
  const STRIPS = readFileSync(join(root, 'docs/js/segment-strips.js'), 'utf8');
  const normalize = new Function('ft', `const { segmentsFromOffsets, makeSegment, newGuid } = ft;
    ${liftDecl(APP, 'normalizePhraseLines')}; return normalizePhraseLines;`)(ft);
  /* What every tab runs before it draws: since v718 the exported prepareDisplaySpans, which takes the
   * recording's length outright; before it, reconcile, lifted from the source with a stand-in cache. */
  let draw = SS.prepareDisplaySpans ? (doc, deps, D) => SS.prepareDisplaySpans(doc, { ...deps, durationMs: D }) : null;
  if (!draw) {
    const lifted = ['COVER_TOL_MS', 'evenSpread', 'coverTail', 'reconcile'].filter((n) => has(STRIPS, n));
    let D0 = 0;
    const reconcile = new Function('SEG', 'ft', 'SS', 'getD', `
      const { syncToLines, isAligned } = SEG;
      const settleSpan = SEG.settleSpan || ((s) => s);
      const readLegacyEstimates = ft.readLegacyEstimates || (() => {});
      const docSegments = SS.docSegments;
      const peaksDurationFor = () => getD();
      const deps = null;
      ${lifted.map((n) => liftDecl(STRIPS, n)).join('\n')}
      return reconcile;`)(SEG, ft, SS, () => D0);
    draw = (doc, deps, D) => { D0 = D || 0; try { return reconcile(doc, deps); } finally { D0 = 0; } };
  }
  return {
    ft, SEG, SS,
    /** What the Cut, Baseline and Gloss tabs run on every draw — counting the writes it asks for. */
    render(doc, durationMs) {
      const writes = { stamped: 0, quiet: 0 };
      draw(doc, { getParagraphs: (d) => ft.getBaselineParagraphs(d), getDocId: () => 'doc',
        persist: () => { writes.stamped++; }, persistQuiet: () => { writes.quiet++; } }, durationMs || 0);
      return writes;
    },
    /** parse + normalize (+ render), as the editor opens a file. */
    open(xml, { durationMs = 0, render = true } = {}) {
      guidN = 0;
      const { texts, error } = ft.parseFlextext(xml, SETTINGS);
      if (error || !texts || !texts.length) throw new Error('parse');
      const doc = texts[0];
      const fileLines = doc.paragraphs.reduce((n, p) => n + Math.max(1, (p.segments || []).length), 0);
      normalize(doc);
      const fileEstimates = (doc.segments || []).filter((s) => (SEG.isEstimate ? SEG.isEstimate(s) : !!s.timeEstimated)).length;
      const writes = render ? this.render(doc, durationMs) : { stamped: 0, quiet: 0 };
      return { doc, fileLines, fileEstimates, writes };
    },
    exportXml(doc, segTimes = true) {
      guidN = 100000;   // export-time guids (if any) must not collide with the open's
      return ft.serializeFlextext(doc, SETTINGS, { segTimes, timeNotes: true, producedBy: 'corpus-gate' });
    },
  };
}

const HERE = resolve(new URL('..', import.meta.url).pathname);
const NEW = await loadEngine(HERE);
const OLD = opt('--baseline') ? await loadEngine(resolve(opt('--baseline'))) : null;
const { isAligned, isEstimate, edgeGuessed, timingReport } = NEW.SEG;
/* v718: an untimed line is drawn as a PLACEHOLDER (display only). Placed = a time somebody has. Older
 * engines have no placeholders, so there every aligned span is placed. */
const V718 = typeof NEW.SEG.storableSegments === 'function';
const V719 = typeof NEW.SEG.gapRowsFor === 'function';   // the gap rows (plans §4 v719, §6.5)
const isPlaceholder = NEW.SEG.isPlaceholder || (() => false);
const isPlaced = NEW.SEG.isPlaced || isAligned;
const storable = NEW.SEG.storableSegments || ((x) => x);
const OFFSET = /begin-time-offset=/;

/* What a line's time IS, for comparing two opens: its values, and which edges are guesses. */
const state = (segs) => JSON.stringify((segs || []).map((s) => (isAligned(s)
  ? [s.start, s.end, edgeGuessed(s, 0) ? 1 : 0, edgeGuessed(s, 1) ? 1 : 0] : ['-'])));
const fileOffsets = (doc) => doc.paragraphs.map((p) => {
  const a = ((p.segments || [])[0] || {}).attrs || {};
  const b = a['begin-time-offset'], e = a['end-time-offset'];
  return b != null && e != null && /^-?\d+$/.test(b) && /^-?\d+$/.test(e) ? [+b, +e] : null;
});

/* The diff of an untouched export against the baseline engine's. Expected kinds only. */
const PI_LINE = /^\s*<\?flextext-editor v="2" time-estimates="[^"]*"\?>$/;
function exportDiff(oldXml, newXml) {
  // The instruction is compared as a line of its own on both sides (a v717+ baseline writes one too).
  const oAll = oldXml.split('\n'), nAll = newXml.split('\n');
  const o = oAll.filter((l) => !PI_LINE.test(l)), n = nAll.filter((l) => !PI_LINE.test(l));
  const oPi = oAll.filter((l) => PI_LINE.test(l));
  const out = { pi: nAll.filter((l) => PI_LINE.test(l) && !oPi.includes(l)).length, tilde: 0, other: 0 };
  if (o.length !== n.length) { out.other += Math.abs(o.length - n.length) || 1; return out; }
  for (let k = 0; k < o.length; k++) {
    if (o[k] === n[k]) continue;
    if (o[k].replace('>audio ', '>audio ~') === n[k]) out.tilde++;
    else out.other++;
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.toLowerCase().endsWith('.flextext')) out.push(p);
  }
  return out;
}

const ROOT = resolve(FOLDER);
const files = walk(ROOT);
const T = {
  files: files.length, unreadable: 0, timed: 0, withAudio: 0,
  timeChanges: 0, lostTimes: 0, linesGained: 0, stampedWrites: 0, quietWrites: 0,
  opensDiffer: 0, rerenderChanges: 0, roundTripDiffer: 0,
  classes: { contiguous: 0, gaps: 0, 'est-full': 0, 'est-partial': 0, damaged: 0, untimed: 0 },
  estimateLines: 0, estimateFiles: 0, estBySource: {}, red: 0, redKinds: {}, amber: 0,
  vsBaseline: OLD ? { identical: 0, tildeRestored: 0, piLines: 0, piFiles: 0, other: 0, otherFiles: 0,
    classicOther: 0, untimedSeeded: V718 ? null : { files: 0, piLines: 0, quietWrites: 0, other: 0 } } : null,
  expectMismatch: EXPECT ? 0 : null,
  /* v719 (plans §4 v719, §6.5): the unassigned-audio rows. `rows` is the total across the corpus;
   * `byFile` names the texts that have any, so the plan's per-text counts can be read off directly
   * (ELAN40 39, ELAN52 51, ELAN43 33, each damaged L29 1, everything else 0). `addAllKeepsTimes` is
   * the safety claim: adding a line in every gap must leave every ORIGINAL line's time untouched. */
  gaps: V719 ? { texts: 0, rows: 0, lead: 0, interior: 0, tail: 0, withSpeech: 0, byFile: {},
    addAllKeepsTimes: 0, addAllBroken: 0, addedOnOpen: 0, blockedByRed: 0 } : null,
  /* v718 (plans §4 v718, §6.5): untimed lines are drawn in their gap and never stored or exported. */
  untimed: V718 ? { partlyTexts: 0, placeholders: 0, noRoom: 0, storedPlaceholders: 0,
    openedWithAudio: 0, spread: 0, noRoomTexts: 0, oneLine: 0, quietWrites: 0, exportedWithOffsets: 0,
    infoBanner: 0, lineMarks: 0,
    v714Seeds: OLD ? { files: 0, lines: 0, missed: 0, exportedWithOffsets: 0, exportedUnopened: 0,
      corrected: { files: 0, texts: 0, lines: 0, missed: 0, placedLost: 0, exportWrong: 0, unopenedWrong: 0, short: 0 } } : null,
    partly: { files: 0, lines: 0, placeholders: 0, noRoom: 0, amber: 0, info: 0, placedChanged: 0,
      edgesChanged: 0, outsideRoom: 0, storedTimes: 0, exportedTimes: 0, exportChanged: 0, writes: 0,
      levelWrong: 0, opensDiffer: 0, rerenderChanges: 0 } } : null,
};
const flagged = {};
const flag = (what, rel) => { (flagged[what] = flagged[what] || []).push(rel); };
const LETTER = { contiguous: 'a', gaps: 'b', untimed: 'd', 'est-full': 'e-full', 'est-partial': 'e-partial', damaged: 'f' };

for (const path of files) {
  const rel = relative(ROOT, path);
  let xml;
  try { xml = readFileSync(path, 'utf8'); } catch { T.unreadable++; flag('unreadable', rel); continue; }
  let A, B;
  const D = DUR[rel] || 0;
  try { A = NEW.open(xml, { durationMs: D }); B = NEW.open(xml, { durationMs: D }); }
  catch { T.unreadable++; flag('unreadable', rel); continue; }
  const offs = fileOffsets(A.doc);
  const timed = offs.some(Boolean);
  if (timed) T.timed++;
  if (D) T.withAudio++;

  // P1 — opening changes no placed time, adds no line, stamps nothing; two opens agree.
  let changed = 0, lost = 0;
  offs.forEach((o, k) => {
    if (!o) return;
    const s = A.doc.segments[k];
    if (!isPlaced(s)) lost++;
    else if (s.start !== o[0] || s.end !== o[1]) changed++;
  });
  T.timeChanges += changed; T.lostTimes += lost;
  if (changed || lost) flag('time changed on open', rel);
  const gained = A.doc.paragraphs.length - A.fileLines;
  if (gained > 0) { T.linesGained += gained; flag('lines gained', rel); }
  if (A.doc.segments.length !== A.doc.paragraphs.length) flag('spans and lines differ in number', rel);
  T.stampedWrites += A.writes.stamped; T.quietWrites += A.writes.quiet;
  if (A.writes.stamped) flag('stamped write on open', rel);
  if (state(A.doc.segments) !== state(B.doc.segments)) { T.opensDiffer++; flag('two opens differ', rel); }
  // Every draw of the tab runs reconcile again on the stored doc: it must change and save nothing.
  const before = state(A.doc.segments);
  const again = NEW.render(A.doc, D);
  if (state(A.doc.segments) !== before || again.stamped || again.quiet) { T.rerenderChanges++; flag('a second render changed or saved', rel); }
  // P4 — an untouched export, re-imported, gives back the same times and the same guessed edges.
  const R = NEW.open(NEW.exportXml(A.doc), { durationMs: D });
  if (state(R.doc.segments) !== before) { T.roundTripDiffer++; flag('export → import differs', rel); }

  // Classes, estimates and the banner — for the texts that carry times in the file.
  const texts = NEW.ft.getBaselineParagraphs(A.doc);
  const rep = timingReport(A.doc.segments, texts, { durationMs: D || undefined });
  // v718: what is drawn is never what is stored — and an untimed line is a placeholder, or ⋯ with no room.
  if (V718) {
    const U = T.untimed;
    U.storedPlaceholders += storable(A.doc.segments).filter((x) => x && ('phAt' in x || 'noRoom' in x || isPlaceholder(x))).length;
    const ph = A.doc.segments.filter(isPlaceholder).length, cramped = A.doc.segments.filter((x) => x && x.noRoom).length;
    if (timed && (ph || cramped)) { U.partlyTexts++; U.placeholders += ph; U.noRoom += cramped; flag('partly timed (v718: needs timing)', rel); }
    if (U.storedPlaceholders) flag('a placeholder in the storable form', rel);
  }

  /* v719 — THE GAP ROWS. Measured on the spans the editor DREW (A.doc.segments), because that is what
   * the rows are built from. Two claims are checked per text:
   *   · opening added no line and changed no time (already counted above as linesGained/timeChanges);
   *   · "Add a line for every gap" would leave every original line's time exactly as it is — simulated
   *     here with the same back-to-front splice addAllGapLines uses, so an off-by-one would show up as
   *     addAllBroken rather than as a silent corpus-wide shift. */
  if (V719 && D) {
    const G = T.gaps;
    const rows = NEW.SEG.gapRowsFor(A.doc.segments, D);
    if (rows.length) {
      const n = A.doc.segments.length;
      G.texts++; G.rows += rows.length;
      G.lead += rows.filter((g) => g.k === 0).length;
      G.tail += rows.filter((g) => g.k === n).length;
      G.interior += rows.filter((g) => g.k > 0 && g.k < n).length;
      G.byFile[rel] = rows.length;
      // the red banner hides Add (case 16) — count the texts where that is what a user would meet
      if (rep.level === 'red') { G.blockedByRed++; flag('v719: gap rows behind a red banner (Add hidden)', rel); }
      const was = A.doc.segments.map((x) => (isPlaced(x) ? [x.start, x.end] : null));
      const after = A.doc.segments.map((x) => ({ ...x }));
      for (let i = rows.length - 1; i >= 0; i--) after.splice(rows[i].k, 0, { start: rows[i].start, end: rows[i].end });
      const kept = [];
      let j = 0;
      for (const w of was) { while (j < after.length && !(after[j].start === (w && w[0]) && after[j].end === (w && w[1]))) j++; kept.push(j < after.length); j++; }
      if (after.length === n + rows.length && kept.every(Boolean)) G.addAllKeepsTimes++;
      else { G.addAllBroken++; flag('v719: Add all would move an existing time', rel); }
    }
    if (A.doc.segments.length !== A.doc.paragraphs.length) { G.addedOnOpen++; flag('v719: opening changed the line count', rel); }
  }
  let cls = 'untimed';
  if (timed) {
    const n = A.doc.segments.length;
    const est = A.doc.segments.filter((x) => isEstimate(x) && !isPlaceholder(x)).length;
    if (rep.level === 'red') cls = 'damaged';
    else if (est && est === n) cls = 'est-full';
    else if (est) cls = 'est-partial';
    else {
      const s = A.doc.segments;
      const gap = s.some((x, k) => k > 0 && isPlaced(x) && isPlaced(s[k - 1]) && x.start - s[k - 1].end > 1)
        || (isPlaced(s[0]) && s[0].start > 1);
      cls = gap ? 'gaps' : 'contiguous';
    }
    if (est) {
      T.estimateLines += est; T.estimateFiles++;
      for (const s of A.doc.segments) if (isEstimate(s) && !isPlaceholder(s)) T.estBySource[s.estSource || 'edit'] = (T.estBySource[s.estSource || 'edit'] || 0) + 1;
    }
    if (est !== A.fileEstimates) flag('estimates changed by the render', rel);
  }
  T.classes[cls]++;
  if (rep.level === 'red') { T.red++; for (const it of rep.items) if (it.level === 'red') T.redKinds[it.kind] = (T.redKinds[it.kind] || 0) + 1; flag('red', rel); }
  if (rep.level === 'amber') { T.amber++; flag('amber', rel); }
  if (EXPECT && EXPECT[rel] != null && EXPECT[rel] !== LETTER[cls]) { T.expectMismatch++; flag(`class ${cls}, expected ${EXPECT[rel]}`, rel); }

  /* v718 — PARTLY TIMED (B2, D3): this timed text with every k % 6 of 2 or 3 line made untimed. See the
   * header. The untimed lines are made by our own export (no offsets, no note), as the editor writes a
   * line with no time, and the copy is then opened as a file. */
  if (V718 && timed) {
    const P0 = NEW.open(xml, { render: false });
    const n = P0.doc.paragraphs.length;
    const strip = [];
    for (let k = 0; k < n; k++) if (k % 6 >= 2 && k % 6 <= 3 && isPlaced(P0.doc.segments[k])) strip.push(k);
    if (strip.length) {
      const PU = T.untimed.partly;
      PU.files++; PU.lines += strip.length;
      const cut = JSON.parse(JSON.stringify(P0.doc));
      for (const k of strip) {
        cut.segments[k] = { timePending: true };
        for (const ph of cut.paragraphs[k].segments || []) {
          if (ph.attrs) { delete ph.attrs['begin-time-offset']; delete ph.attrs['end-time-offset']; }
          if (Array.isArray(ph.postItemsXML)) ph.postItemsXML = ph.postItemsXML.filter((x) => !/type="note"[^>]*>audio ~?\d+:\d\d\.\d{3}/.test(x));
        }
      }
      const xmlP = NEW.exportXml(cut);
      const placedEnds = P0.doc.segments.filter(isPlaced).map((x) => x.end);
      const Dp = D || Math.max(...placedEnds);
      const P = NEW.open(xmlP, { durationMs: Dp }), P2 = NEW.open(xmlP, { durationMs: Dp });
      const segs = P.doc.segments;
      if (state(segs) !== state(P2.doc.segments)) { PU.opensDiffer++; flag('partly: two opens differ', rel); }
      PU.writes += P.writes.stamped + P.writes.quiet;
      if (P.writes.stamped || P.writes.quiet) flag('partly: a write on open', rel);
      // No timed line moves (values), and none changes which of its edges are guesses.
      const stripped = new Set(strip);
      P0.doc.segments.forEach((o, k) => {
        if (stripped.has(k) || !isPlaced(o)) return;
        const s = segs[k];
        if (!isPlaced(s) || s.start !== o.start || s.end !== o.end) { PU.placedChanged++; flag('partly: a timed line moved', rel); }
        else if (edgeGuessed(s, 0) !== edgeGuessed(o, 0) || edgeGuessed(s, 1) !== edgeGuessed(o, 1)) { PU.edgesChanged++; flag('partly: a timed line changed its guessed edges', rel); }
      });
      for (const k of strip) { if (isPlaceholder(segs[k])) PU.placeholders++; else if (segs[k] && segs[k].timePending && segs[k].noRoom) PU.noRoom++; }
      // Every run of untimed lines: inside its room, shared evenly and edge to edge — or all ⋯.
      const minMs = NEW.SEG.SPREAD_MIN_MS || 400;
      for (let k = 0; k < segs.length;) {
        if (isPlaced(segs[k]) && !isPlaceholder(segs[k])) { k++; continue; }
        let j = k;
        while (j + 1 < segs.length && !(isPlaced(segs[j + 1]) && !isPlaceholder(segs[j + 1]))) j++;
        const lo = k > 0 ? segs[k - 1].end : 0, hi = j < segs.length - 1 ? segs[j + 1].start : Dp;
        const members = [];
        for (let q = k; q <= j; q++) if (!Array.isArray(segs[q].fileTimes)) members.push(segs[q]);
        const m = members.length, fits = m > 0 && hi - lo >= m * minMs;
        const ok = fits
          ? members.every((x, q) => isPlaceholder(x) && x.start >= lo && x.end <= hi
              && Math.abs(x.end - x.start - (hi - lo) / m) <= 1 && (q === 0 ? x.start === Math.round(lo) : x.start === members[q - 1].end))
            && members[m - 1].end === Math.round(hi)
          : members.every((x) => x.timePending && x.noRoom);
        if (!ok) { PU.outsideRoom++; flag('partly: an untimed run not shared evenly within its room', rel); }
        k = j + 1;
      }
      // Stored: the untimed lines as { timePending } only. Exported: no offsets on them, the rest unchanged.
      const st = storable(segs);
      for (const k of strip) if (!st[k] || !st[k].timePending || 'start' in st[k] || 'phAt' in st[k] || 'noRoom' in st[k]) { PU.storedTimes++; flag('partly: an untimed line stored with a time', rel); }
      const E = NEW.open(NEW.exportXml(P.doc), { render: false });
      const eo = fileOffsets(E.doc), po = fileOffsets(P0.doc);
      eo.forEach((o, k) => {
        if (stripped.has(k)) { if (o) { PU.exportedTimes++; flag('partly: an untimed line exported with times', rel); } }
        else if (JSON.stringify(o) !== JSON.stringify(po[k])) { PU.exportChanged++; flag('partly: a timed line exported differently', rel); }
      });
      // The banner: amber ('partly', "needs timing" on the lines) exactly while the untimed lines are at most half.
      const u = segs.filter((x) => !(isPlaced(x) && !isPlaceholder(x))).length;
      const pr = timingReport(segs, NEW.ft.getBaselineParagraphs(P.doc), { durationMs: Dp });
      const pi = pr.items.find((it) => it.kind === 'partly');
      const amber = 2 * u <= segs.length;
      if (amber) PU.amber++; else PU.info++;
      if (!pi || pi.level !== (amber ? 'amber' : 'info') || NEW.SS.needsMarks(segs) !== amber) { PU.levelWrong++; flag('partly: banner level or line marks wrong', rel); }
      const before = state(segs), again = NEW.render(P.doc, Dp);
      if (state(P.doc.segments) !== before || again.stamped || again.quiet) { PU.rerenderChanges++; flag('partly: a second render changed or saved', rel); }
    }
  }

  /* v718 — an untimed text opened as if its recording had decoded: drawn evenly (D4), nothing written
   * but D7's one-line span, and an export with no offsets at all (the export of the same text with no
   * audio, byte for byte). */
  if (V718 && !timed && !D) {
    const U = T.untimed;
    const S = NEW.open(xml, { durationMs: AUDIO_MS });
    U.openedWithAudio++;
    U.quietWrites += S.writes.quiet;
    if (S.writes.stamped) { T.stampedWrites += S.writes.stamped; flag('stamped write on an untimed open', rel); }
    if (S.doc.paragraphs.length === 1) U.oneLine++;   // D7: its whole-file span is real, and written quietly
    else {
      if (S.writes.quiet) flag('an untimed open wrote something', rel);
      // 400 ms a line or no spread at all (D3): a long text against --audio-ms may simply not fit.
      const fits = S.doc.paragraphs.length * (NEW.SEG.SPREAD_MIN_MS || 400) <= AUDIO_MS;
      if (fits ? S.doc.segments.every(isPlaceholder) : S.doc.segments.every((x) => x.timePending && x.noRoom)) U[fits ? 'spread' : 'noRoomTexts']++;
      else flag('untimed text not spread evenly', rel);
      // P6: ONE quiet banner for the text ("No audio times yet…") and no mark on any line.
      const sr = timingReport(S.doc.segments, NEW.ft.getBaselineParagraphs(S.doc), { durationMs: AUDIO_MS });
      if (sr.items.length === 1 && sr.items[0].kind === 'noTimes' && sr.level === 'info' && sr.items[0].spread === fits) U.infoBanner++;
      else flag('untimed text: not exactly one info banner', rel);
      if (NEW.SS.needsMarks(S.doc.segments) || S.doc.segments.some((x, k) => NEW.SS.timeStateClass(x, false, false).trim()
        !== (fits ? 'seg-spread' : 'seg-pending'))) { U.lineMarks++; flag('untimed text: a line is marked', rel); }
      if (OFFSET.test(NEW.exportXml(S.doc)) || NEW.exportXml(S.doc) !== NEW.exportXml(A.doc)) {
        U.exportedWithOffsets++; flag('untimed export carries times', rel);
      }
    }
  }

  // An untouched export against the baseline engine's.
  if (OLD) {
    const V = T.vsBaseline;
    let O;
    try { O = OLD.open(xml, { durationMs: D }); } catch { V.other++; V.otherFiles++; flag('baseline cannot open', rel); continue; }
    const d = exportDiff(OLD.exportXml(O.doc), NEW.exportXml(A.doc));
    if (!d.pi && !d.tilde && !d.other) V.identical++;
    V.tildeRestored += d.tilde; V.piLines += d.pi; if (d.pi) V.piFiles++;
    if (d.other) { V.other += d.other; V.otherFiles++; flag('unexpected export difference', rel); }
    // Classic mode (segmentation off): the export must be byte-identical.
    const C0 = OLD.open(xml, { render: false }), C1 = NEW.open(xml, { render: false });
    if (OLD.exportXml(C0.doc, false) !== NEW.exportXml(C1.doc, false)) { V.classicOther++; flag('classic export differs', rel); }
    /* v718: a text v714 (or v717) opened with its recording and STORED with the even spread — recognised as
     * a seed (segments.js seedsToPending) on a device that decodes 70 ms longer (BM6), drawn untimed again,
     * and exported with no times at all. */
    if (V718 && !timed && !D) {
      const So = OLD.open(xml, { durationMs: AUDIO_MS });
      const stored = JSON.parse(JSON.stringify(So.doc));   // what v714 left in IndexedDB
      if (stored.paragraphs.length > 1 && (stored.segments || []).some(isAligned)) {
        const S7 = T.untimed.v714Seeds;
        // exported straight from the list, never drawn again (auto-backup, a send from the list)
        if (OFFSET.test(NEW.exportXml(JSON.parse(JSON.stringify(stored))))) { S7.exportedUnopened++; flag('a stored v714 seed exported unopened as times', rel); }
        NEW.render(stored, AUDIO_MS + 70);
        S7.files++; S7.lines += stored.segments.length;
        const missed = stored.segments.filter(isPlaced).length;
        S7.missed += missed;
        if (missed) flag('a v714 seed not recognised', rel);
        if (OFFSET.test(NEW.exportXml(stored))) { S7.exportedWithOffsets++; flag('a v714 seed exported as times', rel); }
        /* …and the same seed after the corrections v714 itself offered (v718 review): one seam dragged, a ✂
         * at the playhead, a join, the last end clamped to a decode 70 ms short — made with the BASELINE's
         * own functions, so the shapes are exactly the ones it stored (a flag deleted from the line after a
         * placed seam, kept on everything else). Only the drag's two lines and the cut's two pieces may keep
         * a time; every other seed line must come back untimed, opened or not. Flag-only seeds (v714–v716)
         * only: v717's per-edge seed is recognised whole, by design. A two-line text has no seed line left
         * to recognise but the corrected ones (`short`). */
        const seed = JSON.parse(JSON.stringify(So.doc));
        const flagOnly = seed.segments.every((x) => !Array.isArray(x.guess)) && seed.segments.some((x) => x.timeEstimated);
        const n = seed.segments.length, O = OLD.SEG;
        if (flagOnly && n < 3) S7.corrected.short++;
        if (flagOnly && n >= 3 && O.moveBoundary && O.boundaryAtPlayhead && O.mergeSegments) {
          const C = S7.corrected;
          C.files++;
          const lines = NEW.ft.getBaselineParagraphs(seed);
          const i = Math.floor(n / 2) - 1, a = seed.segments[i], b = seed.segments[i + 1];
          const dragged = O.moveBoundary(seed.segments, i, a.end + Math.round(0.37 * (b.end - b.start)));
          const variants = [
            ['drag', lines, dragged && dragged.ok ? dragged.segments : null, [i, i + 1]],
            ['cut', [...lines.slice(0, i + 1), '', ...lines.slice(i + 1)], O.boundaryAtPlayhead(seed.segments, i, a.start + Math.round(0.4 * (a.end - a.start))), [i, i + 1]],
            ['join', [...lines.slice(0, i), lines[i] + ' ' + lines[i + 1], ...lines.slice(i + 2)], O.mergeSegments(seed.segments, i), []],
            ['clamp', lines, seed.segments.map((x, k) => (k === n - 1 ? { ...x, end: x.end - 70 } : { ...x })), []],
          ];
          for (const [kind, ls, segs, keep] of variants) {
            if (!segs || segs.length !== ls.length) { C.missed++; flag(`corrected seed (${kind}): could not be made`, rel); continue; }
            const doc = JSON.parse(JSON.stringify(seed));
            NEW.ft.reconcileBaseline(doc, ls, { flatSegments: true });
            doc.segments = JSON.parse(JSON.stringify(segs));
            C.texts++; C.lines += segs.length;
            const timedIn = (x) => (x.match(/begin-time-offset=/g) || []).length;
            if (timedIn(NEW.exportXml(JSON.parse(JSON.stringify(doc)))) !== keep.length) {   // straight from the list
              C.unopenedWrong++; flag(`corrected seed (${kind}) exported unopened with the wrong times`, rel);
            }
            NEW.render(doc, AUDIO_MS + 70);
            const placed = doc.segments.map((x, k) => (isPlaced(x) ? k : -1)).filter((k) => k >= 0);
            const extra = placed.filter((k) => !keep.includes(k)).length, lost = keep.filter((k) => !placed.includes(k)).length;
            C.missed += extra; C.placedLost += lost;
            if (extra) flag(`corrected seed (${kind}): a seed line not recognised`, rel);
            if (lost) flag(`corrected seed (${kind}): the user's own time dropped`, rel);
            if (timedIn(NEW.exportXml(doc)) !== keep.length) { C.exportWrong++; flag(`corrected seed (${kind}) exported with the wrong times`, rel); }
          }
        }
      }
    }
    // An untimed text opened with audio carries the v714 seed in v717: the PI line is the only change.
    if (!V718 && !timed && !D) {
      const So = OLD.open(xml, { durationMs: AUDIO_MS }), Sn = NEW.open(xml, { durationMs: AUDIO_MS });
      if (Sn.writes.stamped) { T.stampedWrites += Sn.writes.stamped; flag('stamped write on a seeded open', rel); }
      const s = exportDiff(OLD.exportXml(So.doc), NEW.exportXml(Sn.doc));
      V.untimedSeeded.files++;
      V.untimedSeeded.piLines += s.pi;
      V.untimedSeeded.quietWrites += Sn.writes.quiet;
      if (s.tilde || s.other) { V.untimedSeeded.other += s.tilde + s.other; flag('seeded untimed export differs beyond the PI', rel); }
    }
  }
}

console.log(JSON.stringify(T, null, 1));
if (SHOW_PATHS) for (const [what, list] of Object.entries(flagged)) {
  console.log(`\n${what} (${list.length}):`);
  for (const p of list) console.log('  ' + p);
} else {
  const kinds = Object.entries(flagged).map(([k, v]) => `${k}: ${v.length}`).join(', ');
  if (kinds) console.log(`\nflagged — ${kinds} (rerun with --paths to list them)`);
}
