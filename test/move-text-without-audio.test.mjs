/* A TEXT WITH NO RECORDING CAN MOVE, AND A REFUSED TEXT NEVER BLAMES THE DEVICE (#89).
 *
 * Brian Plimley, 2026-10-01: in the Researcher Panel, Move… on a .flextext-only text in a project's
 * Unassigned box showed his device "My device" disabled with "reported v689 as of just now — too old
 * to receive a move" — on a device that was current.
 *
 * Two faults, one screen:
 *
 *  1. THE TEXT WAS REFUSED. moveSources() demanded an original recording unconditionally, so a text
 *     whose manifest declares none (a .flextext-only project upload writes `audio: null`) could never
 *     move. The flextext half of the same check had been relaxed in v416 under Seth's rule — "I want
 *     to be able to move any text anywhere, except to a crowd recorder" — and the recording half was
 *     simply never given the same treatment. A recording is now required only if one is DECLARED.
 *
 *  2. THE DEVICE WAS BLAMED. groupedDestinations() labelled every disabled tile with tooOldLabel(),
 *     whatever had disabled it. The version it printed was right; the conclusion ("too old") was
 *     false. Closed issue #16 was the same mislabel. The caller now supplies the reason (`subOf`).
 *
 * The REAL moveSources / pickSourceFiles / groupedDestinations are lifted out of
 * researcher-panel.js and run against a fake Drive (files-menu-manifest.test.mjs's technique), and
 * the manifests are built by the REAL buildSourceManifest, so these are the shapes the writers emit.
 *
 * Run: node --test test/move-text-without-audio.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSourceManifest, MANIFEST_NAME } from '../docs/js/seg-exports.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const panel = rd('../docs/js/researcher-panel.js');
const i18n = rd('../docs/js/i18n.js');

const grab = (re, what) => {
  const m = panel.match(re);
  assert.ok(m, `${what} is findable in researcher-panel.js`);
  return m[0];
};
const rolesSrc = grab(/const SOURCE_AUDIO_ROLES = [\s\S]*?const isFlextextName = [^;]*;/, 'the role sets');
const pickSrc = grab(/function pickSourceFiles\(files\) \{[\s\S]*?\n\}/, 'pickSourceFiles');
const movSrc = grab(/async function moveSources\(fromId, docId, title\) \{[\s\S]*?\n\}/, 'moveSources');
const gdSrc = grab(/function groupedDestinations\(insts, homeProject, opt, canPick, withUnassigned, subOf = tooOldLabel\) \{[\s\S]*?\n\}/,
  'groupedDestinations (with its subOf parameter)');

/* Run the real gate over a fake folder. `manifest` is the JSON body the manifest file returns;
 * `null` serves an unreadable body, `undefined` serves no manifest file at all. */
async function gate(files, manifest) {
  const folder = [...files];
  if (manifest !== undefined) folder.push(file(MANIFEST_NAME, 'manifest', '2026-09-01T00:00:00Z'));
  const env = {
    MANIFEST_NAME,
    bridgedIds: () => ({ ids: ['doc1'], audioUrl: '', latestEventFileId: '' }),
    Researcher: {
      listTextFiles: async () => ({ files: folder }),
      fetchDriveFile: async () => ({ text: async () => (manifest === null ? 'not json' : JSON.stringify(manifest)) }),
    },
  };
  const moveSources = new Function(...Object.keys(env), `
    ${rolesSrc}
    ${pickSrc}
    return (${movSrc.replace('async function moveSources', 'async function')});
  `)(...Object.values(env));
  return moveSources('inst1', 'doc1', 'Kisah Rusa');
}

const file = (name, role = '', modified = '2026-09-10T00:00:00Z') =>
  ({ id: 'id-' + name, name, role, modified, size: 100, mime: '' });

