/* THE FILE SYSTEM SEAM (docs/js/files.js) — plans/native-shell-capabilities.md §3, built for the
 * lameta device (plans/lameta-device.md). Three things are pinned:
 *   1. the capability verdicts, in words the UI repeats: only Chromium on a computer can hand us a
 *      folder, and every other answer says WHY rather than failing quietly;
 *   2. nothing here can hang the caller — every read has a clock, and a cloud placeholder that never
 *      delivers becomes `available:false` or a FilesTimeout, never a frozen loop;
 *   3. isolation — no native globals at import time, nothing of the sync module or the editor's
 *      storage, and the panel reaches it by import() only, so no offline shell precaches it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const F = await import('../docs/js/files.js');

/* A tiny fake of the File System Access API's shapes, enough to drive the module under node. */
function fakeFile(name, { text = '', hang = false, type = '' } = {}) {
  const file = { name, size: text.length, lastModified: 1700000000000, type,
    text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
  return { kind: 'file', name, getFile: () => (hang ? new Promise(() => {}) : Promise.resolve(file)) };
}
function fakeDir(name, entries = {}) {
  const dir = { kind: 'directory', name, _entries: entries, _written: {},
    async *values() { for (const e of Object.values(entries)) yield e; },
    async getFileHandle(n, { create } = {}) {
      if (entries[n] && entries[n].kind === 'file') return entries[n];
      if (!create) { const e = new Error('nope'); e.name = entries[n] ? 'TypeMismatchError' : 'NotFoundError'; throw e; }
      const fh = { kind: 'file', name: n, createWritable: async () => ({
        write: async (d) => { dir._written[n] = d; }, close: async () => { dir._written[n + '.closed'] = true; }, abort: async () => {} }) };
      entries[n] = fh; return fh;
    },
    async getDirectoryHandle(n, { create } = {}) {
      if (entries[n] && entries[n].kind === 'directory') return entries[n];
      if (!create) { const e = new Error('nope'); e.name = entries[n] ? 'TypeMismatchError' : 'NotFoundError'; throw e; }
      entries[n] = fakeDir(n); return entries[n];
    },
    isSameEntry: async (o) => o === dir,
    queryPermission: async () => 'prompt', requestPermission: async () => 'granted',
  };
  return dir;
}

test('the capability verdicts say why, in the words the UI repeats', () => {
  const was = { navigator: globalThis.navigator, showDirectoryPicker: globalThis.showDirectoryPicker, isSecureContext: globalThis.isSecureContext, matchMedia: globalThis.matchMedia };
  const set = (ua, picker, secure = true, standalone = false) => {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true });
    globalThis.showDirectoryPicker = picker; globalThis.isSecureContext = secure;
    globalThis.matchMedia = () => ({ matches: standalone });
  };
  try {
    set('Mozilla/5.0 (Macintosh) Chrome/129.0 Safari/537.36', () => {});
    assert.deepEqual(F.folderCapability(), { ok: true, why: '', browser: 'Chrome', installed: false }, 'Chrome on a computer');
    set('Mozilla/5.0 (Windows) Chrome/129.0 Safari/537.36 Edg/129.0', () => {}, true, true);
    assert.deepEqual(F.folderCapability(), { ok: true, why: '', browser: 'Edge', installed: true }, 'an installed Edge app');
    set('Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/130.0', undefined);
    assert.deepEqual(F.folderCapability(), { ok: false, why: 'no-picker', browser: 'Firefox', installed: false }, 'Firefox: no picker');
    set('Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1.15', undefined);
    assert.equal(F.folderCapability().why, 'no-picker', 'Safari: no picker');
    set('Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile Safari/537.36', () => {});
    assert.deepEqual(F.folderCapability(), { ok: false, why: 'mobile', browser: 'Chrome', installed: false }, 'a phone, even with the function present');
    set('Mozilla/5.0 (Macintosh) Chrome/129.0 Safari/537.36', () => {}, false);
    assert.equal(F.folderCapability().why, 'insecure', 'http: the API is not exposed');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: was.navigator, configurable: true, writable: true });
    globalThis.showDirectoryPicker = was.showDirectoryPicker; globalThis.isSecureContext = was.isSecureContext; globalThis.matchMedia = was.matchMedia;
  }
});

test('a shell overrides the platform; omitted keys keep the web answer', () => {
  F.setFilesPlatform({ capability: () => ({ ok: true, why: '', browser: 'shell', installed: true }) });
  assert.equal(F.folderCapability().browser, 'shell');
  F.setFilesPlatform(null);
  assert.notEqual(F.folderCapability().browser, 'shell', 'reset to the web');
});

test('every read has a clock: a cloud placeholder that never delivers cannot hang the caller', async () => {
  const dir = fakeDir('Sessions', { 'a.wav': fakeFile('a.wav', { hang: true }), 'b.session': fakeFile('b.session', { text: '<Session/>' }) });
  const t0 = Date.now();
  const st = await F.statFile(dir, 'a.wav', { timeoutMs: 30 });
  assert.equal(st.available, false, 'stat reports not-available rather than waiting');
  assert.ok(Date.now() - t0 < 1000, 'and comes back at once');
  await assert.rejects(F.readFile(dir, 'a.wav', { as: 'text', timeoutMs: 30 }), (e) => e.code === 'FILES_TIMEOUT' && /a\.wav/.test(e.message),
    'a read throws a FilesTimeout that names the file');
  assert.equal(await F.readFile(dir, 'b.session', { as: 'text', timeoutMs: 30 }), '<Session/>', 'a real file reads');
  const ok = await F.statFile(dir, 'b.session', { timeoutMs: 30 });
  assert.equal(ok.available, true); assert.equal(ok.size, 10);
  assert.equal(await F.statFile(dir, 'missing.txt'), null, 'absent is null, not a throw');
  assert.equal(await F.readFile(dir, 'missing.txt'), null);
});

