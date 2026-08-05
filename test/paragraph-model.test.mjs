/* Paragraph Analysis model: grouping invariants, adversarial. Pure node — no DOM. */
import {
  validateFxpa, serializeFxpa, groupUnits, ungroup, editGroup, toggleCollapse,
  topUnits, levelOf, spanOf, leavesOf, summaryOf, summaryLineOf, parentOf,
  isBlankLine, visibleTopUnits, withBlanksBetween,
  newAuthoredDoc, addLine, setLineText, deleteLine, setCollapsedAll,
  addProp, setPropText, setPropImplicit, deleteProp, setLineFree,
  isPropId, propUnits, ownerLineOf, orderIndex,
  setWordText, setWordGloss, deleteWord, splitLine,
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
/* Authored propositions: SSA is semantic, so a line often expresses several propositions. They
 * live INSIDE the line because the line owns the audio span, and they are ADDITIONS beside the
 * record — never edits to imported wording, which is why they are allowed on any document. */
/* Seth, 2026-08-05: "not words, glosses, or splits yet, but the text of the free translation
 * should be changeable." A deliberate, narrow exception to "imported wording is sacred" — the free
 * translation is the analyst's own rendering into the analysis language, not observed data. */
console.log('\nthe free translation is editable — and it is the ONLY imported field that is');
{
  let d = base();
  const before = JSON.stringify(d.lines[0]);
  d = setLineFree(d, 'L1', 'the first one');
  ok(d.lines[0].free === 'the first one', 'the free translation changes');

  // Everything the vernacular record consists of comes back untouched.
  const l = { ...d.lines[0] }; l.free = JSON.parse(before).free;
  eq(JSON.stringify(l), before, 'baseline, words, glosses, times and speaker are all untouched');

  // A line that never had one can be given one — SSA states its propositions in this language.
  let e = setLineFree(base(), 'L3', 'the third one');
  ok(e.lines[2].free === 'the third one', 'a line with no free translation can be given one');

  // Cleared means ABSENT, not an empty string, so it matches a line that never had one.
  e = setLineFree(e, 'L3', '   ');
  ok(!('free' in e.lines[2]), 'clearing it removes the key rather than leaving an empty string');
  ok(validateFxpa(e).ok, 'still valid either way');
  throws(() => setLineFree(d, 'L9', 'x'), 'an unknown line is refused');

  // It feeds everything downstream, which is the point of being able to fix it.
  let g = groupUnits(setLineFree(base(), 'L1', 'FIXED WORDING'), ['L1', 'L2'], { joinType: 'sym' });
  ok(summaryOf(g, 'G1')[0] === 'FIXED WORDING', 'the corrected wording reaches the collapsed summary');
}

/* Seth, 2026-08-05: editing and deleting words and glosses ships now; splitting and joining lines
 * is saved for later (the user is pointed at the FlexText editor or ELAN meanwhile). The split is
 * principled: a word correction stays INSIDE a line, whereas splitting changes the unit the tree
 * references and needs an audio boundary that must be observed, never computed. */
console.log('\nwords and glosses are editable; lines still cannot be split or joined');
{
  let d = base();
  d = setWordText(d, 'L1', 0, 'satú');
  ok(d.lines[0].words[0].txt === 'satú', 'a word can be corrected');
  ok(d.lines[0].baseline === 'satú', 'and the baseline is kept in step, so the two views cannot disagree');
  ok(d.lines[0].words[0].gls === 'one', 'its gloss is untouched by a text edit');

  d = setWordGloss(d, 'L1', 0, 'ONE');
  ok(d.lines[0].words[0].gls === 'ONE', 'a gloss can be corrected');
  d = setWordGloss(d, 'L1', 0, '   ');
  ok(!('gls' in d.lines[0].words[0]), 'clearing a gloss removes the key rather than leaving an empty string');

  // A word with two words in the line, then delete one.
  let e = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', start: 0, end: 1000, baseline: 'ana bete kabo', free: 'he went out',
              words: [{ txt: 'ana', gls: '3SG' }, { txt: 'bete', gls: 'go' }, { txt: 'kabo', gls: 'out' }] }],
    tree: [] }).data;
  e = deleteWord(e, 'L1', 1);
  eq(e.lines[0].words.map((w) => w.txt), ['ana', 'kabo'], 'a word can be deleted');
  eq(e.lines[0].words.map((w) => w.gls), ['3SG', 'out'], 'the remaining glosses stay with THEIR OWN words');
  ok(e.lines[0].baseline === 'ana kabo', 'the baseline follows the deletion');

  // ⚠ Deleting every word must NOT destroy the line: it still holds a time span, a free
  // translation and a place in the grouping tree.
  e = deleteWord(deleteWord(e, 'L1', 0), 'L1', 0);
  ok(e.lines.length === 1 && e.lines[0].words.length === 0, 'the line survives losing all its words');
  ok(e.lines[0].start === 0 && e.lines[0].end === 1000 && e.lines[0].free === 'he went out',
     'and keeps its time span and free translation');
  ok(validateFxpa(e).ok, 'still a valid document');

  throws(() => setWordText(base(), 'L1', 0, '   '), 'a word cannot be silently emptied — delete it instead');
  throws(() => setWordText(base(), 'L1', 9, 'x'), 'an out-of-range word is refused');
  throws(() => deleteWord(base(), 'L9', 0), 'an unknown line is refused');

  // The boundary that has NOT moved: nothing here splits or joins a line.
  ok(base().lines.length === 4 && deleteWord(setWordText(base(), 'L1', 0, 'x'), 'L1', 0).lines.length === 4,
     'editing and deleting words never changes how many lines there are');
}

