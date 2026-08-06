/* paragraph-export.js — exports FROM a .fxpa analysis.
 *
 * FORMAT-MODULE RULES (CLAUDE.md): imports nothing but other format modules — no DOM, no settings,
 * no IndexedDB, no i18n. Input is a validated .fxpa object; output is a string. Runs under plain
 * node (test/paragraph-export.test.mjs is the enforcement).
 *
 * BRACKETS around implicit propositions are a USER SETTING, default ON (Seth, 2026-08-05) — the
 * SSA convention marks material the analyst supplied rather than found, but a reader may want it
 * off. `opts.brackets === false` turns them off; the markup is unchanged either way, so the
 * setting is presentation only.
 *
 * ⚠ ONE ROW PER *LEAF UNIT*, NEVER "one row per line" (Seth, 2026-08-05). SSA analyses semantic
 * PROPOSITIONS, and a proposition often has no contiguous stretch of surface text at all — it is
 * the analyst's restatement of a nominalization, a genitive, or something merely implied. The
 * agreed design is authored "virtual daughter leaves" (`line.props = [{ id, text, implicit? }]`)
 * that group exactly like any other unit. They are not built yet, so today `leavesOfLine()`
 * returns the line itself — but every renderer here walks LEAVES, so propositions will arrive as
 * data rather than as a rewrite of these functions.
 */

import { esc } from './flextext.js';

/* ⚠ SYM/ASYM IS DERIVED FROM `heads`, NEVER STORED (the 2026-08-06 model change). A local copy of
 * the predicate rather than an import: this is a pure format module that deliberately depends on
 * almost nothing, and one expression is cheaper than a coupling.
 *
 * ⚠ MULTIPLE HEADS: for 0 or 1 head this behaves exactly as the old joinType/head did. With 2+,
 * every head is MARKED correctly, but the diagram's ANCHOR still uses the first — the SSA trunk
 * assumes one prominent member and two trunks in one cluster is a genuine layout question, not a
 * marking one. Seth, 2026-08-06: "once our model and UI have enabled multiple heads… we'll need to
 * consider the impact of that on our diagram exports." Decide that before enabling multi-head. */
const isAsym = (g) => !!g && Array.isArray(g.heads) && g.heads.length > 0;
const isHeadChild = (g, c) => !!g && Array.isArray(g.heads) && g.heads.includes(c);

/* ---------------- the unit walk everything renders from ---------------- */

const isGroup = (id) => /^G\d+$/.test(String(id));
const isProp = (id) => /^L\d+p\d+$/.test(String(id));
const lineOfProp = (id) => String(id).split('p')[0];
const propOf = (data, id) => {
  const l = data.lines.find((x) => x.id === lineOfProp(id));
  return (l && (l.props || []).find((p) => p.id === id)) || null;
};
/* The units at a line's proposition level: its written propositions, with any inside a group
 * replaced by that group. Mirrors the model's propUnits — the export module may not import it
 * (format modules import only format modules), so this is the same rule stated once more. */
const propSurface = (data, line) => {
  const written = (line.props || []).filter((p) => String(p.text || '').trim());
  const out = [], seen = new Set();
  for (const p of written) {
    let top = p.id;
    for (;;) {
      const par = data.tree.find((g) => g.children.includes(top));
      if (!par) break;
      top = par.id;
    }
    if (!seen.has(top)) { seen.add(top); out.push(top); }
  }
  return out;
};
const node = (data, id) => (isGroup(id) ? data.tree.find((g) => g.id === id)
  : isProp(id) ? propOf(data, id)
  : data.lines.find((l) => l.id === id)) || null;
const parentOf = (data, id) => data.tree.find((g) => g.children.includes(id)) || null;

// A line's leaves: its authored propositions when it has them, otherwise the line itself.
// This is the single place that will change when propositions land.
/* ⚠ ONLY PROPOSITIONS WITH TEXT REPLACE THE LINE (Seth, 2026-08-05: "the second line of source text
 * isn't showing in the diagram"). A line's propositions stand IN PLACE OF the line — that is the
 * point of them — but an EMPTY one is a box the analyst has just opened and not yet typed into,
 * and letting it stand in for the line makes the line's own text vanish from the diagram. Blank
 * propositions are therefore ignored here, and a line whose propositions are all blank renders as
 * itself. Nothing is deleted: the empty box stays in the editor, waiting to be filled. */
export function leavesOfLine(line) {
  const written = (Array.isArray(line.props) ? line.props : []).filter((p) => String(p.text || '').trim());
  return written.length
    ? written.map((p) => ({ ...p, lineId: line.id, isProp: true }))
    : [{ id: line.id, text: null, lineId: line.id, isProp: false, implicit: !!line.implicit }];
}

/* ONE flat surface, mirroring the model: a line contributes itself, or its written propositions.
 * Stated again here because a format module may import only other format modules. */
const orderOf = (data, id) => {
  const lineId = isProp(id) ? lineOfProp(id) : id;
  const li = data.lines.findIndex((l) => l.id === lineId);
  if (li < 0) return -1;
  if (!isProp(id)) return li * 1000;
  const pi = (data.lines[li].props || []).findIndex((p) => p.id === id);
  return li * 1000 + (pi < 0 ? 0 : pi + 1);
};

export function topUnitsOf(data) {
  const firstLeaf = (id) => {
    if (!isGroup(id)) return id;
    const g = node(data, id);
    return g && g.children.length ? firstLeaf(g.children[0]) : id;
  };
  const units = [];
  for (const l of data.lines) {
    // ALL propositions — identical to the model's surface (the anti-drift test enforces that).
    // A blank one is skipped when a ROW is built, not when the surface is described.
    const props = l.props || [];
    if (!props.length) { if (!parentOf(data, l.id)) units.push(l.id); continue; }
    for (const pr of props) if (!parentOf(data, pr.id)) units.push(pr.id);
  }
  for (const g of data.tree) if (!parentOf(data, g.id)) units.push(g.id);
  return units.sort((a, b) => orderOf(data, firstLeaf(a)) - orderOf(data, firstLeaf(b)));
}

/* ⚠ ASK THIS ONLY ABOUT LINES. A proposition has no baseline, free translation or words, so it
 * answers "yes, blank" and disappears — the same trap that hid propositions in the UI and in the
 * model (Seth: "Do remember the isBlankLine() fix in the redo"). Take the ID, not the node, so the
 * kind is always checked first. */
const blankUnit = (data, id) => {
  if (isGroup(id)) return false;
  if (isProp(id)) { const p = node(data, id); return !p || !String(p.text || '').trim(); }
  const l = node(data, id);
  return !!l && !String(l.baseline || '').trim() && !String(l.free || '').trim()
    && !(l.words || []).some((w) => String(w.txt || '').trim());
};
const blank = (l) => !!l && !String(l.baseline || '').trim() && !String(l.free || '').trim()
  && !(l.words || []).some((w) => String(w.txt || '').trim());

/* ---------------- interactive preview page ---------------- */

/* A self-contained HTML file: the analysis, its audio embedded as base64, and just enough script
 * to play and to expand/collapse. READ-ONLY by design — no grouping controls, nothing to save —
 * so it can be mailed to a colleague or opened beside FLEx without any risk to the analysis.
 *
 * opts: { title, audioB64, audioMime, only (unit ids to export), collapsed (ids), lang }
 */
