/* Issue #54, closed as NOT PLANNED (Seth, 2026-09-11): "I think actually #54 we don't need anymore now
 * that we've added splitting/joining capabilities to PAT. Let's rather just not allow .fxpa importing
 * into audio segmenter and then just close #54 as not planned."
 *
 * The Audio Segmenter had no .fxpa import when this was decided, so there was nothing to remove — the
 * decision is kept by pinning it. Every way a file can come in is checked, and none may admit a .fxpa:
 * the pickers' accept lists, the one extension router, the web-app manifests (share target and file
 * handlers), and drag-and-drop. The .fxpa round trip runs through PAT, which still opens one.
 *
 * ⚠ If a future door is added — a drop zone, a file handler — it has to be added here too, or this
 * test stops describing the app. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js'), PAT = rd('../docs/js/paragraph-ui.js');
const SHELLS = ['../docs/index.html', '../satellites/audio-segmenter/index.html'];
const MANIFESTS = ['../docs/manifest.webmanifest', '../satellites/audio-segmenter/segmenter.webmanifest'];

test('no file picker the segmenter can show accepts a .fxpa', () => {
  let pickers = 0;
  for (const f of SHELLS) {
    for (const m of rd(f).matchAll(/<input[^>]*type="file"[^>]*>/g)) {
      pickers++;
      assert.doesNotMatch(m[0], /fxpa/i, `${f}: ${m[0]}`);
    }
  }
  assert.ok(pickers >= 2, 'found the shells\' pickers — otherwise this checks nothing');
  // the picker built in code for the "open a text or recording" door
  const sat = APP.match(/const SAT_ACCEPT = ([\s\S]*?);\n/);
  assert.ok(sat, 'SAT_ACCEPT is still where the code-built picker gets its list');
  assert.doesNotMatch(sat[1], /fxpa/i);
});

test('the extension router that decides "this is a text" does not recognise a .fxpa', () => {
  const m = APP.match(/const satIsText = \(f\) => (\/[^\n]*?\/i)\.test\(f\.name\)/);
  assert.ok(m, 'satIsText is still the router');
  const re = new Function(`return ${m[1]};`)();
  assert.ok(re.test('story.flextext'), 'a .flextext is a text');
  assert.equal(re.test('story.fxpa'), false, 'a .fxpa is not');
});

test('neither web-app manifest offers a share target or file handler that could deliver one', () => {
  for (const f of MANIFESTS) {
    const j = JSON.parse(rd(f));
    const blob = JSON.stringify([j.share_target || null, j.file_handlers || null]);
    assert.doesNotMatch(blob, /fxpa/i, f);
    assert.equal(j.file_handlers, undefined, `${f}: no file_handlers at all today`);
  }
});

test('there is no drag-and-drop door', () => {
  assert.doesNotMatch(APP, /addEventListener\(\s*['"]drop['"]/, 'a drop handler would be a new way in — add it to this test');
  assert.doesNotMatch(APP, /launchQueue/, 'nor the File Handling API');
});

test('PAT still opens a .fxpa — the round trip lives there now', () => {
  assert.match(PAT, /files\.find\(\(f\) => \/\\\.fxpa\$\/i\.test\(f\.name\)\)/);
});
