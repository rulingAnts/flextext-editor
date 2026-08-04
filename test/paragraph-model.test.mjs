/* Paragraph Analysis model: grouping invariants, adversarial. Pure node — no DOM. */
import {
  validateFxpa, serializeFxpa, groupUnits, ungroup, editGroup, toggleCollapse,
  topUnits, levelOf, spanOf, leavesOf, summaryOf, summaryLineOf, parentOf,
} from '../docs/js/paragraph-model.js';

let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) failures++; };
const throws = (fn, m) => { try { fn(); ok(false, m + ' (did not throw)'); } catch { ok(true, m); } };

const base = () => validateFxpa({
  format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'fau', analLang: 'id',
  audio: { b64: 'QUJD', mime: 'audio/wav', name: 'a.wav' },
  lines: [
    { id: 'L1', start: 0, end: 1000, baseline: 'satu', free: 'one', words: [{ txt: 'satu', gls: 'one' }] },
    { id: 'L2', start: 1000, end: 2000, baseline: 'dua', free: 'two', words: [{ txt: 'dua' }] },
    { id: 'L3', start: 2000, end: 3000, baseline: 'tiga', words: [{ txt: 'tiga' }] },   // no free
    { id: 'L4', baseline: 'empat', free: 'four', words: [{ txt: 'empat' }] },           // text-only line
  ],
  tree: [],
}).data;

console.log('validation');
{
  ok(!!base(), 'a well-formed file validates');
  ok(validateFxpa({}).ok === false, 'garbage rejected');
  ok(validateFxpa({ format: 'flextext-paragraph-analysis', version: 99, lines: [{}] }).ok === false, 'future version rejected');
  const dup = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', baseline: 'a' }, { id: 'L1', baseline: 'b' }] });
  ok(dup.ok === false, 'duplicate line ids rejected');
  const twoParents = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', baseline: 'a' }, { id: 'L2', baseline: 'b' }, { id: 'L3', baseline: 'c' }],
    tree: [
      { id: 'G1', children: ['L1', 'L2'], joinType: 'sym', relation: '' },
      { id: 'G2', children: ['L2', 'L3'], joinType: 'sym', relation: '' },
    ] });
  ok(twoParents.ok === false, 'a unit with two parents rejected');
  const noAudio = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1, lines: [{ id: 'L1', baseline: 'a' }] });
  ok(noAudio.ok && !noAudio.data.audio && noAudio.data.view.audio === false, 'text-only file: audio view auto-off');
}

console.log('grouping — the default join builds structure, never merges');
{
  let d = base();
  d = groupUnits(d, ['L1', 'L2'], { joinType: 'asym', head: 'L2', relation: 'grounds' });
  ok(d.tree.length === 1 && d.tree[0].id === 'G1' && d.tree[0].head === 'L2', 'asym group with head created');
  ok(d.lines.length === 4 && d.lines[0].baseline === 'satu', 'lines untouched by grouping (no merge)');
  ok(levelOf(d, 'G1') === 1, 'first group is level 1');
  ok(topUnits(d).join(',') === 'G1,L3,L4', 'topUnits reflects the new surface, in order');
  d = groupUnits(d, ['G1', 'L3'], { joinType: 'sym', relation: 'parallel' });
  ok(levelOf(d, 'G2') === 2, 'level = 1 + max(child levels)');
  ok(leavesOf(d, 'G2').join(',') === 'L1,L2,L3', 'leaves in text order');
  const sp = spanOf(d, 'G2');
  ok(sp.start === 0 && sp.end === 3000, 'aggregate span from aligned leaves');
  ok(spanOf(d, 'L4') === null, 'text-only unit has no span');
  d = groupUnits(d, ['G2', 'L4'], { joinType: 'asym', head: 'G2', relation: 'summary' });
  ok(levelOf(d, 'G3') === 3, 'deep nesting levels compute');
}
{
  const d = base();
  throws(() => groupUnits(d, ['L1'], { joinType: 'sym' }), 'single unit cannot group');
  throws(() => groupUnits(d, ['L1', 'L3'], { joinType: 'sym' }), 'NON-ADJACENT units cannot group (no crossing by construction)');
  throws(() => groupUnits(d, ['L1', 'L2'], { joinType: 'asym' }), 'asym without head rejected');
  throws(() => groupUnits(d, ['L1', 'L2'], { joinType: 'asym', head: 'L3' }), 'head outside members rejected');
  throws(() => groupUnits(d, ['L1', 'L2'], { joinType: 'sym', head: 'L1' }), 'sym with head rejected');
  const g = groupUnits(d, ['L1', 'L2'], { joinType: 'sym', relation: '' });
  throws(() => groupUnits(g, ['L1', 'L3'], { joinType: 'sym' }), 'unit already inside a group cannot re-group');
}

console.log('ungroup / edit');
{
  let d = base();
  d = groupUnits(d, ['L1', 'L2'], { joinType: 'sym', relation: '' });
  d = groupUnits(d, ['G1', 'L3'], { joinType: 'asym', head: 'G1', relation: '' });
  throws(() => ungroup(d, 'G1'), 'cannot dissolve a group that has a parent (top-down only)');
  d = ungroup(d, 'G2');
  ok(d.tree.length === 1 && topUnits(d).join(',') === 'G1,L3,L4', 'ungroup releases children to the surface');
  d = editGroup(d, 'G1', { joinType: 'asym', head: 'L1', relation: 'idea' });
  ok(d.tree[0].head === 'L1' && d.tree[0].relation === 'idea', 'editGroup patches type/head/relation');
  d = editGroup(d, 'G1', { joinType: 'sym' });
  ok(!('head' in d.tree[0]), 'switching to sym drops the head');
  throws(() => editGroup(d, 'G1', { joinType: 'asym', head: 'L9' }), 'editGroup validates head membership');
}

