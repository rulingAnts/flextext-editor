/* EVERY TIMED PHRASE THE SUITE WRITES CAN BE IMPORTED BY FLEx WITH ITS TIMES.
 *
 * FieldWorks' interlinear importer (BIRDInterlinearImporter.cs) copies a phrase's
 * begin/end-time-offset onto its Segment ONLY when the phrase also carries a non-empty media-file,
 * and resolves that value with GetObject(new Guid(media-file)) against the <media guid> entries of
 * the same text's <media-files> — of which FLEx holds ONE per text (Text.MediaFilesOA; the
 * FlexInterlinear.cs model reads a single `mediafiles` member). The suite's own exports of texts with
 * an attached recording carried a media-files block and NO media-file anywhere, so FLEx imported
 * every one of them with its times thrown away: 151 timed phrases in one text, 29 and 18 in two
 * more, zero kept, no message. The visible "audio 0:01.234–0:05.678" notes arrived, so the files
 * LOOKED right.
 *
 * `flexImport` below is that condition restated independently of the module — parsed with the test
 * DOM, not with the regexes linkPhraseMedia uses — and every writer is held to it on real-shaped
 * timing skeletons (test/lib/timing-skeletons.mjs: two of those exports, sanitized to structure and
 * times). Cases, as the fix names them:
 *   (a) no block + a known recording  → one minted, named for it;
 *   (b) a block already there         → link to its entry for this recording, never a second block,
 *                                       never a dropped or rewritten entry;
 *   (c) no block, no recording name   → minted anyway (the times are the data; the location is a
 *                                       label FLEx never opens) — 'audio', or the caller's better name;
 *   (d) a media-file that resolves    → kept.
 *
 * Run: node --test test/flex-media-link.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installMiniXmlDom } from './lib/mini-xml-dom.mjs';
import { skeletonXml, skeletonNames, timedRows, SKELETON_MEDIA_GUID } from './lib/timing-skeletons.mjs';
installMiniXmlDom();
const { parseFlextext, serializeFlextext, segmentsFromOffsets, linkPhraseMedia, makeDoc, reconcileBaseline } =
  await import('../docs/js/flextext.js');
const { linkFlextextBlob, buildLooseConversion } = await import('../docs/js/seg-exports.js');
const { lametaFlextextMedia } = await import('../docs/js/lameta.js');

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const APP = src('../docs/js/app.js');
const PANEL = src('../docs/js/researcher-panel.js');
const SFM = src('../docs/js/sfm-convert.js');

/* ── FLEx's condition, as an oracle ─────────────────────────────────────────────────────────────── */
const kids = (el, name) => el.children.filter((c) => c.tagName === name);
function flexImport(xml) {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const err = dom.querySelector('parsererror');
  if (err) throw new Error('not well-formed XML: ' + err.textContent);
  return kids(dom.documentElement, 'interlinear-text').map((it) => {
    const blocks = kids(it, 'media-files');
    const media = blocks.length ? kids(blocks[0], 'media') : [];
    const guids = new Set(media.map((m) => String(m.getAttribute('guid')).toLowerCase()));
    const phrases = kids(it, 'paragraphs').flatMap((ps) => kids(ps, 'paragraph'))
      .flatMap((p) => kids(p, 'phrases')).flatMap((ps) => kids(ps, 'phrase'));
    const r = { blocks: blocks.length, media: media.map((m) => ({ guid: m.getAttribute('guid'), location: m.getAttribute('location') })),
      timed: 0, kept: 0, dropped: 0, unresolved: [], times: [] };
    for (const ph of phrases) {
      const b = ph.getAttribute('begin-time-offset'); const e = ph.getAttribute('end-time-offset');
      const mf = ph.getAttribute('media-file');
      const timed = b != null || e != null;
      if (timed) r.timed++;
      if (mf) {                                                     // !String.IsNullOrEmpty(phrase.mediaFile)
        if (!guids.has(mf.toLowerCase())) r.unresolved.push(mf);   // GetObject has nothing to return
        else if (timed) { r.kept++; r.times.push({ begin: +b, end: +e }); }
      } else if (timed) r.dropped++;                                // the silent loss
    }
    return r;
  });
}
const stripLinks = (xml) => xml.replace(/ media-file="[^"]*"/g, '');
const settings = { vernLang: 'fau', analLang: 'id' };

