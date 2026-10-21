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

import { isBoundaryMarker, flexPhraseWarnings, FLEX_EOS, wordGlosses, phraseFrees, setGlossIn, setFreeIn, isFlexBreakPhrase } from './flextext.js';

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

/* ---- every analysis writing system (Seth, 2026-10-16: "cache and be able to edit … ALL writing systems";
 * "If it edits a GUID object (a word), it should ONLY change what we changed and leave everything else
 * preserved"). A word's glosses and a phrase's free translations are compared, written and merged per
 * writing system: {ws: text}, the empties dropped. `prim` is the doc's analysis language — the one a
 * gloss or translation with no language of its own is in. */
export function glossMap(w, prim) {
  const out = {};
  for (const g of wordGlosses(w)) { const l = g.lang || prim; const t = String(g.text || '').normalize('NFC'); if (t && !(l in out)) out[l] = t; }
  return out;
}
export function freeMap(seg, prim) {
  const out = {};
  for (const f of phraseFrees(seg)) { const l = f.lang || prim; const t = String(f.text || '').normalize('NFC'); if (t && !(l in out)) out[l] = t; }
  return out;
}
// {ws: new text ('' = cleared)} for each writing system whose text differs between two maps
export function changedIn(was, now) {
  const out = {};
  for (const l of new Set([...Object.keys(was || {}), ...Object.keys(now || {})])) {
    if (((was || {})[l] || '') !== ((now || {})[l] || '')) out[l] = (now || {})[l] || '';
  }
  return out;
}
const sameMap = (a, b) => !Object.keys(changedIn(a, b)).length;
/* A word's identity: the occurrence it was read as (model.py stamps `flex.seg` + `flex.index`), carried
 * wherever an edit moves the word — a word guid alone (analysis:index) can repeat across phrases. A word
 * made here (a split's halves, an added or joined word) has none. `occ` maps the base's identities to
 * where the base holds them; an older build's record (no `flex.seg`) is matched by its word guid, in its
 * own phrase first. */
function occurrences(base) {
  const occ = new Map(), byGuid = new Map(), keyOf = new Map();
  (base.paragraphs || []).forEach((ln) => {
    const seg = ln.segments && ln.segments[0];
    if (!seg) return;
    const sg = segGuid(seg);
    (seg.words || []).forEach((w, idx) => {
      if (w.punct) return;
      const f = w.flex || {};
      const key = f.seg != null && f.index != null ? f.seg + '#' + f.index : sg + '#' + idx;
      occ.set(key, { w, sg, pg: paraOf(ln), idx });
      keyOf.set(w, key);
      if (w.guid) byGuid.set(w.guid, [...(byGuid.get(w.guid) || []), key]);
    });
  });
  const identity = (w, sgNow) => {
    const f = w && w.flex;
    if (f && f.seg != null && f.index != null) return occ.has(f.seg + '#' + f.index) ? f.seg + '#' + f.index : null;
    const hits = (w && w.guid && byGuid.get(w.guid)) || [];
    const here = hits.filter((k) => occ.get(k).sg === sgNow);
    return here.length === 1 ? here[0] : hits.length === 1 ? hits[0] : null;
  };
  return { occ, identity, keyOf };
}

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
 *   Glosses and free translations are compared in EVERY analysis writing system the docs carry; a
 *   gloss.set names the word's changed ones ({forms: {ws: text}}), an ft.set one writing system each.
 *   opts.ws — the analysis WS a doc with no analLang is in; opts.media — a path to attach when
 *   times exist and the text has no media link (plan D9); opts.relink — { uriGuid, path }.
 */
/* Lines an earlier Matcher Done added for the audio after a FLEx text's last line (2026-10-16): blank — no
 * word, no translation — at the END, and not FLEx's. FLEx makes its lines from its own text and can never
 * take one, so they are this app's padding, not work: dropped (with the time spans they carried) before any
 * diff, merge or "not in FLEx yet", so the work beside them saves. Only at the end and only while blank: a
 * line typed into, or one added in the middle, is still the user's to resolve (flex.unsupported.addedLine). */
/* `opts.everywhere` — for Save to FLEx, and the "not in FLEx yet" mark that predicts it: a blank line ANYWHERE is
 * left out the same way. The Matcher's + rows are on FLEx texts again (Seth, 2026-10-17), and a blank line pairs a
 * piece of audio that has no text; FLEx holds no line without words, so it is kept here and never written there.
 * Without the option (re-opening, hasLocalWork) a blank line in the middle still counts as work, so a text opened
 * read-only keeps the lines and times made with it. */
export function stripFlexPadding(base, doc, opts = {}) {
  if (!base || !doc || !Array.isArray(doc.paragraphs)) return doc;
  const prim = doc.analLang || base.analLang || 'en';
  const known = new Set((base.paragraphs || []).map((l) => segGuid((l.segments || [])[0])).filter(Boolean));
  const blank = (line) => {
    const segs = (line && line.segments) || [];
    return !segs.some((sg) => known.has(segGuid(sg))) && !segs.some((sg) => wordsOf(sg).length || Object.keys(freeMap(sg, prim)).length);
  };
  const paras = doc.paragraphs;
  if (opts.everywhere) {
    const keep = paras.map((l) => !blank(l));
    if (keep.every(Boolean)) return doc;
    return { ...doc, paragraphs: paras.filter((_, i) => keep[i]), ...(Array.isArray(doc.segments) ? { segments: doc.segments.filter((_, i) => i >= keep.length || keep[i]) } : {}) };
  }
  let n = paras.length;
  while (n > 0 && blank(paras[n - 1])) n--;
  if (n === paras.length) return doc;
  return { ...doc, paragraphs: paras.slice(0, n), ...(Array.isArray(doc.segments) ? { segments: doc.segments.slice(0, n) } : {}) };
}

