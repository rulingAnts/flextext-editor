/* The GitHub Pages researcher satellite retires itself by redirecting to Cloudflare — and must do
 * it WITHOUT touching the editor app that shares the origin.
 *
 * WHY THIS NEEDS A TEST, and why the tests are behavioural rather than greps:
 *
 *  1. ONE FILE SERVES BOTH ESTATES. apps/researcher/build.sh copies satellites/flextext-researcher/
 *     wholesale into the Cloudflare deployment. So an UNCONDITIONAL redirect in index.html would
 *     make https://research.flextext.app/ redirect to itself — an infinite loop breaking the
 *     researcher app for everyone — and an unconditional kill switch in sw.js would strip that same
 *     site of offline support. The hostname gate is the only thing preventing both, so it is tested
 *     by RUNNING the guard under each hostname, not by looking for the string.
 *
 *  2. THREE PWAs SHARE ONE ORIGIN AND ONE CacheStorage on rulingants.github.io. The kill switch
 *     must delete ONLY 'flextext-researcher-*'. The broad filter that paragraph-analysis/shell.js
 *     can safely use (delete everything not mine) would, here, delete the EDITOR's and RECORDER's
 *     caches and brick a field device offline — the paired editor Seth explicitly asked not to
 *     break. So the activate handler is executed against a fake CacheStorage holding all three
 *     apps' caches, and what survives is asserted.
 *
 *  3. The query string and fragment must survive the move: an OAuth return arrives as
 *     '#gauth=<id>.<token>' and a settings link as '?vern=…'. Dropping either silently breaks a
 *     flow that looks like it worked.
 *
 * Run: node test/researcher-legacy-redirect.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAT = join(ROOT, 'satellites/flextext-researcher');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const html = readFileSync(join(SAT, 'index.html'), 'utf8');
const swSrc = readFileSync(join(SAT, 'sw.js'), 'utf8');
const buildSh = readFileSync(join(ROOT, 'apps/researcher/build.sh'), 'utf8');

const LEGACY = 'rulingants.github.io';
const TARGET_HOST = 'research.flextext.app';

/* The premise the whole design rests on. If this ever stops being true, the hostname gates become
 * dead weight and someone should be told to revisit them rather than discovering it in production. */
ok(/cp -R \.\.\/\.\.\/satellites\/flextext-researcher\/\. public\//.test(buildSh),
   'apps/researcher/build.sh still copies this satellite into the Cloudflare deployment ' +
   '(the reason both files are hostname-gated)');

console.log('\nindex.html redirect guard — run under each hostname');

/* Pull the guard out and run it with stubbed globals. */
const guard = (html.match(/<script>\s*(\(function \(\) \{[\s\S]*?\}\)\(\);)\s*<\/script>/) || [])[1];
ok(!!guard, 'the guard is an inline IIFE the test can execute');

function runGuard(hostname, search, hash) {
  let replaced = null, written = '';
  const location = {
    hostname, search, hash,
    replace: (u) => { replaced = u; },
  };
  const document = { write: (s) => { written += s; } };
  new Function('location', 'document', guard)(location, document);
  return { replaced, written };
}

if (guard) {
  const legacy = runGuard(LEGACY, '?vern=fau', '#gauth=abc.def');
  ok(legacy.replaced === `https://${TARGET_HOST}/?vern=fau#gauth=abc.def`,
     `on ${LEGACY} it redirects, carrying search AND hash (got ${legacy.replaced})`);
  ok(/research\.flextext\.app/.test(legacy.written) && /<a href=/.test(legacy.written),
     'it writes a visible fallback link first, in case navigation is blocked');

  const cloud = runGuard(TARGET_HOST, '?x=1', '#y');
  ok(cloud.replaced === null,
     `on ${TARGET_HOST} it is INERT — otherwise the Cloudflare app redirects to itself forever`);
  ok(cloud.written === '', `on ${TARGET_HOST} it writes nothing into the page`);

  const preview = runGuard('staging-flextext-researcher.68mh29kgsd.workers.dev', '', '');
  ok(preview.replaced === null, 'on a workers.dev preview it is inert too');
  ok(runGuard('localhost', '', '').replaced === null, 'on the localhost dev rig it is inert');
}

console.log('\nsw.js kill switch — run its activate handler against a shared CacheStorage');

