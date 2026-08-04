/* eaf-read.js — the ELAN EAF *reader*.
 *
 * We have written EAFs since v158 (seg-exports.js, two profiles); this is the other direction, so
 * a researcher can bring ELAN/SayMore/FLEx work INTO the Paragraph Analysis Tool.
 *
 * FORMAT-MODULE RULES (CLAUDE.md): imports nothing, touches no DOM, no settings, no IndexedDB, no
 * i18n. Which is why this file carries its own small XML scanner instead of using DOMParser —
 * `parseFlextext` chose DOMParser and is therefore NOT node-testable, and a reader is exactly the
 * kind of code that must be tested adversarially. Everything here runs under plain node
 * (test/eaf-read.test.mjs is the enforcement, and it round-trips against our own EAF writer).
 *
 * WHAT AN EAF ACTUALLY IS (the parts that matter here):
 *  - <TIME_ORDER> holds TIME_SLOTs; a slot may have NO TIME_VALUE — that is ELAN's own way of
 *    saying "this boundary is not aligned yet", the same idea as our `timePending`.
 *  - A tier's annotations are either ALIGNABLE_ANNOTATION (its own two time slots) or
 *    REF_ANNOTATION (no times; ANNOTATION_REF points at the parent annotation it belongs to).
 *  - Sibling REF_ANNOTATIONs carry their ORDER in PREVIOUS_ANNOTATION — a linked list, not
 *    document order. Reading words in document order happens to work on files we wrote and
 *    silently scrambles files from elsewhere, so the chain is followed properly here.
 *  - Tier hierarchy is PARENT_REF; the stereotype (Symbolic_Subdivision = ordered many children,
 *    Symbolic_Association = exactly one) lives on the LINGUISTIC_TYPE by CONSTRAINTS.
 *
 * The reader deliberately does NOT decide what a tier means — `detectMapping()` proposes, the
 * user confirms in the import wizard, and `eafToLines()` converts whatever mapping it is given.
 */

/* ---------------- a minimal XML scanner (elements, attributes, text) ---------------- */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[body] !== undefined ? ENT[body] : m;
  });
}

// Returns a root node: { name, attrs, children[], text }. Comments, the XML declaration and
// DOCTYPE are skipped; CDATA is treated as text. Tolerant by design — a field EAF that is
// slightly off spec should still import rather than throw.
export function parseXml(src) {
  const s = String(src);
  const n = s.length;
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(s.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt); i = e < 0 ? n : e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt);
      top().text += s.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3; continue;
    }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); i = e < 0 ? n : e + 2; continue; }
    if (s.startsWith('<!', lt)) { const e = s.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (s.startsWith('</', lt)) {
      const e = s.indexOf('>', lt);
      if (stack.length > 1) stack.pop();
      i = e < 0 ? n : e + 1; continue;
    }
    // start tag
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(s[j])) j++;
    const el = { name: s.slice(lt + 1, j), attrs: {}, children: [], text: '' };
    let selfClose = false;
    while (j < n) {
      while (j < n && /\s/.test(s[j])) j++;
      if (j >= n) break;
      if (s[j] === '/') { selfClose = true; j++; continue; }
      if (s[j] === '>') { j++; break; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(s[k])) k++;
      const name = s.slice(j, k);
      let m = k;
      while (m < n && /\s/.test(s[m])) m++;
      let value = '';
      if (s[m] === '=') {
        m++;
        while (m < n && /\s/.test(s[m])) m++;
        const q = s[m];
        if (q === '"' || q === "'") {
          const e = s.indexOf(q, m + 1);            // quote-aware: an attribute may contain '>'
          value = s.slice(m + 1, e < 0 ? n : e);
          m = e < 0 ? n : e + 1;
        } else {
          let e = m;
          while (e < n && !/[\s>]/.test(s[e])) e++;
          value = s.slice(m, e); m = e;
        }
      }
      if (name) el.attrs[name] = decodeEntities(value);
      j = Math.max(m, k + (m === k ? 1 : 0));       // never stall on malformed input
    }
    top().children.push(el);
    if (!selfClose) stack.push(el);
    i = j;
  }
  return root;
}

const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;

/* ---------------- EAF → a normalized document ---------------- */

