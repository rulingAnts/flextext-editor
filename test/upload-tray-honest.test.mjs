/* WHAT THE COWORKER AND THE RESEARCHER ARE TOLD ABOUT AN UPLOAD MUST BE TRUE (plans/move-upload-guards.md §12).
 *
 * WHY THIS TEST EXISTS — the smaller findings of the review, each a sentence that was false:
 *   - a queued copy HELD as damaged (G5) showed in the tray only as "1 file(s) waiting to upload —
 *     will retry shortly" (the reason lived in a list that opens only with two items or more), and
 *     "Send now" left it alone until its six-hour back-off was up;
 *   - "could not be prepared" was replaced at once by "Added to the upload queue" — nothing was queued;
 *   - a coworker was shown "could not be prepared" for an upload the RESEARCHER asked for remotely;
 *   - a delivered text the coworker deliberately emptied was reported "as delivered";
 *   - History showed an "Uploaded file" link on "assigned" rows (which now carry the SENT file's id).
 *
 * Run: node --test test/upload-tray-honest.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { makeDoc, reconcileBaseline, getBaselineParagraphs, checkFlextextBytes } = await import('../docs/js/flextext.js');

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const grab = (src, re, what) => { const m = src.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const A = (re, what) => grab(app, re, what);

test('a HELD copy is visible in the tray as itself, and "Send now" rebuilds it now', async () => {
  const g5 = A(/async function bytesSha256\(buf\) \{[\s\S]*?\nasync function rebuildOrHoldQueued\(key, rec, reason\) \{[\s\S]*?\n\}/, 'the G5 helpers');
  const retrySrc = A(/async function retryPendingUploads\(opts = \{\}\) \{[\s\S]*?\n\}/, 'retryPendingUploads(opts)');
  const mk = (rec) => {
    const puts = [];
    const uploadView = new Map();
    const env = { checkFlextextBytes, uploadView, t: (k) => k, renderUploadQueue: () => {}, pumpUploads: () => {}, console: { warn() {} },
      uploadDocById: async () => false, Sync: { workerUploadTarget: () => 'x' },
      listPendingUploads: async () => [{ docId: 'doc1', rec }],
      db: { getDoc: async () => ({ id: 'doc1' }), putMedia: async (k, v) => { puts.push(v); } } };
    const f = new Function(...Object.keys(env), `${g5}\n${retrySrc}\nreturn { retryPendingUploads, rebuildOrHoldQueued, QUEUE_REBUILD_MAX };`)(...Object.values(env));
    return { ...f, uploadView, puts };
  };
  const heldRec = { name: 'Cerita.flextext', docId: 'doc1', damaged: 'hash', damagedAt: Date.now(), rebuilds: 2 };
  const a = mk(heldRec);
  await a.retryPendingUploads();
  assert.equal(a.uploadView.get('doc1').status, 'error', 'the automatic retry respects the back-off');
  assert.equal(a.uploadView.get('doc1').held, true, 'and the tray knows it is HELD, not a dropped connection');
  const b = mk(heldRec);
  await b.retryPendingUploads({ explicit: true });
  assert.equal(b.uploadView.get('doc1').status, 'waiting', '"Send now" makes it due at once');
  assert.equal(b.puts[0].rebuilds, b.QUEUE_REBUILD_MAX - 1, 'with one rebuild allowed — the same as the six-hour retry');
  const c = mk(heldRec);
  c.uploadView.set('doc1', { status: 'uploading' });
  await c.rebuildOrHoldQueued('doc1', { ...heldRec, rebuilds: 2 }, 'hash');
  assert.equal(c.uploadView.get('doc1').held, true, 'a copy held just now is marked too');
  const render = A(/function renderUploadQueue\(\) \{[\s\S]*?\n\}/, 'renderUploadQueue');
  assert.match(render, /t\('upload\.heldDamagedSummary'/, 'the BAR says it, even with a single item');
  assert.match(app, /else retryPendingUploads\(\{ explicit: true \}\);/, 'the Send now button asks explicitly');
});

test('"could not be prepared" is not overwritten — and is never shown for the researcher\'s remote request', () => {
  const doUp = A(/async function doUpload\(researcher = false\) \{[\s\S]*?\n\}/, 'doUpload');
  assert.match(doUp, /if \(await uploadDocById\(current\.id, \{ quiet: researcher \}\)\) toast\(t\('upload\.queuedToast'\)\);/,
    'the queued toast only when something was queued');
  const q = A(/async function uploadDocById\(docId, opts = \{\}\) \{[\s\S]*?\n\}/, 'uploadDocById');
  assert.match(q, /if \(!opts\.auto && !opts\.quiet\) toast\(t\('upload\.buildFailed'\)/);
  const trig = A(/case 'triggerUpload': \{[\s\S]*?break;\n    \}/, 'the triggerUpload case');
  assert.match(trig, /await uploadDocById\(docId, \{ quiet: true \}\);/, 'a remote request is quiet on the coworker\'s screen');
});

test('a delivery the coworker EMPTIED on purpose is not "as delivered"', () => {
  const src = ['docIsUncut', 'docHasNoText', 'docHasFree', 'deliveredContentSig', 'backupSkipReason', 'isAudioLocked', 'cheapHash']
    .map((n) => A(new RegExp(`function ${n}\\((?:doc|rec|str)\\) \\{[\\s\\S]*?\\n\\}`), n)).join('\n');
  const { backupSkipReason, deliveredContentSig } = new Function('getBaselineParagraphs', `${src}\nreturn { backupSkipReason, deliveredContentSig };`)(getBaselineParagraphs);
  const doc = makeDoc({ vernLang: 'qaa', analLang: 'id' }, 'Cerita');
  reconcileBaseline(doc, ['satu dua', 'tiga']);
  const rec = { id: 'doc1', title: 'Cerita', doc, assigned: true, audioId: 'a', audioLocked: true, audioSource: 'https://x.invalid/a' };
  rec.deliveredSig = deliveredContentSig(rec);
  assert.equal(backupSkipReason(rec), 'asDelivered');
  reconcileBaseline(rec.doc, ['']);
  assert.equal(backupSkipReason(rec), '', 'emptied: that IS a change — it backs up and reports as what it is');
});

test('History: an "assigned" row has no "Uploaded file" link — its file was sent, not uploaded', () => {
  const h = grab(panel, /function historyModal\(\) \{[\s\S]*?\n\}/, 'historyModal');
  assert.match(h, /const up = kind === 'assigned' \? '' : driveLink\(e\.fileId\);/);
});

test('every new string is in English AND Indonesian', () => {
  for (const k of ['upload.heldDamagedSummary']) {
    assert.equal((i18n.match(new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'gm')) || []).length, 2, `${k} in both languages`);
  }
});