export function buildParagraphPreviewHtml(data, opts = {}) {
  const { title = data.title || 'Text', audioB64 = '', audioMime = 'audio/wav' } = opts;
  const collapsed = new Set(opts.collapsed || (data.view && data.view.collapsed) || []);
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
  const hideBlank = opts.hideBlank !== undefined ? opts.hideBlank
    : (data.view ? data.view.hideBlank !== false : true);
  const view = data.view || {};
  const layer = opts.layer || view.layer || 'interlinear';
  const showFree = opts.free !== undefined ? opts.free : view.free !== false;

  const spanOf = (id) => {
    const ids = leafLineIds(data, id);
    const timed = ids.map((x) => node(data, x)).filter((l) => l && typeof l.start === 'number');
    if (!timed.length) return null;
    return { start: Math.min(...timed.map((l) => l.start)), end: Math.max(...timed.map((l) => l.end)) };
  };

  const renderLine = (id, label) => {
    const l = node(data, id);
    if (!l) return '';
    const sp = (typeof l.start === 'number' && typeof l.end === 'number') ? ` data-s="${l.start}" data-e="${l.end}"` : '';
    const parts = [];
    if (label) parts.push(`<span class="lbl">${esc(label)}</span>`);
    if (l.speaker) parts.push(`<span class="spk">${esc(l.speaker)}</span>`);
    if (sp && audioB64) parts.push(`<button class="play" data-s="${l.start}" data-e="${l.end}">▶</button>`);
    const body = [];
    // ONE ROW PER LEAF: today a line yields one; with propositions it will yield several.
    for (const leaf of leavesOfLine(l)) {
      const inner = [];
      if (leaf.isProp) {
        inner.push(`<div class="prop${leaf.implicit ? ' implicit' : ''}">${esc(leaf.text || '')}</div>`);
      } else if (layer === 'baseline') {
        inner.push(`<div class="bl${leaf.implicit ? ' implicit' : ''}">${esc(l.baseline || '')}</div>`);
      } else if (layer === 'interlinear') {
        inner.push(`<div class="wds">${(l.words || []).map((w) => w.punct
          ? `<span class="w"><span class="wt punct">${esc(w.txt)}</span></span>`
          : `<span class="w"><span class="wt">${esc(w.txt)}</span><span class="wg">${esc(w.gls || ' ')}</span></span>`).join('')}</div>`);
      }
      body.push(inner.join(''));
    }
    if (showFree && l.free) body.push(`<div class="ft">${esc(l.free)}</div>`);
    return `<div class="row"${sp}>${parts.join('')}<div class="cell">${body.join('')}</div></div>`;
  };

  const renderUnit = (id, label, depth = 0) => {
    if (!isGroup(id)) {
      const l = node(data, id);
      if (hideBlank && blank(l)) return '';
      return renderLine(id, label);
    }
    const g = node(data, id);
    if (!g) return '';
    const isCollapsed = collapsed.has(id);
    const sp = spanOf(id);
    const head = `<div class="badge">
      <button class="caret" aria-expanded="${!isCollapsed}">${isCollapsed ? '▸' : '▾'}</button>
      ${label ? `<span class="lbl">${esc(label)}</span>` : ''}
      <span class="jt">${isAsym(g) ? '⊳' : '⊕'}</span>
      ${g.relation ? `<span class="rel">${esc(g.relation)}</span>` : ''}
      ${sp && audioB64 ? `<button class="play" data-s="${sp.start}" data-e="${sp.end}">▶</button>` : ''}
    </div>`;
    const kids = g.children.map((c) => {
      if (hideBlank && blankUnit(data, c)) return '';
      const kidLabel = (g.labels || {})[c] || '';
      const el = renderUnit(c, kidLabel, depth + 1);
      return (isHeadChild(g, c) && el) ? el.replace(/^<div class="/, '<div class="head ') : el;
    }).join('');
    // ALWAYS emit the summary; CSS shows it only while collapsed. The reader can collapse groups
    // in the exported page too, and a collapsed bracket with nothing under it reads as broken —
    // the app shows a free-translation summary there and the export must match.
    const summary = `<div class="summary">${esc(summaryText(data, id))}</div>`;
    return `<div class="grp${isCollapsed ? ' collapsed' : ''}" data-depth="${depth % 6}">${head}${summary}<div class="kids">${kids}</div></div>`;
  };

  const units = topUnitsOf(data).filter((id) => !only || only.has(id));
  const body = units.map((id) => renderUnit(id, '')).join('');
  const speakers = (data.speakers || []).length ? `<p class="meta">Speakers: ${esc((data.speakers || []).join(', '))}</p>` : '';

  return `<!DOCTYPE html>
<html lang="${esc(opts.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --blue:#1f4f8f; --vern:#00379c; --gloss:#2a6e2a; --border:#cfd6e0; --panel:#f4f6f9; --muted:#5b6470; }
* { box-sizing:border-box; }
/* An explicit BACKGROUND, not just a colour: with only a text colour set, a reader whose browser
   is in dark mode gets this document's dark text on the browser's dark default and can barely
   read it. Caught in a screenshot; every DOM assertion had passed. This is a light document and
   declares itself one rather than half-inheriting a theme it has no other colours for.
   (NB: no backticks in this comment — the whole stylesheet lives inside a JS template literal.) */
html { background:#fff; }
body { margin:0; background:#fff; color:#1a1d21; font:16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", sans-serif; color-scheme:light; }
header { position:sticky; top:0; background:var(--panel); border-bottom:1px solid var(--border); padding:8px 14px; z-index:5; }
h1 { font-size:19px; margin:0 0 4px; }
.meta { margin:0; font-size:12px; color:var(--muted); }
.player { display:flex; align-items:center; gap:10px; margin-top:6px; }
.ovwrap { position:relative; flex:1; height:40px; }
canvas.ov { width:100%; height:100%; display:block; cursor:pointer; }
.cur { position:absolute; top:0; bottom:0; width:2px; background:#c33; pointer-events:none; }
main { padding:10px 14px 40vh; }
.row { display:flex; align-items:flex-start; gap:8px; padding:5px 6px; border-radius:8px; }
.row.on { background:#eef4ff; }
.cell { flex:1; min-width:0; }
.bl { color:var(--vern); font-size:17px; }
.wds { display:flex; flex-wrap:wrap; gap:2px 12px; }
.w { display:inline-flex; flex-direction:column; }
.wt { color:var(--vern); font-size:16px; }
.wt.punct { color:var(--muted); }
.wg { color:var(--gloss); font-size:13px; }
.ft { font-style:italic; font-size:14px; margin-top:2px; }
.prop { font-size:16px; }
.prop.implicit { color:var(--muted); font-style:italic; }
.brackets .prop.implicit::before { content:"("; } .brackets .prop.implicit::after { content:")"; }
/* Stacked brackets are colour-coded BY DEPTH and traceable on hover — identical parallel bars
   were hard to follow, and this page is read by the same eyes as the app (Seth, 2026-08-05). */
.grp { border-left:3px solid var(--blue); border-radius:8px 0 0 8px; margin:8px 0 8px 2px; padding-left:14px; }
.grp[data-depth="0"] { border-left-color:#1f4f8f; }
.grp[data-depth="1"] { border-left-color:#2a6e2a; }
.grp[data-depth="2"] { border-left-color:#8a5a00; }
.grp[data-depth="3"] { border-left-color:#6b21a8; }
.grp[data-depth="4"] { border-left-color:#0e7490; }
.grp[data-depth="5"] { border-left-color:#a33; }
.grp:has(> .badge:hover) { border-left-width:6px; padding-left:11px; background:rgba(31,79,143,.05); }
.grp.head, .row.head { box-shadow:inset 3px 0 0 var(--gloss); }
.badge { display:flex; align-items:center; gap:6px; padding:3px 6px; border-radius:6px; font-size:13px; color:var(--muted); background:var(--panel); }
.jt { font-weight:700; color:var(--blue); }
.rel { font-weight:600; color:#1a1d21; }
.lbl { flex:none; align-self:flex-start; margin-top:2px; font-size:12px; font-weight:600; color:#163a6b; background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:1px 6px; }
.spk { flex:none; align-self:flex-start; margin-top:2px; font-size:12px; font-weight:700; color:#6b21a8; background:#f3e8ff; border:1px solid #d8b4fe; border-radius:6px; padding:1px 6px; }
.summary { display:none; padding:2px 8px 2px 24px; font-style:italic; color:var(--muted); }
.collapsed > .summary { display:block; }
.collapsed > .kids { display:none; }
button.play, button.caret { border:1px solid var(--border); background:#fff; border-radius:50%; width:26px; height:26px; cursor:pointer; font-size:12px; line-height:1; }
button.caret { border:none; background:none; width:auto; }
footer { padding:10px 14px; color:var(--muted); font-size:12px; border-top:1px solid var(--border); }
</style>
</head>
<body class="${opts.brackets === false ? '' : 'brackets'}">
<header>
  <h1>${esc(title)}</h1>
  ${speakers}
  ${audioB64 ? `<div class="player">
    <button class="play" id="master">▶</button>
    <div class="ovwrap"><canvas class="ov" id="ov"></canvas><div class="cur" id="cur"></div></div>
    <span id="time" class="meta"></span>
  </div>` : ''}
</header>
<main>${body}</main>
<footer>Read-only view — expand or collapse the brackets to explore the structure. Made with the Flextext Paragraph Analysis Tool.</footer>
${audioB64 ? `<script>
(function () {
  var b = atob("${audioB64}"), u = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  var audio = new Audio(URL.createObjectURL(new Blob([u], { type: "${esc(audioMime)}" })));
  var stopAt = 0, active = null, peaks = null, mpb = 0, dur = 0;
  audio.addEventListener("timeupdate", function () {
    if (stopAt && audio.currentTime * 1000 >= stopAt - 20) audio.pause();
  });
  var AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    var ctx = new AC();
    ctx.decodeAudioData(u.buffer.slice(0)).then(function (buf) {
      var ch = buf.getChannelData(0);
      var B = Math.min(400000, Math.max(2000, Math.round(buf.duration * 800)));
      // CEIL, never floor: flooring leaves the tail of the recording with no buckets, so every
      // time past that point clamps to the end of the array and the waveform drifts (peakPlan).
      var per = Math.max(1, Math.ceil(ch.length / B));
      peaks = new Float32Array(B);
      for (var k = 0; k < B; k++) {
        var m = 0, off = k * per, end = Math.min(ch.length, off + per);
        for (var j = off; j < end; j += 4) { var v = Math.abs(ch[j]); if (v > m) m = v; }
        peaks[k] = m;
      }
      mpb = (per / buf.sampleRate) * 1000; dur = Math.round(buf.duration * 1000);
      try { ctx.close(); } catch (e) {}
      drawOv();
    }).catch(function () {});
  }
  function drawOv() {
    var c = document.getElementById("ov"); if (!c || !peaks) return;
    var dpr = window.devicePixelRatio || 1, W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    c.width = W; c.height = H;
    var g = c.getContext("2d"); g.clearRect(0, 0, W, H); g.fillStyle = "#1f4f8f";
    for (var x = 0; x < W; x++) {
      var i0 = Math.floor(x / W * peaks.length), i1 = Math.max(i0 + 1, Math.floor((x + 1) / W * peaks.length)), m = 0;
      for (var i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
      var h = Math.max(2, Math.pow(m, 0.6) * (H - 4));
      g.fillRect(x, (H - h) / 2, 1, h);
    }
  }
  window.addEventListener("resize", drawOv);
  function playSpan(s, e) {
    var now = audio.currentTime * 1000;
    if (!audio.paused && active && active[0] === s && active[1] === e) { audio.pause(); return; }
    active = [s, e]; stopAt = e;
    audio.currentTime = ((now > s && now < e - 150) ? now : s) / 1000;
    audio.play().catch(function () {});
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("button.play");
    if (b && b.id !== "master") { ev.stopPropagation(); playSpan(+b.dataset.s, +b.dataset.e); return; }
    if (b && b.id === "master") { if (!audio.paused && !stopAt) audio.pause(); else { stopAt = 0; active = null; audio.play().catch(function () {}); } return; }
    var c = ev.target.closest("button.caret");
    if (c) { var grp = c.closest(".grp"); grp.classList.toggle("collapsed"); c.textContent = grp.classList.contains("collapsed") ? "▸" : "▾"; c.setAttribute("aria-expanded", String(!grp.classList.contains("collapsed"))); }
  });
  var ov = document.getElementById("ov");
  if (ov) {
    var down = false;
    function seek(ev) { var T = dur || (isFinite(audio.duration) ? audio.duration * 1000 : 0); if (!T) return; var r = ov.getBoundingClientRect(); audio.currentTime = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * T / 1000; }
    ov.addEventListener("pointerdown", function (e) { e.preventDefault(); down = true; seek(e); });
    ov.addEventListener("pointermove", function (e) { if (down) seek(e); });
    window.addEventListener("pointerup", function () { down = false; });
  }
  function clock(ms) { var x = Math.max(0, Math.round(ms)); return Math.floor(x / 60000) + ":" + String(Math.floor((x % 60000) / 1000)).padStart(2, "0"); }
  (function tick() {
    var t = audio.currentTime * 1000, T = dur || (isFinite(audio.duration) ? audio.duration * 1000 : 0);
    var cur = document.getElementById("cur"), o = document.getElementById("ov");
    if (cur && o && T) cur.style.left = (Math.min(1, t / T) * o.clientWidth) + "px";
    var tm = document.getElementById("time"); if (tm && T) tm.textContent = clock(t) + " / " + clock(T);
    var m = document.getElementById("master"); if (m) m.textContent = (!audio.paused && !stopAt) ? "⏸" : "▶";
    var rows = document.querySelectorAll(".row[data-s]");
    for (var i = 0; i < rows.length; i++) {
      var s = +rows[i].dataset.s, e = +rows[i].dataset.e;
      rows[i].classList.toggle("on", t >= s && t < e);
    }
    requestAnimationFrame(tick);
  })();
})();
<\/script>` : `<script>
document.addEventListener("click", function (ev) {
  var c = ev.target.closest("button.caret");
  if (!c) return;
  var grp = c.closest(".grp"); grp.classList.toggle("collapsed");
  c.textContent = grp.classList.contains("collapsed") ? "▸" : "▾";
  c.setAttribute("aria-expanded", String(!grp.classList.contains("collapsed")));
});
<\/script>`}
</body>
</html>`;
}

