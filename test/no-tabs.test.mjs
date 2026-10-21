// A TAB IS NEVER TEXT (Seth, 2026-10-21). A researcher's file reached FLEx with its baseline lines
// tab-separated word by word, and two word glosses carrying a tab at their edges: text pasted from a
// tab-separated source, or typed with a Tab key. Every box that holds text bound for a .flextext turns
// a tab into a space as it arrives and again on the way out — ungated, one character for one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { untab, untabField } from '../docs/js/typing.js';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const STRIPS = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
// the body of the first listener of `kind` registered on `el` after `anchor`
const listener = (src, anchor, el, kind) => {
  const from = src.indexOf(anchor);
  assert.ok(from >= 0, 'anchor found: ' + anchor);
  const at = src.indexOf(`${el}.addEventListener('${kind}'`, from);
  assert.ok(at >= 0, `${el} ${kind} listener after ${anchor}`);
  return src.slice(at, src.indexOf('\n  });', at) + 1 || at + 1200);
};

test('untab: every tab becomes a space, one for one, and nothing else moves', () => {
  assert.equal(untab('ana\tbisa ke\tpasar.'), 'ana bisa ke pasar.');
  assert.equal(untab('\tPST.SUBJ\t'), ' PST.SUBJ ', 'one for one — collapsing is the single-space rule\'s job');
  const lines = 'satu\tdua\n\ntiga\t\nempat';
  assert.equal(untab(lines).split('\n').length, lines.split('\n').length, '⚠ the line count is exactly kept (an aligned doc\'s blank lines are timed silence)');
  assert.equal(untab(lines).length, lines.length, 'and the length, so a caret index stays valid');
  const plain = 'no tabs  here\n';
  assert.equal(untab(plain), plain, 'text without a tab is returned untouched');
  assert.equal(untab(null), '');
});

test('untabField: fixes the box in place and keeps the caret and selection where they were', () => {
  const el = { value: 'aaa\tbbb\tccc', selectionStart: 5, selectionEnd: 7, set: null,
               setSelectionRange(a, b) { this.set = [a, b]; } };
  assert.equal(untabField(el), true);
  assert.equal(el.value, 'aaa bbb ccc');
  assert.deepEqual(el.set, [5, 7], 'caret/selection restored — rewriting .value would otherwise throw it to the end');
  const clean = { value: 'no tab', selectionStart: 2, selectionEnd: 2, setSelectionRange() { throw new Error('should not be called'); } };
  assert.equal(untabField(clean), false, 'a box with no tab is not written to');
  assert.equal(untabField(null), false);
  const detached = { value: 'a\tb', selectionStart: 1, selectionEnd: 1, setSelectionRange() { throw new Error('detached'); } };
  assert.doesNotThrow(() => untabField(detached));
  assert.equal(detached.value, 'a b');
});