/* ── the bug, recorded ──────────────────────────────────────────────────────────────────────────── */
test('the old exports: a media-files block, every phrase timed, and FLEx keeps none of the times', () => {
  for (const name of skeletonNames()) {
    const [t] = flexImport(skeletonXml(name));
    assert.equal(t.blocks, 1, `${name}: the block ensureMediaRef put on the doc is there`);
    assert.equal(t.timed, timedRows(name).length);
    assert.equal(t.kept, 0, `${name}: not one time survives the import`);
    assert.equal(t.dropped, t.timed);
  }
});

/* ── the pass-through writers: bytes someone else wrote, linked on the way out ───────────────────── */
test('linking an old export: every time kept, the block and its entry untouched, nothing else changed', () => {
  for (const name of skeletonNames()) {
    const before = skeletonXml(name);
    const after = linkPhraseMedia(before, { mediaName: 'Some title.wav' });
    const [t] = flexImport(after);
    assert.equal(t.kept, timedRows(name).length, `${name}: every timed phrase keeps its times`);
    assert.deepEqual(t.times, timedRows(name), `${name}: and they are the same times`);
    assert.deepEqual(t.unresolved, []);
    assert.equal(t.blocks, 1, 'still ONE block — never a second');
    assert.deepEqual(t.media, [{ guid: SKELETON_MEDIA_GUID, location: 'recording.wav' }],
      '(b) the existing entry is the one linked to — not renamed, not re-guided, nothing added');
    assert.equal(stripLinks(after), before, 'the media-file attributes are the ONLY change');
    assert.equal(linkPhraseMedia(after, { mediaName: 'Other.wav' }), after, 'and a second pass changes nothing');
  }
});

test('a file FLEx can already read comes back byte for byte (the ELAN-written shape)', () => {
  const linked = linkPhraseMedia(skeletonXml('lines18'));
  assert.equal(linkPhraseMedia(linked), linked);
  const untimed = '<document version="2"><interlinear-text guid="t"><paragraphs><paragraph guid="p"><phrases>'
    + '<phrase guid="a"><item type="txt" lang="x">w</item></phrase></phrases></paragraph></paragraphs>'
    + '<media-files offset-type=""><media guid="m" location="a.wav"/></media-files></interlinear-text></document>';
  assert.equal(linkPhraseMedia(untimed, { mediaName: 'b.wav' }), untimed, 'no times, no links: nothing to do');
});

test('linkFlextextBlob: the same Blob when nothing is needed; a linked one when it is; undecodable bytes pass', async () => {
  const done = new Blob([linkPhraseMedia(skeletonXml('lines29'))], { type: 'application/xml' });
  assert.equal(await linkFlextextBlob(done, 'x.wav'), done, 'the very object, so the download is byte-identical');
  const old = new Blob([skeletonXml('lines29')], { type: 'application/xml' });
  const fixed = await linkFlextextBlob(old, 'x.wav');
  assert.notEqual(fixed, old);
  assert.equal(flexImport(await fixed.text())[0].kept, 29);
  const junk = new Blob([new Uint8Array([0x3c, 0xff, 0xfe, 0x3e])]);
  assert.equal(await linkFlextextBlob(junk, 'x.wav'), junk, 'not UTF-8: handed over untouched, never re-encoded');
});

test('the Utilities converter\'s .flextext row: the picked file, linked to the picked recording', async () => {
  const blob = new Blob([skeletonXml('lines18').replace(/\s*<media-files[\s\S]*?<\/media-files>/, '')], { type: 'application/xml' });
  const r = await buildLooseConversion({ kind: 'flextext', base: 'Story', flextextBlob: blob,
    audio: { name: 'my recording.wav', blob: new Blob([new Uint8Array(4)]) } });
  const [t] = flexImport(await r.entries[0].data.text());
  assert.equal(t.kept, 18);
  assert.deepEqual(t.media.map((m) => m.location), ['my recording.wav'], '(a) minted, named for the file they picked');
  const bare = await buildLooseConversion({ kind: 'flextext', base: 'Story', flextextBlob: blob });
  assert.deepEqual(flexImport(await bare.entries[0].data.text())[0].media.map((m) => m.location), ['Story'],
    '(c) no recording picked: the title, no extension — the suite\'s name for a file it knows nothing about');
});

