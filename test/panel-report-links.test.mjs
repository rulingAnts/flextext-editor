/* #69 — "Can we add 'report a problem' and 'suggest a feature' links to the Researcher Panel, just like
 * we have in PAT?" (Seth, 2026-09-10). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js'), I18N = rd('../docs/js/i18n.js'), APP = rd('../docs/js/app.js');
const fnSrc = PANEL.slice(PANEL.indexOf('function panelIssueUrl(kind) {'), PANEL.indexOf('function releaseNotesModal() {'));

test('both links sit beside the version in the release notes, as PAT has them beside its version', () => {
  const modal = PANEL.slice(PANEL.indexOf('function releaseNotesModal() {'), PANEL.indexOf('function wire(sel, ev, fn)'));
  assert.match(modal, /t\('panel\.rel\.version', \{ v: ENGINE_VERSION \}\)[\s\S]{0,200}<p class="note rp-report-links">\$\{reportLinksHtml\(\)\}<\/p>/,
    'directly after the version line');
  assert.match(fnSrc, /panelIssueUrl\('bug'\)/);
  assert.match(fnSrc, /panelIssueUrl\('feature'\)/);
});

test('they are ordinary offsite links, which the engine hands to the OS browser', () => {
  for (const m of fnSrc.matchAll(/<a [^>]*>/g)) {
    assert.match(m[0], /target="_blank"/);
    assert.match(m[0], /rel="noopener"/);
  }
  // ⚠ the thing that makes <a target=_blank> safe is the MODULE-SCOPE wiring, not the attribute
  assert.match(APP, /^wireExternalLinks\(document, \{/m, 'wired at module scope, so it reaches the panel');
});

test('only labels that exist on the repo are requested, and a feature request carries no diagnostics', () => {
  assert.match(fnSrc, /labels: bug \? 'bug' : 'enhancement'/);
  assert.match(fnSrc, /const body = bug \? \[/, 'diagnostics are for bugs only');
  assert.match(fnSrc, /: '';/, '…and a feature request gets an empty body');
});

/* ⚠ THE TRACKER IS PUBLIC and this panel holds accounts, device nicknames, text titles and keys. */
test('the diagnostics name nothing about the researcher, their devices or their texts', () => {
  const body = fnSrc.slice(fnSrc.indexOf('const body'), fnSrc.indexOf('const q ='));
  for (const leak of [/accountId|currentAccountId/, /instance|install/i, /nickname/i, /\.title\b|titleOf/, /Kr\b|Ki\b|key[A-Z]/, /email/i])
    assert.doesNotMatch(body, leak, `the report body must not reach for ${leak}`);
  assert.match(body, /no account, device, text or key information is included/, 'and says so to the reader');
});

test('labelled in both languages, in the same words PAT uses', () => {
  for (const k of ['panel.reportBug', 'panel.reportFeature'])
    assert.equal((I18N.match(new RegExp(`'${k}':`, 'g')) || []).length, 2, `${k} in en and id`);
  const pat = (k) => [...I18N.matchAll(new RegExp(`'${k}': '([^']*)'`, 'g'))].map((m) => m[1]);
  assert.deepEqual(pat('panel.reportBug'), pat('para.reportBug'));
  assert.deepEqual(pat('panel.reportFeature'), pat('para.reportFeature'));
});
