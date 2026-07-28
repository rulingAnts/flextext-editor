/* Researcher-side HISTORY back-log — what happened to a text, after the text is gone.
 *
 * WHY THIS EXISTS: the dashboard shows only what a device currently HOLDS. The moment a coworker
 * finishes a text and it is deleted, every trace of it leaves the panel — who had it, when it was
 * assigned, whether it was ever uploaded, and where that upload landed. That is precisely the
 * information a researcher needs LATER, when the text is no longer on any device and they are
 * trying to find the recording or the submitted transcription. So the log has to be written while
 * the evidence is still visible; it cannot be reconstructed afterwards.
 *
 * ⚠ THE HARD PART IS DELETION, AND THE FAILURE MODE IS SILENT. A deleted text simply VANISHES from
 * the next inventory report — there is no delete event to observe. So the tombstone must be written
 * at the moment present→absent is seen. The danger is writing one when nothing was deleted:
 *   - an install that has never reported has NO inventory (undefined),
 *   - a decrypt failure yields a non-array,
 * and treating either as "empty" would tombstone the device's entire corpus in one poll. Hence the
 * rule enforced in diffInventory(): a non-array next inventory produces NO events AND NO snapshot
 * update — an unreadable report is not evidence of anything. (A device merely being OFFLINE is
 * safe: the server keeps its last report, so the inventory goes stale, not empty.)
 *
 * ⚠ WHY THIS FILE HAS NO DOM AND NO STORAGE IN ITS CORE: the same log is wanted in the Corpus
 * Manager later. diffInventory/mergeEvents are pure — plain data in, plain data out, runnable under
 * node — and only the thin load/save pair at the bottom touches localStorage. Keep that split.
 *
 * PRIVACY NOTE, stated plainly because it differs from the rest of the connectivity design: this
 * log holds DECRYPTED text titles and device nicknames, durably, in the researcher's own browser.
 * The E2EE model protects field data from the SERVER; it was never a claim about the researcher's
 * own machine, where Kr is used in the clear anyway. Durability is the whole point of a back-log,
 * so it deliberately outlives the session lock — and the modal therefore offers "clear history".
 */

export const HISTORY_KINDS = ['assigned', 'submitted', 'done', 'deleted'];

const CAP = 2000;            // ring cap: oldest entries fall off. ~2000 events is years of fieldwork.
const KEY_PREFIX = 'flextext-rp-history:';
const SNAP_PREFIX = 'flextext-rp-invsnap:';

/* ---------------- pure core (no DOM, no storage — unit-testable) ---------------- */

/** Normalize one inventory item to just the fields the log cares about. */
function pick(d) {
  return {
    id: String(d.id || ''),
    title: String(d.title || d.titleHash || ''),
    uploadedFileId: d.uploadedFileId ? String(d.uploadedFileId) : '',
    done: !!d.done,
    pendingDelete: !!d.pendingDelete,
    hasAudio: !!d.hasAudio,
  };
}

/** prev/next snapshots as {id: pickedItem}. `items` may be anything; non-arrays yield null. */
export function snapshotOf(items) {
  if (!Array.isArray(items)) return null;
  const out = {};
  for (const d of items) {
    if (!d || !d.id) continue;          // an item with no id cannot be tracked across reports
    out[String(d.id)] = pick(d);
  }
  return out;
}

/**
 * Derive history events from one inventory report.
 *
 * @param prev  snapshot from the previous report (or null/undefined if none yet)
 * @param items the NEW inventory items array (anything else = unreadable report)
 * @param ctx   { instanceId, installId, device, at, assigned } — `assigned` maps docId -> {audioUrl,…}
 * @returns { events, snapshot } — snapshot is null when the report was unusable, meaning
 *          "keep the previous snapshot", NOT "everything was deleted".
 */
export function diffInventory(prev, items, ctx) {
  const next = snapshotOf(items);
  // ⚠ THE GUARD THAT PREVENTS MASS FALSE TOMBSTONES. An unreadable report tells us nothing.
  if (!next) return { events: [], snapshot: null };
  // First time we have ever seen this install: adopt the snapshot silently, so an existing corpus
  // is not replayed as though it all just happened. This early return is for CLARITY, not safety —
  // the `if (!a) continue` below already yields the same result, verified by removing this line and
  // watching the tests still pass. Do not treat it as the guard; the `!next` check above is.
  if (!prev) return { events: [], snapshot: next };

  const at = (ctx && ctx.at) || Date.now();
  const base = {
    instanceId: (ctx && ctx.instanceId) || '',
    installId: (ctx && ctx.installId) || '',
    device: (ctx && ctx.device) || '',
  };
  const assigned = (ctx && ctx.assigned) || {};
  const events = [];
  const add = (kind, item, extra) => events.push({
    ...base, kind, at,
    docId: item.id,
    title: item.title,
    audioUrl: (assigned[item.id] && assigned[item.id].audioUrl) || '',
    ...(extra || {}),
  });

  for (const id in next) {
    const a = prev[id], b = next[id];
    if (!a) continue;                                   // new text — 'assigned' is logged at its source
    // A NEW upload file id means a fresh timestamped copy landed in Drive. This is the only
    // observable signal that an upload completed, and it is why uploadedFileId is worth retaining
    // in the entry: the inventory only ever holds the LATEST one.
    if (b.uploadedFileId && b.uploadedFileId !== a.uploadedFileId) add('submitted', b, { fileId: b.uploadedFileId });
    if (b.done && !a.done) add('done', b, { fileId: b.uploadedFileId });
  }
  for (const id in prev) {
    if (next[id]) continue;
    const a = prev[id];
    // Present last report, absent now. `by` records WHICH path removed it: a researcher-triggered
    // remote delete always passes through pendingDelete first (the struck-through row), so its
    // absence means the coworker deleted it on the device.
    add('deleted', a, { fileId: a.uploadedFileId, by: a.pendingDelete ? 'researcher' : 'device' });
  }
  return { events, snapshot: next };
}

