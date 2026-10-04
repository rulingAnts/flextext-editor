/* KEYLESS CARDS KEEP THEIR BUTTONS (Seth, 2026-10-04: "sometimes settings and new text buttons disappear in
 * research panel for certain devices … a 'not loaded yet' or spinning animation over grayed out buttons … so
 * they don't just go 'where did my buttons go?'"). A device in a project shared with this seat has hasKey ===
 * false until the owner's panel sweeps the grant (or when getKi hiccups on one poll); the card used to render
 * with no quick-row buttons at all. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = rd('../docs/js/researcher-panel.js'), CSS = rd('../docs/css/app.css'), I18N = rd('../docs/js/i18n.js'), RES = rd('../docs/js/researcher.js');
const card = PANEL.slice(PANEL.indexOf('async function renderInstanceCard('), PANEL.indexOf('async function renderInstanceCard(') + 40000);

test('the capability and the key are two different absences', () => {
  assert.match(card, /const capManage = !memberCtx \|\| !!mCaps\.manageDevices;\n\s+const capAssign = !memberCtx \|\| !!mCaps\.assignTexts;\n\s+const mManage = capManage && !mKeyless;/);
  assert.match(card, /const mAssign = capAssign && !mKeyless;/);
  assert.match(card, /const mKeyless = !!memberCtx && it\.hasKey === false;/, 'keyless is a member-view state');
  assert.match(RES, /hasKey: !!Ki \}\);/, 'hasKey is whether getKi() served a key for the instance this poll');
});

test('a keyless card keeps Settings and Assign new text: disabled, greyed, spinning, with the reason', () => {
  assert.match(card, /\$\{capAssign && !isLameta \? \(mAssign \? `<button class="rp-iconbtn" data-iact="assign"[^\n]*: waitingBtn\(ICON_NEWTEXT, t\('panel\.inst\.assign'\)\)\) : ''\}/);
  assert.match(card, /\$\{capManage \? \(mManage \? `<button class="rp-iconbtn" data-iact="settings"[^\n]*: waitingBtn\(ICON_GEAR, t\('panel\.inst\.settings'\)\)\) : ''\}/);
  assert.match(card, /const waitingBtn = \(icon, label\) => `<button type="button" class="rp-iconbtn is-waiting" disabled aria-disabled="true" title="\$\{esc\(label\)\} — \$\{esc\(t\('panel\.joined\.keyWaitShort'\)\)\}"/, 'disabled, so no click reaches a refusal; the tooltip carries the reason');
  assert.match(card, /<p class="note rp-keywait">\$\{esc\(t\('panel\.joined\.keyPending'\)\)\}<\/p>/, 'the note stays, and now says who delivers the key');
  assert.match(CSS, /\.rp-iconbtn\.is-waiting \{ position: relative; opacity: \.55; cursor: progress; \}/);
  assert.match(CSS, /\.rp-iconbtn\.is-waiting::after \{[^}]*animation: rp-spin \.9s linear infinite;/, 'a ring spinning over the greyed icon');
  assert.match(CSS, /prefers-reduced-motion: reduce\) \{ \.rp-iconbtn\.is-waiting::after \{ animation: none;/);
});

test('the words, both languages; the backstop toast; the repaint signal', () => {
  for (const k of ['panel.joined.keyPending', 'panel.joined.keyWaitShort', 'panel.rel.fix.keylessButtons']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.match(I18N, /'panel\.joined\.keyPending': 'Waiting for this device\\u2019s key[^\n]*project owner\\u2019s Researcher panel shares the key automatically/, 'the note says WHO delivers it');
  assert.match(PANEL, /if \(mInst && mInst\.hasKey === false\) \{ deps\.toast\(t\('panel\.joined\.keyPending'\), 8000\); return; \}/, 'the act-gate stays for stale DOM');
  assert.match(PANEL, /it\.instance_id, it\.nickname, it\.type, it\.hasKey,/, 'hasKey is in viewSig, so the poll repaints when the key lands');
  assert.match(PANEL, /\{ v: 'v702', date: '2026-10-04', items: \[\n    \{ k: 'panel\.rel\.fix\.keylessButtons' \},/);
});
