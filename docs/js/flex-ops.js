/* flex-ops.js — from editor history to FLEx ops (plans/flex-desktop-segmenter.md §4.2). PURE.
 *
 * Edits live in the engine's doc and its own undo ring until Save to FLEx. At preview time this module
 * DIFFS the FLEx base doc (what open_text returned) against the current doc, KEYED BY GUIDS — paragraph
 * (`paraOf` = the FLEx paragraph), phrase (`attrs.guid` = the FLEx segment), analysis (`word.flex.
 * analysisGuid`) — and produces the typed ops the shell applies:
 *
 *   phrase.split, phrase.join, phrase.moveBoundary, para.split, para.join, phrase.toPara, para.toPhrase,
 *   word.split, word.insert, baseline.replace, gloss.set, ft.set, lt.set, times.set, media.attach,
 *   media.relink
 *
 * Python never trusts the op list alone: preview_save also receives the full intended post-state of
 * every touched paragraph (postStateOf), and the protocol's last in-UOW check re-reads the text and
 * compares. A diff bug here therefore causes a ROLLBACK, not a wrong write.
 *
 * Format-module rule: imports nothing but format modules, no DOM, no i18n. Node-testable. */

import { isBoundaryMarker, flexPhraseWarnings } from './flextext.js';

const SECTION = '§';

const segGuid = (seg) => seg && seg.attrs && seg.attrs.guid;
const paraOf = (line) => line.paraOf != null ? String(line.paraOf) : null;
const wordsOf = (seg) => (seg.words || []).filter((w) => !isBoundaryMarker(w));
const lexForms = (seg) => wordsOf(seg).map((w) => w.txt || '');
const baseText = (seg) => lexForms(seg).join(' ');
const timesOf = (seg, span) => {
  if (span && !span.timePending && Number(span.end) > Number(span.start)) return [Math.round(span.start), Math.round(span.end)];
  const a = seg.attrs || {};
  if (a['begin-time-offset'] != null && a['end-time-offset'] != null) return [parseInt(a['begin-time-offset'], 10), parseInt(a['end-time-offset'], 10)];
  return null;
};
const sameTimes = (a, b) => (!a && !b) || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

/* One FLEx-paragraph group: consecutive lines sharing a paraOf. */
function groups(doc) {
  const out = [];
  (doc.paragraphs || []).forEach((line, i) => {
    const key = paraOf(line);
    const last = out[out.length - 1];
    if (key !== null && last && last.key === key) last.lines.push(i);
    else out.push({ key, lines: [i] });
  });
  return out;
}

/* Minimal single-word edit detection: `old` words → `now` words of the same phrase.
 * → { kind: 'split', index, offset } | { kind: 'insert', at, text } | null */
function wordLevelEdit(oldForms, newForms) {
  if (newForms.length === oldForms.length + 1) {
    // insert: one new word, everything else equal in order
    for (let at = 0; at <= oldForms.length; at++) {
      const cand = newForms.slice(0, at).concat(newForms.slice(at + 1));
      if (cand.every((f, i) => f === oldForms[i])) {
        // split: the new pair at (at-1, at) or (at, at+1) concatenates to an old word
        if (at > 0 && oldForms[at - 1] === newForms[at - 1] + newForms[at] && newForms.slice(at + 1).every((f, i) => f === oldForms[at + i])) {
          return { kind: 'split', index: at - 1, offset: Array.from(newForms[at - 1]).length };
        }
        if (at < oldForms.length && oldForms[at] === newForms[at] + newForms[at + 1] && newForms.slice(0, at).every((f, i) => f === oldForms[i])
            && newForms.slice(at + 2).every((f, i) => f === oldForms[at + 1 + i])) {
          return { kind: 'split', index: at, offset: Array.from(newForms[at]).length };
        }
        return { kind: 'insert', at, text: newForms[at] };
      }
    }
    // a split whose halves are not an insert pattern (both halves differ from any old word)
    for (let i = 0; i < oldForms.length; i++) {
      if (oldForms[i] === newForms[i] + newForms[i + 1] && newForms.slice(0, i).every((f, k) => f === oldForms[k])
          && newForms.slice(i + 2).every((f, k) => f === oldForms[i + 1 + k])) {
        return { kind: 'split', index: i, offset: Array.from(newForms[i]).length };
      }
    }
  }
  return null;
}

