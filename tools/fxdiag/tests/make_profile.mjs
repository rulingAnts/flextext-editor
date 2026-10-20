// Make a REAL Chromium profile holding made-up FlexText records at the suite's production origin,
// so the reader can be developed and tested against the genuine on-disk format.
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/playwright/index.js');
const { chromium } = require('playwright');
const [,, userDataDir] = process.argv;
const ctx = await chromium.launchPersistentContext(userDataDir, { headless: true, executablePath: '/opt/pw-browsers/chromium' });
await ctx.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }));
const page = await ctx.newPage();
await page.goto('https://rulingants.github.io/flextext-editor/');
await page.evaluate(async () => {
  localStorage.setItem('flextext-ws-settings', JSON.stringify({ vern: 'xx', vernName: 'Made-up', anal: 'en', segmentation: true }));
  localStorage.setItem('flextext-device-id', 'dev-0000-fixture');
  const db = await new Promise((res, rej) => { const r = indexedDB.open('flextext-editor', 2); r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('docs', { keyPath: 'id' }).createIndex('modified', 'modified'); d.createObjectStore('media'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const recs = [
    { id: 'doc-a', title: 'Fixture text one', modified: Date.now(), created: Date.now() - 1000, doc: { paragraphs: [{ words: [{ txt: 'lorem' }, { txt: 'ipsum' }] }], segments: [{ begin: 0, end: 1.5 }] }, upload: { state: 'pending' }, audio: { name: 'one.wav', size: 44 } },
    { id: 'doc-b', title: 'Fixture text two', modified: Date.now() - 5000, doc: { paragraphs: [] }, flex: { textGuid: '00000000-0000-0000-0000-000000000001' } },
  ];
  await new Promise((res, rej) => { const tx = db.transaction(['docs', 'media'], 'readwrite'); for (const r of recs) tx.objectStore('docs').put(r); tx.objectStore('media').put(new Blob([new Uint8Array(3000)], { type: 'audio/wav' }), 'doc-a'); tx.objectStore('media').put({ peaks: [1, 2, 3] }, 'peaks:doc-a'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
});
await page.waitForTimeout(1500);
await ctx.close();
console.log('profile written');
