/* The saved toast's word on FLEx's own file check (Seth, 2026-10-21: "the toast should be quieter. Focusing on new
 * problems we introduced rather than pre-existing ones."). Problems the project already had are said ONCE per
 * project while the app is open (and again if their number changes); every later save says only that nothing new was found. A problem a save introduced never reaches
 * the toast: the shell refuses that save (E_DATA_CHECK_FAILED, desktop/tests/test_protocol.py test_w8b_*).
 *
 * Run: node test/flex-datacheck-toast.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../docs/js/flex-panel.js', import.meta.url), 'utf8');
const a = SRC.indexOf('const toldPreExisting');
const b = SRC.indexOf('\n}\n', SRC.indexOf('function dataCheckText', a)) + 3;
assert.ok(a > 0 && b > a, 'dataCheckText found');

function lift() {
  return new Function('T', `let project = null; ${SRC.slice(a, b)}
    return { dataCheckText, open: (p) => { project = p; }, close: () => { project = null; } };`)((k, v) => k + (v ? JSON.stringify(v) : ''));
}

test('pre-existing problems are named once per project while the app is open, then only "nothing new"', () => {
  const s = lift();
  s.open({ name: 'copy' });
  const dc = { ran: true, problems: 0, preExisting: 783 };
  assert.equal(s.dataCheckText(dc), 'flex.dataCheck.preExisting{"n":783}', 'the first save says what was already there');
  assert.equal(s.dataCheckText(dc), 'flex.dataCheck.nothingNew', 'the next save says only that nothing is new');
  assert.equal(s.dataCheckText(dc), 'flex.dataCheck.nothingNew');
});

test('closing the project so FLEx can check a save, then reopening it, does not say them again (VM, 2026-10-24)', () => {
  const s = lift();
  const dc = { ran: true, problems: 0, preExisting: 783 };
  s.open({ name: 'copy' });
  assert.equal(s.dataCheckText(dc), 'flex.dataCheck.preExisting{"n":783}');
  s.close();
  s.open({ name: 'copy' });                       // a NEW project object for the same project
  assert.equal(s.dataCheckText(dc), 'flex.dataCheck.nothingNew');
  s.open({ name: 'other' });                      // a different project has its own note
  assert.equal(s.dataCheckText(dc), 'flex.dataCheck.preExisting{"n":783}');
});

test('a changed number of pre-existing problems is said again', () => {
  const s = lift();
  s.open({ name: 'copy' });
  assert.equal(s.dataCheckText({ ran: true, problems: 0, preExisting: 783 }), 'flex.dataCheck.preExisting{"n":783}');
  assert.equal(s.dataCheckText({ ran: true, problems: 0, preExisting: 790 }), 'flex.dataCheck.preExisting{"n":790}',
    'FLEx itself may have added some between saves');
  assert.equal(s.dataCheckText({ ran: true, problems: 0, preExisting: 790 }), 'flex.dataCheck.nothingNew');
});

test('a clean check, and a check that could not run, are said every time', () => {
  const s = lift();
  s.open({ name: 'copy' });
  assert.equal(s.dataCheckText({ ran: true, problems: 0, preExisting: 0 }), 'flex.dataCheck.clean');
  assert.equal(s.dataCheckText({ ran: false, why: 'x' }), 'flex.dataCheck.skipped{"why":"x"}');
  assert.equal(s.dataCheckText({ ran: false, why: 'x' }), 'flex.dataCheck.skipped{"why":"x"}', 'never quietened');
  assert.equal(s.dataCheckText(null), '');
});

test('the once-only note is no warning: it does not hold the toast on screen as a ⚠ does', () => {
  const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
  const lines = I18N.split('\n').filter((l) => /'flex\.dataCheck\.(preExisting|nothingNew)':/.test(l));
  assert.equal(lines.length, 4, 'both keys, both languages');
  for (const l of lines) assert.ok(!l.includes('⚠'), l);
});
