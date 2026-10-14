/* Local records of FLEx texts (desktop-flex; plans/flex-desktop-segmenter.md §4.4, §8.4): the record
 * id the media store can see, the re-open rule that never discards local work silently, which link
 * the Segmenter cuts, and the FLEx fix a later Save carries. Made-up fixtures.
 *
 * Run: node test/flex-records.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flexDocId, reopenDecision, recordingLink, pendingMediaFix } = await import('../docs/js/flex-ops.js');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('flexDocId');
const g = '0c4f2a1e-1111-4222-8333-444455556666';
const a = flexDocId('Sample Project', g);
ok(!a.includes(':'), 'no colon — db.mediaKeys ignores keys with one, so the recording would never count');
ok(a.startsWith('flex-' + g + '-'), 'readable: the text guid is in it');
ok(a === flexDocId('Sample Project', g), 'deterministic');
ok(a !== flexDocId('Sample Project - copy', g), 'a disposable copy (same text guids) gets its own record');
ok(/^[A-Za-z0-9-]+$/.test(flexDocId('odd:name/with\\stuff', 'g:1')), 'only safe characters, whatever the project is called');

console.log('reopenDecision');
ok(reopenDecision(null, 'r1') === 'new' && reopenDecision({ id: 'x' }, 'r1') === 'new', 'no FLEx record yet → new');
const rec = (modified, loadedAt, baseRev, extra = {}) => ({ id: 'x', modified, flex: { loadedAt, baseRev }, ...extra });
ok(reopenDecision(rec(100, 100, 'r1'), 'r1') === 'keep', 'nothing anywhere → keep');
ok(reopenDecision(rec(200, 100, 'r1'), 'r1') === 'keep', 'local work, FLEx unchanged → keep the local work');
ok(reopenDecision(rec(100, 100, 'r1'), 'r2') === 'replace', 'nothing here, FLEx changed → load FLEx');
ok(reopenDecision(rec(200, 100, 'r1'), 'r2') === 'ask', 'both changed → ask');
ok(reopenDecision(rec(100, 100, 'r1', { matchDraft: { spans: [] } }), 'r2') === 'ask', 'a Segmenter draft is local work too');
ok(reopenDecision({ id: 'x', modified: 5, flex: { baseRev: 'r1' } }, 'r2') === 'ask', 'no loadedAt (older record) → treated as local work: the safe side');

console.log('recordingLink');
ok(recordingLink([]) === null && recordingLink(undefined) === null, 'no links → null');
const L1 = { uriGuid: 'u1', uri: 'C:\\x\\a.wav' }, L2 = { uriGuid: 'u2', uri: 'b.wav', url: '/media/t' };
ok(recordingLink([L1, L2]) === L2, 'one that resolves here wins');
ok(recordingLink([L1, { uriGuid: 'u3' }]) === L1, 'else the first');
ok(recordingLink([{ uriGuid: 'u4', exists: true }]).uriGuid === 'u4', 'list_texts shape (exists) counts too');

console.log('pendingMediaFix');
ok(Object.keys(pendingMediaFix(null)).length === 0 && Object.keys(pendingMediaFix({})).length === 0, 'nothing pending');
ok(JSON.stringify(pendingMediaFix({ mediaFix: { uriGuid: 'u1', path: 'D:\\r\\a.wav' } })) === JSON.stringify({ relink: { uriGuid: 'u1', path: 'D:\\r\\a.wav' } }), 'a link that points nowhere → relink');
ok(JSON.stringify(pendingMediaFix({ mediaFix: { uriGuid: null, path: 'D:\\r\\a.wav' } })) === JSON.stringify({ media: 'D:\\r\\a.wav' }), 'no link → attach (diffFlexDoc adds it only with times)');
ok(Object.keys(pendingMediaFix({ linkOk: true, mediaFix: { uriGuid: 'u1', path: 'p' } })).length === 0, 'FLEx\'s link resolves again → nothing to fix');

if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log('\nall ok');