// Ordered leaf LINE ids under any unit.
function leafLineIds(data, id) {
  if (!isGroup(id)) return [id];
  const g = node(data, id);
  if (!g) return [];
  const out = [];
  for (const c of g.children) out.push(...leafLineIds(data, c));
  return out;
}

// A collapsed group's one-line summary: free translations, which is what SSA reads. Recurses
// through groups; a LINE (including an asym group's head, which usually is one) ends the walk.
function summaryText(data, id) {
  if (!isGroup(id)) {
    const l = node(data, id);
    return (l && (l.free || l.baseline)) || '';
  }
  const g = node(data, id);
  if (!g) return '';
  // ⚠ An AUTHORED summary wins over the derived one — see summaryLineOf in paragraph-model.js.
  if (String(g.summary || '').trim()) return String(g.summary).trim();
  // ⚠ EVERY head, not heads[0] — see summaryLineOf in paragraph-model.js for why.
  if (isAsym(g)) return g.heads.map((h) => summaryText(data, h)).filter(Boolean).join('  ·  ');
  return g.children.map((c) => summaryText(data, c)).filter(Boolean).join('  ·  ');
}

/* A collapsed group's summary as SEPARATE LINES rather than one joined string — the shape the UI
 * shows when you collapse a group. Mirrors summaryOf() in paragraph-model.js. */
function summaryLines(data, id) {
  if (!isGroup(id)) { const t = summaryText(data, id); return t ? [t] : []; }
  const g = node(data, id);
  if (!g) return [];
  const parts = isAsym(g) ? g.heads : g.children;
  return parts.map((c) => summaryText(data, c)).filter(Boolean);
}

export { leafLineIds, summaryText };

