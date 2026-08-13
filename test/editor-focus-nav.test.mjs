/* TWO FOCUS RULES A TRANSCRIBER FEELS EVERY MINUTE, AND NEITHER IS VISIBLE IN A SCREENSHOT.
 *
 * Both were reported by Seth from the v347 test drive, and both are the kind of bug that reads as
 * "the app is a bit awkward" rather than as a defect — which is why they survived this long and why
 * they need pinning rather than remembering.
 *
 * 1. CLICKING A WAVEFORM MUST RELEASE THE TEXT FIELD.
 *    "if you click on an audio recording waveform, the previously selected text box stays focused
 *    and so it types a space instead of playing."
 *    A <canvas> is not focusable, so clicking one leaves focus in the gloss box; space-to-play then
 *    deliberately stands down (a transcriber typing a space must get a space) and the space lands in
 *    the text. The click really did select the span — only the keystroke went elsewhere, which is
 *    what makes it feel like broken playback rather than a focus question.
 *
 * 2. TAB MUST REACH THE FREE TRANSLATION.
 *    "after the last gloss, it should tab to the free translation, not skip over the free
 *    translation to the first gloss of the next segment."
 *    Tab walked `.gloss-input` only, "like FLEx", so the free line was reachable by mouse or Enter
 *    but never by Tab — the one key a touch-typist uses to move on.
 *
 * Run: node test/editor-focus-nav.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = read('../docs/js/app.js');

console.log('\nclicking any waveform blurs the focused text field');
{
  const at = app.indexOf("el.closest('.player-wave, .seg-wave, .gseg-wave')");
  ok(at > 0, 'there is a handler keyed to the waveform surfaces');
  const block = app.slice(at - 700, at + 700);

  /* ⚠ ALL THREE surfaces, in ONE listener. There are three waveform renderers in three files (the
   * dock player, the baseline strips in segment-strips.js, the gloss mini-waves in app.js); a
   * blur() bolted onto each one's own pointerdown is how the fourth one silently misses out. */
  for (const cls of ['.player-wave', '.seg-wave', '.gseg-wave']) {
    ok(app.includes(cls + ',') || app.includes(cls + "'"), `${cls} is covered`);
  }
  ok(/document\.addEventListener\('pointerdown'/.test(block), 'it is delegated on document…');
  ok(/\}, true\);/.test(app.slice(at, at + 500)), '…in the CAPTURE phase, so stopPropagation cannot skip it');

  ok(/active\.closest\('input, textarea, \[contenteditable\]'\)/.test(block),
     'only a real text field is blurred — not every stray activeElement');
  ok(/active\.blur\(\)/.test(block), 'and it actually blurs');

  // pointerdown, NOT click: the space handler must be armed before the pointer is even released,
  // and a drag-to-scrub never produces a click event at all.
  ok(!/addEventListener\('click'[^)]*wave/.test(block), 'it fires on pointerdown, not click');
}

console.log('\n...and the space-to-play gate that makes it necessary is still there');
{
  /* If this gate were ever removed the blur would look pointless and someone would delete it — so
   * the two are pinned together, with the reason. */
  ok(/if \(t2\.closest && \(t2\.closest\('input, textarea, select, button, \[contenteditable\]'\)\)\) return;/.test(app),
     'space still stands down inside a text field — a typed space must remain a space');
}

console.log('\nTab and Space reach the free translation, in DOM order');
{
  const fn = (app.match(/function focusNextWordGloss\(fromInput, dir\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/#gloss-body \.gloss-input, #gloss-body \.free-input/.test(fn),
     'the walk includes the free-translation line');
  ok(!/\$\$\('#gloss-body \.gloss-input'\)/.test(fn),
     'and the gloss-only selector is gone — that WAS the bug');

  /* ⚠ ORDER. One comma-separated querySelectorAll returns DOCUMENT order (gloss, gloss, …, free,
   * next sentence). Two queries concatenated would return every gloss then every free line — the
   * same set, in an order no typist could use. A future "tidy-up" into two lists would pass a naive
   * membership test and ruin the feature, so pin the single-query shape. */
  const queries = (fn.match(/\$\$\(/g) || []).length;
  ok(queries === 1, `one query, so the order is the DOM's (${queries} found)`);

  // Enter already did this (focusNextGloss); the point of the fix is that Tab now AGREES with it.
  const enterFn = (app.match(/function focusNextGloss\(fromInput, dir\) \{[\s\S]*?\n\}/) || [''])[0];
  const sel = (s) => (s.match(/\$\$\('([^']*)'\)/) || [])[1];
  ok(sel(fn) === sel(enterFn), 'Tab and Enter now walk the SAME list instead of disagreeing');
}

console.log('\n...and Tab/Space still route through that function');
{
  ok(/e\.key === 'Tab'\)[\s\S]{0,220}?focusNextWordGloss\(g, e\.shiftKey \? -1 : 1\)/.test(app),
     'Tab (and Shift+Tab) still call it');
  ok(/e\.key === ' '\)[\s\S]{0,220}?focusNextWordGloss\(g, 1\)/.test(app), 'and Space still calls it');
  /* Boundary Enter belongs to the line SPLIT in segmentation mode (v322) — a fix to Tab must not
   * have quietly changed which listener owns Enter. */
  ok(/if \(segmentationEnabled\(\) && \(atStart \|\| atEnd\)\) return;/.test(app),
     'and segmentation-mode boundary Enter still yields to the split handler');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
