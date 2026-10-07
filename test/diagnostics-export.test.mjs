/* THE DIAGNOSTIC EXPORT — and the four ways it could quietly become either useless or dangerous.
 *
 * WHY THIS EXISTS (2026-10-07): a researcher's coworker had a text open as the classic textarea
 * while the researcher saw strips; the cause was one stored value (`segmentation: false`) that no
 * screenshot could show. The export is the answer to "what is actually on that device", producible
 * offline by whoever is holding it. Everything below is a property that is invisible on screen:
 *
 *   1. SECRETS NEVER RIDE BY DEFAULT. The install secret, the wrapped Ki and the researcher session
 *      token are in localStorage beside the settings. A dump that carried them would let its holder
 *      act as the device. Redaction is by FIELD NAME at any depth and by KEY NAME for plain strings,
 *      so a stored shape nobody has written yet is still covered.
 *   2. THE FINGERPRINT IS NOT THE SECRET. It must let two dumps be compared and must not let the
 *      value be recovered — a hash prefix, never a substring.
 *   3. KEYS ONLY ON EXPLICIT REQUEST, into their OWN file. keys.json exists iff includeKeys, and the
 *      manifest says so, so a zip can be judged from its listing alone.
 *   4. ONE BROKEN RECORD DOES NOT KILL THE DUMP. A device whose IndexedDB throws on a record is the
 *      device somebody most wants a dump of.
 *
 * Plus the surface pins: the drawer button, the Feedback button, the warning dialog's shape (ack
 * before confirm; Enter inert), the SHELL entries, and both languages.
 *
 * Run: node test/diagnostics-export.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  redactDeep, redactEntry, redactStorage, isSecretField, isSecretKey, webFingerprint,
  safeName, extFor, mediaKind, docAligned, docSummary, mediaSummary, buildManifest, planEntries,
  zipFileName, gatherDiagnostics, DIAG_FORMAT,
} from '../docs/js/diagnostics.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = read('../docs/js/app.js');
const PANEL = read('../docs/js/researcher-panel.js');
const I18N = read('../docs/js/i18n.js');
const HTML = read('../docs/index.html');
const block = (code) => {
  const at = I18N.indexOf(`\n${code}: {`);
  const rest = I18N.slice(at + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return nxt < 0 ? I18N.slice(at) : I18N.slice(at, at + 1 + nxt);
};
const inBoth = (k) => {
  const re = new RegExp(`^\\s*,?'${k.replace(/\./g, '\\.')}':`, 'm');
  return re.test(block('en')) && re.test(block('id'));
};

/* A real device's localStorage, shape for shape (values invented). */
const SESSION = { inviteId: 'inv1', installId: 'inst-123', installSecret: 'SECRET-TOKEN-ABC', instanceId: 'i9', status: 'approved', accepted: true, wrappedKey: 'WRAPPED-KI-BASE64', pubkey: 'PUB', nickname: "Arnold's laptop" };
const AUTH = { researcher_id: 'r-42', secret: 'RESEARCHER-SESSION-SECRET', google: true };
const STORE = {
  'flextext-ws-settings': JSON.stringify({ vernLang: 'fau', segmentation: false, relayWorker: 'https://x.workers.dev' }),
  'flextext-sync-session': JSON.stringify(SESSION),
  'flextext-researcher-auth': JSON.stringify(AUTH),
  'flextext-lang': 'id',
  'some-future-token': 'PLAIN-STRING-CREDENTIAL',
  'flextext-admin-unlock': '1',
};

