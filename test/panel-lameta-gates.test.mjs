/* THE DEVICE CARD FOR A lameta PROJECT (plans/lameta-device.md, milestone 3): what it keeps, what it
 * never shows, and how the agent is started and stopped by the panel. Source assertions, because the
 * card is a template string; the agent's behaviour is exercised in test/lameta-agent-dispatch.test.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const card = PANEL.slice(PANEL.indexOf('async function renderInstanceCard('), PANEL.indexOf('async function instanceActionInner('));

test('the card recognises a lameta device by what its install REPORTS', () => {
  assert.match(card, /const isLameta = installs\.some\(\(i\) => i\.inventory && i\.inventory\.type === 'lameta'\);/);
  assert.match(PANEL, /'lameta': 'panel\.dev\.platLameta'/, 'the platform line names it');
});

test('never Invite, never Assign, never Erase — Settings, Unlink and Delete stay', () => {
  assert.match(card, /\(mInvite && !isLameta \? `<button class="rp-split-half" data-iact="invite"/, 'Invite is gated');
  assert.match(card, /\$\{mAssign && !isLameta \? `<button class="rp-iconbtn" data-iact="assign"/, 'Assign is gated');
  assert.match(card, /const wipe = \(!memberCtx && live && !isLameta\)/, 'Erase is gated');
  // Every render of each of those three controls is gated: count the sites.
  assert.equal((card.match(/data-iact="invite"/g) || []).length, 1);
  assert.equal((card.match(/data-iact="assign"/g) || []).length, 1);
  assert.equal((card.match(/data-iact="wipe-install"/g) || []).length, 1);
  assert.match(card, /data-iact="revoke-install"/, 'Unlink stays'); assert.match(card, /data-iact="revoke"/, 'Delete stays');
  assert.match(card, /data-iact="settings"/, 'Settings stays');
});

test('the status line is on the card and repainted by the agent, not by the dashboard poll', () => {
  assert.match(card, /\$\{isLameta \? lametaStatusHtml\(it\.instance_id\) : ''\}/);
  assert.match(PANEL, /onChange: \(id\) => paintLametaStatus\(id\)/);
  assert.match(PANEL, /function paintLametaStatus\(id\) \{[\s\S]*?el\.outerHTML = lametaStatusHtml\(id\);[\s\S]*?addEventListener\('click', \(\) => instanceAction\(fresh\)\)/, 'the Allow button is re-wired after the repaint');
  assert.match(PANEL, /act === 'lameta-allow'/, 'the permission request is a click');
});

test('the agent starts after the dashboard, only behind the flag and for the owner, and stops with the session', () => {
  assert.match(PANEL, /renderDashboard\(\);\n  lametaAgentBoot\(\);/);
  assert.match(PANEL, /async function lametaAgentBoot\(\) \{\n  if \(!lametaLinkEnabled\(\) \|\| !Researcher\.isOwnerSelf\(\)\) return;/);
  assert.match(PANEL, /if \(\(await a\.links\(\)\)\.length\) a\.start\(\);/, '...and only once a link exists');
  assert.match(PANEL, /function signOutHere\(\) \{\n  signedOutEmail = Researcher\.accountEmail\(\) \|\| '';\n  if \(lametaAgent\) lametaAgent\.stop\(\);/);
});

test('the link step: name, create-and-claim, then the ordinary settings modal', () => {
  const fn = PANEL.slice(PANEL.indexOf('async function lametaLinkModal()'), PANEL.indexOf('async function inviteModal('));
  assert.match(fn, /agent\.linkedFor\(handle\)/, 'a folder already linked says so instead of a second device');
  assert.match(fn, /agent\.link\(\{ handle, nickname: nick, projectName, sprjName: sprj\.name, projectFolderId: intoProject \}\)/);
  assert.match(fn, /openSettingsModal\(\{ kind: 'instance', instance: \{ instance_id: made\.instanceId/, 'the same settings gate as + New device');
  assert.match(fn, /agent\.start\(\);/);
  for (const k of ['panel.lameta.nick', 'panel.lameta.linkNow', 'panel.lameta.linked', 'panel.lameta.alreadyLinked', 'panel.lameta.statusHere',
    'panel.lameta.statusElsewhere', 'panel.lameta.statusPerm', 'panel.lameta.unlinked', 'panel.lameta.waiting', 'panel.dev.platLameta']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2, `${k} EN + ID`);
  }
});
