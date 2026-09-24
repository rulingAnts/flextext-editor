/* CONFIRMING A MOVE MUST NOT LOOK LIKE A FROZEN APP.
 *
 * Seth, 2026-09-25, on a village connection: "when I push the Move button to confirm moving a text,
 * it sits frozen there for a long time if the connection is slow. I assume the UI is frozen until it
 * confirms the command has been successfully submitted."
 *
 * ⚠ THE ARITHMETIC IS WHY THIS MATTERS. A move is three or four requests in a row — re-parent the
 * Drive folder, assign to the destination, record the move — and researcher.js gives each one a 20 s
 * timeout and four backed-off retries. A single slow call can therefore run well over a minute, and
 * the button said nothing at all: `disabled = true` and no spinner, no label, no step.
 *
 * Nothing in the client can make the network faster. What it can do is say which step is running,
 * and admit when that step is slow — so this file pins the feedback, not a duration.
 *
 * Run: node --test test/move-progress.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');

const handler = PANEL.slice(PANEL.indexOf("const say = m.el.querySelector('#rp-move-say');"),
                            PANEL.indexOf("finally { clearTimeout(slowTimer); }"));

test('the confirm wears the suite’s own in-flight affordance, not a bare disabled flag', () => {
  assert.match(handler, /await busy\(e\.target, async \(\) => \{/,
    'busy() gives the spinner and restores the button on every exit path');
  /* ⚠ INCLUDING THE EARLY RETURN. The "nothing to move" branch used to re-enable the button by
   * hand; with busy() that is automatic, and a hand-written restore beside it would be the thing
   * that drifts. */
  assert.doesNotMatch(handler, /e\.target\.disabled = (true|false)/,
    'no hand-rolled disable/restore survives in this handler');
});

test('every network step names itself BEFORE it runs', () => {
  /* A label written after the await appears only once the slow call has returned — which is exactly
   * when nobody needs it any more. So each stage() must precede its own request. */
  for (const [key, call] of [
    ['panel.move.stepFile', 'Researcher.driveUnassign('],
    ['panel.move.stepRelease', 'Researcher.uploadDelete('],
    ['panel.move.stepFolder', 'Researcher.moveText('],
    ['panel.move.stepAssign', 'Researcher.assign('],
    ['panel.move.stepRecord', 'saveMoves('],
  ]) {
    const at = handler.indexOf(`stage('${key}'`);
    const runs = handler.indexOf(call);
    assert.ok(at > 0, `${key} is used`);
    assert.ok(runs > 0 && at < runs, `${key} is set before ${call}`);
  }
});

test('a step that drags says so, and the timer never outlives the modal', () => {
  /* ⚠ Sliced FORWARD from the helper, with the window checked: a boundary that does not match
   * yields an empty string, and every assertion below would then pass against nothing. */
  const from = PANEL.indexOf('const stage = (key, vars) =>');
  const stage = PANEL.slice(from, PANEL.indexOf('await busy(e.target', from));
  assert.ok(stage.length > 200, 'the stage helper window is real');
  assert.match(stage, /clearTimeout\(slowTimer\);/, 'each new step cancels the previous slow notice');
  assert.match(stage, /slowTimer = setTimeout\(\(\) => \{ say\.textContent = base \+ ' ' \+ t\('panel\.move\.slow'\); \}, 6000\);/,
    'and arms a fresh one, so the notice belongs to the step actually running');
  assert.match(PANEL, /finally \{ clearTimeout\(slowTimer\); \}/,
    'the timer is cleared on success and failure alike');
  /* The stage line is a plain note; only a real failure paints it as an error. */
  assert.match(stage, /say\.className = 'rp-adm-say';/, 'progress is not styled as an error');
});

test('the words exist in both languages', () => {
  for (const k of ['panel.move.stepFolder', 'panel.move.stepAssign', 'panel.move.stepRecord',
                   'panel.move.stepFile', 'panel.move.stepRelease', 'panel.move.slow']) {
    const hits = I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || [];
    assert.equal(hits.length, 2, `${k} is in English and Indonesian`);
  }
  assert.match(I18N, /'panel\.move\.slow': 'Still working/, 'the slow notice reassures rather than alarms');
});
