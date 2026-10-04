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
  assert.match(card, /\$\{isLameta \? lametaBlockHtml\(it\.instance_id, mManage\) : ''\}/);
  assert.match(PANEL, /onChange: \(id\) => paintLametaStatus\(id\)/);
  assert.match(PANEL, /function paintLametaStatus\(id\) \{[\s\S]*?el\.outerHTML = lametaBlockHtml\(id, el\.dataset\.manage === '1', !!\(details && details\.open\)\);[\s\S]*?addEventListener\('click', \(\) => instanceAction\(fresh\)\)/,
    'the buttons are re-wired after the repaint, and the fold is kept as the person left it');
  assert.match(PANEL, /act === 'lameta-allow'/, 'the permission request is a click');
});

test('Adopt (milestone 4): the list, the modal, the queue, the finish', () => {
  assert.match(PANEL, /data-iact="lameta-adopt" data-i="\$\{esc\(id\)\}" data-name="\$\{esc\(e\.name\)\}"/, 'one Adopt per unadopted session');
  assert.match(PANEL, /canManage && e\.available !== false/, 'never for a session whose files are not downloaded, never without device rights');
  assert.match(PANEL, /act === 'lameta-adopt'\) \{\n\s*await lametaAdoptModal\(id, el\.dataset\.name \|\| ''\);/);
  const fn = PANEL.slice(PANEL.indexOf('async function lametaAdoptModal('), PANEL.indexOf('async function inviteModal('));
  assert.match(fn, /a\.prepareAdopt\(instanceId, sessionName\)/);
  assert.match(fn, /a\.beginAdopt\(instanceId, sessionName, \{ title, recording, flextext, done: prep\.done \}\)/);
  assert.match(fn, /db\.putMedia\(AQ_PREFIX \+ plan\.docId, \{[\s\S]*?manifest: plan\.manifest, lameta: \{ instanceId, sessionName, done: !!plan\.done \},/, 'the assign-upload queue carries the built manifest and what finishAdopt needs');
  assert.match(fn, /runAssignUpload\(plan\.docId\)/);
  const run = PANEL.slice(PANEL.indexOf('async function runAssignUpload('), PANEL.indexOf('async function paintAssignQueue('));
  assert.match(run, /const manifest = rec\.manifest \|\| buildSourceManifest\(\{/, 'an adopt arrives with its manifest');
  assert.match(run, /if \(rec\.projectFolderId \|\| rec\.lameta\) \{[\s\S]*?a\.finishAdopt\(rec\.lameta\.instanceId, \{ docId, sessionName: rec\.lameta\.sessionName, manifest: rec\.manifest,/, 'the session folder is written after the bytes, and no assign command is sent');
  const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
  for (const k of ['panel.lameta.unadopted', 'panel.lameta.elsewhere', 'panel.lameta.adoptBtn', 'panel.lameta.adoptTitle', 'panel.lameta.adoptIntro',
    'panel.lameta.adoptNoAudio', 'panel.lameta.eafKept', 'panel.lameta.adoptQueued', 'panel.lameta.adopted', 'panel.aq.doneAdopt']) {
    assert.equal((i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2, `${k} EN + ID`);
  }
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