/* ---------------- SSA propositional display ----------------
 *
 * The Beekman/Callow/Kopesec layout, which is what SIL's SSA actually looks like on paper:
 *   - ONE ROW PER PROPOSITION, indented by embedding depth;
 *   - each member's ROLE in its relation in a left column beside it (the prominent member's role
 *     conventionally in CAPS, the supporting member's lowercase — we print whatever the analyst
 *     typed, since that convention is theirs to keep);
 *   - nested vertical BRACKETS in the left margin spanning each grouping, with the group's own
 *     relation label written along its bracket.
 *
 * Pure: no DOM, so it cannot measure text. `opts.measure(text, fontSize)` is injected by the app
 * (a canvas measureText) and falls back to a width estimate — good enough that a node test can
 * assert the STRUCTURE, while the app gets real metrics. Everything is laid out in one pass so the
 * same geometry can be emitted as SVG, wrapped in a scrollable page, or rasterized to PNG.
 *
 * ⚠ Rows come from LEAF UNITS (see leavesOfLine): today one per line, and one per PROPOSITION once
 * authored propositions land — no change to this function.
 */

/* `runGap` is the whitespace ABOVE and BELOW a collapsed bracket's run — outside the bracket, so the
 * enclosure still hugs its own text and is merely separated from the lines that are NOT in it. */
const DEFAULTS_SSA = { width: 1000, fontSize: 15, lineHeight: 24, levelWidth: 120, labelWidth: 120,
                       pad: 16, gutter: 12, runGap: 12 };

/* Build the analysis as a LEFT-GROWING TREE (Seth, 2026-08-05: "our diagram should look more
 * tree-like, just like original SSA diagrams... instead of JUST brackets"). SIL describes the SSA
 * display as "a form somewhat resembling a tree diagram", and that is what this draws:
 *
 *      setting ─┐
 *               ├─ stepN–GOAL ─┬─ orienter ──── Some Dairi people heard…
 *                              └─ CONTENT  ──── They formed a group…
 *
 *   - every proposition on its own row, all TEXT ALIGNED in one column on the right;
 *   - the structure carried by the tree on the left, one column per depth;
 *   - each relation written HORIZONTALLY at its junction — the earlier bracket version rotated it
 *     along the bracket, where a two-row grouping had no room for it and neighbouring labels
 *     overprinted each other into mush;
 *   - PROMINENCE is the trunk: an asymmetrical group's line continues up from its HEAD child, so
 *     the eye follows the prominent element, which is the point of the method.
 */
