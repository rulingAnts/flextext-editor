/* THE GAPS THE REVIEW FOUND IN "WHICH COPY A MOVE SENDS" (plans/move-upload-guards.md §12).
 *
 * WHY THIS TEST EXISTS: the first build of G1 decided from what it could READ, and was silent about
 * what it could not. The review showed each of these still delivering the wrong copy, or none:
 *   - a copy the check skipped (over the size or count cap, or inside a legacy zip) was invisible, so
 *     an adopt sent an empty placeholder over a 9 MB analysed transcription without asking;
 *   - a copy a device cannot OPEN (a control character the file cannot carry, or one the panel could
 *     not parse at all) was counted fine, or sent "unchecked", and the destination got an empty text;
 *   - a device switched to the basic editor uploads copies without timings, and a move sent that copy
 *     silently while an older one held 32 timed lines;
 *   - a device copy found by its id (not in the folder listing) was missing from the list to pick from;
 *   - "the copy {device} received, unchanged there" was printed when the copy was merely the newest.
 * And in the modal: the "Move the copy already in Drive instead" way out on a DAMAGED or MISSING device
 * copy let the release delete the device's only good copy (the device believes it is backed up), while
 * its warning promised the opposite. Those choices now HOLD the release until the device has sent its
 * own copy again.
 *
 * The real chooseMoveCopy and paintCopyChoice are LIFTED out of researcher-panel.js.
 *
 * Run: node --test test/move-copy-gaps.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
installMiniXmlDom();
const { flextextStats, serializeFlextext, makeDoc, reconcileBaseline } = await import('../docs/js/flextext.js');

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');
const grab = (re, what) => { const m = panel.match(re); assert.ok(m, `${what} is findable`); return m[0]; };
const roleSrc = grab(/const SOURCE_AUDIO_ROLES = [\s\S]*?const isFlextextName = [^;]*;/, 'the role sets');
const helpers = grab(/const STAT_ALL = [\s\S]*?\nfunction statsHaveContent\(s\) \{[\s\S]*?\n\}/, 'the stat helpers');
const rowsSrc = grab(/function moveCopyRows\(files\) \{[\s\S]*?\n\}/, 'moveCopyRows');
const verdictSrc = grab(/function deviceCopyVerdict\(d, file, entry\) \{[\s\S]*?\n\}/, 'deviceCopyVerdict');
const chooseSrc = grab(/function chooseMoveCopy\(\{ source, files, stats, deliveredId, adopt \}\) \{[\s\S]*?\n\}/, 'chooseMoveCopy');
const paintSrc = grab(/function paintCopyChoice\(box, choice, ctx\) \{[\s\S]*?\n\}/, 'paintCopyChoice');

const lib = new Function('MANIFEST_NAME', `${roleSrc}\n${helpers}\n${rowsSrc}\n${verdictSrc}\n${chooseSrc}\nreturn { chooseMoveCopy, moveCopyRows };`)('flextext-manifest.json');
const { chooseMoveCopy } = lib;

const SET = { vernLang: 'qaa', analLang: 'id' };
const xml = (guid, lines, { glossed = 0, times = null } = {}) => {
  const d = makeDoc(SET, 'Cerita');
  d.textAttrs.guid = guid;
  reconcileBaseline(d, lines.length ? lines : ['']);
  let g = glossed;
  for (const p of d.paragraphs) for (const s of p.segments) for (const w of s.words) if (g > 0 && !w.punct) { w.gls = 'x'; g--; }
  if (times) d.segments = times;
  return serializeFlextext(d, SET, times ? { segTimes: true, mediaName: 'a.wav' } : {});
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

test('A COPY THE CHECK SKIPPED IS NOT INVISIBLE: an empty newest copy is never sent over a copy nobody read', () => {
  const placeholder = copy(9, xml('G-NEW', []));
  const big = copy(3, xml('G-A', lines(25), { glossed: 60 }), { size: 9 * 1024 * 1024 });
  const capped = choose([placeholder, big], { adopt: true, stats: statsOf([placeholder], { [big.id]: { state: 'unchecked', why: 'cap' } }) });
  assert.equal(capped.decision, 'pick', 'adopt: the 9 MB transcription was over the cap — so ask, do not send the placeholder');
  assert.ok(capped.candidates.some((f) => f.id === big.id), 'and the unread copy is on the list');
  assert.equal(capped.note, 'unchecked');
  const zip = { id: 'z1', name: 'Cerita bundle.zip', modified: '2026-09-01T00:00:00Z', size: 50000, role: '' };
  assert.equal(choose([placeholder, zip], { adopt: true }).decision, 'pick', 'the same when the transcription is only inside a legacy zip');
  // A delivery the panel cannot trace (no history in this browser) is the same case.
  const delivered = choose([placeholder, big], { source: dev({ uploadState: 'local', asDelivered: true }),
    stats: statsOf([placeholder], { [big.id]: { state: 'unchecked', why: 'cap' } }) });
  assert.equal(delivered.decision, 'pick');
  // ...but a BIGGER unread copy beside a newest copy that does hold work is asked about too.
  const work = copy(8, xml('G-A', lines(6)));
  assert.equal(choose([work, big], { adopt: true, stats: statsOf([work], { [big.id]: { state: 'unchecked', why: 'cap' } }) }).decision, 'pick');
  // ...while a SMALLER unread copy, or a legacy zip beside real work, is not worth a question.
  const small = copy(2, xml('G-A', lines(1)));
  assert.equal(choose([work, small], { adopt: true, stats: statsOf([work], { [small.id]: { state: 'unchecked', why: 'cap' } }) }).decision, 'send');
  assert.equal(choose([work, zip], { adopt: true }).decision, 'send');
});

test('A COPY NO DEVICE CAN OPEN is never sent, and never offered', () => {
  const raw = xml('G-A', lines(25), { glossed: 30 }).replace('kata 4 lagi', 'kata 4\u000Blagi');   // an older engine's file
  const vt = copy(9, raw), older = copy(2, xml('G-A', lines(4)));
  const adopt = choose([vt, older], { adopt: true });
  assert.ok(!(adopt.file && adopt.file.id === vt.id), 'adopt does not send the copy the destination cannot open');
  assert.ok(!adopt.candidates.some((f) => f.id === vt.id), 'nor offer it');
  const mine = choose([vt, older], { source: dev({ uploadState: 'uploaded', uploadedFileId: vt.id }) });
  assert.equal(mine.decision, 'damaged', 'the device path refuses (and offers asking the device to send again)');
  assert.equal(mine.flavor, 'unopenable', 'with its own words: it is whole, but cannot be opened on a device');
  const dev2 = copy(9, 'x'), old2 = copy(2, xml('G', lines(3)));
  const unread = choose([dev2, old2], { source: dev({ uploadState: 'uploaded', uploadedFileId: dev2.id }),
    stats: statsOf([old2], { [dev2.id]: { state: 'unreadable', stats: { ok: false, reason: 'parse', damaged: false } } }) });
  assert.equal(unread.decision, 'damaged', 'a device copy the panel could not parse is not sent "unchecked" any more');
  assert.equal(unread.flavor, 'unopenable');
  assert.ok(!unread.candidates.some((f) => f.id === dev2.id));
  const partial = copy(9, xml('G-A', lines(9)).slice(0, -30)), ok3 = copy(2, xml('G-A', lines(3)));
  const p = choose([partial, ok3], { source: dev({ uploadState: 'uploaded', uploadedFileId: partial.id }) });
  assert.equal(p.decision, 'damaged');
  assert.equal(p.flavor, 'damaged', 'a cut-off copy is damaged, said as such');
  assert.equal(choose([vt], { adopt: true }).decision, 'damaged', 'no copy a device can open at all');
  const flaky = copy(9, xml('G-A', lines(5)));
  const f = choose([flaky, older], { source: dev({ uploadState: 'uploaded', uploadedFileId: flaky.id }),
    stats: statsOf([older], { [flaky.id]: { state: 'unchecked', why: 'fetch' } }) });
  assert.equal(f.decision, 'lastCopyMissing', 'the device\'s own copy could not be fetched: not sent blind (its release would delete without a new upload)');
});

test('TIMINGS: a copy without them is not sent silently over one with them', () => {
  const t32 = Array.from({ length: 32 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 900 }));
  const timed = copy(3, xml('G-A', lines(32), { times: t32 }));
  const untimed = copy(9, xml('G-A', [...lines(31), 'kata 32 lagi juga']));
  assert.equal(flextextStats(timed.body).timed, 32);
  const r = choose([untimed, timed], { source: dev({ uploadState: 'uploaded', uploadedFileId: untimed.id }) });
  assert.equal(r.decision, 'pick', 'the device was switched to the basic editor: its copies carry no timings');
  assert.equal(r.note, 'timings');
  assert.equal(r.timedHad, 32, 'and the modal can say how many');
  const adopt = choose([untimed, timed], { adopt: true });
  assert.equal(adopt.decision, 'pick', 'the same with no device to trust');
  // A whole-file seed span (one) is not a timing anybody made.
  const one = copy(4, xml('G-A', lines(1), { times: [{ start: 0, end: 5000 }] }));
  const plain = copy(8, xml('G-A', lines(1)));
  assert.equal(choose([plain, one], { source: dev({ uploadState: 'uploaded', uploadedFileId: plain.id }) }).decision, 'send');
});

test('a device copy found by its id is ON the list to pick from', () => {
  const dx = xml('G-D', lines(20));
  const listedOther = copy(5, xml('G-OTHER', lines(30)));
  const stats = statsOf([listedOther], { DX: { state: 'ok', stats: flextextStats(dx) } });
  const r = choose([listedOther], { source: dev({ uploadState: 'uploaded', uploadedFileId: 'DX' }), stats });
  assert.equal(r.decision, 'pick');
  assert.ok(r.candidates.some((f) => f.id === 'DX'), 'the device\'s own copy is a choice');
});

test('"the copy {device} received" is said only when that is the copy going', () => {
  const delivered = copy(2, xml('A', lines(10)));
  const junk = copy(8, xml('A', lines(10)));
  const known = choose([junk, delivered], { source: dev({ uploadState: 'local', asDelivered: true }), deliveredId: delivered.id });
  assert.equal(known.deliveredUsed, true);
  const unknown = choose([junk, delivered], { source: dev({ uploadState: 'local', asDelivered: true }) });
  assert.equal(unknown.deliveredUsed, false, 'without the history, the newest readable copy is NOT "the copy it received"');
});

/* ── the modal ── */
const paintLib = (choice, ctx = {}) => {
  const nodes = {};
  let html = '';
  const box = {
    set innerHTML(v) { html = v; }, get innerHTML() { return html; },
    querySelector(sel) {
      if (sel === '[data-copy="drive"]' || sel === '[data-copy="other"]') return /data-copy="(drive|other)"/.test(html) ? (nodes[sel] ||= { hidden: false, onclick: null }) : null;
      if (sel === '[data-copy="ask"]') return /data-copy="ask"/.test(html) ? (nodes.ask ||= { onclick: null }) : null;
      if (sel === '.rp-move-hatch') return nodes.hatch ||= { hidden: true };
      if (sel.startsWith('input[name="rp-move-copy"]')) return nodes.pick ? { value: nodes.pick } : null;
      return null;
    },
  };
  const paint = new Function('t', 'esc', 'histWhen', 'lastSeen', 'busy', 'moveCopyRows', 'fmtSize',
    `${paintSrc}\nreturn paintCopyChoice;`)((k, v) => (v ? `${k}${JSON.stringify(v)}` : k), (s) => String(s), () => 'WHEN', () => 'AGO',
    (b, fn) => fn(), lib.moveCopyRows, (n) => `${n} B`);
  const ui = paint(box, { stats: new Map(), candidates: [], source: null, ...choice }, { device: 'Dev', files: [], ...ctx });
  return { box, ui, nodes, open: (k) => { const b = nodes[k]; b.onclick(); } };
};

