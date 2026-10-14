/* What downloadable files exist for one text, and what each one is FOR.
 *
 * WHY A MODULE AND NOT PANEL CODE: the same question — "which artifacts does this text have, and
 * where are they" — is asked by the researcher panel today and by the Corpus Manager later. Kept
 * pure (plain data in, plain data out, no DOM, no storage, no i18n) so it runs under node and can
 * be imported anywhere. It returns i18n KEYS, never rendered text, so the caller owns language.
 *
 * ⚠ LABEL BY PURPOSE, NOT FILENAME (Seth). An entry says "ELAN" or "FLExText", not
 * "kisah-kasuari-2026-07-28T1432.eaf". A filename tells a researcher nothing about which tool opens
 * the file, and the panel never receives filenames anyway — the inventory carries Drive file IDs.
 *
 * ⚠ ONE ENTRY PER KIND, ALWAYS THE MOST RECENT. Auto-backup writes a new timestamped Drive file on
 * every upload; listing them all would bury the one the researcher wants. The device already
 * reports only its latest id per kind, so "most recent" is a property of the input, not logic here
 * — but that is exactly why the input shape matters (see below).
 */

import { driveLink, driveIdFrom } from './history.js';

/* The artifact kinds, in the order they should be offered. Order is deliberate: the audio comes
 * first because it is what a researcher most often wants to re-listen to, and the working formats
 * come before the interchange exports. */
export const ARTIFACT_KINDS = ['audio', 'wav-derived', 'flextext', 'bundle', 'eaf-flex', 'eaf-saymore'];

/* i18n key per kind. The VALUE the user reads is owned by i18n.js, in en + id. */
export const ARTIFACT_LABEL = {
  'audio':        'panel.dl.audio',        // the recording that was assigned
  'wav-derived':  'panel.dl.wavDerived',   // converted so ELAN/SayMore can draw a waveform
  'flextext':     'panel.dl.flextext',     // FLEx import
  'bundle':       'panel.dl.bundle',       // our own re-importable bundle
  'eaf-flex':     'panel.dl.eafFlex',      // ELAN
  'eaf-saymore':  'panel.dl.eafSaymore',   // SayMore
};

/**
 * Normalize whatever the device reported into a map of kind -> fileId.
 *
 * ⚠ TWO SHAPES, ON PURPOSE. `uploadedFileId` is historically a SINGLE SCALAR, overwritten on every
 * upload — it can name exactly one file. That is fine while a text has one artifact, and hopeless
 * once EAF (x2 profiles), the bundle and the derived WAV exist. The report will therefore move to a
 * map. Field devices update on their own schedule, so BOTH shapes must be readable forever: a
 * device still on the old engine keeps working instead of showing an empty dropdown.
 */
export function uploadedMap(item) {
  const d = item || {};
  if (d.uploaded && typeof d.uploaded === 'object' && !Array.isArray(d.uploaded)) {
    const out = {};
    for (const k of ARTIFACT_KINDS) {
      const v = d.uploaded[k];
      const id = v && typeof v === 'object' ? v.fileId : v;
      if (id) out[k] = String(id);
    }
    return out;
  }
  if (!d.uploadedFileId) return {};
  // Legacy scalar. Which kind is it? The device uploads a ZIP when the text has audio/consent
  // attached and a bare .flextext otherwise (app.js exportBundle). `hasAudio` is the only signal
  // the old report carries, so this is an INFERENCE, not a fact — and it is why the explicit
  // per-kind report is worth making. It is never wrong in a harmful way: both entries link to the
  // same real file, only the label could mislead.
  return { [d.hasAudio ? 'bundle' : 'flextext']: String(d.uploadedFileId) };
}

/**
 * Resolve the downloadable artifacts for one text.
 *
 * @param item      the inventory item the device reported
 * @param assigned  what was assigned to this text: { audioUrl } — from the History log's
 *                  'assigned' event, the only place the original Drive audio URL is retained.
 * @returns [{ kind, labelKey, url, id, inferred }] — newest-relevant first, one per kind, never
 *          duplicated. Entries with no resolvable URL are omitted rather than shown dead.
 *          `id` is the Drive file id when there is one, '' otherwise; a caller with a Worker should
 *          fetch BY ID and use `url` only as the fallback (see the note on `add`).
 */
export function resolveArtifacts(item, assigned) {
  const out = [];
  const seen = new Set();
  /* ⚠ `id` IS THE DRIVE FILE ID, AND IT IS WHAT MAKES THE LINK ACTUALLY WORK. `url` alone is a
   * DIRECT browser request to drive.usercontent.google.com, which authenticates with whatever
   * Google session the researcher's browser happens to hold — not the Worker token the rest of the
   * panel uses. Signed out, signed into another account, or a file placed by the Worker's own
   * credentials, and the link is simply dead while every Worker-routed row beside it works. That
   * was the "'FlexText Editor' option doesn't work" report (Seth, 2026-08-07).
   * With the id exposed, the UI can hand these to Researcher.fetchDriveFile() like the folder rows
   * do. `url` stays for anything that is NOT a Drive file we can fetch (a researcher-pasted link to
   * another host), which is why it is not simply replaced. */
  const add = (kind, url, inferred, id) => {
    if (!url || seen.has(kind)) return;
    seen.add(kind);
    out.push({ kind, labelKey: ARTIFACT_LABEL[kind] || kind, url, id: id || '', inferred: !!inferred });
  };

  // The originally-assigned audio. Retained at assign time (history.js assignedEvent) because the
  // device's own reports never carry it — the field app only ever reports what it UPLOADED.
  //
  // ⚠ The researcher pasted this URL by hand, so it is almost always a Drive SHARE link
  // (/file/d/<id>/view) — a preview page, not a download. Convert it to the direct-download
  // endpoint when it is recognisably Drive, and pass anything else through untouched (it may be a
  // perfectly good link to some other host, and rewriting URLs we do not understand would break it).
  const a = assigned && assigned.audioUrl;
  if (a && /^https?:\/\//i.test(String(a))) {
    const id = driveIdFrom(a);
    add('audio', id ? driveLink(id) : String(a), false, id);   // id only when it IS a Drive file
  }

  const up = uploadedMap(item);
  const legacy = !(item && item.uploaded && typeof item.uploaded === 'object');
  for (const kind of ARTIFACT_KINDS) {
    if (kind === 'audio') continue;                 // assigned audio only; never a Drive-uploaded copy
    if (up[kind]) add(kind, driveLink(up[kind]), legacy, up[kind]);
  }
  return out;
}

/**
 * Why a text has NO artifacts — so the UI can say something true instead of showing an empty menu.
 * Returns an i18n key, or null when there IS something to show.
 *
 * The distinction that matters to Seth: a text assigned BEFORE the audio URL was retained (editor
 * v126) can never recover it. That is not a bug to hide behind an empty dropdown — it is a fact the
 * researcher needs, because no amount of waiting or re-syncing will produce that link.
 */
export function emptyReason(item, assigned) {
  if (resolveArtifacts(item, assigned).length) return null;
  const hasUpload = !!(item && (item.uploadedFileId || (item.uploaded && Object.keys(item.uploaded).length)));
  if (!hasUpload && !(assigned && assigned.audioUrl)) {
    return assigned ? 'panel.dl.noneAssignedPreV126' : 'panel.dl.noneYet';
  }
  return 'panel.dl.noneYet';
}