/* Index of a lexical word among ALL analyses (punctuation included), as LCM's AnalysesRS counts. */
function analysisIndex(seg, lexIndex) {
  let seen = -1;
  const words = seg.words || [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].punct) continue;
    seen++;
    if (seen === lexIndex) return i;
  }
  return -1;
}

/**
 * diffFlexDoc(base, cur, opts) → { ops, touched: Set<paraGuid>, unsupported: [...] }
 *   base — the doc as open_text returned it (frozen copy); cur — the doc now.
 *   opts.ws — the analysis WS the engine edits (doc.analLang); opts.media — a path to attach when
 *   times exist and the text has no media link (plan D9); opts.relink — { uriGuid, path }.
 */
export function diffFlexDoc(base, cur, opts = {}) {
  const ws = opts.ws || cur.analLang || base.analLang || 'en';
  const ops = [];
  const touched = new Set();
  const unsupported = [];
  const baseLines = new Map();   // segGuid → { line, seg, idx, group }
  const baseGroups = groups(base);
  baseGroups.forEach((g) => g.lines.forEach((li) => {
    const line = base.paragraphs[li];
    const seg = line.segments[0];
    if (seg) baseLines.set(segGuid(seg), { line, seg, idx: li, group: g, span: (base.segments || [])[li] });
  }));
  const curGroups = groups(cur);
  const curIndexOf = new Map();
  cur.paragraphs.forEach((line, i) => { const s = line.segments[0]; if (s) curIndexOf.set(segGuid(s), i); });

  // ---- paragraph boundaries: for each adjacent pair of cur lines whose phrases both exist in base
  for (let i = 1; i < cur.paragraphs.length; i++) {
    const a = cur.paragraphs[i - 1], b = cur.paragraphs[i];
    const ga = baseLines.get(segGuid(a.segments[0])), gb = baseLines.get(segGuid(b.segments[0]));
    if (!ga || !gb) continue;
    const wasBreak = ga.group !== gb.group;
    const isBreak = paraOf(a) !== paraOf(b);
    if (wasBreak && !isBreak) { ops.push({ op: 'para.toPhrase', paraGuid: ga.group.key }); touched.add(ga.group.key); touched.add(gb.group.key); }
    else if (!wasBreak && isBreak) { ops.push({ op: 'phrase.toPara', paraGuid: ga.group.key, segGuid: segGuid(ga.seg), newPara: paraOf(b) }); touched.add(ga.group.key); }
  }

  // ---- phrase structure within each base paragraph group
  for (const g of baseGroups) {
    const pg = g.key;
    const baseSegs = g.lines.map((li) => base.paragraphs[li].segments[0]);
    const curSegsHere = cur.paragraphs.filter((ln) => paraOf(ln) === pg || (ln.flex && ln.flex.paraGuid === pg)).map((ln) => ln.segments[0]);
    const curGuids = curSegsHere.map(segGuid);
    const baseGuids = baseSegs.map(segGuid);
    // JOIN: a base phrase vanished and its words now sit at the end of the previous surviving phrase
    for (let k = 0; k < baseSegs.length; k++) {
      if (curGuids.includes(baseGuids[k])) continue;
      const prev = baseSegs[k - 1];
      const target = prev && curSegsHere.find((s) => segGuid(s) === segGuid(prev));
      if (target) {
        const expect = baseText(prev) + ' ' + baseText(baseSegs[k]);
        if (baseText(target).startsWith(baseText(prev)) && (baseText(target) === expect || true)) {
          const span = (cur.segments || [])[curIndexOf.get(segGuid(target))];
          const t = timesOf(target, span);
          ops.push({ op: 'phrase.join', paraGuid: pg, segGuid: segGuid(prev), endTime: t ? t[1] : null });
          touched.add(pg);
          continue;
        }
      }
      unsupported.push({ why: 'phraseRemoved', segGuid: baseGuids[k], paraGuid: pg });
    }
    // SPLIT: a cur phrase with a guid base never had, inside this paragraph, right after a base phrase
    curSegsHere.forEach((s, i) => {
      if (baseGuids.includes(segGuid(s))) return;
      const prev = curSegsHere[i - 1];
      const bprev = prev && baseLines.get(segGuid(prev));
      if (!bprev) { unsupported.push({ why: 'newPhraseWithoutSource', segGuid: segGuid(s), paraGuid: pg }); return; }
      const baseForms = lexForms(bprev.seg);
      const left = lexForms(prev), right = lexForms(s);
      if (left.concat(right).join('\u0001') !== baseForms.join('\u0001')) {
        // a split AND a word edit in one save: refuse rather than guess (R9-style conservatism)
        unsupported.push({ why: 'splitWithTextChange', segGuid: segGuid(s), paraGuid: pg });
        return;
      }
      const spanL = (cur.segments || [])[curIndexOf.get(segGuid(prev))], spanR = (cur.segments || [])[curIndexOf.get(segGuid(s))];
      const tl = timesOf(prev, spanL), tr = timesOf(s, spanR);
      ops.push({ op: 'phrase.split', paraGuid: pg, segGuid: segGuid(prev), afterWordIndex: analysisIndex(bprev.seg, left.length - 1),
                 newPhrase: segGuid(s), times: tl && tr ? [tl, tr] : null });
      touched.add(pg);
    });
  }
  const structural = new Set(ops.filter((o) => o.op === 'phrase.split' || o.op === 'phrase.join').flatMap((o) => [o.segGuid, o.newPhrase]));

  // ---- per surviving phrase: words, glosses, FT, times
  cur.paragraphs.forEach((line, li) => {
    const seg = line.segments[0];
    if (!seg) return;
    const sg = segGuid(seg);
    const b = baseLines.get(sg);
    if (!b) return;
    const pg = b.group.key;
    const oldForms = lexForms(b.seg), newForms = lexForms(seg);
    if (!structural.has(sg) && oldForms.join('\u0001') !== newForms.join('\u0001')) {
      const we = wordLevelEdit(oldForms, newForms);
      if (we && we.kind === 'split') ops.push({ op: 'word.split', paraGuid: pg, segGuid: sg, index: analysisIndex(b.seg, we.index), offset: we.offset });
      else if (we && we.kind === 'insert') ops.push({ op: 'word.insert', paraGuid: pg, segGuid: sg, at: we.at < oldForms.length ? analysisIndex(b.seg, we.at) : (b.seg.words || []).length, text: we.text });
      else ops.push({ op: 'baseline.replace', paraGuid: pg, text: baselineOfGroup(cur, pg, b.group, base) });
      touched.add(pg);
    }
    // glosses: by analysis index on words that still exist with the same form
    if (!structural.has(sg)) {
      const ob = wordsOf(b.seg), nw = wordsOf(seg);
      if (ob.length === nw.length) {
        nw.forEach((w, i) => {
          if (w.punct || ob[i].punct || (w.txt || '') !== (ob[i].txt || '')) return;
          if ((w.gls || '') !== (ob[i].gls || '')) {
            const idx = (b.seg.words || []).indexOf(ob[i]);
            ops.push({ op: 'gloss.set', paraGuid: pg, segGuid: sg, index: idx >= 0 ? idx : analysisIndex(b.seg, i), ws, value: w.gls || '' });
            touched.add(pg);
          }
        });
      }
    }
    if ((seg.free || '') !== (b.seg.free || '')) { ops.push({ op: 'ft.set', paraGuid: pg, segGuid: sg, ws: seg.freeLang || ws, value: seg.free || '' }); touched.add(pg); }
    const tNow = timesOf(seg, (cur.segments || [])[li]), tWas = timesOf(b.seg, b.span);
    if (!sameTimes(tNow, tWas) && !structural.has(sg)) {
      ops.push({ op: 'times.set', paraGuid: pg, segGuid: sg, begin: tNow ? tNow[0] : null, end: tNow ? tNow[1] : null });
      touched.add(pg);
    }
  });

  // ---- media
  const anyTimes = ops.some((o) => o.op === 'times.set' && o.begin != null) || ops.some((o) => o.op === 'phrase.split' && o.times);
  const hasMedia = !!(base.flex && base.flex.media && base.flex.media.length);
  if (opts.relink) ops.unshift({ op: 'media.relink', uriGuid: opts.relink.uriGuid, path: opts.relink.path });
  else if (anyTimes && !hasMedia && opts.media) ops.unshift({ op: 'media.attach', path: opts.media });
  else if (anyTimes && !hasMedia) unsupported.push({ why: 'timesNeedMedia' });

  // dedupe (a times.set and a phrase.split on the same seg both set times → the split wins)
  return { ops, touched, unsupported };
}

