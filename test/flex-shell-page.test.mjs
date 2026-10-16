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

// Seth, 2026-10-16: "we want very verbose TTY debugging output". On the shell's page, the page's own
// warnings and errors reach the console the shell was started from; on the web nothing changes.
test('page warnings, errors and rejections are copied to the shell console, only on the shell page', async () => {
  const { mirrorConsoleToShell, flexLog } = await import('../docs/js/native-flex.js');
  assert.equal(mirrorConsoleToShell(), false, 'node: no window, nothing installed');
  assert.doesNotThrow(() => flexLog('info', 'no bridge: a no-op'));
  const listeners = {};
  const lines = [];
  globalThis.window = {
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    pywebview: { api: { client_log: async (level, msg) => { lines.push([level, msg]); return { ok: true }; } } },
  };
  globalThis.document = { querySelector: () => ({ getAttribute: () => '0' }) };
  assert.equal(mirrorConsoleToShell(), false, 'a page the shell did not serve (the web) is left alone');
  globalThis.document = { querySelector: (sel) => (sel === 'meta[name="flextext-flex-shell"]' ? { getAttribute: () => '1' } : null) };
  const orig = { warn: console.warn, error: console.error };
  const seen = [];
  console.warn = (...a) => seen.push(['warn', a]);
  console.error = (...a) => seen.push(['error', a]);
  try {
    assert.equal(mirrorConsoleToShell(), true);
    assert.equal(mirrorConsoleToShell(), false, 'installed once');
    const e = Object.assign(new Error('boom'), { code: 'E_INVARIANT', detail: { closed: true } });
    console.warn('[flex] save failed', e);
    console.error('plain', { a: 1 });
    listeners.error({ message: 'x is not defined', filename: 'app.js', lineno: 3, colno: 7, error: null });
    listeners.unhandledrejection({ reason: Object.assign(new Error('nope'), { code: 'E_POISONED' }) });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(seen.length, 2, 'the page console still gets every line');
    assert.equal(lines[0][0], 'warn');
    assert.match(lines[0][1], /^\[flex\] save failed Error: boom/);
    assert.match(lines[0][1], /code E_INVARIANT \| detail \{"closed":true\}/);
    assert.deepEqual(lines[1], ['error', 'plain {"a":1}']);
    assert.match(lines[2][1], /^page error: x is not defined \(at app\.js:3:7\)/);
    assert.match(lines[3][1], /^unhandled rejection: Error: nope[\s\S]*code E_POISONED/);
    flexLog('info', 'x'.repeat(9000));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(lines[4][1].length, 8000, 'one console line is capped');
    globalThis.window.pywebview.api.client_log = () => { throw new Error('bridge gone'); };
    assert.doesNotThrow(() => console.warn('still fine'), 'a failing bridge never breaks the page console');
    let calls = 0;
    globalThis.window.pywebview.api.client_log = async () => { calls += 1; console.error('the bridge complains'); return { ok: true }; };
    console.warn('once');
    assert.equal(calls, 1, 'a line printed while forwarding is not forwarded again (no loop)');
  } finally {
    console.warn = orig.warn;
    console.error = orig.error;
    delete globalThis.window;
    delete globalThis.document;
  }
});
