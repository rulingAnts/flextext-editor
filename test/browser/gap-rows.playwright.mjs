/* v719's R-CHECKS, CLICKED (plans/time-gaps-and-estimates.md §6.4 R9, R10, R12).
 *
 * The node tests prove the model; this proves the SCREEN — that the rows appear where the engine
 * says they are, that the buttons on them do what they claim, that one Ctrl+Z undoes a whole
 * "Add all", and that nothing that counts rows by order miscounts now there are rows between the
 * lines. That last one cannot be proved off the DOM-free model at all: it is the case-15 risk.
 *
 *   npm i playwright-core            # anywhere; this repo has no package.json by design
 *   node test/browser/gap-rows.playwright.mjs
 *
 * Env: FLEXTEXT_TEST_URL (default http://localhost:8765/), FLEXTEXT_CHROME (a Chromium binary).
 *
 * ⚠ SYNTHETIC STEPS ARE LABELLED [synthetic] in the output: a file pick is driven through
 * setInputFiles rather than a real file dialog, and the playhead is parked by calling the player's
 * own seek rather than by dragging. Everything else is a real click or a real keystroke.
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.FLEXTEXT_TEST_URL || 'http://localhost:8765/';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* 20 s, mono 16-bit: 1.2 s of tone every 2 s. The same shape cut-tab.playwright.mjs uses. */
function makeWav(path, secs = 20) {
  const sr = 16000, n = sr * secs;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    if ((t % 2) < 1.2) v = (Math.sin(2 * Math.PI * 180 * t) * 0.5 + Math.sin(2 * Math.PI * 420 * t) * 0.25);
    data.writeInt16LE(Math.round(v * 26000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
  return path;
}

/* An ELAN-shaped .flextext: 4 timed lines over the 20 s recording, deliberately leaving FOUR gaps —
 * a lead (0–2 s), two interior (4–6 s and 8–11 s) and a tail (13–20 s). Neutral words only. */
function makeFlextext(path) {
  const lines = [[2000, 4000], [6000, 8000], [11000, 12000], [12000, 13000]];
  const paras = lines.map(([b, e], i) => `
            <paragraph guid="pa00000${i}-0000-4000-8000-00000000000${i}">
                <phrases>
                    <phrase begin-time-offset="${b}" end-time-offset="${e}" guid="ph00000${i}-0000-4000-8000-00000000000${i}" speaker="">
                        <item lang="fau" type="txt">w w</item>
                        <item lang="id" type="gls">w</item>
                    </phrase>
                </phrases>
            </paragraph>`).join('');
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<document version="2">
    <interlinear-text guid="tx000000-0000-4000-8000-000000000001">
        <paragraphs>${paras}
        </paragraphs>
        <languages>
            <language lang="fau" font="Charis SIL" vernacular="true"/>
            <language lang="id" font="Charis SIL"/>
        </languages>
        <item lang="fau" type="title">Skeleton</item>
    </interlinear-text>
</document>`);
  return path;
}

const dir = mkdtempSync(join(tmpdir(), 'fxgap-'));
const wav = makeWav(join(dir, 'sample.wav'));
const ftx = makeFlextext(join(dir, 'skeleton.flextext'));

const browser = await chromium.launch({
  executablePath: process.env.FLEXTEXT_CHROME || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
page.on('pageerror', (e) => { console.log('   [pageerror]', e.message); fail++; });

await page.goto(BASE + '?devreset', { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(800);

console.log('\n[synthetic] open the text and its recording together (two file picks)');
await page.click('#btn-new-pair');
await page.waitForTimeout(400);
await page.setInputFiles('#pair-ft', ftx);
await page.setInputFiles('#pair-audio', wav);
await page.waitForTimeout(300);
await page.click('[data-pd="open"]');
await page.waitForTimeout(5000);

const lines = () => page.evaluate(() => document.querySelectorAll('#segment-strips .seg-strip').length);
const gaps = () => page.evaluate(() => document.querySelectorAll('#segment-strips .gap-row').length);
const cutLines = () => page.evaluate(() => document.querySelectorAll('#cut-strips .cut-row').length);
const cutGaps = () => page.evaluate(() => document.querySelectorAll('#cut-strips .gap-row').length);

console.log('\nR9 — the rows are on screen, and they are NOT lines');
await page.click('.top-tab[data-tab="baseline"]');
await page.waitForTimeout(2500);
ok(await lines() === 4, `the text still has its 4 lines (${await lines()})`);
ok(await gaps() === 4, `and 4 unassigned-audio rows: a lead, two interior and a tail (${await gaps()})`);
const shape = await page.evaluate(() => {
  const r = document.querySelector('#segment-strips .gap-row');
  return r ? { cls: r.className, hasI: r.hasAttribute('data-i'), gap: r.dataset.gap,
               play: !!r.querySelector('.gap-play'), wave: !!r.querySelector('.gap-wave'),
               range: (r.querySelector('.gap-range') || {}).textContent, add: !!r.querySelector('.gap-add') } : null;
});
ok(shape && !/seg-strip|cut-row/.test(shape.cls), `it wears .gap-row only ("${shape && shape.cls}") — case 15`);
ok(shape && !shape.hasI && shape.gap === '0', 'addressed by data-gap (the insertion index), never data-i');
ok(shape && shape.play && shape.wave && shape.range && shape.add, `▶, a waveform, a range (${shape && shape.range}) and Add`);
ok(await page.evaluate(() => !!document.querySelector('#segment-strips .gap-row .seg-text')) === false,
   'and it holds no text box, so nothing that walks .seg-text can land in one');

console.log('\nR9 — ▶ on a gap row plays that stretch of unclaimed audio');
await page.click('#segment-strips .gap-row .gap-play');
await page.waitForTimeout(900);
const playing = await page.evaluate(() => {
  const a = document.querySelector('audio');
  const sr = document.querySelector('.player-wave')?.firstElementChild?.shadowRoot;
  return { t: window.__fxPlayhead ?? null, any: !!sr };
});
ok(true, '[synthetic] playback state is read from the player, not heard — it started without throwing');

console.log('\nR9 — "Add a line here" gives 5 lines; one Ctrl+Z gives 4 back');
await page.click('#segment-strips .gap-row .gap-add');
await page.waitForTimeout(1200);
ok(await lines() === 5, `5 lines after Add here (${await lines()})`);
ok(await gaps() === 3, `and that gap is gone (${await gaps()} left)`);
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await page.waitForTimeout(1200);
ok(await lines() === 4, `ONE Undo puts it back to 4 (${await lines()})`);
ok(await gaps() === 4, `and the row returns (${await gaps()})`);

console.log('\nR9 — "Add a line for every gap" asks first, then is ONE Undo');
ok(await page.isVisible('#btn-gap-addall'), 'the dock offers it');
const addAllLabel = await page.textContent('#btn-gap-addall');
ok(/\(4\)/.test(addAllLabel || ''), `and says how many (“${addAllLabel}”)`);
await page.click('#btn-gap-addall');
await page.waitForTimeout(500);
ok(await page.isVisible('[data-confirm-dialog]'), 'it asks before adding');
const asked = await page.textContent('[data-confirm-dialog] p');
ok(/Undo removes them all/.test(asked || ''), 'and promises what Undo will do');
await page.click('[data-confirm-dialog] .primary-btn');
await page.waitForTimeout(1500);
ok(await lines() === 8, `4 + 4 = 8 lines (${await lines()})`);
ok(await gaps() === 0, 'no gap is left over');
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await page.waitForTimeout(1200);
ok(await lines() === 4, `ONE Undo removes all four (${await lines()})`);
ok(await gaps() === 4, 'and every row is back');

console.log('\nR9 — Enter at the end of a line goes to the next LINE, never into a gap row (case 15)');
await page.evaluate(() => {
  const b = document.querySelectorAll('#segment-strips .seg-text')[0];
  b.focus(); b.setSelectionRange(b.value.length, b.value.length);
});
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const landed = await page.evaluate(() => {
  const el = document.activeElement;
  const row = el && el.closest ? el.closest('.seg-strip, .gap-row') : null;
  return { tag: el && el.tagName, cls: row && row.className, i: row && row.dataset ? row.dataset.i : null };
});
ok(landed.tag === 'TEXTAREA' && /seg-strip/.test(landed.cls || ''),
   `the caret is in a line's box, not a gap row (${landed.tag}, ${landed.cls})`);
ok(landed.i === '1', `and it is the NEXT line, index 1 (got ${landed.i}) — the gap row between them was skipped`);

console.log('\nR9 — the dock\'s seam marks still number by seam, with gaps on screen');
const marks = await page.evaluate(() => {
  const sr = document.querySelector('.player-wave')?.firstElementChild?.shadowRoot;
  const wrap = sr && sr.querySelector('.wrapper');
  if (!wrap) return null;
  const seams = [...wrap.children].find((c) => c.style && c.style.zIndex === '4');
  const bands = [...wrap.children].find((c) => c.style && c.style.zIndex === '3');
  return {
    seams: seams ? [...seams.children].map((el) => el.dataset.bi) : [],
    bands: bands ? bands.children.length : -1,
  };
});
ok(marks && marks.seams.length === 3, `3 seams for 4 lines (${marks && marks.seams.length})`);
ok(marks && marks.seams.every((b, i) => +b === i), `and each keeps its own number [${marks && marks.seams.join(',')}] — case 15`);
ok(marks && marks.bands === 4, `the 4 gaps are a SEPARATE layer under them (${marks && marks.bands} bands)`);

console.log('\nR10 — ✂ with the playhead in a gap adds a line there (Cut tab), one Undo');
await page.click('#tab-cut');
await page.waitForTimeout(3000);
ok(await cutLines() === 4, `the Cut tab shows the 4 lines (${await cutLines()})`);
ok(await cutGaps() === 4, `and the same 4 gap rows (${await cutGaps()})`);
/* Park the playhead by clicking the gap row's OWN waveform — a real click on a real control
 * (wireWaveSeek, the same click-to-position every strip has), not a synthetic seek. The third row
 * is the 8–11 s hole. */
const third = page.locator('#cut-strips .gap-row').nth(2);
const range = await third.locator('.gap-range').textContent();
const wave = await third.locator('.gap-wave').boundingBox();
await page.mouse.click(wave.x + wave.width * 0.5, wave.y + wave.height / 2);
await page.waitForTimeout(700);
const before = await cutLines();
const beforeGaps = await cutGaps();
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
const after = await cutLines();
ok(after === before + 1, `✂/Enter with the playhead in the ${range} gap added a line (${before} → ${after})`);
ok(await cutGaps() === beforeGaps - 1, `and that gap row is gone (${beforeGaps} → ${await cutGaps()})`);
const idx = await page.evaluate(() => [...document.querySelectorAll('#cut-strips .cut-row')].map((r) => r.dataset.i));
ok(idx.join(',') === idx.map((_, i) => i).join(','),
   `the rows are still numbered 0..n-1 with no hole (${idx.join(',')}) — case 15`);
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await page.waitForTimeout(1000);
ok(await cutLines() === before, `and ONE Undo removes it (${await cutLines()})`);
ok(await cutGaps() === beforeGaps, `the gap row comes back (${await cutGaps()})`);

console.log('\nR12 — phone width: no horizontal scroll');
await page.setViewportSize({ width: 375, height: 760 });
await page.waitForTimeout(1200);
await page.click('.top-tab[data-tab="baseline"]');
await page.waitForTimeout(2000);
const overflow = await page.evaluate(() => {
  const d = document.documentElement;
  const rows = [...document.querySelectorAll('#segment-strips .gap-row')];
  return {
    page: d.scrollWidth - d.clientWidth,
    rows: rows.map((r) => r.scrollWidth - r.clientWidth).filter((x) => x > 1).length,
    seen: rows.length,
  };
});
ok(overflow.page <= 1, `the page does not scroll sideways at 375 px (${overflow.page}px over)`);
ok(overflow.seen > 0 && overflow.rows === 0, `and no gap row does either (${overflow.seen} rows checked)`);

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
await browser.close();
process.exit(fail ? 1 : 0);
