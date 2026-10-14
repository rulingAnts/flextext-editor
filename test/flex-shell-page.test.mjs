// The FLEx shell's page marker (native-flex.js isFlexShellPage) and the one engine choice that
// hangs on it: the shell's 127.0.0.1 origin is NOT a developer's localhost (app.js isLocalDev), so
// inside the shell the engine talks to the production relay worker like any installed app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('isFlexShellPage reads the staged page marker and nothing else', async () => {
  const { isFlexShellPage } = await import('../docs/js/native-flex.js');
  assert.equal(isFlexShellPage(), false, 'no document at all (node)');
  globalThis.document = { querySelector: (sel) => (sel === 'meta[name="flextext-flex-shell"]' ? { getAttribute: () => '1' } : null) };
  assert.equal(isFlexShellPage(), true);
  globalThis.document = { querySelector: () => ({ getAttribute: () => '0' }) };
  assert.equal(isFlexShellPage(), false, 'content must be exactly "1"');
  globalThis.document = { querySelector: () => { throw new Error('boom'); } };
  assert.equal(isFlexShellPage(), false, 'never throws');
  delete globalThis.document;
});

test('app.js isLocalDev is off on the shell page, and the staged shell carries the marker', () => {
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const m = app.match(/function isLocalDev\(\) \{ return ([^\n]*)\}/);
  assert.ok(m, 'isLocalDev found');
  assert.ok(m[1].startsWith('!isFlexShellPage() && '), 'the shell page is never local dev: ' + m[1]);
  assert.match(app, /import \{[^}]*\bisFlexShellPage\b[^}]*\} from '\.\/native-flex\.js'/);
  const stage = readFileSync(new URL('../desktop/build/stage_engine.py', import.meta.url), 'utf8');
  assert.match(stage, /<meta name="flextext-flex-shell" content="1">/);
  const src = readFileSync(new URL('../satellites/audio-segmenter/index.html', import.meta.url), 'utf8');
  assert.ok(!src.includes('flextext-flex-shell'), 'the web satellite is never marked');
});
