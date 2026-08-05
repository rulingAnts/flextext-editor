/* paragraph-model.js — the Paragraph Analysis data model: .fxpa parse/validate/serialize and the
 * grouping-tree operations with their invariants.
 *
 * FORMAT-MODULE RULES (CLAUDE.md): imports nothing but other format modules — no DOM, no
 * settings, no IndexedDB, no i18n. Everything here runs under plain node
 * (test/paragraph-model.test.mjs is the enforcement).
 *
 * THE MODEL OWNS THE INVARIANTS (same doctrine as segments.js): every tree mutation routes
 * through here and either returns a valid new state or throws with a human-readable message.
 * Invariants: units group only when ADJACENT and PARENTLESS (trees build bottom-up); every unit
 * has at most one parent; a group's level = 1 + max(child levels), lines are level 0; joinType is
 * 'sym' | 'asym'; asym has EXACTLY ONE head (∈ children), sym has NONE; brackets can never cross
 * by construction (adjacency + single-parent). The DEFAULT join is GROUPING — nothing here ever
 * merges audio segments or text (Seth: destructive merges are a separate, explicit v1.1 feature).
 *
 * LABELLING (Seth, 2026-08-04) — a relation may be written on the GROUP, on its MEMBER NODES, or
 * both, and every one of them is OPTIONAL:
 *   - `relation` — the group's own label (e.g. "grounds–CONCLUSION", "ADDITION");
 *   - `labels`   — { childId: "grounds", … }, each member's ROLE in that relation. This is the
 *     SSA convention (the prominent member's role in CAPS, the supporting member's in lowercase)
 *     and it belongs on the GROUP, not on the unit: a role is held relative to ONE relation.
 * Keys are validated to be members of that group, values are trimmed, and empties are dropped —
 * so "no label" is genuinely absent rather than an empty string in the saved file.
 */

export const FXPA_FORMAT = 'flextext-paragraph-analysis';
export const FXPA_VERSION = 1;

/* ---------------- validation / normalization ---------------- */

