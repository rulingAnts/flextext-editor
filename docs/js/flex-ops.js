/* flex-ops.js — from editor history to FLEx ops (plans/flex-desktop-segmenter.md §4.2). PURE.
 *
 * Edits live in the engine's doc and its own undo ring until Save to FLEx. At preview time this module
 * DIFFS the FLEx base doc (what open_text returned) against the current doc, KEYED BY GUIDS — paragraph
 * (`paraOf` = the FLEx paragraph), phrase (`attrs.guid` = the FLEx segment), analysis (`word.flex.
 * analysisGuid`) — and produces the typed ops the shell applies:
 *
 *   phrase.split, phrase.join, phrase.moveBoundary, para.split, para.join, phrase.toPara, para.toPhrase,
 *   word.split, word.join, word.insert, baseline.replace, gloss.set, ft.set, lt.set, times.set,
 *   media.attach, media.relink
 *
 * Python never trusts the op list alone: preview_save also receives the full intended post-state of
 * every touched paragraph (postStateOf), and the protocol's last in-UOW check re-reads the text and
 * compares. A diff bug here therefore causes a ROLLBACK, not a wrong write.
 *
 * Format-module rule: imports nothing but format modules, no DOM, no i18n. Node-testable. */

import { isBoundaryMarker, flexPhraseWarnings, FLEX_EOS } from './flextext.js';

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
// The phrase ends at real end-of-sentence punctuation (not FLEx's § marker): FLEx does not join across it.
const endsAtStop = (seg) => {
  const toks = (seg.words || []).filter((w) => String(w.txt || '').trim());
  const last = toks[toks.length - 1];
  return !!last && !!last.punct && !isBoundaryMarker(last) && FLEX_EOS.test(last.txt);
};

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
 * → { kind: 'split', index, offset } | { kind: 'insert', at, text } | { kind: 'join', index } | null */