export function ssaLayout(data, opts = {}) {
  const o = { ...DEFAULTS_SSA, ...opts };
  const measure = opts.measure || ((text, size) => String(text).length * size * 0.52);
  const collapsed = new Set(opts.collapsed || (data.view && data.view.collapsed) || []);
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
  const hideBlank = opts.hideBlank !== undefined ? opts.hideBlank
    : (data.view ? data.view.hideBlank !== false : true);
  /* WHAT EACH ROW SHOWS follows the VIEWER (Seth, 2026-08-05: "matching whatever view settings the
   * user had before they exported — if their viewer was free translation only, export free
   * translation only, if their viewer had interlinear, export that"). Carrying real interlinear
   * text into the analysis is what makes this tool different from a bare diagramming tool, so the
   * diagram has to be able to show words over glosses, not just a gloss line. */
  /* The DEFAULT stays 'free' — SSA states its propositions in the analysis language, not the
   * vernacular — and is NOT taken from data.view implicitly. The app passes the viewer's current
   * layer explicitly, so "export what I am looking at" is a decision the caller makes rather than
   * a surprise the library imposes on anyone rendering a document object.
   * `textSource` is the older name for this option and still works. */
  const layer = opts.layer || opts.textSource || 'free';
  const showFree = opts.free !== undefined ? !!opts.free : true;

  const contentOf = (line, leaf) => {
    if (leaf.isProp) return { kind: 'prop', text: leaf.text || '', implicit: !!leaf.implicit };
    const words = (line.words || []).filter((w) => (w.txt || '').trim());
    if (layer === 'interlinear' && words.length) {
      return { kind: 'interlinear', words, free: showFree ? (line.free || '') : '' };
    }
    if (layer === 'baseline') return { kind: 'text', text: line.baseline || '', free: showFree ? (line.free || '') : '' };
    // 'free' (and interlinear/baseline with nothing to show) — never render an empty row when
    // there IS text available on the other line.
    return { kind: 'text', text: line.free || line.baseline || '', free: '' };
  };

  /* ⚠ A LINE WITH PROPOSITIONS STILL APPEARS — AS CONTEXT (Seth, 2026-08-06: the language-data line
   * should be "in situ but unconnected" when it has propositions). Until now its propositions stood
   * in place of it and the line VANISHED from the diagram, which is right about the analysis and
   * wrong about the reader: the propositions are the analyst's restatement, and without the sentence
   * they restate there is nothing to check them against.
   *
   * So the line is drawn at its own position among its propositions, with NO branch into the tree.
   * That is the whole distinction: a node is connected, context is not. The mechanism is simply that
   * nothing in the node tree references this row — rows are laid out in array order and branches are
   * drawn from the tree, so an unreferenced row occupies its slot and receives no line.
   *
   * ⚠ IT GOES BEFORE THE FIRST PROPOSITION OF ITS LINE, wherever that lands. If all of a line's
   * propositions sit inside one group, the context row lands inside that group's span — which is
   * Seth's "the line rendered inside the top level of that group" — and it falls out of the ordering
   * rather than needing a rule of its own. If the propositions were split across groups, the line
   * appears once, above the first of them.
   *
   * Turning this OFF is the "propositions only" export: the line is omitted when it has
   * propositions, and a line with none contributes its own text as before. */
  const rows = [];
  /* ⚠ DEFAULT IS 'bracket' (Seth, 2026-08-07). Showing every line inside one bracket keeps the text
   * readable while still marking the constituent; 'leaf' hides everything but a summary, which is a
   * bigger claim to make on the user's behalf. */
  const collapsedStyle = opts.collapsedStyle === 'leaf' ? 'leaf' : 'bracket';
  const showLineContext = opts.lineContext !== false;
  const contextDone = new Set();
  const emitContext = (lineId) => {
    if (!showLineContext || contextDone.has(lineId)) return;
    contextDone.add(lineId);
    const l = data.lines.find((x) => x.id === lineId);
    if (!l) return;
    const c = contentOf(l, { id: l.id, text: null, lineId: l.id, isProp: false, implicit: !!l.implicit });
    if (!c || !(c.words ? c.words.length : String(c.text || '').trim())) return;
    rows.push({ depth: 0, label: '', content: c, head: false, implicit: !!l.implicit,
                speaker: l.speaker || '', context: true });
  };

  let maxDepth = 0;

  // Build a node tree; leaves push a row and remember its index.
  const build = (id, depth, roleLabel, isHead) => {
    maxDepth = Math.max(maxDepth, depth);
    if (isGroup(id)) {
      const g = node(data, id);
      if (!g) return null;
      if (collapsed.has(id)) {
        /* ⚠ COLLAPSING IS HOW YOU PRODUCE A BIG-PICTURE CHART — it marks a constituent and hides
         * what is inside it. Two renderings, and they are genuinely different pictures:
         *
         *   'leaf'    (default) — the group becomes ONE row of summary text. Densest; the chart is
         *                         about the shape of the discourse and the words are a reminder of
         *                         which unit you are looking at.
         *   'bracket'           — EVERY line under the group still appears, with ONE bracket around
         *                         the whole run and NO internal structure: no sub-brackets, no inner
         *                         relations, no member roles. Seth's analogy is the triangle in a
         *                         generative syntax tree — same JOB, highlight the larger constituent
         *                         and ignore lower-level detail — but drawn as a bracket, and the
         *                         text stays readable because the lines are still there.
         *
         * Either way the group keeps its OWN relation, role and slot labels: the collapsed node must
         * still say what it is and how it relates to its parent. What is suppressed is what is
         * BELOW it. */
        if (collapsedStyle === 'bracket') {
          const kids = [];
          for (const leafId of leafLineIds(data, id)) {
            if (hideBlank && blankUnit(data, leafId)) continue;
            /* ⚠ SAME depth, not depth + 1. These leaves get no stem of their own — the bracket is
             * drawn hard against the text instead — so an extra level would only widen the whole
             * diagram by one indent for connectors that are never drawn.
             * No role label and no head either: that is the internal detail being suppressed. */
            const kid = build(leafId, depth, '', false);
            if (kid) kids.push(kid);
          }
          if (!kids.length) return null;
          /* ⚠ BREATHING ROOM OUTSIDE THE ENCLOSURE (Seth, 2026-08-06, from a screenshot: the bottom
           * arm was almost touching the next line). A boundary drawn hard against its neighbours
           * reads as ambiguous — the row below looks like it might be inside. The gap is added
           * BEFORE the first row and AFTER the last, so it sits OUTSIDE the bracket: the enclosure
           * still hugs its own text exactly, and is simply separated from what is not in it. */
          const firstRow = kids[0].kind === 'leaf' ? rows[kids[0].row] : null;
          const lastRow = kids[kids.length - 1].kind === 'leaf' ? rows[kids[kids.length - 1].row] : null;
          if (firstRow) firstRow.runStart = true;
          if (lastRow) lastRow.runEnd = true;
          /* A run of ONE is not a bracket. Falling through to the group node would draw a bracket
           * around a single line, which says "constituent" about nothing. */
          if (kids.length === 1) { kids[0].label = roleLabel; kids[0].head = !!isHead; return kids[0]; }
          return { kind: 'group', depth, kids, relation: g.relation || '', slot: g.slot || '',
                   asym: isAsym(g), headIndex: -1, label: roleLabel, head: !!isHead, collapsed: true };
        }
        rows.push({ depth, label: roleLabel, head: !!isHead, collapsed: true,
                    content: { kind: 'text', text: summaryText(data, id), free: '' } });
        return { kind: 'leaf', depth, row: rows.length - 1, label: roleLabel, head: !!isHead };
      }
      const kids = [];
      for (const c of g.children) {
        if (hideBlank && blankUnit(data, c)) continue;
        const kid = build(c, depth + 1, (g.labels || {})[c] || '', isHeadChild(g, c));
        if (kid) kids.push(kid);
      }
      if (!kids.length) return null;
      return { kind: 'group', depth, kids, relation: g.relation || '', slot: g.slot || '', asym: isAsym(g),
               headIndex: kids.findIndex((k) => k.head), label: roleLabel, head: !!isHead };
    }
    /* A PROPOSITION IS ITS OWN LEAF on the flat surface. */
    if (isProp(id)) {
      const pr = node(data, id);
      const owner = data.lines.find((x) => x.id === lineOfProp(id));
      if (!pr || !String(pr.text || '').trim()) {
        /* ⚠ AN EMPTY PROPOSITION BOX MUST NOT SWALLOW ITS LINE. `leavesOfLine` already says that
         * only propositions WITH TEXT stand in for the line — an empty one is a box the analyst
         * has opened and not yet typed into. But units are surfaced as propositions, so the row
         * builder reached the blank prop directly, returned null, and the line disappeared from the
         * diagram: exactly the "second line of source text isn't showing" report that rule was
         * written to fix, still live on this path.
         * So when NONE of a line's propositions have text, the line renders as ITSELF here — a
         * normal connected node, not the muted context row, because there is no analysis standing
         * in front of it. Once any proposition is written, this stops firing and the line becomes
         * context instead. */
        const written = (owner && owner.props || []).some((x) => String(x.text || '').trim());
        if (written || !owner || contextDone.has(owner.id)) return null;
        contextDone.add(owner.id);   // one row for the line, however many empty boxes it has
        const leaf = leavesOfLine(owner)[0];
        if (leaf.isProp) return null;
        rows.push({ depth, label: roleLabel, content: contentOf(owner, leaf), head: !!isHead,
                    implicit: !!leaf.implicit, speaker: owner.speaker || '' });
        return { kind: 'leaf', depth, row: rows.length - 1, label: roleLabel, head: !!isHead };
      }
      emitContext(lineOfProp(id));   // the line itself, in situ and unconnected — see above
      rows.push({ depth, label: roleLabel, head: !!isHead, implicit: !!pr.implicit,
                  speaker: (owner && owner.speaker) || '',
                  content: { kind: 'prop', text: pr.text || '', implicit: !!pr.implicit, free: '' } });
      return { kind: 'leaf', depth, row: rows.length - 1, label: roleLabel, head: !!isHead };
    }
    const l = node(data, id);
    if (!l) return null;
    /* ONE FLAT SURFACE (the redo): a proposition is surfaced in its own right, so a line that has
     * propositions never reaches here as a unit — and a line that does reach here is a plain leaf.
     * Nothing needs to expand anything. */
    const leaf = leavesOfLine(l)[0];
    rows.push({ depth, label: roleLabel, content: contentOf(l, leaf), head: !!isHead,
                implicit: !!leaf.implicit, speaker: l.speaker || '' });
    return { kind: 'leaf', depth, row: rows.length - 1, label: roleLabel, head: !!isHead };
  };

  const roots = [];
  for (const id of topUnitsOf(data)) {
    if (only && !only.has(id)) continue;
    const n = build(id, 0, '', false);
    if (n) roots.push(n);
  }

  /* ⚠ THE TEXT COLUMN IS A FIXED WIDTH AND THE CANVAS GROWS TO HOLD IT (Seth, 2026-08-05: lines
   * too long, "the diagram is too wide", and "language data isn't showing up at all — at least if
   * the diagram is at all thorough"). Both were the SAME arithmetic: the text column used to be
   * whatever was LEFT OVER after the tree (`width - textX - pad`), so a deep analysis — exactly the
   * thorough ones — pushed textX out to the full canvas width and every line of text was drawn
   * beyond the right edge, invisible. Now `textWidth` is what the user asks for, the canvas is
   * whatever that needs, and the HTML wrapper scrolls. Wrapping keeps any single row from running
   * away; `levelWidth` lets a deep tree be tightened instead of truncated. */
  /* ⚠ THE LEAF LINE RUNS ALL THE WAY TO THE TEXT (Seth, 2026-08-05: terminal nodes should "have
   * the line go all the way to almost touching the text data itself"). It used to stop at a
   * reserved label column, leaving a gap — line, gap, label, gap, text — so the eye had to jump
   * twice to get from a branch to the words it points at, which on a tall diagram means losing
   * your place. The role label now floats ABOVE the end of its own line instead of occupying a
   * column, so there is nothing between the branch and the text, and the reserved column's width
   * is reclaimed (a narrower diagram into the bargain). */
  const treeWidth = (maxDepth + 1) * o.levelWidth;
  const labelX = o.pad + treeWidth + o.gutter;
  const textX = labelX + o.gutter;
  /* WRAPPING IS THE USER'S CALL (Seth, 2026-08-05: "enable or disable wrapping, which would
   * include the interlinear text"). With wrapping ON the column is the width they asked for and
   * long rows fold into it. With it OFF nothing folds — so the column has to be as wide as the
   * longest row, or the text would simply run off the canvas, which is the bug we just fixed at
   * the other end. Interlinear obeys the same switch: unwrapped, a line's words stay on one row
   * however many there are. */
  const wrap = opts.wrap !== false;
  // 'auto' = as wide as the longest row (Seth's auto-fit). Otherwise the width asked for, with the
  // longest row as a FLOOR when nothing may wrap — or the text would run off the canvas again.
  const auto = o.textWidth === 'auto';
  const asked = auto ? 0 : Math.max(120, o.textWidth || (o.width - textX - o.pad));
  const natural = (auto || !wrap) ? Math.max(0, ...rows.map((r) => naturalWidth(r.content, o, measure))) : 0;
  const textWidth = auto ? Math.max(120, natural) : (wrap ? asked : Math.max(asked, natural));
  /* ⚠ THE CANVAS IS EXACTLY WHAT THE CONTENT NEEDS — no minimum (Seth, 2026-08-05: "I don't see any
   * difference with the various settings"). `o.width` used to act as a 1000px FLOOR, so narrowing
   * the language-data column did not narrow the diagram; it only added whitespace on the right,
   * and "auto — fit the longest line" produced the same wide picture as everything else. The width
   * now follows the settings, which is the whole point of having them. */
  const width = textX + textWidth + o.pad;

  const glossSize = o.fontSize * 0.78;
  let y = o.pad;
  for (const r of rows) {
    // A plain-text view of the row, whatever the layer — handy for tests, search and PNG alt text.
    r.text = r.content.kind === 'interlinear'
      ? r.content.words.map((w) => w.txt).join(' ')
      : (r.content.text || '');
    r.blocks = layoutContent(r.content, wrap ? textWidth : Infinity, o, measure);
    if (r.runStart) y += o.runGap;          // space above a collapsed run, outside its bracket
    r.y = y;
    r.height = Math.max(o.lineHeight, r.blocks.height);
    r.midY = y + r.height / 2;
    y += r.height;
    if (r.runEnd) y += o.runGap;            // and below it
  }

  // Anchor: where a node's line leaves toward its parent. PROMINENCE IS THE TRUNK — an asymmetrical
  // group anchors on its HEAD child, so the trunk runs through the prominent element.
  const anchor = (n) => {
    if (n.kind === 'leaf') return rows[n.row].midY;
    const ys = n.kids.map(anchor);
    /* ⚠ THE MOTHER LINE ENTERS AT THE MEAN y OF THE PROMINENT MEMBERS — the heads if there are any,
     * otherwise all members (Seth, 2026-08-06: "treat the HEADS in a multi-head group as a range and
     * center the mother-line to that group on AVERAGE relative to the HEADS").
     *
     * One expression covers every case, which is why there is no branch on head count:
     *   1 head  → the mean of one value is that value — identical to the old behaviour;
     *   2+      → midway between them, so the line serves both rather than picking one;
     *   0 heads → the prominent set is every member, giving the span's midpoint — also unchanged.
     *
     * ⚠ Known and accepted: with NON-ADJACENT heads the mean lands on a support between them, so the
     * line appears to point at a non-head. Arithmetically right; Seth reviewed it and chose to ship
     * this rather than a bracket spanning the heads. Revisit if it reads wrong in a real analysis —
     * the model permits heads in ANY pattern, so the case is reachable whenever multi-head is on. */
    const headYs = ys.filter((_, i) => n.kids[i] && n.kids[i].head);
    const anchors = headYs.length ? headYs : ys;
    n.anchorY = anchors.reduce((a, b) => a + b, 0) / anchors.length;
    n.top = Math.min(...ys); n.bottom = Math.max(...ys);
    /* ⚠ THE FULL EXTENT OF THE ROWS, kept alongside the anchor extent and used by NOTHING except a
     * collapsed 'bracket' group (Seth, 2026-08-06, marked-up screenshot: the bracket ended inside
     * the first and last rows instead of enclosing them). Anchors are midpoints, so a joiner drawn
     * between them stops half a row short at each end — invisible on a normal group, where the
     * bracket only has to reach its members' connector stubs, but wrong for a bracket whose whole
     * job is to say "this entire range is one constituent".
     * ⚠ Every other group keeps drawing between anchors. Seth: "The rest of the diagram formatting
     * should remain unchanged for all other things." */
    const ext = n.kids.map((k) => (k.kind === 'leaf'
      ? [rows[k.row].y, rows[k.row].y + rows[k.row].height]
      : [k.spanTop, k.spanBottom]));
    n.spanTop = Math.min(...ext.map((e) => e[0]));
    n.spanBottom = Math.max(...ext.map((e) => e[1]));
    return n.anchorY;
  };
  roots.forEach(anchor);

  return { rows, roots, opts: o, labelX, textX, textWidth, treeWidth, maxDepth, glossSize, wrap,
           height: y + o.pad, width, measure };
}

