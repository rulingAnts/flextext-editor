/* lameta's FILE NAMING RULE. Seth, 2026-09-11, from lameta 3.0.21-beta: every file of an imported session
 * showed a red ! and "This file does not comply with the file naming rules of the current archive",
 * because they were named "Tautua Do.eaf", "Tautua Do.wav" and so on, while the id and the folder were
 * already "Tautua_Do". His projects use the REAP configuration, fileNameRules "ASCII".
 *
 * v690 ports the rule as lameta's sanitizeForArchive actually writes it (upstream V3): fold to ASCII
 * (Lucene's folding, "X" for what it cannot fold), trim, whitespace → "_", the rest of the charset → "_",
 * then sanitize-filename with an EMPTY replacement (names that are only dots and Windows reserved stems
 * like `con` VANISH; trailing dots and spaces go; 255 bytes), then "_" stripped from both ends. Until
 * v690 our copy was the character class alone — right about spaces, silent about `Café` and `con`.
 *
 * And, in the same conversation: "(Including editing the eaf (and pfsx file as well) to point to the
 * correctly named audio file per lameta requirements)", "Also, update the flextext file's media
 * reference", and "put the How-To-OPEN instructions in the zip root. Rather than in the actual lameta
 * session folder." (Our .pfsx names no audio: it holds tier order and is found by sharing the EAF's
 * name, so naming both from the same safe base is all it needs.) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  lametaFileName, lametaFlextextMedia, lametaSessionEntries, lametaSessionId, lametaSessionIdFor,
  lametaSanitize, lametaCompliant, lametaFold, LAMETA_ROOT_FILES,
} from '../docs/js/lameta.js';

const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

/* lameta's rule RESTATED HERE, independently of the module, from upstream sanitizeForArchive +
 * sanitize-filename: the check every produced name must pass. The fold below is the small part of
 * Lucene's table these cases touch; the module's fold is tested separately. */
const fold = (s) => [...s].map((c) => (c.charCodeAt(0) < 128 ? c
  : ({ ø: 'o', Ø: 'O', ß: 'ss', æ: 'ae', '‘': "'", '’': "'", '“': '"', '”': '"', '—': '-' })[c]
  || (/^[A-Za-z0-9]+$/.test(c.normalize('NFKD').replace(/\p{M}/gu, '')) ? c.normalize('NFKD').replace(/\p{M}/gu, '') : 'X'))).join('');