test('1. secrets are redacted by field name at any depth, and by key name for plain strings', async () => {
  const { redacted, secrets } = await redactStorage(STORE);
  const s = redacted['flextext-sync-session'];
  assert.equal(s.installId, 'inst-123', 'the non-secret identity survives — that is what makes the dump useful');
  assert.equal(s.nickname, "Arnold's laptop");
  assert.equal(s.installSecret.$redacted, true, 'installSecret is a marker');
  assert.equal(s.wrappedKey.$redacted, true, 'wrappedKey is key material and goes too');
  assert.equal(redacted['flextext-researcher-auth'].researcher_id, 'r-42');
  assert.equal(redacted['flextext-researcher-auth'].secret.$redacted, true);
  assert.equal(redacted['some-future-token'].$redacted, true, 'a plain string under a credential-named key is redacted whole');
  assert.equal(redacted['flextext-lang'], 'id', 'ordinary values are untouched');
  assert.equal(redacted['flextext-admin-unlock'], '1');
  assert.deepEqual(redacted['flextext-ws-settings'], { vernLang: 'fau', segmentation: false, relayWorker: 'https://x.workers.dev' },
    'the settings blob — the whole reason for the export — is complete, segmentation:false included');
  assert.deepEqual(Object.keys(secrets).sort(), ['flextext-researcher-auth', 'flextext-sync-session', 'some-future-token'],
    'exactly the entries that had something redacted are set aside for keys.json');
  assert.equal(secrets['flextext-sync-session'], STORE['flextext-sync-session'], 'set aside VERBATIM');
  const text = JSON.stringify(redacted);
  for (const v of ['SECRET-TOKEN-ABC', 'WRAPPED-KI-BASE64', 'RESEARCHER-SESSION-SECRET', 'PLAIN-STRING-CREDENTIAL'])
    assert.ok(!text.includes(v), `${v} appears nowhere in the redacted output`);
  // the name rules themselves
  for (const f of ['secret', 'installSecret', 'wrappedKey', 'token', 'password', 'privateKey', 'apiKey', 'credential'])
    assert.ok(isSecretField(f), `${f} is a secret field name`);
  for (const f of ['installId', 'instanceId', 'nickname', 'pubkey', 'vernLang', 'relayWorker', 'uploadFolder'])
    assert.ok(!isSecretField(f), `${f} is not`);
  assert.ok(isSecretKey('flextext-researcher-auth') && !isSecretKey('flextext-ws-settings') && !isSecretKey('flextext-sync-session'),
    'the key-name rule covers auth/token names; the session is JSON and handled by field');
  const deep = await redactDeep({ a: [{ b: { token: 'T' } }], c: { secret: '' } });
  assert.equal(deep.value.a[0].b.token.$redacted, true, 'nested inside arrays and objects');
  assert.equal(deep.value.c.secret, '', 'an empty value is not a secret and is left as the (empty) fact');
});

test('2. the fingerprint identifies without revealing', async () => {
  const fp = await webFingerprint('SECRET-TOKEN-ABC');
  assert.match(fp, /^[0-9a-f]{8}$/, 'eight hex characters of SHA-256');
  assert.ok(!'SECRET-TOKEN-ABC'.toLowerCase().includes(fp), 'not a substring of the value');
  assert.equal(await webFingerprint('SECRET-TOKEN-ABC'), fp, 'stable, so two dumps can be compared');
  assert.notEqual(await webFingerprint('SECRET-TOKEN-ABD'), fp, 'and different values differ');
  const e = await redactEntry('k', JSON.stringify({ secret: 'SECRET-TOKEN-ABC' }));
  assert.equal(e.value.secret.sha256_8, fp);
  assert.equal(e.value.secret.bytes, 'SECRET-TOKEN-ABC'.length);
});