test('the baseline boxes: classic (blur, before applyBaseline reads it) and Segmentation strips (input + blur)', () => {
  const b = listener(APP, "$('#baseline-text').addEventListener('blur'", "$('#baseline-text')", 'blur');
  const iTab = b.indexOf("if (ta.value.includes('\\t')) ta.value = untab(ta.value);");
  assert.ok(iTab > 0, 'classic box: tabs replaced on blur');
  assert.ok(iTab < b.indexOf('if (singleSpaceEnabled())'), '...UNGATED: before the single-space setting is asked');
  assert.ok(iTab < b.indexOf('applyBaseline()'), '...and before applyBaseline reads the box');
  const si = listener(STRIPS, 'function renderStrips', 'input', 'input');
  assert.ok(si.indexOf('untabField(input);') > 0 && si.indexOf('untabField(input);') < si.indexOf('commitTexts()'), 'strip: tabs replaced on every input, before the text is committed');
  const sb = listener(STRIPS, "untabField(input);", 'input', 'blur');
  assert.match(sb, /const plain = untab\(input\.value\);\s*\n\s*const tidy = \(deps\.singleSpace && deps\.singleSpace\(\)\) \? tidyField\(plain/, 'strip blur: tab rule first, ungated; the tidy after it stays gated');
  assert.doesNotMatch(sb, /if \(!\(deps\.singleSpace && deps\.singleSpace\(\)\)\) return;/, 'the early return that would have skipped the tab rule is gone');
});

test('the free translation: input and blur, ungated', () => {
  const fin = APP.slice(APP.indexOf("    untabField(input);   // a tab is never text"), APP.indexOf("    untabField(input);   // a tab is never text") + 400);
  assert.ok(fin.indexOf('untabField(input);') < fin.indexOf("if (/[\\r\\n]/.test(input.value))"), 'tabs replaced first, beside the newline rule');
  assert.ok(APP.indexOf("    untabField(input);   // a tab is never text") > 0, 'free translation input handles tabs');
  assert.match(APP, /const plain = untab\(input\.value\);\s*\n\s*const tidy = singleSpaceEnabled\(\) \? tidyField\(plain, \{ kind: 'free', moment: 'blur' \}\)\.value : plain;/,
    'free translation blur: tab rule first, ungated');
  assert.doesNotMatch(APP, /input\.addEventListener\('blur', \(\) => \{\s*\n\s*if \(!singleSpaceEnabled\(\)\) return;/,
    'the early return that would have skipped the tab rule is gone');
});

test('word glosses: a tab is a space, so it becomes the break character; the gloss-tab word edit too', () => {
  const gi = APP.slice(APP.indexOf("    g.addEventListener('input', () => {"), APP.indexOf("    g.addEventListener('input', () => {") + 600);
  assert.ok(gi.indexOf('untabField(g);') > 0 && gi.indexOf('untabField(g);') < gi.indexOf("if (g.value.includes(' '))"), 'before the space rule, which then makes it the separator');
  assert.match(APP, /const spaced = untab\(g\.value\)\.split\(' '\)\.join\(glossBreak\(\)\);/, 'and on blur');
  assert.match(APP, /t2\.addEventListener\('blur', \(\) => \{ const v = untab\(t2\.textContent\)\.trim\(\);/, 'the baseline word edited in place on the Gloss tab');
});

/* ── the export backstop: no tab leaves in a .flextext, whatever is stored (flextext.js untabForXml) ── */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const FX = await import('../docs/js/flextext.js');

test('untabForXml: a run holding a tab is ONE space between words and nothing at an edge; no tab, no change', () => {
  const { untabForXml: u } = FX;
  assert.equal(u('aaa\tbbb'), 'aaa bbb');
  assert.equal(u('aaa \t bbb'), 'aaa bbb', 'tab with spaces around it: one space, not three');
  assert.equal(u('\tpst.subj\t'), 'pst.subj', 'a gloss with tabs at its edges keeps no space inside the item');
  assert.equal(u('dddd\t'), 'dddd');
  assert.equal(u('a  b'), 'a  b', '⚠ whitespace with no tab in it is NOT touched — a tab-free text exports as before');
  assert.equal(u(' lead and trail '), ' lead and trail ');
  assert.equal(u(null), '');
});

test('untabFragmentForXml: kept fragments lose tabs in their TEXT, never in the layout between tags', () => {
  const { untabFragmentForXml: f } = FX;
  assert.equal(f('<item type="title" lang="en">Two\tparts</item>'), '<item type="title" lang="en">Two parts</item>');
  const layout = '<morphemes>\n\t<morph>\n\t\t<item type="txt">ka</item>\n\t</morph>\n</morphemes>';
  assert.equal(f(layout), layout, 'indentation tabs are layout, left to indentFragment');
  assert.equal(f('<a>x</a>'), '<a>x</a>');
});

test('an export holds no tab anywhere, from any field — the shape of the reported file', () => {
  const settings = { vernLang: 'und', analLang: 'en' };
  const doc = FX.makeDoc(settings, 'Title\twith tab');
  // the reported shape, letters standing in for the words: a tab between each, one with a space before it
  const base = 'aaaaaa\tbbbbbb\tcccc\tddddd\tee \tffffffff\tggg ';
  const words = FX.tokenize(base).map((t) => FX.makeWord(t.txt, { punct: t.punct }));
  words[0].gls = '\tpst.subj\t';
  words[1].gls = 'dddd\t';
  const raw = FX.makeWord('hh\tii');           // a word made from text that was never tokenized (an import path)
  const seg = FX.makeSegment(base, [...words, raw], { free: 'she went\tto the market' });
  seg.postItemsXML = ['<item type="note" lang="en">kept\tnote</item>'];
  doc.paragraphs = [{ guid: 'p1', segments: [seg] }];
  const xml = FX.serializeFlextext(doc, settings);
  assert.ok(!xml.includes('\t'), 'not one tab in the whole file');
  assert.match(xml, />aaaaaa bbbbbb cccc ddddd ee ffffffff ggg </, 'the baseline line: one space where each tab was');
  assert.match(xml, /<item type="gls" lang="en">pst\.subj<\/item>/, 'gloss edges: gone, not turned into spaces');
  assert.match(xml, /<item type="gls" lang="en">dddd<\/item>/);
  assert.match(xml, />she went to the market</, 'free translation');
  assert.match(xml, /<item type="title" lang="en">Title with tab<\/item>/, 'title');
  assert.match(xml, />hh ii</, 'an untokenized word');
  assert.match(xml, />kept note</, 'a kept fragment');
  // round trip: the words FLEx would build are the same seven, and nothing read back holds a tab
  const back = FX.parseFlextext(xml, settings).texts[0];
  const ws = back.paragraphs[0].segments[0].words.filter((w) => !w.punct).map((w) => w.txt);
  assert.deepEqual(ws.slice(0, 7), ['aaaaaa', 'bbbbbb', 'cccc', 'ddddd', 'ee', 'ffffffff', 'ggg']);
  assert.ok(!JSON.stringify(back).includes('\\t'), 'nothing parsed back carries a tab');
});

test('the serializer writes every value and every kept fragment through the backstop', () => {
  const src = readFileSync(new URL('../docs/js/flextext.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function serializeFlextext('), src.indexOf('\n}\n', src.indexOf('export function serializeFlextext(')));
  assert.match(body, /const xesc = \(v\) => esc\(untabForXml\(v\)\);/);
  assert.match(body, /const frag = \(xml, pad\) => indentFragment\(untabFragmentForXml\(xml\), pad\);/);
  const bare = body.replace(/const xesc = [^\n]*\n/, '').replace(/const frag = [^\n]*\n/, '');
  assert.doesNotMatch(bare, /[^x]esc\(/, 'no value is written through the plain esc()');
  assert.doesNotMatch(bare, /indentFragment\(/, 'no fragment is written around the backstop');
  // esc() itself is untouched: six other modules use it for HTML and other formats
  assert.match(src, /export function esc\(s\) \{ return String\(s \?\? ''\)\.replace\(\/\[&<>"\]\/g, c => ESC\[c\]\); \}/);
});