export function readEaf(xmlString) {
  const root = parseXml(xmlString);
  const doc = kid(root, 'ANNOTATION_DOCUMENT') || root;

  const media = [];
  for (const h of kids(doc, 'HEADER')) {
    for (const m of kids(h, 'MEDIA_DESCRIPTOR')) {
      const url = m.attrs.MEDIA_URL || '';
      const rel = m.attrs.RELATIVE_MEDIA_URL || '';
      // The basename is the only part worth trusting: MEDIA_URL is an absolute path from whichever
      // machine made the file, and matching the audio the user dropped is what we actually need.
      const name = decodeURIComponent((rel || url).split(/[\\/]/).pop() || '');
      media.push({ url, relativeUrl: rel, name, mimeType: m.attrs.MIME_TYPE || '' });
    }
  }

  const slots = new Map();
  for (const to of kids(doc, 'TIME_ORDER')) {
    for (const ts of kids(to, 'TIME_SLOT')) {
      const v = ts.attrs.TIME_VALUE;
      // No TIME_VALUE = ELAN's unaligned slot. null, never 0 — 0 is a real time.
      slots.set(ts.attrs.TIME_SLOT_ID, v === undefined || v === '' ? null : Number(v));
    }
  }

  const types = {};
  for (const lt of kids(doc, 'LINGUISTIC_TYPE')) {
    types[lt.attrs.LINGUISTIC_TYPE_ID] = {
      timeAlignable: lt.attrs.TIME_ALIGNABLE === 'true',
      constraints: lt.attrs.CONSTRAINTS || '',
    };
  }

  const tiers = [];
  for (const t of kids(doc, 'TIER')) {
    const tier = {
      id: t.attrs.TIER_ID || '',
      parentRef: t.attrs.PARENT_REF || null,
      typeRef: t.attrs.LINGUISTIC_TYPE_REF || '',
      participant: t.attrs.PARTICIPANT || '',
      annotations: [],
    };
    for (const a of kids(t, 'ANNOTATION')) {
      for (const node of a.children) {
        const value = (kid(node, 'ANNOTATION_VALUE')?.text ?? '').trim();
        if (node.name === 'ALIGNABLE_ANNOTATION') {
          const s = slots.has(node.attrs.TIME_SLOT_REF1) ? slots.get(node.attrs.TIME_SLOT_REF1) : null;
          const e = slots.has(node.attrs.TIME_SLOT_REF2) ? slots.get(node.attrs.TIME_SLOT_REF2) : null;
          tier.annotations.push({ id: node.attrs.ANNOTATION_ID || '', aligned: true, start: s, end: e, value });
        } else if (node.name === 'REF_ANNOTATION') {
          tier.annotations.push({
            id: node.attrs.ANNOTATION_ID || '', aligned: false,
            ref: node.attrs.ANNOTATION_REF || null,
            prev: node.attrs.PREVIOUS_ANNOTATION || null,
            value,
          });
        }
      }
    }
    tiers.push(tier);
  }
  return { media, tiers, types, slots };
}

export const tierById = (doc, id) => doc.tiers.find((t) => t.id === id) || null;
const childTiers = (doc, id) => doc.tiers.filter((t) => t.parentRef === id);
const timedCount = (t) => t.annotations.filter((a) => a.aligned && typeof a.start === 'number' && typeof a.end === 'number').length;

// Ordered REF_ANNOTATION children of one parent annotation. PREVIOUS_ANNOTATION is a linked list;
// document order is NOT authoritative (it is only coincidentally right in files we wrote).
export function orderedRefChildren(tier, parentId) {
  if (!tier) return [];
  const group = tier.annotations.filter((a) => a.ref === parentId);
  if (group.length < 2) return group;
  const byId = new Map(group.map((a) => [a.id, a]));
  const nextOf = new Map();
  for (const a of group) if (a.prev && byId.has(a.prev)) nextOf.set(a.prev, a);
  const head = group.find((a) => !a.prev || !byId.has(a.prev)) || group[0];
  const out = [];
  const seen = new Set();
  let cur = head;
  while (cur && !seen.has(cur.id)) { out.push(cur); seen.add(cur.id); cur = nextOf.get(cur.id); }
  for (const a of group) if (!seen.has(a.id)) out.push(a);   // broken/cyclic chain: keep the rest
  return out;
}

/* ---------------- what the import wizard shows ---------------- */