/* How wide this row would be if nothing wrapped — used to size the column when wrapping is off. */
function naturalWidth(content, o, measure) {
  const c = content || { kind: 'text', text: '' };
  const glossSize = o.fontSize * 0.78;
  let w = 0;
  if (c.kind === 'interlinear') {
    const gap = Math.max(8, o.fontSize * 0.6);
    for (const word of c.words) w += Math.max(measure(word.txt || '', o.fontSize), measure(word.gls || '', glossSize)) + gap;
  } else {
    w = measure(c.text || '', o.fontSize);
  }
  return Math.max(w, c.free ? measure(c.free, glossSize) : 0);
}

/* One row's drawable content, measured. Returns { items[], height } where each item is a piece
 * positioned relative to the row's top: a run of words with their glosses underneath, a wrapped
 * paragraph of text, or the free translation. Interlinear is the reason this exists — a word and
 * its gloss are ONE unit that must not be split across a wrap. */
function layoutContent(content, maxWidth, o, measure) {
  const c = content || { kind: 'text', text: '' };
  const items = [];
  let y = 0;
  const glossSize = o.fontSize * 0.78;

  if (c.kind === 'interlinear') {
    const gap = Math.max(8, o.fontSize * 0.6);
    let line = [], x = 0;
    for (const w of c.words) {
      const txt = w.txt || '', gls = w.gls || '';
      const cell = Math.max(measure(txt, o.fontSize), measure(gls, glossSize));
      if (line.length && x + cell > maxWidth) {
        items.push({ type: 'words', y, cells: line });
        y += o.fontSize * 1.25 + glossSize * 1.35;
        line = []; x = 0;
      }
      line.push({ txt, gls, x });
      x += cell + gap;
    }
    if (line.length) { items.push({ type: 'words', y, cells: line }); y += o.fontSize * 1.25 + glossSize * 1.35; }
  } else {
    const text = c.kind === 'prop' ? c.text : c.text;
    for (const ln of wrapText(text, maxWidth, o.fontSize, measure)) {
      items.push({ type: 'line', y, text: ln, implicit: c.kind === 'prop' && c.implicit });
      y += o.lineHeight;
    }
  }

  if (c.free) {
    for (const ln of wrapText(c.free, maxWidth, glossSize, measure)) {
      items.push({ type: 'free', y, text: ln });
      y += glossSize * 1.5;
    }
  }
  return { items, height: Math.max(o.lineHeight, y + 6) };
}

/* ⚠ A NEWLINE IS A HARD BREAK, not whitespace. Splitting the whole string on /\s+/ swallowed them,
 * so any text carrying deliberate line structure — a collapsed group's per-head summary, a free
 * translation typed across two lines — was reflowed into one paragraph. Each segment is wrapped on
 * its own and the results concatenated, so a break the user put there survives and soft wrapping
 * still happens inside it. */