test('the lameta package: location repointed AND every timed phrase linked to it', () => {
  const out = lametaFlextextMedia(skeletonXml('lines29'), 'Session_A.wav');
  const [t] = flexImport(out);
  assert.equal(t.kept, 29);
  assert.deepEqual(t.media, [{ guid: SKELETON_MEDIA_GUID, location: 'Session_A.wav' }]);
  assert.equal(lametaFlextextMedia(skeletonXml('lines29'), ''), skeletonXml('lines29'), 'no recording in the package: as it was');
});

/* ── the serializer: every app export, upload, Segmenter Done/Download, SFM conversion ───────────── */
test('open an old export, export it again: FLEx keeps every time, linked to the IMPORTED entry', () => {
  for (const name of skeletonNames()) {
    for (const segTimes of [true, false]) {   // segmentation mode, and the basic editor (imported attrs ride verbatim)
      const doc = parseFlextext(skeletonXml(name), settings).texts[0];
      doc.segments = segmentsFromOffsets(doc);           // what opening the text does
      const xml = serializeFlextext(doc, settings, { mediaName: 'Timing skeleton.wav', segTimes, producedBy: 'test' });
      const [t] = flexImport(xml);
      assert.equal(t.kept, timedRows(name).length, `${name} segTimes:${segTimes}: every time kept`);
      assert.deepEqual(t.times, timedRows(name));
      assert.equal(t.blocks, 1, 'one block');
      assert.deepEqual(t.media.map((m) => m.guid), [SKELETON_MEDIA_GUID], '(b) the imported entry, not a minted one');
      assert.equal(t.media[0].location, 'recording.wav', 'its location as imported');
    }
  }
});

/* ensureMediaRef (app.js) is what puts a block on every text recorded, attached or delivered in the
 * app — the shape that hid this. Replicated, and pinned to the source so the replica cannot drift. */
const ensureMediaRefBlock = (guid, location) =>
  `<media-files offset-type="milliseconds">\n  <media guid="${guid}" location="${location}" />\n</media-files>`;
test('the app\'s own block (ensureMediaRef) is linked to, never doubled', () => {
  assert.match(APP, /`<media-files offset-type="milliseconds">\\n  <media guid="\$\{esc\(rec\.mediaGuid\)\}" location="\$\{esc\(location\)\}" \/>\\n<\/media-files>`/,
    'the replica above is still what ensureMediaRef writes');
  const doc = makeDoc(settings, 'T');
  reconcileBaseline(doc, ['w w', '', 'w'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 900 }, { start: 900, end: 1500 }, { start: 1500, end: 2600, timeEstimated: true }];
  doc.mediaXML = [ensureMediaRefBlock('aaaaaaaa-0000-4000-8000-000000000001', 'phone recording 0042.wav')];
  const [t] = flexImport(serializeFlextext(doc, settings, { mediaName: 'T.wav' }));
  assert.equal(t.kept, 3, 'blank (silent) lines included — they are timed spans too');
  assert.equal(t.blocks, 1);
  assert.deepEqual(t.media, [{ guid: 'aaaaaaaa-0000-4000-8000-000000000001', location: 'phone recording 0042.wav' }]);
});

test('(a) no block, a known recording: one entry minted, named for it, and the SAME guid every export', () => {
  const doc = makeDoc(settings, 'T');
  reconcileBaseline(doc, ['w', 'w w'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 1000 }, { start: 1000, end: 2500 }];
  const one = serializeFlextext(doc, settings, { mediaName: 'T.wav' });
  const [t] = flexImport(one);
  assert.equal(t.kept, 2);
  assert.equal(t.media.length, 1);
  assert.equal(t.media[0].location, 'T.wav');
  assert.equal(t.media[0].guid, doc.mediaGuid, 'kept on the doc');
  assert.equal(flexImport(serializeFlextext(doc, settings, { mediaName: 'T.wav' }))[0].media[0].guid, doc.mediaGuid,
    'a re-export names the same entry, so a FLEx re-import merges instead of adding one per export');
  assert.match(one, /\n    <\/languages>\n    <media-files offset-type="">\n      <media guid="[^"]+" location="T\.wav"\/>\n    <\/media-files>\n  <\/interlinear-text>\n/,
    'laid out exactly as the serializer always wrote its own block');
});

