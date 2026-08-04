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

/* ---------------- the unit walk everything renders from ---------------- */

const isGroup = (id) => /^G\d+$/.test(String(id));
const node = (data, id) => (isGroup(id) ? data.tree.find((g) => g.id === id) : data.lines.find((l) => l.id === id)) || null;
const parentOf = (data, id) => data.tree.find((g) => g.children.includes(id)) || null;

// A line's leaves: its authored propositions when it has them, otherwise the line itself.
// This is the single place that will change when propositions land.
export function leavesOfLine(line) {
  return (Array.isArray(line.props) && line.props.length)
    ? line.props.map((p) => ({ ...p, lineId: line.id, isProp: true }))
    : [{ id: line.id, text: null, lineId: line.id, isProp: false }];
}

export function topUnitsOf(data) {
  const pos = new Map(data.lines.map((l, i) => [l.id, i]));
  const firstLine = (id) => {
    if (!isGroup(id)) return id;
    const g = node(data, id);
    return g && g.children.length ? firstLine(g.children[0]) : id;
  };
  const units = [];
  for (const l of data.lines) if (!parentOf(data, l.id)) units.push(l.id);
  for (const g of data.tree) if (!parentOf(data, g.id)) units.push(g.id);
  return units.sort((a, b) => (pos.get(firstLine(a)) ?? 0) - (pos.get(firstLine(b)) ?? 0));
}

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
        inner.push(`<div class="bl">${esc(l.baseline || '')}</div>`);
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

  const renderUnit = (id, label) => {
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
      <span class="jt">${g.joinType === 'asym' ? '⊳' : '⊕'}</span>
      ${g.relation ? `<span class="rel">${esc(g.relation)}</span>` : ''}
      ${sp && audioB64 ? `<button class="play" data-s="${sp.start}" data-e="${sp.end}">▶</button>` : ''}
    </div>`;
    const kids = g.children.map((c) => {
      if (hideBlank && !isGroup(c) && blank(node(data, c))) return '';
      const kidLabel = (g.labels || {})[c] || '';
      const el = renderUnit(c, kidLabel);
      return (g.joinType === 'asym' && g.head === c && el) ? el.replace(/^<div class="/, '<div class="head ') : el;
    }).join('');
    // ALWAYS emit the summary; CSS shows it only while collapsed. The reader can collapse groups
    // in the exported page too, and a collapsed bracket with nothing under it reads as broken —
    // the app shows a free-translation summary there and the export must match.
    const summary = `<div class="summary">${esc(summaryText(data, id))}</div>`;
    return `<div class="grp${isCollapsed ? ' collapsed' : ''}">${head}${summary}<div class="kids">${kids}</div></div>`;
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
.grp { border-left:3px solid var(--blue); border-radius:6px 0 0 6px; margin:6px 0 6px 2px; padding-left:8px; }
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
  if (g.joinType === 'asym' && g.head) return summaryText(data, g.head);
  return g.children.map((c) => summaryText(data, c)).filter(Boolean).join('  ·  ');
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

const DEFAULTS_SSA = { width: 1000, fontSize: 15, lineHeight: 24, levelWidth: 120, labelWidth: 120, pad: 16, gutter: 12 };

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
  const textSource = opts.textSource || 'free';

  const textOf = (line, leaf) => {
    if (leaf.isProp) return leaf.text || '';
    if (textSource === 'baseline') return line.baseline || '';
    return line.free || line.baseline || '';
  };

  const rows = [];
  let maxDepth = 0;

  // Build a node tree; leaves push a row and remember its index.
  const build = (id, depth, roleLabel, isHead) => {
    maxDepth = Math.max(maxDepth, depth);
    if (isGroup(id)) {
      const g = node(data, id);
      if (!g) return null;
      if (collapsed.has(id)) {
        rows.push({ depth, label: roleLabel, text: summaryText(data, id), head: !!isHead, collapsed: true });
        return { kind: 'leaf', depth, row: rows.length - 1, label: roleLabel, head: !!isHead };
      }
      const kids = [];
      for (const c of g.children) {
        if (hideBlank && !isGroup(c) && blank(node(data, c))) continue;
        const kid = build(c, depth + 1, (g.labels || {})[c] || '', g.joinType === 'asym' && g.head === c);
        if (kid) kids.push(kid);
      }
      if (!kids.length) return null;
      return { kind: 'group', depth, kids, relation: g.relation || '', joinType: g.joinType,
               headIndex: kids.findIndex((k) => k.head), label: roleLabel, head: !!isHead };
    }
    const l = node(data, id);
    if (!l) return null;
    const leaves = leavesOfLine(l).map((leaf) => {
      rows.push({ depth, label: roleLabel, text: textOf(l, leaf), head: !!isHead,
                  implicit: !!leaf.implicit, speaker: l.speaker || '' });
      return { kind: 'leaf', depth, row: rows.length - 1, label: roleLabel, head: !!isHead };
    });
    // Several propositions from one segment behave as an implicit grouping of that segment.
    return leaves.length === 1 ? leaves[0]
      : { kind: 'group', depth, kids: leaves, relation: '', joinType: 'sym', headIndex: -1, label: roleLabel, head: !!isHead, segment: true };
  };

  const roots = [];
  for (const id of topUnitsOf(data)) {
    if (only && !only.has(id)) continue;
    const n = build(id, 0, '', false);
    if (n) roots.push(n);
  }

  const treeWidth = (maxDepth + 1) * o.levelWidth;
  const labelX = o.pad + treeWidth + o.gutter;
  const textX = labelX + o.labelWidth + o.gutter;
  const textWidth = Math.max(160, o.width - textX - o.pad);

  let y = o.pad;
  for (const r of rows) {
    r.lines = wrapText(r.text, textWidth, o.fontSize, measure);
    r.y = y;
    r.height = Math.max(o.lineHeight, r.lines.length * o.lineHeight);
    r.midY = y + r.height / 2;
    y += r.height;
  }

  // Anchor: where a node's line leaves toward its parent. PROMINENCE IS THE TRUNK — an asymmetrical
  // group anchors on its HEAD child, so the trunk runs through the prominent element.
  const anchor = (n) => {
    if (n.kind === 'leaf') return rows[n.row].midY;
    const ys = n.kids.map(anchor);
    n.anchorY = (n.joinType === 'asym' && n.headIndex >= 0) ? ys[n.headIndex] : (Math.min(...ys) + Math.max(...ys)) / 2;
    n.top = Math.min(...ys); n.bottom = Math.max(...ys);
    return n.anchorY;
  };
  roots.forEach(anchor);

  return { rows, roots, opts: o, labelX, textX, textWidth, treeWidth, maxDepth,
           height: y + o.pad, width: o.width, measure };
}

function wrapText(text, maxWidth, fontSize, measure) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cur && measure(next, fontSize) > maxWidth) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
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
  const xOf = (depth) => o.pad + depth * o.levelWidth;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${Math.round(L.height)}" viewBox="0 0 ${L.width} ${Math.round(L.height)}" font-family="Helvetica, Arial, sans-serif">`);
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>');

  const line = (x1, y1, x2, y2, w, dash) =>
    parts.push(`<path d="M ${x1} ${y1} H ${x2}" stroke="#1f4f8f" stroke-width="${w}" fill="none"${dash ? ' stroke-dasharray="4 3"' : ''}/>`);

  const draw = (n) => {
    if (n.kind === 'leaf') {
      // the leaf's own line runs from its depth column to the label column
      line(xOf(n.depth), L.rows[n.row].midY, L.labelX - 6, L.rows[n.row].midY, n.head ? 2.4 : 1.2, false);
      return;
    }
    const x = xOf(n.depth), xc = xOf(n.depth + 1);
    // the vertical joiner across this group's children
    parts.push(`<path d="M ${xc} ${n.top} V ${n.bottom}" stroke="#1f4f8f" stroke-width="1.4" fill="none"${n.joinType === 'sym' ? ' stroke-dasharray="4 3"' : ''}/>`);
    // each child's connector into the joiner
    for (const k of n.kids) {
      const ky = k.kind === 'leaf' ? L.rows[k.row].midY : k.anchorY;
      line(xc, ky, xc + (k.kind === 'leaf' ? 0 : 0), ky, 1, false);
      if (k.kind !== 'leaf') line(xc, ky, xOf(k.depth), ky, k.head ? 2.4 : 1.2, false);
    }
    // this group's own line toward its parent — the TRUNK, thicker when it is the prominent one
    line(x, n.anchorY, xc, n.anchorY, n.head ? 2.4 : 1.6, false);
    if (n.relation && !n.segment) {
      const room = o.levelWidth - 14;
      const label = fitToLength(n.relation, room, 11, measure);
      if (label) parts.push(`<text x="${x + 5}" y="${n.anchorY - 5}" font-size="11" fill="#163a6b">${esc(label)}</text>`);
    }
    n.kids.forEach(draw);
  };
  L.roots.forEach(draw);

  for (const r of L.rows) {
    const baseY = r.y + (r.height - (r.lines.length - 1) * o.lineHeight) / 2 + o.fontSize * 0.36;
    if (r.label) {
      const lab = fitToLength(r.label, o.labelWidth, 12, measure);
      parts.push(`<text x="${L.labelX}" y="${baseY}" font-size="12" font-weight="${r.head ? 700 : 600}" fill="${r.head ? '#2a6e2a' : '#163a6b'}">${esc(lab)}</text>`);
    }
    if (r.speaker) parts.push(`<text x="${L.labelX}" y="${baseY + 13}" font-size="10" fill="#6b21a8">${esc(r.speaker)}</text>`);
    r.lines.forEach((ln, i) => {
      const txt = (r.implicit && showBrackets) ? ((i === 0 ? '(' : '') + ln + (i === r.lines.length - 1 ? ')' : '')) : ln;
      parts.push(`<text x="${L.textX}" y="${baseY + i * o.lineHeight}" font-size="${o.fontSize}" fill="${r.implicit ? '#5b6470' : '#1a1d21'}"${r.implicit ? ' font-style="italic"' : ''}>${esc(txt)}</text>`);
    });
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