test('3. keys.json exists iff asked for, the manifest says so, and the zip is planned from parts', () => {
  const manifest = buildManifest({ app: 'editor', engineVersion: 'v703', includesKeys: false, settings: { segmentation: false } });
  assert.equal(manifest.format, DIAG_FORMAT);
  assert.equal(manifest.includesKeys, false);
  assert.equal(manifest.settings.segmentation, false);
  const rec = { id: 'd1', title: 'Cara tokok sagu', doc: { paragraphs: [] } };
  const media = [{ key: 'd1', rec: { name: 'sago.wav', mimeType: 'audio/wav', blob: new Blob([new Uint8Array(4)]) }, title: 'Cara tokok sagu' },
                 { key: 'segwav:d1', rec: { name: 'sago.converted-NOT-ARCHIVAL.wav', mimeType: 'audio/wav', blob: new Blob([]) }, title: 'Cara tokok sagu' }];
  const without = planEntries({ manifest, docs: [{ rec, xml: '<document/>' }], media, keys: null });
  assert.deepEqual(without.map((e) => e.name),
    ['diagnostics.json', 'docs/001-Cara tokok sagu.json', 'docs/001-Cara tokok sagu.flextext', 'media/001-Cara tokok sagu.wav', 'media/segwav/002-Cara tokok sagu.wav'],
    'manifest, each text twice, recordings by kind — and no keys.json');
  const withKeys = planEntries({ manifest: { ...manifest, includesKeys: true }, docs: [{ rec, xml: null }], media: [], keys: { localStorage: { x: '1' } } });
  assert.deepEqual(withKeys.map((e) => e.name), ['diagnostics.json', 'docs/001-Cara tokok sagu.json', 'keys.json'],
    'keys.json only when asked; a text whose serialisation failed still ships as .json');
  assert.equal(JSON.parse(without[0].data).includesKeys, false);
  // two texts with one title cannot overwrite each other
  const twins = planEntries({ manifest, docs: [{ rec, xml: null }, { rec: { ...rec, id: 'd2' }, xml: null }], media: [], keys: null });
  assert.equal(new Set(twins.map((e) => e.name)).size, twins.length, 'every entry name is unique');
});

test('naming and summaries: safe names, kinds, extensions, and the alignment fact', () => {
  assert.equal(safeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeName('   '), 'untitled');
  assert.equal(safeName('x'.repeat(100)).length, 60);
  assert.equal(extFor('take.MP3', ''), 'mp3');
  assert.equal(extFor('', 'audio/wav'), 'wav');
  assert.equal(extFor('', 'audio/mpeg; codecs=x'), 'mp3');
  assert.equal(extFor('', ''), 'bin');
  assert.deepEqual(mediaKind('abc'), { kind: 'recording', docId: 'abc' });
  assert.deepEqual(mediaKind('consent-prompt:abc'), { kind: 'consent-prompt', docId: 'abc' });
  assert.match(zipFileName('editor', 'v703', new Date('2026-10-07T09:12:00Z')), /^flextext-diagnostics-editor-v703-20261007-0912\.zip$/);
  // the alignment fact, exactly as applyBaseline's docCarriesTime decides it
  assert.equal(docAligned({ paragraphs: [{ segments: [{ baseline: 'x', words: [] }] }] }), false);
  assert.equal(docAligned({ paragraphs: [{ segments: [{ baseline: 'x', words: [], attrs: { 'begin-time-offset': '0', 'end-time-offset': '900' } }] }] }), true, 'FLEx offsets on a phrase');
  assert.equal(docAligned({ segments: [{ start: 0, end: 900 }], paragraphs: [] }), true, 'working spans');
  const rec = { id: 'd', title: 't', doc: { segments: [{ start: 0, end: 5 }, { timePending: true }], paragraphs: [
    { segments: [{ baseline: 'catatan', words: [{ txt: 'catatan', gls: 'note' }, { txt: ':', punct: true }] }] },
    { segments: [{ baseline: '', words: [] }] }] } };
  const s = docSummary(rec);
  assert.equal(s.paragraphs, 2); assert.equal(s.phrases, 2); assert.equal(s.textedPhrases, 1);
  assert.equal(s.words, 1); assert.equal(s.glossedWords, 1);
  assert.equal(s.aligned, true); assert.equal(s.spans, 2); assert.equal(s.spansPending, 1);
  const m = mediaSummary('segwav:d', { name: 'a.wav', mimeType: 'audio/wav', blob: new Blob([new Uint8Array(10)]), peaks: [1], derived: true, srcName: 'a.m4a' });
  assert.equal(m.kind, 'segwav'); assert.equal(m.size, 10); assert.equal(m.hasPeaks, true); assert.equal(m.derived, true);
});

