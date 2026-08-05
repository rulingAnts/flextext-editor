/* paragraph-model.js — the Paragraph Analysis data model: .fxpa parse/validate/serialize and the
 * grouping-tree operations with their invariants.
 *
 * FORMAT-MODULE RULES (CLAUDE.md): imports nothing but other format modules — no DOM, no
 * settings, no IndexedDB, no i18n. Everything here runs under plain node
 * (test/paragraph-model.test.mjs is the enforcement).
 *
 * THE MODEL OWNS THE INVARIANTS (same doctrine as segments.js): every tree mutation routes
 * through here and either returns a valid new state or throws with a human-readable message.
 * Invariants: units group only when ADJACENT and under the SAME PARENT (so trees may be built
 * top-down or bottom-up, and a sub-level can be changed without dismantling the rest); every unit
 * has at most one parent; a group's level is DERIVED as 1 + max(child levels) and never stored; joinType is
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
  // `level` is DERIVED (see stripDerived) — drop it from any file that still carries the stale copy.
  data.tree = Array.isArray(obj.tree) ? obj.tree.map((g) => stripDerived({ ...g, children: [...(g.children || [])] })) : [];
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
  // Every proposition id in the document — group children may reference these as well as lines.
  const propIds = new Set();
  for (const l of data.lines) for (const pr of (l.props || [])) propIds.add(pr.id);
  const seenChild = new Set();
  for (const g of data.tree) {
    if (!Array.isArray(g.children) || g.children.length < 2) errors.push(`Group ${g.id}: needs 2+ children.`);
    for (const c of g.children || []) {
      const known = ids.has(c) || (isPropId(c) && propIds.has(c));
      if (!known) errors.push(`Group ${g.id}: unknown child ${c}.`);
      if (seenChild.has(c)) errors.push(`Unit ${c} has two parents.`);
      seenChild.add(c);
    }
    /* No same-line rule any more (Seth, 2026-08-05): propositions and lines share ONE surface, so a
     * group may hold a proposition beside a proposition from the next line, or beside a whole
     * line. What still cannot happen is a crossing bracket — and that is guaranteed by adjacency
     * plus single-parent, which are checked above and in groupUnits, not here. */
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
/* A line of a FROM-SCRATCH chart can be marked implicit, exactly like a proposition — because in a
 * blank chart every line IS a proposition (Seth, 2026-08-05: "we want an implicit/explicit toggle
 * for each line, but not for actual language data lines in imported-interlinear-text-based
 * charts"). Hence the authored gate: a recorded line is a thing someone said, and "implied" is not
 * a claim you can make about it — the claim belongs to a proposition written UNDER it. */
export function setLineImplicit(data, id, implicit) {
  requireAuthored(data);
  const i = data.lines.findIndex((l) => l.id === id);
  if (i < 0) throw new Error(`Unknown line ${id}.`);
  const lines = data.lines.slice();
  const l = { ...lines[i] };
  if (implicit) l.implicit = true; else delete l.implicit;
  lines[i] = l;
  return { ...data, lines };
}

/* SPLIT A TEXT LINE AT THE CURSOR (Seth, 2026-08-05: "If you press enter in the middle of a line,
 * it should split it at the cursor's place"). Authored documents only — this is the from-scratch
 * diagram, where a "line" IS a proposition someone typed, so splitting one is just editing text.
 *
 * ⚠ NOT the same thing as splitting an audio-segmented line, which is a separate feature and is
 * deliberately harder: that one has to place a boundary in the AUDIO, which must be observed at
 * the playhead and never computed. Here there is no audio to divide.
 *
 * The new line inherits nothing but the tail of the text: no implicit flag, no propositions.
 * Returns the document with `_added` naming the new line, so the caller can put the cursor in it. */
