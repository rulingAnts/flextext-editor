/* THE MATCHER'S TEXT-SIDE ✂, CLICKED IN THE AUDIO SEGMENTER ITSELF (Seth, 2026-10-17: "On the regular
 * audio-segmenter app … sometimes the free translation disappears when I click scissors"; "if there are TWO
 * free translation lines … they both display and are both incorporated in the split").
 *
 * test/matcher-split-translations.test.mjs runs the functions; this runs the app: a text translated in
 * English and Indonesian, NO FLEx, the view on English alone — the case where the Indonesian used to be
 * invisible while the point was chosen and gone from both halves after Done.
 *
 *   npm i playwright-core            # anywhere; this repo has no package.json by design
 *   node test/browser/matcher-split.playwright.mjs
 *
 * Env: FLEXTEXT_CHROME (a Chromium binary); FLEXTEXT_TEST_URL, a server laid out as dev-serve.sh serves
 * (/flextext-editor/ and /audio-segmenter/ under it) — without one, this checkout is served at those paths.
 *
 * ⚠ SYNTHETIC STEP, labelled [synthetic] in the output: the text and its recording are put into storage
 * through the engine's own db.js (the Segmenter has no import of its own). Everything after is a real click
 * or a real keystroke. Made-up fixture. */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP = [['/flextext-editor/', join(ROOT, 'docs')], ['/audio-segmenter/', join(ROOT, 'satellites', 'audio-segmenter')]];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let server = null, BASE = process.env.FLEXTEXT_TEST_URL;