console.log('collapse summaries — free-translation-only (Seth 2026-08-05)');
{
  let d = base();
  d = groupUnits(d, ['L1', 'L2'], { joinType: 'asym', head: 'L2', relation: 'grounds' });
  ok(summaryOf(d, 'G1').join('|') === 'two', 'asym collapse shows the HEAD\'s free translation only');
  d = groupUnits(d, ['G1', 'L3'], { joinType: 'sym', relation: '' });
  ok(summaryOf(d, 'G2').join('|') === 'two|tiga', 'sym collapse: one compact line per member; no-free falls back to baseline');
  d = groupUnits(d, ['G2', 'L4'], { joinType: 'asym', head: 'G2', relation: '' });
  ok(summaryLineOf(d, 'G3') === 'two  ·  tiga',
     'recursive: an asym head that is itself a SYM group summarizes as that group\'s member list');
  d = toggleCollapse(d, 'G2');
  ok(d.view.collapsed.includes('G2'), 'collapse recorded in view');
  d = toggleCollapse(d, 'G2');
  ok(!d.view.collapsed.includes('G2'), 'toggle expands again');
}

/* Labels (Seth, 2026-08-04): the group may be labelled, its member nodes may be labelled, or
 * both — every one optional. Member labels live on the GROUP keyed by child id, so a role is
 * always held relative to ONE relation, and blanks are absent rather than empty strings. */
console.log('labels — group, members, both, neither (all optional)');
{
  let d = base();
  d = groupUnits(d, ['L1', 'L2'], { joinType: 'asym', head: 'L2' });                       // neither
  ok(d.tree[0].relation === '' && !('labels' in d.tree[0]), 'no labels at all: relation empty, no labels key');

  d = editGroup(d, 'G1', { joinType: 'asym', head: 'L2', labels: { L1: 'grounds', L2: 'CONCLUSION' } });
  ok(d.tree[0].labels.L1 === 'grounds' && d.tree[0].labels.L2 === 'CONCLUSION', 'member labels only');
  ok(d.tree[0].relation === '', 'member labels do not invent a group label');

  d = editGroup(d, 'G1', { joinType: 'asym', head: 'L2', relation: 'grounds–CONCLUSION' });
  ok(d.tree[0].relation === 'grounds–CONCLUSION' && d.tree[0].labels.L1 === 'grounds',
     'group label added; untouched member labels survive an edit that omits them');

  d = editGroup(d, 'G1', { joinType: 'asym', head: 'L2', labels: { L1: '  ', L2: '' } });
  ok(!('labels' in d.tree[0]), 'emptying every member label removes the labels key entirely');

  d = editGroup(d, 'G1', { joinType: 'asym', head: 'L2', labels: { L1: '  spaced  ' } });
  ok(d.tree[0].labels.L1 === 'spaced', 'labels are trimmed');

  throws(() => editGroup(d, 'G1', { joinType: 'asym', head: 'L2', labels: { L3: 'x' } }),
         'a label for a NON-member is refused');
  throws(() => groupUnits(base(), ['L1', 'L2'], { joinType: 'sym', labels: ['a', 'b'] }),
         'labels must be an object, not an array');

  // sym groups take labels too — labelling is independent of head/joinType
  let s = groupUnits(base(), ['L1', 'L2'], { joinType: 'sym', relation: 'ADDITION', labels: { L1: 'a', L2: 'b' } });
  ok(s.tree[0].labels.L1 === 'a' && s.tree[0].relation === 'ADDITION', 'sym group: both kinds of label');
  s = editGroup(s, 'G1', { joinType: 'asym', head: 'L1' });
  ok(s.tree[0].labels.L1 === 'a', 'labels survive a sym → asym change');

  // a foreign file carrying a bogus label key is rejected, not silently accepted
  const bad = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', baseline: 'a' }, { id: 'L2', baseline: 'b' }],
    tree: [{ id: 'G1', level: 1, children: ['L1', 'L2'], joinType: 'sym', labels: { L9: 'x' } }] });
  ok(bad.ok === false, 'file with a label for a non-member is rejected');
  const blank = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', baseline: 'a' }, { id: 'L2', baseline: 'b' }],
    tree: [{ id: 'G1', level: 1, children: ['L1', 'L2'], joinType: 'sym', labels: { L1: '   ' } }] });
  ok(blank.ok === true && !('labels' in blank.data.tree[0]), 'blank labels in a file normalize away');
}

console.log('round-trip');
{
  let d = base();
  d = groupUnits(d, ['L1', 'L2'], { joinType: 'asym', head: 'L2', relation: 'grounds–CONCLUSION',
                                    labels: { L1: 'grounds', L2: 'CONCLUSION' } });
  d = toggleCollapse(d, 'G1');
  const rt = validateFxpa(JSON.parse(serializeFxpa(d)));
  ok(rt.ok, 'serialized state re-validates');
  ok(JSON.stringify(rt.data.tree) === JSON.stringify(d.tree) &&
     JSON.stringify(rt.data.view) === JSON.stringify(d.view), 'tree + view survive the round trip exactly');
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nPASS: the paragraph model holds its invariants.');