// Returns { ok:true, data } (normalized: tree/view/lines arrays present, defaults filled) or
// { ok:false, errors:[...] }. Never throws on foreign input.
export function validateFxpa(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['Not a JSON object.'] };
  if (obj.format !== FXPA_FORMAT) errors.push(`Not a .fxpa file (format is "${obj.format || 'missing'}").`);
  if (typeof obj.version !== 'number' || obj.version > FXPA_VERSION) {
    errors.push(`Unsupported .fxpa version ${obj.version} (this app reads up to ${FXPA_VERSION}).`);
  }
  if (!Array.isArray(obj.lines) || !obj.lines.length) errors.push('No lines in the file.');
  if (errors.length) return { ok: false, errors };

  const data = { ...obj };
  data.lines = obj.lines.map((l, i) => ({ ...l, id: String(l.id || 'L' + (i + 1)) }));
  data.tree = Array.isArray(obj.tree) ? obj.tree.map((g) => ({ ...g, children: [...(g.children || [])] })) : [];
  data.view = { layer: 'interlinear', free: true, audio: true, waves: 'compact', collapsed: [], ...(obj.view || {}) };
  if (!Array.isArray(data.view.collapsed)) data.view.collapsed = [];
  if (!data.audio || !data.audio.b64) { delete data.audio; data.view.audio = false; }

  const ids = new Set();
  for (const l of data.lines) {
    if (ids.has(l.id)) errors.push(`Duplicate line id ${l.id}.`);
    ids.add(l.id);
    const timed = typeof l.start === 'number' && typeof l.end === 'number';
    if ((typeof l.start === 'number') !== (typeof l.end === 'number')) errors.push(`Line ${l.id}: start/end must come together.`);
    if (timed && l.end <= l.start) errors.push(`Line ${l.id}: end before start.`);
    // Authored propositions (optional). Normalized here so every renderer can trust the shape:
    // an empty or malformed list becomes no list at all, which is the same file as one that never
    // had propositions — leavesOfLine then falls back to the line with no special case.
    if ('props' in l) {
      if (!Array.isArray(l.props)) { errors.push(`Line ${l.id}: props must be a list.`); continue; }
      const seen = new Set();
      const kept = [];
      for (const p of l.props) {
        if (!p || typeof p !== 'object') { errors.push(`Line ${l.id}: a proposition is not an object.`); continue; }
        const pid = String(p.id || '');
        if (!pid) { errors.push(`Line ${l.id}: a proposition has no id.`); continue; }
        if (seen.has(pid)) { errors.push(`Line ${l.id}: duplicate proposition id ${pid}.`); continue; }
        seen.add(pid);
        const q = { id: pid, text: String(p.text ?? '') };
        if (p.implicit) q.implicit = true;
        kept.push(q);
      }
      if (kept.length) l.props = kept; else delete l.props;
    }
  }
  for (const g of data.tree) {
    if (!g.id || ids.has(g.id)) errors.push(`Group id ${g.id || '(missing)'} duplicate or missing.`);
    ids.add(g.id);
  }
  const seenChild = new Set();
  for (const g of data.tree) {
    if (!Array.isArray(g.children) || g.children.length < 2) errors.push(`Group ${g.id}: needs 2+ children.`);
    for (const c of g.children || []) {
      if (!ids.has(c)) errors.push(`Group ${g.id}: unknown child ${c}.`);
      if (seenChild.has(c)) errors.push(`Unit ${c} has two parents.`);
      seenChild.add(c);
    }
    if (g.joinType !== 'sym' && g.joinType !== 'asym') errors.push(`Group ${g.id}: joinType must be sym|asym.`);
    if (g.joinType === 'asym' && !(g.children || []).includes(g.head)) errors.push(`Group ${g.id}: asym needs a head from its children.`);
    if (g.joinType === 'sym' && g.head) errors.push(`Group ${g.id}: sym groups have no head.`);
    // Member labels: optional, but when present every key must be a member of THIS group.
    if (g.labels !== undefined && g.labels !== null) {
      if (typeof g.labels !== 'object' || Array.isArray(g.labels)) {
        errors.push(`Group ${g.id}: labels must be an object keyed by member id.`);
      } else {
        const kept = {};
        for (const [k, v] of Object.entries(g.labels)) {
          if (!(g.children || []).includes(k)) { errors.push(`Group ${g.id}: label for ${k}, which is not one of its members.`); continue; }
          const s = String(v ?? '').trim();
          if (s) kept[k] = s;
        }
        if (Object.keys(kept).length) g.labels = kept; else delete g.labels;
      }
    } else if ('labels' in g) delete g.labels;
  }
  data.view.collapsed = data.view.collapsed.filter((id) => data.tree.some((g) => g.id === id));
  return errors.length ? { ok: false, errors } : { ok: true, data };
}

export function serializeFxpa(data) {
  return JSON.stringify(data);
}

/* ---------------- authored documents (built in the app, not imported) ----------------
 *
 * Seth, 2026-08-05: a user may build a diagram from scratch out of typed propositions — but
 * explicitly NOT edit imported language data. `authored: true` on the document is what enforces
 * that: the editing operations below refuse to run on anything else, so an imported text's words,
 * glosses, speakers and time spans can never be altered by this path. Text is sacred, as in the
 * segmentation engine; here there simply is no imported text to protect.
 *
 * An authored document is otherwise an ordinary .fxpa — no audio, lines with no words and no
 * times — so grouping, labels, collapse and every export work on it unchanged. */

export function newAuthoredDoc(title = '') {
  return {
    format: FXPA_FORMAT, version: FXPA_VERSION, title, vernLang: 'und', analLang: 'en',
    authored: true,
    lines: [{ id: 'L1', baseline: '', words: [] }],
    tree: [],
    view: { layer: 'baseline', free: false, audio: false, waves: 'off', collapsed: [], hideBlank: false },
  };
}

const requireAuthored = (data) => {
  if (!data.authored) throw new Error('This text was imported — its wording cannot be edited here.');
};

const nextLineId = (data) => {
  let n = data.lines.length + 1;
  const taken = new Set(data.lines.map((l) => l.id));
  while (taken.has('L' + n)) n++;
  return 'L' + n;
};

