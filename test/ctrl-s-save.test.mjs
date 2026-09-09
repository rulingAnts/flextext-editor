/* CTRL+S / CMD+S FLUSHES AND REASSURES (#40, Seth 2026-09-04: "capture CTRL+S keyboard shortcut
 * (Green saved button, plus 'Auto saved' toast that that triggers)").
 *
 * The saving half is almost beside the point — work is persisted continuously already. The half
 * that matters is that WITHOUT this, Ctrl+S opens the browser's "Save page as…" download dialog
 * mid-sentence, and the reflex is universal in anyone who has used a word processor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js');
/* ⚠ The end anchor must be searched FROM the start offset: `$('#btn-share')` also appears earlier in
 * the file, and slicing to that earlier index yields an empty string — which passes nothing and
 * reads like four broken assertions. */
const START = APP.indexOf('const flushSave = async ()');
const HANDLER = APP.slice(START, APP.indexOf("$('#btn-share')", START));
if (!HANDLER.trim()) throw new Error('the handler slice is empty — the anchors moved');

test('the button and the shortcut run the SAME act, not two copies of it', () => {
  assert.match(HANDLER, /const flushSave = async \(\) => \{/, 'one named action');
  assert.match(HANDLER, /saveBtn\.addEventListener\('click', flushSave\)/, 'the button calls it');
  assert.match(HANDLER, /flushSave\(\);\s*\n\s*\}, true\)/, 'and so does the key handler');
  // What the act is: flush the baseline textarea if that tab is showing, persist, reassure.
  assert.match(HANDLER, /if \(activeTab === 'baseline' && \$\('#baseline-text'\)\) applyBaseline\(\);/);
  assert.match(HANDLER, /await persist\(\)/);
  assert.match(HANDLER, /toast\(t\('toast\.autoSaved'\), 4000\)/);
});

test('it prevents the browser save dialog, which is the actual fix', () => {
  assert.match(HANDLER, /e\.preventDefault\(\);\s*\n\s*flushSave\(\);/,
    'preventDefault comes BEFORE the async work — the dialog must not open while persist() awaits');
  assert.match(HANDLER, /\}, true\);/, 'capture phase, so a nearer handler cannot stop it first');
});

/* ⚠ THE ONE SHORTCUT IN THIS FILE THAT MUST NOT CHECK inTextField(). Space and Enter are gated by
 * it because a text box legitimately owns those keys. Ctrl+S is never a typing key, and inside a
 * box is exactly where the hand is when the reflex arrives — gating it would defeat the fix. */
test('it fires inside text boxes too', () => {
  // ⚠ Comments STRIPPED first: the handler explains this rule in prose, naming inTextField, so a
  // bare /inTextField/ match fails on the explanation rather than on any guard.
  const code = HANDLER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /inTextField/,
    'no inTextField gate — that would disable it exactly where it is needed');
});

test('modifiers: Ctrl or Cmd, but never with Alt', () => {
  assert.match(HANDLER, /!\(e\.metaKey \|\| e\.ctrlKey\)/, 'Cmd on a Mac, Ctrl elsewhere');
  // AltGr reports as Ctrl+Alt on Windows/Linux layouts, and is how some keyboards type characters.
  assert.match(HANDLER, /\|\| e\.altKey\) return;/, 'Alt held → not this shortcut, leave the key alone');
  assert.match(HANDLER, /e\.key !== 's' && e\.key !== 'S'/, 'Shift+Ctrl+S counts too, rather than silently doing nothing');
});

/* Bound only where there is something to flush. The recorder, consent and crowd shells have no
 * document and no Save button; a shortcut that toasted "saved" in one of those would be a lie. */
test('only wired in the apps that have a Save button', () => {
  assert.match(HANDLER, /const saveBtn = \$\('#btn-save'\);\s*\n\s*if \(saveBtn\) \{/);
  const shells = ['docs/index.html', 'satellites/audio-segmenter/index.html'];
  for (const p of shells) assert.match(rd('../' + p), /id="btn-save"/, `${p} has the button`);
  for (const p of ['satellites/text-recorder/index.html', 'satellites/consent-collector/index.html']) {
    assert.doesNotMatch(rd('../' + p), /id="btn-save"/, `${p} correctly has none`);
  }
});

test('the reassurance string is in both languages', () => {
  const I18N = rd('../docs/js/i18n.js');
  assert.equal((I18N.match(/'toast\.autoSaved':/g) || []).length, 2);
});
