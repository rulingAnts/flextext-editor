/* EVERY FILE THE ENGINE NEEDS TO START IS IN EVERY OFFLINE APP'S PRECACHE.
 *
 * Found 2026-09-11 while adding #68's language-name table: js/typing.js and js/external-link.js
 * (v653) and js/lameta.js (v665) are static imports of app.js, yet no service worker precached them.
 * Each worker answers from its OWN versioned cache and deletes the old one on activate, so a device
 * that installed or updated while online, and next opened the app offline, asked the network for
 * typing.js, got the worker's empty 504, and the whole module graph failed to load: a dead app, in
 * exactly the place (a village, no signal) this suite exists for.
 *
 * DEVELOPERS.md already said to add new top-level imports to every SHELL. Nothing checked it. This
 * does, by walking the real import graph rather than a list someone has to remember to update.
 *
 * Dynamic import() is deliberately NOT followed: those load on demand (flac.js, the language-name
 * table), and a worker caches them the first time they are fetched. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// The apps that work offline. The Researcher satellite precaches nothing (an online console) and the
// crowd recorder's worker is a tombstone, so neither has a SHELL to check.
const OFFLINE_SHELLS = [
  ['docs/sw.js', ''],
  ['satellites/audio-segmenter/sw.js', '/flextext-editor/'],
  ['satellites/consent-collector/sw.js', '/flextext-editor/'],
  ['satellites/text-recorder/sw.js', '/flextext-editor/'],
  ['paragraph-analysis/sw.js', '/flextext-editor/'],
];

const IMPORT = /(?:^|[\s;])(?:import|export)\s+(?:[\w$*{}\s,]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;

function staticGraph(entry) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const m of bare(rd(join('docs', rel))).matchAll(IMPORT)) walk(normalize(join(dirname(rel), m[1])));
  };
  walk(entry);
  return [...seen];
}

function shellOf(sw) {
  const m = /const SHELL = \[([\s\S]*?)\n\];/.exec(bare(rd(sw)));
  assert.ok(m, `${sw} declares a SHELL list`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

test('every module app.js loads at startup is precached by every app that works offline', () => {
  const graph = staticGraph('js/app.js');
  assert.ok(graph.includes('js/i18n.js') && graph.includes('js/typing.js') && graph.length >= 25,
    `the walk reached the whole engine (${graph.length} modules)`);
  for (const [sw, prefix] of OFFLINE_SHELLS) {
    const shell = shellOf(sw);
    assert.deepEqual(graph.filter((m) => !shell.has(prefix + m)), [], `${sw}: every startup module is precached`);
  }
});

test('the walk follows multi-line and re-export forms, and not dynamic import()', () => {
  const src = "import {\n  a,\n  b as c,\n} from './one.js';\nexport { d } from './two.js';\nconst x = await import('./three.js');\nimport './four.js';";
  const found = [...src.matchAll(IMPORT)].map((m) => m[1]);
  assert.deepEqual(found, ['./one.js', './two.js', './four.js']);
});
