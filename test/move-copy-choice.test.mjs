/* A MOVE SENDS THE SOURCE'S CURRENT STATE, NOT DRIVE'S NEWEST FILE (plans/move-upload-guards.md G1).
 *
 * WHY THIS TEST EXISTS: move and adopt delivered the newest .flextext in the text's folder — Drive
 * modifiedTime, which is UPLOAD time — and never read what the source device reported. Confirmed on a
 * real estate: a 25-line text went back to its 4-line state on the new device, and a text cut into 32
 * lines was replaced by an empty one, while the source's release then uploaded the real work into
 * the folder where nobody looked.
 *
 * The real chooseMoveCopy (and every helper it closes over) is LIFTED out of researcher-panel.js and
 * run over copies built by the real serializer and counted by the real flextextStats.
 *
 * ⚠ THE CASE THAT MUST NOT ASK: ordinary editing. A join makes the copy from before it "longer" by
 * lines, and clearing wrong glosses makes an older copy "richer" in glosses. A guard that sent the
 * older copy — or demanded a choice on every ordinary move — would undo the coworker's own work or
 * train the researcher to click through. Only CONTENT measures count, and an older same-text copy
 * never outranks the device's own current copy (a note says so instead).
 *
 * Run: node --test test/move-copy-choice.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flextextStats, serializeFlextext, makeDoc, reconcileBaseline } = await import('../docs/js/flextext.js');
const { assignedEvent } = await import('../docs/js/history.js');

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const grab = (re, what) => { const m = panel.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const roleSrc = grab(/const SOURCE_AUDIO_ROLES = [\s\S]*?const isFlextextName = [^;]*;/, 'the role sets');
const helpers = grab(/const STAT_ALL = [\s\S]*?\nfunction statsHaveContent\(s\) \{[\s\S]*?\n\}/, 'the stat helpers');
const rowsSrc = grab(/function moveCopyRows\(files\) \{[\s\S]*?\n\}/, 'moveCopyRows');
const chooseSrc = grab(/function chooseMoveCopy\(\{ source, files, stats, deliveredId, adopt \}\) \{[\s\S]*?\n\}/, 'chooseMoveCopy');
const devSrc = grab(/function deviceItems\(instanceId, docId\) \{[\s\S]*?\n\}/, 'deviceItems');
const holdsSrc = grab(/function instanceHoldsDoc\(x, docId\) \{[\s\S]*?\n\}/, 'instanceHoldsDoc');
const paintSrc = grab(/function paintCopyChoice\(box, choice, ctx\) \{[\s\S]*?\n\}/, 'paintCopyChoice');
const flagSrc = grab(/async function flagNewerAfterMove\(docId, mv\) \{[\s\S]*?\n\}/, 'flagNewerAfterMove');

const lib = new Function('MANIFEST_NAME', `${roleSrc}\n${helpers}\n${rowsSrc}\n${chooseSrc}\nreturn { chooseMoveCopy, moveCopyRows };`)('flextext-manifest.json');
const { chooseMoveCopy } = lib;

const xml = (guid, lines, { glossed = 0 } = {}) => {
  const d = makeDoc({ vernLang: 'qaa', analLang: 'id' }, 'Cerita');
  d.textAttrs.guid = guid;
  reconcileBaseline(d, lines.length ? lines : ['']);
  let g = glossed;
  for (const p of d.paragraphs) for (const s of p.segments) for (const w of s.words) if (g > 0 && !w.punct) { w.gls = 'x'; g--; }
  return serializeFlextext(d, { vernLang: 'qaa', analLang: 'id' });
};
const lines = (n) => Array.from({ length: n }, (_, i) => `kata ${i + 1} lagi`);
let seq = 0;
const copy = (day, body, extra = {}) => ({ id: 'f' + (++seq), name: `Cerita ${day}.flextext`,
  modified: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`, size: (body || '').length, role: '', sha256: '', body, ...extra });
const statsOf = (files, extra = {}) => {
  const m = new Map(files.map((f) => {
    if (/\.zip$/.test(f.name)) return [f.id, { state: 'unchecked', why: 'zip' }];
    const st = flextextStats(f.body);
    return [f.id, { state: st.ok ? 'ok' : st.damaged ? 'damaged' : 'unreadable', stats: st }];
  }));
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  return m;
};
const dev = (item) => ({ item: { id: 'doc1', ...item }, seenAt: Date.now() });
const choose = (files, o = {}) => chooseMoveCopy({ files, stats: o.stats || statsOf(files), source: o.source || null,
  deliveredId: o.deliveredId || '', adopt: !!o.adopt });

test('no report, no guess: a device that has not reported the text gets no copy chosen for it', () => {
  assert.equal(choose([copy(1, xml('A', lines(3)))]).decision, 'noReport');
});

test('THE INCIDENT: the device\'s own upload is sent, not the newer, poorer file', () => {
  const work = copy(3, xml('A', lines(25)));
  const poorer = copy(9, xml('A', lines(4)));           // newest by upload time
  const r = choose([poorer, work], { source: dev({ uploadState: 'uploaded', uploadedFileId: work.id }) });
  assert.equal(r.decision, 'send');
  assert.equal(r.file.id, work.id, 'the 25-line copy the device actually holds');
  assert.equal(r.path, 'device');
});

test('unsent work refuses with a choice — changed, never sent, and sending now are each named', () => {
  const f = copy(3, xml('A', lines(5)));
  assert.deepEqual([choose([f], { source: dev({ uploadState: 'changed', uploadedFileId: f.id }) })].map((r) => [r.decision, r.flavor]),
    [['needsUpload', 'changed']]);
  assert.deepEqual([choose([f], { source: dev({ uploadState: 'local' }) })].map((r) => [r.decision, r.flavor]), [['needsUpload', 'local']]);
  assert.equal(choose([f], { source: dev({}) }).flavor, 'local', 'no state reported reads as never sent');
  assert.equal(choose([f], { source: dev({ uploadState: 'uploading' }) }).decision, 'wait');
  // The Drive copy is still on offer as the deliberate way out for every one of these.
  assert.ok(choose([f], { source: dev({ uploadState: 'changed' }) }).candidates.some((c) => c.id === f.id));
});

test('a device copy missing from the listing is LOOKED UP by id before it is called missing', () => {
  const other = copy(2, xml('A', lines(3)));
  const gone = choose([other], { source: dev({ uploadState: 'uploaded', uploadedFileId: 'X1' }), stats: statsOf([other], { X1: { state: 'missing' } }) });
  assert.equal(gone.decision, 'lastCopyMissing');
  const body = xml('A', lines(6));
  const found = choose([other], { source: dev({ uploadState: 'uploaded', uploadedFileId: 'X2' }),
    stats: statsOf([other], { X2: { state: 'ok', stats: flextextStats(body) } }) });
  assert.equal(found.decision, 'send', 'found by id (an old duplicate folder, a lagging listing) → it exists');
  assert.equal(found.file.id, 'X2');
  assert.equal(found.file.notListed, true);
});

test('a damaged device copy is never sent — by content, or by a hash that changed on the way', () => {
  const nul = copy(9, '\u0000'.repeat(489));
  const good = copy(4, xml('A', lines(5)));
  const r = choose([nul, good], { source: dev({ uploadState: 'uploaded', uploadedFileId: nul.id }) });
  assert.equal(r.decision, 'damaged');
  assert.ok(!r.candidates.some((c) => c.id === nul.id), 'and it is not offered as a candidate either');
  const f = copy(5, xml('A', lines(5)), { sha256: 'drive-says' });
  const h = choose([f], { source: dev({ uploadState: 'uploaded', uploadedFileId: f.id, uploadedSha256: 'device-sent' }) });
  assert.equal(h.decision, 'damaged', 'the device reports the hash of what it sent; Drive lists its own');
});

test('a JOIN does not make the pre-join copy win, or even ask', () => {
  const before = copy(3, xml('A', ['satu dua', 'tiga empat']));
  const after = copy(6, xml('A', ['satu dua tiga empat']));
  const r = choose([after, before], { source: dev({ uploadState: 'uploaded', uploadedFileId: after.id }) });
  assert.equal(r.decision, 'send');
  assert.equal(r.file.id, after.id);
  assert.equal(r.note, '', 'content is equal, so not even a note');
});

test('an OLDER same-text copy with more glosses is a note, never a question and never what is sent', () => {
  const older = copy(3, xml('A', lines(4), { glossed: 6 }));
  const mine = copy(6, xml('A', lines(4), { glossed: 1 }));   // wrong glosses cleared on the device
  const r = choose([mine, older], { source: dev({ uploadState: 'uploaded', uploadedFileId: mine.id }) });
  assert.equal(r.decision, 'send');
  assert.equal(r.file.id, mine.id);
  assert.equal(r.note, 'olderRicher');
  assert.equal(r.richer.id, older.id);
});

test('THE OTHER INCIDENT: a device holding a fresh placeholder, Drive holding the transcription → the researcher chooses', () => {
  const transcription = copy(2, xml('A', lines(32)));
  const placeholder = copy(8, xml('NEW', []));
  const r = choose([placeholder, transcription], { source: dev({ uploadState: 'uploaded', uploadedFileId: placeholder.id }) });
  assert.equal(r.decision, 'pick');
  assert.equal(r.file, null, 'nothing is preselected');
  assert.equal(r.candidates[0].id, transcription.id, 'listed richest first');
});

test('a NEWER copy richer than the device\'s last upload means a stale report → the researcher chooses', () => {
  const mine = copy(3, xml('A', lines(4)));
  const newer = copy(7, xml('A', lines(9)));
  assert.equal(choose([newer, mine], { source: dev({ uploadState: 'uploaded', uploadedFileId: mine.id }) }).decision, 'pick');
});

test('an untouched delivery sends the file it was given; another richer copy makes it a choice', () => {
  const delivered = copy(2, xml('A', lines(10)));
  const junk = copy(8, xml('A', lines(10)));             // a re-serialized backup of the same untouched text
  const r = choose([junk, delivered], { source: dev({ uploadState: 'local', asDelivered: true }), deliveredId: delivered.id });
  assert.equal(r.decision, 'send');
  assert.equal(r.file.id, delivered.id, 'the delivered file, not the newer equal one');
  assert.equal(r.path, 'delivered');
  const noHistory = choose([junk, delivered], { source: dev({ uploadState: 'local', asDelivered: true }) });
  assert.equal(noHistory.file.id, junk.id, 'without the history: the newest readable copy');
  // A copy delivered by a buggy older move (stale), with the real work also in Drive:
  const stale = copy(5, xml('A', lines(4)));
  const work = copy(4, xml('A', lines(25)));
  const asked = choose([stale, work], { source: dev({ uploadState: 'local', awaitingTranscript: true }), deliveredId: stale.id });
  assert.equal(asked.decision, 'pick', 'no device work to trust, and a copy holds more — so ask');
});

test('adopt: newest readable copy, unless another holds more; never a damaged one', () => {
  const a = copy(5, xml('A', lines(6))), b = copy(3, xml('A', lines(2)));
  assert.equal(choose([a, b], { adopt: true }).file.id, a.id);
  const nul = copy(9, '\u0000\u0000');
  assert.equal(choose([nul, a, b], { adopt: true }).file.id, a.id, 'the damaged newest is skipped');
  const rich = copy(1, xml('A', lines(30)));
  assert.equal(choose([a, b, rich], { adopt: true }).decision, 'pick', 'the release-then-adopt case: the newest is not the richest');
  assert.equal(choose([nul], { adopt: true }).decision, 'damaged', 'nothing usable at all');
  const none = choose([], { adopt: true });
  assert.equal(none.decision, 'send');
  assert.equal(none.file, null, 'no copy at all: the recording moves alone, as before');
});

test('a legacy zip upload is sent as the device\'s copy, flagged "could not be checked" — never called damaged', () => {
  const zip = copy(4, '', { name: 'Cerita 2026-08-01.zip' });
  const r = choose([zip], { source: dev({ uploadState: 'uploaded', uploadedFileId: zip.id }) });
  assert.equal(r.decision, 'send');
  assert.equal(r.note, 'unchecked');
});

test('deviceItems: live installs only, the most recently seen first', () => {
  const lastData = { instances: [{ instance_id: 'i1', installs: [
    { install_id: 'old', last_seen_at: 100, inventory: { items: [{ id: 'doc1', uploadState: 'changed' }] } },
    { install_id: 'wiped', last_seen_at: 999, wipe_state: 'confirmed', inventory: { items: [{ id: 'doc1', uploadState: 'uploaded' }] } },
    { install_id: 'pend', last_seen_at: 998, status: 'pending' },
    { install_id: 'new', last_seen_at: 500, inventory: { items: [{ id: 'doc1', uploadState: 'uploaded' }] } },
  ] }] };
  const deviceItems = new Function('lastData', `${devSrc}\nreturn deviceItems;`)(lastData);
  const r = deviceItems('i1', 'doc1');
  assert.deepEqual(r.map((x) => x.seenAt), [500, 100], 'the wiped and the pending install say nothing');
  const holds = new Function(`${holdsSrc}\nreturn instanceHoldsDoc;`)();
  assert.equal(holds(lastData.instances[0], 'doc1'), true);
  assert.equal(holds(lastData.instances[0], 'doc2'), false);
});

test('the modal: a send names what goes; a refusal offers asking AND the Drive copy; nothing preselected', () => {
  const make = (choice, ctx = {}) => {
    const nodes = {};
    const box = {
      set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
      querySelector(sel) { return nodes[sel] || null; },
    };
    const paint = new Function('t', 'esc', 'histWhen', 'lastSeen', 'busy', 'moveCopyRows',
      `${paintSrc}\nreturn paintCopyChoice;`)((k, v) => (v ? `${k}${JSON.stringify(v)}` : k), (s) => String(s), () => 'WHEN', () => 'AGO',
      (b, fn) => fn(), lib.moveCopyRows);
    const ui = paint(box, { stats: new Map(), candidates: [], source: null, ...choice }, { device: 'Dev', files: [], ...ctx });
    return { box, ui, nodes };
  };
  const f = copy(4, xml('A', lines(3)));
  const st = statsOf([f]);
  const sent = make({ decision: 'send', file: f, path: 'device', stats: st, source: dev({ uploadedFileId: f.id }) });
  assert.match(sent.box.innerHTML, /panel\.move\.willSend/);
  assert.match(sent.box.innerHTML, /panel\.move\.fromDevice\{"device":"Dev","ago":"AGO"\}/, 'and the AGE of the report it trusts');
  assert.deepEqual(sent.ui.pickFile(), { ok: true, file: f });

  const blocked = make({ decision: 'needsUpload', flavor: 'local', candidates: [f], stats: st, source: dev({ uploadState: 'local' }) }, { onAsk: () => {} });
  assert.match(blocked.box.innerHTML, /panel\.move\.neverSent/, '"never sent" has its own words, not "has changes"');
  assert.match(blocked.box.innerHTML, /data-copy="ask"/);
  assert.match(blocked.box.innerHTML, /data-copy="drive"/);
  assert.match(blocked.box.innerHTML, /panel\.move\.useDriveWarn/);
  assert.ok(!/checked/.test(blocked.box.innerHTML), 'no radio is pre-checked');
  assert.equal(blocked.ui.pickFile().ok, false, 'until the Drive copy is deliberately chosen, a device gets nothing');

  for (const decision of ['wait', 'lastCopyMissing', 'damaged']) {
    const m = make({ decision, candidates: [f], stats: st, source: dev({}) }, { onAsk: () => {} });
    assert.match(m.box.innerHTML, /data-copy="drive"/, `${decision} offers the Drive copy too — a stuck or lost device must not block a move`);
  }
  assert.ok(!/data-copy="ask"/.test(make({ decision: 'wait', candidates: [f], stats: st, source: dev({}) }, { onAsk: () => {} }).box.innerHTML),
    'nothing to ask a device that is already sending');
});

test('after a finished move, newer work the source sent on its way out is flagged — once, durably', async () => {
  const toasts = [], events = [];
  const run = (files, destIds = []) => new Function('Researcher', 'deviceFileIds', 'isFlextextName', 'hasRole', 'PROTECTED_ROLES',
    'instanceNick', 'deps', 't', 'histWhen', 'recordEvents', `${flagSrc}\nreturn flagNewerAfterMove;`)(
    { listTextFiles: async () => ({ files }), currentAccountId: () => 'acct' }, () => new Set(destIds),
    (f) => /\.flextext$/.test(f.name), () => false, [], (id) => id, { toast: (m) => toasts.push(m) }, (k) => k, () => 'W',
    (_a, ev) => events.push(...ev));
  const at = Date.parse('2026-09-10T00:00:00Z');
  const mv = { from: 'src', to: 'dst', title: 'Cerita', at, sentFileId: 'sent', sentModified: '2026-09-05T00:00:00Z' };
  const sent = { id: 'sent', name: 'a.flextext', modified: '2026-09-05T00:00:00Z', sha256: 'S' };
  await run([sent, { id: 'old', name: 'b.flextext', modified: '2026-09-01T00:00:00Z' }])('doc1', mv);
  assert.equal(toasts.length, 0, 'nothing newer than the move');
  await run([sent, { id: 'same', name: 'c.flextext', modified: '2026-09-11T00:00:00Z', sha256: 'S' }])('doc1', mv);
  assert.equal(toasts.length, 0, 'a byte-identical re-upload is not newer work');
  await run([sent, { id: 'dst-own', name: 'd.flextext', modified: '2026-09-12T00:00:00Z', sha256: 'D' }], ['dst-own'])('doc1', mv);
  assert.equal(toasts.length, 0, 'the destination\'s own backup is not the source\'s work');
  await run([sent, { id: 'final', name: 'e.flextext', modified: '2026-09-11T00:00:00Z', sha256: 'F' }])('doc1', mv);
  assert.equal(toasts.length, 1);
  assert.equal(events[0].kind, 'submitted');
  assert.equal(events[0].fileId, 'final');
  assert.equal(events[0].afterMove, true, 'a History row the researcher can come back to');
});

test('the commits send exactly the chosen copy, and record what they sent', () => {
  const mvAt = panel.indexOf('async function moveTextModal');
  const mv = panel.slice(mvAt, panel.indexOf('\n}\n', panel.indexOf('  });', mvAt)) + 3);
  assert.ok(mv.indexOf('await moveSources(') < mv.indexOf('const m = modal('), 'the gate still runs before the picker');
  assert.match(mv, /resolveMoveCopy\(\{ fromId, docId, src, adopt: false/);
  assert.match(mv, /flextextFileId: isZip \? null : idOf\(sendFile\), extractFromZipId: isZip \? idOf\(sendFile\) : null,/,
    'exactly one of the two ids — no silent fallback from a .flextext to an older zip');
  assert.match(mv, /fileId: idOf\(sendFile\) \|\| ''/, 'the assigned event records the file');
  assert.match(mv, /sentFileId: idOf\(sendFile\) \|\| '', sentModified:/, 'so does the move record');
  assert.ok(mv.indexOf('copyPick') < mv.indexOf('confirmCrossProject(to'), 'a device without a sendable copy is refused before any confirm');
  const adAt = panel.indexOf('async function adoptTextModal');
  const ad = panel.slice(adAt, panel.indexOf('\n}\n', panel.indexOf('  }));', adAt)) + 3);
  assert.match(ad, /resolveMoveCopy\(\{ fromId: null, docId, src, adopt: true/);
  assert.ok(!/Researcher\.listTextFiles\(to, docId\)/.test(ad), 'adopt no longer re-lists and takes the newest');
  assert.match(ad, /fileId: \(sendFile && sendFile\.id\) \|\| ''/);
  assert.equal(assignedEvent({ docId: 'd', fileId: 'F9' }).fileId, 'F9', 'history keeps the delivered file id (F3)');
  assert.equal('fileId' in assignedEvent({ docId: 'd' }), false, 'and adds nothing when there was none');
  assert.match(panel, /flagNewerAfterMove\(docId, \{ \.\.\.mv \}\);/, 'the sweep checks for newer work when a move finishes');
  assert.match(panel, /pendingCmds\.set\(docId, \{ seq: r1\.seq, kind: 'upload', instanceId: fromId, prevFileId:/,
    '"Ask to send" is the row\'s own upload request, retired by the same outcome sweep');
});

test('every new G1/G4-panel string is in English AND Indonesian', () => {
  const keys = [...new Set([...panel.matchAll(/t\('(panel\.(?:move|up|hist)\.[A-Za-z]+)'/g)].map((m) => m[1]))]
    .filter((k) => /willSend|fromDevice|fromDelivered|fromBest|olderRicher|notOnDrive|neverSent|sendingNow|lastCopy|allDamaged|noReport|askSen|useDrive|noDriveCopy|pickCopy|pickFirst|stillChecking|copyRow|copyDevice|copyDelivered|copyNewest|copyUnnamed|whenUnknown|holdsCopy|newerAfter|afterMove|checking/.test(k));
  assert.ok(keys.length >= 25, `found the keys (${keys.length})`);
  for (const k of keys.concat(['panel.up.asDelivered', 'panel.up.awaitingTranscript'])) {
    const n = (i18n.match(new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'gm')) || []).length;
    assert.equal(n, 2, `${k} is in both languages`);
  }
  assert.match(panel, /'asDelivered', 'awaitingTranscript'\]\.includes\(disp\)/, 'the two chips are in the fixed allow-list');
});
