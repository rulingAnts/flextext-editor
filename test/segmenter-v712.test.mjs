/* v712 — SETH'S AUDIO SEGMENTER LIST ON v711 (2026-10-09), and the round-trip tail.
 *
 *   tail   "Round-trip appears to work, except final empty segment isn't being drawn. Make sure to also
 *           watch for a gap between the final audio segment in the flextext and the actual end of the
 *           audio file (total duration?)"
 *   1.     "All permissions that are specific to the audio segmenter app should be on by default … but
 *           make sure if they really are blank, they don't export as empty lines in flextext or eaf files"
 *   2.     "I seem to have lost my language picker that lets me toggle analysis languages."
 *   3.     "Does the audio segmenter app have undo/redo history built in like the others? Doesn't appear
 *           to be working right now..."
 *   5.     "add the same segment-level guess/auto-segment functionality that we added to FlexText Editor
 *           to Audio Segmenter as well"
 *
 * The real functions run here — imported, or lifted out of app.js and run against stubs — so what is
 * measured is behaviour, not a regex's opinion of it. Run: node --test test/segmenter-v712.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { segmenterPermission, SEG_PERMS, SEG_PERMS_REV_KEY, SEG_PERMS_REV, glossBreakChar } = await import('../docs/js/typing.js');
const { isSilentPhrase, isEmptyWord, serializeFlextext, stripSilentPhrasesXml, makeDoc, makeWord, makeSegment,
        reconcileBaseline, baselineFromWords, mergePhrases } = await import('../docs/js/flextext.js');
const { serializeEaf } = await import('../docs/js/seg-exports.js');
const { applyGuessedSplitsWithin, TAIL_LINE_MIN_MS } = await import('../docs/js/segments.js');
const { settleTail } = await import('../docs/js/segment-strips.js');

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const CSS = rd('../docs/css/app.css'), SHELL = rd('../satellites/audio-segmenter/index.html');

/* A function's whole source, by brace matching (one-liners included). Template literals here hold only
 * balanced ${…} pairs, so plain counting is enough for the functions lifted below. */
function src(name, from = APP) {
  let i = from.indexOf(`\nasync function ${name}(`);
  if (i < 0) i = from.indexOf(`\nfunction ${name}(`);
  if (i < 0) throw new Error(name + ' not found');
  let depth = 0, k = from.indexOf('{', from.indexOf(')', i));
  for (; k < from.length; k++) {
    if (from[k] === '{') depth++;
    else if (from[k] === '}' && --depth === 0) break;
  }
  return from.slice(i + 1, k + 1);
}
const SETTINGS = { vernLang: 'fau', analLang: 'id' };

/* ───────────────────────── 1. the Segmenter's own switches are on by default ───────────────────────── */

test('segmenterPermission: on unless a v712+ panel switched it off', () => {
  assert.deepEqual(SEG_PERMS, ['allowTextEdit', 'allowBlankLines', 'allowAudioSwap']);
  for (const k of SEG_PERMS) {
    assert.equal(segmenterPermission({}, k), true, `${k}: unset → on (the new default)`);
    assert.equal(segmenterPermission(undefined, k), true, `${k}: no settings at all → on`);
    assert.equal(segmenterPermission({ [k]: true }, k), true, `${k}: ticked → on`);
    assert.equal(segmenterPermission({ [k]: false }, k), true, `${k}: false from an OLD panel (no marker) is the old default written down → on`);
    assert.equal(segmenterPermission({ [k]: false, [SEG_PERMS_REV_KEY]: SEG_PERMS_REV }, k), false, `${k}: false from a v712+ panel → off`);
    assert.equal(segmenterPermission({ [k]: true, [SEG_PERMS_REV_KEY]: SEG_PERMS_REV }, k), true, `${k}: true from a v712+ panel → on`);
    assert.equal(segmenterPermission({ [k]: false, [SEG_PERMS_REV_KEY]: 1 }, k), true, `${k}: an older marker does not count`);
  }
});

