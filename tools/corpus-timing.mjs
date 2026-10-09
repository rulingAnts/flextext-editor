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
 *              recording of this length had decoded (the v714 seed) — the length does not matter.
 * --expect     { "<path>": "a"|"b"|"d"|"e-full"|"e-partial"|"f" } from the planning audit; the
 *              classes found here are checked against it file by file.
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
  const lifted = ['COVER_TOL_MS', 'evenSpread', 'coverTail', 'reconcile'].filter((n) => has(STRIPS, n));
  let D = 0;
  const reconcile = new Function('SEG', 'ft', 'SS', 'getD', `
    const { syncToLines, isAligned } = SEG;
    const readLegacyEstimates = ft.readLegacyEstimates || (() => {});
    const docSegments = SS.docSegments;
    const peaksDurationFor = () => getD();
    const deps = null;
    ${lifted.map((n) => liftDecl(STRIPS, n)).join('\n')}
    return reconcile;`)(SEG, ft, SS, () => D);
  return {
    ft, SEG,
    /** reconcile — what the Cut and Baseline tabs run on every draw — counting the writes it asks for. */
    render(doc, durationMs) {
      const writes = { stamped: 0, quiet: 0 };
      D = durationMs || 0;
      try {
        reconcile(doc, { getParagraphs: (d) => ft.getBaselineParagraphs(d), getDocId: () => 'doc',
          persist: () => { writes.stamped++; }, persistQuiet: () => { writes.quiet++; } });
      } finally { D = 0; }
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
  const o = oldXml.split('\n'), nAll = newXml.split('\n');
  const n = nAll.filter((l) => !PI_LINE.test(l));
  const out = { pi: nAll.length - n.length, tilde: 0, other: 0 };
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
    classicOther: 0, untimedSeeded: { files: 0, piLines: 0, quietWrites: 0, other: 0 } } : null,
  expectMismatch: EXPECT ? 0 : null,
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
    if (!isAligned(s)) lost++;
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
  let cls = 'untimed';
  if (timed) {
    const n = A.doc.segments.length;
    const est = A.doc.segments.filter(isEstimate).length;
    if (rep.level === 'red') cls = 'damaged';
    else if (est && est === n) cls = 'est-full';
    else if (est) cls = 'est-partial';
    else {
      const s = A.doc.segments;
      const gap = s.some((x, k) => k > 0 && isAligned(x) && isAligned(s[k - 1]) && x.start - s[k - 1].end > 1)
        || (isAligned(s[0]) && s[0].start > 1);
      cls = gap ? 'gaps' : 'contiguous';
    }
    if (est) {
      T.estimateLines += est; T.estimateFiles++;
      for (const s of A.doc.segments) if (isEstimate(s)) T.estBySource[s.estSource || 'edit'] = (T.estBySource[s.estSource || 'edit'] || 0) + 1;
    }
    if (est !== A.fileEstimates) flag('estimates changed by the render', rel);
  }
  T.classes[cls]++;
  if (rep.level === 'red') { T.red++; for (const it of rep.items) if (it.level === 'red') T.redKinds[it.kind] = (T.redKinds[it.kind] || 0) + 1; flag('red', rel); }
  if (rep.level === 'amber') { T.amber++; flag('amber', rel); }
  if (EXPECT && EXPECT[rel] != null && EXPECT[rel] !== LETTER[cls]) { T.expectMismatch++; flag(`class ${cls}, expected ${EXPECT[rel]}`, rel); }

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
    // An untimed text opened with audio carries the v714 seed in v717: the PI line is the only change.
    if (!timed && !D) {
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
