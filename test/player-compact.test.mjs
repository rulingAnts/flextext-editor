/* THE STICKY PLAYER AND THE CUT HINT MUST SHRINK ON A SMALL SCREEN — AND THE BUTTONS MUST NOT.
 *
 * WHY (Seth, 2026-09-01): "on a small screen, our large audio player needs to be more compact. So
 * does our instructions text on the cut screen (or maybe have it appear on clicking an
 * instructions/information/exclamation point button next to the auto-cut button)?" — then, on the
 * range: "for larger screens, a larger player is good … but for smaller ones, we need a smaller
 * player", and "a small screen would also include, for example, a Samsung Galaxy Tab A9 tablet".
 *
 * Measured in a browser at 375px before the change: the dock was 162px and the Cut hint another
 * 162px — 324px of chrome above the work, on a viewport around 640px tall, and the dock is
 * position:sticky so it is spent on every screen of a session, not once.
 *
 * ⚠ THE ONE RULE THAT MUST NOT BE "OPTIMISED" LATER: the transport buttons are not shrunk.
 * .icon-btn2 is already only ~30px tall — under the 44px a field phone deserves — so a future pass
 * looking for pixels must take them from the waveform, the wrapping, and redundant labels, never
 * from the controls. This test fails if a small-screen block starts setting padding or font-size on
 * the transport, which is what that mistake would look like.
 *
 * ⚠ AND THE TIERS MUST STAY A GRADIENT. Seth asked for a larger player on larger screens, so the
 * tablet tier and the phone tier are deliberately different numbers, not one breakpoint doing both.
 *
 * Run: node test/player-compact.test.mjs
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const css  = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
const app  = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');

/* Return the body of a media query by its exact condition text. */
const block = (cond) => {
  const at = css.indexOf(`@media ${cond} {`);
  if (at < 0) return null;
  let i = css.indexOf('{', at), depth = 0, start = i;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start + 1, i);
  }
  return null;
};

