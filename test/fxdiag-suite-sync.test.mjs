/* fxdiag FOLLOWS THE SUITE'S STORAGE (Seth, 2026-10-20: "we need a rule to update this when apps get updated").
 *
 * tools/fxdiag reads a computer's browser profiles for the FlexText apps' storage and ONLY that — so it has to
 * know every origin the suite lives on, every IndexedDB database the apps open and the prefix of every
 * localStorage key. Those facts live in docs/js and worker/wrangler.toml and move when an app is added or
 * renamed; this test harvests them from the source and asks fxdiag's own suite.py whether it recognises each
 * one. A new hostname, database or key that fxdiag would skip fails here, in the commit that added it.
 *
 * ⚠ It runs the check in Python (the tool IS Python) and FAILS, never skips, when no Python is found — a guard
 * that no-ops prints a reassuring line and checks nothing (CLAUDE.md, the freshness-guard lesson).
 *
 * Run: node test/fxdiag-suite-sync.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const rd = (p) => readFileSync(new URL(p, root), 'utf8');
const JS = readdirSync(new URL('docs/js/', root)).filter((f) => f.endsWith('.js')).map((f) => ['docs/js/' + f, rd('docs/js/' + f)]);

function harvest() {
  const hosts = new Set(), dbNames = new Set(), storageKeys = new Set();
  // every host the panel's estate table and the worker's origin allow-list name
  const panel = rd('docs/js/researcher-panel.js');
  const estates = panel.slice(panel.indexOf('const ESTATES = {'), panel.indexOf('\n};', panel.indexOf('const ESTATES = {')));
  for (const m of estates.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  for (const line of rd('worker/wrangler.toml').split('\n')) {
    if (!/ALLOWED_ORIGINS/.test(line) || /^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/https?:\/\/([a-z0-9.*-]+)/gi)) if (!m[1].includes('*')) hosts.add(m[1].toLowerCase());
  }
  // the beta shapes i18n.js isBetaHost accepts, by example
  for (const h of ['beta.flextext.app', 'beta-record.flextext.app', 'beta-audio-segmenter.flextext.app', 'flextext-editor-beta.68mh29kgsd.workers.dev']) hosts.add(h);
  for (const [file, src] of JS) {
    const consts = new Map([...src.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
    for (const m of src.matchAll(/indexedDB\.open\(\s*([A-Za-z_][A-Za-z0-9_]*|'[^']+')/g)) {
      const v = m[1].startsWith("'") ? m[1].slice(1, -1) : consts.get(m[1]);
      assert.ok(v, `${file}: indexedDB.open(${m[1]}) — name not resolvable to a string constant; teach the harvester`);
      dbNames.add(v);
    }
    for (const m of src.matchAll(/localStorage(?:\.(?:getItem|setItem|removeItem)\(|\[)\s*'([^']+)'/g)) storageKeys.add(m[1]);
    // a key named by an identifier (`localStorage.getItem(SETTINGS_KEY)`): resolve it to its `const X = '…'`
    // or `const X = '…' + …` in the same file; a parameter or a computed key cannot be resolved and is skipped
    const anyConst = new Map([...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
    for (const m of src.matchAll(/localStorage(?:\.(?:getItem|setItem|removeItem)\(|\[)\s*([A-Za-z_$][\w$]*)\s*[,)\]]/g)) {
      const v = anyConst.get(m[1]);
      if (v) storageKeys.add(v);
    }
  }
  const docsDb = /const DB_NAME = '([^']+)'/.exec(rd('docs/js/db.js'))[1];
  return { hosts: [...hosts].sort(), dbNames: [...dbNames].sort(), storageKeys: [...storageKeys].sort(), docsDb };
}

function python() {
  for (const [cmd, args] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const r = spawnSync(cmd, [...args, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return [cmd, args];
  }
  return null;
}

test('the harvest finds what it must (or the regexes rotted)', () => {
  const f = harvest();
  assert.ok(f.hosts.includes('rulingants.github.io') && f.hosts.includes('app.flextext.app'), JSON.stringify(f.hosts));
  assert.ok(f.dbNames.includes('flextext-editor') && f.dbNames.includes('flextext-sync'), JSON.stringify(f.dbNames));
  assert.ok(f.storageKeys.includes('flextext-ws-settings') && f.storageKeys.length > 10, JSON.stringify(f.storageKeys));
  assert.equal(f.docsDb, 'flextext-editor');
});

test('fxdiag/suite.py recognises every suite host, database and key the source names', () => {
  const py = python();
  assert.ok(py, 'no Python 3 on PATH — this test cannot run, and that is a failure, not a skip');
  assert.ok(existsSync(new URL('tools/fxdiag/tests/suite_check.py', root)));
  const r = spawnSync(py[0], [...py[1], '-I', 'tools/fxdiag/tests/suite_check.py'], { cwd: root, input: JSON.stringify(harvest()), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.problems, [], 'teach tools/fxdiag/fxdiag/suite.py the new storage facts:\n' + out.problems.join('\n'));
});

test('the stores fxdiag reads by name are the ones db.js declares', () => {
  const db = rd('docs/js/db.js'), reader = rd('tools/fxdiag/fxdiag/reader.py');
  const store = /const STORE = '([^']+)'/.exec(db)[1], media = /const MEDIA = '([^']+)'/.exec(db)[1];
  assert.ok(reader.includes(`"${store}"`) && reader.includes(`"${media}"`), `reader.py must read stores ${store} and ${media}`);
});

test('the tool is linked from the researcher panel and nowhere else', () => {
  const panel = rd('docs/js/researcher-panel.js');
  assert.match(panel, /const FXDIAG_URL = 'https:\/\/github\.com\/rulingAnts\/flextext-editor\/tree\/main\/tools\/fxdiag'/);
  assert.match(panel, /openExternal\(FXDIAG_URL\)/, 'leaves the app through openExternal like every off-site link');
  for (const [file, src] of JS) if (file !== 'docs/js/researcher-panel.js') assert.ok(!/tools\/fxdiag/.test(src), `${file} must not link the tool (panel only)`);
  for (const f of ['docs/index.html', 'satellites/text-recorder/index.html', 'paragraph-analysis/index.html']) if (existsSync(new URL(f, root))) assert.ok(!/fxdiag/.test(rd(f)), f);
  const i18n = rd('docs/js/i18n.js');
  assert.equal((i18n.match(/'panel\.feedback\.diag':/g) || []).length, 2, 'both languages');
  assert.equal((i18n.match(/'panel\.feedback\.diagTip':/g) || []).length, 2, 'both languages');
  assert.ok(existsSync(new URL('tools/fxdiag/README.md', root)), 'the link lands on a README');
});
