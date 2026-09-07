// The Toolbox/SFM → .flextext converter (issue #29). Seth, 2026-09-07: "Can we add toolbox/sfm
// import capability into our engine/suite? … as a converter on the utilities menu in editor and
// researcher panel. Please also add that utilities link (or tab) to audio segmenter as well, and as
// a menu item in paragraph analysis tool." And: "having the user select ONE of those texts for the
// import (or maybe it can convert them into individual flextext files in an export folder or zip)."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textToDoc, CONVERT_ROLES } from '../docs/js/sfm-convert.js';
import { parseSfm, detectMapping, sfmToTexts } from '../docs/js/sfm.js';
import { serializeFlextext } from '../docs/js/flextext.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CONV = rd('../docs/js/sfm-convert.js'), I18N = rd('../docs/js/i18n.js');
const APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js'), UI = rd('../docs/js/paragraph-ui.js');

const FILE = [
  '\\_sh v3.0 520 Text',
  '\\name Frog story', '\\ref F.001',
  '\\tx Todn   lyfch', '\\ge frog   lily.pad', '\\ft Long ago a frog lived.',
  '\\ref F.002', '\\tx nyr', '\\ge by', '\\ft By the pond.',
  '\\name Second story', '\\ref S.001', '\\tx aaa', '\\ge one', '\\ft One.',
].join('\n');

test('one file, many texts: the file splits where the new-text marker says, as FLEx does', () => {
  const fields = parseSfm(FILE);
  const mapping = detectMapping(fields);
  assert.equal(mapping.newtext, 'name', 'the new-text marker is inferred, not guessed at import time');
  const { texts } = sfmToTexts(fields, mapping);
  assert.equal(texts.length, 2);
  assert.deepEqual(texts.map((t) => t.title), ['Frog story', 'Second story']);
  assert.deepEqual(texts.map((t) => t.lines.length), [2, 1]);
});

test('a text becomes a .flextext with its words, glosses and translations intact', () => {
  const { texts } = sfmToTexts(parseSfm(FILE), detectMapping(parseSfm(FILE)));
  const doc = textToDoc(texts[0], 'fallback');
  assert.equal(doc.title, 'Frog story');
  assert.equal(doc.paragraphs.length, 2);
  // Column alignment, not positional zipping — the thing that silently mis-glosses if it is wrong.
  assert.deepEqual(doc.paragraphs[0].segments[0].words, [{ txt: 'Todn', gls: 'frog' }, { txt: 'lyfch', gls: 'lily.pad' }]);
  assert.equal(doc.paragraphs[0].segments[0].free, 'Long ago a frog lived.');
  assert.equal(doc.segments[0].timePending, true, 'a Toolbox file has no times unless ELAN wrote them');
  const xml = serializeFlextext(doc, {}, { producedBy: 'test' });
  assert.match(xml, /<phrase\b/);
  assert.match(xml, /exportSource="test"/, 'the file says what made it');
  assert.match(xml, /Todn/);
});

test('a file with ELAN times keeps them, so the .flextext is time-aligned', () => {
  const withTimes = ['\\ref A.1', '\\ELANBegin 00:00:01.500', '\\ELANEnd 00:00:04.000',
                     '\\ELANParticipant Yohanis', '\\tx aaa', '\\ge one', '\\ft One.'].join('\n');
  const fields = parseSfm(withTimes);
  const { texts } = sfmToTexts(fields, detectMapping(fields));
  const doc = textToDoc(texts[0], 'x');
  assert.deepEqual(doc.segments[0], { start: 1500, end: 4000 });
  assert.equal(doc.paragraphs[0].segments[0].speaker, 'Yohanis');
});

test('the reader is shared, never re-implemented, and the wrapper shape is unwrapped correctly', () => {
  assert.match(CONV, /import \{ parseSfm, markerInventory, detectMapping, sfmToTexts, alignmentRisk, normalizePastedSfm \} from '\.\/sfm\.js';/);
  assert.doesNotMatch(CONV, /function parseSfm|function alignBlock/, 'no second SFM reader in the suite');
  assert.match(CONV, /const r = sfmToTexts\(state\.fields, state\.mapping\); state\.texts = \(r && r\.texts\) \|\| \[\];/,
    'sfmToTexts returns { texts }, not an array — reading it as one yields nothing at all');
});