test('(c) times and no recording name anywhere: still linked — to \'audio\', or the name the caller gives', () => {
  const doc = makeDoc(settings, 'T');
  reconcileBaseline(doc, ['w', 'w'], { flatSegments: true });
  doc.segments = [{ start: 0, end: 700 }, { start: 700, end: 1400 }];
  const [t] = flexImport(serializeFlextext(doc, settings, {}));
  assert.equal(t.kept, 2, 'the times reach FLEx');
  assert.deepEqual(t.media.map((m) => m.location), ['audio']);
  // Pending spans: no times, so nothing to link and no block at all.
  const d2 = makeDoc(settings, 'T');
  reconcileBaseline(d2, ['w'], { flatSegments: true });
  d2.segments = [{ timePending: true }];
  assert.doesNotMatch(serializeFlextext(d2, settings, { mediaName: 'T.wav' }), /media-file|<media-files/);
});

test('the SFM converter names the entry after the text (ELAN\'s Toolbox export never says which recording)', () => {
  assert.match(SFM, /mediaName: safeName\(tx\.title \|\| fallback, 'audio'\)/);
});

/* ── (b) and (d) in detail ──────────────────────────────────────────────────────────────────────── */
const text = (phrases, mediaFiles = '') => `<document version="2"><interlinear-text guid="t"><paragraphs>${
  phrases.map((p, i) => `<paragraph guid="p${i}"><phrases><phrase guid="ph${i}"${p}><item type="txt" lang="x">w</item></phrase></phrases></paragraph>`).join('')
}</paragraphs>${mediaFiles}</interlinear-text></document>`;
const T = (b, e) => ` begin-time-offset="${b}" end-time-offset="${e}"`;
const mfOf = (xml) => [...xml.matchAll(/<phrase\b[^>]*>/g)].map((m) => (/media-file="([^"]*)"/.exec(m[0]) || [])[1] ?? null);
const TWO = '<media-files offset-type=""><media guid="m1" location="file:///C:/Rec/first.wav"/>'
  + '<media guid="m2" location="C:\\Rec\\Story%20B.WAV"/></media-files>';

test('(b) which entry: the file name, then the name without extension, then the usual one, then the first', () => {
  assert.deepEqual(mfOf(linkPhraseMedia(text([T(0, 1)], TWO), { mediaName: 'story%20b.wav' })), ['m2'], 'file name, any path, any case');
  assert.deepEqual(mfOf(linkPhraseMedia(text([T(0, 1)], TWO), { mediaName: 'first.mp3' })), ['m1'], 'stem, when the extension differs');
  assert.deepEqual(mfOf(linkPhraseMedia(text([T(0, 1), T(1, 2) + ' media-file="m2"'], TWO), { mediaName: 'x.wav' })),
    ['m2', 'm2'], 'the entry the text\'s other phrases already use');
  assert.deepEqual(mfOf(linkPhraseMedia(text([T(0, 1)], TWO), { mediaName: 'x.wav' })), ['m1'], 'else the first');
  const relay = '<media-files offset-type="milliseconds"><media guid="m9" location="https://example.invalid/drive?src=abc&amp;t=def"/></media-files>';
  assert.deepEqual(mfOf(linkPhraseMedia(text([T(0, 1)], relay), { mediaName: 'drive' })), ['m9'],
    'a relay URL names no file and matches nothing — the only entry is still the one');
});

test('(d) a link that resolves is kept; one that does not is relinked; a respelled one is spelled like its entry', () => {
  const out = linkPhraseMedia(text([T(0, 1) + ' media-file="m2"', T(1, 2) + ' media-file="gone"', T(2, 3) + ' media-file="M1"'], TWO),
    { mediaName: 'first.wav' });
  assert.deepEqual(mfOf(out), ['m2', 'm1', 'm1']);
  const [t] = flexImport(out);
  assert.equal(t.kept, 3);
  assert.deepEqual(t.unresolved, []);
  // A link to nothing on an UNTIMED phrase is still a lookup FLEx cannot answer.
  const lone = linkPhraseMedia(text(['', ' media-file="gone"']), { mediaName: 'a.wav' });
  assert.deepEqual(flexImport(lone)[0].unresolved, [], 'relinked to a minted entry rather than left dangling');
});