const AUDIO = { name: 'Kisah Rusa.mp3', mime: 'audio/mpeg', bytes: 5000000, derived: false };
const AUDIO_ROW = { name: 'Kisah Rusa.mp3', role: 'source-audio', mime: 'audio/mpeg', bytes: 5000000 };
const FT_ROW = { name: 'Kisah Rusa.flextext', role: 'source-flextext', mime: 'application/xml', bytes: 4000 };
const man = ({ audio = null, files = [], origin = 'assigned' } = {}) =>
  buildSourceManifest({ docId: 'doc1', title: 'Kisah Rusa', origin, audio, files });

test('a .flextext-only text — no recording declared — moves (Brian\'s text, #89)', async () => {
  // Exactly what the panel's project-upload lane writes when only a .flextext was given.
  const r = await gate([file('Kisah Rusa.flextext', 'source-flextext')], man({ audio: null, files: [FT_ROW] }));
  assert.equal(r.declaresAudio, false, 'a manifest with audio:null and no source-audio row declares no recording');
  assert.equal(r.audio, null, 'and none is found');
  assert.ok(r.picks.flextext, 'the flextext resolves');
  assert.equal(r.ok, true, 'so the text is movable — the recording is not required when none was declared');
});

test('a recording that is declared but absent still refuses', async () => {
  // A recording still uploading must not be silently dropped by a move.
  const r = await gate([file('Kisah Rusa.flextext', 'source-flextext')],
    man({ audio: AUDIO, files: [AUDIO_ROW, FT_ROW] }));
  assert.equal(r.declaresAudio, true);
  assert.equal(r.ok, false, 'declared-but-missing refuses');
  assert.equal(r.declaredMissing, true, '...and says that a NAMED file is what is missing');

  // Declared by either signal alone — every writer sets one or both.
  const viaRow = await gate([file('Kisah Rusa.flextext', 'source-flextext')], man({ audio: null, files: [AUDIO_ROW, FT_ROW] }));
  assert.equal(viaRow.declaresAudio, true, 'a source-audio row alone declares a recording');
  assert.equal(viaRow.ok, false);
  const viaAudio = await gate([file('Kisah Rusa.flextext', 'source-flextext')], man({ audio: AUDIO, files: [FT_ROW] }));
  assert.equal(viaAudio.declaresAudio, true, 'a non-null `audio` alone declares a recording');
  assert.equal(viaAudio.ok, false);
});

test('...and a consent clip is never mistaken for the missing recording', async () => {
  /* The extension fallback used to match ANY audio-shaped name, so a consent clip that arrived
   * before the recording became `audio` and passed the gate — and would have been assigned as the
   * recording. Tagged files say what they are; the fallback is for untagged legacy files only. */
  const r = await gate([file('Kisah Rusa.flextext', 'source-flextext'), file('consent-response.mp3', 'consent-clip')],
    man({ audio: AUDIO, files: [AUDIO_ROW, FT_ROW, { name: 'consent-response.mp3', role: 'consent-clip', mime: 'audio/mpeg', bytes: 9 }] }));
  assert.equal(r.audio, null, 'a consent-clip is not the recording');
  assert.equal(r.ok, false, 'so the declared-but-missing recording still refuses');

  // The legacy case the fallback exists for still works: an UNTAGGED recording is found by its name.
  const legacy = await gate([file('Kisah Rusa.mp3'), file('Kisah Rusa.flextext', 'source-flextext')],
    man({ audio: AUDIO, files: [FT_ROW] }));
  assert.equal(legacy.audio && legacy.audio.name, 'Kisah Rusa.mp3', 'an untagged audio file still resolves');
  assert.equal(legacy.ok, true);
});

test('a flextext that is declared but absent still refuses (v416 rule, unchanged)', async () => {
  const r = await gate([file('Kisah Rusa.mp3', 'source-audio')], man({ audio: AUDIO, files: [AUDIO_ROW, FT_ROW] }));
  assert.equal(r.declaresFlextext, true);
  assert.equal(r.ok, false);
  assert.equal(r.declaredMissing, true);
});

test('a manifest declaring neither, over a folder holding neither, refuses — nothing to deliver', async () => {
  const r = await gate([], man({ audio: null, files: [] }));
  assert.equal(r.declaresAudio, false);
  assert.equal(r.declaresFlextext, false);
  assert.equal(r.ok, false, 'at least one deliverable must exist');
  assert.equal(r.declaredMissing, false,
    '...and it is NOT "incomplete" — no named file is missing — so the modal says nothingToMove instead');
});

