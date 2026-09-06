// One splitting rule across the tabs (Seth, 2026-09-06; plans/split-tiers.md): a more basic tab
// cannot split or join a line with more advanced data; a split is one edit that needs one position
// per tier the line carries, started on any tier, written only when every tier is placed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lineLevel, splitAllowed, splitTiers, splitPlan, TAB_LEVEL } from '../docs/js/segments.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
const PAT = readFileSync(new URL('../docs/js/paragraph-ui.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');

test('levels: audio 0, words 1, glosses or a translation 2; a tab edits only lines at or below its level', () => {
  assert.deepEqual(TAB_LEVEL, { cut: 0, baseline: 1, gloss: 2 });
  assert.equal(lineLevel({ text: '', hasGloss: false }), 0);
  assert.equal(lineLevel({ text: 'satu dua', hasGloss: false }), 1);
  assert.equal(lineLevel({ text: 'satu dua', hasGloss: true }), 2);
  assert.equal(splitAllowed('cut', { text: 'satu' }), false, 'the Cut tab cannot cut a texted line');
  assert.equal(splitAllowed('cut', { text: '  ' }), true);
  assert.equal(splitAllowed('baseline', { text: 'satu', hasGloss: true }), false, 'the Baseline tab cannot split a glossed line');
  assert.equal(splitAllowed('baseline', { text: 'satu' }), true);
  assert.equal(splitAllowed('gloss', { text: 'satu', hasGloss: true }), true, 'the Gloss tab is the top');
});

test('tiers: one position per part the line carries, and a plan that completes only when all are placed', () => {
  assert.deepEqual(splitTiers({ tab: 'cut', aligned: true }), ['audio']);
  assert.deepEqual(splitTiers({ tab: 'baseline', aligned: true, text: 'satu dua' }), ['audio', 'text']);
  assert.deepEqual(splitTiers({ tab: 'baseline', aligned: false, text: 'satu dua' }), ['text'], 'no time yet: text only');
  assert.deepEqual(splitTiers({ tab: 'baseline', aligned: true, text: '' }), ['audio'], 'no words yet: audio only');
  assert.deepEqual(splitTiers({ tab: 'gloss', aligned: true, words: 3, free: 'the words' }), ['audio', 'words', 'free']);
  assert.deepEqual(splitTiers({ tab: 'gloss', aligned: true, words: 3, free: ' ' }), ['audio', 'words'], 'an empty translation needs no position');
  assert.deepEqual(splitPlan(['audio', 'text'], {}), { missing: ['audio', 'text'], complete: false });
  assert.deepEqual(splitPlan(['audio', 'text'], { text: 4 }), { missing: ['audio'], complete: false });
  assert.deepEqual(splitPlan(['audio', 'text'], { text: 4, audio: 1200 }), { missing: [], complete: true });
  assert.deepEqual(splitPlan(['text'], { text: 0 }), { missing: [], complete: true }, 'a position of 0 counts as placed');
});

test('the pending-split engine: one at a time, toggle off, and every cancel with nothing written', () => {
  const eng = STRIPS.slice(STRIPS.indexOf('let pendingSplit = null;'), STRIPS.indexOf('let deps = null;'));
  assert.match(eng, /if \(!pendingSplit \|\| pendingSplit\.tab !== key\.tab \|\| pendingSplit\.i !== key\.i\) \{\s*\n\s*if \(pendingSplit\) splitCancel\(\);/, 'a gesture on another line replaces the pending split');
  assert.match(eng, /p\.pos\[tier\] === value\) \{ splitCancel\(\); return 'cancelled'; \}/, 'the same scissors again toggles it off');
  assert.match(eng, /if \(plan\.complete\) \{\s*\n\s*pendingSplit = null;\s*\n\s*try \{ p\.render\(null\); \} catch \{[^}]*\}\s*\n\s*p\.commit\(p\.pos\);/, 'the write happens once, when the last tier lands');
  assert.match(eng, /if \(e\.key === 'Escape' && pendingSplit\) \{ e\.preventDefault\(\); splitCancel\(\); \}/, 'Escape cancels');
  assert.match(eng, /closest\('\.split-pending, #audio-player, \.cut-scissors, \.gseg-scissors, \.split-here, \.split-prompt, \.scissor-btn, \.pa-cut, \.pa-rowcut, \.pa-player, \.pa-rowplay, #btn-undo, #pa-undo, #mg-undo'\)\) return;[^\n]*\n\s*splitCancel\(\);/, 'a tap away from the line cancels');
  assert.match(APP, /function doUndo\(\) \{ if \(splitCancel\(\)\) return;/, 'Undo cancels first');
  assert.match(APP, /function switchTab\(tab, landing\) \{\s*\n\s*splitCancel\(\);/, 'a tab switch cancels');
  assert.match(APP, /current = null;\s*\n\s*splitCancel\(\);/, 'closing the text cancels');
  assert.match(APP, /applyGlossIcon\(\);\s*\n\s*installSplitCancel\(\);/, 'installed once at boot');
});

test('Baseline tab: the box places the text tier, the playhead the audio tier; rule A locks and joins', () => {
  const onKey = STRIPS.slice(STRIPS.indexOf('function onKey(e, i, input)'), STRIPS.indexOf('function mergeAt('));
  assert.match(onKey, /stripsPlace\(i, 'text', input\.selectionStart \?\? input\.value\.length\);/);
  const atPlayhead = STRIPS.slice(STRIPS.indexOf('export function stripSplitAtPlayhead()'), STRIPS.indexOf('function stripsInfo(i)'));
  assert.match(atPlayhead, /return stripsPlace\(i, 'audio', ms\) !== 'ignored';/);
  const spec = STRIPS.slice(STRIPS.indexOf('function stripsSpec(i)'), STRIPS.indexOf('function stripsPlace(i, tier, value)'));
  assert.match(spec, /if \(deps\.capture\) deps\.capture\(\); splitLineAt\(i, 'text' in pos \? pos\.text : null, 'text' in pos, 'audio' in pos \? pos\.audio : null\);/, 'one undo, at the commit');
  assert.match(STRIPS, /function splitLineAt\(i, caret, focusNext, audioMs = null\)/);
  assert.match(STRIPS, /doc\.segments = boundaryAtPlayhead\(docSegments\(doc\), i, audioMs,/, 'the placed audio position, never the live playhead');
  const place = STRIPS.slice(STRIPS.indexOf('function stripsPlace(i, tier, value)'), STRIPS.indexOf('function renderStripsPending(p)'));
  assert.match(place, /if \(stripsLocked\(i\)\) \{ stripsRefuse\(\); return 'refused'; \}/, 'rule A on a split');
  const merge = STRIPS.slice(STRIPS.indexOf('function mergeAt(a, b, caretAtJoin)'), STRIPS.indexOf('function commitTexts()'));
  assert.match(merge, /if \(stripsLocked\(a\) \|\| stripsLocked\(b\)\) \{ stripsRefuse\(\); return; \}/, 'rule A on a join');
  assert.match(STRIPS, /\+ \(deps\.hasGloss && deps\.hasGloss\(i\) \? ' seg-locked' : ''\);/, 'a locked line is drawn locked');
  assert.match(STRIPS, /joinSplitOk\(\) && !stripsLocked\(i\) && !stripsLocked\(i \+ 1\)\) \{/, 'no join button beside a locked line');
  assert.match(STRIPS, /function stripsLocked\(i\) \{ return !splitAllowed\('baseline', stripsInfo\(i\)\); \}/);
  assert.match(STRIPS, /sc\.addEventListener\('click', \(ev\) => \{ ev\.stopPropagation\(\); stripSplitAtPlayhead\(\); \}\);/, 'a ✂ under the playhead on this tab too');
  assert.match(APP, /hasGloss: \(i\) => lineHasAnalysis\(current && current\.doc, i\),/);
  const render = STRIPS.slice(STRIPS.indexOf('function renderStripsPending(p)'), STRIPS.indexOf('function onKey(e, i, input)'));
  assert.match(render, /input\.classList\.toggle\('needs-split', missing\.includes\('text'\)\);/, 'the box still to be placed is marked');
  assert.match(STRIPS, /registerCaretScissors\(input, row, \(\) => stripsCaretWant\(input, i\), \(at\) => stripsPlace\(i, 'text', at\), deps\.t\('split\.here'\)\);/, 'every Baseline box registers its ✂');
  assert.match(render, /if \(missing\.includes\('text'\) && input\) prompt\.classList\.add\('has-caret-scissors'\);/, 'and the ✕ row keeps clear of it');
  assert.doesNotMatch(render, /split\.now\./, 'no sentence in the row (Seth, 2026-09-06: "We don\'t need that tip anymore")');
});

test('Gloss tab: the ✂ between words, the translation\'s caret and the playhead each place a tier; words editable in place', () => {
  assert.match(APP, /sc\.addEventListener\('click', \(\) => glossPlace\(i, 'words', before\)\);/);
  assert.match(APP, /glossPlace\(i, 'words', atStart \? w : w \+ 1\);/);
  assert.match(APP, /if \(fi\.value\.trim\(\) && joinSplitAllowed\('gloss'\)\) \{ glossPlace\(i, 'free', fi\.selectionStart \?\? fi\.value\.length\); return; \}/, 'mid-text Enter in the translation places its tier');
  assert.match(APP, /glossPlaceEdge\(i, 0\);/, 'Enter at the start: an empty line before, audio still to place (through the edge helper, v598)');
  assert.match(APP, /if \(onGloss\) glossPlaceAudio\(\); else stripSplitAtPlayhead\(\);/, 'Enter outside the boxes places audio on either tab');
  assert.match(APP, /sc\.addEventListener\('click', \(ev\) => \{ ev\.stopPropagation\(\); glossPlaceAudio\(\); \}\);/, 'a ✂ under the gloss playhead');
  const spec = APP.slice(APP.indexOf('function glossSpec(i)'), APP.indexOf('function glossPlace(i, tier, value)'));
  assert.match(spec, /glossSplitAt\(i, 'words' in pos \? pos\.words : 0, \{ audioMs: 'audio' in pos \? pos\.audio : null, freeAt: 'free' in pos \? pos\.free : null \}\)/);
  const split = APP.slice(APP.indexOf('function glossSplitAt(i, boundary, opts = {})'), APP.indexOf('function glossJoinLines(i)'));
  assert.match(split, /playheadMs: opts\.audioMs \?\? null,/, 'the placed audio position');
  assert.match(split, /L\.free = free\.slice\(0, at\)\.trim\(\);\s*\n\s*R\.free = free\.slice\(at\)\.trim\(\);/, 'the placed translation position');
  assert.match(APP, /function lineHasAnalysis\(doc, i\)/);
  const edit = APP.slice(APP.indexOf('function glossEditWord(seg, wi, txt)'), APP.indexOf('function glossSplitAt(i, boundary, opts = {})'));
  assert.match(edit, /paras\[li\] = textFromWords\(words\);/, 'the line is rebuilt from its words');
  assert.match(edit, /if \(near && near\.gls\) w\.gls = near\.gls;/, 'and each gloss goes back to its word');
  assert.match(APP, /t2\.contentEditable = 'plaintext-only'/, 'the word cell is editable');
  assert.match(APP, /if \(v && v !== was\) glossEditWord\(seg, i, v\); else t2\.textContent = was;/, 'committed on blur, reverted otherwise');
});

test('the ✂ for a text tier hangs under the blinking caret and follows it (Seth, 2026-09-06)', () => {
  const helper = STRIPS.slice(STRIPS.indexOf('export function caretX(input)'), STRIPS.indexOf('export function splitPromptText'));
  assert.match(helper, /caretMirror\.textContent = input\.value\.slice\(0, at\);/, 'a mirror span in the input\'s own font measures the text before the caret');
  assert.match(helper, /for \(const k of \['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'textTransform', 'wordSpacing'\]\) caretMirror\.style\[k\] = cs\[k\];/);
  assert.match(helper, /btn\.style\.left = \(input\.offsetLeft \+ caretX\(input\)\) \+ 'px';\s*\n\s*btn\.style\.top = \(input\.offsetTop \+ input\.offsetHeight\) \+ 'px';/, 'under the caret, at the box\'s bottom edge');
  assert.match(helper, /document\.addEventListener\('selectionchange', onSel\);/, 'follows the caret');
  assert.match(helper, /for \(const ev of \['input', 'keyup', 'click', 'scroll', 'focus'\]\) input\.addEventListener\(ev, place\);/, 'and typing, scrolling, focus');
  assert.match(helper, /btn\.addEventListener\('pointerdown', \(ev\) => \{ ev\.preventDefault\(\); ev\.stopPropagation\(\); onCut\(input\.selectionStart \?\? input\.value\.length\); \}\);/, 'placed on pointerdown so the caret is still where the user sees it');
  assert.match(helper, /btn\.className = 'cut-scissors split-here caret-scissors';/, 'the playhead\'s ✂, on the caret');
  assert.equal((I18N.match(/'split\.now\./g) || []).length, 0, 'the tip sentences are gone');
  assert.match(APP, /registerCaretScissors\(input, freeRow, \(\) => glossCaretWant\(input, seg\), /, 'every translation box registers its ✂');
  const want = STRIPS.slice(STRIPS.indexOf('function stripsCaretWant(input, i)'), STRIPS.indexOf('function stripsCaretWant(input, i)') + 500);
  assert.match(want, /if \(document\.activeElement === input\) return true;/, 'shown whenever the focused box can be split by Enter');
  assert.match(want, /if \(!joinSplitOk\(\) \|\| stripsLocked\(i\)\) return false;/, 'never on a locked line');
  assert.match(STRIPS, /caretRegs\.set\(input, \{ host, want, onCut, label, dispose: null \}\);[\s\S]{0,800}queueMicrotask\(syncCaretScissors\);/, 'the first sweep waits for the row to be in the document');
  assert.match(STRIPS, /document\.addEventListener\('focusin', \(\) => syncCaretScissors\(\)\);\s*\n\s*document\.addEventListener\('focusout', \(\) => setTimeout\(syncCaretScissors, 0\)\);/, 'follows focus');
  assert.match(STRIPS, /if \(!p\) \{ syncCaretScissors\(\); return; \}/, 're-decided the moment the split completes or cancels');
});

test('the join button between two lines is the chain link, the same picture as between two words (Seth, 2026-09-06)', () => {
  assert.equal((STRIPS.match(/textContent = '🔗';/g) || []).length, 2, 'Baseline and Cut join buttons');
  assert.match(APP, /join\.textContent = '🔗';/, 'the Gloss join button');
  assert.match(APP, /link\.textContent = '🔗';/, 'and the link between two words it matches');
  assert.equal((I18N.match(/\\u2919\\u291a/g) || []).length, 0, 'no hint names the old glyph');
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.joinChain': '/g) || []).length, 2);
});

test('the Paragraph Analysis Tool goes through the same planner; words exist in both languages; the styles exist', () => {
  assert.match(PAT, /import \{ splitTiers, splitPlan, isAligned \} from '\.\/segments\.js';/);
  assert.match(PAT, /paPlace\(lineId, 'text', caret\);/, 'mid-text Enter places the text tier through the engine (v598)');
  for (const k of ['split.here', 'split.cancel', 'split.no.glossed', 'gloss.editWordTip']) {
    assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.splitTiers': '/g) || []).length, 2, 'release note in EN and ID');
  assert.match(CSS, /\.needs-split \{ outline: 3px solid #e65100 !important; outline-offset: 1px; caret-color: #e65100;/, 'a thick orange border and a glowing caret');
  assert.match(CSS, /\.caret-scissors \{ border-color: #e65100;/, 'the ✂ under the caret');
  assert.match(STRIPS, /cancel\.className = 'split-cancel'; cancel\.textContent = '\\u2715';/, 'cancel is an icon button (Seth, 2026-09-06)');
  assert.match(APP, /cancel\.className = 'split-cancel'; cancel\.textContent = '\\u2715';/, 'on the Gloss tab too');
  assert.match(CSS, /\.split-prompt \.split-cancel \{ margin-left: auto; appearance: none; border: 1px solid #b23c00;/, 'round, like the ✂');
  assert.match(CSS, /\.free-row \{\n  position: relative;/, 'the translation row positions it');
  assert.match(CSS, /\.seg-strip\.seg-locked \{ background: var\(--panel, #f4f6fa\); \}/, 'a locked line');
  assert.match(CSS, /\.word-txt\[contenteditable\] \{ cursor: text;/);
});