/** Build the 'assigned' event recorded at the moment the researcher sends an assignment. */
export function assignedEvent({ instanceId, device, docId, title, audioUrl, flextextUrl, at }) {
  return {
    kind: 'assigned', at: at || Date.now(),
    instanceId: instanceId || '', installId: '', device: device || '',
    docId: String(docId || ''), title: String(title || ''),
    audioUrl: audioUrl || '', flextextUrl: flextextUrl || '',
  };
}

/**
 * Append events to a log: newest LAST, deduped, capped.
 * Dedupe matters because the dashboard re-renders on a 12s poll and a render must be replayable
 * without doubling the log — identity is (kind, docId, at, fileId).
 */
export function mergeEvents(existing, incoming, cap) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(out.map((e) => `${e.kind}|${e.docId}|${e.at}|${e.fileId || ''}`));
  for (const e of incoming || []) {
    const k = `${e.kind}|${e.docId}|${e.at}|${e.fileId || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  const lim = cap || CAP;
  return out.length > lim ? out.slice(out.length - lim) : out;
}

/** A Google Drive file id -> a link a human can open. '' when there is no file. */
export function driveLink(fileId) {
  const id = String(fileId || '').trim();
  // Only ever build a link from a Drive-shaped id. The id arrives via a field device's report, so
  // an id containing a quote or a scheme must never be interpolated into an href in this
  // privileged panel (same reasoning as the uploadState allow-list in researcher-panel.js).
  return /^[\w-]{10,}$/.test(id) ? `https://drive.google.com/file/d/${id}/view` : '';
}

/* ---------------- storage (thin; the only part that is not pure) ---------------- */

const rd = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota/private mode — the log is best-effort */ } };

export function loadHistory(accountId) { return rd(KEY_PREFIX + (accountId || 'anon'), []) || []; }
export function saveHistory(accountId, events) { wr(KEY_PREFIX + (accountId || 'anon'), events); }
export function clearHistory(accountId) {
  try {
    localStorage.removeItem(KEY_PREFIX + (accountId || 'anon'));
    localStorage.removeItem(SNAP_PREFIX + (accountId || 'anon'));
  } catch { /* noop */ }
}

function loadSnaps(accountId) { return rd(SNAP_PREFIX + (accountId || 'anon'), {}) || {}; }
function saveSnaps(accountId, s) { wr(SNAP_PREFIX + (accountId || 'anon'), s); }

/** Record events straight away (the 'assigned' path, which has no diff to run). */
export function recordEvents(accountId, events) {
  if (!events || !events.length) return;
  saveHistory(accountId, mergeEvents(loadHistory(accountId), events));
}

/**
 * Observe one dashboard view: diff every install's inventory against its stored snapshot and
 * append whatever happened. Safe to call on every poll — a repeat of the same report diffs to
 * nothing. Never throws: a broken history must not take down the dashboard.
 */
export function observeView(accountId, instances) {
  try {
    const snaps = loadSnaps(accountId);
    const assigned = {};
    for (const e of loadHistory(accountId)) {
      if (e.kind === 'assigned' && e.docId) assigned[e.docId] = { audioUrl: e.audioUrl, flextextUrl: e.flextextUrl };
    }
    let all = [];
    let dirty = false;
    for (const it of instances || []) {
      for (const ins of it.installs || []) {
        const key = ins.install_id || '';
        if (!key) continue;
        const { events, snapshot } = diffInventory(
          snaps[key],
          ins.inventory && ins.inventory.items,
          { instanceId: it.instance_id, installId: key, device: it.nickname || '', assigned },
        );
        if (snapshot) { snaps[key] = snapshot; dirty = true; }
        if (events.length) all = all.concat(events);
      }
    }
    if (dirty) saveSnaps(accountId, snaps);
    if (all.length) recordEvents(accountId, all);
    return all;
  } catch { return []; }        // instrumentation must never break the panel it observes
}