// Insert a new empty line AFTER `afterId` (or at the end). A new line is always parentless: it
// joins no group, because dropping it into one would silently change that grouping's meaning.
export function addLine(data, afterId = null, text = '') {
  requireAuthored(data);
  const line = { id: nextLineId(data), baseline: String(text || ''), words: [] };
  const at = afterId ? data.lines.findIndex((l) => l.id === afterId) : data.lines.length - 1;
  const lines = [...data.lines];
  lines.splice(at < 0 ? lines.length : at + 1, 0, line);
  return { ...data, lines, _added: line.id };
}

export function setLineText(data, id, text) {
  requireAuthored(data);
  if (!data.lines.some((l) => l.id === id)) throw new Error('No such line.');
  return { ...data, lines: data.lines.map((l) => (l.id === id ? { ...l, baseline: String(text ?? '') } : l)) };
}

/* Delete a line, and keep the TREE valid: pull it out of any group, then dissolve any group left
 * with fewer than two children (cascading upward), promoting the survivor to the parent. Without
 * this a delete leaves one-child groups, which validateFxpa rejects — the file would refuse to
 * reopen after an edit that appeared to work. */
export function deleteLine(data, id) {
  requireAuthored(data);
  if (data.lines.length <= 1) throw new Error('A text needs at least one line.');
  let tree = data.tree.map((g) => ({ ...g, children: g.children.filter((c) => c !== id) }));
  const lines = data.lines.filter((l) => l.id !== id);

  let changed = true;
  while (changed) {
    changed = false;
    for (const g of [...tree]) {
      if (g.children.length >= 2) continue;
      const survivor = g.children[0] || null;
      tree = tree.filter((x) => x.id !== g.id)
        .map((x) => ({ ...x, children: x.children.flatMap((c) => (c === g.id ? (survivor ? [survivor] : []) : [c])) }));
      changed = true;
      break;
    }
  }
  // A head that was deleted (or promoted away) must not dangle.
  tree = tree.map((g) => {
    if (g.joinType !== 'asym' || g.children.includes(g.head)) return g;
    return { ...g, head: g.children[0] };
  });
  const collapsed = (data.view.collapsed || []).filter((c) => tree.some((g) => g.id === c));
  return { ...data, lines, tree, view: { ...data.view, collapsed } };
}

/* ---------------- lookup / order ---------------- */

export const isGroupId = (id) => /^G\d+$/.test(String(id));

export function nodeById(data, id) {
  return isGroupId(id) ? data.tree.find((g) => g.id === id) || null
                       : data.lines.find((l) => l.id === id) || null;
}

export function parentOf(data, id) {
  return data.tree.find((g) => g.children.includes(id)) || null;
}

// Ordered leaf line ids under any unit (a line = itself).
export function leavesOf(data, id) {
  if (!isGroupId(id)) return [id];
  const g = nodeById(data, id);
  if (!g) return [];
  const out = [];
  for (const c of g.children) out.push(...leavesOf(data, c));
  const pos = new Map(data.lines.map((l, i) => [l.id, i]));
  return out.sort((a, b) => pos.get(a) - pos.get(b));
}

export function levelOf(data, id) {
  if (!isGroupId(id)) return 0;
  const g = nodeById(data, id);
  return g ? 1 + Math.max(...g.children.map((c) => levelOf(data, c))) : 0;
}

// The ordered sequence of PARENTLESS units (lines and top groups) — the groupable surface.
/* A BLANK line: no text of any kind. In segmentation these are real timed spans (usually silence)
 * and must never be destroyed — but for GROUPING they are noise, so the paragraph app hides them
 * (Seth, 2026-08-05). Hidden, never deleted: the .fxpa keeps them, the times stay exactly as they
 * were, and turning the setting off brings them straight back. */
export const isBlankLine = (l) =>
  !!l && !isGroupId(l.id) && !String(l.baseline || '').trim() && !String(l.free || '').trim()
  && !(l.words || []).some((w) => String(w.txt || '').trim());

// The units a hidden-blank view would show, in order.
export function visibleTopUnits(data, hideBlank) {
  const units = topUnits(data);
  if (!hideBlank) return units;
  return units.filter((id) => isGroupId(id) || !isBlankLine(nodeById(data, id)));
}

