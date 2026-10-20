// Make a REAL Chromium profile holding MADE-UP FlexText records at the suite's production origin, so
// fxdiag can be developed and tested against the genuine on-disk format (LevelDB, Blink, V8).
//   node tests/make_profile.mjs <empty dir>      then zip Default/IndexedDB + "Default/Local Storage/leveldb"
//                                                 (no LOCK files) into tests/fixtures/profile-fixture.zip
// The records are built IN THE PAGE with the engine's own parser (docs/js/flextext.js, served into the
// fake origin by a Playwright route), so their shape is exactly what the app stores. Everything in them
// is invented: "Fixture text one/two", lorem/ipsum, a 3000-byte recording of zeros, a fake auth token.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.FXDIAG_PLAYWRIGHT || '/opt/node-tools/node_modules/playwright/index.js');
const { chromium, firefox } = require('playwright');
// FXDIAG_BROWSER=firefox writes a Firefox profile instead (zip the profile's storage/default/<suite origins>
// into tests/fixtures/firefox-fixture.zip): the gecko reader's test runs only when that fixture exists.
const engine = process.env.FXDIAG_BROWSER === 'firefox' ? firefox : chromium;
const here = dirname(fileURLToPath(import.meta.url));
const jsDir = join(here, '..', '..', '..', 'docs', 'js');
const [,, userDataDir] = process.argv;
const ctx = await engine.launchPersistentContext(userDataDir, { headless: true, ...(engine === chromium ? { executablePath: process.env.FXDIAG_CHROMIUM || '/opt/pw-browsers/chromium' } : {}) });
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  const m = /\/js\/([a-z-]+\.js)$/.exec(u.pathname);
  if (m) return route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(join(jsDir, m[1]), 'utf8') });
  return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>fixture</title>' });
});
const page = await ctx.newPage();
await page.goto('https://rulingants.github.io/flextext-editor/');
const XML_A = `<?xml version="1.0" encoding="utf-8"?><document version="2"><interlinear-text guid="11111111-1111-4111-8111-111111111111">
<item type="title" lang="en">Fixture text one</item><paragraphs><paragraph><phrases>
<phrase begin-time-offset="0" end-time-offset="1500"><item type="txt" lang="xx">lorem ipsum.</item><words>
<word><item type="txt" lang="xx">lorem</item><item type="gls" lang="en">one</item></word><word><item type="txt" lang="xx">ipsum</item></word><word type="punct"><item type="punct" lang="xx">.</item></word>
</words><item type="gls" lang="en">a made-up line</item></phrase>
<phrase begin-time-offset="1500" end-time-offset="2600"><item type="txt" lang="xx">dolor</item><words><word><item type="txt" lang="xx">dolor</item></word></words></phrase>
</phrases></paragraph></paragraphs><languages><language lang="xx" font="Charis SIL" vernacular="true"/><language lang="en" font="Charis SIL"/></languages></interlinear-text></document>`;
const XML_B = `<?xml version="1.0" encoding="utf-8"?><document version="2"><interlinear-text guid="22222222-2222-4222-8222-222222222222"><item type="title" lang="en">Fixture text two</item><paragraphs/><languages><language lang="xx" vernacular="true"/><language lang="en"/></languages></interlinear-text></document>`;
await page.evaluate(async ({ XML_A, XML_B }) => {
  const { parseFlextext, segmentsFromOffsets } = await import('/flextext-editor/js/flextext.js');
  localStorage.setItem('flextext-ws-settings', JSON.stringify({ vern: 'xx', vernName: 'Made-up', anal: 'en', segmentation: true }));
  localStorage.setItem('flextext-device-id', 'dev-0000-fixture');
  localStorage.setItem('flextext-researcher-auth', 'made-up-token-value-0000');
  const docA = parseFlextext(XML_A).texts[0]; docA.segments = segmentsFromOffsets(docA);   // a record holds ONE text of the parsed document, as the app stores it
  const docB = parseFlextext(XML_B).texts[0];
  const now = Date.now();
  const recs = [
    { id: 'doc-a', title: 'Fixture text one', modified: now, created: now - 1000, doc: docA, upload: { state: 'pending' }, driveFolderId: 'folder-0000' },
    { id: 'doc-b', title: 'Fixture text two', modified: now - 5000, created: now - 9000, doc: docB, flex: { textGuid: '00000000-0000-0000-0000-000000000001' } },
  ];
  const db = await new Promise((res, rej) => { const r = indexedDB.open('flextext-editor', 2); r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('docs', { keyPath: 'id' }).createIndex('modified', 'modified'); d.createObjectStore('media'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise((res, rej) => { const tx = db.transaction(['docs', 'media'], 'readwrite'); for (const r of recs) tx.objectStore('docs').put(r); tx.objectStore('media').put(new Blob([new Uint8Array(3000)], { type: 'audio/wav' }), 'doc-a'); tx.objectStore('media').put({ peaks: [1, 2, 3] }, 'peaks:doc-a'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
  return recs.length;
}, { XML_A, XML_B });
await page.waitForTimeout(1500);
await ctx.close();
console.log('profile written');