function wrapText(text, maxWidth, fontSize, measure) {
  const segments = String(text || '').split('\n');
  const out = [];
  for (const seg of segments) {
    const words = seg.split(/\s+/).filter(Boolean);
    if (!words.length) { if (segments.length === 1) out.push(''); continue; }
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (cur && measure(next, fontSize) > maxWidth) { out.push(cur); cur = w; } else cur = next;
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

// Shorten text until it fits, ending with an ellipsis; '' when there is no room at all.
function fitToLength(text, maxPx, fontSize, measure) {
  const t = String(text || '');
  if (maxPx <= fontSize) return '';
  if (measure(t, fontSize) <= maxPx) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(t.slice(0, mid) + '…', fontSize) <= maxPx) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? t.slice(0, lo) + '…' : '';
}

export function buildSsaSvg(data, opts = {}) {
  const L = ssaLayout(data, opts);
  const o = L.opts;
  const measure = L.measure;
  const showBrackets = opts.brackets !== false;
  // 'both' | 'relations' | 'roles' — a published SSA display often shows only one of the two.
  const labelMode = opts.labels || 'both';
  const showRelations = labelMode !== 'roles';
  const showRoles = labelMode !== 'relations';
  /* Slots are their own axis, so they are NOT governed by `labels` (which chooses between the two
   * SEMANTIC labels). A plot-structure chart may want slots and nothing else. */
  const showSlots = opts.slots !== false;
  const slotStyle = opts.slotStyle === 'rotated' ? 'rotated' : 'stacked';
  const xOf = (depth) => o.pad + depth * o.levelWidth;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${Math.round(L.height)}" viewBox="0 0 ${L.width} ${Math.round(L.height)}" font-family="Helvetica, Arial, sans-serif">`);
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');

  const line = (x1, y1, x2, y2, w, dash) =>
    parts.push(`<path d="M ${x1} ${y1} H ${x2}" stroke="#1f4f8f" stroke-width="${w}" fill="none"${dash ? ' stroke-dasharray="4 3"' : ''}/>`);

  /* Shared by BOTH group renderings — an ordinary group and a collapsed bracket must label
   * themselves identically. `vx` is the x of this group's vertical band (its joiner normally,
   * its bracket when collapsed), which is where a rotated slot rides. */
  const drawGroupLabels = (n, x, vx) => {
    /* ⚠ A GROUP CARRIES TWO INDEPENDENT LABELS AND BOTH MUST BE READABLE (Seth, 2026-08-05:
     * "daughter element labels and mother relationship labels are rendered in the same space and
     * when that happens, the relationship label wins and the daughter label doesn't appear at
     * all... daughter groups can have a relationship label as well as a daughter/item label at the
     * same time"). They are different things: RELATION names how this group's own children relate
     * to each other; ROLE names what this group is to its PARENT. Previously a group's role was
     * simply never drawn — only leaf rows got one — so nesting silently lost it.
     * They now occupy different bands of the trunk: the relation ABOVE the line, the role BELOW
     * it. Different bands rather than different x, so they cannot overprint however long they get.
     * `labels` chooses which are drawn: published SSA displays often show only one or the other. */
      /* ⚠ A ROTATED SLOT NEEDS ITS OWN COLUMN, and the column belongs to the PARENT's joiner — that
       * is where the label is drawn, and a label sitting on this node's own trunk start is what the
       * rotated slot of our PARENT occupies. So the shift is unconditional whenever rotation is on:
       * every horizontal label starts clear of the vertical band, and the two can never collide
       * however long either gets. */
      const slotCol = (slotStyle === 'rotated' && showSlots) ? 16 : 0;
      const lx = x + 5 + slotCol;
      /* ⚠ ROTATED SLOTS COST HORIZONTAL ROOM, and there is no way around it. A group's relation is
       * drawn from its trunk RIGHTWARDS, and its rotated slot sits on its own joiner one level to
       * the right — the same pixels. Shifting the label around only moves which pair collides
       * (moving it to the gutter, the first attempt, put it beside the wrong row entirely).
       * So the band is genuinely reserved: `room` gives up the column, and a long relation name is
       * ELLIPSISED by fitToLength rather than printed through the label. A visibly shortened label
       * is honest; two strings on top of each other is not.
       * The cost is real and the user can pay it back — widening "Indent per level" restores the
       * room. That trade is why rotation is opt-in and 'stacked' is the default. */
      const room = o.levelWidth - 12 - slotCol;
      // A segment cluster (one line's propositions) has no relation of its own, but it DOES carry
      // the line's role — that is the only place that role can now be written.
      if (n.relation && showRelations && !n.segment) {
        const lab = fitToLength(n.relation, room, 11, measure);
        if (lab) parts.push(`<text x="${lx}" y="${n.anchorY - 5}" font-size="11" fill="#163a6b">${esc(lab)}</text>`);
      }
      /* ⚠ THE DISCOURSE SLOT IS A THIRD, INDEPENDENT LABEL and needs its own space — the same trap
       * that made a group's role invisible when it also had a relation. It is a higher-order thing
       * than either (what part this group plays in the whole text, not how its members relate), so
       * it is drawn LARGER and in its own place rather than competing in the same band.
       *
       * Two renderings, because this is a judgement call best made by looking:
       *   'stacked'  (default) — a heading above the relation. Reads left-to-right like everything
       *                          else, costs a little vertical room, never truncates.
       *   'rotated'            — set vertically along the group's own bracket, where it labels the
       *                          full extent of the span it names. Striking on a big chart, but it
       *                          costs horizontal space and is harder to read.
       * ⚠ ROTATED IS DRAWN ON THE JOINER, NOT THE TRUNK — the joiner spans the group's members, so
       * the label sits beside exactly the stretch it describes. On the trunk it would be a tick at
       * one y with nothing to say how far the slot reaches. */
      if (n.slot && showSlots) {
        if (slotStyle === 'rotated') {
          /* ⚠ ON THE GROUP'S OWN BRACKET (Seth, 2026-08-06, with a marked-up screenshot). The joiner
           * is the vertical line spanning this group's members, so a label beside it names exactly
           * the stretch it describes; parked out in the trunk gutter it read as belonging to
           * whatever else was on that row.
           *
           * ⚠ IT SITS JUST LEFT OF THE JOINER AND THE CHILD LABELS MOVE RIGHT TO CLEAR IT. This is
           * the collision that drove it into the gutter the first time: child relations are drawn
           * from the joiner rightwards, so a label on the joiner printed straight through
           * "orienter–CONTENT". Relocating it hid the problem; reserving a column solves it.
           *
           * ⚠ NOT TRUNCATED TO THE SPAN. Fitting it to the group's height seemed right — the bracket
           * is its budget — but a two-member group is barely one line tall, so "Stage setting" was
           * cut to nothing and the slot vanished. A label overhanging its bracket is readable; a
           * missing one is a lost analysis. Centred on the span, so any overhang is symmetrical. */
          /* ⚠ OVERHANG IS BOUNDED, not unlimited. Clamping to the span exactly cut short groups'
           * labels to nothing; allowing any length let two SIBLING groups' labels — same depth, so
           * the same x — run into each other vertically. The budget is the span plus a fixed
           * tolerance, with a floor so an ordinary slot name ("Stage setting", "Episode 1") always
           * fits whatever the span: a short group still shows a readable label, and only a genuinely
           * long one is ellipsised instead of climbing into its neighbour. */
          const top = n.collapsed ? n.spanTop : n.top;
          const bot = n.collapsed ? n.spanBottom : n.bottom;
          const mid = (top + bot) / 2;
          const sx = vx - 7;
          const lab = fitToLength(n.slot, Math.max(112, (bot - top) + 46), 12, measure);
          if (lab) parts.push(`<text x="${sx}" y="${mid}" font-size="12" font-weight="700" fill="#6b21a8" text-anchor="middle" transform="rotate(-90 ${sx} ${mid})">${esc(lab)}</text>`);
        } else {
          const lab = fitToLength(n.slot, room + o.levelWidth, 12.5, measure);
          if (lab) parts.push(`<text x="${lx}" y="${n.anchorY - (n.relation && showRelations && !n.segment ? 19 : 5)}" font-size="12.5" font-weight="700" fill="#6b21a8">${esc(lab)}</text>`);
        }
      }
      if (n.label && showRoles) {
        const lab = fitToLength(n.label, room, 10.5, measure);
        // A prominent member is written in caps by convention; colour marks it here too.
        if (lab) parts.push(`<text x="${lx}" y="${n.anchorY + 12}" font-size="10.5" font-weight="${n.head ? 700 : 600}" fill="${n.head ? '#2a6e2a' : '#5b6470'}">${esc(lab)}</text>`);
      }
  };

  const draw = (n) => {
    if (n.kind === 'leaf') {
      // ...to just short of the text, so the branch and the words it names are visually one thing.
      line(xOf(n.depth), L.rows[n.row].midY, L.textX - 8, L.rows[n.row].midY, n.head ? 2.4 : 1.2, false);
      return;
    }
    const x = xOf(n.depth), xc = xOf(n.depth + 1);
    // the vertical joiner across this group's children
    /* ── A COLLAPSED 'bracket' GROUP IS DRAWN COMPLETELY DIFFERENTLY ────────────────────────────
     * Seth, 2026-08-06, approved from a mockup: "the upstream stem to go all the way to the items,
     * and then don't have individual stems for each daughter, just the encompassing bracket right
     * up against them."
     *
     * So: ONE stem from the parent running the full width to the text, ONE bracket hard against the
     * words enclosing the whole range, and NOTHING else — no per-line stems, no inner structure.
     * That is what makes it read as a single constituent rather than a list of members: there is
     * literally one line in and one boundary, however many rows are inside.
     *
     * ⚠ The bracket spans the rows' FULL extent (spanTop/spanBottom), not the anchor extent — a
     * boundary that stops half a row inside the thing it bounds is not a boundary. Its arms point
     * toward the text, so it reads as enclosing the words rather than as a stray spine.
     * ⚠ It RETURNS — the children are never drawn, which is the whole point. */
    if (n.collapsed) {
      const bx = L.textX - 10;
      const arm = 12;
      line(x, n.anchorY, bx, n.anchorY, n.head ? 2.4 : 1.6, false);
      parts.push(`<path d="M ${bx} ${n.spanTop} V ${n.spanBottom}" stroke="#1f4f8f" stroke-width="1.6" fill="none"/>`);
      parts.push(`<path d="M ${bx} ${n.spanTop} H ${bx + arm} M ${bx} ${n.spanBottom} H ${bx + arm}" stroke="#1f4f8f" stroke-width="1.6" fill="none"/>`);
      drawGroupLabels(n, x, bx);
      return;
    }
    parts.push(`<path d="M ${xc} ${n.top} V ${n.bottom}" stroke="#1f4f8f" stroke-width="1.4" fill="none"${n.asym ? '' : ' stroke-dasharray="4 3"'}/>`);
    // each child's connector into the joiner
    for (const k of n.kids) {
      const ky = k.kind === 'leaf' ? L.rows[k.row].midY : k.anchorY;
      line(xc, ky, xc + (k.kind === 'leaf' ? 0 : 0), ky, 1, false);
      if (k.kind !== 'leaf') line(xc, ky, xOf(k.depth), ky, k.head ? 2.4 : 1.2, false);
    }
    // this group's own line toward its parent — the TRUNK, thicker when it is the prominent one
    line(x, n.anchorY, xc, n.anchorY, n.head ? 2.4 : 1.6, false);
    drawGroupLabels(n, x, xc);
    n.kids.forEach(draw);
  };
  L.roots.forEach(draw);

  for (const r of L.rows) {
    const items = r.blocks.items;
    const top = r.y + Math.max(0, (r.height - r.blocks.height) / 2);
    const firstY = top + o.fontSize * 0.9;
    // Right-aligned to the end of the leaf's line, above it — so the role names the row it touches.
    if (r.label && showRoles && !r.context) {
      const lab = fitToLength(r.label, Math.max(60, L.textX - L.opts.pad - 8), 12, measure);
      parts.push(`<text x="${L.textX - 10}" y="${r.midY - 5}" text-anchor="end" font-size="12" font-weight="${r.head ? 700 : 600}" fill="${r.head ? '#2a6e2a' : '#163a6b'}">${esc(lab)}</text>`);
    }
    if (r.speaker) parts.push(`<text x="${L.textX - 10}" y="${r.midY + 13}" text-anchor="end" font-size="10" fill="#6b21a8">${esc(r.speaker)}</text>`);
    const nLines = items.filter((it) => it.type === 'line').length;
    let seen = 0;
    for (const it of items) {
      const y = top + it.y + o.fontSize * 0.9;
      if (it.type === 'words') {
        // A word sits over its gloss; the pair was measured as one cell so it never splits.
        for (const c of it.cells) {
          parts.push(`<text x="${L.textX + c.x}" y="${y}" font-size="${o.fontSize}" fill="${r.context ? '#8892a0' : '#1a4d8f'}">${esc(c.txt)}</text>`);
          if (c.gls) parts.push(`<text x="${L.textX + c.x}" y="${y + L.glossSize * 1.35}" font-size="${L.glossSize}" fill="#2a6e2a">${esc(c.gls)}</text>`);
        }
      } else if (it.type === 'free') {
        parts.push(`<text x="${L.textX}" y="${y}" font-size="${L.glossSize}" fill="#454b54" font-style="italic">${esc(it.text)}</text>`);
      } else {
        const txt = (it.implicit && showBrackets)
          ? ((seen === 0 ? '(' : '') + it.text + (seen === nLines - 1 ? ')' : '')) : it.text;
        seen++;
        parts.push(`<text x="${L.textX}" y="${y}" font-size="${o.fontSize}" fill="${r.context ? '#8892a0' : it.implicit ? '#5b6470' : '#1a1d21'}"${it.implicit ? ' font-style="italic"' : ''}>${esc(txt)}</text>`);
      }
    }
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/* The same diagram as a scrollable web page (Seth: two HTML exports — the interactive preview,
 * and "a scrollable graphical diagram ... except it's an HTML page that is scrollable"). The SVG
 * is inlined at its natural size inside a scrolling container, so a wide arcing-style diagram is
 * usable in a browser instead of being squashed to fit. */
export function buildSsaDiagramHtml(data, opts = {}) {
  const svg = buildSsaSvg(data, opts);
  const title = opts.title || data.title || 'Text';
  return `<!DOCTYPE html>
<html lang="${esc(opts.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — semantic structure</title>
<style>
html { background:#fff; }
body { margin:0; background:#fff; color:#1a1d21; color-scheme:light; font:15px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
header { position:sticky; top:0; background:#f4f6f9; border-bottom:1px solid #cfd6e0; padding:8px 14px; }
h1 { font-size:18px; margin:0; }
.scroll { overflow:auto; padding:10px 14px 40px; }
svg { display:block; }
footer { padding:10px 14px; color:#5b6470; font-size:12px; border-top:1px solid #cfd6e0; }
</style>
</head>
<body>
<header><h1>${esc(title)} — semantic structure</h1></header>
<div class="scroll">${svg}</div>
<footer>Semantic structure analysis. Made with the Flextext Paragraph Analysis Tool.</footer>
</body>
</html>`;
}


/* ---------------- raster export (PNG / JPEG) ----------------
 * Seth, 2026-08-06: PNG and JPG, with a resolution slider and a live size estimate.
 *
 * ⚠ THE SVG IS RASTERISED IN THE BROWSER, not re-drawn. Re-implementing the diagram against a canvas
 * API would be a second renderer, and two renderers drift — the picture you export would slowly stop
 * matching the picture you previewed. Drawing the SVG into a canvas keeps exactly one drawing path.
 *
 * ⚠ ENCODED AS A data: URL, NOT a blob: URL. A blob: URL would need revoking and, more importantly,
 * some browsers taint a canvas drawn from one, which makes toBlob throw a security error at the last
 * step. A self-contained SVG (which ours is — no external fonts, no images) is safe inline.
 *
 * ⚠ JPEG IS FLATTENED ONTO WHITE. JPEG has no alpha, so an unpainted canvas exports as black. The
 * SVG already paints a white background rect, but the canvas is filled anyway: relying on the
 * content to cover every pixel is the kind of assumption that breaks the first time a margin
 * changes. */
export function rasterizeSsa(svgText, { scale = 2, type = 'image/png', quality = 0.92 } = {}) {
  return new Promise((resolve, reject) => {
    const m = /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(svgText);
    if (!m) return reject(new Error('Could not read the diagram size.'));
    const w = Math.max(1, Math.round(+m[1] * scale));
    const h = Math.max(1, Math.round(+m[2] * scale));
    /* ⚠ A HARD PIXEL CEILING. Canvases have per-browser limits (often ~16k a side, and an area cap);
     * past them toBlob returns null or a blank image with NO error, so an unchecked slider silently
     * produces a broken file. Refusing with a message beats exporting something empty. */
    const MAX_SIDE = 12000, MAX_AREA = 60e6;
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_AREA) {
      return reject(new Error(`That resolution would be ${w}×${h}px, which is too large to render. Use a smaller scale.`));
    }
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        c.toBlob((b) => (b ? resolve({ blob: b, width: w, height: h })
                           : reject(new Error('The browser could not encode that image.'))),
                 type, quality);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('The diagram could not be drawn for export.'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  });
}