console.log('\nauthored propositions — semantic daughters of a line');
{
  let d = base();
  const before = JSON.stringify(d.lines[0]);
  d = addProp(d, 'L1', 'the speaker left the house');
  d = addProp(d, 'L1', 'he was in a hurry', { implicit: true });
  eq(d.lines[0].props.map((p) => [p.text, !!p.implicit]),
     [['the speaker left the house', false], ['he was in a hurry', true]], 'propositions are added in order, with the implicit flag');
  ok(d.lines[0].props[0].id !== d.lines[0].props[1].id, 'ids are distinct');

  // ⚠ THE LINE ITSELF IS UNTOUCHED — this is not a text editor for imported data.
  const l = d.lines[0];
  const stripped = { ...l }; delete stripped.props;
  eq(JSON.stringify(stripped), before, 'the line\'s own baseline, words, glosses, times and free translation are untouched');

  d = setPropText(d, 'L1', l.props[0].id, 'the speaker went outside');
  eq(d.lines[0].props[0].text, 'the speaker went outside', 'text edits apply');
  d = setPropImplicit(d, 'L1', l.props[0].id, true);
  ok(d.lines[0].props[0].implicit === true, 'a proposition can be marked implied');
  d = setPropImplicit(d, 'L1', l.props[0].id, false);
  ok(!('implicit' in d.lines[0].props[0]), 'and back to stated, with no leftover key');

  ok(validateFxpa(d).ok, 'a document with propositions validates');

  // Deleting the LAST one removes the key, so the file is shaped exactly like one that never had
  // any — every renderer's leavesOfLine fallback then needs no special case.
  d = deleteProp(d, 'L1', l.props[0].id);
  ok(d.lines[0].props.length === 1, 'one deleted, one left');
  d = deleteProp(d, 'L1', l.props[1].id);
  ok(!('props' in d.lines[0]), 'deleting the last proposition removes the key entirely');

  throws(() => addProp(d, 'L9', 'x'), 'an unknown line is refused');

  // Validation normalizes junk rather than trusting it into the renderers.
  const messy = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', baseline: 'a', props: [{ id: 'p1', text: 'ok' }, { id: 'p1', text: 'dup' }] }], tree: [] });
  ok(!messy.ok, 'duplicate proposition ids are rejected');
  const empty = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1,
    lines: [{ id: 'L1', baseline: 'a', props: [] }], tree: [] });
  ok(empty.ok && !('props' in empty.data.lines[0]), 'an empty props list is dropped, not carried');
}

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

/* PROPOSITIONS ARE TREE UNITS (Seth, 2026-08-05: "I need to be able to apply groupings to semantic
 * component propositions. They need to function as leaves on the tree for the diagram, but not as
 * independent audio segments") — groupable and sub-groupable, but only BENEATH their own line. */
