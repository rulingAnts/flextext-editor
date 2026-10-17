/* flextext.js — parse, serialize, tokenize, segment, and reconcile FLEx flextext documents.
 *
 * Format reference: FlexInterlinear.xsd (FieldWorks, DistFiles/Language Explorer/
 * Export Templates/Interlinear). See docs/FlexInterlinear.xsd.
 *
 * Round-trip policy: anything this app does not edit (morphemes, pos items, notes,
 * literal translations, objects, media-files, unknown items/attributes) is preserved
 * as serialized XML fragments and re-emitted, except for words/segments the user
 * actually changed in the baseline (where stale analyses are dropped, as FLEx does).
 */

// segments.js is pure and imports nothing, so this adds no cycle and no new SHELL entry (it is already
// precached everywhere app.js is). The per-edge estimate rules live there, once.
import { isAligned, isEstimate, edgeGuessed, estimateEdges, withGuesses, settleSpan, storableSegments, seedsToPending } from './segments.js';

export const APP_ITEM_TYPES = new Set(['txt', 'gls', 'segnum', 'punct']);

export function newGuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ESC[c]); }

/* ---------------- Tokenization & segmentation ---------------- */

// Characters that count as part of a word (letters, marks, digits, common
// word-internal punctuation used in orthographies).
const WORD_CHAR = /[\p{L}\p{M}\p{N}'’ʼ‘\-_=ʔ]/u;

/* ⚠ THE WORD-FORMING SET CAN BE WIDENED, NEVER NARROWED (seg-word-split, plan
 * flex-desktop-segmenter.md §4.3 item 5). FLEx decides what is word-forming PER WRITING SYSTEM —
 * `IsWordForming` plus the WS's own character-set overrides — so an orthography that writes a
 * glottal stop as `7` or a tone letter as `ꜝ` tokenises differently in FLEx than the Unicode rule
 * above would. A FLEx-bound doc (the desktop shell's `open_project` returns each WS's extra
 * word-forming characters) must tokenise the way FLEx will, or every word-level diff is off by one.
 *
 * Two routes, both ADDITIVE: `tokenize(text, { wordChars })` for one call, or
 * `setExtraWordForming(chars)` for the module default (the shell sets it once per open project;
 * `setExtraWordForming('')` clears it). With neither, the default is exactly what it has always
 * been — the web app's behaviour does not change by this existing. */
let EXTRA_WORD_CHARS = new Set();
export function setExtraWordForming(chars) {
  EXTRA_WORD_CHARS = new Set(Array.from(chars || []).filter((c) => c && !/\s/u.test(c)));
  return EXTRA_WORD_CHARS.size;
}
export function isWordForming(ch, extra) {
  if (WORD_CHAR.test(ch)) return true;
  if (extra) { for (const c of extra) if (c === ch) return true; }
  return EXTRA_WORD_CHARS.has(ch);
}

// Split a paragraph's text into sentence segments, FLEx-style:
// a segment ends after sentence-final punctuation (. ! ? …) plus any
// trailing closing quotes/brackets.
export function segmentText(text) {
  const segs = [];
  const re = /[^.!?…]*[.!?…]+["'”’)\]»]*\s*|[^.!?…]+$/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++; // safety
    const t = m[0].trim();
    if (t) segs.push(t);
    if (m[0] === '') break;
  }
  return segs;
}

// Tokenize a segment into word and punctuation tokens.
// Consecutive punctuation characters group into a single punct token.
// `opts.wordChars` (iterable of characters) widens the word-forming set for this call only.
export function tokenize(text, opts = {}) {
  const tokens = [];
  const extra = opts && opts.wordChars ? Array.from(opts.wordChars) : null;
  let cur = '';
  let curPunct = '';
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      if (cur) { tokens.push({ txt: cur, punct: false }); cur = ''; }
      if (curPunct) { tokens.push({ txt: curPunct, punct: true }); curPunct = ''; }
    } else if (isWordForming(ch, extra)) {
      if (curPunct) { tokens.push({ txt: curPunct, punct: true }); curPunct = ''; }
      cur += ch;
    } else {
      if (cur) { tokens.push({ txt: cur, punct: false }); cur = ''; }
      curPunct += ch;
    }
  }
  if (cur) tokens.push({ txt: cur, punct: false });
  if (curPunct) tokens.push({ txt: curPunct, punct: true });
  return tokens;
}

/* ---------------- The § boundary marker (seg-word-split; plan §4.3 item 2, §6.1) ----------------
 *
 * FLEx's segment breaker treats U+00A7 `§` as an end-of-sentence character: a forced phrase break
 * where the text has no punctuation. FLEx's own .flextext IMPORTER writes one after every phrase
 * that does not already end in `. ! ?` [source + verified on FW 9.3.12], so a text that has been
 * through FLEx carries hundreds of them as phrase-final punct items — and a text the desktop shell
 * reads straight out of a FLEx project carries them in its baselines.
 *
 * They are structure, not text. The engine therefore HIDES a phrase-final § in every word-level
 * view, never offers it for editing, and round-trips it UNCHANGED: it stays a punct word in
 * `seg.words` and in `seg.baseline`, so serializeFlextext writes exactly what was read. A § the
 * shell's own split recipe inserts (plan §6.3) is the same item.
 *
 * "Phrase-final" means: the item, and everything after it in the phrase, is punctuation. A § with a
 * word after it inside one phrase cannot come from FLEx (FLEx would have broken the phrase there)
 * and is shown as the text it is — see the internal end-of-sentence warning below. */
export const BOUNDARY_MARKER = '§';
export function isBoundaryMarker(w) {
  return !!(w && w.punct && String(w.txt || '').trim() === BOUNDARY_MARKER);
}
/* Flag the phrase-final § items of a phrase (idempotent). parsePhrase calls it; the shell's reader
 * sets the same flag (plan §4.1). */
export function markBoundaryMarkers(seg) {
  const words = (seg && seg.words) || [];
  let tail = true;
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    if (!w.punct) tail = false;
    if (isBoundaryMarker(w)) { if (tail) w.boundaryMarker = true; else delete w.boundaryMarker; }
  }
  return seg;
}
/* The words a word-level view shows: everything but a phrase-final §. */
export function visibleWords(seg) {
  const words = (seg && seg.words) || [];
  if (!words.some(isBoundaryMarker)) return words;
  markBoundaryMarkers(seg);
  return words.filter((w) => !w.boundaryMarker);
}
/* A phrase's baseline as the classic text box shows it: a trailing § (with the space before it) is
 * taken off. restoreBoundaryMarkers puts it back on an unchanged line. */
export function displayBaseline(text) {
  return String(text || '').replace(/\s*§+\s*$/u, '');
}
export function getDisplayParagraphs(doc) {
  return doc.paragraphs.map((p) => p.segments.map((s) => displayBaseline(s.baseline)).join(' ').trim());
}
/* Text typed back from the box, line by line, with each UNCHANGED line's § restored — so a line the
 * user did not touch reconciles as kept, marker and all, while a line they edited is their text (a
 * baseline edit; FLEx re-derives its own breaks from it, and a FLEx-bound doc diffs it as one). */
export function restoreBoundaryMarkers(doc, texts) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const shown = getDisplayParagraphs(doc);
  const full = getBaselineParagraphs(doc);
  return texts.map((t, i) => (i < shown.length && norm(t) === norm(shown[i]) && shown[i] !== full[i] ? full[i] : t));
}

/* ---------------- FLEx-bound warnings (seg-word-split; plan §4.3 item 3, §6.1, §6.8) ----------------
 *
 * Computed everywhere (they are facts about the text); SHOWN only where the doc is FLEx-bound and
 * BLOCKING only in the desktop shell's Save to FLEx. Two conditions FLEx's segment breaker would act
 * on [source: SegmentBreaker in liblcm]:
 *   noWordChar  — the phrase has no word-forming character. FLEx cannot make it a segment (it joins
 *                 the next), so its times and free translation would land on the wrong text. The
 *                 Segmenter makes such lines on purpose (a timed, not-yet-transcribed span): they stay
 *                 in the editor until text is typed or the user merges them (Decision D4).
 *   internalEos — an end-of-sentence character followed, after optional closing marks and space, by
 *                 a word-forming character INSIDE one phrase. FLEx will split there: a timed segment
 *                 followed by an untimed one, and the free translation on the first half only.
 * The EOS list is FLEx's fixed one, not per WS: `! . ?`, their script variants, `‼ ‽ ⁇ ⁈ ⁉` and §.
 * A period between digits (3.5), an exact three-dot ellipsis, or a period right after another one
 * does not break; four periods do. */
export const FLEX_EOS = /[.!?§؟।॥‼‽⁇⁈⁉。！．？｡]/u;
export const FLEX_CLOSERS = /["'”’)\]}»\s]/u;
export function flexPhraseWarnings(seg, opts = {}) {
  const out = [];
  const text = String((seg && seg.baseline) || '');
  const chars = Array.from(text);
  const wordChars = opts.wordChars || null;
  if (!chars.some((c) => isWordForming(c, wordChars))) { out.push({ code: 'noWordChar' }); return out; }
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!FLEX_EOS.test(c)) continue;
    if (c === '.') {
      const prev = chars[i - 1], next = chars[i + 1];
      if (prev === '.' ) continue;                                   // a run: judged at its first dot
      if (/\p{N}/u.test(prev || '') && /\p{N}/u.test(next || '')) continue;   // 3.5
      let run = 1; while (chars[i + run] === '.') run++;
      if (run === 3) { i += 2; continue; }                           // an exact ellipsis
      if (run === 2) { i += 1; continue; }                           // a period after a period
      i += run - 1;
    }
    // skip closers and whitespace; a following word-forming character means FLEx breaks here
    let j = i + 1, sawSpace = false;
    while (j < chars.length && FLEX_CLOSERS.test(chars[j])) { if (/\s/u.test(chars[j])) sawSpace = true; j++; }
    if (j < chars.length && isWordForming(chars[j], wordChars) && (sawSpace || c !== '.')) {
      /* a break also needs a word-forming character BEFORE it */
      if (chars.slice(0, i).some((x) => isWordForming(x, wordChars))) out.push({ code: 'internalEos', at: i, char: c });
    }
  }
  return out;
}
export function flexDocWarnings(doc, opts = {}) {
  const out = [];
  (doc && doc.paragraphs || []).forEach((p, pi) => (p.segments || []).forEach((s, si) => {
    for (const w of flexPhraseWarnings(s, opts)) out.push({ para: pi, phrase: si, guid: s.attrs && s.attrs.guid, ...w });
  }));
  return out;
}

/* ---------------- Model constructors ---------------- */

export function makeWord(txt, opts = {}) {
  return {
    guid: newGuid(),
    punct: !!opts.punct,
    phrase: !!opts.phrase,     // chained multi-word phrase (word type="phrase")
    txt,
    gls: opts.gls ?? '',
    preservedXML: [],          // morphemes, pos items, unknown word children
  };
}

export function makeSegment(baselineText, words, opts = {}) {
  return {
    attrs: opts.attrs ?? { guid: newGuid() },
    baseline: baselineText,
    words,
    free: opts.free ?? '',
    freeLang: opts.freeLang ?? null,   // set on parse; null = use doc analysis lang
    preItemsXML: opts.preItemsXML ?? [],   // unknown items before <words>
    postItemsXML: opts.postItemsXML ?? [], // unknown items after <words> (notes, lit, other-lang free)
  };
}

/* Join phrases INTO ONE PHRASE — the matcher's text-side ⤴ (Seth: "join will join phrases").
 *
 * ⚠ Not "one paragraph holding both". That shape is exactly what normalizePhraseLines undoes on
 * the next open: it promotes every phrase back to its own paragraph and clears doc.segments to
 * re-derive them — which threw away the alignment the user had just committed, along with the
 * join itself. A join has to produce the shape the rest of the suite already reads as ONE line,
 * and that is one segment.
 *
 * What survives: every word (glosses ride on the word), the free translations joined with a space,
 * the first phrase's guid (the merged line IS the first phrase, extended), and every unknown item
 * from both sides — a note on the second phrase is not the matcher's to drop; a repeated item is
 * visible in FLEx, a vanished one is not. Time offsets become the union when both phrases carry
 * them, and are dropped when only one does: half an extent is not an extent.
 *
 * (Named for PHRASES: in this suite "segments" are the audio spans, and segments.js already owns a
 * mergeSegments for those — app.js imports both, so the names cannot collide.)
 *
 * ⚠ EACH FREE TRANSLATION BY ITS OWN LANGUAGE (Seth's FLEx round-trip report, 2026-10-17). The editable
 * slot (`free`/`freeLang`) holds ONE language, chosen at import by the DEVICE's analysis language — so two
 * phrases' slots can be in different languages. Joining the slots as one text under the first tag that
 * named one put "the older sibling … tree," (an English slot with no tag of its own) and "helping his
 * younger sister …" (English, an item beside an empty Indonesian slot) together as: Indonesian = the first
 * phrase's English, English = the second's alone. Now every language's text is the parts' texts in THAT
 * language, joined in order; the slot keeps the language of the first part that has one. `opts.prim` is
 * the document's analysis language — the language a slot with no tag of its own is in.
 *
 * And a hard line break (foldLineBreaks) BETWEEN the parts is gone — a merge across it removes it, as in
 * FLEx — while the first part's break before it and the last part's after it stay where they were. */
export function mergePhrases(segs, opts = {}) {
  const parts = (segs || []).filter(Boolean);
  if (!parts.length) return makeSegment('', []);
  if (parts.length === 1) return parts[0];
  /* ⚠ A HARD LINE BREAK IS NEVER THE SURVIVOR. A text stored before breaks were folded (foldLineBreaks) still
   * holds each as a line of its own, and joining it away is the only way past it — which gave the next phrase
   * the break's GUID (bug 1 of the FLEx round-trip report) and lost the break. So a break part rides on the
   * merge where it stood: before the first text part, or after the last; one BETWEEN two text parts goes, as a
   * merge across a break does in FLEx. Parts that are all breaks stay breaks: the first, the rest after it. */
  if (parts.some(isLineBreakPhrase)) {
    const texts = parts.filter((p) => !isLineBreakPhrase(p));
    const flat = (p) => [...(p.breaksBefore || []), bare(p), ...(p.breaksAfter || [])];
    if (!texts.length) {
      const [head, ...rest] = parts;
      return { ...bare(head), ...(head.breaksBefore ? { breaksBefore: head.breaksBefore.slice() } : {}),
        breaksAfter: [...(head.breaksAfter || []), ...rest.flatMap(flat)] };
    }
    const i0 = parts.indexOf(texts[0]), i1 = parts.lastIndexOf(texts[texts.length - 1]);
    const lead = parts.slice(0, i0).flatMap(flat), tail = parts.slice(i1 + 1).flatMap(flat);
    // one text part: a copy, its lists too — the phrase it was may be an undo step's, or the record's
    const one = texts[0];
    const seg = texts.length > 1 ? mergePhrases(texts, opts)
      : { ...one, words: (one.words || []).slice(), preItemsXML: (one.preItemsXML || []).slice(), postItemsXML: (one.postItemsXML || []).slice() };
    if (lead.length) seg.breaksBefore = [...lead, ...(seg.breaksBefore || [])];
    if (tail.length) seg.breaksAfter = [...(seg.breaksAfter || []), ...tail];
    return seg;
  }
  const [first] = parts, last = parts[parts.length - 1];
  // A slot with no tag is in the document's language. A caller that cannot say which (no `prim`) gets the
  // older reading: the first tag any part names, else en (setFreeIn's default).
  const prim = opts.prim || parts.map((s) => s.freeLang).find((l) => l) || 'en';
  const words = parts.flatMap((s) => s.words || []);
  const attrs = { ...(first.attrs || { guid: newGuid() }) };
  const begins = parts.map((s) => parseInt(s.attrs && s.attrs['begin-time-offset'], 10)).filter(Number.isFinite);
  const ends = parts.map((s) => parseInt(s.attrs && s.attrs['end-time-offset'], 10)).filter(Number.isFinite);
  if (begins.length === parts.length && ends.length === parts.length) {
    attrs['begin-time-offset'] = String(Math.min(...begins));
    attrs['end-time-offset'] = String(Math.max(...ends));
  } else {
    delete attrs['begin-time-offset'];
    delete attrs['end-time-offset'];
  }
  const seg = makeSegment(
    parts.map((s) => (s.baseline || '').trim()).filter(Boolean).join(' ') || baselineFromWords(words),
    words,
    {
      attrs,
      // a translation in one language is ONE item, the phrases' texts joined as FLEx joins them (LCM
      // joins every free and literal translation of two segments with a space); notes and anything
      // else ride along from both, as before
      preItemsXML: foldLangItems(parts.map((s) => s.preItemsXML || [])),
      postItemsXML: foldLangItems(parts.map((s) => s.postItemsXML || [])),
    });
  mergeFrees(seg, parts, prim);
  if (first.breaksBefore && first.breaksBefore.length) seg.breaksBefore = first.breaksBefore.slice();
  if (last.breaksAfter && last.breaksAfter.length) seg.breaksAfter = last.breaksAfter.slice();
  const txtLang = parts.map((s) => s.txtLang).find((l) => l);
  if (txtLang) seg.txtLang = txtLang;
  // a FLEx text's ride-alongs: the first phrase's identity, and its translations by language, joined
  if (first.flex) seg.flex = { ...first.flex };
  for (const key of ['frees', 'lits']) {
    if (!parts.some((s) => s[key] && typeof s[key] === 'object')) continue;
    const m = {};
    for (const s of parts) for (const [l, v] of Object.entries(s[key] || {})) { const t = String(v || '').trim(); if (t) m[l] = m[l] ? m[l] + ' ' + t : t; }
    seg[key] = m;
  }
  return seg;
}
/* The free translations of `parts`, joined language by language, into `seg` — whose item lists are the
 * parts' folded (foldLangItems), so an item there already holds the parts' ITEMS in its language; what it
 * lacks is the text a part kept in its slot. Each language's text is the parts' texts in it, in order (a
 * part's first, the one freeIn reads). The slot takes the language of the first part that has a slot; an
 * item in that language is folded into the slot. Any other language goes into its item, in place — or a new
 * one after the words, empty when every part's was (FLEx writes one for each writing system of the line). */