function wordLevelEdit(oldForms, newForms) {
  if (newForms.length === oldForms.length - 1) {
    // join: two neighbours became their concatenation, everything else equal in order
    for (let i = 0; i < newForms.length; i++) {
      if (newForms[i] === oldForms[i] + oldForms[i + 1] && newForms.slice(0, i).every((f, k) => f === oldForms[k])
          && newForms.slice(i + 1).every((f, k) => f === oldForms[i + 2 + k])) return { kind: 'join', index: i };
    }
  }
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

  /* ---- phrase structure, in document order (plan §6). FLEx makes phrases from the baseline's
   * punctuation and §: a split inserts a § (the first half keeps the segment's GUID, the second is new),
   * a join removes one, and two sentences parted by a real stop are not FLEx's to join without changing
   * the text. The Matcher's ✂ and ⤴ make exactly these shapes; anything else is refused, never guessed. */
  const baseOrder = base.paragraphs.map((line) => line.segments[0]).filter(Boolean);
  const groupOf = (seg) => baseLines.get(segGuid(seg)).group;
  const structural = new Set();   // phrases a split or a join reshapes: their words travel with the op
  const joined = new Set();
  const crossed = new Set();      // paragraph groups a join merges into the paragraph before them
  const newPhrases = new Map();   // guid of a phrase a split makes → its base paragraph group key
  // JOINS: base phrases gone from cur whose words now end the nearest surviving phrase before them
  for (let k = 0; k < baseOrder.length; k++) {
    const s = baseOrder[k];
    if (!curIndexOf.has(segGuid(s))) continue;
    const run = [];
    for (let j = k + 1; j < baseOrder.length && !curIndexOf.has(segGuid(baseOrder[j])); j++) run.push(baseOrder[j]);
    if (!run.length) continue;
    const now = cur.paragraphs[curIndexOf.get(segGuid(s))].segments[0];
    if (lexForms(now).join('\u0001') !== [s, ...run].flatMap(lexForms).join('\u0001')) {
      run.forEach((v) => unsupported.push({ why: 'phraseRemoved', segGuid: segGuid(v), paraGuid: groupOf(v).key }));
      continue;
    }
    const pg = groupOf(s).key;
    const these = [], merged = [];
    let left = s, g = groupOf(s), why = null;
    for (const v of run) {
      if (endsAtStop(left)) { why = 'joinAtStop'; break; }
      const gv = groupOf(v);
      if (gv !== g) {
        // across a paragraph break: FLEx joins the paragraphs, then the phrases — only when v opens its
        // paragraph and the rest of that paragraph is in the survivor's paragraph now (or joined too)
        const opens = base.paragraphs[gv.lines[0]].segments[0] === v;
        const rest = gv.lines.map((li) => base.paragraphs[li].segments[0]).filter((x) => x !== v);
        const moved = rest.every((x) => (curIndexOf.has(segGuid(x)) ? paraOf(cur.paragraphs[curIndexOf.get(segGuid(x))]) === pg : run.includes(x)));
        if (!opens || !moved) { why = 'joinAcrossParagraphs'; break; }
        these.push({ op: 'para.toPhrase', paraGuid: pg });
        merged.push(gv.key);
        g = gv;
      }
      these.push({ op: 'phrase.join', paraGuid: pg, segGuid: segGuid(s), endTime: null });
      left = v;
    }
    if (why) { unsupported.push({ why, segGuid: segGuid(run[0]), paraGuid: groupOf(run[0]).key }); continue; }
    ops.push(...these);
    merged.forEach((key) => { crossed.add(key); touched.add(key); });
    touched.add(pg);
    structural.add(segGuid(s));
    joined.add(segGuid(s));
  }

  // ---- paragraph boundaries: for each adjacent pair of cur lines whose phrases both exist in base
  // (a boundary a join above already crossed is not crossed twice)
  for (let i = 1; i < cur.paragraphs.length; i++) {
    const a = cur.paragraphs[i - 1], b = cur.paragraphs[i];
    const ga = baseLines.get(segGuid(a.segments[0])), gb = baseLines.get(segGuid(b.segments[0]));
    if (!ga || !gb) continue;
    const wasBreak = ga.group !== gb.group;
    const isBreak = paraOf(a) !== paraOf(b);
    if (wasBreak && !isBreak) {
      if (!crossed.has(gb.group.key)) { ops.push({ op: 'para.toPhrase', paraGuid: ga.group.key }); touched.add(ga.group.key); touched.add(gb.group.key); }
    } else if (!wasBreak && isBreak) { ops.push({ op: 'phrase.toPara', paraGuid: ga.group.key, segGuid: segGuid(ga.seg), newPara: paraOf(b) }); touched.add(ga.group.key); }
  }

  const examined = new Set();     // every phrase base never had that follows a base phrase
  // SPLITS: a base phrase followed in cur by phrases base never had, whose words continue it. Each new
  // phrase is a split of the one before it, all inside the base paragraph (so the splits run first); a
  // new phrase that opens a paragraph of its own (a Sentence break) then moves to it (afterSplit).
  for (let i = 0; i < cur.paragraphs.length; i++) {
    const s = cur.paragraphs[i].segments[0];
    if (!s || !baseLines.has(segGuid(s))) continue;
    const pieces = [s];
    for (let j = i + 1; j < cur.paragraphs.length; j++) {
      const n = cur.paragraphs[j].segments[0];
      if (!n || baseLines.has(segGuid(n))) break;
      pieces.push(n);
    }
    if (pieces.length === 1) continue;
    pieces.slice(1).forEach((p) => examined.add(segGuid(p)));
    const b = baseLines.get(segGuid(s));
    const pg = b.group.key;
    if (joined.has(segGuid(s))) { unsupported.push({ why: 'splitAndJoin', segGuid: segGuid(s), paraGuid: pg }); continue; }
    if (pieces.flatMap(lexForms).join('\u0001') !== lexForms(b.seg).join('\u0001')) {
      // the phrase itself unchanged: the lines after it were ADDED (+, or Done's padding for leftover
      // audio); otherwise a split whose words were also edited
      const added = lexForms(s).join('\u0001') === lexForms(b.seg).join('\u0001');
      unsupported.push({ why: added ? 'addedLine' : 'splitWithTextChange', segGuid: segGuid(pieces[1]), paraGuid: pg });
      continue;
    }
    // a piece with no word is a line added with nothing in it (FLEx makes no phrase without a letter, D4)
    const empty = pieces.find((p) => !lexForms(p).length);
    if (empty) { unsupported.push({ why: 'addedLine', segGuid: segGuid(empty), paraGuid: pg }); continue; }
    const idx = pieces.map((p) => curIndexOf.get(segGuid(p)));
    const times = pieces.map((p, t) => timesOf(p, (cur.segments || [])[idx[t]]));
    const allTimed = times.every(Boolean);
    const toParas = [];
    let para = pg;
    for (let t = 0; t + 1 < pieces.length; t++) {
      const rest = { words: pieces.slice(t).flatMap((p) => p.words || []) };   // the FLEx segment being split, as it is then
      ops.push({ op: 'phrase.split', paraGuid: pg, segGuid: segGuid(pieces[t]), afterWordIndex: analysisIndex(rest, lexForms(pieces[t]).length - 1),
                 newPhrase: segGuid(pieces[t + 1]), times: allTimed ? [times[t], times[t + 1]] : null });
      newPhrases.set(segGuid(pieces[t + 1]), pg);
      const pa = paraOf(cur.paragraphs[idx[t]]), pb = paraOf(cur.paragraphs[idx[t + 1]]);
      if (pb !== pa && pb != null) {
        toParas.push({ op: 'phrase.toPara', paraGuid: para, segGuid: segGuid(pieces[t]), newPara: pb, afterSplit: true });
        touched.add(pb);
        para = pb;
      }
    }
    ops.push(...toParas);
    if (!allTimed) {
      pieces.forEach((p, t) => ops.push({ op: 'times.set', paraGuid: pg, segGuid: segGuid(p), begin: times[t] ? times[t][0] : null, end: times[t] ? times[t][1] : null }));
    }
    pieces.forEach((p) => structural.add(segGuid(p)));
    touched.add(pg);
  }
  // Phrases base never had before its first phrase (a line added at the very top): nothing to split from.
  cur.paragraphs.forEach((line) => {
    const seg = line.segments[0];
    if (!seg || baseLines.has(segGuid(seg)) || examined.has(segGuid(seg))) return;
    unsupported.push({ why: lexForms(seg).length ? 'newPhraseWithoutSource' : 'addedLine', segGuid: segGuid(seg), paraGuid: paraOf(line) });
  });

  // A reshaped phrase carries its words' glosses as they were; a gloss edited in the same save is
  // refused, never dropped (save the reshaping first, then gloss).
  const baseGls = new Map();
  base.paragraphs.forEach((ln) => ln.segments.forEach((sg) => (sg.words || []).forEach((w) => { if (w.guid) baseGls.set(w.guid, w.gls || ''); })));
  cur.paragraphs.forEach((line) => {
    const seg = line.segments[0];
    if (!seg || !(structural.has(segGuid(seg)) || newPhrases.has(segGuid(seg)))) return;
    if ((seg.words || []).some((w) => w.guid && baseGls.has(w.guid) && baseGls.get(w.guid) !== (w.gls || ''))) {
      unsupported.push({ why: 'structureWithGlossChange', segGuid: segGuid(seg), paraGuid: paraOf(line) });
    }
  });

  // ---- per surviving phrase: words, glosses, FT, times
  cur.paragraphs.forEach((line, li) => {
    const seg = line.segments[0];
    if (!seg) return;
    const sg = segGuid(seg);
    const b = baseLines.get(sg);
    if (!b) {
      // a phrase a split made: FLEx gives it no free translation, so the one here is set after the split
      const npg = newPhrases.get(sg);
      if (npg != null && (seg.free || '')) { ops.push({ op: 'ft.set', paraGuid: npg, segGuid: sg, ws: seg.freeLang || ws, value: seg.free }); touched.add(npg); }
      return;
    }
    const pg = b.group.key;
    const oldForms = lexForms(b.seg), newForms = lexForms(seg);
    if (!structural.has(sg) && oldForms.join('\u0001') !== newForms.join('\u0001')) {
      const we = wordLevelEdit(oldForms, newForms);
      if (we && we.kind === 'split') ops.push({ op: 'word.split', paraGuid: pg, segGuid: sg, index: analysisIndex(b.seg, we.index), offset: we.offset });
      else if (we && we.kind === 'join') ops.push({ op: 'word.join', paraGuid: pg, segGuid: sg, index: analysisIndex(b.seg, we.index) });
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
    // a join survivor's times are set outright: FLEx's join keeps the first phrase's start, the last one's end
    if (joined.has(sg) && (tNow || tWas)) {
      ops.push({ op: 'times.set', paraGuid: pg, segGuid: sg, begin: tNow ? tNow[0] : null, end: tNow ? tNow[1] : null });
      touched.add(pg);
    } else if (!sameTimes(tNow, tWas) && !structural.has(sg)) {
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
  'word.split', 'word.join', 'word.insert', 'baseline.replace', 'gloss.set', 'ft.set', 'lt.set', 'times.set', 'media.attach', 'media.relink'];

/* ---- local records of FLEx texts (plans/flex-desktop-segmenter.md §4.4, §8.4) -------------------- */

/* The local record id of a FLEx text: one per (project, text).
 * ⚠ NO COLON. The media store's answer to "which texts have a recording" (db.mediaKeys) ignores
 * every key containing ':' — that is how it tells a text's own recording from derived WAVs and
 * consent clips — so a FLEx text stored under 'flex:<project>:<guid>' could never count as having
 * one: the Segmenter would list it as "no recording" whatever was cached (found 2026-10-14, before
 * any text had been opened in the field, so nothing stored under the old form needs moving).
 * The project rides as a hash: a disposable copy shares its text GUIDs with the original and must
 * not share its local record. */
export function flexDocId(projectName, textGuid) {
  let h = 0x811c9dc5;   // FNV-1a, 32-bit
  const s = String(projectName || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'flex-' + String(textGuid || '').replace(/[^A-Za-z0-9-]/g, '') + '-' + h.toString(36);
}

/* A FLEx text's local record (flexDocId); the app's own records have GUID ids. */
export const isFlexDocId = (id) => /^flex-/.test(String(id || ''));

/* A local record of a text of THIS project (a reset of all its texts must not touch a copy's): the id
 * ends in the project's hash, after the text guid. */
export function isFlexDocOf(id, projectName) {
  const tail = flexDocId(projectName, '').slice('flex-'.length);   // '-' + the project's hash
  return isFlexDocId(id) && String(id).length > 'flex-'.length + tail.length && String(id).endsWith(tail);
}

/* Work on a FLEx text's local record that FLEx does not have: a Matcher draft in progress, a save to
 * FLEx that was undone (`flex.dirty`), or anything Save to FLEx would write — judged by that same diff,
 * never by timestamps (a Done that changed nothing has done nothing). A record the diff cannot read
 * counts as work: the answer that cannot lose anything. */
export function hasLocalWork(rec) {
  if (!rec || !rec.flex) return false;
  if (rec.matchDraft || rec.flex.dirty) return true;
  try {
    const d = diffFlexDoc(rec.flex.base, rec.doc, { ws: rec.doc.analLang });
    return d.ops.length > 0 || d.unsupported.length > 0;
  } catch { return true; }
}

/* What re-opening a FLEx text does with its local record — never discard local work silently.
 *   'new'     no local record yet
 *   'replace' no work here (hasLocalWork) → FLEx's text, read again. Always, not only when FLEx changed:
 *             FLEx is where the text lives, so a record with nothing of its own is re-read in the
 *             writing systems chosen for it — a gloss corrected in FLEx (no fingerprint covers a gloss's
 *             wording), and a record an older build made in another writing system (Seth, 2026-10-15:
 *             texts glossed in FLEx opening with no glosses), both come back right
 *   'keep'    work here, FLEx unchanged → the local record: FLEx's text plus the work done here
 *   'ask'     work here, FLEx changed → the user decides; the safe answer keeps the local work */
export function reopenDecision(rec, baseRev, local = hasLocalWork(rec)) {
  if (!rec || !rec.flex) return 'new';
  if (!local) return 'replace';
  return rec.flex.baseRev === baseRev ? 'keep' : 'ask';
}

/* Which edges of a phrase's times are this app's estimates (segments.js `guess`) is not something FLEx
 * holds — it stores the times only. A record read again from FLEx keeps them for every phrase whose
 * times FLEx still has exactly as they were here, so re-opening never turns an estimate into a
 * measurement. In place, on `fresh`. */
export function keepTimeEstimates(was, fresh) {
  const spans = (doc) => (Array.isArray(doc && doc.segments) ? doc.segments : []);
  const byGuid = new Map();
  ((was && was.paragraphs) || []).forEach((ln, i) => {
    const g = segGuid(ln.segments && ln.segments[0]);
    if (g && spans(was)[i]) byGuid.set(g, spans(was)[i]);
  });
  ((fresh && fresh.paragraphs) || []).forEach((ln, i) => {
    const old = byGuid.get(segGuid(ln.segments && ln.segments[0]));
    const now = spans(fresh)[i];
    if (!old || !now || old.timePending || now.timePending) return;
    if (Math.round(Number(old.start)) !== Number(now.start) || Math.round(Number(old.end)) !== Number(now.end)) return;
    if (Array.isArray(old.guess)) now.guess = old.guess.slice(0, 2);
    if (old.timeEstimated) now.timeEstimated = true;
    if (old.estSource) now.estSource = old.estSource;
  });
  return fresh;
}

/* Which of a text's media links the Segmenter cuts: one that resolves on this machine, else the
 * first. (A FLEx text normally carries one; several is possible and the Segmenter uses one.) */
export function recordingLink(media) {
  const list = Array.isArray(media) ? media : [];
  return list.find((m) => m && (m.url || m.exists)) || list[0] || null;
}

/* What a Save to FLEx carries for a recording this app found itself (§8.2): a RELINK of the link
 * that points nowhere, or an ATTACH when the text has no link (diffFlexDoc adds it only when the
 * save also writes times, D9). Nothing once FLEx has a link that resolves — fixed here, fixed in FLEx,
 * or attached there since. */
export function pendingMediaFix(flexState) {
  const f = flexState && flexState.mediaFix;
  if (!f || !f.path || flexState.linkOk) return {};
  return f.uriGuid ? { relink: { uriGuid: f.uriGuid, path: f.path } } : { media: f.path };
}