if (!BASE) {
  server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const hit = MAP.find(([p]) => path.startsWith(p));
    const file = hit && resolve(hit[1], '.' + path.slice(hit[0].length - 1) + (path.endsWith('/') ? 'index.html' : ''));
    try {
      if (!file || !file.startsWith(hit[1])) throw new Error('outside');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}/`;
}

/* 6 s, mono 16-bit: 1.2 s of tone every 2 s (the shape gap-rows.playwright.mjs uses). */
function wavBase64(secs = 6) {
  const sr = 16000, n = sr * secs, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const v = (t % 2) < 1.2 ? Math.sin(2 * Math.PI * 180 * t) * 0.5 + Math.sin(2 * Math.PI * 420 * t) * 0.25 : 0;
    data.writeInt16LE(Math.round(v * 26000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString('base64');
}
const FLEXTEXT = `<?xml version="1.0" encoding="UTF-8"?>
<document version="2">
  <interlinear-text guid="tx000000-0000-4000-8000-000000000017">
    <item type="title" lang="qaa">Two translations</item>
    <paragraphs>
      <paragraph guid="pa000000-0000-4000-8000-000000000017">
        <phrases>
          <phrase guid="ph000000-0000-4000-8000-000000000017" begin-time-offset="0" end-time-offset="4000">
            <item type="txt" lang="qaa">aaa bbb ccc</item>
            <words>
              <word><item type="txt" lang="qaa">aaa</item></word>
              <word><item type="txt" lang="qaa">bbb</item></word>
              <word><item type="txt" lang="qaa">ccc</item></word>
            </words>
            <item type="gls" lang="en">one two three</item>
            <item type="gls" lang="id">ka kb kc</item>
          </phrase>
        </phrases>
      </paragraph>
    </paragraphs>
    <languages>
      <language lang="qaa" vernacular="true"/>
      <language lang="en"/>
      <language lang="id"/>
    </languages>
  </interlinear-text>
</document>`;

const browser = await chromium.launch({
  executablePath: process.env.FLEXTEXT_CHROME || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
page.on('pageerror', (e) => { console.log('   [pageerror]', e.message); fail++; });
const APP = BASE + 'audio-segmenter/';
const mtxt = () => page.evaluate(() => document.querySelector('#view-matcher').innerText);
const line = (k) => page.locator('#view-matcher .mg-line').nth(k);
const lineCount = () => page.locator('#view-matcher .mg-line').count();
const frees = (k) => page.evaluate((i) => [...document.querySelectorAll('#view-matcher .mg-line')[i].querySelectorAll('.mg-ft')].map((x) => x.innerText.trim()).join(' / '), k);
const stored = () => page.evaluate(async () => {
  const db = await import('/flextext-editor/js/db.js');
  const FT = await import('/flextext-editor/js/flextext.js');
  const r = await db.getDoc('split-two');
  return r.doc.paragraphs.flatMap((p) => p.segments).map((s) => [FT.freeIn(s, 'en', 'en'), FT.freeIn(s, 'id', 'en')]);
});

try {
  await page.goto(APP + '?devreset', { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForFunction(() => !!document.querySelector('#view-segmenter'), null, { timeout: 15000 });

  console.log('\n[synthetic] a text in English and Indonesian, and its recording, put into storage');
  await page.evaluate(async ([xml, b64]) => {
    const db = await import('/flextext-editor/js/db.js');
    const FT = await import('/flextext-editor/js/flextext.js');
    const { texts } = FT.parseFlextext(xml, { analLang: 'en' });
    const doc = texts[0];
    await db.putDoc({ id: 'split-two', title: doc.title, created: Date.now(), modified: Date.now(), doc });
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await db.putMedia('split-two', { blob: new Blob([bytes], { type: 'audio/wav' }), name: 'sample.wav', mimeType: 'audio/wav' });
  }, [FLEXTEXT, wavBase64()]);
  await page.goto(APP, { waitUntil: 'load' });
  await page.waitForSelector('#sg-list .sg-open:not([disabled])', { timeout: 15000 });
  await page.click('#sg-list .sg-open');
  await page.waitForFunction(() => { const v = document.querySelector('#view-matcher'); return !!v && !v.hidden && !!v.querySelector('.mg-line'); }, null, { timeout: 15000 });
  await page.waitForFunction(() => { const n = document.querySelector('#mg-audio-note'); return !n || n.hidden; }, null, { timeout: 20000 });

  console.log('\nthe view on English alone: the Indonesian is not shown');
  await page.selectOption('#mg-lang', 'primary');
  await page.waitForFunction(() => /one two three/.test(document.querySelector('#view-matcher').innerText), null, { timeout: 5000 });
  ok(!/ka kb kc/.test(await mtxt()), 'English only');

  console.log('\n✂ between aaa and bbb: BOTH translations drawn, each with its targets');
  await line(0).locator('.mg-scissors').first().click();
  await page.waitForSelector('#view-matcher .mg-ft-cut[data-lang="id"]', { timeout: 5000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll('#view-matcher .mg-ft-cut')]
    .map((r) => r.dataset.lang + ':' + [...r.querySelectorAll('span')].map((s) => s.textContent).join(' ')));
  ok(rows.join(' / ') === 'en:one two three / id:ka kb kc', 'both rows, tagged: ' + rows.join(' / '));
  const toast = () => page.evaluate(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : ''; });
  ok(/2 free translations/.test(await toast()), 'the prompt says there are two: ' + await toast());

  console.log('\nEscape puts it down; the ✂ again arms it');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#view-matcher .mg-ft-cut'), null, { timeout: 5000 });
  ok(!/ka kb kc/.test(await mtxt()) && /one two three/.test(await mtxt()) && await toast() === '', 'back to English alone, nothing changed, the prompt gone');
  await line(0).locator('.mg-scissors').first().click();
  await page.waitForSelector('#view-matcher .mg-ft-cut[data-lang="id"]', { timeout: 5000 });

  console.log('\na point in each, and the line splits');
  await page.click('#view-matcher .mg-ft-cut[data-lang="en"] .mg-ftgap[data-at="3"]');
  await page.waitForSelector('#view-matcher .mg-ft-cut[data-lang="en"] .mg-ftgap.mg-chosen', { timeout: 5000 });
  ok(await lineCount() === 1 && /id translation/.test(await toast()), 'one point: not yet, and it asks for the Indonesian');
  await page.click('#view-matcher .mg-ft-cut[data-lang="id"] .mg-ftgap[data-at="2"]');
  await page.waitForFunction(() => document.querySelectorAll('#view-matcher .mg-line').length === 2, null, { timeout: 5000 });
  ok(await toast() === '', 'split; the prompt went with it');
  await page.selectOption('#mg-lang', 'all');
  await page.waitForFunction(() => /kb kc/.test(document.querySelector('#view-matcher').innerText), null, { timeout: 5000 });
  ok(await frees(0) === 'one / ka' && await frees(1) === 'two three / kb kc', 'each half shows its part of each: ' + await frees(0) + ' | ' + await frees(1));

  console.log('\nDone: the stored text has both halves of both translations');
  await page.click('#mg-done');
  await page.waitForFunction(() => { const v = document.querySelector('#view-matcher'); return !v || v.hidden; }, null, { timeout: 15000 });
  const s = await stored();
  ok(JSON.stringify(s) === JSON.stringify([['one', 'ka'], ['two three', 'kb kc']]), 'stored: ' + JSON.stringify(s));
} catch (e) {
  ok(false, 'threw: ' + (e && e.message));
} finally {
  await browser.close();
  if (server) server.close();
}
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
