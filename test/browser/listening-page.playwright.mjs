/* THE EXPORTED LISTENING PAGE, DRIVEN BY KEYBOARD AND WATCHED FOR SCROLL.
 *
 * Seth, 2026-08-15: "add the auto-scrolling and space to play/pause behavior to the preview/
 * listening html pages our app suite exports … on the model of what we already have for various
 * editor tabs and paragraph analysis tool."
 *
 * ⚠ WHY THIS CANNOT BE A NODE TEST. Everything here is behaviour a string cannot have: whether a
 * key reaches a handler, whether preventDefault stopped a focused button from re-firing, whether
 * the document actually scrolled, and whether it stayed still when it should. Asserting that the
 * generated HTML *contains* the word scrollIntoView would prove nothing at all — that is the
 * "guard that asserts nothing" shape, and this repo has been bitten by it twice this week.
 *
 * Run (no server needed — the page is self-contained, so file:// is the honest way to load it):
 *   node test/browser/listening-page.playwright.mjs
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMiniXmlDom } from '../lib/mini-xml-dom.mjs';

installMiniXmlDom();
const { buildSegPreviewHtml } = await import('../../docs/js/seg-exports.js');

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const dir = mkdtempSync(join(tmpdir(), 'fxlisten-'));

// 40 seconds of quiet tone at 8 kHz — long enough that 25 rows cannot fit on one screen, which is
// the whole point: a follow-scroll that is never needed is never tested.
const SR = 8000, SECS = 40, ROWS = 25;
function wavB64() {
  const n = SR * SECS, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 200 * (i / SR)) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString('base64');
}

const per = (SECS * 1000) / ROWS;
const doc = {
  title: 'Long Story', paragraphs: [], segments: [],
};
for (let i = 0; i < ROWS; i++) {
  doc.paragraphs.push({ segments: [{
    baseline: `line ${i + 1} of the story`, free: `free translation ${i + 1}`,
    words: [{ txt: `kata${i + 1}`, gls: `word${i + 1}` }],
    attrs: { 'begin-time-offset': String(Math.round(i * per)), 'end-time-offset': String(Math.round((i + 1) * per)) },
  }] });
}
const page1 = join(dir, 'story.preview.html');
writeFileSync(page1, buildSegPreviewHtml(doc, {
  title: 'Long Story', audioB64: wavB64(), audioMime: 'audio/wav', mediaName: 'story.wav',
}));

const browser = await chromium.launch({
  executablePath: process.env.FLEXTEXT_CHROME || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => { console.log('   [pageerror]', e.message); fail++; });
await page.goto('file://' + page1, { waitUntil: 'load' });
await page.waitForTimeout(1500);           // decode + first draw

const scrollY = () => page.evaluate(() => window.scrollY);
// The page keeps its Audio object in a closure, so ask the DOM what it is showing instead — the
// master button's glyph IS the play state, and reading the visible truth is better than the state.
const playing = async () => (await page.textContent('#mplay')).trim() === '⏸';
const activeRowIndex = () => page.evaluate(() =>
  [...document.querySelectorAll('.seg[data-s]')].findIndex((r) => r.classList.contains('on')));

console.log('\nthe page builds and is scrollable at all');
{
  ok((await page.$$('.seg[data-s]')).length === ROWS, `${ROWS} rows rendered`);
  const h = await page.evaluate(() => document.body.scrollHeight - window.innerHeight);
  ok(h > 400, `the page is taller than the window by ${h}px — a follow-scroll has somewhere to go`);
  ok(!(await playing()), 'and it starts paused');
}

console.log('\nSPACE plays and pauses');
{
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  ok(await playing(), 'Space starts playback');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  ok(!(await playing()), 'Space again pauses it');
  /* ⚠ Space must not ALSO scroll the document — the browser's default for the key. If this fails,
   * every play/pause jumps the reader a screenful down, which is worse than not having the key. */
  const before = await scrollY();
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  ok(Math.abs((await scrollY()) - before) < 5, 'and preventDefault stops Space scrolling the page');
}

