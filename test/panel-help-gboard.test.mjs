/* #72 — "device setup must include turning off Gboard's suggestion strip" (Seth, 2026-09-10). The web layer
 * asks Gboard not to suggest and Gboard declines (#62), so the per-device switch has to be part of setting
 * a coworker up rather than something a researcher discovers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const help = [...I18N.matchAll(/'panel\.help\.html':\s*`([\s\S]*?)`,/g)].map((m) => m[1]);
const section = (body, heading) => {
  const i = body.indexOf(`<h3>${heading}</h3>`);
  return i < 0 ? '' : body.slice(i, body.indexOf('<h3>', i + 5));
};

test('the step is in "Setting up a coworker", in both languages', () => {
  assert.equal(help.length, 2, 'both help blocks found');
  const en = section(help[0], 'Setting up a coworker');
  const id = section(help[1], 'Menyiapkan rekan kerja');
  assert.match(en, /<li><b>Turn off the keyboard's suggestion strip<\/b>/);
  assert.match(en, /Show suggestion strip/);
  assert.match(id, /<li><b>Matikan baris saran papan ketik<\/b>/);
  // it sits before the closing "from then on" step, so it is part of the setup rather than an afterthought
  assert.ok(en.indexOf('suggestion strip') < en.indexOf('From then on'));
  assert.ok(id.indexOf('baris saran') < id.indexOf('Sejak itu'));
});

/* ⚠ #72's own warning: "do not document the MDM route as the solution… A researcher who sets the MDM
 * policy, sees no effect, and concludes the app is broken is the outcome to avoid." */
test('it says the switch is the only fix, and that the MDM route does not work', () => {
  const en = section(help[0], 'Setting up a coworker');
  assert.match(en, /the only thing that removes the strip/);
  assert.match(en, /pushed from an MDM does not take effect/);
  assert.match(en, /applies to every app on that phone/, 'and what else it touches');
  assert.match(section(help[1], 'Menyiapkan rekan kerja'), /MDM tidak berpengaruh/);
});
