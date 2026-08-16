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
const strips = read('../docs/js/segment-strips.js');

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
   * the two are pinned together, with the reason.
   *
   * ⚠ The gate now lives in transportKeysApply() rather than inline. This assertion follows the
   * BEHAVIOUR, not the old line: a typed space must remain a space. What deliberately changed at the
   * same time is the BUTTON half — Space used to stand down on any focused button, which jammed the
   * key on the Baseline and Gloss tabs because focus sits on the tab button you clicked to get
   * there (v362). Text fields and open modals still win; since v383 a SELECT wins only for keys
   * other than Space — the key-conditional rule is pinned in its own section below. */
  const gate = (app.match(/function transportKeysApply\(target, key\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(!!gate, 'the space-to-play gate is one named function');
  ok(/textarea, \[contenteditable\], input:not\(\[type="range"\]\)/.test(gate),
     'space still stands down inside a text field — a typed space must remain a space');
  ok(/document\.querySelector\('\.modal:not\(\[hidden\]\)'\)/.test(gate),
     '…and inside an open dialog, whose buttons must keep their own keys');
  ok(/if \(!transportKeysApply\(e\.target, e\.key\)\) return;/.test(app), 'and the Space handler consults it');
}

/* ── TAB WALKS THE TEXT BOXES, AND NOTHING ELSE (Seth, 2026-08-13) ─────────────────────────────
 * "On baseline and gloss tabs, we don't want play and join and split controls to be part of the tab
 * (keyboard) order. Just next and previous textbox in order (so that the last gloss on a line tabs
 * to that line's free translation rather than skipping over it to the following line's first gloss
 * and the free translation tabs to the next gloss, and shift-tab works in reverse)."
 *
 * Tab is how a transcriber walks their own text; every control sitting between two boxes was a
 * keypress spent on something they did not ask for. Measured before and after in Chromium: Baseline
 * used to go text → BODY → topbar icon → title; the Gloss tab used to fall out of the list after the
 * free translation. */
console.log('\nthe controls between the text boxes are not tab stops');
{
  for (const [file, src, what] of [['segment-strips.js', strips, 'the Baseline ▶ and its ⤙⤚ join'],
                                   ['app.js', app, 'the Gloss ▶, ⤙⤚, scissors and unchain']]) {
    const hits = (src.match(/tabIndex = -1;/g) || []).length;
    ok(hits >= 2, `${what} are out of the tab order (${hits} in ${file})`);
  }
  ok(/play\.tabIndex = -1;/.test(strips) && /join\.tabIndex = -1;/.test(strips),
     'the Baseline strip\'s play and join specifically');
  ok(/btn\.tabIndex = -1;/.test(app) && /un\.tabIndex = -1;/.test(app) && /sc\.tabIndex = -1;/.test(app),
     'and the gloss line\'s play, unchain and gap scissors');
  /* ⚠ The CUT tab is deliberately untouched: it has no text boxes, its rows ARE the controls, and
   * they are focusable on purpose (the row is what Enter and Backspace act on). */
  ok(/row\.tabIndex = 0;/.test(strips), 'the Cut tab\'s rows stay focusable — there is no text there to walk');
}

console.log('\nand the free translation is part of the same walk');
{
  const freeBlock = app.slice(app.indexOf("input.className = 'free-input'"), app.indexOf("input.className = 'free-input'") + 1400);
  ok(/e\.key !== 'Tab'/.test(freeBlock) && /focusNextWordGloss\(input, e\.shiftKey \? -1 : 1\)/.test(freeBlock),
     'Tab and Shift+Tab from the free translation walk the same list as the glosses');
  ok(!/e\.key === ' '/.test(freeBlock),
     '…but Space is NOT hijacked there — a free translation is prose, and a space must stay a space');
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

/* 3. SPACE-TO-PLAY OUTRANKS EVERY CONTROL EXCEPT TYPING (Seth, 2026-08-17: "Space to play should
 *    override space to activate a UI control everywhere in the editor (except when typing in a
 *    text box)... when I've changed the play speed, I don't want the native speaker to know that
 *    they have to click the player again for space to play to work.")
 *
 *    The live case is the dock's speed picker: focus sits on the <select> after changing it, and
 *    Space used to pop the dropdown open instead of playing. The rule is KEY-CONDITIONAL, and that
 *    is the part worth pinning: Space treats a select as just another control (claimed inside the
 *    editor surface), while Enter and Backspace still stand down on one — otherwise the Cut tab's
 *    keys could cut or join the audio off a focused picker. */
console.log('\nSpace outranks the speed picker; Enter and Backspace do not');
{
  const fn = (app.match(/function transportKeysApply\(target, key\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(fn.length > 100, 'transportKeysApply takes the KEY — the select rule depends on which key it is');
  ok(/key === ' '\s*\n?\s*\? 'textarea, \[contenteditable\], input:not\(\[type="range"\]\)'/.test(fn),
     "for SPACE the typing guard has NO select — the picker cannot swallow the transport key");
  ok(/: 'textarea, select, \[contenteditable\], input:not\(\[type="range"\]\)'/.test(fn),
     'for every other key the select keeps its native behavior — Enter cannot cut off a focused picker');
  ok(/closest\('button, a\[href\], input, select, \[tabindex\]'\)/.test(fn),
     'and a select is then judged like a button: claimed inside the editor surface, left alone elsewhere');
  const sites = (app.match(/transportKeysApply\(e\.target, e\.key\)/g) || []).length;
  ok(sites === 3, `all three transport-key handlers pass the key (${sites} of 3)`);
  ok(!/transportKeysApply\(e\.target\)/.test(app), 'and none still calls it keyless');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