test('THE WAY OUT ON A DAMAGED OR MISSING DEVICE COPY HOLDS THE RELEASE — and says so', () => {
  const f = copy(4, xml('A', lines(3)));
  const st = statsOf([f]);
  for (const decision of ['damaged', 'lastCopyMissing']) {
    const m = paintLib({ decision, file: decision === 'damaged' ? { id: 'nul' } : null, candidates: [f], stats: st,
      source: dev({ uploadState: 'uploaded', uploadedFileId: 'nul' }) }, { onAsk: () => {} });
    assert.match(m.box.innerHTML, /panel\.move\.useDriveWarnResend/, `${decision}: the warning says the device sends its own copy FIRST`);
    assert.ok(!/panel\.move\.useDriveWarn\{/.test(m.box.innerHTML), 'not the "it sends them and removes it" sentence, which was false here');
    m.open('[data-copy="drive"]');
    m.nodes.pick = f.id;
    assert.deepEqual(m.ui.pickFile(), { ok: true, file: f, hold: 'resend' }, 'the commit is told to hold the release');
  }
  const w = paintLib({ decision: 'wait', candidates: [f], stats: st, source: dev({ uploadState: 'uploading' }) });
  assert.match(w.box.innerHTML, /panel\.move\.useDriveWarnWait/);
  w.open('[data-copy="drive"]'); w.nodes.pick = f.id;
  assert.equal(w.ui.pickFile().hold, 'wait', 'a device sending now keeps its text until that copy lands');
  const n = paintLib({ decision: 'needsUpload', flavor: 'changed', candidates: [f], stats: st, source: dev({ uploadState: 'changed' }) });
  assert.match(n.box.innerHTML, /panel\.move\.useDriveWarn\{/, 'unsent changes: the device uploads them on release, as the warning says');
  n.open('[data-copy="drive"]'); n.nodes.pick = f.id;
  assert.equal(n.ui.pickFile().hold, undefined, 'and needs no hold — uploadDelete uploads first there');
});

test('a device copy that cannot be opened has its own sentence; a send can still be changed', () => {
  const f = copy(4, xml('A', lines(3))), g = copy(2, xml('A', lines(2)));
  const st = statsOf([f, g]);
  const u = paintLib({ decision: 'damaged', flavor: 'unopenable', file: { id: 'x' }, candidates: [f], stats: st,
    source: dev({ uploadState: 'uploaded', uploadedFileId: 'x' }) }, { onAsk: () => {} });
  assert.match(u.box.innerHTML, /panel\.move\.lastCopyUnopenable/);
  const s = paintLib({ decision: 'send', file: f, path: 'adopt', candidates: [f, g], stats: st });
  assert.match(s.box.innerHTML, /data-copy="other"/, 'a send offers "choose a different copy" — a researcher who sees "words: 0" can act');
  assert.deepEqual(s.ui.pickFile(), { ok: true, file: f }, 'until it is opened, the chosen copy goes');
  s.open('[data-copy="other"]');
  assert.equal(s.ui.pickFile().ok, false, 'opened: a copy must be picked');
  s.nodes.pick = g.id;
  assert.deepEqual(s.ui.pickFile(), { ok: true, file: g });
  const d = paintLib({ decision: 'send', file: f, path: 'delivered', deliveredUsed: false, candidates: [f], stats: st, source: dev({}) });
  assert.match(d.box.innerHTML, /panel\.move\.fromBest/, 'not "the copy it received" unless it is');
  const d2 = paintLib({ decision: 'send', file: f, path: 'delivered', deliveredUsed: true, candidates: [f], stats: st, source: dev({}) });
  assert.match(d2.box.innerHTML, /panel\.move\.fromDelivered/);
  const pk = paintLib({ decision: 'pick', note: 'timings', timedHad: 32, candidates: [f, g], stats: st });
  assert.match(pk.box.innerHTML, /panel\.move\.pickTimings\{"n":32/, 'a pick says WHY it asks');
  const pu = paintLib({ decision: 'pick', note: 'unchecked', candidates: [f, g], stats: st });
  assert.match(pu.box.innerHTML, /panel\.move\.pickUnchecked/);
});

test('every new string is in English AND Indonesian', () => {
  for (const k of ['panel.move.useDriveWarnResend', 'panel.move.useDriveWarnWait', 'panel.move.lastCopyUnopenable',
    'panel.move.otherCopy', 'panel.move.otherCopyWarn', 'panel.move.pickTimings', 'panel.move.pickUnchecked']) {
    assert.equal((i18n.match(new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'gm')) || []).length, 2, `${k} in both languages`);
  }
});
