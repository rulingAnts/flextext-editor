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

/* A mono 16-bit WAV: 1.2s of tone, 0.8s of silence, repeating. 20 seconds unless asked otherwise. */
function makeWav(path, secs = 20) {
  const sr = 16000, n = sr * secs;
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

console.log('\n"Guess the lines" cuts the real recording at its real pauses');
/* ⚠ The detector is measured against synthetic peaks in test/guess-splits.test.mjs. What THIS proves
 * is the other half: that the whole path works on a genuinely decoded recording — file → decode →
 * ensurePeaks → guessSplits → segments AND paragraphs — and lands the boundaries in the silences.
 * The test recording is 1.2s of tone every 2s, so a correct guess is 9 lines with boundaries in the
 * 0.8s gaps. */
ok(await page.isVisible('#btn-guess-splits'), 'the button is at the top of the tab');
await page.click('#btn-guess-splits');
await page.waitForTimeout(1200);
const guessed = await page.evaluate(() => {
  const segs = (window.__fxDoc && window.__fxDoc.segments) || null;
  const rows = document.querySelectorAll('#cut-strips .cut-row').length;
  return { rows, say: document.getElementById('cut-say').textContent };
});
ok(guessed.rows >= 8 && guessed.rows <= 11,
   `the recording came apart into one line per burst (${guessed.rows} rows for 10 bursts)`);
ok(/Guessed \d+ lines/.test(guessed.say), `and it says what it did: "${guessed.say.slice(0, 40)}…"`);
/* ⚠ EVERY BOUNDARY MUST SIT IN A SILENCE — that is the whole claim, and the first version of this
 * check counted rows instead, which proved nothing (found by review). The recording is 1.2s of tone
 * then 0.8s of silence, repeating, so a correct boundary time satisfies 1.2 ≤ (t mod 2) ≤ 2.0. The
 * times are read back off the dock player's own marks, in per cent of a 20s file. */
const marksAt = await page.evaluate(() => {
  const sr = document.querySelector('.player-wave')?.firstElementChild?.shadowRoot;
  const wrap = sr && sr.querySelector('.wrapper');
  const layer = wrap && [...wrap.children].find((c) => c.style && c.style.zIndex === '4');
  return layer ? [...layer.children].map((el) => parseFloat(el.style.left) / 100 * 20) : [];
});
const strays = marksAt.filter((t) => { const m = t % 2; return !(m >= 1.15 && m <= 2.0); });
ok(marksAt.length >= 8, `the boundaries are marked on the player (${marksAt.length})`);
ok(strays.length === 0,
   `and every one lands in a silence, not inside speech (strays: ${strays.map((s) => s.toFixed(2)).join(', ') || 'none'})`);
/* ── ✨ OVER MANUAL WORK (Seth, 2026-08-14: "having that button still active after manual
 * adjustments have been made is WAY too easy for a native speaker who isn't tech savvy to
 * accidentally ruin all the work"). Visible on a pristine guess (re-rolling it destroys nothing —
 * the detector is deterministic), GONE — not greyed — the moment one manual edit exists, and back
 * when that edit is undone. The mechanism is a comparison against the guessed boundaries stamped on
 * the doc, so no edit gesture has to know the feature exists. */
console.log('\n✨ disappears over manual work, and comes back when the work is undone');
ok(await page.isVisible('#btn-guess-splits'), 'still visible right after the guess — nothing manual to lose yet');
await page.locator('#cut-strips .gseg-join').first().click();   // ONE manual join
await page.waitForTimeout(700);
ok(await page.locator('#btn-guess-splits').isHidden(), 'one manual join and it is GONE, not greyed');
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await page.waitForTimeout(900);
ok(await page.isVisible('#btn-guess-splits'), 'undoing that join brings it back — the guess is pristine again');

// Undo puts the whole guess back in ONE step.
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await page.waitForTimeout(900);
ok(await page.locator('#cut-strips .cut-row').count() === 1,
   'and one Ctrl+Z undoes the whole guess, not one boundary of it');
ok(await page.isVisible('#btn-guess-splits'), 'and past the guess, the untouched seed shows it too');

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

/* ── ENTER ON THE BASELINE TAB, OUTSIDE A TEXT BOX ─────────────────────────────────────────────
 * Seth, 2026-08-14: "if the segment audio is active, pressing enter splits at the playhead and
 * splits the text at the end of the baseline (rather than wherever the cursor was last). If the text
 * box is focused, pressing enter splits wherever the playhead is (on the current segment) as it does
 * now." So the two Enters must divide the WORDS differently and the TIME identically — which is the
 * only thing worth asserting here, and it needs a line that has words in it to be able to see.
 *
 * Line 1 already carries "kata pertama" from the section above. */
console.log('\nEnter on BASELINE: outside a box it keeps the words, inside one it splits them');
await page.evaluate(() => document.querySelector('.top-tab[data-tab="baseline"]').click());
await page.waitForTimeout(2000);
const bLines = () => page.locator('#segment-strips .seg-text');
const bStrip = await page.locator('#segment-strips .seg-wave').first().boundingBox();
await page.mouse.click(bStrip.x + bStrip.width * 0.5, bStrip.y + bStrip.height / 2);   // playhead into line 1
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector('#segment-strips .seg-play')?.focus());
const bBefore = await bLines().count();
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const afterOutside = await page.evaluate(() => [...document.querySelectorAll('#segment-strips .seg-text')].slice(0, 2).map((el) => el.value));
ok(await bLines().count() === bBefore + 1, `one more line (${bBefore} → ${await bLines().count()})`);
ok(afterOutside[0] === 'kata pertama' && afterOutside[1] === '',
   `the words all stayed on the line, the new one is empty (${JSON.stringify(afterOutside)})`);