export function splitLine(data, id, at) {
  requireAuthored(data);
  const i = data.lines.findIndex((l) => l.id === id);
  if (i < 0) throw new Error(`Unknown line ${id}.`);
  const text = String(data.lines[i].baseline || '');
  const cut = Math.max(0, Math.min(text.length, Number(at) || 0));
  const head = text.slice(0, cut).replace(/\s+$/, '');
  const tail = text.slice(cut).replace(/^\s+/, '');
  const newId = nextLineId(data);
  const lines = data.lines.slice();
  lines[i] = { ...lines[i], baseline: head };
  lines.splice(i + 1, 0, { id: newId, baseline: tail, words: [] });
  /* ⚠ THE NEW LINE MUST JOIN ITS SIBLING'S GROUP, or a split inside a bracket would silently drop
   * half the text out of the analysis. It goes in immediately after the line it came from, so the
   * run stays contiguous and the bracket still covers everything it did before. */
  const tree = data.tree.map((g) => {
    const k = g.children.indexOf(id);
    if (k < 0) return g;
    const children = g.children.slice();
    children.splice(k + 1, 0, newId);
    return { ...g, children };
  });
  return { ...data, lines, tree, _added: newId };
}

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

/* ---------------- PROPOSITIONS AS TREE UNITS ----------------
 *
 * Seth, 2026-08-05: "I need to be able to apply groupings to semantic component propositions. They
 * need to function as leaves on the tree for the diagram, but not as independent audio segments."
 * And on where they may group: "beneath the level of the raw phonetic data."
 *
 * So a proposition is a first-class unit of the tree — groupable, sub-groupable, able to carry a
 * role and to sit in a group with a relation — with ONE structural restriction: **a group may not
 * mix propositions from different lines, nor mix propositions with lines.** A proposition belongs
 * to the line that owns the audio span; letting one group across lines would assert a structure
 * above the level it lives at, and would make `spanOf` meaningless.
 *
 * That restriction is what keeps "not independent audio segments" true by construction: a
 * proposition has no time of its own, it inherits its line's, and playback only ever addresses
 * lines. Nothing about grouping changes that.
 *
 * Ids are `<lineId>p<n>` (minted by addProp), so a proposition names its own line. */
/* ⚠ `level` IS DERIVED, NEVER STORED (Seth, 2026-08-06): "we want to avoid storing things and
 * keeping two separate parallel copies of information or structure that trust our app/code to keep
 * them in sync. That's always a less preferable design whenever possible."
 *
 * It used to be written onto each group at creation and then went stale the moment anything nested
 * — the group's depth changed but the field did not. Nothing ever read it (levelOf() recurses over
 * the tree), so it was pure drift waiting to mislead. Old files are stripped on load.
 *
 * ⚠ The counter-case, so this is not over-applied: audio times ARE stored, because they are
 * OBSERVED, not derivable. "Never invent a time" is the segmentation engine's absolute rule. Derive
 * what can be derived; store what was measured. */
export const stripDerived = (g) => { const { level, ...rest } = g; return rest; };

export const isPropId = (id) => /^L\d+p\d+$/.test(String(id));
export const lineOfPropId = (id) => String(id).split('p')[0];

const propById = (data, id) => {
  const line = data.lines.find((l) => l.id === lineOfPropId(id));
  return (line && (line.props || []).find((p) => p.id === id)) || null;
};

export function nodeById(data, id) {
  if (isGroupId(id)) return data.tree.find((g) => g.id === id) || null;
  if (isPropId(id)) return propById(data, id);
  return data.lines.find((l) => l.id === id) || null;
}

/* A proposition's parent is a GROUP when one holds it, otherwise its LINE — which is implicit,
 * never written in the tree. Returning the line here would make every caller that expects a group
 * wrong, so the line case is reported separately by `ownerLineOf`. */
export function parentOf(data, id) {
  return data.tree.find((g) => g.children.includes(id)) || null;
}

// The line a unit ultimately sits under, or null for units at the document level.
export function ownerLineOf(data, id) {
  if (isPropId(id)) return lineOfPropId(id);
  if (isGroupId(id)) {
    const g = nodeById(data, id);
    return g && g.children.length ? ownerLineOf(data, g.children[0]) : null;
  }
  return null;                        // a LINE is not inside a line
}

// Ordered LEAF ids under any unit: line ids, or proposition ids where a line has been split.
export function leavesOf(data, id) {
  if (!isGroupId(id)) return [id];
  const g = nodeById(data, id);
  if (!g) return [];
  const out = [];
  for (const c of g.children) out.push(...leavesOf(data, c));
  return out.sort((a, b) => orderIndex(data, a) - orderIndex(data, b));
}

/* One ordering for every kind of unit: line position, then proposition position within the line.
 * Adjacency, sorting and "is this a single unbroken run" all read from this, so there is exactly
 * one definition of what comes before what. */