console.log('\npropositions are leaves of ONE flat document surface');
{
  let d = base();
  d = addProp(d, 'L1', 'the man went outside');
  d = addProp(d, 'L1', 'the child had laughed');
  const [p1, p2] = d.lines[0].props.map((p) => p.id);

  /* ⚠ A LINE WITH PROPOSITIONS IS NO LONGER A UNIT — its propositions are. It stays a HEADER that
   * owns the audio, which is why playback is unaffected. */
  eq(topUnits(d), [p1, p2, 'L2', 'L3', 'L4'],
     'the line is replaced on the surface by its propositions; other lines are unchanged');
  eq(ownerLineOf(d, p1), 'L1', 'a proposition still knows the line that owns its audio');

  // The case that forced the redesign: a proposition grouped with the NEXT LINE.
  d = groupUnits(d, [p2, 'L2'], { joinType: 'asym', head: 'L2', relation: 'reason–RESULT',
                                  labels: { [p2]: 'reason', L2: 'RESULT' } });
  const g = d.tree[0];
  eq(g.children, [p2, 'L2'], 'a proposition can be grouped with an adjacent LINE');
  ok(validateFxpa(d).ok, 'and the result is a valid document');
  eq(topUnits(d), [p1, g.id, 'L3', 'L4'], 'the surface reflects it');

  // ...and with a proposition of the next line.
  let e = base();
  e = addProp(e, 'L1', 'first');
  e = addProp(e, 'L2', 'second');
  const a = e.lines[0].props[0].id, b = e.lines[1].props[0].id;
  eq(topUnits(e), [a, b, 'L3', 'L4'], 'propositions of adjacent lines are adjacent on the surface');
  e = groupUnits(e, [a, b], { joinType: 'sym', relation: 'sequence' });
  ok(validateFxpa(e).ok, 'a proposition can be grouped with a proposition of the NEXT line');

  // ⚠ STILL NOT INDEPENDENT AUDIO: a proposition resolves to its LINE's span, so a cross-line
  // group spans the union of the lines it touches — it can never invent or narrow a span.
  eq(spanOf(e, e.tree[0].id), { start: 0, end: 2000 }, 'a cross-line group spans both lines, exactly');
  eq(spanOf(e, a), { start: 0, end: 1000 }, 'and one proposition still spans its whole line');

  // Crossing brackets remain impossible — adjacency does that work, not the old same-line rule.
  let f = base();
  f = addProp(f, 'L1', 'x');
  f = addProp(f, 'L3', 'y');
  const fa = f.lines[0].props[0].id, fb = f.lines[2].props[0].id;
  throws(() => groupUnits(f, [fa, fb], { joinType: 'sym' }),
         'non-adjacent units still cannot group, whatever kind they are');
}