test('an empty block gets the entry INSIDE it; two blocks become one with every entry kept', () => {
  for (const empty of ['<media-files offset-type="milliseconds"></media-files>', '<media-files offset-type=""/>',
    '\n    <media-files offset-type="milliseconds">\n    </media-files>\n  ']) {
    const [t] = flexImport(linkPhraseMedia(text([T(0, 5)], empty), { mediaName: 'a.wav' }));
    assert.equal(t.blocks, 1, `one block (${JSON.stringify(empty)})`);
    assert.deepEqual(t.media.map((m) => m.location), ['a.wav']);
    assert.equal(t.kept, 1);
  }
  const twice = text([T(0, 1), T(1, 2) + ' media-file="m2"'],
    '<media-files offset-type=""><media guid="m1" location="a.wav"/></media-files>'
    + '<media-files offset-type=""><media guid="m2" location="b.wav"/></media-files>');
  const [t] = flexImport(linkPhraseMedia(twice, { mediaName: 'a.wav' }));
  assert.equal(t.blocks, 1, 'FLEx reads one block per text, so the second is merged into the first');
  assert.deepEqual(t.media.map((m) => m.guid), ['m1', 'm2'], 'and nothing in it is lost');
  assert.equal(t.kept, 2);
});

test('a Windows (CRLF) file gets its new lines in CRLF too', () => {
  const crlf = skeletonXml('lines18').replace(/\s*<media-files[\s\S]*?<\/media-files>/, '').replace(/\n/g, '\r\n');
  const out = linkPhraseMedia(crlf, { mediaName: 'a.wav' });
  assert.doesNotMatch(out, /[^\r]\n/, 'no bare LF anywhere');
  assert.equal(flexImport(out)[0].kept, 18);
  const crlfBlock = skeletonXml('lines18').replace(/\n/g, '\r\n')
    .replace(/<media-files offset-type="milliseconds">[\s\S]*?<\/media-files>/, '<media-files offset-type="milliseconds">\r\n    </media-files>');
  const out2 = linkPhraseMedia(crlfBlock, { mediaName: 'a.wav' });
  assert.doesNotMatch(out2, /[^\r]\n/);
  assert.deepEqual(flexImport(out2)[0].media.map((m) => m.location), ['a.wav']);
});

test('a document of several texts: each links to ITS OWN block', () => {
  const two = '<document version="2">'
    + '<interlinear-text guid="t1"><paragraphs><paragraph guid="a"><phrases><phrase guid="x"' + T(0, 1) + '/></phrases></paragraph></paragraphs>'
    + '<media-files offset-type=""><media guid="m1" location="a.wav"/></media-files></interlinear-text>'
    + '<interlinear-text guid="t2"><paragraphs><paragraph guid="b"><phrases><phrase guid="y"' + T(5, 9) + '/></phrases></paragraph></paragraphs>'
    + '</interlinear-text></document>';
  const [a, b] = flexImport(linkPhraseMedia(two, { mediaName: 'z.wav' }));
  assert.deepEqual([a.kept, a.media.map((m) => m.guid)], [1, ['m1']]);
  assert.equal(b.kept, 1);
  assert.equal(b.media.length, 1, 'the second text gets its own entry — a link across texts would not resolve');
  assert.notEqual(b.media[0].guid, 'm1');
});

/* ── wiring: the writers that cannot run under node ─────────────────────────────────────────────── */
test('the app always names the recording for its .flextext, upload and local save alike', () => {
  const body = APP.slice(APP.indexOf('async function buildBundleFor('), APP.indexOf('function serializeDocBlob('));
  assert.match(body, /const fallbackMediaName = mediaNameFor\(base, media\);/);
  assert.match(body, /: fallbackMediaName;\s*const bare = serializeDocBlob\(rec, uploadMediaName\);/, 'the upload (Segmenter Done, triggerUpload)');
  assert.match(body, /serializeDocBlob\(rec, segMediaName \|\| fallbackMediaName\)/, 'the local bundle (share, save, Segmenter Download)');
  assert.doesNotMatch(body, /serializeDocBlob\(rec, [^)]*undefined/, 'never undefined');
});

test('the panel: the Files ▾ .flextext goes out linked, whichever way it is fetched', () => {
  assert.match(PANEL, /function menuLinkedFlextext\(wrap, blob\)[\s\S]{0,300}linkFlextextBlob\(blob, mediaNameFor\(/);
  assert.match(PANEL, /\(ft && ft\.id === df\.dataset\.drivefile\) \? await menuLinkedFlextext\(wrap2, got\) : got/,
    'the single-file row — and ONLY the .flextext; the recording stays the bytes Drive holds');
  assert.match(PANEL, /saveBlobAs\(await menuLinkedFlextext\(wrap, new Blob\(\[xml\]/, 'the conversion-menu kind');
  assert.match(PANEL, /lametaFlextextMedia\(src\.xml, src\.segMedia \? src\.segMedia\.name : ''\)/, 'the lameta package (links inside lametaFlextextMedia)');
});
