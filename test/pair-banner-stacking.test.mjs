/* THE PAIRING "CONNECT" BUTTON MUST NEVER BE COVERED BY THE BANNER THAT SITS BEHIND IT.
 *
 * WHY (Seth, 2026-09-01): "the 'Hubungkan'/'Connect' button on the device end of pairing can get
 * hidden behind the persistent 'waiting for researcher' modal/toast at the bottom, depending on
 * window size/shape (and probably mobile devices or smaller screens)."
 *
 * The mechanism, which is worth stating because the symptom hid it: `.pair-banner` is
 * `position: fixed; bottom: 12px` and the invite-consent dialog is a `.modal` whose card is
 * VERTICALLY CENTRED with `max-height: 88vh`. On a short or landscape window the card's lower edge
 * reaches down into the banner's band — and the banner outranked the modal (60 vs 40), so it
 * painted over the card and swallowed the clicks. `Connect` is the card's second-to-last child, so
 * the banner covered precisely the one control the whole pairing flow depends on. On a taller
 * window the two never meet and everything works, which is why it read as intermittent rather than
 * as a stacking rule that was simply wrong.
 *
 * ⚠ THIS IS A RULE, NOT A NUMBER. A bottom-anchored element that shows STANDING STATE belongs below
 * the modal layer; a modal is a question that must be answerable. `.update-ready-banner` already
 * says so in its own comment ("below modals, above page content") — `.pair-banner` was the outlier.
 * So the assertions below are written as inequalities against `.modal`, not as equality with 39:
 * the tier may be renumbered, but the ORDER may not be inverted.
 *
 * ⚠ AND TOASTS DELIBERATELY STAY ABOVE MODALS. They are ephemeral and one may report the outcome of
 * a modal action, so `.toast > .modal` is asserted too — a well-meaning "put modals on top of
 * everything" sweep would break that, and this test is where it should stop.
 *
 * The banner reaches BOTH the editor and the recorder (refreshPairBanner lives in the shared
 * docs/js/app.js), and the recorder is the usual device end of a pairing — so this is a
 * suite-wide fix, not an editor detail.
 *
 * Run: node test/pair-banner-stacking.test.mjs
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const css = readFileSync(new URL('../docs/css/app.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');

/* Read the z-index out of a rule by selector. Deliberately naive — one declaration per rule is the
 * house style here, and a parser that tolerated more would also tolerate the ambiguity it is
 * meant to catch. */
function zOf(selector) {
  const at = css.indexOf(selector + ' {');
  if (at < 0) return null;
  const body = css.slice(at, css.indexOf('}', at));
  const m = body.match(/z-index:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

test('a standing bottom banner never outranks the dialog it sits behind', () => {
  const modal = zOf('.modal');
  const banner = zOf('.pair-banner');
  const update = zOf('.update-ready-banner');
  const toast = zOf('#toast');   // an id, not a class — see the guard below

  console.log('\nthe layers exist and are readable');
  ok(modal !== null, `.modal declares a z-index (${modal})`);
  ok(banner !== null, `.pair-banner declares a z-index (${banner})`);

  console.log('\nthe pairing banner sits BELOW the modal layer — this is the reported bug');
  ok(banner < modal,
    banner < modal
      ? `.pair-banner (${banner}) < .modal (${modal}) — the Connect button cannot be covered`
      : `⚠ .pair-banner (${banner}) >= .modal (${modal}) — the banner will cover "Connect" on a short window`);

  console.log('\n...and still above ordinary page content, so it is not lost behind the app');
  /* ⚠ Assert the lookup SUCCEEDED rather than skipping when it returns null. A guarded `if` here
   * would turn a renamed selector into a check that quietly stops running while still reporting
   * PASS — the failure mode this repo already had to fix once in check-secrets.sh. */
  ok(update !== null, `.update-ready-banner is still a named tier (${update})`);
  ok(banner >= update,
    `.pair-banner (${banner}) >= .update-ready-banner (${update}) — the active task stays readable`);

  console.log('\ntoasts deliberately stay ABOVE modals — do not "fix" this one');
  ok(toast !== null, `the toast layer was found (${toast})`);
  ok(toast > modal,
    toast > modal
      ? `#toast (${toast}) > .modal (${modal}) — a toast can still report a modal's outcome`
      : `⚠ #toast (${toast}) <= .modal (${modal}) — a toast fired from a dialog is now invisible`);

  console.log('\nthe two elements really are the pair described above');
  ok(/\.pair-banner\s*\{[^}]*position:\s*fixed/.test(css),
     '.pair-banner is fixed-position (so z-index is what decides, not document order)');
  ok(/\.pair-banner\s*\{[^}]*bottom:/.test(css),
     '...and bottom-anchored, which is why it meets a centred card at all');
  ok(/\.modal\s*\{[^}]*position:\s*fixed/.test(css) && /\.modal\s*\{[^}]*inset:\s*0/.test(css),
     '.modal is a full-viewport fixed layer');
  ok(/data-iv="accept"/.test(app),
     'the Connect control is still the accept button this test is about');
  ok(/refreshPairBanner/.test(app),
     'the banner is still painted from the SHARED engine — editor and recorder both');

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