console.log('\ndeleting a grouped proposition repairs the tree');
{
  let d = base();
  d = addProp(d, 'L1', 'one');
  d = addProp(d, 'L1', 'two');
  d = addProp(d, 'L1', 'three');
  const [p1, p2, p3] = d.lines[0].props.map((p) => p.id);
  d = groupUnits(d, [p1, p2], { joinType: 'asym', head: p1, labels: { [p2]: 'support' } });
  const gid = d.tree[0].id;
  d = groupUnits(d, [gid, p3], { joinType: 'sym' });

  // Removing one member of the inner pair leaves it with a single child — which must DISSOLVE,
  // or the file becomes one that validateFxpa refuses to reopen.
  d = deleteProp(d, 'L1', p2);
  ok(validateFxpa(d).ok, 'still valid after deleting a grouped proposition');
  ok(d.tree.every((x) => x.children.length >= 2), 'no one-child group is left behind');
  ok(!JSON.stringify(d.tree).includes(p2), 'no dangling reference to the deleted proposition');
  ok(!JSON.stringify(d.tree).includes('"support"'), 'and its member label went with it');

  // Deleting the rest empties the line back to a plain line.
  d = deleteProp(deleteProp(d, 'L1', p1), 'L1', p3);
  ok(!('props' in d.lines[0]), 'the line is a plain line again');
  eq(d.tree, [], 'and the tree is empty rather than holding ghosts');
  ok(validateFxpa(d).ok, 'valid at the end');
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

/* Seth, 2026-08-05: "If you press enter in the middle of a line, it should split it at the
 * cursor's place" — in the blank/new diagram, where a line IS a typed proposition. */
console.log('\nsplitting a typed line at the cursor (authored documents only)');
{
  let d = validateFxpa(newAuthoredDoc('T')).data;
  d = setLineText(d, 'L1', 'he went outside because the child laughed');
  d = splitLine(d, 'L1', 'he went outside'.length);
  eq(d.lines.map((l) => l.baseline), ['he went outside', 'because the child laughed'],
     'the text divides at the cursor, with the whitespace at the seam tidied');
  ok(d._added === d.lines[1].id, 'the new line is named, so the cursor can follow it');
  ok(validateFxpa(d).ok, 'valid');

  // ⚠ A SPLIT INSIDE A BRACKET must not drop half the text out of the analysis.
  let g = validateFxpa(newAuthoredDoc('T')).data;
  g = setLineText(g, 'L1', 'first part second part');
  g = addLine(g); g = setLineText(g, g.lines[1].id, 'another');
  g = groupUnits(g, [g.lines[0].id, g.lines[1].id], { joinType: 'sym', relation: 'x' });
  g = splitLine(g, 'L1', 'first part'.length);
  eq(g.tree[0].children.length, 3, 'the new half joins its sibling group');
  eq(g.tree[0].children[1], g._added, 'immediately after the line it came from, so the run stays contiguous');
  ok(validateFxpa(g).ok, 'still valid');

  // Splitting at the very end is just "add a line" — the fast typing flow is unchanged.
  let e = validateFxpa(newAuthoredDoc('T')).data;
  e = setLineText(e, 'L1', 'whole thing');
  e = splitLine(e, 'L1', 'whole thing'.length);
  eq(e.lines.map((l) => l.baseline), ['whole thing', ''], 'a split at the end leaves an empty new line');

  // IMPORTED text is not splittable here — that is the audio-boundary feature, and it is separate.
  throws(() => splitLine(base(), 'L1', 2), 'an imported line cannot be split this way');
}


/* ── SUB-GROUPING: nesting must not require dismantling the tree (Seth, 2026-08-06) ──────────────
 * "It seems like any sub-grouping doesn't work if members are already part of a group. And we
 * REALLY don't want our model to have that constraint… I do not have to want to redo the entire
 * tree every time I have to modify a sub level." */
console.log('sub-grouping inside an existing group');
{
  const four = () => validateFxpa({
    format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'fau', analLang: 'id',
    lines: [1, 2, 3, 4].map((n) => ({ id: 'L' + n, baseline: 'w' + n, words: [] })), tree: [],
  }).data;

  // TOP-DOWN: one big group, then carve sub-groups out of it without touching the parent.
  let d = groupUnits(four(), ['L1', 'L2', 'L3', 'L4'], { joinType: 'sym' });
  d = groupUnits(d, ['L1', 'L2'], { joinType: 'sym' });
  eq(d.tree.find((g) => g.id === 'G1').children, ['G2', 'L3', 'L4'], "the sub-group takes the run's place in its parent");
  eq(d.tree.find((g) => g.id === 'G2').children, ['L1', 'L2'], 'and holds the grouped units');
  eq(topUnits(d), ['G1'], 'the root is unchanged — nothing had to be dismantled');
  eq(levelOf(d, 'G1'), 2, 'the ancestor deepens');

  // level is DERIVED, never stored — no parallel copy to drift.
  ok(d.tree.every((g) => !('level' in g)), 'no group stores a level');
  const reloaded = validateFxpa(JSON.parse(serializeFxpa(d))).data;
  ok(reloaded.tree.every((g) => !('level' in g)), 'and a saved file carries none either');
  eq(levelOf(reloaded, 'G1'), 2, 'depth survives the round trip by derivation alone');
  const stale = validateFxpa({ format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'fau', analLang: 'id',
    lines: [{ id: 'L1', baseline: 'a', words: [] }, { id: 'L2', baseline: 'b', words: [] }],
    tree: [{ id: 'G1', level: 99, children: ['L1', 'L2'], joinType: 'sym' }] }).data;
  ok(!('level' in stale.tree[0]), 'an OLD file\'s stale stored level is stripped on load');

  // An asymmetrical parent whose HEAD is absorbed must follow it into the new group.
  let a = groupUnits(four(), ['L1', 'L2', 'L3'], { joinType: 'asym', head: 'L2' });
  a = groupUnits(a, ['L2', 'L3'], { joinType: 'sym' });
  eq(a.tree.find((g) => g.id === 'G1').head, 'G2', 'an absorbed HEAD is re-pointed at the new sub-group');

  // Still refused: a run spanning two parents would be a re-parenting, not a nesting.
  let b = groupUnits(four(), ['L1', 'L2'], { joinType: 'sym' });
  b = groupUnits(b, ['L3', 'L4'], { joinType: 'sym' });
  throws(() => groupUnits(b, ['L2', 'L3'], { joinType: 'sym' }), 'units in DIFFERENT groups are still refused');
  throws(() => groupUnits(b, ['G1', 'L3'], { joinType: 'sym' }), 'mixing a group with a unit inside another group is refused');
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nPASS: the paragraph model holds its invariants.');

/* ── Propositions on an ALREADY-GROUPED line (Seth, 2026-08-05) ────────────────────────────────
 * "if we create sub-propositions, the propositions, rather than the audio segment line, are
 * supposed to be what goes in the tree."
 *
 * The bug: topUnits() substituted propositions for their line at TOP level, but nothing did it
 * INSIDE a group. A proposition added to a grouped line therefore had no parent, became a
 * top-level unit, and rendered at the BOTTOM of the document. */
console.log('propositions take the line\'s slot in the tree');
{
  const g0 = groupUnits(base(), ['L1', 'L2'], { joinType: 'sym' });
  const kids = (d) => d.tree.map((g) => g.children);

  const a1 = addProp(g0, 'L1');
  eq(kids(a1), [['L1p1', 'L2']], 'first proposition REPLACES its line in the group');
  ok(!!parentOf(a1, 'L1p1'), 'the proposition has a parent (it did not escape the group)');
  ok(!topUnits(a1).includes('L1p1'), 'and is NOT a top-level unit (that was the bottom-of-page bug)');

  // ⚠ the regression that my own first fix missed: after substitution the LINE is gone from the
  // tree, so a lineId-only "is it grouped?" test says no and every later proposition escapes.
  const a2 = addProp(a1, 'L1');
  eq(kids(a2), [['L1p1', 'L1p2', 'L2']], 'SECOND proposition joins the group beside the first');
  const a3 = addProp(a2, 'L2');
  eq(kids(a3), [['L1p1', 'L1p2', 'L2p1']], 'a sibling line substitutes independently, order kept');

  const d1 = deleteProp(a3, 'L1', 'L1p1');
  eq(kids(d1), [['L1p2', 'L2p1']], 'deleting one of several just removes it');
  const d2 = deleteProp(d1, 'L1', 'L1p2');
  eq(kids(d2), [['L1', 'L2p1']], 'deleting the LAST proposition restores the line to its slot');

  ok(!!d2.lines.find((l) => l.id === 'L1'), 'the line itself always survives — audio/player depend on it');
  ok(!!a3.lines.find((l) => l.id === 'L1'), 'including while its propositions stand in for it');
}

/* ⚠ THE CASE THE FIRST FIX MISSED (v230, reverted). Its tests all passed because they only ever
 * built CONSISTENT trees — so a fix whose flaw was assuming consistency could not be caught.
 * A line's propositions can end up in DIFFERENT groups (a file saved by the version that orphaned
 * them, then grouped). v230 re-inserted the whole proposition list into every group containing any
 * of them, duplicating ids across groups; deleting one then emptied both, pruneTree dissolved them,
 * and lines disappeared from the view. */
console.log('a malformed tree must not be made worse');
{
  const split = validateFxpa({
    format: 'flextext-paragraph-analysis', version: 1, title: 'T', vernLang: 'fau', analLang: 'id',
    lines: [
      { id: 'L1', baseline: 'satu', words: [], props: [{ id: 'L1p1', text: 'a' }, { id: 'L1p2', text: 'b' }] },
      { id: 'L2', baseline: 'dua', words: [] }, { id: 'L3', baseline: 'tiga', words: [] },
    ],
    tree: [{ id: 'G1', level: 1, children: ['L1p1', 'L2'], joinType: 'sym' },
           { id: 'G2', level: 1, children: ['L1p2', 'L3'], joinType: 'sym' }],
  }).data;
  const after = addProp(split, 'L1');
  const all = after.tree.flatMap((g) => g.children);
  eq(all.length, new Set(all).size, 'no id is a child of two groups after adding a proposition');
  eq(after.tree.find((g) => g.id === 'G2').children, ['L1p2', 'L3'], 'the OTHER group is left alone');
  ok(after.tree.find((g) => g.id === 'G1').children.includes('L1p3'), 'the new proposition joins exactly one group');
  eq(after.lines.map((l) => l.id), ['L1', 'L2', 'L3'], 'and no language-data line is touched');
}
