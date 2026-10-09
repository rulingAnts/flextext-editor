/* bundle.js — build exactly what the app's own "Save" would have written for one text.
 *
 * ⚠ THIS IS A PORT OF app.js buildBundleFor(rec, false, { full: true }) — the share menu's local
 * save — AND IT MUST STAY ONE. Every decision is the app's: the file name, when the result is a bare
 * .flextext and when it is a zip, which export files ride along, what the recording is called. The
 * serializers themselves are not ported at all: the build embeds the engine's own flextext.js,
 * seg-exports.js and zip.js byte for byte, and `engine` below IS those modules. So the XML in a
 * recovered file is the XML the app would have written, by construction.
 *
 * test/recovery-tool.test.mjs pins the decisions here against app.js's source, so a change to the
 * app's save logic that is not mirrored here fails the build instead of quietly producing files
 * that differ from the app's.
 *
 * One deliberate difference: `exportSource` says "Flextext Recovery <engine version>", not the
 * app's name. These files were written by this tool, and the provenance attribute exists to say
 * what wrote a file (see the note in serializeFlextext).
 */

/* app.js segmentationEnabled(): the Audio Segmenter is always in segmentation mode; everywhere
 * else it is on unless the device setting says false. (The `?segmentation=1` URL override is a
 * per-visit flag and is not stored, so it cannot be recovered.) */
export function segmentationEnabled(settings, appKey) {
  if (appKey === 'segmenter') return true;
  return settings.segmentation !== false;
}

/* app.js consentReceiptText — copied verbatim; the test compares the two. */
export function consentReceiptText(r) {
  return [
    'SPEAKER PERMISSION / CONSENT RECORD',
    '',
    'Text: ' + (r.textTitle || '(untitled)'),
    'Consent given: yes',
    'Forms of consent: ' + (r.responseTypes && r.responseTypes.length ? r.responseTypes : [r.responseType]).join(', ') +
      (r.signatureName ? '  — signed: "' + r.signatureName + '"' : '') +
      (r.recordedAssentFile ? '  — audio: ' + r.recordedAssentFile : ''),
    'Date/time: ' + r.localTime + '  (' + r.timestamp + ', ' + r.timezone + ')',
    '',
    'Prompt(s) shown to the speaker (' + ((r.promptModes && r.promptModes.length ? r.promptModes : (r.promptMode && r.promptMode !== 'off' ? [r.promptMode] : [])).join(' + ') || 'none') + '):',
    (r.promptMessage || ((r.promptModes || []).includes('audio') || r.promptMode === 'audio' ? '(spoken — see prompt audio file below)' : '(none)')),
    ...(r.promptAudioFile ? ['Spoken prompt audio (included in this bundle): ' + r.promptAudioFile
      + (r.promptAudioUrl ? '   [source: ' + r.promptAudioUrl + ']' : '')] : []),
    '',
    'Device id: ' + r.deviceId,
    'Interface language: ' + r.interfaceLang,
    'IP address: ' + r.ipAddress,
    'Approximate location: ' + (r.approxLocation && typeof r.approxLocation === 'object'
      ? `${r.approxLocation.lat}, ${r.approxLocation.lon} (±${r.approxLocation.accuracyMeters} m)`
      : 'unavailable'),
    'Browser: ' + r.userAgent,
  ].join('\n');
}

export function producedBy(engineVersion) {
  return `Flextext Recovery ${engineVersion}`;
}

/* The media record shape the engine expects ({ blob, name, mimeType, derived, srcName }) from what
 * recover.js found; null when the record exists but its file was not among the chosen files. */
function asMedia(found) {
  if (!found || !found.blob) return null;
  const v = found.value || {};
  return { ...v, blob: found.blob, name: v.name || found.name, mimeType: v.mimeType || found.mimeType };
}

/* app.js serializeDocBlob. */
function serializeDocBlob(engine, rec, settings, appKey, mediaName, provenance) {
  const doc = rec.doc;
  doc.title = rec.title || doc.title || 'Untitled';
  return new Blob([engine.serializeFlextext(doc, settings, {
    mediaName, segTimes: segmentationEnabled(settings, appKey), timeNotes: settings.segTimeNotes !== false, producedBy: provenance,
  })], { type: 'application/xml' });
}

/* text: one item from recover.js scanFiles(). settings: the device settings to export with.
 * Returns { filename, zipped, blob | zip(), entries?, xmlBlob, xmlName, trimmed, missing } —
 * `missing` lists files the app would have included but whose bytes were not found on disk. */
