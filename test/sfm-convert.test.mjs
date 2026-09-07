// The Toolbox/SFM → .flextext converter (issue #29). Seth, 2026-09-07: "Can we add toolbox/sfm
// import capability into our engine/suite? … as a converter on the utilities menu in editor and
// researcher panel. Please also add that utilities link (or tab) to audio segmenter as well, and as
// a menu item in paragraph analysis tool." And: "having the user select ONE of those texts for the
// import (or maybe it can convert them into individual flextext files in an export folder or zip)."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textToDoc, CONVERT_ROLES, claimMarker, restoreMapping } from '../docs/js/sfm-convert.js';
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
  assert.deepEqual(doc.paragraphs[0].segments[0].words.map((w) => [w.txt, w.gls]),
    [['Todn', 'frog'], ['lyfch', 'lily.pad']]);
  assert.equal(doc.paragraphs[0].segments[0].free, 'Long ago a frog lived.');
  assert.equal(doc.segments[0].timePending, true, 'a Toolbox file has no times unless ELAN wrote them');
  const xml = serializeFlextext(doc, {}, { producedBy: 'test' });
  assert.match(xml, /<phrase\b/);
  assert.match(xml, /exportSource="test"/, 'the file says what made it');
  assert.match(xml, /Todn/);
});

/* ⚠ EVERY guid IN THE OUTPUT IS REAL. textToDoc used to build paragraphs, segments and words as
 * bare object literals instead of going through makeDoc/makeSegment/makeWord, which are what mint
 * newGuid() — and serializeFlextext writes guid="${esc(x)}" unconditionally, with esc(undefined)
 * being ''. Converting InterlinTxNarA.txt's first story emitted 387 guid attributes and all 387
 * were empty, while <interlinear-text> and <phrase> carried none at all. It matters because FLEx
 * honours an incoming guid (Seth, 2026-08-08, plans/BACKLOG.md): with real ones, re-importing a
 * corrected text updates the same objects instead of duplicating them. */
test('the .flextext carries real guids: on the text, every paragraph, every phrase, every word', () => {
  const { texts } = sfmToTexts(parseSfm(FILE), detectMapping(parseSfm(FILE)));
  const xml = serializeFlextext(textToDoc(texts[0], 'fallback'), {}, { producedBy: 'test' });
  const guids = (xml.match(/guid="([^"]*)"/g) || []).map((g) => g.slice(6, -1));
  assert.ok(guids.length >= 8, `something to check (${guids.length} guid attributes)`);
  assert.equal(guids.filter((g) => !g).length, 0, 'not one empty guid=""');
  assert.equal(new Set(guids).size, guids.length, 'and no two objects share one');
  for (const g of guids) assert.match(g, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, g);
  // Each element type carries one — a phrase with no guid attribute at all passed the checks above.
  for (const tag of ['interlinear-text', 'paragraph', 'phrase', 'word'])
    assert.match(xml, new RegExp(`<${tag} guid="[0-9a-f-]{36}"`), `<${tag}> has a guid`);
  // A second conversion of the SAME text mints fresh ones: a guid identifies an object, not a text.
  const again = serializeFlextext(textToDoc(texts[0], 'fallback'), {}, { producedBy: 'test' });
  assert.notEqual(again.match(/<paragraph guid="([^"]+)"/)[1], xml.match(/<paragraph guid="([^"]+)"/)[1]);
});

/* ⚠ ONE MARKER, ONE ROLE — the modal's job, done at the moment of the choice.
 * The handler used to be `state.mapping[role] = value || null` with no check that another role
 * already owned that marker, and the reader then resolved the marker to whichever role was written
 * last. Reproduced: a file with \tx \mb \ge where "Word glosses" is pointed at \mb while
 * "Morphemes" still holds it — 0 of 2 words glossed, no message, no warning. */
