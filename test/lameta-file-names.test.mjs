/* lameta's FILE NAMING RULE. Seth, 2026-09-11, from lameta 3.0.21-beta: every file of an imported session
 * showed a red ! and "This file does not comply with the file naming rules of the current archive",
 * because they were named "Tautua Do.eaf", "Tautua Do.wav" and so on, while the id and the folder were
 * already "Tautua_Do". His projects use the REAP configuration, fileNameRules "ASCII": accents folded,
 * whitespace to "_", anything outside 0-9 a-z A-Z _ . - to "_", "_" trimmed from both ends.
 *
 * And, in the same conversation: "(Including editing the eaf (and pfsx file as well) to point to the
 * correctly named audio file per lameta requirements)", "Also, update the flextext file's media
 * reference", and "put the How-To-OPEN instructions in the zip root. Rather than in the actual lameta
 * session folder." (Our .pfsx names no audio: it holds tier order and is found by sharing the EAF's
 * name, so naming both from the same safe base is all it needs.) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lametaFileName, lametaFlextextMedia, lametaSessionEntries, lametaSessionId, LAMETA_ROOT_FILES } from '../docs/js/lameta.js';

const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

/* lameta's own check as its bundle writes it, for the ASCII names we produce: a name complies when the
 * rule leaves it unchanged. */
const lametaAsciiRule = (n) => n.trim().replace(/\s/g, '_').replace(/[^0-9a-zA-Z_.-]/g, '_').replace(/^_+/, '').replace(/_+$/, '');
const complies = (n) => lametaAsciiRule(n) === n;

test('file names come out the way lameta requires, and a compliant name is left alone', () => {
  assert.equal(lametaFileName('Tautua Do.eaf'), 'Tautua_Do.eaf', 'the file lameta flagged');
  assert.equal(lametaFileName('Tautua Do.wav'), 'Tautua_Do.wav');
  for (const ok of ['Tautua_Do.eaf', 'Tautua_Do.converted-NOT-ARCHIVAL.wav', 'HOW-TO-OPEN.txt', 'narr_x.flextext']) {
    assert.equal(lametaFileName(ok), ok, `${ok} already complies`);
  }
  for (const messy of ['  Cerita tentang (tempat) baru!.m4a', 'Hlai boa constrictor .flextext', '_lead_.pfsx', 'Café.wav']) {
    const out = lametaFileName(messy);
    assert.ok(complies(out), `${messy} → ${out} passes lameta's rule`);
    assert.equal(lametaFileName(out), out, 'and applying it again changes nothing');
  }
});

test("HOW-TO-OPEN sits at the top of the zip, and every session file passes lameta's rule", () => {
  assert.deepEqual(LAMETA_ROOT_FILES, ['HOW-TO-OPEN.txt']);
  const id = lametaSessionId('Tautua Do');
  assert.equal(id, 'Tautua_Do');
  const names = lametaSessionEntries({ id, title: 'Tautua Do' }, [
    { name: `${id}.eaf`, data: 'E' }, { name: `${id}.pfsx`, data: 'P' }, { name: `${id}.flextext`, data: 'F' },
    { name: `${id}.wav`, data: 'W' }, { name: 'HOW-TO-OPEN.txt', data: 'H' }, { name: 'Tautua Do (copy).wav', data: 'C' },
  ]).map((e) => e.name);
  assert.equal(names[0], 'HOW-TO-OPEN.txt', 'at the root of the zip');
  assert.ok(!names.some((n) => n.startsWith('Sessions/') && n.includes('HOW-TO-OPEN')), 'not in the session folder, and no .meta for it');
  for (const n of names.filter((x) => x.startsWith(`Sessions/${id}/`))) {
    assert.ok(complies(n.split('/').pop()), `${n} passes lameta's rule`);
  }
  assert.ok(names.includes(`Sessions/${id}/Tautua_Do_copy.wav`), 'a stray non-compliant name is made compliant too');
  assert.ok(names.includes(`Sessions/${id}/Tautua_Do_copy.wav.meta`), 'and its .meta follows the new name');
});

