/* sfm-convert.js — the Toolbox / SFM → .flextext converter, as a modal any app can open.
 *
 * Seth, 2026-09-07: "Can we add toolbox/sfm import capability into our engine/suite? I think the
 * easiest place to add that is as a converter on the utilities menu in editor and researcher panel
 * … SFM/toolbox converter will require mapping fields and helping determine where individual texts
 * begin and end. FLEx's own repository … may give some good ideas of how to get this. And then
 * having the user select ONE of those texts for the import (or maybe it can convert them into
 * individual flextext files in an export folder or zip)."
 *
 * ⚠ THE READER ALREADY EXISTED AND IS NOT TOUCHED. sfm.js parses, infers the mapping and splits a
 * file into texts; flextext.js writes the XML. This module is only the surface between them, so
 * there is exactly one SFM reader in the suite and the Paragraph Analysis Tool's own importer and
 * this converter can never disagree about what a file means.
 *
 * WHERE ONE TEXT ENDS AND THE NEXT BEGINS — checked against how FLEx itself does it (SIL's
 * "Import Standard Format interlinear texts"), because guessing at this is what makes a corpus
 * import silently wrong:
 *   - FLEx offers a destination called "New Text" for the marker that signals a new text but
 *     carries no data of its own. sfm.js has had that role (`newtext`) all along; nothing exposed
 *     it, so this converter does — it is the first control in the list, and the one to reach for
 *     when a file does not split the way you expect.
 *   - FLEx's fallback is to start a text whenever a HEADER field (title, source, comment) appears
 *     after body content. sfm.js implements the same rule, so a file with no explicit marker still
 *     splits sensibly.
 *   - FLEx's own documentation warns this only works with "consistent use of markers across all
 *     the texts", which is why the count of texts found is shown live as the mapping is changed:
 *     the wrong answer is visible before anything is written.
 */
import { parseSfm, markerInventory, detectMapping, sfmToTexts, alignmentRisk, normalizePastedSfm } from './sfm.js';
import { serializeFlextext, esc, makeDoc, makeSegment, makeWord, newGuid } from './flextext.js';
import { t, ENGINE_VERSION } from './i18n.js';
import { makeZip } from './zip.js';

/* Every role sfm.js understands, in the order a person meets them: what splits the file, what
 * names a text, then the lines themselves. The Paragraph Analysis Tool's own wizard shows a
 * shorter list; this one is the whole set, because a converter has no second chance to ask. */
export const CONVERT_ROLES = ['newtext', 'title', 'ref', 'baseline', 'gloss', 'morphemes',
                              'free', 'literal', 'note', 'speaker', 'start', 'end'];
const MAP_KEY = 'sfm.convert.mapping';

const dl = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
};
// A filename that survives every filesystem, and never an empty one.
const safeName = (s, fallback) => (String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback);

/* One text from sfm.js → the document shape serializeFlextext writes. Deliberately the same shape
 * the Paragraph Analysis Tool builds from the same reader (sfmConfirm), so the two importers
 * produce the same interlinear from the same file.
 *
 * ⚠ BUILT THROUGH makeDoc / makeSegment / makeWord, NEVER AS OBJECT LITERALS. The literals are the
 * obvious-looking shape a later reader will "simplify" this back into, and they cost every guid in
 * the file: those three helpers are the only things that mint newGuid(), while serializeFlextext
 * writes guid="${esc(w.guid)}" for whatever it is handed and esc(undefined) is the empty string.
 * Measured before this was fixed — converting InterlinTxNarA.txt's first story emitted 387 guid
 * attributes and all 387 were EMPTY, while <interlinear-text> and <phrase> carried no guid at all;
 * the two FLEx-written exports in samples/ have 0 empty of 7,370, and the editor's own path 0.
 *
 * ⚠ AND AN EMPTY GUID IS NOT COSMETIC. Seth, 2026-08-08: "FLEx honors an incoming guid", which is
 * why plans/BACKLOG.md records the minting as a FEATURE and says not to stop emitting them —
 * re-importing a corrected text updates the same objects in FLEx instead of duplicating them, and
 * the audio work in that file plans to name recordings after the phrase guid. A converted corpus
 * with no guids gives all of that up for every text the converter produces. */