// One row per tier for the mapping UI: enough to recognise a tier without opening ELAN.
export function describeTiers(doc) {
  return doc.tiers.map((t) => {
    const withValue = t.annotations.find((a) => a.value);
    return {
      id: t.id,
      parentRef: t.parentRef,
      typeRef: t.typeRef,
      kind: t.annotations.some((a) => a.aligned) ? 'timed' : 'ref',
      constraints: (doc.types[t.typeRef] || {}).constraints || '',
      count: t.annotations.length,
      timed: timedCount(t),
      sample: withValue ? withValue.value.slice(0, 60) : '',
    };
  });
}

/* Propose a mapping. Names first (files we wrote, and the two conventions we know), then STRUCTURE
 * — which is what makes an arbitrary field EAF land close enough that the user only confirms.
 *  - baseline: the time-aligned tier with the most real spans, ignoring the structural wrappers
 *    our own writer emits (interlinear-text = 1 annotation for the whole text; paragraph = a
 *    mirror of the phrase tier with EMPTY values).
 *  - free: a 1:1 ref child of the baseline.  - words: a 1:many ref child.  - glosses: 1:1 on words.
 *
 * ⚠ ANY EAF, FROM ANY SOURCE (Seth, 2026-08-04). Two shapes beyond the symbolic hierarchy we write
 * are ordinary in the wild and are handled here and in eafToLines():
 *   1. an INDEPENDENT time-aligned translation tier (no PARENT_REF at all) — very common when
 *      someone types translations straight onto their own tier;
 *   2. Time_Subdivision words, i.e. word tiers whose annotations carry their OWN times.
 * Both are linked to the baseline by TIME OVERLAP rather than by ANNOTATION_REF. A reader that
 * only follows refs silently drops every one of those translations, which would look like the
 * import "losing" data. And whatever detection concludes is only a PROPOSAL: the import wizard
 * lists every tier and lets the user assign any of them to any role.
 */
export function detectMapping(doc) {
  const byName = (re) => doc.tiers.find((t) => re.test(t.id));
  const m = { baseline: null, words: null, glosses: null, free: null, title: '' };

  // 1. Names we know: our FLEx profile, then SayMore's literal tier names.
  const phrase = byName(/phrase-txt/i) || doc.tiers.find((t) => t.id === 'Transcription');
  if (phrase) m.baseline = phrase.id;
  const free = byName(/phrase-gls/i) || doc.tiers.find((t) => t.id === 'Free Translation');
  if (free) m.free = free.id;
  const word = byName(/word-txt/i);
  if (word) m.words = word.id;
  const gloss = byName(/word-gls/i);
  if (gloss) m.glosses = gloss.id;
  const title = byName(/interlinear-text-title/i);
  if (title) m.title = (title.annotations.find((a) => a.value) || {}).value || '';

  // 2. Structure, for everything else.
  if (!m.baseline) {
    // ⚠ "Most timed annotations" is NOT the baseline test: a Time_Subdivision WORD tier has more
    // annotations than the sentence tier above it, so that rule picks the words and the import
    // comes out one-word-per-line. Exclude any tier that subdivides a timed parent, then take the
    // richest of what remains (ties keep document order — the transcription tier is written first
    // by every tool we have seen).
    const isSubdivision = (t) => {
      if (!t.parentRef) return false;
      const p = tierById(doc, t.parentRef);
      return !!p && timedCount(p) > 0 && t.annotations.length > p.annotations.length;
    };
    const candidates = doc.tiers
      .filter((t) => timedCount(t) > 0)
      .filter((t) => t.annotations.some((a) => a.value))          // a mirror tier holds no text
      .filter((t) => !isSubdivision(t))
      .sort((a, b) => b.annotations.length - a.annotations.length);
    // A purely symbolic EAF (no times anywhere) is still importable as a text-only document.
    m.baseline = candidates.length
      ? candidates[0].id
      : (doc.tiers.filter((t) => t.annotations.some((a) => a.value))
          .sort((a, b) => b.annotations.length - a.annotations.length)[0] || {}).id || null;
  }
  if (m.baseline) {
    const base = tierById(doc, m.baseline);
    const baseCount = base.annotations.length || 1;
    for (const child of childTiers(doc, m.baseline)) {
      const ratio = child.annotations.length / baseCount;
      if (ratio > 1.2) { if (!m.words) m.words = child.id; }      // many per line → words
      else if (!m.free) m.free = child.id;                        // about one per line → free
    }
    if (m.words && !m.glosses) {
      const g = childTiers(doc, m.words)[0];
      if (g) m.glosses = g.id;
    }
    // Shape 1: an INDEPENDENT time-aligned tier as the translation. Only guessed when there is
    // exactly one such candidate — with several, the wizard should ask rather than pick wrongly.
    if (!m.free) {
      const loose = doc.tiers.filter((t) => t.id !== m.baseline && t.id !== m.words && t.id !== m.glosses
        && !t.parentRef && timedCount(t) > 0 && t.annotations.some((a) => a.value));
      if (loose.length === 1) m.free = loose[0].id;
    }
  }
  return m;
}