console.log('\nSPACE AFTER CLICKING A LINE\'S ▶ pauses — it does not re-press the button');
{
  /* ⚠ THE BUG THIS EXISTS TO PREVENT, which the editor shipped once: focus stays on the button you
   * clicked, so without preventDefault the key re-activates it. On this page that would RESTART the
   * line instead of pausing it — the reader presses Space to stop and it starts over, forever. */
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.$$eval('.seg[data-s] .play', (b) => b[2].click());
  await page.waitForTimeout(500);
  ok(await playing() === false, 'the MASTER button does not claim whole-file playback — a span is armed');
  const wasOn = await activeRowIndex();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const btn = (await page.$$eval('.seg[data-s] .play', (b) => b[2].textContent)).trim();
  ok(btn === '▶', `the line's button shows paused, not restarted (glyph "${btn}")`);
  const nowOn = await activeRowIndex();
  ok(nowOn === wasOn, `and the playhead did not jump back to the line start (row ${wasOn} → ${nowOn})`);
}

console.log('\nthe view FOLLOWS the playing line');
{
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  /* Jump the playhead deep into the recording, then play: the active row is far below the fold, so
   * a working follow must bring it into view. Seeking is done through the page's own overview
   * scrub, which is how a reader would do it. */
  await page.evaluate(() => {
    const ov = document.getElementById('ov');
    const r = ov.getBoundingClientRect();
    ov.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * 0.8, clientY: r.top + r.height / 2, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const beforeScroll = await scrollY();
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500);
  const afterScroll = await scrollY();
  ok(afterScroll > beforeScroll + 100,
     `playing a line far down the page scrolled the view to it (${beforeScroll} → ${afterScroll})`);
  const idx = await activeRowIndex();
  const vis = await page.evaluate((i) => {
    const r = document.querySelectorAll('.seg[data-s]')[i].getBoundingClientRect();
    const head = document.querySelector('.player').getBoundingClientRect().bottom;
    return r.top >= head - 2 && r.bottom <= window.innerHeight + 2;
  }, idx);
  ok(vis, `and the playing row (${idx}) is fully visible, not tucked under the sticky player`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
}

console.log('\n⚠ SCRUBBING WHILE PAUSED MUST NOT SCROLL — the gate the app does not need');
{
  /* This page lets you drag any waveform to move the playhead, and tick() runs whether or not audio
   * is playing. Without the !audio.paused gate, dragging across the overview smooth-scrolls the
   * page once per row crossed — yanking the view out from under the hand that is dragging. It is
   * the one way this feature could make the page worse than it was. */
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  ok(!(await playing()), 'precondition: paused');
  const before = await scrollY();
  await page.evaluate(() => {
    const ov = document.getElementById('ov');
    const r = ov.getBoundingClientRect();
    ov.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + r.height / 2, bubbles: true }));
    for (let f = 1; f <= 10; f++) {
      ov.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + (r.width * f * 0.07), clientY: r.top + r.height / 2, bubbles: true }));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const after = await scrollY();
  ok(Math.abs(after - before) < 5,
     `dragging the whole overview while paused moved the playhead but NOT the page (${before} → ${after})`);
  const idx = await activeRowIndex();
  ok(idx > 3, `…and the playhead really did move (active row ${idx} of ${ROWS})`);
}

console.log('\na manual scroll suspends the follow for a few seconds');
{
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  // A wheel gesture is what says "I am reading somewhere else" — the app's rule, copied.
  await page.mouse.move(450, 400);
  await page.mouse.wheel(0, 250);
  await page.waitForTimeout(150);
  const parked = await scrollY();
  await page.keyboard.press('Space');
  await page.waitForTimeout(1800);
  const after = await scrollY();
  ok(Math.abs(after - parked) < 30,
     `the view stayed where the reader put it (${parked} → ${after}) rather than chasing the audio`);
  await page.keyboard.press('Space');
}

console.log('\nthe TEXT-ONLY INTERLINEAR flavor is a working document (v380)');
{
  /* Same generator, audioB64:'' — the node suite pins what the string contains; this proves the
   * page a browser actually renders: rows visible, nothing throws, and no control pretends there
   * is sound. A parse error in the flavor branch would show up here and nowhere else. */
  const page2 = join(dir, 'story.interlinear.html');
  writeFileSync(page2, buildSegPreviewHtml(doc, { title: 'Long Story' }));
  await page.goto('file://' + page2, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  ok((await page.$$('.seg')).length === ROWS, `all ${ROWS} interlinear rows render`);
  ok((await page.$$('.play, #ov, #mplay')).length === 0, 'and not one play control or canvas exists on the page');
  ok((await page.textContent('title')).includes('interlinear'), 'the tab names it interlinear');
  const y0 = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  ok((await page.evaluate(() => window.scrollY)) > y0,
     'Space simply scrolls, as on any document — no handler was shipped to swallow it');
}

await browser.close();
console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
