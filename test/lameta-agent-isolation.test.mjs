/* ISOLATION of the lameta device agent (plans/lameta-device.md §2): the agent and the file seam are
 * reached by import() only, so no offline shell precaches them; they share nothing with the device
 * module (sync.js) or the editor's storage; and the agent never deletes a file — the one promise a
 * researcher's own corpus folder is owed above all others. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const AGENT = read('../docs/js/lameta-agent.js');
const FILES = read('../docs/js/files.js');
const PANEL = read('../docs/js/researcher-panel.js');
const RES = read('../docs/js/researcher.js');

test('the agent imports only the two pure format modules; every platform is injected, so node can run the loop', () => {
  const imports = [...AGENT.matchAll(/^\s*import\s[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./lameta.js', './seg-exports.js'], 'the session format and the manifest builder — nothing with a browser behind it');
  assert.match(AGENT, /export function createLametaAgent\(\{ R, F,/);
});

test('nothing of sync.js or the editor storage: no session key, no sync database, no localStorage', () => {
  for (const src of [AGENT, FILES]) {
    assert.doesNotMatch(src, /flextext-sync|localStorage|sessionStorage|eraseAllData/);
  }
  assert.doesNotMatch(AGENT, /indexedDB/, 'the agent stores through files.js, never its own database');
});

test('the agent never deletes a file', () => {
  assert.doesNotMatch(AGENT, /removeEntry|deleteFile|\.remove\(/);
  // and the seam offers no deletion either — writeFile and ensureDir are the only mutations
  assert.doesNotMatch(FILES, /removeEntry/);
});

test('the panel reaches both by import() only, and no shell precaches them', () => {
  assert.doesNotMatch(PANEL, /^import[^\n]*['"]\.\/(files|lameta-agent)\.js['"]/m);
  assert.match(PANEL, /import\('\.\/lameta-agent\.js'\)/); assert.match(PANEL, /import\('\.\/files\.js'\)/);
  const shells = readdirSync(new URL('../satellites', import.meta.url)).map((s) => `../satellites/${s}/sw.js`).concat(['../docs/sw.js', '../paragraph-analysis/sw.js']);
  for (const sw of shells) {
    let src = ''; try { src = read(sw); } catch { continue; }
    assert.doesNotMatch(src, /files\.js|lameta-agent\.js/, `${sw}`);
  }
});

test('Ki never leaves researcher.js: the agent seals and opens through it', () => {
  assert.match(RES, /export function apiAsInstall\(method, path, install, opts = \{\}\)/);
  assert.match(RES, /export async function encryptForInstance\(instanceId, obj\) \{ return encryptJSON\(await getKi\(instanceId\), obj\); \}/);
  assert.match(RES, /export async function decryptForInstance\(instanceId, token\) \{ return decryptJSON\(await getKi\(instanceId\), token\); \}/);
  assert.match(RES, /auth: false \}\);\n\}/, 'install calls carry no researcher headers');
  assert.doesNotMatch(AGENT, /getKi|encryptJSON|decryptJSON|unwrapKey/);
});