function mergeFrees(seg, parts, prim) {
  const langOf = (s) => s.freeLang || prim;
  const owner = parts.find((s) => s.free || s.freeLang) || parts[0];
  const slotLang = langOf(owner);
  seg.freeLang = owner.freeLang ?? null;
  const texts = new Map();   // lang -> [text, …] in part order
  for (const s of parts) {
    const seen = new Set();
    for (const f of phraseFrees(s)) {
      const l = f.lang || prim;
      if (seen.has(l)) continue;
      seen.add(l);
      if (!texts.has(l)) texts.set(l, []);
      const t = String(f.text || '').trim();
      if (t) texts.get(l).push(t);
    }
  }
  const isGlsIn = (xml, l) => { const g = glsOfItemXml(xml); return !!g && g.lang === l; };
  for (const [l, list] of texts) {
    const text = list.join(' ');
    if (l === slotLang) {
      seg.free = text;
      seg.preItemsXML = seg.preItemsXML.filter((x) => !isGlsIn(x, l));
      seg.postItemsXML = seg.postItemsXML.filter((x) => !isGlsIn(x, l));
      continue;
    }
    let done = false;
    for (const k of ['preItemsXML', 'postItemsXML']) {
      const i = seg[k].findIndex((x) => isGlsIn(x, l));
      if (i < 0) continue;
      seg[k][i] = langItemXml('gls', l, text);
      done = true;
      break;
    }
    if (!done && l) seg.postItemsXML.push(langItemXml('gls', l, text));
  }
}

/* ⚠ A HARD LINE BREAK IS NOT A LINE (Seth's FLEx round-trip report, 2026-10-17). Shift+Enter in FLEx's
 * Baseline tab inserts U+2028, and LCM makes every one its own one-character segment (liblcm
 * SegmentBreaker: "Hard line break, always its own segment"), which FLEx exports as a <phrase> whose txt is
 * that one character, with no <words> and no segnum. Read as a line, it was an empty line with no audio in
 * every view — U+2028 is whitespace to trim() and \s — and in the Audio Segmenter, where line i pairs with
 * audio i, the only way past one was to join it away. A join keeps the FIRST phrase's GUID, so each text
 * phrase after a break came out wearing the break's GUID, and the break itself was gone (13 breaks, 11 GUIDs).
 *
 * So, where a .flextext becomes a stored doc (app.js normalizePhraseLines), a line-break phrase stops being
 * a line and rides on its neighbour in the same paragraph: on the phrase after it (`breaksBefore`), or, at
 * the end of the paragraph, on the phrase before it (`breaksAfter`). The writer puts each back where it was —
 * its own GUID, its txt, no words. A split leaves it in place (the first piece keeps `breaksBefore`, the
 * last `breaksAfter`); a merge ACROSS it removes it, as in FLEx (mergePhrases). A paragraph of nothing but
 * line breaks keeps them as lines: there is no text phrase to carry them. */
export const LINE_BREAK = '\u2028';
export function isLineBreakPhrase(seg) {
  return !!seg && seg.baseline === LINE_BREAK && !(seg.words || []).length;
}
// → whether anything moved. Run before a doc's paragraphs are flattened to one phrase per line.
export function foldLineBreaks(doc) {
  let changed = false;
  for (const p of (doc && doc.paragraphs) || []) {
    const segs = p.segments || [];
    if (!segs.some(isLineBreakPhrase) || segs.every(isLineBreakPhrase)) continue;
    const out = [];
    let pending = [];
    for (const s of segs) {
      if (isLineBreakPhrase(s)) { pending.push(s); continue; }
      if (pending.length) { s.breaksBefore = [...(s.breaksBefore || []), ...pending]; pending = []; }
      out.push(s);
    }
    if (pending.length) { const prev = out[out.length - 1]; prev.breaksAfter = [...(prev.breaksAfter || []), ...pending]; }
    p.segments = out;
    changed = true;
  }
  return changed;
}

/* ---- FLEx's hard line breaks in the Matcher (2026-10-17) ----------------------------------------------------
 * Shift+Enter in FLEx inserts U+2028, and LCM makes every one its own label segment, with no words. The shell
 * reads it as it reads any segment (desktop/flexshell/model.py: one line, `readOnly`, an empty baseline — the
 * break itself is whitespace there) and the record keeps it so: the diff, the post-state and the three-way merge
 * all walk the shell's segments, so a FLEx text is STORED exactly as the shell gave it. Only the Matcher, where
 * row i is audio i, folds the breaks out while it is open — each rides on the line beside it in its paragraph,
 * drawn as ↵, as a .flextext's are (foldLineBreaks, above) — and puts them back as their own lines on Done.
 * A break that has a time of its own stays a row: that time is somebody's, and folding it away would drop it. */
export function isFlexBreakPhrase(seg) {
  return !!seg && !(seg.words || []).length && (isLineBreakPhrase(seg) || (!!seg.readOnly && !String(seg.baseline || '').trim()));
}
const rowPara = (line) => (line && line.paraOf != null ? String(line.paraOf) : null);
const timedSpan = (sp) => !!sp && !sp.timePending && Number(sp.end) > Number(sp.start);
// A copy of a phrase without the breaks a fold hung on it.
const bare = (ph) => { const { breaksBefore, breaksAfter, ...rest } = ph; return rest; };

/* The Matcher's rows (`lines`, each { id, phrases, guid, paraOf }) and their index-paired `spans` with every untimed
 * break folded onto a neighbour IN ITS OWN PARAGRAPH: onto the next line as `breaksBefore`, or, at the paragraph's
 * end, onto the one before it as `breaksAfter`. A paragraph of nothing but breaks keeps them as rows. Each folded
 * break is a copy carrying `flexLine` — its row's guid, paragraph and span — so unfoldFlexBreakLines can put it
 * back exactly. Pure: nothing passed in is changed. Idempotent: rows already folded have no breaks to fold. */
export function foldFlexBreakLines(lines, spans) {
  const L = lines || [], S = Array.isArray(spans) ? spans : [];
  const isBreakRow = (i) => L[i].phrases && L[i].phrases.length === 1 && isFlexBreakPhrase(L[i].phrases[0]) && !timedSpan(S[i]);
  const outL = [], outS = [];
  for (let a = 0; a < L.length;) {
    let b = a;
    while (b < L.length && rowPara(L[b]) === rowPara(L[a]) && rowPara(L[a]) !== null) b++;
    if (b === a) b = a + 1;                                     // a row with no paragraph: on its own
    const rows = [];
    for (let i = a; i < b; i++) rows.push(i);
    const texts = rows.filter((i) => !isBreakRow(i));
    if (!texts.length || texts.length === rows.length) {
      for (const i of rows) { outL.push(L[i]); if (i < S.length) outS.push(S[i]); }
      a = b;
      continue;
    }
    let pending = [];
    const take = (i) => ({ ...L[i].phrases[0], flexLine: { guid: L[i].guid, paraOf: L[i].paraOf ?? null, ...(i < S.length ? { span: S[i] } : {}) } });
    for (const i of rows) {
      if (isBreakRow(i)) { pending.push(take(i)); continue; }
      const ph = L[i].phrases.slice();
      if (pending.length) { ph[0] = { ...ph[0], breaksBefore: [...(ph[0].breaksBefore || []), ...pending] }; pending = []; }
      outL.push({ ...L[i], phrases: ph });
      if (i < S.length) outS.push(S[i]);
    }
    if (pending.length) {
      const last = outL[outL.length - 1], ph = last.phrases.slice(), k = ph.length - 1;
      ph[k] = { ...ph[k], breaksAfter: [...(ph[k].breaksAfter || []), ...pending] };
      outL[outL.length - 1] = { ...last, phrases: ph };
    }
    a = b;
  }
  return { lines: outL, spans: S.length ? outS : S };
}

/* Done's way back: every folded break is its own row again, beside the line that carried it — before it, or
 * after it — with its own guid and span, and the carrying phrases as they were. Its paragraph is where it now
 * SITS: a break after a line is that line's; a break before a line is that line's too, unless the line now opens
 * a paragraph and the break was read in the paragraph before — a ¶ made at the line after a break leaves the
 * break at the end of the paragraph before, which is where FLEx's own split keeps it (segmentation.py
 * phrase_to_paragraph). A row past the paired spans gets none, as it had none. Pure. */
export function unfoldFlexBreakLines(lines, spans) {
  const L = lines || [], S = Array.isArray(spans) ? spans : [];
  const outL = [], outS = [];
  let n = 0;
  const put = (br, carrier, para, paired) => {
    const { flexLine, ...ph } = br;
    const fl = flexLine || {};
    outL.push({ id: carrier.id + '~lb' + (n++), guid: fl.guid || ('ln-' + ((ph.attrs && ph.attrs.guid) || newGuid())), phrases: [bare(ph)], ...(para == null ? {} : { paraOf: para }) });
    if (paired) outS.push(fl.span || { id: 'lb' + n, start: 0, end: 0, timePending: true, timeEstimated: false });
  };
  L.forEach((l, i) => {
    const ph = l.phrases || [], paired = i < S.length;
    const before = outL[outL.length - 1], prevPara = before ? rowPara(before) : null;
    const opens = rowPara(l) !== prevPara;
    for (const br of (ph[0] && ph[0].breaksBefore) || []) {
      const read = br.flexLine && br.flexLine.paraOf != null ? String(br.flexLine.paraOf) : null;
      put(br, l, opens && prevPara !== null && read === prevPara ? before.paraOf : l.paraOf, paired);
    }
    outL.push({ ...l, phrases: ph.map(bare) });
    if (paired) outS.push(S[i]);
    for (const br of (ph[ph.length - 1] && ph[ph.length - 1].breaksAfter) || []) put(br, l, l.paraOf, paired);
  });
  return { lines: outL, spans: S.length ? outS : S };
}

/* The phrases' item lists as one: a top-level <item type="gls"|"lit" lang=…> (a free or literal
 * translation in another language) whose language an earlier item already holds is joined into it with
 * a space; everything else is kept in order. */
function foldLangItems(lists) {
  const out = [];
  const at = new Map();
  for (const list of lists) {
    for (const xml of list) {
      const it = langItemOf(xml);
      if (!it) { out.push(xml); continue; }
      const k = it.type + '\u0001' + it.lang;
      if (!at.has(k)) { at.set(k, out.length); out.push(xml); continue; }
      const prev = langItemOf(out[at.get(k)]);
      const joined = [prev.text.trim(), it.text.trim()].filter(Boolean).join(' ');
      out[at.get(k)] = langItemXml(it.type, it.lang, joined);
    }
  }
  return out;
}

export function makeDoc(settings, title = '') {
  return {
    version: '2',
    textAttrs: { guid: newGuid() },
    title,
    // WS codes for an app-AUTHORED doc are resolved at EXPORT time from the live
    // settings (see serializeFlextext) — the values below are only the fallback
    // for exporting on a device whose settings were wiped. appAuthored is what
    // switches serialize to live-settings mode; imported docs (parseFlextext)
    // keep their own codes for round-trip fidelity.
    appAuthored: true,
    titleLang: settings.analLang || 'en',
    metaItemsXML: [],
    vernLang: settings.vernLang || '',
    analLang: settings.analLang || 'en',
    languages: [
      { lang: settings.vernLang || 'und', font: settings.vernFont || '', vernacular: true },
      { lang: settings.analLang || 'en', font: settings.analFont || '', vernacular: false },
    ],
    objectsXML: '',
    mediaXML: [],
    paragraphs: [{ guid: newGuid(), segments: [] }],
    timeEdges: true,   // made by the per-edge time model (v717) — see readLegacyEstimates
  };
}

// Is this doc app-authored (recorded/typed in this app) rather than imported?
// Authored docs resolve their WS codes from the LIVE settings at export, so a
// researcher's code correction applies to every text exported afterwards.
// Legacy docs (created before the appAuthored flag) are detected by the absence
// of parse artifacts: the FLEx XSD requires lang= on every <item>, so an import
// always leaves per-item langs (and usually preserved fragments) behind, while
// the in-app editor never sets any of them.
export function isAppAuthored(doc) {
  if (doc.appAuthored === true) return true;
  if (doc.appAuthored === false) return false;
  if ((doc.metaItemsXML || []).length || doc.objectsXML) return false;
  for (const p of doc.paragraphs || []) {
    for (const s of p.segments || []) {
      if (s.txtLang != null || s.freeLang != null) return false;
      if ((s.preItemsXML || []).length || (s.postItemsXML || []).length) return false;
      for (const w of s.words || []) {
        if (w.txtLang != null || w.glsLang != null) return false;
        if ((w.preservedXML || []).length) return false;
      }
    }
  }
  return true;
}

/* ---------------- Parsing ---------------- */

function serializeEl(el) {
  return new XMLSerializer().serializeToString(el);
}

function childElements(el, name) {
  return Array.from(el.children).filter(c => c.tagName === name);
}

// Pick which of several same-type <item> lines this editor edits: the one whose
// lang matches the app's writing system for that tier, else the first (the old
// behavior). Multi-WS FLEx exports carry e.g. both en and id gloss lines — only
// the matching line becomes editable; the rest round-trip untouched.
function pickByLang(els, prefLang) {
  if (!els.length) return null;
  return (prefLang && els.find((el) => el.getAttribute('lang') === prefLang)) || els[0];
}

// Parse a flextext XML string. Returns { texts: [docModel...], error }.
// prefs = { vernLang, analLang }: when an imported text carries MULTIPLE writing
// systems per tier, these choose which lines the editor displays/edits (see
// pickByLang); every non-selected line is preserved verbatim for round-trip.
export function parseFlextext(xmlString, prefs = {}) {
  const dom = new DOMParser().parseFromString(xmlString, 'text/xml');
  const err = dom.querySelector('parsererror');
  if (err) return { texts: [], error: 'XML parse error: ' + err.textContent.slice(0, 300) };
  const docEl = dom.documentElement;
  // Read provenance back as well as writing it — "look for that" (Seth). This is what lets a future
  // survey ask "which tool wrote this?" instead of fingerprinting whitespace.
  const exportSource = docEl.getAttribute && docEl.getAttribute('exportSource');
  if (docEl.tagName !== 'document') return { texts: [], error: 'Not a flextext document (root element is <' + docEl.tagName + '>)' };
  const version = docEl.getAttribute('version') || '2';
  const texts = [];
  for (const itEl of childElements(docEl, 'interlinear-text')) {
    texts.push(parseInterlinearText(itEl, version, prefs));
  }
  if (!texts.length) return { texts: [], error: 'No <interlinear-text> found in file.' };
  return { texts, error: null };
}

function parseInterlinearText(itEl, version, prefs = {}) {
  const doc = {
    version,
    textAttrs: {},
    title: '',
    titleLang: 'en',
    appAuthored: false,   // imported: keeps its own WS codes at export (round-trip fidelity)
    metaItemsXML: [],
    vernLang: '',
    analLang: '',
    languages: [],
    objectsXML: '',
    mediaXML: [],
    paragraphs: [],
    timeEdges: true,   // read by the per-edge time model (v717) — see readLegacyEstimates
  };
  for (const a of itEl.attributes) doc.textAttrs[a.name] = a.value;
  if (!doc.textAttrs.guid) doc.textAttrs.guid = newGuid();

  // Multi-WS title: edit the analysis-language one when present (see pickByLang).
  const titleEl = pickByLang(
    Array.from(itEl.children).filter((c) => c.tagName === 'item' && c.getAttribute('type') === 'title'),
    prefs.analLang);

  for (const child of itEl.children) {
    switch (child.tagName) {
      case 'item': {
        if (child === titleEl) {
          doc.title = child.textContent;
          doc.titleLang = child.getAttribute('lang') || 'en';
        } else {
          doc.metaItemsXML.push(serializeEl(child));
        }
        break;
      }
      case 'objects':
        doc.objectsXML = serializeEl(child);
        break;
      case 'languages':
        for (const langEl of childElements(child, 'language')) {
          doc.languages.push({
            lang: langEl.getAttribute('lang') || '',
            font: langEl.getAttribute('font') || '',
            encoding: langEl.getAttribute('encoding') || '',
            vernacular: langEl.getAttribute('vernacular') === 'true',
          });
        }
        break;
      case 'media-files':
        doc.mediaXML.push(serializeEl(child));
        break;
      case 'paragraphs':
        for (const pEl of childElements(child, 'paragraph')) {
          const para = { guid: pEl.getAttribute('guid') || newGuid(), segments: [] };
          for (const phrasesEl of childElements(pEl, 'phrases')) {
            for (const phEl of childElements(phrasesEl, 'phrase')) {
              para.segments.push(parsePhrase(phEl, doc, prefs));
            }
          }
          doc.paragraphs.push(para);
        }
        break;
    }
  }

  // Which edges were estimates when this file was written (TIME_ESTIMATES_PI). A processing
  // instruction is not an element, so it never reaches the switch above. segmentsFromOffsets reads it.
  for (const node of Array.from(itEl.childNodes || [])) {
    if (!node || node.nodeType !== 7 || node.target !== TIME_ESTIMATES_PI) continue;
    const entries = parseTimeEstimatesPi(node.data);
    // An instruction listing NONE is a statement too (v718 — NO_TIME_ESTIMATES_PI): kept as an empty list.
    if (entries.length || /\btime-estimates=""/.test(String(node.data || ''))) doc.timeEstimatesPi = (doc.timeEstimatesPi || []).concat(entries);
  }

  // Determine writing systems: prefer <languages>, fall back to usage.
  const vernFromLangs = doc.languages.find(l => l.vernacular);
  if (vernFromLangs) doc.vernLang = vernFromLangs.lang;
  const analFromLangs = doc.languages.find(l => !l.vernacular);
  if (analFromLangs) doc.analLang = analFromLangs.lang;
  // Usage-based fallback / correction from actual content
  outer:
  for (const p of doc.paragraphs) {
    for (const s of p.segments) {
      if (s.txtLang && !doc.vernLang) doc.vernLang = s.txtLang;
      if (s.freeLang && !doc.analLang) doc.analLang = s.freeLang;
      for (const w of s.words) {
        if (!doc.vernLang && w.txtLang) doc.vernLang = w.txtLang;
        if (!doc.analLang && w.glsLang) doc.analLang = w.glsLang;
      }
      if (doc.vernLang && doc.analLang) break outer;
    }
  }
  if (!doc.analLang) doc.analLang = 'en';
  if (!doc.paragraphs.length) doc.paragraphs.push({ guid: newGuid(), segments: [] });
  return doc;
}