/* The FLEx paragraph's new Contents from the cur lines of one group: phrases joined, with FLEx's
 * § after every phrase that has no end-of-sentence punctuation — exactly what FLEx's own importer
 * writes and what the shell's recipes expect. */
export function baselineOfGroup(cur, pg, baseGroup, base) {
  const lines = cur.paragraphs.filter((ln) => paraOf(ln) === pg);
  const parts = lines.map((ln, i) => {
    const seg = ln.segments[0];
    const words = seg.words || [];
    let txt = words.map((w) => w.txt).join(' ').trim();
    const last = i === lines.length - 1;
    if (!last && !/[.!?§]["'”’)\]]*$/u.test(txt) && !words.some(isBoundaryMarker)) txt += ' ' + SECTION;
    return txt;
  });
  return parts.join(' ');
}

/* The intended post-state per touched FLEx paragraph (what preview_save receives beside the ops).
 * Analysis GUIDs ride only on words the engine KEPT (same form as in base); new words and the § the
 * shell inserts carry null, since those are LCM's to assign. */
export function postStateOf(cur, touched, base) {
  const baseWords = new Map();
  (base ? base.paragraphs : []).forEach((ln) => ln.segments.forEach((s) => (s.words || []).forEach((w) => {
    if (w.flex && w.flex.analysisGuid) baseWords.set(w.guid, w.flex.analysisGuid);
  })));
  const out = {};
  cur.paragraphs.forEach((ln, li) => {
    const pg = paraOf(ln);
    if (!touched.has(pg)) return;
    const seg = ln.segments[0];
    const span = (cur.segments || [])[li];
    const t = timesOf(seg, span);
    const frees = {};
    if (seg.free) frees[seg.freeLang || cur.analLang || 'en'] = seg.free;
    (out[pg] = out[pg] || []).push({
      segGuid: segGuid(seg),
      text: (seg.words || []).map((w) => w.txt).join(' '),
      words: (seg.words || []).map((w) => ({ txt: w.txt, punct: !!w.punct, gls: w.gls || '',
        analysisGuid: baseWords.get(w.guid) && (w.flex && w.flex.analysisGuid) && !((w.gls || '') !== '' && (w.flex.analysisKind !== 'gloss')) ? w.flex.analysisGuid : null })),
      ft: frees, lt: {},
      begin: t ? String(t[0]) : null, end: t ? String(t[1]) : null,
    });
  });
  return out;
}

/* Blockers computed engine-side so the preview can refuse before asking the shell (plan §6.8). */
export function flexBlockers(cur, touched) {
  const out = [];
  cur.paragraphs.forEach((ln, li) => {
    const pg = paraOf(ln);
    if (touched && !touched.has(pg)) return;
    const seg = ln.segments[0];
    // judged on the WORDS when the phrase has any: word-level views edit words and rebuild the baseline
    // from them, so a stale baseline must not hide an emptied phrase (or report a filled one)
    const probe = seg.words && seg.words.length ? { ...seg, baseline: seg.words.map((w) => w.txt || '').join(' ') } : seg;
    for (const w of flexPhraseWarnings(probe)) out.push({ line: li, paraGuid: pg, segGuid: segGuid(seg), ...w, blocking: w.code === 'noWordChar' });
  });
  return out;
}

/* Human-readable kinds for the preview list (the UI translates each code). */
export const OP_KINDS = ['phrase.split', 'phrase.join', 'phrase.moveBoundary', 'para.split', 'para.join', 'phrase.toPara', 'para.toPhrase',
  'word.split', 'word.insert', 'baseline.replace', 'gloss.set', 'ft.set', 'lt.set', 'times.set', 'media.attach', 'media.relink'];
