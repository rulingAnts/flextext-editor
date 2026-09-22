/* SIGNING IN WITH GOOGLE OUTLIVES SIGNING OUT HERE, and the only fixes available are words plus one
 * OAuth parameter (2026-09-22).
 *
 * The hazard is ordinary and real: our sign-out ends this app's session and nothing else, so on a
 * shared or lab machine the next person can open Gmail or Drive as the researcher who just signed
 * out. Our sign-out looks complete and is not.
 *
 * ⚠ AND IT CANNOT BE FIXED IN CODE. Checked that morning against
 * accounts.google.com/.well-known/openid-configuration: Google advertises NO `end_session_endpoint`
 * and no front- or back-channel logout. Its `revocation_endpoint` revokes OUR tokens, not the
 * person's Google session in that browser — and no site may end another site's session in any case;
 * that is the browser's rule, not a gap to engineer around.
 *
 * So this file pins the three things that ARE available — a warning before the button, the same
 * truth on the screen a sign-out lands on, and `prompt=select_account` on the authorization request
 * — and the claims that must never be made.
 *
 * Run: node --test test/google-session-truth.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PANEL = read('../docs/js/researcher-panel.js');
const I18N = read('../docs/js/i18n.js');
const WORKER = read('../worker/src/v1.js');
const CSS = read('../docs/css/app.css');
// The comments below describe the very shapes this file forbids, so they must not satisfy the greps.
const bare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('the authorization request asks Google for the account chooser, and keeps consent beside it', () => {
  const start = bare(WORKER.slice(WORKER.indexOf("seg[3] === 'start'"), WORKER.indexOf("seg[3] === 'callback'")));
  assert.match(start, /prompt: 'select_account consent'/,
    'select_account: a returning visitor on a shared machine is ASKED which account, instead of being signed straight back in as whoever used the browser last');
  /* ⚠ BOTH VALUES, IN ONE STRING. Google reads `prompt` as a space-separated set. Replacing
   * `consent` with the chooser would stop the refresh token coming back, and that refresh token IS
   * the Drive connection every researcher's data rides on (drive_refresh_enc → driveAccessToken). */
  assert.match(start, /access_type: 'offline'/, 'offline access stays, or there is no refresh token at all');
  assert.doesNotMatch(start, /prompt: 'select_account'[^\s]/, 'the chooser did not replace consent');
  assert.doesNotMatch(start, /prompt: 'login'/,
    'NOT prompt=login: a forced re-authentication on every sign-in is a cost paid over village connections by everyone, to protect the minority on a borrowed machine');
});