test('4. one unreadable record does not take the export down; every failure is listed', async () => {
  const db = {
    listDocs: async () => [{ id: 'ok', title: 'Fine' }, { id: 'bad', title: 'Broken' }],
    getDoc: async (id) => { if (id === 'bad') throw new Error('IDB read failed'); return { id, title: 'Fine', doc: { paragraphs: [] } }; },
    listMediaKeys: async () => ['ok', 'ghost'],
    getMedia: async (k) => { if (k === 'ghost') throw new Error('blob gone'); return { name: 'ok.wav', mimeType: 'audio/wav', blob: new Blob([new Uint8Array(3)]) }; },
  };
  const deps = { db, app: 'editor', engineVersion: 'v703', buildTag: '', lang: 'en', settings: { segmentation: false },
    serialize: (rec) => { if (rec.id === 'ok') throw new Error('serializer choked'); return '<x/>'; } };
  const got = await gatherDiagnostics(deps, { includeRecordings: true, includeKeys: false });
  const m = got.manifest;
  assert.equal(m.indexedDB.docs.length, 2, 'both texts are listed');
  assert.equal(m.indexedDB.docs[1].unreadable, true, 'the broken one is marked, not dropped');
  assert.equal(m.indexedDB.docs[0].flextext, false, 'a serialiser failure is recorded on the row');
  assert.equal(got.docs.length, 1, 'and the readable one still ships');
  assert.equal(m.indexedDB.media.length, 2);
  assert.equal(m.indexedDB.media[1].unreadable, true);
  assert.equal(got.media.length, 1);
  assert.equal(m.indexedDB.docs[0].hasMedia, true, 'the recording is matched to its text');
  const where = m.errors.map((e) => e.where);
  assert.ok(where.includes('db.getDoc bad') && where.includes('serialize ok') && where.includes('db.getMedia ghost'),
    `every failure is named in errors: ${where.join(', ')}`);
  assert.equal(m.settings.segmentation, false, 'and the setting that explains the report is right there');
  assert.equal(got.keys, null, 'no keys were asked for');
  const withKeys = await gatherDiagnostics(deps, { includeRecordings: false, includeKeys: true });
  assert.ok(withKeys.keys && /non-extractable/.test(withKeys.keys.installPrivateKey), 'keys.json says why the private key cannot be in it');
  assert.equal(withKeys.media.length, 0, 'recordings left out when unticked');
  assert.equal(withKeys.manifest.indexedDB.media.length, 2, '…but still inventoried');
});

