/* EVERY MODAL'S CLOSE BUTTON ACTUALLY CLOSES IT.
 *
 * WHY THIS FILE EXISTS. modal() handled Escape and the backdrop click, but NOT the cancel button —
 * each caller was expected to add `m.el.querySelector('[data-m="cancel"]').onclick = m.close` by
 * hand. Most did. The release-notes modal (v494) did not, and shipped with a Close button that did
 * nothing; Seth found it, not the suite, because nothing here could see it: the markup was right, the
 * helper was right, and the one line joining them was absent.
 *
 * That is the shape worth guarding — not "is the button there" but "is the button connected".
 *
 * ⚠ THE FIX WAS TO MOVE THE WIRING INTO modal() so a caller CANNOT forget, which in turn made close()
 * idempotent necessary: callers still wire it themselves, so both paths fire, and `onClose` runs the
 * caller's teardown. For the converter modal that teardown destroys WaveSurfer players and revokes
 * object URLs — doing it twice is not free. Both properties are asserted.
 *
 * Run: node test/modal-close.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const panel = read('../docs/js/researcher-panel.js');

console.log('\nthe helper wires the cancel button itself, so no caller can forget');
{
  const fn = (panel.match(/function modal\(innerHtml, wide, onClose\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/wrap\.querySelectorAll\('\[data-m="cancel"\], \[data-m="close"\]'\)\.forEach\(\(b\) => b\.addEventListener\('click', close\)\);/.test(fn),
     '⚠ modal() binds every dismissal button to close — the v494 dead-button class, closed at the source');
  ok(/if \(e\.key === 'Escape'\)[\s\S]{0,40}close\(\);/.test(fn), '...Escape still closes');
  ok(/if \(e\.target === wrap\) close\(\);/.test(fn), '...and so does the backdrop');
}

console.log('\n...and closing twice is a no-op, because both paths now fire');
{
  const fn = (panel.match(/function modal\(innerHtml, wide, onClose\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/let closed = false;/.test(fn) && /if \(closed\) return;\s*\n\s*closed = true;/.test(fn),
     '⚠ close() guards re-entry — onClose is a TEARDOWN (WaveSurfer players, object URLs), not a notification');
}

console.log('\nboth dismissal conventions are bound, not just the one I happened to use');
{
  /* ⚠ THE PANEL HAS TWO NAMES FOR ONE ACT: data-m="cancel" and data-m="close". Binding only the
   * first would leave the identical dead-button hole open under the other name — which is how the
   * v494 bug would have come back wearing a different attribute.
   *
   * ⚠ AN EARLIER VERSION OF THIS TEST tried to extract every modal body and prove each offered a way
   * out. It could not: a regex stops at the first backtick, so multi-line bodies were truncated
   * before their buttons and it reported four false positives. A test that cannot parse what it
   * checks is worse than no test — it was replaced with this, which checks the one thing that
   * actually decides the outcome. */
  const fn = (panel.match(/function modal\(innerHtml, wide, onClose\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/querySelectorAll\('\[data-m="cancel"\], \[data-m="close"\]'\)/.test(fn),
     '⚠ BOTH data-m="cancel" and data-m="close" are bound centrally');
  for (const act of ['save', 'clear']) {
    ok(!new RegExp(`\\[data-m="${act}"\\][^)]*addEventListener\\('click', close\\)`).test(fn),
       `...and data-m="${act}" is NOT — an action button's caller decides whether the modal survives it`);
  }
  // Both names are genuinely in use, so neither branch of the selector is dead weight.
  ok(panel.split('data-m="cancel"').length - 1 > 5, 'data-m="cancel" is in real use');
  ok(panel.split('data-m="close"').length - 1 > 1, 'data-m="close" is in real use too');
}

console.log('\none click, one handler — the duplicate that made a working button look dead');
{
  /* ⚠ THE ACTUAL v494 BUG, found only because the user said the Close button did not work.
   * renderDashboard calls wireActs TWICE — the loading shell, then the real dashboard — and a bare
   * addEventListener left TWO listeners on any header button the re-render did not replace. One click
   * opened two identical modals; closing the top one revealed the second, which reads exactly like a
   * dead Close button. Measured live at the time: one dispatched click produced modalsOpen: 2.
   *
   * ⚠ REPLACE, do not skip: the loading shell binds a SMALLER handler map than the finished
   * dashboard, so the later binding is the one that must survive. A "wire it once and never again"
   * guard would freeze the poorer map in place. */
  ok(/if \(el\.__fxAct\) el\.removeEventListener\('click', el\.__fxAct\);/.test(panel),
     '⚠ wireActs removes its previous listener before adding one — never two on the same element');
  ok(/el\.__fxAct = \(\) => fn\(el\);/.test(panel) && /el\.addEventListener\('click', el\.__fxAct\);/.test(panel),
     '...and remembers the exact function it bound, so the removal can actually match it');
  ok(!/if \(fn\) el\.addEventListener\('click', \(\) => fn\(el\)\);/.test(panel),
     '⚠ the bare double-binding form is gone — an anonymous listener can never be removed');
  // wireActs is genuinely called more than once, so this is a live hazard rather than a hypothetical.
  ok(panel.split('wireActs(').length - 1 >= 6,
     `wireActs has multiple call sites (${panel.split('wireActs(').length - 1}) — which is why one-listener-per-element matters`);
}

console.log(fail ? `\nFAILED (${fail}) — a modal may not be dismissible.\n`
                 : '\nPASS: cancel buttons are wired centrally, close is idempotent, no modal traps the user.\n');
process.exit(fail ? 1 : 0);