/* ---- FLEx's guesses on a record made before the shell read them (2026-10-16) ------------------------------
 * A word a FLEx text has not analysed carries `flex.guess` from open_text (FLEx's best guess, blue in FLEx);
 * the Matcher shows it and adopts it when a gloss is typed (app.js mgAdoptGuess, which marks the word
 * `flex.adopted`). A record kept from an older build has neither — and glosses typed there for words FLEx
 * was guessing would save as one language alone, FLEx's other languages for those words gone from view. */
const occKey = (w) => (w && w.flex && w.flex.seg != null && w.flex.index != null ? w.flex.seg + '#' + w.flex.index : null);
const eachWord = (doc, fn) => { for (const ln of (doc && doc.paragraphs) || []) for (const sg of ln.segments || []) for (const w of sg.words || []) fn(w); };
const copyDoc = (x) => JSON.parse(JSON.stringify(x));

/* `fresh`'s guesses (open_text: FLEx as it is now) on the same occurrences of `doc` — ONLY while FLEx has not
 * changed the text (same baseRev; the caller checks). Metadata only: no gloss is touched. A copy when
 * anything changed, else `doc` itself. */
export function graftFlexGuesses(doc, fresh) {
  const by = new Map();
  eachWord(fresh, (w) => { const k = occKey(w); if (k && w.flex.guess) by.set(k, w.flex.guess); });
  if (!by.size || !doc) return doc;
  let changed = false;
  const out = copyDoc(doc);
  eachWord(out, (w) => {
    const k = occKey(w);
    if (k && by.has(k) && w.flex.analysisKind === 'wordform' && !w.flex.guess) { w.flex.guess = copyDoc(by.get(k)); changed = true; }
  });
  return changed ? out : doc;
}

/* A word glossed in `work` that FLEx was guessing for in `base` (no gloss of its own there, the same
 * spelling), never adopted in the Matcher: the guess's languages the word does not have come along, as
 * mgAdoptGuess would have done when it was typed. A word the Matcher already adopted for (`flex.adopted`) is
 * left exactly as it is — a language removed after adopting stays removed. A copy when anything changed. */
export function adoptFlexGuesses(base, work) {
  const basePrim = (base && base.analLang) || 'en';
  const guessOf = new Map();
  eachWord(base, (w) => {
    const k = occKey(w);
    if (k && w.flex.analysisKind === 'wordform' && w.flex.guess && w.flex.guess.gloss && !Object.keys(glossMap(w, basePrim)).length) guessOf.set(k, w.flex.guess);
  });
  if (!guessOf.size || !work) return work;
  const prim = work.analLang || basePrim;
  // FLEx's current analysis writing systems only (a save may name no other); the shell carries the rest
  const anals = (work.flex && work.flex.anals) || (base.flex && base.flex.anals) || null;
  let changed = false;
  const out = copyDoc(work);
  eachWord(out, (w) => {
    const g = guessOf.get(occKey(w));
    if (!g || w.flex.adopted || (g.form != null && (w.txt || '') !== g.form)) return;
    const now = glossMap(w, prim);
    if (!Object.keys(now).length) return;              // not glossed here: the guess stays a guess
    for (const [l, text] of Object.entries(g.gloss)) {
      if (text && !now[l] && (!anals || anals.includes(l))) { setGlossIn(w, l, text, prim); changed = true; }
    }
  });
  return changed ? out : work;
}

