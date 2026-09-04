// Backlog fixes, 2026-09-04 (issues #33 and #36).
//   #33 "Done — send" on a text whose exact content auto-backup had already sent marked nothing: the
//       "already saved" short-cut sat above the done-marking line. Done is now decided first, and the
//       short-cut finishes the job (persist, report, return to the list, honour auto-delete).
//   #36 The ORIGINAL recording rides every local bundle and every ELAN / SayMore zip, even when the
//       audio is researcher-locked (uploads keep their lock) or a derived WAV is the timeline file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const SEGX = readFileSync(new URL('../docs/js/seg-exports.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');

function fnBody(src, header) {
  const i = src.indexOf(header);
  assert.ok(i > 0, `found ${header}`);
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n') + 3);
}

test('#33 Done — send marks done BEFORE asking whether the bytes are already on Drive', () => {
  const body = fnBody(APP, 'async function doUpload(researcher = false)');
  const markAt = body.indexOf("if (!researcher && !current.done) { current.done = true; current.doneAt = Date.now(); applyDoneButton(); }");
  const shortcutAt = body.indexOf('current.uploadedSig === uploadContentSig(current)');
  assert.ok(markAt > 0 && shortcutAt > 0, 'both lines exist');
  assert.ok(markAt < shortcutAt, 'done is set above the already-saved short-cut');
  const shortcut = body.slice(shortcutAt, body.indexOf('await uploadDocById(current.id)'));
  assert.match(shortcut, /returnAfterUploadOf = null;/, 'no completion hook will run, so the intent is cleared here');
  assert.match(shortcut, /await persist\(\);/, 'the done flag is persisted');
  assert.match(shortcut, /Sync\.reportNow\(\)/, 'the panel learns about Done on its next poll');
  assert.match(shortcut, /deleteAfterUpload\(\) && await deleteConfirmedDoc\(current\.id\)/, 'auto-delete follows the row-toggle rule');
  assert.match(shortcut, /if \(wantedReturn\) await returnToLibraryAfterSend\(\);/, 'Done — send still returns to the list');
  assert.match(shortcut, /toast\(t\('upload\.alreadyDone'\), 6000\);/, 'the user is still told nothing new was sent');
});

test('#36 a local bundle carries the original whatever the lock says; uploads keep their lock', () => {
  const body = fnBody(APP, 'async function buildBundleFor(rec, withTimestamp, opts = {})');
  assert.match(body, /const userAudio = !!\(media && media\.blob\);/, 'the local gate is "is there a recording"');
  assert.doesNotMatch(body, /userAudio = !!\(media && !isAudioLocked/, 'the lock no longer starves local saves');
  assert.match(body, /if \(userAudio\) entries\.push\(\{ name: mediaNameFor\(base, media\), data: media\.blob \}\);/);
  const up = fnBody(APP, 'async function queueMediaUpload(');
  assert.match(up, /isAudioLocked/, 'the upload lane still refuses to send assigned audio back');
});

test('#36 the panel ELAN / SayMore zip adds the original beside the timeline WAV, once', () => {
  const i = PANEL.indexOf("if (kind === 'elan' || kind === 'saymore') {\n      /* The ORIGINAL recording rides");
  assert.ok(i > 0, 'the push sits in runMenuConversion, not in buildSegEntriesFor (Download All would duplicate it)');
  const branch = PANEL.slice(i, i + 900);
  assert.match(branch, /if \(src\.media && src\.media\.blob && !entries\.some\(\(x\) => x\.name === src\.media\.name\)\) \{/);
  assert.match(branch, /entries\.push\(\{ name: src\.media\.name, data: src\.media\.blob \}\);/);
  const bse = fnBody(PANEL, 'async function buildSegEntriesFor(');
  assert.doesNotMatch(bse, /src\.media\.blob/, 'buildSegEntriesFor is unchanged (drive-download tests stub it)');
  for (const k of ['panel.dl.elanZipSub', 'panel.dl.saymoreZipSub']) {
    const lines = I18N.split('\n').filter((l) => l.startsWith(`  '${k}':`));
    assert.equal(lines.length, 2, `${k} in EN and ID`);
    assert.match(lines[0], /original recording/); assert.match(lines[1], /rekaman asli/);
  }
});

test('#36 the loose converter ships the original in both zip kinds, derived or not, never twice', () => {
  const i = SEGX.indexOf("if (segMedia && audio && audio.blob && (kind === 'elan' || kind === 'saymore')) {");
  assert.ok(i > 0, 'the original is no longer gated on !segMedia.derived');
  const block = SEGX.slice(i, i + 400);
  assert.match(block, /const origName = mediaNameFor\(base, segMedia\.derived \? media : segMedia\);/, 'the ORIGINAL name, not the derived WAV name');
  assert.match(block, /if \(!entries\.some\(\(x\) => x\.name === origName\)\) entries\.push\(\{ name: origName, data: audio\.blob \}\);/);
  assert.doesNotMatch(SEGX, /if \(segMedia && !segMedia\.derived && \(kind === 'elan'/, 'the old derived-only gate is gone');
});
