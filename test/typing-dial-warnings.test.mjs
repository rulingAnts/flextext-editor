/* THE TYPING-DIAL WARNINGS MUST ACTUALLY APPEAR — on the researcher panel AND a device's own Settings tab.
 *
 * Seth, 2026-09-10, asked for two warnings on the spell-check / suggestions / autocorrect dials: that
 * on Android the three are one keyboard setting (`on`), and that Automatic only works when the device
 * speaks the analysis language or has a dictionary for it (`auto`). From v660 until this test, neither
 * one ever showed. The handler called `noticeDialog(t(…))`: noticeDialog was never written, and `t`
 * was `const t = e.target`, so even a real dialog would have been handed the select element's call
 * result instead of a sentence. The first switch to on/auto threw a ReferenceError and that was all.
 *
 * ⚠ AND A TEST WAS PINNING IT. no-autocorrect-vernacular matched the broken line as text and passed
 * for a month. Matching source proves the source says something, not that it runs. So this file
 * lifts the handler out of app.js and RUNS it, giving it exactly the names it calls — after checking
 * that each of those names really is defined or imported in app.js. A callee that does not exist
 * fails here by name, and a shadowed `t` fails because the warning text comes out wrong.
 *
 * ⚠ If the handler grows a new free name, add it to SCOPE below. That is the point: every name it
 * reaches is checked against app.js before the handler is allowed to run with a stand-in for it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = rd('../docs/js/app.js');
const CSS = rd('../docs/css/app.css');
const DIALS = ['analSpellcheck', 'analAutocomplete', 'analAutocorrect'];

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/* The module-scope change listener that serves both settings surfaces. It is a top-level statement,
 * so it ends at the first `});` in column 0 after it opens. Returned as the bare arrow, `(e) => {…}`. */
function handlerSource() {
  const opener = "document.addEventListener('change', ";
  let at = -1;
  for (let i = APP.indexOf(opener); i !== -1; i = APP.indexOf(opener, i + 1)) {
    if (APP.slice(i, i + 600).includes("'analSpellcheck'")) { at = i; break; }
  }
  assert.notEqual(at, -1, 'the typing-dial change handler is still a module-scope change listener in app.js');
  const end = APP.indexOf('\n});', at);
  assert.notEqual(end, -1);
  return stripComments(APP.slice(at + opener.length, end + 2));   // through the arrow's closing brace
}

/* Every name the handler BINDS for itself: declarations, arrow and function parameters, catch. */
function boundNames(code) {
  const out = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) { const n = p.trim().split(/[\s=]/)[0]; if (n) out.add(n); }
  }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return out;
}

/* Bare calls — `name(` not preceded by `.` — minus keywords and the handler's own bindings. */
function freeCallees(code) {
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new']);
  const own = boundNames(code);
  return [...new Set([...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))]
    .filter((n) => !KEYWORDS.has(n) && !own.has(n));
}

/* Defined in app.js: a top-level function or const/let, or a name an import brings in. */
function definedInApp(name) {
  const re = (s) => new RegExp(s.replace('NAME', name.replace(/\$/g, '\\$')), 'm');
  if (re('^(?:export\\s+)?(?:async\\s+)?function\\s+NAME\\s*\\(').test(APP)) return true;
  if (re('^(?:export\\s+)?(?:const|let)\\s+NAME\\s*=').test(APP)) return true;
  for (const m of APP.matchAll(/^import\s*\{([^}]*)\}\s*from/gm)) {
    for (const part of m[1].split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop().trim();
      if (local === name) return true;
    }
  }
  return false;
}

test('every function the handler calls is defined or imported in app.js', () => {
  const code = handlerSource();
  const callees = freeCallees(code);
  for (const n of callees) {
    assert.ok(definedInApp(n), `the typing-dial handler calls ${n}(), which app.js neither defines nor imports`);
  }
  assert.ok(callees.includes('t'), "it translates its warning text with the i18n t() (a local `t` hides it from this list)");
});

test("the i18n t() is not shadowed inside the handler", () => {
  const code = handlerSource();
  assert.ok(!boundNames(code).has('t'),
    "the handler binds its own `t` — every t('…') in it would call that instead of the i18n function");
  assert.match(APP, /^import \{[^}]*\bt\b[^}]*\} from '\.\/i18n\.js';/m, 't comes from i18n.js');
});

/* ── Running it ──────────────────────────────────────────────────────────────────────────────────── */

function makeHandler() {
  const code = handlerSource();
  const calls = { dialog: [], sync: [] };
  const SCOPE = {
    t: (k) => `T:${k}`,
    confirmDialog: (msg, opts) => { calls.dialog.push([msg, opts]); return Promise.resolve(true); },
    syncTypingWarnings: (box, attr) => { calls.sync.push([box, attr]); },
  };
  for (const n of freeCallees(code)) {
    assert.ok(n in SCOPE, `the handler now calls ${n}() — check it is real in app.js, then add a stand-in to SCOPE`);
  }
  const fakeDocument = { querySelector: () => null };
  const fn = new Function(...Object.keys(SCOPE), 'document', `return (${code});`)(...Object.values(SCOPE), fakeDocument);
  return { fn, calls };
}