function parsePhrase(phEl, doc, prefs = {}) {
  const seg = makeSegment('', []);
  seg.attrs = {};
  for (const a of phEl.attributes) seg.attrs[a.name] = a.value;
  if (!seg.attrs.guid) seg.attrs.guid = newGuid();

  // Pre-scan for multi-WS line selection: which baseline txt (before <words>) and
  // which free-translation gls (after <words>) does this editor edit? The matching
  // language wins; every other line is preserved verbatim (the old code silently
  // OVERWROTE earlier baseline txt lines — now they round-trip).
  const kids = Array.from(phEl.children);
  const wordsIdx = kids.findIndex((c) => c.tagName === 'words');
  const txtEl = pickByLang(
    kids.filter((c, i) => c.tagName === 'item' && c.getAttribute('type') === 'txt' && (wordsIdx < 0 || i < wordsIdx)),
    prefs.vernLang);
  /* ⚠ THE FREE TRANSLATION MAY SIT EITHER SIDE OF <words> (v332, Seth's field file).
   *
   * This used to require `wordsIdx >= 0 && i > wordsIdx` — a phrase-level gls AFTER the words. Real
   * FLEx exports also write it BEFORE (`<item type="txt">`, `<item type="gls">`, then `<words>`),
   * and such a file imported with EVERY free translation silently empty: the item fell through to
   * preItemsXML, so it round-tripped back out intact and nothing looked lost until a human read the
   * screen. Not a segmentation-mode bug and not new — any import of that layout was affected.
   *
   * After-words still WINS when both exist (that is the position this app writes, so a re-import of
   * our own export keeps reading its own line). Word-level gls cannot be caught here: `kids` is the
   * phrase's DIRECT children, and word glosses live inside <word>. */
  const glsKids = kids.filter((c) => c.tagName === 'item' && c.getAttribute('type') === 'gls');
  const afterWords = glsKids.filter((c) => wordsIdx >= 0 && kids.indexOf(c) > wordsIdx);
  const freeEl = pickByLang(afterWords.length ? afterWords : glsKids, prefs.analLang);

  let seenWords = false;
  // A phrase FLEx wrote with no <words> (a hard line break, LINE_BREAK) is written back without one.
  if (wordsIdx < 0) seg.noWords = true;
  for (const child of kids) {
    if (child.tagName === 'words') {
      seenWords = true;
      for (const wEl of child.children) {
        if (wEl.tagName === 'word') seg.words.push(parseWord(wEl, doc, prefs));
        else seg.preItemsXML.push(serializeEl(wEl)); // e.g. scrMilestone — keep, re-emit inside <words>
      }
    } else if (child.tagName === 'item') {
      const type = child.getAttribute('type');
      const lang = child.getAttribute('lang') || '';
      if (child === txtEl) { seg.baseline = child.textContent; seg.txtLang = lang; }
      else if (child === freeEl) {
        seg.free = child.textContent; seg.freeLang = lang;
        // where it stood among the phrase's other items, so it is written back there (FREE_AT)
        seg.freeAt = { post: seenWords, at: (seenWords ? seg.postItemsXML : seg.preItemsXML).length };
      }
      /* segnum is DROPPED on read and never emitted on write — and nothing here may depend on it,
       * because it cannot be relied on to exist (Seth: "we can't count on it existing in flextext
       * files"). The spec makes it optional and 27 of the 95 texts in the corpus carry none. The
       * interlinear view numbers its own lines for display, which is the only place a number is
       * actually wanted. */
      else if (type === 'segnum' && !seenWords) { /* deliberately discarded — see serializeFlextext */ }
      else (seenWords ? seg.postItemsXML : seg.preItemsXML).push(serializeEl(child));
    } else {
      seg.postItemsXML.push(serializeEl(child));
    }
  }
  // If no baseline txt item, reconstruct from words.
  if (!seg.baseline) seg.baseline = baselineFromWords(seg.words);
  markBoundaryMarkers(seg);   // a phrase-final § is structure FLEx wrote, hidden in every word-level view
  // Words without their own txt item (morphemes-only exports) get a derived
  // form, which may differ from the baseline surface form (e.g. aː vs a).
  // FLEx shows the surface form, so map baseline tokens onto those words.
  if (seg.words.some(w => w.derivedTxt)) {
    const tokens = tokenize(seg.baseline).filter(t => !t.punct);
    const lexWords = seg.words.filter(w => !w.punct);
    if (tokens.length === lexWords.length) {
      lexWords.forEach((w, i) => {
        if (w.derivedTxt) w.txt = tokens[i].txt;
        else if (w.phrase) { /* keep phrase txt */ }
      });
    }
  }
  return seg;
}

function parseWord(wEl, doc, prefs = {}) {
  const w = makeWord('', {});
  if (wEl.getAttribute('guid')) w.guid = wEl.getAttribute('guid');
  if (wEl.getAttribute('type') === 'phrase') w.phrase = true;
  // Multi-WS selection (see pickByLang): the vern-matching txt and anal-matching
  // gls become the editable lines; all other langs' lines are preserved verbatim
  // in document order (interleaved with morphemes etc., exactly as authored).
  const kids = Array.from(wEl.children);
  const items = kids.filter((c) => c.tagName === 'item');
  const punctEl = items.find((el) => el.getAttribute('type') === 'punct') || null;
  const txtEl = punctEl ? null : pickByLang(items.filter((el) => el.getAttribute('type') === 'txt'), prefs.vernLang);
  const glsEl = pickByLang(items.filter((el) => el.getAttribute('type') === 'gls'), prefs.analLang);
  for (const child of kids) {
    if (child === punctEl) { w.txt = child.textContent; w.punct = true; w.txtLang = child.getAttribute('lang') || ''; }
    else if (child === txtEl) { w.txt = child.textContent; w.txtLang = child.getAttribute('lang') || ''; }
    // glsAt: where it stood among the word's other items, so it is written back there (FREE_AT)
    else if (child === glsEl) { w.gls = child.textContent; w.glsLang = child.getAttribute('lang') || ''; w.glsAt = w.preservedXML.length; }
    else w.preservedXML.push(serializeEl(child)); // morphemes, pos, cf, hn, msa, other-lang lines...
  }
  // Word with morphemes but no top-level txt item: derive txt from morphs for display.
  if (!w.txt && w.preservedXML.length) {
    const frag = new DOMParser().parseFromString('<x>' + w.preservedXML.join('') + '</x>', 'text/xml');
    const morphTxts = Array.from(frag.querySelectorAll('morph > item[type="txt"]'))
      .map(e => e.textContent.replace(/^[-=~]+|[-=~]+$/g, ''));
    if (morphTxts.length) { w.txt = morphTxts.join(''); w.derivedTxt = true; }
  }
  return w;
}

/* ⚠ WHICH WORD A PUNCTUATION TOKEN BELONGS TO — ONE DEFINITION, used by baselineFromWords when it
 * rebuilds a line and by canSplitBefore when it decides where a line may break. These two must never
 * disagree: one puts the mark on a side, the other decides whether a break may pass between them.
 *
 * An OPENING mark leads the word that FOLLOWS it — "(bar", "«bar", "“bar" — so it takes a space
 * before and none after. Everything else TRAILS the word before it — "foo,", "foo.", "foo)".
 * tokenize() groups a run of punctuation into a single token, so the group is classified by its
 * FIRST character, which is what decides where the whitespace goes.
 *
 * ⚠ THE STRAIGHT QUOTES ' AND " ARE GENUINELY AMBIGUOUS — the same character opens and closes, and
 * nothing in the token tells you which. They are counted as opening here because that is what
 * baselineFromWords has always done, and one shared answer beats two that drift. The cost is a ✂
 * offered before a CLOSING straight quote, which a researcher can simply not use; the alternative —
 * guessing by parity — is wrong on any line with an odd number of them. (The typographic quotes " "
 * ' ' are unambiguous and handled exactly.) NOTE: ' is a WORD character in this engine (it writes a
 * glottal stop), so a bare apostrophe never reaches here as punctuation at all. */