test('a marker cannot serve two roles: the newest choice wins and the other role is emptied', () => {
  const before = { baseline: 'tx', gloss: 'ge', morphemes: 'mb' };
  const { mapping, freed } = claimMarker(before, 'gloss', 'mb');
  assert.deepEqual(freed, ['morphemes'], 'the role that held \\mb is named, so the user can be told');
  assert.equal(mapping.gloss, 'mb');
  assert.equal(mapping.morphemes, null, 'and it no longer holds the marker');
  assert.equal(mapping.baseline, 'tx', 'roles that were not involved are untouched');
  assert.notEqual(before.morphemes, null, 'the caller\'s mapping is not mutated under it');
  // Case is the file's own, so the comparison cannot be case-sensitive.
  assert.deepEqual(claimMarker({ speaker: 'ELANParticipant' }, 'note', 'elanparticipant').freed, ['speaker']);
  // Clearing a role frees its marker and accuses nobody.
  assert.deepEqual(claimMarker({ gloss: 'ge' }, 'gloss', '').freed, []);
  assert.equal(claimMarker({ gloss: 'ge' }, 'gloss', '').mapping.gloss, null);
  // And the whole point: the resulting mapping actually glosses the words.
  const f = parseSfm('\\ref r\n\\tx Todn  lyfch\n\\mb tod -n  lyfch\n\\ge frog-Nom  lily.pad\n');
  const { texts } = sfmToTexts(f, { ...claimMarker({ ref: 'ref', baseline: 'tx', gloss: 'ge', morphemes: 'mb' }, 'gloss', 'mb').mapping });
  assert.deepEqual(texts[0].lines[0].words.map((w) => w.gls), ['tod-n', 'lyfch'],
    'the marker the user chose is what glosses the words');
  // The modal itself is DOM-only, so its half of the fix is checked at the source: go through
  // claimMarker, put the emptied roles' SELECTS back to none, and say what changed hands.
  assert.match(CONV, /const \{ mapping, freed \} = claimMarker\(state\.mapping, role, s\.value\);/);
  assert.match(CONV, /for \(const r of freed\) \{ const el = box\.querySelector\(`\[data-role="\$\{r\}"\]`\); if \(el\) el\.value = ''; \}/,
    'a role that lost its marker must not still show it');
  assert.match(CONV, /recount\(freed\.length \? t\('sfm\.roleTaken'/, 'and the user is told, in the one message line');
  assert.doesNotMatch(CONV, /state\.mapping\[s\.dataset\.role\] = s\.value/, 'never the old blind write');
});

/* ⚠ A REMEMBERED MAPPING MUST NOT RE-CREATE THE COLLISION detectMapping REMOVES.
 * \t is a candidate for both the title and the vernacular line. Session 1 on a file where \t is
 * the title saves title:'t'; session 2 opens a file where \t IS the vernacular line, and the old
 * restore ("keep any saved role whose marker this file has") put title:'t' back on top of
 * baseline:'t' — which reported "No texts found" on a perfectly good file. */
test('the remembered mapping is only restored onto markers nothing else claims', () => {
  const fields = parseSfm(['\\t aaa   bbb', '\\gl one   two', '\\ft One two.'].join('\n'));
  const detected = detectMapping(fields);
  assert.equal(detected.baseline, 't', 'this file uses \\t for the vernacular line');
  assert.equal(detected.title, undefined, 'so it has no title marker');
  const markers = new Set(fields.map((f) => f.marker.toLowerCase()));
  const restored = restoreMapping(detected, { title: 't', gloss: 'gl' }, markers);
  assert.equal(restored.baseline, 't', 'the remembered title:\\t does not steal the baseline');
  assert.equal(restored.title, undefined, 'and is dropped, not applied');
  assert.equal(restored.gloss, 'gl', 'a remembered choice that still fits is kept');
  assert.equal(sfmToTexts(fields, restored).texts.length, 1, 'so the file still reads as one text');
  assert.equal(sfmToTexts(fields, restored).texts[0].lines[0].words.length, 2, 'with its words');
  // A remembered marker the new file does not have is ignored, and nothing else is disturbed.
  assert.equal(restoreMapping(detected, { free: 'fte' }, markers).free, 'ft');
  assert.deepEqual(restoreMapping(detected, null, markers), detected, 'nothing remembered: unchanged');
  assert.match(CONV, /state\.mapping = restoreMapping\(state\.mapping, saved, present\);/, 'and load\\(\\) goes through it');
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
  const readerImport = (CONV.match(/^import \{([^}]*)\} from '\.\/sfm\.js';$/m) || [])[1] || '';
  for (const name of ['parseSfm', 'markerInventory', 'detectMapping', 'sfmToTexts', 'alignmentRisk', 'normalizePastedSfm'])
    assert.ok(readerImport.includes(name), `${name} comes from sfm.js, not from a copy in here`);
  assert.doesNotMatch(CONV, /function parseSfm|function alignBlock/, 'no second SFM reader in the suite');
  // The guids come from the model constructors for the same reason: one minting point in the suite.
  assert.match(CONV, /^import \{[^}]*\bmakeDoc\b[^}]*\} from '\.\/flextext\.js';$/m, 'makeDoc, not a doc literal');
  assert.doesNotMatch(CONV, /guid: *['"`]/, 'no guid is ever written down in here');
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