test('one rule on three surfaces: the gates, the panel form, the device form — and the panel writes the marker', () => {
  for (const [gate, k] of [['allowTextEditOn', 'allowTextEdit'], ['allowBlankLinesOn', 'allowBlankLines'], ['allowAudioSwapOn', 'allowAudioSwap']]) {
    assert.equal(src(gate).trim(), `function ${gate}() { return !Sync.hasSession() || segmenterPermission(settings, '${k}'); }`, `${gate}: unpaired always on, paired by the rule`);
  }
  for (const s of [APP, PANEL]) assert.match(s, /else if \(SEG_PERMS\.includes\(f\.k\)\) v\[f\.k\] = segmenterPermission\(s, f\.k\);/, 'the form shows what the device will do');
  assert.match(src('readForm', PANEL), /if \(SEG_PERMS\.every\(\(k\) => typeof raw\[k\] === 'boolean'\)\) patch\[SEG_PERMS_REV_KEY\] = SEG_PERMS_REV;/,
    'a save from a form that carried all three switches marks its false as a decision');
  // the panel's readForm, run: a form with the three boxes writes the marker; one without does not
  const lifted = new Function('GROUPS', 'raw', 'deps', 'SEG_PERMS', 'SEG_PERMS_REV_KEY', 'SEG_PERMS_REV', 'legacyJoinSplit', `
    const groupFields = (g) => g.fields;
    const collectRaw = () => raw;
    ${src('readForm', PANEL)}
    return readForm(null);`);
  const legacy = (j, s) => j !== false && s !== false;
  const GROUPS = [{ fields: SEG_PERMS.map((k) => ({ k, type: 'checkbox' })) }];
  const withBoxes = lifted(GROUPS, { allowTextEdit: false, allowBlankLines: true, allowAudioSwap: true }, {}, SEG_PERMS, SEG_PERMS_REV_KEY, SEG_PERMS_REV, legacy);
  assert.equal(withBoxes[SEG_PERMS_REV_KEY], SEG_PERMS_REV);
  assert.equal(segmenterPermission(withBoxes, 'allowTextEdit'), false, 'so the researcher\'s untick now holds');
  assert.equal(segmenterPermission(withBoxes, 'allowBlankLines'), true);
  const without = lifted([{ fields: [] }], {}, {}, SEG_PERMS, SEG_PERMS_REV_KEY, SEG_PERMS_REV, legacy);
  assert.equal(SEG_PERMS_REV_KEY in without, false, 'no boxes, no marker');
});

/* ───────────────────────── 1b. a blank line is still blank with an empty pair in it ───────────────────────── */

function docWithEmptyPair() {
  const doc = makeDoc(SETTINGS);
  reconcileBaseline(doc, ['satu dua', '', 'tiga'], { flatSegments: true });
  doc.paragraphs[0].segments[0].free = 'one two';
  // The Segmenter's blank line, its placeholder pair typed into and cleared again.
  const blank = doc.paragraphs[1].segments[0];
  blank.words = [makeWord('', {})];
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 3000 }, { start: 3000, end: 4000 }];
  return doc;
}

test('an empty word/gloss pair does not make a line: no empty phrase in the .flextext, no annotation in the EAFs', () => {
  assert.equal(isEmptyWord(makeWord('', {})), true);
  assert.equal(isEmptyWord(makeWord('kama', {})), false);
  assert.equal(isEmptyWord({ txt: '', gls: 'water' }), false, 'a gloss alone is data');
  assert.equal(isEmptyWord({ txt: '', gls: '', preservedXML: ['<morphemes/>'] }), false, 'an imported analysis is data');
  const doc = docWithEmptyPair();
  assert.equal(isSilentPhrase(doc.paragraphs[1].segments[0]), true, 'the blank line with an empty pair is silent');
  const xml = serializeFlextext(doc, SETTINGS, {});
  assert.equal((xml.match(/<phrase\b/g) || []).length, 2, 'two phrases written for three lines');
  assert.doesNotMatch(xml, /begin-time-offset="2000"/, 'nothing where the blank line was');
  for (const profile of ['flex', 'saymore']) {
    const eaf = serializeEaf(doc, { profile, vern: 'fau', anal: 'id', mediaName: 'x.wav' });
    const tier = profile === 'flex' ? 'A_phrase-txt-fau' : 'Transcription';
    const body = eaf.slice(eaf.indexOf(`TIER_ID="${tier}"`));
    const n = (body.slice(0, body.indexOf('</TIER>')).match(/<ALIGNABLE_ANNOTATION /g) || []).length;
    assert.equal(n, 2, `${profile}: two annotations on the phrase tier, none over the blank line`);
  }
  const kept = docWithEmptyPair(); kept.paragraphs[1].segments[0].words[0].gls = 'cough';
  assert.equal((serializeFlextext(kept, SETTINGS, {}).match(/<phrase\b/g) || []).length, 3, 'a pair with a gloss keeps its line');
});