export async function buildBundle(text, { engine, settings, appKey, engineVersion }) {
  const rec = text.record;
  const provenance = producedBy(engineVersion);
  const name = (engine.sanitizeBase(rec.title) || 'text') + '.flextext';       // app.js docFilename
  const base = name.replace(/\.flextext$/, '');
  const missing = [];
  const media = asMedia(text.media);
  if (text.media && text.media.expected && !media) missing.push(`the recording (${text.media.name || 'audio'})`);
  const userAudio = !!(media && media.blob);
  const spans = (Array.isArray(rec.doc && rec.doc.segments) && rec.doc.segments.length)
    ? rec.doc.segments
    : ((rec.doc && engine.segmentsFromOffsets(rec.doc)) || []);
  const hasAligned = spans.some((s) => typeof s.start === 'number' && typeof s.end === 'number' && !s.timePending);
  const expDefault = segmentationEnabled(settings, appKey);
  const caps = media ? engine.conversionCaps({
    bytes: (media.blob && media.blob.size) || 0,
    isWav: /\.wav$/i.test(String(media.name || '')) || /wav/i.test(String(media.mimeType || '')),
  }) : engine.conversionCaps({ bytes: 0, isWav: true });
  const wantEaf = settings.exportEaf ?? expDefault;
  const wantSaymore = settings.exportSaymore ?? expDefault;
  const wantPreview = (settings.exportPreview ?? expDefault) && caps.preview;
  const wantJson = settings.exportJson ?? expDefault;
  const trimmed = [];
  if ((settings.exportPreview ?? expDefault) && !caps.preview) trimmed.push('preview');
  if (wantJson && !caps.fxpaAudio) trimmed.push('fxpaAudio');
  let segMediaName = '';
  let segMedia = null;
  if (hasAligned && media) {
    const working = asMedia(text.segwav);
    segMedia = (working && working.blob && working.srcName === media.name) ? working : media;
    segMediaName = segMedia.derived ? engine.derivedWavName(base) : engine.mediaNameFor(base, segMedia);
  }
  const segEntries = await engine.assembleSegEntries({
    doc: rec.doc, title: rec.title || base, base, media, segMedia,
    producedBy: provenance,
    wants: { eaf: wantEaf, saymore: wantSaymore, preview: wantPreview, fxpa: wantJson, fxpaAudio: caps.fxpaAudio },
    vern: settings.vernLang || rec.doc.vernLang || 'und',
    anal: settings.analLang || rec.doc.analLang || 'en',
    full: true,
  });
  const xmlBlob = serializeDocBlob(engine, rec, settings, appKey, segMediaName || undefined, provenance);
  const consent = rec.consentClip ? asMedia(text.consent) : null;
  if (rec.consentClip && !consent) missing.push(`the recorded consent (${rec.consentClip})`);
  const promptAudio = rec.consentPromptClip ? asMedia(text.consentPrompt) : null;
  if (rec.consentPromptClip && !promptAudio) missing.push(`the consent prompt audio (${rec.consentPromptClip})`);
  const receipt = rec.consentReceipt || null;
  if (userAudio || consent || promptAudio || receipt || segEntries.length) {
    const entries = [{ name, data: xmlBlob }, ...segEntries];
    if (userAudio) entries.push({ name: engine.mediaNameFor(base, media), data: media.blob });
    if (consent?.blob) entries.push({ name: consent.name || rec.consentClip, data: consent.blob });
    if (promptAudio?.blob) entries.push({ name: promptAudio.name || rec.consentPromptClip, data: promptAudio.blob });
    if (receipt) {
      const full = { ...receipt, textTitle: rec.title || '' };
      entries.push({ name: 'consent-receipt.json', data: new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' }) });
      entries.push({ name: 'consent-receipt.txt', data: new Blob([consentReceiptText(full)], { type: 'text/plain' }) });
    }
    let packed = null;
    const zip = () => (packed ??= engine.makeZip(entries));
    return { zip, filename: `${base}.zip`, mime: 'application/zip', xmlBlob, xmlName: name, zipped: true, trimmed, entries, missing };
  }
  return { blob: xmlBlob, filename: `${base}.flextext`, mime: 'application/xml', xmlBlob, xmlName: name, zipped: false, trimmed, missing };
}