ok(await page.evaluate(() => document.activeElement?.classList?.contains('seg-text') !== true),
   'and the cursor was NOT dropped into a box — the next Enter still follows the playhead');
// The time really did break at the playhead, not vanish into a pending span.
ok(await page.locator('#segment-strips .seg-strip.seg-pending').count() === 0,
   'both halves carry real times, so nothing became "⋯"');
/* ⚠ AND ONE Ctrl+Z PUTS IT BACK — which needs its own step, because a chopping run types nothing and
 * typing is what otherwise creates undo points on this tab. Asserted, not assumed: the first version
 * of this check found the split was NOT captured and Ctrl+Z reached past it to the typing instead. */
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await page.waitForTimeout(1200);
const undone = await page.evaluate(() => ({
  n: document.querySelectorAll('#segment-strips .seg-text').length,
  first: document.querySelector('#segment-strips .seg-text')?.value,
}));
ok(undone.n === bBefore && undone.first === 'kata pertama',
   `and Ctrl+Z undoes the split itself, not the typing before it (${JSON.stringify(undone)})`);

console.log('\n…and a chop far down the list does not throw the view back to the top');
/* The audit that followed v368 found exactly this: renderStrips rebuilds with no scroll preservation
 * (drawStrip forces layout mid-rebuild, so the clamp fires against a near-empty container), and the
 * playhead-Enter — unlike the in-box Enter — moves no focus, so nothing recovers. Measured 8021 → 0
 * on a 60-line text: every chop of the listen-and-chop loop lost the user's place, the very thing
 * the v357 fix cured on the Cut tab. */
{
  const scroller = () => page.evaluate(() => document.querySelector('main').scrollTop);
  await page.evaluate(() => { const m = document.querySelector('main'); m.scrollTop = m.scrollHeight; });
  await page.waitForTimeout(300);
  const strips = page.locator('#segment-strips .seg-strip');
  const n = await strips.count();
  const bb = await strips.nth(n - 2).locator('.seg-wave').boundingBox();
  await page.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height / 2);
  await page.waitForTimeout(400);
  const top0 = await scroller();
  ok(top0 > 100, `the view really is scrolled well down first (${top0}px)`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const top1 = await scroller();
  ok(Math.abs(top1 - top0) < 80, `and held its place across the chop (${top0} -> ${top1})`);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
  await page.waitForTimeout(900);
  /* ⚠ PUT THE PLAYHEAD BACK. This block parks it ~2s from the end with a bottom-line span armed —
   * and the Space checks further down press play and expect it to STILL be playing 900ms later,
   * which the span-rewind rule (correctly) makes false that close to the end. The first version of
   * this block failed those checks and the app was right both times. */
  await page.evaluate(() => { document.querySelector('main').scrollTop = 0; });
  const first = await page.locator('#segment-strips .seg-strip .seg-wave').first().boundingBox();
  await page.mouse.click(first.x + first.width * 0.15, first.y + first.height / 2);
  await page.waitForTimeout(300);
}

console.log('\n…and INSIDE a box the caret still decides where the words divide');
await page.evaluate(() => {
  const el = document.querySelector('#segment-strips .seg-text');
  el.focus(); el.setSelectionRange(4, 4);          // "kata| pertama"
});
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const afterInside = await page.evaluate(() => [...document.querySelectorAll('#segment-strips .seg-text')].slice(0, 2).map((el) => el.value));
// The model trims each line, so the caret's space does not survive into line 2 — what matters is
// that the division happened AT THE CARET rather than at the end.
ok(afterInside[0] === 'kata' && afterInside[1].trim() === 'pertama',
   `the caret split the words (${JSON.stringify(afterInside)})`);