test("the .flextext's media reference follows the renamed recording, and nothing else changes", () => {
  const xml = '<document>\n  <interlinear-text guid="t1">\n    <media-files offset-type="">\n'
    + '      <media guid="m1" location="C:\\Users\\Seth\\Tautua Do.wav"/>\n    </media-files>\n  </interlinear-text>\n</document>';
  const out = lametaFlextextMedia(xml, 'Tautua_Do.wav');
  assert.match(out, /<media guid="m1" location="Tautua_Do\.wav"\/>/, 'the recording, by the name it ships under');
  assert.match(out, /<media-files offset-type="">/, 'the media-files element itself is untouched');
  assert.equal(out.replace(/location="[^"]*"/, ''), xml.replace(/location="[^"]*"/, ''), 'byte for byte apart from that one attribute');
  assert.equal(lametaFlextextMedia('<document/>', 'x.wav'), '<document/>', 'no media element: nothing to repoint');
  assert.equal(lametaFlextextMedia(xml, ''), xml, 'no recording in the package: left as it was');
});

test('the panel builds the whole lameta package from one lameta-safe name', () => {
  assert.match(PANEL, /const pkgBase = kind === 'lameta' \? lametaSessionId\(base\) : base;/);
  assert.match(PANEL, /const src = await prepareConversionSources\(wrap, pkgBase, paint, \{ kind \}\);/, 'the recording is named from it');
  assert.match(PANEL, /buildSegEntriesFor\(useSrc, \{ title, base: pkgBase, wants,/, 'so are the EAF, its .pfsx and the EAF\'s reference to the audio');
  const branch = PANEL.slice(PANEL.indexOf("if (kind === 'lameta') {"), PANEL.indexOf("} else if (kind === 'elan' || kind === 'saymore') {"));
  assert.match(branch, /id: pkgBase,/, 'and the session id and folder');
  assert.match(branch, /`\$\{base\} lameta session\.zip`/, 'while the zip itself keeps the readable title');
});

/* Behavior, not just wiring: build a real EAF from the lameta-safe name, as the panel now does, and read
 * its reference to the audio back out. */
test('the EAF built from that name points at the recording by its compliant name', async () => {
  const { assembleSegEntries, mediaNameFor } = await import('../docs/js/seg-exports.js');
  const { makeDoc, reconcileBaseline } = await import('../docs/js/flextext.js');
  const doc = makeDoc({ vernLang: 'fau', analLang: 'id' });
  reconcileBaseline(doc, ['satu dua', 'tiga empat'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 2000 }, { start: 2000, end: 4000 }];
  const base = lametaSessionId('Tautua Do');
  const wav = { name: mediaNameFor(base, { name: 'Tautua Do.wav', mime: 'audio/wav' }),
    blob: new Blob([new Uint8Array(44)], { type: 'audio/wav' }), mimeType: 'audio/wav' };
  const entries = await assembleSegEntries({ doc, title: 'Tautua Do', base, media: wav, segMedia: wav,
    wants: { eaf: true }, vern: 'fau', anal: 'id', full: false, producedBy: '' });
  assert.equal(wav.name, 'Tautua_Do.wav', 'the recording is named from the lameta-safe base');
  const eaf = await entries.find((e) => e.name === `${base}.eaf`).data.text();
  assert.match(eaf, /RELATIVE_MEDIA_URL="\.\/Tautua_Do\.wav"/, 'the EAF points at exactly that file');
  assert.match(eaf, /MEDIA_URL="file:\/\/\/\.\/Tautua_Do\.wav"/);
  assert.ok(entries.some((e) => e.name === `${base}.pfsx`), "its .pfsx shares the EAF's compliant name");
  for (const e of entries) assert.ok(complies(e.name), `${e.name} passes lameta's rule`);
});
