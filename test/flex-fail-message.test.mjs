// What a failed FLEx call tells the user (flex-ops.js flexFailText). Pinned after the first saves to a
// real FLEx project (2026-10-16): the shell's own check had CLOSED the project without saving, and the
// panel said "rolled back" for the first failure and "FLEx reported a problem saving … preserved as ;"
// for every one after it. A closed project must say it is closed, why, and what to do next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flexFailText, flexClosedBy } from '../docs/js/flex-ops.js';

// i18n.js reads localStorage/navigator defensively but setLang touches document.documentElement.
globalThis.document ??= { documentElement: {} };
const i18n = await import('../docs/js/i18n.js');
const T = (k, v) => i18n.t(k, v);
const err = (code, message, detail) => Object.assign(new Error(message), { code, detail });

const W5 = 'the commit did not produce exactly one FLEx history item (depth 0, items 3 → 6, top item …)';
const closedByW5 = () => err('E_INVARIANT', W5, { closed: true, itemsBefore: 3, itemsAfter: 6 });
const poisoned = (extra = {}) => err('E_POISONED', 'the project was closed without saving (E_INVARIANT: …)',
  { cause: { code: 'E_INVARIANT', message: W5, detail: { closed: true } }, failedFile: null, backup: null, closed: true, ...extra });

for (const lang of ['en', 'id']) {
  test(`[${lang}] the check that closed the project says closed, never rolled back, and says why`, () => {
    i18n.setLang(lang, { save: false });
    const s = flexFailText(closedByW5(), true, T);
    assert.equal(s.startsWith(T('flex.closedUnsaved', { f: '' })), true, s);
    assert.ok(!s.includes(T('flex.nothingWritten')), 'not "nothing was written (rolled back)": ' + s);
    assert.ok(s.includes(T('flex.seeConsole')) && !s.includes(W5), 'the cause is in the console, not the toast: ' + s);
  });

  test(`[${lang}] every later call reports the error that closed the project, and the backup`, () => {
    i18n.setLang(lang, { save: false });
    const s = flexFailText(poisoned({ backup: 'C:/Backups/demo 2026-01-02 0930.fwbackup' }), false, T);
    assert.ok(s.startsWith(T('flex.closedUnsaved', { f: '' })), s);
    assert.ok(s.includes('demo 2026-01-02 0930.fwbackup'), s);
    assert.ok(s.includes(T('flex.seeConsole')), 'the cause is in the console: ' + s);
    assert.doesNotMatch(s, /\{[a-z]+\}/, 'no unfilled placeholder');
    assert.doesNotMatch(s, /\s;|;\s*;/, 'no empty "preserved as ;"');
  });

  test(`[${lang}] a file the disk check set aside is named, and no backup line without a backup`, () => {
    i18n.setLang(lang, { save: false });
    const s = flexFailText(poisoned({ failedFile: 'D:/P/demo.fwdata.failed-20261016-130000' }), false, T);
    assert.ok(s.startsWith(T('flex.closedSetAside', { f: 'D:/P/demo.fwdata.failed-20261016-130000' })), s);
    assert.ok(!s.includes(T('flex.closedBackup', { b: '' }).trim().split(':')[0] + ':'), 'no backup sentence: ' + s);
  });

  test(`[${lang}] a write rolled back inside FLEx says so once, and why`, () => {
    i18n.setLang(lang, { save: false });
    const e = err('E_INVARIANT', 're-read differs from the intended result: phrase 1 gloss', { problems: ['x'] });
    const s = flexFailText(e, true, T);
    assert.equal(s, T('flex.err.E_INVARIANT') + ' ' + T('flex.seeConsole'), 'friendly: the words of the check go to the console');
  });

  test(`[${lang}] refusals keep their own words; "nothing was written" only where it adds something`, () => {
    i18n.setLang(lang, { save: false });
    assert.equal(flexFailText(err('E_STALE_BASE', 'x', {}), true, T), T('flex.err.E_STALE_BASE'));
    assert.equal(flexFailText(err('E_SCOPE', 'x', {}), true, T), T('flex.nothingWritten') + ' ' + T('flex.err.E_SCOPE'));
    assert.equal(flexFailText(err('E_SCOPE', 'x', {}), false, T), T('flex.err.E_SCOPE'), 'the shell\'s English is not shown for a refusal');
    assert.equal(flexFailText(err('E_NO_SUCH_CODE', 'boom', {}), false, T), T('flex.err.E_INTERNAL'));
    assert.equal(flexFailText(err('E_INTERNAL', 'boom', {}), false, T), T('flex.err.E_INTERNAL') + ' ' + T('flex.seeConsole'));
  });
}

test('flexClosedBy: closed errors and E_POISONED name their cause; anything else is not closed', () => {
  assert.equal(flexClosedBy(null), null);
  assert.equal(flexClosedBy(err('E_INVARIANT', 'x', {})), null, 'a rollback inside FLEx leaves the project open');
  const c = closedByW5();
  assert.equal(flexClosedBy(c), c);
  assert.equal(flexClosedBy(poisoned()).message, W5);
  assert.equal(flexClosedBy(err('E_POISONED', 'older shell', {})).code, 'E_POISONED', 'an older shell without a cause still reads as closed');
});

test('the old misleading string is gone from both languages', () => {
  i18n.setLang('en', { save: false });
  assert.equal(T('flex.poisoned'), 'flex.poisoned');
});
