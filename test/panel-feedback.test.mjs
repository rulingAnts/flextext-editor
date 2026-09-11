/* #69, refined by Seth, 2026-09-11: "We need to rename the 'Release Notes' link, because only software
 * developer geeks will look for it there." Then: "I like the Feedback link idea. Release notes or
 * 'About this version...' can go in the help menu." And: "the 'Feedback link' can include its own link
 * to the Release Notes or something. Also a 'Known Issues and Planned Fixes' link that points to the
 * GitHub Issues page." */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js');
const fn = (sig) => {
  const at = PANEL.indexOf(sig);
  assert.ok(at > -1, `${sig} exists`);
  return PANEL.slice(at, PANEL.indexOf('\n}\n', at) + 2);
};

test('the header offers Feedback where Release notes was', () => {
  const header = PANEL.slice(PANEL.indexOf('<div class="rp-head">'), PANEL.indexOf('</div>`;', PANEL.indexOf('<div class="rp-head">')));
  assert.match(header, /\$\{feedbackLink\(\)\}\s*\n\s*<button class="icon-btn rp-helpbtn" data-act="help"/, 'just before the help ?');
  assert.doesNotMatch(header, /releaseNotesLink\(\)/, 'the notes are no longer a header link');
  assert.match(fn('function feedbackLink() {'), /data-act="feedback">\$\{esc\(t\('panel\.feedback\.btn'\)\)\}/);
  assert.doesNotMatch(fn('function feedbackLink() {'), /RELEASES|KNOWN_ISSUES/, 'always shown: reporting never depends on there being notes');
  assert.match(PANEL, /if \(!fn && el\.dataset\.act === 'feedback'\) fn = feedbackModal;/, 'wired in every view the header renders in');
  assert.doesNotMatch(PANEL, /el\.dataset\.act === 'known'/, 'the old header act is gone');
});

test('the Feedback window leads to all four, and never stacks a window on itself', () => {
  const src = fn('function feedbackModal() {');
  assert.match(src, /data-report="bug">\$\{esc\(t\('panel\.reportBug'\)\)\}/, 'report a problem');
  assert.match(src, /data-report="feature">\$\{esc\(t\('panel\.reportFeature'\)\)\}/, 'suggest a feature');
  assert.match(src, /data-issues[^>]*>\$\{esc\(t\('panel\.feedback\.known'\)\)\}/, 'known issues and planned fixes');
  assert.match(src, /openExternal\(ISSUES_URL\.replace\(\/\\\/\$\/, ''\)\)/, 'the GitHub issues page, through openExternal');
  assert.match(src, /const notes = releaseNotesLink\(\);/, 'and the version notes');
  assert.match(src, /m\.close\(\);\s*\n\s*reportModal\(b\.dataset\.report\);/, 'closes before the app chooser opens');
  assert.match(src, /m\.close\(\);\s*\n\s*releaseNotesModal\(\);/, 'closes before the notes open');
  assert.match(PANEL, /const ISSUES_URL = 'https:\/\/github\.com\/rulingAnts\/flextext-editor\/issues\/';/);
});

test('Help leads with About this version, and the notes are called that everywhere', () => {
  const help = fn('function showPanelHelp() {');
  assert.match(help, /const notes = releaseNotesLink\(\);/);
  assert.ok(help.indexOf('rp-help-notes') < help.indexOf("t('panel.help.html')"), 'above the long guide, not after it');
  assert.match(help, /m\.close\(\);\s*\n\s*releaseNotesModal\(\);/, 'hands over rather than stacking');
  const link = fn('function releaseNotesLink() {');
  assert.match(link, /if \(!RELEASES\.length && !KNOWN_ISSUES\.length\) return '';/, 'nothing to say, no entry');
  assert.match(link, /data-notes>\$\{esc\(t\('panel\.rel\.btn'\)\)\}/);
  assert.match(I18N, /\n {2}'panel\.rel\.btn': 'About this version…',/);
  assert.match(I18N, /\n {2}'panel\.rel\.title': 'About this version',/);
  for (const k of ['panel.feedback.btn', 'panel.feedback.title', 'panel.feedback.intro', 'panel.feedback.known', 'panel.feedback.knownTip']) {
    assert.equal((I18N.match(new RegExp(`\\n {2}'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
});