await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
await page.waitForTimeout(900);

/* ── AND THE SAME KEY ON THE OTHER TABS ────────────────────────────────────────────────────────
 * Seth: "spacebar to play/pause is jammed and doesn't work (the page glitches/appears to re-render
 * and nothing plays) until I click the big player… that's on the baseline and gloss tabs. The cut
 * tab works flawlessly."
 *
 * The cause was focus: you arrive on a tab by CLICKING ITS TAB BUTTON, so the button keeps focus and
 * Space was spent re-activating it — switchTab re-rendered the list (the "glitch") and nothing
 * played. Clicking the big player cured it only because that moved focus off the button. */
for (const tab of ['baseline', 'gloss']) {
  console.log(`\nSpace works on the ${tab.toUpperCase()} tab with focus on the tab button`);
  await page.evaluate((t) => document.querySelector(`.top-tab[data-tab="${t}"]`).click(), tab);
  await page.waitForTimeout(1800);
  await pause();
  await page.evaluate((t) => document.querySelector(`.top-tab[data-tab="${t}"]`).focus(), tab);
  const focused = await page.evaluate(() => document.activeElement.className.split(' ')[0]);
  ok(focused === 'top-tab', `focus really is on the tab button (${focused})`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(900);
  ok(await page.textContent('.player-play') === '⏸', 'Space started playback instead of re-opening the tab');
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  ok(await page.textContent('.player-play') === '▶', 'and stopped it again');
}

/* ── FOLLOWING THE PLAYING LINE, whichever transport started it (Seth: "auto-scrolling works if I
 * play the big player, but I want it to work on the play-through behavior too"). v326 exempted SPAN
 * playback from the follow rule on the grounds that the user was already looking at the line they
 * clicked — a guess, where `offScreen` is the same claim measured. */
for (const tab of ['cut', 'baseline', 'gloss']) {
  console.log(`\nplaying a line far down the ${tab.toUpperCase()} list brings it into view`);
  if (tab === 'cut') await page.click('#tab-cut');
  else await page.evaluate((t) => document.querySelector(`.top-tab[data-tab="${t}"]`).click(), tab);
  await page.waitForTimeout(2200);
  await pause();
  const playSel = tab === 'cut' ? '#cut-strips .cut-row .seg-play'
    : tab === 'baseline' ? '#segment-strips .seg-play' : '.gseg-play';
  const n = await page.locator(playSel).count();
  const idx = Math.min(7, n - 1);
  await page.evaluate(() => { document.querySelector('main').scrollTop = 0; });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => document.querySelector('main').scrollTop);
  await page.evaluate(([sel, i]) => document.querySelectorAll(sel)[i].click(), [playSel, idx]);
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => document.querySelector('main').scrollTop);
  ok(n >= 8, `the list is long enough for line ${idx} to be off screen (${n} lines)`);
  ok(after > before + 100, `the view followed the line being played (${before} → ${after})`);
  await pause();
}

/* ── TAB WALKS THE TEXT BOXES, AND NOTHING ELSE (Seth, 2026-08-13) ─────────────────────────────
 * Measured on the previous build, Baseline went text → BODY → topbar icon → title, and the Gloss tab
 * fell out of the list after the free translation. Both were the ▶/⤙⤚/✂ controls sitting between the
 * boxes and taking a keypress each. */
{
  console.log('\nTab walks the text boxes on BASELINE');
  await page.evaluate(() => document.querySelector('.top-tab[data-tab="baseline"]').click());
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    const els = document.querySelectorAll('#segment-strips .seg-text');
    ['kata satu dua', 'kata tiga empat'].forEach((v, i) => {
      if (!els[i]) return;
      els[i].value = v; els[i].dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
  await page.waitForTimeout(600);
  const stops = async (n) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(120);
      seen.push(await page.evaluate(() => (document.activeElement?.className || document.activeElement?.tagName || '?').split(' ')[0]));
    }
    return seen;
  };
  await page.evaluate(() => document.querySelector('#segment-strips .seg-text').focus());
  const bl = await stops(3);
  ok(bl.every((c) => c === 'seg-text'), `every stop is a text box (${bl.join(' → ')})`);

  console.log('\n…and on GLOSS the last gloss of a line reaches its own free translation');
  await page.evaluate(() => document.querySelector('.top-tab[data-tab="gloss"]').click());
  await page.waitForTimeout(2200);
  await page.evaluate(() => document.querySelector('#gloss-body .gloss-input').focus());
  const gl = await stops(4);
  ok(gl.every((c) => c === 'gloss-input' || c === 'free-input'),
     `no button is a tab stop (${gl.join(' → ')})`);
  ok(gl.includes('free-input'), 'the free translation is IN the walk, not skipped');
  ok(gl.indexOf('free-input') < gl.lastIndexOf('gloss-input'),
     'and it leads on to the next line\'s first gloss rather than ending the list');
}