const lametaRule = (n) => {
  let s = fold(n).trim().replace(/\s/g, '_').replace(/[^0-9A-Za-z_.-]/g, '_');
  s = s.replace(/[\/\?<>\\:\*\|"]/g, '').replace(/[\x00-\x1f\x80-\x9f]/g, '').replace(/^\.+$/, '')
    .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '').replace(/[\. ]+$/, '');
  return Buffer.from(s).subarray(0, 255).toString().replace(/^_+/, '').replace(/_+$/, '');
};
const complies = (n) => lametaRule(n) === n;

test("the module's verdict IS lameta's rule", () => {
  for (const n of ['Café.wav', 'con.wav', 'a__b.wav', 'x_.wav', '_lead_.pfsx', 'x.', '...', 'Tautua Do.eaf',
    '  a b .wav', 'ʔaba.wav', 'Øre — “quoted”.mp3', 'a'.repeat(300) + '.wav', '']) {
    assert.equal(lametaSanitize(n), lametaRule(n), `sanitize(${JSON.stringify(n)})`);
    assert.equal(lametaCompliant(n), complies(n), `compliant(${JSON.stringify(n)})`);
  }
  assert.equal(lametaSanitize('Café.wav'), 'Cafe.wav', 'accents fold to letters, not underscores');
  assert.equal(lametaSanitize('con.wav'), '', 'lameta ERASES a Windows reserved stem — so it can never comply');
  assert.equal(lametaSanitize('a__b.wav'), 'a__b.wav', 'doubled underscores are legal to lameta');
  assert.equal(lametaSanitize('_lead_.pfsx'), 'lead_.pfsx', 'only the ends are stripped');
});

/* Lucene's folding, where it differs from plain NFKD: the letters a Fayu or Indonesian title could carry. */
test("the fold matches lameta's for the letters a title could carry, and gives X for the rest", () => {
  assert.equal(lametaFold('Café Øre Łódź straße Æsir ñ ç'), 'Cafe Ore Lodz strasse AEsir n c');
  assert.equal(lametaFold('ɛfɔ ŋə'), 'efo na', 'IPA letters Lucene folds');
  assert.equal(lametaFold('ʔaba ɸi'), 'Xaba Xi', 'glottal stop and phi: X, as in lameta');
  assert.equal(lametaFold('‘q’ “w” — a–b'), "'q' \"w\" - a-b", 'curly quotes and dashes');
  assert.equal(lametaFold('Ａ ﬁ'), 'A fi', 'fullwidth and ligatures, via NFKD');
  assert.equal(lametaFold('日本'), 'XX', 'other scripts: X, as in lameta');
  assert.equal(lametaFold('plain ASCII 123'), 'plain ASCII 123');
});

test('file names come out the way lameta requires, and a compliant name is left alone', () => {
  assert.equal(lametaFileName('Tautua Do.eaf'), 'Tautua_Do.eaf', 'the file lameta flagged');
  assert.equal(lametaFileName('Tautua Do.wav'), 'Tautua_Do.wav');
  for (const ok of ['Tautua_Do.eaf', 'Tautua_Do.converted-NOT-ARCHIVAL.wav', 'HOW-TO-OPEN.txt', 'narr_x.flextext',
    'a__b.wav', 'x_.wav', 'lead_.pfsx']) {
    assert.equal(lametaFileName(ok), ok, `${ok} already complies`);
  }
  for (const messy of ['  Cerita tentang (tempat) baru!.m4a', 'Hlai boa constrictor .flextext', '_lead_.pfsx', 'Café.wav',
    'ʔaba.wav', 'con.wav', 'COM1.eaf', '.wav', 'x.', '...', '‘Tautua’ Do.wav', 'a'.repeat(300) + '.wav', '']) {
    const out = lametaFileName(messy);
    assert.ok(complies(out), `${messy} → ${out} passes lameta's rule`);
    assert.equal(lametaFileName(out), out, 'and applying it again changes nothing');
    assert.ok(out && !out.startsWith('.'), 'never empty, never a hidden file');
  }
  assert.equal(lametaFileName('Café.wav'), 'Cafe.wav', 'a folded letter, not an underscore');
  assert.equal(lametaFileName('ʔaba.wav'), 'Xaba.wav');
  assert.equal(lametaFileName('con.wav'), 'con_.wav', "a reserved stem gets an underscore, because lameta's rule erases `con`");
  assert.equal(lametaFileName('.wav'), 'file.wav', 'a bare extension gets a stem');
  assert.equal(lametaFileName('‘Tautua’ Do.wav'), 'Tautua_Do.wav', 'quotes fold, then tidy');
  const long = lametaFileName('a'.repeat(300) + '.wav');
  assert.ok(long.length <= 255 && long.endsWith('.wav'), 'the 255-byte cap keeps the extension');
});

/* The id is the folder name, so it is made tidy beyond lameta's rule (no leading dots or dashes, no
 * doubled underscores) — and it must survive lameta's rule unchanged all the same. */
test('ids are tidy, compliant and never empty', () => {
  assert.equal(lametaSessionId('Air Rifle Accident'), 'Air_Rifle_Accident');
  assert.equal(lametaSessionId("Suu's story"), 'Suu_s_story');
  assert.equal(lametaSessionId('a//b'), 'a_b', 'runs of illegal characters collapse');
  assert.equal(lametaSessionId('...trim...'), 'trim', 'no leading or trailing punctuation');
  assert.equal(lametaSessionId(''), 'session', 'and never empty — an empty folder name is unusable');
  assert.equal(lametaSessionId('ünïcödé x'), 'unicode_x');
  // lameta's rule erases `con` outright and strips a trailing "_", so `con_` cannot comply either.
  assert.equal(lametaSessionId('con'), 'session_con', 'a reserved stem as a whole id');
  assert.equal(lametaFileName('con'), 'file_con', '...and as a whole file name');
  assert.ok(complies('session_con') && complies('file_con') && !complies('con_'));
  for (const t of ['Air Rifle Accident', 'con', '...', 'Café ʔ', 'a'.repeat(400)]) {
    assert.ok(complies(lametaSessionId(t)), `${t}: compliant`);
    assert.ok(lametaSessionId(t).length <= 200, 'short enough for a _NN suffix');
  }
});

/* A project already holding sessions: the text's own folder is reused by docId, a stranger's folder
 * with the same name yields _2, _3…, and a name is a collision whatever its case (macOS, Windows). */
test('an id in a project with sessions: reuse by docId, else suffix on collision', () => {
  const existing = [{ id: 'Tautua_Do', docId: 'd1' }, { id: 'tautua_do_2', docId: null }];
  assert.equal(lametaSessionIdFor('Tautua Do', 'd1', existing), 'Tautua_Do', 'its own folder, never renamed');
  assert.equal(lametaSessionIdFor('Something else', 'd1', existing), 'Tautua_Do', '...even when the title changed');
  assert.equal(lametaSessionIdFor('Tautua Do', 'd9', existing), 'Tautua_Do_3', 'a stranger holds _1 and, by case, _2');
  assert.equal(lametaSessionIdFor('Tautua Do', 'd9', []), 'Tautua_Do', 'an empty project');
  assert.equal(lametaSessionIdFor('Tautua Do', '', existing), 'Tautua_Do_3', 'no docId: never claims a folder');
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
