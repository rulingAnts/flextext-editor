/* What a .flextext SAYS, for comparing two of them (Seth's FLEx round-trip report, 2026-10-17): every
 * paragraph, phrase, word and morph by its guid, in order; every item by type, lang and value (FLEx reads an
 * item by type and lang, never by position, so a word's items compare as a set); whether a phrase has
 * <words>; its attributes. Whitespace inside a value is not content (FLEx writes an `hn` across lines), but
 * a U+2028 is — it is a hard line break, so only ASCII whitespace is folded. Needs a DOMParser
 * (test/lib/mini-xml-dom.mjs under node). */
const kids = (el, tag) => Array.from((el && el.children) || []).filter((c) => !tag || c.tagName === tag);
const value = (s) => String(s ?? '').replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, '');
const items = (el) => kids(el, 'item').map((i) => `${i.getAttribute('type')}|${i.getAttribute('lang')}|${value(i.textContent)}`);

export function flextextModel(xml) {
  const dom = new DOMParser().parseFromString(String(xml).replace(/^﻿/, ''), 'text/xml');
  const it = kids(dom.documentElement, 'interlinear-text')[0];
  const paras = [];
  for (const p of kids(kids(it, 'paragraphs')[0], 'paragraph')) {
    const phrases = [];
    for (const phs of kids(p, 'phrases')) for (const ph of kids(phs, 'phrase')) {
      const words = [];
      for (const ws of kids(ph, 'words')) for (const w of kids(ws, 'word')) {
        const morphs = [];
        for (const ms of kids(w, 'morphemes')) for (const m of kids(ms, 'morph')) morphs.push({ guid: m.getAttribute('guid'), type: m.getAttribute('type'), items: items(m) });
        words.push({ guid: w.getAttribute('guid'), items: items(w), morphs });
      }
      const attrs = {};
      for (const a of Array.from(ph.attributes)) attrs[a.name] = a.value;
      phrases.push({ guid: ph.getAttribute('guid'), attrs, items: items(ph), hasWords: kids(ph, 'words').length > 0, words });
    }
    paras.push({ guid: p.getAttribute('guid'), phrases });
  }
  const media = kids(it, 'media-files').flatMap((mf) => kids(mf, 'media').map((m) => ({ guid: m.getAttribute('guid'), location: m.getAttribute('location'), offsetType: mf.getAttribute('offset-type') })));
  const langs = kids(kids(it, 'languages')[0], 'language').map((l) => [l.getAttribute('lang'), l.getAttribute('vernacular')]);
  return { textGuid: it.getAttribute('guid'), textItems: items(it), langs, paras, media };
}

/* Every difference between two models, as one line each ([] when they say the same). `ignore`: item
 * patterns to leave out of the phrase comparison (segnum — FLEx computes it, and this suite does not write it). */
export function flextextDiff(A, B, { ignore = [] } = {}) {
  const out = [];
  const keep = (list) => list.filter((x) => !ignore.some((r) => r.test(x))).sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (A.textGuid !== B.textGuid) out.push(`text guid ${A.textGuid} → ${B.textGuid}`);
  if (A.paras.length !== B.paras.length) out.push(`paragraphs ${A.paras.length} → ${B.paras.length}`);
  for (let i = 0; i < Math.min(A.paras.length, B.paras.length); i++) {
    const pa = A.paras[i], pb = B.paras[i];
    if (pa.guid !== pb.guid) out.push(`¶${i + 1} guid ${pa.guid} → ${pb.guid}`);
    if (pa.phrases.length !== pb.phrases.length) { out.push(`¶${i + 1} phrases ${pa.phrases.length} → ${pb.phrases.length}`); continue; }
    pa.phrases.forEach((qa, k) => {
      const qb = pb.phrases[k], at = `¶${i + 1}.${k + 1}`;
      if (qa.guid !== qb.guid) out.push(`${at} phrase guid ${qa.guid} → ${qb.guid}`);
      const fa = keep(qa.items), fb = keep(qb.items);
      if (!same(fa, fb)) out.push(`${at} phrase items −${JSON.stringify(fa.filter((x) => !fb.includes(x)))} +${JSON.stringify(fb.filter((x) => !fa.includes(x)))}`);
      if (qa.hasWords !== qb.hasWords) out.push(`${at} <words> ${qa.hasWords} → ${qb.hasWords}`);
      if (!same(Object.keys(qa.attrs).sort(), Object.keys(qb.attrs).sort())) out.push(`${at} phrase attributes ${Object.keys(qa.attrs).sort()} → ${Object.keys(qb.attrs).sort()}`);
      if (qa.words.length !== qb.words.length) { out.push(`${at} words ${qa.words.length} → ${qb.words.length}`); return; }
      qa.words.forEach((wa, j) => {
        const wb = qb.words[j];
        if (wa.guid !== wb.guid) out.push(`${at} word ${j} guid ${wa.guid} → ${wb.guid}`);
        const ia = [...wa.items].sort(), ib = [...wb.items].sort();
        if (!same(ia, ib)) out.push(`${at} word ${j} items −${JSON.stringify(ia.filter((x) => !ib.includes(x)))} +${JSON.stringify(ib.filter((x) => !ia.includes(x)))}`);
        if (!same(wa.morphs, wb.morphs)) out.push(`${at} word ${j} morphs differ`);
      });
    });
  }
  if (!same([...A.textItems].sort(), [...B.textItems].sort())) out.push('text items differ');
  if (!same(A.langs, B.langs)) out.push(`languages ${JSON.stringify(A.langs)} → ${JSON.stringify(B.langs)}`);
  return out;
}

// Every phrase, in document order, with its paragraph's guid: what a check walks.
export const phrasesOf = (model) => model.paras.flatMap((p) => p.phrases.map((q) => ({ ...q, para: p.guid })));
// One item's value by type and lang ('' when the phrase or word has none).
export const itemValue = (list, type, lang) => {
  const hit = list.find((x) => x.startsWith(`${type}|${lang}|`));
  return hit == null ? null : hit.slice(type.length + lang.length + 2);
};