test('listings are names only, sorted, never bytes', async () => {
  const dir = fakeDir('root', { 'Zeta': fakeDir('Zeta'), 'alpha.sprj': fakeFile('alpha.sprj', { hang: true }), 'Sessions': fakeDir('Sessions') });
  assert.deepEqual(await F.listDir(dir), [{ name: 'alpha.sprj', kind: 'file' }, { name: 'Sessions', kind: 'directory' }, { name: 'Zeta', kind: 'directory' }],
    'a hanging file is listed like any other: no getFile() happened');
  assert.equal((await F.getDir(dir, 'Sessions')).name, 'Sessions');
  assert.equal(await F.getDir(dir, 'nope'), null, 'absent directory is null');
  assert.equal(await F.getDir(dir, 'alpha.sprj'), null, 'a file is not a directory');
  const deep = await F.ensureDir(dir, 'Sessions/x/flextext');
  assert.equal(deep.name, 'flextext'); assert.ok(dir._entries.Sessions._entries.x._entries.flextext, 'created along the path');
});

test('a write goes through a writable and is committed on close', async () => {
  const dir = fakeDir('s');
  assert.equal(await F.writeFile(dir, 'x.session', '<Session/>'), true);
  assert.equal(dir._written['x.session'], '<Session/>'); assert.equal(dir._written['x.session.closed'], true);
  assert.equal(await F.sameEntry(dir, dir), true); assert.equal(await F.sameEntry(dir, fakeDir('o')), false);
  assert.equal(await F.sameEntry(null, dir), false);
});

test('withTimeout: the loser keeps running, the caller has moved on', async () => {
  const slow = new Promise((r) => setTimeout(() => r('late'), 60));
  await assert.rejects(F.withTimeout(slow, 10, 'slow thing'), (e) => e.code === 'FILES_TIMEOUT' && e.what === 'slow thing' && e.ms === 10);
  assert.equal(await F.withTimeout(Promise.resolve('now'), 10), 'now');
  assert.equal(await F.withTimeout(slow, 0), 'late', 'zero means no clock');
});

/* ─── isolation ──────────────────────────────────────────────────────────────────────────────── */
const SRC = readFileSync(new URL('../docs/js/files.js', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

test('files.js imports nothing, touches no other storage, and reads no native global at import time', () => {
  assert.doesNotMatch(SRC, /^\s*import\s/m, 'no imports: a shell can load it alone');
  assert.doesNotMatch(SRC, /flextext-sync|flextext-lameta|localStorage|sessionStorage/, 'its own IndexedDB and nothing else');
  assert.match(SRC, /const DB_NAME = 'flextext-files'/);
  // Loaded under node with no window/navigator at all — which this test file just did.
  assert.equal(typeof F.folderCapability, 'function');
});

test('the Link button is hidden behind the flag and the owner, and says why on a browser that cannot', () => {
  assert.match(PANEL, /function lametaLinkBtnHtml\(\) \{\n  if \(!lametaLinkEnabled\(\) \|\| !Researcher\.isOwnerSelf\(\)\) return '';/, 'flag AND owner');
  assert.match(PANEL, /get\('lameta'\) === '1'\) localStorage\.setItem\(LAMETA_LINK_FLAG, '1'\)/, '?lameta=1 turns it on, once');
  assert.match(PANEL, /'lameta-link': \(\) => lametaLinkModal\(\)/, 'wired');
  const fn = PANEL.slice(PANEL.indexOf('async function lametaLinkModal()'), PANEL.indexOf('async function inviteModal('));
  assert.match(fn, /if \(!cap\.ok\) \{[\s\S]*?'panel\.lameta\.unsupported\.' \+ cap\.why/, 'the honest sentence names the reason');
  assert.match(fn, /e\.name === 'AbortError'\) return;/, 'a cancelled picker is no news');
  assert.match(fn, /rememberFolder\(lametaFolderKey\(\), handle\)/, 'the folder is remembered for the relaunch check');
  assert.match(fn, /permissionState\(saved\.handle\)/, '...and its permission state is shown on the next open');
  assert.match(fn, /filter\(\(e\) => e\.kind === 'directory'\)/, 'sessions are the directories under Sessions/');
  assert.doesNotMatch(fn, /writeFile|createInstance|mintInvite/, 'milestone 2 writes nothing and links nothing');
  const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
  for (const k of ['panel.lameta.linkBtn', 'panel.lameta.unsupported.no-picker', 'panel.lameta.unsupported.mobile', 'panel.lameta.unsupported.insecure',
    'panel.lameta.installedNote', 'panel.lameta.tabNote', 'panel.lameta.previewNote', 'panel.lameta.slowFolder', 'panel.lameta.notProject']) {
    assert.equal((i18n.match(new RegExp(`'${k.replace(/[.-]/g, '\\$&')}':`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
});

test('the panel reaches files.js by import() only, so no offline shell precaches it', () => {
  assert.doesNotMatch(PANEL, /^import[^\n]*['"]\.\/files\.js['"]/m, 'no static import');
  assert.match(PANEL, /import\('\.\/files\.js'\)/, 'a dynamic one');
  const shells = readdirSync(new URL('../satellites', import.meta.url)).map((s) => `../satellites/${s}/sw.js`).concat(['../docs/sw.js', '../paragraph-analysis/sw.js']);
  for (const sw of shells) {
    let src = ''; try { src = readFileSync(new URL(sw, import.meta.url), 'utf8'); } catch { continue; }
    assert.doesNotMatch(src, /files\.js/, `${sw} does not precache it`);
  }
});