export function textToDoc(tx, fallbackTitle, settings = {}) {
  const doc = makeDoc(settings, tx.title || fallbackTitle || '');
  doc.paragraphs = (tx.lines || []).map((l) => {
    const words = (l.words || []).map((w) => makeWord(w.txt, { gls: w.gls || '' }));
    const seg = makeSegment(l.baseline || '', words, { free: l.free || '' });
    seg.speaker = l.speaker || '';   // carried for the importers that show it; FLEx has no field
    return { guid: newGuid(), segments: [seg] };
  });
  doc.segments = (tx.lines || []).map((l) => (typeof l.start === 'number'
    ? { start: l.start, end: l.end } : { timePending: true }));
  return doc;
}

/* ⚠ ONE MARKER CANNOT DO TWO JOBS, and the modal settles that the moment the choice is made.
 *
 * Reproduced before this existed: a file with \tx \mb \ge, the user points "Word glosses" at \mb
 * while "Morphemes" still holds \mb. The handler wrote `state.mapping[role] = value` with no check
 * that another role already owned the marker, and the reader resolved \mb to whichever role was
 * listed last — 0 of 2 words glossed, no message, and a gloss-free .flextext that looks like a
 * successful conversion.
 *
 * The NEWEST choice wins, because it is the one the person just made. The role that held the
 * marker is emptied — and the caller must put its select back to "none" so the screen still
 * matches the mapping, and say which role gave it up. A drop-down that silently empties itself is
 * its own bug report. (sfm.js dedupes as well, by fixed priority; that is the backstop for
 * mappings with no user event behind them, not a substitute for telling the user.) */
export function claimMarker(mapping, role, marker) {
  const out = { ...mapping, [role]: marker || null };
  const want = String(marker || '').toLowerCase();
  const freed = want ? Object.keys(out).filter((r) => r !== role && String(out[r] || '').toLowerCase() === want) : [];
  for (const r of freed) out[r] = null;
  return { mapping: out, freed };
}

/* ⚠ A REMEMBERED MAPPING IS RESTORED ONLY ONTO A MARKER NOTHING ELSE CLAIMS.
 *
 * It used to restore role by role, keeping any role whose marker the new file also has — which
 * re-created the exact collision detectMapping deliberately removes. \t is a candidate for BOTH
 * the title and the vernacular line: session 1 on a file where \t is the title saves title:'t',
 * session 2 opens a file where \t IS the vernacular line, the restore puts title:'t' back on top
 * of baseline:'t', and the converter reported "No texts found" on a perfectly good file.
 *
 * So this file's own inference wins any conflict: it was computed from THIS file, while the
 * remembered mapping is a fact about a DIFFERENT one. A remembered choice that no longer fits is
 * dropped rather than applied — the mapping shown is the one that reads this file, and the user
 * can still change any of it. */
export function restoreMapping(detected, saved, markers) {
  const out = { ...detected };
  if (!saved || !markers) return out;
  const owner = new Map();                    // marker (lowercased) → the role holding it
  for (const [r, m] of Object.entries(out)) if (m) owner.set(String(m).toLowerCase(), r);
  for (const r of CONVERT_ROLES) {
    const marker = String(saved[r] || '').toLowerCase();
    if (!marker || !markers.has(marker)) continue;            // the new file does not have it
    const held = owner.get(marker);
    if (held && held !== r) continue;                         // another role has it: leave it there
    if (out[r]) owner.delete(String(out[r]).toLowerCase());
    out[r] = saved[r];                                        // keep the saved capitalisation
    owner.set(marker, r);
  }
  return out;
}