/* One settings surface: the researcher panel marks its fields `data-f`, a device's own Settings tab
 * marks them `data-sf`. The handler finds the other two dials through the form it sits in. */
function surface(attr, values) {
  const key = attr === 'data-sf' ? 'sf' : 'f';
  const els = {};
  const box = {
    querySelector(sel) {
      const m = sel.match(/^\[(data-s?f)="(\w+)"\]$/);
      return m && m[1] === attr ? els[m[2]] || null : null;
    },
  };
  for (const k of DIALS) els[k] = { dataset: { [key]: k }, value: values[k] || 'off', closest: () => box };
  return { box, els };
}

const BUNDLED = ['T:panel.f.typingBundledWarn', { warn: true }];
const AUTO = ['T:panel.f.typingAutoWarn', { warn: true }];

for (const [where, attr] of [['the researcher panel', 'data-f'], ["a device's own Settings tab", 'data-sf']]) {
  test(`on ${where}: the warning shows on the transition, and only then`, () => {
    const cases = [
      // [the other dials, the dial changed, its new value, the dialog expected]
      [{}, 'analSpellcheck', 'on', BUNDLED],                                   // none on → one on
      [{ analAutocomplete: 'on' }, 'analSpellcheck', 'on', null],               // a second one on: nothing new
      [{}, 'analAutocorrect', 'auto', AUTO],                                    // none auto → one auto
      [{ analSpellcheck: 'auto' }, 'analAutocomplete', 'auto', null],           // a second auto: nothing new
      [{ analAutocomplete: 'on' }, 'analSpellcheck', 'auto', AUTO],             // the two warnings are separate
      [{ analAutocomplete: 'on' }, 'analSpellcheck', 'off', null],              // going back off never warns
    ];
    for (const [others, k, v, want] of cases) {
      const { fn, calls } = makeHandler();
      const { box, els } = surface(attr, others);
      els[k].value = v;
      fn({ target: els[k] });
      const label = `${JSON.stringify(others)} then ${k}=${v}`;
      assert.deepEqual(calls.dialog, want ? [want] : [], label);
      assert.deepEqual(calls.sync, [[box, attr]], `${label}: the field highlights follow every change`);
    }
  });
}

test('a change to any other field is none of its business', () => {
  const { fn, calls } = makeHandler();
  fn({ target: { dataset: { f: 'vernName' }, value: 'on', closest: () => null } });
  fn({ target: { dataset: { sf: 'loopPlay' }, value: 'auto', closest: () => null } });
  fn({ target: null });
  fn({ target: {} });
  assert.deepEqual(calls, { dialog: [], sync: [] });
});

/* ── The dialog it calls ─────────────────────────────────────────────────────────────────────────── */

function confirmDialogSource() {
  const at = APP.indexOf('function confirmDialog(');
  assert.notEqual(at, -1, 'confirmDialog is still the editor\'s own dialog');
  return stripComments(APP.slice(at, APP.indexOf('\n}\n', at) + 2));
}

test('the warning wears the amber that explains the glowing fields, with one button', () => {
  const src = confirmDialogSource();
  assert.match(src, /function confirmDialog\(message, \{ warn = false \} = \{\}\)/, 'warn is an option, off by default');
  assert.match(src, /warn \? ' modal-warn' : ''/, 'the warning card takes .modal-warn');
  assert.match(CSS, /\.modal-card\.modal-warn\s*\{[^}]*var\(--warn-glow\)/, 'and .modal-warn glows in the same amber as the fields');
  /* ⚠ NO CANCEL ON A WARNING. The change it explains has already been saved by another listener; a
   * Cancel button would read as an undo that does not happen. */
  assert.match(src, /\$\{warn \? '' : `<button class="link-btn" data-cf="cancel">/, 'a warning has no Cancel');
  assert.match(src, /querySelector\('\[data-cf="cancel"\]'\)\?\.addEventListener/, 'and wiring tolerates its absence');
  assert.match(src, /class="primary-btn" data-cf="ok"/, 'every variant keeps its OK');
});

/* ⚠ ON THE PANEL THIS DIALOG OPENS OVER THE SETTINGS FORM, which is a researcher-panel modal() with
 * its own capture-phase Escape listener on `document`. Two capture listeners on one target run in
 * the order they were added, so a dialog listening on `document` too would let Escape close the form
 * underneath — the researcher's unsaved edits with it — before the dialog saw the key. */
test("the dialog takes its keys on window, ahead of the panel's settings form", () => {
  const src = confirmDialogSource();
  assert.match(src, /window\.addEventListener\('keydown', onKey, true\)/);
  assert.match(src, /window\.removeEventListener\('keydown', onKey, true\)/, 'and lets go of them on the same target');
  assert.doesNotMatch(src, /document\.addEventListener\('keydown'/);
});