test('the player and the cut hint compact by tier, without shrinking the transport', () => {
  const tabletCond = '(max-width: 1024px), (max-height: 700px)';
  /* ⚠ HEIGHT, not width. Keying this on width put a Galaxy Tab A9 in portrait (533 x 893) into the
   * tightest tier beside a phone — narrow, but with 893px of height and nothing to save — while a
   * phone in landscape (640 x 360) escaped it by being "wide". The dock is sticky; it costs height. */
  const phoneCond  = '(max-width: 560px), (max-height: 560px)';
  const tablet = block(tabletCond);
  const phone  = block(phoneCond);

  console.log('\nboth tiers exist — "small" is a tablet as well as a phone');
  ok(tablet !== null, `tier A exists: @media ${tabletCond}`);
  ok(phone  !== null, `tier B exists: @media ${phoneCond}`);
  /* Height is in tier A on purpose: a phone in landscape is wide and desperately short, and the
   * player is sticky, so width alone would call that viewport roomy. */
  ok(/max-height/.test(tabletCond), 'tier A also keys on HEIGHT — the dock is sticky, height is what it costs');
  ok(/max-width/.test(phoneCond) && /max-height/.test(phoneCond),
     'tier B keys on EITHER dimension — width alone missed phone landscape, height alone missed a tall phone');
  /* ⚠ Seth, 2026-09-01: "It's screen size that matters to me, not device type." An earlier version
   * sniffed pointer:coarse to tell an 11" tablet from a same-sized laptop window; that is the exact
   * distinction he does not want drawn. If it reappears, this is where it should be caught. */
  ok(!/pointer/.test(tabletCond) && !/pointer/.test(phoneCond),
     'neither tier sniffs the input device — size decides, not device type');

  console.log('\nthe waveform is where the height comes from, and it is a gradient');
  const waveOf = (b) => { const m = b && b.match(/\.player-wave\s*\{[^}]*min-height:\s*(\d+)px/); return m ? Number(m[1]) : null; };
  const base = (css.match(/\n\.player-wave \{ min-height: (\d+)px; \}/) || [])[1];
  const wTablet = waveOf(tablet), wPhone = waveOf(phone);
  ok(base && wTablet && wPhone, `three sizes declared (desktop ${base}, tablet ${wTablet}, phone ${wPhone})`);
  ok(Number(base) > wTablet && wTablet > wPhone,
     `larger screen = larger player: ${base} > ${wTablet} > ${wPhone}`);

  console.log('\n⚠ the transport buttons are NOT shrunk in either tier');
  for (const [name, b] of [['tier A', tablet], ['tier B', phone]]) {
    const touched = /\.(player-play|player-home|player-back|icon-btn2)\s*\{[^}]*(padding|font-size|min-width|height)/.test(b || '');
    ok(!touched, touched
      ? `⚠ ${name} resizes a transport control — take the pixels from the waveform instead`
      : `${name} leaves .player-play / .player-home / .player-back / .icon-btn2 alone`);
  }

  console.log('\nthe zoom word is clipped, not deleted — the slider keeps an accessible name');
  ok(/\.player-zoom-label\s*\{[^}]*clip-path:\s*inset\(50%\)/.test(tablet || ''),
     'the label is clipped (screen-reader-only), not display:none');
  ok(/class="player-zoom"[^>]*data-i18n-aria="player\.zoom"/s.test(html)
     || /data-i18n-aria="player\.zoom"[^>]*class="player-zoom"/s.test(html),
     'the range input carries its own translated aria-label');
  ok(/data-i18n-aria/.test(i18n) && /setAttribute\('aria-label', t\(el\.dataset\.i18nAria\)\)/.test(i18n),
     'applyI18n actually applies data-i18n-aria — an unread hook would be decoration');

  console.log('\n⚠ a laptop is NOT a small screen — 1366x768 is one of the commonest displays there is');
  {
    const h = Number((tabletCond.match(/max-height:\s*(\d+)px/) || [])[1]);
    ok(h > 0 && h < 768,
       h < 768 ? `tier A's height arm is ${h}px — below 768, so an ordinary laptop keeps the full player`
               : `⚠ tier A fires at ${h}px tall, which swallows 1366x768 laptops and makes the release note false`);
  }

  console.log('\n⚠ the instructions are never hidden while the ℹ that reveals them is off screen');
  /* #btn-cut-hint lives inside #cut-main, which is [hidden] until the recording decodes and stays
   * hidden for a text with no recording at all. Without this rule the hint and its only control
   * disappear together, on the one tab whose gestures are not guessable. */
  ok(/#view-cut:has\(#cut-main\[hidden\]\) #cut-hint \{ display: block; \}/.test(css),
     'the hint stays put while #cut-main is hidden (loading, or no recording at all)');

  console.log('\nthe Cut hint folds behind ℹ on small screens, and ONLY on small screens');
  ok(/#btn-cut-hint \{ display: none; \}/.test(css),
     'the button is hidden by default — on a wide screen the hint is simply visible');
  ok(/#cut-hint \{ display: none; \}/.test(tablet || '') && /#cut-hint\.is-open/.test(tablet || ''),
     'the hint collapses inside the small-screen tier, with an is-open escape');
  ok(/id="cut-hint"/.test(html) && /aria-controls="cut-hint"/.test(html),
     'the button is wired to the hint for assistive tech (aria-controls)');
  ok(/aria-expanded/.test(html) && /setAttribute\('aria-expanded'/.test(app),
     'and aria-expanded reflects the real state, not just the initial one');
  ok(/btn-cut-hint.*addEventListener|#btn-cut-hint'\)\?\.addEventListener/s.test(app),
     'the toggle is wired up');

  console.log('\nthe ✨ button’s own label is translated now, not hardcoded English');
  ok(/id="btn-guess-splits"[\s\S]{0,200}data-i18n-aria="cut\.guess"/.test(html),
     'btn-guess-splits carries data-i18n-aria (its aria-label was English-only)');

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
