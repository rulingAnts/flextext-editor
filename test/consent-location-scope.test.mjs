/* Location is a CONSENT permission: asked only while the consent dialog is up (#88).
 *
 * WHY THIS EXISTS: Brian Plimley (2026-09-30) saw "app.flextext.app wants to know your location" in a
 * workflow with no consent step at all, and it made the app look sketchy. The cause was
 * primeGeolocationOnce(): setup() armed a one-shot pointerdown listener in every app that boots the
 * engine, so the FIRST TAP ANYWHERE asked for location. Seth (2026-10-02): "Brian's request is
 * correct: it's a consent-related permission. So it should only prompt the user when the consent
 * dialog box is up."
 *
 * Pinned here: nothing at boot or on a tap touches geolocation; the one requester runs only from
 * requestConsentThen, after the consent-off return and after the dialog is shown; its promise rides
 * the flow it belongs to; and the copy no longer promises "asked once at first use". The requester,
 * the receipt fill and the settle wait are also lifted out of the source and RUN against stubs, so
 * these are their actual answers, not a regex's opinion of them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const APP = readFileSync(new URL('docs/js/app.js', root), 'utf8');
const I18N = readFileSync(new URL('docs/js/i18n.js', root), 'utf8');

// The source of one top-level function (optionally async), up to its closing brace at column 0.
function fnSrc(name) {
  const re = new RegExp(`\\n(async )?function ${name}\\(`);
  const m = re.exec(APP);
  assert.ok(m, `${name} exists`);
  const start = m.index + 1;
  const end = APP.indexOf('\n}\n', start);
  assert.ok(end > start, `${name} has a closing brace`);
  return APP.slice(start, end + 2);
}

// Line-comment and block-comment text removed, so a comment that NAMES an API is not a call to it.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

const REQUESTER = fnSrc('requestConsentGeo');

test('the first-tap primer is gone, and no pointerdown listener sits near a geolocation call', () => {
  assert.ok(!/primeGeolocationOnce/.test(APP), 'primeGeolocationOnce is deleted, call and all');
  assert.ok(!/readGeoIfGranted|lastGeo|rememberGeo/.test(APP), 'the global-cache helpers are gone with it');
  const src = code(APP);
  let at = -1;
  while ((at = src.indexOf('pointerdown', at + 1)) >= 0) {
    const near = src.slice(Math.max(0, at - 800), at + 800);
    assert.ok(!/geolocation/.test(near), `no geolocation within reach of the pointerdown at offset ${at}`);
  }
});

test('getCurrentPosition and the geolocation permission query live ONLY inside requestConsentGeo', () => {
  const src = code(APP);
  const gets = src.match(/getCurrentPosition\(/g) || [];
  const queries = src.match(/permissions\.query\(\{\s*name:\s*'geolocation'\s*\}\)/g) || [];
  assert.equal(gets.length, 1, 'exactly one getCurrentPosition call in the engine');
  assert.equal(queries.length, 1, 'exactly one geolocation permission query in the engine');
  assert.match(code(REQUESTER), /getCurrentPosition\(/);
  assert.match(code(REQUESTER), /permissions\.query\(\{ name: 'geolocation' \}\)/);
  assert.ok(!/watchPosition/.test(src), 'and nothing watches position');
});

test("setup() — boot, in every app — never touches geolocation", () => {
  const setup = fnSrc('setup');
  assert.ok(setup.length > 5000, 'sliced the real setup(), not a stub');
  assert.ok(!/geolocation/.test(setup), 'no geolocation in setup()');
  assert.ok(!/requestConsentGeo/.test(setup), 'and no call to the requester from setup()');
});

test('requestConsentThen asks for location only after the consent-off return AND after the dialog is shown', () => {
  const body = fnSrc('requestConsentThen');
  const off = body.indexOf('if (ask.length === 0 && confirm.length === 0) { onApproved(null); return; }');
  const shown = body.indexOf("$('#consent-modal').hidden = false;");
  const asked = body.indexOf('requestConsentGeo()');
  assert.ok(off > 0, 'the consent-off early return is still there');
  assert.ok(shown > off, 'the dialog is shown after it');
  assert.ok(asked > shown, 'the location request starts only once the dialog is visible');
  const calls = code(APP).match(/(?<!function )requestConsentGeo\(\)/g) || [];
  assert.equal(calls.length, 1, 'requestConsentThen is the ONLY caller');
  // Per flow: the request is a local of this dialog, handed to this receipt only.
  assert.match(body, /const geo = \{ pending: true, promise: null \};/);
  assert.match(body, /consentCapture = \{ receipt: pendingReceipt, geo, promise: captureConsentContext\(pendingReceipt, geo\.promise\) \};/);
});

test('only the record buttons and the Consent Collector enter the consent gate — never the segmenter', () => {
  const lines = APP.split('\n');
  const callers = new Set();
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (!/requestConsentThen\(/.test(ln) || /function requestConsentThen\(/.test(ln)) return;
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    for (let j = i; j >= 0; j--) {
      const m = lines[j].match(/^(?:async )?function (\w+)\(/);
      if (m) { callers.add(m[1]); break; }
    }
  });
  assert.deepEqual([...callers].sort(), ['ccCollectFor', 'startConsentThenRecord']);
  assert.ok(!/requestConsentThen|startConsentThenRecord/.test(fnSrc('setupSegmenterMode')));
});

test('the requester refuses the crowd page first, before anything else', () => {
  const body = REQUESTER.slice(REQUESTER.indexOf('{') + 1);
  const first = body.replace(/^\s*(\/\/[^\n]*\n)*/, '').trimStart();
  assert.ok(first.startsWith('if (CROWD_MODE) return null;'), 'CROWD_MODE guard is the first statement');
});