/* Execute sw.js with a fake worker global so the registered handlers can be invoked. */
function loadSw(hostname) {
  const handlers = {};
  const self = {
    location: { hostname, origin: 'https://' + hostname },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { self._skipWaiting = true; },
    registration: { unregister: async () => { self._unregistered = true; } },
    clients: {
      claim: async () => { self._claimed = true; },
      matchAll: async () => self._windows,
    },
    _windows: [],
  };
  /* ⚠ DERIVED FROM SOURCE, not typed. The first version of this hardcoded the satellite's cache
   * name, and bump-version.sh promptly moved it — so the test failed for a reason that had nothing
   * to do with the behaviour it guards. What matters is "the CURRENT cache survives and older own
   * ones do not", which only stays true if the current name is read from the file under test. */
  const CUR = (swSrc.match(/const VERSION = '([^']+)'/) || [])[1];
  const store = new Set([
    'flextext-v384',                          // the EDITOR's cache — a field device's offline shell
    'flextext-v383',
    'text-recorder-v311',                     // the RECORDER's cache
    'flextext-paragraph-v197',
    'flextext-researcher-v317',               // ours, an older version — must be pruned
    'flextext-researcher-' + CUR,             // ours, current — must survive on the Cloudflare side
  ]);
  const caches = {
    keys: async () => [...store],
    delete: async (k) => store.delete(k),
    open: async () => ({ match: async () => null, put: async () => {}, addAll: async () => {} }),
  };
  new Function('self', 'caches', 'location', 'fetch', 'Response',
    swSrc)(self, caches, self.location, async () => ({ ok: true }), class {});
  return { handlers, self, store };
}

const legacySw = loadSw(LEGACY);
ok(typeof legacySw.handlers.activate === 'function', 'sw.js registers an activate handler');

if (legacySw.handlers.activate) {
  legacySw.self._windows = [
    { url: `https://${LEGACY}/flextext-researcher/?mode=researcher#gauth=abc.def`,
      navigate: async function (u) { this.navigatedTo = u; } },
  ];
  let waited;
  await legacySw.handlers.activate({ waitUntil: (p) => { waited = p; } });
  await waited;

  const survivors = [...legacySw.store].sort();
  ok(survivors.includes('flextext-v384') && survivors.includes('flextext-v383'),
     "the EDITOR's caches SURVIVE — this is the paired field app, and deleting them bricks it offline");
  ok(survivors.includes('text-recorder-v311'), "the RECORDER's cache survives");
  ok(survivors.includes('flextext-paragraph-v197'), "the paragraph app's cache survives");
  ok(!survivors.some((k) => k.startsWith('flextext-researcher-')),
     'every flextext-researcher-* cache is dropped (nothing of ours is left behind)');
  ok(legacySw.self._unregistered === true, 'the worker unregisters itself, so the next visit hits the network');
  ok(legacySw.self._claimed === true, 'it claims open clients first, so it can move them');

  const moved = legacySw.self._windows[0].navigatedTo;
  ok(moved === `https://${TARGET_HOST}/?mode=researcher#gauth=abc.def`,
     `open windows are navigated on THIS launch, search and hash intact (got ${moved})`);
}

/* The Cloudflare side must be untouched: still a precaching app worker. */
const cloudSw = loadSw(TARGET_HOST);
ok(cloudSw.self._skipWaiting !== true,
   `on ${TARGET_HOST} install does NOT take the kill-switch path`);
if (cloudSw.handlers.activate) {
  let waited;
  await cloudSw.handlers.activate({ waitUntil: (p) => { waited = p; } });
  await waited;
  ok(cloudSw.self._unregistered !== true,
     `on ${TARGET_HOST} the worker does NOT unregister — that site keeps its offline support`);
  const cur = (swSrc.match(/const VERSION = '([^']+)'/) || [])[1];
  ok(cloudSw.store.has('flextext-researcher-' + cur),
     `on ${TARGET_HOST} the CURRENT cache (${cur}) is kept — only older own-versions are pruned`);
}

/* Per-ORIGIN storage is shared by all three apps here; the retiring worker must not go near it.
 * Comments are stripped first — the file's own note SAYS "never touches localStorage", and a naive
 * match on the raw source passes on the prose while missing the code. (It did, first run.) */
const swCode = swSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
ok(!/localStorage|indexedDB/i.test(swCode),
   'sw.js CODE touches neither localStorage nor IndexedDB (per-origin, shared with the editor)');

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
