/* AN UNPAIRED DEVICE MUST NOT SPIN (v373). Seth deleted his device in the researcher panel; the
 * PWA kept retrying three bundles against a target that had become null, once per sweep, forever,
 * each row reading "Failed — will retry". The queue must HOLD instead: keep the items, start
 * nothing, and say why — resuming by itself when the device is paired again.
 *
 * A fresh install IS unpaired, so this needs no auth to reproduce: queue a bundle and watch.
 *
 * Run it deliberately (needs a browser and a server), like the Cut-tab harness beside it:
 *   cd docs && python3 -m http.server 8765 &
 *   node test/browser/unpaired-queue.playwright.mjs
 * Env: FLEXTEXT_TEST_URL, FLEXTEXT_CHROME. */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.FLEXTEXT_TEST_URL || 'http://localhost:8765/';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

function makeWav(path) {
  const sr = 16000, n = sr * 3;
  const d = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) d.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 200 * i / sr) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(d.length, 40);
  writeFileSync(path, Buffer.concat([h, d]));
  return path;
}
const wav = makeWav(join(mkdtempSync(join(tmpdir(), 'fxup-')), 'clip.wav'));

const browser = await chromium.launch({ executablePath: process.env.FLEXTEXT_CHROME || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on('pageerror', (e) => { console.log('   [pageerror]', e.message); fail++; });
page.on('dialog', (d) => d.accept().catch(() => {}));
const U = BASE;
await page.goto(U + '?devreset'); await page.waitForTimeout(700);
await page.goto(U); await page.waitForTimeout(900);
await page.setInputFiles('#new-audio-file', wav);
await page.waitForTimeout(5000);

console.log('\nan UNPAIRED device holds its queue instead of retrying it');
// Put a queued bundle into the store the way a paired device would have left one behind.
await page.evaluate(async () => {
  const db = await import('./js/db.js');
  await db.putMedia('upload:held-test', {
    name: 'held-bundle.zip', blob: new Blob([new Uint8Array(4096)]), mime: 'application/zip',
    total: 4096, docId: 'held-test', docTitle: 'Held test', sent: 0,
  });
});
/* ⚠ NO NETWORK ASSERTION HERE, deliberately. An earlier version counted requests to /v1/ and
 * "passed" both ways — an unpaired device never reaches the fetch at all (upload.js throws on the
 * null target first), so the count is zero with OR without the fix. The observable difference is
 * what the TRAY says, which is also the thing the user actually suffers. */
await page.evaluate(() => location.reload());
await page.waitForTimeout(9000);

const tray = await page.evaluate(() => ({
  barShown: !document.getElementById('upload-bar')?.hidden,
  label: (document.getElementById('upload-label')?.textContent || '').trim(),
  diagShown: !document.getElementById('upload-diag')?.hidden,
  diag: (document.getElementById('upload-diag-text')?.textContent || '').trim(),
  paired: null,
}));
console.log('   tray:', JSON.stringify(tray, null, 1));
ok(tray.barShown, 'the queued bundle is still shown — held, never discarded');
ok(/not linked|kept here/i.test(tray.label + ' ' + tray.diag),
   'the tray says this device is not linked to a researcher, rather than promising a retry');
ok(!/will retry/i.test(tray.label),
   `and does NOT promise "will retry shortly" (pre-fix this read "1 file(s) waiting to upload — will retry shortly.")`);
const rowText = await page.evaluate(() => {
  const t2 = document.getElementById('upload-toggle');
  if (t2 && !t2.hidden) t2.click();
  return [...document.querySelectorAll('#upload-list .up-state')].map((e) => e.textContent).join(' | ');
});
ok(!/Failed/i.test(rowText), `the row reads as kept, not failed ("${rowText}")`);

// The record must survive: losing it would lose the only copy of the bundle.
const kept = await page.evaluate(async () => {
  const db = await import('./js/db.js');
  const r = await db.getMedia('upload:held-test').catch(() => null);
  return !!(r && r.blob);
});
ok(kept, 'the bundle is still in storage, ready to go when the device is paired again');
await browser.close();
console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