test('…and a file handed over as it came loses such a phrase too (stripSilentPhrasesXml)', () => {
  const phrase = (inner) => `<?xml version="1.0"?>\n<document><interlinear-text><paragraphs>\n      <paragraph guid="p1">\n        <phrases>\n          <phrase guid="f1" begin-time-offset="0" end-time-offset="1000">\n${inner}\n          </phrase>\n        </phrases>\n      </paragraph>\n</paragraphs></interlinear-text></document>\n`;
  const emptyWord = phrase('            <item type="txt" lang="fau"></item>\n            <words>\n              <word guid="w1">\n                <item type="txt" lang="fau"></item>\n                <item type="gls" lang="id"></item>\n              </word>\n            </words>');
  assert.doesNotMatch(stripSilentPhrasesXml(emptyWord), /<phrase\b|<paragraph\b/, 'a phrase holding only an empty word goes, and its paragraph with it');
  const analysed = phrase('            <words>\n              <word guid="w1">\n                <item type="txt" lang="fau"></item>\n                <morphemes><morph><item type="txt" lang="fau">ka</item></morph></morphemes>\n              </word>\n            </words>');
  assert.equal(stripSilentPhrasesXml(analysed), analysed, 'a word carrying an analysis keeps the phrase — the same string back');
});

test('Done drops pairs left empty, and a blank line commits as a blank line', () => {
  const run = new Function('isEmptyWord', 'baselineFromWords', `${src('mgDropEmptyWords')}; return mgDropEmptyWords;`)(isEmptyWord, baselineFromWords);
  const ph = makeSegment('kama', [makeWord('kama', { gls: 'water' }), makeWord('', {}), makeWord('fi', {})]);
  const out = run(ph);
  assert.deepEqual(out.words.map((w) => w.txt), ['kama', 'fi']);
  assert.equal(out.baseline, 'kama fi', 'the baseline follows the words that are left');
  assert.equal(ph.words.length, 3, 'a copy — the matcher\'s own line keeps its empty pair to type into');
  const blank = makeSegment('', [makeWord('', {})]);
  assert.equal(isSilentPhrase(run(blank)), true);
  const clean = makeSegment('kama', [makeWord('kama', {})]);
  assert.equal(run(clean), clean, 'nothing to drop: the same object');
  assert.match(src('mgCommit'), /segments: \(l\.phrases\.length > 1 \? \[mergePhrases\(l\.phrases\)\] : l\.phrases\)\.map\(mgDropEmptyWords\)/);
});

/* ───────────────────────── tail: the end of the recording, on every surface ───────────────────────── */

test('settleTail: a texted last line gets a blank line after it; an empty one reaches the end; from 350 ms', () => {
  const deps = { getParagraphs: (d) => d.paragraphs.map((p) => p.segments.map((s) => s.baseline).join(' ')),
                 appendBlankLine: (d) => { d.paragraphs.push({ guid: 'tail', segments: [makeSegment('', [])] }); return true; } };
  const mk = (texts, segs) => { const d = makeDoc(SETTINGS); reconcileBaseline(d, texts, { flatSegments: true }); d.segments = segs; return d; };
  // Seth's case: the round trip dropped a final blank line under a second long
  let d = mk(['satu', 'dua'], [{ start: 0, end: 2000 }, { start: 2000, end: 5000 }]);
  assert.equal(settleTail(d, 5700, deps), true);
  assert.deepEqual(d.segments.map((s) => [s.start, s.end]), [[0, 2000], [2000, 5000], [5000, 5700]]);
  assert.equal(d.paragraphs.length, 3, 'paragraphs and segments grow together');
  assert.equal(settleTail(d, 5700, deps), false, 'idempotent');
  // an empty last line with no imported times simply reaches the end
  d = mk(['satu', ''], [{ start: 0, end: 2000 }, { start: 2000, end: 5000 }]);
  assert.equal(settleTail(d, 5600, deps), true);
  assert.deepEqual(d.segments.map((s) => [s.start, s.end]), [[0, 2000], [2000, 5600]]);
  assert.equal(d.paragraphs.length, 2, 'stretched, not a second blank line');
  // under 350 ms is padding, not a line
  d = mk(['satu'], [{ start: 0, end: 5000 }]);
  assert.equal(settleTail(d, 5000 + TAIL_LINE_MIN_MS - 1, deps), false);
  // never on a doc that is not 1:1, never without a length
  d = mk(['satu', 'dua'], [{ start: 0, end: 5000 }]);
  assert.equal(settleTail(d, 9000, deps), false);
  d = mk(['satu'], [{ start: 0, end: 5000 }]);
  assert.equal(settleTail(d, 0, deps), false);
  // a host with no hook only ever stretches
  d = mk(['satu'], [{ start: 0, end: 5000 }]);
  assert.equal(settleTail(d, 9000, { getParagraphs: deps.getParagraphs }), false);
});