test('the ordinary text — recording and flextext both declared and present — moves', async () => {
  const r = await gate([file('Kisah Rusa.mp3', 'source-audio'), file('Kisah Rusa.flextext', 'source-flextext')],
    man({ audio: AUDIO, files: [AUDIO_ROW, FT_ROW] }));
  assert.equal(r.ok, true);
  assert.equal(r.audio.name, 'Kisah Rusa.mp3');
  assert.equal(r.picks.flextext.name, 'Kisah Rusa.flextext');
});

test('an audio-only text with no flextext declared (a crowd recording) moves', async () => {
  const r = await gate([file('Kisah Rusa.mp3', 'source-audio')], man({ audio: AUDIO, files: [AUDIO_ROW], origin: 'crowd' }));
  assert.equal(r.declaresFlextext, false);
  assert.equal(r.ok, true);
});

test('no manifest, or an unreadable one, still refuses (noManifest — unchanged)', async () => {
  const none = await gate([file('Kisah Rusa.mp3', 'source-audio'), file('Kisah Rusa.flextext', 'source-flextext')], undefined);
  assert.equal(none.manifest, null);
  assert.equal(none.ok, false);
  const bad = await gate([file('Kisah Rusa.mp3', 'source-audio')], null);
  assert.equal(bad.manifest, null, 'an unreadable body is not a manifest');
  assert.equal(bad.ok, false);
});

/* ── PART A: the tile names the reason it is disabled ───────────────────────────────────────────── */

/* Run the real groupedDestinations over one project holding Brian's device. Returns the tiles. */
function tiles(canPick, subOf) {
  const out = [];
  const env = {
    estateCache: { projects: [{ folderId: 'P1', name: 'Fayu' }] },
    projectOfInstance: () => 'P1',
    esc: (s) => String(s == null ? '' : s),
    t: (k) => k,
    tooOldLabel: (x) => `TOO-OLD(${x.nickname})`,
  };
  const gd = new Function(...Object.keys(env), `return (${gdSrc});`)(...Object.values(env));
  const opt = (value, label, sub, disabled, checked) => { out.push({ value, label, sub, disabled, checked }); return ''; };
  const dev = { instance_id: 'i-brian', nickname: 'My device', _canReceive: true,
                installs: [{ inventory: { engineVersion: 'v689' }, last_seen_at: Date.now() }] };
  const args = [[dev], 'P1', opt, canPick, false];
  if (subOf) args.push(subOf);
  gd(...args);
  return out.filter((o) => o.value === 'i-brian');
}

test('groupedDestinations: a caller that passes no subOf keeps the old label exactly', () => {
  const [tile] = tiles(() => false);
  assert.equal(tile.disabled, true);
  assert.equal(tile.sub, 'TOO-OLD(My device)', 'default subOf is tooOldLabel');
  const [on] = tiles(() => true);
  assert.equal(on.sub, '', 'and an enabled tile has no sub-label');
});

test('moveTextModal: a current device refused because of the TEXT is not called too old', () => {
  const mvAt = panel.indexOf('async function moveTextModal');
  const mv = panel.slice(mvAt, panel.indexOf('\n}\n', panel.indexOf('  });', mvAt)) + 3);
  // The REAL subOf line from the modal, evaluated with the same stubs.
  const line = (mv.match(/const blockedSub = \(x\) => [^;]*;/) || [''])[0];
  assert.ok(line, 'moveTextModal defines blockedSub');
  const blockedSub = new Function('t', 'tooOldLabel', `${line} return blockedSub;`)(
    (k) => k, (x) => `TOO-OLD(${x.nickname})`);

  const deviceOk = false;   // the text gate failed — Brian's case
  const [tile] = tiles((x) => deviceOk && x._canReceive, blockedSub);
  assert.equal(tile.disabled, true, 'the device is still not selectable — the text cannot be sent');
  assert.equal(tile.sub, 'panel.move.textBlocked', '...but the tile points at the note, not at the version');

  // And a device that really IS too old still says so.
  assert.equal(blockedSub({ nickname: 'Old phone', _canReceive: false }), 'TOO-OLD(Old phone)');

  assert.match(mv, /groupedDestinations\(insts, homeProject, opt, \(x\) => deviceOk && x\._canReceive, true, blockedSub\)/,
    'the grouped list is given blockedSub');
  assert.match(mv, /deviceOk && x\._canReceive \? '' : blockedSub\(x\)/,
    'and the flat (no-projects) fallback uses the same words');
  assert.doesNotMatch(mv, /x\._canReceive \? '' : tooOldLabel\(x\)/,
    'the flat fallback no longer prints the version for every disabled reason');
});

