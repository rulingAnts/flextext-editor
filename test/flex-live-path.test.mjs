// What keeps the FLEx desktop shell's later move to the LIVE engine cheap (plans/flex-shell-live-path.md).
// Today the shell bundles the engine it was built with and serves it from 127.0.0.1:8017. None of this
// changes that; it pins the engine-side assumptions that would otherwise quietly multiply until the move
// had to find and undo each one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const js = (f) => readFileSync(new URL('../docs/js/' + f, import.meta.url), 'utf8');
const ENGINE = readdirSync(new URL('../docs/js/', import.meta.url)).filter((f) => f.endsWith('.js'));

test('the engine never builds a recording URL — the shell hands it one, and it is used as given (§3.2)', () => {
  for (const f of ENGINE) {
    assert.doesNotMatch(js(f), /['"`]\/media\//, `${f} spells the shell's media path; use the url the bridge returned`);
  }
});

test('the staged-page marker decides only what it must — FLEx features ride on the bridge, not on it (§3.3)', () => {
  /* isFlexShellPage() reads a <meta> that stage_engine.py stamps into the BUNDLED page. A shell that loads
   * the live site gets no such stamp, so anything gated on the marker silently switches off on that day.
   * It is allowed exactly where a decision must be made before the bridge exists; every FLEx feature asks
   * isFlexShell() (the bridge answered hello() with a matching contract) instead. */
  const where = [];
  // code only: comments that NAME the function (there are several, rightly) are not callers
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  for (const f of ENGINE) {
    const src = code(js(f));
    for (const m of src.matchAll(/(?<!function )isFlexShellPage\(\)/g)) {   // calls, not the definition
      const before = src.slice(0, m.index);
      const fn = [...before.matchAll(/\n(?:export )?function (\w+)\(/g)].pop();
      where.push(`${f}:${fn ? fn[1] : '?'}`);
    }
  }
  assert.deepEqual([...new Set(where)].sort(), [
    'app.js:devResetAllowed',          // ?devreset: never inside the shell (its 127.0.0.1 is not a dev box)
    'app.js:isLocalDev',               // the relay worker: production, not a developer's wrangler dev
    'native-flex.js:mirrorConsoleToShell',   // the shell's verbose console, a shell-only diagnostic
  ], 'a new caller of isFlexShellPage() — gate it on isFlexShell() instead, or add it here with its reason '
   + 'AND to plans/flex-shell-live-path.md §3.3, because a live-loading shell needs it answered another way');
});

test('the FLEx modules a live-loading Segmenter would also have to precache are the three the plan names (§3.5)', () => {
  /* Lazy on purpose: flex-panel.js is import()ed only inside the shell, so no web user downloads it. Today
   * the shell's own server serves it; a shell that loads the live Segmenter needs the site's service
   * worker to hold these too, or the FLEx section is dead offline — the v108 failure in a new place. The
   * list is computed from the real imports, so it cannot go stale without this test saying so. */
  const sw = readFileSync(new URL('../satellites/audio-segmenter/sw.js', import.meta.url), 'utf8');
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of js(f).matchAll(/^import [^'"]*['"]\.\/([\w.-]+\.js)['"]/gm)) walk(m[1]);
  };
  walk('flex-panel.js');
  const notPrecached = [...seen].filter((f) => !sw.includes('js/' + f)).sort();
  assert.deepEqual(notPrecached, ['flex-ops.js', 'flex-panel.js', 'printview-tsv.js'],
    'the FLEx modules outside the Segmenter\'s SHELL changed — update plans/flex-shell-live-path.md §3.5 to match');
  assert.ok(sw.includes('js/native-flex.js'), 'the seam itself IS precached: app.js imports it at top level (the v108 rule)');
});

test('the contract rule is stated where the numbers live: additions are capabilities, not bumps (§3.4)', () => {
  const seam = js('native-flex.js');
  assert.match(seam, /BUMP IT ONLY FOR A CHANGE AN OLDER SHELL CANNOT SURVIVE/);
  assert.match(seam, /hello\(\)\.capabilities/);
  const py = readFileSync(new URL('../desktop/flexshell/__init__.py', import.meta.url), 'utf8');
  assert.match(py, /only for a change an older shell cannot survive/);
});