/* Grouping needs CONTIGUOUS units, but a hidden blank sitting between two visible ones would make
 * them "non-adjacent" and the group would be refused for a reason the user cannot see. So the
 * selection absorbs any hidden blanks that fall between its own ends — the group stays contiguous
 * in the model and the silence simply comes along, which is what it is anyway. */
export function withBlanksBetween(data, ids, hideBlank) {
  if (!hideBlank || !Array.isArray(ids) || ids.length < 2) return ids;
  const top = topUnits(data);
  const idx = ids.map((id) => top.indexOf(id)).filter((i) => i >= 0);
  if (!idx.length) return ids;
  const lo = Math.min(...idx), hi = Math.max(...idx);
  const out = [...ids];
  for (let i = lo; i <= hi; i++) {
    const id = top[i];
    if (out.includes(id)) continue;
    if (!isGroupId(id) && isBlankLine(nodeById(data, id))) out.push(id);   // only blanks, never real content
  }
  return out;
}

export function topUnits(data) {
  const pos = new Map(data.lines.map((l, i) => [l.id, i]));
  const units = [];
  for (const l of data.lines) if (!parentOf(data, l.id)) units.push(l.id);
  for (const g of data.tree) if (!parentOf(data, g.id)) units.push(g.id);
  return units.sort((a, b) => pos.get(leavesOf(data, a)[0]) - pos.get(leavesOf(data, b)[0]));
}

// Aggregate time span of a unit's leaves — null when nothing under it is aligned.
export function spanOf(data, id) {
  let start = null, end = null;
  for (const lid of leavesOf(data, id)) {
    const l = nodeById(data, lid);
    if (l && typeof l.start === 'number' && typeof l.end === 'number') {
      start = start === null ? l.start : Math.min(start, l.start);
      end = end === null ? l.end : Math.max(end, l.end);
    }
  }
  return start === null ? null : { start, end };
}

/* ---------------- collapse summaries (Seth's rules, 2026-08-05) ----------------
 * Collapsed rendering is FREE-TRANSLATION-ONLY: an asym group summarizes as its HEAD's free
 * translation (recursively — a group head summarizes by ITS head); a sym group summarizes as one
 * compact line per member. A unit with no free translation falls back to its baseline. */

export function summaryLineOf(data, id) {
  if (!isGroupId(id)) {
    const l = nodeById(data, id);
    return l ? (l.free || l.baseline || '') : '';
  }
  const g = nodeById(data, id);
  if (!g) return '';
  if (g.joinType === 'asym') return summaryLineOf(data, g.head);
  return g.children.map((c) => summaryLineOf(data, c)).filter((s) => s.trim()).join('  ·  ');
}

/* ⚠ A MEMBER WITH NOTHING TO SAY CONTRIBUTES NOTHING (Seth, 2026-08-05: "FLEx can definitely do
 * some funny things with blank lines and line numbering — our app should be able to handle that
 * without troubling the user"). Blank lines are real timed spans and stay in the tree, but a
 * summary entry for one is empty by definition, so listing it just puts a stray placeholder row
 * (or a doubled ' · ' separator) where the user sees no line at all. Dropping empties is safe
 * whatever the hide-blanks setting is, because there is no text either way. */
export function summaryOf(data, id) {
  const g = nodeById(data, id);
  if (!g || !isGroupId(id)) return [summaryLineOf(data, id)];
  if (g.joinType === 'asym') return [summaryLineOf(data, g.head)];
  const lines = g.children.map((c) => summaryLineOf(data, c)).filter((s) => s.trim());
  return lines.length ? lines : [''];      // all-blank group: ONE placeholder, not one per member
}

/* ---------------- mutations (throw on invariant violation) ---------------- */

function nextGroupId(data) {
  let n = 0;
  for (const g of data.tree) { const m = /^G(\d+)$/.exec(g.id); if (m) n = Math.max(n, +m[1]); }
  return 'G' + (n + 1);
}