test('adoptTextModal: its only refusal is the text, so it never shows a version', () => {
  const adAt = panel.indexOf('async function adoptTextModal');
  const ad = panel.slice(adAt, panel.indexOf('\n}\n', panel.indexOf('  }));', adAt)) + 3);
  assert.match(ad, /const textBlocked = \(\) => t\('panel\.move\.textBlocked'\);/, 'the neutral label');
  assert.match(ad, /groupedDestinations\(insts, homeProject, adoptOpt, \(\) => deviceOk, !!opts\.unassign, textBlocked\)/,
    'is what the grouped list is given — and canPick is still `() => deviceOk` (no version gate added to adopt)');
  assert.match(ad, /deviceOk \? '' : textBlocked\(\), !deviceOk, deviceOk && i === 0\)/,
    'the flat fallback labels a disabled tile the same way, and never pre-selects it');
  assert.doesNotMatch(ad, /tooOldLabel/, 'adopt never mentions a device version');

  const [tile] = tiles(() => false, () => 'panel.move.textBlocked');
  assert.equal(tile.sub, 'panel.move.textBlocked');
});

test('groupedDestinations no longer hard-codes tooOldLabel at either tile site', () => {
  const body = gdSrc.slice(gdSrc.indexOf('{'));
  assert.doesNotMatch(body, /tooOldLabel/, 'only the default parameter names it');
  assert.equal((body.match(/ok \? '' : subOf\(x\)/g) || []).length, 2, 'both tile sites (project groups and loose devices) use subOf');
});

test('both modals name the three refusal causes apart', () => {
  const re = /why = !src\.manifest \? 'panel\.move\.noManifest'\s*: src\.declaredMissing \? 'panel\.move\.manifestIncomplete' : 'panel\.move\.nothingToMove'/g;
  assert.equal((panel.match(re) || []).length, 2, 'moveTextModal and adoptTextModal alike');
});

test('the new and reworded strings are in BOTH languages', () => {
  const block = (lang) => {
    const at = i18n.indexOf(`\n${lang}: {`);
    const rest = i18n.slice(at + 1);
    const nxt = rest.search(/\n[a-z]{2,3}: \{/);
    return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
  };
  const val = (lang, k) => (block(lang).match(new RegExp(`^  '${k.replace(/\./g, '\\.')}': '([^']*)'`, 'm')) || [])[1] || '';
  for (const lang of ['en', 'id']) {
    assert.ok(val(lang, 'panel.move.textBlocked'), `panel.move.textBlocked is in ${lang}`);
    assert.ok(val(lang, 'panel.move.manifestIncomplete'), `panel.move.manifestIncomplete is in ${lang}`);
  }
  // Neutral: it must not claim anything about the device's version.
  assert.doesNotMatch(val('en', 'panel.move.textBlocked'), /old|version|update/i,
    'textBlocked says nothing about the device being out of date');
  // The reworded incomplete message: a NAMED file is absent, and it still gives the remedy.
  const mi = val('en', 'panel.move.manifestIncomplete');
  assert.match(mi, /names a file/, 'manifestIncomplete now says a named file is missing');
  assert.doesNotMatch(mi, /both/, '...not that both a .flextext and a recording are required');
  assert.match(mi, /download/i);
  assert.match(mi, /re-upload/i);
});
