// Pause / resume / cancel for researcher-panel transfers (issue #21; Seth, 2026-09-07: "add
// pause/resume/cancel support to the researcher panel for this release"). Village bandwidth: a
// transfer that cannot be paused or resumed restarts from zero when the link drops.
//
// ⚠ THE LAST FOUR TESTS EXECUTE THE REAL FUNCTIONS, and they are the ones that matter. Every defect
// the 2026-09-07 review found had passed a source-shape check: the v613 cleanup existed and was
// asserted, in the ONE route the researcher was least likely to take; the stop flag was read three
// times, none of them on the path a stalled link takes; the paused row was created correctly and
// then never removed. Reading the code proves it says the right thing; running it proves it DOES
// the right thing, and only the second kind of test would have caught these. New behaviour here
// gets an executed test, not a regex.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js'), RES = rd('../docs/js/researcher.js');
const CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js');

/* ---------------------------------------------------------------------------------------------
 * THE HARNESS. researcher-panel.js cannot be imported under plain node (panel-collapse.test.mjs's
 * note), so the functions under test are lifted out of the source verbatim and given stubs for the
 * module-level things they reach for. Verbatim matters: nothing here is a re-implementation, so a
 * change to the panel changes what these tests run.
 * ------------------------------------------------------------------------------------------- */
const fnSrc = (head) => {                       // a top-level function: head → its column-0 close
  const at = PANEL.indexOf(head);
  assert.ok(at >= 0, `harness: ${head} not found — has it been renamed?`);
  const end = PANEL.indexOf('\n}\n', at);
  assert.ok(end > at, `harness: no end for ${head}`);
  return PANEL.slice(at, end + 2);
};
const TRAY = ['const jobs = new Map();\nlet jobSeq = 0;',
  fnSrc('function jobStart(label, msg, dir, ctl) {'), fnSrc('function jobPaused(id, paused, msg) {'),
  fnSrc('function jobSet(id, msg) {'), fnSrc('function jobEnd(id, finalMsg) {'),
  fnSrc('function jobDrop(id) {')].join('\n');
// AQ_PREFIX through aqCancelRunning is one contiguous stretch of the file: the queue's state and
// every control that acts on it.
const AQ = PANEL.slice(PANEL.indexOf("const AQ_PREFIX = 'assign-upload:';"),
  PANEL.indexOf('\n}\n', PANEL.indexOf('async function aqCancelRunning(docId) {')) + 2);