/* ───────────────────────── 2. the language picker on a narrow screen ───────────────────────── */

test('the picker survives the narrow layout that hides the column headings', () => {
  assert.match(APP, /<div class="mg-rowhead\$\{langPick \? ' mg-has-lang' : ''\}">/);
  const narrow = CSS.slice(CSS.indexOf('@media (max-width:820px){\n  .mg-rowhead{display:none}'));
  assert.match(narrow, /^@media \(max-width:820px\)\{\s*\.mg-rowhead\{display:none\}[\s\S]{0,200}?\.mg-rowhead\.mg-has-lang\{display:flex;/);
});

/* ───────────────────────── 3. undo / redo from the keyboard ───────────────────────── */

test('the matcher\'s keys: Ctrl+Y redoes, Ctrl+Z works from a picker, a field keeps its own undo, Enter cuts only off a control', () => {
  const setup = src('setupSegmenterMode');
  const at = setup.indexOf("document.addEventListener('keydown', (e) => {\n    if (!MG) return;");
  assert.ok(at > 0, 'the matcher\'s own key handler');
  const open = setup.indexOf('(e) => {', at);
  let depth = 0, k = setup.indexOf('{', open);
  for (; k < setup.length; k++) { if (setup[k] === '{') depth++; else if (setup[k] === '}' && --depth === 0) break; }
  const body = setup.slice(open, k + 1);
  const calls = [];
  const handler = new Function('calls', `
    let MG = {};
    const mgUndoOnce = () => calls.push('undo'), mgRedoOnce = () => calls.push('redo'), mgSplitAtPlayhead = () => calls.push('split');
    return ${body};`)(calls);
  const press = (key, mods, target) => { calls.length = 0; let prevented = false;
    handler({ key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt, target, preventDefault() { prevented = true; } });
    return { calls: calls.slice(), prevented }; };
  const body0 = { tagName: 'BODY' }, select = { tagName: 'SELECT' }, range = { tagName: 'INPUT', type: 'range' };
  const word = { tagName: 'SPAN', isContentEditable: true }, text = { tagName: 'INPUT', type: 'text' }, button = { tagName: 'BUTTON' };
  assert.deepEqual(press('z', { ctrl: true }, body0).calls, ['undo']);
  assert.deepEqual(press('z', { meta: true }, body0).calls, ['undo'], 'Cmd+Z on a Mac');
  assert.deepEqual(press('Z', { meta: true, shift: true }, body0).calls, ['redo'], 'Cmd+Shift+Z');
  assert.deepEqual(press('y', { ctrl: true }, body0).calls, ['redo'], 'Ctrl+Y — what the Redo tooltip says (it did nothing before v712)');
  assert.deepEqual(press('z', { ctrl: true }, select).calls, ['undo'], 'from the language or speed picker');
  assert.deepEqual(press('z', { ctrl: true }, range).calls, ['undo'], 'from a slider');
  assert.deepEqual(press('y', { ctrl: true }, button).calls, ['redo'], 'from a button just clicked');
  assert.deepEqual(press('z', { ctrl: true }, word).calls, [], 'a word being typed keeps the browser\'s own undo');
  assert.deepEqual(press('z', { ctrl: true }, text).calls, [], 'and so does a text box');
  assert.deepEqual(press('z', { ctrl: true, alt: true }, body0).calls, [], 'Ctrl+Alt+Z is not ours');
  assert.deepEqual(press('Enter', {}, body0).calls, ['split'], 'Enter cuts at the playhead');
  assert.deepEqual(press('Enter', {}, select).calls, [], '…but not on the picker');
  assert.deepEqual(press('Enter', {}, button).calls, [], '…nor on a button');
  // and the editor's ring stands down while the matcher is open (it snapshots current.doc, which the matcher does not edit)
  assert.match(APP, /if \(mod && MG && \/\^\[zy\]\$\/i\.test\(e\.key \|\| ''\)\) return;/);
});

test('undo steps: a grab that never moved leaves none, a refused ✂ leaves none', () => {
  const drag = src('mgBoundaryDrag');
  const h = new Function('env', `
    let MG = env.MG; const calls = [];
    let mgDragSnap = null;
    const player = { pause() {}, boundaryFocus() {}, boundaryLive() {} };
    const mgSnap = () => ({ snap: MG.spans.map((s) => s.end) });
    function mgCapture(s) { calls.push('capture:' + JSON.stringify(s)); }
    function mgDraw() { calls.push('draw'); }
    function mgLiveBoundary() {}
    function mgMoveBoundary(i, ms) { if (ms === MG.spans[i].end) return false; MG.spans[i].end = ms; MG.spans[i + 1].start = ms; return true; }
    ${drag}
    return { calls, drag: mgBoundaryDrag };`)({ MG: { spans: [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }] } });
  h.drag(0, null, 'start', 'row'); h.drag(0, 1000, 'move', 'row'); h.drag(0, null, 'end', 'row');
  assert.deepEqual(h.calls.filter((c) => c.startsWith('capture')), [], 'tap on an edge: no step');
  h.calls.length = 0;
  h.drag(0, null, 'start', 'row'); h.drag(0, 1200, 'move', 'row'); h.drag(0, 1300, 'move', 'row'); h.drag(0, null, 'end', 'row');
  assert.deepEqual(h.calls.filter((c) => c.startsWith('capture')), ['capture:{"snap":[1000,2000]}'], 'a real drag: ONE step, of the state at pick-up');
  const split = src('mgSplitSpan');
  const iRefuse = split.indexOf("toast(t('mg.tooShort'))"), iCap = split.indexOf('mgCapture()');
  assert.ok(iRefuse > 0 && iCap > iRefuse, 'mgSplitSpan captures after its refusal, as mgSplitLine does');
});

/* ───────────────────────── 5. ✨ on one piece, in the Segmenter ───────────────────────── */

function guessHarness(env) {
  const names = ['mgGuessMode', 'mgPieceIndex', 'mgPieceBlockedBecause', 'mgGuessPiece', 'mgGuess'];
  return new Function('env', 'applyGuessedSplitsWithin', `
    let MG = env.MG; const calls = [];
    const player = { playheadMs: () => env.head, clearSpan: () => calls.push('clearSpan') };
    const t = (k, o) => (o && o.n != null ? k + ':' + o.n : k);
    const toast = (m) => calls.push('toast:' + m);
    const peaksDurationMs = () => env.dur;
    const guessedBoundaries = () => env.cuts;
    const guessedBoundariesWithin = (a, b) => env.cuts.filter((c) => c > a && c < b);
    const confirmDialog = async () => { calls.push('confirm'); return true; };
    function mgCapture() { calls.push('capture'); }
    function mgDraw() { calls.push('draw'); }
    ${names.map((n) => src(n)).join('\n')}
    return { calls, get MG() { return MG; }, mgGuess, mgGuessMode, mgPieceIndex };`)(env, applyGuessedSplitsWithin);
}
const spansOf = (MG) => MG.spans.map((s) => [s.id, s.start, s.end]);

test('✨ in the Segmenter: the whole recording while nothing is cut, the piece under the playhead after', async () => {
  // nothing cut yet: the whole-file guess, as before — and no confirm
  let h = guessHarness({ MG: { spans: [{ id: 'sp0', start: 0, end: 30000 }], lines: [] }, head: 0, dur: 30000, cuts: [10000, 20000] });
  assert.equal(h.mgGuessMode(), 'all');
  await h.mgGuess();
  assert.deepEqual(spansOf(h.MG), [['g0', 0, 10000], ['g1', 10000, 20000], ['g2', 20000, 30000]]);
  assert.ok(!h.calls.includes('confirm'));
  // cut by hand: the piece under the playhead, only it, one undo step, the text untouched
  const lines = [{ id: 'ln0' }, { id: 'ln1' }];
  h = guessHarness({ MG: { spans: [{ id: 'sp0', start: 0, end: 4000 }, { id: 'sp1', start: 4000, end: 30000, timeEstimated: true }], lines },
                     head: 12000, dur: 30000, cuts: [2000, 9000, 15000, 22000] });
  assert.equal(h.mgGuessMode(), 'piece');
  assert.equal(h.mgPieceIndex(), 1);
  await h.mgGuess();
  assert.deepEqual(spansOf(h.MG), [['sp0', 0, 4000], ['sp1g0', 4000, 9000], ['sp1g1', 9000, 15000], ['sp1g2', 15000, 22000], ['sp1g3', 22000, 30000]],
    'the cut inside piece 0 (2000) is not touched; piece 1 is cut at its own pauses');
  assert.equal(h.calls.filter((c) => c === 'capture').length, 1, 'one undo step for the whole piece');
  assert.ok(h.MG.spans.slice(1).every((s) => s.timeEstimated === true), 'an estimate\'s pieces stay estimates');
  assert.equal(h.MG.lines, lines, 'the text side is untouched');
  assert.ok(h.calls.includes('toast:mg.guessedPiece:4'));
  assert.ok(!h.calls.includes('confirm'), 'no "replace everything?" — nothing but the one piece changes');
  // the playhead in no piece, or a piece with no pauses: said, nothing changed
  h = guessHarness({ MG: { spans: [{ id: 'a', start: 1000, end: 4000 }, { id: 'b', start: 4000, end: 8000 }], lines }, head: 500, dur: 8000, cuts: [6000] });
  await h.mgGuess();
  assert.deepEqual(h.calls, ['toast:cut.no.guessPiecePick']);
  h = guessHarness({ MG: { spans: [{ id: 'a', start: 0, end: 4000 }, { id: 'b', start: 4000, end: 8000 }], lines }, head: 1000, dur: 8000, cuts: [6000] });
  await h.mgGuess();
  assert.deepEqual(h.calls, ['toast:cut.no.guessPieceNone']);
  // the last piece owns its own end — a playhead parked at the very end still names it
  h = guessHarness({ MG: { spans: [{ id: 'a', start: 0, end: 4000 }, { id: 'b', start: 4000, end: 8000 }], lines }, head: 8000, dur: 8000, cuts: [6000] });
  assert.equal(h.mgPieceIndex(), 1);
});

test('✨ lives on the dock while the matcher owns it, as on the Cut tab', () => {
  assert.doesNotMatch(APP, /id="mg-guess"/, 'the bar\'s own ✨ is gone — one ✨, in one place');
  assert.match(src('mgPrepareAudio'), /const guessBtn = \$\('#btn-guess-splits'\);\n\s+if \(guessBtn\) \{ guessBtn\.hidden = false; guessBtn\.onclick = \(\) => mgGuess\(\); \}/);
  assert.match(src('mgClose'), /if \(guessBtn\) \{ guessBtn\.hidden = true; guessBtn\.onclick = null; delete guessBtn\.dataset\.mode; \}/);
  assert.match(SHELL, /<button id="btn-guess-splits" class="player-guess icon-btn2"[^>]*hidden>✨<\/button>/, 'the Segmenter\'s dock carries it, hidden until the matcher shows it');
  assert.match(src('mgDraw'), /mgSyncGuess\(true\);/, 'every redraw re-asks what ✨ would do');
  assert.match(APP, /mgSyncGuess\(false\);   \/\/ ✨ is about the piece under the playhead/, 'and the ticker follows the playhead');
  for (const k of ['mg.guessPieceTip', 'mg.guessedPiece', 'mg.joinWordPunct', 'mg.joinWordAnalysed']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.doesNotMatch(I18N, /'mg\.guessReplace'/, 'the "replace everything?" question went with the behaviour');
});

/* ───────────────────────── 1c. splitting and joining a word/gloss pair in place ───────────────────────── */

function wordHarness(line, settings = {}) {
  return new Function('env', 'makeWord', 'makeSegment', 'baselineFromWords', 'mergePhrases', 'glossBreakChar', `
    let MG = env.MG; const calls = []; const settings = env.settings;
    const t = (k) => k; const toast = (m) => calls.push('toast:' + m);
    function mgCapture() { calls.push('capture'); }
    function mgDraw() { calls.push('draw'); }
    function mgFocusWord(id, wi, caret) { calls.push('focus:' + wi + ':' + caret); }
    ${['mgRealIndex', 'mgLinePhrase', 'mgSplitWord', 'mgJoinWord'].map((n) => src(n)).join('\n')}
    return { calls, mgSplitWord, mgJoinWord };`)({ MG: { lines: [line] }, settings }, makeWord, makeSegment, baselineFromWords, mergePhrases, glossBreakChar);
}

test('Space inside a word splits the pair; Backspace at a word\'s start joins it to the one before', () => {
  const line = { id: 'L', phrases: [makeSegment('kamafi ra', [makeWord('kamafi', { gls: 'water' }), makeWord(',', { punct: true }), makeWord('ra', {})])] };
  const h = wordHarness(line, { glossBreak: 'period' });
  h.mgSplitWord('L', 0, 'kamafi', 4);
  assert.deepEqual(line.phrases[0].words.map((w) => [w.txt, w.gls]), [['kama', 'water'], ['fi', ''], [',', ''], ['ra', '']],
    'the left part keeps the word and its gloss; the right is a new pair to gloss');
  assert.equal(line.phrases[0].baseline, 'kama fi, ra');
  assert.deepEqual(h.calls, ['capture', 'draw', 'focus:1:0'], 'one undo step; the caret lands at the start of the new word');
  h.calls.length = 0;
  line.phrases[0].words[1].gls = 'cold';
  assert.equal(h.mgJoinWord('L', 1, 'fi'), true);
  assert.deepEqual(line.phrases[0].words.map((w) => [w.txt, w.gls]), [['kamafi', 'water.cold'], [',', ''], ['ra', '']],
    'joined back, the glosses run together after the device\'s gloss break');
  assert.deepEqual(h.calls, ['capture', 'draw', 'focus:0:4'], 'one step; the caret at the seam');
  h.calls.length = 0;
  assert.equal(h.mgJoinWord('L', 1, 'ra'), false, 'not across punctuation');
  assert.deepEqual(h.calls, ['toast:mg.joinWordPunct']);
  // an imported analysis on the second word cannot be merged honestly — refused, nothing lost
  const l2 = { id: 'L', phrases: [makeSegment('a b', [makeWord('a', {}), { ...makeWord('b', {}), preservedXML: ['<morphemes/>'] }])] };
  const h2 = wordHarness(l2);
  assert.equal(h2.mgJoinWord('L', 1, 'b'), false);
  assert.deepEqual(h2.calls, ['toast:mg.joinWordAnalysed']);
  assert.equal(l2.phrases[0].words.length, 2);
  // a blank line's placeholder pair, typed into and split
  const l3 = { id: 'L', phrases: [makeSegment('', [])] };
  wordHarness(l3).mgSplitWord('L', 0, 'satu dua', 4);
  assert.deepEqual(l3.phrases[0].words.map((w) => w.txt), ['satu', 'dua']);
  assert.equal(glossBreakChar('underscore'), '_', '(the break follows the device setting)');
});

/* ⚠ THE BLUR A REDRAW FIRES. Chromium fires `blur` on a focused box synchronously AS a redraw removes it
 * (measured in the rig: still connected when it fires). The box's blur commits its text to the pair at
 * its index — so after any change that moves the pairs, that commit landed on the wrong one: Space at
 * the start of "boro" made "boro" twice (pre-v712, since in-place editing shipped), and a join wrote the
 * joined-away text over the next word. This runs the real box wiring with a redraw that fires the blur. */
function boxHarness(line, caret) {
  return new Function('env', 'makeWord', 'makeSegment', 'baselineFromWords', 'mergePhrases', 'glossBreakChar', `
    let MG = env.MG; const calls = []; const settings = {};
    const t = (k) => k; const toast = (m) => calls.push('toast:' + m);
    let box = null;                                          // the focused box the next redraw removes
    function mgCapture() {}
    function mgSaveDraft() {}
    function mgDraw() { const b = box; box = null; if (b) b.fire('blur'); }   // removal blurs it, synchronously
    function mgFocusWord() {}
    function mgCaretOffset() { return env.caret(); }
    ${['mgRealIndex', 'mgLinePhrase', 'mgCommitEdit', 'mgEditWord', 'mgEditFree', 'mgInsertWord', 'mgDeleteWord', 'mgSplitWord', 'mgJoinWord', 'mgWireEditable'].map((n) => src(n)).join('\n')}
    function wire(wi, text) {
      const h = {};
      const el = { textContent: text, dataset: {}, classList: { add() {} }, contentEditable: '',
        addEventListener: (k, f) => { (h[k] = h[k] || []).push(f); }, blur() { this.fire('blur'); },
        fire(k, ev = {}) { for (const f of h[k] || []) f(ev); } };
      mgWireEditable(el, MG.lines[0], wi, 'txt');
      box = el;
      return el;
    }
    return { calls, wire };`)({ MG: { lines: [line] }, caret }, makeWord, makeSegment, baselineFromWords, mergePhrases, glossBreakChar);
}
const key = (k) => ({ key: k, preventDefault() {} });
const pairs = (line) => line.phrases[0].words.map((w) => `${w.txt}/${w.gls}`);

test('a redraw\'s blur never writes a box\'s old text over the pair that moved into its place', () => {
  const fresh = () => ({ id: 'L', phrases: [makeSegment('ati boro', [makeWord('ati', { gls: 'go' }), makeWord('boro', { gls: 'house' })])] });
  let caretAt = 0;
  // Space at the START of "boro": an empty pair before it — not "boro" twice
  let line = fresh(); let h = boxHarness(line, () => caretAt);
  caretAt = 0; h.wire(1, 'boro').fire('keydown', key(' '));
  assert.deepEqual(pairs(line), ['ati/go', '/', 'boro/house']);
  // Space at the END of "ati": an empty pair after it
  line = fresh(); h = boxHarness(line, () => caretAt);
  caretAt = 3; h.wire(0, 'ati').fire('keydown', key(' '));
  assert.deepEqual(pairs(line), ['ati/go', '/', 'boro/house']);
  // Backspace in an EMPTY pair: it goes, and the word that moves into its index keeps its text
  line = { id: 'L', phrases: [makeSegment('ati boro', [makeWord('ati', { gls: 'go' }), makeWord('', {}), makeWord('boro', { gls: 'house' })])] };
  h = boxHarness(line, () => caretAt);
  caretAt = 0; h.wire(1, '').fire('keydown', key('Backspace'));
  assert.deepEqual(pairs(line), ['ati/go', 'boro/house']);
  // Space INSIDE "ati", then Backspace at the start of the new "ti": back to exactly where it began
  line = fresh(); h = boxHarness(line, () => caretAt);
  caretAt = 1; h.wire(0, 'ati').fire('keydown', key(' '));
  assert.deepEqual(pairs(line), ['a/go', 'ti/', 'boro/house']);
  caretAt = 0; h.wire(1, 'ti').fire('keydown', key('Backspace'));
  assert.deepEqual(pairs(line), ['ati/go', 'boro/house'], 'the join is not undone by the blur of the box it removed');
  // a REFUSED join leaves the box live: its own blur still commits what was typed
  line = { id: 'L', phrases: [makeSegment('a b', [makeWord('a', {}), { ...makeWord('b', {}), preservedXML: ['<morphemes/>'] }])] };
  h = boxHarness(line, () => caretAt);
  caretAt = 0; const box = h.wire(1, 'bee'); box.fire('keydown', key('Backspace'));
  assert.deepEqual(h.calls, ['toast:mg.joinWordAnalysed']);
  box.fire('blur');
  assert.deepEqual(pairs(line), ['a/', 'bee/'], 'refused, so the typing in the box is still kept on blur');
});