export function diffFlexDoc(base, cur, opts = {}) {
  const basePrim = base.analLang || opts.ws || 'en', curPrim = cur.analLang || basePrim;
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
  const joinedFrom = new Map();   // a join's survivor → the base phrases it is made of (itself first)
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
    /* A hard line break between them (its own label segment in LCM) goes with the join: "joining audio segments always
     * makes them one phrase, one baseline line" (Seth, 2026-10-21) — the shell's join_phrases deletes the break. A
     * break is never a phrase of the join: no op of its own, no words. Breaks gone with no phrase joined across them,
     * or a break that is the line joined onto, are not a join: refused by name. */
    const texts = run.filter((v) => !isFlexBreakPhrase(v));
    if (isFlexBreakPhrase(s) || !texts.length) {
      unsupported.push({ why: 'lineBreak', segGuid: segGuid([s, ...run].find(isFlexBreakPhrase) || s), paraGuid: groupOf(s).key });
      continue;
    }
    if (lexForms(now).join('\u0001') !== [s, ...texts].flatMap(lexForms).join('\u0001')) {
      run.forEach((v) => unsupported.push({ why: 'phraseRemoved', segGuid: segGuid(v), paraGuid: groupOf(v).key }));
      continue;
    }
    const pg = groupOf(s).key;
    const these = [], merged = [];
    let left = s, g = groupOf(s), why = null;
    for (const v of texts) {
      if (endsAtStop(left)) { why = 'joinAtStop'; break; }
      const gv = groupOf(v);
      if (gv !== g) {
        // across a paragraph break: FLEx joins the paragraphs, then the phrases — only when v opens its
        // paragraph (a break before it in that paragraph goes with the join) and the rest of that paragraph is in
        // the survivor's paragraph now (or joined too)
        const opens = gv.lines.map((li) => base.paragraphs[li].segments[0]).find((x) => !isFlexBreakPhrase(x)) === v;
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
    joinedFrom.set(segGuid(s), [s, ...texts]);   // the phrases joined; a break between them has no words to pair
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
  const splitPieces = new Map();  // a base phrase split here → its pieces, in order (itself first)
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
    splitPieces.set(segGuid(s), pieces);
    if (!allTimed) {
      pieces.forEach((p, t) => ops.push({ op: 'times.set', paraGuid: pg, segGuid: segGuid(p), begin: times[t] ? times[t][0] : null, end: times[t] ? times[t][1] : null }));
    }
    pieces.forEach((p) => structural.add(segGuid(p)));
    touched.add(pg);
  }
  /* ---- paragraph boundaries after a split's LAST piece: the line after it is a base phrase, so neither loop above
   * saw the pair (the first skips a phrase base never had; the second looks only between pieces). Phase B on the VM,
   * 2026-10-21: a Sentence break set right after a split's last piece sent no op, the engine's intended result still
   * had the paragraph, and the shell's check refused the save (2 phrases intended, 9 found). The boundary is the base
   * phrase's own (its stop, §, or line break), moved to the end of its last piece. */
  for (let i = 1; i < cur.paragraphs.length; i++) {
    const a = cur.paragraphs[i - 1], b = cur.paragraphs[i];
    const sa = segGuid(a.segments[0]), gb = baseLines.get(segGuid(b.segments[0]));
    if (!newPhrases.has(sa) || !gb) continue;
    const ka = newPhrases.get(sa);
    const wasBreak = ka !== gb.group.key, isBreak = paraOf(a) !== paraOf(b);
    if (wasBreak && !isBreak) {
      if (!crossed.has(gb.group.key)) { ops.push({ op: 'para.toPhrase', paraGuid: ka }); touched.add(ka); touched.add(gb.group.key); }
    } else if (!wasBreak && isBreak) {
      ops.push({ op: 'phrase.toPara', paraGuid: ka, segGuid: sa, newPara: paraOf(b), afterSplit: true });
      touched.add(ka); touched.add(paraOf(b));
    }
  }
  // Phrases base never had before its first phrase (a line added at the very top): nothing to split from.
  cur.paragraphs.forEach((line) => {
    const seg = line.segments[0];
    if (!seg || baseLines.has(segGuid(seg)) || examined.has(segGuid(seg))) return;
    unsupported.push({ why: lexForms(seg).length ? 'newPhraseWithoutSource' : 'addedLine', segGuid: segGuid(seg), paraGuid: paraOf(line) });
  });

  // ---- per surviving phrase: words, FT, times
  cur.paragraphs.forEach((line, li) => {
    const seg = line.segments[0];
    if (!seg) return;
    const sg = segGuid(seg);
    const b = baseLines.get(sg);
    if (!b) {
      // a phrase a split made: FLEx gives it no free translation, so each one here is set after the split
      const npg = newPhrases.get(sg);
      if (npg != null) {
        for (const [l, v] of Object.entries(freeMap(seg, curPrim))) { ops.push({ op: 'ft.set', paraGuid: npg, segGuid: sg, ws: l, value: v }); touched.add(npg); }
      }
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
    // free translations, in every analysis writing system: those that changed — and on a join's survivor
    // every one the joined phrases had, set outright (LCM joins each with a space; what is written is
    // what the line here holds)
    const fNow = freeMap(seg, curPrim);
    if (joined.has(sg)) {
      const langs = new Set(Object.keys(fNow));
      for (const p of joinedFrom.get(sg) || []) for (const l of Object.keys(freeMap(p, basePrim))) langs.add(l);
      for (const l of langs) ops.push({ op: 'ft.set', paraGuid: pg, segGuid: sg, ws: l, value: fNow[l] || '' });
      if (langs.size) touched.add(pg);
    } else {
      for (const [l, v] of Object.entries(changedIn(freeMap(b.seg, basePrim), fNow))) { ops.push({ op: 'ft.set', paraGuid: pg, segGuid: sg, ws: l, value: v }); touched.add(pg); }
    }
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

  /* ---- word glosses, in every analysis writing system, word by word wherever the word is now. A word
   * the base had (the same occurrence — see occurrences — with the same form) has its gloss set where
   * the base holds it, naming only the writing systems that changed: the shell sets these FIRST, on the
   * text as checked out, and every structural recipe keeps the analyses of the words it does not remake,
   * so the gloss travels with its word into a split's half or a joined phrase. A word made here — a
   * split's halves, an added or a joined word, a respelled one — starts unglossed in FLEx; its glosses
   * (every writing system it has) are set after the save's structural ops, at its place in its phrase
   * now (`newWord`, with its form, which the shell checks before writing). */
  const { occ, identity, keyOf } = occurrences(base);
  /* Which base word each word here IS, from the shape of the edit — the same reading the structural ops
   * above make of it: a split's pieces hold the split phrase's words in order, a join's survivor the joined
   * phrases' words, and any other phrase its own, around the one word a word edit made (same count: place by
   * place — a respelled word keeps its place, its form tells it apart). The occurrence a word was read as
   * (`flex.seg`) answers only where the shape says nothing: after an Undo of a save, the copy here holds
   * FLEx's text as it was after that save, and its words carry places that text had. */
  const aligned = new Map();
  const pairUp = (cw, bw) => {
    if (cw.length !== bw.length) return;
    cw.forEach((w, i) => { if (!w.punct && !bw[i].punct && keyOf.has(bw[i])) aligned.set(w, keyOf.get(bw[i])); });
  };
  for (const [sg, pieces] of splitPieces) pairUp(pieces.flatMap(wordsOf), wordsOf(baseLines.get(sg).seg));
  for (const [sg, from] of joinedFrom) { const i = curIndexOf.get(sg); if (i != null) pairUp(wordsOf(cur.paragraphs[i].segments[0]), from.flatMap(wordsOf)); }
  cur.paragraphs.forEach((line) => {
    const seg = line.segments[0];
    const sg = seg && segGuid(seg);
    if (!seg || structural.has(sg) || !baseLines.has(sg)) return;
    const bw = wordsOf(baseLines.get(sg).seg), cw = wordsOf(seg);
    if (cw.length === bw.length) { pairUp(cw, bw); return; }
    const we = wordLevelEdit(bw.map((w) => w.txt || ''), cw.map((w) => w.txt || ''));
    // the base place of the word now at j, around the one word edit (null: a word made by it)
    const from = (j) => {
      if (!we) return null;
      if (we.kind === 'split') return j < we.index ? j : j > we.index + 1 ? j - 1 : null;
      if (we.kind === 'join') return j < we.index ? j : j > we.index ? j + 1 : null;
      return j < we.at ? j : j > we.at ? j - 1 : null;   // insert
    };
    cw.forEach((w, j) => { const k = from(j); if (k != null && !w.punct && bw[k] && !bw[k].punct && keyOf.has(bw[k])) aligned.set(w, keyOf.get(bw[k])); });
  });
  const identityOf = (w, sgNow) => (aligned.has(w) ? aligned.get(w) : identity(w, sgNow));
  cur.paragraphs.forEach((line) => {
    const seg = line.segments[0];
    if (!seg) return;
    const sg = segGuid(seg);
    (seg.words || []).forEach((w, idx) => {
      if (w.punct) return;
      const now = glossMap(w, curPrim);
      const key = identityOf(w, sg);
      const b = key && occ.get(key);
      if (b && (b.w.txt || '') === (w.txt || '')) {
        const forms = changedIn(glossMap(b.w, basePrim), now);
        if (Object.keys(forms).length) {
          const op = { op: 'gloss.set', paraGuid: b.pg, segGuid: b.sg, index: b.idx, forms };
          // a word FLEx was guessing for (open_text's flex.guess): the gloss builds on that guess (glosses.py)
          const gs = b.w.flex && b.w.flex.analysisKind === 'wordform' && b.w.flex.guess;
          if (gs && gs.analysisGuid) op.guess = { analysisGuid: gs.analysisGuid, glossGuid: gs.glossGuid || null };
          ops.push(op);
          touched.add(b.pg);
        }
        return;
      }
      if (!Object.keys(now).length) return;   // a new word with no gloss: FLEx leaves it unglossed too
      const bl = baseLines.get(sg);
      if (!bl || structural.has(sg)) { unsupported.push({ why: 'newWordGloss', segGuid: sg, paraGuid: paraOf(line) }); return; }
      ops.push({ op: 'gloss.set', paraGuid: bl.group.key, segGuid: sg, index: idx, forms: now, newWord: true, form: w.txt || '' });
      touched.add(bl.group.key);
    });
  });

  // ---- media
  const anyTimes = ops.some((o) => o.op === 'times.set' && o.begin != null) || ops.some((o) => o.op === 'phrase.split' && o.times);
  const hasMedia = !!(base.flex && base.flex.media && base.flex.media.length);
  if (opts.relink) ops.unshift({ op: 'media.relink', uriGuid: opts.relink.uriGuid, path: opts.relink.path });
  else if (anyTimes && !hasMedia && opts.media) ops.unshift({ op: 'media.attach', path: opts.media });
  else if (anyTimes && !hasMedia) unsupported.push({ why: 'timesNeedMedia' });

  // dedupe (a times.set and a phrase.split on the same seg both set times → the split wins)
  // `baseOf(word, its phrase's guid)` → where the base holds that word ({ w, sg, pg, idx }), or null for a
  // word made here — the reading the gloss ops were made from (postStateOf and the merge use it too)
  const baseOf = (w, sgNow) => { const k = identityOf(w, sgNow); return (k && occ.get(k)) || null; };
  return { ops, touched, unsupported, baseOf };
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

/* The intended post-state per touched FLEx paragraph (what preview_save receives beside the ops): each
 * word's gloss and each phrase's free translation in EVERY analysis writing system the doc carries —
 * the shell compares each one with FLEx after the write, so a writing system nobody edited that changed
 * anyway rolls the save back. The occurrence FLEx holds is promised only for a word the base had,
 * unchanged in form and gloss; a word made here, or glossed anew, is LCM's to assign. FLEx's § marks are
 * its structure, not text: a join removes the one between two phrases (the shell compares a phrase-final
 * run away on both sides). */
export function postStateOf(cur, touched, base) {
  const baseOf = base ? diffFlexDoc(base, cur).baseOf : () => null;
  const basePrim = (base && base.analLang) || cur.analLang || 'en', curPrim = cur.analLang || basePrim;
  const out = {};
  cur.paragraphs.forEach((ln, li) => {
    const pg = paraOf(ln);
    if (!touched.has(pg)) return;
    const seg = ln.segments[0];
    const sg = segGuid(seg);
    const span = (cur.segments || [])[li];
    const t = timesOf(seg, span);
    const words = (seg.words || []).filter((w) => !isBoundaryMarker(w));
    (out[pg] = out[pg] || []).push({
      segGuid: sg,
      text: words.map((w) => w.txt).join(' '),
      words: words.map((w) => {
        if (w.punct) return { txt: w.txt, punct: true, gls: '', glosses: {}, analysisGuid: null };
        const g = glossMap(w, curPrim);
        const b = baseOf(w, sg);
        const keep = b && (b.w.txt || '') === (w.txt || '') && sameMap(glossMap(b.w, basePrim), g) && b.w.flex && b.w.flex.analysisGuid;
        return { txt: w.txt, punct: false, gls: g[curPrim] || '', glosses: g, analysisGuid: keep ? b.w.flex.analysisGuid : null };
      }),
      ft: freeMap(seg, curPrim), lt: {},
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
    /* A label segment FLEx already has — a hard line break, a line of only punctuation (model.py `readOnly`) —
     * has no letters and never had: FLEx made it, and refusing it refused every save that touched its paragraph.
     * One the user has typed words into is judged like any phrase. */
    if (seg && seg.readOnly && !wordsOf(seg).some((w) => !w.punct)) return;
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
    const d = diffFlexDoc(rec.flex.base, stripFlexPadding(rec.flex.base, rec.doc), { ws: rec.doc.analLang });
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

/* ---- check-in with a merge (plans/flex-desktop-segmenter.md §4.5) ---------------------------------------
 * Seth, 2026-10-16: "for now a check-out and check-in with the original (before changes) version saved for
 * comparison and diff/merge … We don't want to use flextext format import/export because that round-trip
 * isn't reliable. We want to just compare before and after our edits and change JUST what we change."
 *
 * mergeFlexDocs(base, ours, theirs, { prefer }) → { doc, conflicts, theirs }
 *   base   — the text as it was checked out (rec.flex.base)
 *   ours   — the work done here since (rec.doc)
 *   theirs — the text in FLEx now
 * `doc` is THEIRS with our changes on it, so diffFlexDoc(theirs, doc) is exactly our changes: a save
 * writes those and FLEx keeps everything else it has, its own changes since the check-out included.
 * Compared cell by cell, keyed by GUIDs, never by position alone — and every analysis writing system is
 * its own cell (2026-10-16): English edited here and Indonesian edited in FLEx are both kept:
 *   - a phrase's times and its free translation in each writing system, which belong to the FLEx segment
 *     — so they still apply after FLEx reworded its words, as long as FLEx kept the segment where it was
 *     (the same phrases either side of it);
 *   - each word's gloss in each writing system, which belongs to a word at a place — only while FLEx kept
 *     the phrase's words;
 *   - the shape: which phrases a paragraph holds and their words. A paragraph reshaped here (a split, a
 *     join, a word split or joined) goes in as reshaped here only if FLEx still has it exactly as checked
 *     out — its phrases and words, and the times and free translations of every phrase reshaped here (a
 *     split's halves share what was one translation: FLEx's new one cannot be laid on one half). FLEx's
 *     glosses, and its changes to the phrases not reshaped, are taken across. Else the reshaping is a
 *     conflict, and the paragraph stays as FLEx has it.
 * A cell changed on one side takes that side; on both to the same value, that value; to different values
 * it is a CONFLICT, and FLEx's value stays — unless `prefer: 'mine'`, which takes ours for a conflict that
 * can take it (`forceable`). Everything this app does not edit (literal translations, notes, paragraphs
 * FLEx added) is FLEx's. `theirs` counts the phrases FLEx changed, for the preview. Pure: nothing here
 * writes anything. */
export function mergeFlexDocs(base, ours, theirs, opts = {}) {
  const mine = opts.prefer === 'mine';
  const cl = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  // every gloss and translation with its language spelled out, so a doc's own analysis language (which
  // a slot with none is in) cannot be mistaken for another doc's
  const pin = (doc) => {
    const d = cl(doc) || {}, p = d.analLang || 'en';
    (d.paragraphs || []).forEach((ln) => (ln.segments || []).forEach((sg) => {
      if ((sg.free || '') && !sg.freeLang) sg.freeLang = p;
      (sg.words || []).forEach((w) => { if ((w.gls || '') && !w.glsLang) w.glsLang = p; });
    }));
    return d;
  };
  base = pin(base); ours = pin(ours); theirs = pin(theirs);
  const P = (doc) => doc.analLang || 'en';
  const outPrim = P(theirs);
  const conflicts = [];
  const at = (doc) => {
    const m = new Map();
    (doc.paragraphs || []).forEach((ln, li) => {
      const seg = ln.segments && ln.segments[0];
      const g = segGuid(seg);
      if (g) m.set(g, { li, ln, seg, span: (doc.segments || [])[li], pg: paraOf(ln), prim: P(doc) });
    });
    return m;
  };
  const B = at(base), O = at(ours), T = at(theirs);
  const formsOf = (seg) => lexForms(seg).join('\u0001');
  const groupsOf = (doc) => groups(doc).map((g) => ({ key: g.key, segs: g.lines.map((li) => segGuid(doc.paragraphs[li].segments[0])) }));
  const bG = groupsOf(base), oG = groupsOf(ours), tG = groupsOf(theirs);
  const byKey = (gs) => { const m = new Map(); gs.forEach((g) => { if (g.key != null) m.set(g.key, m.has(g.key) ? null : g); }); return m; };
  const bK = byKey(bG), oK = byKey(oG), tK = byKey(tG);
  const sameList = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  // a paragraph as checked out: the same phrases in the same order, each with the same words
  const kept = (bg, g, I) => !!g && sameList(bg.segs, g.segs) && bg.segs.every((s) => I.has(s) && formsOf(I.get(s).seg) === formsOf(B.get(s).seg));
  // FLEx kept this segment where it was: the same paragraph, the same phrases either side of it
  const sameSpot = (s) => {
    const b = B.get(s), t = T.get(s);
    if (!b || !t || b.pg !== t.pg) return false;
    const bs = bK.get(b.pg), ts = tK.get(t.pg);
    if (!bs || !ts) return false;
    const i = bs.segs.indexOf(s), j = ts.segs.indexOf(s);
    return bs.segs[i - 1] === ts.segs[j - 1] && bs.segs[i + 1] === ts.segs[j + 1];
  };
  const lineNo = (s) => (O.has(s) ? O.get(s).li + 1 : null);
  const tm = (I, s) => { const x = I.get(s); return x ? timesOf(x.seg, x.span) : null; };
  const fm = (I, s) => { const x = I.get(s); return x ? freeMap(x.seg, x.prim) : {}; };
  const V = (m, l) => (m && m[l]) || '';
  const langsOf = (...ms) => [...new Set(ms.flatMap((m) => Object.keys(m || {})))].sort();
  const conflict = (c) => conflicts.push(c);

  // ---- the paragraphs reshaped here, gathered into regions that must go in whole
  const reshaped = new Set();
  bG.forEach((bg) => { if (bg.key != null && !kept(bg, oK.get(bg.key), O)) reshaped.add(bg.key); });
  oG.forEach((g) => { if (g.key != null && !bK.has(g.key)) reshaped.add(g.key); });   // a Sentence break made here
  const up = new Map();
  const find = (k) => { let r = k; while (up.has(r) && up.get(r) !== r) r = up.get(r); return r; };
  const join = (a, b) => {
    for (const k of [a, b]) if (!up.has(k)) up.set(k, k);
    const ra = find(a), rb = find(b);
    if (ra !== rb) up.set(ra, rb);
  };
  reshaped.forEach((k) => { if (!up.has(k)) up.set(k, k); });
  // a line now in another paragraph than the one its phrase came from (a new phrase: from the one before)
  let origin = null;
  (ours.paragraphs || []).forEach((ln) => {
    const s = segGuid(ln.segments[0]);
    if (s && B.has(s)) origin = B.get(s).pg;
    const k = paraOf(ln);
    if (origin != null && k != null && k !== origin) join(k, origin);
  });
  // a phrase joined into the one before it here: its paragraph goes with the survivor's
  const order = (base.paragraphs || []).map((ln) => segGuid(ln.segments[0])).filter(Boolean);
  order.forEach((s, i) => {
    if (O.has(s)) return;
    for (let j = i - 1; j >= 0; j--) {
      if (O.has(order[j])) { if (B.get(s).pg !== B.get(order[j]).pg) join(B.get(s).pg, B.get(order[j]).pg); break; }
    }
  });
  const regions = new Map();
  reshaped.forEach((k) => {
    const r = find(k);
    if (!regions.has(r)) regions.set(r, { keys: new Set(), bad: null });
    regions.get(r).keys.add(k);
  });
  for (const reg of regions.values()) {
    for (const k of reg.keys) if (!up.has(k)) up.set(k, k);
    const inBase = bG.filter((g) => reg.keys.has(g.key));
    for (const bg of inBase) {
      if (!tK.get(bg.key)) { reg.bad = 'gone'; break; }
      if (!kept(bg, tK.get(bg.key), T)) { reg.bad = 'structure'; break; }
      // a phrase reshaped here (gone into another, or its words changed) whose times or translations FLEx changed
      if (bg.segs.some((s) => (!O.has(s) || formsOf(O.get(s).seg) !== formsOf(B.get(s).seg))
          && (!sameMap(fm(T, s), fm(B, s)) || !sameTimes(tm(T, s), tm(B, s))))) { reg.bad = 'structure'; break; }
    }
    if (!reg.bad) {
      // …and FLEx still has them side by side, in the same order
      const pos = inBase.map((bg) => tG.indexOf(tK.get(bg.key)));
      if (pos.some((p, i) => i > 0 && p !== pos[i - 1] + 1)) reg.bad = 'structure';
    }
    if (reg.bad) {
      const lines = (ours.paragraphs || []).map((ln, li) => (reg.keys.has(paraOf(ln)) ? li + 1 : null)).filter(Boolean);
      conflict({ kind: reg.bad, line: lines[0] || null, lines, paraGuid: inBase.length ? inBase[0].key : null, forceable: false });
    }
  }
  const regionOf = (k) => (reshaped.has(k) ? regions.get(find(k)) : null);

  // ---- cells
  const setTimes = (ln, holder, from) => {
    const a = ln.segments[0].attrs = ln.segments[0].attrs || {};
    const fa = from.seg.attrs || {};
    for (const k of ['begin-time-offset', 'end-time-offset']) { if (fa[k] != null) a[k] = fa[k]; else delete a[k]; }
    holder.span = cl(from.span);
  };
  let theirsChanged = 0;
  const theirsTouched = (s) => {
    const b = B.get(s), t = T.get(s);
    if (!b || !t) return true;
    if (formsOf(b.seg) !== formsOf(t.seg) || !sameMap(fm(B, s), fm(T, s)) || !sameTimes(tm(B, s), tm(T, s))) return true;
    const bw = wordsOf(b.seg), tw = wordsOf(t.seg);
    return bw.some((w, i) => !sameMap(glossMap(w, b.prim), tw[i] ? glossMap(tw[i], t.prim) : {}));
  };
  T.forEach((_, s) => { if (theirsTouched(s)) theirsChanged++; });
  B.forEach((_, s) => { if (!T.has(s)) theirsChanged++; });

  /* One cell, three ways → the side whose value it takes: 'o' (here) or 't' (FLEx). `oc`/`tc`: changed
   * here / in FLEx since the check-out; `same`: both now hold the same value; `can`: ours can be laid on
   * FLEx's text at all (else changing it here is a conflict nobody can force). */
  const side = (oc, tc, same, can, c) => {
    if (!oc) return 't';
    if (!can) { conflict({ ...c, forceable: false }); return 't'; }
    if (!tc || same) return 'o';
    conflict({ ...c, forceable: true });
    return mine ? 'o' : 't';
  };
  // a cell per writing system: `b`, `o`, `t` are {ws: text} maps (`t` null when FLEx's cannot be read
  // here), `put(ws, text)` lays the side that wins onto the merged copy when it is not the copy's own
  const perWs = (b, o, t, can, c, keepSide, put) => {
    for (const l of langsOf(b, o, t || {})) {
      const vb = V(b, l), vo = V(o, l), vt = t ? V(t, l) : null;
      const s = side(vo !== vb, vt !== vb, vt === vo, can, { ...c, ws: l });
      if (s !== keepSide) put(l, s === 'o' ? vo : vt);
    }
  };

  // ---- a paragraph not reshaped here: FLEx's lines, with the cells changed here laid over them
  const overlayTheirs = (ln, holder, s) => {
    const b = B.get(s), o = O.get(s), t = T.get(s);
    if (!b || !o) return;
    const spot = sameSpot(s);
    const c = { segGuid: s, paraGuid: t.pg, line: lineNo(s) };
    const tb = tm(B, s), to = tm(O, s), tt = tm(T, s);
    if (side(!sameTimes(to, tb), !sameTimes(tt, tb), sameTimes(tt, to), spot, { ...c, kind: 'times' }) === 'o') setTimes(ln, holder, o);
    perWs(fm(B, s), fm(O, s), fm(T, s), spot, { ...c, kind: 'free' }, 't', (l, v) => setFreeIn(ln.segments[0], l, v, outPrim));
    const bw = wordsOf(b.seg), ow = wordsOf(o.seg), mw = wordsOf(ln.segments[0]);
    const wordsKept = formsOf(t.seg) === formsOf(b.seg);
    ow.forEach((w, i) => {
      if (w.punct || !bw[i]) return;
      perWs(glossMap(bw[i], b.prim), glossMap(w, o.prim), wordsKept && mw[i] ? glossMap(mw[i], t.prim) : null, wordsKept,
        { ...c, kind: 'gloss', word: i + 1 }, 't', (l, v) => setGlossIn(mw[i], l, v, outPrim));
    });
  };
  // ---- a paragraph reshaped here: OUR lines, with FLEx's changes to the cells we left alone taken over.
  // Which checked-out word each of ours is: the diff's reading of the reshaping; FLEx's word is at the same
  // place (the region passed only if FLEx kept those phrases' words exactly as checked out).
  const baseOfOurs = diffFlexDoc(base, ours).baseOf;
  const overlayOurs = (ln, holder, s) => {
    const seg = ln.segments[0];
    const b = B.get(s), t = T.get(s);
    if (b && t) {
      // the region passed only if FLEx left the times and translations of every phrase reshaped here
      // alone, so a cell here is either one FLEx did not change or one of a phrase not reshaped here
      const c = { segGuid: s, paraGuid: t.pg, line: lineNo(s) };
      const tb = tm(B, s), to = timesOf(seg, holder.span), tt = tm(T, s);
      if (side(!sameTimes(to, tb), !sameTimes(tt, tb), sameTimes(tt, to), true, { ...c, kind: 'times' }) === 't') setTimes(ln, holder, t);
      perWs(fm(B, s), freeMap(seg, P(ours)), fm(T, s), true, { ...c, kind: 'free' }, 'o', (l, v) => setFreeIn(seg, l, v, outPrim));
      // what this app never edits is FLEx's: literal translations, notes
      seg.lits = cl(t.seg.lits);
      if (t.seg.flex) seg.flex = { ...(seg.flex || {}), notes: cl(t.seg.flex.notes) };
    }
    const sg = segGuid(seg);
    wordsOf(seg).forEach((w, i) => {
      if (w.punct) return;
      const from = baseOfOurs(w, sg);
      const tw = from && T.has(from.sg) ? (T.get(from.sg).seg.words || [])[from.idx] : null;
      if (!from || !tw || (from.w.txt || '') !== (w.txt || '') || (tw.txt || '') !== (w.txt || '')) return;
      // the occurrence is FLEx's as it is now, so a gloss left as FLEx has it is FLEx's own
      w.flex = { ...(w.flex || {}), ...(tw.flex || {}) };
      if (tw.guid) w.guid = tw.guid;
      perWs(glossMap(from.w, P(base)), glossMap(w, P(ours)), glossMap(tw, P(theirs)), true,
        { segGuid: sg, paraGuid: paraOf(ln), line: lineNo(sg), kind: 'gloss', word: i + 1 }, 'o', (l, v) => setGlossIn(w, l, v, outPrim));
    });
  };

  // ---- the merged text, in FLEx's paragraph order
  const out = [], spans = [];
  const emitted = new Set();
  for (const tg of tG) {
    const reg = regionOf(tg.key);
    if (reg && !reg.bad) {
      if (emitted.has(reg)) continue;
      emitted.add(reg);
      (ours.paragraphs || []).forEach((oln, li) => {
        if (!reg.keys.has(paraOf(oln))) return;
        const ln = cl(oln), holder = { span: cl((ours.segments || [])[li]) };
        overlayOurs(ln, holder, segGuid(ln.segments[0]));
        out.push(ln); spans.push(holder.span);
      });
      continue;
    }
    for (const s of tg.segs) {   // FLEx's paragraph (a reshaping that conflicted leaves it as FLEx has it)
      const t = T.get(s);
      const ln = cl(t.ln), holder = { span: cl(t.span) };
      if (!reg) overlayTheirs(ln, holder, s);
      out.push(ln); spans.push(holder.span);
    }
  }
  // work here on phrases FLEx no longer has
  O.forEach((o, s) => {
    const b = B.get(s);
    if (!b || T.has(s) || regionOf(b.pg)) return;
    const changed = !sameTimes(tm(O, s), tm(B, s)) || !sameMap(fm(O, s), fm(B, s))
      || wordsOf(o.seg).some((w, i) => !sameMap(glossMap(w, o.prim), wordsOf(b.seg)[i] ? glossMap(wordsOf(b.seg)[i], b.prim) : {}));
    if (changed) conflict({ kind: 'gone', segGuid: s, paraGuid: b.pg, line: lineNo(s), forceable: false });
  });
  const doc = cl({ ...theirs, paragraphs: [], segments: [] });
  doc.paragraphs = out;
  doc.segments = spans;
  return { doc, conflicts, theirs: theirsChanged };
}

/* ---- the FLEx text list, sorted and filtered (plan §11.1) ---------------------------------------------
 * Seth, 2026-10-16: "sorting options for texts, including open/pending edits, most recently opened/edited
 * (in this app, in FLEx), alphabetical, date created, etc. Also ability to filter (including by genre or
 * checkbox)."
 *   rows: [{ guid, title, flexIndex, created, modified (FLEx's, epoch ms), genres: [{guid, name}], segs,
 *            timedSegs, pending (work here not in FLEx), openedAt (here), recording (here), checked }]
 *   view: { sort: one of TEXT_SORTS, reverse, genre: '' (all) | 'none' | a genre guid, q (title search,
 *           accents and case ignored), only: { pending, checked, opened, recording, untimed } }
 * → the rows to show, in order. Title by default: the order FLEx hands texts over in is its own storage
 * order (GUIDs), not one a person chose. Each sort has its natural direction (latest, newest, least timed first);
 * `reverse` turns it round, and a row with nothing to sort by (never opened here, no date in FLEx) stays
 * at the end either way. Ties go by title, numbers as numbers ("Text 9" before "Text 10"). Pure. */
export const TEXT_SORTS = ['title', 'pending', 'opened', 'changed', 'created', 'timed'];
export function arrangeTexts(rows, view = {}) {
  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const q = fold(view.q).trim();
  const only = view.only || {};
  const shown = (rows || []).filter((r) => {
    const genres = r.genres || [];
    if (q && !fold(r.title).includes(q)) return false;
    if (view.genre === 'none' && genres.length) return false;
    if (view.genre && view.genre !== 'none' && !genres.some((g) => g.guid === view.genre)) return false;
    if (only.pending && !r.pending) return false;
    if (only.checked && !r.checked) return false;
    if (only.opened && !r.openedAt) return false;
    if (only.recording && !r.recording) return false;
    if (only.untimed && !(r.segs > 0 && (r.timedSegs || 0) < r.segs)) return false;
    return true;
  });
  const title = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' })
    || (a.flexIndex || 0) - (b.flexIndex || 0);
  // a key and its natural direction (-1: largest first); no key → last, whichever way round
  const by = (key, dir) => (a, b) => {
    const x = key(a), y = key(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return x === y ? 0 : (x < y ? -1 : 1) * dir;
  };
  const flip = view.reverse ? -1 : 1;
  const sorts = {
    pending: [by((r) => (r.pending ? 1 : 0), -flip), by((r) => r.openedAt || null, -1), title],
    opened: [by((r) => r.openedAt || null, -flip), title],
    changed: [by((r) => r.modified || null, -flip), title],
    title: [(a, b) => flip * title(a, b)],
    created: [by((r) => r.created || null, -flip), title],
    timed: [by((r) => (r.segs > 0 ? (r.timedSegs || 0) / r.segs : null), flip), title],
  };
  const chain = sorts[view.sort] || sorts.title;
  return shown.slice().sort((a, b) => { for (const c of chain) { const d = c(a, b); if (d) return d; } return 0; });
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

/* ---- what a failed FLEx call tells the user (Seth, 2026-10-16: three real-FLEx failures in a row said
 * "rolled back" or "FLEx reported a problem saving" when the project had in fact been CLOSED unsaved by
 * the shell's own check) — PURE: `T(key, vars)` is the caller's translator. */

/* The error that closed the project, when this one did or follows one that did: the shell closes a
 * session WITHOUT saving whenever a write cannot be confirmed (detail.closed), and every later call
 * answers E_POISONED carrying that cause. */
export function flexClosedBy(e) {
  if (!e) return null;
  const d = e.detail || {};
  if (e.code === 'E_POISONED') return d.cause || { code: e.code, message: e.message, detail: {} };
  return d.closed ? e : null;
}
// codes whose own message already says nothing was written (no "Nothing was written" before them)
const SAYS_NOTHING_WRITTEN = new Set(['E_INVARIANT', 'E_STALE_BASE', 'E_BACKUP_FAILED']);
// codes whose shell message says WHY, in words worth showing beside the translated one
const WHY_CODES = new Set(['E_INVARIANT', 'E_SAVE_FAILED', 'E_DISK_CHECK_FAILED', 'E_DATA_CHECK_FAILED', 'E_ROLLBACK_INCOMPLETE', 'E_BACKUP_FAILED', 'E_IMPORT_INVALID', 'E_INTERNAL']);

export function flexFailText(e, afterWrite, T) {
  const code = (e && e.code) || 'E_INTERNAL';
  const closed = flexClosedBy(e);
  if (closed) {
    // never "rolled back" and never "nothing changed" alone: the project is CLOSED and must be reopened
    const d = (e && e.detail) || {};
    const f = d.failedFile || (closed.detail && closed.detail.failedFile) || '';
    let msg = T(f ? 'flex.closedSetAside' : 'flex.closedUnsaved', { f });
    if (d.backup) msg += ' ' + T('flex.closedBackup', { b: d.backup });
    if (closed.message) msg += ' ' + T('flex.why', { why: closed.message });
    return msg;
  }
  let msg = T('flex.err.' + code, (e && e.detail) || undefined);
  if (msg === 'flex.err.' + code) msg = T('flex.err.E_INTERNAL');
  if (afterWrite && !SAYS_NOTHING_WRITTEN.has(code)) msg = T('flex.nothingWritten') + ' ' + msg;
  if (e && e.message && WHY_CODES.has(code)) msg += ' ' + T('flex.why', { why: e.message });
  return msg;
}
