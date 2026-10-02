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
  const s = save.indexOf('await settleConsentCapture(capture,');
  assert.ok(s > 0 && s < save.indexOf('await newDocFromAudio(file, title)'), 'saveRecording settles before the doc is written');
  assert.match(save.slice(s, s + 300), /if \(rec !== take\) return;/, 'and honors a Cancel pressed while waiting');
  assert.match(save, /t\('record\.waitingLocation'\)/, 'and the modal says why it is still saving');
});

test('the Consent Collector runs one group at a time while it waits (#88 review)', () => {
  const cc = fnSrc('ccCollectFor');
  assert.match(cc, /if \(!ids\.length \|\| ccSaving\) return;/, 'a second ask during the wait is refused');
  const on = cc.indexOf('ccSaving = true;');
  const settle = cc.indexOf('await settleConsentCapture(capture,');
  const off = cc.indexOf('ccSaving = false;');
  assert.ok(on > 0 && on < settle && off > settle, 'busy from before the wait until after the copies');
  assert.match(cc, /finally \{\s*ccSaving = false;/, 'and released even if the copy throws');
  assert.ok(!/ccSelected\.clear\(\)/.test(cc), 'a finished group no longer wipes a selection made during the wait');
  assert.match(cc, /for \(const id of ids\) ccSelected\.delete\(id\);/, 'it deselects only its own texts');
  assert.match(fnSrc('ccSyncActions'), /go\.disabled = ccSaving;/, 'the button shows it is busy');
});

/* ---- run the real code ---- */

const GEO_RECORD = fnSrc('geoRecord');
// `dialog` stands in for #consent-modal; requestConsentThen has just shown it when the requester runs.
const makeRequester = (navigator, CROWD_MODE = false, dialog = { hidden: false }) =>
  new Function('navigator', 'CROWD_MODE', '$', `${GEO_RECORD}\n${REQUESTER}\nreturn requestConsentGeo;`)(
    navigator, CROWD_MODE, (sel) => { assert.equal(sel, '#consent-modal'); return dialog; });

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

test('requester: a dialog closed while the permission query ran never sets off a prompt (#88 review)', async () => {
  const dialog = { hidden: false };
  const { nav, calls } = fakeNav({ state: 'prompt' });
  const query = nav.permissions.query;
  nav.permissions.query = async (d) => { const r = await query(d); dialog.hidden = true; return r; };   // Cancel, mid-query
  assert.equal(await makeRequester(nav, false, dialog)(), null);
  assert.equal(calls.query, 1);
  assert.equal(calls.get, 0, 'no getCurrentPosition once the dialog is gone');
  // The same check covers a browser with no Permissions API, where nothing is awaited first.
  const bare = fakeNav({ noPermissions: true });
  assert.equal(await makeRequester(bare.nav, false, { hidden: true })(), null);
  assert.equal(bare.calls.get, 0);
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
  assert.ok(Date.now() - t0 < 3000, 'returned at the cap, not never');
  assert.equal(receipt.approxLocation, 'unavailable');
});

/* settleConsentCapture with its 5 s step shortened, so the logic runs in real time. The bounds are
 * deliberately loose — a loaded machine runs timers late (a 25 ms "returns at once" bound failed 1 run
 * in 24 under load) — and each test picks a short step that keeps what it measures far from it. */
const SETTLE = fnSrc('settleConsentCapture');
assert.ok(SETTLE.includes('setTimeout(r, 5000)'));
const makeSettle = (shortMs) =>
  new Function(`${SETTLE.replace('setTimeout(r, 5000)', `setTimeout(r, ${shortMs})`)}\nreturn settleConsentCapture;`)();
const later = (ms) => new Promise((r) => setTimeout(r, ms));

test('settle: past the short wait ONLY while the location request is still pending', async () => {
  let said = 0;
  const geo = { pending: true };
  const promise = later(400).then(() => { geo.pending = false; });
  const t0 = Date.now();
  await makeSettle(50)({ geo, promise }, () => { said++; });
  assert.ok(Date.now() - t0 >= 350, 'waited for the location');
  assert.equal(said, 1, 'and said why, once');
});

test('settle: a slow IP lookup alone still gets only the short wait', async () => {
  let said = 0;
  const t0 = Date.now();
  await makeSettle(50)({ geo: { pending: false }, promise: later(2000) }, () => { said++; });
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the IP');
  assert.equal(said, 0);
});

test('settle: an already-finished capture returns at once and says nothing', async () => {
  let said = 0;
  const t0 = Date.now();
  await makeSettle(1000)({ geo: { pending: true }, promise: Promise.resolve() }, () => { said++; });
  assert.ok(Date.now() - t0 < 500, 'returned on the capture, not on the 1000 ms short wait');
  assert.equal(said, 0, 'a pending flag past the cap is not a reason to announce a wait');
  await makeSettle(1000)(null);   // no capture at all is fine
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
  assert.match(en, /only while the consent dialog is open/);
  assert.match(id, /hanya selama dialog persetujuan terbuka/);
  // #88 review: "asked … the first time consent is collected" promised once-only, which Chrome's
  // "Allow this time", a dismissed prompt and iOS's short grants all break. Usually, not always.
  assert.ok(!/first time consent is collected/.test(en), 'EN no longer promises a single ask');
  assert.ok(!/persetujuan pertama kali dikumpulkan/.test(id), 'ID no longer promises a single ask');
  assert.match(en, /usually just the first time on each device/);
  assert.match(id, /biasanya hanya pertama kali di setiap perangkat/);
});

test('the help page says location is asked only when consent is collected — in either language', () => {
  assert.ok(!/\(asked once\)/.test(I18N));
  assert.ok(!/\(ditanya sekali\)/.test(I18N));
  assert.match(block('en'), /\(asked only when consent is collected\)/);
  assert.match(block('id'), /\(ditanyakan hanya saat persetujuan dikumpulkan\)/);
});

test("the collector's and the recorder's waiting messages exist in both languages", () => {
  assert.match(str('en', 'cc.waitingLocation'), /location/);
  assert.match(str('id', 'cc.waitingLocation'), /lokasi/);
  assert.match(str('en', 'record.waitingLocation'), /location/);
  assert.match(str('id', 'record.waitingLocation'), /lokasi/);
});

/* ---- saveRecording: a take cancelled mid-save must not take a LATER consent with it (#88 review) ----
 *
 * Cancel stays live while saveRecording awaits (the encode, the MP3 convert, the location settle).
 * Cancel → consent again → a new take fits in that gap, and the old `if (!rec) return;` saw the NEW
 * take there: the old save then read the second consent's receipt, its closeRecordModal() threw away
 * the take in progress, and the OLD file was stored under the SECOND consent. The real function runs
 * here against stubs, with the same module-level `let`s it reads and writes in app.js. */
const SAVE = fnSrc('saveRecording');
function saveHarness() {
  const h = {
    stored: [], ui: [], closed: 0, released: [], errors: [],
    status: { textContent: '' },
    encode: null, settle: null, onLocationWait: null,
  };
  const $ = (sel) => {
    if (sel === '#record-title') return { value: 'Story', focus() {} };
    if (sel === '#record-status') return h.status;
    if (sel === '#record-preview') return { pause() {}, removeAttribute() {}, load() {} };
    throw new Error('unexpected selector ' + sel);
  };
  const env = new Function('h', '$', 'assert', `
    let rec = null, pendingAssent = null, pendingReceipt = null, pendingPromptAudio = null,
        pendingCapture = null, consentCapture = null, savingRecording = false;
    const CROWD_MODE = false;
    const settings = {};
    const REC_FORMATS = { webm: { save: 'direct', ext: 'webm', mime: 'audio/webm' }, wav32: {} };
    const t = (k) => k;
    const console = { error: (...a) => h.errors.push(a) };
    const recordUI = (state, extra) => h.ui.push(state === 'saving' ? 'saving ' + (extra && extra.pct) : state);
    const syncRecordSaveEnabled = () => {};
    const fileStamp = () => 'STAMP';
    const describeCapture = (m) => ({ mic: m && m.mic });
    const recordingProvenance = () => ({});
    const reduceChannels = (c) => c;
    const normalizePeak = () => {};
    const encodeRecording = (chans, rate, fmt, onProgress) => { h.onProgress = onProgress; return h.encode.promise; };
    const convertToMp3 = () => { throw new Error('not used'); };
    const wavWithBext = () => { throw new Error('not used'); };
    const captureBext = () => ({});
    const settleConsentCapture = (capture, onLocationWait) => { h.settledFor = capture; h.onLocationWait = onLocationWait; return h.settle ? h.settle.promise : undefined; };
    const releaseCapture = async (path) => { h.released.push(path); };
    const crowdQueueAndSubmit = async () => { throw new Error('not crowd'); };
    const Sync = { workerUploadTarget: () => false };
    const queueMediaUpload = async () => {};
    const applyUpdateIfSafe = () => {};
    function closeRecordModal() { rec = null; pendingAssent = null; pendingReceipt = null; pendingPromptAudio = null; h.closed++; }
    async function newDocFromAudio(file, title) {
      h.stored.push({ name: file.name, title, receipt: pendingReceipt, assent: pendingAssent, capture: pendingCapture });
      return 'doc-' + h.stored.length;
    }
    ${SAVE}
    return {
      saveRecording, closeRecordModal,
      consent(receipt, assent) { pendingReceipt = receipt; pendingAssent = assent; consentCapture = { receipt, geo: { pending: true }, promise: new Promise(() => {}) }; },
      start(take) { rec = take; },
      get rec() { return rec; },
      get pendingReceipt() { return pendingReceipt; },
      get saving() { return savingRecording; },
    };
  `)(h, $, assert);
  return { h, env };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const webmTake = (tag) => ({ mode: 'mr', fmt: 'webm', blob: new Blob([tag], { type: 'audio/webm' }) });

test('saveRecording: no cancel — the take is stored with ITS consent, after the location settles', async () => {
  const { h, env } = saveHarness();
  const R1 = { id: 'R1' };
  env.consent(R1, { name: 'consent-1.mp3' });
  env.start(webmTake('A'));
  h.settle = deferred();
  const p = env.saveRecording();
  await later(0);
  assert.equal(h.settledFor.receipt, R1, 'it settles the capture of the receipt it will store');
  assert.equal(h.stored.length, 0, 'nothing is stored before the location settles');
  h.onLocationWait();
  assert.equal(h.status.textContent, 'record.waitingLocation', 'a long wait says why, in the modal');
  h.settle.resolve();
  await p;
  assert.equal(h.stored.length, 1);
  assert.equal(h.stored[0].receipt, R1);
  assert.equal(h.stored[0].assent.name, 'consent-1.mp3');
  assert.equal(h.stored[0].name, 'recording-STAMP.webm');
  assert.equal(h.closed, 1);
  assert.equal(env.saving, false);
});

test('saveRecording: Cancel → consent again → new take during the LOCATION wait stores nothing and spares the new take', async () => {
  const { h, env } = saveHarness();
  const R1 = { id: 'R1' }, R2 = { id: 'R2' };
  env.consent(R1, null);
  env.start(webmTake('A'));
  h.settle = deferred();
  const p = env.saveRecording();
  await later(0);
  env.closeRecordModal();                // Cancel
  env.consent(R2, { name: 'consent-2.mp3' });   // the speaker is asked again…
  const takeB = { mode: 'mr', fmt: 'webm', recording: true };
  env.start(takeB);                      // …and a new take is being recorded
  h.onLocationWait();                    // a late "still waiting" must not repaint the new take's modal
  assert.equal(h.status.textContent, '');
  h.settle.resolve();
  await p;
  assert.deepEqual(h.stored, [], 'the cancelled take is not stored — least of all under R2');
  assert.equal(env.rec, takeB, 'the take in progress is untouched');
  assert.equal(env.pendingReceipt, R2, "and the second consent is still waiting for it");
  assert.equal(h.closed, 1, 'only the Cancel closed the modal');
});

test('saveRecording: a cancel during the ENCODE is honored the same way, and its progress and failure stay off the new take', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const { h, env } = saveHarness();
    const R1 = { id: 'R1' }, R2 = { id: 'R2' };
    env.consent(R1, null);
    env.start({ mode: 'pcm', fmt: 'wav32', channels: [new Float32Array(4)], sampleRate: 48000, blob: new Blob(['A']) });
    h.encode = deferred();
    const p = env.saveRecording();
    await later(0);
    env.closeRecordModal();
    env.consent(R2, null);
    const takeB = { mode: 'mr', fmt: 'webm', recording: true };
    env.start(takeB);
    const uiBefore = h.ui.length;
    h.onProgress(0.5);
    if (outcome === 'resolve') h.encode.resolve({ blob: new Blob(['wav']), ext: 'wav', mime: 'audio/wav' });
    else h.encode.reject(new Error('out of memory'));
    await p;
    assert.deepEqual(h.stored, [], `${outcome}: nothing stored`);
    assert.equal(h.settledFor, undefined, `${outcome}: never even waited for a location`);
    assert.equal(h.ui.length, uiBefore, `${outcome}: no progress or "review" painted over the new take`);
    assert.equal(env.rec, takeB, `${outcome}: the take in progress is untouched`);
    assert.equal(env.pendingReceipt, R2);
    assert.equal(h.closed, 1);
    assert.equal(env.saving, false);
    if (outcome === 'reject') assert.equal(h.errors.length, 1, 'the abandoned failure is logged, not shown');
  }
});

test('saveRecording: a native take keeps its own path and provenance through the wait', async () => {
  const { h, env } = saveHarness();
  const R1 = { id: 'R1' };
  env.consent(R1, null);
  // wavWithBext throws in the harness, so the untouched capture is used — the same fallback as app.js.
  env.start({ mode: 'native', nativeMeta: { path: '/cap/A.wav', mic: 'usb' }, blob: new Blob(['RIFF']) });
  h.settle = deferred();
  const p = env.saveRecording();
  await later(0);
  h.settle.resolve();
  await p;
  assert.equal(h.stored.length, 1);
  assert.deepEqual(h.stored[0].capture, { mic: 'usb' });
  assert.deepEqual(h.released, ['/cap/A.wav'], 'released only after it was stored');
});
