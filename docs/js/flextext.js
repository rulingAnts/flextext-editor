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
export function tokenize(text) {
  const tokens = [];
  let cur = '';
  let curPunct = '';
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      if (cur) { tokens.push({ txt: cur, punct: false }); cur = ''; }
      if (curPunct) { tokens.push({ txt: curPunct, punct: true }); curPunct = ''; }
    } else if (WORD_CHAR.test(ch)) {
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
      else if (child === freeEl) { seg.free = child.textContent; seg.freeLang = lang; }
      else if (type === 'segnum' && !seenWords) { /* regenerated on export */ }
      else (seenWords ? seg.postItemsXML : seg.preItemsXML).push(serializeEl(child));
    } else {
      seg.postItemsXML.push(serializeEl(child));
    }
  }
  // If no baseline txt item, reconstruct from words.
  if (!seg.baseline) seg.baseline = baselineFromWords(seg.words);
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
    else if (child === glsEl) { w.gls = child.textContent; w.glsLang = child.getAttribute('lang') || ''; }
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

export function baselineFromWords(words) {
  let out = '';
  for (const w of words) {
    if (w.punct) {
      if (/^[([{«“‘'"¿¡]/.test(w.txt)) out += (out && !/\s$/.test(out) ? ' ' : '') + w.txt;
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
  lines.push(`<document version="${esc(doc.version || '2')}">`);
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
  const spans = (opts.segTimes !== false && Array.isArray(doc.segments)) ? doc.segments : [];
  const hasSpans = spans.some((s) => typeof s.start === 'number' && typeof s.end === 'number' && !s.timePending);
  const clock = (ms) => { const ti = Math.max(0, Math.round(ms)); return `${Math.floor(ti / 60000)}:${String(Math.floor((ti % 60000) / 1000)).padStart(2, '0')}.${String(ti % 1000).padStart(3, '0')}`; };
  const OUR_NOTE = /type="note"[^>]*>audio ~?\d+:\d\d\.\d{3}/;   // dedupe our own notes on round trips
  const mediaGuid = hasSpans && opts.mediaName && !(doc.mediaXML || []).length
    ? (doc.mediaGuid || (doc.mediaGuid = newGuid())) : null;
  let segnum = 0;
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

  let pi = -1;
  for (const run of emit) {
    lines.push(`      <paragraph guid="${esc(run.guid)}">`);
    lines.push('        <phrases>');
    for (const li of run.lines) {
    const para = doc.paragraphs[li];
    pi = li;
    for (const seg of para.segments) {
      segnum++;
      const span = (hasSpans && para.segments.length === 1) ? spans[pi] : null;
      const timed = !!(span && typeof span.start === 'number' && typeof span.end === 'number' && !span.timePending);
      // A round trip preserves imported offsets in seg.attrs — when we emit fresh ones, filter
      // the stale copies or the phrase would carry the attribute twice (invalid XML). media-file
      // is filtered ONLY when we mint our own guid: an imported doc keeps its media-files block
      // (mediaGuid null), so its phrases must keep their original media-file references too —
      // filtering unconditionally silently unlinked every phrase from its media (audit find).
      const pAttrs = Object.entries(seg.attrs || {})
        .filter(([k]) => !(timed && (k === 'begin-time-offset' || k === 'end-time-offset' || (k === 'media-file' && mediaGuid))))
        .map(([k, v]) => ` ${k}="${esc(v)}"`).join('')
        + (timed ? ` begin-time-offset="${Math.round(span.start)}" end-time-offset="${Math.round(span.end)}"${mediaGuid ? ` media-file="${esc(mediaGuid)}"` : ''}` : '');
      lines.push(`          <phrase${pAttrs}>`);
      lines.push(`            <item type="txt" lang="${esc(seg.txtLang || vern)}">${esc(seg.baseline)}</item>`);
      lines.push(`            <item type="segnum" lang="${esc(anal)}">${segnum}</item>`);
      lines.push('            <words>');
      for (const xml of seg.preItemsXML || []) lines.push(indentFragment(xml, '              '));
      for (const w of seg.words) {
        const wType = w.phrase ? ' type="phrase"' : '';
        lines.push(`              <word guid="${esc(w.guid)}"${wType}>`);
        if (w.punct) {
          lines.push(`                <item type="punct" lang="${esc(w.txtLang || vern)}">${esc(w.txt)}</item>`);
        } else {
          if (!w.derivedTxt) {
            lines.push(`                <item type="txt" lang="${esc(w.txtLang || vern)}">${esc(w.txt)}</item>`);
          }
          for (const xml of w.preservedXML || []) lines.push(indentFragment(xml, '                '));
          if (w.gls) {
            lines.push(`                <item type="gls" lang="${esc(w.glsLang || anal)}">${esc(w.gls)}</item>`);
          }
        }
        lines.push('              </word>');
      }
      lines.push('            </words>');
      if (seg.free || seg.freeLang) {
        lines.push(`            <item type="gls" lang="${esc(seg.freeLang || anal)}">${esc(seg.free)}</item>`);
      }
      // The human-visible timestamps (never in the baseline): a note item FLEx displays on its
      // own Note line. '~' marks an estimated boundary the transcriber has not confirmed by ear.
      if (timed) {
        lines.push(`            <item type="note" lang="${esc(anal)}">audio ${span.timeEstimated ? '~' : ''}${clock(span.start)}–${clock(span.end)}</item>`);
      }
      for (const xml of (seg.postItemsXML || []).filter((x) => !(timed && OUR_NOTE.test(x)))) lines.push(indentFragment(xml, '            '));
      lines.push('          </phrase>');
      }
    }
    lines.push('        </phrases>');
    lines.push('      </paragraph>');
  }
  lines.push('    </paragraphs>');
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
  // when WE minted the guid (authored docs with no imported media-files block of their own).
  if (mediaGuid) {
    lines.push('    <media-files offset-type="">');
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
 * Returns null when nothing in the doc carries offsets. */
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
  let floor = 0;
  for (const s of spans) {
    if (typeof s.start !== 'number') continue;
    if (s.start < floor) s.start = floor;
    if (s.end <= s.start) { delete s.start; delete s.end; s.timePending = true; continue; }
    floor = s.end;
  }
  return spans;
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

  // Carry-over pool: segments from old paragraphs that were not kept verbatim.
  const oldSegs = [];
  oldParas.forEach((p, i) => { if (!keptOld.has(i)) oldSegs.push(...p.segments); });

  // Skeleton for changed/new paragraphs only.
  const newParas = paragraphTexts.map((text, j) => {
    if (keptOldByNew.has(j)) return oldParas[keptOldByNew.get(j)];
    // Flat mode keeps the line whole (even an EMPTY line, which is a legitimate timed segment
    // marking silence/untranscribable audio); default mode splits it into sentence-phrases.
    return { guid: newGuid(), segments: [], segTexts: flat ? [text] : segmentText(text) };
  });

  const newSegsFlat = [];
  for (const p of newParas) {
    if (!p.segTexts) continue; // kept paragraph
    for (const t of p.segTexts) newSegsFlat.push({ text: t, para: p });
  }

  // Pass 1: LCS over changed segments with exact (whitespace-normalized) text equality.
  const a = oldSegs.map(s => norm(s.baseline));
  const b = newSegsFlat.map(s => norm(s.text));
  const pairs = lcsPairs(a, b);
  const oldMatched = new Map(); // newIdx -> oldSeg
  const oldUsed = new Set();
  for (const [i, j] of pairs) { oldMatched.set(j, oldSegs[i]); oldUsed.add(i); }

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
   * the transcriber checks it afterwards. */
  const leftoverOld = oldSegs.map((s, i) => ({ s, i })).filter(x => !oldUsed.has(x.i)).map(x => x.s);
  const unmatchedNew = newSegsFlat.map((s, j) => j).filter(j => !oldMatched.has(j));
  const fuzzyPair = new Map();   // newIdx -> { olds:[seg], wordSlice?:[from,to], takesFree?:bool }
  {
    let oi = 0, ui = 0;
    const newTextAt = (u) => norm(newSegsFlat[unmatchedNew[u]].text);
    while (ui < unmatchedNew.length && oi < leftoverOld.length) {
      const j = unmatchedNew[ui];
      const want = newTextAt(ui);

      // JOIN — consume consecutive olds while they still build toward this one new line.
      let acc = norm(leftoverOld[oi].baseline), take = 1;
      while (acc !== want && want.startsWith(acc) && oi + take < leftoverOld.length) {
        acc = norm(acc + ' ' + leftoverOld[oi + take].baseline); take++;
      }
      if (acc === want && take > 1) {
        fuzzyPair.set(j, { olds: leftoverOld.slice(oi, oi + take) });
        oi += take; ui++; continue;
      }

      // SPLIT — one old line spread across consecutive new lines.
      const whole = norm(leftoverOld[oi].baseline);
      let acc2 = want, take2 = 1;
      while (acc2 !== whole && whole.startsWith(acc2) && ui + take2 < unmatchedNew.length) {
        acc2 = norm(acc2 + ' ' + newTextAt(ui + take2)); take2++;
      }
      if (acc2 === whole && take2 > 1) {
        const old = leftoverOld[oi];
        let longest = 0;
        for (let p = 1; p < take2; p++) if (newTextAt(ui + p).length > newTextAt(ui + longest).length) longest = p;
        let at = 0;
        for (let p = 0; p < take2; p++) {
          const n = tokenize(newSegsFlat[unmatchedNew[ui + p]].text).length;
          fuzzyPair.set(unmatchedNew[ui + p], { olds: [old], wordSlice: [at, at + n], takesFree: p === longest });
          at += n;
        }
        oi++; ui += take2; continue;
      }

      fuzzyPair.set(j, { olds: [leftoverOld[oi]] });
      oi++; ui++;
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
    const free = !plan ? ''
      : plan.wordSlice ? (plan.takesFree ? old.free : '')
        : plan.olds.map((o) => o.free).filter(Boolean).join(' ');
    const seg = makeSegment(ns.text, words, old ? {
      free, freeLang: old.freeLang,
      preItemsXML: old.preItemsXML, postItemsXML: old.postItemsXML,
      attrs: old.attrs,
    } : {});
    if (old && old.txtLang) seg.txtLang = old.txtLang;
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
  doc.paragraphs = newParas.map(p => { delete p.segTexts; return p; });
  if (!doc.paragraphs.length) doc.paragraphs.push({ guid: newGuid(), segments: [] });
  return doc;
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
