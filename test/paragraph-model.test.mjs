/* Paragraph Analysis model: grouping invariants, adversarial. Pure node — no DOM. */
import {
  validateFxpa, serializeFxpa, groupUnits, ungroup, editGroup, toggleCollapse,
  topUnits, levelOf, spanOf, leavesOf, summaryOf, summaryLineOf, parentOf,
  isBlankLine, visibleTopUnits, withBlanksBetween,
  newAuthoredDoc, addLine, setLineText, deleteLine, setCollapsedAll,
} from '../docs/js/paragraph-model.js';

let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok    ' : '  FAIL  ') + m); if (!c) failures++; };
const throws = (fn, m) => { try { fn(); ok(false, m + ' (did not throw)'); } catch { ok(true, m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n        got:  ${JSON.stringify(a)}\n        want: ${JSON.stringify(b)}`}`);

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

/* BLANK LINES (Seth, 2026-08-05): skipped in the paragraph app, but HIDDEN — never deleted.
 * Skipping cannot misalign audio, because alignment is not positional: every line carries its own
 * explicit start/end, so the lines that remain keep their exact times. The risk is elsewhere, and
 * these assertions pin both halves of it: the file must keep the blanks, and grouping across a
 * hidden blank must still work. */
console.log('blank lines are HIDDEN, never deleted');
{
  const withBlanks = validateFxpa({
    format: 'flextext-paragraph-analysis', version: 1, title: 'T',
    lines: [
      { id: 'L1', start: 0, end: 1000, baseline: 'one', words: [{ txt: 'one' }] },
      { id: 'L2', start: 1000, end: 2000, baseline: '  ', words: [], free: '' },      // silence
      { id: 'L3', start: 2000, end: 3000, baseline: 'three', words: [{ txt: 'three' }] },
      { id: 'L4', start: 3000, end: 4000, baseline: '', words: [{ txt: '  ' }] },      // also blank
    ],
    tree: [],
  }).data;

  ok(isBlankLine(withBlanks.lines[1]), 'a line with only whitespace is blank');
  ok(isBlankLine(withBlanks.lines[3]), 'so is one whose only word is whitespace');
  ok(!isBlankLine(withBlanks.lines[0]), 'a line with text is not');
  eq(visibleTopUnits(withBlanks, true), ['L1', 'L3'], 'hidden view skips the blanks');
  eq(visibleTopUnits(withBlanks, false), ['L1', 'L2', 'L3', 'L4'], 'and shows them again when off');
  eq(withBlanks.lines.length, 4, 'THE DATA STILL HAS ALL FOUR — hiding is a view, not a delete');
  eq(withBlanks.lines[1].start, 1000, 'and the hidden line keeps its exact times');

  // Grouping two VISIBLE neighbours with silence between them.
  const ids = withBlanksBetween(withBlanks, ['L1', 'L3'], true);
  eq(ids.sort(), ['L1', 'L2', 'L3'], 'the hidden blank between them is absorbed into the selection');
  const grouped = groupUnits(withBlanks, ids, { joinType: 'sym' });
  eq(grouped.tree[0].children.sort(), ['L1', 'L2', 'L3'],
     'so the group is CONTIGUOUS in the model — it would otherwise be refused as non-adjacent');
  eq(spanOf(grouped, 'G1'), { start: 0, end: 3000 }, 'and its span covers the silence it contains');
  eq(withBlanksBetween(withBlanks, ['L1', 'L3'], false), ['L1', 'L3'], 'with blanks shown, nothing is absorbed');
  // Never absorb real content.
  const ids2 = withBlanksBetween(withBlanks, ['L1', 'L4'], true);
  ok(!ids2.includes('L3'), 'a line with TEXT between the ends is never swept in');
}

/* AUTHORED documents: built in the app from typed propositions. Seth, 2026-08-05 — explicitly NOT
 * a way to edit imported language data, which is what the `authored` flag guards. */
console.log('authored documents — typed propositions, and imported text protected');
{
  let d = validateFxpa(newAuthoredDoc('From scratch')).data;
  ok(d.authored === true && d.lines.length === 1, 'a new authored doc has one empty line');
  ok(!d.audio && d.view.audio === false, 'and no audio');

  d = setLineText(d, 'L1', 'The enemy destroyed the city.');
  d = addLine(d, 'L1', 'The people were afraid.');
  d = addLine(d, d.lines[1].id, 'They fled to the hills.');
  eq(d.lines.map((l) => l.baseline),
     ['The enemy destroyed the city.', 'The people were afraid.', 'They fled to the hills.'],
     'lines are typed and inserted in order');
  ok(d.lines.every((l) => Array.isArray(l.words) && !l.words.length), 'authored lines carry no word data');
  ok(validateFxpa(JSON.parse(serializeFxpa(d))).ok, 'and the result is a valid .fxpa');
  ok(validateFxpa(JSON.parse(serializeFxpa(d))).data.authored === true, 'the authored flag survives a round trip');

  // IMPORTED text is refused by every editing operation — the guarantee Seth asked for.
  const imported = base();
  throws(() => setLineText(imported, 'L1', 'nope'), 'setLineText refuses an imported text');
  throws(() => addLine(imported, 'L1', 'nope'), 'addLine refuses an imported text');
  throws(() => deleteLine(imported, 'L1'), 'deleteLine refuses an imported text');
}

/* Deleting a line must leave the TREE valid, or the file will not reopen after an edit that
 * looked like it worked — validateFxpa rejects a group with fewer than two children. */
console.log('deleting an authored line keeps the tree valid');
{
  let d = validateFxpa(newAuthoredDoc('T')).data;
  d = setLineText(d, 'L1', 'one');
  d = addLine(d, 'L1', 'two'); d = addLine(d, d.lines[1].id, 'three'); d = addLine(d, d.lines[2].id, 'four');
  const ids = d.lines.map((l) => l.id);
  d = groupUnits(d, [ids[0], ids[1]], { joinType: 'asym', head: ids[1], relation: 'grounds' });
  d = groupUnits(d, ['G1', ids[2]], { joinType: 'sym', relation: 'ADDITION' });
  eq(d.tree.length, 2, 'two groups to start');

  // Deleting one member of the inner pair leaves it with ONE child → it must dissolve, and its
  // survivor must be promoted into the parent rather than vanishing.
  d = deleteLine(d, ids[0]);
  ok(validateFxpa(JSON.parse(serializeFxpa(d))).ok, 'the document still validates after the delete');
  eq(d.tree.length, 1, 'the one-child group dissolved');
  eq(d.tree[0].children.sort(), [ids[1], ids[2]].sort(), 'and its survivor was promoted into the parent');
  ok(!d.lines.some((l) => l.id === ids[0]), 'the line is gone');

  // Deleting the HEAD of an asym group must not leave a dangling head reference.
  let e = validateFxpa(newAuthoredDoc('T2')).data;
  e = setLineText(e, 'L1', 'a'); e = addLine(e, 'L1', 'b'); e = addLine(e, e.lines[1].id, 'c');
  const eids = e.lines.map((l) => l.id);
  e = groupUnits(e, eids, { joinType: 'asym', head: eids[0], relation: 'x' });
  e = deleteLine(e, eids[0]);
  ok(validateFxpa(JSON.parse(serializeFxpa(e))).ok, 'still valid after deleting the head');
  ok(e.tree[0].children.includes(e.tree[0].head), 'the head points at a member that still exists');

  throws(() => deleteLine(validateFxpa(newAuthoredDoc('T3')).data, 'L1'), 'the last line cannot be deleted');
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

/* FLEx exports routinely carry whitespace-only phrases (Jn1_1-3-glossed.flextext: four of eleven).
 * They are real timed spans and stay in the tree, but they must never surface as units the user
 * has to think about — Seth: "our app should be able to handle that without troubling the user". */
console.log('\nblank lines from FLEx never surface as phantom members');
{
  let d = validateFxpa({
    format: 'flextext-paragraph-analysis', version: 1,
    lines: [
      { id: 'L1', baseline: 'Ἐν ἀρχῇ ἦν ὁ λόγος', free: 'In the beginning was the Word' },
      { id: 'L2', baseline: '   ' },                                  // FLEx's whitespace-only phrase
      { id: 'L3', baseline: 'καὶ ὁ λόγος ἦν πρὸς τὸν θεόν', free: 'and the Word was with God' },
    ],
    tree: [],
  }).data;
  ok(isBlankLine(d.lines[1]), 'a whitespace-only phrase counts as blank');

  // The blank MUST be absorbed — the children have to be contiguous — but it must not be listed.
  const ids = withBlanksBetween(d, ['L1', 'L3'], true);
  eq([...ids].sort(), ['L1', 'L2', 'L3'], 'the hidden blank is absorbed so the group stays contiguous');
  d = groupUnits(d, ids, { joinType: 'sym', relation: 'coordinate' });
  eq(d.tree[0].children, ['L1', 'L2', 'L3'], 'the blank really is inside the group, in text order');

  eq(summaryOf(d, 'G1'), ['In the beginning was the Word', 'and the Word was with God'],
     'the collapsed summary shows TWO lines, not three with an empty one');
  ok(!summaryLineOf(d, 'G1').includes('·  ·'), 'no doubled separator where the blank was');

  // An all-blank group degrades to a single placeholder rather than one per member.
  let e = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', baseline: ' ' }, { id: 'L2', baseline: '' }], tree: [] }).data;
  e = groupUnits(e, ['L1', 'L2'], { joinType: 'sym' });
  eq(summaryOf(e, 'G1'), [''], 'all-blank group summarizes as ONE empty placeholder');
}

console.log('\ncollapse/expand ALL — whole document, or one subtree when something is selected');
{
  // L1 L2 grouped (G1), L3 L4 grouped (G2), then G1+G2 grouped (G3) — three levels.
  let d = base();
  d = groupUnits(d, ['L1', 'L2'], { joinType: 'sym' });
  d = groupUnits(d, ['L3', 'L4'], { joinType: 'sym' });
  d = groupUnits(d, ['G1', 'G2'], { joinType: 'sym' });

  const all = setCollapsedAll(d, true);
  ok(all.view.collapsed.slice().sort().join(',') === 'G1,G2,G3', 'collapse all takes every group');
  ok(setCollapsedAll(all, false).view.collapsed.length === 0, 'expand all opens every group');

  // THE POINT of the recursion: collapsing a group must take its descendants with it, or
  // re-opening it later dumps the entire depth back onto the screen at once.
  const sub = setCollapsedAll(d, true, ['G1']);
  ok(sub.view.collapsed.slice().sort().join(',') === 'G1', 'a leaf-level group collapses alone');
  const subTop = setCollapsedAll(d, true, ['G3']);
  ok(subTop.view.collapsed.slice().sort().join(',') === 'G1,G2,G3', 'collapsing a group takes its descendants too');

  const partial = setCollapsedAll(setCollapsedAll(d, true), false, ['G2']);
  ok(partial.view.collapsed.slice().sort().join(',') === 'G1,G3', 'expanding a subtree leaves the rest collapsed');

  // A mixed or line-only selection does the sensible thing rather than throwing.
  ok(setCollapsedAll(d, true, ['L1']).view.collapsed.length === 0, 'a line has no collapse state — nothing happens');
  ok(setCollapsedAll(d, true, ['L1', 'G2']).view.collapsed.join(',') === 'G2', 'a mixed selection acts on the groups in it');
  ok(setCollapsedAll(d, true, ['G9']).view.collapsed.length === 0, 'an unknown id is ignored, not crashed on');
  ok(validateFxpa(setCollapsedAll(d, true)).ok, 'the result is still a valid document');
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nPASS: the paragraph model holds its invariants.');
