// Pause / resume / cancel for researcher-panel transfers (issue #21; Seth, 2026-09-07: "add
// pause/resume/cancel support to the researcher panel for this release"). Village bandwidth: a
// transfer that cannot be paused or resumed restarts from zero when the link drops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js'), RES = rd('../docs/js/researcher.js');
const CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js');

test('the upload loop stops BETWEEN chunks and keeps its session, so Resume continues mid-file', () => {
  const fn = RES.slice(RES.indexOf('export async function assignUploadFile('), RES.indexOf('export function cancelCommand('));
  assert.match(fn, /\{ onProgress, onSession, base, shouldStop \} = \{\}/);
  assert.match(fn, /const stopped = \(\) => \{ try \{ return !!\(shouldStop && shouldStop\(\)\); \} catch \{ return false; \} \};/, 'a throwing flag never loses the transfer');
  assert.match(fn, /e\.stopped = true;/, 'a deliberate stop is distinguishable from a failure');
  assert.equal((fn.match(/if \(stopped\(\)\) throw bail\(\);/g) || []).length, 3, 'checked at the session, before a chunk, and after the run');
  assert.doesNotMatch(fn, /abort\(\)/, 'the chunk in flight is allowed to land: Drive keeps the bytes it received');
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
  assert.match(c, /if \(stop === 'cancel'\) \{\s*\n\s*await db\.deleteMedia\(key\)\.catch/, 'cancel throws the queue record away');
  assert.match(c, /rec\.state = 'paused'; rec\.error = '';/, 'pause keeps every fileId and the open session');
  assert.match(c, /jobPaused\(job, true, t\('panel\.aq\.pausedPct'/, 'and the row stays, showing where it stopped');
  assert.match(PANEL, /if \(rec\.state === 'paused'\) continue;\s*\/\/ a deliberate pause waits for Resume/, 'the sweep leaves it alone');
  assert.match(PANEL, /rec\.state === 'paused' \? t\('panel\.aq\.pausedRow'\)/, 'the queue card names the state');
  assert.match(PANEL, /data-aqresume="\$\{esc\(docId\)\}"/, 'and offers Resume there, for a pause that outlived its tray row');
  assert.match(PANEL, /host\.querySelectorAll\('\[data-aqresume\]'\)\.forEach\(\(b\) => b\.addEventListener\('click', \(\) => aqResume\(b\.dataset\.aqresume\)\)\);/);
});

test('a stop flag can never outlive its transfer', () => {
  assert.match(PANEL, /const view = aqActive\.get\(docId\);\s*\n\s*if \(!view \|\| view\.state !== 'uploading'\) return;\s*\n\s*aqStop\.set\(docId, 'pause'\);/, 'too late to pause once it is sending');
  assert.match(PANEL, /if \(!view \|\| view\.state !== 'uploading'\) return;\s*\/\/ see aqPause/, 'and too late to cancel');
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