test('the surfaces: drawer button, Feedback button, the warning dialog, SHELLs, both languages', () => {
  const fn = (src, name) => { const at = src.indexOf(`function ${name}(`); const end = src.indexOf('\n}', at); return src.slice(at, end + 2); };
  const drawer = fn(APP, 'applyAdminDrawer');
  assert.match(drawer, /btn-admin-diag/, 'the admin drawer offers the export');
  assert.match(drawer, /openDiagnosticsExport\(\)/, '…and it opens the dialog');
  assert.ok(APP.indexOf('btn-admin-diag') < APP.indexOf('btn-admin-unpair', APP.indexOf('btn-admin-diag')), 'listed before the recovery controls: it changes nothing');
  assert.match(PANEL, /\$\{deps\.exportDiagnostics \? `<button type="button" class="secondary-btn" data-diag>/, 'the panel Feedback window offers it when the host provides it');
  assert.equal((APP.match(/exportDiagnostics: \(\) => openDiagnosticsExport\(\)/g) || []).length, 2, 'both panel hosts (editor + standalone Researcher) provide it');
  const dlg = fn(APP, 'openDiagnosticsExport');
  assert.match(dlg, /data-diag="audio" checked/, 'recordings default ON');
  assert.match(dlg, /<input type="checkbox" data-diag="keys">/, 'keys default OFF');
  assert.match(dlg, /if \(!await confirmKeysExport\(\)\) q\('keys'\)\.checked = false;/, 'ticking keys opens the warning and a dismissal un-ticks it');
  assert.match(dlg, /estimateMediaBytes\(db\)/, 'the recordings size is shown before the choice');
  const warn = fn(APP, 'confirmKeysExport');
  assert.match(warn, /modal-card modal-warn/, 'the warning is visibly a warning');
  assert.match(warn, /data-kc="yes" disabled/, 'confirm is disabled until…');
  assert.match(warn, /yes\.disabled = !ack\.checked/, '…the "I understand" box is ticked');
  assert.match(warn, /if \(e\.key === 'Escape'\)/, 'Escape dismisses');
  assert.doesNotMatch(warn, /'Enter'/, '⚠ Enter does NOT confirm — a held key must not export credentials');
  assert.match(fn(APP, 'diagDeps'), /segTimes: true/, 'the dumped .flextext always carries the offsets, whatever the device\'s mode');
  for (const sw of ['../docs/sw.js', '../satellites/text-recorder/sw.js', '../satellites/audio-segmenter/sw.js', '../satellites/consent-collector/sw.js', '../paragraph-analysis/sw.js'])
    assert.match(read(sw), /js\/diagnostics\.js'/, `${sw} precaches the module (offline is where it is needed)`);
  for (const k of ['admin.diag', 'diag.title', 'diag.intro', 'diag.recordings', 'diag.recordingsNote', 'diag.keys', 'diag.keysNote', 'diag.keysWarnTitle',
                   'diag.keysWarn', 'diag.keysAck', 'diag.keysYes', 'diag.build', 'diag.stage.device', 'diag.stage.texts', 'diag.stage.media', 'diag.stage.zip',
                   'diag.done', 'diag.failed', 'diag.tooBig', 'panel.feedback.diag', 'panel.rel.new.diagExport'])
    assert.ok(inBoth(k), `${k} in BOTH languages`);
});

test('the aligned-but-off note: only the classic textarea, only an explicit false, only an aligned text', () => {
  const fn = (src, name) => { const at = src.indexOf(`function ${name}(`); const end = src.indexOf('\n}', at); return src.slice(at, end + 2); };
  const note = fn(APP, 'applyAlignedNote');
  assert.match(note, /const on = !!classic && settings\.segmentation === false && !!current && docCarriesTime\(current\.doc\);/,
    '⚠ === false, never a truthiness check: unset means ON and a default device must never see this');
  assert.match(note, /Sync\.hasSession\(\) \? 'baseline\.alignedOffPaired' : 'baseline\.alignedOffSolo'/, 'says who can turn the mode on');
  assert.match(HTML, /<p id="baseline-aligned-note" class="note" hidden><\/p>/, 'its own element, not the pinned hint span');
  const entry = APP.slice(APP.indexOf("if (tab === 'baseline') {"), APP.indexOf("await ensurePeaks(stripsFor"));
  assert.match(entry, /applyBaselineHint\(\);\s*\n\s*applyAlignedNote\(false\);/, 'cleared on entry');
  const classic = APP.slice(APP.indexOf("await ensurePeaks(stripsFor"), APP.indexOf("healFlatSegments(current && current.doc);\n    renderGloss();"));
  assert.match(classic, /getBaselineParagraphs\(current\.doc\)\.join\('\\n'\);\s*\n\s*applyAlignedNote\(true\);/, 'set in the classic branch, after the textarea is filled');
  assert.match(fn(APP, 'applyLiveSettings'), /applyAlignedNote\(baselineShowsTextarea\(\)\)/, 'a pushed setting re-evaluates it live');
  for (const k of ['baseline.alignedOffPaired', 'baseline.alignedOffSolo']) assert.ok(inBoth(k), `${k} in BOTH languages`);
});