console.log('\n…but a control OUTSIDE the editor keeps its own Space');
/* The line has to be drawn somewhere: Save, Done—send and ⟵ Back are ordinary buttons in the topbar
 * and a keyboard user must still be able to press them. */
await page.evaluate(() => document.querySelector('#btn-back')?.focus());
const beforeKey = await page.textContent('.player-play');
await page.keyboard.press('Space');
await page.waitForTimeout(600);
const stillInEditor = await page.isVisible('#view-baseline') || await page.isVisible('#view-gloss') || await page.isVisible('#view-cut');
ok(await page.textContent('.player-play') === beforeKey || !stillInEditor,
   'Space on the topbar Back button did not hijack the transport');

/* ── AND IT STILL WORKS THE SECOND TIME THE TEXT IS OPENED. Seth, 2026-08-14, on a real .m4a:
 * "guess isn't working". It worked on the first open of that text and refused on every one after.
 *
 * The FIRST load of any recording caches 12000 display peaks on its media record; every load after
 * that hands those to wavesurfer instead of decoding, and getDecodedData() then returns a PICTURE of
 * the audio — an AudioBuffer of 12000 samples whose "sample rate" is 12000/duration. ensurePeaks
 * bucketed that at 2000 buckets a second, so most buckets held nothing, and the detector honestly
 * reported a recording with no speech in it.
 *
 * ⚠ IT ONLY BITES RECORDINGS OVER ABOUT A MINUTE, which is why this needs its own file. The share of
 * frames carrying real data is 12000/(2000 × seconds) = 6/seconds — 30% at 20 seconds, where the
 * 90th-percentile "speech level" still lands on real audio, but under 10% beyond a minute, where
 * both percentiles land on zero and guessSplits correctly refuses to guess. A first version of this
 * check reused the 20-second fixture above and PASSED WITH THE BUG IN.
 *
 * ⚠ AND THE PLAYER MUST BE READY BEFORE THE CUT TAB ASKS. The first prepareCutAudio after a reload
 * usually wins and decodes the blob itself; it is the SECOND arrival, with a loaded player to ask,
 * that takes the player's word for what the audio is. Leaving the tab and coming back is what a
 * transcriber does anyway. */
console.log('\na LONG recording is still readable the second time its text is opened');
const long = makeWav(join(mkdtempSync(join(tmpdir(), 'fxcut2-')), 'long.wav'), 75);
await page.evaluate(() => document.querySelector('#btn-back')?.click());
await page.waitForTimeout(1200);
await page.setInputFiles('#new-audio-file', long);
await page.waitForTimeout(6000);
if (await page.isHidden('#view-cut')) await page.click('#tab-cut');
await page.waitForTimeout(4000);
ok(await page.locator('#cut-strips .cut-row').count() === 1, 'the 75-second recording opens as one whole-file span');
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.click('#doc-list li');
await page.waitForTimeout(2500);
if (await page.isHidden('#view-cut')) await page.click('#tab-cut');
await page.waitForTimeout(3500);
await page.click('.top-tab[data-tab="baseline"]');
await page.waitForTimeout(2500);
await page.click('#tab-cut');
await page.waitForTimeout(4000);
const reopened = await page.evaluate(() => {
  const g = document.getElementById('btn-guess-splits');
  return { disabled: !!g?.disabled, title: g?.title || '' };
});
ok(!reopened.disabled, `✨ is still live after a reopen ("${reopened.title.slice(0, 44)}…")`);
// Guarded: with the bug present the button is DISABLED, and an unguarded click times out with a
// stack trace instead of the one-line failure this suite reports everything else with.
if (!reopened.disabled) { await page.click('#btn-guess-splits'); await page.waitForTimeout(2000); }
const reRows = await page.locator('#cut-strips .cut-row').count();
ok(reRows >= 30, `and it finds the pauses it would have found on the first open (${reRows} rows for 37 bursts)`);

await browser.close();
console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
