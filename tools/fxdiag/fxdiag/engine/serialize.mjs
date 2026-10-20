// The suite's own .flextext writer, driven from Python: JSON in on stdin, JSON out on stdout.
//   stdin:  { settings: {...the device's flextext-ws-settings...}, records: [{ rec, mediaName }] }
//   stdout: [{ id, xml } | { id, error }]
// Mirrors app.js serializeDocBlob: a FLEx text (the desktop shell's record) goes out as FLEx writes
// it (flexExportDoc, on a copy); the title comes from the record. Times are written whenever the
// record carries segments — a diagnostic export keeps everything the device holds.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsDir = process.env.FXDIAG_ENGINE_JS || join(here, 'js');
const { serializeFlextext, flexExportDoc } = await import(pathToFileURL(join(jsDir, 'flextext.js')).href);

const input = JSON.parse(readFileSync(0, 'utf8'));
const settings = input.settings || {};
const out = [];
for (const { rec, mediaName } of input.records || []) {
  try {
    const base = rec.doc && rec.doc.flex ? flexExportDoc(rec.doc, rec.flex || {}) : rec.doc;
    const doc = { ...base };
    doc.title = rec.title || doc.title || 'Untitled';
    const hasTimes = Array.isArray(doc.segments) && doc.segments.some((s) => s && (s.begin != null || s.end != null));
    const xml = serializeFlextext(doc, settings, {
      mediaName: mediaName || undefined, segTimes: hasTimes || settings.segmentation === true,
      timeNotes: settings.segTimeNotes === true, producedBy: 'fxdiag (FlexText suite diagnostic reader)',
    });
    out.push({ id: rec.id, xml });
  } catch (e) {
    out.push({ id: rec.id, error: String(e && e.stack || e) });
  }
}
process.stdout.write(JSON.stringify(out));