export const PUNCT_LEADS = /^[([{«“‘'"¿¡]/;
export function punctLeadsWord(txt) { return PUNCT_LEADS.test(String(txt || '')); }

/* ⚠ AND THE ONES THAT COULD BE EITHER. The straight quotes open and close with the SAME character,
 * so no rule reading a single token can say which this one is. baselineFromWords has to pick a side
 * regardless — it has to emit something — and picks leading, which is right half the time. A SPLIT
 * has a third option: don't offer one. So canSplitBefore treats an ambiguous group as belonging to
 * neither neighbour and refuses a break on both sides of it, which can never strand a mark. The cost
 * is a couple of gaps unoffered on a quoted line, and the keyboard route (Enter at a box boundary)
 * still splits there; the alternative — guessing by parity — is wrong on any line with an odd number
 * of them, which is exactly the line someone is mid-way through typing.
 *
 * The typographic quotes “ ” ‘ ’ « » are unambiguous and are classified exactly, which is a decent
 * reason to prefer them. */
export const PUNCT_AMBIGUOUS = /^['"]/;
export function punctSideUnknown(txt) { return PUNCT_AMBIGUOUS.test(String(txt || '')); }

export function baselineFromWords(words) {
  let out = '';
  for (const w of words) {
    if (w.punct) {
      if (punctLeadsWord(w.txt)) out += (out && !/\s$/.test(out) ? ' ' : '') + w.txt;
      else out += w.txt;
    } else {
      out += (out && !/[([{«“‘¿¡\s]$/.test(out) ? ' ' : '') + w.txt;
    }
  }
  return out;
}

/* ---------------- Serialization ---------------- */

function indentFragment(xml, pad) {
  // Reindent a serialized fragment one line at a time (best effort).
  return xml.split('\n').map(l => pad + l.trim()).join('\n');
}
// A kept fragment that is an <item> (a phrase's item, from before or after its <words>), not another element.
function isItemXml(xml) { return /^\s*<item\b/.test(String(xml || '')); }
// The guids of the <media> elements a doc's <media-files> blocks name, in order.
export function mediaGuidsOf(blocks) {
  const out = [];
  for (const xml of blocks || []) for (const m of String(xml).matchAll(/<media\b[^>]*?\bguid="([^"]+)"/g)) out.push(m[1]);
  return out;
}

/* ⚠ WHICH TIMES ARE ESTIMATES, IN THE FILE ITSELF (v717 — plans/time-gaps-and-estimates.md D5/D6).
 *
 * The `~` in our "audio ~0:04.000–0:06.000" note was the only mark an estimate left in an export, and
 * v714 never read it back: a text whose times were the editor's own even-spread guesses came back as
 * measured times (E78 and E19 are made of nothing else), and every round trip laundered a little
 * more. The note also says "estimated" for the whole line when only one EDGE is a guess, and it is
 * absent altogether on a device with segTimeNotes off. So the serializer writes, inside
 * <interlinear-text>, one XML processing instruction listing each estimated phrase by guid with its
 * offsets, `~` before each GUESSED edge:
 *
 *     <?flextext-editor v="2" time-estimates="9d5e…931@~5346-~6846 1ed0…dca@2230-~4153"?>
 *
 * written whenever times are (segTimes), regardless of timeNotes. A processing instruction is XML's
 * own place for one application's data (XML 1.0 §2.6): not an element, so outside what
 * FlexInterlinear.xsd governs, and skipped by FLEx and ELAN (both proven with v713's, which used the
 * same target with a different pseudo-attribute — that one, `blank-lines`, is NOT read: D17).
 * An entry counts only for the one phrase with its guid whose offsets still equal its times within
 * 1 ms (markFileEstimates), so a file edited elsewhere can never mark a time it did not write.
 *
 * ⚠ "SKIPPED" MEANS DROPPED: the instruction carries the per-edge marks through OUR OWN round trips
 * (another device, a re-import) and through nothing else. FLEx re-writes the file without it and an EAF
 * has nowhere to put it, so after a trip through FLEx what is left is the `~` note — per line, read
 * back conservatively (both seams of a dashed line guessed, never a guess made real) — and with the
 * notes switched off, only the equal-length rule, which catches an even spread and nothing else
 * (v717 review). The notes are the FLEx-facing carrier; the instruction is ours. */
export const TIME_ESTIMATES_PI = 'flextext-editor';
/* ⚠ AND AN EMPTY ONE SAYS "NONE OF THESE ARE GUESSES" (v718, case 7/17). A run of three or more equal
 * lines is read back as an estimate when a file carries no instruction (the equal-length rule, for
 * devices that had notes off) — so a line the user KEPT, in a run that happens to be even, came back
 * dashed after our own export and import. A writer holding no estimates says so with an instruction
 * that lists none, written only when the reader's rule would otherwise misfire (serializeFlextext). */
export const NO_TIME_ESTIMATES_PI = `<?${TIME_ESTIMATES_PI} v="2" time-estimates=""?>`;
export function timeEstimatesPi(entries) {
  const list = (entries || []).filter((e) => e && e.guid && Number.isFinite(e.start) && Number.isFinite(e.end) && (e.gs || e.ge));
  if (!list.length) return '';
  const body = list.map((e) => `${e.guid}@${e.gs ? '~' : ''}${Math.round(e.start)}-${e.ge ? '~' : ''}${Math.round(e.end)}`).join(' ');
  return `<?${TIME_ESTIMATES_PI} v="2" time-estimates="${esc(body)}"?>`;
}
// The entries a processing instruction's data names ('v="2" time-estimates="…"'), in the order written.
export function parseTimeEstimatesPi(data) {
  const m = String(data ?? '').match(/\btime-estimates="([^"]*)"/);
  if (!m) return [];
  const out = [];
  for (const tok of m[1].trim().split(/\s+/)) {
    const t = tok.match(/^([^@\s]+)@(~?)(\d+)-(~?)(\d+)$/);
    if (!t) continue;
    const start = +t[3], end = +t[5];
    if (end > start && (t[2] || t[4])) out.push({ guid: t[1], start, end, gs: !!t[2], ge: !!t[4] });
  }
  return out;
}

export function serializeFlextext(doc, settings = {}, opts = {}) {
  // WS codes resolve AT EXPORT for app-authored docs: the LIVE settings win, so a
  // researcher's writing-system correction applies to every text exported after it
  // — including texts recorded before the change. Imported docs are the opposite:
  // their own codes win (round-trip fidelity; the file's languages are facts about
  // the file, not about this device's settings).
  const authored = isAppAuthored(doc);
  const vern = authored ? (settings.vernLang || doc.vernLang || 'und') : (doc.vernLang || settings.vernLang || 'und');
  const anal = authored ? (settings.analLang || doc.analLang || 'en') : (doc.analLang || settings.analLang || 'en');
  const lines = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  /* ⚠ WHO MADE THIS FILE — and in FLEx's OWN schema, not a convention of ours.
   *
   * "Technical Notes on FLEx Text Interlinear" (Ken Zook, 5 May 2026) gives the <document> element
   * two optional attributes for exactly this:
   *     <xs:attribute name="exportSource" type="xs:string" use="optional"/>
   *     <xs:attribute name="exportTarget" type="xs:string" use="optional"/>
   * Being in the published XSD as optional, it cannot break a FLEx import — which an XML comment is
   * also very unlikely to do (XML 1.0 §2.5; every conformant parser skips comments) but only by
   * inference. A documented field is evidence.
   *
   * WHY IT MATTERS, concretely: asked what FLEx's segnum numbering looks like, I measured 95
   * .flextext files from Seth's corpus and concluded we already matched it. 68 of them turned out to
   * have been written by THIS SERIALIZER, identifiable only by its indentation, so the finding was
   * circular. A file that says what wrote it answers that in one line, years later, to somebody who
   * has never seen this repo. Seth: "Our apps should leave metadata 'created by...' in exported
   * files whenever the schema or file format allows that."
   *
   * `producedBy` is a PARAMETER (opts), never module state — same rule the rest of this module
   * follows so a second writer can call it. Omitted entirely when the caller supplies nothing,
   * rather than emitting a guess. */
  const provenance = opts.producedBy ? ` exportSource="${esc(opts.producedBy)}"` : '';
  lines.push(`<document version="${esc(doc.version || '2')}"${provenance}>`);
  const attrs = Object.entries(doc.textAttrs || {})
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  lines.push(`  <interlinear-text${attrs}>`);
  lines.push(`    <item type="title" lang="${esc(authored ? anal : (doc.titleLang || anal))}">${esc(doc.title || 'Untitled')}</item>`);
  for (const xml of doc.metaItemsXML || []) lines.push(indentFragment(xml, '    '));
  if (doc.objectsXML) lines.push(indentFragment(doc.objectsXML, '    '));
  lines.push('    <paragraphs>');
  // Segmentation time-alignment (Seth, 2026-08-03): aligned spans are exported BOTH ways — as
  // FLEx's native phrase begin/end-time-offset attributes AND as a human-visible note item — and
  // NEVER into the baseline. One phrase per paragraph is the segmentation-mode invariant, so
  // phrase↔span pairing is by paragraph position; a multi-phrase paragraph gets no pairing
  // rather than a crossed one. Estimated boundaries are marked with '~' in the note.
  // opts.segTimes === false suppresses OUR timing emission entirely (Seth, 2026-08-03: no audio
  // segmentation going on → none in the flextext). Preserved attrs/notes from an IMPORTED file
  // still round-trip verbatim below — suppressing emission must never strip imported data.
  /* ⚠ D8 (v717): WHEN WE WRITE TIMES, THE LIVE SPAN IS THE ONLY SOURCE. A single-phrase paragraph
   * used to fall back to whatever begin/end-time-offset its phrase carried from an earlier import
   * whenever its live span had no time — so a line the Segmenter left without audio went out with
   * its stale times, and an E78-style re-cut produced two phrases claiming overlapping audio. Now a
   * line whose live span is pending is written with NO offsets and no "audio" note. Only when the
   * doc has a live time model at all (doc.segments non-empty); with segTimes off, or a doc that never
   * had spans, imported offsets pass through verbatim as before. Multi-phrase paragraphs keep each
   * phrase's own offsets (no live span pairs with them). The `~` comes from isEstimate per edge, and
   * a pre-v717 doc's estimates are read back first (spansForExport) — on a copy; the doc is never
   * touched here. One exception to "no offsets": a line the model could not place but nobody changed
   * (`fileTimes` — nested ELAN phrases, a sliver, an older build's duration clamp) writes the file's
   * own offsets and notes back as they came (P4); heldFileTimes says when that still holds. */
  const spans = (opts.segTimes !== false && Array.isArray(doc.segments)) ? spansForExport(doc) : [];
  const liveModel = spans.length > 0;
  const hasSpans = spans.some(isAligned);
  const estimates = [];   // TIME_ESTIMATES_PI entries, one per estimated phrase that has a guid
  const clock = (ms) => { const ti = Math.max(0, Math.round(ms)); return `${Math.floor(ti / 60000)}:${String(Math.floor((ti % 60000) / 1000)).padStart(2, '0')}.${String(ti % 1000).padStart(3, '0')}`; };
  const OUR_NOTE = /type="note"[^>]*>audio ~?\d+:\d\d\.\d{3}/;   // dedupe our own notes on round trips
  /* ⚠ EVERY TIMED PHRASE NAMES ITS MEDIA (Seth's FLEx round-trip report, 2026-10-17). FLEx imports a phrase's
   * begin/end only through `media-file`, the guid of a <media> in the text's <media-files>
   * (BIRDInterlinearImporter, AddELANInfoToSegment), and its exporter writes times only for segments linked
   * that way. This linked phrases only to a guid minted HERE, and minted none while the doc had a block of
   * its own — which the app writes the moment audio is attached (app.js ensureMediaRef). So every phrase
   * went out with times and no link, and FLEx would import none of them. Now the media is the doc's own (the
   * first <media> its blocks name, FLEx's or the app's), else one minted here for `opts.mediaName`; every
   * timed phrase points at it, unless its own link names another <media> the doc carries. */
  const fileMedia = mediaGuidsOf(doc.mediaXML);
  const minted = hasSpans && !fileMedia.length && !!opts.mediaName;
  const mediaGuid = !hasSpans ? null : fileMedia.length ? fileMedia[0] : minted ? (doc.mediaGuid || (doc.mediaGuid = newGuid())) : null;
  /* ⚠ REGROUP ONLY WHAT WAS DELIBERATELY GROUPED, AND FAIL SAFE TO FLAT.
   *
   * The engine holds one line per PHRASE. Emitting one <paragraph> per line is the DEFAULT and is
   * deliberate — a maximally-split export means an ELAN annotator only ever merges, which ELAN can
   * do, never splits at a higher level, which it cannot (see plans/preserve-paragraph-structure.md).
   *
   * But when the source file distinguished the two — Seth's recent FLEx texts use phrase breaks for
   * clauses and paragraph breaks for sentences — normalizePhraseLines tags each line with `paraOf`,
   * and consecutive lines sharing one are emitted inside a single <paragraph> under the ORIGINAL
   * guid. Uniform files (one paragraph of many phrases, or many of one) are never tagged, so they
   * take the flat path below and their output is byte-identical to before this existed.
   *
   * ⚠ AND IT GIVES UP RATHER THAN GUESS. Cuts and joins move lines about, and a paragraph whose
   * lines are no longer CONSECUTIVE cannot be emitted as one element — writing it as two would put
   * the same guid on two <paragraph>s, which is invalid and which FLEx would read as two
   * paragraphs anyway. So the runs are computed first and checked; if any guid appears in more than
   * one run, the whole document falls back to flat. Seth: "preserve as close as possible, fall back
   * to flat paragraph-breaking if it fails to produce a valid flextext or is uncertain enough."
   *
   * ⚠ THE SPAN INDEX STAYS PER LINE. doc.segments is 1:1 with LINES, never with emitted paragraphs.
   */
  const runs = [];
  doc.paragraphs.forEach((para, i) => {
    const key = para.paraOf == null ? null : String(para.paraOf);
    const last = runs[runs.length - 1];
    if (key !== null && last && last.key === key) last.lines.push(i);
    else runs.push({ key, guid: para.paraOf || para.guid, lines: [i] });
  });
  const tagged = runs.map((r) => r.key).filter((k) => k !== null);
  const canGroup = tagged.length === new Set(tagged).size;
  const emit = canGroup ? runs : doc.paragraphs.map((para, i) => ({ guid: para.guid, lines: [i] }));

  /* One <phrase>. `span` is its line's live span when it has one (`own`), else null — and a hard line break
   * (foldLineBreaks) never has one: it goes out exactly as it came in. */
  const writePhrase = (seg, own, span) => {
    const timed = isAligned(span);   // a placeholder arrives here pending (spansForExport, v718): untimed
    // D8: the live span says "no time" — so does the file, unless these are the file's own, untouched.
    const untimed = own && !timed && !heldFileTimes(span, seg.attrs);
    if (timed && isEstimate(span) && seg.attrs && seg.attrs.guid) {
      estimates.push({ guid: seg.attrs.guid, start: span.start, end: span.end, gs: edgeGuessed(span, 0), ge: edgeGuessed(span, 1) });
    }
    // A round trip preserves imported offsets in seg.attrs — when we emit fresh ones, filter the stale
    // copies or the phrase would carry the attribute twice (invalid XML). The link is written afresh with
    // them: the phrase's own when it names a <media> the doc carries, else the doc's (mediaGuid).
    const ownLink = seg.attrs && seg.attrs['media-file'];
    const link = timed ? (ownLink && fileMedia.includes(ownLink) ? ownLink : mediaGuid) : null;
    const pAttrs = Object.entries(seg.attrs || {})
      .filter(([k]) => !((timed || untimed) && (k === 'begin-time-offset' || k === 'end-time-offset'))
        && !(timed && k === 'media-file'))
      .map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
      + (timed ? ` begin-time-offset="${Math.round(span.start)}" end-time-offset="${Math.round(span.end)}"${link ? ` media-file="${esc(link)}"` : ''}` : '');
    lines.push(`          <phrase${pAttrs}>`);
    lines.push(`            <item type="txt" lang="${esc(seg.txtLang || vern)}">${esc(seg.baseline)}</item>`);
    /* ⚠ NO segnum ITEM. We used to mint one — a plain running integer — for every phrase, and it
     * was wrong in three ways at once.
     *
     *   1. FLEx does not want it. "There is an OPTIONAL item with type 'segnum'. This is the
     *      segment number which in FLEx is CALCULATED AUTOMATICALLY based on paragraph and segment
     *      numbers" (Technical Notes on FLEx Text Interlinear, Ken Zook, 2026-05-04). FLEx
     *      recomputes it on import, so ours was overwritten at best.
     *   2. Ours was the wrong shape anyway: a running integer, where FLEx derives par.phr (1.1,
     *      1.2, 2.1). We would have been supplying a number that disagreed with FLEx's own.
     *   3. It broke round-trip fidelity for files that had none. 27 of 95 texts in Seth's corpus
     *      carry no segnum; we added one to every phrase regardless.
     *
     * And nothing here needs it: the parser already DISCARDS it on read (see parsePhrase,
     * "regenerated on export"), and the interlinear view numbers its own lines for display.
     * Seth: "I think we actually don't need segnum, and if we can do without it, that's better."
     *
     * ⚠ ONE SIDE EFFECT WORTH KNOWING: segnum carried lang=<analysis WS>, so it was one of the
     * places the analysis writing system appeared in our output. `gls` items still carry it
     * wherever there are glosses or free translations; a document with neither has no analysis
     * content to declare in the first place. */
    /* ⚠ EACH ITEM WHERE IT STOOD (FREE_AT). The parser keeps a phrase's items from before <words> (another
     * vernacular's txt, a free translation there — v332) and the non-word elements inside <words>
     * (scrMilestone) in one list; the first go back before <words>, the second inside it — every one of
     * them used to go inside, which is not where FLEx looks for a phrase's items. The editable free
     * translation goes back at its own place among the others (seg.freeAt), and so does a word's gloss
     * (w.glsAt): FLEx writes a word's glosses id-then-en and a phrase's en-then-id in the same file. Order
     * is not identity — FLEx reads an item by type and lang — but the file should come back as it went. */
    const pre = seg.preItemsXML || [];
    const head = pre.filter(isItemXml), inWords = pre.filter((x) => !isItemXml(x));
    const free = (seg.free || seg.freeLang) ? `<item type="gls" lang="${esc(seg.freeLang || anal)}">${esc(seg.free)}</item>` : null;
    const at = seg.freeAt;
    const freeBefore = !!(free && at && !at.post);
    head.forEach((x, k) => { if (freeBefore && k === at.at) lines.push('            ' + free); lines.push(indentFragment(x, '            ')); });
    if (freeBefore && at.at >= head.length) lines.push('            ' + free);
    // a phrase FLEx wrote with no <words> (a hard line break) goes back without one while it has none
    if (!((seg.noWords || isLineBreakPhrase(seg)) && !(seg.words || []).length && !inWords.length)) {
      lines.push('            <words>');
      for (const xml of inWords) lines.push(indentFragment(xml, '              '));
      for (const w of seg.words) {
        const wType = w.phrase ? ' type="phrase"' : '';
        // A <word> guid is FLEx's analysis object (InterlinearExporter); punctuation has none and FLEx writes
        // it with none — one minted on import is the engine's own (Seth's FLEx round-trip report, bug 7).
        lines.push(`              <word${w.punct ? '' : ` guid="${esc(w.guid)}"`}${wType}>`);
        if (w.punct) {
          lines.push(`                <item type="punct" lang="${esc(w.txtLang || vern)}">${esc(w.txt)}</item>`);
        } else {
          if (!w.derivedTxt) {
            lines.push(`                <item type="txt" lang="${esc(w.txtLang || vern)}">${esc(w.txt)}</item>`);
          }
          // the editable gloss, empty included when the file had it (glsLang): FLEx writes one per writing system
          const gls = (w.gls || w.glsLang) ? `<item type="gls" lang="${esc(w.glsLang || anal)}">${esc(w.gls)}</item>` : null;
          const kept = w.preservedXML || [];
          const gAt = gls && Number.isInteger(w.glsAt) ? Math.min(w.glsAt, kept.length) : kept.length;
          kept.forEach((xml, k) => { if (gls && k === gAt) lines.push('                ' + gls); lines.push(indentFragment(xml, '                ')); });
          if (gls && gAt >= kept.length) lines.push('                ' + gls);
        }
        lines.push('              </word>');
      }
      lines.push('            </words>');
    }
    /* The human-visible timestamps (never in the baseline): a note item FLEx shows on its own Note line, `~`
     * before an estimated time. OFF unless asked for (opts.timeNotes === true, the device setting
     * segTimeNotes; Seth's FLEx round-trip report, 2026-10-17): FLEx imports each as a segment Note, and
     * they say again what the times on the phrase already say — which FLEx reads now that every timed phrase
     * names its media. Our own notes from an earlier export are dropped either way when times are written. */
    const note = timed && opts.timeNotes === true
      ? `<item type="note" lang="${esc(anal)}">audio ${isEstimate(span) ? '~' : ''}${clock(span.start)}–${clock(span.end)}</item>` : null;
    const post = seg.postItemsXML || [];
    const ins = free && !freeBefore ? (at && at.post ? Math.min(at.at, post.length) : 0) : 0;
    const ours = [free && !freeBefore ? free : null, note].filter(Boolean);
    post.forEach((xml, k) => {
      if (k === ins) for (const x of ours) lines.push('            ' + x);
      if (!((timed || untimed) && OUR_NOTE.test(xml))) lines.push(indentFragment(xml, '            '));
    });
    if (ins >= post.length) for (const x of ours) lines.push('            ' + x);
    lines.push('          </phrase>');
  };

  let pi = -1;
  for (const run of emit) {
    lines.push(`      <paragraph guid="${esc(run.guid)}">`);
    lines.push('        <phrases>');
    for (const li of run.lines) {
      const para = doc.paragraphs[li];
      pi = li;
      for (const seg of para.segments) {
        const own = liveModel && para.segments.length === 1;
        // FLEx's hard line breaks ride on the phrase beside them (foldLineBreaks) and go back where they were
        for (const lb of seg.breaksBefore || []) writePhrase(lb, false, null);
        writePhrase(seg, own, own ? spans[pi] : null);
        for (const lb of seg.breaksAfter || []) writePhrase(lb, false, null);
      }
    }
    lines.push('        </phrases>');
    lines.push('      </paragraph>');
  }
  lines.push('    </paragraphs>');
  /* With no live time model to write from (segmentation off — `segTimes: false` — or a doc that never
   * had spans), the phrases go out with their imported offsets verbatim, and so does the file's own
   * instruction: each entry whose phrase still carries that guid and those offsets, so the per-edge
   * marks survive a device with segmentation off (P4) and can never point at a time that moved. */
  if (!liveModel && Array.isArray(doc.timeEstimatesPi)) {
    const written = doc.paragraphs.flatMap((p) => (p.segments || []).map((ph) => ph.attrs || {}))
      .map((a) => [a.guid, parseInt(a['begin-time-offset'], 10), parseInt(a['end-time-offset'], 10)]);
    for (const x of doc.timeEstimatesPi) {
      const at = written.filter(([g, b, e]) => g === x.guid && Math.abs(b - x.start) <= 1 && Math.abs(e - x.end) <= 1);
      if (at.length === 1) estimates.push({ guid: x.guid, start: at[0][1], end: at[0][2], gs: x.gs, ge: x.ge });
    }
  }
  // Which of the times above are estimates, per edge — regardless of timeNotes (TIME_ESTIMATES_PI).
  const estPi = timeEstimatesPi(estimates);
  if (estPi) lines.push('    ' + estPi);
  /* None at all — and the times written hold an even run the reader would take for a guess, or the file
   * came with an instruction (a classic device passes its claim on): say "none" (NO_TIME_ESTIMATES_PI). */
  else if (liveModel ? evenRealRun(spans, doc) : Array.isArray(doc.timeEstimatesPi)) lines.push('    ' + NO_TIME_ESTIMATES_PI);
  // languages element. Authored docs SKIP doc.languages (that's the stale snapshot
  // frozen at creation) and emit purely from the live settings; imported docs emit
  // their own languages first, with the settings only as gap-fillers.
  const langs = [];
  const seen = new Set();
  const push = (l) => { if (l.lang && !seen.has(l.lang)) { seen.add(l.lang); langs.push(l); } };
  if (!authored) for (const l of doc.languages || []) push(l);
  push({ lang: vern, font: settings.vernFont || '', vernacular: true });
  push({ lang: anal, font: settings.analFont || '', vernacular: false });
  lines.push('    <languages>');
  for (const l of langs) {
    let s = `      <language lang="${esc(l.lang)}"`;
    if (l.encoding) s += ` encoding="${esc(l.encoding)}"`;
    if (l.font) s += ` font="${esc(l.font)}"`;
    if (l.vernacular) s += ' vernacular="true"';
    lines.push(s + ' />');
  }
  lines.push('    </languages>');
  // flextext's native media reference: phrases point at this guid via media-file. Emitted only
  // when WE minted the guid (a doc with no media-files block of its own), in milliseconds, as FLEx writes it.
  if (minted) {
    lines.push('    <media-files offset-type="milliseconds">');
    lines.push(`      <media guid="${esc(mediaGuid)}" location="${esc(opts.mediaName)}"/>`);
    lines.push('    </media-files>');
  }
  for (const xml of doc.mediaXML || []) lines.push(indentFragment(xml, '    '));
  lines.push('  </interlinear-text>');
  lines.push('</document>');
  return lines.join('\n') + '\n';
}

/* ---------------- Baseline reconciliation ----------------
 * Applies edited baseline text (one string per paragraph, segments are
 * re-derived) onto an existing doc, carrying over glosses, free translations,
 * and preserved analyses for unchanged segments/words — and dropping them
 * for changed material, like FLEx does.
 */

/* Derive segmentation-mode time spans from phrase begin/end-time-offset attributes — the
 * flextext-NATIVE alignment carrier (ELAN interop, FLEx 7+; stored on FLEx's Segment object).
 * This is what makes flextext the default segmentation format with no proprietary sidecar
 * (Seth, 2026-08-03): export writes the offsets, this reads them back. One span per PARAGRAPH
 * (the editor's line): a single-phrase paragraph takes its own offsets; a multi-phrase paragraph
 * (e.g. merged in ELAN) takes the envelope first-begin..last-end (per-phrase detail stays
 * preserved in seg.attrs for round-trip). Paragraphs without offsets come back timePending.
 * Returns null when nothing in the doc carries offsets.
 *
 * ⚠ AND WHICH OF THOSE TIMES ARE ESTIMATES (v717, D5) — read back, not lost. Each span from the file
 * gets `guess` (markFileEstimates): from our processing instruction first, else our `~` note, else an
 * equal-length run; a span none of them marks is real, explicitly (`guess: [null, null]`). This is
 * the one reader every caller shares (the editor's import, PAT, lameta, the researcher panel), so
 * they all agree on what is an estimate. */
export function segmentsFromOffsets(doc) {
  let any = false;
  const spans = (doc.paragraphs || []).map((p) => {
    const offs = (p.segments || [])
      .map((s) => [parseInt(s.attrs && s.attrs['begin-time-offset'], 10), parseInt(s.attrs && s.attrs['end-time-offset'], 10)])
      .filter(([b, e]) => Number.isFinite(b) && Number.isFinite(e) && e > b);
    if (!offs.length) return { timePending: true };
    any = true;
    return { start: offs[0][0], end: offs[offs.length - 1][1] };
  });
  if (!any) return null;
  // Malformed sources exist: clamp to monotonic non-overlap (a span may not start before the
  // previous one ends; an unsalvageable span demotes to timePending). Without this a bad file
  // could smuggle crossing spans into the model — and out again as an INVALID EAF, since ELAN
  // requires aligned annotations on a tier to be ordered and non-overlapping (audit find).
  // A start this moves is no longer the file's time: it is recorded as a guess (C0 aside).
  // A span this demotes (nested inside the line before, as overlapping ELAN speakers are) keeps the
  // file's own times as `fileTimes`: the model cannot place them, but the export writes them back (P4).
  let floor = 0;
  spans.forEach((s, k) => {
    if (typeof s.start !== 'number') return;
    const own = [s.start, s.end];
    if (s.start < floor) {
      s.start = floor;
      if (s.end > s.start && k > 0) { s.guess = [s.start, null]; s.estSource = 'edit'; }
    }
    if (s.end <= s.start) { delete s.start; delete s.end; delete s.guess; delete s.estSource; s.timePending = true; s.fileTimes = own; return; }
    floor = s.end;
  });
  markFileEstimates(doc, spans, { todo: () => true });
  return spans;
}

/* A PRE-v717 DOC'S ESTIMATES, read back in memory (v717, case 11). A doc stored by v714 holds spans
 * with no `guess` field: its import ignored the `~`, and its own estimates carry only the flag. This
 * looks at those spans ONLY — a span that has `guess` was decided by v717 and is never re-decided,
 * which is what keeps an explicit "these times are right" from being undone by an old note (case 7) —
 * plus any span an older build flagged beside a copied `guess` it did not understand (segments.js
 * flagOnly: a rollback to v716 and back). Same tests as on import, but a mark counts only if it equals
 * the CURRENT span as well as the phrase's offsets: a seam dragged in v714 moved the span and not the
 * note, and must not come back as a guess. A flag no file mark explains is migrated per edge
 * ('legacy'). Mutates doc.segments in place and writes nothing — the result is saved with the next
 * real edit, and app.js carries an upload's "already on Drive" record across it (opening is not an
 * edit). Returns whether anything changed.
 *
 * ⚠ AND A LINE AN OLDER BUILD CLAMPED AWAY KEEPS THE FILE'S TIMES ON EXPORT. v714–v716 cut stored
 * times to the DECODED length on every render with audio, and saved the result: open T53 against a
 * recording that decodes short and every line past the end became pending, while its phrase still
 * carried the file's real offsets — which v716 went on exporting, and v717's export (live span only,
 * D8) dropped. In a doc this model has not read before (no `timeEdges` mark), a pending line whose
 * phrase's offsets sit in order between its timed neighbours is marked `fileTimes`, so its times go
 * back out as they came (P4). Offsets that overlap a timed neighbour are an edit's leftovers (an older
 * split shared one attrs object between two lines) and stay out, as D8 means them to. */
export function readLegacyEstimates(doc) {
  const spans = doc && Array.isArray(doc.segments) ? doc.segments : null;
  if (!spans || !spans.length) return false;
  const todo = spans.map((s) => isAligned(s) && (!Array.isArray(s.guess) || olderFlag(s)));
  const hold = doc.timeEdges ? [] : spans.map((s, k) => !isAligned(s) && !Array.isArray(s.fileTimes) && heldOffsetsFit(doc, spans, k));
  if (!todo.some(Boolean) && !hold.some(Boolean) && doc.timeEdges) return false;
  const before = JSON.stringify(spans);
  if (todo.some(Boolean)) markFileEstimates(doc, spans, { todo: (k) => todo[k], legacy: true });
  hold.forEach((h, k) => { if (h) spans[k].fileTimes = h; });
  const changed = JSON.stringify(spans) !== before || !doc.timeEdges;
  /* Read once by this model: from here on a pending line is THIS model's verdict (a Segmenter row left
   * without audio, a moved line), and its phrase's old offsets are stale — never held (D8). Every doc
   * parsed or made by v717 carries the mark from the start. */
  doc.timeEdges = true;
  return changed;
}
// A flag no live guessed edge explains (segments.js flagOnly — not exported, it is one line).
const olderFlag = (s) => !!s.timeEstimated && !edgeGuessed(s, 0) && !edgeGuessed(s, 1);
// A phrase's own offsets, when it is its line's only phrase and they are well formed.
function lineOffsets(doc, k) {
  const p = (doc.paragraphs || [])[k];
  if (!p || (p.segments || []).length !== 1) return null;
  const a = p.segments[0].attrs || {};
  const b = parseInt(a['begin-time-offset'], 10), e = parseInt(a['end-time-offset'], 10);
  return Number.isFinite(b) && Number.isFinite(e) && e > b ? [b, e] : null;
}
// Line k's offsets, if they sit between the timed lines around it (within 1 ms), else null.
function heldOffsetsFit(doc, spans, k) {
  const off = lineOffsets(doc, k);
  if (!off) return null;
  for (let j = k - 1; j >= 0; j--) if (isAligned(spans[j])) { if (spans[j].end > off[0] + 1) return null; break; }
  for (let j = k + 1; j < spans.length; j++) if (isAligned(spans[j])) { if (spans[j].start < off[1] - 1) return null; break; }
  return off;
}
/* The file's own times a PENDING line still carries (segments.js `fileTimes`), or null — only while its
 * phrase's offsets are still exactly the times that were held, so an edit that changed the phrase (a
 * split drops the offsets; a join keeps only the first line's) can never send stale ones out. The
 * .flextext writes them back as they came; seg-exports' phraseRows uses them where they keep the tier
 * in order. */
export function heldFileTimes(span, attrs) {
  const h = span && !isAligned(span) && Array.isArray(span.fileTimes) ? span.fileTimes : null;
  if (!h) return null;
  const b = parseInt(attrs && attrs['begin-time-offset'], 10), e = parseInt(attrs && attrs['end-time-offset'], 10);
  if (!Number.isFinite(b) || !Number.isFinite(e) || e <= b) return null;
  return Math.abs(b - h[0]) <= 1 && Math.abs(e - h[1]) <= 1 ? [b, e] : null;
}
/* THE SPANS AN EXPORT WRITES: copies, with a pre-v717 doc's estimates read back exactly as an open would
 * (readLegacyEstimates, on the copy). ⚠ Every export path needs this, not only the open one: a stored
 * record can be serialized without ever being opened on a tab that reads it back — uploaded from the
 * list, sent by auto-backup, built on the Gloss tab with the banner switched off — and before this its
 * `~` marks were dropped there and the guesses went to Drive as measured times (v717 review). */
export function spansForExport(doc) {
  const segs = doc && Array.isArray(doc.segments) ? doc.segments : [];
  if (!segs.length) return [];
  /* ⚠ THE STORABLE FORM FIRST (v718, D8/D12): a placeholder — an untimed line drawn evenly in its gap —
   * is written exactly as storage would hold it, { timePending: true }, so it goes out with no offsets,
   * no "audio" note and no instruction entry, from every exporter at once. */
  const copy = { paragraphs: doc.paragraphs, timeEstimatesPi: doc.timeEstimatesPi, timeEdges: doc.timeEdges,
    segments: storableSegments(segs).map((s) => (s && Array.isArray(s.guess) ? { ...s, guess: s.guess.slice(0, 2) } : { ...s })) };
  readLegacyEstimates(copy);
  /* …and a stored v714/v717 even spread is no time either (v718, case 12): a record exported without
   * ever being drawn again — from the list, by auto-backup — must not send that seed out as times. */
  return withGuesses(seedsToPending(copy.segments, (k) => !!lineOffsets(doc, k)));
}

/* Would the reader's equal-length rule (markFileEstimates, test 3) mark any of these written times? A run
 * of ≥ 3 timed single-phrase lines, each within ±2 ms of the first one's length and meeting end to start.
 * Only consulted when the live model holds no estimate at all, so every line in such a run is real. */
function evenRealRun(spans, doc) {
  const paras = doc.paragraphs || [];
  const ok = (k) => isAligned(spans[k]) && paras[k] && (paras[k].segments || []).length === 1;
  for (let k = 0; k < spans.length;) {
    if (!ok(k)) { k++; continue; }
    const len = spans[k].end - spans[k].start;
    let j = k;
    while (j + 1 < spans.length && ok(j + 1) && Math.abs((spans[j + 1].end - spans[j + 1].start) - len) <= 2
      && Math.abs(spans[j + 1].start - spans[j].end) <= 1) j++;
    if (j - k >= 2) return true;
    k = j + 1;
  }
  return false;
}

// Our own note: "audio ~0:04.000–0:06.000". Attribute order varies by writer, so only `type` is pinned.
const EST_NOTE = /type="note"[^>]*>audio ~(\d+):(\d\d)\.(\d{3})[–-](\d+):(\d\d)\.(\d{3})/;
const noteMs = (m, s, f) => (+m) * 60000 + (+s) * 1000 + (+f);

/* THE THREE READ-BACK TESTS, in order, for the spans `todo(k)` selects (in place):
 *   1. a TIME_ESTIMATES_PI entry with the phrase's guid AND its offsets (within 1 ms), unambiguous
 *      both ways; gives the edges exactly;
 *   2. else our `~` note, its times equal to the offsets within 1 ms;
 *   3. else an equal-length run: ≥ 3 neighbouring spans from the file, each within ±2 ms of the run's
 *      first and meeting end to start — the shape of an even spread, which real speech never has
 *      (real lines differ by seconds; v714's spreads by 1 ms). Covers devices that had notes off.
 * Every test needs the span to EQUAL its phrase's offsets (the span came from the file, unchanged):
 * a split piece carries no offsets, so it can never be mistaken for an equal-length run (BM2).
 * For 2 and 3 the edges come from estimateEdges. Unmarked spans: `[null, null]`, or, with
 * opts.legacy, a pre-v717 flag migrated per edge. */
function markFileEstimates(doc, spans, opts = {}) {
  const paras = doc.paragraphs || [];
  const n = spans.length;
  const todo = (k) => opts.todo(k) && isAligned(spans[k]);
  const fromFile = spans.map((s, k) => {
    if (!todo(k)) return null;
    const p = paras[k];
    if (!p || (p.segments || []).length !== 1) return null;
    const ph = p.segments[0];
    const b = parseInt(ph.attrs && ph.attrs['begin-time-offset'], 10), e = parseInt(ph.attrs && ph.attrs['end-time-offset'], 10);
    if (!Number.isFinite(b) || !Number.isFinite(e)) return null;
    if (Math.abs(s.start - b) > 1 || Math.abs(s.end - e) > 1) return null;
    return { ph, b, e };
  });
  /* An entry belongs to the ONE phrase with its guid AND its times. Not the guid alone: real files
   * carry the same phrase guid on two lines (an older split passed one attrs object to both pieces;
   * L29 and T18 do), and those are exactly the nudged-cut pairs that hold estimates. An entry that
   * fits two phrases, or a phrase that two entries fit, is ambiguous and used for neither. */
  const entries = Array.isArray(doc.timeEstimatesPi) ? doc.timeEstimatesPi : [];
  const fits = (x, guid, b, e) => x.guid === guid && Math.abs(x.start - b) <= 1 && Math.abs(x.end - e) <= 1;
  const phrases = paras.flatMap((p) => (p.segments || []).map((ph) => ph.attrs || {}))
    .map((a) => [a.guid, parseInt(a['begin-time-offset'], 10), parseInt(a['end-time-offset'], 10)]);
  const how = new Array(n).fill(null);
  const exact = new Array(n).fill(null);
  fromFile.forEach((f, k) => {
    if (!f) return;
    const guid = f.ph.attrs && f.ph.attrs.guid;
    const mine = guid ? entries.filter((x) => fits(x, guid, f.b, f.e)) : [];
    const entry = mine.length === 1 && phrases.filter(([g, b, e]) => fits(mine[0], g, b, e)).length === 1 ? mine[0] : null;
    if (entry) {
      how[k] = 'marker';
      exact[k] = [entry.gs ? spans[k].start : null, entry.ge ? spans[k].end : null];
      return;
    }
    for (const x of f.ph.postItemsXML || []) {
      const m = EST_NOTE.exec(x);
      if (m && Math.abs(noteMs(m[1], m[2], m[3]) - f.b) <= 1 && Math.abs(noteMs(m[4], m[5], m[6]) - f.e) <= 1) { how[k] = 'note'; break; }
    }
  });
  for (let k = 0; k < n;) {
    if (!fromFile[k]) { k++; continue; }
    const len = spans[k].end - spans[k].start;
    let j = k;
    while (j + 1 < n && fromFile[j + 1] && Math.abs((spans[j + 1].end - spans[j + 1].start) - len) <= 2
      && Math.abs(spans[j + 1].start - spans[j].end) <= 1) j++;
    if (j - k >= 2) for (let q = k; q <= j; q++) if (!how[q]) how[q] = 'pattern';
    k = j + 1;
  }
  /* ⚠ NOT WHEN THE FILE CARRIES OUR PROCESSING INSTRUCTION. A writer that wrote it listed every
   * estimate it held, per edge — so a run the instruction does not list is real, however even it looks.
   * Without this a real line after a word-fraction split into two equal halves (three equal lengths in a
   * row) came back marked, and every later export wrote `~` on it (v717 review). */
  // (v718) …an instruction that lists NONE included: it says the same about every run in the file.
  if (Array.isArray(doc.timeEstimatesPi)) for (let k = 0; k < n; k++) if (how[k] === 'pattern') how[k] = null;
  const est = (j) => (todo(j) ? !!how[j] || (opts.legacy && !!spans[j].timeEstimated) : isEstimate(spans[j]));
  /* A legacy flag with the phrase's own offsets to compare against: the edges that DIFFER from the
   * file's are the ones somebody moved (v714–v716's normalize pushed a start to the previous line's end
   * and flagged the span; the neighbour rule alone marked its untouched end instead). C0 as ever. */
  const movedEdges = (k) => {
    const off = lineOffsets(doc, k);
    if (!off) return null;
    const s = spans[k];
    const gs = k > 0 && Math.abs(s.start - off[0]) > 1, ge = k < n - 1 && Math.abs(s.end - off[1]) > 1;
    return gs || ge ? [gs ? s.start : null, ge ? s.end : null] : null;
  };
  const decided = spans.map((s, k) => {
    if (!todo(k)) return null;
    if (how[k] === 'marker') return { guess: exact[k], src: 'marker' };
    if (how[k]) return { guess: estimateEdges(spans, k, est), src: how[k] };
    if (opts.legacy && s.timeEstimated) return { guess: movedEdges(k) || estimateEdges(spans, k, est), src: s.estSource || 'legacy' };
    return { guess: Array.isArray(s.guess) ? s.guess : [null, null], src: s.estSource };
  });
  decided.forEach((d, k) => {
    if (!d) return;
    const s = spans[k];
    s.guess = d.guess.slice(0, 2);
    /* C0 is decided where guesses are made: estimateEdges and movedEdges never mark the first start or
     * the last end. A marker entry says exactly what our writer held — after the first line of an
     * estimated text was deleted, its new first start IS a guess — except that 0, the recording's own
     * start, is a fact whatever anyone wrote. */
    if (k === 0 && s.guess[0] != null && s.start <= 1) s.guess[0] = null;
    if (d.src) s.estSource = d.src; else delete s.estSource;
    settleSpan(s);
  });
}

export function getBaselineParagraphs(doc) {
  return doc.paragraphs.map(p => p.segments.map(s => s.baseline).join(' ').trim());
}

/* opts.flatSegments — ONE phrase per line, punctuation ignored (Simple-ELAN segmentation mode).
 *
 * ⚠ WHY THIS OPTION EXISTS. Normally a line is split into sentence-phrases by segmentText(), i.e.
 * punctuation decides the structure. That is wrong for pause-based transcription: mother-tongue
 * transcribers break where they HEAR a pause, and cannot be relied on to punctuate at all — so
 * inferring phrase structure from their punctuation invents information they never supplied.
 *
 * It also breaks time alignment. Time lives on the PHRASE (per ELAN's FLEx mapping), so a
 * two-sentence line would need two times from a single Enter keypress — times the user never chose.
 *
 * In flat mode each line becomes exactly one paragraph holding exactly one phrase, so
 * line <-> paragraph <-> phrase <-> time span is 1:1:1:1 and nothing is inferred.
 */
export function reconcileBaseline(doc, paragraphTexts, opts = {}) {
  reconcileLines(doc, paragraphTexts, opts);
  return doc;
}

/* THE SAME EDIT, SAYING WHERE EVERY NEW LINE CAME FROM (v717, D10). Returns `origins`, one per line
 * of the reconciled doc (doc.paragraphs[j]), each naming OLD line indices (the doc.segments indices
 * before the edit):
 *   { kind: 'kept',  from: i }           the line is untouched (the very same paragraph object)
 *   { kind: 'exact', from: i }           the same text, matched phrase by phrase
 *   { kind: 'edit',  from: i }           a changed line paired with old line i (a typo fix)
 *   { kind: 'join',  from: [i, i+1, …] } several old lines joined into this one
 *   { kind: 'split', from: i, frac: [a, b] }  this line is old line i's words a..b (fractions 0–1)
 *   { kind: 'new' }                      a fresh line — no time, guid, offsets or translation inherited
 * A line moved past others also carries `moved: true` — it is still that line (words, guid,
 * translation), but its audio stayed where it was.
 * segmentsFollowLines (segments.js) turns this into the time list, so the text box can never again
 * pair lines with times by position. */
export function reconcileBaselineWithOrigins(doc, paragraphTexts, opts = {}) {
  return reconcileLines(doc, paragraphTexts, opts);
}

function reconcileLines(doc, paragraphTexts, opts = {}) {
  const flat = !!opts.flatSegments;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  // Pass 0: paragraphs whose text is unchanged are kept verbatim (object
  // identity), so untouched parts of the text can never degrade. LCS pairing
  // tolerates inserted/deleted/reordered paragraphs.
  const oldParas = doc.paragraphs;
  const oldParaTexts = oldParas.map(p => norm(p.segments.map(s => s.baseline).join(' ')));
  const paraPairs = lcsPairs(oldParaTexts, paragraphTexts.map(norm));
  const keptOldByNew = new Map(paraPairs.map(([i, j]) => [j, i]));
  const keptOld = new Set(paraPairs.map(([i]) => i));

  // Carry-over pool: segments from old paragraphs that were not kept verbatim. Every old phrase also
  // records its line, its position in the old text and where its words sit within its line — the
  // stretches below and the origins at the end are measured in those.
  const oldSegs = [];
  const oldInfo = new Map();   // old phrase -> { line, pos, tokFrom, tokTotal }
  const oldLinePos = [];       // old line -> position of its first phrase
  {
    let pos = 0;
    oldParas.forEach((p, i) => {
      oldLinePos[i] = pos;
      const toks = p.segments.map((sg) => tokenize(sg.baseline || '').length);
      const total = toks.reduce((x, y) => x + y, 0);
      let from = 0;
      p.segments.forEach((sg, k) => {
        oldInfo.set(sg, { line: i, pos: pos++, tokFrom: from, tokTotal: total });
        from += toks[k];
        if (!keptOld.has(i)) oldSegs.push(sg);
      });
    });
  }

  // Skeleton for changed/new paragraphs only.
  const newParas = paragraphTexts.map((text, j) => {
    if (keptOldByNew.has(j)) return oldParas[keptOldByNew.get(j)];
    // Flat mode keeps the line whole (even an EMPTY line, which is a legitimate timed segment
    // marking silence/untranscribable audio); default mode splits it into sentence-phrases.
    return { guid: newGuid(), segments: [], segTexts: flat ? [text] : segmentText(text) };
  });

  const newSegsFlat = [];
  /* [oldPos, newPos, weight] of everything kept or matched exactly — see Pass 2. The weight decides
   * which of two crossing anchors is the one that MOVED: a line with words outweighs a blank one, and a
   * paragraph kept verbatim outweighs an exact match by a hair. */
  const anchors = [];
  const anchorWeight = (text, kept) => (norm(text || '') ? 2 : 1) + (kept ? 0.001 : 0);
  {
    let pos = 0;
    newParas.forEach((p, j) => {
      if (!p.segTexts) { // kept paragraph
        anchors.push([oldLinePos[keptOldByNew.get(j)], pos, anchorWeight(p.segments.map((s) => s.baseline).join(' '), true)]);
        pos += p.segments.length; return;
      }
      for (const t of p.segTexts) newSegsFlat.push({ text: t, para: p, pos: pos++ });
    });
  }

  // Pass 1: LCS over changed segments with exact (whitespace-normalized) text equality.
  const a = oldSegs.map(s => norm(s.baseline));
  const b = newSegsFlat.map(s => norm(s.text));
  const pairs = lcsPairs(a, b);
  const oldMatched = new Map(); // newIdx -> oldSeg
  const oldUsed = new Set();
  for (const [i, j] of pairs) {
    oldMatched.set(j, oldSegs[i]); oldUsed.add(i);
    anchors.push([oldInfo.get(oldSegs[i]).pos, newSegsFlat[j].pos, anchorWeight(newSegsFlat[j].text, false)]);
  }
  /* …and the exact matches an order-preserving LCS cannot take: two lines that crossed (one moved down
   * past the other) are both still there word for word, and the LCS keeps only one. The same text is
   * the same line, moved — paired here, so it keeps its own words, guid and translation and can never
   * be taken for an edit of the line whose place it landed in (v717 review: a line moved into a deleted
   * line's slot inherited that line's time and translation). Off the chain below, it is `moved`. */
  {
    const byText = new Map();
    oldSegs.forEach((sg, i) => { if (!oldUsed.has(i)) { if (!byText.has(a[i])) byText.set(a[i], []); byText.get(a[i]).push(i); } });
    newSegsFlat.forEach((ns, j) => {
      const list = oldMatched.has(j) ? null : byText.get(b[j]);
      if (!list || !list.length) return;
      const i = list.shift();
      oldMatched.set(j, oldSegs[i]); oldUsed.add(i);
      anchors.push([oldInfo.get(oldSegs[i]).pos, ns.pos, anchorWeight(ns.text, false)]);
    });
  }

  /* Pass 2: pair leftover old/new segments in order — but FIRST recognise the two edits that move
   * a boundary rather than the text: a JOIN (one new line == several old ones) and a SPLIT (one old
   * line == several new ones).
   *
   * ⚠ WHY THIS EXISTS (Seth, 2026-08-12): plain 1:1 pairing gave a joined line the LEFT segment and
   * dropped the right one entirely — "joining on the gloss tab loses all existing glosses and free
   * translations in the second line joined". Every gloss the team had typed on that line was gone,
   * silently, from an edit that only meant to move a boundary. The text is sacred here in both
   * directions: a boundary change must carry the words (and their glosses) across it.
   *
   * JOIN: words concatenate in order; the free translations concatenate with a space (both were
   * real sentences and neither is more correct than the other).
   * SPLIT: each piece takes the words that fall in it; the free translation goes to the LONGEST
   * piece and the other pieces start blank — a guess, but the honest one, and Seth's rule is that
   * the transcriber checks it afterwards.
   *
   * ⚠ AND ONLY WITHIN A STRETCH (v717, plans/time-gaps-and-estimates.md D10, cases 1 and 8). The pairing
   * used to run over the WHOLE document in order: delete line 2 and add a line at line 30, and line 30
   * inherited line 2's free translation, guid and offsets — and once times follow lines, its audio.
   * Now the leftovers are grouped into STRETCHES between exact anchors (kept lines, exact matches), so
   * nothing can pair across a line that did not change. Within a stretch:
   *   · first the order-preserving alignment with the most shared words, where a 1:1 pair needs at
   *     least half of the OLD line's words and joins and splits are recognised exactly as above;
   *   · then each GAP that evidence leaves (between two of its pairs, or a stretch end) pairs in
   *     order when it holds as many new lines as old ones — a line rewritten in place, a one-word typo
   *     fix, keeps its line's everything, as before — and otherwise its new lines are FRESH: no
   *     offsets, guid or free translation copied.
   *     ("a b / NEW LINE / c x / e f" over "a b / c d / e f": "c x" keeps c d's guid, translation
   *     and time; NEW LINE gets none of them.)
   * ⚠ EVIDENCE FIRST, EVEN WHEN THE COUNTS AGREE. Two edits that cancel out in line count — delete
   * "bb b1", fix a typo in "cc c1", add "new n1" after it — used to take the in-order path because the
   * stretch had two old lines and two new ones, and handed "cc c1x" bb's time, guid and translation and
   * "new n1" cc's (v717 review: ~1 in 60 random two-edit sequences). Counting lines says nothing about
   * which line is which; the shared words do. */
  const leftoverOld = oldSegs.filter((sg, i) => !oldUsed.has(i));
  const unmatchedNew = newSegsFlat.map((sg, j) => j).filter(j => !oldMatched.has(j));
  const fuzzyPair = new Map();   // newIdx -> { olds:[seg], wordSlice?:[from,to], takesFree?:bool }
  const newText = (j) => norm(newSegsFlat[j].text);
  // A split of old line `old` across the new lines `js` (consecutive), its free translation to the longest.
  const planSplit = (old, js) => {
    let longest = 0;
    for (let p = 1; p < js.length; p++) if (newText(js[p]).length > newText(js[longest]).length) longest = p;
    let at = 0;
    js.forEach((j, p) => {
      const n = tokenize(newSegsFlat[j].text).length;
      fuzzyPair.set(j, { olds: [old], wordSlice: [at, at + n], takesFree: p === longest });
      at += n;
    });
  };
  /* How many olds from i build exactly to new line j (a JOIN), or how many news from j rebuild old
   * line i (a SPLIT). Compared with the whitespace taken out: the Gloss tab rebuilds each half of a
   * split from its WORDS joined by spaces ("a , b ." for "a, b."), and that is still the same line. */
  const squash = (t) => String(t || '').replace(/\s+/g, '');
  const build = (parts, from, whole) => {
    let acc = parts[from], take = 1;
    while (acc !== whole && whole.startsWith(acc) && from + take < parts.length) { acc += parts[from + take]; take++; }
    return acc === whole && take > 1 ? take : 0;
  };
  const stretchText = (olds, news) => ({ sqO: olds.map((sg) => squash(sg.baseline)), sqN: news.map((j) => squash(newSegsFlat[j].text)) });
  // The as-many-as-there-were walk (the pre-v717 pass, now inside one stretch).
  // `allow(old, newIdx)` vetoes a plain positional pair (joins and splits are exact, so never vetoed).
  const inOrder = (olds, news, allow = () => true) => {
    const { sqO, sqN } = stretchText(olds, news);
    let oi = 0, ui = 0;
    while (ui < news.length && oi < olds.length) {
      const take = build(sqO, oi, sqN[ui]);
      if (take) { fuzzyPair.set(news[ui], { olds: olds.slice(oi, oi + take) }); oi += take; ui++; continue; }
      const take2 = build(sqN, ui, sqO[oi]);
      if (take2) { planSplit(olds[oi], news.slice(ui, ui + take2)); oi++; ui += take2; continue; }
      if (allow(olds[oi], news[ui])) fuzzyPair.set(news[ui], { olds: [olds[oi]] });
      oi++; ui++;
    }
  };
  /* The best order-preserving alignment by shared words: a dynamic programme over the stretch whose
   * moves are join, split, pair (≥ half the old line's words shared), drop an old line, take a new
   * line fresh — preferred in that order on a tie. Words are compared as sorted lists. */
  const wordsOf = (t) => tokenize(t || '').filter((x) => !x.punct).map((x) => x.txt.toLowerCase()).sort();
  const shared = (a, b) => { let n = 0; for (let x = 0, y = 0; x < a.length && y < b.length;) { if (a[x] === b[y]) { n++; x++; y++; } else if (a[x] < b[y]) x++; else y++; } return n; };
  const JOIN = 1, SPLIT = 2, PAIR = 3, DROP = 4;
  // Returns the blocks it paired, in order, as [oldFrom, oldTo, newFrom, newTo) — the gaps between them
  // are what pairStretch then fills in order where the counts agree.
  const byWords = (olds, news) => {
    const blocks = [];
    const m = olds.length, n = news.length, W = n + 1;
    const { sqO, sqN } = stretchText(olds, news);
    const oW = olds.map((sg) => wordsOf(sg.baseline)), nW = news.map((j) => wordsOf(newSegsFlat[j].text));
    const best = new Uint32Array((m + 1) * W), pick = new Uint8Array((m + 1) * W), take = new Uint32Array((m + 1) * W);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        const at = i * W + j;
        let top = -1, code = 0, k = 0;
        const tj = sqN[j].startsWith(sqO[i]) ? build(sqO, i, sqN[j]) : 0;
        if (tj) { top = Math.max(1, nW[j].length) + best[(i + tj) * W + j + 1]; code = JOIN; k = tj; }
        const ts = sqO[i].startsWith(sqN[j]) ? build(sqN, j, sqO[i]) : 0;
        if (ts) { const v = Math.max(1, oW[i].length) + best[(i + 1) * W + j + ts]; if (v > top) { top = v; code = SPLIT; k = ts; } }
        if (oW[i].length) {
          const sh = shared(oW[i], nW[j]);
          if (2 * sh >= oW[i].length) { const v = sh + best[(i + 1) * W + j + 1]; if (v > top) { top = v; code = PAIR; } }
        }
        if (best[(i + 1) * W + j] > top) { top = best[(i + 1) * W + j]; code = DROP; }
        if (best[at + 1] > top) { top = best[at + 1]; code = 0; }
        best[at] = top; pick[at] = code; take[at] = k;
      }
    }
    for (let i = 0, j = 0; i < m && j < n;) {
      const at = i * W + j, k = take[at];
      if (pick[at] === JOIN) { fuzzyPair.set(news[j], { olds: olds.slice(i, i + k) }); blocks.push([i, i + k, j, j + 1]); i += k; j++; }
      else if (pick[at] === SPLIT) { planSplit(olds[i], news.slice(j, j + k)); blocks.push([i, i + 1, j, j + k]); i++; j += k; }
      else if (pick[at] === PAIR) { fuzzyPair.set(news[j], { olds: [olds[i]] }); blocks.push([i, i + 1, j, j + 1]); i++; j++; }
      else if (pick[at] === DROP) i++;
      else j++;
    }
    return blocks;
  };
  /* One stretch: word evidence first, then the gaps it leaves, in order where the counts agree — but a
   * positional pair is vetoed when either line shares MORE words with another leftover line, in this
   * stretch or any other, than with its partner: "bb b1 y" sitting in dd's slot is bb, edited and
   * moved, not a rewrite of dd, and must not inherit dd's time or translation. (Across stretches too: a
   * line split and then passed by a moved line has its pieces in one stretch and itself in the next.)
   * A line that shares nothing with anything (a rewrite, a one-word typo fix) still pairs with the
   * line whose place it took. */
  const leftW = new Map(leftoverOld.map((sg) => [sg, wordsOf(sg.baseline)]));
  const freshW = new Map(unmatchedNew.map((j) => [j, wordsOf(newSegsFlat[j].text)]));
  const allow = (old, nj) => {
    const ow = leftW.get(old), nw = freshW.get(nj);
    const own = shared(ow, nw);
    for (const [q, w] of freshW) if (q !== nj && shared(ow, w) > own) return false;
    for (const [o2, w] of leftW) if (o2 !== old && shared(w, nw) > own) return false;
    return true;
  };
  const pairStretch = (olds, news) => {
    let oi = 0, nj = 0;
    for (const [o0, o1, n0, n1] of [...byWords(olds, news), [olds.length, olds.length, news.length, news.length]]) {
      if (o0 - oi > 0 && o0 - oi === n0 - nj) inOrder(olds.slice(oi, o0), news.slice(nj, n0), allow);
      oi = o1; nj = n1;
    }
  };
  const movedNew = new Set();   // new positions of anchors off the chain: lines MOVED to another place
  {
    /* The stretches. Anchors that cross each other (a line moved past another) cannot both bound a
     * stretch, so the boundaries are the heaviest chain of anchors increasing on both sides. An anchor
     * off the chain is a line that moved: it keeps its words, guid and translation — it is the same
     * line — but its origin says `moved`, so segmentsFollowLines does not carry its time out of order. */
    anchors.sort((x, y) => x[1] - y[1] || x[0] - y[0]);
    const len = anchors.map((x) => x[2]), prev = anchors.map(() => -1);
    for (let k = 0; k < anchors.length; k++) {
      for (let q = 0; q < k; q++) if (anchors[q][0] <= anchors[k][0] && anchors[q][1] <= anchors[k][1] && len[q] + anchors[k][2] > len[k]) { len[k] = len[q] + anchors[k][2]; prev[k] = q; }
    }
    const chain = [];
    let top = -1;
    for (let k = 0; k < anchors.length; k++) if (top < 0 || len[k] > len[top]) top = k;
    const onChain = new Set();
    for (let k = top; k >= 0; k = prev[k]) { chain.unshift(anchors[k]); onChain.add(k); }
    anchors.forEach((x, k) => { if (!onChain.has(k)) movedNew.add(x[1]); });
    const stretchOf = (posIdx, side) => { let c = 0; while (c < chain.length && chain[c][side] <= posIdx) c++; return c; };
    const groups = new Map();
    const group = (id) => { if (!groups.has(id)) groups.set(id, { olds: [], news: [] }); return groups.get(id); };
    for (const sg of leftoverOld) group(stretchOf(oldInfo.get(sg).pos, 0)).olds.push(sg);
    for (const j of unmatchedNew) group(stretchOf(newSegsFlat[j].pos, 1)).news.push(j);
    for (const { olds, news } of groups.values()) {
      if (!olds.length || !news.length) continue;
      pairStretch(olds, news);
    }
  }

  const result = newSegsFlat.map((ns, j) => {
    const exact = oldMatched.get(j);
    if (exact) { exact.baseline = ns.text; return { seg: exact, para: ns.para }; }
    const plan = fuzzyPair.get(j);
    const old = plan ? plan.olds[0] : null;
    const tokens = tokenize(ns.text);
    // The words this new line inherits: its slice of a split line, or every old line's words in
    // order for a join. carryWords then aligns them to the actual tokens, so a word whose text
    // survived keeps its gloss.
    const source = !plan ? []
      : plan.wordSlice ? (old.words || []).slice(plan.wordSlice[0], plan.wordSlice[1])
        : plan.olds.flatMap((o) => o.words || []);
    const words = plan ? carryWords(source, tokens) : tokens.map(t => makeWord(t.txt, { punct: t.punct }));
    /* ⚠ A JOIN TAKES EVERY SIDE'S TRANSLATIONS, EACH IN ITS OWN LANGUAGE (Seth's FLEx round-trip report,
     * 2026-10-17). It joined the slots as one text whatever language each held, and kept the first line's
     * items only — another language's translation, or a note, on the line joined in was dropped, though the
     * comment below has always promised mergePhrases' rule. Now it is mergePhrases', and the doc's analysis
     * language says what a slot with no tag of its own is in. */
    const joined = plan && !plan.wordSlice && plan.olds.length > 1 ? mergePhrases(plan.olds, { prim: doc.analLang || '' }) : null;
    const free = !plan ? ''
      : plan.wordSlice ? (plan.takesFree ? old.free : '')
        : joined ? joined.free : old.free;
    /* ⚠ EACH PIECE OF A SPLIT IS ITS OWN PHRASE. attrs used to be passed BY REFERENCE, so every piece
     * of a split line shared one object — one GUID for two phrases in the FLExText, and the old
     * begin/end offsets (the whole line's) on both. The first piece keeps the line's GUID (it IS the
     * line, shortened, as a join keeps the first phrase's); the others are new phrases with new
     * GUIDs; no piece carries the old offsets (half an extent is not an extent — the app's own
     * timing in doc.segments is written fresh). The notes and other unknown items ride with the
     * piece that keeps the free translation, once, not on every piece. A join keeps every item from
     * every side (mergePhrases' rule) — that path is untouched here. */
    const isSplit = !!(plan && plan.wordSlice);
    const firstPiece = isSplit && plan.wordSlice[0] === 0;
    // a join's first line may be a break stored as a line (mergePhrases): the line keeps the first TEXT line's GUID
    const keeper = joined && isLineBreakPhrase(old) ? (plan.olds.find((o) => !isLineBreakPhrase(o)) || old) : old;
    const attrs = keeper ? { ...(keeper.attrs || {}) } : undefined;
    if (attrs && isSplit) {
      if (!firstPiece) attrs.guid = newGuid();
      delete attrs['begin-time-offset'];
      delete attrs['end-time-offset'];
    }
    const carriesItems = !isSplit || plan.takesFree;
    const seg = makeSegment(ns.text, words, old ? {
      free, freeLang: joined ? joined.freeLang : old.freeLang,
      preItemsXML: joined ? joined.preItemsXML : carriesItems ? (old.preItemsXML || []).slice() : [],
      postItemsXML: joined ? joined.postItemsXML : carriesItems ? (old.postItemsXML || []).slice() : [],
      attrs,
    } : {});
    if (old && old.txtLang) seg.txtLang = old.txtLang;
    /* FLEx's hard line breaks beside it (foldLineBreaks): a split's first piece keeps the one before the line,
     * its last piece the one after; a join keeps the first line's before and the last line's after — the ones
     * between the joined lines go with the join, as in FLEx. */
    if (joined && plan.olds.some(isLineBreakPhrase)) {
      // the breaks this join folded are written as their own phrases: their character is not the line's text too
      seg.baseline = String(seg.baseline || '').replace(/\u2028/g, ' ').trim();
      if (joined.breaksBefore) seg.breaksBefore = joined.breaksBefore.slice();
      if (joined.breaksAfter) seg.breaksAfter = joined.breaksAfter.slice();
    } else if (plan) {
      const lastOld = plan.olds[plan.olds.length - 1];
      const lastPiece = !isSplit || plan.wordSlice[1] >= (old.words || []).length;
      if ((!isSplit || firstPiece) && old.breaksBefore && old.breaksBefore.length) seg.breaksBefore = old.breaksBefore.slice();
      if (lastPiece && lastOld.breaksAfter && lastOld.breaksAfter.length) seg.breaksAfter = lastOld.breaksAfter.slice();
    }
    return { seg, para: ns.para };
  });

  // Fill in segments of changed paragraphs; kept paragraphs already have theirs.
  for (const { seg, para } of result) para.segments.push(seg);
  // ⚠ FLAT-MODE GUARANTEE: one line = one phrase, INCLUDING EMPTY LINES. An empty line is how the
  // transcriber marks silence (Enter, play through the pause, Enter again) — its paragraph must
  // still carry exactly one (empty) segment, or every per-segment view drifts: the gloss tab
  // renders one group per SEGMENT, so a zero-segment paragraph silently vanished there and every
  // following line paired with the WRONG waveform (Seth's misalignment report). The baseline tab
  // masked the defect by rendering from paragraph texts.
  if (flat) for (const p of newParas) { if (!p.segments.length) p.segments.push(makeSegment('', [])); }

  /* WHERE EACH LINE CAME FROM, line by line (reconcileBaselineWithOrigins). A line is usually one
   * phrase; a line the default (non-flat) mode split into sentences is several, and is described by
   * the old lines its phrases came from together. */
  const phraseFrom = newSegsFlat.map((ns, j) => {
    const exact = oldMatched.get(j);
    if (exact) return { kind: 'exact', olds: [exact] };
    const plan = fuzzyPair.get(j);
    if (!plan) return { kind: 'new', olds: [] };
    if (plan.wordSlice) return { kind: 'split', olds: plan.olds, slice: plan.wordSlice };
    return { kind: plan.olds.length > 1 ? 'join' : 'edit', olds: plan.olds };
  });
  /* `moved` (one of the line's anchors fell off the chain above) rides on its origin for
   * segmentsFollowLines, which keeps times only where the old order holds. */
  const keptPos = new Map();
  {
    let pos = 0;
    newParas.forEach((p, j) => { if (!p.segTexts) keptPos.set(j, pos); pos += p.segTexts ? p.segTexts.length : p.segments.length; });
  }
  const origins = newParas.map((p, j) => {
    if (!p.segTexts) {
      const o = { kind: 'kept', from: keptOldByNew.get(j) };
      if (movedNew.has(keptPos.get(j))) o.moved = true;
      return o;
    }
    const moved = newSegsFlat.some((ns) => ns.para === p && movedNew.has(ns.pos));
    const mine = phraseFrom.filter((o, k) => newSegsFlat[k].para === p && o.kind !== 'new');
    if (!mine.length) return { kind: 'new' };
    const lines = [...new Set(mine.flatMap((o) => o.olds.map((sg) => oldInfo.get(sg).line)))].sort((x, y) => x - y);
    const tag = (o) => { if (moved) o.moved = true; return o; };
    if (lines.length > 1) return tag({ kind: 'join', from: lines });
    if (mine.every((o) => o.kind === 'split')) {
      let a = 1, b = 0;
      for (const o of mine) {
        const inf = oldInfo.get(o.olds[0]);
        if (!(inf.tokTotal > 0)) { a = 0; b = 1; break; }
        a = Math.min(a, (inf.tokFrom + o.slice[0]) / inf.tokTotal);
        b = Math.max(b, (inf.tokFrom + o.slice[1]) / inf.tokTotal);
      }
      if (a > 0 || b < 1) return tag({ kind: 'split', from: lines[0], frac: [a, Math.min(1, b)] });
    }
    return tag({ kind: mine.every((o) => o.kind === 'exact') ? 'exact' : 'edit', from: lines[0] });
  });

  doc.paragraphs = newParas.map(p => { delete p.segTexts; return p; });
  if (!doc.paragraphs.length) { doc.paragraphs.push({ guid: newGuid(), segments: [] }); origins.push({ kind: 'new' }); }
  return origins;
}

// Word-level carry-over inside a changed segment: LCS over token text, where a
// chained phrase-word matches only if all of its space-separated parts match
// contiguously.
function carryWords(oldWords, newTokens) {
  const oldParts = [];
  oldWords.forEach((w, wi) => {
    const parts = w.phrase ? w.txt.split(/\s+/) : [w.txt];
    parts.forEach((p, pi) => oldParts.push({ txt: p, wi, pi, nParts: parts.length }));
  });
  const pairs = lcsPairs(oldParts.map(p => p.txt), newTokens.map(t => t.txt));
  const matchOfOld = new Map(); // oldPartIdx -> newIdx
  for (const [i, j] of pairs) matchOfOld.set(i, j);

  // A word is carried if every part matched, contiguously in both sequences.
  const carriedAt = new Map(); // newIdx (start) -> {word, span}
  for (let wi = 0, base = 0; wi < oldWords.length; wi++) {
    const w = oldWords[wi];
    const nParts = w.phrase ? w.txt.split(/\s+/).length : 1;
    let ok = true, start = -1;
    for (let pi = 0; pi < nParts; pi++) {
      const j = matchOfOld.get(base + pi);
      if (j === undefined || (pi > 0 && j !== start + pi)) { ok = false; break; }
      if (pi === 0) start = j;
    }
    if (ok && start >= 0 && !carriedAt.has(start)) carriedAt.set(start, { word: w, span: nParts });
    base += nParts;
  }

  const out = [];
  for (let j = 0; j < newTokens.length;) {
    const hit = carriedAt.get(j);
    if (hit) { out.push(hit.word); j += hit.span; }
    else { out.push(makeWord(newTokens[j].txt, { punct: newTokens[j].punct })); j++; }
  }
  return out;
}

function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  // DP table (n+1)x(m+1); fine for typical text sizes.
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/* ---------------- Gloss-tab structural edits ---------------- */

// Merge word at index i with the next non-punct word (must be adjacent, no punct between).
export function canMerge(seg, i) {
  const w = seg.words[i], next = seg.words[i + 1];
  return !!(w && next && !w.punct && !next.punct);
}

/* ⚠ WHERE THE LINE MAY BE SPLIT, which is NOT simply "wherever it may be chained" (issue #73;
 * Seth, 2026-09-10: "when there's punctuation, split scissors do not show up between word/gloss
 * pairs where the punctuation sits").
 *
 * The ✂ used to be hung off each chain-link, so canMerge decided both. That gate is right for
 * CHAINING — you cannot merge a word with a comma into one lexical item — and wrong for SPLITTING,
 * where a gap beside punctuation is often the very place a line wants to break. Two different
 * questions had one answer.
 *
 * The split rule is its own, and it is a typographic one:
 *
 *   1. A TRAILING MARK MAY NOT START THE NEW LINE. A comma or full stop belongs to the word in
 *      front of it, so a split before one would strand "," at the head of the next line. Splitting
 *      AFTER it is exactly right, and is the gap Seth found missing.
 *   2. A LEADING MARK MAY NOT END THE OLD ONE (Seth, 2026-09-10: "What about single and double
 *      quotes and parentheses…? Keep opening/first punctuation marks in mind too."). An opening
 *      bracket or quote belongs to the word AFTER it, so the mirror of rule 1 applies: a split
 *      between "(" and its word would leave the bracket dangling at the end of the previous line.
 *      Splitting BEFORE the "(" is fine — the whole "(bar)" travels together.
 *   3. NEITHER SIDE MAY BE LEFT WITHOUT A REAL WORD, so a line of nothing but punctuation cannot be
 *      created.
 *   0. AND A MARK WHOSE SIDE CANNOT BE KNOWN GETS NO BREAK EITHER SIDE. The straight quotes open and
 *      close with the same character; refusing both gaps can never strand one, where guessing can.
 *      See punctSideUnknown.
 *
 * ⚠ WHICH SIDE A MARK BELONGS TO IS NOT DECIDED HERE. punctLeadsWord is shared with
 * baselineFromWords, which puts the whitespace on that same side when it rebuilds the line. Two
 * separate notions of "this comma is trailing" would eventually disagree, and the visible result
 * would be a split whose two halves re-join wrongly.
 *
 * For "Kaisou fedahu, tudu bisa." that offers gaps 1, 3 and 4 — including 3, immediately after the
 * comma, the natural clause break — and withholds 2 and 5. For "foo (bar) baz" it offers the gap
 * BEFORE "(" and after ")", and withholds the one between "(" and "bar". Interior gaps only: the
 * edges have their own trim ✂. */
export function canSplitBefore(seg, k) {
  const words = (seg && seg.words) || [];
  if (!(k > 0 && k < words.length)) return false;
  const at = words[k], prev = words[k - 1];
  if (!at || !prev) return false;
  // 0. a mark whose side cannot be known belongs to neither: no break on either side of it
  if ((at.punct && punctSideUnknown(at.txt)) || (prev.punct && punctSideUnknown(prev.txt))) return false;
  // 1. a TRAILING mark may not start the new line — it belongs to the word behind it
  if (at.punct && !punctLeadsWord(at.txt)) return false;
  // 2. a LEADING mark may not end the old one — it belongs to the word ahead of it
  if (prev.punct && punctLeadsWord(prev.txt)) return false;
  // 3. neither side may be left without a real word
  let head = false, tail = false;
  for (let j = 0; j < k; j++) if (words[j] && !words[j].punct) { head = true; break; }
  for (let j = k; j < words.length; j++) if (words[j] && !words[j].punct) { tail = true; break; }
  return head && tail;
}

export function mergeWords(seg, i) {
  if (!canMerge(seg, i)) return false;
  const a = seg.words[i], b = seg.words[i + 1];
  const merged = makeWord(a.txt + ' ' + b.txt, { phrase: true });
  merged.gls = [a.gls, b.gls].filter(Boolean).join(' ');
  merged.txtLang = a.txtLang;
  merged.glsLang = a.glsLang || b.glsLang;
  seg.words.splice(i, 2, merged);
  return true;
}

export function breakPhrase(seg, i) {
  const w = seg.words[i];
  if (!w || !w.phrase) return false;
  const parts = w.txt.split(/\s+/).filter(Boolean);
  const repl = parts.map((p, idx) => {
    const nw = makeWord(p);
    nw.txtLang = w.txtLang;
    if (idx === 0) { nw.gls = w.gls; nw.glsLang = w.glsLang; } // keep gloss rather than silently losing it
    return nw;
  });
  seg.words.splice(i, 1, ...repl);
  return true;
}

/* ---------------- Word split / insert (seg-word-split; plan §4.3 item 1, §6.5) ----------------
 *
 * Two edits that CHANGE THE BASELINE from a word-level view, written so that a later Save to FLEx is
 * the minimal diff FLEx itself would make:
 *
 *   splitWordAt(seg, k, offset)  — word k becomes two words, cut at character `offset` of its text.
 *     FLEx's equivalent is inserting ONE space inside the word [verified: only that word becomes two
 *     unanalysed WfiWordforms; every other analysis GUID is kept]. So BOTH halves are new,
 *     unglossed words here too: the old word's gloss described a word that no longer exists, and
 *     carrying it onto one half would make the FLEx write a gloss.set (a new analysis + gloss) on
 *     top of the split. The removed gloss is returned so a UI can say so; Undo restores it.
 *   insertWordAt(seg, at, txt) — a new word at index `at` (0 = before the first, words.length =
 *     after the last). FLEx's equivalent is `"new "` at the next word's start or `" new"` at the
 *     previous word's end [verified: only the new word is unanalysed].
 *
 * Both rebuild `seg.baseline` from the words (baselineFromWords), so the baseline and the word forms
 * stay one string, which is also how LCM keeps them. Neither touches `seg.attrs`, times, the free
 * translation or any preserved item. Neither captures undo: the CALLER does, once per user action
 * (Seth's rule — one action, one Undo, one Redo). Both are pure and node-tested. */
export function splitWordAt(seg, k, offset) {
  const words = (seg && seg.words) || [];
  const w = words[k];
  if (!w || w.punct || w.phrase) return { ok: false, reason: 'notAWord' };
  const chars = Array.from(String(w.txt || ''));
  const at = Number(offset);
  if (!(Number.isInteger(at) && at > 0 && at < chars.length)) return { ok: false, reason: 'badOffset' };
  const left = chars.slice(0, at).join(''), right = chars.slice(at).join('');
  // the two halves must each hold a word-forming character, as FLEx needs them to
  if (!Array.from(left).some((c) => isWordForming(c)) || !Array.from(right).some((c) => isWordForming(c))) return { ok: false, reason: 'noWordChar' };
  const a = makeWord(left), b = makeWord(right);
  a.txtLang = w.txtLang; b.txtLang = w.txtLang;
  words.splice(k, 1, a, b);
  seg.baseline = baselineFromWords(words);
  return { ok: true, words: [a, b], removedGloss: w.gls || '' };
}
/*   joinWordsAt(seg, k) — word k and the word after it become ONE word (the Matcher's Backspace at a
 *     word's start, Delete at its end). FLEx's equivalent is deleting the space between them: the
 *     joined word is one new, unanalysed wordform and every other analysis is kept. So the joined word
 *     is unglossed — both glosses described words that no longer exist — and they are returned so a UI
 *     can say so; Undo restores both. Only two words parted by nothing but a space: punctuation
 *     between them is not a space to delete. Pure, node-tested; the caller captures undo. */
export function joinWordsAt(seg, k) {
  const words = (seg && seg.words) || [];
  const a = words[k], b = words[k + 1];
  if (!a || a.punct || a.phrase) return { ok: false, reason: 'notAWord' };
  if (!b) return { ok: false, reason: 'noNext' };
  if (b.punct) return { ok: false, reason: 'punctBetween' };
  if (b.phrase) return { ok: false, reason: 'notAWord' };
  const w = makeWord(String(a.txt || '') + String(b.txt || ''));
  w.txtLang = a.txtLang || b.txtLang;
  words.splice(k, 2, w);
  seg.baseline = baselineFromWords(words);
  return { ok: true, word: w, removedGlosses: [a.gls, b.gls].filter(Boolean) };
}
export function insertWordAt(seg, at, txt = '') {
  const words = (seg && seg.words) || [];
  const i = Math.max(0, Math.min(words.length, Number(at) | 0));
  const w = makeWord(String(txt || ''));
  const nb = words[i] || words[i - 1];
  if (nb && nb.txtLang) w.txtLang = nb.txtLang;
  words.splice(i, 0, w);
  seg.baseline = baselineFromWords(words);
  return { ok: true, word: w, at: i };
}

/* ---------------- Paragraph structure on flat lines (seg-word-split; plan §4.3 item 4, §6.4) ----
 *
 * The engine holds ONE PHRASE PER LINE and remembers paragraphs as `paraOf` on each line — the
 * original paragraph's guid, set by normalizePhraseLines only for a doc whose author distinguished
 * phrases from paragraphs, and regrouped on export by serializeFlextext (consecutive lines sharing
 * a paraOf become one <paragraph>). A FLEx-bound doc carries the FLEx paragraph GUID the same way.
 * So "paragraph split", "paragraph join", "phrase boundary → paragraph boundary" and "paragraph
 * boundary → phrase boundary" are all edits to WHICH GROUP a run of lines belongs to:
 *
 *   breakParagraphBefore(doc, k) — the boundary before line k becomes a paragraph boundary: line k
 *     and the lines after it that shared its group move to a NEW group (a fresh guid: a split
 *     paragraph's second half is new containment, as FLEx's SplitParaAt makes it [verified]).
 *   joinParagraphBefore(doc, k)  — the boundary before line k becomes a phrase boundary: line k's
 *     whole group takes line k−1's group id (the second paragraph's identity is lost — that is what
 *     a join means [verified: MergeParaWithNext]).
 *
 * Both refuse (return false) when the doc has no paragraph structure to express — a flat text has no
 * paragraphs to split or join — or when the boundary is already of the asked kind. Neither touches
 * text, words, times or free translations: one line stays one phrase. The caller captures undo. */
export function hasParagraphStructure(doc) {
  return !!(doc && Array.isArray(doc.paragraphs) && doc.paragraphs.some((p) => p && p.paraOf != null));
}
export function paragraphBreakBefore(doc, k) {
  const ps = (doc && doc.paragraphs) || [];
  if (!(k > 0 && k < ps.length) || !hasParagraphStructure(doc)) return null;
  const a = ps[k - 1].paraOf != null ? String(ps[k - 1].paraOf) : null;
  const b = ps[k].paraOf != null ? String(ps[k].paraOf) : null;
  return a === null || b === null ? true : a !== b;
}
export function breakParagraphBefore(doc, k) {
  const ps = (doc && doc.paragraphs) || [];
  if (paragraphBreakBefore(doc, k) !== false) return false;   // no structure, out of range, or already a break
  const group = String(ps[k].paraOf);
  const fresh = newGuid();
  for (let i = k; i < ps.length && String(ps[i].paraOf) === group; i++) ps[i].paraOf = fresh;
  return true;
}
export function joinParagraphBefore(doc, k) {
  const ps = (doc && doc.paragraphs) || [];
  if (paragraphBreakBefore(doc, k) !== true) return false;    // no structure, out of range, or already joined
  const target = ps[k - 1].paraOf != null ? ps[k - 1].paraOf : ps[k - 1].guid;
  if (ps[k - 1].paraOf == null) ps[k - 1].paraOf = target;
  const group = ps[k].paraOf != null ? String(ps[k].paraOf) : null;
  for (let i = k; i < ps.length; i++) {
    const g = ps[i].paraOf != null ? String(ps[i].paraOf) : null;
    if (i > k && g !== group) break;
    ps[i].paraOf = target;
    if (group === null) break;   // an untagged line is its own paragraph
  }
  return true;
}

/* ---------------- Break kinds: Sentence (<paragraph>) or Clause (<phrase>) (seg-word-split) ----------------
 *
 * Seth, 2026-10-14: a text's segment breaks are of two kinds, and the engine has to know which it is
 * making. In the file a SENTENCE break is a <paragraph> boundary and a CLAUSE break is a <phrase>
 * boundary inside one paragraph. On the flat line model that is `paraOf`: lines in one paragraph share
 * it (clause breaks between them); a line with a different (or no) paraOf starts a paragraph (a sentence
 * break before it). The device setting `breakKind` says which kind a NEW cut makes — 'sentence', the
 * default and what every cut has always made, or 'clause'. Only the Audio Segmenter shows the setting
 * for now; the engine honours it wherever a line boundary is created.
 *
 *   setBoundaryKind(lines, k, kind)   — the boundary BEFORE line k becomes that kind (lines = the flat
 *                                       paragraphs array, each with `guid` and optional `paraOf`)
 *   applyNewLineBreak(lines, idx, kind) — line idx was just inserted after idx−1: give the boundary
 *                                       between them the kind (a 'clause' joins the paragraph, creating
 *                                       one when the text had none; a 'sentence' starts a new paragraph,
 *                                       and the rest of the old paragraph follows it)
 *   applyBreakKindToOrigins(doc, origins, kind) — after reconcileBaselineWithOrigins: every piece of a
 *                                       split line gets the kind before it
 * None of these touch text, words, times or free translations. Callers capture undo. */
export const BREAK_KINDS = ['sentence', 'clause'];
export const DEFAULT_BREAK_KIND = 'sentence';
export function normalizeBreakKind(v) { return v === 'clause' ? 'clause' : 'sentence'; }

export function setBoundaryKind(lines, k, kind) {
  if (!Array.isArray(lines) || !(k > 0 && k < lines.length)) return false;
  const prev = lines[k - 1], line = lines[k];
  if (normalizeBreakKind(kind) === 'clause') {
    if (prev.paraOf == null) prev.paraOf = prev.guid || newGuid();
    const group = prev.paraOf;
    if (line.paraOf != null && String(line.paraOf) === String(group)) return false;
    const old = line.paraOf;
    for (let j = k; j < lines.length; j++) {
      if (j > k && (old == null || lines[j].paraOf == null || String(lines[j].paraOf) !== String(old))) break;
      lines[j].paraOf = group;
      if (old == null) break;   // an untagged line is its own paragraph: only it joins
    }
    return true;
  }
  // sentence
  if (line.paraOf == null) return false;                                       // already its own paragraph
  if (prev.paraOf == null || String(prev.paraOf) !== String(line.paraOf)) return false;   // already a break
  const old = line.paraOf, fresh = newGuid();
  for (let j = k; j < lines.length && lines[j].paraOf != null && String(lines[j].paraOf) === String(old); j++) lines[j].paraOf = fresh;
  return true;
}

export function applyNewLineBreak(lines, idx, kind) {
  if (!Array.isArray(lines) || !(idx > 0 && idx < lines.length)) return false;
  const prev = lines[idx - 1];
  if (prev.paraOf != null) lines[idx].paraOf = prev.paraOf; else delete lines[idx].paraOf;   // start inside prev's paragraph
  setBoundaryKind(lines, idx, kind);
  return true;
}

export function applyBreakKindToOrigins(doc, origins, kind, paraOfBefore = null) {
  const lines = (doc && doc.paragraphs) || [];
  /* The reconcile builds a changed line as a NEW paragraph object, so an edited or split line used to
   * leave its FLEx paragraph (and the export fell back to flat). With the paragraph memberships from
   * before the edit, every piece of an old line first takes that line's paraOf back… */
  if (Array.isArray(paraOfBefore)) {
    (origins || []).forEach((o, j) => {
      const line = lines[j];
      if (!line || !o || line.paraOf != null) return;
      const from = o.kind === 'join' ? (Array.isArray(o.from) ? o.from[0] : null) : (o.kind === 'new' ? null : o.from);
      if (from != null && paraOfBefore[from] != null) line.paraOf = paraOfBefore[from];
    });
  }
  /* …and then the boundary between two pieces of ONE old line takes the device's break kind. */
  let n = 0;
  for (let j = 1; j < lines.length && j < (origins || []).length; j++) {
    const o = origins[j], p = origins[j - 1];
    if (o && p && o.kind === 'split' && p.kind === 'split' && o.from === p.from) { applyNewLineBreak(lines, j, kind); n++; }
  }
  return n;
}

/* ---------------- § section marks → real breaks, ONE AT A TIME (seg-word-split) ----------------
 *
 * Seth, 2026-10-14: "replace section break characters with phrase breaks or paragraph breaks when we
 * find them… the user needs to choose what kind of break on a case by case basis. But it should make
 * them stand out and prompt the user to deal with them if there are any left (with an option to do all
 * one or all another)." A § is FLEx's forced break with no punctuation; a text that came through FLEx
 * carries one after most phrases. The engine lists every mark as a SITE the UI can show and offer two
 * choices on, and resolves one site at a time:
 *   · a phrase-final §: the word is removed and the boundary to the next line takes the chosen kind;
 *   · a § with words after it inside one line (a file FLEx never re-segmented): the line is split
 *     there — the first half keeps the line's guid, time and free translation, the second half is a new
 *     untimed line (never invent a time) — and the new boundary takes the chosen kind.
 * `lines` are the flat paragraphs, each holding its phrase under `segments` (the doc) or `phrases` (the
 * Matcher's lines): the functions read either and create new lines through `opts.newLine(seg)` so a
 * caller with its own line shape (ids) stays in charge of it. The baseline is rebuilt from the words.
 * On a FLEx-bound doc this is loss-free: FLEx's importer re-adds § itself, and the desktop shell's diff
 * ignores marker words and re-writes § from the phrase structure. */
export function lineSegmentsOf(line) { return (line && (line.segments || line.phrases)) || []; }

/* Every § mark: { line, word, final, visibleBefore } — `word` indexes the phrase's words, `final` says
 * the mark ends its phrase (only punctuation follows), `visibleBefore` counts the lexical words before
 * it (where a word-level view, which hides punctuation, places the mark). */
export function sectionBreakSites(doc) {
  const out = [];
  (doc && doc.paragraphs || []).forEach((line, li) => {
    const seg = lineSegmentsOf(line)[0];
    const words = (seg && seg.words) || [];
    let visible = 0;
    words.forEach((w, wi) => {
      if (isBoundaryMarker(w)) out.push({ line: li, word: wi, final: words.slice(wi + 1).every((x) => x.punct), visibleBefore: visible });
      else if (!w.punct) visible++;
    });
  });
  return out;
}
export function countSectionBreaks(doc) { return sectionBreakSites(doc).length; }

/* Resolve ONE mark: the §
 * at (li, wi) becomes a break of `kind`. → { ok, split } ; ok false when there is no mark there. */
export function resolveSectionBreak(doc, li, wi, kind, opts = {}) {
  const lines = (doc && doc.paragraphs) || [];
  const line = lines[li];
  const seg = lineSegmentsOf(line)[0];
  const words = (seg && seg.words) || [];
  if (!isBoundaryMarker(words[wi])) return { ok: false, split: false };
  const k2 = normalizeBreakKind(kind);
  const final = words.slice(wi + 1).every((x) => x.punct);
  if (final) {
    seg.words = words.filter((w, i) => i !== wi);
    seg.baseline = seg.words.length ? baselineFromWords(seg.words) : String(seg.baseline || '').replace(/\s*§+/gu, '').trim();
    if (li + 1 < lines.length) setBoundaryKind(lines, li + 1, k2);
    return { ok: true, split: false };
  }
  const left = words.slice(0, wi), right = words.slice(wi + 1);
  seg.words = left;
  seg.baseline = baselineFromWords(left);
  const seg2 = makeSegment(baselineFromWords(right), right);
  seg2.txtLang = seg.txtLang;
  const nl = opts.newLine ? opts.newLine(seg2, line) : { guid: newGuid(), segments: [seg2] };
  lines.splice(li + 1, 0, nl);
  if (Array.isArray(doc.segments)) { const segs = doc.segments.slice(); segs.splice(li + 1, 0, { start: 0, end: 0, timePending: true }); doc.segments = segs; }
  applyNewLineBreak(lines, li + 1, k2);
  return { ok: true, split: true };
}

/* All remaining marks, one kind ("All → Clause" / "All → Sentence"). → { removed, split } */
export function replaceSectionBreaks(doc, kind, opts = {}) {
  let removed = 0, split = 0, guard = 0;
  for (;;) {
    const sites = sectionBreakSites(doc);
    if (!sites.length || guard++ > 10000) break;
    const r = resolveSectionBreak(doc, sites[0].line, sites[0].word, kind, opts);
    if (!r.ok) break;
    removed++;
    if (r.split) split++;
  }
  return { removed, split };
}

/* ---------------- Writing-system survey / remap (research utility) ---------------- */

// Survey distinct lang codes per interlinear "line" in a raw flextext DOM.
export function surveyWritingSystems(xmlString) {
  const dom = new DOMParser().parseFromString(xmlString, 'text/xml');
  if (dom.querySelector('parsererror')) return { error: 'XML parse error', rows: [], dom: null };
  const counts = new Map(); // key "context\0lang" -> count
  // Labels are i18n keys, translated by the UI layer.
  const CONTEXTS = [
    ['phrase > item[type="txt"]', 'wsline.baseline'],
    ['word > item[type="txt"]', 'wsline.word'],
    ['word > item[type="punct"]', 'wsline.punct'],
    ['word > item[type="gls"]', 'wsline.wordgloss'],
    ['word > item[type="pos"]', 'wsline.pos'],
    ['morph > item[type="txt"]', 'wsline.morph'],
    ['morph > item[type="gls"]', 'wsline.morphgloss'],
    ['morph > item[type="cf"]', 'wsline.cf'],
    ['morph > item[type="msa"]', 'wsline.msa'],
    ['phrase > item[type="gls"]', 'wsline.free'],
    ['phrase > item[type="lit"]', 'wsline.lit'],
    ['phrase > item[type="note"]', 'wsline.note'],
    ['phrase > item[type="segnum"]', 'wsline.segnum'],
    ['interlinear-text > item', 'wsline.meta'],
  ];
  const claimed = new Set();
  const rows = [];
  for (const [sel, label] of CONTEXTS) {
    const langs = new Map();
    for (const el of dom.querySelectorAll(sel)) {
      if (claimed.has(el)) continue;
      claimed.add(el);
      const lang = el.getAttribute('lang') || '(none)';
      langs.set(lang, (langs.get(lang) || 0) + 1);
    }
    for (const [lang, count] of langs) rows.push({ selector: sel, label, lang, count });
  }
  const declared = [];
  const seenDecl = new Set();
  for (const el of dom.querySelectorAll('languages > language')) {
    const lang = el.getAttribute('lang');
    if (seenDecl.has(lang)) continue;
    seenDecl.add(lang);
    declared.push({
      lang,
      font: el.getAttribute('font') || '',
      vernacular: el.getAttribute('vernacular') === 'true',
    });
  }
  return { error: null, rows, declared, dom };
}

/* Split a survey's codes into vernacular vs analysis, for validating a flextext against a
 * device/instance setup before attaching it. segnum/meta lines are neutral — a number or metadata
 * WS must not trigger a vern/anal mismatch. Lives here (not app.js) so the researcher panel can
 * run the same validation on a picked file that the device runs on an arriving one
 * (assign-by-upload, 2026-08-11). */
export const WS_VERN_LABELS = new Set(['wsline.baseline', 'wsline.word', 'wsline.punct', 'wsline.morph', 'wsline.cf']);
export const WS_ANAL_LABELS = new Set(['wsline.wordgloss', 'wsline.pos', 'wsline.morphgloss', 'wsline.msa', 'wsline.free', 'wsline.lit', 'wsline.note']);

export function analyzeFlextextWs(xmlText) {
  const survey = surveyWritingSystems(xmlText);
  if (survey.error) return { error: survey.error };
  const pick = (labels) => {
    const set = new Set();
    for (const r of survey.rows) if (labels.has(r.label) && r.lang && r.lang !== '(none)') set.add(r.lang);
    return [...set];
  };
  return { error: null, survey, vernCodes: pick(WS_VERN_LABELS), analCodes: pick(WS_ANAL_LABELS) };
}

// Apply remappings: list of {selector, fromLang, toLang}. Returns new XML string.
export function remapWritingSystems(dom, mappings) {
  const claimed = new Set();
  // Re-walk in the same context order so "claimed" semantics match the survey.
  const bySelector = new Map();
  for (const m of mappings) {
    if (!bySelector.has(m.selector)) bySelector.set(m.selector, []);
    bySelector.get(m.selector).push(m);
  }
  for (const [selector, maps] of bySelector) {
    for (const el of dom.querySelectorAll(selector)) {
      if (claimed.has(el)) continue;
      claimed.add(el);
      const cur = el.getAttribute('lang') || '(none)';
      const m = maps.find(x => x.fromLang === cur && x.toLang && x.toLang !== cur);
      if (m) el.setAttribute('lang', m.toLang);
    }
  }
  // Update <languages> declarations: rename codes wholesale where unambiguous.
  const renames = new Map();
  for (const m of mappings) {
    if (m.toLang && m.toLang !== m.fromLang) {
      if (!renames.has(m.fromLang)) renames.set(m.fromLang, new Set());
      renames.get(m.fromLang).add(m.toLang);
    }
  }
  const usedNow = new Set();
  for (const el of dom.querySelectorAll('[lang]')) usedNow.add(el.getAttribute('lang'));
  for (const langEl of Array.from(dom.querySelectorAll('languages > language'))) {
    const cur = langEl.getAttribute('lang');
    const targets = renames.get(cur);
    if (targets && targets.size === 1 && !usedNow.has(cur)) {
      langEl.setAttribute('lang', targets.values().next().value);
    }
  }
  // Add declarations for codes now in use but not declared.
  for (const langsEl of dom.querySelectorAll('interlinear-text > languages')) {
    const have = new Set(Array.from(langsEl.querySelectorAll('language')).map(e => e.getAttribute('lang')));
    const textEl = langsEl.parentElement;
    const used = new Set();
    for (const el of textEl.querySelectorAll('[lang]')) used.add(el.getAttribute('lang'));
    for (const code of used) {
      if (code && code !== '(none)' && !have.has(code)) {
        const ne = dom.createElement('language');
        ne.setAttribute('lang', code);
        langsEl.appendChild(ne);
      }
    }
  }
  return new XMLSerializer().serializeToString(dom);
}

/* ── EVERY ANALYSIS LANGUAGE A TEXT CARRIES (Seth, 2026-09-05: "we need to be able to select
 * analysis writing system for gloss and for free translation if there are multiple choices …
 * ELAN and SayMore exports should export all that are present").
 *
 * The editor edits ONE gloss per word (w.gls / w.glsLang) and ONE free translation per phrase
 * (seg.free / seg.freeLang), chosen by pickByLang; every other analysis language rides
 * w.preservedXML / seg.preItemsXML / seg.postItemsXML verbatim so it round-trips. The exports
 * that must show every language read them back from those strings here — top-level <item
 * type="gls"> elements only: a word's <morphemes> block also holds gls items, and those are
 * morpheme glosses, not a second word gloss. Pure string work: this module runs under node. */
const XML_ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescXml(s) {
  return String(s ?? '').replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g,
    (m, n, d, h) => XML_ENT[n] ?? (d ? String.fromCodePoint(+d) : String.fromCodePoint(parseInt(h, 16))));
}
function itemOfXml(xml) {
  const s = String(xml || '');
  if (!/^\s*<item\b/.test(s)) return null;                       // <morphemes>, notes, anything else
  const m = s.match(/^\s*<item\b([^>]*?)(\/>|>([\s\S]*?)<\/item>)/);
  if (!m) return null;
  const attrs = {};
  m[1].replace(/([\w:-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = unescXml(v); return ''; });
  return { type: attrs.type || '', lang: attrs.lang || '', text: unescXml(m[3] || '') };
}
function glsOfItemXml(xml) {
  const it = itemOfXml(xml);
  return it && it.type === 'gls' ? { lang: it.lang, text: it.text } : null;
}
// A translation item (free: gls, literal: lit) in a language, or null.
function langItemOf(xml) {
  const it = itemOfXml(xml);
  return it && (it.type === 'gls' || it.type === 'lit') && it.lang ? it : null;
}
function langItemXml(type, lang, text) {
  return `<item type="${esc(type)}" lang="${esc(lang)}">${esc(text)}</item>`;
}
/* [{ lang, text }] — the editable gloss first (lang '' when the word was typed in this app, which
 * means the document's analysis language), then each preserved language once. */
export function wordGlosses(w) {
  const out = [];
  if (w && (w.gls || w.glsLang)) out.push({ lang: w.glsLang || '', text: w.gls || '' });
  for (const xml of (w && w.preservedXML) || []) {
    const g = glsOfItemXml(xml);
    if (g && !out.some((x) => x.lang === g.lang)) out.push(g);
  }
  return out;
}
export function phraseFrees(seg) {
  const out = [];
  if (seg && (seg.free || seg.freeLang)) out.push({ lang: seg.freeLang || '', text: seg.free || '' });
  for (const xml of [...((seg && seg.preItemsXML) || []), ...((seg && seg.postItemsXML) || [])]) {
    const g = glsOfItemXml(xml);
    if (g && !out.some((x) => x.lang === g.lang)) out.push(g);
  }
  return out;
}
/* WHICH OF THOSE TO SHOW, and in what order (Seth, 2026-10-05: "ability to show more than one
 * analysis writing system (or at least switch between them)" — the Audio Segmenter's text column).
 * `entries` is wordGlosses(w) or phraseFrees(seg); `mode` is 'primary', 'all', or one language code.
 * Exactly one row comes back for 'primary' and for a code (empty text when the text has none),
 * every language for 'all' with the primary first. `primary: true` marks the one row a device may
 * edit — the others are shown as they are. */
export function analysisRows(entries, mode, primary, langs = null) {
  const prim = primary || 'en';
  const list = (entries || []).map((e) => ({ lang: e.lang || prim, text: e.text || '' }));
  const primRow = { lang: prim, text: (list.find((e) => e.lang === prim) || {}).text || '', primary: true };
  if (mode === 'all') {
    const out = [primRow];
    for (const e of list) if (e.lang !== prim && !out.some((o) => o.lang === e.lang)) out.push({ ...e, primary: false });
    // `langs`: every language to show, in order, an empty row where this word or line has none (a FLEx
    // text's analysis writing systems: each one can be typed into)
    if (Array.isArray(langs)) {
      for (const l of langs) if (!out.some((o) => o.lang === l)) out.push({ lang: l, text: '', primary: false });
      const rank = (l) => (l === prim ? -1 : langs.indexOf(l) < 0 ? langs.length : langs.indexOf(l));
      out.sort((a, b) => rank(a.lang) - rank(b.lang));
    }
    return out;
  }
  if (mode && mode !== 'primary' && mode !== prim) {
    return [{ lang: mode, text: (list.find((e) => e.lang === mode) || {}).text || '', primary: false }];
  }
  return [primRow];
}

/* { gloss: [...], free: [...] } — the primary analysis language first, then every other language
 * that has at least one non-empty line, in order of first appearance. A line with no language of
 * its own counts as the primary. */
export function analysisLangs(doc, primary = '') {
  const prim = primary || (doc && doc.analLang) || 'en';
  const gloss = [prim], free = [prim];
  const add = (list, g) => { const l = g.lang || prim; if (g.text && !list.includes(l)) list.push(l); };
  for (const para of (doc && doc.paragraphs) || []) {
    for (const seg of para.segments || []) {
      for (const f of phraseFrees(seg)) add(free, f);
      for (const w of seg.words || []) { if (w.punct) continue; for (const g of wordGlosses(w)) add(gloss, g); }
    }
  }
  return { gloss, free };
}
/* SET one word's gloss / one phrase's free translation IN ONE LANGUAGE, every other language left exactly
 * as it is (Seth, 2026-10-16: "ONLY change what we changed and leave everything else preserved. I don't
 * want it erasing data in other writing systems or languages when I edit ONE of them"). The editable slot
 * (`gls`/`glsLang`, `free`/`freeLang`) holds its own language — the document's analysis language when it
 * names none (`primary`); every other language is its top-level <item type="gls" lang=…> string, changed
 * where it stands, added after the others, removed when emptied. A FLEx text's ride-along map of the same
 * values (`w.glosses`, `seg.frees`) is kept in step. → true when anything changed. Pure. */
export function setGlossIn(w, lang, text, primary = '') {
  return setInLang(w, lang, text, primary, 'gls', 'glsLang', ['preservedXML'], 'glosses');
}
export function setFreeIn(seg, lang, text, primary = '') {
  return setInLang(seg, lang, text, primary, 'free', 'freeLang', ['preItemsXML', 'postItemsXML'], 'frees');
}
function setInLang(o, lang, text, primary, slot, slotLang, lists, ride) {
  if (!o || !lang) return false;
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  const prim = primary || 'en';
  const was = slot === 'gls' ? glossIn(o, lang, prim) : freeIn(o, lang, prim);
  if (was === value) return false;
  const inSlot = (o[slotLang] || prim) === lang && ((o[slot] || '') !== '' || !!o[slotLang] || !hasItemIn(o, lists, lang));
  if (inSlot) {
    o[slot] = value;
    for (const k of lists) if (Array.isArray(o[k])) o[k] = o[k].filter((x) => { const g = glsOfItemXml(x); return !(g && g.lang === lang); });
  } else {
    let done = false;
    for (const k of lists) {
      if (!Array.isArray(o[k])) continue;
      const i = o[k].findIndex((x) => { const g = glsOfItemXml(x); return g && g.lang === lang; });
      if (i < 0) continue;
      if (value) o[k][i] = langItemXml('gls', lang, value); else o[k].splice(i, 1);
      done = true;
      break;
    }
    if (!done && value) {
      const k = lists[lists.length - 1];
      o[k] = Array.isArray(o[k]) ? o[k] : [];
      o[k].push(langItemXml('gls', lang, value));
    }
  }
  if (o[ride] && typeof o[ride] === 'object') { if (value) o[ride][lang] = value; else delete o[ride][lang]; }
  return true;
}
function hasItemIn(o, lists, lang) {
  return lists.some((k) => (o[k] || []).some((x) => { const g = glsOfItemXml(x); return g && g.lang === lang; }));
}
/* The text of one word's gloss / one phrase's free translation in a given language, '' if none. */
export function glossIn(w, lang, primary = '') {
  const g = wordGlosses(w).find((x) => (x.lang || primary) === lang);
  return g ? g.text : '';
}
export function freeIn(seg, lang, primary = '') {
  const f = phraseFrees(seg).find((x) => (x.lang || primary) === lang);
  return f ? f.text : '';
}
