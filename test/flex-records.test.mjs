/* Local records of FLEx texts (desktop-flex; plans/flex-desktop-segmenter.md §4.4, §8.4): the record
 * id the media store can see, the re-open rule that never discards local work silently, which link
 * the Segmenter cuts, and the FLEx fix a later Save carries. Made-up fixtures.
 *
 * Run: node test/flex-records.test.mjs */
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flexDocId, isFlexDocOf, reopenDecision, hasLocalWork, keepTimeEstimates, recordingLink, pendingMediaFix } = await import('../docs/js/flex-ops.js');
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

console.log('isFlexDocOf (Reset all: this project\'s records, never a copy\'s)');
ok(isFlexDocOf(a, 'Sample Project'), 'a text of this project');
ok(!isFlexDocOf(a, 'Sample Project - copy') && !isFlexDocOf(flexDocId('Sample Project - copy', g), 'Sample Project'), 'not a copy\'s, either way round');
ok(!isFlexDocOf('0f8e2a52-6c1d-4f3b-9a57-2d6e4b1c9a10', 'Sample Project'), 'never the app\'s own records');
ok(!isFlexDocOf(flexDocId('Sample Project', ''), 'Sample Project'), 'not an id with no text in it');

console.log('reopenDecision + hasLocalWork');
ok(reopenDecision(null, 'r1') === 'new' && reopenDecision({ id: 'x' }, 'r1') === 'new', 'no FLEx record yet → new');
// a FLEx text's record as open_text makes it: base = the doc as read, one phrase per line
const clone = (x) => JSON.parse(JSON.stringify(x));
const W = (txt, gls = '') => ({ guid: 'w-' + txt, txt, punct: false, gls, flex: { analysisGuid: 'an-' + txt, analysisKind: gls ? 'gloss' : 'wordform', index: 0 } });
const ln = (pg, sg, words, free = '') => ({ guid: 'ln-' + sg, paraOf: pg, flex: { paraGuid: pg, segGuid: sg },
  segments: [{ attrs: { guid: sg }, baseline: words.map((w) => w.txt).join(' '), words, free, freeLang: free ? 'en' : null }] });
const fdoc = () => ({ title: 'T', vernLang: 'xx', analLang: 'en', flex: { textGuid: 't1', media: [{ uriGuid: 'u1', uri: 'a.wav', url: '/media/a' }], ws: { vern: 'xx', anal: 'en' } },
  paragraphs: [ln('P1', 's1', [W('aaa', 'A'), W('bbb')], 'one'), ln('P2', 's2', [W('ccc')])],
  segments: [{ start: 0, end: 1000 }, { start: 1000, end: 2000 }] });
const rec = (baseRev, change = null, extra = {}) => {
  const base = fdoc(), doc = clone(base);
  if (change) change(doc);
  return { id: 'x', modified: 200, doc, ...extra, flex: { loadedAt: 100, baseRev, base, ...(extra.flex || {}) } };
};
ok(!hasLocalWork(rec('r1')) && reopenDecision(rec('r1'), 'r1') === 'replace',
  'nothing here, FLEx unchanged → FLEx read again (an older build\'s record, a gloss corrected in FLEx)');
ok(reopenDecision(rec('r1'), 'r2') === 'replace', 'nothing here, FLEx changed → FLEx');
ok(reopenDecision(rec('r1', null, { modified: 999 }), 'r1') === 'replace', 'a Done that changed nothing is no work: the diff decides, not the timestamp');
const glossed = rec('r1', (d) => { d.paragraphs[1].segments[0].words[0].gls = 'C'; });
ok(hasLocalWork(glossed) && reopenDecision(glossed, 'r1') === 'keep', 'a gloss typed here, FLEx unchanged → keep the local work');
ok(reopenDecision(glossed, 'r2') === 'ask', 'both changed → ask');
const timed = rec('r1', (d) => { d.segments[1] = { start: 1000, end: 2500 }; });
ok(hasLocalWork(timed) && reopenDecision(timed, 'r1') === 'keep', 'times changed here → work');
ok(reopenDecision(rec('r1', null, { matchDraft: { spans: [] } }), 'r1') === 'keep', 'a Segmenter draft is local work too');
ok(reopenDecision(rec('r1', null, { flex: { dirty: true } }), 'r2') === 'ask', 'an undone save to FLEx is local work too');
ok(hasLocalWork({ id: 'x', doc: fdoc(), flex: { baseRev: 'r1' } }) && reopenDecision({ id: 'x', doc: fdoc(), flex: { baseRev: 'r1' } }, 'r2') === 'ask',
  'no base to diff against → treated as local work: the safe side');
ok(reopenDecision(glossed, 'r1', false) === 'replace' && reopenDecision(rec('r1'), 'r1', true) === 'keep', 'the caller may pass what it already judged');

console.log('keepTimeEstimates');
{
  const was = fdoc();
  was.segments = [{ start: 0, end: 1000.4, guess: [null, 1000.4], timeEstimated: true, estSource: 'edit' }, { start: 1000.4, end: 2000, guess: [1000.4, null], timeEstimated: true, estSource: 'edit' }];
  const fresh = fdoc();
  fresh.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 1800 }];
  keepTimeEstimates(was, fresh);
  ok(JSON.stringify(fresh.segments[0].guess) === '[null,1000.4]' && fresh.segments[0].timeEstimated && fresh.segments[0].estSource === 'edit',
    'FLEx has the phrase\'s times as they were here (to the ms it stores) → its estimated edge stays an estimate');
  ok(!fresh.segments[1].guess && !fresh.segments[1].timeEstimated, 'times FLEx holds differently → FLEx\'s, as measurements');
  const moved = fdoc();
  moved.paragraphs.reverse();   // s2 first now
  moved.segments = [{ start: 1000, end: 2000 }, { start: 0, end: 1000 }];
  keepTimeEstimates(was, moved);
  ok(JSON.stringify(moved.segments[0].guess) === '[1000.4,null]' && JSON.stringify(moved.segments[1].guess) === '[null,1000.4]',
    'matched by the phrase, never by position');
}

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
ok(Object.keys(pendingMediaFix({ linkOk: true, mediaFix: { uriGuid: null, path: 'p' } })).length === 0, 'a link attached in FLEx since (or a redone attach) → nothing to attach');

if (fail) { console.error(`\n${fail} FAILED`); process.exit(1); }
console.log('\nall ok');
