/* THE CUT TAB, DRIVEN IN A REAL BROWSER.
 *
 * WHY THIS EXISTS. The Cut tab is DOM, canvas and a rAF loop — there is no pure model to assert
 * against, so test/cut-tab-ui.test.mjs can only check the SHAPE of the source. Two releases in a row
 * (v355, v356) shipped with "⚠ still unverified in a browser" in their commit message and both were
 * wrong in ways no source-grep could see: a row class that did not exist, and per-segment waveforms
 * wired to nothing at all. This test is the answer to that: it opens the app, imports a recording,
 * cuts it, and looks at what actually happened.
 *
 * It is NOT part of the node suite (it needs a browser and a server). Run it deliberately:
 *
 *   cd docs && python3 -m http.server 8765 &
 *   npm i playwright-core            # anywhere; this repo has no package.json by design
 *   node test/browser/cut-tab.playwright.mjs
 *
 * Env: FLEXTEXT_TEST_URL (default http://localhost:8765/), FLEXTEXT_CHROME (a Chromium binary).
 * The recording it works on is generated here — bursts separated by silence, so the waveform has
 * structure to click at — and nothing is left behind but a temp file.
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.FLEXTEXT_TEST_URL || 'http://localhost:8765/';
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* A 20s mono 16-bit WAV: 1.2s of tone, 0.8s of silence, repeating. */
function makeWav(path) {
  const sr = 16000, n = sr * 20;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    if ((t % 2) < 1.2) {
      v = (Math.sin(2 * Math.PI * 180 * t) * 0.5 + Math.sin(2 * Math.PI * 420 * t) * 0.25)
        * (0.6 + 0.4 * Math.sin(2 * Math.PI * 7 * t));
    }
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

const wav = makeWav(join(mkdtempSync(join(tmpdir(), 'fxcut-')), 'sample.wav'));
const browser = await chromium.launch({
  executablePath: process.env.FLEXTEXT_CHROME || undefined,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on('pageerror', (e) => { console.log('   [pageerror]', e.message); fail++; });

await page.goto(BASE + '?devreset', { waitUntil: 'load' });   // this origin's settings/docs/SW
await page.waitForTimeout(600);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.setInputFiles('#new-audio-file', wav);
await page.waitForTimeout(3000);

console.log('\nthe Cut tab opens on a doc with audio');
ok(await page.isVisible('#tab-cut'), 'its tab button is shown (segmentation + cutTab both default on)');
await page.click('#tab-cut');
await page.waitForTimeout(4000);
ok(await page.isVisible('#cut-main'), 'the strips are built once the recording has decoded');

console.log('\nthere is ONE whole-file waveform, and it is the dock player\'s');
ok((await page.locator('#cut-big').count()) === 0, 'the tab draws no second overview of its own');
const rows = () => page.locator('#cut-strips .cut-row');
ok(await rows().count() >= 1, `per-segment strips rendered (${await rows().count()})`);

console.log('\nclicking a STRIP places the playhead — the whole point of the tab');
const b = await rows().first().locator('.seg-wave').boundingBox();
await page.mouse.click(b.x + b.width * 0.6, b.y + b.height / 2);
await page.waitForTimeout(300);
const at = await page.textContent('.player-time');
ok(/0:1[0-9]/.test(at || ''), `the one player followed the click (${at})`);
ok(await rows().first().locator('.seg-cursor').count() === 1, 'the strip shows the playhead');
ok(await rows().first().locator('.cut-scissors').count() === 1, 'and the ✂ button rides it');

console.log('\nEnter cuts there, and the cut appears as a mark on the player');
const before = await rows().count();
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
ok(await rows().count() === before + 1, `one more strip (${before} → ${await rows().count()})`);
const marks = await page.evaluate(() => {
  // The marks live in wavesurfer's SHADOW ROOT, positioned in per cent — see Player.setBoundaries.
  const sr = document.querySelector('.player-wave')?.firstElementChild?.shadowRoot;
  const wrap = sr && sr.querySelector('.wrapper');
  const layer = wrap && [...wrap.children].find((c) => c.style && c.style.zIndex === '4');
  return layer ? { n: layer.children.length, css: layer.children[0]?.getAttribute('style') || '' } : { n: 0, css: '' };
});
ok(marks.n === 1, `one boundary marked on the dock waveform (${marks.n})`);
ok(/dotted/.test(marks.css) && /%/.test(marks.css), `dotted, and placed in per cent so zoom keeps it in register`);

console.log('\nSpace plays and pauses wherever focus is');
await page.evaluate(() => document.getElementById('tab-cut').focus());
await page.keyboard.press('Space');
await page.waitForTimeout(900);
ok(await page.textContent('.player-play') === '⏸', 'Space started playback with the TAB BUTTON focused');
await page.keyboard.press('Space');
await page.waitForTimeout(400);
ok(await page.textContent('.player-play') === '▶', 'and Space paused it again');

console.log('\nan open dialog keeps its own keys — Space must not play behind it');
/* The Cut tab claims Space at document level, which is what makes it work with focus on the tab
 * button. The cost, found by the v357 preflight review, is that a Send/consent/record dialog sitting
 * OVER the tab had its buttons deadened while the recording played behind it. */
await page.evaluate(() => { document.getElementById('share-menu').hidden = false; });
await page.evaluate(() => document.querySelector('#share-menu button')?.focus());
await page.keyboard.press('Space');
await page.waitForTimeout(500);
ok(await page.textContent('.player-play') === '▶', 'Space inside the dialog did NOT start playback');
await page.evaluate(() => { document.getElementById('share-menu').hidden = true; });

/* ⚠ Every step below leaves the transport in a known state, because a rolling player SCROLLS the
 * list (followLine), which would quietly wreck the scroll assertion further down. */
const pause = async () => {
  if (await page.textContent('.player-play') === '⏸') {
    await page.evaluate(() => document.querySelector('.player-play').click());
    await page.waitForTimeout(300);
  }
};

console.log('\narriving on the tab DISARMS the span watcher a Baseline line left running');
/* The most ordinary route to this tab is "listen to a line, come over to re-cut it" — and the
 * watcher armed by that line's playSpan would pause playback at its end, on the one tab whose whole
 * promise is that playback runs on through the cuts. Found by the v357 preflight review. */
await pause();
await page.evaluate(() => document.querySelector('.top-tab[data-tab="baseline"]').click());
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('#segment-strips .seg-play').click());   // span 0
await page.waitForTimeout(400);
await page.click('#tab-cut');
await page.waitForTimeout(2500);
await page.waitForTimeout(11000);   // span 0 ends at ~12s; a live watcher would have paused there
const past = await page.textContent('.player-time');
ok(await page.textContent('.player-play') === '⏸',
   `still rolling past the end of the line that was playing when the tab was entered (${past})`);
await pause();

/* ── THE TWO TRANSPORTS ANSWER DIFFERENT QUESTIONS (Seth, refining v357). Both are checked here
 * from the SAME starting position — parked just inside span 0's end — so the only variable is which
 * control was used. */
const parkNearSeam = async () => {
  const w = await rows().first().locator('.seg-wave').boundingBox();
  await page.mouse.click(w.x + w.width * 0.95, w.y + w.height / 2);
  await page.waitForTimeout(250);
};

/* ⚠ "Ended paused" is NOT enough to prove a span stopped at its boundary — it starts paused too, so
 * the same assertion passes on a button that does nothing at all (found by the v359 preflight
 * review, about the first version of this very check). Each transport is therefore watched at TWO
 * moments, and the seam crossing is asserted on the CLOCK, not narrated in the message. */
const secs = async () => {
  const txt = (await page.textContent('.player-time')) || '';
  const m = txt.match(/(\d+):(\d\d)/);
  return m ? (+m[1] * 60 + +m[2]) : -1;
};
const SEAM = 12;   // span 0 is 0–12s: the first cut, made at 60% of a 20s recording

console.log('\na strip\'s own ▶ plays THAT LINE and stops at its end');
await parkNearSeam();
await page.evaluate(() => document.querySelector('#cut-strips .cut-row .seg-play').click());
await page.waitForTimeout(400);
ok(await page.textContent('.player-play') === '⏸', 'it really did start playing');
await page.waitForTimeout(3000);   // long enough to have crossed the seam, had it been allowed to
const stoppedAt = await secs();
ok(await page.textContent('.player-play') === '▶',
   'and then stopped — "play this line" means the line, as on every other tab');
ok(stoppedAt <= SEAM, `without ever crossing the seam (ended at ${stoppedAt}s, seam ${SEAM}s)`);
await pause();

console.log('\n…and SPACE, from the same spot, runs ON through the seam');
await parkNearSeam();
await page.keyboard.press('Space');
await page.waitForTimeout(3000);
const spaceAt = await secs();
ok(await page.textContent('.player-play') === '⏸', 'still rolling');
ok(spaceAt > SEAM, `and past the seam (${spaceAt}s > ${SEAM}s) — Space is the continuous transport`);
await pause();

console.log('\n…and so does the dock player\'s own ⏵, the other control Seth named');
await parkNearSeam();
await page.evaluate(() => document.querySelector('.player-play').click());
await page.waitForTimeout(3000);
const dockAt = await secs();
ok(await page.textContent('.player-play') === '⏸', 'still rolling');
ok(dockAt > SEAM, `and past the seam (${dockAt}s > ${SEAM}s)`);
await pause();

console.log('\nplacing the playhead PAUSES — on a strip and on the big player alike');
/* Seth: "if the user clicks on a player at all (to place a playhead) playback should pause." A click
 * during playback used to move the playhead and then immediately run on from it, so the spot the
 * user was aiming at had already slid away before they could cut at it. */
await page.evaluate(() => document.querySelector('.player-play').click());   // start it rolling
await page.waitForTimeout(700);
ok(await page.textContent('.player-play') === '⏸', 'playing, to have something to interrupt');
await parkNearSeam();
ok(await page.textContent('.player-play') === '▶', 'a click on a STRIP waveform paused it');
await page.evaluate(() => document.querySelector('.player-play').click());
await page.waitForTimeout(700);
ok(await page.textContent('.player-play') === '⏸', 'playing again');
const dock = await page.locator('.player-wave').boundingBox();
await page.mouse.click(dock.x + dock.width * 0.35, dock.y + dock.height / 2);
await page.waitForTimeout(400);
ok(await page.textContent('.player-play') === '▶', 'and a click on the BIG player paused it too');

console.log('\nand a cut does not throw the view back to the top');
/* Enough rows that the list genuinely scrolls — with only a screenful the clamp-to-top this guards
 * against is unobservable, and the test passes either way. Each cut takes a slice off the FRONT of
 * the last span, so the spans stay comfortably above MIN_SEGMENT_MS however many are made. */
for (let k = 0; k < 8; k++) {
  await rows().last().scrollIntoViewIfNeeded();   // a row below the fold cannot be clicked at all
  const last = await rows().last().locator('.seg-wave').boundingBox();
  if (!last) break;
  await page.mouse.click(last.x + last.width * 0.15, last.y + last.height / 2);
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}
await page.evaluate(() => { const m = document.querySelector('main'); m.scrollTop = m.scrollHeight; });
await page.waitForTimeout(200);
const was = await page.evaluate(() => document.querySelector('main').scrollTop);
const lb = await rows().last().locator('.seg-wave').boundingBox();
await page.mouse.click(lb.x + lb.width * 0.5, lb.y + lb.height / 2);
await page.waitForTimeout(200);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const now = await page.evaluate(() => document.querySelector('main').scrollTop);
ok(was > 200, `the list really was scrolled well down first (${was}px)`);
// Tight on purpose: the failure this guards is a slam to 0, and a loose bound would pass through it.
ok(Math.abs(now - was) < 40, `and held its place across the cut (${was} → ${now})`);

console.log('\nand a seek on the big player brings that line into the middle of the view');
/* The other half of "the one overview and the strips stay in sync": seeking on the whole-file player
 * is how you find your place in a long recording, and landing there with the line off screen leaves
 * you hunting for the row you just picked.
 *
 * ⚠ It runs HERE, after the cutting loop, because it needs a list long enough for "off screen" to
 * mean something — with two rows on a screenful, the assertion would pass without any scrolling
 * having happened at all. The precondition is asserted rather than assumed. */
await page.evaluate(() => { document.querySelector('main').scrollTop = 0; });
await page.waitForTimeout(300);
const beforeReveal = await page.evaluate(() => {
  const rs = [...document.querySelectorAll('#cut-strips .cut-row')];
  const last = rs[rs.length - 1];
  return { rows: rs.length, lastTop: Math.round(last.getBoundingClientRect().top), h: window.innerHeight };
});
ok(beforeReveal.rows >= 8 && beforeReveal.lastTop > beforeReveal.h,
   `the last line really is off screen to begin with (${JSON.stringify(beforeReveal)})`);
const dockBox = await page.locator('.player-wave').boundingBox();
/* ⚠ NOT the very end of the recording: its row is the LAST one, and no scroller can put its last
 * row in the middle of the window — the assertion would be testing gravity, not the feature. 85%
 * lands on a row with several below it, so centring is actually possible. */
await page.mouse.click(dockBox.x + dockBox.width * 0.85, dockBox.y + dockBox.height / 2);
await page.waitForTimeout(1200);   // the tickers honour the request on their next pass
const revealed = await page.evaluate(() => {
  const on = document.querySelector('#cut-strips .cut-row.seg-on');
  if (!on) return { err: 'no row holds the playhead' };
  const r = on.getBoundingClientRect();
  const m = document.querySelector('main');
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: window.innerHeight,
           atEnd: m.scrollTop >= m.scrollHeight - m.clientHeight - 2 };
});
ok(!revealed.err && revealed.top >= 60 && revealed.bottom <= revealed.h - 20,
   `the line for that instant scrolled into view (${JSON.stringify(revealed)})`);
ok(!revealed.err && (Math.abs((revealed.top + revealed.bottom) / 2 - revealed.h / 2) < 160 || revealed.atEnd),
   'and it is near the MIDDLE of the window (or as close as the end of the list allows)');
await pause();

console.log('\na segment carrying text is grey, and refuses to be cut');
await page.evaluate(() => document.querySelector('.top-tab[data-tab="baseline"]').click());
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const el = document.querySelector('#segment-strips .seg-text');
  el.value = 'kata pertama';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
await page.click('#tab-cut');
await page.waitForTimeout(2500);
ok(await page.locator('#cut-strips .cut-row.cut-locked').count() >= 1, 'the texted row is marked locked');
await page.evaluate(() => { document.querySelector('main').scrollTop = 0; });
const g = await rows().first().locator('.seg-wave').boundingBox();
await page.mouse.click(g.x + g.width * 0.5, g.y + g.height / 2);
await page.waitForTimeout(200);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const say = await page.textContent('#cut-say');
ok(/already has words|sudah ada kata/.test(say || ''), `and says why: "${(say || '').slice(0, 48)}…"`);

await browser.close();
console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