export function orderIndex(data, id) {
  const lineId = isPropId(id) ? lineOfPropId(id) : id;
  const li = data.lines.findIndex((l) => l.id === lineId);
  if (li < 0) return -1;
  if (!isPropId(id)) return li * 1000;
  const line = data.lines[li];
  const pi = (line.props || []).findIndex((p) => p.id === id);
  return li * 1000 + (pi < 0 ? 0 : pi + 1);
}

/* The units at a LINE's proposition level: its propositions, with any that are inside a group
 * replaced by that group — the same "surface" idea as topUnits, one level down. */
export function propUnits(data, lineId) {
  const line = data.lines.find((l) => l.id === lineId);
  if (!line || !(line.props || []).length) return [];
  const out = [];
  const seen = new Set();
  for (const p of line.props) {
    let top = p.id;
    for (let par = parentOf(data, top); par; par = parentOf(data, top)) top = par.id;
    if (!seen.has(top)) { seen.add(top); out.push(top); }
  }
  return out;
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
/* "Is this a hidden blank line?" may only be asked about LINES. A GROUP has no baseline, and
 * neither does a PROPOSITION — so asking isBlankLine about either returns TRUE and silently
 * removes it (Seth, having been bitten once in the UI: "Do remember the isBlankLine() fix in the
 * redo"). Every filter goes through this instead. */
export const isHiddenBlankUnit = (data, id) =>
  !isGroupId(id) && !isPropId(id) && isBlankLine(nodeById(data, id));

export const isBlankLine = (l) =>
  !!l && !isGroupId(l.id) && !String(l.baseline || '').trim() && !String(l.free || '').trim()
  && !(l.words || []).some((w) => String(w.txt || '').trim());

// The units a hidden-blank view would show, in order.
export function visibleTopUnits(data, hideBlank) {
  const units = topUnits(data);
  if (!hideBlank) return units;
  return units.filter((id) => !isHiddenBlankUnit(data, id));
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
    if (isHiddenBlankUnit(data, id)) out.push(id);   // only blanks, never real content
  }
  return out;
}

/* ⚠ ONE FLAT SURFACE (Seth, 2026-08-05, replacing the per-line surfaces of v205): "we do need to
 * be able to group a proposition with another line (or an adjacent proposition from another
 * line)". He is right linguistically — audio segmentation is a recording artifact and semantic
 * structure has no obligation to respect it.
 *
 * So the document has ONE ordered leaf sequence: each line contributes ITSELF when it has no
 * written propositions, or ITS PROPOSITIONS when it has them. Groups form over any adjacent run of
 * that sequence, whatever line the members came from. Brackets still cannot cross — adjacency plus
 * single-parent does that work, exactly as before.
 *
 * A line with propositions is therefore no longer a tree unit. It remains a HEADER: it owns the
 * audio span, the waveform and the playback, which is why nothing about playback changes. */
export function topUnits(data) {
  const units = [];
  for (const l of data.lines) {
    /* ⚠ ALL propositions, including EMPTY ones. A proposition the analyst has just added has no
     * text yet, and if the surface excluded it the editor would render nothing — "+ proposition"
     * would appear to do nothing at all (Seth, 2026-08-05). Blank ones are skipped when DRAWING a
     * diagram, which is a rendering decision, not a question about what exists. */
    const props = l.props || [];
    if (!props.length) { if (!parentOf(data, l.id)) units.push(l.id); continue; }
    for (const pr of props) if (!parentOf(data, pr.id)) units.push(pr.id);
  }
  for (const g of data.tree) if (!parentOf(data, g.id)) units.push(g.id);
  return units.sort((a, b) => orderIndex(data, leavesOf(data, a)[0]) - orderIndex(data, leavesOf(data, b)[0]));
}

// Aggregate time span of a unit's leaves — null when nothing under it is aligned.
/* ⚠ A PROPOSITION HAS NO TIME OF ITS OWN — it inherits its line's span, which is what "not
 * independent audio segments" means in the data rather than only in the UI. Grouping propositions
 * therefore cannot invent, narrow or widen any span. */