test('captureConsentContext waits on THIS flow\'s promise, capped, and keeps the receipt shape', () => {
  const cap = fnSrc('captureConsentContext');
  assert.match(cap, /^async function captureConsentContext\(receipt, geo\)/);
  assert.match(cap, /Promise\.race\(\[\s*Promise\.resolve\(geo\)/);
  assert.match(cap, /setTimeout\(\(\) => r\(null\), CONSENT_GEO_WAIT_MS\)/);
  assert.ok(!/readGeoIfGranted/.test(cap));
  assert.match(APP, /const CONSENT_GEO_WAIT_MS = 20000;/);
  assert.match(fnSrc('buildConsentReceipt'), /approxLocation: 'unavailable',/, 'a fresh receipt starts unavailable');
});

test('the Consent Collector and the recorder settle the location before copying or storing the receipt', () => {
  const cc = fnSrc('ccCollectFor');
  const pay = cc.indexOf('const payload = {');
  const settle = cc.indexOf('await settleConsentCapture(capture,');
  const attach = cc.indexOf('await ccAttachConsent(ids, payload)');
  assert.ok(pay > 0 && settle > pay && attach > settle, 'payload taken, then settled, then cloned onto the texts');
  assert.match(cc, /toast\(t\('cc\.waitingLocation'\), CONSENT_GEO_WAIT_MS\)/, 'a long wait says why');
  assert.ok(!/setTimeout\(r, 5000\)/.test(cc), 'no bare 5 s cap left in the collector');
  const save = fnSrc('saveRecording');
  const s = save.indexOf('await settleConsentCapture(consentCapture)');
  assert.ok(s > 0 && s < save.indexOf('await newDocFromAudio(file, title)'), 'saveRecording settles before the doc is written');
  assert.match(save.slice(s, s + 200), /if \(!rec\) return;/, 'and honors a Cancel pressed while waiting');
});

/* ---- run the real code ---- */

const GEO_RECORD = fnSrc('geoRecord');
const makeRequester = (navigator, CROWD_MODE = false) =>
  new Function('navigator', 'CROWD_MODE', `${GEO_RECORD}\n${REQUESTER}\nreturn requestConsentGeo;`)(navigator, CROWD_MODE);

const POS = { coords: { latitude: -2.5, longitude: 140.7, accuracy: 812.4 }, timestamp: Date.UTC(2026, 9, 2) };
function fakeNav({ state, queryThrows = false, noPermissions = false, fail = false } = {}) {
  const calls = { query: 0, get: 0, opts: null };
  const nav = {
    geolocation: {
      getCurrentPosition(ok, err, opts) { calls.get++; calls.opts = opts; fail ? err(new Error('denied')) : ok(POS); },
    },
  };
  if (!noPermissions) {
    nav.permissions = {
      async query(d) { calls.query++; assert.deepEqual(d, { name: 'geolocation' }); if (queryThrows) throw new TypeError('unsupported'); return { state }; },
    };
  }
  return { nav, calls };
}

test('requester: a permission query that throws still asks', async () => {
  const { nav, calls } = fakeNav({ queryThrows: true });
  const loc = await makeRequester(nav)();
  assert.equal(calls.get, 1);
  assert.deepEqual(loc, { lat: -2.5, lon: 140.7, accuracyMeters: 812, at: '2026-10-02T00:00:00.000Z' });
});

test('requester: no Permissions API at all still asks', async () => {
  const { nav, calls } = fakeNav({ noPermissions: true });
  assert.ok(await makeRequester(nav)());
  assert.equal(calls.get, 1);
});

test("requester: a device that said no ('denied') is never asked again", async () => {
  const { nav, calls } = fakeNav({ state: 'denied' });
  assert.equal(await makeRequester(nav)(), null);
  assert.equal(calls.get, 0);
});

test("requester: 'prompt' asks, with the calm options, and resolves to the receipt's location shape", async () => {
  const { nav, calls } = fakeNav({ state: 'prompt' });
  const loc = await makeRequester(nav)();
  assert.equal(calls.get, 1);
  assert.deepEqual(calls.opts, { timeout: 15000, maximumAge: 300000, enableHighAccuracy: false });
  assert.equal(loc.lat, -2.5);
});

test('requester: a refusal or no fix resolves to null, never throws', async () => {
  const { nav } = fakeNav({ state: 'prompt', fail: true });
  assert.equal(await makeRequester(nav)(), null);
});

test('requester: the crowd page and a browser without geolocation are never asked', async () => {
  const { nav, calls } = fakeNav({ state: 'granted' });
  assert.equal(await makeRequester(nav, true)(), null);
  assert.equal(calls.query + calls.get, 0, 'crowd: not even a permission query');
  assert.equal(await makeRequester({})(), null);
});

const CAPTURE = fnSrc('captureConsentContext');
const makeCapture = (waitMs) => new Function('CROWD_MODE', 'CONSENT_GEO_WAIT_MS', 'current', 'persist', 'fetch',
  `${CAPTURE}\nreturn captureConsentContext;`)(false, waitMs, null, async () => {}, async () => { throw new Error('offline'); });

test("captureConsentContext puts this flow's location on this receipt", async () => {
  const receipt = { ipAddress: 'unavailable', approxLocation: 'unavailable' };
  const loc = { lat: 1, lon: 2, accuracyMeters: 3, at: 'x' };
  await makeCapture(1000)(receipt, Promise.resolve(loc));
  assert.deepEqual(receipt.approxLocation, loc);
  assert.equal(receipt.ipAddress, 'unavailable', 'offline IP lookup leaves its placeholder');
});

test('captureConsentContext gives up at the cap: an unanswered prompt leaves "unavailable"', async () => {
  const receipt = { ipAddress: 'unavailable', approxLocation: 'unavailable' };
  const t0 = Date.now();
  await makeCapture(40)(receipt, new Promise(() => {}));   // never answered
  assert.ok(Date.now() - t0 < 1000, 'returned at the cap, not never');
  assert.equal(receipt.approxLocation, 'unavailable');
});

// settleConsentCapture with its 5 s step shortened to 30 ms, so the logic runs in real time.
const SETTLE = fnSrc('settleConsentCapture');
assert.ok(SETTLE.includes('setTimeout(r, 5000)'));
const settle = new Function(`${SETTLE.replace('setTimeout(r, 5000)', 'setTimeout(r, 30)')}\nreturn settleConsentCapture;`)();
const later = (ms) => new Promise((r) => setTimeout(r, ms));

test('settle: past the short wait ONLY while the location request is still pending', async () => {
  let said = 0;
  const geo = { pending: true };
  const promise = later(120).then(() => { geo.pending = false; });
  const t0 = Date.now();
  await settle({ geo, promise }, () => { said++; });
  assert.ok(Date.now() - t0 >= 100, 'waited for the location');
  assert.equal(said, 1, 'and said why, once');
});

test('settle: a slow IP lookup alone still gets only the short wait', async () => {
  let said = 0;
  const t0 = Date.now();
  await settle({ geo: { pending: false }, promise: later(400) }, () => { said++; });
  assert.ok(Date.now() - t0 < 300, 'did not wait for the IP');
  assert.equal(said, 0);
});

test('settle: an already-finished capture returns at once and says nothing', async () => {
  let said = 0;
  const t0 = Date.now();
  await settle({ geo: { pending: true }, promise: Promise.resolve() }, () => { said++; });
  assert.ok(Date.now() - t0 < 25);
  assert.equal(said, 0, 'a pending flag past the cap is not a reason to announce a wait');
  await settle(null);   // no capture at all is fine
});

/* ---- copy ---- */

function block(lang) {
  const at = I18N.indexOf(`\n${lang}: {`);
  assert.ok(at >= 0, `${lang} block`);
  const rest = I18N.slice(at + 1);
  const nxt = rest.search(/\n[a-z]{2,3}: \{/);
  return nxt < 0 ? I18N.slice(at) : I18N.slice(at, at + 1 + nxt);
}
const str = (lang, key) => {
  const b = block(lang);
  const i = b.indexOf(`'${key}': `);
  assert.ok(i >= 0, `${lang} has ${key}`);
  return b.slice(i, b.indexOf('\n', i));
};

test('the consent note no longer promises "asked once at first use" — in either language', () => {
  const en = str('en', 'consent.note');
  const id = str('id', 'consent.note');
  assert.ok(!/first use/.test(en) && !/just once/.test(en));
  assert.ok(!/saat pertama dipakai/.test(id) && !/sekali saja/.test(id));
  assert.match(en, /first time consent is collected/);
  assert.match(en, /only while the consent dialog is open/);
  assert.match(id, /persetujuan pertama kali dikumpulkan/);
  assert.match(id, /hanya selama dialog persetujuan terbuka/);
});

test('the help page says location is asked only when consent is collected — in either language', () => {
  assert.ok(!/\(asked once\)/.test(I18N));
  assert.ok(!/\(ditanya sekali\)/.test(I18N));
  assert.match(block('en'), /\(asked only when consent is collected\)/);
  assert.match(block('id'), /\(ditanyakan hanya saat persetujuan dikumpulkan\)/);
});

test("the collector's waiting message exists in both languages", () => {
  assert.match(str('en', 'cc.waitingLocation'), /location/);
  assert.match(str('id', 'cc.waitingLocation'), /lokasi/);
});