test('the mapping exposes every role the reader understands, starting with what splits the file', () => {
  assert.equal(CONVERT_ROLES[0], 'newtext', 'the control for where texts begin comes first');
  for (const r of ['newtext', 'title', 'ref', 'baseline', 'gloss', 'morphemes', 'free', 'literal', 'note', 'speaker', 'start', 'end'])
    assert.ok(CONVERT_ROLES.includes(r), `role ${r}`);
  for (const r of CONVERT_ROLES)
    assert.equal((I18N.match(new RegExp(`\n  'sfm\\.role\\.${r}': '`, 'g')) || []).length, 2, `sfm.role.${r} in EN and ID`);
  assert.match(CONV, /the count of texts found is shown live/, 'FLEx warns the split only works with consistent markers, so the count is visible before anything is written');
});

test('one text or all of them, and a zip that cannot silently drop one', () => {
  assert.match(CONV, /function saveOne\(\)/);
  assert.match(CONV, /async function saveAll\(\)/);
  assert.match(CONV, /base = String\(i \+ 1\)\.padStart\(2, '0'\) \+ ' ' \+ base;/, 'numbered, so the zip keeps the file\'s order');
  assert.match(CONV, /while \(used\.has\(name\.toLowerCase\(\)\)\) name = base \+ ' \(' \+ \(\+\+n\) \+ '\)\.flextext';/, 'and de-duplicated');
  assert.match(CONV, /all\.hidden = state\.texts\.length < 2;/, 'the zip is only offered when there is more than one');
});

test('all four doors open the same converter', () => {
  assert.match(rd('../docs/index.html'), /id="usfm-open"/, 'the editor\'s Utilities tab');
  assert.match(rd('../satellites/audio-segmenter/index.html'), /id="usfm-open"/, 'the segmenter\'s new Utilities tab');
  assert.match(rd('../satellites/audio-segmenter/index.html'), /data-view="utilities"/, 'and its tab button');
  assert.match(APP, /function wireSfmConverterButton\(\) \{\s*\n\s*\$\('#usfm-open'\)\?\.addEventListener\('click', \(\) => openSfmConverter\(\{ settings \}\)\);/);
  assert.match(APP, /renderSegmenterView\(\);\s*\n\s*wireSfmConverterButton\(\);/, 'the segmenter wires it too: setupResearch() never runs there, so one call site left its button dead');
  assert.match(APP, /wireAudioConverter\(\);\s*\n\s*wireSfmConverterButton\(\);/, 'and the editor');
  assert.match(APP, /else if \(b\.dataset\.view === 'utilities'\) \{ show\('utilities'\); \}\s*\n\s*else \{ sgRenderList\(\)/, 'the segmenter\'s tab strip opens it');
  assert.match(PANEL, /m\.el\.querySelector\('\[data-m="sfm"\]'\)\.onclick = \(\) => \{ m\.close\(\); openSfmConverter\(\); \};/, 'the panel\'s Utilities');
  assert.match(UI, /id="pa-sfm-convert"/, 'the tool\'s File menu');
  assert.match(UI, /\$\('#pa-sfm-convert'\)\?\.addEventListener\('click', \(\) => openSfmConverter\(\)\);/);
  for (const k of ['sfm.title', 'sfm.utilBtn', 'sfm.saveOne', 'sfm.saveAll', 'sfm.noneFound'])
    assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
});

test('the offline shells precache it; the panel deliberately caches nothing', () => {
  for (const p of ['../docs/sw.js', '../paragraph-analysis/sw.js', '../satellites/audio-segmenter/sw.js'])
    assert.match(rd(p), /js\/sfm-convert\.js/, p);
  assert.doesNotMatch(rd('../satellites/flextext-researcher/sw.js'), /sfm-convert/,
    'the researcher console is network-first on purpose');
});