assert.match(AQ, /async function aqCancelCleanup\(docId, rec\) \{/, 'harness: the AQ slice must carry the shared cleanup');

const STUBS = ['t', 'deps', 'db', 'Researcher', 'confirmModal', 'renderDashboard', 'listAssignQueue',
  'assignQueueHtml', 'root', 'paintJobs', 'fmtSize', 'lastData', 'estateCache', 'buildSourceManifest',
  'MANIFEST_NAME', 'ENGINE_VERSION', 'BUILD_TAG', 'recordEvents', 'assignedEvent', 'pendingCmds',
  'savePending', 'setTimeout', 'dlStatus', 'bridgedIds', 'memberDlVia', 'prepareConversionSources',
  'buildSegEntriesFor', 'makeZip', 'document', 'URL'];

function loadPanel(stubs) {
  const body = `${TRAY}\n${AQ}\n${fnSrc('async function runAssignUpload(docId) {')}
    ${fnSrc('async function paintAssignQueue() {')}\n${fnSrc('async function downloadAllZip(btn) {')}
    return { jobs, jobStart, jobEnd, jobSet, jobPaused, jobDrop, aqActive, aqStop, aqJobs, aqPause,
             aqResume, aqCancelRunning, aqCancelCleanup, aqCancelPrompt, aqCancelIds,
             runAssignUpload, paintAssignQueue, downloadAllZip };`;
  return new Function(...STUBS, body)(...STUBS.map((n) => stubs[n]));
}

const KEY = 'assign-upload:doc1';
// The world the panel runs in: an IndexedDB that is a Map, a Drive that is a log, and a clock the
// test winds by hand (the tray's "show the outcome, then drop the row" timeout).
function world(over = {}) {
  const log = [], media = new Map(), timers = [], toasts = [], confirms = [];
  const w = { log, media, toasts, confirms,
    flush: () => { const q = timers.splice(0); q.forEach(([fn]) => fn()); return q.length; } };
  w.stubs = {
    t: (k, p) => (p ? `${k}(${JSON.stringify(p)})` : k),
    deps: { toast: (m) => { toasts.push(m); log.push('toast ' + m); } },
    db: { getMedia: async (k) => (media.has(k) ? media.get(k) : null),
          putMedia: async (k, v) => { media.set(k, v); },
          deleteMedia: async (k) => { log.push('deleteMedia ' + k); media.delete(k); },
          listMediaKeys: async () => [...media.keys()] },
    Researcher: {
      trashFiles: async (ids, why) => { log.push(`trashFiles [${ids}] ${why}`); },
      assignBegin: async () => ({ folderId: 'fld-new', originalsFolderId: 'orig-1' }),
      projectTextBegin: async () => ({ folderId: 'fld-new', originalsFolderId: 'orig-1' }),
      assignUploadFile: async () => 'file-x',
      assignFinish: async () => ({ audioUrl: 'u' }), assign: async () => ({ seq: 1 }),
      currentAccountId: () => 'acct', projectTextBase: () => 'base',
      listTextFiles: async () => ({ files: [{ id: 'f1', name: 'a.wav', size: 100 }] }),
    },
    confirmModal: async (msg) => { confirms.push(msg); return true; },
    renderDashboard: () => log.push('renderDashboard'),
    listAssignQueue: async () => [], assignQueueHtml: () => '',
    root: { querySelector: () => null }, paintJobs: () => {},
    fmtSize: (n) => `${n}B`,
    lastData: { instances: [{ instance_id: 'inst-1', nickname: 'Tablet A' }] },
    estateCache: { projects: [] }, buildSourceManifest: () => ({}),
    MANIFEST_NAME: 'flextext-manifest.json', ENGINE_VERSION: 'e', BUILD_TAG: 'b',
    recordEvents: () => {}, assignedEvent: () => ({}), pendingCmds: new Map(), savePending: () => {},
    setTimeout: (fn, ms) => timers.push([fn, ms]),
    dlStatus: () => {}, bridgedIds: (id) => ({ ids: [id] }), memberDlVia: () => null,
    prepareConversionSources: async () => ({ error: 'none' }), buildSegEntriesFor: async () => [],
    makeZip: async () => ({}),
    document: { createElement: () => ({ click() {}, remove() {}, style: {} }), body: { appendChild() {} } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  };
  Object.assign(w.stubs, over);
  return w;
}
// What the researcher can see in the tray, in the order the rows are drawn.
const rows = (P) => [...P.jobs.values()].map((j) => `${j.paused ? 'paused' : j.done ? 'done' : 'running'}:${j.msg}`);
const drain = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
const QUEUED = () => ({ instanceId: 'inst-1', title: 'Story', state: 'queued', at: 1, ttlDays: 90,
  audio: { blob: { size: 10 }, name: 'a.wav', mime: 'audio/wav', size: 10 } });

/* Run one upload for real, with a hook that fires mid-transfer — where the researcher's thumb
 * lands. The uploader honours shouldStop the way researcher.js's chunk loop does. */
async function startRun(onChunk, over = {}) {
  const w = world(over);
  let P;
  w.stubs.Researcher = { ...w.stubs.Researcher,
    assignUploadFile: async (iid, docId, part, opts = {}) => {
      // Fires on every source part of every run of this docId — a resumed run gets the hook too,
      // which is the whole subject of the paused-row test; callers that want it once say so.
      if (part.kind !== 'manifest' && onChunk) await onChunk(P, opts);
      if (opts.shouldStop && opts.shouldStop()) { const e = new Error('assign_upload_stopped'); e.stopped = true; throw e; }
      if (opts.onProgress) opts.onProgress(part.blob.size || 0);
      return part.kind === 'manifest' ? 'm1' : 'f-' + part.kind;
    } };
  P = loadPanel(w.stubs);
  w.media.set(KEY, { ...QUEUED(), ...(over.rec || {}) });
  await P.runAssignUpload('doc1');
  return { w, P };
}
// The queue card, wired by the real paintAssignQueue, then clicked.
async function cardCancel(rec, over = {}) {
  const w = world(over), clicks = {};
  const host = { innerHTML: '', querySelectorAll: (sel) => [{
    dataset: { aqcancel: 'doc1', aqresume: 'doc1', aqretry: 'doc1' },
    addEventListener: (_e, fn) => { clicks[sel] = fn; } }] };
  w.stubs.root = { querySelector: () => host };
  const P = loadPanel(w.stubs);
  w.media.set(KEY, rec);
  await P.paintAssignQueue();
  assert.ok(clicks['[data-aqcancel]'], 'the card wires a Cancel handler');
  await clicks['[data-aqcancel]']();
  return { w, P };
}

/* ---------------------------------------------------------------------------------------------
 * What the code has to SAY (shape), then what it has to DO (executed).
 * ------------------------------------------------------------------------------------------- */

test('the upload loop stops BETWEEN chunks and keeps its session, so Resume continues mid-file', () => {
  const fn = RES.slice(RES.indexOf('export async function assignUploadFile('), RES.indexOf('export function cancelCommand('));
  assert.match(fn, /\{ onProgress, onSession, base, shouldStop \} = \{\}/);
  assert.match(fn, /const stopped = \(\) => \{ try \{ return !!\(shouldStop && shouldStop\(\)\); \} catch \{ return false; \} \};/, 'a throwing flag never loses the transfer');
  assert.match(fn, /e\.stopped = true;/, 'a deliberate stop is distinguishable from a failure');
  assert.equal((fn.match(/if \(stopped\(\)\) throw bail\(\);/g) || []).length, 4,
    'at the session, before a chunk, after the run — and after a stalled probe\'s back-off, which is where the flag used to be unreadable for a minute');
  assert.doesNotMatch(fn, /abort\(\)/, 'the chunk in flight is allowed to land: Drive keeps the bytes it received');
  // The rest between retries is served in slices so the flag can end it; the back-off itself (the
  // doubling) is untouched, because that is the part a weak link needs.
  assert.match(fn, /const restfulSleep = async \(ms\) => \{/);
  assert.match(fn, /if \(stopped\(\)\) return;/, 'a slice gives up the moment the researcher has stopped it');
  assert.equal((fn.match(/await sleep\(waitMs\)/g) || []).length, 0, 'no un-interruptible wait is left in the loop');
  assert.equal((fn.match(/await restfulSleep\(waitMs\)/g) || []).length, 2, 'both back-offs: the probe retry and the chunk retry');
});

test('a download can be cancelled but not paused, and says so', () => {
  const fn = RES.slice(RES.indexOf('export async function fetchDriveFile('), RES.indexOf('/* ---------------- assignment uploads'));
  assert.match(fn, /export async function fetchDriveFile\(fileId, onProgress, via, signal\)/);
  assert.match(fn, /\.\.\.\(signal \? \{ signal \} : \{\}\)/);
  assert.match(fn, /if \(signal && signal\.aborted\) \{ try \{ await reader\.cancel\(\); \} catch \{[^}]*\} throw abortErr\(\); \}/, 'the read loop stops too, not just the request');
  assert.match(RES, /Pause and resume\n \* are deliberately NOT offered for a download/, 'the reason is written down where the next reader will look');
});

test('the tray rows carry the controls, wired once by delegation', () => {
  assert.match(PANEL, /let jobsWired = false;\s*\nfunction wireJobs\(el\) \{/, 'one listener, not one per repaint');
  assert.match(PANEL, /const b = ev\.target\.closest && ev\.target\.closest\('\[data-jobact\]'\);/);
  assert.match(PANEL, /function jobStart\(label, msg, dir, ctl\) \{/);
  assert.match(PANEL, /function jobPaused\(id, paused, msg\) \{/);
  assert.match(PANEL, /const acts = \(j\.done \|\| !j\.ctl\) \? '' :/, 'no controls on a finished job, or one that offered none');
  assert.match(PANEL, /\(j\.ctl\.pause \|\| j\.ctl\.resume\) \? \(j\.paused \? btn\('resume', 'panel\.jobs\.resume'\) : btn\('pause', 'panel\.jobs\.pause'\)\) : ''/, 'pause and resume are the same slot');
  assert.match(PANEL, /j\.paused \? '<span class="rp-job-pausemark"/, 'a paused row does not spin');
  assert.match(CSS, /\.rp-job\.is-paused \.rp-job-label, \.rp-job\.is-paused \.rp-job-dir \{ opacity: \.65; \}/);
  assert.match(CSS, /\.rp-job-btn \{ appearance: none;/);
});

test('an upload offers all three; a pause parks the record so no sweep resumes it behind your back', () => {
  assert.match(PANEL, /const aqStop = new Map\(\);/);
  assert.match(PANEL, /shouldStop: \(\) => aqStop\.has\(docId\),/, 'the loop reads the flag');
  assert.match(PANEL, /pause: \(\) => \{ aqPause\(docId\); jobSet\(job, t\('panel\.jobs\.pausing'\)\); \},\s*\n\s*resume: \(\) => aqResume\(docId\),\s*\n\s*cancel: \(\) => aqCancelRunning\(docId\),/);
  const c = PANEL.slice(PANEL.indexOf('const stop = e && e.stopped ? aqStop.get(docId) : null;'), PANEL.indexOf('// TRANSIENT (network, stalled chunks, 5xx)'));
  assert.match(c, /await aqCancelCleanup\(docId, rec\);/, 'cancel hands over to the one cleanup both routes use');
  assert.match(c, /rec\.state = 'paused'; rec\.error = '';/, 'pause keeps every fileId and the open session');
  assert.match(c, /jobPaused\(job, true, t\('panel\.aq\.pausedPct'/, 'and the row stays, showing where it stopped');
  assert.match(PANEL, /if \(rec\.state === 'paused'\) continue;\s*\/\/ a deliberate pause waits for Resume/, 'the sweep leaves it alone');
  assert.match(PANEL, /rec\.state === 'paused' \? t\('panel\.aq\.pausedRow'\)/, 'the queue card names the state');
  assert.match(PANEL, /data-aqresume="\$\{esc\(docId\)\}"/, 'and offers Resume there, for a pause that outlived its tray row');
  assert.match(PANEL, /host\.querySelectorAll\('\[data-aqresume\]'\)\.forEach\(\(b\) => b\.addEventListener\('click', \(\) => aqResume\(b\.dataset\.aqresume\)\)\);/);
});

test('a stop flag can never outlive its transfer', () => {
  assert.match(PANEL, /const view = aqActive\.get\(docId\);\s*\n\s*if \(!view \|\| view\.state !== 'uploading'\) return;\s*\n\s*aqStop\.set\(docId, 'pause'\);/, 'too late to pause once it is sending');
  /* Cancel's guard is deliberately the weaker `view &&`: a PARKED row has no live view at all, and
   * its ✕ must still work (it used to silently do nothing). What both share is the refusal once the
   * view says 'sending' — the bytes are in, the assign command is being minted, and a flag set then
   * would outlive this transfer and stop the next one before it started. */
  assert.match(PANEL, /if \(view && view\.state !== 'uploading'\) return;\s*\/\/ see aqPause/, 'and too late to cancel');
  assert.equal((PANEL.match(/aqActive\.delete\(docId\); aqStop\.delete\(docId\);/g) || []).length, 3,
    'cleared on both success paths and on failure, or the next upload of this text would bail instantly');
});

test('both download jobs can be cancelled, and a cancel reads as a cancel, not a failure', () => {
  assert.equal((PANEL.match(/new AbortController\(\)/g) || []).length >= 2, true);
  assert.match(PANEL, /cancel: \(\) => \{ dlCancelled = true; jobSet\(job, t\('panel\.jobs\.cancelling'\)\); dlCtl\.abort\(\); \}/, 'Download All');
  assert.match(PANEL, /memberDlVia\(wrapForStatus\), dlCtl\.signal\)\);/, 'and the signal actually reaches the fetch');
  assert.match(PANEL, /cancel: \(\) => \{ fileCancelled = true; jobSet\(job, t\('panel\.jobs\.cancelling'\)\); fileCtl\.abort\(\); \}/, 'a single Drive file');
  assert.match(PANEL, /memberDlVia\(wrap2\), fileCtl\.signal\)\.then/);
  assert.match(PANEL, /if \(dlCancelled \|\| \(e && \(e\.cancelled \|\| e\.name === 'AbortError'\)\)\) \{\s*\n\s*jobEnd\(job, t\('panel\.jobs\.cancelledShort'\)\);/);
  assert.match(PANEL, /if \(fileCancelled \|\| \(err && \(err\.cancelled \|\| err\.name === 'AbortError'\)\)\) \{ jobEnd\(job, t\('panel\.jobs\.cancelledShort'\)\); return; \}/);
});

test('every new string is in both languages, and the release note too', () => {
  for (const k of ['panel.jobs.pause', 'panel.jobs.resume', 'panel.jobs.cancel', 'panel.jobs.pausing',
                   'panel.jobs.cancelling', 'panel.jobs.cancelledShort', 'panel.aq.pausedRow', 'panel.aq.pausedPct']) {
    assert.equal((I18N.match(new RegExp(`\n  '${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.equal((I18N.match(/\n    ,'panel\.rel\.new\.transferCtl': '/g) || []).length, 2);
  assert.match(PANEL, /\{ v: 'v605', date: '2026-09-07', items: \[\s*\n\s*\{ k: 'panel\.rel\.new\.transferCtl' \},/);
});

/* ---------------------------------------------------------------------------------------------
 * THE FIVE DEFECTS OF THE 2026-09-07 REVIEW, each executed.
 * ------------------------------------------------------------------------------------------- */

test('#55 is fixed on BOTH routes: the queue card\'s Cancel clears Drive too, through the one cleanup', async () => {
  // The rule is written once. Two copies of it drifted the day the second was written: v613 taught
  // the running upload to clean up and left the card deleting only the local record — and the card
  // is the ONLY cancel offered for a paused or queued transfer, i.e. exactly the state in which the
  // folder, originals/ and the manifest already exist.
  assert.equal((PANEL.match(/'cancelled assignment upload'/g) || []).length, 1, 'one trash call, not one per route');
  assert.match(PANEL, /await aqCancelCleanup\(id, rec\);/, 'the card calls it');
  assert.match(PANEL, /await aqCancelCleanup\(docId, rec\);/, 'and so does the running upload');

  const folder = await cardCancel({ title: 'Story', state: 'paused', folderId: 'fld-1', createdFolder: true,
    originalsFolderId: 'orig-1', manifestFileId: 'm1', audioFileId: 'a1' });
  console.log('  card Cancel on a paused upload →', folder.w.log.join(' | '));
  assert.deepEqual(folder.w.log, ['trashFiles [fld-1] cancelled assignment upload',
    'deleteMedia assign-upload:doc1', 'renderDashboard']);
  assert.equal(folder.w.media.has(KEY), false, 'the queue record goes too');

  // NARROWLY: only the folder this run created. Otherwise only the files this run uploaded — a
  // re-upload into a folder that already held the researcher's work must not take that work with it.
  const files = await cardCancel({ title: 'Story', state: 'queued', folderId: 'fld-1', createdFolder: false,
    manifestFileId: 'm1', audioFileId: 'a1' });
  console.log('  card Cancel, folder was already there →', files.w.log.join(' | '));
  assert.match(files.w.log[0], /trashFiles \[m1,a1\]/);
  assert.ok(!files.w.log.join(' ').includes('fld-1'), 'never the pre-existing folder');

  const nothing = await cardCancel({ title: 'Story', state: 'queued' });
  assert.ok(!nothing.w.log.some((l) => l.startsWith('trashFiles')), 'nothing on Drive yet ⇒ no Drive call at all');

  // Best-effort: a cleanup that fails must not turn a cancel into an error.
  const broke = await cardCancel({ title: 'Story', state: 'paused', folderId: 'fld-1', createdFolder: true },
    { Researcher: { trashFiles: async () => { throw new Error('offline'); } } });
  console.log('  card Cancel when Drive is unreachable →', broke.w.log.join(' | '));
  assert.match(broke.w.toasts[0], /^panel\.aq\.cancelLeftovers/, 'the orphan is named, not swallowed');
  assert.equal(broke.w.media.has(KEY), false, 'and the cancel still cancels');

  const kept = await cardCancel({ title: 'Story', state: 'paused', folderId: 'fld-1', createdFolder: true },
    { confirmModal: async () => false });
  assert.deepEqual(kept.w.log, [], 'declining the confirmation touches nothing');
  assert.equal(kept.w.media.has(KEY), true);
});

test('a Pause or Cancel pressed while the link is stalling is honoured, not slept through', async () => {
  /* The probe-retry path used to sleep up to 60s per strike and `continue` past every stop check:
   * five strikes, ~62s, the flag read ONCE — and then a TRANSIENT failure, which the sweep resumed,
   * against the researcher's explicit stop. Pressing Pause exactly when the link stalls is the
   * normal case, because a stall is why you reach for Pause. */
  const src = RES.slice(RES.indexOf('export async function assignUploadFile('), RES.indexOf('export function cancelCommand('));
  const run = async (flipAfterSlices) => {
    let probes = 0, slices = 0, consults = 0, stop = false;
    const fn = new Function('assignUploadStart', 'assignUploadChunk', 'sleep', 'openingChunk', 'shrinkChunk', 'CHUNK_MAX',
      src.replace('export async function', 'async function') + '\n; return assignUploadFile;')(
      async () => ({ uploadId: 'sess-1' }),
      async (i, d, s, range) => { if (range.includes('*/')) probes++; return { fail: true }; },   // a dead link
      async () => { slices++; if (flipAfterSlices != null && slices >= flipAfterSlices) stop = true; },
      () => 524288, (n) => Math.max(524288, n / 2), 8388608);
    let out = 'resolved';
    try {
      await fn('inst', 'doc', { blob: { size: 4e6, slice: () => 'b' }, name: 'a.wav', mime: 'audio/wav', kind: 'audio' },
        { shouldStop: () => { consults++; return stop; } });
    } catch (e) { out = { msg: e.message, stopped: !!e.stopped, transient: !!e.transient }; }
    return { out, probes, slices, consults };
  };

  const pressed = await run(3);          // the thumb lands three slices into the first back-off
  console.log('  Pause pressed during the back-off →', JSON.stringify(pressed));
  assert.deepEqual(pressed.out, { msg: 'assign_upload_stopped', stopped: true, transient: false },
    'a deliberate stop, which the sweep will NOT resume');
  assert.equal(pressed.probes, 1, 'it does not sit through five strikes first');
  assert.equal(pressed.slices, 3, 'and the rest of that wait is abandoned the moment the flag turns');
  assert.ok(pressed.consults > 1, 'the flag is read throughout the wait, not once at the end of it');

  const untouched = await run(null);     // nobody presses anything: the back-off must be unchanged
  console.log('  nobody presses anything →', JSON.stringify(untouched));
  assert.deepEqual(untouched.out, { msg: 'assign_upload_stalled', stopped: false, transient: true });
  assert.equal(untouched.probes, 5, 'five strikes, as before');
  assert.equal(untouched.slices, 248, '2+4+8+16+32s of back-off, to the slice — a stop shortens the WAIT, never the back-off');
});

test('resuming a paused upload replaces its tray row instead of stranding it there forever', async () => {
  /* jobPaused parks the row and keeps it in the jobs map (it is the only handle on a half-done
   * transfer); Resume mints a NEW row; jobEnd's timeout is the only thing that ever removes one. So
   * the tray kept a "paused at 41%" row that outlived the transfer it described and went on
   * offering Resume for an upload already running. */
  let midResume = null, paused = false;
  const { w, P } = await startRun(async (P2) => {
    if (paused) { midResume = { size: P2.jobs.size, rows: rows(P2) }; return; }   // the SECOND run, mid-flight
    paused = true;
    await P2.jobs.get(P2.aqJobs.get('doc1')).ctl.pause();                         // the tray's ❚❚
  });
  console.log('  after Pause →', rows(P));
  assert.deepEqual(rows(P), ['paused:panel.aq.pausedPct({"pct":0,"size":"10B"})'], 'one parked row, showing where it stopped');
  assert.equal(w.media.get(KEY).state, 'paused', 'and the record waits for Resume');

  await P.aqResume('doc1');
  await drain();
  console.log('  mid-resume →', JSON.stringify(midResume));
  assert.equal(midResume.size, 1, 'ONE row while the resumed transfer runs — not the ghost plus the real one');
  assert.deepEqual(midResume.rows, ['running:panel.dl.starting'], 'and it is the live one, spinning, not the parked ghost');

  console.log('  after it finishes →', rows(P));
  assert.deepEqual(rows(P), ['done:panel.aq.sentShort']);
  w.flush();                                                    // the tray's 5s "show the outcome" window
  assert.equal(P.jobs.size, 0, 'the row leaves when the transfer it describes is over');
  assert.equal(P.aqJobs.size, 0, 'and nothing is left pointing at it');
  assert.equal(w.media.has(KEY), false, 'the assignment was delivered');
});

test('a cancelled Download-all says cancelled, not "done — check your downloads"', async () => {
  /* The cancel branch ends the job in the catch and returns; the `finally` then ended it AGAIN with
   * the saved message. The researcher cancelled and was told the zip was waiting for them. */
  const w = world();
  let P;
  w.stubs.Researcher = { ...w.stubs.Researcher, fetchDriveFile: async () => {
    P.jobs.get([...P.jobs.keys()][0]).ctl.cancel();              // the tray's ✕, mid-download
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  } };
  P = loadPanel(w.stubs);
  const nameEl = { textContent: 'Download all' };
  await P.downloadAllZip({ dataset: { i: 'inst-1', id: 'doc1', title: 'Story' }, disabled: false,
    querySelector: () => nameEl, closest: () => null });
  console.log('  the row the researcher is left with →', rows(P));
  assert.deepEqual(rows(P), ['done:panel.jobs.cancelledShort'], 'the outcome the researcher caused');
  assert.equal(w.flush(), 1, 'and one removal timer, not one per jobEnd call');
  // The guard lives in jobEnd, so no caller has to remember which of its exits already spoke.
  assert.match(PANEL, /const j = jobs\.get\(id\);\s*\n\s*if \(!j \|\| j\.done\) return;\s*\n\s*j\.done = true;/);
});

test('the tray\'s ✕ asks before it trashes, and the question says what will be removed', async () => {
  /* 26x24px, 4px from Pause, and since v613 one mis-tap ends the transfer AND sends the created
   * text folder to Drive's trash. The MILDER control — the card's Cancel — was the one that asked. */
  const yes = await startRun(async (P2) => { await P2.jobs.get(P2.aqJobs.get('doc1')).ctl.cancel(); });
  console.log('  ✕ confirmed →', yes.w.confirms[0], '|', yes.w.log.join(' | '));
  assert.equal(yes.w.confirms.length, 1, 'it asks');
  assert.equal(yes.w.confirms[0], 'panel.aq.cancelConfirmFolder({"title":"Story"})',
    'and names the loss: the text folder this upload created');
  assert.deepEqual(yes.w.log, ['trashFiles [fld-new] cancelled assignment upload',
    'deleteMedia assign-upload:doc1', 'renderDashboard'], 'the same cleanup the card gets');
  assert.deepEqual(rows(yes.P), ['done:panel.jobs.cancelledShort']);

  const no = await startRun(async (P2) => { await P2.jobs.get(P2.aqJobs.get('doc1')).ctl.cancel(); },
    { confirmModal: async () => false });
  console.log('  ✕ declined →', no.w.log.join(' | '));
  assert.equal(no.P.aqStop.size, 0, 'a declined cancel sets no flag');
  assert.ok(!no.w.log.some((l) => l.startsWith('trashFiles')), 'and trashes nothing');
  assert.deepEqual(rows(no.P), ['done:panel.aq.sentShort'], 'the upload carries on and is delivered');

  // A PARKED row's ✕ used to do nothing at all: aqCancelRunning looked for a live view and there is
  // none once a pause has ended the run. It is the same cancel, so it cleans up the same way.
  let paused = false;
  const parked = await startRun(async (P2) => {
    if (paused) return;
    paused = true;
    await P2.jobs.get(P2.aqJobs.get('doc1')).ctl.pause();
  });
  await parked.P.jobs.get(parked.P.aqJobs.get('doc1')).ctl.cancel();
  console.log('  ✕ on a paused row →', parked.w.confirms[0], '|', parked.w.log.join(' | '));
  assert.equal(parked.w.confirms[0], 'panel.aq.cancelConfirmFolder({"title":"Story"})');
  assert.deepEqual(parked.w.log, ['trashFiles [fld-new] cancelled assignment upload',
    'deleteMedia assign-upload:doc1', 'renderDashboard']);
  assert.deepEqual(rows(parked.P), ['done:panel.jobs.cancelledShort'], 'and the row reports it');
});

test('the three sentences the confirmations need, and where they come from', () => {
  /* ⚠ THESE KEYS ARE NOT IN i18n.js YET (Seth, 2026-09-07 — reported for translation with the fix).
   * When they land, add them to the EN/ID assertion in the release-strings test above; until then
   * this at least pins that the code asks for them, so the sentences cannot be quietly dropped:
   *   panel.aq.cancelConfirmFolder — the text folder this upload created goes to Drive's trash
   *   panel.aq.cancelConfirmFiles  — only the files this upload sent go; the folder's own work stays
   *   panel.aq.cancelTooLate       — the bytes finished while the question was on screen */
  assert.match(PANEL, /t\('panel\.aq\.cancelConfirmFolder', \{ title \}\)/);
  assert.match(PANEL, /t\('panel\.aq\.cancelConfirmFiles', \{ title \}\)/);
  assert.match(PANEL, /deps\.toast\(t\('panel\.aq\.cancelTooLate'\), 6000\)/);
  assert.match(PANEL, /if \(!ids\.length\) return t\('panel\.aq\.cancelConfirm'\);/,
    'and the old wording still serves the case it was written for: nothing has reached Drive');
});

test('a conversion that produced no file does not tell the researcher it was saved', () => {
  /* ⚠ The finally used to end EVERY exit with savedShort ("done — check your downloads"), so a
   * refusal — no alignment, an unparseable flextext, an oversized listening page, a thrown build —
   * pointed the researcher at a folder where nothing had been written. */
  const fn = PANEL.slice(PANEL.indexOf('async function runMenuConversion('), PANEL.indexOf('// The current inventory item for a doc'));
  assert.match(fn, /let saved = false;/);
  assert.match(fn, /jobEnd\(job, saved \? t\('panel\.dl\.savedShort'\) : t\('panel\.dl\.failedShort'\)\);/);
  /* ⚠ `saved` is set ONLY where a blob actually reaches the disk. This used to assert a count of 2
   * and broke when a third output was added (the lameta session folder) — a change that satisfied
   * the rule perfectly. The count was never the property; the pairing is. So: every `saved = true`
   * must be immediately preceded by a `saveBlobAs`, whatever the number of outputs. */
  const sets = (fn.match(/saved = true;/g) || []).length;
  const paired = (fn.match(/saveBlobAs\([^\n]*\n\s*saved = true;/g) || []).length;
  assert.ok(sets > 0, 'something sets it');
  assert.equal(paired, sets, 'every saved = true immediately follows a saveBlobAs — no bare flags');
  assert.ok(fn.indexOf('saveBlobAs') < fn.indexOf('saved = true;'), 'the flag follows the save, never precedes it');
});