// Member labels → a clean object, or null when nothing is labelled. Every key must be a member
// of the group; blank values are dropped so "unlabelled" is absent, never an empty string.
function cleanLabels(children, labels) {
  if (labels == null) return null;
  if (typeof labels !== 'object' || Array.isArray(labels)) throw new Error('Member labels must be an object.');
  const out = {};
  for (const [k, v] of Object.entries(labels)) {
    if (!children.includes(k)) throw new Error('A label was given for a unit that is not in this group.');
    const s = String(v ?? '').trim();
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

// The DEFAULT join: create a grouping node over 2+ adjacent parentless units. Never touches
// lines, audio, or text — grouping is metadata by construction. Both kinds of label are
// OPTIONAL: `relation` on the group, `labels` on its members, either, both, or neither.
export function groupUnits(data, ids, { joinType, head, relation = '', labels = null } = {}) {
  if (!Array.isArray(ids) || ids.length < 2) throw new Error('Select at least two units to group.');
  for (const id of ids) {
    if (!nodeById(data, id)) throw new Error(`Unknown unit ${id}.`);
    if (parentOf(data, id)) throw new Error('A selected unit is already inside a group — ungroup it first.');
  }
  const top = topUnits(data);
  const idx = ids.map((id) => top.indexOf(id)).sort((a, b) => a - b);
  for (let k = 1; k < idx.length; k++) {
    if (idx[k] !== idx[k - 1] + 1) throw new Error('Units must be adjacent to group.');
  }
  if (joinType !== 'sym' && joinType !== 'asym') throw new Error('Choose symmetrical or asymmetrical.');
  if (joinType === 'asym' && !ids.includes(head)) throw new Error('An asymmetrical join needs one of its members as HEAD.');
  if (joinType === 'sym' && head) throw new Error('A symmetrical join has no head.');
  const ordered = idx.map((i) => top[i]);
  const lab = cleanLabels(ordered, labels);
  const g = { id: nextGroupId(data), children: ordered, joinType, relation: String(relation || '').trim() };
  if (joinType === 'asym') g.head = head;
  if (lab) g.labels = lab;
  g.level = 1 + Math.max(...ordered.map((c) => levelOf(data, c)));
  return { ...data, tree: [...data.tree, g] };
}

export function ungroup(data, gid) {
  const g = nodeById(data, gid);
  if (!g || !isGroupId(gid)) throw new Error('Not a group.');
  if (parentOf(data, gid)) throw new Error('Ungroup its parent first (dissolve top-down).');
  return {
    ...data,
    tree: data.tree.filter((x) => x.id !== gid),
    view: { ...data.view, collapsed: (data.view.collapsed || []).filter((id) => id !== gid) },
  };
}

export function editGroup(data, gid, patch = {}) {
  const g = nodeById(data, gid);
  if (!g || !isGroupId(gid)) throw new Error('Not a group.');
  const next = { ...g, ...patch };
  if (next.joinType !== 'sym' && next.joinType !== 'asym') throw new Error('joinType must be sym|asym.');
  if (next.joinType === 'asym' && !g.children.includes(next.head)) throw new Error('HEAD must be one of the group\'s members.');
  if (next.joinType === 'sym') delete next.head;
  if ('relation' in patch) next.relation = String(patch.relation ?? '').trim();
  if ('labels' in patch) {
    const lab = cleanLabels(g.children, patch.labels);
    if (lab) next.labels = lab; else delete next.labels;   // clearing every label removes the key
  }
  return { ...data, tree: data.tree.map((x) => (x.id === gid ? next : x)) };
}

/* Collapse or expand a WHOLE SUBTREE in one action (Seth, 2026-08-05). With no roots it acts on
 * the entire document; with roots — a selection — it acts on those groups AND every group beneath
 * them, which is the point: collapsing a group alone would leave its descendants expanded
 * underneath, so re-expanding it later would dump the full depth back on the screen.
 * A LINE among the roots contributes nothing (it has no collapse state) rather than erroring —
 * a mixed selection should still do the sensible thing to the groups in it. */
export function setCollapsedAll(data, collapsed, roots = null) {
  const known = new Set(data.tree.map((g) => g.id));
  let target;
  if (!roots || !roots.length) {
    target = [...known];
  } else {
    const seen = new Set();
    const walk = (id) => {
      if (!isGroupId(id) || seen.has(id) || !known.has(id)) return;
      seen.add(id);
      const g = nodeById(data, id);
      for (const c of (g ? g.children : [])) walk(c);
    };
    for (const id of roots) walk(id);
    target = [...seen];
  }
  const set = new Set((data.view.collapsed || []).filter((id) => known.has(id)));
  for (const id of target) { if (collapsed) set.add(id); else set.delete(id); }
  return { ...data, view: { ...data.view, collapsed: [...set] } };
}

/* ---------------- authored propositions (SSA is semantic, not grammatical) ----------------
 *
 * Seth, 2026-08-05: "SSA is semantic, rather than grammatical analysis, which at times requires us
 * to split up segments into component semantic propositions... add virtual daughter leaves to
 * segments that would be just text boxes where the user could type in component semantic
 * propositions of that segment."
 *
 * They live INSIDE the line, because THE LINE OWNS THE AUDIO SPAN. A proposition has no time of
 * its own — it inherits its line's — which is also why playback highlights lines and never
 * propositions: several propositions under one span would all light up at once, meaning nothing.
 *
 * This is NOT text editing of imported data. A proposition is new authored content sitting beside
 * the record; the line's baseline, words, glosses and free translation are never touched, so the
 * "imported wording is sacred" rule holds exactly as before — which is what makes this safe to
 * offer on any document rather than only on authored ones.
 *
 * `implicit` marks a proposition that is implied rather than stated — bracketed by convention when
 * displayed (a setting, default on). */
const propsOf = (line) => (Array.isArray(line.props) ? line.props : []);

function withLine(data, lineId, fn) {
  const i = data.lines.findIndex((l) => l.id === lineId);
  if (i < 0) throw new Error(`Unknown line ${lineId}.`);
  const lines = data.lines.slice();
  lines[i] = fn(lines[i]);
  return { ...data, lines };
}

export function addProp(data, lineId, text = '', opts = {}) {
  return withLine(data, lineId, (l) => {
    const props = propsOf(l);
    // Ids are unique WITHIN the line and never reused, so a reference cannot silently re-point.
    let n = props.length + 1;
    while (props.some((p) => p.id === `${lineId}p${n}`)) n++;
    const p = { id: `${lineId}p${n}`, text: String(text || '') };
    if (opts.implicit) p.implicit = true;
    const at = Number.isInteger(opts.index) ? Math.max(0, Math.min(props.length, opts.index)) : props.length;
    return { ...l, props: [...props.slice(0, at), p, ...props.slice(at)] };
  });
}

export function setPropText(data, lineId, propId, text) {
  return withLine(data, lineId, (l) => ({
    ...l, props: propsOf(l).map((p) => (p.id === propId ? { ...p, text: String(text ?? '') } : p)),
  }));
}

export function setPropImplicit(data, lineId, propId, implicit) {
  return withLine(data, lineId, (l) => ({
    ...l,
    props: propsOf(l).map((p) => {
      if (p.id !== propId) return p;
      const q = { ...p };
      if (implicit) q.implicit = true; else delete q.implicit;
      return q;
    }),
  }));
}

/* Removing the LAST proposition drops the `props` key entirely, so the line goes back to being one
 * leaf — the file is then byte-identical in shape to one that never had propositions, and every
 * renderer's `leavesOfLine` falls back without a special case. */
export function deleteProp(data, lineId, propId) {
  return withLine(data, lineId, (l) => {
    const rest = propsOf(l).filter((p) => p.id !== propId);
    if (rest.length) return { ...l, props: rest };
    const q = { ...l };
    delete q.props;
    return q;
  });
}

export function toggleCollapse(data, gid) {
  if (!nodeById(data, gid) || !isGroupId(gid)) throw new Error('Not a group.');
  const collapsed = new Set(data.view.collapsed || []);
  if (collapsed.has(gid)) collapsed.delete(gid); else collapsed.add(gid);
  return { ...data, view: { ...data.view, collapsed: [...collapsed] } };
}