test('nothing anywhere pretends the app can end a Google session', () => {
  const code = bare(WORKER);
  assert.doesNotMatch(code, /end_session_endpoint/,
    'Google advertises none — a URL taken from a discovery document and never requested is how a sister project shipped a 404 wall');
  assert.doesNotMatch(code, /accounts\.google\.com\/Logout/,
    'the worker never redirects anyone to a Google sign-out: on a personal device that is hostile, and it is not ours to do');
  /* The panel may NAME Google's sign-out page, because there it is a link a person chooses to
   * follow. What it must never be is automatic — see the offsite-link test below. */
  assert.doesNotMatch(bare(PANEL), /location\.href = GOOGLE_SIGNOUT_URL|location\.replace\(GOOGLE_SIGNOUT_URL/,
    'and the panel never navigates itself to it');
});

test('the sign-in screen warns BEFORE the button, and not behind a disclosure', () => {
  const screen = PANEL.slice(PANEL.indexOf('function renderSignIn(note)'), PANEL.indexOf('function renderConnecting()'));
  const warn = screen.indexOf('panel.signin.sharedNote');
  const button = screen.indexOf('data-act="google"');
  assert.ok(warn > 0, 'the shared-computer note is on the sign-in screen');
  assert.ok(button > 0 && warn < button, 'and it is rendered ABOVE the "Sign in with Google" button');
  assert.doesNotMatch(screen, /<details|<summary/, 'nothing here is hidden behind a disclosure triangle');
});

test('every sign-out path lands on the other half of the truth', () => {
  /* ONE CHOKEPOINT, so a sign-out added later cannot quietly skip saying it. Six paths signed out
   * before this change — the account modal, the lock button on two screens, the pending screen, the
   * reconnect screen, and the account-switch cancel — and each said nothing. */
  assert.equal((bare(PANEL).match(/Researcher\.signOut\(\)/g) || []).length, 1,
    'exactly one call to Researcher.signOut() in the whole panel');
  const fn = PANEL.slice(PANEL.indexOf('function signOutHere()'), PANEL.indexOf('function googleAccountUrl('));
  assert.match(fn, /Researcher\.signOut\(\);/, 'and it lives in signOutHere()');
  assert.match(fn, /signedOutNotice = true;/, 'which arms the notice');
  const screen = PANEL.slice(PANEL.indexOf('function renderSignIn(note)'), PANEL.indexOf('function renderConnecting()'));
  assert.match(screen, /const justSignedOut = signedOutNotice;[\s\S]{0,140}signedOutNotice = false;/,
    'the screen reads the flag once and clears it, so the notice does not follow them around');
  for (const k of ['panel.signout.done', 'panel.signout.finish', 'panel.signout.googleBtn']) {
    assert.ok(screen.includes(k), `${k} is rendered there`);
  }
});

test('the deliberate sign-out offers the choice, and the Google half is an ordinary offsite link', () => {
  const choice = PANEL.slice(PANEL.indexOf('function signOutChoiceModal()'), PANEL.indexOf('// Sign-in screen'));
  assert.match(choice, /data-m="panel"/, 'the panel-only sign-out');
  assert.match(choice, /data-m="google"/, 'and the one that goes on to Google');
  /* ⚠ AN <a>, NEVER A BUTTON CALLING openExternal(). external-link.js owns every exit from this
   * suite: on Android it hands the URL to the OS as an `intent://` VIEW, so the DEFAULT BROWSER
   * opens it in its own task instead of a Custom Tab wearing the PWA's colors, and on a PAIRED
   * device the link is removed altogether. A helper call from here would be a second exit that
   * skips all of that. */
  assert.match(choice, /<a class="secondary-btn rp-gout" data-m="google" href="\$\{GOOGLE_SIGNOUT_URL\}" target="_blank" rel="noopener noreferrer">/,
    'it is a real link, routed by the suite\'s one offsite policy');
  assert.doesNotMatch(bare(PANEL), /openExternal\(GOOGLE_SIGNOUT_URL\)|openExternal\(GOOGLE_ACCOUNT_URL\)/,
    'neither Google URL is opened by a call that bypasses that policy');
  assert.match(PANEL, /const GOOGLE_SIGNOUT_URL = 'https:\/\/accounts\.google\.com\/Logout';/);
  assert.match(PANEL, /const GOOGLE_ACCOUNT_URL = 'https:\/\/myaccount\.google\.com\/';/);
  assert.match(CSS, /a\.rp-gout \{/, 'and it is styled to sit where a button would');
  // the panel's own sign-out happens first, so abandoning Google's page still leaves this app signed out
  const acct = PANEL.slice(PANEL.indexOf('[data-m="signout"]\').onclick'));
  assert.match(acct.slice(0, 1600), /const how = await signOutChoiceModal\(\);\s*\n\s*if \(!how\) return;/);
});

test('no copy claims the app signs anyone out of Google, in either language', () => {
  const keys = ['panel.signin.sharedNote', 'panel.signout.done', 'panel.signout.finish',
                'panel.signout.googleBtn', 'panel.signout.choiceTitle', 'panel.signout.choiceIntro',
                'panel.signout.panelOnly', 'panel.signout.panelOnlyNote', 'panel.signout.alsoGoogle',
                'panel.signout.alsoGoogleNote'];
  for (const k of keys) {
    const hits = I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || [];
    assert.equal(hits.length, 2, `${k} exists in English and Indonesian`);
  }
  assert.match(I18N, /'panel\.signout\.done': 'You are signed out of FlexText in this browser\. You are still signed in to Google/,
    'the sign-out says plainly what is still true');
  assert.match(I18N, /'panel\.signin\.sharedNote': 'Signing in with Google keeps you signed in to Google in this browser/,
    'and the sign-in says it before they start');
  /* ⚠ THE FORBIDDEN SENTENCE. Any copy of the shape "we sign you out of Google" would be false, and
   * a false reassurance is worse than no warning at all: it is the line that leaves somebody's mail
   * open on a library machine. What the copy may say is that it OPENS Google's own page.
   *
   * ⚠ NEGATIONS ARE THE POINT, NOT AN EXCEPTION, and the first draft of this assertion failed on
   * our own honest copy: "Signing out here does NOT sign you out of Google" says exactly the right
   * thing and contains the forbidden words. So the claim is forbidden only where nothing denies it —
   * in both languages, because the Indonesian sentence carries the same fact. */
  assert.doesNotMatch(I18N, /(?<!cannot |can['’]t |does not |doesn['’]t |never |not )signs? you out of Google/i,
    'no English copy promises a Google sign-out this app cannot perform');
  assert.doesNotMatch(I18N, /(?<!tidak dapat |tidak |bukan )mengeluarkan Anda dari Google/i,
    'nor does the Indonesian');
});

test('the Google link names, and asks for, the account that just signed out', () => {
  /* ⚠ A BROWSER CAN HOLD SEVERAL GOOGLE ACCOUNTS, and myaccount.google.com opens the DEFAULT one,
   * which need not be the one the panel used (Seth, 2026-09-22: "we need to make sure it's the same
   * Google Account that just signed out on this app… Just in case the user is signed into
   * multiple"). Two halves, because one is not enough: `authuser` asks Google for that account, and
   * the screen NAMES it — the parameter is Google's own convention rather than a documented API, and
   * an account silently opened wrong would tell nobody anything. */
  assert.match(PANEL, /function signOutHere\(\) \{\s*\n\s*signedOutEmail = Researcher\.accountEmail\(\) \|\| '';\s*\n\s*Researcher\.signOut\(\);/,
    '⚠ the address is read BEFORE signOut(), which clears the stored auth it comes from');
  assert.match(PANEL, /function googleAccountUrl\(email\) \{\s*\n\s*return GOOGLE_ACCOUNT_URL \+ \(email \? '\?authuser=' \+ encodeURIComponent\(email\) : ''\);/,
    'the link carries ?authuser=<that address>, encoded, and falls back to the plain page without one');
  const screen = PANEL.slice(PANEL.indexOf('function renderSignIn(note)'), PANEL.indexOf('function renderConnecting()'));
  assert.match(screen, /href="\$\{esc\(googleAccountUrl\(justSignedOutEmail\)\)\}"/, 'the screen uses it');
  assert.match(screen, /panel\.signout\.asAccount', \{ email: justSignedOutEmail \}/, 'and names the account in words');
  assert.match(screen, /const justSignedOutEmail = signedOutEmail;[\s\S]{0,120}signedOutEmail = '';/,
    'read once and cleared, like the flag beside it — a stale address would name the wrong account next time');
  const choice = PANEL.slice(PANEL.indexOf('function signOutChoiceModal()'), PANEL.indexOf('// Sign-in screen'));
  assert.match(choice, /panel\.signout\.signedInAs', \{ email: Researcher\.accountEmail\(\) \}/,
    'the choice modal says which account as well: "sign out of Google" means nothing without it');
  for (const k of ['panel.signout.asAccount', 'panel.signout.signedInAs']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2,
      `${k} exists in both languages`);
  }
});