export function spanOf(data, id) {
  let start = null, end = null;
  for (const leaf of leavesOf(data, id)) {
    const lid = isPropId(leaf) ? lineOfPropId(leaf) : leaf;
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
  if (isPropId(id)) {
    const p = nodeById(data, id);
    return p ? String(p.text || '') : '';
  }
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
  for (const id of ids) if (!nodeById(data, id)) throw new Error(`Unknown unit ${id}.`);

  /* ⚠ SUB-GROUPING IS ALLOWED. This used to refuse any unit that already had a parent —
   * "already inside a group, ungroup it first" — which made nesting impossible and forced the
   * researcher to dismantle a hierarchy to change any part of it. Seth, 2026-08-06: "We should be
   * able to work from the top down… or the bottom up… without having to dismantle and redo the
   * entire hierarchy. And we REALLY don't want our model to have that constraint."
   *
   * What IS still required is a single parent: every selected unit must sit at the SAME level, so
   * grouping is a local edit to one parent's children. Grouping across two different groups would
   * have to steal children from one and give them to another, which is not a sub-grouping at all —
   * it is a re-parenting, and it would break the single-parent invariant the tree depends on. */
  const parents = ids.map((id) => parentOf(data, id));
  if (new Set(parents.map((p) => (p ? p.id : ''))).size > 1) {
    throw new Error('Those units are in different groups — group units that sit side by side at the same level.');
  }
  const parent = parents[0] || null;
  // Adjacency is judged among SIBLINGS: the parent's own children, or the top surface.
  const siblings = parent ? parent.children : topUnits(data);
  const idx = ids.map((id) => siblings.indexOf(id)).sort((a, b) => a - b);
  if (idx[0] < 0) throw new Error('Those units are not all at the same level.');
  for (let k = 1; k < idx.length; k++) {
    if (idx[k] !== idx[k - 1] + 1) throw new Error('Units must be adjacent to group.');
  }
  if (joinType !== 'sym' && joinType !== 'asym') throw new Error('Choose symmetrical or asymmetrical.');
  if (joinType === 'asym' && !ids.includes(head)) throw new Error('An asymmetrical join needs one of its members as HEAD.');
  if (joinType === 'sym' && head) throw new Error('A symmetrical join has no head.');
  const ordered = idx.map((i) => siblings[i]);
  const lab = cleanLabels(ordered, labels);
  const g = { id: nextGroupId(data), children: ordered, joinType, relation: String(relation || '').trim() };
  if (joinType === 'asym') g.head = head;
  if (lab) g.labels = lab;
  if (!parent) return { ...data, tree: [...data.tree, g] };

  /* The new group TAKES THE RUN'S PLACE among its parent's children, so order is preserved and the
   * parent keeps exactly the same span. Two details that are wrong if forgotten:
   *  - an asymmetrical parent whose HEAD was one of the absorbed children must now point at the new
   *    group, or it is left naming a child it no longer has;
   *  - the parent's labels for absorbed children no longer address anything, so they are dropped —
   *    the same healing pruneTree does. */
  const first = idx[0], last = idx[idx.length - 1];
  const tree = [...data.tree, g].map((x) => {
    if (x.id !== parent.id) return x;
    const children = [...x.children.slice(0, first), g.id, ...x.children.slice(last + 1)];
    const y = { ...x, children };
    if (y.joinType === 'asym' && ordered.includes(y.head)) y.head = g.id;
    if (y.labels) {
      const kept = {};
      for (const [k, v] of Object.entries(y.labels)) if (children.includes(k)) kept[k] = v;
      if (Object.keys(kept).length) y.labels = kept; else delete y.labels;
    }
    return y;
  });
  return { ...data, tree };
}

export function ungroup(data, gid) {
  const g = nodeById(data, gid);
  if (!g || !isGroupId(gid)) throw new Error('Not a group.');

  /* ⚠ A NESTED GROUP MAY BE DISSOLVED IN PLACE. This used to refuse any group that had a parent —
   * "Ungroup its parent first (dissolve top-down)" — which meant unwinding had to start at the
   * outermost group, so changing one nested join cost the whole hierarchy above it (Seth,
   * 2026-08-06: "It appears to mean that I can only ungroup if I start all the way at the top. And
   * I definitely don't want that to be the case.").
   *
   * The constraint existed because deleting a nested group from `tree` alone would leave its parent
   * still naming it in `children` — a dangling reference. That is a real hazard, but the answer is
   * to handle it, not to forbid the operation: the group's children take its place in the parent,
   * in order, so the parent keeps exactly the same span and nothing dangles. */
  const parent = parentOf(data, gid);
  const tree = data.tree.filter((x) => x.id !== gid).map((x) => {
    if (!parent || x.id !== parent.id) return x;
    const at = x.children.indexOf(gid);
    const children = [...x.children.slice(0, at), ...g.children, ...x.children.slice(at + 1)];
    const y = { ...x, children };
    /* An asymmetrical parent whose HEAD was this group must name a surviving child instead — and
     * the right one is the DISSOLVED GROUP'S OWN HEAD when it had one. Prominence was asserted at
     * both levels: "the head of the head" is still the most prominent surviving unit, whereas
     * defaulting to the first grandchild silently relocates prominence to whatever happened to come
     * first. Only when the dissolved group was symmetrical (no head to inherit) is the first child
     * a genuine choice rather than a guess.
     *
     * ⚠ REVISIT WHEN MULTIPLE HEADS LAND (backlog: "Multiple HEADs in a group"). With 2+ heads this
     * inheritance must decide whether they all become the parent's heads or only one does — a
     * semantic question, not a mechanical one. Today it cannot arise: exactly one head on an
     * asymmetrical join, none on a symmetrical one, enforced in groupUnits.
     *
     * Seth's two options for then (2026-08-06), both viable:
     *   (1) ALLOW MULTIPLE HEADS — a to-do anyway, and then the grandchildren's heads simply all
     *       become the parent's heads. Nothing is lost and no choice has to be invented.
     *   (2) AUTO-DEMOTE to non-head when inheriting grandchildren — safe and predictable, but note
     *       it is not free TODAY: an asymmetrical group REQUIRES exactly one head, so demoting all
     *       of them would force the parent to become symmetrical, which changes the analyst's
     *       assertion about the join rather than just its members. Option 1 avoids that. */
    if (y.joinType === 'asym' && y.head === gid) {
      y.head = (g.joinType === 'asym' && g.head) ? g.head : g.children[0];
    }
    // A label addressed to the dissolved group no longer addresses anything.
    if (y.labels && gid in y.labels) {
      const { [gid]: _gone, ...rest } = y.labels;
      if (Object.keys(rest).length) y.labels = rest; else delete y.labels;
    }
    return y;
  });
  return {
    ...data,
    tree,
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

/* THE FREE TRANSLATION IS EDITABLE — and it is the ONLY imported field that is (Seth, 2026-08-05:
 * "not words, glosses, or splits yet, but the text of the free translation should be changeable").
 *
 * This is a deliberate, narrow exception to "imported wording is sacred", and it is narrow for a
 * reason: the free translation is the analyst's own rendering into the analysis language, not
 * observed language data. SSA states its propositions in that language, so a clumsy or missing
 * free translation is the one piece of an imported text the analysis genuinely needs to fix.
 * Baseline text, words, glosses, speakers and times remain untouchable, and there is still no way
 * to split or join a line.
 *
 * Deliberately NOT gated on `authored` — that gate exists to protect the vernacular record, and
 * this field is not part of it. */
/* The title is METADATA, not language data, so it is editable on any document — imported or not.
 * It is also what every save and export names the file after (Seth, 2026-08-05: "the filename at
 * the top should be editable, and then that will help with the save/download/export functionality
 * whenever a file picker save isn't an option"), which is why it matters that it can be corrected. */
export function setTitle(data, title) {
  return { ...data, title: String(title ?? '').trim() };
}

export function setLineFree(data, lineId, text) {
  const i = data.lines.findIndex((l) => l.id === lineId);
  if (i < 0) throw new Error(`Unknown line ${lineId}.`);
  const lines = data.lines.slice();
  const s = String(text ?? '');
  const l = { ...lines[i] };
  if (s.trim()) l.free = s; else delete l.free;     // cleared → absent, not an empty string
  lines[i] = l;
  return { ...data, lines };
}

/* WORDS AND GLOSSES ARE EDITABLE, AND A WORD CAN BE DELETED (Seth, 2026-08-05) — but a line can
 * still never be SPLIT or JOINED here, and that boundary is deliberate.
 *
 * Fixing a mistyped word or a wrong gloss is a correction WITHIN a line: nothing else in the
 * document depends on it. Splitting or joining lines is a different animal — it changes the unit
 * the grouping tree references AND it needs an audio boundary, which must be OBSERVED at the
 * playhead and never computed. That belongs in its own release; until then the user is pointed at
 * the FlexText editor or ELAN, which already do it properly.
 *
 * Deleting the last word does NOT delete the line: a line with no words still holds its time span,
 * its free translation and its place in the tree. Removing a line is `deleteLine`, and that is
 * still authored-documents-only.
 *
 * The baseline string is kept in step with the words, so the two never disagree — an edited word
 * that still showed the old spelling in the baseline view would be a silent lie about the data. */
const withWords = (data, lineId, fn) => {
  const i = data.lines.findIndex((l) => l.id === lineId);
  if (i < 0) throw new Error(`Unknown line ${lineId}.`);
  const lines = data.lines.slice();
  const words = fn((lines[i].words || []).slice());
  const line = { ...lines[i], words };
  // Rebuild the baseline from the words so the two views of the same line agree. A line that had
  // no words to begin with keeps whatever baseline it had — there is nothing to rebuild from.
  if ((lines[i].words || []).length) line.baseline = words.map((w) => w.txt || '').join(' ').replace(/\s+/g, ' ').trim();
  lines[i] = line;
  return { ...data, lines };
};

export function setWordText(data, lineId, index, text) {
  return withWords(data, lineId, (words) => {
    if (!words[index]) throw new Error('No such word.');
    const s = String(text ?? '').trim();
    if (!s) throw new Error('A word cannot be emptied — delete it instead.');
    words[index] = { ...words[index], txt: s };
    return words;
  });
}

export function setWordGloss(data, lineId, index, gloss) {
  return withWords(data, lineId, (words) => {
    if (!words[index]) throw new Error('No such word.');
    const w = { ...words[index] };
    const s = String(gloss ?? '').trim();
    if (s) { w.gls = s; delete w.punct; } else delete w.gls;   // cleared → absent, not empty
    words[index] = w;
    return words;
  });
}

export function deleteWord(data, lineId, index) {
  return withWords(data, lineId, (words) => {
    if (!words[index]) throw new Error('No such word.');
    words.splice(index, 1);
    return words;
  });
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

/* ⚠ WHEN A LINE GAINS PROPOSITIONS, THE PROPOSITIONS TAKE ITS PLACE IN THE TREE — not the line
 * (Seth, 2026-08-05: "if we create sub-propositions, the propositions, rather than the audio segment
 * line, are supposed to be what goes in the tree").
 *
 * topUnits() already did this substitution at TOP level but nothing did it INSIDE a group, so a
 * proposition added to an already-grouped line had no parent at all: it fell out of the group,
 * became a top-level unit, and rendered at the BOTTOM of the document instead of under its line.
 * Seth found it; the group's children still read ["L1"] while the surface had moved on to "L1p1".
 *
 * Substitution is positional: the first proposition replaces the line where the line sat, and later
 * ones are inserted immediately after their siblings, so grouping order never jumps around. */
export function addProp(data, lineId, text = '', opts = {}) {
  /* ⚠ "Is this line in a group?" must ask about the line OR ANY OF ITS EXISTING PROPOSITIONS.
   * After the first substitution the line is no longer in the tree — its proposition is — so a
   * lineId-only test says "not grouped" from the SECOND proposition onward, and every later one
   * silently escaped the group. Caught by the add-two-then-check test below. */
  /* Which ONE group does this line occupy? After the first substitution the line is no longer in
   * the tree — its proposition is — so ask about the line OR its existing propositions. */
  const existingProps = ((nodeById(data, lineId) || {}).props || []).map((x) => x.id);
  const holder = parentOf(data, lineId)
    || existingProps.map((id) => parentOf(data, id)).find(Boolean)
    || null;
  const out = withLine(data, lineId, (l) => {
    const props = propsOf(l);
    // Ids are unique WITHIN the line and never reused, so a reference cannot silently re-point.
    let n = props.length + 1;
    while (props.some((p) => p.id === `${lineId}p${n}`)) n++;
    const p = { id: `${lineId}p${n}`, text: String(text || '') };
    if (opts.implicit) p.implicit = true;
    const at = Number.isInteger(opts.index) ? Math.max(0, Math.min(props.length, opts.index)) : props.length;
    return { ...l, props: [...props.slice(0, at), p, ...props.slice(at)] };
  });

  if (!holder) return out;                         // top level: topUnits() already substitutes

  /* ⚠ EXACTLY ONE GROUP, and only the NEW id. v230 rebuilt every group that contained ANY of the
   * line's propositions and re-inserted the WHOLE list, so a line whose propositions had ended up in
   * two different groups got all of them duplicated into both — "propositions in somewhat random
   * places" (Seth, 2026-08-06). Deleting one then emptied both, pruneTree dissolved the groups, and
   * lines vanished from the view. Touch one group, insert one id. */
  const p = nodeById(out, lineId).props.find((x) => !existingProps.includes(x.id));
  return {
    ...out,
    tree: out.tree.map((g) => {
      if (g.id !== holder.id) return g;
      const lineAt = g.children.indexOf(lineId);
      if (lineAt >= 0) {                              // first proposition: it TAKES the line's slot
        const children = [...g.children];
        children[lineAt] = p.id;
        return { ...g, children };
      }
      // later ones: immediately after the last sibling of this line already in this group
      let last = -1;
      g.children.forEach((c, i) => { if (existingProps.includes(c)) last = i; });
      if (last < 0) return g;
      const children = [...g.children];
      children.splice(last + 1, 0, p.id);
      return { ...g, children };
    }),
  };
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
/* Deleting a proposition must REPAIR THE TREE, exactly as deleting a line does: pull it out of any
 * group, then dissolve a group left with fewer than two children (cascading), and repair a
 * dangling asymmetrical head. Without this, deleting one member of a pair leaves a one-child group
 * that validateFxpa rejects — so the file would refuse to reopen after an edit that looked fine. */
export function deleteProp(data, lineId, propId) {
  const next = withLine(data, lineId, (l) => {
    const rest = propsOf(l).filter((p) => p.id !== propId);
    if (rest.length) return { ...l, props: rest };
    const q = { ...l };
    delete q.props;
    return q;
  });
  /* ⚠ RESTORE THE LINE when its last proposition is deleted. The propositions took the line's slot
   * in the tree (see addProp); if they all go and nothing takes their place, the line silently
   * leaves the group it was grouped into. */
  const stillHasProps = ((nodeById(next, lineId) || {}).props || []).length > 0;
  const restored = stillHasProps ? next : {
    ...next,
    tree: next.tree.map((g) => {
      const at = g.children.indexOf(propId);
      if (at < 0) return g;
      const children = [...g.children]; children[at] = lineId;
      return { ...g, children };
    }),
  };
  return pruneTree(restored, propId);
}

/* Remove a unit from the tree and heal what that leaves behind. */
function pruneTree(data, goneId) {
  let tree = data.tree.map((g) => ({ ...g, children: g.children.filter((c) => c !== goneId) }));
  for (;;) {
    const thin = tree.find((g) => g.children.length < 2);
    if (!thin) break;
    const survivor = thin.children[0] || null;
    tree = tree.filter((g) => g.id !== thin.id).map((g) => ({
      ...g,
      children: g.children.flatMap((c) => (c === thin.id ? (survivor ? [survivor] : []) : [c])),
    }));
  }
  tree = tree.map((g) => {
    const h = { ...g };
    if (h.joinType === 'asym' && !h.children.includes(h.head)) h.head = h.children[0];
    if (h.labels) {
      const kept = {};
      for (const [k, v] of Object.entries(h.labels)) if (h.children.includes(k)) kept[k] = v;
      if (Object.keys(kept).length) h.labels = kept; else delete h.labels;
    }
    return h;
  });
  const live = new Set(tree.map((g) => g.id));
  return { ...data, tree, view: { ...data.view, collapsed: (data.view.collapsed || []).filter((id) => live.has(id)) } };
}

export function toggleCollapse(data, gid) {
  if (!nodeById(data, gid) || !isGroupId(gid)) throw new Error('Not a group.');
  const collapsed = new Set(data.view.collapsed || []);
  if (collapsed.has(gid)) collapsed.delete(gid); else collapsed.add(gid);
  return { ...data, view: { ...data.view, collapsed: [...collapsed] } };
}
