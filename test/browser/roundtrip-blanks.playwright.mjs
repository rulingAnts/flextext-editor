/* RE-IMPORTING AN ALIGNED FLEXTEXT MUST NOT EAT ITS BLANK LINES.
 *
 * ⚠ THE FIELD BUG (Seth, 2026-08-16, reproduced with his own Keru Jaha a Dehebo export before
 * fixing): open a .flextext + its recording via the pair picker, and a 53-line doc with 23 blank
 * (silence) lines became 30 lines paired against the FIRST 30 spans — silences included — with the
 * recording "ending" at 51s of 88. Everything downstream of the format module was fine (the same
 * file round-tripped node-perfect through parse/serialize); the corruption was applyBaseline's
 * classic-mode blank-line filter running while the textarea was the live editor, which it IS in
 * the pair flow, because the text opens before its audio attaches.
 *
 * WHY THIS MUST BE A BROWSER TEST: the whole failure is the LIVE FLOW — which editor view is
 * visible at which instant of the import. No node test sees that; this one drives the exact
 * gesture Seth used and then reads the persisted model out of IndexedDB.
 *
 * Run:  cd docs && python3 -m http.server 8765 &
 *       node test/browser/roundtrip-blanks.playwright.mjs
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.FLEXTEXT_TEST_URL || 'http://localhost:8765/';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const dir = mkdtempSync(join(tmpdir(), 'fxblank-'));

/* Six timed lines, two of them BLANK — the shape the editor itself exports for a text with
 * silences, and the shape FLEx round trips. Spans are contiguous out to 12s. */
const LINES = [
  ['satu dua', 0, 2000],
  ['', 2000, 4500],          // silence — a REAL span with no words
  ['tiga', 4500, 6000],
  ['', 6000, 8000],          // silence
  ['empat lima', 8000, 10000],
  ['enam', 10000, 12000],
];
const ftXml = `<?xml version="1.0" encoding="utf-8"?>
<document version="2"><interlinear-text guid="rt-blank-test">
  <item type="title" lang="fau">Blank Lines</item>
  <paragraphs>${LINES.map(([txt, a, b]) => `
    <paragraph><phrases><phrase begin-time-offset="${a}" end-time-offset="${b}">
      ${txt ? `<words>${txt.split(' ').map((w) => `<word><item type="txt" lang="fau">${w}</item></word>`).join('')}</words>` : '<words></words>'}
    </phrase></phrases></paragraph>`).join('')}
  </paragraphs>
  <languages><language lang="fau" vernacular="true"/><language lang="id"/></languages>
</interlinear-text></document>`;
const ft = join(dir, 'blanks.flextext');
writeFileSync(ft, ftXml);

// 12s WAV to match the spans.
const SR = 16000, SECS = 12;
{
  const n = SR * SECS, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * (i / SR)) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(join(dir, 'blanks.wav'), Buffer.concat([h, data]));
}

const browser = await chromium.launch({ executablePath: process.env.FLEXTEXT_CHROME || undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on('pageerror', (e) => { console.log('   [pageerror]', e.message); fail++; });

await page.goto(BASE + '?devreset', { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(800);

console.log('\nthe pair import — text first, audio second, exactly the flow that corrupted');
await page.setInputFiles('#new-pair-file', [ft, join(dir, 'blanks.wav')]);
/* Long wait ON PURPOSE: the corruption fired during the attach/decode window, after the doc had
 * already opened in the classic textarea. Returning too early would pass on the broken code. */
await page.waitForTimeout(6000);

const model = await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  const open = (name) => new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  for (const d of dbs) {
    const db = await open(d.name);
    for (const store of db.objectStoreNames) {
      if (!/doc/i.test(store)) continue;
      const rows = await new Promise((res) => { const t = db.transaction(store).objectStore(store).getAll(); t.onsuccess = () => res(t.result); });
      for (const r of rows) {
        if (r && r.doc && r.doc.paragraphs) {
          const phrases = r.doc.paragraphs.flatMap((p) => p.segments || []);
          db.close();
          return {
            nPara: r.doc.paragraphs.length,
            nBlanks: phrases.filter((p) => !(p.baseline || '').trim() && !(p.words || []).some((w) => (w.txt || '').trim())).length,
            nSegs: (r.doc.segments || []).length,
            segLastEnd: (r.doc.segments || []).length ? r.doc.segments[(r.doc.segments || []).length - 1].end : 0,
            starts: (r.doc.segments || []).map((s) => s.start),
          };
        }
      }
    }
    db.close();
  }
  return null;
});

ok(!!model, 'the imported doc is in IndexedDB');
if (model) {
  /* ⚠ THE WHOLE BUG, in three numbers. On the broken code this read 4 paragraphs / 0 blanks /
   * 4 spans ending 8000 — the silences deleted and the tail of the recording orphaned. */
  ok(model.nPara === 6, `all 6 lines survive the import (got ${model.nPara})`);
  ok(model.nBlanks === 2, `including BOTH blank (silence) lines (got ${model.nBlanks})`);
  ok(model.nSegs === 6, `six spans, 1:1 with the lines (got ${model.nSegs})`);
  ok(model.segLastEnd === 12000, `and the last span still reaches the end of the recording (got ${model.segLastEnd})`);
  ok(JSON.stringify(model.starts) === JSON.stringify([0, 2000, 4500, 6000, 8000, 10000]),
     `every span keeps its own start (${model.starts.join(',')})`);
}

console.log('\nand the strips agree with the model once they render');
{
  const strips = await page.evaluate(() => document.querySelectorAll('[class*="strip"]').length);
  ok(strips === 0 || strips >= 6, `no HALF-rendered strip set (got ${strips})`);
}

await browser.close();
console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