export function openSfmConverter(opts = {}) {
  if (typeof document === 'undefined') return;
  if (document.querySelector('[data-sfm-convert]')) return;
  const settings = opts.settings || {};
  const state = { name: '', fields: [], inv: [], mapping: {}, texts: [] };

  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.dataset.sfmConvert = '1';
  wrap.innerHTML = `<div class="modal-card sfm-card" role="dialog" aria-modal="true" aria-label="${esc(t('sfm.title'))}">
    <h3>${esc(t('sfm.title'))}</h3>
    <p class="note">${esc(t('sfm.intro'))}</p>
    <div data-step="pick">
      <button type="button" class="primary-btn" data-a="pick">${esc(t('sfm.pick'))}</button>
      <input type="file" data-a="file" accept=".sfm,.txt,.db,.tbx,.sfm.txt,text/plain" hidden>
      <p class="note">${esc(t('sfm.orPaste'))}</p>
      <textarea data-a="paste" class="sfm-paste" rows="5" placeholder="\\ref 001&#10;\\tx …"></textarea>
      <button type="button" class="secondary-btn" data-a="usePaste">${esc(t('sfm.usePaste'))}</button>
    </div>
    <div data-step="map" hidden></div>
    <p class="note sfm-msg" data-a="msg" hidden></p>
    <button type="button" class="link-btn" data-a="close">${esc(t('sfm.close'))}</button>
  </div>`;
  document.body.appendChild(wrap);

  const $ = (sel) => wrap.querySelector(sel);
  const msg = (s, warn) => {
    const el = $('[data-a="msg"]');
    el.textContent = s || ''; el.hidden = !s;
    el.classList.toggle('sfm-warn', !!warn);
  };
  const close = () => { document.removeEventListener('keydown', onKey, true); wrap.remove(); };
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  $('[data-a="close"]').addEventListener('click', close);
  $('[data-a="pick"]').addEventListener('click', () => $('[data-a="file"]').click());
  $('[data-a="file"]').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) load(await f.text(), f.name);
  });
  $('[data-a="usePaste"]').addEventListener('click', () => {
    const v = $('[data-a="paste"]').value;
    if (!v.trim()) { msg(t('sfm.pasteEmpty'), true); return; }
    load(normalizePastedSfm(v), t('sfm.pastedName'));
  });

  function load(text, name) {
    state.name = name || 'text';
    state.fields = parseSfm(text);
    if (!state.fields.length) { msg(t('sfm.noMarkers'), true); return; }
    state.inv = markerInventory(state.fields);
    // The file's own inference first, then whatever was chosen last time, for markers it still has
    // AND no other role has already claimed (see restoreMapping).
    state.mapping = detectMapping(state.fields);
    try {
      const saved = JSON.parse(localStorage.getItem(MAP_KEY) || 'null');
      const present = new Set(state.inv.map((x) => x.marker.toLowerCase()));
      state.mapping = restoreMapping(state.mapping, saved, present);
    } catch { /* a corrupt remembered mapping is not worth a failed import */ }
    $('[data-step="pick"]').hidden = true;
    renderMap();
  }

  // `note` is what just happened to the mapping (a marker changing hands); the rest is what the
  // mapping now MEANS. Both go in the one message line, note first — the user's own action first.
  function recount(note = '') {
    // ⚠ sfmToTexts returns { texts, … }, not an array — the same shape the Paragraph Analysis
    // Tool's importer unwraps. Reading it as an array silently yields no texts at all.
    try { const r = sfmToTexts(state.fields, state.mapping); state.texts = (r && r.texts) || []; }
    catch { state.texts = []; }
    const sel = $('[data-a="which"]');
    if (sel) {
      sel.innerHTML = state.texts.map((tx, i) =>
        `<option value="${i}">${esc((tx.title || t('sfm.untitled')) + ' — ' + t('sfm.nLines', { n: (tx.lines || []).length }))}</option>`).join('');
    }
    const found = $('[data-a="found"]');
    if (found) found.textContent = t('sfm.found', { n: state.texts.length });
    const all = $('[data-a="all"]');
    if (all) { all.hidden = state.texts.length < 2; all.textContent = t('sfm.saveAll', { n: state.texts.length }); }
    /* alignmentRisk returns null when the pairing looks sound, or names WHY it does not:
     * 'single-spaced' (no column geometry to align by), 'shifted' (the geometry is partly gone, so
     * glosses have slid onto their neighbours) or 'lopsided' (most words got no gloss).
     * Said before anything is written, because a mis-glossed corpus is discovered much later. */
    const risk = state.mapping.baseline ? alignmentRisk(state.fields, state.mapping) : null;
    const warn = !state.mapping.baseline ? t('sfm.needBaseline')
      : !state.texts.length ? t('sfm.noneFound')
      : risk ? t('sfm.risk.' + risk.reason) : '';
    msg([note, warn].filter(Boolean).join(' '), true);
    $('[data-a="save"]').disabled = !state.texts.length || !state.mapping.baseline;
  }

  function renderMap() {
    const box = $('[data-step="map"]');
    box.hidden = false;
    const options = (role) => ['<option value="">' + esc(t('sfm.none')) + '</option>']
      .concat(state.inv.map((e) => `<option value="${esc(e.marker)}"${
        String(state.mapping[role] || '').toLowerCase() === e.marker.toLowerCase() ? ' selected' : ''
      }>\\${esc(e.marker)} (${e.count})</option>`)).join('');
    box.innerHTML = `
      <p class="note"><b>${esc(state.name)}</b> — ${esc(t('sfm.markersFound', { n: state.inv.length }))}</p>
      <div class="sfm-grid">
        ${CONVERT_ROLES.map((r) => `<label class="rp-field sfm-row"><span>${esc(t('sfm.role.' + r))}</span>
          <select data-role="${r}">${options(r)}</select></label>`).join('')}
      </div>
      <p class="note sfm-found" data-a="found"></p>
      <label class="rp-field"><span>${esc(t('sfm.which'))}</span><select data-a="which"></select></label>
      <button type="button" class="primary-btn" data-a="save">${esc(t('sfm.saveOne'))}</button>
      <button type="button" class="secondary-btn" data-a="all" hidden></button>`;
    box.querySelectorAll('[data-role]').forEach((s) => s.addEventListener('change', () => {
      const role = s.dataset.role;
      const { mapping, freed } = claimMarker(state.mapping, role, s.value);
      state.mapping = mapping;
      // The emptied roles have to LOOK emptied: their selects still show the marker they lost.
      for (const r of freed) { const el = box.querySelector(`[data-role="${r}"]`); if (el) el.value = ''; }
      try { localStorage.setItem(MAP_KEY, JSON.stringify(state.mapping)); } catch { /* non-fatal */ }
      recount(freed.length ? t('sfm.roleTaken', {
        marker: s.value,
        from: freed.map((r) => t('sfm.role.' + r)).join(', '),
        to: t('sfm.role.' + role),
      }) : '');
    }));
    $('[data-a="save"]').addEventListener('click', () => saveOne());
    $('[data-a="all"]').addEventListener('click', () => saveAll());
    recount();
  }

  const xmlFor = (tx, fallback) => serializeFlextext(textToDoc(tx, fallback, settings), settings,
    { producedBy: 'Flextext Editor Suite ' + (ENGINE_VERSION || '') + ' (Toolbox/SFM converter)' });

  function saveOne() {
    const i = +($('[data-a="which"]') || {}).value || 0;
    const tx = state.texts[i];
    if (!tx) return;
    const base = safeName(tx.title || state.name.replace(/\.[^.]+$/, ''), 'text');
    dl(new Blob([xmlFor(tx, base)], { type: 'application/xml' }), base + '.flextext');
    msg(t('sfm.savedOne', { name: base }), false);
  }

  async function saveAll() {
    /* One file per text, in a zip — Seth's "individual flextext files in an export folder or zip".
     * Names collide when two texts share a title (or have none), so they are numbered and
     * de-duplicated: a zip that silently dropped a text would be the worst possible outcome here. */
    const used = new Set();
    const entries = state.texts.map((tx, i) => {
      let base = safeName(tx.title, '') || safeName(state.name.replace(/\.[^.]+$/, ''), 'text');
      base = String(i + 1).padStart(2, '0') + ' ' + base;
      let name = base + '.flextext', n = 1;
      while (used.has(name.toLowerCase())) name = base + ' (' + (++n) + ').flextext';
      used.add(name.toLowerCase());
      return { name, data: new Blob([xmlFor(tx, base)], { type: 'application/xml' }) };
    });
    try {
      const zip = await makeZip(entries);
      dl(zip, safeName(state.name.replace(/\.[^.]+$/, ''), 'texts') + '.flextext.zip');
      msg(t('sfm.savedAll', { n: entries.length }), false);
    } catch (e) { msg(t('sfm.zipFailed', { msg: (e && e.message) || String(e) }), true); }
  }
}
