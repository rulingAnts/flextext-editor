/* #69, as refined by Seth, 2026-09-11: "let's give the user a modal where they can choose WHICH app the
 * problem they're reporting is for: reason for this: paired end-user apps don't show this link. So
 * we're counting on the researcher to submit problems… let's also [make] that choice of apps be
 * unspecified by default and require the researcher submitting a report to deliberately choose an
 * app so that they think about it rather than just quickly clicking through." */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js'), PAT = rd('../docs/js/paragraph-ui.js');
const between = (a, b) => PANEL.slice(PANEL.indexOf(a), PANEL.indexOf(b, PANEL.indexOf(a)));
const urlSrc = between('function panelIssueUrl(kind, app) {', 'function reportModal(kind) {');
const modalSrc = between('function reportModal(kind) {', 'function releaseNotesModal() {');
const notesSrc = between('function releaseNotesModal() {', 'function wire(sel, ev, fn)');

test('Release notes offer both, beside the version, and hand over to the app chooser', () => {
  assert.match(notesSrc, /t\('panel\.rel\.version', \{ v: ENGINE_VERSION \}\)[\s\S]{0,250}data-report="bug"[\s\S]{0,200}data-report="feature"/);
  assert.match(notesSrc, /m\.el\.querySelectorAll\('\[data-report\]'\)/);
  // ⚠ the notes CLOSE first — two stacked modals would both close on one Escape
  assert.match(notesSrc, /m\.close\(\);\s*\n\s*reportModal\(b\.dataset\.report\);/);
});

test('the app must be chosen deliberately: no default, no Continue, and no memory of last time', () => {
  assert.match(modalSrc, /<option value="" selected disabled>/, 'starts on a placeholder that cannot be submitted');
  assert.match(modalSrc, /data-m="go" disabled/, 'Continue is disabled until an app is picked');
  assert.match(modalSrc, /go\.disabled = !sel\.value;/);
  assert.match(modalSrc, /if \(!sel\.value\) return;/, 'and the click handler refuses too, not just the attribute');
  // ⚠ a remembered answer is exactly the click-through Seth is guarding against
  assert.doesNotMatch(modalSrc, /localStorage|sessionStorage|lastApp|savedApp/);
  assert.match(modalSrc, /openExternal\(panelIssueUrl\(kind, sel\.value\)\)/, 'leaves through openExternal');
});

test('every app is offered, plus an honest "not sure"', () => {
  const apps = PANEL.match(/const REPORT_APPS = \[([^\]]+)\]/)[1].match(/'([a-z]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(apps, ['editor', 'recorder', 'crowd', 'consent', 'segmenter', 'paragraph', 'panel', 'unsure']);
  for (const a of apps)
    assert.equal((I18N.match(new RegExp(`'panel\\.report\\.app\\.${a}':`, 'g')) || []).length, 2, `${a} labelled in en and id`);
  for (const k of ['appLabel', 'appPlaceholder', 'why', 'goNote', 'go', 'cancel'])
    assert.equal((I18N.match(new RegExp(`'panel\\.report\\.${k}':`, 'g')) || []).length, 2, `${k} in en and id`);
});

test('titles carry a FIXED English app name, so searching by app works in any language', () => {
  assert.match(urlSrc, /title: bug \? `\[\$\{name\}\] ` : `\[\$\{name\}\] Feature: `/);
  assert.doesNotMatch(urlSrc, /\bt\(/, 'no translated string reaches the title or body');
  // PAT files its own reports as "[Paragraph Analysis] …" — the panel must match, or one search misses half
  assert.match(PAT, /\[Paragraph Analysis\] /);
  assert.match(PANEL, /paragraph: 'Paragraph Analysis'/);
  assert.match(urlSrc, /labels: bug \? 'bug' : 'enhancement'/, 'only labels that exist on the repo');
});

/* ⚠ THE TRACKER IS PUBLIC, and this panel holds accounts, device nicknames, text titles and keys. */
test('nothing filled in automatically names the researcher, their devices or their texts', () => {
  const body = urlSrc.slice(urlSrc.indexOf('const body'), urlSrc.indexOf('const q ='));
  for (const leak of [/accountId|currentAccountId/, /instance|install/i, /nickname/i, /\.title\b|titleOf/, /\bKr\b|\bKi\b/, /email/i])
    assert.doesNotMatch(body, leak, `the report body must not reach for ${leak}`);
  assert.match(body, /nothing about your account, devices, texts or keys was filled in automatically/);
  assert.match(body, /reported from the Researcher Panel/, 'the version and browser are labelled as the PANEL\'s, not the device\'s');
  // the suggestion body: the app and a prompt, nothing else (its first element is a template literal)
  assert.match(body, /\[`App: \$\{name\}`, '', 'What would you like it to do\?', ''\]/, 'a suggestion carries no diagnostics');
});
