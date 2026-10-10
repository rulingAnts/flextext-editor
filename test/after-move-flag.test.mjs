/* THE "NEWER COPY AFTER THE MOVE" FLAG MUST NOT CRY WOLF, OR BLAME A DEVICE (plans/move-upload-guards.md §5.4, §12).
 *
 * WHY THIS TEST EXISTS: the first build flagged any .flextext that landed after a move with bytes
 * different from the copy sent — and wrote a lasting "submitted" History row under the SOURCE device.
 * The review found it fired on the normal paths:
 *   - every move of an untouched delivery: the release uploads the text first (it was never uploaded,
 *     by G4), and a parse-and-reserialize is not byte-stable, so the same content has new bytes;
 *   - the DESTINATION's own auto-backups while the source was still offline: only its latest upload
 *     was excluded, so its earlier ones were toasted as the source's work.
 * The flag now compares what the copies HOLD with what the destination now holds (its own latest
 * backup, or the copy it was sent), flags only a copy holding MORE, and names no device the panel
 * cannot know.
 *
 * The real flagNewerAfterMove is LIFTED with the real copyStats, flextextStats and deviceItems.
 *
 * Run: node --test test/after-move-flag.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flextextStats, serializeFlextext, parseFlextext, makeDoc, reconcileBaseline, makeSegment } = await import('../docs/js/flextext.js');

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const grab = (re, what) => { const m = panel.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const roleSrc = grab(/const SOURCE_AUDIO_ROLES = [\s\S]*?const isFlextextName = [^;]*;/, 'the role sets');
const helpers = grab(/const STAT_ALL = [\s\S]*?\nfunction statsHaveContent\(s\) \{[\s\S]*?\n\}/, 'the stat helpers');
const copyStatsSrc = grab(/const copyStatsCache = new Map\(\);[\s\S]*?\nasync function copyStats\(files, opts = \{\}\) \{[\s\S]*?\n\}/, 'copyStats');
const devItemsSrc = grab(/function deviceItems\(instanceId, docId\) \{[\s\S]*?\n\}/, 'deviceItems');
const devIdsSrc = grab(/function deviceFileIds\(docId\) \{[\s\S]*?\n\}/, 'deviceFileIds');
const flagSrc = grab(/async function flagNewerAfterMove\(docId, mv\) \{[\s\S]*?\n\}/, 'flagNewerAfterMove');

const SET = { vernLang: 'qaa', analLang: 'id' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const xml = (n, { glossed = 0, guid = 'G' } = {}) => {
  const d = makeDoc(SET, 'Cerita'); d.textAttrs.guid = guid;
  reconcileBaseline(d, n ? Array.from({ length: n }, (_, i) => `kata ${i + 1} lagi`) : ['']);
  let g = glossed;
  for (const p of d.paragraphs) for (const s of p.segments) for (const w of s.words) if (g > 0 && !w.punct) { w.gls = 'x'; g--; }
  return serializeFlextext(d, SET);
};
const file = (id, day, body, extra = {}) => ({ id, name: `Cerita ${id}.flextext`, modified: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`,
  size: body.length, sha256: sha(body), role: '', body, ...extra });

const run = async ({ files, destItem = null }) => {
  const toasts = [], events = [];
  const bodies = new Map(files.map((f) => [f.id, f.body]));
  const lastData = { instances: [{ instance_id: 'dst', installs: [{ last_seen_at: 9, inventory: { items: destItem ? [{ id: 'doc1', ...destItem }] : [] } }] }] };
  const env = {
    Researcher: { listTextFiles: async () => ({ files }), currentAccountId: () => 'acct',
      fetchDriveFile: async (id) => ({ text: async () => bodies.get(id) }) },
    flextextStats, MANIFEST_NAME: 'flextext-manifest.json', lastData,
    instanceNick: (x) => ({ src: 'Phone-A', dst: 'Phone-B' })[x], deps: { toast: (m) => toasts.push(m) },
    t: (k, v) => k + (v ? JSON.stringify(v) : ''), histWhen: () => 'WHEN', recordEvents: (_a, ev) => events.push(...ev),
  };
  const flag = new Function(...Object.keys(env), `${roleSrc}\n${helpers}\n${copyStatsSrc}\n${devItemsSrc}\n${devIdsSrc}\n${flagSrc}\nreturn flagNewerAfterMove;`)(...Object.values(env));
  await flag('doc1', { from: 'src', to: 'dst', title: 'Cerita', at: Date.parse('2026-10-01T00:00:00Z'), sentFileId: 'sent', sentModified: '2026-09-20T00:00:00Z' });
  return { toasts, events };
};

test('an untouched delivery\'s release re-upload (same content, new bytes) is NOT newer work', async () => {
  const delivered = xml(6);
  const reser = serializeFlextext(parseFlextext(delivered, SET).texts[0], SET, { producedBy: 'another engine' });
  assert.notEqual(sha(reser), sha(delivered), 'the bytes really do differ');
  const r = await run({ files: [file('sent', 1, delivered, { modified: '2026-09-20T00:00:00Z' }), file('release', 2, reser)] });
  assert.equal(r.toasts.length, 0);
  assert.equal(r.events.length, 0);
});

test('the destination\'s OWN earlier backups are not flagged — its latest holds at least as much', async () => {
  const sent = xml(4);
  const f2 = xml(6), f3 = xml(9);   // the new device's coworker kept working while the old device was offline
  const r = await run({ files: [file('sent', 1, sent, { modified: '2026-09-20T00:00:00Z' }), file('f2', 2, f2), file('f3', 3, f3)],
    destItem: { uploadState: 'uploaded', uploadedFileId: 'f3' } });
  assert.equal(r.toasts.length, 0, 'f2 holds less than f3, which the new device reports as its own');
});

test('a copy holding MORE than the new device has is flagged once — neutrally, with a durable row', async () => {
  const sent = xml(4);
  const finalFromSource = xml(25, { glossed: 10 });   // offline work the old device sent on its way out
  const r = await run({ files: [file('sent', 1, sent, { modified: '2026-09-20T00:00:00Z' }), file('final', 2, finalFromSource)] });
  assert.equal(r.toasts.length, 1);
  assert.match(r.toasts[0], /panel\.move\.newerAfter/);
  assert.ok(!/Phone-A/.test(r.toasts[0]), '⚠ the old device is not named: the panel cannot know which device sent it');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].fileId, 'final');
  assert.equal(r.events[0].afterMove, true);
  assert.notEqual(r.events[0].instanceId, 'src', 'not a "submitted" row under the old device');
  assert.equal(r.events[0].device, '', 'and no device name on the row');
});

test('a placeholder CUT into lines on the old device (no words, 32 timings) is flagged too', async () => {
  const d = makeDoc(SET, 'Cerita');
  reconcileBaseline(d, Array.from({ length: 32 }, () => ''));
  for (const p of d.paragraphs) p.segments = [makeSegment('', [])];   // segmentation mode: a blank line is a real phrase
  d.segments = Array.from({ length: 32 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 900 }));
  const cut = serializeFlextext(d, SET, { segTimes: true, mediaName: 'a.wav' });
  assert.equal(flextextStats(cut).timed, 32);
  const r = await run({ files: [file('sent', 1, xml(0), { modified: '2026-09-20T00:00:00Z' }), file('cut', 2, cut)] });
  assert.equal(r.toasts.length, 1, 'the second incident shape: the work is all in the timings');
});

test('the words: no {from}, in English AND Indonesian', () => {
  for (const k of ['panel.move.newerAfter', 'panel.hist.afterMove']) {
    const rows = i18n.match(new RegExp(`^  '${k.replace(/\./g, '\\.')}': .*$`, 'gm')) || [];
    assert.equal(rows.length, 2, `${k} in both languages`);
    for (const row of rows) assert.ok(!/\{from\}/.test(row), `${k} names no source device`);
  }
});
