/* CLEANUP KEEPS EVERY COPY THAT HOLDS SOMETHING THE KEPT ONES LACK (plans/move-upload-guards.md G2).
 *
 * WHY THIS TEST EXISTS: Files ▾ "Clean up old backups" kept only the newest .flextext by Drive
 * modifiedTime — UPLOAD time — and offered every other copy to the trash in one click. On a real
 * estate that would have trashed the good copy of several texts: a placeholder that landed last, or
 * a queued copy damaged on the device (all NUL) and sent days later, sorted as newest. The fixtures
 * below are shaped like those incidents (anonymised): the same counts, none of the words.
 *
 * The real cleanupPlan, copyStats and their helpers are LIFTED out of researcher-panel.js and run
 * over copies built by the REAL serializer and counted by the REAL flextextStats.
 *
 * Run: node --test test/cleanup-keeps-richest.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flextextStats, serializeFlextext, makeDoc, reconcileBaseline } = await import('../docs/js/flextext.js');

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const grab = (re, what) => { const m = panel.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const helpers = grab(/const STAT_ALL = [\s\S]*?\nfunction statsHaveContent\(s\) \{[\s\S]*?\n\}/, 'the stat helpers');
const copyStatsSrc = grab(/const copyStatsCache = new Map\(\);[\s\S]*?\nasync function copyStats\(files, opts = \{\}\) \{[\s\S]*?\n\}/, 'copyStats');
const planSrc = grab(/function cleanupPlan\(\{ backups, stats, deviceIds, keepIds \}\) \{[\s\S]*?\n\}/, 'cleanupPlan');
const roleSrc = grab(/const SOURCE_AUDIO_ROLES = [\s\S]*?const isFlextextName = [^;]*;/, 'the role sets');
const ccSrc = grab(/function cleanupCandidates\(allFiles\) \{[\s\S]*?\n\}/, 'cleanupCandidates');

const lift = (Researcher) => new Function('Researcher', 'flextextStats', 'MANIFEST_NAME',
  `${roleSrc}\n${ccSrc}\n${helpers}\n${copyStatsSrc}\n${planSrc}\nreturn { cleanupPlan, copyStats, statsRicher, statsDominate, STAT_CONTENT, STAT_ALL, cleanupCandidates, PROTECTED_ROLES, isFlextextName, hasRole };`)(
  Researcher, flextextStats, 'flextext-manifest.json');

/* A copy of a text: `lines` of baseline, optional glosses. Same `guid` = the same FLEx text. */
const xml = (guid, lines, { glossed = 0 } = {}) => {
  const d = makeDoc({ vernLang: 'qaa', analLang: 'id' }, 'Cerita');
  d.textAttrs.guid = guid;
  reconcileBaseline(d, lines.length ? lines : ['']);
  let g = glossed;
  for (const p of d.paragraphs) for (const sg of p.segments) for (const w of sg.words) if (g > 0 && !w.punct) { w.gls = 'x'; g--; }
  return serializeFlextext(d, { vernLang: 'qaa', analLang: 'id' });
};
const lines = (n, prefix = 'kata') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1} lagi`);
let seq = 0;
const copy = (day, body, extra = {}) => ({ id: 'f' + (++seq), name: `Cerita 2026-09-${String(day).padStart(2, '0')}.flextext`,
  modified: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, size: body.length, role: '', sha256: extra.sha256 || '', body, ...extra });
const statsOf = (files) => new Map(files.map((f) => {
  const st = flextextStats(f.body);
  return [f.id, f.unchecked ? { state: 'unchecked', why: 'fetch' } : { state: st.ok ? 'ok' : st.damaged ? 'damaged' : 'unreadable', stats: st }];
}));
const { cleanupPlan, copyStats, statsRicher, STAT_CONTENT, cleanupCandidates, PROTECTED_ROLES, isFlextextName, hasRole } = lift({});
const plan = (files, { deviceIds = [], keepIds = [] } = {}) =>
  cleanupPlan({ backups: files, stats: statsOf(files), deviceIds: new Set(deviceIds), keepIds: new Set(keepIds) });
const verdictOf = (p, f) => p.rows.find((r) => r.file.id === f.id).verdict;

test('an empty placeholder that landed LAST does not cost the transcription its place', () => {
  const transcription = copy(3, xml('G-A', lines(21)));
  const placeholder = copy(9, xml('G-NEW', []));           // a fresh guid, nothing in it, newest by upload
  const p = plan([placeholder, transcription]);
  assert.equal(verdictOf(p, transcription), 'keepNewest', 'the newest copy WITH CONTENT is the one protected');
  assert.equal(verdictOf(p, placeholder), 'trashLess', 'and the empty placeholder is outranked, whatever its guid');
});

test('a 25-line copy older than a 4-line copy of the same text is kept', () => {
  const rich = copy(2, xml('G-A', lines(25)));
  const poor = copy(8, xml('G-A', lines(4)));
  const p = plan([poor, rich]);
  assert.equal(verdictOf(p, poor), 'keepNewest');
  assert.equal(verdictOf(p, rich), 'keepRicher', 'it has more of something than every kept copy');
  assert.deepEqual(p.trash, []);
});

test('a damaged copy is trashed EVEN WHEN IT IS THE NEWEST — the damaged file was the newest', () => {
  const good = copy(4, xml('G-A', lines(6)));
  const nul = copy(10, '\u0000'.repeat(489));
  const p = plan([nul, good]);
  assert.equal(verdictOf(p, nul), 'trashEmpty');
  assert.equal(verdictOf(p, good), 'keepNewest');
});

test('...but never a copy a DEVICE relies on as its backup, damaged or dominated', () => {
  const good = copy(4, xml('G-A', lines(6)));
  const nul = copy(10, '\u0000'.repeat(489));
  const older = copy(1, xml('G-A', lines(2)));
  const p = plan([nul, good, older], { deviceIds: [nul.id, older.id] });
  assert.equal(verdictOf(p, nul), 'keepDevice', 'trashing it would make that device believe in a backup Drive no longer shows');
  assert.equal(verdictOf(p, older), 'keepDevice');
  assert.deepEqual(p.trash, []);
});

test('byte-identical copies go; a copy a delivery used stays', () => {
  const body = xml('G-A', lines(5));
  const a = copy(7, body, { sha256: 'aaa' });
  const b = copy(5, body, { sha256: 'aaa' });
  const c = copy(3, xml('G-A', lines(3)));
  const p = plan([a, b, c], { keepIds: [c.id] });
  assert.equal(verdictOf(p, b), 'trashSame');
  assert.equal(verdictOf(p, c), 'keepRecorded', 'the delivered copy is extra-protected (history is never RELIED on)');
});

test('unknown means keep: not fetched, unreadable, or over the caps', () => {
  const good = copy(6, xml('G-A', lines(9)));
  const unread = copy(4, xml('G-A', lines(1)).replace('<phrases>', '<phrases><broken'));
  const notFetched = copy(2, xml('G-A', lines(1)), { unchecked: true });
  const p = plan([good, unread, notFetched]);
  assert.equal(verdictOf(p, unread), 'keepUnknown');
  assert.equal(verdictOf(p, notFetched), 'keepUnknown');
});

test('different texts (guids) each keep their best; a same-text copy with less goes', () => {
  const a1 = copy(9, xml('G-A', lines(5))), a0 = copy(3, xml('G-A', lines(2)));
  const b1 = copy(8, xml('G-B', lines(4, 'lain'))), b0 = copy(2, xml('G-B', lines(1, 'lain')));
  const p = plan([a1, b1, a0, b0]);
  assert.equal(verdictOf(p, a1), 'keepNewest');
  assert.equal(verdictOf(p, b1), 'keepRicher', 'a different guid is never compared with the newest');
  assert.equal(verdictOf(p, a0), 'trashLess');
  assert.equal(verdictOf(p, b0), 'trashLess');
});

test('cleanup uses EVERY measure, so the copy from before a join is kept (a false keep is cheap)', () => {
  const before = copy(3, xml('G-A', ['satu dua', 'tiga empat']));
  const after = copy(6, xml('G-A', ['satu dua tiga empat']));
  const p = plan([after, before]);
  assert.equal(verdictOf(p, before), 'keepRicher', 'it has more lines — cleanup cannot know a join from a loss');
  const sa = flextextStats(after.body), sb = flextextStats(before.body);
  assert.equal(statsRicher(sb, sa, STAT_CONTENT), false, '...but by CONTENT the two are equal, which is what a move reads');
});

test('everything a plan trashes is a bare .flextext backup — never a source file, consent record or manifest', () => {
  const rows = [copy(9, '\u0000\u0000'), copy(5, xml('G-A', lines(2))), copy(1, xml('G-A', lines(1)))];
  const p = plan(rows);
  for (const id of p.trash) {
    const f = rows.find((r) => r.id === id);
    assert.ok(isFlextextName(f) && !hasRole(f, PROTECTED_ROLES));
  }
  assert.ok(cleanupCandidates([...rows, { id: 'm', name: 'flextext-manifest.json', role: 'manifest', modified: '2026-09-30' }])
    .every((f) => f.id !== 'm'), 'the MAY-GO list is unchanged');
});

test('copyStats: identical copies fetched once, the cap reports "not checked", the copy to SEND is never capped', async () => {
  const fetched = [];
  const bodies = new Map();
  const Researcher = { fetchDriveFile: async (id) => {
    fetched.push(id);
    if (id === 'gone') throw new Error('file_fetch_failed_404');
    if (id === 'flaky') throw new Error('file_fetch_failed_502');
    return { text: async () => bodies.get(id) };
  } };
  const { copyStats: cs } = lift(Researcher);
  const body = xml('G-A', lines(3));
  const files = [];
  for (let i = 0; i < 15; i++) {
    const f = { id: 'c' + i, name: `x${i}.flextext`, size: 100, sha256: i < 3 ? 'same' : 'h' + i };
    bodies.set(f.id, body); files.push(f);
  }
  const big = { id: 'big', name: 'big.flextext', size: 50 * 1024 * 1024, sha256: 'big' };
  bodies.set('big', body);
  files.push(big, { id: 'z', name: 'old.zip', size: 10 }, { id: 'gone', name: 'g.flextext', size: 1, sha256: 'g' },
             { id: 'flaky', name: 'f.flextext', size: 1, sha256: 'f' });
  const out = await cs(files, { need: ['big', 'gone', 'flaky'] });
  assert.equal(fetched.filter((id) => id.startsWith('c0') || id === 'c1' || id === 'c2').length, 1, 'three identical backups, one fetch');
  assert.equal(out.get('c1').state, 'ok', 'and every one of them gets the answer');
  assert.ok([...out.values()].some((e) => e.state === 'unchecked' && e.why === 'cap'), 'past the cap a copy is "not checked"');
  assert.equal(out.get('big').state, 'ok', 'the copy that will be SENT is fetched whatever its size');
  assert.deepEqual(out.get('z'), { state: 'unchecked', why: 'zip' });
  assert.equal(out.get('gone').state, 'missing', 'a 404 is "missing" — the lookup-by-id answer');
  assert.deepEqual(out.get('flaky'), { state: 'unchecked', why: 'fetch' }, 'any other failure is unknown, never damaged');
  const before = fetched.length;
  await cs([{ id: 'other-id', name: 'again.flextext', size: 100, sha256: 'same' }]);
  assert.equal(fetched.length, before, 'a later check reuses the session cache by content hash');
});

test('the review trashes exactly the plan, re-checks delivery first, and stays owner-only', () => {
  const m = grab(/async function cleanupReviewModal\(wrap\) \{[\s\S]*?\n\}/, 'cleanupReviewModal');
  const planAt = m.indexOf('const plan = cleanupPlan(');
  const trashAt = m.indexOf('Researcher.trashFiles(');
  assert.ok(planAt > 0 && trashAt > planAt, 'a plan is built before anything is trashed');
  assert.match(m, /Researcher\.trashFiles\(plan\.trash, 'backup cleanup'\)/, 'and only plan.trash goes');
  assert.ok(m.indexOf('if (cleanupBlocked(docId))', m.indexOf('go.addEventListener')) > 0, 're-checked at the moment of the act');
  assert.match(m, /deviceIds: deviceFileIds\(docId\), keepIds: recordedFileIds\(docId\)/);
  assert.match(panel, /const dead = viaMember \? \[\] : cleanupCandidates\(ownFiles\)/, 'a member is never offered it');
  assert.match(panel, /cleanupReviewModal\(wrap2\)\.catch/, 'the row opens the review, not a one-click trash');
  assert.ok(!/confirmModal\(t\('panel\.dl\.cleanupConfirm'/.test(panel), 'the one-click confirm is gone');
});