/* ---------------- EAF → the shape buildFxpa() consumes ---------------- */

// Returns { title, lines: [{ baseline, words:[{txt,gls}], free, start?, end? }] }.
// Times ride only when BOTH boundaries are real: an ELAN unaligned slot must not become an
// invented time (the same rule segments.js enforces — never invent a time).
export function eafToLines(doc, mapping = {}) {
  const base = tierById(doc, mapping.baseline);
  if (!base) return { title: mapping.title || '', lines: [] };
  const words = mapping.words ? tierById(doc, mapping.words) : null;
  const glosses = mapping.glosses ? tierById(doc, mapping.glosses) : null;
  const free = mapping.free ? tierById(doc, mapping.free) : null;

  const anns = [...base.annotations];
  // Sort by time ONLY when every annotation is aligned; otherwise document order is the only
  // honest ordering (sorting with nulls would silently move unaligned lines to the end).
  if (anns.length && anns.every((a) => typeof a.start === 'number')) {
    anns.sort((a, b) => a.start - b.start);
  }

  // A tier is linked to its parent EITHER by ANNOTATION_REF or, in plenty of real-world EAFs, by
  // sharing the timeline. `childrenOf` hides the difference so any EAF converts the same way.
  const isTimed = (t) => !!t && t.annotations.some((a) => a.aligned && typeof a.start === 'number');
  const overlapOwner = (c, parents) => {
    let best = null, bestOv = 0;
    for (const p of parents) {
      if (typeof p.start !== 'number' || typeof p.end !== 'number') continue;
      const ov = Math.min(c.end, p.end) - Math.max(c.start, p.start);
      if (ov > bestOv) { bestOv = ov; best = p; }
    }
    return best;
  };
  const byTime = new Map();                 // tierId → Map(parentAnnId → [child annotations])
  const timeIndex = (tier, parents) => {
    if (byTime.has(tier.id)) return byTime.get(tier.id);
    const idx = new Map(parents.map((p) => [p.id, []]));
    for (const c of tier.annotations) {
      if (typeof c.start !== 'number' || typeof c.end !== 'number') continue;
      const owner = overlapOwner(c, parents);
      if (owner) idx.get(owner.id).push(c);
    }
    for (const arr of idx.values()) arr.sort((x, y) => x.start - y.start);
    byTime.set(tier.id, idx);
    return idx;
  };
  const childrenOf = (tier, parentAnn, parents) => {
    if (!tier) return [];
    if (isTimed(tier)) return timeIndex(tier, parents).get(parentAnn.id) || [];
    return orderedRefChildren(tier, parentAnn.id);
  };

  const lines = anns.map((a) => {
    const line = { baseline: a.value || '' };
    if (typeof a.start === 'number' && typeof a.end === 'number' && a.end > a.start) {
      line.start = Math.round(a.start);
      line.end = Math.round(a.end);
    }
    const wordAnns = childrenOf(words, a, anns);
    const ws = wordAnns.map((w) => {
      const o = { txt: w.value || '' };
      // Glosses hang off the WORD — again by ref or by time, whichever this file uses.
      const g = glosses ? (childrenOf(glosses, w, wordAnns)[0] || null) : null;
      if (g && g.value) o.gls = g.value;
      return o;
    });
    // No word tier (or an empty one): fall back to splitting the baseline, so a Transcription-only
    // EAF (SayMore) still shows words rather than nothing.
    line.words = ws.length ? ws : (line.baseline ? line.baseline.split(/\s+/).filter(Boolean).map((txt) => ({ txt })) : []);
    if (free) {
      // Several translation annotations can overlap one line (an independent tier segmented
      // differently) — join them rather than keeping only the first.
      const fs = childrenOf(free, a, anns).map((x) => x.value).filter(Boolean);
      if (fs.length) line.free = fs.join(' ');
    }
    return line;
  });

  return { title: mapping.title || '', lines };
}
