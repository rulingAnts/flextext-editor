/* researcher-panel.js — the researcher control panel (a SEPARATE full-screen view).
 *
 * The visual layer over js/researcher.js (the verified E2EE engine). Field workers
 * never see this: it has no entry point on a device that hasn't signed up, and it
 * lives in its own #view-researcher takeover (its own header, both app topbars hidden).
 *
 * Flow: signup (Turnstile) / restore → set/enter passphrase (→ Kr, in memory only) →
 * dashboard (devices, approve+deliver-key, decrypted inventory, invite links, per-device
 * tabbed settings). All crypto + network is in researcher.js; this file is UI only.
 *
 * Decoupled like sync.js: app.js calls initResearcherPanel(deps) with injected helpers
 * (workerBase, toast, loadSettings/saveSettings, parseDriveFolder, openView, goHome, …).
 */

import * as Researcher from './researcher.js';
import { t, getLang, setLang, applyI18n, ENGINE_VERSION, BUILD_TAG, LANGS, LANG_NAMES } from './i18n.js';
import { REC_FORMATS, DEFAULT_REC_FORMAT } from './record-pcm.js';
import { importPublicKeyB64, publicKeyFingerprint } from './crypto.js';
import { esc, parseFlextext, surveyWritingSystems, remapWritingSystems, analyzeFlextextWs, segmentsFromOffsets } from './flextext.js';
import { assembleSegEntries, MANIFEST_NAME, buildSourceManifest, sanitizeBase, mediaNameFor, derivedWavName, conversionCaps,
         loosePlan, buildLooseConversion, durationVerdict } from './seg-exports.js';
import { convertAudio, detectFormat, readWavHeader, validOutputs } from './convert.js';
import WaveSurfer from './vendor/wavesurfer.esm.js';
import * as db from './db.js';
import { observeView, recordEvents, loadHistory, clearHistory, assignedEvent, driveLink, driveIdFrom, driveFolderLink, recordingSince, HISTORY_KINDS } from './history.js';
import { makeZip } from './zip.js';

// Byte-size formatter for assign-validation verdicts (mirrors app.js sizeFmt; that one is not exported).
const fmtSize = (b) => (b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB');

/* Local verdict on a PICKED audio file (assign-by-upload — the whole probe/soft-CORS confirm
 * ladder is gone with pasted URLs; a file in hand is checked from its own bytes, offline,
 * deterministically). Mirrors what the device's probe used to block: AIFF (browsers can't play
 * it), oversize, and obvious non-audio. `buf` is a header slice — detectFormat reads magic bytes
 * only. PURE; lifted by test/assign-modal-verdicts.test.mjs. */
const ASSIGN_AUDIO_MAX = 512 * 1024 * 1024;   // the old probe's PROBE_MAX (audio.js) — same ceiling
function assignAudioVerdict({ buf, name, size }) {
  const fmt = detectFormat(buf);
  if (fmt === 'aiff') return { ok: false, code: 'aiff' };
  if (size > ASSIGN_AUDIO_MAX) return { ok: false, code: 'big', mb: Math.round(size / 1048576) };
  const extAudio = /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac|3gp|amr)$/i.test(name || '');
  if (!fmt && !extAudio) return { ok: false, code: 'notAudio' };
  return { ok: true, fmt: fmt || '' };
}

/* WS mismatch at assign time (locked decision 5): compare the picked flextext's surveyed codes
 * against the instance's last-pushed vern/anal settings. Returns null when they match — or when
 * there is nothing to compare (no snapshot pushed yet, unreadable file): a missing check must be
 * SILENT, not a false alarm. Else the two sides, for the explicit Send-anyway/Cancel dialog —
 * never remap, never hard-block. PURE; lifted by test/assign-modal-verdicts.test.mjs. */
function wsAssignMismatch(analysis, instanceCodes) {
  if (!analysis || analysis.error || !instanceCodes) return null;
  const vern = String(instanceCodes.vernLang || '').trim();
  const anal = String(instanceCodes.analLang || '').trim();
  if (!vern && !anal) return null;
  const misVern = !!vern && analysis.vernCodes.length > 0 && !analysis.vernCodes.includes(vern);
  const misAnal = !!anal && analysis.analCodes.length > 0 && !analysis.analCodes.includes(anal);
  if (!misVern && !misAnal) return null;
  return {
    fileVern: analysis.vernCodes.join(', ') || '?', fileAnal: analysis.analCodes.join(', ') || '?',
    setupVern: vern || '?', setupAnal: anal || '?',
  };
}

let deps = null;
let root = null;
let dashPoll = null;   // dashboard auto-refresh interval (runs only while the dashboard shows)
let liveTick = 0;      // counts dashboard polls, to re-fetch the LIVE-version banner periodically (not every tick)
let lastSig = null;    // signature of the last-rendered view, to skip no-op re-renders
let reconnectTimer = null; // auto-retry timer for the "reconnecting" screen (network blip during bootstrap)
let lastData = null;   // last dashboard view, kept so an action (e.g. upload) can re-render instantly w/o a refetch
let lastDataAt = 0;    // when it was fetched — see FRESH_VIEW_MS
// Researcher-side upload-request tracking: docId -> { prevFileId, requestedAt, doneAt }. Lets the panel show
// "request sent → uploaded just now" with NO server state: a (re)upload writes a new timestamped Drive file,
// so when the device later reports a DIFFERENT uploadedFileId we know THIS request completed — even a re-send
// of an otherwise-unchanged doc (uploadState stays 'uploaded'). Swept in renderDashboard; resets on reload.
// Where the native (Android/Windows/Mac) builds can be downloaded. EMPTY until they are
// actually published — the notice then says "in preparation" rather than offering a dead link.
const NATIVE_DOWNLOADS_URL = '';

/* PENDING COMMANDS — docId -> { seq, kind:'upload'|'delete', instanceId, prevFileId, at }.
 *
 * ⚠ REPLACES TWO EXPIRING TIMERS, AND THAT IS THE POINT. The old markers faded after 2 and 10
 * minutes, so a request the device simply had not polled for yet became indistinguishable from one
 * that was never made: the strikethrough vanished while the command was still queued server-side,
 * and the text was still there. Seth hit exactly that. A clock was never the right signal —
 * `install.ack_seq` is, because it says whether the device has actually SEEN the command.
 *
 * Persisted, because these are real outstanding requests: closing the panel must not lose track of
 * a delete that is still queued.
 *
 * ⚠ THE STATE IS DERIVED FROM ack_seq, NEVER FROM ELAPSED TIME:
 *   seq >  maxAck  → queued, the device has not seen it → CANCELLABLE
 *   seq <= maxAck  → the device has it → in progress, NOT cancellable
 * The second case must never offer a cancel. Letting a researcher "cancel" a delete that already
 * happened would leave the panel claiming a text the device no longer has — and for an upload, that
 * it was never sent when it was. The Worker refuses it too (409 already_delivered); the UI simply
 * must not ask for something the server will rightly reject.
 */
/* In-flight MOVES — docId -> { from, to, title, at, stage:'assigned'|'removing' }. Persisted like
 * pendingCmds; advanced by the sweep in renderDashboard on every poll:
 *   'assigned'  → destination reports the doc in its inventory → fire the upload-first remove at
 *                 the source (stage 'removing'). AUTOMATIC by Seth's decision.
 *   'removing'  → the doc is gone from the source's inventory → the move is complete.
 * Both signals are the same inventory facts the rest of the panel already trusts. */
/* ⚠ AN IN-FLIGHT MOVE BELONGS TO THE ACCOUNT, NOT TO THIS BROWSER (Seth's audit, 2026-08-18).
 * It used to live in this browser's localStorage, and a move is two stages — assign to the
 * destination, then, once the destination REPORTS the text, fire the upload-first remove at the
 * source. Only the browser that started it ran that second stage, which cost two different things:
 *   - close that browser mid-move and the text sat on BOTH devices indefinitely, with no panel even
 *     showing that a move was in progress;
 *   - every other panel showed a live Move button on a text already being moved (the chip and the
 *     button suppression both read this map), so a second, conflicting move could be started.
 * Now read from and written to the researcher's account settings, which listView() already refreshes
 * on every dashboard poll — so any panel can see a move and any panel can finish it. Still a Map
 * here, so every call site reads the same. */
let pendingMoves = new Map();
const MOVES_KEY = 'flextext-rp-moves:';   // legacy per-browser key — migration only, see loadMoves

async function loadMoves(accountId) {
  let obj;
  try { obj = await Researcher.getMoves(); }
  catch { return; }                                  // locked or offline — keep what we already have
  /* One-time migration, so a move already in flight across this upgrade is not stranded in the
   * browser that started it. Folded in only where the account has no entry for that text: the
   * account copy is the newer authority the moment it exists. */
  const legacyKey = MOVES_KEY + (accountId || 'anon');
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(legacyKey) || 'null'); } catch { legacy = null; }
  if (Array.isArray(legacy) && legacy.length) {
    try {
      obj = await Researcher.updateMoves((cur) => {
        for (const [docId, mv] of legacy) if (docId && mv && !cur[docId]) cur[docId] = mv;
        return cur;
      });
      localStorage.removeItem(legacyKey);
    } catch { /* leave it; the next render retries the migration */ }
  } else if (legacy) {
    try { localStorage.removeItem(legacyKey); } catch { /* noop */ }
  }
  pendingMoves = new Map(Object.entries(obj || {}));
}

/* `mutate(current)` edits the account's map under an optimistic lock, so two panels transitioning at
 * the same moment merge instead of clobbering. Failure is survivable: the next poll re-reads. */
async function saveMoves(mutate) {
  try { pendingMoves = new Map(Object.entries((await Researcher.updateMoves(mutate)) || {})); }
  catch { /* transient — the next poll re-reads the account copy */ }
}

/* SERVER-DERIVED pending commands — the half that syncs across browsers.
 *
 * ⚠ WHY THIS EXISTS (Seth, 2026-08-18, testing two panels at once): "Pending actions SHOULD sync
 * across researcher sessions. An upload can't of course." Right on both counts. `pendingCmds` below
 * is per-BROWSER localStorage, so before this the second panel saw a successful upload but never the
 * pending one — and, worse than looking emptier, a panel that does not know an upload is in flight
 * will cheerfully issue a SECOND one: a duplicate command with a fresh seq that the device runs twice.
 *
 * The evidence was already server-side, which is why this needs no worker change: listView gives
 * desired_rev per instance and ack_seq per install, so "behind on something" is derivable with no
 * extra request at all, and only when it IS behind do we spend one call on the detail. In steady
 * state that set is empty and polling costs exactly what it always did.
 *
 * `pendingCmds` keeps its job as the OPTIMISTIC hint that makes the issuing browser feel instant
 * before the next poll; this map is the shared truth underneath it. */
let serverPending = new Map();

/* Command types, translated to the vocabulary the renderer already speaks. Anything not doc-scoped
 * (changeSettings) has no per-text row to decorate and is deliberately dropped. */
/* setDone: 'done' (2026-08-31) — un-checking Done used to show a four-second toast and record
 * NOTHING, so a researcher who blinked read a durable, delivered command as a broken button
 * (plans/BACKLOG.md). It rides the same rails as delete/upload: local marker for the issuing
 * browser, serverPending for every other panel, retired by ack like the rest. */
const CMD_KIND = { triggerUpload: 'upload', uploadDelete: 'delete', delete: 'delete', assign: 'assign', setDone: 'done' };

/* #15 — texts in the Researcher view sort by STATUS, THEN NAME (they listed in arrival order,
 * which helped nobody — Brian's screenshot made the case). Active texts first, finished ones
 * after: the list is a worklist, and a done text is the one thing nobody is about to open. Each
 * half uses the same numeric-aware compare as the device's own sortAlpha option (#11), so
 * "Text 2" precedes "Text 10" on both screens. Applied to device rows and the Unassigned card;
 * crowd rows keep their own order — their names ARE timestamps, so arrival is chronology. */
function textOrder(a, b) {
  return (Number(!!(a && a.done)) - Number(!!(b && b.done)))
    || String((a && a.title) || '').localeCompare(String((b && b.title) || ''), undefined, { numeric: true, sensitivity: 'base' });
}

/* Keyed per INSTANCE, because seq counters are per-instance and two devices can legitimately hold
 * the same docId — one device's command history must never decorate another device's row. */
const spKey = (instanceId, docId) => instanceId + '\u0000' + docId;

/* The decrypted command blob, cached by the `desired_rev` it was read at. Two jobs:
 *   - the blob only changes when desired_rev changes, so a steady state costs ZERO requests;
 *   - the ack filter below is re-applied every tick against the CURRENT ack_seq, so a command
 *     retires the moment the device reports it, with no refetch at all.
 * Dropped wholesale on an account switch — a cached blob belongs to one researcher's instances. */
let blobCache = new Map();       // instanceId -> { rev, cmds }
let blobCacheAccount = null;

/* instanceId -> Set of every seq currently in that instance's blob. Populated ONLY for instances
 * this pass actually read, so a transient fetch failure leaves an instance absent rather than
 * looking empty — the difference between "nothing is queued" and "we do not know" (see the
 * withdrawn-elsewhere sweep in renderDashboard, which must never act on the second). */
let serverSeqs = new Map();

/* ⚠ `desired_rev` IS NOT COMPARABLE TO `ack_seq`, and reading it as if it were is what broke this
 * on first contact (Seth, 2026-08-18: a cancelled delete still ran; a pending upload never reached
 * the editor). They are different counters kept for different reasons:
 *
 *   desired_rev — a BLOB revision. Bumped on every command append, on every CANCEL, and on a
 *                 re-key (v1.js). It only ever goes up.
 *   ack_seq     — the highest COMMAND seq an install has run. `seq` is derived from the blob TAIL,
 *                 which goes DOWN when a cancel removes the last entry.
 *
 * So `desired_rev > ack_seq` is true essentially always, and the "cheap gate" it guarded never
 * short-circuited — every instance was refetched on every 12s tick.
 *
 * ⚠ AND THE BLOB IS COMMAND HISTORY, NOT A QUEUE. The Worker deliberately NEVER prunes acked
 * commands (the seq-monotonicity invariant in v1.js — pruning would reuse a seq and the device
 * would silently skip that command forever). Without the `seq > maxAck` test below, every command a
 * device ever ran read as still-pending: a long-finished uploadDelete kept a text struck through
 * for good, and a long-finished triggerUpload replaced that text's Upload button with an inert
 * "in progress" tag — so the button that would have sent a NEW upload was not there to click.
 *
 * `seq > maxAck` is the same test the renderer already uses for `queued`, and it makes this map
 * self-retiring: no sweep, no timer, no second notion of "done". */
/* Every device this panel can act on — the caller's OWN instances PLUS the devices of every project
 * shared with them. Pending-command markers are read from the SERVER's command queue, so they are
 * inherently cross-researcher: whoever queued it, everyone holding the key sees it. But this was fed
 * only `data.instances`, so the sharing was one-way — an OWNER saw a member's pending delete while
 * the MEMBER saw nothing at all on the devices they co-manage, which is exactly backwards from what
 * multi-researcher work needs (Seth, 2026-08-28: "is it possible for researchers to see pending
 * commands triggered by the other researcher?"). */
function allActionableInstances(data) {
  const out = [...((data && data.instances) || [])];
  for (const mp of ((data && data.memberProjects) || [])) out.push(...(mp.instances || []));
  return out;
}

async function refreshServerPending(instances) {
  const account = Researcher.currentAccountId();
  if (account !== blobCacheAccount) { blobCache = new Map(); blobCacheAccount = account; }
  const next = new Map();
  const seqs = new Map();
  const seen = new Set();
  for (const it of instances || []) {
    seen.add(it.instance_id);
    const rev = parseInt(it.desired_rev, 10) || 0;
    const maxAck = ackOf(instances, it.instance_id);
    let hit = blobCache.get(it.instance_id);
    if (!hit || hit.rev !== rev) {
      /* DECRYPTED by researcher.js — the docId for an upload or a delete lives inside the command's
       * ciphertext, not in a plaintext field, which is the whole reason those two never propagated. */
      try { hit = { rev, cmds: await Researcher.readDesiredCommands(it.instance_id) }; }
      catch { continue; }                                   // transient; next poll retries
      blobCache.set(it.instance_id, hit);
    }
    /* Recorded per instance BEFORE the ack filter: the question this answers is "does this command
     * still exist on the server at all", which an acked command does. */
    seqs.set(it.instance_id, new Set((hit.cmds || []).map((c) => c && c.seq)));
    for (const c of hit.cmds || []) {
      const kind = CMD_KIND[c && c.type];
      const docId = c && c.id;
      if (!kind || !docId) continue;
      if (!(c.seq > maxAck)) continue;                      // acked ⇒ history, not pending
      const key = spKey(it.instance_id, docId);
      const prev = next.get(key);
      /* Keep the HIGHEST seq for a doc: an assign followed by an upload should read as the upload. */
      if (prev && prev.seq >= c.seq) continue;
      next.set(key, { seq: c.seq, kind, instanceId: it.instance_id, docId,
                      title: c.title || '', hasAudio: !!c.hasAudio,
                      // The TARGET state, so a done-toggle pending in another browser still knows
                      // which way it is going (readDesiredCommands spreads the decrypted payload).
                      ...(kind === 'done' ? { done: !!c.done } : {}) });
    }
  }
  for (const id of [...blobCache.keys()]) if (!seen.has(id)) blobCache.delete(id);   // instance revoked/removed
  serverPending = next;
  serverSeqs = seqs;
}

/* One place to ask "is anything pending for this text ON THIS DEVICE?" — the browser's own
 * optimistic marker first, because it is there before the poll confirms it, then the shared
 * server-derived one.
 *
 * ⚠ The instance must match. Every pendingCmds marker already records the instance it was sent to,
 * and the row being drawn always knows which device it belongs to; without the check, a marker for
 * one device decorated the same text on every other device that happened to hold it. */
function pendingFor(docId, instanceId) {
  const own = pendingCmds.get(docId);
  if (own && (!instanceId || !own.instanceId || own.instanceId === instanceId)) return own;
  return serverPending.get(spKey(instanceId, docId));
}

const PENDING_KEY = 'flextext-rp-pending:';
let pendingCmds = new Map();
function loadPending(accountId) {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY + (accountId || 'anon')) || '[]');
    pendingCmds = new Map(Array.isArray(raw) ? raw : []);
  } catch { pendingCmds = new Map(); }
}
function savePending(accountId) {
  try { localStorage.setItem(PENDING_KEY + (accountId || 'anon'), JSON.stringify([...pendingCmds])); }
  catch { /* quota/private mode — the markers degrade to in-memory only */ }
}

/* COLLAPSED DEVICE CARDS — instanceId -> true (collapsed) | false (expanded). Same per-account
 * localStorage shape as PENDING_KEY above.
 *
 * ⚠ ONLY AN EXPLICIT CHOICE IS STORED. A card the researcher has never touched has no entry and
 * falls back to collapsedByDefault() — one device expands (there is nothing to scan past), several
 * collapse (the dashboard becomes a list again). Writing the default in at first render would
 * freeze whatever the device count happened to be that day.
 */
const COLLAPSE_KEY = 'flextext-rp-collapsed:';
let collapsedCards = new Map();
function loadCollapsed(accountId) {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY + (accountId || 'anon')) || '[]');
    collapsedCards = new Map(Array.isArray(raw) ? raw : []);
  } catch { collapsedCards = new Map(); }
}
function saveCollapsed(accountId) {
  try { localStorage.setItem(COLLAPSE_KEY + (accountId || 'anon'), JSON.stringify([...collapsedCards])); }
  catch { /* quota/private mode — the choice degrades to in-memory only */ }
}
/* Is this card collapsed right now? PURE, and exported for the test: the state is DERIVED on every
 * render (never carried in the DOM), which is what makes it survive the 12s poll — the rebuilt card
 * comes back in the same state it was in, so there is nothing to animate and nothing to flicker. */
export function isCardCollapsed(stored, instanceId, deviceCount) {
  const v = stored instanceof Map ? stored.get(instanceId) : (stored ? stored[instanceId] : undefined);
  return (v === undefined || v === null) ? deviceCount > 1 : !!v;
}

/* ⚠ TWO ESTATES RUN IN PARALLEL (Seth, 2026-08-05): the Cloudflare apps are production for NEW
 * installs, while existing GitHub Pages installs keep working and keep syncing. So an invite link
 * cannot be built from `location.origin` + a Pages sub-path any more.
 *
 * On a Cloudflare-hosted panel that would produce https://research.flextext.app/flextext-editor/ —
 * a path that EXISTS (build.sh copies the engine there as asset storage) but is NOT the editor
 * app. Opening it would install a third, bogus PWA at that scope, on the wrong origin, with its
 * own empty database. Hence an explicit map rather than string concatenation.
 *
 * Both estates stay addressable: a researcher adding a SECOND device for someone already on Pages
 * needs the legacy link, or that person ends up with two installs and half their work in each. */
const ESTATES = {
  cloud: {
    editor: 'https://app.flextext.app/',
    recorder: 'https://record.flextext.app/',
    crowd: 'https://crowd.flextext.app/',
    researcher: 'https://research.flextext.app/',
    segmenter: 'https://audio-segmenter.flextext.app/',
    consent: 'https://consent.flextext.app/',
  },
  pages: {
    editor: 'https://rulingants.github.io/flextext-editor/',
    recorder: 'https://rulingants.github.io/text-recorder/',
    crowd: 'https://rulingants.github.io/crowd-recorder/',
    researcher: 'https://rulingants.github.io/flextext-researcher/',
    // The two newest apps have NO Pages twin (apps/segmenter/wrangler.toml says why), so the
    // legacy panel links the only copies that exist. Naming the real one is honest; a Pages URL
    // that 404s would not be.
    segmenter: 'https://audio-segmenter.flextext.app/',
    consent: 'https://consent.flextext.app/',
  },
  /* THE STAGING ESTATE (Seth, 2026-08-07) — an explicit map, and it has to be.
   *
   * ⚠ NOT `origin + '/'`. Each staging app is its OWN Cloudflare Worker on its OWN *.workers.dev
   * host, so deriving the editor from wherever the panel happens to be running gets it wrong the
   * moment the panel is the standalone researcher build: staging-flextext-researcher would offer
   * ITSELF as "Open FlexText Editor". That is the same mistake as the estate fallback this replaced,
   * one level down — a URL that resolves, serves a working-looking app, and is the wrong app.
   *
   * ⚠ recorder and crowd are the PRODUCTION addresses ON PURPOSE: those satellites are published
   * only from a productionWeb push, so no staging build of either exists to point at. Naming the
   * real one is honest; inventing a staging URL that 404s would not be. Revisit if they ever get
   * their own Workers.
   *
   * (The Paragraph Analysis tool has a staging Worker too —
   * staging-paragraph-analysis-tool.68mh29kgsd.workers.dev — but the panel links no PAT app, and
   * its version is read from /flextext-editor/js/i18n.js rather than /sw.js, so it is deliberately
   * not in this map. Add it WITH that difference handled, or the live-version check will read the
   * wrong file.) */
  staging: {
    editor: 'https://staging-flextext-editor.68mh29kgsd.workers.dev/',
    researcher: 'https://staging-flextext-researcher.68mh29kgsd.workers.dev/',
    recorder: 'https://record.flextext.app/',
    crowd: 'https://crowd.flextext.app/',
    segmenter: 'https://staging-audio-segmenter.68mh29kgsd.workers.dev/',
    consent: 'https://staging-consent-collector.68mh29kgsd.workers.dev/',
    staging: true,
  },
};

/* Which estate is THIS panel part of?
 *
 * ⚠ THE DEFAULT IS CLOUD, AND PAGES IS NAMED EXPLICITLY (Seth, 2026-08-07). It used to be the other
 * way round — anything that was not *.flextext.app or localhost fell back to the PAGES map — and
 * that quietly made every unrecognised origin part of the legacy estate. The STAGING worker
 * (*.workers.dev) is the case that bit: a staging panel linked to production Pages apps, and
 * refreshLiveVersions() fetched PRODUCTION Pages sw.js files, so staging devices were compared
 * against production versions. Nothing failed; the numbers were simply about a different estate.
 * A wrong fallback is worse than an unknown one, so the legacy estate now has to be recognised by
 * name and everything else lands on the current one.
 *
 * ⚠ STAGING IS SMARTER STILL, because it can be: the staging worker serves ./docs at its own ROOT,
 * so the editor is right there on the same origin — and the panel is that same deployment reached
 * with ?mode=researcher. Test-driving must never hand anyone a production link (the same rule that
 * already protected localhost). The satellites are published only from productionWeb, so there is
 * no staging recorder or crowd app; those keep the real, current URLs rather than a broken guess.
 */
export function estateOf(origin = location.origin) {
  const host = new URL(origin).hostname;
  // The dev rig serves every app under the Pages sub-paths on one origin.
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) {
    return { editor: origin + '/flextext-editor/', recorder: origin + '/text-recorder/',
             crowd: origin + '/crowd-recorder/', researcher: origin + '/flextext-researcher/',
             segmenter: origin + '/audio-segmenter/', consent: origin + '/consent-collector/', local: true };
  }
  // Staging / preview builds get an EXPLICIT map, never a guess from the current origin.
  if (/\.(workers|pages)\.dev$/.test(host)) return ESTATES.staging;
  // The LEGACY estate, by name. Everything else is the current one.
  if (/(^|\.)rulingants\.github\.io$/.test(host)) return ESTATES.pages;
  return ESTATES.cloud;
}

const HOME = estateOf();

/* The two newest apps, as links. The panel's Utilities modal and the editor's Utilities tab both
 * list them FROM THIS ONE MAP, so neither can point at an estate the other does not — a staging
 * editor sends you to the staging apps, the dev rig to its own. They open in a new tab (Seth,
 * 2026-09-03): each is its own origin with its own texts, and the page you came from stays put. */
export function companionApps(estate = HOME) {
  return [
    { key: 'segmenter', url: estate.segmenter, label: 'panel.util.segmenter' },
    { key: 'consent',   url: estate.consent,   label: 'panel.util.consent' },
  ];
}

/* DEPRECATION NOTICE — the legacy GitHub Pages panel only (Seth, 2026-08-05).
 *
 * ⚠ Matched on the EXACT hostname, not on `HOME === ESTATES.pages`. estateOf() returns the pages
 * map for anything that is not *.flextext.app or localhost, which includes the *.workers.dev
 * STAGING previews — and staging is the dev site, not a deprecated address. An estate-based test
 * would have nagged every preview build.
 *
 * Researcher-panel only, deliberately: a researcher's account, coworkers and texts live server-side
 * in D1, so re-installing costs them nothing. The FIELD apps are the opposite — their texts and
 * audio are in per-origin IndexedDB, and telling a field worker to reinstall before they upload
 * would destroy work. Do not copy this banner into the editor or recorder. */
/* Always the CLOUD copy: this link has to outlive the estate it describes, and a link to
 * rulingants.github.io/…/help/migrate.html dies the moment Pages is retired — which is precisely
 * when someone is most likely to be reading it. */
const MIGRATE_DOC = ESTATES.cloud.researcher + 'help/migrate.html';
const LEGACY_PANEL_HOST = 'rulingants.github.io';
const LEGACY_PANEL_PATH = '/flextext-researcher/';
/* ⚠ HOST **AND** PATH. Gating on the host alone also caught the EDITOR opened with
 * ?mode=researcher — putting a site-wide deprecation warning in front of end users on the app they
 * work in, which is the opposite of the intent (Seth, 2026-08-05: "That warning is meant for
 * researchers, NOT end users. The site-wide warning banner should appear only on
 * https://rulingants.github.io/flextext-researcher/"). The researcher APP is the surface being
 * retired; the panel merely being open is not. */
const onLegacyHost = () =>
  location.hostname === LEGACY_PANEL_HOST && location.pathname.startsWith(LEGACY_PANEL_PATH);
// Page-load scoped on purpose: no storage, so it returns next launch. A deprecation notice that can
// be dismissed forever stops being a deprecation notice; one that cannot be dismissed at all is a
// permanent tax on every screen of the panel.
let deprecationDismissed = false;
function deprecationBanner() {
  if (!onLegacyHost() || deprecationDismissed) return '';
  return `<div class="warn-banner rp-deprecated">
    <span>${esc(t('panel.deprecated.msg'))}
      <a href="${ESTATES.cloud.researcher}" target="_blank" rel="noopener">${esc(t('panel.deprecated.link'))}</a>
      &nbsp;·&nbsp;
      <a href="${MIGRATE_DOC}" target="_blank" rel="noopener">${esc(t('panel.deprecated.coworkers'))}</a></span>
    <button class="banner-dismiss" data-act="deprecated-dismiss" aria-label="${esc(t('panel.deprecated.dismiss'))}" title="${esc(t('panel.deprecated.dismiss'))}">&times;</button>
  </div>`;
}

/* ⚠ EVERY LINK COMES FROM THE RECORD'S ESTATE, never from where the panel happens to be running
 * (Seth, 2026-08-05: a legacy crowd recorder shown from the Cloudflare panel produced
 * https://research.flextext.app/crowd-recorder/?c=… — a 404, because the satellites are not copied
 * to that origin. The editor invite was worse: it returned 200 and a working editor, being the
 * engine asset copy, so claiming it would have installed a THIRD PWA on the wrong origin with its
 * own empty database and looked entirely fine).
 *
 * `estate` is stamped on the row by the worker — 'pages' for everything that existed before the
 * migration, 'cloud' for everything created since. So an old coworker keeps their old links for
 * good, and a new one gets Cloudflare, with nothing asked of the researcher.
 *
 * On localhost the dev rig wins regardless: a developer must never be handed production links. */
function basesFor(estate) {
  const ov = linkOverride();
  if (ov) return ov;
  if (HOME.local) return HOME;
  return estate === 'pages' ? ESTATES.pages : ESTATES.cloud;
}

/* ADVANCED: override which estate's URLs the panel PRINTS (Seth, 2026-08-05).
 *
 * Seth: "Don't let the researcher manually choose which site/url to use for new instances... And
 * that should be true regardless of which researcher URL is used (there should be a keyboard
 * shortcut way to expose more advanced options so I can do things like pair a dev app)." And:
 * "But don't present those choices to ordinary users."
 *
 * ⚠ This changes the LINK ONLY, never the stored estate. The worker stamps the row 'cloud' at
 * creation and that stays true, so a dev pairing cannot quietly re-home a real coworker or leave a
 * row disagreeing with the apps it was paired to. The estate remains a property of the record, not
 * a question put to the researcher — the override just prints a different door to the same house.
 *
 * ⚠ NEVER SILENT. While an override is active the picker STAYS visible with a live badge, because
 * a hidden mode that rewrites every invite link is exactly the sort of thing you forget is on and
 * then hand to a real coworker.
 *
 * sessionStorage, not localStorage: it survives the reloads a dev pairing needs, and dies with the
 * tab, so it can never persist into a later real session. */
const LINK_OVERRIDE_KEY = 'flextext-rp-link-estate';
const LINK_MODES = ['auto', 'cloud', 'pages', 'origin'];
function linkMode() {
  try { const v = sessionStorage.getItem(LINK_OVERRIDE_KEY); return LINK_MODES.includes(v) ? v : 'auto'; }
  catch { return 'auto'; }
}
function setLinkMode(v) {
  try { if (v === 'auto') sessionStorage.removeItem(LINK_OVERRIDE_KEY); else sessionStorage.setItem(LINK_OVERRIDE_KEY, v); }
  catch { /* private mode — the override simply will not stick */ }
  advancedShown = true;   // stay visible: an active override must never be invisible
  route();
}
function sameOriginBases() {
  const o = location.origin;
  return { editor: o + '/flextext-editor/', recorder: o + '/text-recorder/',
           crowd: o + '/crowd-recorder/', researcher: o + '/flextext-researcher/', local: true };
}
function linkOverride() {
  const m = linkMode();
  if (m === 'cloud') return ESTATES.cloud;
  if (m === 'pages') return ESTATES.pages;
  if (m === 'origin') return sameOriginBases();
  return null;
}
// Hidden by default; ⌃⌥E reveals it. Auto-revealed whenever an override is already active.
let advancedShown = false;
function advancedPicker() {
  if (!advancedShown && linkMode() === 'auto') return '';
  const m = linkMode();
  const opt = (v, label) => `<option value="${v}"${m === v ? ' selected' : ''}>${esc(label)}</option>`;
  return `<span class="rp-advlinks${m === 'auto' ? '' : ' rp-advlinks-on'}" title="${esc(t('panel.adv.links.help'))}">
    ${m === 'auto' ? '' : `<b>${esc(t('panel.adv.links.on'))}</b>`}
    <select id="rp-adv-links" aria-label="${esc(t('panel.adv.links.label'))}">
      ${opt('auto', t('panel.adv.links.auto'))}${opt('cloud', t('panel.adv.links.cloud'))}
      ${opt('pages', t('panel.adv.links.pages'))}${opt('origin', t('panel.adv.links.origin'))}
    </select></span>`;
}
// A record with no estate at all is pre-migration data seen by a newer client: treat it as legacy,
// which is what it is. Never default an UNKNOWN record to 'cloud' — that invents a migration.
const estateOfRecord = (rec) => (rec && rec.estate) || 'pages';
// Approx capture bytes/sec per format (mono 48 kHz worst-case) — MIRRORS the
// worker's CROWD_BPS: the submit cap is estimate×1.5+overhead, platform-clamped
// at ~95 MB (a public submission is one POST). The live estimate below keeps the
// researcher honest about what their format + max-length choice produces.
const CROWD_BPS = { mp3: 8000, opus: 6000, webmpcm: 187500, wav16: 96000, wav24: 144000, wav32: 192000, flac24: 110000 };
function crowdEstimate(fmt, secs) { return (CROWD_BPS[fmt] || 8000) * secs; }
function fmtDur(secs) { const m = Math.floor(secs / 60), ss = secs % 60; return ss ? `${m} min ${ss} s` : `${m} min`; }

// Crowd recorders live OUTSIDE the 12s poll signature (worker load stays flat): fetched on full
// dashboard renders + after crowd actions only. undefined = not yet fetched, null = fetch failed.
let crowdCache;
let estateCache;   // last Drive estate (full renders only) — feeds the Unassigned card
/* ⚠ DELIBERATELY NOT PERSISTED, unlike device cards (which remember an explicit choice in
 * localStorage). Seth: the Unassigned card is collapsed by default "on every load". It is a holding
 * area, not somewhere work happens, so it should never claim screen space until asked — and a
 * remembered expansion would defeat that on exactly the accounts with most unassigned texts. */
let unassignedOpen = false;

const REC_KEYS = Object.keys(REC_FORMATS);
const AGC_OPTS = ['off', 'on', 'auto'];
const CONSENT_MODES = ['off', 'text', 'audio'];
const CONSENT_RESP = ['yesno', 'record', 'signature'];
const BTN_OPTS = ['new', 'audio', 'record', 'open', 'pair'];   // 'pair' = text+recording together (v332)
/* ⚠ NO 'download': it and 'save' were two checkboxes for one capability (picker where the browser
 * has one, plain download where it does not). See allowedSend() in app.js — the old value is still
 * read so devices set up before v297 keep working, but it is never offered or written again. */
const SEND_OPTS = ['share', 'upload', 'save'];

/* The 5 settings groups (canonical field ids; local↔device key mapping handled in
 * fillForm/readForm). This is the reusable settings-form component. */
const GROUPS = [
  { id: 'languages', legend: 'panel.legend.languages', helpModal: 'wscodes', fields: [
    // Interface language pushed to THIS device (setting D).
    // opts from LANGS: a researcher must not be able to push a language a device cannot render.
    { k: 'appLang', type: 'select', opts: ['follow', ...LANGS], optPrefix: 'panel.opt.appLang.', outside: true },   // sits ABOVE the codes fieldset
    // Codes ONLY (2026-07-13): the name/font fields are gone — names were display
    // sugar, fonts device cosmetics; neither belongs in the FLEx export. tip =
    // hover tooltip (fieldHtml) warning that FLEx codes are case-sensitive.
    { k: 'vernLang', type: 'text', tip: 'research.wsCase' },
    { k: 'analLang', type: 'text', tip: 'research.wsCase' },
  ] },
  /* Audio Segmentation Mode and the exports it governs, on their OWN tab between Languages and
   * Recording (Seth, 2026-08-07). They were the tail of the Buttons tab, which put a mode that
   * rewrites both editing tabs — and the annotation files a text ships with — behind a heading about
   * which buttons show. The exports come with it: their own note says they follow this mode and
   * only apply to texts that have time alignment, so reading them apart from it was never possible. */
  { id: 'segmentation', fields: [
    // Default OFF — the classic textarea workflow is untouched unless the researcher deliberately
    // enables it; the note tells them to trial it with one worker first. Turning it off later hides
    // the UI but never deletes segments.
    { k: 'segmentation', type: 'checkbox', note: 'panel.f.segmentationNote' },
    { k: 'backspaceJoin', type: 'checkbox', note: 'panel.f.backspaceJoinNote' },
    { k: 'cutTab', type: 'checkbox', note: 'panel.f.cutTabNote' },
    { k: 'landOnCut', type: 'checkbox', note: 'panel.f.landOnCutNote' },
    { k: 'joinSplitBaseline', type: 'checkbox', note: 'panel.f.joinSplitBaselineNote' },
    { k: 'joinSplitGloss', type: 'checkbox', note: 'panel.f.joinSplitGlossNote' },
    { k: 'cutJoinTexted', type: 'checkbox', note: 'panel.f.cutJoinTextedNote' },
    // Which annotation exports ride the bundles (Seth, 2026-08-03): each is researcher-selectable;
    // an UNSET value follows the mode. toFormValues prefils these with the EFFECTIVE value so the
    // checkboxes never lie about what the device actually exports.
    { k: 'exportEaf', type: 'checkbox' },
    { k: 'exportSaymore', type: 'checkbox' },
    { k: 'exportPreview', type: 'checkbox' },
    // .fxpa: the Paragraph Analysis app's interchange. Local saves only — never uploads (bandwidth).
    { k: 'exportJson', type: 'checkbox', note: 'panel.f.exportsNote' },
  ] },
  { id: 'recording', helpModal: 'recfmt', notice: 'pwaAudio', fields: [
    { k: 'recordFormat', type: 'select', opts: REC_KEYS, optPrefix: 'panel.opt.fmt.' },  // the permanent recording format
    { k: 'maxRecordSeconds', type: 'range' },   // auto-stop cap (0 = no limit) + live size readout
    { k: 'agc', type: 'select', opts: AGC_OPTS, optPrefix: 'panel.opt.agc.' },
    { k: 'nr', type: 'checkbox' }, { k: 'echo', type: 'checkbox' }, { k: 'norm', type: 'checkbox' },
    // One-tap archive-grade capture: 24-bit WAV with EVERY processing stage off
    // (AGC/NR/echo/normalization are prohibited on preservation masters).
    { k: 'archivalDefaults', type: 'action' },
  ] },
  { id: 'consent', fields: [
    // Consent is multi-select: any combination of prompts + confirmations, all required together.
    { k: 'consentAsk', type: 'multicheck', opts: ['text', 'audio'], optPrefix: 'panel.opt.ask.' },
    { k: 'consentMsg', type: 'textarea' },
    { k: 'consentAudioUrl', type: 'text', note: 'panel.f.consentAudioNote' },
    { k: 'consentConfirm', type: 'multicheck', opts: ['yesno', 'record', 'signature'], optPrefix: 'panel.opt.conf.' },
  ] },
  { id: 'sending', fields: [
    { k: 'sendOptions', type: 'multicheck', opts: SEND_OPTS, optPrefix: 'panel.opt.send.', note: 'setup.sendNote' },
    { k: 'autoDel', type: 'checkbox' },
    // Auto-backup: a text changed since its last upload is auto-uploaded once it's been quiet for
    // autoBackupMins (device engine feature; each backup is a NEW timestamped Drive copy).
    { k: 'autoBackup', type: 'checkbox' },
    { k: 'autoBackupMins', type: 'select', opts: ['5', '15', '30', '60'], optPrefix: 'panel.opt.abm.' },
    { k: 'recordWelcome', type: 'text' },
  ] },
  { id: 'other', fields: [
    { k: 'buttons', type: 'multicheck', opts: BTN_OPTS, optPrefix: 'panel.opt.btn.' },
    // Let the coworker fully wipe THIS device (Delete All). Off by default for managed devices; standalone
    // apps always have it.
    { k: 'deleteAllEnabled', type: 'checkbox' },
    // Let the coworker delete individual texts. Default ON (absent = allowed) so existing
    // devices keep the delete button until the researcher deliberately turns it off.
    { k: 'allowDelete', type: 'checkbox' },
    // Show the coworker an optional "Done" button on each text; marking done auto-uploads
    // and surfaces a "done" badge to the researcher. Off by default.
    { k: 'doneEnabled', type: 'checkbox' },
    // Keep the device's texts list in alphabetical order (numeric-aware). Off by default —
    // most-recently-modified first, as it has always been (issue #11).
    { k: 'sortAlpha', type: 'checkbox' },
  ] },
];

export function initResearcherPanel(d) {
  deps = d;
  root = d.root;
  Researcher.init({ workerBase: deps.workerBase });
  // Language selector lives in the panel's OWN header (every screen, both homes).
  // Delegated once: setLang persists (shared LANG_KEY, same as the apps' toggles),
  // applyI18n repaints the shell's static bits, and route() rebuilds the whole
  // panel so every t() string — dashboard, modals opened later, settings forms —
  // is consistently in the chosen language.
  root.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'rp-lang') {
      setLang(e.target.value);
      applyI18n();
      route();
    }
  });
  // Install button (parity with the editor/recorder apps): the top install banner is
  // hidden behind the panel's full-screen takeover, so it lives in the panel header.
  root.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#rp-install');
    if (b) { b.remove(); if (deps.doInstall) deps.doInstall(); }
  });
  root.addEventListener('change', (e) => {
    const sel = e.target.closest && e.target.closest('#rp-adv-links');
    if (sel) setLinkMode(sel.value);
  });
  // Delegated: the banner is re-rendered by every screen, so a per-render listener would leak.
  root.addEventListener('click', (e) => {
    const d = e.target.closest && e.target.closest('[data-act="deprecated-dismiss"]');
    if (!d) return;
    deprecationDismissed = true;
    const b = d.closest('.rp-deprecated');
    if (b) b.remove();
  });
  // Returning to a backgrounded tab → refresh the dashboard + the LIVE-version banner right away rather
  // than waiting for the next poll tick (only fires while the dashboard is actively polling).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dashPoll) { refreshLiveVersions(); pollDashboard(); } });
  // Regained connectivity → recover immediately instead of waiting for the next timer: refresh the
  // dashboard if it's up, otherwise re-attempt sign-in/bootstrap (drives the reconnecting screen).
  window.addEventListener('online', () => { if (!root || root.hidden) return; sweepAssignUploads(); if (dashPoll) { refreshLiveVersions(); pollDashboard(); } else route(); });
  /* CONSOLE ENTRY POINT — `fxDevices()`. Prints what the panel ACTUALLY received for each device,
   * so "why is/isn't this flagged?" is answered with data instead of a theory. Added after two wrong
   * guesses about the estate badge (Seth, 2026-08-05): the client code and the worker SQL both
   * looked right, which is exactly when you need to see the payload rather than reason about it. */
  if (typeof window !== 'undefined') {
    window.fxDevices = () => {
      const rows = (lastData && lastData.instances) || [];
      if (!rows.length) return 'no dashboard data yet — open the dashboard first';
      const out = rows.map((it) => ({
        nickname: it.nickname || '?',
        estate: 'estate' in it ? it.estate : '(FIELD ABSENT)',
        flagged: it.estate === 'pages',
      }));
      console.table(out);
      const absent = out.filter((r) => r.estate === '(FIELD ABSENT)').length;
      /* ⚠ This reads lastData, which is ALREADY transformed by Researcher.listView(). So an absent
       * field means "it did not reach the panel" — NOT "the server did not send it". Saying the
       * latter sent me to redeploy the worker when the loss was in listView's enumerated rebuild
       * (2026-08-05). Name both suspects. */
      return absent
        ? `${absent}/${out.length} rows have no estate by the time the panel sees it — check BOTH `
          + `the server response (GET /v1/researcher) and Researcher.listView(), which rebuilds each `
          + `instance field-by-field and silently drops anything not named there`
        : `${out.length} rows carry an estate; ${out.filter((r) => r.flagged).length} flagged legacy`;
    };
  }

  /* CONSOLE ENTRY POINT — `fxSettingsAudit(nickOrIdPrefix?)`. Answers "are ALL settings shared?"
   * with data: for each device (own + shared), reads the LOCAL snapshot and the SHARED lane
   * (readSettingsLane — the exact path another researcher's seat decrypts) and diffs them
   * key-by-key. `onlySnapshot` keys are settings this seat pushed that predate the lane or were
   * superseded; `mismatch` is the list that matters — it must be empty for the sharing claim to
   * hold. Sibling of fxDevices/fxLinks/fxProjects; recorded in DEVELOPERS.md. */
  if (typeof window !== 'undefined') {
    window.fxSettingsAudit = async (filter, full) => {
      /* EVERY field the form can store, by stored key — derived from the SAME GROUPS the form
       * renders, so the audit's idea of "all settings" can never drift from the form's. appLang is
       * excluded (a one-shot language command, legitimately absent); consentAudio is the derived
       * twin of consentAudioUrl. A device missing a field was configured by an older form or has
       * never been pushed it — the device treats absence as the default. */
      const expected = (() => {
        const ks = new Set();
        for (const g of GROUPS) for (const f of groupFields(g)) {
          if (f.type === 'action' || f.k === 'appLang') continue;
          ks.add(f.k === 'autoDel' ? 'autoDelUploaded' : f.k === 'buttons' ? 'toolbarButtons' : f.k);
        }
        ks.add('consentAudio');
        return ks;
      })();
      const v = await Researcher.listView();
      const all = [...(v.instances || [])];
      for (const mp of (v.memberProjects || [])) all.push(...(mp.instances || []));
      const pick = filter
        ? all.filter((it) => (it.nickname || '').includes(filter) || it.instance_id.startsWith(filter))
        : all;
      const report = [];
      for (const it of pick) {
        const snap = await Researcher.getInstanceSettings(it.instance_id).catch(() => null);
        const lane = await Researcher.readSettingsLane(it.instance_id).catch(() => null);
        const keys = new Set([...Object.keys(snap || {}), ...Object.keys(lane || {})]);
        const mismatch = [];
        for (const k of keys) {
          if (snap && lane && JSON.stringify(snap[k]) !== JSON.stringify(lane[k])) {
            mismatch.push(`${k}: snap=${JSON.stringify(snap[k])} lane=${JSON.stringify(lane[k])}`);
          }
        }
        const missing = lane ? [...expected].filter((k) => !(k in lane)) : null;
        report.push({ device: it.nickname || it.instance_id.slice(0, 8),
                      snapKeys: snap ? Object.keys(snap).length : null,
                      laneKeys: lane ? Object.keys(lane).length : null,
                      mismatches: mismatch.length,
                      missingFromLane: lane ? (missing.join(', ') || '—') : '(no lane copy)',
                      detail: mismatch });
        if (full) {
          console.log(`--- ${it.nickname} — every field ---`);
          console.table([...new Set([...expected, ...keys])].sort().map((k) => ({
            field: k,
            snapshot: snap && k in snap ? JSON.stringify(snap[k]) : '(absent)',
            lane: lane && k in lane ? JSON.stringify(lane[k]) : '(absent)',
            agree: snap && lane ? (JSON.stringify(snap[k]) === JSON.stringify(lane[k]) ? 'yes' : 'NO') : 'n/a',
          })));
        }
      }
      console.table(report.map(({ detail, ...r }) => r));
      for (const r of report) if (r.detail.length) console.warn(r.device, r.detail);
      return report.every((r) => !r.mismatches)
        ? 'PASS: snapshot and lane agree key-for-key wherever both exist. (A snap≠lane mismatch means one side is STALE — since v461 forms always open on the lane, the device’s current truth.)'
        : 'MISMATCHES — see warnings; the LANE side is what forms open on and what the device obeys';
    };
  }

  /* CONSOLE ENTRY POINT — `fxLinks()`. Replaces a ⌃⌥E shortcut that could never have worked on a
   * Mac: Option+E is the dead key that composes an acute accent, so `e.key` is never 'e' and the
   * handler never fired (Seth, 2026-08-05). A console function is the better shape anyway — there
   * is nothing for an ordinary researcher to discover, and nothing to collide with a dead key,
   * an IME, or a screen reader.
   *
   * Sibling of window.fxUpdate() in app.js. Both are recorded in DEVELOPERS.md. */
  if (typeof window !== 'undefined') {
    window.fxLinks = (mode) => {
      if (mode === undefined) {
        advancedShown = true; route();
        return `links: ${linkMode()} — call fxLinks('auto'|'cloud'|'pages'|'origin') to change. ` +
               `Affects the URLs printed in invite/share links only, never where a device is registered.`;
      }
      if (!LINK_MODES.includes(mode)) return `unknown mode ${JSON.stringify(mode)} — use ${LINK_MODES.join(' | ')}`;
      setLinkMode(mode);
      return `links: ${linkMode()}${mode === 'auto' ? '' : ' (OVERRIDE ACTIVE — the panel shows a badge while it is on)'}`;
    };
  }
  /* CONSOLE ENTRY POINT — `fxProjects()`. The project folder migration (plans/drive-as-truth.md
   * §16.16), driven from the console rather than a button, deliberately and for now.
   *
   * ⚠ WHY NOT A BUTTON YET. This is the first operation in the suite that MOVES a researcher's
   * folders. Its plan needs to be read against a real estate and judged correct before anything
   * wraps a UI around it — a button implies "we are confident", and we are not yet. Console first,
   * button once the plan has been seen to be right, is the same order the repo used for fxLinks.
   *
   *   fxProjects()                      → DRY RUN. Prints exactly what would move. Changes nothing.
   *   fxProjects('migrate', 'My Name')  → apply, creating the project folder with that name
   *   fxProjects('undo')                → DRY RUN of the reverse
   *   fxProjects('undo!', )             → apply the reverse
   *   fxProjects('rename', 'New Name')  → rename the project folder
   *
   * The bang is the confirmation. Every verb without one previews, matching the server, which also
   * defaults to dry — two independent defaults, so forgetting either one is still safe.
   *
   * Sibling of window.fxLinks() and window.fxUpdate(). All recorded in DEVELOPERS.md. */
  if (typeof window !== 'undefined') {
    window.fxProjects = async (verb, name) => {
      const show = (r) => { console.log(r); return r; };
      try {
        if (verb === 'rename') {
          if (!name) return 'usage: fxProjects("rename", "New project name")';
          const est = await Researcher.driveEstate();
          // The project ON SCREEN, not projects[0] — which renamed the wrong one the moment a
          // second project existed.
          const ids = new Set((est.projects || []).map((p) => p.folderId));
          const proj = (currentProject && ids.has(currentProject)) ? currentProject
                                                                   : ((est.projects || [])[0] || {}).folderId;
          if (!proj) return 'no project folder yet — run fxProjects("migrate", "…") first';
          return show(await Researcher.projectRename(proj, name));
        }
        /* fxProjects('why') — WHY IS THIS DEVICE IN THE WRONG TAB. Prints the actual join: each
         * instance's stored folder id, the estate device it matched, and the project that yields.
         * Added because the same symptom was mis-diagnosed twice from the outside; a table of what
         * the panel actually received settles it in one line instead of a third theory. */
        if (verb === 'why') {
          const est = await Researcher.driveEstate();
          const byFolder = new Map((est.devices || []).map((d) => [d.folderId, d]));
          const rows = ((lastData && lastData.instances) || []).map((it) => ({
            nickname: it.nickname || '', instance: String(it.instance_id).slice(0, 8),
            oauth_folder_id: it.oauth_folder_id || '(none)',
            matchedEstateDevice: (byFolder.get(it.oauth_folder_id) || {}).name || '(NO MATCH)',
            projectId: (byFolder.get(it.oauth_folder_id) || {}).projectId || '(none)',
          }));
          console.table(rows);
          console.table((est.devices || []).map((d) => ({ folderId: d.folderId, name: d.name, kind: d.kind, projectId: d.projectId })));
          console.table((est.projects || []).map((p) => ({ folderId: p.folderId, name: p.name })));
          return 'printed: instances, estate devices, projects';
        }
        /* ⚠ THE UNDO LIVES HERE NOW, not on the card (§16.28): the migration is one-way and not
         * optional, and a "go back" button on the panel is the optionality message however it is
         * worded. `undo` opens the real modal — preview, settle, repaint, all of it — so the
         * operator path is the good one rather than a stripped-down twin. `undo!` stays a direct
         * apply for scripted use, and §17.4's rollback ladder still names it. */
        /* ⚠ AWAITED, so the string is not a lie. Fire-and-forget returned "opened the undo
         * preview" whether or not anything opened: if the dry run threw, the rejection went
         * unhandled and the console still reported success. Awaiting sends a failure to the
         * catch below, which reports it. */
        if (verb === 'undo') { await projectsUndoModal(); return 'undo preview opened'; }
        if (verb === 'undo!') return show(await Researcher.projectsUnmigrate({ dry: false }));
        if (verb === 'migrate') {
          if (!name) return 'usage: fxProjects("migrate", "Default Project")  — the name is yours to choose';
          return show(await Researcher.projectsMigrate({ name, dry: false }));
        }
        // No verb, or anything unrecognised: preview. Never act on a typo.
        const plan = await Researcher.projectsMigrate({ dry: true });
        console.log(plan);
        return `DRY RUN — ${plan.count} container(s) would move under a project folder`
             + `${plan.wouldCreateProject ? ' (which would be created)' : ''}. `
             + `Nothing has changed. To apply: fxProjects('migrate', 'Default Project')`;
      } catch (e) { return 'failed: ' + ((e && e.message) || e); }
    };
  }
  return { open, close, isSignedUp: () => Researcher.isSignedUp(), onInstallable };
}

// app.js calls this when a deferred install prompt arrives (which may be after the
// header already rendered) — inject the Install button into the current header if
// it isn't already there. header() also renders it up-front when the prompt exists.
function onInstallable() {
  const head = root && root.querySelector('.rp-head');
  if (!head || head.querySelector('#rp-install')) return;
  const btn = document.createElement('button');
  btn.className = 'secondary-btn rp-install';
  btn.id = 'rp-install';
  btn.textContent = t('install.btn');
  head.insertBefore(btn, head.querySelector('#rp-lang') || head.querySelector('.rp-helpbtn') || null);
}

function open() { deps.openView('researcher'); route(); }
function close() { stopDashPoll(); deps.goHome(); }

async function route() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  /* Returning from Google having DECLINED Drive. The worker refuses to create (or to half-update)
   * an account that cannot reach Drive, and sends the researcher back with this fragment instead of
   * a session — so the panel has to explain it, or the trip looks like sign-in simply failed.
   * Checked BEFORE consumeGauth because there is no session in this fragment to consume. */
  const declined = /[#&]gauth_error=([^&]+)/.exec(location.hash || '');
  if (declined) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* noop */ }
    return renderSignIn(t(decodeURIComponent(declined[1]) === 'drive_required'
      ? 'panel.signin.driveRequired' : 'panel.signin.expired'));
  }
  // Returning from Google? Consume #gauth=<id>.<token>, then strip it from the address bar.
  if (Researcher.consumeGauth()) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* noop */ } }
  if (!Researcher.isSignedUp()) return renderSignIn();
  // Account-switch guard: a DIFFERENT account signed in on a browser that still holds the PREVIOUS
  // account's offline data (docs / enrollment) → block until that data is erased. Offline data is
  // origin-scoped, not account-scoped, so it would otherwise be inherited. Explicit + reversible.
  { const cur = Researcher.currentAccountId(), last = Researcher.lastAccountId();
    if (last && cur && cur !== last && await hasInheritableData()) return renderAccountSwitch(); }
  if (!Researcher.isUnlocked()) {
    renderConnecting();
    try { await Researcher.bootstrap(); }
    catch (e) {
      // 401 = the session is genuinely invalid → sign out. Any OTHER failure (network/timeout/5xx —
      // the field hits these constantly) must NOT sign the researcher out: show "reconnecting" and
      // keep retrying, so a blip never drops them back to the sign-in screen.
      if (e && e.status === 401) { Researcher.purgeLocal(); return renderSignIn(t('panel.signin.expired')); }   // session gone/deleted → wipe researcher-console local data
      return renderReconnecting();
    }
  }
  if (!Researcher.isApprovedSelf()) return renderAwaiting();   // signed in but pending → awaiting-approval screen
  renderDashboard();
}

// Sign-in screen: one "Sign in with Google" button (replaces the email+password + 2FA screens).
function renderSignIn(note) {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin">
      <h2>${esc(t('panel.signin.title'))}</h2>
      <p class="note">${esc(t('panel.signin.intro'))}</p>
      ${note ? `<p class="banner warn-banner">${esc(note)}</p>` : ''}
      <button class="primary-btn" data-act="google">${esc(t('panel.signin.btn'))}</button>
      <label class="check-label rp-stay"><input type="checkbox" id="rp-stay"${Researcher.staySignedIn() ? ' checked' : ''}> ${esc(t('panel.account.stay'))}</label>
    </div></div>`;
  const stayBox = root.querySelector('#rp-stay');
  if (stayBox) stayBox.addEventListener('change', () => Researcher.setStaySignedIn(stayBox.checked));
  wireActs({ google: () => { location.href = Researcher.googleSignInUrl(undefined, getLang()); }, exit: close });
}

function renderConnecting() {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin"><p class="note">${esc(t('panel.signin.connecting'))}</p></div></div>`;
  wireActs({ exit: close });
}

// Network blip during bootstrap → never sign the researcher out. Show we're retrying, auto-retry on a
// timer (and the `online` listener re-routes the moment connectivity returns). route() recovers to the
// dashboard as soon as bootstrap succeeds; the session is never dropped on a transient failure.
function renderReconnecting() {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin">
      <h2>${esc(t('panel.conn.title'))}</h2>
      <p class="banner warn-banner">${esc(t('panel.conn.offline'))}</p>
      <button class="primary-btn" data-act="retry">${esc(t('panel.conn.retry'))}</button>
      <button class="link-btn" data-act="signout">${esc(t('panel.account.signout'))}</button>
    </div></div>`;
  wireActs({ retry: () => route(), signout: () => { Researcher.signOut(); route(); }, exit: close });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => route(), 8000);
}

// Pending researcher: signed in via Google, but an owner hasn't approved this account yet. They
// can re-check (re-bootstrap) or sign out. No dashboard until approved.
function renderAwaiting() {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin">
      <h2>${esc(t('panel.await.title'))}</h2>
      <p class="note">${esc(t('panel.await.intro', { email: Researcher.accountEmail() || '' }))}</p>
      <button class="primary-btn" data-act="recheck">${esc(t('panel.await.recheck'))}</button>
      <button class="link-btn" data-act="signout">${esc(t('panel.account.signout'))}</button>
    </div></div>`;
  wireActs({
    recheck: (btn) => busy(btn, async () => { try { await Researcher.bootstrap(); } catch { /* stay pending */ } route(); }),
    signout: () => { Researcher.signOut(); route(); },
    exit: close,
  });
}

// Cheap probe: does this browser hold offline data a different account would inherit? A field
// enrollment (sync-session) or any locally-authored docs both qualify. A fresh researcher-only
// browser has neither → no gate.
async function hasInheritableData() {
  try { if (localStorage.getItem('flextext-sync-session')) return true; } catch { /* noop */ }
  try { if ((await db.listDocs()).length) return true; } catch { /* noop */ }
  return false;
}

// A different account signed in on a browser that still holds the previous account's data. Block with
// a clear choice: erase this device's data and continue (full local wipe → reload → fresh sign-in), or
// cancel (drop the just-signed-in session; the old data stays intact for whoever owns it). Never silent.
function renderAccountSwitch() {
  stopDashPoll();
  root.innerHTML = header('panel.title', false) + `
    <div class="rp-body rp-narrow"><div class="rp-card rp-signin">
      <h2>${esc(t('panel.acctswitch.title'))}</h2>
      <p class="note">${esc(t('panel.acctswitch.intro', { email: Researcher.accountEmail() || '' }))}</p>
      <p class="banner warn-banner">${esc(t('panel.acctswitch.warn'))}</p>
      <button class="primary-btn rp-danger" data-act="erase">${esc(t('panel.acctswitch.erase'))}</button>
      <button class="link-btn" data-act="cancel">${esc(t('panel.acctswitch.cancel'))}</button>
    </div></div>`;
  wireActs({
    erase: (btn) => busy(btn, async () => { try { await deps.eraseAllData(); } catch (e) { errToast(e); } }),
    cancel: () => { Researcher.signOut(); route(); },   // drop the new session; old data stays for its owner
    exit: close,
  });
}

/* ---------------- small DOM helpers ---------------- */

/* WHICH ACCOUNT AM I LOOKING AT — under the panel title (Seth, 2026-08-28: "so that both you and I,
 * and anyone else testing or using multiple accounts, can see which one is active/logged in").
 * Two panels open on two accounts are otherwise identical at a glance, and acting on the wrong one
 * is silent and expensive.
 *
 * ⚠ ONLY EVER THIS BROWSER'S OWN ACCOUNT. Researcher identity is not advertised anywhere a device
 * or another researcher can see it (the pairing screen deliberately shows none) — this is the one
 * place it belongs, because the person reading it is the person it names.
 *
 * The avatar is remote (Google's CDN) and may fail to load; `onerror` removes it rather than
 * leaving a broken-image glyph. Email always renders — it is available from stored auth with no
 * round trip, so the header names the account on the very first paint. */
function whoHtml() {
  let id = { email: '', name: '', avatar: '' };
  try { id = Researcher.accountIdentity ? Researcher.accountIdentity() : id; } catch { /* locked / old build */ }
  if (!id.email && !id.name) return '';
  const label = id.name && id.email ? `${id.name} · ${id.email}` : (id.name || id.email);
  /* ⚠⚠ TEMPORARY — REMOVE WITH THE INVITE-LINK WORK (Seth, 2026-08-28: "as long as our panel depends
   * on the researcher ID, can you print it underneath the e-mail address in the header? We'll remove
   * that when we're done").
   *
   * It is here because joining a project currently REQUIRES a person to find this string and send it
   * to someone — and it lives in Account, which a first-time coworker has no reason to open. Putting
   * it on screen is a crutch for a flow that should not need one.
   *
   * ⚠ THE CONDITION FOR DELETING IT IS WRITTEN DOWN, so this does not quietly become permanent: when
   * a one-time-use invite link replaces the ID exchange (plans/BACKLOG.md, "Coworker pairing"), the
   * owner never learns the ID and nobody needs to read it off a screen. Delete this block, its two
   * strings and the .rp-who-id rule in the SAME commit that lands the link.
   *
   * ⚠ It is YOUR OWN id, which is why showing it is acceptable at all — it is already on the Account
   * screen. It is NOT a step toward showing anyone else's; that is the opposite direction, and the
   * backlog entry above it says so. `user-select: all` so one click selects the whole thing: the
   * point is to get it into a message, and a hand-selected uuid is a transcription error waiting. */
  const rid = (() => { try { return Researcher.currentAccountId() || ''; } catch { return ''; } })();
  return `<span class="rp-who" title="${esc(t('panel.who.title', { who: label }))}">
    ${id.avatar ? `<img class="rp-who-av" src="${esc(id.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <span class="rp-who-txt">${esc(label)}</span>${
    rid ? `<span class="rp-who-idwrap">(${esc(t('panel.who.idLabel'))} <button type="button" class="rp-who-id" data-act="copyid" title="${esc(t('panel.who.idTip'))}">${esc(rid)}</button>)</span>` : ''}</span>`;
}

function header(titleKey, withLock) {
  // Standalone Researcher app: no editor to go "back" to, so drop the exit arrow
  // (the dashboard Lock button is the way out — it signs out → sign-in screen).
  const exitBtn = deps && deps.standalone ? ''
    : `<button class="icon-btn rp-exit" data-act="exit" title="${esc(t('panel.exit'))}">&#8592;</button>`;
  return deprecationBanner() + `<div class="rp-head">
    ${exitBtn}
    <span class="rp-titlewrap"><span class="rp-title">${esc(t(titleKey))}</span>${whoHtml()}</span>
    <span class="rp-spacer"></span>
    ${deps && deps.canInstall && deps.canInstall() ? `<button class="secondary-btn rp-install" id="rp-install">${esc(t('install.btn'))}</button>` : ''}
    ${advancedPicker()}
    ${/* ⚠ GATED ON withLock, which is the DASHBOARD flag — and that is what wires it for free.
         `refresh: () => renderDashboard()` already lives in the dashboard's own wireActs handler
         map, so rendering the button only where that map is in scope needs no universal special
         case like `help` and `known` required. On any other view the button would be handled by
         nobody, which is the failure those two comments describe. */''}
    ${/* An icon, matching the header's own idiom — the exit arrow and the help "?" are glyphs too,
         so an SVG here would be the odd one out. ↻ is Unicode 1.1, so it renders everywhere the
         field runs. The word survives in title + aria-label. */''}
    ${withLock ? `<button class="icon-btn rp-headbtn" data-act="refresh" title="${esc(t('panel.dash.refresh'))}" aria-label="${esc(t('panel.dash.refresh'))}">↻</button>` : ''}
    <select id="rp-lang" title="${esc(t('research.lang'))}">${LANGS.map((l) =>
      `<option value="${esc(l)}"${getLang() === l ? ' selected' : ''}>${esc(LANG_NAMES[l] || l)}</option>`).join('')}</select>
    ${releaseNotesLink()}
    <button class="icon-btn rp-helpbtn" data-act="help" title="${esc(t('panel.help.btn'))}" aria-label="${esc(t('panel.help.btn'))}">?</button>
    ${withLock ? `<button class="secondary-btn rp-lock" data-act="lock">${esc(t('panel.lock'))}</button>` : ''}
  </div>`;
}

/* RELEASE NOTES — what changed, and what is still wrong, in one place.
 *
 * ⚠ NOT STAGING-ONLY ANY MORE (Seth, 2026-08-28: "I'd like to have that link available on stable, as
 * well as release"). It began as a staging-only "Known issues" list on the reasoning that a
 * production user meeting a list of broken things has no way to act on it. That was half right: what
 * a production user cannot act on is a list of ONLY broken things. Paired with what changed, the same
 * list becomes the thing people actually look for after an app updates itself under them — which this
 * one does, silently, on every service-worker activation.
 *
 * ⚠ "Release notes" and not "What's new", deliberately: the conventional contents of release notes
 * are additions, fixes AND known issues, so the name promises exactly what is inside. "What's new"
 * promises only the first and would make the second half read as a surprise.
 *
 * ⚠ BOTH LISTS EMPTY ⇒ NO LINK. A permanent entry opening onto nothing teaches people it is
 * decoration, and the next time it has content they will not look.
 *
 * ⚠ KEEP BOTH CURRENT. A stale known-issue sends someone hunting for a bug that is fixed and makes
 * the rest look untrustworthy; a stale what's-new claims credit for something that is not there. When
 * a release fixes one of these, delete the key in the SAME commit that fixes it.
 *
 * ⚠ PER-RELEASE SECTIONS, GitHub-style (Seth, 2026-08-31: "specific to each release, and a new
 * section with each new release"). Each production release is one entry, newest first — a version
 * heading, its date, its changes. Start a NEW entry when a release wave begins; the top entry's `v`
 * is finalised by the release commit (mid-wave it names the current staging build, which is honest
 * on the staging estate and a day early nowhere else).
 *
 * ⚠ ISSUE LINKS, FORWARD-ONLY (Seth, same day: link fixes to submitted issues "whenever they DO
 * relate", "no need to do that retroactively"): an item that resolves a submitted GitHub issue
 * carries `issue: <n>` and renders a link to it. Items with no submitted issue carry nothing —
 * never invent a number for symmetry. */
const ISSUES_URL = 'https://github.com/rulingAnts/flextext-editor/issues/';
const RELEASES = [
  /* ⚠ #6 IS LISTED NOW, AND THIS IS THE RELEASE THAT EARNED IT. The note that stood here said it
   * was deliberately absent because CREATE_RETRY_SAFE was false — the worker replayed, the client
   * never retried, so nothing about duplicate device creation actually behaved differently. That
   * flag went true in v561 against the deployed worker, so the sentence is true for the first time.
   * Left as a comment rather than deleted: the rule it records (a note describing something the
   * shipped code does not do is worse than silence) is the one this file exists to enforce. */
  { v: 'v569', date: '2026-09-03', items: [
    { k: 'panel.rel.new.segmenterApp' },
    { k: 'panel.rel.new.consentApp' },
    { k: 'panel.rel.new.satExport' },
    { k: 'panel.rel.new.appLinks' },
    { k: 'panel.rel.new.phraseLines' },
    { k: 'panel.rel.new.matcherDraft' },
    { k: 'panel.rel.new.eafOnly' },
    { k: 'panel.rel.new.provenance' },
  ] },
  { v: 'v566', date: '2026-09-01', items: [
    { k: 'panel.rel.new.hardRefresh' },
    { k: 'panel.rel.new.deviceOnce', issue: 6 },
    { k: 'panel.rel.new.moveVersionAge', issue: 16 },
    { k: 'panel.rel.new.deviceHeader' },
    { k: 'panel.rel.new.uploadChipAll' },
    { k: 'panel.rel.new.slowModal' },
  ] },
  { v: 'v555', date: '2026-09-01', items: [
    { k: 'panel.rel.new.deviceButtons', issue: 17 },
  ] },
  { v: 'v550', date: '2026-09-01', items: [
    { k: 'panel.rel.new.smallScreen' },
    { k: 'panel.rel.new.pairConnect' },
    { k: 'panel.rel.new.projectText', issue: 4 },
  ] },
  { v: 'v543', date: '2026-09-01', items: [
    { k: 'panel.rel.new.editorDialogs' },
    { k: 'panel.rel.new.unassignedInFlight', issue: 14 },
    { k: 'panel.rel.new.deviceCountRevoked', issue: 10 },
  ] },
  { v: 'v539', date: '2026-08-31', items: [
    { k: 'panel.rel.new.previewPlayer' },
    { k: 'panel.rel.new.previewNoAudio' },
    { k: 'panel.rel.new.crowdSpeakerName' },
  ] },
  { v: 'v532', date: '2026-08-31', items: [
    { k: 'panel.rel.new.doneTogglePending' },
    { k: 'panel.rel.new.textSort', issue: 15 },
  ] },
  { v: 'v531', date: '2026-08-31', items: [
    { k: 'panel.rel.new.crowdFirstSubmit' },
    { k: 'panel.rel.new.crowdProgress' },
    { k: 'panel.rel.new.crowdExpiry' },
    { k: 'panel.rel.new.crowdLocalTime' },
    { k: 'panel.rel.new.crowdInFlight', issue: 14 },
    { k: 'panel.rel.new.crowdEveryProject' },
    { k: 'panel.rel.new.recordButton' },
  ] },
  { v: 'v524', date: '2026-08-31', items: [
    { k: 'panel.rel.new.share' },
    { k: 'panel.rel.new.memberApprove' },
    { k: 'panel.rel.new.projTemplates' },
    { k: 'panel.rel.new.activityTray' },
    { k: 'panel.rel.new.memberFiles' },
    { k: 'panel.rel.new.projectLifecycle' },
    { k: 'panel.rel.new.rename' },
    { k: 'panel.rel.new.freshPanel' },
    { k: 'panel.rel.new.dialogs' },
    { k: 'panel.rel.new.keylessHonest' },
    { k: 'panel.rel.new.uploadChip' },
    { k: 'panel.rel.new.audioError' },
    { k: 'panel.rel.new.doneToggle' },
    { k: 'panel.rel.new.oneVersion' },
  ] },
];
const KNOWN_ISSUES = [
  'panel.known.addColleague',
  'panel.known.crowdMembers',
  'panel.known.inviteOnce',
];

/* The same rule the staging ribbon uses, deliberately duplicated rather than imported: the ribbon
 * lives inline in five shells precisely so it does not depend on the engine, so there is nothing to
 * import from. Still used for the "this is a test build" line inside the notes — the LINK no longer
 * depends on it. */
function onStagingEstate() {
  try { return /\.(pages|workers)\.dev$/.test(location.hostname); } catch { return false; }
}
/* PROJECT DEFAULT SETTINGS — the settings a NEW device in this project is born with.
 *
 * ⚠ A TEMPLATE, NOT AN INHERITANCE. Nothing reads these at runtime and no device consults them: they
 * are COPIED onto a device once, when it is created, and pushed like any other settings change.
 * The copy site is openSettingsModal's prefill (v519): a device with NO settings yet seeds its form
 * from the template of the project it lives in (the create flow passes the folder id straight in;
 * the retry path — a card's Settings button after a failed first delivery — resolves it from the
 * estate), and the PUSH stays the researcher's explicit act, so validation and the invite gate run
 * exactly as for hand-typed values and nothing lands on a device behind anyone's back.
 * Editing them later changes what the NEXT device gets and touches no existing one BY ITSELF —
 * applying to devices already out there is a separate, explicit act (Seth: "the user can also
 * specifically choose to apply defaults to all or one or more specifically selected existing
 * devices"): applyTemplateModal, offered after every template save, whole-template or
 * changed-fields-only, and declinable.
 * That is what keeps this out of the worker entirely. Live inheritance would need a second settings
 * layer the device merges at read time, and settings are ciphertext the worker does not read (⚠
 * corrected 2026-08-28: "cannot" overclaimed — the escrow chain reaches Ki; see worker
 * project-key.js — but a merge built on that reach would put plaintext settings handling on the
 * worker's hot path, which nobody wants), so the merge would ship to every field device and be
 * versioned forever.
 *
 * ⚠ KEYED BY DRIVE FOLDER ID, which is what both ends already hold: the Projects card renders
 * folderIds, and newDeviceModal resolves `intoProject` to one. The D1 project uuid is a DIFFERENT
 * namespace used by the shared-project tabs — keying by that would silently store defaults nothing
 * could look up. Folder ids survive renames, which a name-based key would not.
 *
 * ⚠ OWNER-ONLY, and by construction rather than by a check: these live in the owner's account prefs,
 * encrypted under their Kr. A member holds no Kr of the owner's, so a device a MEMBER creates in a
 * shared project gets no defaults. That is the honest limit of this storage choice and it matches
 * what was agreed — making it grantable needs a project-scoped key, which does not exist yet
 * (plans/BACKLOG.md). */
let projDefCache = null;
/* Keys saved into the template but not yet pushed to every device — see applyTemplateModal. Same
 * prefs blob, same round trip; a list of field keys per project, never any values. */
let projPendCache = null;
async function loadProjectDefaults() {
  try {
    const p = (await Researcher.getPrefs()) || {};
    projDefCache = p.projectDefaults || {};
    projPendCache = p.projectDefaultsPending || {};
  } catch { projDefCache = {}; projPendCache = {}; }
  return projDefCache;
}
function projectPending(folderId) {
  const v = projPendCache && folderId && projPendCache[folderId];
  return Array.isArray(v) ? v : [];
}
async function savePendingApply(folderId, keys) {
  const next = { ...(projPendCache || {}) };
  if (keys && keys.length) next[folderId] = keys; else delete next[folderId];
  try { await Researcher.setPref('projectDefaultsPending', next); projPendCache = next; }
  catch { /* best-effort bookkeeping: never turn a successful push into an error */ }
}
function projectDefaults(folderId) {
  return (projDefCache && folderId && projDefCache[folderId]) || null;
}
async function saveProjectDefaults(folderId, settings) {
  const next = { ...(projDefCache || {}) };
  if (settings && Object.keys(settings).length) next[folderId] = settings; else delete next[folderId];
  await Researcher.setPref('projectDefaults', next);
  projDefCache = next;
}

/* COWORKER NICKNAMES — the owner's own label for a person the server deliberately no longer names.
 *
 * ⚠ LOCAL BY DESIGN, not by omission. Held in the account prefs blob, which is encrypted under Kr
 * before it leaves the browser, so D1 stores ciphertext and the nickname names the coworker to THIS
 * researcher and to nobody else. Storing it server-side would rebuild in one hop exactly the
 * collaborator directory that dropping display_name/drive_email/avatar_url just removed. */
let nickCache = {};
async function loadNicks() {
  try { nickCache = ((await Researcher.getPrefs()) || {}).coworkerNames || {}; }
  catch { nickCache = {}; }
  return nickCache;
}
function memberNick(rid) { return (nickCache && nickCache[rid]) || ''; }
async function setMemberNick(rid, name) {
  const next = { ...(nickCache || {}) };
  if (name) next[rid] = name; else delete next[rid];
  await Researcher.setPref('coworkerNames', next);
  nickCache = next;
}

function releaseNotesLink() {
  if (!RELEASES.length && !KNOWN_ISSUES.length) return '';
  return `<button class="link-btn rp-known" data-act="known">${esc(t('panel.rel.btn'))}</button>`;
}
function releaseNotesModal() {
  // One section per release, newest first — a version heading with its date, then its changes.
  // An item resolving a submitted GitHub issue links to it (repo is public); target=_blank so the
  // panel session survives the visit.
  const item = (it) => `<li>${esc(t(it.k))}${it.issue
    ? ` <a class="rp-rel-issue" href="${ISSUES_URL}${it.issue}" target="_blank" rel="noopener">#${it.issue}</a>` : ''}</li>`;
  const relDate = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const rel = (r, i) => `<h4 class="rp-rel-h">${esc(r.v)}${i === 0
      ? ` <span class="rp-badge rp-badge-ok">${esc(t('panel.rel.latest'))}</span>` : ''}
      <span class="note rp-rel-date">${esc(relDate(r.date))}</span></h4>
    <ul class="rp-known-list">${r.items.map(item).join('')}</ul>`;
  modal(`<h3>${esc(t('panel.rel.title'))}</h3>
    <p class="note">${esc(t('panel.rel.version', { v: ENGINE_VERSION }))}${
      onStagingEstate() ? ' ' + esc(t('panel.rel.isTestBuild')) : ''}</p>
    ${KNOWN_ISSUES.length ? `<h4 class="rp-rel-h">${esc(t('panel.rel.knownTitle'))}</h4>
      <ul class="rp-known-list">${KNOWN_ISSUES.map((k) => `<li>${esc(t(k))}</li>`).join('')}</ul>
      <p class="note">${esc(t('panel.rel.prioritise'))}</p>` : ''}
    ${RELEASES.map(rel).join('')}
    <div class="modal-actions"><button class="primary-btn" data-m="cancel">${esc(t('panel.help.close'))}</button></div>`);
}

function wire(sel, ev, fn) { const el = root.querySelector(sel); if (el) el.addEventListener(ev, fn); }
function wireActs(handlers) {
  root.querySelectorAll('[data-act]').forEach((el) => {
    let fn = handlers[el.dataset.act];
    if (!fn && el.dataset.act === 'help') fn = showPanelHelp;   // the header help button is universal
    // …and so is Release notes: the header renders in several views, and a link that works in one of
    // them is worse than no link. Not estate-gated — the notes belong on production too (v494).
    if (!fn && el.dataset.act === 'known') fn = releaseNotesModal;
    /* …and so is copy-my-id. A <button> rather than a span with a click handler, so Enter and Space
     * work without inventing key handling, and screen readers announce it as an action.
     * ⚠ The clipboard can refuse (insecure context, permissions) — the same shape as the Account
     * modal's Copy ID, and the same fallback: the id is on screen with user-select:all, so a refusal
     * silently leaves manual selection working rather than claiming a copy that did not happen. */
    if (!fn && el.dataset.act === 'copyid') {
      fn = async () => {
        try {
          await navigator.clipboard.writeText(Researcher.currentAccountId() || '');
          deps.toast(t('panel.account.ridCopied'), 3000);
        } catch { /* refused — the text is selectable on screen */ }
      };
    }
    /* ⚠ EXACTLY ONE LISTENER PER ELEMENT, and the LAST wireActs call wins.
     *
     * renderDashboard calls wireActs TWICE — once on the loading shell it paints immediately, then
     * again on the real dashboard — and when the second pass meets a header button the re-render did
     * not replace, a bare addEventListener left TWO listeners on it. One click then ran the handler
     * twice: two stacked identical modals, of which closing one revealed the other. That is what
     * "the close button doesn't seem to work" actually was (Seth, v494) — the button worked; there
     * was a second dialog behind it.
     *
     * Replacing rather than skipping is deliberate: the loading shell binds a SMALLER handler map
     * than the finished dashboard, so the later, richer binding must be the one that survives. */
    if (fn) {
      if (el.__fxAct) el.removeEventListener('click', el.__fxAct);
      el.__fxAct = () => fn(el);
      el.addEventListener('click', el.__fxAct);
    }
  });
}

// Researcher documentation (incl. the honest Security section) — lives HERE in the panel,
// not in the field app's help. The help.html string is trusted static i18n markup.
function showPanelHelp() {
  const m = modal(`<div class="rp-help">${t('panel.help.html')}</div>
    <button class="primary-btn" data-m="close">${esc(t('panel.help.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
}
/* ⚠ A DISABLED BUTTON READS AS BROKEN, NOT AS BUSY (Seth, 2026-08-18: an action "does take a while
 * for the UI to update… that could be alarming to a user"). Every panel action is a network round
 * trip on a field connection, and greying the label out is indistinguishable from a dead control.
 * The class keeps the label — so the row neither reflows nor loses its meaning — and animates, which
 * is the part that says "working" rather than "refused". */
/* ⚠ A GRAYED SCREEN WITH A SPINNER, for anything that opens a modal after a round-trip (Seth,
 * 2026-09-01: "the UI exhibits some kind of response … for any modal that doesn't instantly pop up.
 * The user needs to know not to click it again", then "I want the loading spinner with the grayed
 * screen before the modal loads").
 *
 * ⚠ IT BLOCKS THE SECOND CLICK, which a toast does not. On a slow link the instinct is to press
 * again, and a second Settings press means a second full listView — the scrim makes that physically
 * impossible rather than merely discouraged.
 *
 * ⚠ DELAYED BY DESIGN. Shown immediately it would strobe on every fast action; most complete well
 * inside the delay and should look instant. Nothing appears unless the wait is long enough to notice.
 *
 * ⚠ WHY THIS IS NOT OPTIONAL POLISH (Seth): "we're dealing with Google Drive and … Indonesian
 * internet, things won't always be instant." Speed is worth chasing, but it can never be promised;
 * an acknowledgement can.
 *
 * ⚠ z-index sits BELOW the modal layer (40) on purpose: the modal covers the scrim when it opens, so
 * removing the scrim afterwards cannot flash a bare page between the two. */
function loadingScrim(delayMs = 200) {
  let el = null;
  const timer = setTimeout(() => {
    el = document.createElement('div');
    el.className = 'rp-loading';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `<div class="rp-loading-card"><div class="rp-spinner" aria-hidden="true"></div><p>${esc(t('panel.loading'))}</p></div>`;
    document.body.appendChild(el);
  }, delayMs);
  return () => { clearTimeout(timer); if (el) el.remove(); };
}

async function busy(btn, fn) {
  if (!btn) return fn();
  const old = btn.textContent; btn.disabled = true; btn.classList.add('rp-busy');
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove('rp-busy'); btn.textContent = old; }
}
function errToast(e) {
  /* The freeze refusal is not an error to garble into panel.err: it names a deliberate operator
   * state, and the server message says why. Long duration — the person just lost a click's work. */
  if (e && e.message === 'maintenance_freeze') {
    const msg = (e.data && e.data.message) || Researcher.freeze() || '';
    deps.toast(t('panel.freeze.refused', { msg }), 10000);
    return;
  }
  deps.toast(t('panel.err', { msg: (e && e.message) || String(e) }), 6000);
}

/* a body-level overlay modal: closes on backdrop click or Escape, moves focus in,
 * traps Tab, and restores focus on close. Returns { el, close }. */
/* In-app replacement for window.confirm() (Seth, 2026-08-31: "Can we use modals instead of
 * native-state dialogs?"). A native confirm() BLOCKS the renderer — it froze three revoke clicks in
 * a row during live testing, it can't be styled or translated consistently, and its buttons say
 * whatever the browser likes. This one rides the existing modal(): Escape/backdrop resolve false
 * (the safe answer), OK resolves true. Await it: `if (!await confirmModal(msg)) return;`. */
/* Centered spinner + text for anything that is waiting on the network (Seth, 2026-08-31: the wait
 * left after un-caching the panel is the real one — D1 and Drive — "we can at least make it look
 * less janky while it waits"). role=status so screen readers announce the wait once, politely. */
function loadingHtml(key, inModal) {
  return `<div class="rp-loading${inModal ? ' rp-loading-modal' : ''}" role="status" aria-live="polite">
    <div class="rp-loading-spin" aria-hidden="true"></div>
    <div class="note">${esc(t(key))}</div></div>`;
}

function confirmModal(message) {
  return new Promise((resolve) => {
    const m = modal(`
      <p style="white-space:pre-wrap">${esc(message)}</p>
      <button class="primary-btn" data-m="ok">${esc(t('panel.confirm.ok'))}</button>
      <button class="link-btn" data-m="cancel">${esc(t('panel.confirm.cancel'))}</button>`,
      false, () => resolve(false));
    m.el.querySelector('[data-m="ok"]').onclick = () => { resolve(true); m.close(); };
    m.el.querySelector('[data-m="cancel"]').onclick = () => m.close();
  });
}

function modal(innerHtml, wide, onClose) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-card${wide ? ' help-modal' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(wrap);
  const prevFocus = document.activeElement;
  const focusables = () => Array.from(wrap.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'));
  // onClose fires on EVERY close path (button, backdrop, Escape) — callers use it to release resources
  // (e.g. destroy WaveSurfer players + revoke object URLs in the converter).
  /* ⚠ IDEMPOTENT, and that is load-bearing now that data-m="cancel" is wired BELOW as well as by most
   * callers by hand. Without the guard those two paths would both fire, and `onClose` runs twice —
   * which for the converter modal means destroying WaveSurfer players and revoking object URLs a
   * second time. Closing an already-closed modal is a no-op, not a second teardown. */
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true); wrap.remove();
    try { onClose && onClose(); } catch { /* noop */ } try { prevFocus && prevFocus.focus(); } catch { /* noop */ }
  };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {                       // simple focus trap
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  /* ⚠ data-m="cancel" IS WIRED HERE, not left to each caller. Escape and the backdrop were handled;
   * the CANCEL BUTTON was not, so a modal whose author forgot the one-line
   * `m.el.querySelector('[data-m="cancel"]').onclick = m.close` shipped with a dead Close button —
   * which is exactly what the release-notes modal did, and it took a user to notice. Most callers
   * still wire it themselves and that is now harmless redundancy, because close() is idempotent. */
  /* BOTH dismissal conventions. The panel grew two names for one act — data-m="cancel" and
   * data-m="close" — and wiring only the first would have left the same dead-button hole open under
   * the other name. Action buttons (save, clear, ok) are deliberately NOT bound: those DO something
   * and their callers decide whether the modal survives it. */
  wrap.querySelectorAll('[data-m="cancel"], [data-m="close"]').forEach((b) => b.addEventListener('click', close));
  setTimeout(() => { const f = focusables()[0]; if (f) { try { f.focus(); } catch { /* noop */ } } }, 0);
  return { el: wrap, close };
}

/* ---------------- dashboard ---------------- */

function fmtFp(hex) { return (hex || '').replace(/(.{4})/g, '$1 ').trim(); }
async function fpOf(pubkeyB64) {
  try { return fmtFp(await publicKeyFingerprint(await importPublicKeyB64(pubkeyB64))); } catch { return '—'; }
}
function lastSeen(ts) {
  if (!ts) return t('panel.inst.never');
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return t('panel.inst.now');
  if (mins < 60) return t('panel.inst.minsAgo', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('panel.inst.hrsAgo', { n: hrs });
  return t('panel.inst.daysAgo', { n: Math.round(hrs / 24) });
}

// Auto-refresh: a researcher with no refresh button (and possibly several windows
// open) shouldn't have to reload to see a device claim an invite or report back.
// While the dashboard shows, poll the worker and silently re-render ONLY when the
// meaningful state changed — never while a dialog is open (don't yank the DOM), and
// never on heartbeat-only churn (last_seen excluded from the signature).
function stopDashPoll() { if (dashPoll) { clearInterval(dashPoll); dashPoll = null; } }
function startDashPoll() { if (!dashPoll) dashPoll = setInterval(pollDashboard, 12000); }

// Stable signature of what the tiles actually show — excludes volatile fields
// (last_seen_at / ack_seq / *_rev) so a device heartbeat doesn't force a re-render.
function viewSig(data) {
  try {
    return JSON.stringify([
      (data.instances || []).map((it) => [
        it.instance_id, it.nickname, it.type,
        (it.installs || []).map((ins) => [
          ins.install_id, ins.status, ins.accepted, ins.has_key, ins.wipe_state,   // wipe_state → re-render on wipe pending/confirmed
          ins.inventory && ins.inventory.ua, ins.inventory && JSON.stringify(ins.inventory.cachedApps),  // re-render when the device's browser/app version changes
          ins.inventory && ins.inventory.engineVersion,  // re-render when the true running engine version changes (brick/stale signal)
          ins.inventory && Array.isArray(ins.inventory.items)
            // uploadedFileId IS part of the signature: a re-send of an unchanged doc keeps uploadState
            // 'uploaded' but mints a new file id, and that's our only signal the re-upload landed.
            ? ins.inventory.items.map((d) => [d.id, d.title, d.uploadState, d.hasAudio, d.uploadedFileId, d.done, d.pendingDelete])
            .concat([[ins.inventory.platform || '']])
            : null,
        ]),
      ]),
      (data.pending || []).map((p) => [p.researcher_id, p.email]),   // owner: re-render when a request lands
      /* ⚠ CLIENT-SIDE PENDING STATE IS PART OF WHAT THE TILES SHOW (v339). This signature decides
       * whether the 12s poll re-renders, and it used to be built from SERVER data alone — so a
       * marker set while the device was offline changed nothing the signature could see, the poll
       * concluded "nothing to redraw", and the pending row simply never appeared. Seth: assigned
       * texts and their status refresh "a little slow and not always automatic".
       *
       * That is worst in exactly the case the markers exist FOR: an offline device produces no
       * server-side change at all, so the row that says "waiting for the device" was the one row
       * guaranteed not to be drawn. Sorted by key so Map insertion order cannot make an unchanged
       * state look changed and cause a redraw every tick. */
      [...pendingCmds].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([id, p]) => [id, p.kind, p.seq]),
      /* ⚠ THE SHARED PENDING STATE IS PART OF THE SIGNATURE TOO, for exactly the reason the local
       * markers are. A command issued in ANOTHER browser changes no field this signature otherwise
       * reads — the device is offline, so no inventory moves — and the tick concluded "nothing to
       * redraw". That is the case this whole feature exists to cover, so leaving it out made the
       * propagation arrive only when some unrelated fact happened to change (Seth: "auto propagates
       * within a minute or two", "frequently requiring a manual refresh"). */
      [...serverPending].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, p]) => [k, p.kind, p.seq]),
      [...pendingMoves].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([id, mv]) => [id, mv.stage]),
      /* ⚠ THE MAINTENANCE NOTICE, AND THIS IS THE THIRD TIME THIS TRAP HAS BEEN SPRUNG. The two
       * comments above record the same bug for local pending markers (v339) and for shared pending
       * state: a piece of state the dashboard RENDERS was not in this signature, so the poll
       * concluded "nothing to redraw" and the change only appeared on a manual refresh.
       *
       * It happened again the moment a banner was added, and it invalidated a claim made out loud —
       * "appears within one 12s tick" was simply false; Seth: "it doesn't auto refresh at all. It
       * changes when I push the refresh button."
       *
       * THE RULE, since three occurrences is a pattern and not bad luck: anything renderDashboard
       * reads that is NOT part of `data` must be added here in the same commit that renders it.
       * The signature is not a performance detail — it is the list of everything the panel is
       * allowed to notice. */
      Researcher.maintenance(),
      Researcher.freeze(),   // the write-lock banner is rendered state too — same rule as the notice
      /* MEMBER PROJECTS are rendered state (2026-08-27) — the fourth time the rule above earns its
       * keep, this time BEFORE the bug shipped: a coworker renaming a device, a new install
       * appearing, a report landing — all change what the joined section shows, and none of it
       * would redraw without these entries. Same fields the owner cards key on. */
      (data.memberProjects || []).map((mp) => [
        mp.project_id, mp.name, JSON.stringify(mp.caps || {}),
        (mp.instances || []).map((it) => [
          it.instance_id, it.nickname, it.type, it.hasKey,
          (it.installs || []).map((ins) => [
            ins.install_id, ins.status, ins.accepted, ins.has_key, ins.wipe_state,
            ins.inventory && ins.inventory.engineVersion,
            ins.inventory && Array.isArray(ins.inventory.items)
              ? ins.inventory.items.map((d) => [d.id, d.title, d.uploadState, d.hasAudio, d.done])
              : null,
          ]),
        ]),
      ]),
      /* ⚠ THE ESTATE DOES NOT RIDE THE 12s POLL — read this before trusting the two lines below.
       *
       * `renderDashboard` refetches `estateCache` only on a FULL render (initial load, manual
       * Refresh, or after an action); the poll passes `prefetched` and deliberately skips the Drive
       * round trip. So on the poll path these entries CANNOT change, and adding them here does not
       * make a migration appear on its own — a claim I made out loud and which was simply wrong.
       *
       * What actually refreshes the card after a migration is `estateSettle` + a render from the
       * settled estate, above. These lines are kept because they cost nothing and are correct the
       * moment anything else mutates `estateCache` between renders — but they are NOT the mechanism,
       * and a future reader must not conclude from their presence that the poll is watching.
       *
       * Only the SHAPE goes in, never the text list: that would redraw the dashboard on every
       * upload. */
      currentProject,   // which project is on screen — render state, not part of `data`
      ((estateCache && estateCache.projects) || []).map((p) => [p.folderId, p.name]),
      ((estateCache && estateCache.devices) || []).map((d) => [d.folderId, d.projectId || '']),
    ]);
  } catch { return String(Math.random()); } // unserializable → treat as changed
}

async function pollDashboard() {
  if (!root || root.hidden || !Researcher.isUnlocked()) { stopDashPoll(); return; } // left the dashboard
  if (document.hidden || document.querySelector('.modal')) return;                   // backgrounded / dialog open
  if (liveTick++ % 10 === 0) refreshLiveVersions();                                  // refresh the LIVE-version banner ~every 2 min (12s×10), in place
  let data;
  try { data = await Researcher.listView(); }
  catch (e) {
    /* ⚠ A 401 IS NOT TRANSIENT, and swallowing it left a panel whose session had been revoked
     * repainting a fully interactive dashboard from `lastData` — every button live, every action
     * failing with a bare status-code toast. Revoking a session from another browser is supposed to
     * END that session, so the poll needs the same branch renderDashboard already has. */
    if (e && e.status === 401) { stopDashPoll(); Researcher.purgeLocal(); renderSignIn(t('panel.signin.expired')); }
    return;                                                                        // else transient; next tick retries
  }
  if (root.hidden || document.querySelector('.modal')) return;                       // re-check after the await
  await refreshServerPending(allActionableInstances(data));   // shared pending state (own + shared devices), before anything renders
  if (root.hidden || document.querySelector('.modal')) return;                       // and again after ITS awaits
  if (viewSig(data) !== lastSig) renderDashboard(data);
}

// Parse a reported userAgent into a short "Browser NN · OS" for the device tiles. The UA is
// attacker-controllable (a field device out of the team's control), but this only pulls a browser name + digits + a fixed OS
// label, and the result is esc()'d at every call site — no raw UA reaches the DOM.
function parseUA(ua) {
  if (!ua || typeof ua !== 'string') return '';
  let b = 'browser', m;
  if ((m = ua.match(/Firefox\/(\d+)/))) b = 'Firefox ' + m[1];
  else if ((m = ua.match(/Edg\/(\d+)/))) b = 'Edge ' + m[1];
  else if ((m = ua.match(/OPR\/(\d+)/))) b = 'Opera ' + m[1];
  else if ((m = ua.match(/Chrome\/(\d+)/))) b = 'Chrome ' + m[1];
  else if (/Safari/.test(ua) && (m = ua.match(/Version\/(\d+)/))) b = 'Safari ' + m[1];
  let os = '';
  if ((m = ua.match(/Android (\d+)/))) os = 'Android ' + m[1];
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod|iOS/.test(ua)) os = 'iOS';
  else if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? b + ' · ' + os : b;
}
// One tile's device line + a staleness verdict. The PRIMARY version is the TRUE running engine
// (engineVersion, reported from inside the running code) — NOT the cache name, which a stale-body
// precache can make lie (the Firefox-Utilities bug). cachedApps' recorder/researcher shell versions
// ride along as secondary detail. stale = the running engine is BEHIND the live site, or the client is
// so old it reports no engineVersion at all (both mean "this device needs to update / may be stuck").
// All values are attacker-controllable (a device out of the team's control) → esc'd at every call site.
// Each shell is a SEPARATE storage sandbox (own IndexedDB, own enrollment) even when several load
// the same URL — so the same person on a PWA and an APK is legitimately two devices here. Showing
// the platform first is what makes that comprehensible instead of looking like a duplicate.
const PLATFORM_KEY = {
  'web': 'panel.dev.platWeb',
  'android-recorder': 'panel.dev.platAndroidRec',
  'android-editor': 'panel.dev.platAndroidEd',
  'windows': 'panel.dev.platWindows',
};

/* CONFIRMED staleness — do not cry wolf on every release.
 *
 * A device is briefly "behind" after every deploy: service workers update on the next load, so an
 * instant warning would fire for every install after every push and train the researcher to ignore
 * the badge — which is worse than having no badge, because it burns the one signal that a genuinely
 * bricked device would raise.
 *
 * So a mismatch must be confirmed across TWO DISTINCT REPORTS separated by STALE_CONFIRM_MS. The
 * separation is measured on the DEVICE's report timestamps, not on wall clock, or simply leaving the
 * panel open for six hours would "confirm" staleness from a single report.
 *
 * The timer resets if the device's engine version CHANGES while still behind: a device that is
 * moving is lagging, not stuck, and only stuck is worth an alarm.
 *
 * Clears itself the moment a device reports the current version.
 *
 * 6h: propagation is minutes (editor Pages ~30s, satellites ~90s), so this is generous padding,
 * while still surfacing a genuinely stuck device inside a day. Watch state lives in this
 * researcher's own localStorage; losing it only restarts the timer.
 */
const STALE_CONFIRM_MS = 6 * 60 * 60 * 1000;
const STALE_WATCH_KEY = 'flextext-rp-stale-watch';

function staleWatchRead() {
  try { return JSON.parse(localStorage.getItem(STALE_WATCH_KEY) || '{}') || {}; }
  catch { return {}; }
}
function staleWatchWrite(w) {
  try { localStorage.setItem(STALE_WATCH_KEY, JSON.stringify(w)); } catch { /* quota — non-critical */ }
}

/** @returns true only when this install has been behind across two reports >= STALE_CONFIRM_MS apart.
 *  Exported ONLY so the test suite can drive this function itself rather than a copy of its logic —
 *  a copied test passes while the real path is broken. Not part of the panel's public surface. */
export function staleConfirmed(installId, reportedAt, behind, runningVer, unknown) {
  const w = staleWatchRead();
  if (!installId) return behind;                 // nothing to track by — fail toward showing it
  /* ⚠ "WE CANNOT TELL" IS NOT "NOT BEHIND". liveVersions is null whenever the live-version check is
   * offline or has not run yet, which made `behind` false and fell into the branch below that
   * DELETES the record — throwing away a confirmation clock that may have been running for hours,
   * every time the network hiccuped. Leave the record alone and report only what it has already
   * proved. (Paired with the install_id fix above: this whole path had never actually run, because
   * the caller passed a field that does not exist and every call returned at the line above.) */
  if (unknown) {
    const seen = w[installId];
    return !!seen && (seen.last - seen.first) >= STALE_CONFIRM_MS;
  }
  if (!behind) {                                 // resolved: drop the record so the badge disappears
    if (w[installId]) { delete w[installId]; staleWatchWrite(w); }
    return false;
  }
  const ts = Date.parse(reportedAt) || Number(reportedAt) || Date.now();
  const e = w[installId];
  if (!e || e.ver !== runningVer) {              // first sighting, or it moved — (re)start the clock
    w[installId] = { first: ts, last: ts, ver: runningVer };
    staleWatchWrite(w);
    return false;
  }
  if (ts > e.last) { e.last = ts; staleWatchWrite(w); }
  return (e.last - e.first) >= STALE_CONFIRM_MS;
}

function deviceInfo(ua, cachedApps, engineVersion, platform, installId, reportedAt) {
  const segs = [];
  const pk = PLATFORM_KEY[platform];
  if (pk) segs.push(t(pk));
  else if (platform) segs.push(platform);          // unknown native shell — show it raw, don't hide it
  const b = parseUA(ua); if (b) segs.push(b);
  const eng = engineVersion || (cachedApps && cachedApps.editor);   // true running engine, or cache-name fallback
  if (eng) segs.push(t('panel.dev.engine', { v: eng }));
  if (cachedApps && typeof cachedApps === 'object') {
    if (cachedApps.recorder) segs.push('recorder ' + cachedApps.recorder);
    if (cachedApps.researcher) segs.push('researcher ' + cachedApps.researcher);
  }
  const live = liveVersions && liveVersions.engine;
  let stale = false;
  if (!engineVersion && !(cachedApps && cachedApps.editor)) stale = true;        // pre-feature client → definitely old
  else if (live && eng && eng !== live) stale = true;                            // running engine behind the live site
  // Confirm across two reports before alarming (see STALE_CONFIRM_MS). A client so old it reports no
  // version at all is NOT put through the timer: that is not a propagation delay, it is a client from
  // before the field existed, and it is already definitively behind.
  const known = !!(engineVersion || (cachedApps && cachedApps.editor));
  // `live` unknown ⇒ we cannot judge a device that DID report a version; say so rather than
  // letting a failed live check read as "up to date".
  const confirmed = known ? staleConfirmed(installId, reportedAt, stale, eng, !live) : stale;
  return { text: segs.join(' · '), stale: confirmed, behindNow: stale, running: eng, live };
}
/* ⚠ THERE IS NO panelCachedApps() ANY MORE, and it must not come back in that form.
 *
 * It read `caches.keys()` to report which sibling apps this device had installed. That worked only
 * because the old estate put all four apps on ONE origin (rulingants.github.io): the Cache Storage
 * API is ORIGIN-SCOPED, so from research.flextext.app it can never see app.flextext.app's caches.
 * After the Cloudflare migration it silently reported nothing for the editor and the recorder — not
 * an error, not a stale number, just segments that stopped appearing. Seth saw the versions were
 * "out of sync" and was right about the cause.
 *
 * deviceInfo() itself is FINE and is still used for real devices (renderInstanceCard): there the
 * cachedApps come from the device's OWN inventory report, enumerated on its own origin, where the
 * question is answerable. Only asking it about THIS browser was broken.
 *
 * If a researcher's own installed-app versions are ever wanted again, they must be reported the way
 * a device reports them — from inside each app — never sniffed across origins. */

// LIVE (cache-busted) versions currently deployed on the site — the reference the researcher compares
// devices against (a device reporting an OLDER version, or stale + not reporting, may be stuck/bricked).
// null = the site is unreachable (researcher offline). The ?live= query forces a SW cache miss → network.
let liveVersions = undefined;  // undefined = not yet checked
async function fetchLiveVersion(path) {
  try {
    const r = await fetch(path + '?live=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    const m = (await r.text()).match(/const VERSION = '([^']+)'/);
    return m ? m[1] : null;
  } catch { return null; }
}
/* THE ENGINE NUMBER, AND ONLY IT (Seth, 2026-08-28: "we are actually OK with just the engine
 * number... on productionWeb at least they will all consistently deploy together").
 *
 * The three per-app numbers were an artifact of the SATELLITE-REPOS era, when each app shipped from
 * its own repo and could genuinely lag the others. A productionWeb push now deploys all five apps
 * together, so on the estate this banner exists for they cannot disagree.
 *
 * ⚠ AND THE THREE NUMBERS ASKED THE WRONG QUESTION. A device reports `engine vNNN` — that is the
 * vocabulary of every device card below this banner, and it is what staleness is judged on
 * (deviceInfo compares the device's `eng` against this value). Printing app versions invited the
 * researcher to compare two things that were never the same quantity. The editor's sw.js VERSION IS
 * the engine version — bump-version.sh keeps them equal and test/version-sync.test.mjs fails the
 * release if they drift — so ONE fetch answers the only question this banner is for: is a production
 * app failing to auto-update?
 *
 * ⚠ ON STAGING THIS READS AHEAD OF PRODUCTION, and the badge carries a BUILD_TAG feature name. That
 * is expected and is not a fault to report; the tag is cleared when the release goes to production. */
async function refreshLiveVersions() {
  // The panel reports on ITS OWN estate — mixing the two would show a version nobody is running.
  const engine = await fetchLiveVersion(HOME.editor + 'sw.js');
  liveVersions = engine == null ? null : { engine };
  paintLiveVersions();
}
function liveVerText() {
  if (liveVersions === undefined) return t('panel.live.checking');
  if (liveVersions === null) return t('panel.live.offline');
  return t('panel.live.latest', { v: liveVersions.engine });
}
function paintLiveVersions() {
  const el = root && root.querySelector('#rp-live-ver');
  if (!el) return;
  el.textContent = liveVerText();   // versions come from our OWN site's sw.js (not attacker data); textContent regardless
  el.className = 'rp-live' + (liveVersions === null ? ' rp-live-offline' : '');
}

async function renderDashboard(prefetched) {
  /* ⚠ A DASHBOARD ALREADY ON SCREEN IS REFRESHED IN PLACE, never through the loading screen. The
   * loading repaint below wipes the whole panel to a one-line note BEFORE the network round trip —
   * and the browser clamps the scroll offset against that near-empty layout, so any action taken on
   * a text near the bottom of a long list bounced the researcher back to the top (Seth, 2026-08-14:
   * "bounces back to the top after a change made to a text on the bottom"). The 12s poll path
   * (`prefetched`) never had this bug, because it replaces `.rp-body` in one task with the data
   * already in hand — so a full render simply borrows that shape when there is old content worth
   * keeping: leave it up while fetching, then swap. `.rp-metrics` is the marker: it exists exactly
   * when a dashboard (not sign-in, not an error screen) is what is showing. The scroll offset is
   * still captured and restored across the swap, because the swap replaces `.rp-body` wholesale and
   * "nearly where I was" is lost when every card looks alike. */
  const inPlace = !prefetched && !!root.querySelector('.rp-metrics');
  const scroller = (() => {
    for (let n = root.querySelector('.rp-body'); n; n = n.parentElement) {
      const ov = n instanceof Element ? getComputedStyle(n).overflowY : '';
      if (ov === 'auto' || ov === 'scroll') return n;
    }
    return document.scrollingElement || document.documentElement;
  })();
  const keepTop = inPlace && scroller ? scroller.scrollTop : null;
  if (!prefetched && !inPlace) {
    root.innerHTML = header('panel.title', true) + `<div class="rp-body">${loadingHtml('panel.dash.loading')}</div>`;
    wireActs({ exit: close, lock: () => { Researcher.signOut(); route(); } });
  }
  let data = prefetched;
  if (!data) {
    try { data = await Researcher.listView(); }
    catch (e) {
      if (e && e.status === 401) { Researcher.purgeLocal(); return renderSignIn(t('panel.signin.expired')); }   // session gone/deleted → wipe researcher-console local data
      // Transient: keep the poll running (it recovers on the next good tick) and show "reconnecting"
      // instead of a dead error screen — a field network drop must not strand the dashboard.
      startDashPoll();
      root.querySelector('.rp-body').innerHTML = `<p class="banner warn-banner">${esc(t('panel.conn.reconnecting'))}</p><button class="secondary-btn" data-act="retry">${esc(t('panel.dash.retry'))}</button>`;
      wire('[data-act="retry"]', 'click', () => renderDashboard());
      return;
    }
  }

  lastData = data; lastDataAt = Date.now();   // cache for an instant local re-render after an action (no refetch)
  const insts = data.instances || [];
  loadPending(Researcher.currentAccountId());
  await loadMoves(Researcher.currentAccountId());
  await loadTtl(Researcher.currentAccountId());
  /* ⚠ EVERY render re-derives the shared pending state, not just the 12s poll. An action-driven
   * re-render (cancel, upload, delete) happens between ticks, and leaving serverPending untouched
   * meant the row it just changed redrew from the PREVIOUS tick's state — the cancelled delete kept
   * its strikethrough and its Cancel button until something else forced a refresh. Cheap: the blob
   * is cached by desired_rev, so this is a no-network re-filter unless the server actually moved. */
  await refreshServerPending(allActionableInstances(data));   // own + shared devices (see the helper)
  // Advance in-flight moves on every poll (a stage transition is visible in exactly one report —
  // same reasoning as the History observer): destination reports the doc → fire the upload-first
  // remove at the source (AUTOMATIC, Seth's decision); source no longer reports it → move done.
  {
    const transitions = [];                      // applied to the account copy in ONE locked write
    for (const [docId, mv] of pendingMoves) {
      if (mv.stage === 'assigned' && findInventoryItem(mv.to, docId)) {
        /* ⚠ EVERY panel advances moves now, so check the source is not ALREADY being told to remove
         * this text before telling it again. Two panels polling in the same second would otherwise
         * queue two uploadDelete commands, and uploadDelete uploads a fresh copy before deleting —
         * so the duplicate is a wasted upload on a field connection, not just a redundant command. */
        if (pendingFor(docId, mv.from)) continue;
        try {
          const r1 = await Researcher.uploadDelete(mv.from, docId);
          pendingCmds.set(docId, { seq: r1.seq, kind: 'delete', instanceId: mv.from, at: Date.now() });
          savePending(Researcher.currentAccountId());
          transitions.push(['removing', docId]);
        } catch { /* transient — retried next poll */ }
      /* ⚠ ABSENT-BECAUSE-UNREADABLE IS NOT ABSENT-BECAUSE-REMOVED. findInventoryItem returns null
       * just as readily when the source instance was revoked, or its report could not be decrypted,
       * as when the text really is gone — and this branch declares the move COMPLETE and toasts so.
       * Require the source to have actually reported something first (the same guard history.js
       * uses before it will emit a deletion event). */
      } else if (mv.stage === 'removing' && instanceReported(mv.from) && !findInventoryItem(mv.from, docId)) {
        transitions.push(['done', docId]);
        deps.toast(t('panel.move.done', { title: mv.title || '?' }), 6000);
      }
    }
    if (transitions.length) {
      await saveMoves((cur) => {
        for (const [what, docId] of transitions) {
          if (what === 'done') delete cur[docId];
          else if (cur[docId]) cur[docId].stage = 'removing';
        }
        return cur;
      });
    }
  }
  loadCollapsed(Researcher.currentAccountId());
  // Retire pending markers on OUTCOME, never on a clock. A request stays visible for as long as it
  // is genuinely outstanding — which is the whole correction: the old timers made a still-queued
  // delete look forgotten while the command was alive on the server.
  {
    const live = new Map();                                   // docId -> its current inventory item
    for (const it of insts) for (const ins of it.installs || []) {
      const items = ins.inventory && Array.isArray(ins.inventory.items) ? ins.inventory.items : [];
      for (const d of items) if (d && d.id) live.set(d.id, d);
    }
    let changed = false;
    for (const [docId, p] of pendingCmds) {
      const d = live.get(docId);
      // A delete is done when the text is gone from every inventory. An upload is done when the
      // device reports a NEW file id — the same signal the History log uses.
      /* Each kind is retired by the inventory FACT that proves it happened — never by a clock
       * (v131). An assign is the mirror image of a delete: done the moment the text APPEARS in an
       * inventory. That is the same signal pendingMoves' 'assigned' stage already trusts. */
      const done = p.kind === 'delete'
        ? (d === undefined && ackOf(insts, p.instanceId) >= p.seq)
        : p.kind === 'assign'
          ? d !== undefined
          : !!(d && d.uploadedFileId && d.uploadedFileId !== p.prevFileId);
      /* ⚠ WITHDRAWN IN ANOTHER BROWSER — the mirror of the bug v388 fixed, and the half it missed
       * (Seth, 2026-08-18): "If I do an action on the first session it DOES propagate to the second
       * session, but then when I cancel on the second, the first doesn't register that the second
       * cancelled it." Right: the three outcomes above are all things the DEVICE does, and a cancel
       * performed elsewhere is not one of them, so the issuing browser's own localStorage marker
       * outlived the command it stood for — strikethrough and a Cancel button for something the
       * server no longer holds.
       *
       * The evidence is already in hand: serverSeqs is every seq still in that instance's blob. A
       * marker that still claims to be QUEUED (seq > ack, so the device cannot have consumed it)
       * whose seq is no longer there was withdrawn by somebody else.
       *
       * ⚠ Absence of the INSTANCE means "we could not read it", not "it is empty" — refreshServerPending
       * records an instance only when its fetch succeeded. Acting on a missing instance would clear
       * every marker in the panel on one dropped request. */
      const known = serverSeqs.get(p.instanceId);
      const withdrawn = !!known && p.seq > ackOf(insts, p.instanceId) && !known.has(p.seq);
      if (done || withdrawn) { pendingCmds.delete(docId); changed = true; }
    }
    if (changed) savePending(Researcher.currentAccountId());
  }
  // HISTORY: observe BEFORE rendering, and on every poll — not only on full renders. A text can be
  // assigned, uploaded and deleted between two full renders, and the deletion is only visible as
  // the one report where it goes present→absent. Miss that report and the tombstone is lost for
  // good. observeView never throws and diffs a repeated report to nothing, so calling it on the
  // 12s tick is both safe and necessary.
  observeView(Researcher.currentAccountId(), insts);
  let pending = 0, texts = 0;
  for (const it of insts) for (const ins of it.installs || []) {
    if (ins.status === 'pending') pending++;
    if (ins.inventory && Array.isArray(ins.inventory.items)) texts += ins.inventory.items.length;
  }

  // Crowd recorders ride FULL renders only (initial load / manual refresh / post-action), never the
  // 12s poll (worker load stays flat; viewSig excludes them). A fetch failure paints a reconnect
  // note inside the card — the rest of the dashboard must never be taken down by it.
  if (!prefetched && Researcher.isApprovedSelf()) {
    try { crowdCache = (await Researcher.crowdList()).recorders || []; } catch { crowdCache = null; }
    /* The Drive estate rides FULL renders only, never the 12s poll — it is a Drive round trip, and
     * the unassigned card changes on the timescale of a researcher removing a text, not seconds. */
    try { estateCache = await Researcher.driveEstate(); } catch { estateCache = null; }
    // Warm the crowd preview heads once this render is out of the way — see sweepCrowdPreviews.
    try { sweepCrowdPreviews(crowdCache, estateCache); } catch { /* never costs the render */ }
    sweepUnassigned(estateCache);
  }

  // deviceCount passed explicitly (not taken from map's array arg): it decides the collapse default.
  const cards = await Promise.all(insts.map((it) => renderInstanceCard(it, insts.length)));
  /* Tab scope is resolved BEFORE the template so the async pieces can be built for exactly the
   * layout that will render: a shared TAB's content when the tabbed layout has one selected, or
   * the flat layout's shared card sections when there is no strip to live in. Never both. */
  const scope = projectScope(insts, estateCache, crowdCache, data.memberProjects);
  const selMp = scope && isMemberTab(scope.sel)
    ? (data.memberProjects || []).find((m) => memberTabId(m.project_id) === scope.sel) : null;
  const memberTabContent = selMp ? await renderMemberProjectContent(selMp) : '';
  const joinedSections = scope ? '' : await renderJoinedSections(data);
  root.querySelector('.rp-body').innerHTML = `
    ${maintenanceBanner()}
    <div id="rp-live-ver" class="rp-live${liveVersions === null ? ' rp-live-offline' : ''}">${esc(liveVerText())}</div>
    <div class="rp-metrics">
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.devices'))}</div><div class="rp-metric-n">${insts.length}</div></div>
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.pending'))}</div><div class="rp-metric-n${pending ? ' rp-warn' : ''}">${pending}</div></div>
      <div class="rp-metric"><div class="rp-metric-l">${esc(t('panel.dash.texts'))}</div><div class="rp-metric-n">${texts}</div></div>
    </div>
    <div class="rp-actions">
      ${/* Refresh moved to the sticky header (Seth, 2026-09-01) — it is wanted from anywhere in a
           long dashboard, which is the same reason the header is sticky at all. */''}
      <span class="rp-spacer"></span>
      ${data.isOwner ? `<button class="link-btn rp-admin-btn" data-act="admin">${esc(t('panel.admin.btn'))}</button>` : ''}
      <button class="link-btn" data-act="storage">${esc(t('panel.store.btn'))}</button>
      ${/* ⚠ NOT gated on data.isOwner — that flag is the OPERATOR of this deployment (see isOperator
          in the worker), not the owner of a project, and gating on it would hide sharing from every
          researcher but the admin. The membership routes are owner-only server-side and answer 404
          to anyone else, so the button is safe to show and the modal reports what it finds. */''}
      <button class="link-btn" data-act="coworkers">${esc(t('panel.share.btn'))}</button>
      <button class="link-btn" data-act="history">${esc(t('panel.hist.btn'))}</button>
      <button class="link-btn" data-act="utilities">${esc(t('panel.util.btn'))}</button>
      <button class="link-btn" data-act="account">${esc(t('panel.dash.account'))}</button>
    </div>
    <div id="rp-aq"></div>
    ${(data.isOwner && (data.pending || []).length) ? `
    <div class="rp-card rp-pending-res">
      <div class="rp-inst-name">${esc(t('panel.pending.title', { n: data.pending.length }))}</div>
      <p class="note">${esc(t('panel.pending.intro'))}</p>
      ${data.pending.map((p) => `<div class="rp-install">
        <div class="invite-who">${p.avatar_url ? `<img class="invite-avatar" src="${esc(p.avatar_url)}" alt="" referrerpolicy="no-referrer" width="40" height="40">` : ''}<div><div class="invite-name">${esc(p.display_name || p.email || '?')}</div>${p.email ? `<div class="note">${esc(p.email)}</div>` : ''}</div></div>
        <div class="rp-inst-actions">
          <button class="primary-btn" data-ract="approve" data-rid="${esc(p.researcher_id)}">${esc(t('panel.pending.approve'))}</button>
          <button class="link-btn rp-revoke" data-ract="decline" data-rid="${esc(p.researcher_id)}">${esc(t('panel.pending.decline'))}</button>
        </div>
      </div>`).join('')}
    </div>` : ''}
    ${/* ⚠ THE "This device" CARD IS GONE (Seth, 2026-08-28: "It is confusing and unhelpful").
         It held one link — Open FlexText Editor — plus a note explaining that the link does NOT pair
         the editor, which existed because a new researcher clicked it, met an unlinked editor and
         reasonably read the link as broken (issue #3). A control that needs a paragraph disclaiming
         what it does not do is the wrong control: the card invited a pairing action it could not
         perform, at the top of the dashboard, where a first-time user reads first.
         Nothing is stranded by removing it — the editor is reachable by its own short URL, from
         flextext.app, and through any invite link the researcher makes (Seth). */''}
    ${renderProjectsCard(estateCache)}
    ${(() => {
      /* "+ New device" left the top actions bar (Seth, 2026-08-31: "It makes more sense there
       * [by the tabs]"). On tabbed layouts it rides the strip row itself — renderProjectSwitcher
       * owns it there. The FLAT layout has no strip, so it keeps this row at the top of the
       * device column. */
      const newDevBtn = `<div class="rp-newdev"><button class="primary-btn" data-act="new">${esc(t('panel.dash.newDevice'))}</button></div>`;
      /* ONE PROJECT AT A TIME once projects exist; the classic flat layout otherwise, byte for byte.
       * `scope` is null on a flat estate, which is the whole backward-compatibility story. */
      if (!scope) {
        return `${newDevBtn}${renderUnassignedCard(estateCache)}
          ${/* ⚠ THE EMPTY DASHBOARD SPEAKS ONLY TO OWNERS, AND A COWORKER'S FIRST SCREEN IS THIS ONE
               (Seth, 2026-08-28: "we do need clear documentation for how to send your ID # to a
               project owner who wants to add you… it's not very intuitive").
               "No devices yet. Add one to send an invite link to a field worker." tells someone
               joining a COLLEAGUE's project to do the one thing they did not come here to do, and
               says nothing about the one step that actually unblocks them. The ID, its copy button
               and a good explanation already exist — but they are inside Account, which a first-time
               user has no reason to open, so the instruction never reaches the person who needs it.
               Shown only when there is genuinely nothing here yet (no devices AND no shared project):
               once either exists, the person is oriented and this would be noise. */''}
          ${insts.length ? cards.join('') : `<p class="note rp-empty">${esc(t('panel.dash.empty'))}</p>
            ${((lastData && lastData.memberProjects) || []).length ? '' : `<p class="note rp-empty rp-empty-join">${esc(t('panel.dash.emptyJoin'))}
              <button class="link-btn" data-act="account">${esc(t('panel.dash.emptyJoinBtn'))}</button></p>`}`}
          ${Researcher.isApprovedSelf() ? renderCrowdCard(crowdCache, estateCache) : ''}
          ${joinedSections}`;
      }
      currentProject = scope.sel;                       // persist the resolved tab, not the stale one
      /* A shared tab replaces the WHOLE owned-content column: no Unassigned card (that is a Drive
       * view of the owner's estate), no crowd card, no owned device cards — the member sees exactly
       * what the owner shared, rendered from data.memberProjects and nothing else. */
      if (selMp) {
        return `${renderProjectSwitcher(scope)}
          ${memberTabContent}`;
      }
      const idx = new Map(insts.map((it, i) => [it.instance_id, i]));
      const mine = scope.insts.map((it) => cards[idx.get(it.instance_id)]).join('');
      return `${renderProjectSwitcher(scope)}
        ${scope.sel === STRAY_TAB ? '' : renderUnassignedCard(estateCache, scope.sel)}
        ${scope.insts.length ? mine : `<p class="note rp-empty">${esc(t('panel.proj.emptyProject'))}</p>`}
        ${/* ⚠ AN OWNED PROJECT ALWAYS GETS THE CROWD CARD, EMPTY OR NOT (Seth, 2026-08-31: "new
             projects I create do not have a crowd-recorder area… Looks like I can't add a crowd
             recorder to a new project I create"). The card was gated on scope.recs.length, i.e.
             on the project ALREADY having a recorder — so the only way to get the area was to
             already have one, which made the feature unreachable on every project made after the
             first, and on a new researcher's default project. renderCrowdCard has carried an
             empty state and its own "+ New crowd recorder" button all along; nothing but this
             condition was missing.
             The STRAY tab stays conditional: it is "not in a project yet", and an empty card
             there would invite creating a recorder that belongs to nothing. selProject is
             non-null only for a real owned project (projectScope), which is exactly the line. */''}
        ${(scope.selProject || scope.recs.length) && Researcher.isApprovedSelf() ? renderCrowdCard(scope.recs, estateCache) : ''}`;
    })()}`;

  wireActs({
    exit: close,
    lock: () => { Researcher.signOut(); route(); },
    new: () => newDeviceModal(),
    /* ⚠ A HARD REFRESH, AND VISIBLY SO (Seth, 2026-09-01: "doesn't seem like the refresh button is
     * doing anything at all… I think a hard refresh is what we want, the equivalent of
     * ctrl+shift+r, not just a soft refresh").
     *
     * It WAS working. renderDashboard() re-fetches, but the render is skipped when the view
     * signature is unchanged (lastSig) — so a refresh that found nothing new was pixel-identical to
     * a dead button. That is the worse failure: the researcher cannot tell "nothing changed" from
     * "nothing happened", so they press it again, and again.
     *
     * ⚠ IT ASKS THE SERVICE WORKER TO UPDATE FIRST, which is the half a plain reload misses. The
     * panel's own worker caches nothing, but the registration is what learns a new engine exists —
     * without update() a reload can serve the same version forever, which is exactly the "there's a
     * cache and that's easier" case.
     *
     * ⚠ GUARDED ON IN-FLIGHT TRANSFERS. `jobs` holds researcher-side downloads and uploads, and a
     * reload kills them mid-stream with no resume — on village bandwidth that can be an hour's work.
     * So a refresh during a transfer asks first, and the default is not to lose it. */
    refresh: async (el) => {
      const busyJobs = [...jobs.values()].filter((j) => j && !j.done).length;
      if (busyJobs && !await confirmModal(t('panel.dash.refreshBusy', { n: busyJobs }))) return;
      if (el) el.classList.add('rp-spin');
      const done = loadingScrim(0);   // no delay: a reload is coming, so the wait is the whole point
      try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); }
      catch { /* no worker, or update refused — reload anyway */ }
      finally { done(); location.reload(); }
    },
    admin: () => adminModal(),
    storage: () => storageModal(),
    coworkers: () => coworkersModal(),
    history: () => historyModal(),
    utilities: () => utilitiesModal(),
    account: () => accountModal(),
  });
  // per-card actions are delegated:
  wireDownloadMenus();
  root.querySelectorAll('[data-iact]').forEach((el) => el.addEventListener('click', () => instanceAction(el)));
  // Unassigned-card actions. Deliberately their OWN attribute, not data-iact: instanceAction()
  // assumes a real instance id on the element, and there is none here by design.
  root.querySelectorAll('[data-uact]').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.uact === 'collapse') {
      unassignedOpen = !unassignedOpen;
      renderDashboard(lastData || undefined);   // cached data — the estate has not changed
      return;
    }
    // busy(): the manifest check lists the folder first, so the button must not look dead meanwhile.
    /* ⚠ { unassign: true } is what makes the "Unassigned — <project>" destination tiles render at
     * all. Without it, moving a text that is ALREADY unassigned offered only devices — so a project
     * with no devices could not receive it, and a cross-project filing was impossible from this
     * card while the crowd row two lines down could do it (issue #12). Same modal, same flag. */
    if (el.dataset.uact === 'adopt') { busy(el, () => adoptTextModal(el.dataset.id, el.dataset.title || '', { unassign: true })); return; }
    /* Move… on a CROWD row — the SAME source-less flow the Unassigned card uses, because a crowd
     * recording is held by no device either. Destinations: any device, or Unassigned (Seth: "any
     * text anywhere, except to a crowd recorder"). It reaches a device through /adopt rather than
     * /move precisely because there is no source instance to name. */
    if (el.dataset.uact === 'cmove') {
      busy(el, () => adoptTextModal(el.dataset.id, el.dataset.title || '', { unassign: true }));
      return;
    }
    if (el.dataset.uact === 'drop') {
      busy(el, async () => {
        if (!await confirmModal(t('panel.store.deleteConfirm', { title: el.dataset.title || '?' }))) return;
        try {
          await Researcher.trashFiles([el.dataset.folder], 'panel delete');
          deps.toast(t('panel.store.deleted'), 5000);
          renderDashboard();
        } catch (e) { errToast(e); }
      });
    }
  }));
  root.querySelectorAll('[data-ract]').forEach((el) => el.addEventListener('click', () => researcherAction(el)));
  root.querySelectorAll('[data-cact]').forEach((el) => el.addEventListener('click', () => crowdAction(el)));
  /* Project actions: their OWN attribute, like the Unassigned card's, because none of them name
   * an instance — they act on the Drive tree itself. */
  root.querySelectorAll('[data-pact]').forEach((el) => el.addEventListener('click', () => {
    const act = el.dataset.pact;
    if (act === 'setup') { busy(el, () => projectsSetupModal()); return; }
    if (act === 'pick') {
      currentProject = el.dataset.p;
      renderDashboard(lastData || undefined);   // cached: switching tabs is not a Drive round trip
      return;
    }
    if (act === 'new') { projectNewModal(); return; }
    if (act === 'moveto') { projectAssignModal(el.dataset.folder, el.dataset.name || ''); return; }
    if (act === 'rename') { projectRenameModal(el.dataset.folder, el.dataset.name || ''); return; }
    // Upload a text into this project's Unassigned — no device (issue #4). Same modal as the
    // device's own upload, given a project instead of an instance.
    if (act === 'newtext') { assignModal({ projectFolderId: el.dataset.folder }); return; }
    if (act === 'delete') { projectDeleteModal(el.dataset.folder, el.dataset.name || ''); return; }
    /* ⚠ loadProjectDefaults() FIRST — openSettingsModal prefills SYNCHRONOUSLY from projectDefaults(),
     * so opening before the prefs have decrypted shows an empty form and a save would then wipe the
     * template the owner came to edit. */
    if (act === 'defaults') {
      busy(el, async () => {
        await loadProjectDefaults();
        openSettingsModal({ kind: 'project', project: { folderId: el.dataset.folder, name: el.dataset.name || '' } });
      });
      return;
    }
    if (act === 'leave') { leaveProjectModal(el.dataset.project, el.dataset.name || ''); }
  }));
  lastSig = viewSig(data);
  // Fire-and-forget, after the paint it must never delay. Full renders force a pass — a device
  // created moments ago gets its member grants NOW, not next session (see memberGrantSweep).
  memberGrantSweep(!prefetched);
  // Same placement and contract: after the paint, never blocking it.
  deliverPendingDeviceKeys(data);
  // The in-place refresh promised the researcher their place back — keep it (see the top).
  if (keepTop !== null && scroller && scroller.isConnected) scroller.scrollTop = keepTop;
  startDashPoll();
  // Queued assignment uploads: paint the card, then resume anything interrupted (panel restart is
  // one of the two resume points; the 'online' listener is the other). Fire-and-forget — the
  // dashboard must never block on an upload.
  paintAssignQueue();
  sweepAssignUploads();
  // Refresh the LIVE-version tip on a full render (initial load / manual refresh), not on every poll tick.
  if (!prefetched) refreshLiveVersions();
}

// Owner: approve / decline a pending researcher request (request/approve onboarding).
async function researcherAction(el) {
  const id = el.dataset.rid, act = el.dataset.ract;
  try {
    if (act === 'approve') {
      await busy(el, () => Researcher.approveResearcher(id));
      deps.toast(t('panel.pending.approved'), 4000);
      renderDashboard();
    } else if (act === 'decline') {
      if (!await confirmModal(t('panel.pending.confirmDecline'))) return;
      await busy(el, () => Researcher.declineResearcher(id));
      renderDashboard();
    }
  } catch (e) { errToast(e); }
}

/* Downloads dropdown: opens on hover AND on click (Seth asked for both).
 *
 * Hover alone is not enough — it does not exist on the touch devices a researcher may be using, and
 * it is unreachable by keyboard. Click alone loses the quick glance. So: hover opens it on
 * pointers that actually have hover, click toggles it everywhere, Escape and any outside click
 * close it, and only ONE menu is ever open (two overlapping menus would be unreadable).
 *
 * Closing on mouseleave is deliberately DELAYED — a menu that vanishes while the pointer crosses
 * the few pixels between the button and the menu is the classic dropdown failure, and it makes the
 * links effectively unclickable. */
/* ⚠ v347 REMOVED `openDlMenu` / `closeDlMenu` / `placeDlMenu` and their scroll, resize and
 * mouseleave wiring. The Files control is a MODAL now (see openFilesModal) — there is no anchored
 * element left to position, to keep on screen, or to dismiss when a list scrolls underneath it.
 *
 * Do not reintroduce a drop-down here "for speed". The positioning was fixed three times (absolute →
 * clipped by the height-capped lists; `fixed` → stranded on scroll; close-on-scroll → the menu
 * vanishing mid-read, which is what Seth reported). The modal is the fix for the whole class. */
/* ⚠⚠ THE FILES ▾ MENU IS HIDDEN (Seth, 2026-08-08). Flip this to true to bring it back.
 *
 * "The download files function is kind of all out of whack and needs more attention. I pushed it
 *  before it was really working. For now let's hide that drop-down and let researchers go to Google
 *  Drive directly until I have time to really develop that feature."
 *
 * RESTORED by assign-by-upload (2026-08-11): the menu is now the fixed six-item Downloads list —
 * original audio (byte-faithful), most recent flextext, on-click ELAN/SayMore zips, the preview
 * page and the .fxpa, every one either Worker-routed by file id or CONVERTED CLIENT-SIDE from
 * bytes fetched the same way. The unreliable half that got the menu parked in v316 (plain Drive
 * hrefs, the inferred-bundle row) stays retired: inferred artifacts are still skipped, and href
 * rows survive only for external (non-Drive) hosts the Worker cannot fetch. */
const FILES_MENU_ENABLED = true;

/* The Files ▾ control, renderable ANYWHERE a text appears (device rows, History entries). The menu
 * body is a placeholder that populates from the text's Drive FOLDER on first open — the folder is
 * the source of truth for what artifacts exist, so History entries show the same live menu the
 * device row does instead of a snapshot frozen at event time. */
// Does this History entry actually get a Files ▾ menu? The one predicate both the menu and the
// plain-link fallback read, so they can never both be hidden (or both shown) by accident.
function histHasMenu(e) { return FILES_MENU_ENABLED && !!(e.instanceId && e.docId); }

/* ⚠ v347: THE FILES CONTROL OPENS A MODAL, NOT A DROP-DOWN (Seth, 2026-08-13).
 *
 * "Sometimes the Files menu is too long and goes off screen, and then if I scroll (which scrolls the
 *  texts list by default), it disappears and it won't come back again until I refresh the page. I
 *  think we have so many options now that it would actually be better for the files to be a popup
 *  overlay modal instead of a menu."
 *
 * The drop-down had been chased through three positioning fixes and lost each time, and the reason
 * is structural rather than a bug to find: the text lists are height-capped scroll containers, so an
 * absolutely-positioned menu is clipped by them; `fixed` escapes the clipping but then cannot follow
 * its button, so it had to close on scroll — and closing on scroll is what Seth is describing. A
 * menu of ~8 rows on a small laptop cannot win that argument. A modal has no anchor to lose.
 *
 * It also buys the thing a drop-down could not give: ROOM FOR PROGRESS. A conversion could only
 * report into its own `.rp-dl-sub` line, so "working…" was invisible unless the menu happened to
 * still be open and the row happened to be on screen. The modal has a status line that survives.
 *
 * The row keeps this span because it carries the identity (dataset) the modal is seeded from; the
 * LIST lives in the modal. */
/* What to CALL a text on a device card. Titles are E2EE inside the reported inventory and are meant
 * to be read by whoever holds the key — Seth, 2026-08-28: "Text titles are OK to share. Please
 * don't just use ids for those." The old expression fell through to `titleHash`, so a text with no
 * name showed a 16-character hex string, which tells a human nothing and looks like an internal id.
 *
 * ⚠ THE THREE CASES ARE DIFFERENT AND THE MIDDLE ONE IS THE POINT:
 *   · a real title            → show it;
 *   · `title` present but ''  → the text genuinely has no name; say "Untitled text", the same words
 *                               the editor itself shows, so both screens agree;
 *   · no `title` field at all → a LEGACY device that only ever reported a hash. Saying "Untitled"
 *                               there would be a lie — the text has a name, we just cannot see it —
 *                               so the hash remains, as the honest "unknown" it always was. */
function textLabel(d) {
  const title = typeof d.title === 'string' ? d.title.trim() : null;
  if (title) return title;
  if (typeof d.title === 'string') return t('panel.inst.untitledText');
  return d.titleHash || t('panel.inst.untitledText');
}

function filesMenuHtml(instanceId, docId, title, audioUrl, fileId, viaMember) {
  if (!FILES_MENU_ENABLED) return '';
  if (!docId) return '';
  const au = /^https?:\/\//i.test(String(audioUrl || '')) ? audioUrl : '';
  /* `data-viamember` selects the download LANE, not whether the button exists (v468). A member with
   * drive:read downloads through the project-scoped route that runs under the owner's Drive token;
   * the owner keeps the account route, which can also serve files from a bridged legacy identity
   * that does not live under this doc's folder. */
  return `<span class="rp-dl" data-fmenu${viaMember ? ' data-viamember="1"' : ''} data-i="${esc(instanceId)}" data-id="${esc(docId)}" data-title="${esc(title || '')}" data-audio="${esc(au)}" data-fileid="${esc(fileId || '')}">
    <button class="link-btn rp-dl-btn" aria-haspopup="dialog">${esc(t('panel.dl.btn'))} <span class="rp-dl-caret" aria-hidden="true">▾</span></button></span>`;
}

/* ── PREVIEW PLAYER (Seth, 2026-08-31: "a mini preview player modal … for all our texts in all our
 * devices (and Google Drive Unassigned)") ────────────────────────────────────────────────────────
 *
 * A ▶ button beside Files… on every text row. The modal resolves the text's audio (the same
 * listTextFiles + pickSourceFiles the Files modal trusts), then plays the LIGHTEST thing it can:
 *
 *   1. a pre-cached preview head (crowd texts, fetched idle-time below) — instant;
 *   2. a minted /v1/textfile preview URL — the worker's ~240 KB telephone-quality head of a PCM
 *      WAV, or the raw first 256 KB of an already-compressed file;
 *   3. the ORIGINAL, downloaded and played as a blob — the fallback when the worker predates the
 *      preview routes. Heavier, never wrong, and what makes this shippable before that deploy.
 *
 * ⚠ THE PLAYER DIES WITH THE MODAL — pause, detach, revoke — on EVERY close path (modal()'s
 * onClose contract). A preview that keeps sounding after its dialog is gone reads as a haunting.
 *
 * ⚠ THE PRE-CACHE MUST NEVER COST THE PAGE (Seth: "the rest of the app working smoothly matters
 * more"): it runs idle-time only, one fetch at a time, capped, skips data-saver/2G connections,
 * only ever fetches the small preview heads (an old worker disables it entirely rather than pull
 * full originals), and evicts the moment a text leaves the estate. */
/* ⚠ NO BUTTON WHERE THERE IS NOTHING TO PLAY (Seth, 2026-08-31: "we are frequently seeing 'no
 * audio' toasts"). A text with no recording — a typed .flextext, an assignment not yet returned —
 * was still offered Preview, and the only way to find out was to click and be told. That is the
 * disabled-control failure in another costume: an affordance that cannot act.
 *
 * The signal is the warm cache: an entry with no blob means a Drive folder listing found no audio,
 * which the background sweep discovers without anyone clicking — so the button disappears on the
 * next repaint after the sweep reaches that text, and a click that discovers it records the same
 * fact. Unknown still renders: silence about a text nobody has looked at yet would hide a real
 * recording, and the click path handles the miss honestly.
 *
 * ⚠ AND NOT `hasAudio`, THOUGH EVERY DEVICE ROW CARRIES ONE. That flag is the device's LOCAL audio
 * (`audioSource || pendingAudio || audioId`, app.js), and `autoDelUploaded` deletes local audio
 * once it is safely in Drive — so a perfectly previewable text reports false. Hiding on it would
 * hide exactly the recordings a researcher most wants to hear: the ones already uploaded. Drive's
 * own listing is the only honest answer to "is there audio", which is what the cache holds. */
function previewBtnHtml(instanceId, docId, title, viaMember) {
  if (!instanceId || !docId) return '';
  const seen = prevCache.get(docId);
  if (seen && !seen.blob) return '';
  /* ⚠ ICON ONLY, BUT NEVER NAMELESS (Seth, 2026-09-01: "we don't actually need a text label next to
   * the play/pause toggle icon"). The word is redundant beside a ▶ and it crowded a row that already
   * carries Files…, Move… and Delete — but dropping it would leave a button whose only content is a
   * glyph marked aria-hidden, i.e. nothing at all to a screen reader. So the NAME moves to
   * aria-label while the tooltip keeps the fuller explanation, and the icon stays decorative. */
  return `<button class="link-btn rp-prev" data-prev data-i="${esc(instanceId)}" data-id="${esc(docId)}" data-title="${esc(title || '')}"${viaMember ? ' data-viamember="1"' : ''}
    aria-label="${esc(t('panel.prev.btn'))}" title="${esc(t('panel.prev.tip'))}"><span class="rp-prev-icon" aria-hidden="true">▶</span></button>`;
}

/* ONE PLAYER FOR THE WHOLE PANEL — Apple Music, not a dialog (Seth, 2026-08-31: "instant, rapid,
 * preview play … if another one is clicked the first one stops, toggle play/pause once loading has
 * finished"). A single detached <audio> serves every row; the row's own button IS the transport,
 * cycling ▶ → spinner → ⏸ → ▶. No modal, nothing to close, and starting a second preview stops
 * the first by construction because there is only ever one element.
 *
 * ⚠ IT MUST DIE WITH THE VIEW TOO. The 12s poll rebuilds rows, and a button that vanished
 * mid-playback would leave sound with no way to stop it — so a render that removes the playing
 * button stops the audio (stopPreviewIfDetached, called from the paint path). */
let prevAudio = null;       // the one element
let prevBtn = null;         // the button currently driving it
let prevToken = 0;          // guards against a slow resolve landing after a newer click

function previewSetState(btn, state) {
  if (!btn) return;
  const icon = btn.querySelector('.rp-prev-icon');
  if (icon) icon.textContent = state === 'playing' ? '⏸' : (state === 'loading' ? '◌' : '▶');
  btn.classList.toggle('rp-prev-loading', state === 'loading');
  btn.classList.toggle('rp-prev-playing', state === 'playing');
}

function stopPreview() {
  prevToken++;                                  // any in-flight resolve is now stale
  if (prevAudio) { try { prevAudio.pause(); } catch { /* noop */ } }
  if (prevAudio && prevAudio.dataset.objurl) { URL.revokeObjectURL(prevAudio.src); delete prevAudio.dataset.objurl; }
  if (prevAudio) { prevAudio.removeAttribute('src'); try { prevAudio.load(); } catch { /* noop */ } }
  previewSetState(prevBtn, 'idle');
  prevBtn = null;
}

/* Called after every repaint. The 12s poll rebuilds rows, and a 30-second preview outlives it, so
 * the button driving playback can be replaced mid-play. RE-ADOPT the replacement — same text, same
 * sound, the ⏸ simply reappears where it was — and stop only when the row is genuinely gone (the
 * text was deleted, moved, or filtered away), because sound with no visible control is the one
 * outcome an inline player must never produce. */
function stopPreviewIfDetached() {
  if (!prevBtn || prevBtn.isConnected) return;
  const want = prevBtn.dataset.id;
  const heir = want && root && root.querySelector(`[data-prev][data-id="${CSS.escape(want)}"]`);
  if (heir && prevAudio && !prevAudio.paused) {
    prevBtn = heir;
    previewSetState(heir, 'playing');
    return;
  }
  stopPreview();
}

/* THE PREVIEW IS A TASTE, NOT THE RECORDING (Seth: "not even necessarily the whole recording,
 * especially for longer recordings … maybe the first 30-40 seconds"). The worker's decimated head
 * is already capped at 30s; this stops the FALLBACK paths — a full original played from an old
 * worker, or a compressed file served whole — at the same place, so every source behaves alike. */
const PREVIEW_MAX_SECONDS = 35;

async function startPreview(btn) {
  const ds = btn.dataset;
  const via = ds.viamember ? { instanceId: ds.i, docId: ds.id } : null;
  if (!prevAudio) {
    prevAudio = new Audio();
    prevAudio.preload = 'auto';
    prevAudio.addEventListener('ended', () => stopPreview());
    prevAudio.addEventListener('timeupdate', () => {
      if (prevAudio.currentTime >= PREVIEW_MAX_SECONDS) stopPreview();
    });
  }
  stopPreview();                                 // whatever was playing stops — one player, always
  const mine = ++prevToken;
  prevBtn = btn;
  previewSetState(btn, 'loading');
  const live = () => mine === prevToken && btn.isConnected;
  const playSrc = (src, isObjUrl) => {
    if (!live()) { if (isObjUrl) URL.revokeObjectURL(src); return; }
    if (isObjUrl) prevAudio.dataset.objurl = '1';
    prevAudio.src = src;
    prevAudio.play().then(() => { if (live()) previewSetState(btn, 'playing'); })
      .catch(() => { if (live()) previewSetState(btn, 'idle'); });
  };
  const playFull = async (f) => {
    if (!live()) return;
    try {
      const blob = await Researcher.fetchDriveFile(f.id, null, via);
      playSrc(URL.createObjectURL(blob), true);
    } catch { if (live()) { previewSetState(btn, 'idle'); deps.toast(t('panel.prev.failed'), 5000); } }
  };
  try {
    const cached = prevCache.get(ds.id);
    if (cached && cached.blob) { playSrc(URL.createObjectURL(cached.blob), true); return; }
    const f = await resolveTextAudio(ds.i, ds.id);
    if (!live()) return;
    if (!f) { previewSetState(btn, 'idle'); deps.toast(t('panel.prev.noAudio'), 5000); return; }
    if (!prevMintDead) {
      const u = await Researcher.previewUrl(f.id, via);
      if (!live()) return;
      if (u) {
        // A head that will not decode (an exotic container, a mis-typed upload) falls back to the
        // original — the worker's truncation list is a judgement about FORMATS, this is a fact
        // about THIS file.
        prevAudio.addEventListener('error', () => { if (live()) playFull(f); }, { once: true });
        playSrc(u, false);
        return;
      }
    }
    await playFull(f);
  } catch { if (live()) { previewSetState(btn, 'idle'); deps.toast(t('panel.prev.failed'), 5000); } }
}

// The button is the transport: click toggles this row's own playback, or takes it over from
// whichever row had it.
function togglePreview(btn) {
  if (prevBtn === btn && prevAudio) {
    if (prevAudio.paused) { prevAudio.play().then(() => previewSetState(btn, 'playing')).catch(() => {}); }
    else { prevAudio.pause(); previewSetState(btn, 'idle'); }
    return;
  }
  startPreview(btn);
}

async function resolveTextAudio(instanceId, docId) {
  const r = await Researcher.listTextFiles(instanceId, docId);
  return pickSourceFiles((r && r.files) || []).audio || null;
}

const prevCache = new Map();   // docId -> { blob?, fileId? } ({} = known audio-less; no refetch loop)
let prevMintDead = false;      // this worker has no preview routes — fall back, and never pre-cache
let prevSweepBusy = false;

/* Idle-time pre-cache of crowd preview heads (Seth's suggestion): after a dashboard render, warm
 * the first N crowd texts so ▶ is instant. Strictly sequential; ~240 KB each. */
/* WARMING THE PREVIEWS — bounded, idle, and cheap-formats-only.
 *
 * Seth asked whether the panel should pre-cache EVERY text's preview once it finishes loading, and
 * answered his own question with the right instinct ("or is that a bad idea?"). Warming everything
 * is the wrong shape for this audience, and the honest reasons are:
 *   - it is THREE requests per text (list the folder, mint a URL, fetch the bytes), so a
 *     hundred-text estate is three hundred requests for audio nobody asked to hear;
 *   - the formats that cannot be truncated (m4a, flac) are served WHOLE, so "all" can mean tens of
 *     megabytes — paid for by a researcher who may be on the same field connection as the device;
 *   - most previews are never played, and speculative bytes on a metered link are real money.
 * So: warm a BOUNDED head of the list, cheap formats only, and make the rest instant by warming on
 * HOVER — the pointer arriving over a button is the best possible signal that it is about to be
 * clicked, and it costs one file instead of a hundred. That is how this ends up feeling instant
 * without the bill (Seth's own standing rule: "the rest of the app working smoothly matters more").
 *
 * ⚠ THE BUDGET IS TWO NUMBERS, not one: a file count AND a byte ceiling, because one big whole-file
 * source would otherwise eat a count-only budget on its own. */
const PREV_WARM_FILES = 24;
const PREV_WARM_BYTES = 12 * 1024 * 1024;
/* Cheap = we know the response is a small head. WAV decimates to ~240 KB whatever its length, and
 * mp3/ogg get a 256 KB head. Everything else is served whole, so it is warmed only when the file
 * is genuinely small; otherwise it stays a click away (and hover still warms it). */
function prevWorthWarming(f) {
  const n = String((f && f.name) || '').toLowerCase();
  const m = String((f && f.mimeType) || '').toLowerCase();
  if (/\.wav$/.test(n) || /wav/.test(m)) return true;
  if (/\.(mp3|ogg|opus)$/.test(n) || /(mpeg|mp3|ogg|opus)/.test(m)) return true;
  return (f && f.size ? Number(f.size) : Infinity) <= 3 * 1024 * 1024;
}

async function warmPreview(iid, docId, budget) {
  if (prevMintDead || prevCache.has(docId)) return;
  const f = await resolveTextAudio(iid, docId);
  if (!f) { prevCache.set(docId, {}); return; }            // no audio: remember, so we never re-ask
  if (budget && !prevWorthWarming(f)) return;               // hover ignores the budget; the sweep does not
  const u = await Researcher.previewUrl(f.id, null);
  if (!u) { prevMintDead = true; return; }                  // old worker — never pre-fetch originals
  const r = await fetch(u);
  if (!r.ok) return;
  const blob = await r.blob();
  if (budget) budget.bytes += blob.size;
  prevCache.set(docId, { blob, fileId: f.id });
}

/* Every text the panel can show a Preview button for — devices, Unassigned and crowd alike (they
 * are all rows in the Drive estate), newest first so the head of the budget goes to what a
 * researcher is most likely to be looking at. */
function previewableDocIds(estate) {
  const rows = (estate && Array.isArray(estate.texts)) ? estate.texts : [];
  return rows.filter((tx) => tx && tx.docId)
    .slice()
    .sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')))
    .map((tx) => tx.docId);
}

function sweepCrowdPreviews(recs, estate) {
  if (prevSweepBusy || prevMintDead) return;
  const conn = navigator.connection || {};
  if (conn.saveData || /(^|-)2g$/.test(String(conn.effectiveType || ''))) return;
  const iid = firstInstanceId();
  if (!iid) return;
  const want = previewableDocIds(estate);
  const wantSet = new Set(want);
  for (const k of [...prevCache.keys()]) if (!wantSet.has(k)) prevCache.delete(k);   // deleted text ⇒ cache gone too
  const todo = want.filter((d) => !prevCache.has(d)).slice(0, PREV_WARM_FILES);
  if (!todo.length) return;
  prevSweepBusy = true;
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
  idle(async () => {
    const budget = { bytes: 0 };
    let learned = false;
    try {
      for (const docId of todo) {
        if (prevMintDead || budget.bytes >= PREV_WARM_BYTES) break;
        try {
          await warmPreview(iid, docId, budget);
          const e = prevCache.get(docId);
          if (e && !e.blob) learned = true;              // this text has no audio — its button must go
        } catch { /* one text failing must not stop the sweep */ }
      }
    } finally { prevSweepBusy = false; }
    /* ⚠ REPAINT WHEN WE LEARNED A BUTTON SHOULD NOT BE THERE. Buttons are rendered, not live, and
     * the 12s poll only repaints when something CHANGED — so without this the Preview button on a
     * text with no audio survives until an unrelated change happens to repaint the dashboard, and
     * the researcher keeps meeting the "no audio" toast in the meantime (Seth: "we are frequently
     * seeing" them). Cannot loop: the next render's sweep finds everything cached and returns
     * before reaching this line. */
    if (learned) { try { renderDashboard(lastData || undefined); } catch { /* a repaint is a courtesy */ } }
  });
}

/* Open the Files modal for a row. The modal gets its OWN `[data-fmenu]` wrapper carrying the same
 * dataset, so every delegated handler (`data-conv`, `data-drivefile`, `data-zipall`, `data-cleanup`)
 * resolves `closest('[data-fmenu]')` to it and needs no change at all. The per-open caches
 * (`_allFiles`, `_menuSrc`, `_cache`) live on that wrapper and die with the modal.
 *
 * ⚠ It therefore RE-LISTS the folder on every open rather than once per page load. That is a
 * deliberate trade: one Worker round trip per deliberate user action, in exchange for a list that
 * cannot be stale — which matters more now that texts move between devices and Unassigned. */
function openFilesModal(rowWrap) {
  const title = rowWrap.dataset.title || t('panel.dl.title');
  const m = modal(`
    <div class="rp-dlm-head">
      <h3 class="rp-dlm-title">${esc(title)}</h3>
      <button class="btn-plain rp-dlm-close" type="button">${esc(t('panel.help.close'))}</button>
    </div>
    ${/* ⚠⚠ EVERY dataset key THE MENU READS MUST BE COPIED HERE — this modal builds a NEW wrapper
         and populateFilesMenu runs against IT, not the row's span. `data-viamember` was missed, and
         it decides two things at once: whether owner-only items render, and which download LANE is
         used. So a member's modal showed "Open the Drive folder" (v469/v475 gated the render sites
         correctly — they simply never saw a member) AND would have fetched through the owner route,
         where a member gets 404s from their own empty Drive.
         An attribute added to filesMenuHtml must be added here in the same commit. */''}
    <span class="rp-dl" data-fmenu${rowWrap.dataset.viamember ? ' data-viamember="1"' : ''}
          data-i="${esc(rowWrap.dataset.i || '')}" data-id="${esc(rowWrap.dataset.id || '')}"
          data-title="${esc(rowWrap.dataset.title || '')}" data-audio="${esc(rowWrap.dataset.audio || '')}"
          data-fileid="${esc(rowWrap.dataset.fileid || '')}">
      <div class="rp-dl-menu rp-dlm-list" role="menu">
        <span class="note rp-dl-loading">${esc(t('panel.dl.loading'))}</span>
      </div>
    </span>
    <div class="rp-dlm-status" role="status" aria-live="polite"></div>`);
  const wrap = m.el.querySelector('[data-fmenu]');
  /* The status element is reached through the WRAP, not through a module-level variable: two modals
   * can never be open at once, but a stale global would outlive a close and paint into a dead node. */
  wrap._status = m.el.querySelector('.rp-dlm-status');
  wrap._closeModal = m.close;
  m.el.querySelector('.rp-dlm-close').addEventListener('click', m.close);
  populateFilesMenu(wrap).catch((e) => {
    console.warn('[flextext] files modal failed to load:', e);
    const list = m.el.querySelector('.rp-dl-menu');
    if (list) list.innerHTML = `<span class="note rp-dl-loading">${esc(t('panel.dl.zipFailed'))}</span>`;
  });
  return m;
}

/* The modal's status line — the answer to "the UI gives no indication that it's doing anything".
 * A no-op when the caller is not in a modal, so nothing has to check first. */
function dlStatus(wrap, msg) {
  const el = wrap && wrap._status;
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('is-on', !!msg);
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE ACTIVITY TRAY — what is running right now, at the bottom of the screen.
 *
 * Seth, 2026-08-13: "We need some kind of progress/status bar in a box at the bottom showing things
 * that are in progress and downloading (they don't show up on the browser download menu, looks like,
 * until they're finished)."
 *
 * ⚠ THE OBSERVATION IS THE WHOLE DESIGN. A researcher-panel download is not a browser download until
 * the very last instant: every byte is fetched through the Worker into a Blob, and only when it is
 * COMPLETE does the anchor click hand it to the browser. So for the entire slow part there is
 * nothing in the browser's download list — the one place a user has been trained to look. The app is
 * the only thing that can say the work exists, and until now the only place it said so was inside
 * the Files modal, which the researcher may well have closed.
 *
 * Hence: body-level (survives closing the modal AND a dashboard re-render), multi-job (a single-file
 * download, a conversion and a Download-all can all be in flight together — only CONVERSIONS are
 * serialised, by convBusy), and self-clearing shortly after each job finishes so a finished tray
 * does not become permanent furniture.
 *
 * ⚠ It reports STATE, never a percentage it does not have. Researcher.fetchDriveFile resolves once
 * rather than streaming progress, so "Fetching X…" is the honest message and a fake progress bar
 * would be a lie that makes a stalled transfer look healthy.
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */
const jobs = new Map();
let jobSeq = 0;

function jobsEl() {
  let el = document.getElementById('rp-jobs');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rp-jobs';
    el.className = 'rp-jobs';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

/* Collapsed state is MODULE-LEVEL, not read back from the DOM: the tray repaints on every progress
 * tick (each jobSet), so DOM-held state would pop the tray back open once a second. The whole
 * header is the toggle, both directions (Seth, 2026-08-31: "Collapsible and expandable again") —
 * collapsed it is one line: the title, how many jobs, and a spinner while anything still runs, so
 * "is it still working" stays answerable without expanding. */
let jobsCollapsed = false;
function paintJobs() {
  const el = jobsEl();
  if (!jobs.size) { el.hidden = true; el.replaceChildren(); return; }
  el.hidden = false;
  el.classList.toggle('rp-jobs-min', jobsCollapsed);
  const running = [...jobs.values()].filter((j) => !j.done).length;
  const rows = jobsCollapsed ? [] : [...jobs.values()].map((j) => {
    const cls = 'rp-job' + (j.done ? ' is-done' : '');
    /* Which WAY the bytes are going, now that both directions share this box (Seth, 2026-08-31).
     * The arrow is the identity and stays put when the job finishes — a row that swapped its
     * arrow for a tick at the end would lose the one thing distinguishing it from its neighbour,
     * so "done" is the tick BESIDE the arrow, not instead of it. The spinner keeps its slot while
     * the job runs, so the tray still shows motion. Title text, not just a glyph. */
    const dir = j.dir === 'up' ? '↑' : '↓';
    const dirTip = esc(t(j.dir === 'up' ? 'panel.jobs.upload' : 'panel.jobs.download'));
    const state = j.done ? '<span class="rp-job-tick">✓</span>' : '<span class="rp-job-spin" aria-hidden="true"></span>';
    return `<div class="${cls}"><span class="rp-job-mark">
        <span class="rp-job-dir" title="${dirTip}" aria-label="${dirTip}" role="img">${dir}</span>${state}</span>
      <span class="rp-job-body"><span class="rp-job-label">${esc(j.label)}</span>
      ${j.msg ? `<span class="rp-job-msg">${esc(j.msg)}</span>` : ''}</span></div>`;
  });
  el.innerHTML = `<button type="button" class="rp-jobs-head" data-jobs-toggle aria-expanded="${!jobsCollapsed}"
      title="${esc(t(jobsCollapsed ? 'panel.jobs.expand' : 'panel.jobs.collapse'))}">
      <span class="rp-jobs-head-t">${esc(t('panel.jobs.title'))}${jobsCollapsed ? ` (${jobs.size})` : ''}</span>
      ${jobsCollapsed && running ? '<span class="rp-job-spin" aria-hidden="true"></span>' : ''}
      <span class="rp-jobs-chev" aria-hidden="true">${jobsCollapsed ? '▴' : '▾'}</span>
    </button>${rows.join('')}`;
  el.querySelector('[data-jobs-toggle]').onclick = () => { jobsCollapsed = !jobsCollapsed; paintJobs(); };
}

/* dir: 'down' (fetching FROM Drive — the original job kind) or 'up' (an assignment streaming TO
 * it). Defaults to 'down' so every existing caller keeps its meaning without being touched. */
function jobStart(label, msg, dir) {
  const id = ++jobSeq;
  jobs.set(id, { label, msg: msg || '', done: false, dir: dir === 'up' ? 'up' : 'down' });
  paintJobs();
  return id;
}
function jobSet(id, msg) {
  const j = jobs.get(id);
  if (!j || j.done) return;
  j.msg = msg || '';
  paintJobs();
}
/* Finish: show the outcome briefly, THEN drop it. The pause matters — a job that vanished the
 * instant it completed would leave the researcher unsure whether it finished or was lost, which is
 * the same doubt the tray exists to remove. */
function jobEnd(id, finalMsg) {
  const j = jobs.get(id);
  if (!j) return;
  j.done = true;
  j.msg = finalMsg || '';
  paintJobs();
  setTimeout(() => { jobs.delete(id); paintJobs(); }, finalMsg ? 5000 : 1200);
}

/* ---------------- WHAT A FILE IS: the Drive ROLE TAG, never its name ----------------
 *
 * ⚠ THE HEURISTIC MENU IS DELETED (Seth, 2026-08-12). `EXT_KIND` + `latestPerKind` classified every
 * file by sniffing its extension and then showed the newest of each guessed kind. Seth: *"the
 * inferred menu has actually never worked correctly and it's not worth our time making it work
 * correctly if it's just a fallback."* It is the machinery that earned the old Files menu its "all
 * out of whack" reputation and got it parked behind a flag — most memorably promising
 * "Bundle (.zip, includes audio)" and delivering raw XML, because a `.zip` name says nothing about
 * what is inside it.
 *
 * What replaced it: every file this suite writes carries an `appProperties.flextextRole` tag
 * (worker v1.js), and the v2 manifest DECLARES the intended set. A tag is a fact; an extension was
 * a guess. The one name-based check that survives is `.flextext`, and it is deliberately not the
 * same thing: that extension IS the format, on files we ourselves wrote, so it cannot mis-promise
 * the way a `.zip` could. */
const SOURCE_AUDIO_ROLES = ['source-audio', 'assigned-audio'];
const SOURCE_FT_ROLES = ['source-flextext', 'assigned-flextext'];
const CONSENT_ROLES = ['consent-clip', 'consent-prompt', 'consent-receipt'];
/* Never a "backup copy", however old: the source materials are what the researcher delivered or the
 * speaker recorded, the consent artifacts are the IRB record, and the manifest is the contract the
 * whole package is checked against. */
const PROTECTED_ROLES = [...SOURCE_AUDIO_ROLES, ...SOURCE_FT_ROLES, ...CONSENT_ROLES, 'manifest'];
const hasRole = (f, roles) => roles.includes(String((f && f.role) || ''));
const isFlextextName = (f) => /\.flextext$/i.test(String((f && f.name) || ''));

/* The files a text's SOURCE material resolves to, newest-first input assumed.
 * - audio: the tagged original. Detection is by ROLE so a later story rename leaves a cosmetically
 *   stale filename and nothing breaks (locked decision 4).
 * - flextext: the tagged source copy OR the newest bare `.flextext` a device uploaded (Lane B
 *   working copies postdate the manifest, so the manifest cannot declare them).
 * - bundle: legacy `.zip` uploads. Used ONLY by moveTextModal, where the WORKER extracts the
 *   flextext server-side; the panel no longer reads zips itself. */
function pickSourceFiles(files) {
  const rows = files || [];
  return {
    audio: rows.find((f) => hasRole(f, SOURCE_AUDIO_ROLES)) || null,
    flextext: rows.find((f) => hasRole(f, SOURCE_FT_ROLES) || isFlextextName(f)) || null,
    bundle: rows.find((f) => /\.zip$/i.test(String(f.name || ''))) || null,
    consent: rows.filter((f) => hasRole(f, CONSENT_ROLES)),
    manifest: rows.find((f) => hasRole(f, ['manifest']) || f.name === MANIFEST_NAME) || null,
  };
}

/* LEGACY IDENTITY BRIDGE. Until v137 the device DISCARDED the assign id and minted its own doc
 * id, so every assigned text has TWO identities: the panel's (history "Assigned" row, audio cache,
 * assign-copy folder) and the device's (inventory, uploads — in a SECOND Drive folder). New
 * assigns share one id, but every existing text stays split forever, so the menu bridges the halves
 * through the history log: events with the SAME TITLE name the sibling ids. Exact-title match is
 * imperfect (a retitled text will not bridge) — acceptable for a display menu, and only legacy
 * texts ever need it. */
function bridgedIds(docId, title) {
  const ids = new Set([docId]);
  const audio = [];
  const fileIds = [];
  try {
    const want = String(title || '').trim();
    for (const e of loadHistory(Researcher.currentAccountId())) {
      const same = e.docId === docId || (want && String(e.title || '').trim() === want);
      if (!same) continue;
      if (e.docId) ids.add(e.docId);
      if (/^https?:\/\//i.test(e.audioUrl || '')) audio.push(e.audioUrl);
      if (e.fileId) fileIds.push({ fileId: e.fileId, at: e.at || 0 });
    }
  } catch { /* the bridge is best-effort; the primary id still renders */ }
  fileIds.sort((a, b) => b.at - a.at);
  return { ids: [...ids], audioUrl: audio[0] || '', latestEventFileId: (fileIds[0] || {}).fileId || '' };
}

/* What cleanup is allowed to remove: the OLDER bare `.flextext` backup copies, and nothing else.
 *
 * That is the whole of the pileup — Lane B uploads one timestamped `.flextext` per auto-backup and
 * they accumulate forever. Everything else in the folder is either source material, a consent
 * artifact or the manifest, and PROTECTED_ROLES keeps all of it however old. Rewritten off
 * `latestPerKind` in v3: the old version derived "keep" from the extension-sniffing table, so
 * deleting that table would have silently widened what cleanup proposed to trash — the most
 * dangerous possible way for a refactor to go wrong. Explicitly listing what MAY go, rather than
 * subtracting what must stay, means a role this function has never heard of is kept by default.
 * PURE and lifted by test/text-folder-files.test.mjs. */
function cleanupCandidates(allFiles) {
  const rows = (allFiles || []).filter((f) => f && f.id);
  // Newest-first already, but never trust the caller's ordering for a destructive operation.
  const backups = rows.filter((f) => isFlextextName(f) && !hasRole(f, PROTECTED_ROLES))
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  return backups.slice(1);   // keep the newest; the rest are the older copies
}

/* THE FILES ▾ MENU, BUILT ON THE MANIFEST (v3 work order item 2).
 *
 * `flextext-manifest.json` is written FIRST, before a single source byte, and DECLARES the intended
 * file set. So the menu no longer guesses: it names the source files, reports which declared file
 * has not arrived yet, sizes the conversions before a click, and takes the writing systems from the
 * package instead of a separate instance-settings round trip.
 *
 * ⚠ NO MANIFEST → ONE ITEM: "Open the Drive folder ↗" (Seth, 2026-08-12: *"our fallback on the
 * files menu for previously assigned texts should rather just point [to] the Google Drive folder
 * for that text. That's good enough."*). Pre-manifest texts get a link, not a reconstructed menu —
 * a folder link cannot be wrong, and the heuristic that used to fill this space is deleted rather
 * than carried. `listTextFiles` already returns `folderId`, so the link costs no extra call. */
/* The member-safe download route for a files-menu wrapper, or null for the owner's own estate.
 * `data-viamember` is set only when the card was rendered inside a shared project, and the owner's
 * path is left EXACTLY as it was: their menu can list files from a bridged legacy identity whose
 * folder is not this doc's, which the member route (correctly) refuses. Same button, two lanes. */
function memberDlVia(wrap) {
  if (!wrap || !wrap.dataset || !wrap.dataset.viamember) return null;
  const instanceId = wrap.dataset.i, docId = wrap.dataset.id;
  return (instanceId && docId) ? { instanceId, docId } : null;
}

async function populateFilesMenu(wrap) {
  if (wrap.dataset.loaded) return;
  wrap.dataset.loaded = '1';
  const menu = wrap.querySelector('.rp-dl-menu');
  const iid = wrap.dataset.i, docId = wrap.dataset.id, title = wrap.dataset.title || 'text';
  const viaMember = !!wrap.dataset.viamember;   // a shared project's device: downloads only

  const bridge = bridgedIds(docId, wrap.dataset.title);
  const head = `<span class="rp-dl-head">${esc(t('panel.dl.title'))}</span>`;
  // Query EVERY bridged identity's folder (legacy texts have two), merge newest-first.
  // ⚠ Collect per-promise, then flatten. The first version concatenated onto a SHARED variable
  // inside Promise.all — a lost-update race where the last resolver's stale read silently dropped
  // the other folder's files, and WHICH half survived depended on resolution order. Caught by the
  // bridge fixture returning complementary menus per direction.
  const lists = await Promise.all(bridge.ids.map(async (id) => {
    try { const r = await Researcher.listTextFiles(iid, id); return { files: r.files || [], folderId: r.folderId || '' }; }
    catch { return { files: [], folderId: '' }; /* one folder failing must not empty the menu */ }
  }));
  const allFiles = lists.flatMap((l) => l.files).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  const folderId = lists.map((l) => l.folderId).find(Boolean) || '';
  wrap._allFiles = allFiles;                 // the entire-folder ZIP wants EVERYTHING, uncollapsed
  wrap._cache = new Map();                   // per-menu-open byte cache: one fetch per file per open

  const src = pickSourceFiles(allFiles);
  let manifest = null;
  if (src.manifest) {
    try { manifest = JSON.parse(await (await menuFetch(wrap, src.manifest.id)).text()); }
    catch { manifest = null; /* unreadable manifest is treated as none — the link is always right */ }
  }
  // Readers MUST ignore keys they do not know (manifest rule); a wrong-shaped body is not a manifest.
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) manifest = null;

  if (!manifest) {
    /* TWO items, and only these two (Seth, 2026-08-12: "for pre-manifest texts, let's add a
     * 'Download All' option (not just 'Open in Google Drive')").
     *
     * ⚠ This does NOT reopen the deleted heuristic, and the distinction is the whole point. What
     * was deleted were rows that CLAIMED to be a particular kind of artifact — "Bundle (.zip,
     * includes audio)" on a file that turned out to be raw XML. Both rows here make no claim about
     * what any file IS: one opens the folder, the other hands over every byte in it under each
     * file's own name. Neither can be wrong, which was §8's actual test.
     *
     * downloadAllZip needs no manifest: it re-lists the folder itself, and its conversion
     * injection is already gated on one — so a pre-manifest text simply gets the raw folder, which
     * is exactly right. */
    const pre = [];
    if (allFiles.length) {
      pre.push(`<button class="rp-dl-item rp-dl-all" data-zipall data-i="${esc(iid)}" data-id="${esc(docId)}" data-title="${esc(title)}">
        <span class="rp-dl-name">${esc(t('panel.dl.all'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.allSubRaw', { n: allFiles.length }))}</span></button>`);
    }
    /* ⚠ OWNER ONLY — and this is the SECOND of the two places that render it. v469 gated the other
     * one and shipped believing the job was done; a member's menu still carried this link, complete
     * with a live Drive folder id, until it was opened and looked at. Grep for every render site,
     * not the first. */
    if (folderId && !viaMember) {
      pre.push(`<a class="rp-dl-item" role="menuitem" href="${esc(driveFolderLink(folderId))}" target="_blank" rel="noopener noreferrer">
        <span class="rp-dl-name">${esc(t('panel.dl.openFolder'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.openFolderSub'))}</span></a>`);
    }
    menu.innerHTML = head + (pre.length ? pre.join('') : `<span class="note rp-dl-loading">${esc(t('panel.dl.noneYet'))}</span>`);
    return;
  }

  /* Declared-vs-present: the manifest's whole purpose. Completeness is DERIVED by this comparison,
   * never read from a stored flag — a flag goes stale the moment a later write fails and would then
   * assert the opposite of the truth. Matching is by NAME because that is what the manifest records;
   * the roles below then come from Drive's own tags. */
  const present = new Set(allFiles.map((f) => f.name));
  const missing = manifest.files.filter((d) => d && d.name && !present.has(d.name)).map((d) => d.name);

  const audioF = src.audio;
  const ftF = src.flextext;
  const declaredAudio = manifest.audio || null;
  // Sizes come from the manifest when the file has not arrived, from Drive when it has.
  const sizeOf = (f, declared) => (f && f.size) || (declared && declared.bytes) || 0;
  wrap._menuSrc = { audio: audioF, ft: ftF, manifest, base: sanitizeBase(manifest.title || title) || 'text' };

  const rows = [];
  const row = (attrs, name, sub) => `<a class="rp-dl-item" role="menuitem" ${attrs} href="#">
      <span class="rp-dl-name">${esc(name)}</span><span class="rp-dl-sub">${esc(sub)}</span></a>`;

  // 1. ORIGINAL AUDIO — byte-faithful, exact format as uploaded (locked decision 6), routed through
  //    the Worker by id. Labelled by the manifest's `origin`, so the researcher is told whether this
  //    is what they assigned or what the speaker recorded, instead of having to infer it.
  const originKey = 'panel.dl.origin.' + String(manifest.origin || '').replace(/[^a-z-]/g, '');
  const originLabel = t(originKey) === originKey ? String(manifest.origin || '') : t(originKey);
  if (audioF) {
    rows.push(row(`data-drivefile="${esc(audioF.id)}" data-fname="${esc(audioF.name)}"`,
      t('panel.dl.audio'), `${originLabel} · ${audioF.name}${audioF.size ? ' · ' + fmtSize(audioF.size) : ''}`));
  } else if (declaredAudio && declaredAudio.name) {
    // Declared but not yet in the folder: NAME it rather than silently omitting the row. This is
    // the difference the manifest buys — "not arrived yet" instead of "there is no audio".
    rows.push(`<span class="rp-dl-item rp-dl-pending" role="menuitem" aria-disabled="true">
      <span class="rp-dl-name">${esc(t('panel.dl.audio'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.notArrived', { name: declaredAudio.name }))}</span></span>`);
  }

  // 2. MOST RECENT FLEXTEXT — the tagged source copy, or the newest bare .flextext a device uploaded.
  if (ftF) {
    rows.push(row(`data-drivefile="${esc(ftF.id)}" data-fname="${esc(ftF.name)}"`,
      t('panel.dl.flextext'), `${ftF.name}${ftF.size ? ' · ' + fmtSize(ftF.size) : ''}`));
  }

  /* 3–6. CLIENT-SIDE CONVERSIONS, built on click from the two sources above by the SAME
   * assembleSegEntries the device bundles with — so what the researcher downloads is what a device
   * upload would have contained. The manifest lets each row carry a real SIZE ESTIMATE before the
   * click: a lossy source decodes to PCM at roughly 10x its compressed size, which is also what the
   * memory guard is measured against. That replaces download-then-discover. */
  if (ftF) {
    const aBytes = sizeOf(audioF, declaredAudio);
    const isWav = /\.wav$/i.test(String((audioF && audioF.name) || (declaredAudio && declaredAudio.name) || ''))
      || /wav/i.test(String((audioF && audioF.mime) || (declaredAudio && declaredAudio.mime) || ''));
    /* ⚠ The SAME `conversionCaps` the conversion itself will consult (seg-exports). Judging the
     * rows by a second, hand-rolled threshold is how a menu ends up promising what the click then
     * refuses — so this reads the one function and nothing else. */
    const caps = conversionCaps({ bytes: aBytes, isWav });
    const est = caps.est;
    const estTxt = aBytes ? t('panel.dl.approx', { size: fmtSize(est) }) : '';
    const conv = (kind, labelKey, withSize) => rows.push(row(`data-conv="${kind}"`,
      t('panel.dl.' + labelKey), t('panel.dl.' + labelKey + 'Sub') + (withSize && estTxt ? ' · ' + estTxt : '')));
    /* A row that cannot be built says so HERE, greyed, instead of after a long download. It reuses
     * rp-dl-pending — the same treatment as an audio file the manifest declared but that has not
     * arrived — because both mean "real row, not available right now". */
    const convOff = (labelKey, why) => rows.push(`<span class="rp-dl-item rp-dl-pending" role="menuitem" aria-disabled="true">
      <span class="rp-dl-name">${esc(t('panel.dl.' + labelKey))}</span><span class="rp-dl-sub">${esc(why)}</span></span>`);
    if (audioF) conv('elan', 'elanZip', true);
    /* ⚠ THE ONLY CONVERSION ROW THAT IS NOT GATED ON AUDIO, and loosePlan says why: "THE EAF NEEDS
     * TIMES, NOT AUDIO". serializeEaf omits the MEDIA_DESCRIPTOR when there is no media name and is
     * otherwise a perfectly legal ELAN file, so a text with offsets and no recording on this device
     * still yields one. It is also the only annotation output whose cost is O(text) rather than
     * O(audio) — no WAV conversion, no zip, nothing to weigh — so it carries no size estimate and
     * can never be refused for one. That is the whole point of offering it beside the package: the
     * researcher who already HAS the recordings should not download them again to get the tiers. */
    conv('eaf', 'eafOnly', false);
    if (audioF) {
      conv('saymore', 'saymoreZip', true);
      // The one output whose whole value IS the embedded audio, so it refuses rather than degrades.
      if (caps.preview) conv('preview', 'preview', true);
      else convOff('preview', t('panel.dl.previewTooBig', { size: fmtSize(est) }));
    }
    // Never disabled: above the ceiling it is built text-only, and the sub-line says so up front.
    if (audioF && !caps.fxpaAudio) {
      rows.push(row('data-conv="fxpa"', t('panel.dl.fxpa'), t('panel.dl.fxpaNoAudioSub')));
    } else {
      conv('fxpa', 'fxpa', !!audioF);
    }
    // The ELAN/SayMore rows above will carry the ORIGINAL recording rather than a converted copy.
    if (caps.lossyUnconverted) {
      rows.push(`<span class="rp-dl-note">${esc(t('panel.dl.lossyTiming'))}</span>`);
    }
  }

  /* 7. RECORDING PACKAGE (locked decision 6) — a client-side zip of whatever the folder actually
   * holds, offered ONLY when the manifest DECLARES consent artifacts or a recording. Declared, not
   * sniffed: an IRB package that quietly ships without the consent record is worse than no button. */
  const consentDeclared = !!(manifest.consent && (manifest.consent.prompt || manifest.consent.response || manifest.consent.receipt));
  if (consentDeclared || src.consent.length) {
    rows.push(row('data-conv="package"', t('panel.dl.package'), t('panel.dl.packageSub')));
  }

  // Whatever the manifest declared and Drive does not have — named, so a consumer can say WHICH
  // piece is missing instead of showing a partial package as if it were whole.
  if (missing.length) {
    rows.push(`<span class="note rp-dl-missing">${esc(t('panel.dl.missing', { names: missing.join(', ') }))}</span>`);
  }

  if (allFiles.length) {
    // ONE zip control (Seth): it takes the ENTIRE folder — every file across every bridged
    // identity, backups included. The list above is the curated set; the zip is not.
    rows.push(`<button class="rp-dl-item rp-dl-all" data-zipall data-i="${esc(iid)}" data-id="${esc(docId)}" data-title="${esc(title)}">
      <span class="rp-dl-name">${esc(t('panel.dl.all'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.allSub', { n: allFiles.length }))}</span></button>`);
    if (folderId) {
      /* ⚠ OWNER ONLY — "Open folder" leaves the app for Drive itself, and browsing Drive directly is
       * the owner's alone (Seth's v1 line: a member acts THROUGH the app, never in the Drive UI).
       * A member would meet Google's "You need access" page, which is a dead end wearing a link. */
      if (!viaMember) {
        rows.push(`<a class="rp-dl-item" role="menuitem" href="${esc(driveFolderLink(folderId))}" target="_blank" rel="noopener noreferrer">
          <span class="rp-dl-name">${esc(t('panel.dl.openFolder'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.openFolderSub'))}</span></a>`);
      }
    }
    // Cleanup: only the older .flextext backup copies, always to TRASH — recoverable for 30 days.
    /* ⚠ OWNER ONLY, AND ABSENT RATHER THAN DISABLED (Seth, 2026-08-28: "don't add enabled buttons or
     * links that won't work"). Cleanup deletes, and members hold drive:'read' — the worker refuses
     * 'manage' outright, so this control could only ever fail for them. Deletion and re-parenting
     * may be revisited in a later release; until they are, a member must not see the button. */
    const dead = viaMember ? [] : cleanupCandidates(allFiles);
    if (dead.length) {
      wrap._cleanupIds = dead.map((f) => f.id);
      rows.push(`<button class="rp-dl-item rp-dl-all rp-dl-clean" data-cleanup data-n="${dead.length}">
        <span class="rp-dl-name">${esc(t('panel.dl.cleanup'))}</span><span class="rp-dl-sub">${esc(t('panel.dl.cleanupSub', { n: dead.length }))}</span></button>`);
    }
  }
  menu.innerHTML = head + (rows.length ? rows.join('') : `<span class="note rp-dl-loading">${esc(t('panel.dl.noneYet'))}</span>`);
}

/* ---------------- Downloads-menu client-side conversions (assign-by-upload) ---------------- */

function saveBlobAs(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Per-menu-open byte cache: converting to ELAN then SayMore fetches the audio ONCE. The cache dies
// with the menu (wrap._cache resets on repopulate), so a re-opened menu sees fresh Drive truth.
/* `onPct(0..100 | null)` reports the transfer as it streams. The DENOMINATOR comes from the folder
 * listing we already hold — the worker's content-length is not readable cross-origin (no
 * Access-Control-Expose-Headers on v1Cors) and adding it would be a worker deploy for a number that
 * is already in hand. When the size is unknown the callback gets null and the caller says "N MB"
 * rather than inventing a percentage. */
async function menuFetch(wrap, fileId, onPct) {
  if (!wrap._cache) wrap._cache = new Map();
  if (!wrap._cache.has(fileId)) {
    const known = ((wrap._allFiles || []).find((f) => f && f.id === fileId) || {}).size || 0;
    const report = onPct
      ? (got) => onPct(known ? Math.min(99, Math.round((got / known) * 100)) : null, got)
      : undefined;
    wrap._cache.set(fileId, await Researcher.fetchDriveFile(fileId, report, memberDlVia(wrap)));
  }
  return wrap._cache.get(fileId);
}

/* The menu's flextext TEXT — a direct Drive file, always. The legacy "extract the .flextext from
 * the newest bundle zip" path is DELETED with the rest of the inferred menu (v3): a text with no
 * manifest now gets a folder link instead of a reconstructed menu, so there is nothing left to
 * reconstruct FROM. `unzipStoreEntry` went with it — it had no other caller. */
async function menuFlextextText(wrap) {
  const src = wrap._menuSrc && wrap._menuSrc.ft;
  if (!src) return null;
  return (await menuFetch(wrap, src.id)).text();
}

/* THE RECORDING PACKAGE (locked decision 6): "Recording Package (with consent records)" is a
 * CLIENT-SIDE zip built from whatever the folder actually holds — the source audio, the consent
 * clip, the spoken prompt, the receipt, and the manifest that declares the set. Offered only when
 * the manifest DECLARES consent artifacts, because an IRB package that quietly ships without the
 * consent record is worse than no button at all.
 *
 * It repackages BYTES — no decode, no conversion, no size guard needed beyond the browser's own
 * limits: every file goes in exactly as uploaded, which is the whole point of an archival package. */
async function buildRecordingPackage(wrap, base) {
  const files = (wrap._allFiles || []).filter((f) => hasRole(f, [...SOURCE_AUDIO_ROLES, ...CONSENT_ROLES, 'manifest']));
  if (!files.length) { deps.toast(t('panel.dl.zipFailed'), 5000); return; }
  const entries = [];
  const used = new Set();
  for (const f of files) {
    let name = f.name || 'file'; let n = 1;
    while (used.has(name)) name = (f.name || 'file').replace(/(\.[^.]*)?$/, ` (${++n})$1`);
    used.add(name);
    entries.push({ name, data: await menuFetch(wrap, f.id) });
  }
  saveBlobAs(await makeZip(entries), `${base} recording package.zip`);
}

/* ONE conversion at a time, on-click only. Decoding + base64-embedding a huge recording is the
 * panel's one real memory hazard (spec risk #1) — the ceiling and the per-output ladder it drives
 * now live in seg-exports' `conversionCaps`, which BOTH the menu renderer and the conversion itself
 * consult so a greyed row and a refusal can never disagree. */
let convBusy = false;

/* The inputs EVERY conversion shares: the parsed doc, the original audio, the WAV timeline the
 * segment times live on, and the writing systems. Extracted (v3.1) so that Download-all builds
 * exactly the same files as the individual menu rows — two code paths producing "the ELAN export"
 * would drift, and the researcher would have no way to tell which one they got.
 *
 * Returns { doc, aligned, vern, anal, media, segMedia, caps } or { error }.
 *
 * ⚠ v347: this no longer REFUSES on size — it degrades, per `conversionCaps`. Above the ceiling a
 * lossy source is shipped UNCONVERTED (`segMedia = media`) rather than withheld, because the zip
 * only ever needed the bytes; the caller then warns about the ~44 ms of priming drift that buys.
 * `caps` rides back so each caller can honour the rest of the ladder (audio-less .fxpa, no preview).
 *
 * `opts.kind`, when given, lets an oversized `.fxpa` skip the audio DOWNLOAD entirely — it is about
 * to be built without audio, so fetching 200 MB to discard it would be pure waste. */
async function prepareConversionSources(wrap, base, paint, opts = {}) {
  const manifest = (wrap._menuSrc && wrap._menuSrc.manifest) || null;
  const xml = await menuFlextextText(wrap);
  if (!xml) return { error: t('panel.dl.zipFailed') };
  const parsed = parseFlextext(xml);
  if (parsed.error || !parsed.texts.length) {
    return { error: t('task.ftParseFailed', { msg: parsed.error || t('task.ftNone') }) };
  }
  // The same derivation the paragraph app does on a dropped flextext (paragraph-ui precedent):
  // spans from the file's own begin/end-time-offset attributes; none -> a text-only document.
  const doc = parsed.texts[0];
  doc.segments = segmentsFromOffsets(doc) || [];
  const aligned = doc.segments.some((s) => typeof s.start === 'number' && !s.timePending);
  /* Writing systems come from the MANIFEST (v3): it records the codes the package was created
   * with, which is what these files should be labelled with — and it is already in hand, so the
   * separate getInstanceSettings round trip is gone. A device whose settings changed since the
   * upload no longer retro-labels an old export with today's codes. Falls back to the parsed
   * doc's own codes, then to the instance settings for a manifest that predates the field. */
  const ws = (manifest && manifest.writingSystems) || {};
  let vern = ws.vern || doc.vernLang || '';
  let anal = ws.anal || doc.analLang || '';
  if (!vern || !anal) {
    const codes = (await Researcher.getInstanceSettings(wrap.dataset.i).catch(() => null)) || {};
    vern = vern || codes.vernLang || 'und';
    anal = anal || codes.analLang || 'en';
  }
  let media = null, segMedia = null;
  let caps = conversionCaps({ bytes: 0, isWav: true });   // no audio ⇒ nothing is size-blocked
  const af = wrap._menuSrc && wrap._menuSrc.audio;
  if (af && aligned) {
    const isWav = /\.wav$/i.test(af.name || '') || /\bwav\b/i.test(af.mime || '');
    caps = conversionCaps({ bytes: af.size || 0, isWav });
    // An oversized .fxpa is built text-only, so its audio is never touched — do not download it.
    if (opts.kind === 'fxpa' && !caps.fxpaAudio) return { doc, aligned, vern, anal, media, segMedia, caps, xml };
    /* ⚠ THE LONG SILENT STRETCH, named. For a WAV source there is no decode to report a percentage
     * for, so the only slow step is this fetch — the whole original streaming through the Worker.
     * Without this line an ELAN export of a 217 MB recording sits on "working…" for a minute and
     * looks hung, which is precisely what Seth reported. */
    paint(t('panel.dl.fetching', { name: af.name || 'audio' }));
    const blob = await menuFetch(wrap, af.id, (pct, got) => paint(
      pct == null ? t('panel.dl.fetchingBytes', { name: af.name || 'audio', size: fmtSize(got) })
                  : t('panel.dl.fetchingPct', { name: af.name || 'audio', pct })));
    /* v3 NAMING: from the STORY TITLE, not from the Drive file's name — an assigned text's
     * original was uploaded under a token-derived name before the fix, and reading it here is
     * what put gibberish on the researcher's downloads. `srcName` still records the REAL source
     * file, because the bext chunk's honesty depends on naming what was actually converted. */
    media = { name: mediaNameFor(base, { name: af.name, mime: af.mime || blob.type }),
              mimeType: af.mime || blob.type || 'audio/*', blob };
    /* A WAV is already the timeline — no decode, at any size. And above the ceiling a LOSSY source
     * takes the same branch deliberately: the zip wants bytes, so shipping the original beats
     * refusing. `derived` stays false, which is what makes assembleSegEntries name it correctly, skip
     * the "NOT an archival master" bext stamp, and put the timing caveat in HOW-TO-OPEN.txt. */
    if (isWav || !caps.convert) segMedia = media;
    else {
      // Same reason the editor works on a WAV copy: AAC priming makes decode and playback
      // disagree; ELAN/SayMore get exact alignment against PCM. Same honest name, too.
      const res = await convertAudio(await blob.arrayBuffer(), { format: 'wav', wavBits: 16 },
        (f) => paint(t('convert.working', { pct: Math.round(f * 100) })));
      segMedia = { name: derivedWavName(base),
        mimeType: 'audio/wav', blob: res.blob, derived: true, srcName: af.name || '' };
    }
  }
  return { doc, aligned, vern, anal, media, segMedia, caps, xml };
}

/* The generated annotation/listening files for a text, as zip entries. `full` mirrors the device's
 * local-save rule (preview + .fxpa embed audio and ride LOCAL bundles only). The already-WAV case
 * needs its media pushed explicitly: assembleSegEntries bundles the derived copy but not an
 * original that was already PCM, and the EAF references it BY NAME either way — so leaving it out
 * would hand ELAN a bundle whose audio it cannot find. */
async function buildSegEntriesFor(src, { title, base, wants, full = true }) {
  const entries = await assembleSegEntries({
    doc: src.doc, title, base, media: src.media, segMedia: src.segMedia, wants,
    vern: src.vern, anal: src.anal, full,
    producedBy: deps.producedBy ? deps.producedBy() : '',
  });
  if ((wants.eaf || wants.saymore) && src.segMedia && !entries.some((x) => x.name === src.segMedia.name)) {
    entries.push({ name: src.segMedia.name, data: src.segMedia.blob });
  }
  return entries;
}

async function runMenuConversion(wrap, kind, itemEl) {
  if (convBusy) { deps.toast(t('panel.dl.oneAtATime'), 4000); return; }
  convBusy = true;
  const sub = itemEl && itemEl.querySelector('.rp-dl-sub');
  const subWas = sub ? sub.textContent : '';
  /* Progress goes to BOTH the row's own sub-line and the modal's status line. The row keeps it
   * where the researcher clicked; the status line is what survives scrolling a long list, and is
   * the reason the modal exists (a drop-down had nowhere to put this). */
  const kindLabel = t('panel.dl.' + ({ elan: 'elanZip', saymore: 'saymoreZip', preview: 'preview',
    fxpa: 'fxpa', package: 'package', flextext: 'flextext' }[kind] || 'title'));
  const job = jobStart(`${wrap.dataset.title || 'text'} — ${kindLabel}`, t('panel.dl.starting'));
  const paint = (msg) => { if (sub) sub.textContent = msg; dlStatus(wrap, msg); jobSet(job, msg); };
  try {
    const title = wrap.dataset.title || 'text';
    const base = (wrap._menuSrc && wrap._menuSrc.base) || sanitizeBase(title) || 'text';
    paint(t('panel.dl.working'));
    // The recording package is a straight repackage of the folder — no flextext parse, no decode.
    if (kind === 'package') { await buildRecordingPackage(wrap, base); return; }
    if (kind === 'flextext') {
      const xml = await menuFlextextText(wrap);
      if (!xml) { deps.toast(t('panel.dl.zipFailed'), 5000); return; }
      saveBlobAs(new Blob([xml], { type: 'application/xml' }), base + '.flextext');
      return;
    }
    const src = await prepareConversionSources(wrap, base, paint, { kind });
    if (src.error) { deps.toast(src.error, 6000); return; }
    if (!src.aligned && kind !== 'fxpa') { deps.toast(t('panel.dl.noAlign'), 7000); return; }
    /* THE ONLY SIZE REFUSAL (Seth): a listening page whose audio is not in it has no reason to
     * exist — the embedded sound and the follow-along player ARE the feature, so an audio-less one
     * would be a worse .flextext. Everything else degrades instead. */
    if (kind === 'preview' && !src.caps.preview) {
      deps.toast(t('panel.dl.previewTooBig', { size: fmtSize(src.caps.est) }), 8000); return;
    }
    // 'eaf' joins 'fxpa' in not needing the recording — see the menu row's note. It still needs
    // ALIGNMENT, which the src.aligned check above already enforced for every kind but fxpa.
    if (kind !== 'fxpa' && kind !== 'eaf' && !src.segMedia) { deps.toast(t('panel.dl.noAlign'), 7000); return; }
    paint(t('panel.dl.working'));
    /* ⚠ 'eaf' ASKS FOR EXACTLY WHAT 'elan' ASKS FOR. The difference is what is KEPT below, not what
     * is built — so the .eaf a researcher gets here is byte-for-byte the one inside the ELAN zip.
     * A second, slimmer EAF path would be a second EAF implementation, and the two would drift. */
    const wants = { elan: { eaf: true }, eaf: { eaf: true }, saymore: { saymore: true },
                    preview: { preview: true }, fxpa: { fxpa: true } }[kind];
    if (!wants) return;
    /* An oversized .fxpa is built WITHOUT audio rather than refused — the grouping analysis is the
     * point of the file, and buildFxpa's audio has always been optional (a text-only .fxpa is what
     * an unaligned doc already exports). Dropping segMedia is the entire mechanism. */
    const dropAudio = kind === 'fxpa' && !src.caps.fxpaAudio;
    const useSrc = dropAudio ? { ...src, media: null, segMedia: null } : src;
    // full: preview + fxpa are the embedded-audio outputs (the same full-bundle-only rule the
    // device applies); the ELAN/SayMore zips match what an upload bundle carries.
    const entries = await buildSegEntriesFor(useSrc, { title, base, wants, full: kind === 'preview' || kind === 'fxpa' });
    if (kind === 'elan' || kind === 'saymore') {
      saveBlobAs(await makeZip(entries), `${base} ${kind === 'elan' ? 'ELAN' : 'SayMore'}.zip`);
      // The file is already saved — these say what the researcher is holding, not that it failed.
      if (src.caps.lossyUnconverted) deps.toast(t('panel.dl.lossyTiming'), 10000);
    } else {
      const pick = kind === 'preview' ? /\.preview\.html$/i : kind === 'eaf' ? /\.eaf$/i : /\.fxpa$/i;
      const one = entries.find((x) => pick.test(x.name));
      if (!one) { deps.toast(t('panel.dl.zipFailed'), 5000); return; }
      saveBlobAs(one.data, one.name);
      if (dropAudio) deps.toast(t('panel.dl.fxpaNoAudio', { size: fmtSize(src.caps.est) }), 9000);
    }
  } catch (e) {
    console.warn('[flextext] downloads-menu conversion failed:', e);
    deps.toast(e && e.code === 'ZIP_TOO_LARGE' ? t('panel.dl.zipTooLarge') : t('panel.dl.zipFailed'), 6000);
  } finally {
    convBusy = false;
    if (sub) sub.textContent = subWas;   // the row goes back to its description…
    dlStatus(wrap, '');                  // …and the status line clears rather than freezing mid-word
    jobEnd(job, t('panel.dl.savedShort'));
  }
}

// The current inventory item for a doc, for the static fallback path.
/* Did this instance report a readable inventory at all? Distinguishes "the text is not there" from
 * "we cannot see what is there" — a revoked instance, or one whose report failed to decrypt. */
function instanceReported(instanceId) {
  for (const it of (lastData && lastData.instances) || []) {
    if (it.instance_id !== instanceId) continue;
    for (const ins of it.installs || []) {
      if (ins.inventory && Array.isArray(ins.inventory.items)) return true;
    }
  }
  return false;
}

function findInventoryItem(instanceId, docId) {
  for (const it of (lastData && lastData.instances) || []) {
    if (it.instance_id !== instanceId) continue;
    for (const ins of it.installs || []) {
      const items = ins.inventory && Array.isArray(ins.inventory.items) ? ins.inventory.items : [];
      const d = items.find((x) => x && x.id === docId);
      if (d) return d;
    }
  }
  return null;
}

/* Download-everything-as-one-ZIP: every byte routes through the Worker with the RESEARCHER'S own
 * token and connection — this control must never exist on a field device. Built client-side because
 * Drive has no "folder as zip" URL — the web UI's folder download is an internal, cookie-
 * authenticated route, not something the Drive API offers an OAuth client, so there is nothing to
 * delegate the zipping to.
 *
 * ⚠ BUT A FOLDER HOLDING ONE FILE MUST NOT BE RE-ZIPPED (Seth, 2026-08-07). A device uploads its
 * text as a single BUNDLE .zip, so a text uploaded once has exactly one file in its folder — and
 * wrapping that gave a zip whose only member was another zip. On a Mac that errors outright; where
 * it does not, it is worse, because it quietly works: "the flextext files are inside the inner zip
 * file", and the people this suite is for are precisely the ones who will not distinguish a folder
 * from an archive and will report that the app cannot find their text.
 * One file → hand over that file, under its own name. The zip earns its place only when it is
 * actually bundling several things. */
async function downloadAllZip(btn) {
  const iid = btn.dataset.i, docId = btn.dataset.id;
  const title = (btn.dataset.title || 'text').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const nameEl = btn.querySelector('.rp-dl-name');
  const orig = nameEl.textContent;
  const wrapForStatus = btn.closest ? btn.closest('[data-fmenu]') : null;
  const job = jobStart(`${btn.dataset.title || title} — ${t('panel.dl.all')}`, t('panel.dl.starting'));
  try {
    btn.disabled = true; nameEl.textContent = t('panel.dl.zipBuilding');
    /* Same complaint as the single-file download: every byte of the folder streams through the
     * Worker before the browser is handed anything, so a big text spends a long time looking idle.
     * The count is the useful number here — "3 of 11" tells the researcher it is moving, which a
     * spinner does not. */
    deps.toast(t('panel.dl.started'), 4000);
    dlStatus(wrapForStatus, t('panel.dl.zipBuilding'));
    // Re-list across every bridged identity (legacy texts have two folders — see bridgedIds).
    const bridge = bridgedIds(docId, btn.dataset.title);
    const lists = await Promise.all(bridge.ids.map(async (id) => {
      try { return (await Researcher.listTextFiles(iid, id)).files || []; } catch { return []; /* partial is fine */ }
    }));
    const all = lists.flat().sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    const wanted = all;   // the ENTIRE folder — every bridged identity, backups included
    const entries = [];
    const used = new Set();
    const add = (name0, data) => {
      // Backup copies share names across time; a zip needs unique entry names.
      let name = name0 || 'file'; let n = 1;
      while (used.has(name)) name = (name0 || 'file').replace(/(\.[^.]*)?$/, ` (${++n})$1`);
      used.add(name);
      entries.push({ name, data });
    };
    let got = 0;
    for (const f of wanted) {
      const i = ++got;
      const head = t('panel.dl.fetchingN', { i, n: wanted.length, name: f.name || '' });
      dlStatus(wrapForStatus, head); jobSet(job, head);
      add(f.name, await Researcher.fetchDriveFile(f.id, (bytes) => {
        const pct = f.size ? t('panel.dl.pct', { pct: Math.min(99, Math.round((bytes / f.size) * 100)), size: fmtSize(f.size) }) : fmtSize(bytes);
        dlStatus(wrapForStatus, head + ' ' + pct); jobSet(job, head + ' ' + pct);
      }, memberDlVia(wrapForStatus)));
    }

    /* GENERATED FILES RIDE ALONG (Seth, 2026-08-12: "can our Download All zip also generate and
     * inject ELAN and SayMore as well as Listening HTML and fxpa into that zip?").
     *
     * They are built by the SAME prepareConversionSources + assembleSegEntries the individual menu
     * rows use, so "the ELAN export" means one thing however it was obtained — two code paths
     * producing it would drift and the researcher could not tell which they got.
     *
     * ⚠ Never at the cost of the download itself. Everything here is best-effort: no manifest, no
     * alignment, an audio file too large to decode in a tab, or an outright failure all leave the
     * folder zip exactly as it would have been. The raw bytes are what the researcher asked for;
     * the conversions are a bonus, and a bonus must not be able to take the request down with it. */
    const wrap = btn.closest ? btn.closest('.rp-dl') : null;
    let skipped = '';
    if (wrap && wrap._menuSrc && wrap._menuSrc.manifest) {
      try {
        nameEl.textContent = t('panel.dl.zipConverting');
        const base = wrap._menuSrc.base || title || 'text';
        const src = await prepareConversionSources(wrap, base, () => {});
        if (src.error) skipped = src.error;
        else {
          /* full:true — Download-all is the LOCAL path, so the embedded-audio outputs belong in it,
           * exactly as they do in the editor's own save bundle.
           *
           * ⚠ v347: an oversized recording no longer skips ALL of this. The ladder applies here per
           * output, so the researcher gets the ELAN and SayMore packages (built on the original
           * audio) and a text-only .fxpa, and is told exactly which ONE thing was left out — the
           * old blanket "conversions skipped" message described a refusal that no longer happens. */
          const wants = {
            eaf: !!src.segMedia, saymore: !!src.segMedia,
            preview: !!src.segMedia && src.caps.preview,
            fxpa: src.caps.fxpaAudio,
          };
          for (const e of await buildSegEntriesFor(src, { title, base, wants, full: true })) add(e.name, e.data);
          /* ⚠ The oversized .fxpa needs its OWN pass, and the reason is worth stating: one call
           * takes one segMedia, so dropping it to make the .fxpa text-only would take the EAFs and
           * their audio down with it. The EAFs want the recording; the .fxpa must not embed it. Two
           * passes, each with the media it should have. The second emits nothing else — with no
           * media the EAF/preview/HOW-TO-OPEN block is skipped entirely — so nothing duplicates. */
          if (!src.caps.fxpaAudio) {
            const textOnly = { ...src, media: null, segMedia: null };
            for (const e of await buildSegEntriesFor(textOnly, { title, base, wants: { fxpa: true }, full: true })) add(e.name, e.data);
          }
          const notes = [];
          if (!src.segMedia) notes.push(t('panel.dl.noAlign'));            // .fxpa still went in, text-only
          if (src.segMedia && !src.caps.preview) notes.push(t('panel.dl.previewTooBig', { size: fmtSize(src.caps.est) }));
          if (!src.caps.fxpaAudio && src.segMedia) notes.push(t('panel.dl.fxpaNoAudio', { size: fmtSize(src.caps.est) }));
          if (src.caps.lossyUnconverted) notes.push(t('panel.dl.lossyTiming'));
          skipped = notes.join(' ');
        }
      } catch (e) {
        console.warn('[flextext] download-all conversions skipped:', e);
        skipped = t('panel.dl.zipFailed');
      }
    }
    if (skipped) deps.toast(t('panel.dl.allPartial', { why: skipped }), 7000);
    if (!entries.length) throw new Error('empty');
    /* One file: give them the file. Its own name is also the RIGHT name — a bundle is already
     * "<title> <timestamp>.zip", so renaming it to the bare title would drop which upload it is.
     * Note this now fires only when the conversions produced NOTHING too — the moment any is
     * injected there are several things to bundle, which is precisely when a zip earns its place. */
    const single = entries.length === 1;
    const blob = single ? entries[0].data : await makeZip(entries);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = single ? entries[0].name : title + '.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    nameEl.textContent = orig;
  } catch (e) {
    nameEl.textContent = t('panel.dl.zipFailed');
    // A ZIP32 overflow is a different fact from "it failed" — say which one it was.
    if (e && e.code === 'ZIP_TOO_LARGE') deps.toast(t('panel.dl.zipTooLarge'), 8000);
  } finally { btn.disabled = false; dlStatus(wrapForStatus, ''); jobEnd(job, t('panel.dl.savedShort')); }
}

function wireDownloadMenus(scope) {
  /* ⚠ CLICK ONLY — the hover-to-open path is deliberately GONE (v347). A modal that opened on
   * mouseenter would fire while the researcher was merely moving the pointer across a list of
   * forty texts, taking over the screen each time. Opening a dialog is an action, not a hover. */
  (scope || root).querySelectorAll('.rp-dl').forEach((wrap) => {
    wrap.querySelector('.rp-dl-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openFilesModal(wrap);
    });
  });
  // The ▶ preview buttons ride the same wiring point, so every surface that renders Files… (and
  // calls this) gets the player without a second hookup site to forget.
  (scope || root).querySelectorAll('[data-prev]').forEach((b) => {
    b.addEventListener('click', (e) => { e.stopPropagation(); togglePreview(b); });
    /* HOVER WARMS THIS ONE. The pointer arriving over a Preview button is the best available
     * signal that it is about to be clicked, and warming one file beats warming a hundred — this
     * is what makes the rest of the list feel instant without pre-fetching the whole estate.
     * `once` so a researcher sweeping the pointer down a long list warms each row at most once;
     * budget-free because a deliberate hover is worth the bytes a blind sweep is not.
     * ⚠ Keyboard users get the same courtesy through focus — the button is a real <button>. */
    const warm = () => { warmPreview(b.dataset.i, b.dataset.id, null).catch(() => {}); };
    b.addEventListener('pointerenter', warm, { once: true });
    b.addEventListener('focus', warm, { once: true });
  });
  /* The repaint just replaced these rows. If the button driving playback went with them, the sound
   * would have no visible control — so it stops. (The 12s poll rebuilds rows constantly.) */
  stopPreviewIfDetached();
  if (!wireDownloadMenus.global) {   // document listeners attach ONCE, not per render
    wireDownloadMenus.global = true;
    document.addEventListener('click', async (e) => {
      const z = e.target.closest && e.target.closest('[data-zipall]');
      if (z) { e.preventDefault(); e.stopPropagation(); downloadAllZip(z); return; }
      const cl = e.target.closest && e.target.closest('[data-cleanup]');
      if (cl) {
        e.preventDefault(); e.stopPropagation();
        const wrap2 = cl.closest('.rp-dl');
        const ids = (wrap2 && wrap2._cleanupIds) || [];
        if (!ids.length) return;
        if (!await confirmModal(t('panel.dl.cleanupConfirm', { n: ids.length }))) return;
        Researcher.trashFiles(ids, 'backup cleanup').then((r) => {
          deps.toast(t('panel.dl.cleanupDone', { n: r.trashed }), 6000);
          if (wrap2) { wrap2.dataset.loaded = ''; populateFilesMenu(wrap2); }   // menu refreshes to the post-cleanup truth
        }).catch(() => deps.toast(t('panel.dl.zipFailed'), 5000));
        return;
      }
      const hc = e.target.closest && e.target.closest('[data-histclean]');
      if (hc) {
        e.preventDefault(); e.stopPropagation();
        (async () => {
          // Find every folder the bridged identities own, then confirm with the ADVISORY (Seth):
          // download first, and the removal follows the folder ID wherever it now lives — if the
          // folder was MOVED elsewhere in Drive, THAT folder is what goes to trash. Copy or
          // download; never move.
          const bridge = bridgedIds(hc.dataset.id, hc.dataset.title);
          const folderIds = [];
          for (const id of bridge.ids) {
            try { const r = await Researcher.listTextFiles(hc.dataset.i, id); if (r.folderId) folderIds.push(r.folderId); }
            catch { /* a missing folder is simply not removable */ }
          }
          if (!folderIds.length) { deps.toast(t('panel.hist.noFolder'), 5000); return; }
          if (!await confirmModal(t('panel.hist.removeFolderConfirm', { title: hc.dataset.title || '?' }))) return;
          try {
            const r = await Researcher.trashFiles(folderIds, 'deleted-text folder removal');
            deps.toast(t('panel.hist.folderRemoved', { n: r.trashed }), 6000);
          } catch { deps.toast(t('panel.dl.zipFailed'), 5000); }
        })();
        return;
      }
      const cv = e.target.closest && e.target.closest('[data-conv]');
      if (cv) {
        e.preventDefault(); e.stopPropagation();
        const wrap2 = cv.closest('[data-fmenu]');
        if (wrap2) runMenuConversion(wrap2, cv.dataset.conv, cv);
        return;
      }
      const df = e.target.closest && e.target.closest('[data-drivefile]');
      if (df) {
        e.preventDefault(); e.stopPropagation();
        /* Single-file download through the Worker (same auth as the ZIP; a plain drive URL would
         * work for the owner, but this behaves identically signed in or not, and never leaves a
         * preview page).
         *
         * ⚠ SAY SOMETHING IMMEDIATELY (Seth, 2026-08-13): "it looks like it's trying to download
         * (and taking a long time with no status update) before the UI gets any response at all
         * when I click Download original audio… it did download eventually, but too a long time
         * before the user got any response."
         *
         * The whole file streams through the Worker into a Blob before the browser is handed
         * anything, so on a 217 MB original there are tens of seconds where a correct system looks
         * dead. There is no progress to report — fetchDriveFile resolves once, not incrementally —
         * so the honest fix is to say the request went out, and to keep saying it until the file
         * lands rather than implying a percentage we do not have. */
        const wrap2 = df.closest && df.closest('[data-fmenu]');
        const fname = df.dataset.fname || 'file';
        /* The TRAY is what survives closing this modal — and closing it is the normal thing to do
         * while a 217 MB original streams. The modal status line is a bonus while it is open. */
        const job = jobStart(fname, t('panel.dl.starting'));
        dlStatus(wrap2, t('panel.dl.fetching', { name: fname }));
        deps.toast(t('panel.dl.started'), 4000);
        const known = ((wrap2 && wrap2._allFiles) || []).find((f) => f && f.id === df.dataset.drivefile);
        const total = (known && known.size) || 0;
        Researcher.fetchDriveFile(df.dataset.drivefile, (got) => {
          const msg = total
            ? t('panel.dl.pct', { pct: Math.min(99, Math.round((got / total) * 100)), size: fmtSize(total) })
            : fmtSize(got);
          jobSet(job, msg);
          dlStatus(wrap2, t('panel.dl.fetching', { name: fname }) + ' ' + msg);
        }, memberDlVia(wrap2)).then((blob) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = fname;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 60000);
          dlStatus(wrap2, t('panel.dl.saved', { name: fname }));
          jobEnd(job, t('panel.dl.savedShort'));
        }).catch(() => {
          dlStatus(wrap2, '');
          jobEnd(job, t('panel.dl.failedShort'));
          deps.toast(t('panel.dl.zipFailed'), 5000);
        });
        return;
      }
    });
  }
}

/* The highest command seq ANY live install of an instance has processed.
 *
 * This is the single source of truth for "has the device seen it yet". ack_seq is monotonic
 * server-side (Math.max on every report), so a command with seq > this has demonstrably not been
 * acted on — and one with seq <= this has. MAX across installs, not per-install: an instance can
 * run the editor and the recorder side by side and either may hold the text, so the conservative
 * reading is the only one that cannot race. */
function ackOf(instances, instanceId) {
  let max = 0;
  for (const it of instances || []) {
    if (it.instance_id !== instanceId) continue;
    for (const ins of it.installs || []) max = Math.max(max, parseInt(ins.ack_seq, 10) || 0);
  }
  return max;
}

/* v3: the assigned-audio lookup (assignedCache / assignedFor) is GONE. It existed to feed the
 * downloads menu's "cached assignment link" fallback row — the one shown when the text's Drive
 * folder held no copy of the original audio. That row went with the rest of the inferred menu: a
 * text with no manifest now gets a single link to its Drive folder instead of a reconstructed list.
 * The History log still retains the assigned URLs; nothing reads them per-render any more. */

async function renderInstanceCard(it, deviceCount, memberCtx = null) {
  /* memberCtx = { caps, projectName } renders this card for a COWORKER's joined project: every
   * control maps to what the worker will actually honour for a member — manageDevices keeps
   * settings/upload/approve/revoke, createInvites keeps the invite button, the assignTexts-gated
   * text actions and the owner-only wipe/force-remove are ABSENT (not greyed out — the same rule
   * as the Drive capability), and the Files menus wait for the deferred drive:read. */
  const mCaps = memberCtx ? (memberCtx.caps || {}) : null;
  /* ⚠ A SHARED DEVICE THIS SEAT CANNOT KEY RENDERS WITH NO CONTROLS AT ALL (Seth, 2026-08-27:
   * "don't have the invite button or the settings button or the assign button or anything else
   * clickable by them"). Buttons that would only toast a refusal are absence-with-explanation
   * instead: the card stays visible, one note says the key arrives automatically, and the poll
   * repaints the buttons in the moment hasKey flips (it is in viewSig). The act-gate in
   * instanceAction stays as the backstop for stale DOM. */
  const mKeyless = !!memberCtx && it.hasKey === false;
  /* ⚠ Buttons render per CAPABILITY, and the flows themselves speak when a device is not ready —
   * the invite act toasts one line on a fully-unconfigured device instead of opening the
   * settings-modal-plus-banner pile (Seth, 2026-08-27: "don't give them a UI path that gives them
   * an error"). A desired_rev-based "configured" bit was tried and REVERTED the same day: renames
   * bump the rev, so it vouched for devices nobody had configured. */
  const mManage = (!memberCtx || !!mCaps.manageDevices) && !mKeyless;
  const mInvite = (!memberCtx || !!mCaps.createInvites) && !mKeyless;
  const mAssign = (!memberCtx || !!mCaps.assignTexts) && !mKeyless;   // texts: assign, done, delete
  const mDrive = (!memberCtx || mCaps.drive === 'read' || mCaps.drive === 'manage') && !mKeyless;   // Files… menu
  const installs = it.installs || [];
  const anyPending = installs.some((i) => i.status === 'pending');
  // Collected while the installs render, then shown in the COLLAPSED header too. A collapse that
  // hides a pending install, a remote wipe or a stuck engine would conceal exactly the states that
  // need attention — so these three ride the summary line and are visible either way.
  let anyStale = false, anyWipe = false, textCount = 0;
  const linked = installs.some((i) => i.status === 'approved' && i.has_key);
  const status = anyPending
    ? `<span class="rp-badge rp-badge-warn">${esc(t('panel.inst.pending'))}</span>`
    : linked ? `<span class="rp-badge rp-badge-ok">${esc(t('panel.inst.linked'))}</span>`
    : `<span class="rp-badge">${esc(t('panel.inst.noKey'))}</span>`;

  let installsHtml = '';
  for (const ins of installs) {
    if (ins.status === 'pending') {
      const fp = ins.pubkey ? await fpOf(ins.pubkey) : '—';
      // B: no key can be delivered until the field user accepts on their device — so until then
      // show "waiting for the user" instead of Approve (the worker would 409 the key anyway).
      /* PHASE 2 (2026-08-30): APPROVAL BELONGS TO ANYONE WITH DEVICE RIGHTS — owner or member —
       * because the worker now completes it: approveInstall asks the server-key lane to mint the
       * install wrap itself, so approving no longer strands a device waiting for the owner's key.
       * (The v471 rule this replaces — members see a waiting note, never the button — existed
       * precisely because keying was owner-only; that constraint is what Phase 2 removed. Seth,
       * 2026-08-30: "both member and owner CAN approve an accepted invite regardless of who is
       * owner and who minted the invite.")
       *
       * A member WITHOUT manageDevices still gets the honest waiting note: someone with device
       * rights has to do this, and the card says so rather than hiding the button. */
      const canApprove = !memberCtx || !!(memberCtx.caps || {}).manageDevices;
      const action = ins.accepted
        ? (canApprove
            ? `<button class="primary-btn" data-iact="approve" data-i="${esc(it.instance_id)}" data-id="${esc(ins.install_id)}">${esc(t('panel.inst.approve'))}</button>`
            : `<div class="note rp-waiting">${esc(t('panel.inst.waitingOwnerApprove'))}</div>`)
        : `<div class="note rp-waiting">${esc(t('panel.inst.waitingAccept'))}</div>`;
      /* ⚠ THE CODE IS THE HEADLINE; the fingerprint moved to fine print (Seth, 2026-08-20).
       * This card used to ask the researcher to visually match a long hex fingerprint against one
       * the device showed for twelve seconds and then forgot. When the coworker could not produce
       * it, the honest response was to refuse to approve — which is exactly what happened, and the
       * pairing dead-ended. Six digits, big, on both screens, until both ends approve.
       *
       * ⚠ THE FINGERPRINT STAYS, though, because it is still the stronger check and costs nothing
       * to keep: the six digits are ~20 bits, and anyone who wants the full comparison should be
       * able to have it. It is DEMOTED, not deleted.
       *
       * ⚠ An install claimed by an engine from before this shipped has no pair_code. Say so rather
       * than rendering an empty box — "no code" and "code is blank" look identical otherwise, and
       * the fingerprint line below is then the only thing to match on. */
      const pc = ins.pair_code || '';
      const codeHtml = pc
        ? `<div class="rp-pair-code" aria-label="${esc(t('panel.inst.codeAria', { code: String(pc).split('').join(' ') }))}">${esc(pc)}</div>
           <div class="note rp-verify">${esc(t('panel.inst.codeHint'))}</div>`
        : `<div class="note rp-verify">${esc(t('panel.inst.codeLegacy'))}</div>`;
      installsHtml += `<div class="rp-install rp-install-pending">
        <div><div>${esc(t('panel.inst.newInstall'))}</div>
          ${codeHtml}
          <div class="rp-mono rp-fp">${esc(t('panel.inst.fingerprint'))}: ${esc(fp)}</div></div>
        ${action}
      </div>`;
    } else {
      const inv = ins.inventory && Array.isArray(ins.inventory.items) ? ins.inventory.items : null;
      if (inv) textCount += inv.length;
      if (ins.wipe_state) anyWipe = true;
      /* ⚠ A CONFIRMED WIPE MEANS THE DEVICE IS GONE, and its last report is a historical record —
       * not a live inventory. The install row is revoked server-side and the device has erased
       * itself and will never poll again, but reported_blob is left untouched, so the card went on
       * offering Upload / Remove-from-device / Move / Done on texts that no longer exist anywhere
       * but Drive. Every one of those commands is queued to an instance nothing will ever read.
       * The Files ▾ downloads deliberately stay live: those Drive copies are real, and salvaging
       * them is the entire reason the row is still shown. */
      const wiped = ins.wipe_state === 'confirmed';
      // uploadDelete gate: only engine v94+ understands the upload-first delete command — an older
      // (or non-reporting) install gets a disabled button with a "must update first" tooltip instead
      // of a command it would drop on the floor. Devices auto-update, so this resolves itself.
      const engNum = parseInt(String((ins.inventory && ins.inventory.engineVersion) || '').replace(/[^0-9]/g, ''), 10);
      const canDelText = engNum >= 94 && !wiped;
      // Only surface finished/not-finished status when THIS device actually has the Done
      // feature on — else every text on other devices would carry a meaningless "not done".
      const doneOn = !!(ins.inventory && ins.inventory.settings && ins.inventory.settings.doneEnabled);
      // The inventory is decrypted from the field install's OWN report, so every value is
      // attacker-controllable once a device leaves the team's control. Titles go
      // through esc(); uploadState lands in a class attribute, so ALLOW-LIST it to the three
      // known states — never interpolate it raw (would permit an attribute-breakout XSS into
      // this privileged panel where Kr + the account secret live).
      // Computed once per card: the highest seq any install of THIS instance has processed.
      const maxAck = ackOf(lastData ? lastData.instances : [], it.instance_id);
      /* ⚠ A SENT ASSIGNMENT MUST NOT VANISH (v3 work order item 3). Seth: an edit-and-upload
       * "just disappears until the remote device loads it and then uploads it again". Between the
       * assign command being sent and the device's first inventory report there was NOTHING on
       * screen — no row, no marker — so a researcher on a field connection could not tell a
       * delivered assignment from one that never left. The upload queue card covers the bytes going
       * up; this covers the wait AFTER that, which is the longer half.
       *
       * The text has no inventory row yet, so one is synthesized and PREPENDED. It flows through
       * the same renderer as every other row, which is the point: the pending state is shown "the
       * way it shows a pending delete" rather than as a second, differently-behaved widget. */
      const invIds = new Set((inv || []).map((d) => d && d.id));
      /* Merged so a pending ASSIGN shows in every panel, not just the one that sent it. Both maps
       * are re-keyed to the plain docId here (serverPending is keyed per instance) and the local
       * marker wins on a clash: it is the same command, and it arrived first. */
      const allPending = new Map();
      for (const [, pc] of serverPending) if (pc.instanceId === it.instance_id) allPending.set(pc.docId, pc);
      for (const [docId, pc] of pendingCmds) if (pc.instanceId === it.instance_id) allPending.set(docId, pc);
      const ghosts = [...allPending].filter(([docId, pc]) =>
        pc.kind === 'assign' && !invIds.has(docId))
        .map(([docId, pc]) => ({ id: docId, title: pc.title || '', uploadState: '', hasAudio: !!pc.hasAudio, __assigning: true }));
      // Ghosts (incoming assigns) stay on top — they are news; the settled rows sort by #15's rule.
      const listed = [...ghosts, ...(inv || []).slice().sort(textOrder)];
      const rows = listed.length ? listed.map((d) => {
        /* ⚠ 'uploading' HAS A REAL WRITER — see the allow-list note below, which rightly warns
         * against carrying a state nothing can produce. The device now reports it whenever any file
         * for the doc is still queued, so "uploaded ✓" can no longer appear while audio is in
         * flight. */
        const us = (d.uploadState === 'uploaded' || d.uploadState === 'changed' || d.uploadState === 'uploading') ? d.uploadState : 'local';
        // ⚠ STATE FROM ack_seq, NOT FROM A CLOCK. `queued` = the device has not polled for it yet,
        // so it can still be withdrawn. `taken` = the device has it and is acting; offering a
        // cancel there would let the panel claim a text the device has already deleted, or claim an
        // upload never happened when it did. The Worker refuses it too — this just never asks.
        const p = pendingFor(d.id, it.instance_id);
        const queued = !!p && p.seq > maxAck;
        const taken  = !!p && p.seq <= maxAck;
        let disp = us;
        if (p && p.kind === 'upload') disp = queued ? 'requested' : 'slow';
        // A synthesized assign row has no reported state of its own — it IS the pending state.
        if (d.__assigning) disp = queued ? 'assigning' : 'assignTaken';
        // SECURITY: disp must stay within this fixed literal set — it lands in a class attribute in this
        // privileged panel; never let an attacker-controlled report value reach it (see note above).
        /* ⚠ 'justUploaded' IS GONE FROM THIS LIST (2026-08-31 audit) — it was UNREACHABLE, not
         * merely unused: `us` above collapses every reported value to local/uploaded/changed, and
         * the only overrides are requested/slow/assigning/assignTaken, so `disp` could never hold
         * it. Its chip, its label and its two translations were all dead weight inviting someone
         * to "fix" a state that never occurs. Narrowing an allowlist is also strictly safer, which
         * is the note below. If a just-uploaded confirmation is ever wanted, it needs a real
         * writer first — the string is not the missing half. */
        // SECURITY: disp must stay within this fixed literal set — see the note above.
        const DISP = ['local', 'uploaded', 'changed', 'uploading', 'requested', 'slow', 'assigning', 'assignTaken'].includes(disp) ? disp : 'local';
        // Action label by state — Upload (never sent) / Upload changes (edited since) / Re-upload (re-send).
        const label = { changed: 'panel.inst.uploadChanges', uploaded: 'panel.inst.reupload',
                        slow: 'panel.inst.resend' }[DISP] || 'panel.inst.upload';
        // A queued request TOGGLES: click again to withdraw it. Once taken, the button goes inert
        // and says so, rather than pretending an option exists that cannot be honoured.
        /* ⚠ ONE PENDING COMMAND PER TEXT (Seth, 2026-08-18: "I had both remove AND upload
         * registered as pending changes. I feel like that should never happen"). He is right, and
         * both directions were reachable: the Upload button stayed live under a pending delete, and
         * the Remove button stayed live under a pending upload, so a second command could be queued
         * on top of the first. That is incoherent on screen — an Upload button on a struck-through
         * row — and wasteful on the wire, since uploadDelete uploads a fresh copy itself, so
         * remove-after-upload just uploads the same text twice.
         * Computed here, above the buttons, because `d.pendingDelete` (the DEVICE's own flag) must
         * suppress the upload control too, not only a marker this panel knows about. */
        /* ⚠ A MOVE IS TWO PENDING ACTIONS, NOT ONE (Seth, 2026-08-19): a pending ASSIGNMENT to the
         * new device AND a pending REMOVAL from the old one. Only the assignment was modelled —
         * it rides a real command, so once moves became account-scoped it propagated to every panel
         * — while the removal existed as a chip and nothing else, because its command is not issued
         * until the destination confirms receipt. So the source row looked idle: no strikethrough,
         * and a live Remove button offering to queue a SECOND removal of a text already leaving.
         *
         * The removal is COMMITTED from the moment the move starts; only its delivery waits. So it
         * is shown as pending from the start, through the same `deleting` path a queued uploadDelete
         * already uses — one vocabulary, one appearance, in every panel, and every guard built on
         * `deleting` (no Upload, no Move, no second Remove) applies to it for free. */
        const mv = pendingMoves.get(d.id);
        const mvSource = !!mv && mv.from === it.instance_id;      // this device is LOSING the text
        const deleting = !!d.pendingDelete || !!(p && p.kind === 'delete') || mvSource;
        const uploading = !!(p && p.kind === 'upload');
        /* ⚠ A CANCEL FOLLOWS THE CAPABILITY OF THE COMMAND IT WITHDRAWS, which is why `may` is a
         * parameter rather than a single gate on this helper: withdrawing an ASSIGN is text work
         * (assignTexts) while withdrawing an UPLOAD is device management (manageDevices), and the
         * worker's capForCommand() draws exactly that line. Ungated, these three buttons were the
         * client promising an action the worker answers 404 to.
         * Falling back to the `taken` tag rather than to nothing is deliberate: a queued command a
         * seat may not cancel is still a command the row must SHOW, or the pending state disappears
         * and the text looks idle while something is on its way to the device. */
        const cancelBtn = (kind, may) => (may
          ? ` <button class="link-btn rp-cancel" data-iact="cancel-cmd" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}">${esc(t('panel.inst.cancel' + kind))}</button>`
          : ` <span class="rp-tag rp-tag-taken">${esc(t('panel.inst.pendingTag'))}</span>`);
        const takenTag = ` <span class="rp-tag rp-tag-taken" title="${esc(t('panel.inst.takenWhy'))}">${esc(t('panel.inst.taken'))}</span>`;

        const up = d.__assigning
          ? (queued ? cancelBtn('Assign', mAssign) : takenTag)
          : (deleting || wiped) ? ''                        // being removed, or the device is gone
          : uploading
            ? (queued ? cancelBtn('Upload', mManage) : takenTag)
            : (mManage ? ` <button class="link-btn rp-up" data-iact="upload" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-fileid="${esc(d.uploadedFileId || '')}">${esc(t(label))}</button>` : '');
        // Upload-first remote delete (v94+): the device uploads a fresh timestamped copy, THEN deletes.
        // The chip belongs to the device LOSING the text. The destination's half of the move is its
        // pending ASSIGNMENT, which its own ghost row already tells.
        const moveChip = mvSource ? ` <span class="rp-tag rp-tag-moving">${esc(t(mv.stage === 'assigned' ? 'panel.move.waitingDest' : 'panel.move.removingSrc'))}</span>` : '';
        const moveBtn = (memberCtx || !d.id || mv || d.__assigning || deleting || uploading || wiped) ? ''
          : ` <button class="link-btn" data-iact="move-text" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-title="${esc(d.title || '')}">${esc(t('panel.move.btn'))}</button>`;
        /* A move is NOTHING MORE than a pending assignment and a pending removal, each cancellable
         * on its own (Seth, 2026-08-19) — so no move-specific control exists. The removal wears the
         * same label and the same Cancel as any other pending removal; only its plumbing differs,
         * because until the destination confirms receipt there is no command to withdraw, just a
         * commitment to stop. Dropping the move record IS stopping it.
         *
         * Order matters: once stage 2 has issued the real uploadDelete, that command is the thing to
         * cancel, so it is tested first and the row falls through to the ordinary withdrawal. */
        const cancelRemovalBtn = ` <button class="link-btn rp-cancel" data-iact="cancel-removal" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-title="${esc(d.title || '')}">${esc(t('panel.inst.cancelDelete'))}</button>`;
        const del = (!d.id || d.__assigning || wiped) ? ''
          : (p && p.kind === 'delete') ? (queued ? cancelBtn('Delete', mAssign) : takenTag)
          : mvSource ? cancelRemovalBtn                     // committed, not yet issued as a command
          : uploading ? ''                                  // cancel the upload first, or wait it out
          : canDelText
            ? (mAssign ? ` <button class="link-btn rp-revoke" data-iact="del-text" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-title="${esc(d.title || '')}">${esc(t('panel.inst.delText'))}</button>` : '')
            /* ⚠ THE "UPDATE THE DEVICE FIRST" GREY-OUT IS FOR SOMEONE WHO COULD OTHERWISE DELETE.
             * It sits on the ELSE of canDelText and so used to escape the mAssign gate above it: a
             * member WITHOUT assignTexts, looking at an old device, was shown a dead greyed Remove
             * whose tooltip blamed the device's engine — when the real reason was that this seat may
             * not delete at all. Two different "no", and the wrong one was displayed.
             * A disabled control reads as a broken app (Seth's standing rule, and it has cost a bug
             * report before), so for a seat without the capability it is ABSENT; the grey-out is kept
             * only for those the message is actually about. */
            : (mAssign ? ` <button class="link-btn rp-revoke" disabled title="${esc(t('panel.inst.delNeedsUpdate'))}">${esc(t('panel.inst.delText'))}</button>` : '');
        // The done tag is a TOGGLE when the engine understands the setDone COMMAND — the dispatch
        // case shipped in v138. Gating on setDocDone's age (v100) was wrong: an older device ACKS
        // the unknown command and silently does nothing, which reads as "the toggle is broken".
        const canSetDone = engNum >= 138 && !wiped && mAssign;   // the toggle follows the assignTexts capability
        /* A pending done-toggle renders the TARGET state plus the same waiting tag every other
         * queued command wears — and not as a button, so a second click cannot queue a second
         * toggle while the first is still travelling. Retires on ack like every marker. */
        const donePend = p && p.kind === 'done' ? p : null;
        const doneTag = donePend
          ? `<span class="rp-tag ${donePend.done ? 'rp-tag-done' : 'rp-tag-notdone'}">${esc(t(donePend.done ? 'panel.inst.doneTag' : 'panel.inst.notDoneTag'))}</span><span class="rp-tag rp-tag-taken" title="${esc(t('panel.inst.toggleDoneTip'))}">${esc(t('panel.inst.pendingTag'))}</span>`
          : d.done
          ? (canSetDone ? `<button class="rp-tag rp-tag-done rp-tag-btn" data-iact="toggle-done" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-done="1" title="${esc(t('panel.inst.toggleDoneTip'))}">${esc(t('panel.inst.doneTag'))}</button>`
                        : `<span class="rp-tag rp-tag-done">${esc(t('panel.inst.doneTag'))}</span>`)
          /* ⚠ `|| canSetDone` — UN-MARKING DONE USED TO BE A ONE-WAY DOOR (Seth, 2026-08-28: "the
           * inability to un-mark done as a researcher is a known issue, I've run into that before").
           *
           * `doneOn` is the DEVICE's own `doneEnabled` setting — whether the FIELD USER sees the Done
           * feature on their phone. It was also gating the RESEARCHER's control, and those are two
           * different audiences asking two different questions. The consequence was a trap with no
           * way back: on a device with Done switched off, a text that IS done renders its chip as a
           * toggle (that branch never consulted doneOn), so the researcher can un-mark it — and the
           * moment they do, `d.done` goes false, this branch returns '', and the control they just
           * used disappears behind them. The state is now unreachable from the panel entirely.
           *
           * Rendering when `canSetDone` closes it: the control exists exactly when the researcher may
           * actually act, in BOTH directions. `canSetDone` already carries engine >= 138, not-wiped
           * and the assignTexts capability, so this adds a chip only where a click would work — never
           * to a read-only seat, and never to a device too old to honour the command.
           *
           * ⚠ THE COST, STATED: on a device with done-tracking off, texts now carry a quiet "not
           * finished" chip they did not before. That is the trade for the door not being one-way, and
           * it is reversible by returning this to `doneOn` alone if the chips prove noisy. */
          : ((doneOn || canSetDone) ? (canSetDone ? `<button class="rp-tag rp-tag-notdone rp-tag-btn" data-iact="toggle-done" data-i="${esc(it.instance_id)}" data-id="${esc(d.id)}" data-done="" title="${esc(t('panel.inst.toggleDoneTip'))}">${esc(t('panel.inst.notDoneTag'))}</button>`
                                  : `<span class="rp-tag rp-tag-notdone">${esc(t('panel.inst.notDoneTag'))}</span>`) : '');
        // Delete triggered (by device flag OR this researcher's just-clicked request) but not yet
        // confirmed → strike through + fade the whole row, and add a small "deleting…" tag.
        const delTag = deleting ? `<span class="rp-tag rp-tag-deleting">${esc(t('panel.inst.deletingTag'))}</span>` : '';
        // Downloads: labelled by PURPOSE (ELAN / SayMore / FLExText / FlexText Editor), never by
        // filename — two .eaf exports are near-impossible to tell apart by name. The assigned-audio
        // URL comes from the History log, the only place it is retained (the device reports what it
        // UPLOADED, never what it was given).
        // Files ▾ renders for EVERY text; the menu populates lazily from the text's Drive folder
        // when opened (filesMenuHtml), falling back to the static artifacts when there is no
        // folder yet. Rendering it unconditionally is the point of the per-text folder: the menu
        // is now the one place all of a text's artifacts live.
        // Members: the menu's listing rides drive:read, which is deferred — absent, not broken.
        /* ⚠ FILES ARE THE POINT OF SHARING (Seth, 2026-08-28: "there's really no meaningful sharing
         * until that works"). A member holding drive:read gets the same Files… menu the owner has,
         * downloading through the project-scoped route. Without the capability it is ABSENT rather
         * than disabled — a dead control reads as broken. */
        const dl = (memberCtx && !mDrive) ? ''
          : previewBtnHtml(it.instance_id, d.id, d.title || '', !!memberCtx)
            + filesMenuHtml(it.instance_id, d.id, d.title || '', '', '', !!memberCtx);
        // (5) The row reads in two lines: title + state chip, then muted metadata; actions sit on
        // the right. The tags stopped fighting the title for attention — that was Seth's "plain
        // line of text with plain hyperlinks is getting busy and ugly".
        const meta = d.__assigning
          ? esc(t(queued ? 'panel.up.assigningWhy' : 'panel.up.assignTakenWhy'))
          : `${d.hasAudio ? esc(t('panel.inst.audio')) : ''}${doneTag ? (d.hasAudio ? ' · ' : '') + doneTag : ''}`;
        return `<li class="rp-text-row ${deleting ? 'rp-pending-del' : ''}${d.__assigning ? ' rp-pending-assign' : ''}">
          <div class="rp-text-main">
            <div class="rp-text-title">${esc(textLabel(d))} <span class="rp-tag rp-tag-${DISP}">${esc(t('panel.up.' + DISP))}</span>${delTag}</div>
            <div class="note rp-text-meta">${meta}</div>
          </div>
          <div class="rp-text-actions">${dl}${up}${moveBtn}${del}</div>
        </li>`;
      }).join('')
        : `<li class="note">${esc(t('panel.inst.noTexts'))}</li>`;
      installsHtml += `<div class="rp-install">
        <div class="note">${esc(t('panel.inst.lastSeen', { when: lastSeen(ins.last_seen_at) }))} · ${esc(t('panel.inst.texts', { n: inv ? inv.length : 0 }))}</div>
        ${(() => {
          const di = deviceInfo(ins.inventory && ins.inventory.ua, ins.inventory && ins.inventory.cachedApps,
                                ins.inventory && ins.inventory.engineVersion, ins.inventory && ins.inventory.platform,
                                ins.install_id, ins.last_seen_at);
          const txt = di.text || t('panel.inst.verUnknown');
          // The badge is RESEARCHER/DEVELOPER-facing only — it never renders in the coworker's app.
          // A confirmed mismatch means the release process itself misfired, so give a way to report
          // it rather than leaving the researcher to describe a version mismatch from memory.
          let badge = '';
          if (di.stale) {
            anyStale = true;   // surfaced in the collapsed header too — see the note at the top of this function
            const detail = t('panel.dev.staleWhy', { running: di.running || '?', live: di.live || '?' });
            const body = encodeURIComponent(
              'A device is stuck on an old engine after a release.\n\n'
              + 'Running engine: ' + (di.running || 'unknown') + '\n'
              + 'Live engine: ' + (di.live || 'unknown') + '\n'
              + 'Platform: ' + ((ins.inventory && ins.inventory.platform) || 'unknown') + '\n\n'
              + 'Confirmed across two reports at least 6h apart, so this is not propagation delay.');
            const url = 'https://github.com/rulingAnts/flextext-editor/issues/new?title='
              + encodeURIComponent('Stale engine on a field device') + '&body=' + body;
            badge = ` <span class="rp-badge rp-badge-stale" title="${esc(detail)}">${esc(t('panel.dev.stale'))}</span>`
                  + ` <a class="rp-report" href="${url}" target="_blank" rel="noopener">${esc(t('panel.dev.staleReport'))}</a>`;
          }
          return `<div class="note rp-devinfo${di.text ? '' : ' rp-devinfo-old'}${di.stale ? ' rp-devinfo-stale' : ''}">${esc(txt)}${badge}</div>`;
        })()}
        <ul class="rp-inv">${rows}</ul>
        ${(() => {
          const I = esc(it.instance_id), D = esc(ins.install_id);
          /* ⚠ FORCE-REMOVE IS OWNER-ONLY, AND THE *BUTTON* IS WHAT IS WITHHELD — not the note.
           * The wipe STATE is information a member with manageDevices needs (a device that has erased
           * itself is why their controls vanished); the button acts on it, and worker/src/v1.js's
           * force-remove route is owner-only BY DESIGN — no capability will ever delegate it, so this
           * control could only ever 404 for a member (Seth: "don't add enabled buttons or links that
           * won't work").
           * ⚠ BOTH BRANCHES, not one. The comment above this card already claimed "the owner-only
           * wipe/force-remove are ABSENT (not greyed out)" while these two render sites were ungated —
           * an invariant asserted in prose and not held in code. This file has shipped a half-fix of
           * exactly that shape twice before (see the v469/v475 note on 'Open the Drive folder'), which
           * is why panel-shared-state now COUNTS the render sites rather than matching one. */
          if (ins.wipe_state === 'confirmed') return `<div class="note rp-wipe-done">${esc(t('panel.wipe.confirmed'))}</div>
            ${memberCtx ? '' : `<button class="link-btn rp-revoke" data-iact="force-remove" data-i="${I}" data-id="${D}">${esc(t('panel.wipe.removeBtn'))}</button>`}`;
          if (ins.wipe_state === 'requested') return `<div class="note rp-wipe-pending">${esc(t('panel.wipe.pending', { when: lastSeen(ins.wipe_at) }))}</div>
            ${memberCtx ? '' : `<button class="link-btn rp-revoke" data-iact="force-remove" data-i="${I}" data-id="${D}">${esc(t('panel.wipe.forceRemoveBtn'))}</button>`}`;
          /* ⚠ NOTHING HERE ANY MORE. Unlink and Erase used to hang off each install row as loose text
           * links; they now live in the device's own action row beside Delete, because all three act
           * on one device and reading them apart was the confusion (Seth, 2026-09-01: "kind of ugly
           * and awkwardly placed… we can put them all on the device buttons row"). Only the
           * wipe-STATE branches above still render here, since those describe this install. */
          return '';
        })()}
      </div>`;
    }
  }

  // Show the app(s) the device actually RUNS (from each install's reported inventory.type), not a
  // creation-time type — a unified device may run the editor, the recorder, or both.
  const apps = [...new Set((it.installs || []).map((i) => i.inventory && i.inventory.type).filter(Boolean))];
  const runs = apps.length ? apps.join(' + ') : (it.type || '');
  // Collapsed by default once there is more than one device; an explicit choice always wins.
  const collapsed = isCardCollapsed(collapsedCards, it.instance_id, deviceCount || 1);
  const bodyId = 'rp-inst-body-' + it.instance_id;
  // Warning badges that must NOT be hidden behind the collapse.
  const warnBadges = `${anyWipe ? ` <span class="rp-badge rp-badge-warn">${esc(t('panel.inst.wipeBadge'))}</span>` : ''}`
                   + `${anyStale ? ` <span class="rp-badge rp-badge-stale">${esc(t('panel.dev.stale'))}</span>` : ''}`;
  /* LEGACY-ESTATE FLAG (Seth, 2026-08-05: "with ANY researcher app, devices listed that use a
   * legacy URL should be flagged with a warning tip/banner that has a link to the migration
   * instructions"). Shown from BOTH panels, deliberately: on the legacy panel it duplicates the top
   * banner, but the top banner says "this PANEL is retiring" while this says "THIS DEVICE is still
   * on the old apps", which is the thing the researcher actually has to act on, one device at a
   * time. */
  /* ⚠ EXPLICIT 'pages' ONLY — deliberately NOT estateOfRecord(), which defaults a MISSING estate to
   * 'pages'. That default is right for building LINKS (never invent a migration for a record whose
   * estate we do not know) and wrong for a WARNING, where it converts "unknown" into an accusation:
   * every row rendered from a cached dashboard, or served by a worker predating the column, was
   * flagged "old address" — including devices that are not (Seth, 2026-08-05).
   *
   * Absence of evidence is not evidence. No estate ⇒ no badge. */
  const isLegacyDevice = it.estate === 'pages';
  const legacyBadge = isLegacyDevice
    ? ` <span class="rp-badge rp-badge-legacy">${esc(t('panel.inst.legacyBadge'))}</span>` : '';
  return `<div class="rp-card rp-inst${collapsed ? ' rp-inst-collapsed' : ''}">
    <div class="rp-inst-top">
      ${/* ⚠ THE QUICK ACTIONS ARE SIBLINGS OF THE COLLAPSE BUTTON, NOT CHILDREN OF IT.
           The whole header used to be one <button> so the entire row was a collapse target — good
           on a phone. A <button> cannot contain a <button>, so putting icons "in the header row"
           (Seth, 2026-09-01) meant splitting it: the toggle keeps the caret, the name and the
           badges and still takes all the leftover width, and the icons and the count sit beside it.
           The hit target shrinks by the width of three icons; nesting would have been invalid HTML
           that browsers silently reparent, which is worse than a smaller target. */''}
      <button class="rp-inst-toggle" data-iact="collapse" data-i="${esc(it.instance_id)}"
              aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="${esc(bodyId)}"
              title="${esc(t(collapsed ? 'panel.inst.expand' : 'panel.inst.collapse'))}">
        <span class="rp-caret" aria-hidden="true">▾</span>
        <span class="rp-inst-name"><span class="rp-inst-nick">${esc(it.nickname || '?')}</span> ${runs ? `<span class="rp-badge rp-badge-type">${esc(runs)}</span>` : ''} ${status}${warnBadges}${legacyBadge}</span>
        <span class="rp-inst-count">${esc(t('panel.inst.texts', { n: textCount }))}</span>
      </button>
      ${/* Far right, after a flexible gap — Seth, 2026-09-01: "put them on the far right and then
           move the number of texts to immediately following the status tiles (with no line break)".
           The count going back INSIDE the toggle also restores the collapse hit target it had
           before, so the phone-tap behaviour comes back with the layout fix. */''}
      ${collapsed ? '' : `<div class="rp-inst-quick">
        ${mAssign ? `<button class="rp-iconbtn" data-iact="assign" data-i="${esc(it.instance_id)}" title="${esc(t('panel.inst.assign'))}" aria-label="${esc(t('panel.inst.assign'))}">${ICON_NEWTEXT}</button>` : ''}
        ${mManage ? `<button class="rp-iconbtn" data-iact="settings" data-i="${esc(it.instance_id)}" data-type="${esc(it.type)}" title="${esc(t('panel.inst.settings'))}" aria-label="${esc(t('panel.inst.settings'))}">${ICON_GEAR}</button>` : ''}
        ${memberCtx ? '' : projectMoveIconBtn(it)}
      </div>`}
    </div>
    <div class="rp-inst-body" id="${esc(bodyId)}"${collapsed ? ' hidden' : ''}>
      ${isLegacyDevice ? `<p class="banner warn-banner rp-legacy-tip">${esc(t('panel.inst.legacyTip'))}
        <a href="${MIGRATE_DOC}" target="_blank" rel="noopener">${esc(t('panel.deprecated.coworkers'))}</a></p>` : ''}
      ${installsHtml || `<p class="note">${esc(t('panel.inst.noInstall'))}</p>`}
      ${mKeyless ? `<p class="note">${esc(t('panel.joined.keyPending'))}</p>` : ''}
      <div class="rp-inst-actions">
        ${/* The everyday actions moved to the header as icons; what is left on this row is the
             device's LIFECYCLE, in order: connect it, disconnect it, remove it, destroy it. */''}
        ${(() => {
          /* ⚠ THE THREE DESTRUCTIVE CONTROLS, TOGETHER AND GRADED (Seth, 2026-09-01).
           * Unlink and Delete are one segmented control with two halves: they are the pair a
           * researcher chooses BETWEEN (keep the device and move it, or remove it), they leave the
           * data alone, and pairing them visually says that. Erase is a separate hazard button —
           * different shape, different colour, skull — because it is the only one that destroys a
           * corpus, and the only one that cannot be undone.
           * ⚠ UNLINK AND ERASE NEED A LIVE INSTALL; DELETE DOES NOT. A device that was created but
           * never set up has nothing to unlink or erase, so those two are ABSENT rather than
           * disabled — Seth's standing rule: "don't add enabled buttons or links that won't work",
           * and a disabled control reads as broken. Delete still renders, which is what lets you
           * clear away a device that never got used. */
          if (!mManage) return '';
          const live = (it.installs || []).find((x) => !x.wipe_state);
          const I = esc(it.instance_id), NM = esc(it.nickname || '');
          /* ⚠ LINK AND UNLINK ARE ONE CONTROL, BECAUSE THEY ARE ONE AXIS (Seth, 2026-09-01: "even
           * better if we can make link/unlink a toggle. So until an invitation has been accepted,
           * the 'link' button shows (with a chain) and when it is accepted, it changes to
           * 'unlink'"). Two separate buttons could contradict each other — Invite offering to
           * connect a device that is already connected, Unlink offering to cut a link that was
           * never made.
           * ⚠ DRIVEN BY THE SAME `linked` THE BADGE USES (status === 'approved' && has_key), not by
           * "is there an install row": an install that has claimed the invite but is still awaiting
           * approval is NOT linked, and offering Unlink there would be offering to undo something
           * that has not happened. Sharing the expression is what stops the toggle and the badge
           * ever telling different stories about the same device. */
          /* ⚠ THE HINGE IS "IS THERE A LIVE INSTALL", NOT "IS IT APPROVED" — and the middle state is
           * why (Seth asked what happens there). Between the field user accepting on their device
           * and the researcher approving, the install exists with status 'pending'. Keying this on
           * the badge's `linked` (approved && has_key) showed LINK in that window, which is not
           * merely unhelpful but harmful: the invite is already claimed and spent, and minting a
           * fresh one REVOKES the pending install (worker, "single-live-device, §D.4"). The button
           * would have offered to destroy the enrollment the researcher was about to approve, while
           * looking like a setup step.
           * Unlink is right there — revoking a pending install is a real action ("that is not the
           * device I meant") and the worker's route takes it with no status check.
           * ⚠ SO THE BUTTON AND THE BADGE DELIBERATELY DIVERGE in that window, and that is correct:
           * the badge answers "what state is this device in" (pending), the button answers "what can
           * I do about it" (cancel it). An earlier comment here claimed sharing one expression kept
           * them honest; it did not — it made the button wrong. */
          const connect = live
            ? (`<button class="rp-split-half" data-iact="revoke-install" data-i="${I}" data-id="${esc(live.install_id)}" data-name="${NM}" title="${esc(t('panel.inst.revokeInstallTip'))}" aria-label="${esc(t('panel.inst.revokeInstall'))}">${ICON_UNLINK}<span>${esc(t('panel.inst.revokeInstall'))}</span></button>`)
            : (mInvite ? `<button class="rp-split-half" data-iact="invite" data-i="${I}" data-type="${esc(it.type)}" title="${esc(t('panel.inst.inviteTip'))}" aria-label="${esc(t('panel.inst.link'))}">${ICON_LINK}<span>${esc(t('panel.inst.link'))}</span></button>` : '');
          const unlink = connect;
          const del = `<button class="rp-split-half" data-iact="revoke" data-i="${I}" data-name="${NM}" data-i18n-title="panel.inst.revokeTip" title="${esc(t('panel.inst.revokeTip'))}">${ICON_X}<span>${esc(t('panel.inst.revoke'))}</span></button>`;
          const wipe = (!memberCtx && live)
            ? `<button class="rp-wipe-btn" data-iact="wipe-install" data-i="${I}" data-id="${esc(live.install_id)}" data-name="${NM}" data-i18n-title="panel.wipe.tip" title="${esc(t('panel.wipe.tip'))}"><span class="rp-skull" aria-hidden="true">☠</span><span>${esc(t('panel.wipe.btn'))}</span></button>`
            : '';
          /* No separator element: the group takes its own line (flex-basis:100%), so there is
           * nothing to divide horizontally. */
          return `<div class="rp-danger-group"><div class="rp-split-btn">${unlink}${del}</div>${wipe}</div>`;
        })()}
      </div>
    </div>
  </div>`;
}

/* One dashboard poll. Inside this, the cached view is what the panel is already showing, so opening
 * a modal from it shows the researcher exactly what is on their screen. */
const FRESH_VIEW_MS = 15000;
let lastView = null;
/* An instance by id from EITHER side of the view — owned, or a joined project's (2026-08-27).
 * Every action handler that resolves an instance goes through this, or member cards' buttons
 * would find nothing and silently do nothing. */
function viewInst(v, id) {
  return ((v && v.instances) || []).find((x) => x.instance_id === id)
    || ((v && v.memberProjects) || []).flatMap((mp) => mp.instances || []).find((x) => x.instance_id === id);
}

async function instanceAction(el) {
  /* Wrapped rather than sprinkled over "the slow ones": every branch below either opens a modal or
   * touches the network, and a hand-picked list would be wrong the first time a fast one grew a
   * fetch. */
  const done = loadingScrim();
  if (el) el.classList.add('rp-busy');
  try {
    return await instanceActionInner(el);
  } finally {
    done();
    if (el) el.classList.remove('rp-busy');
  }
}

async function instanceActionInner(el) {
  const id = el.dataset.i, installId = el.dataset.id, type = el.dataset.type;
  const act = el.dataset.iact;
  try {
    if (act === 'collapse') {
      // ⚠ A DOM FLIP, DELIBERATELY NOT A RE-RENDER. renderDashboard() would refetch and rebuild
      // every card just to hide one; the state is re-derived on the next 12s poll anyway, so the
      // card comes back exactly as left. Nothing animates, so there is nothing to flicker.
      const card = el.closest('.rp-inst');
      const body = card && card.querySelector('.rp-inst-body');
      if (!card || !body) return;
      const nowCollapsed = !body.hidden;
      body.hidden = nowCollapsed;
      card.classList.toggle('rp-inst-collapsed', nowCollapsed);
      el.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      el.title = t(nowCollapsed ? 'panel.inst.expand' : 'panel.inst.collapse');
      collapsedCards.set(id, nowCollapsed);
      saveCollapsed(Researcher.currentAccountId());   // persist BEFORE the next render reads it back
      return;
    }
    /* A shared device whose key has not reached this seat yet cannot have its settings read or an
     * invite minted — those need Ki. Say WHY and when it will fix itself, instead of surfacing a
     * raw no_key_for_instance (the no-silently-disabled-controls rule). Fresh listView on purpose:
     * the grant may have landed since the cards painted, and a stale "not yet" here would block a
     * healed member. ⚠ 'approve' is NOT in this list since Phase 2: the worker mints the install
     * wrap itself on the server-key lane, so approving needs no key material on this seat. */
    /* ⚠ ONE listView, NOT TWO. This gate fetched the view and the settings branch below fetched it
     * AGAIN — two full round-trips before the modal could open, which is most of why Settings felt
     * "very slow" on a poor link. preView carries the first one forward. */
    /* ⚠ AND WHERE POSSIBLE, ZERO ROUND-TRIPS (Seth: "what can we do to reduce the network load time
     * there without breaking any functionality?"). The dashboard poll already fetched exactly this —
     * lastData IS a Researcher.listView() result (see the note at the pendingCmds sweep) — so on a
     * panel that has polled recently the modal can open with no request at all.
     * ⚠ BOUNDED BY AGE, NOT USED BLINDLY. Past FRESH_VIEW_MS we fetch, so what the researcher edits
     * is never more than one poll stale. That is the whole safety argument: the save path is
     * separately protected by settings_rev, but showing someone stale values to edit is its own bug.
     * Net effect on a slow link: Settings went from TWO full round-trips to one, and now usually to
     * none. */
    let preView = (lastData && (Date.now() - lastDataAt) < FRESH_VIEW_MS) ? lastData : null;
    if (act === 'settings' || act === 'invite') {
      const v = preView || (preView = await Researcher.listView());
      const owned = ((v && v.instances) || []).some((x) => x.instance_id === id);
      const mInst = owned ? null : viewInst(v, id);
      if (mInst && mInst.hasKey === false) { deps.toast(t('panel.joined.keyPending'), 8000); return; }
    }
    if (act === 'approve') {
      lastView = await Researcher.listView();
      const inst = viewInst(lastView, id);
      const ins = inst && inst.installs.find((x) => x.install_id === installId);
      /* Owner or member with manageDevices (Phase 2) — approveInstall asks the worker's server-key
       * lane to mint the wrap, falling back to the legacy client-side wrap when this seat can. */
      await busy(el, () => Researcher.approveInstall(id, installId, ins && ins.pubkey));
      deps.toast(t('panel.inst.approved'), 4000);
      renderDashboard();
    } else if (act === 'revoke') {
      if (!await confirmModal(t('panel.inst.confirmRevoke', { name: el.dataset.name || '' }))) return;
      await busy(el, () => Researcher.revokeInstance(id));
      renderDashboard();
    } else if (act === 'revoke-install') {
      if (!await confirmModal(t('panel.inst.confirmRevokeInstall', { name: el.dataset.name || '' }))) return;   // UNLINK — warns local data stays on the device
      await busy(el, () => Researcher.revokeInstall(id, installId));
      renderDashboard();
    } else if (act === 'wipe-install') {
      wipeConfirmModal(id, installId, el.dataset.name || '');       // REMOTE WIPE — typed confirm (+ TOTP step-up)
    } else if (act === 'force-remove') {
      if (!await confirmModal(t('panel.wipe.confirmForceRemove'))) return;
      await busy(el, () => Researcher.forceRemoveInstall(id, installId));
      renderDashboard();
    } else if (act === 'invite') {
      // Gate: don't mint an invite for a device that lacks minimal usable settings, or the field
      // worker ends up with a broken device. Validate the researcher-side snapshot, falling back to
      // whatever the device last reported — so a device configured before this feature (or via the
      // device itself) isn't forced through a redundant re-save.
      const snap = await Researcher.getInstanceSettings(id).catch(() => null);
      lastView = await Researcher.listView();
      const inst = viewInst(lastView, id);
      const effective = snap || (inst && firstInventorySettings(inst));
      const probs = effective ? validateDeviceSettings(settingsToRaw(effective)) : null;
      /* A FULLY-unconfigured device gets ONE quiet line and nothing else — no modal, no red
       * banner, no error (Seth, 2026-08-27: "don't give them a UI path that gives them an
       * error"). The bounce-into-Settings below is kept ONLY for the partially-configured case,
       * where someone has started and the banner's links point at exactly what is missing. */
      if (!effective) { deps.toast(t('panel.joined.needsSetup'), 8000); return; }
      if (probs && probs.length) {
        deps.toast(t('panel.invite.fixSettings'), 6000);
        if (inst) await openSettingsModal({ kind: 'instance', instance: inst }, { flagOnOpen: true });
        return;
      }
      inviteModal(id);
    } else if (act === 'assign') {
      assignModal(id);
    } else if (act === 'upload') {
      const docId = el.dataset.id;                                         // data-id is the doc id here
      const prevFileId = el.dataset.fileid || '';                          // snapshot: a DIFFERENT id later = this upload landed
      // Keep the seq the Worker assigned — it is what makes the request withdrawable, and what
      // ack_seq is later compared against to know whether it still can be.
      const r1 = await busy(el, () => Researcher.triggerUpload(id, docId)); // throws on failure → caught below → no marker set
      pendingCmds.set(docId, { seq: r1.seq, kind: 'upload', instanceId: id, prevFileId, at: Date.now() });
      savePending(Researcher.currentAccountId());
      deps.toast(t('panel.inst.uploadSent'), 5000);
      renderDashboard(lastData || undefined);                             // instant feedback: row flips to "request sent…"
    } else if (act === 'del-text') {
      // Upload-first delete: the confirm spells out the safety order (fresh Drive copy FIRST, delete
      // only after it's confirmed).
      if (!await confirmModal(t('panel.inst.confirmDelText', { title: el.dataset.title || '?' }))) return;
      const r2 = await busy(el, () => Researcher.uploadDelete(id, el.dataset.id));  // data-id is the doc id here
      pendingCmds.set(el.dataset.id, { seq: r2.seq, kind: 'delete', instanceId: id, at: Date.now() });
      savePending(Researcher.currentAccountId());
      deps.toast(t('panel.inst.delSent'), 5000);
      renderDashboard(lastData || undefined);
    } else if (act === 'cancel-removal') {
      /* The pending REMOVAL half of a move, before stage 2 has issued it as a command. There is
       * nothing on the server to withdraw — the commitment lives in the account's move record — so
       * cancelling it IS dropping that record, which also stops the sweep from ever issuing it.
       * The assignment half is untouched and proceeds: the text ends up on both devices, which is a
       * legitimate thing to want and the reason this is separately cancellable at all. */
      /* ⚠ CONFIRMED, because the end state it produces is not one the storage model really supports.
       * There is exactly ONE Drive folder per text: driveEnsureTextFolder resolves it by the GLOBAL
       * flextextDoc tag (not parent-scoped), and /move RE-PARENTS that one folder rather than
       * copying it. So a text left on both devices does not become two folders — it becomes one
       * folder with two writers, sitting under the destination device, receiving divergent uploads
       * from both, with no way to tell which copy is newest. Cancelling the ASSIGNMENT is the safe
       * way to call a move off; this one is a deliberate choice and says so. */
      const docId = el.dataset.id;
      if (!await confirmModal(t('panel.move.keepBothWarn', { title: el.dataset.title || '?' }))) return;
      await busy(el, () => saveMoves((cur) => { delete cur[docId]; return cur; }));
      deps.toast(t('panel.inst.cancelled'), 4000);
      renderDashboard(lastData || undefined);
    } else if (act === 'cancel-cmd') {
      // Withdraw a request the device has not picked up. The Worker re-checks ack_seq and refuses
      // with 409 already_delivered if it is too late — that refusal is SHOWN, never swallowed,
      // because a cancel the researcher believes worked but did not is the dangerous outcome: the
      // panel would claim a text the device has already deleted.
      /* ⚠ CANCEL THE COMMAND THE ROW IS SHOWING — through pendingFor, the SAME lookup the renderer
       * used to decide there was something to cancel. Reading pendingCmds directly here was wrong
       * twice over (Seth, 2026-08-18):
       *   - in a browser that learned of the command from the SERVER, there is no local marker, so
       *     the button returned silently: no request, no toast, nothing withdrawn;
       *   - a STALE local marker (one whose command is long gone from the queue) sent its old seq
       *     instead, so the Worker withdrew a different command and answered 200 — the researcher
       *     got "cancelled" while the delete they meant to stop stayed queued and later ran.
       * `not_queued` is reported as cancelled on purpose: the Worker checks ack_seq FIRST, so a 404
       * here proves the command was neither run nor queued — it is already gone. */
      const docId = el.dataset.id;
      const p = pendingFor(docId, id);
      if (!p) { renderDashboard(lastData || undefined); return; }
      /* ⚠ SURGICAL, NOT INVALIDATED. Dropping the cached blob forced refreshServerPending to refetch
       * on the very next render, so the row the researcher had just acted on sat unchanged through a
       * SECOND round trip — the visible lag. We already know the exact truth the refetch would
       * return: this one seq is gone. Apply it locally and render from cache.
       * The cached `rev` is deliberately left stale, so the next poll still sees the server's newer
       * desired_rev, refetches once, and reconciles anything a concurrent panel did. */
      const forget = () => {
        pendingCmds.delete(docId);
        savePending(Researcher.currentAccountId());
        serverPending.delete(spKey(id, docId));
        /* ⚠ CANCELLING THE ASSIGNMENT MUST CANCEL THE REMOVAL WITH IT — the one place the move's two
         * halves are NOT independent, and the direction that would lose data. A removal whose
         * delivery never happened must never fire: the source would delete a text the destination
         * never received. (Cancelling the removal alone is fine and stays independent — the text
         * simply ends up on both devices.) Dropping the record also releases a move that would
         * otherwise wedge at stage 'assigned' forever, holding the source row struck through. */
        if (pendingMoves.has(docId)) saveMoves((cur) => { delete cur[docId]; return cur; });
        const hit = blobCache.get(id);
        if (hit) hit.cmds = (hit.cmds || []).filter((c) => c && c.seq !== p.seq);
        const known = serverSeqs.get(id);
        if (known) known.delete(p.seq);
      };
      try {
        await busy(el, () => Researcher.cancelCommand(p.instanceId || id, p.seq));
        forget();
        deps.toast(t('panel.inst.cancelled'), 4000);
      } catch (e) {
        const msg = String((e && e.message) || '');
        if (/not_queued|404/.test(msg)) { forget(); deps.toast(t('panel.inst.cancelled'), 4000); }
        // Too late: leave the marker in place so the row correctly shows "in progress".
        else deps.toast(t(/already_delivered|409/.test(msg) ? 'panel.inst.cancelTooLate' : 'panel.inst.cancelFailed'), 7000);
      }
      /* Render from what we already hold — instantly. `forget()` has applied the one fact a refetch
       * would have returned, so a round trip here buys nothing but the delay. The 12s poll
       * reconciles against the server's newer desired_rev, which is why the cached rev is left stale.
       * ⚠ Deliberately NOT awaited on a fresh fetch: a UI that updates on click and reconciles a
       * moment later beats one that is correct but appears stuck (Seth, 2026-08-18). */
      renderDashboard(lastData || undefined);
    } else if (act === 'move-text') {
      // Through busy(): the eligibility check lists the folder first, so the button must show it is
      // working rather than looking dead until the picker appears (or the refusal toast fires).
      await busy(el, () => moveTextModal(id, el.dataset.id, el.dataset.title || ''));
    } else if (act === 'toggle-done') {
      const want = !el.dataset.done;
      const r = await busy(el, () => Researcher.setDone(id, el.dataset.id, want));
      /* The marker is the point (BACKLOG: the toast alone read as "that did nothing"). Recorded
       * exactly as a delete is, so the chip renders pending until the device acks — in THIS
       * browser instantly via pendingCmds, in every other via serverPending's next poll. */
      if (r && r.seq) {
        pendingCmds.set(el.dataset.id, { seq: r.seq, kind: 'done', instanceId: id, at: Date.now(), done: want });
        savePending(Researcher.currentAccountId());
      }
      deps.toast(t(want ? 'panel.move.doneSent' : 'panel.move.notDoneSent'), 4000);
      renderDashboard(lastData || undefined);
    } else if (act === 'settings') {
      lastView = preView || await Researcher.listView();   // already fetched by the gate above
      const inst = viewInst(lastView, id);
      openSettingsModal({ kind: 'instance', instance: inst });
    }
  } catch (e) { errToast(e); }
}

/* ---------------- modals: new device / invite / assign / account ---------------- */

function newDeviceModal() {
  /* Born into the project on screen (resolved once, so the NOTE below and the create call cannot
   * disagree). `currentProject` is the tab the researcher is looking at; STRAY_TAB and a flat
   * estate both mean "no project named", which is the lazy default — and so does a SHARED tab:
   * its id is a D1 uuid, not a Drive folder, and the new device is the researcher's own. */
  const intoProject = (currentProject && currentProject !== STRAY_TAB && !isMemberTab(currentProject)) ? currentProject : '';
  const projName = intoProject
    ? ((((estateCache && estateCache.projects) || []).find((p) => p.folderId === intoProject) || {}).name || '')
    : '';
  /* A SHARED tab on screen creates INTO that shared project when the owner granted manageDevices —
   * the device is born the owner's, in their Drive, keyed by this seat (createMemberInstance).
   * Without the cap the create falls back to the researcher's OWN estate, and the note SAYS so
   * up front — a device silently landing outside the tab you were looking at read as data loss
   * (Seth, 2026-08-27: "it put it in a 'not in a project yet' tab"). */
  const sharedMp = isMemberTab(currentProject)
    ? ((lastData && lastData.memberProjects) || []).find((x) => memberTabId(x.project_id) === currentProject) : null;
  const intoShared = sharedMp && (sharedMp.caps || {}).manageDevices ? sharedMp : null;
  const m = modal(`
    <h3>${esc(t('panel.new.title'))}</h3>
    <label class="rp-field"><span>${esc(t('panel.new.nick'))}</span><input id="rp-new-nick" placeholder="${esc(t('panel.new.nickPh'))}" spellcheck="false"></label>
    ${intoShared ? `<p class="note">${esc(t('panel.new.intoShared', { name: sharedMp.name || '?' }))}</p>` : ''}
    ${sharedMp && !intoShared ? `<p class="note">${esc(t('panel.new.sharedNoCap', { name: sharedMp.name || '?' }))}</p>` : ''}
    ${projName ? `<p class="note">${esc(t('panel.new.intoProject', { name: projName }))}</p>` : ''}
    <p class="note">${esc(t('panel.new.unifiedNote'))}</p>
    <button class="primary-btn" data-m="create">${esc(t('panel.new.create'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.new.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="create"]').onclick = (e) => busy(e.target, async () => {
    const nick = m.el.querySelector('#rp-new-nick').value.trim();
    if (!nick) return deps.toast(t('panel.new.needNick'), 4000);
    /* ⚠ TWO TRY BLOCKS, because "the device could not be created" and "the device exists but its
     * settings were not delivered" are DIFFERENT facts, and one catch made them one message —
     * which is how a researcher came to see "failed to create" over a device that existed, then
     * met it later as a ghost (issue #6). Creation failure ends here; anything after names the
     * true state and points at the retry (the device card's Settings). */
    let inst = null;
    try {
      inst = intoShared
        ? await Researcher.createMemberInstance(intoShared.project_id, nick)
        : await Researcher.createInstance(nick, intoProject);
    }
    catch (err) { errToast(err); return; }
    m.close(); renderDashboard();
    // A new device has no settings yet — open them straight away so it gets configured. Invite-link
    // creation stays blocked until the required fields are filled in, so this isn't skippable.
    // projectFolderId seeds the form from the project's default settings (v519): the estate cache
    // cannot know a device created seconds ago, so the folder rides along explicitly.
    deps.toast(t('panel.new.configure'), 5000);
    try {
      await openSettingsModal({ kind: 'instance', instance: { instance_id: inst.instance_id, nickname: inst.nickname, installs: [] } }, { projectFolderId: intoProject });
    } catch (err) {
      deps.toast(t('panel.new.createdNotConfigured'), 9000);
    }
  });
}

async function inviteModal(instanceId) {
  const m = modal(`<h3>${esc(t('panel.invite.title'))}</h3>${loadingHtml('panel.invite.loading', true)}`);
  try {
    // ONE invite, rendered as BOTH app URLs. The coworker opens whichever app(s) they use; same-origin
    // editor + recorder share one identity, so opening either binds the SAME device — one claim, one
    // consent, one approval, even if both links are sent.
    const invite = await Researcher.mintInvite(instanceId);
    /* THIS instance's estate, from the MINT RESPONSE — server truth. The cached dashboard is not
     * good enough: a brand-new device is not in it yet, the lookup missed, and estateOfRecord(undefined)
     * fell back to 'pages' — which sent every new coworker to the legacy apps even though the row
     * said 'cloud' (Seth, 2026-08-05; confirmed against D1). The cache is only a fallback now, and
     * an unknown instance is an ERROR rather than a guess: guessing legacy is exactly the bug. */
    const cached = ((lastData && lastData.instances) || []).find((x) => x.instance_id === instanceId);
    const estate = invite.estate || (cached && cached.estate);
    if (!estate) throw new Error('Could not determine which app this device should install — reload the panel and try again.');
    const B = basesFor(estate);
    const urls = { editor: Researcher.inviteUrl(B.editor, invite), recorder: Researcher.inviteUrl(B.recorder, invite) };
    const exp = invite.expires_at ? new Date(invite.expires_at).toLocaleString() : '';
    const row = (label, key) => `
      <div class="rp-field"><span>${esc(label)}</span>
        <textarea class="rp-linkbox" readonly rows="2" data-url="${key}">${esc(urls[key])}</textarea>
        <div class="rp-inst-actions"><button class="secondary-btn" data-copy="${key}">${esc(t('panel.invite.copy'))}</button>
        <button class="link-btn" data-share="${key}">${esc(t('panel.invite.share'))}</button>
        ${/* Issue #3's honest half: pairing THIS browser is just opening the claim link here — a
            plain anchor, so it cannot silently skip the settings gate (the invite already passed
            it) and works exactly like the link a coworker would tap. */''}
        <a class="link-btn" href="${esc(urls[key])}" target="_blank" rel="noopener noreferrer">${esc(t('panel.invite.openHere'))}</a></div></div>`;
    m.el.querySelector('.modal-card').innerHTML = `
      <h3>${esc(t('panel.invite.title'))}</h3>
      <p class="note">${esc(t('panel.invite.introUnified'))}</p>
      ${/* Links are minted FRESH on every open and shown once (only a hash is stored), so nobody —
          including the minter — can re-display an earlier link. Said here because a coworker
          clicking "Invite link" after someone else already sent one would otherwise assume they
          are LOOKING at that link (Seth, 2026-08-27); earlier links stay claimable until claimed
          or expired. */''}
      <p class="note">${esc(t('panel.invite.freshNote'))}</p>
      <!-- ⚠ WARN THE RESEARCHER, NEVER THE DEVICE USER (Seth, 2026-08-07). Claiming an invite makes
           the device managed: its Settings tab disappears and everything on it comes from here, so
           whatever the coworker had set up themselves is superseded the moment they tap the link.
           The RESEARCHER is the one who can weigh that, and the one issuing the link — so they get
           told, here, before they send it.
           The coworker deliberately gets NO such warning: the whole premise of this suite is that
           they should not be expected to understand what "your local settings will be overridden"
           means, let alone make an informed decision about it while a speaker waits. -->
      <p class="note rp-invite-warn">${esc(t('panel.invite.overrideWarn'))}</p>
      ${row(t('panel.invite.editorLink'), 'editor')}
      ${row(t('panel.invite.recorderLink'), 'recorder')}
      ${exp ? `<p class="note">${esc(t('panel.invite.expires', { when: exp }))}</p>` : ''}
      <button class="link-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`;
    m.el.querySelector('[data-m="close"]').onclick = m.close;
    m.el.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => {
      const u = urls[b.dataset.copy];
      try { await navigator.clipboard.writeText(u); deps.toast(t('panel.invite.copied'), 3000); }
      catch { const ta = m.el.querySelector(`[data-url="${b.dataset.copy}"]`); if (ta) ta.select(); }
    }; });
    m.el.querySelectorAll('[data-share]').forEach((b) => { b.onclick = () => {
      const u = urls[b.dataset.share];
      if (navigator.share) navigator.share({ url: u, text: t('panel.invite.shareText') }).catch(() => {});
      else window.open('https://wa.me/?text=' + encodeURIComponent(u), '_blank');
    }; });
  } catch (e) { m.close(); errToast(e); }
}

/* The assign modal (assign-by-upload, 2026-08-11): the researcher picks the ACTUAL FILES — pasted
 * URLs are retired entirely, and with them the probe/soft-CORS confirm ladder and the assign-copy
 * call (the upload IS the copy). Validation is local and deterministic: the audio verdict reads
 * the file's own bytes, the flextext parses in-panel, and a WS mismatch gets the explicit
 * Send-anyway/Cancel dialog. Send absorbs the files into IndexedDB FIRST (locked decision 8) and
 * queues a resilient background upload; the assign command goes out only after the upload
 * finishes, so a dropped connection can never produce a half-assignment. */
/* ⚠ ONE MODAL, TWO DESTINATIONS (issue #4). `target` is either an instanceId — the device lane,
 * unchanged — or `{ projectFolderId }`, which uploads the text into that project's Unassigned and
 * assigns it to nobody: "at a later time, I can move/assign it to the device of my choice". The
 * picking, validating and queueing are identical, which is exactly why this is one modal and not a
 * second copy that drifts. */
function assignModal(target) {
  const projectFolderId = (target && typeof target === 'object') ? (target.projectFolderId || '') : '';
  const instanceId = projectFolderId ? '' : target;
  /* ⚠ WHOSE DRIVE THE FILES LAND IN DEPENDS ON WHO IS SENDING. An assign-by-upload always writes
   * into the DEVICE OWNER's Drive — that is the point of the route — so telling a coworker their
   * files are "stored privately in your Drive" is simply false, and it is false about the one thing
   * a researcher most needs to be right about (Seth's standing line on Drive scope). Found by
   * opening the real modal on the member seat rather than by reading the string. */
  const assignAsMember = !projectFolderId
    && !((lastData && lastData.instances) || []).some((x) => x.instance_id === instanceId);
  const m = modal(`
    <h3>${esc(t(projectFolderId ? 'panel.assign.projTitle' : 'panel.assign.title'))}</h3>
    <p class="note">${esc(t(projectFolderId ? 'panel.assign.projIntro'
                                            : (assignAsMember ? 'panel.assign.introMember' : 'panel.assign.intro')))}</p>
    <label class="rp-field"><span>${esc(t('panel.assign.titleField'))}</span><input id="rp-as-title" spellcheck="false"></label>
    <label class="rp-field"><span>${esc(t('panel.assign.audioFile'))}</span><input type="file" id="rp-as-audio" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.webm,.flac,.3gp,.amr"></label>
    <label class="rp-field"><span>${esc(t('panel.assign.flextextFile'))}</span><input type="file" id="rp-as-ft" accept=".flextext,.xml"></label>
    <div class="rp-notice rp-notice-sm" id="rp-as-ft-warn" hidden><b>${esc(t('panel.assign.roundTripTitle'))}</b>${t('panel.assign.roundTripBody')}</div>
    <p class="rp-as-status" id="rp-as-status" role="status" hidden></p>
    <button class="primary-btn" data-m="send">${esc(t('panel.assign.send'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  // The FLEx round-trip warning is only relevant once they're actually attaching a flextext
  // file — showing it on an audio-only assignment is noise that trains people to ignore it.
  const ftInput = m.el.querySelector('#rp-as-ft');
  const ftWarn = m.el.querySelector('#rp-as-ft-warn');
  const syncFtWarn = () => { ftWarn.hidden = !(ftInput.files && ftInput.files.length); };
  ftInput.addEventListener('change', syncFtWarn);
  syncFtWarn();

  /* ── THE TITLE FILLS ITSELF IN ────────────────────────────────────────────────────────────────
   * Seth's priority order (2026-08-14), highest first:
   *   1. what the researcher TYPES into the box
   *   2. the title inside the flextext's XML (the first one that appears)
   *   3. the flextext's filename
   *   4. the audio file's filename
   *
   * So a flextext is asked what it calls ITSELF before its filename is considered: FLEx stores a
   * real title, and a file called "export_final_2.flextext" is a fact about somebody's desktop
   * rather than about the text. The filename is the fallback for a flextext that carries no title.
   *
   * ⚠ TYPING WINS, ALWAYS. `touched` latches on the first keystroke and is never cleared by a file
   * change. The one exception is a field they have EMPTIED, which reads as asking for the default
   * back rather than as a deliberate blank — an assignment with no title helps nobody downstream. */
  const titleInput = m.el.querySelector('#rp-as-title');
  const audioInput = m.el.querySelector('#rp-as-audio');
  let touched = false;
  titleInput.addEventListener('input', () => { touched = true; });
  const baseName = (n) => String(n || '').replace(/\.[^./\\]+$/, '').trim();
  const firstFile = (input) => (input.files || [])[0] || null;

  async function autoTitle() {
    const ft = firstFile(ftInput);
    if (ft) {
      try {
        const parsed = parseFlextext(await ft.text());
        const inner = ((parsed.texts && parsed.texts[0] && parsed.texts[0].title) || '').trim();
        if (inner) return inner;                       // (2) the text's own title
      } catch { /* unreadable or not a flextext — the send handler reports that properly */ }
      return baseName(ft.name);                        // (3) failing that, its filename
    }
    const audio = firstFile(audioInput);
    return audio ? baseName(audio.name) : '';          // (4) last resort
  }

  async function fillTitle() {
    if (touched && titleInput.value.trim()) return;    // (1) their words stand
    const next = await autoTitle();
    if (next) titleInput.value = next;
  }
  audioInput.addEventListener('change', fillTitle);
  ftInput.addEventListener('change', fillTitle);
  const say = (msg, kind) => {
    const s = m.el.querySelector('#rp-as-status');
    s.hidden = false; s.textContent = msg;
    s.className = 'rp-as-status' + (kind ? ' rp-as-' + kind : '');
  };
  m.el.querySelector('[data-m="send"]').onclick = (e) => busy(e.target, async () => {
    const title = titleInput.value.trim();
    const audioFile = firstFile(audioInput);
    const ftFile = (ftInput.files || [])[0] || null;
    // The device only materializes an assign that carries a resource; a title alone sends nothing.
    if (!audioFile && !ftFile) { say('⚠ ' + t('panel.assign.needFile'), 'err'); return; }

    // Audio verdict from the file's own header bytes — a hard failure NEVER reaches the queue.
    if (audioFile) {
      const head = new Uint8Array(await audioFile.slice(0, 64).arrayBuffer());
      const v = assignAudioVerdict({ buf: head, name: audioFile.name, size: audioFile.size });
      if (!v.ok) {
        say('⚠ ' + (v.code === 'aiff' ? t('task.cantPlay')
          : v.code === 'big' ? t('task.tooBig', { mb: v.mb })
          : t('task.notAudio', { mime: audioFile.type || '?' })), 'err');
        return;
      }
      say('✓ ' + t('task.checkOk', { name: audioFile.name, size: fmtSize(audioFile.size) }), 'ok');
    }

    // The flextext parses HERE, before anything uploads: a SINGLE interlinear text (only the
    // first would be delivered), then the WS check against this instance's pushed codes.
    let ftText = null;
    if (ftFile) {
      ftText = await ftFile.text();
      const parsed = parseFlextext(ftText);
      if (parsed.error || !parsed.texts.length) { say('⚠ ' + t('task.ftParseFailed', { msg: parsed.error || t('task.ftNone') }), 'err'); return; }
      if (parsed.texts.length > 1) { say('⚠ ' + t('task.ftMultiText', { n: parsed.texts.length }), 'err'); return; }
      /* The writing-system cross-check compares the file against the DEVICE's configured codes.
       * A project upload has no device yet, so there is nothing to disagree with — the check is
       * skipped rather than faked, and it happens for real when the text is later assigned. */
      const codes = instanceId ? await Researcher.getInstanceSettings(instanceId).catch(() => null) : null;
      const mm = codes ? wsAssignMismatch(analyzeFlextextWs(ftText), codes) : null;
      if (mm && !(await wsMismatchConfirm(mm))) {
        say('⚠ ' + t('panel.assign.blockedNoSend'), 'err');   // Cancel visibly aborts — nothing was sent
        return;
      }
    }

    // The docId is minted HERE, so this is the only place that knows which assignment produced
    // which text (the history event is written by the queue runner once the assign really sends).
    const docId = crypto.randomUUID();
    /* ⚠ PROVENANCE IS CAPTURED AT QUEUE TIME OR NEVER. The manifest the queue runner writes later
     * reads queuedAt / vernLang / analLang off THIS record — and until 2026-08-27 nothing wrote
     * them, so every assigned text shipped writingSystems {vern:'',anal:''} and an originatedAt
     * equal to whenever the UPLOAD happened to run. Manifests are written once and immutable by
     * contract, so those wrong values were permanent. The settings snapshot is decrypted locally
     * (Kr) and may legitimately be absent for an unconfigured device — '' stays honest there. */
    const wsCodes = instanceId ? await Researcher.getInstanceSettings(instanceId).catch(() => null) : null;
    // ABSORB INTO INDEXEDDB BEFORE ANYTHING ELSE (locked decision 8): once this write lands, the
    // assignment survives connection drops, panel reloads and retries — the queue owns it now.
    await db.putMedia(AQ_PREFIX + docId, {
      instanceId, projectFolderId, title, ttlDays: assignTtlDays(), state: 'queued', at: Date.now(),
      queuedAt: Date.now(),
      vernLang: (wsCodes && wsCodes.vernLang) || '', analLang: (wsCodes && wsCodes.analLang) || '',
      audio: audioFile ? { blob: audioFile, name: audioFile.name, mime: audioFile.type || 'application/octet-stream', size: audioFile.size } : null,
      // Stored as the TEXT we just validated (not the File) — what was checked is what ships.
      flextext: ftFile ? { blob: new Blob([ftText], { type: 'application/xml' }), name: ftFile.name, mime: 'application/xml', size: ftFile.size } : null,
    });
    runAssignUpload(docId);   // deliberately not awaited — the queue reports through the dashboard card
    m.close();
    deps.toast(t('panel.assign.queuedToast'), 5000);
    paintAssignQueue();
  });
}

// The explicit two-button WS-mismatch dialog (locked decision 5): names BOTH sides, never remaps,
// never hard-blocks. Resolves true on "Send anyway"; every other close path (Cancel, Escape,
// backdrop) is a visible abort.
function wsMismatchConfirm(mm) {
  return new Promise((resolve) => {
    const m = modal(`
      <h3>${esc(t('panel.assign.wsTitle'))}</h3>
      <p class="note">${esc(t('panel.assign.wsBody', mm))}</p>
      <button class="primary-btn" data-m="anyway">${esc(t('panel.assign.sendAnyway'))}</button>
      <button class="link-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>`, false, () => resolve(false));
    m.el.querySelector('[data-m="anyway"]').onclick = () => { resolve(true); m.close(); };
    m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  });
}

/* ---------------- the resilient assignment-upload queue (assign-by-upload) ----------------
 * One IndexedDB record per queued assignment ('assign-upload:<docId>', blobs included), a
 * single-flight runner per docId, and a dashboard card that shows queued/uploading N%/failed.
 * Resume points: panel restart (renderDashboard sweeps), connectivity return (the 'online'
 * listener sweeps), and a manual Retry on definitive failures. The assign command is sent ONLY
 * after finish() succeeds — a dropped connection can never produce a half-assignment. */

const AQ_PREFIX = 'assign-upload:';
const aqActive = new Map();   // docId -> live view { state: 'uploading'|'sending', sent, total }

/* Researcher-configurable delivery TTL (default 90; the worker's clampTtlDays is the authority).
 * ⚠ IT IS PER-ACCOUNT, AND IT USED TO BE STORED PER-BROWSER — the old comment here already said
 * "per-account" while writing localStorage, which is exactly the kind of drift that never announces
 * itself: set 180 days in one browser and the next one went on minting 90-day assignments, with
 * nothing wrong on screen until an assignment expired early (Seth's audit, 2026-08-18). Now an
 * account preference, refreshed on every render from the settings blob listView() already returns. */
const TTL_KEY = 'flextext-rp-ttl:';   // legacy per-browser key — migration only, see loadTtl
let ttlDays = null;
function assignTtlDays() { return Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 90; }

async function loadTtl(accountId) {
  let prefs;
  try { prefs = await Researcher.getPrefs(); } catch { return; }   // locked or offline — keep what we have
  const legacyKey = TTL_KEY + (accountId || 'anon');
  let legacy = NaN;
  try { legacy = parseInt(localStorage.getItem(legacyKey), 10); } catch { /* noop */ }
  const haveAccount = Number.isFinite(prefs && prefs.assignTtlDays) && prefs.assignTtlDays > 0;
  /* Migrate a browser-local value up ONCE, so nobody's setting is silently reset to 90 by this
   * change. The account copy wins the moment it exists; the legacy key is dropped only after the
   * account genuinely holds a value, so a failed write retries next render instead of losing it. */
  if (!haveAccount && Number.isFinite(legacy) && legacy > 0) {
    try { prefs = await Researcher.setPref('assignTtlDays', legacy); } catch { return; }
  }
  try { if (localStorage.getItem(legacyKey) !== null) localStorage.removeItem(legacyKey); } catch { /* noop */ }
  ttlDays = Number.isFinite(prefs && prefs.assignTtlDays) ? prefs.assignTtlDays : null;
}

async function setAssignTtlDays(v) { await Researcher.setPref('assignTtlDays', v); ttlDays = v; }

/* ⚠ SYNCHRONOUSLY READABLE MIRROR of the assign-upload queue's docIds. The queue itself lives in
 * IndexedDB and is read asynchronously, but the "is this text unassigned?" test that gates a
 * DESTRUCTIVE Drive delete runs inside a render. Refreshed on every listAssignQueue(), which the
 * dashboard already calls on each paint. */
let aqQueued = new Set();

async function listAssignQueue() {
  const keys = await db.listMediaKeys().catch(() => []);
  const out = [];
  for (const k of keys) {
    if (!String(k).startsWith(AQ_PREFIX)) continue;
    const rec = await db.getMedia(k).catch(() => null);
    if (rec) out.push({ docId: String(k).slice(AQ_PREFIX.length), rec });
  }
  out.sort((a, b) => (a.rec.at || 0) - (b.rec.at || 0));
  aqQueued = new Set(out.map((o) => o.docId));
  return out;
}

/* Every docId that is mid-assignment right now, from BOTH kinds of evidence:
 *   - a queued assign command (server truth, so every panel agrees), and
 *   - a local upload still streaming bytes into the text's Drive folder (this browser only — but
 *     this browser is the one that would be deleting the folder it is writing into).
 *
 * ⚠ WHY THIS EXISTS. "Unassigned" was defined as "no device inventory reports this docId", and the
 * worker creates a text's Drive folder at assignment/begin — before a single byte is uploaded. So
 * from the moment an assignment starts until the destination device's first inventory report (the
 * whole upload, plus days if that device is offline) the text was listed under "in your Drive but on
 * no device", offering Remove. That is the most destructive button in the panel, aimed at the only
 * copy of live work, and a second panel had no assign-queue card and no way to know why the folder
 * was there. It also showed on ONE screen: an "assigning…" ghost row on the device card and an
 * Unassigned row offering to delete the same text. */
function inFlightAssignIds() {
  const ids = new Set(aqQueued);
  for (const [, p] of serverPending) if (p.kind === 'assign' && p.docId) ids.add(p.docId);
  for (const [docId, p] of pendingCmds) if (p.kind === 'assign') ids.add(docId);
  return ids;
}

async function runAssignUpload(docId) {
  if (aqActive.has(docId)) return;                      // single-flight per assignment
  const key = AQ_PREFIX + docId;
  const rec = await db.getMedia(key).catch(() => null);
  if (!rec) return;
  const save = () => db.putMedia(key, rec).catch(() => { /* the in-memory run continues */ });
  const total = (rec.audio ? rec.audio.size : 0) + (rec.flextext ? rec.flextext.size : 0);
  const view = { state: 'uploading', sent: 0, total };
  aqActive.set(docId, view);
  rec.state = 'uploading'; rec.error = '';
  await save();
  /* The RUNNING upload lives in the activity tray — the same "In progress" box the Files…
   * downloads use (Seth, 2026-08-31), with the same {pct}% of {size} voice, for the same reason:
   * it survives dashboard re-renders and closed modals, and it is the one place a researcher has
   * learned to look for work in flight. The queue card below keeps only the rows that need a
   * HAND — queued (cancellable) and failed (retryable) — so one upload is never narrated twice. */
  const nick = (((lastData && lastData.instances) || []).find((x) => x.instance_id === rec.instanceId) || {}).nickname;
  /* A PROJECT upload names the project, not a device — "→ ?" would be the tray asking a question
   * nobody can answer, for a text that is deliberately going to no device (issue #4). */
  const projName = rec.projectFolderId
    ? ((((estateCache && estateCache.projects) || []).find((p) => p.folderId === rec.projectFolderId) || {}).name || t('panel.proj.defaultName'))
    : '';
  const dest = rec.projectFolderId ? `${projName} · ${t('panel.store.unassignedGroup')}` : (nick || '?');
  const job = jobStart(`${rec.title || t('panel.hist.untitled')} → ${dest}`, t('panel.dl.starting'), 'up');
  /* The chunked trio is addressed by a BASE PATH, so the project lane needs no second copy of the
   * upload loop — `base` is the same opt-in the crowd consent prompt already uses. Absent for a
   * device, where the default instance path is right. */
  const uploadOpts = () => (rec.projectFolderId
    ? { base: Researcher.projectTextBase(rec.projectFolderId, docId) } : {});
  const jobPct = () => jobSet(job, total
    ? t('panel.dl.pct', { pct: Math.min(99, Math.round((view.sent / total) * 100)), size: fmtSize(total) })
    : fmtSize(view.sent));
  paintAssignQueue();
  try {
    if (!rec.originalsFolderId) {
      /* ⚠ A WORKER THAT PREDATES THE PROJECT LANE ANSWERS 404, and projectTextBegin turns that into
       * null rather than an exception — so the failure is one honest sentence at the top of the
       * queue instead of a half-uploaded text. This is what lets the client ship before the worker
       * is deployed. */
      const b = rec.projectFolderId
        ? await Researcher.projectTextBegin(rec.projectFolderId, docId, rec.title)
        : await Researcher.assignBegin(rec.instanceId, docId, rec.title, rec.folderId || '');
      if (!b) throw new Error(t('panel.assign.projNoWorker'));
      rec.folderId = b.folderId; rec.originalsFolderId = b.originalsFolderId;
      await save();
    }
    /* The manifest goes FIRST, before a single source byte — so that from the moment the folder
     * exists it declares what SHOULD be in it, and any consumer (the Files menu, a future app) can
     * compare that list against the folder and NAME what has not arrived rather than guessing.
     * Written once: if the queue resumes after a restart, manifestFileId is already set. */
    if (!rec.manifestFileId) {
      /* THE SHARED BUILDER, not a copy of it. This was a hand-copied literal of app.js's
       * buildSourceManifest — two writers of the one contract every consumer checks completeness
       * against, so the first divergence would have surfaced as "this package is incomplete" on a
       * text that was fine. It now calls the same function the device does. */
      const manifest = buildSourceManifest({
        docId, title: rec.title || '',
        origin: 'assigned',
        originatedAt: rec.queuedAt || Date.now(),
        engine: ENGINE_VERSION, buildTag: BUILD_TAG,
        vern: rec.vernLang || '', anal: rec.analLang || '',
        audio: rec.audio ? { name: rec.audio.name, mime: rec.audio.mime, bytes: rec.audio.size, derived: false } : null,
        files: [
          ...(rec.audio ? [{ name: rec.audio.name, role: 'source-audio', mime: rec.audio.mime, bytes: rec.audio.size }] : []),
          ...(rec.flextext ? [{ name: rec.flextext.name, role: 'source-flextext', mime: rec.flextext.mime, bytes: rec.flextext.size }] : []),
        ],
        // Uploaded by a researcher, and WHICH researcher account — the third origin Seth asked to
        // be able to tell apart from Drive alone.
        source: { kind: 'researcher', id: Researcher.currentAccountId() || '' },
      });
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      rec.manifestFileId = await Researcher.assignUploadFile(rec.instanceId, docId, {
        blob, name: MANIFEST_NAME, mime: 'application/json', kind: 'manifest',
        originalsFolderId: rec.originalsFolderId,
      }, uploadOpts());
      await save();
    }
    let done = 0;
    for (const part of ['audio', 'flextext']) {
      const p = rec[part];
      if (!p) continue;
      if (!rec[part + 'FileId']) {
        rec[part + 'FileId'] = await Researcher.assignUploadFile(rec.instanceId, docId, {
          blob: p.blob, name: p.name, mime: p.mime, kind: part === 'audio' ? 'audio' : 'flextext',
          originalsFolderId: rec.originalsFolderId, streamId: rec[part + 'StreamId'] || null,
        }, {
          ...uploadOpts(),
          onProgress: (sent) => { view.sent = done + sent; jobPct(); },
          // The session token persists in the queue record, so a panel restart resumes MID-FILE.
          onSession: (id) => { rec[part + 'StreamId'] = id || ''; return save(); },
        });
        delete rec[part + 'StreamId'];
        await save();
      }
      done += p.size; view.sent = done;
      jobPct();
    }
    /* ⚠ A PROJECT UPLOAD ENDS HERE — there is no delivery half (issue #4). Everything below mints
     * streaming URLs and sends an ASSIGN COMMAND to a device, and this text is deliberately going to
     * no device: "at a later time, I can move/assign it to the device of my choice". The bytes are
     * in the project's Unassigned, which is where the estate lists it and where Move… picks it up,
     * so the work is complete. Faking a finish would be an affordance that cannot work.
     *
     * The estate is a Drive SEARCH and lags by seconds, so the dashboard is refreshed rather than
     * merely repainted — otherwise the text the researcher just uploaded is briefly nowhere. */
    if (rec.projectFolderId) {
      jobEnd(job, t('panel.aq.doneProject'));
      await db.deleteMedia(key).catch(() => { /* the record is spent either way */ });
      aqActive.delete(docId);
      deps.toast(t('panel.assign.projQueuedDone', { title: rec.title || '' }), 6000);
      renderDashboard();
      paintAssignQueue();
      return;
    }
    view.state = 'sending';
    jobSet(job, t('panel.aq.sending'));
    const fin = await Researcher.assignFinish(rec.instanceId, docId, {
      ...(rec.audioFileId ? { audioFileId: rec.audioFileId } : {}),
      ...(rec.flextextFileId ? { flextextFileId: rec.flextextFileId } : {}),
      ttlDays: rec.ttlDays,
    });
    // ONLY NOW does the assign command exist. folderId rides the payload so the device stamps it
    // from birth (the dedupe search never runs); the device re-uses the same private token URLs.
    const fields = { title: rec.title, folderId: rec.folderId || '' };
    if (fin.audioUrl) fields.audioUrl = fin.audioUrl;
    if (fin.flextextUrl) fields.flextextUrl = fin.flextextUrl;
    const sent = await Researcher.assign(rec.instanceId, docId, fields);
    /* ⚠ THE QUEUE RECORD IS ABOUT TO BE DELETED, AND WITH IT THE ONLY THING ON SCREEN. Hand the
     * wait over to pendingCmds before that happens, so the text keeps a visible row until the
     * device actually reports it — the v3 work order's "a pending upload must be visible", and the
     * reason it composes with delete/upload rather than inventing a parallel mechanism: the seq is
     * what makes it cancellable while still queued, and retirement is an inventory fact, not a
     * timer. moveTextModal deliberately does NOT do this — a move already shows its own chip
     * through pendingMoves, and two markers for one wait is worse than none. */
    if (sent && sent.seq) {
      pendingCmds.set(docId, { seq: sent.seq, kind: 'assign', instanceId: rec.instanceId,
                               title: rec.title || '', hasAudio: !!rec.audio, at: Date.now() });
      savePending(Researcher.currentAccountId());
      // Redraw NOW from cached data (no refetch — the marker is client-side): waiting up to 12s to
      // see the result of your own action is the other half of the "slow refresh" report.
      renderDashboard(lastData || undefined);
    }
    const inst = (lastData && (lastData.instances || []).find((x) => x.instance_id === rec.instanceId)) || null;
    recordEvents(Researcher.currentAccountId(), [assignedEvent({
      instanceId: rec.instanceId, device: (inst && inst.nickname) || '', docId, title: rec.title,
      audioUrl: fields.audioUrl || '', flextextUrl: fields.flextextUrl || '',
    })]);
    await db.deleteMedia(key).catch(() => { /* the record is spent either way */ });
    aqActive.delete(docId);
    jobEnd(job, t('panel.aq.sentShort'));
    paintAssignQueue();
    deps.toast(t('panel.assign.sent'), 4000);
  } catch (e) {
    // TRANSIENT (network, stalled chunks, 5xx) → back to 'queued'; the online/restart sweeps
    // re-enter with every fileId + session already persisted. DEFINITIVE (4xx — bad auth, revoked
    // instance) → 'error', loud, with a manual Retry: silent infinite retry on a 403 helps no one.
    const definitive = e && e.status >= 400 && e.status < 500;
    rec.state = definitive ? 'error' : 'queued';
    rec.error = String((e && e.message) || e);
    await save();
    aqActive.delete(docId);
    // The tray tells the truth about how it ended: re-queued (the sweeps will resume it) or
    // failed (the queue card holds the Retry).
    jobEnd(job, definitive ? t('panel.dl.failedShort') : t('panel.aq.queued'));
    paintAssignQueue();
    if (definitive) deps.toast(t('panel.aq.failed', { title: rec.title || '?', msg: rec.error }), 8000);
  }
}

let aqSweeping = false;
async function sweepAssignUploads() {
  if (aqSweeping || !Researcher.isSignedUp()) return;
  aqSweeping = true;
  try {
    for (const { docId, rec } of await listAssignQueue()) {
      if (aqActive.has(docId)) continue;
      if (rec.state === 'error') continue;              // definitive failures wait for the Retry button
      await runAssignUpload(docId);                     // sequential — gentle on weak connections
    }
  } finally { aqSweeping = false; }
}

function assignQueueHtml(queue) {
  /* ⚠ RUNNING uploads are NOT rows here any more — they live in the activity tray with the
   * downloads (runAssignUpload's jobStart), where progress survives re-renders. This card is the
   * management surface: only rows a researcher can ACT on — queued (cancellable) and failed
   * (retryable) — so one upload is never narrated in two places at once. When everything in the
   * queue is in flight, there is rightly no card at all. */
  const rows = queue.filter(({ docId }) => !aqActive.has(docId));
  if (!rows.length) return '';
  const nick = (iid) => (((lastData && lastData.instances) || []).find((x) => x.instance_id === iid) || {}).nickname || '?';
  return `<div class="rp-card rp-aq-card"><div class="rp-inst-name">${esc(t('panel.aq.title'))}</div>
    ${rows.map(({ docId, rec }) => {
      const status = rec.state === 'error' ? t('panel.aq.failedRow', { msg: rec.error || '?' }) : t('panel.aq.queued');
      return `<div class="rp-install rp-aq-row">
        <div><div class="invite-name">${esc(rec.title || t('panel.hist.untitled'))}</div>
        <div class="note">${esc(nick(rec.instanceId))} · ${esc(status)}</div></div>
        <div class="rp-inst-actions">
          ${rec.state === 'error' ? `<button class="secondary-btn" data-aqretry="${esc(docId)}">${esc(t('panel.aq.retry'))}</button>` : ''}
          <button class="link-btn rp-revoke" data-aqcancel="${esc(docId)}">${esc(t('panel.assign.cancel'))}</button>
        </div>
      </div>`;
    }).join('')}</div>`;
}

async function paintAssignQueue() {
  const host = root && root.querySelector('#rp-aq');
  if (!host) return;
  host.innerHTML = assignQueueHtml(await listAssignQueue());
  host.querySelectorAll('[data-aqretry]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.aqretry;
    const rec = await db.getMedia(AQ_PREFIX + id).catch(() => null);
    if (rec) { rec.state = 'queued'; rec.error = ''; await db.putMedia(AQ_PREFIX + id, rec).catch(() => {}); }
    runAssignUpload(id);
  }));
  host.querySelectorAll('[data-aqcancel]').forEach((b) => b.addEventListener('click', async () => {
    if (!await confirmModal(t('panel.aq.cancelConfirm'))) return;
    await db.deleteMedia(AQ_PREFIX + b.dataset.aqcancel).catch(() => {});
    paintAssignQueue();
  }));
}

/* ---------------- crowd recorders (public crowd-source recording pages) ----------------
 * A crowd recorder is a PUBLIC page (CROWD_BASE?c=<id>) anyone with the link can use: welcome →
 * consent → record → the worker relays the zip to the researcher's Drive folder. No login, no local
 * corpus, no E2EE — the keyless public page must read its own config, so everything in it (except
 * nothing: even the folder id) is server-readable. The edit modal warns accordingly. */

// Bytes → human size up to GB (the crowd budgets are GB-scale; fmtSize stops at MB).
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1073741824) { const g = b / 1073741824; return (g >= 10 ? Math.round(g) : g.toFixed(1)) + ' GB'; }
  if (b >= 1048576) { const mo = b / 1048576; return (mo >= 10 ? Math.round(mo) : mo.toFixed(1)) + ' MB'; }
  return Math.max(0, Math.round(b / 1024)) + ' KB';
}

const CROWD_DEFAULT_CONFIG = { welcome: '', consentAsk: ['text'], consentConfirm: ['yesno'], consentMsg: '', consentAudioUrl: '', lang: 'id', maxSeconds: 600, recordFormat: 'wav24', turnstile: true };

/* A recorder's recordings, listed under it — so a crowd submission has a HOME in the panel rather
 * than appearing in the researcher's set-aside pile (§16.24).
 *
 * Move… here is the Unassigned card's source-less /adopt flow (see the `cmove` handler) — the
 * earlier ban on offering it (v408's `no_flextext_in_zip` failure) ended when crowd submissions
 * started uploading real text folders; the warning that SURVIVES is the assignNote below: never
 * move these folders by hand in Drive — dragging one onto a device SEEMS to work (the tree looks
 * right, the panel groups it) but the device is never told, so the text is in its inventory
 * nowhere.
 *
 * ⚠ IN FLIGHT MEANS SHOWN-AND-LOCKED, NEVER HIDDEN — the same rule the Unassigned card states at
 * length. A crowd row mid-move keeps its Files menu, wears the same in-flight tag every other
 * source wears, and withholds Move/Delete: offering to trash Drive's only copy while a device is
 * still fetching it is the one affordance this row must never show. (Issue #14's crowd gap.) */
function crowdTextRows(rec, estate) {
  const texts = crowdTexts(estate, rec);
  if (!texts.length) return '';
  const iid = firstInstanceId();
  const inFlight = inFlightAssignIds();
  return `<ul class="rp-crowd-texts">${texts.map((tx) => {
    const busy = pendingMoves.has(tx.docId) || inFlight.has(tx.docId);
    const when = crowdRowLabel(rec, tx.title);
    return `<li class="rp-text-row">
      <div class="rp-text-main">
        <div class="rp-text-title"${when ? ` title="${esc(tx.title || '')}"` : ''}>${esc(when || tx.title || t('panel.hist.untitled'))}</div>
        <div class="note rp-text-meta">${esc(gb(tx.bytes || 0))} · ${esc(t('panel.store.nFiles', { n: tx.files || 0 }))}</div>
      </div>
      <div class="rp-text-actions">
        ${iid ? previewBtnHtml(iid, tx.docId, tx.title || '') + filesMenuHtml(iid, tx.docId, tx.title || '') : ''}
        ${busy ? `<span class="rp-tag rp-tag-moving">${esc(t('panel.store.inFlight'))}</span>`
          : `<button class="link-btn" data-uact="cmove" data-id="${esc(tx.docId)}" data-title="${esc(tx.title || '')}">${esc(t('panel.move.btn'))}</button>
        <button class="link-btn rp-revoke" data-uact="drop" data-folder="${esc(tx.folderId)}" data-title="${esc(tx.title || '')}">${esc(t('panel.store.delete'))}</button>`}
      </div>
    </li>`;
  }).join('')}</ul>
    <p class="note rp-crowd-assign-note">${esc(t('panel.crowd.assignNote'))}</p>`;
}

/* A crowd row's visible name is WHEN IT WAS RECORDED, on the researcher's own clock. The Drive
 * folder keeps its server-generated '<label> — YYYY-MM-DD HH:MM UTC' name (crowdTextTitle in the
 * worker — interim until the researcher-set timezone, plans/BACKLOG.md), but that name is for
 * correlation, not reading: at UTC+9 the raw stamp puts the wrong DAY on anything recorded after
 * 3 pm, and the label half just repeats the card heading (Seth, 2026-08-31: "the filename is kind
 * of pointless"). The raw title survives as the row's tooltip and rides the action payloads, so
 * confirmations and the Files modal still say what Drive says. Unparseable titles render as-is. */
function crowdRowWhen(title) {
  /* [:_] — crowdTextTitle writes 'HH:MM UTC', but Drive folder names pass through the worker's
   * character sanitizer (v1.js: [\\/:*?"<>|] → '_'), so the name that actually comes back in the
   * estate reads 'HH_MM UTC'. Caught live on staging 2026-08-31: the colon-only parse matched
   * nothing and every row fell back to the raw title. Accept both, so this keeps working if the
   * sanitizer ever stops eating colons. */
  const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2})[:_](\d{2}) UTC$/.exec(String(title || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return isNaN(d) ? null : histWhen(d.getTime());
}
/* The row's whole visible name. When the title's prefix is the SPEAKER'S TYPED NAME (v533's
 * crowdTextTitle leads with it when the typed-signature consent mode captured one), show
 * "name — local time"; when the prefix merely repeats the recorder's label — every pre-v533
 * submission — the local time alone says everything the row needs to. */
function crowdRowLabel(rec, title) {
  const when = crowdRowWhen(title);
  if (!when) return null;
  const prefix = String(title || '').replace(/\s*—\s*\d{4}-\d{2}-\d{2} \d{2}[:_]\d{2} UTC$/, '').trim();
  return (prefix && prefix !== String((rec && rec.label) || '').trim()) ? prefix + ' — ' + when : when;
}

function renderCrowdCard(recs, estate) {
  let body;
  if (recs == null) body = `<p class="banner warn-banner">${esc(t('panel.crowd.fetchFail'))}</p>
    <button class="secondary-btn" data-cact="reload">${esc(t('panel.dash.retry'))}</button>`;
  else if (!recs.length) body = `<p class="note">${esc(t('panel.crowd.empty'))}</p>`;
  else body = recs.map((r) => renderCrowdRow(r, estate)).join('');
  return `<div class="rp-card rp-crowd">
    <div class="rp-inst-top"><span class="rp-inst-name">${esc(t('panel.crowd.title'))}</span></div>
    <p class="note">${esc(t('panel.crowd.intro'))}</p>
    ${body}
    <div class="rp-inst-actions"><button class="primary-btn" data-cact="new">${esc(t('panel.crowd.new'))}</button></div>
  </div>`;
}

function renderCrowdRow(r, estate) {
  const id = esc(r.crowd_id);
  const live = Number(r.enabled) === 1;
  // Budget-reached = auto-paused by the worker until the day/budget resets or the researcher raises it.
  const overDay = Number(r.max_per_day) > 0 && Number(r.day_count) >= Number(r.max_per_day);
  const overBytes = Number(r.max_bytes_total) > 0 && Number(r.bytes_total) >= Number(r.max_bytes_total);
  const pill = live
    ? `<span class="rp-badge rp-badge-ok">${esc(t('panel.crowd.live'))}</span>`
    : `<span class="rp-badge">${esc(t('panel.crowd.paused'))}</span>`;
  const counts = t('panel.crowd.counts', {
    total: Number(r.submit_count) || 0,
    today: Number(r.day_count) || 0, max: Number(r.max_per_day) || 0,
    bytes: fmtBytes(r.bytes_total), budget: fmtBytes(r.max_bytes_total),
  });
  return `<div class="rp-install">
    <div><div class="rp-inst-name">${esc(r.label || '?')} ${pill}</div>
      <div class="note">${esc(counts)}</div>
      ${(overDay || overBytes) ? `<div class="note rp-crowd-budget">${esc(t('panel.crowd.budget'))}</div>` : ''}
      ${crowdTextRows(r, estate)}</div>
    <div class="rp-inst-actions">
      <button class="secondary-btn" data-cact="edit" data-c="${id}">${esc(t('panel.crowd.edit'))}</button>
      <button class="secondary-btn" data-cact="share" data-c="${id}">${esc(t('panel.crowd.share'))}</button>
      <button class="secondary-btn" data-cact="toggle" data-c="${id}" data-on="${live ? '1' : '0'}">${esc(t(live ? 'panel.crowd.pause' : 'panel.crowd.resume'))}</button>
      <button class="link-btn" data-cact="subs" data-c="${id}">${esc(t('panel.crowd.subs'))}</button>
      <button class="link-btn rp-revoke" data-cact="delete" data-c="${id}">${esc(t('panel.crowd.delete'))}</button>
    </div>
  </div>`;
}

// Refetch + repaint ONLY the crowd card (post-action feedback without a full dashboard refetch).
async function refreshCrowd() {
  try { crowdCache = (await Researcher.crowdList()).recorders || []; } catch { crowdCache = null; }
  const holder = root && root.querySelector('.rp-crowd');
  if (!holder) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderCrowdCard(crowdCache, estateCache);
  holder.replaceWith(tmp.firstElementChild);
  root.querySelectorAll('.rp-crowd [data-cact]').forEach((el) => el.addEventListener('click', () => crowdAction(el)));
}

async function crowdAction(el) {
  const id = el.dataset.c, act = el.dataset.cact;
  const rec = (Array.isArray(crowdCache) ? crowdCache : []).find((r) => r.crowd_id === id) || null;
  try {
    if (act === 'new') newCrowdModal();
    else if (act === 'reload') await busy(el, refreshCrowd);
    else if (act === 'edit') { if (rec) crowdEditModal(rec); }
    else if (act === 'share') { if (rec) crowdShareModal(rec); }
    else if (act === 'subs') { if (rec) crowdSubsModal(rec); }
    else if (act === 'delete') { if (rec) crowdDeleteModal(rec); }
    else if (act === 'toggle') {
      // Pause/Resume is safe + instantly reversible → no confirm on either direction.
      const on = el.dataset.on === '1';
      await busy(el, () => Researcher.crowdUpdate(id, { enabled: on ? 0 : 1 }));
      deps.toast(t(on ? 'panel.crowd.pausedToast' : 'panel.crowd.resumedToast'), 4000);
      await refreshCrowd();
    }
  } catch (e) { errToast(e); }
}

// Create flow mirrors newDeviceModal: ask only for a label, create with safe defaults, then drop
// straight into the edit modal so the recorder gets its Drive folder before anyone shares the link.
function newCrowdModal() {
  /* Same destination note as newDeviceModal (issue #7): born-into-the-tab is real and invisible,
   * and the crowd dialog was the last place the surprise survived. */
  const crIntoProject = (currentProject && currentProject !== STRAY_TAB && !isMemberTab(currentProject)) ? currentProject : '';
  const crProjName = crIntoProject
    ? ((((estateCache && estateCache.projects) || []).find((p) => p.folderId === crIntoProject) || {}).name || '')
    : '';
  const m = modal(`
    <h3>${esc(t('panel.crowd.newTitle'))}</h3>
    <p class="note">${esc(t('panel.crowd.newIntro'))}</p>
    ${crProjName ? `<p class="note">${esc(t('panel.crowd.intoProject', { name: crProjName }))}</p>` : ''}
    <label class="rp-field"><span>${esc(t('panel.crowd.label'))}</span><input id="rp-cr-label" spellcheck="false" placeholder="${esc(t('panel.crowd.labelPh'))}"></label>
    <button class="primary-btn" data-m="create">${esc(t('panel.crowd.create'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.set.cancel'))}</button>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="create"]').onclick = (e) => busy(e.target, async () => {
    const label = m.el.querySelector('#rp-cr-label').value.trim();
    if (!label) return deps.toast(t('panel.crowd.needLabel'), 4000);
    try {
      // Born into the project on screen, exactly as a new device is (v426); a shared tab is not a
      // Drive project of ours, so it too means "no project named".
      const intoProject = (currentProject && currentProject !== STRAY_TAB && !isMemberTab(currentProject)) ? currentProject : '';
      const r = await Researcher.crowdCreate(label, '', Object.assign({}, CROWD_DEFAULT_CONFIG), intoProject);
      m.close();
      await refreshCrowd();   // also pulls the server-defaulted budgets for the edit modal below
      deps.toast(t('panel.crowd.created'), 4000);
      const rec = (Array.isArray(crowdCache) ? crowdCache : []).find((x) => x.crowd_id === r.crowd_id)
        || { crowd_id: r.crowd_id, label, enabled: 1, config: Object.assign({}, CROWD_DEFAULT_CONFIG), max_per_day: 200, max_bytes_total: 1073741824 };
      crowdEditModal(rec);
    } catch (err) { errToast(err); }
  });
}

function crowdEditModal(rec) {
  const cfg = (rec.config && typeof rec.config === 'object') ? rec.config : {};
  const m = modal(`
    <h3>${esc(t('panel.crowd.editTitle', { label: rec.label || '' }))}</h3>
    <p class="banner warn-banner">${esc(t('panel.crowd.publicWarn'))}</p>
    <label class="rp-field"><span>${esc(t('panel.crowd.label'))}</span><input id="cr-label" spellcheck="false"></label>
    <label class="rp-field"><span>${esc(t('panel.crowd.welcome'))}</span><textarea id="cr-welcome" rows="2"></textarea></label>
    <div class="rp-field"><span>${esc(t('panel.f.consentAsk'))}</span><div class="rp-multi">${['text', 'audio'].map((o) =>
      `<label class="check-label rp-inline"><input type="checkbox" data-ask="${o}"> ${esc(t('panel.opt.ask.' + o))}</label>`).join('')}</div></div>
    <label class="rp-field"><span>${esc(t('panel.f.consentMsg'))}</span><textarea id="cr-cmsg" rows="2"></textarea></label>
    <div class="rp-field"><span>${esc(t('panel.f.consentAudioUrl'))}</span>
      <input data-f="consentAudioUrl" type="hidden">
      <div class="rp-prompt-state" data-promptstate>${esc(t('panel.f.consentNone'))}</div>
      <button type="button" class="secondary-btn" id="cr-caudio-pick">${esc(t('panel.f.consentUpload'))}</button>
      <input type="file" id="cr-caudio-file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.opus,.webm,.flac" hidden></div>
    <p class="note">${esc(t('panel.f.consentAudioNote'))}</p>
    <div class="rp-field"><span>${esc(t('panel.f.consentConfirm'))}</span><div class="rp-multi">${['yesno', 'record', 'signature'].map((o) =>
      `<label class="check-label rp-inline"><input type="checkbox" data-conf="${o}"> ${esc(t('panel.opt.conf.' + o))}</label>`).join('')}</div></div>
    <label class="rp-field"><span>${esc(t('panel.f.recordFormat'))}</span>
      <select id="cr-fmt">${REC_KEYS.map((k) => `<option value="${k}">${esc(t('panel.opt.fmt.' + k))}</option>`).join('')}</select></label>
    <label class="rp-field"><span>${esc(t('panel.crowd.lang'))}</span>
      <select id="cr-lang"><option value="en">${esc(t('panel.opt.appLang.en'))}</option><option value="id">${esc(t('panel.opt.appLang.id'))}</option></select></label>
    <label class="rp-field"><span>${esc(t('panel.crowd.maxSec'))} — <span id="cr-maxsec-lbl"></span></span>
      <input type="range" id="cr-maxsec" min="10" max="3600" step="10"></label>
    <p class="note" id="cr-estimate"></p>
    <label class="check-label"><input type="checkbox" id="cr-turnstile"> ${esc(t('panel.crowd.turnstile'))}</label>
    <p class="note">${esc(t('panel.crowd.turnstileNote'))}</p>
    <label class="rp-field"><span>${esc(t('panel.crowd.maxDay'))}</span><input id="cr-maxday" type="number" min="1" inputmode="numeric"></label>
    <label class="rp-field"><span>${esc(t('panel.crowd.maxMb'))}</span><input id="cr-maxmb" type="number" min="1" inputmode="numeric"></label>
    <button class="primary-btn" data-m="save">${esc(t('panel.crowd.save'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.set.cancel'))}</button>`, true);
  const $$ = (s) => m.el.querySelector(s);
  // Prefill programmatically (same pattern as fillForm) — no untrusted values in attribute position.
  $$('#cr-label').value = rec.label || '';
  $$('#cr-welcome').value = cfg.welcome || '';
  $$('#cr-cmsg').value = cfg.consentMsg || '';
  /* The prompt is a FILE PICK, not a URL to type — identical to the device settings form, and
   * `data-f="consentAudioUrl"` is what lets paintPromptState be reused verbatim on this modal.
   * Nothing else in this modal reads `[data-f]` (every other field is addressed by id), so the
   * attribute is inert here apart from that. */
  $$('[data-f="consentAudioUrl"]').value = cfg.consentAudioUrl || '';
  paintPromptState(m.el);
  $$('#cr-fmt').value = REC_KEYS.includes(cfg.recordFormat) ? cfg.recordFormat : 'wav24';
  $$('#cr-lang').value = cfg.lang === 'en' ? 'en' : 'id';
  $$('#cr-maxsec').value = String(Math.min(3600, Math.max(10, Number(cfg.maxSeconds) || 300)));
  // Live size heads-up: re-computed on every slider move and format change.
  const paintEstimate = () => {
    const secsNow = parseInt($$('#cr-maxsec').value, 10) || 300;
    const fmt = $$('#cr-fmt').value;
    $$('#cr-maxsec-lbl').textContent = fmtDur(secsNow);
    const est = crowdEstimate(fmt, secsNow);
    const mb = est / 1048576;
    const el = $$('#cr-estimate');
    el.textContent = t('panel.crowd.estimate', { mb: mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1) });
  };
  $$('#cr-maxsec').addEventListener('input', paintEstimate);
  $$('#cr-fmt').addEventListener('change', paintEstimate);
  paintEstimate();
  $$('#cr-turnstile').checked = cfg.turnstile !== false;   // default ON
  $$('#cr-maxday').value = String(Number(rec.max_per_day) || 200);
  $$('#cr-maxmb').value = String(Math.max(1, Math.round((Number(rec.max_bytes_total) || 1073741824) / 1048576)));
  const ask = Array.isArray(cfg.consentAsk) ? cfg.consentAsk : [];
  const conf = Array.isArray(cfg.consentConfirm) ? cfg.consentConfirm : [];
  m.el.querySelectorAll('[data-ask]').forEach((c) => { c.checked = ask.includes(c.dataset.ask); });
  m.el.querySelectorAll('[data-conf]').forEach((c) => { c.checked = conf.includes(c.dataset.conf); });

  /* CONSENT PROMPT PICKER — the crowd twin of the device settings form's, streaming through the
   * recorder's own /prompt routes into its Drive folder root. Same rule as everywhere else since
   * assign-by-upload: there is ONE way a prompt gets in, and it is picking the file. A crowd
   * recorder has no instance, so it addresses the shared chunk loop by base path instead. */
  let crowdUploading = null;   // { pct } while the prompt is streaming — read by Save below
  {
    const cuBtn = $$('#cr-caudio-pick');
    const cuFile = $$('#cr-caudio-file');
    cuBtn.addEventListener('click', () => cuFile.click());
    cuFile.addEventListener('change', (e) => busy(cuBtn, async () => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      crowdUploading = { pct: 0 };
      cuBtn.textContent = t('panel.f.consentUploadingPct', { pct: 0 });
      try {
        const fileId = await Researcher.assignUploadFile('', 'consent-prompt', {
          blob: file, name: file.name, mime: file.type || 'audio/mpeg', kind: 'consent-prompt',
        }, {
          base: Researcher.crowdPromptBase(rec.crowd_id),
          onProgress: (sent, total) => {
            const pct = total ? Math.min(100, Math.round((sent / total) * 100)) : 0;
            crowdUploading = { pct };
            cuBtn.textContent = t('panel.f.consentUploadingPct', { pct });
          },
        });
        cuBtn.textContent = t('panel.f.consentFinishing');
        const fin = await Researcher.crowdPromptFinish(rec.crowd_id, { promptFileId: fileId, ttlDays: assignTtlDays() });
        if (fin.promptUrl) $$('[data-f="consentAudioUrl"]').value = fin.promptUrl;
        paintPromptState(m.el);
        deps.toast(t('panel.f.consentUploaded'), 5000);
      } catch (err) { errToast(err); }
      finally { crowdUploading = null; }   // always cleared, or Save would be wedged for good
    }));
  }
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;

  m.el.querySelector('[data-m="save"]').onclick = (e) => busy(e.target, async () => {
    const label = $$('#cr-label').value.trim();
    if (!label) return deps.toast(t('panel.crowd.needLabel'), 4000);
    // Saving mid-upload would store an EMPTY prompt URL and silently discard the file the
    // researcher is watching upload — the device form's lesson (never an error that looks like
    // failure when the thing simply is not done yet), applied before it can bite here.
    if (crowdUploading) return deps.toast(t('panel.f.consentStillUploading', { pct: crowdUploading.pct }), 6000);
    // No folder field: submissions stream into the researcher's own Drive at
    // "FlexText Uploads / Crowd — <name>" automatically (relay leg retired).
    const config = {
      welcome: $$('#cr-welcome').value.trim(),
      consentAsk: Array.from(m.el.querySelectorAll('[data-ask]')).filter((c) => c.checked).map((c) => c.dataset.ask),
      consentConfirm: Array.from(m.el.querySelectorAll('[data-conf]')).filter((c) => c.checked).map((c) => c.dataset.conf),
      consentMsg: $$('#cr-cmsg').value.trim(),
      consentAudioUrl: $$('[data-f="consentAudioUrl"]').value.trim(),
      recordFormat: $$('#cr-fmt').value,
      lang: $$('#cr-lang').value === 'en' ? 'en' : 'id',
      maxSeconds: parseInt($$('#cr-maxsec').value, 10) || 300,
      turnstile: $$('#cr-turnstile').checked,
    };
    const maxDay = parseInt($$('#cr-maxday').value, 10);
    const maxMb = parseInt($$('#cr-maxmb').value, 10);
    try {
      await Researcher.crowdUpdate(rec.crowd_id, {
        label, config,
        max_per_day: maxDay > 0 ? maxDay : 200,                       // NaN/0 → the documented defaults
        max_bytes_total: maxMb > 0 ? maxMb * 1048576 : 1073741824,    // researcher-facing unit is MB
      });
      m.close(); deps.toast(t('panel.crowd.saved'), 4000);
      refreshCrowd();
    } catch (err) { errToast(err); }
  });
}

// Share & Embed — patterned on inviteModal (readonly boxes + Copy). Three integration tiers, most
// robust first; the notes are the field-tested embedding pitfalls (allow="microphone", CMS stripping).
function crowdShareModal(rec) {
  /* THIS recorder's estate. Its public link may already be embedded on somebody's website, so it
   * must keep the address it was created with for the rest of its life — showing a second URL for
   * one recorder is how a researcher ends up handing out two. */
  const CB = basesFor(estateOfRecord(rec)).crowd;
  const link = CB + '?c=' + encodeURIComponent(rec.crowd_id);
  const snips = {
    link,
    iframe: `<iframe src="${link}&embed=1" allow="microphone; autoplay" style="width:100%;max-width:480px;height:640px;border:0;border-radius:12px" title="Voice recorder" loading="lazy"></iframe>`,
    script: `<script async src="${CB}embed.js" data-recorder="${rec.crowd_id}"><\/script>`,
  };
  const block = (key, titleKey, noteKey, rows, share) => `
    <div class="rp-field"><span>${esc(t(titleKey))}</span>
      <textarea class="rp-linkbox" readonly rows="${rows}" data-url="${key}">${esc(snips[key])}</textarea>
      <p class="note">${esc(t(noteKey))}</p>
      <div class="rp-inst-actions"><button class="secondary-btn" data-copy="${key}">${esc(t(share ? 'panel.invite.copy' : 'panel.crowd.copyCode'))}</button>
      ${share ? `<button class="link-btn" data-share="${key}">${esc(t('panel.invite.share'))}</button>` : ''}</div></div>`;
  const m = modal(`
    <h3>${esc(t('panel.crowd.shareTitle', { label: rec.label || '' }))}</h3>
    <p class="banner warn-banner">${esc(t('panel.crowd.shareWarn'))}</p>
    ${block('link', 'panel.crowd.shareLink', 'panel.crowd.shareLinkNote', 2, true)}
    ${block('script', 'panel.crowd.shareScript', 'panel.crowd.shareScriptNote', 3, false)}
    ${block('iframe', 'panel.crowd.shareIframe', 'panel.crowd.shareIframeNote', 4, false)}
    <p class="note">${esc(t('panel.crowd.wildfireNote'))}</p>
    <button class="link-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => {
    const u = snips[b.dataset.copy];
    try { await navigator.clipboard.writeText(u); deps.toast(t('panel.invite.copied'), 3000); }
    catch { const ta = m.el.querySelector(`[data-url="${b.dataset.copy}"]`); if (ta) ta.select(); }
  }; });
  m.el.querySelectorAll('[data-share]').forEach((b) => { b.onclick = () => {
    const u = snips[b.dataset.share];
    if (navigator.share) navigator.share({ url: u, text: t('panel.crowd.shareText') }).catch(() => {});
    else window.open('https://wa.me/?text=' + encodeURIComponent(u), '_blank');
  }; });
}

// Last 50 submissions (worker keeps a rolling log; already-uploaded Drive files are the real archive).
async function crowdSubsModal(rec) {
  const m = modal(`<h3>${esc(t('panel.crowd.subsTitle', { label: rec.label || '' }))}</h3>
    ${loadingHtml('panel.crowd.subsLoading', true)}`, true);
  try {
    const r = await Researcher.crowdSubmissions(rec.crowd_id);
    const subs = r.submissions || [];
    const rows = subs.length ? subs.map((s) => `<tr>
      <td>${esc(s.created_at ? new Date(s.created_at).toLocaleString() : '?')}</td>
      <td>${esc(fmtBytes(s.bytes))}</td>
      <td>${esc(s.country || '—')}</td>
      <td>${esc(s.file_name || '—')}</td>
      <td>${esc(s.status || '—')}</td></tr>`).join('')
      : `<tr><td colspan="5" class="note">${esc(t('panel.crowd.subsNone'))}</td></tr>`;
    m.el.querySelector('.modal-card').innerHTML = `
      <h3>${esc(t('panel.crowd.subsTitle', { label: rec.label || '' }))}</h3>
      <p class="note">${esc(t('panel.crowd.subsIntro'))}</p>
      <div class="rp-subs-scroll"><table class="ws-table"><thead><tr>
        <th>${esc(t('panel.crowd.subDate'))}</th><th>${esc(t('panel.crowd.subSize'))}</th><th>${esc(t('panel.crowd.subCountry'))}</th><th>${esc(t('panel.crowd.subFile'))}</th><th>${esc(t('panel.crowd.subStatus'))}</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <button class="primary-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`;
    m.el.querySelector('[data-m="close"]').onclick = m.close;
  } catch (e) { m.close(); errToast(e); }
}

// Typed-confirmation delete (patterned on wipeConfirmModal): kills the PUBLIC link immediately +
// deletes the submission log; already-uploaded Drive files are NOT touched. Cannot be undone.
function crowdDeleteModal(rec) {
  const m = modal(`
    <h3>${esc(t('panel.crowd.delTitle'))}</h3>
    <p class="note">${esc(t('panel.crowd.delWhat'))}</p>
    <p class="banner warn-banner">${esc(t('panel.crowd.delWarn'))}</p>
    <label class="rp-field"><span>${esc(t('panel.crowd.delTypeLabel', { label: rec.label || 'DELETE' }))}</span>
      <input id="crowd-del-confirm" spellcheck="false" autocomplete="off"></label>
    <button class="primary-btn rp-danger" data-m="go" disabled>${esc(t('panel.crowd.delBtn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const input = m.el.querySelector('#crowd-del-confirm');
  const go = m.el.querySelector('[data-m="go"]');
  const want = (rec.label || 'DELETE').trim().toLowerCase();
  input.addEventListener('input', () => { go.disabled = input.value.trim().toLowerCase() !== want; });
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  go.onclick = async () => {
    go.disabled = true; go.textContent = t('panel.crowd.delWorking');
    try {
      await Researcher.crowdDelete(rec.crowd_id);
      m.close(); deps.toast(t('panel.crowd.deleted'), 5000);
      refreshCrowd();
    } catch (e) { errToast(e); go.disabled = false; go.textContent = t('panel.crowd.delBtn'); }
  };
}

/* ---------------- Admin: OWNER-only settings ----------------------------------------------
 * Link sits LEFT of History and renders only for owners (env ALLOWED_RESEARCHERS). ⚠ The hidden
 * link is CONVENIENCE, NOT THE BOUNDARY — every endpoint behind it re-checks isOwner() server-side,
 * because anything enforced only by not drawing a button is enforced by nothing.
 *
 * Replaces the paste-into-console helper in worker/docs/approved-domains.md. That existed because
 * the domain hashes can only be derived inside the Worker; this puts the same four endpoints behind
 * a UI so managing the list never means opening a developer console. */

// Client-side mirror of the Worker's PUBLIC_EMAIL_DOMAINS. Duplicated ON PURPOSE: the server is the
// real gate (it refuses these with a 400), but catching it here turns a round-trip and a raw error
// code into an immediate, plain-language explanation of WHY it is refused.
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.id', 'ymail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com',
  'qq.com', '163.com', '126.com', 'naver.com', 'web.de', 'mail.ru',
]);

// Normalize what the user typed: accept a full address, a leading @, stray case/dots.
function normDomainInput(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/^[@.\s]+/, '').replace(/[.\s]+$/, '');
  return s.includes('@') ? s.split('@').pop() : s;
}
// Returns an i18n key when the input is unusable, else null.
function domainInputError(d) {
  if (!d) return 'panel.admin.errEmpty';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d)) return 'panel.admin.errShape';
  if (PUBLIC_MAIL_DOMAINS.has(d)) return 'panel.admin.errPublic';
  return null;
}

function adminModal() {
  const m = modal(`
    <h3>${esc(t('panel.admin.title'))}</h3>
    <p class="note">${esc(t('panel.admin.intro'))}</p>
    <hr class="rp-sep">
    <div class="rp-adm-sec">
      <div class="rp-adm-h">${esc(t('panel.admin.domTitle'))}</div>
      <p class="note">${esc(t('panel.admin.domIntro'))}</p>
      <div id="rp-adm-list" class="rp-adm-list"><p class="note">…</p></div>
      <p class="note rp-adm-privacy">${esc(t('panel.admin.domPrivacy'))}</p>
      <label class="rp-field"><span>${esc(t('panel.admin.addDomain'))}</span>
        <input id="rp-adm-dom" spellcheck="false" autocapitalize="off" placeholder="${esc(t('panel.admin.addDomainPh'))}"></label>
      <label class="rp-field"><span>${esc(t('panel.admin.addNote'))}</span>
        <input id="rp-adm-note" spellcheck="false" placeholder="${esc(t('panel.admin.addNotePh'))}"></label>
      <button class="primary-btn" id="rp-adm-add">${esc(t('panel.admin.addBtn'))}</button>
      <div id="rp-adm-say" class="rp-adm-say" hidden></div>
    </div>
    <hr class="rp-sep">
    <div class="rp-adm-sec">
      <div class="rp-adm-h">${esc(t('panel.admin.testTitle'))}</div>
      <label class="rp-field"><span>&nbsp;</span>
        <input id="rp-adm-test" spellcheck="false" autocapitalize="off" placeholder="${esc(t('panel.admin.testPh'))}"></label>
      <button class="secondary-btn" id="rp-adm-testbtn">${esc(t('panel.admin.testBtn'))}</button>
      <div id="rp-adm-testsay" class="rp-adm-say" hidden></div>
    </div>
    <hr class="rp-sep">
    <div class="rp-adm-sec">
      <div class="rp-adm-h">${esc(t('panel.admin.logTitle'))}</div>
      <p class="note">${esc(t('panel.admin.logIntro'))}</p>
      <div id="rp-adm-log" class="rp-adm-log"><p class="note">…</p></div>
    </div>
    <hr class="rp-sep">
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;

  // The access-control history. Server-side and append-only, so unlike the texts History it
  // survives switching machines — and it is the only record of a DECLINED account, whose row is
  // deleted outright.
  async function refreshLog() {
    const box = m.el.querySelector('#rp-adm-log');
    let rows = [], unavailable = false;
    try { const r = await Researcher.listApprovals(200); rows = r.approvals || []; unavailable = !!r.unavailable; }
    catch (e) { box.innerHTML = `<p class="note rp-adm-err">${esc(String(e.message || e))}</p>`; return; }
    if (!rows.length) { box.innerHTML = `<p class="note">${esc(t(unavailable ? 'panel.admin.logUnavailable' : 'panel.admin.logEmpty'))}</p>`; return; }
    const KINDS = ['account_signup', 'account_auto_approved', 'account_approved', 'account_declined',
                   'domain_added', 'domain_removed', 'files_trashed', 'text_moved'];
    box.innerHTML = `<ul class="rp-adm-ul rp-adm-logul">${rows.map((r) => {
      // SECURITY: kind lands in a class attribute; allow-list it. subject/detail/actor are esc()'d.
      const k = KINDS.includes(r.kind) ? r.kind : 'account_signup';
      return `<li class="rp-log-${k}">
        <span class="rp-tag rp-log-k rp-log-k-${k}">${esc(t('panel.admin.kind.' + k))}</span>
        <span class="rp-adm-note">${esc(r.subject || '—')}</span>
        <span class="note rp-adm-meta">${esc(histWhen(r.at))}${r.detail ? ' · ' + esc(r.detail) : ''}${r.actor && r.actor !== 'system' ? ' · ' + esc(t('panel.admin.byActor', { a: r.actor })) : ''}</span>
      </li>`;
    }).join('')}</ul>`;
  }

  const say = (el, msg, kind) => {
    el.hidden = false; el.textContent = msg;
    el.className = 'rp-adm-say' + (kind ? ' rp-adm-' + kind : '');
  };

  async function refreshList() {
    const box = m.el.querySelector('#rp-adm-list');
    let rows = [];
    try { rows = (await Researcher.listDomains()).domains || []; }
    catch (e) { box.innerHTML = `<p class="note rp-adm-err">${esc(String(e.message || e))}</p>`; return; }
    if (!rows.length) { box.innerHTML = `<p class="note">${esc(t('panel.admin.listEmpty'))}</p>`; return; }
    box.innerHTML = `<ul class="rp-adm-ul">${rows.map((r) => `<li>
      <span class="rp-adm-note">${esc(r.note || '—')}</span>
      <span class="note rp-adm-meta">${esc(t('panel.admin.added_at', { when: lastSeen(r.created_at) }))} · <span class="rp-mono">${esc(r.hash_prefix)}</span></span>
      <button class="link-btn rp-revoke" data-rm="${esc(r.hash_prefix)}" data-note="${esc(r.note || '')}">${esc(t('panel.admin.removeBtn'))}</button>
    </li>`).join('')}</ul>`;
    box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => removeRow(b.dataset.rm, b.dataset.note, b)));
  }

  // Removal has to name the domain again — the table holds hashes, not names. Rather than trust the
  // typed value, we ask the Worker to hash it and compare against THIS row's prefix, so a typo
  // removes nothing instead of silently deleting a different entry.
  async function removeRow(prefix, note, btn) {
    const typed = prompt(t('panel.admin.removePrompt', { n: note || prefix }));
    if (typed === null) return;
    const d = normDomainInput(typed);
    const err = domainInputError(d);
    const box = m.el.querySelector('#rp-adm-say');
    if (err) return say(box, t(err), 'err');
    try {
      const probe = await busy(btn, () => Researcher.testDomain(d));
      if (probe.hash_prefix !== prefix) return say(box, t('panel.admin.removeMismatch'), 'err');
      await Researcher.removeDomain(d);
      say(box, t('panel.admin.removed', { d }), 'ok');
      refreshList(); refreshLog();
    } catch (e) { say(box, String(e.message || e), 'err'); }
  }

  m.el.querySelector('#rp-adm-add').addEventListener('click', async (e) => {
    const box = m.el.querySelector('#rp-adm-say');
    const d = normDomainInput(m.el.querySelector('#rp-adm-dom').value);
    const err = domainInputError(d);
    if (err) return say(box, t(err), 'err');
    const note = m.el.querySelector('#rp-adm-note').value.trim();
    try {
      await busy(e.target, () => Researcher.addDomain(d, note));
      // VERIFY, don't assume: a 200 proves the row was written, not that the rule works.
      const probe = await Researcher.testDomain('someone@' + d);
      say(box, t(probe.auto_approves ? 'panel.admin.added' : 'panel.admin.addedUnverified', { d }),
          probe.auto_approves ? 'ok' : 'err');
      m.el.querySelector('#rp-adm-dom').value = '';
      m.el.querySelector('#rp-adm-note').value = '';
      refreshList(); refreshLog();
    } catch (e2) { say(box, String(e2.message || e2), 'err'); }
  });

  m.el.querySelector('#rp-adm-testbtn').addEventListener('click', async (e) => {
    const box = m.el.querySelector('#rp-adm-testsay');
    const d = normDomainInput(m.el.querySelector('#rp-adm-test').value);
    if (!d) return say(box, t('panel.admin.errEmpty'), 'err');
    try {
      const r = await busy(e.target, () => Researcher.testDomain(d));
      // Localize from the STRUCTURED result, not the Worker's English `why` string.
      const key = r.public_provider ? 'panel.admin.testPublic'
                : r.auto_approves ? 'panel.admin.testAuto' : 'panel.admin.testManual';
      say(box, t(key, { d: r.domain }), r.public_provider ? 'err' : r.auto_approves ? 'ok' : '');
    } catch (e2) { say(box, String(e2.message || e2), 'err'); }
  });

  refreshList();
  refreshLog();
}

/* Move a text to another device. The Worker re-homes the Drive folder and mints authed streaming
 * URLs; we assign to the destination with the SAME docId (v137 identity — the folder tag already
 * follows), then the render sweep completes the handoff automatically once the destination reports
 * the doc. Upload-first remove at the source means the final copy is in the text's folder before
 * anything is deleted — the same safety order as remote delete. */
/* CAN THIS TEXT BE MOVED AT ALL? (Seth, 2026-08-13)
 *
 * "In order to MOVE a story (either from unassigned or from another device), there needs to be a
 *  manifest and it needs to make clear which file is the most recent flextext file (which becomes
 *  the flextext file sent in the new assignment) and which is the original audio (which becomes the
 *  audio source sent). Folders that do not have a manifest or whose manifest does not contain this
 *  info should not present a 'Move...' option. The researcher will have to download and re-upload
 *  those."
 *
 * ⚠ WHY THE CHECK CANNOT BE DONE AT RENDER TIME: knowing whether a text has a manifest requires
 * listing its Drive folder, and the dashboard shows dozens of texts. Gating the BUTTON would mean a
 * Worker round trip per text on every render — the exact per-text cost the v167 dedupe work and the
 * v342 done-marker fix were both about removing. The estate endpoint does not report manifest
 * presence either (that would be a worker change and a deploy).
 *
 * So the check runs on CLICK, before the device picker is shown — which is the same protection from
 * the researcher's side: they never get to choose a destination for a text that cannot be sent.
 *
 * ⚠ And it runs FIRST, not last. The old code listed the folder only after the researcher had
 * picked a device and pressed Move, then failed with `nothingToMove` — a refusal after the
 * commitment, which reads as the app breaking rather than as the text being ineligible. */
async function moveSources(fromId, docId, title) {
  const bridge = bridgedIds(docId, title);
  let all = [];
  for (const id of bridge.ids) {
    try { all = all.concat((await Researcher.listTextFiles(fromId, id)).files || []); } catch { /* partial */ }
  }
  all.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  const picks = pickSourceFiles(all);
  /* The MANIFEST is the gate, per Seth — not merely "we found some files". A folder can hold
   * role-tagged files without ever having been described by one, and an assignment built from a
   * guess is what the whole v3 manifest work exists to stop. Unreadable counts as absent: the same
   * rule populateFilesMenu uses, because a wrong-shaped body is not a manifest. */
  let manifest = null;
  if (picks.manifest) {
    try {
      const blob = await Researcher.fetchDriveFile(picks.manifest.id);
      const body = JSON.parse(await blob.text());
      if (body && typeof body === 'object' && Array.isArray(body.files)) manifest = body;
    } catch { manifest = null; }
  }
  const audio = picks.audio ||
    all.find((f) => /\.(wav|mp3|opus|ogg|webm|flac|m4a|aac)$/i.test(String(f.name || ''))) || null;
  /* ⚠ A FLEXTEXT IS REQUIRED ONLY IF ONE IS SUPPOSED TO EXIST (Seth, 2026-08-19: "I want to be able
   * to move any text anywhere, except to a crowd recorder").
   *
   * The gate demanded a flextext unconditionally, which made a crowd recording unmovable — a
   * recording is not a transcription yet and has none. But assigning audio ALONE is the ordinary
   * workflow: assignModal has always allowed it ("showing it on an audio-only assignment is noise"),
   * and both commit paths already refuse only when there is neither audio nor flextext to deliver.
   * So the unconditional demand was protecting nothing in that case.
   *
   * What it IS protecting is a text whose transcription exists and did not resolve — moving that
   * audio-only would silently drop the work. The MANIFEST distinguishes them, which is what a
   * manifest is for: declared-but-missing refuses, never-declared moves as the recording it is. */
  const declaresFlextext = Array.isArray(manifest && manifest.files) && manifest.files.some((f) =>
    isFlextextName(f) || hasRole(f, SOURCE_FT_ROLES));
  return { all, picks, manifest, audio, declaresFlextext,
           ok: !!(manifest && audio && (picks.flextext || !declaresFlextext)) };
}

/* ── DESTINATIONS, GROUPED BY PROJECT ─────────────────────────────────────────────────────────────
 *
 * Seth, 2026-08-20: a text CAN be moved to a device in another project, but "it's clear in both the
 * UI and the actual Google drive/etc changes that they are distinct projects. We don't want it to be
 * easy to accidentally move texts across projects, and also clear that each project has its own
 * 'unassigned' box, not some universal, unassigned anywhere box."
 *
 * Both halves were wrong before this: every device was listed flat, so a device three projects away
 * looked exactly like the one next door; and a single "Google Drive (Unassigned)" row read as one
 * universal box when there is in fact one per project.
 *
 * ⚠ CROSS-PROJECT IS POSSIBLE, NEVER ACCIDENTAL. The source's own project is listed first and holds
 * the default selection; every other project is a separately headed group whose rows are marked as
 * such; and choosing one requires a second, explicit confirmation naming both projects. Possible and
 * deliberate are different settings of the same dial, and this picks deliberate.
 *
 * ⚠ UNASSIGNED IS NAMED AFTER ITS PROJECT. There is exactly one offered — the text's own project's —
 * because `drive-unassign` files a text into the Unassigned folder of ITS OWN container's project and
 * takes no target. Labelling it with the project name makes the per-project truth visible at the
 * moment it matters, instead of implying a universal box that does not exist. */
/* A destination TILE. The radio is still the control — it keeps keyboard and screen-reader
 * behaviour, and the browser keeps the group semantics — but it is visually hidden and the whole
 * label becomes the hit target, highlighted when checked.
 *
 * ⚠ WHY: `.rp-field` is a stacked (label-above-input) layout, so a bare radio rendered as one sat
 * CENTRED ABOVE the next option's name. Seth: "radio buttons don't align with text names, so it's
 * easy to get confused which is which" — in a modal whose whole job is choosing between similarly
 * named devices, and where the wrong pick moves a text to the wrong project. */
function tileOpt(group, value, label, sub, disabled, checked) {
  return `<label class="rp-tile${disabled ? ' rp-tile-off' : ''}">
    <input type="radio" name="${esc(group)}" value="${esc(value)}" ${disabled ? 'disabled' : ''} ${checked ? 'checked' : ''}>
    <span class="rp-tile-name">${esc(label)}</span>
    ${sub ? `<span class="rp-tile-sub">${esc(sub)}</span>` : ''}</label>`;
}

function projectOfInstance(instanceId) {
  const devs = ((estateCache && estateCache.devices) || []);
  const insts = ((lastData && lastData.instances) || []);
  const it = insts.find((x) => x.instance_id === instanceId);
  const dev = devs.find((d) => (d.instanceId && d.instanceId === instanceId)
                            || (it && d.folderId === it.oauth_folder_id));
  return dev ? (dev.projectId || '') : '';
}

function projectName(folderId) {
  const p = ((estateCache && estateCache.projects) || []).find((x) => x.folderId === folderId);
  return p ? (p.name || t('panel.proj.defaultName')) : '';
}

/* Build the grouped destination list. `opt(value, label, sub, disabled, checked)` is supplied by the
 * caller so each modal keeps its own radio name and markup. Returns '' when there are no projects at
 * all, so a flat estate renders exactly the ungrouped list it always did. */
/* ⚠ DRAWN, NOT EMOJI. Unicode has chains (⛓) but no BROKEN link, and the nearest real emoji
 * (⛓️‍💥, Emoji 15.1) would be tofu on the older Androids this suite still runs on — the same trap
 * the Cut tab's ✨ comment describes. ☠ stays a character because it IS Emoji 1.0 and Seth asked
 * for the skull by name. `currentColor` so each icon takes its button's colour. */
const ICON_UNLINK = '<svg class="rp-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9.5 7H7a5 5 0 0 0 0 10h2.5"/><path d="M14.5 7H17a5 5 0 0 1 0 10h-2.5"/><path d="M12 3.5v2M12 18.5v2"/></svg>';
const ICON_X = '<svg class="rp-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* Quick-action icons for the device header. Drawn, for the same reason the Unlink icon is: a
 * "new document" or "gear" emoji is either absent or wildly different per platform, and these sit at
 * 16px where emoji detail turns to mush. currentColor so they inherit the button's state. */
const ICON_NEWTEXT = '<svg class="rp-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"/><path d="M14 3l4 4"/><path d="M14 3v4h4"/><path d="M18 14v6M15 17h6"/></svg>';
const ICON_GEAR = '<svg class="rp-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>';
const ICON_MOVE = '<svg class="rp-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v3"/><path d="M3 7v10a2 2 0 0 0 2 2h7"/><path d="M16 17h6M19 14l3 3-3 3"/></svg>';
const ICON_LINK = '<svg class="rp-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9.5 7H7a5 5 0 0 0 0 10h2.5"/><path d="M14.5 7H17a5 5 0 0 1 0 10h-2.5"/><path d="M8 12h8"/></svg>';

/* ⚠ MODULE SCOPE, NOT INSIDE moveTextModal. groupedDestinations() is a separate function defined
 * ABOVE it and calls tooOldLabel twice; declared as a const inside the modal these were a
 * ReferenceError the moment a move dialog rendered a device that could not receive. The static
 * tests pass either way, which is exactly why this is worth a comment rather than a quiet fix. */
const engOf = (x) => Math.max(0, ...((x.installs || []).map((i) => parseInt(String((i.inventory && i.inventory.engineVersion) || '').replace(/[^0-9]/g, ''), 10) || 0)));
/* ⚠ SAY WHAT WE KNOW AND WHEN WE LEARNED IT (issue #16). The gate reads the version the DEVICE
 * LAST REPORTED, which the panel cannot refresh on its own — the device has to check in. So
 * "needs its app updated first" was a claim the panel had no standing to make: Brian's device was
 * already on v543, he reloaded the panel twice, and of course nothing changed, because reloading
 * the panel re-reads the same stored report.
 * ⚠ NO STALENESS THRESHOLD. Guessing "older than N minutes is stale" invents a fact; showing the
 * reading and its age states one, and lets the researcher draw the obvious conclusion — "v139, as
 * of 3 h ago" reads as out of date without anyone having to define out of date. When nothing has
 * ever been reported, say THAT, and name the action that fixes it: open the app on the device. */
const seenOf = (x) => Math.max(0, ...((x.installs || []).map((i) => i.last_seen_at || 0)));
const tooOldLabel = (x) => {
  const v = engOf(x);
  return v > 0
    ? t('panel.move.tooOldAt', { ver: 'v' + v, when: lastSeen(seenOf(x) || 0) })
    : t('panel.move.tooOldUnknown');
};

function groupedDestinations(insts, homeProject, opt, canPick, withUnassigned) {
  const projects = ((estateCache && estateCache.projects) || []);
  if (!projects.length) return '';
  const order = [...projects].sort((a, b) => (b.folderId === homeProject) - (a.folderId === homeProject));
  const out = [];
  let first = true;
  for (const p of order) {
    const mine = insts.filter((x) => projectOfInstance(x.instance_id) === p.folderId);
    // ⚠ NOT `continue` on an empty project — its Unassigned box is still a valid destination, and
    // skipping the group would hide the one thing an empty project can receive.
    if (!mine.length && !withUnassigned) continue;
    const away = p.folderId !== homeProject && !!homeProject;
    /* ⚠ THE PROJECT'S OWN UNASSIGNED SITS INSIDE ITS OWN GROUP — which is what makes "a different
     * project's Unassigned box" unmistakable rather than a second row that reads almost the same.
     * The nesting is the explanation: the box belongs to the heading above it. */
    out.push(`<div class="rp-move-group${away ? ' rp-move-away' : ''}">
      <div class="rp-move-group-h">${esc(p.name || t('panel.proj.defaultName'))}${away ? ` <span class="rp-badge rp-badge-warn">${esc(t('panel.move.otherProject'))}</span>` : ''}</div>
      ${mine.map((x) => { const ok = canPick(x); const checked = ok && first && !away; if (checked) first = false;
                          return opt(x.instance_id, x.nickname || '?', ok ? '' : tooOldLabel(x), !ok, checked); }).join('')}
      ${withUnassigned ? opt('__unassigned:' + p.folderId,
          t('panel.move.unassignedOf', { project: p.name || t('panel.proj.defaultName') }),
          away ? t('panel.move.unassignedAway') : t('panel.move.unassignedHere'), false, false) : ''}
    </div>`);
  }
  // Devices whose folder no project claims — still reachable, still labelled honestly.
  const loose = insts.filter((x) => !projects.some((p) => projectOfInstance(x.instance_id) === p.folderId));
  if (loose.length) {
    out.push(`<div class="rp-move-group"><div class="rp-move-group-h">${esc(t('panel.proj.outside'))}</div>
      ${loose.map((x) => { const ok = canPick(x); return opt(x.instance_id, x.nickname || '?', ok ? '' : tooOldLabel(x), !ok, false); }).join('')}</div>`);
  }
  return out.join('');
}

/* The second gate on a cross-project move. Returns true to proceed. */
/* Filing into ANOTHER project's Unassigned is a cross-project act with no device involved, so it
 * gets its own confirmation naming both boxes — the device version's wording would be wrong here. */
async function confirmCrossProjectFile(toProject, homeProject) {
  if (!homeProject || !toProject || toProject === homeProject) return true;
  return confirmModal(t('panel.move.crossFileConfirm', { from: projectName(homeProject) || '?', to: projectName(toProject) || '?' }));
}

async function confirmCrossProject(toInstanceId, homeProject) {
  const to = projectOfInstance(toInstanceId);
  if (!homeProject || !to || to === homeProject) return true;
  return confirmModal(t('panel.move.crossConfirm', { from: projectName(homeProject) || '?', to: projectName(to) || '?' }));
}

/* MOVE, from a device (Seth, 2026-08-19: "let's let move also work for that").
 *
 * Two destinations of completely different natures, and it matters which is which:
 *
 *  - ANOTHER DEVICE is an ASSIGNMENT plus a removal, so it needs source material the destination
 *    can actually materialize — `moveSources` is the gate.
 *  - UNASSIGNED assigns nothing. It is the existing upload-first removal: the device lands a fresh
 *    Drive copy, then drops its own, after which no device reports the text and the sweep files it.
 *    Seth had already noticed this ("Remove from device already moves"); what was missing was the
 *    verb, not the machinery. It needs no manifest, so the device gate must NOT block it — the old
 *    version returned early on a failed gate, which left an ineligible text with nowhere to go.
 *
 * ⚠ NOTHING IS RE-PARENTED HERE. The text is still on the device until the delete confirms, and
 * filing it early would put it in the assign queue while a device still holds it — the exact state
 * the sweep exists to resolve. The sweep does it afterwards, on the path already tested.
 *
 * A text held by NO device — unassigned, or sitting in a crowd recorder — does not come through
 * here at all: see adoptTextModal, the source-less flow, which reaches a device via /adopt. */
async function moveTextModal(fromId, docId, title) {
  // ⚠ Only devices on v138+ can RECEIVE a move: older engines ignore the assign's docId and mint
  // their own, so the arrival is invisible to the sweep and the move waits forever (fail-safe —
  // the source is never removed — but wedged). Devices auto-update, so this resolves itself.
  const insts = ((lastData && lastData.instances) || []).filter((x) => x.instance_id !== fromId);
  for (const x of insts) x._canReceive = engOf(x) >= 138;

  /* The device gate, run ONLY when a device could be a destination at all. `why` is the reason no
   * device is selectable, shown in place of the ordinary intro so the modal never presents a row of
   * dead radio buttons with no explanation. */
  let src = null;
  let why = '';
  if (!insts.length) why = 'panel.move.noOther';
  else if (!insts.some((x) => x._canReceive)) why = 'panel.move.allTooOld';
  else {
    try { src = await moveSources(fromId, docId, title); }
    catch { src = null; }
    if (!src) why = 'panel.dl.zipFailed';
    else if (!src.ok) why = src.manifest ? 'panel.move.manifestIncomplete' : 'panel.move.noManifest';
  }
  const deviceOk = !why;
  const firstOk = deviceOk ? insts.find((y) => y._canReceive) : null;

  const opt = (value, label, sub, disabled, checked) => tileOpt('rp-move-to', value, label, sub, disabled, checked);
  const homeProject = projectOfInstance(fromId);
  const grouped = groupedDestinations(insts, homeProject, opt, (x) => deviceOk && x._canReceive, true);

  const m = modal(`
    <h3>${esc(t('panel.move.title', { title }))}</h3>
    <p class="note">${esc(t(deviceOk ? 'panel.move.intro' : why))}</p>
    ${grouped || insts.map((x) => opt(x.instance_id, x.nickname || '?', x._canReceive ? '' : tooOldLabel(x),
                           !deviceOk || !x._canReceive, deviceOk && x === firstOk)).join('')}
    ${grouped ? '' : opt('__unassigned', t('panel.move.unassignedOpt'), t('panel.move.unassignedWhyDevice'), false, !deviceOk)}
    ${grouped ? `<p class="note">${esc(t('panel.move.unassignedPerProject'))}</p>` : ''}
    <button class="primary-btn" data-m="go">${esc(t('panel.move.go'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
    <div class="rp-adm-say" id="rp-move-say" hidden></div>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', async (e) => {
    const to = (m.el.querySelector('input[name="rp-move-to"]:checked') || {}).value;
    if (!to) return;
    // ⚠ The second gate: a cross-project move must be said out loud before it happens.
    if (!to.startsWith('__unassigned') && !(await confirmCrossProject(to, homeProject))) return;
    // Filing into ANOTHER project's box is a cross-project act too, and says so by name.
    if (to.startsWith('__unassigned:') && !(await confirmCrossProjectFile(to.slice(13), homeProject))) return;
    const say = m.el.querySelector('#rp-move-say');
    try {
      e.target.disabled = true;

      if (to.startsWith('__unassigned')) {
        /* ⚠ A TARGETED box needs the re-parent EXPLICITLY: the sweep files a text into ITS OWN
         * project's Unassigned, so any other project must be asked for. Issued alongside the removal
         * rather than after it — the folder id is stable, so the device's final upload lands
         * correctly either way. */
        const target = to.startsWith('__unassigned:') ? to.slice(13) : '';
        if (target) await Researcher.driveUnassign([docId], target, unassignFolderEcho([docId]));
        /* The upload-first removal, identical to the del-text path: a fresh Drive copy lands BEFORE
         * the device drops its own. Nothing is re-parented here — the text is still on the device
         * until the delete confirms, and filing it early would put it in the assign queue while a
         * device still holds it, which is the exact state the sweep exists to resolve. The sweep
         * files it once no device reports it. */
        const r2 = await Researcher.uploadDelete(fromId, docId);
        pendingCmds.set(docId, { seq: r2.seq, kind: 'delete', instanceId: fromId, at: Date.now() });
        savePending(Researcher.currentAccountId());
        m.close();
        deps.toast(t('panel.inst.delSent'), 6000);
        renderDashboard();
        return;
      }

      /* The sources were RESOLVED BEFORE this modal opened (moveSources) — re-listing here would
       * spend a second round trip to re-derive an answer we already have, and could in principle
       * disagree with the one the eligibility gate passed on.
       *
       * v3: role tags, not the deleted extension-sniffing table. `bundle` survives HERE and only
       * here — a legacy text's only flextext may still be inside an uploaded zip, and it is the
       * WORKER that extracts it server-side (storeZipEntry). The panel no longer reads zips. */
      const idOf = (f) => (f && f.id) || null;
      const fields = { to, flextextFileId: idOf(src.picks.flextext), extractFromZipId: idOf(src.picks.bundle),
                       audioFileId: idOf(src.audio) };
      const r = await Researcher.moveText(fromId, docId, fields);
      const assignFields = { title };
      if (r.audioUrl) assignFields.audioUrl = r.audioUrl;
      if (r.flextextUrl) assignFields.flextextUrl = r.flextextUrl;
      if (!assignFields.audioUrl && !assignFields.flextextUrl) {
        // The device only materializes an assignment that carries a resource — with nothing to
        // stream, the move cannot deliver content and must say so instead of half-happening.
        say.hidden = false; say.className = 'rp-adm-say rp-adm-err'; say.textContent = t('panel.move.nothingToMove');
        e.target.disabled = false; return;
      }
      await Researcher.assign(to, docId, assignFields);
      const toName = (insts.find((x) => x.instance_id === to) || {}).nickname || '?';
      recordEvents(Researcher.currentAccountId(), [assignedEvent({ instanceId: to, device: toName, docId, title,
        audioUrl: assignFields.audioUrl || '', flextextUrl: assignFields.flextextUrl || '' })]);
      await saveMoves((cur) => { cur[docId] = { from: fromId, to, title, at: Date.now(), stage: 'assigned' }; return cur; });
      m.close();
      deps.toast(t('panel.move.sent', { device: toName }), 6000);
      renderDashboard();
    } catch (err) { say.hidden = false; say.className = 'rp-adm-say rp-adm-err'; say.textContent = String(err.message || err); e.target.disabled = false; }
  });
}

/* ---------------- History: the back-log of texts that USED to be on a device ----------------
 * Deliberately a modal rather than a section of the dashboard: the dashboard answers "what is on
 * my devices right now", and mixing in a growing list of things that are gone would bury it. See
 * js/history.js for how the events are observed (and why deletion is the hard one). */

function histWhen(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '?';
  // Explicit date AND time: "which device, when" is the whole point, and a relative
  // "3 days ago" stops being useful for exactly the old entries this log exists to hold.
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* THE "UNASSIGNED" CARD — texts that live in Drive and on no device (Seth, 2026-08-12).
 *
 * ⚠ IT IS NOT A PSEUDO-INSTANCE, deliberately. It has no instance_id, no ack_seq, no installs and
 * no pairing secret, so it is NOT pushed into lastData.instances — a synthetic entry there would
 * have to be special-cased at every site that iterates instances, which is exactly the "rule
 * enforced in one place that other paths reach differently" drift the backlog warns about. It is
 * built from the Drive estate and rendered with the same row markup, and NO fake instance_id ever
 * reaches the worker: every action here names a real destination device or acts on Drive directly.
 *
 * Same buttons as a device row, with ONE substitution: "Remove from Google Drive" in place of
 * "Remove from Device", because there is no device to remove it from — the Drive copy is all that
 * is left, which is also why removing it is the one genuinely destructive action on this card. */
function unassignedTexts(estate) {
  if (!estate || !Array.isArray(estate.texts)) return [];
  const assigned = assignedDocIds();
  // A text mid-MOVE is not unassigned — it is between devices, and listing it here would offer to
  // delete Drive's only copy while the destination is still fetching it. A text mid-ASSIGNMENT is
  // the same case and was missing: see inFlightAssignIds().
  const inFlight = inFlightAssignIds();
  /* ⚠ A CROWD SUBMISSION IS NOT "UNASSIGNED" — it is held by its recorder (plan §16.24).
   *
   * "No device reports it" is PERMANENTLY true of a crowd text: it was never on a device and never
   * will be. Without this the card lists every crowd recording for ever, offering "Remove from
   * Google Drive" on each — and a recorder can produce them without limit, so the researcher's own
   * set-aside pile fills with things they never set aside. Seth: "we don't want crowd submitted,
   * potentially unlimited number texts ending up in the unassigned box without the researcher
   * specifically putting them there."
   *
   * This is the SECOND bug from that one predicate shape (the sweep was the first, v407). Any new
   * rule phrased as "no device reports it" must be checked against the crowd case before it ships. */
  /* ⚠ IN FLIGHT MEANS SHOWN-AND-LOCKED, NEVER HIDDEN. These two were exclusions, and that is how a
   * text became invisible in the panel AND the storage modal at once while sitting plainly in Drive:
   * the sweep filed it under Unassigned, and a stale pending-move record then removed it from the one
   * view that would have shown it. A researcher who cannot SEE a text cannot do anything about it,
   * which is strictly worse than any wrong placement.
   *
   * The original reason for hiding was sound and is preserved differently: an in-flight text must not
   * offer to delete Drive's only copy while a destination is still fetching it. So it is listed, with
   * a pending tag, and its destructive action is withheld — see renderUnassignedCard. */
  return estate.texts.filter((tx) => tx.docId && !assigned.has(tx.docId) && !tx.fromCrowd)
    .map((tx) => ({ ...tx, pending: pendingMoves.has(tx.docId) || inFlight.has(tx.docId) }));
}

/* The texts sitting in ONE crowd recorder's folder. A recorder is a container of texts exactly as a
 * device is (§16.9) — it just cannot be a destination. Linked by `oauth_folder_id`, which crowdList
 * already returns, so this needs nothing new from the worker. */
function crowdTexts(estate, rec) {
  const folder = rec && rec.oauth_folder_id;
  if (!folder || !estate || !Array.isArray(estate.texts)) return [];
  return estate.texts.filter((tx) => tx && tx.deviceFolderId === folder);
}

/* ── PROJECTS ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The Drive folder layer (plans/drive-as-truth.md §16.16): every container — device folders, crowd
 * recorders, Unassigned — becomes a child of a PROJECT folder instead of hanging off master.
 *
 * ⚠ THIS CARD REPLACES `fxProjects()`, and only now. The console-first rule was explicit: "a button
 * implies we are confident, and we are not yet" — this being the first operation in the suite that
 * MOVES a researcher's folders. What earned the button is that the round trip was executed on the
 * real production estate and measured: 103 objects, nothing lost, no id changed, byte delta exactly
 * zero (§17.4a). `fxProjects()` stays for the operator.
 *
 * ⚠ EVERY ACTION PREVIEWS FIRST, and that is not politeness. The worker defaults `dry` to true and
 * this UI never sends `dry:false` except from a button the researcher pressed while looking at the
 * list of folders that would move. Two independent defaults, so forgetting either one is still safe.
 *
 * ⚠ IT IS BACKWARD-COMPATIBLE BY CONSTRUCTION, in both directions:
 *   - A flat estate renders this card as an OFFER; nothing is migrated until asked.
 *   - The worker's `buildDriveEstate` reads both tree shapes and keeps emitting the old
 *     `{devices, texts, unassignedFolderId}` fields, so a panel that predates projects renders a
 *     migrated estate exactly as it renders a flat one — devices flattened across projects.
 *   - New device and crowd folders resolve their parent through Drive (`driveDefaultProjectFolder`),
 *     NOT through D1, so this works with `instance.project_id` still NULL and needs no migration
 *     applied to any database. */
function projectOf(estate, folderId) {
  return ((estate && estate.projects) || []).find((p) => p.folderId === folderId) || null;
}

/* Drives the silent path above.
 *
 * ⚠ IT REUSES THE MIGRATE ROUTE, AND THAT IS NOT A MISNOMER TO FIX WITH A SECOND ENDPOINT. With
 * nothing to move, `projects/migrate` does exactly one thing: `driveEnsureDefaultProject`, which
 * creates the master folder and the project folder if they do not exist. For a BRAND-NEW account
 * that is not a migration at all — it is the estate being created correctly in the first place,
 * which is precisely what should happen. Adding a second route that made the same two Drive calls
 * would give the "where does a project come from" question two answers, and two answers is how they
 * start to differ.
 * A tiny state machine rather than a bare boolean because
 * `renderProjectsCard` runs on every dashboard paint INCLUDING the poll's, so the three states it
 * has to tell apart are "not asked yet", "asking — draw nothing" and "asked, draw the answer".
 * Deliberately once per panel session: a researcher who declines nothing and simply has containers
 * to move should not re-run a dry run every poll. */
let layoutState = 'idle';          // idle | running | done | failed

async function ensureProjectLayout() {
  if (layoutState !== 'idle') return;
  layoutState = 'running';
  try {
    const plan = await Researcher.projectsMigrate({ dry: true });
    if (plan && !plan.count) {
      /* Nothing moves, so there is nothing to preview and nothing to consent to — the call only
       * creates the folder this account was always going to need. `name` is passed because the
       * worker cannot know what language the researcher reads. */
      await Researcher.projectsMigrate({ name: t('panel.proj.defaultName'), dry: false });
      layoutState = 'done';
      await estateSettle(true);      // Drive's search index lags the write; render the settled shape
    } else {
      layoutState = 'done';          // there IS something to move → the card takes it from here
    }
  } catch { layoutState = 'failed'; }
  renderFromSettledEstate();
}

function renderProjectsCard(estate) {
  if (!estate || !Array.isArray(estate.devices)) return '';
  const projects = estate.projects || [];
  const devices = estate.devices || [];
  /* ⚠ NOT AN OFFER — see §16.28. This states that the layout needs updating and gives ONE action.
   * The earlier copy pitched projects as a way to keep bodies of work apart, which reads as a
   * feature you may or may not want; the migration is one-way, permanent and for everyone, and the
   * panel must not teach otherwise. The dry-run preview is NOT what "not optional" removes — the
   * researcher still sees which folders will move before they move. */
  if (!projects.length) {
    /* ⚠ AN ACCOUNT WITH NOTHING TO MOVE MUST NOT BE ASKED TO MOVE IT (Seth, 2026-08-20).
     *
     * v432 fixed the wrong half. It noticed that an account with no devices was shown the migration
     * card and then handed a DISABLED button, and it enabled the button. But a researcher who has
     * nothing to migrate should never meet the card at all: a brand-new account should simply START
     * in the project layout, and an older empty one should arrive there without being told its
     * folders are wrong and asked to authorise a repair. The step is unsettling precisely because it
     * sounds like something is broken — and for these accounts nothing is.
     *
     * So: on a flat estate, ASK THE WORKER what would move before drawing anything. Nothing to move
     * ⇒ run the migration silently (it creates the project folder, and on a truly new account the
     * master folder too) and re-render into the normal dashboard. Something to move ⇒ the card
     * appears, unchanged, because those moves SHOULD be previewed and consented to.
     *
     * ⚠ The predicate is the worker's own dry run — the same call the modal previews with — and not
     * a second client-side guess at "is this estate empty". A local guess would be one more thing
     * that can disagree with the worker as the estate shape evolves; this cannot drift, because
     * there is only one answer and both paths read it.
     *
     * A FAILED check falls through to the card. Offering a manual button that works is a much better
     * failure than hiding the only way forward, which is the trap v432 was already dug out of. */
    if (layoutState === 'idle' || layoutState === 'running') { ensureProjectLayout(); return ''; }
    return `<div class="rp-card rp-projects">
      <div class="rp-inst-top"><span class="rp-inst-name">${esc(t('panel.proj.title'))}</span>
        <span class="rp-badge rp-badge-type">${esc(t('panel.proj.flatTag'))}</span></div>
      <p class="note">${esc(t('panel.proj.introFlat'))}</p>
      <div class="rp-inst-actions"><button class="primary-btn" data-pact="setup">${esc(t('panel.proj.setup'))}</button></div>
    </div>`;
  }
  /* ⚠ COUNT ONLY LIVE-BACKED DEVICES (issue #10, interim ahead of the decided sweep-then-move
   * retention design). Revoking clears the PAIRING but leaves the device's Drive folder, so a
   * pair-and-revoke cycle left "4 devices" on a project with zero paired. Live means: the estate
   * stamped an instanceId (only revoked=0 rows are stamped), OR the folder matches a live
   * instance's oauth_folder_id (a live device the estate has not stamped yet). Crowd folders count
   * as themselves. Fallback: if NOTHING anywhere carries either signal (an older worker's estate),
   * count raw rather than showing zero everywhere — a wrong count beats a lying one. */
  const liveInstances = ((lastData || {}).instances) || [];
  const liveFolders = new Set(liveInstances.map((i) => i.oauth_folder_id).filter(Boolean));
  /* ⚠ AN EMPTY INSTANCE LIST IS AN ANSWER, NOT A MISSING SIGNAL — and getting that backwards left
   * the ORIGINAL bug alive in the fallback (Brian, issue #10: "Now I have no devices paired, but
   * ... it says 4 devices for this project instead of 0"). Revoke every device and there is nothing
   * left to stamp and no folder to match, so `anyLiveSignal` went false, the fallback counted raw,
   * and the count read 4 — exactly the case reported, reached by the path meant to protect it.
   *
   * The two states are distinguishable because they come from DIFFERENT endpoints. `lastData` is
   * listView, which excludes revoked instances: an empty list there means genuinely none are live,
   * whatever the estate does or does not stamp. The estate's stamping is the only thing an older
   * worker can be missing, so ambiguity survives in exactly one shape — instances exist, yet none
   * carries a folder id and none is stamped — and only that shape still counts raw.
   *
   * Order matters: `lastData` absent (nothing loaded yet) is unknown, not zero. */
  const cannotTell = !lastData
    || (liveInstances.length > 0 && liveFolders.size === 0 && !devices.some((d) => d.instanceId));
  const liveDevice = (d) => d.kind === 'crowd' || cannotTell || !!d.instanceId || liveFolders.has(d.folderId);
  const rows = projects.map((p) => {
    const mine = devices.filter((d) => d.projectId === p.folderId && liveDevice(d));
    return `<div class="rp-proj-row">
      <div class="rp-text-main">
        <div class="rp-text-title">${esc(p.name || t('panel.proj.defaultName'))}</div>
        <div class="note rp-text-meta">${esc(t('panel.proj.nContainers', { n: mine.length }))}</div>
      </div>
      <div class="rp-text-actions">
        <button class="link-btn" data-pact="defaults" data-folder="${esc(p.folderId)}" data-name="${esc(p.name || '')}">${esc(t('panel.proj.defaults'))}</button>
        <button class="link-btn" data-pact="rename" data-folder="${esc(p.folderId)}" data-name="${esc(p.name || '')}">${esc(t('panel.proj.rename'))}</button>
        ${/* ⚠ SHOWN ONLY WHILE THE PROJECT IS EMPTY, because the worker refuses a non-empty one
             (409 project_not_empty) and offering a button that can only fail is the thing this panel
             has a standing rule against. `mine.length` is the same count the row already prints, so
             the control and the sentence above it can never disagree.
             ⚠ OWNER-ONLY BY CONSTRUCTION: this card renders the caller's OWN estate — a shared
             project appears as a TAB, never as a row here — so there is no member case to gate. */''}
        ${mine.length === 0 ? `<button class="link-btn rp-revoke" data-pact="delete" data-folder="${esc(p.folderId)}" data-name="${esc(p.name || '')}">${esc(t('panel.proj.delete'))}</button>` : ''}
      </div>
    </div>`;
  }).join('');
  /* ⚠ Containers still under MASTER after a migration are not an error state to hide — a half
   * migrated tree is exactly what an interrupted run leaves, and the estate reads it correctly. Say
   * so, and offer the run again, rather than letting it look finished. */
  const stray = devices.filter((d) => !d.projectId && liveDevice(d)).length;
  /* ⚠ NO UNDO BUTTON HERE, DELIBERATELY (§16.28). A prominent "go back to a flat folder" IS the
   * optionality message whatever the surrounding words say — a destination you are invited to leave
   * is a mode. The undo has NOT been deleted: `fxProjects('undo')` opens the same modal, preview and
   * all, and §17.4's rollback ladder still names unmigrate as step 2. Recovery exists and is
   * documented for whoever needs it; the panel simply stops advertising that going back is a way to
   * live. */
  return `<div class="rp-card rp-projects">
    <div class="rp-inst-top"><span class="rp-inst-name">${esc(t('panel.proj.title'))}</span></div>
    ${rows}
    ${stray ? `<p class="banner warn-banner">${esc(t('panel.proj.stray', { n: stray }))}</p>
      <button class="secondary-btn" data-pact="setup">${esc(t('panel.proj.finish'))}</button>` : ''}
    <div class="rp-inst-actions"><button class="secondary-btn" data-pact="new">${esc(t('panel.proj.new'))}</button></div>
  </div>`;
}

/* ⚠ DRIVE'S SEARCH INDEX IS EVENTUALLY CONSISTENT, AND THE ESTATE IS BUILT FROM A SEARCH.
 *
 * This is the v167 lesson arriving in a new place. `driveListAll` lists with `files?q=trashed=false`
 * and reads `parents` off that result — the SEARCH index, which lags a write. `files.get` by id is
 * strongly consistent, but there is no by-id way to ask for a whole tree, so a re-parent can be
 * complete in Drive and invisible to the very next estate call.
 *
 * The symptom is precise and was reported exactly this way: "it updated Google drive, but not the
 * researcher UI". Nothing had failed — the panel re-read the tree and Drive told it the old answer.
 *
 * So after a migration, poll until the shape MATCHES what we just asked for, then render from that.
 * Bounded: Drive settles in seconds, and if it has not, saying so is better than painting a flat
 * estate that looks like the migration silently did nothing. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function estateSettle(wantProjects, say) {
  for (let i = 0; i < 6; i++) {
    let est = null;
    try { est = await Researcher.driveEstate(); } catch { est = null; }
    if (est && ((est.projects || []).length > 0) === wantProjects) { estateCache = est; return true; }
    if (say) say(t('panel.proj.settling'));
    await sleep(1500);
  }
  return false;
}

/* Render from the estate we just settled, WITHOUT letting renderDashboard fetch it again — a second
 * read is a second chance to get the stale answer and undo the wait. Passing `lastData` takes the
 * prefetched path, which reuses `estateCache`. */
function renderFromSettledEstate() { renderDashboard(lastData || undefined); }

/* ⚠ WAIT FOR ONE PARTICULAR FOLDER TO DISAPPEAR — estateSettle cannot do this, and the difference is
 * why this exists rather than another call to it. Its predicate is "are there any projects at all", a
 * BOOLEAN, which does not move when one of several projects goes away.
 *
 * The lag is real and was watched live: a deleted project stayed on screen until a manual Refresh,
 * because the estate is built from a SEARCH (files?q=trashed=false) and Drive's search index lags the
 * write that trashed it. Left alone, the researcher deletes, sees the project still sitting there, and
 * presses Delete again — on a folder that is already in the bin. */
async function estateWithoutFolder(folderId) {
  for (let i = 0; i < 6; i++) {
    let est = null;
    try { est = await Researcher.driveEstate(); } catch { est = null; }
    if (est && !((est.projects || []).some((p) => p.folderId === folderId))) { estateCache = est; return true; }
    await sleep(1500);
  }
  return false;   // gave it 9s; render anyway rather than hang on an index that may lag longer
}

/* Run migrate/unmigrate to completion. The worker caps each call at 20 containers and reports
 * `remaining`, so one press finishes an estate of any size instead of silently doing the first 20
 * — the cap exists so a huge estate cannot die halfway, not so the researcher has to press twice. */
async function projectsRunToEnd(apply, say) {
  let moved = 0;
  for (let pass = 0; pass < 10; pass++) {
    const r = await apply();
    moved += r.moved || 0;
    if (say) say(t('panel.proj.moving', { n: moved }));
    if (!r.remaining) return { moved, done: true };
  }
  return { moved, done: false };
}

function projectPlanHtml(plan) {
  /* ⚠ NOTHING TO MOVE IS NOT NOTHING TO DO. A researcher with no devices yet — a brand-new account,
   * or one that predates all this and never added anything — still needs their project folder, and
   * the migration creates it whether or not anything moves. The first version disabled the button on
   * `count === 0`, so those accounts were told their folders needed updating and then prevented from
   * updating them: prompted, blocked, with no way forward. */
  if (!plan.count) {
    return `<p class="note">${esc(t(plan.wouldCreateProject ? 'panel.proj.planEmptyNew' : 'panel.proj.planNone'))}</p>`;
  }
  return `<p class="note">${esc(t('panel.proj.planCount', { n: plan.count }))}</p>
    <ul class="rp-proj-plan">${plan.moves.map((mv) =>
      `<li>${esc(mv.name || '?')} <span class="note">${esc(t('panel.proj.kind.' + (mv.kind === 'crowd' ? 'crowd' : mv.kind === 'unassigned' ? 'unassigned' : 'device')))}</span></li>`).join('')}</ul>`;
}

async function projectsSetupModal() {
  let plan = null;
  try { plan = await Researcher.projectsMigrate({ dry: true }); }
  catch (e) { errToast(e); return; }
  /* ⚠ THE DUPLICATE-PROJECT GUARD, and it closes a real path rather than a theoretical one.
   *
   * Seth, having seen the card fail to update: "I don't want to know what happens if I see my panel
   * is unchanged and try running it again..." Most of that second run is harmless — re-parenting a
   * folder to where it already is, is a no-op, and removing a parent it no longer has is ignored.
   *
   * The one path that is NOT harmless: `driveEnsureDefaultProject` finds the existing project folder
   * by TAG SEARCH. If that search is still lagging, it does not find it and CREATES A SECOND ONE —
   * the v167 duplicate-folder bug, in a new costume.
   *
   * `wouldCreateProject: true` while the estate we already hold reports a project is exactly the
   * signature of a stale index, and it is the only combination that can mint a duplicate. Refuse,
   * say why, and let Drive catch up. */
  if (plan.wouldCreateProject && ((estateCache && estateCache.projects) || []).length) {
    deps.toast(t('panel.proj.stale'), 9000);
    return;
  }
  const m = modal(`<h3>${esc(t('panel.proj.setupTitle'))}</h3>
    <p class="note">${esc(t('panel.proj.setupIntro'))}</p>
    ${projectPlanHtml(plan)}
    ${plan.wouldCreateProject ? `<label class="rp-field"><span>${esc(t('panel.proj.nameLabel'))}</span>
      <input id="rp-proj-name" spellcheck="false" value="${esc(t('panel.proj.defaultName'))}"></label>
      <p class="note">${esc(t('panel.proj.nameNote'))}</p>` : ''}
    <div class="rp-adm-say" id="rp-proj-say" hidden></div>
    <div class="modal-actions">
      <button class="secondary-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
      <button class="primary-btn" data-m="go"${(plan.count || plan.wouldCreateProject) ? '' : ' disabled'}>${esc(t(plan.count ? 'panel.proj.go' : 'panel.proj.goEmpty'))}</button>
    </div>`);
  const say = (txt) => { const el = m.el.querySelector('#rp-proj-say'); el.hidden = false; el.className = 'rp-adm-say'; el.textContent = txt; };
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', (e) => busy(e.target, async () => {
    const nameEl = m.el.querySelector('#rp-proj-name');
    const name = (nameEl && nameEl.value.trim()) || t('panel.proj.defaultName');
    try {
      const r = await projectsRunToEnd(() => Researcher.projectsMigrate({ name, dry: false }), say);
      const settled = await estateSettle(true, say);
      m.close();
      deps.toast(t(!r.done ? 'panel.proj.partial' : settled ? 'panel.proj.done' : 'panel.proj.doneSlow', { n: r.moved }), 8000);
      renderFromSettledEstate();
    } catch (err) {
      const el = m.el.querySelector('#rp-proj-say');
      el.hidden = false; el.className = 'rp-adm-say rp-adm-err'; el.textContent = String(err.message || err);
    }
  }));
}

/* ⚠ THE UNDO IS A FIRST-CLASS BUTTON, not a hidden operator trick. §17 exists because the honest
 * answer to "what if this tangles my Drive" has to be something the researcher can DO, and an undo
 * nobody can find is not reassurance. It previews like everything else, and it trashes the project
 * folder only when it is empty. */
async function projectsUndoModal() {
  let plan = null;
  try { plan = await Researcher.projectsUnmigrate({ dry: true }); }
  catch (e) { errToast(e); return; }
  const m = modal(`<h3>${esc(t('panel.proj.undoTitle'))}</h3>
    <p class="note">${esc(t('panel.proj.undoIntro'))}</p>
    ${projectPlanHtml(plan)}
    <div class="rp-adm-say" id="rp-proj-say" hidden></div>
    <div class="modal-actions">
      <button class="secondary-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
      <button class="primary-btn" data-m="go"${plan.count ? '' : ' disabled'}>${esc(t('panel.proj.undoGo'))}</button>
    </div>`);
  const say = (txt) => { const el = m.el.querySelector('#rp-proj-say'); el.hidden = false; el.className = 'rp-adm-say'; el.textContent = txt; };
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', (e) => busy(e.target, async () => {
    try {
      const r = await projectsRunToEnd(() => Researcher.projectsUnmigrate({ dry: false }), say);
      const settled = await estateSettle(false, say);
      m.close();
      deps.toast(t(!r.done ? 'panel.proj.partial' : settled ? 'panel.proj.undone' : 'panel.proj.doneSlow', { n: r.moved }), 8000);
      renderFromSettledEstate();
    } catch (err) {
      const el = m.el.querySelector('#rp-proj-say');
      el.hidden = false; el.className = 'rp-adm-say rp-adm-err'; el.textContent = String(err.message || err);
    }
  }));
}

/* A new project is EMPTY until a container is moved into it — deliberately. Creating a project must
 * not guess which devices belong to it, and an empty project with a clear "move a device here" path
 * is honest where an auto-populated one would be a guess presented as a decision. */
async function projectNewModal() {
  const m = modal(`<h3>${esc(t('panel.proj.newTitle'))}</h3>
    <p class="note">${esc(t('panel.proj.newIntro'))}</p>
    <label class="rp-field"><span>${esc(t('panel.proj.nameLabel'))}</span>
      <input id="rp-proj-name" spellcheck="false" placeholder="${esc(t('panel.proj.newPlaceholder'))}"></label>
    <div class="rp-adm-say" id="rp-proj-say" hidden></div>
    <div class="modal-actions">
      <button class="secondary-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
      <button class="primary-btn" data-m="go">${esc(t('panel.proj.newGo'))}</button>
    </div>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', (e) => busy(e.target, async () => {
    const name = m.el.querySelector('#rp-proj-name').value.trim();
    if (!name) return;
    try {
      const r = await Researcher.projectCreate(name);
      /* Drive's search index lags a write, so wait for the new project to actually appear rather than
       * painting a dashboard that still shows one project (§16.27's lesson, same cause). */
      for (let i = 0; i < 6; i++) {
        let est = null;
        try { est = await Researcher.driveEstate(); } catch { est = null; }
        if (est && (est.projects || []).some((p) => p.folderId === r.folderId)) { estateCache = est; break; }
        await sleep(1500);
      }
      currentProject = r.folderId;                     // open the thing that was just made
      m.close();
      deps.toast(t('panel.proj.created', { name }), 5000);
      renderFromSettledEstate();
      /* A new project goes straight into its Default settings (Seth, 2026-08-31: "let's require
       * the user to fill in project defaults for any new projects they create from now on") — the
       * same move newDeviceModal makes for a new device, for the same reason: the one moment the
       * researcher is already thinking about this project is now, and every device it ever gets
       * is born from what they put here. Save is gated by the usual validation; closing without
       * saving leaves the project template-less, which the device flow still survives (blank form
       * + the invite gate), so the requirement guides rather than traps. */
      deps.toast(t('panel.proj.nowDefaults', { name }), 6000);
      await loadProjectDefaults();
      openSettingsModal({ kind: 'project', project: { folderId: r.folderId, name } });
    } catch (err) {
      const el = m.el.querySelector('#rp-proj-say');
      el.hidden = false; el.className = 'rp-adm-say rp-adm-err'; el.textContent = String(err.message || err);
    }
  }));
}

/* Move ONE container into another project. The texts inside ride along as children, and the folder
 * keeps its id — so pending uploads, minted URLs and the device's own record all survive the move. */
async function projectAssignModal(folderId, label) {
  const projects = ((estateCache && estateCache.projects) || []);
  const here = ((estateCache && estateCache.devices) || []).find((d) => d.folderId === folderId);
  const options = projects.filter((p) => p.folderId !== (here && here.projectId));
  if (!options.length) { deps.toast(t('panel.proj.noOtherProject'), 5000); return; }
  const m = modal(`<h3>${esc(t('panel.proj.moveTitle', { name: label }))}</h3>
    <p class="note">${esc(t('panel.proj.moveIntro'))}</p>
    ${options.map((p, i) => tileOpt('rp-proj-to', p.folderId, p.name || t('panel.proj.defaultName'), '', false, i === 0)).join('')}
    <div class="rp-adm-say" id="rp-proj-say" hidden></div>
    <div class="modal-actions">
      <button class="secondary-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
      <button class="primary-btn" data-m="go">${esc(t('panel.proj.moveGo'))}</button>
    </div>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', (e) => busy(e.target, async () => {
    const to = (m.el.querySelector('input[name="rp-proj-to"]:checked') || {}).value;
    if (!to) return;
    try {
      await Researcher.projectAssign(folderId, to);
      for (let i = 0; i < 6; i++) {                    // settle: the re-parent is a search-index write
        let est = null;
        try { est = await Researcher.driveEstate(); } catch { est = null; }
        const d = est && (est.devices || []).find((x) => x.folderId === folderId);
        if (d && d.projectId === to) { estateCache = est; break; }
        await sleep(1500);
      }
      m.close();
      deps.toast(t('panel.proj.moved'), 5000);
      renderFromSettledEstate();
    } catch (err) {
      const el = m.el.querySelector('#rp-proj-say');
      el.hidden = false; el.className = 'rp-adm-say rp-adm-err'; el.textContent = String(err.message || err);
    }
  }));
}

/* DELETE AN EMPTY PROJECT (owner only). Modelled on projectRenameModal, with one difference that is
 * the point: deleting is not undoable from here, so the modal SAYS what happens to the folder rather
 * than asking for a bare yes.
 *
 * ⚠ IT PROMISES THE TRASH, NOT DELETION, because that is what the worker does — the folder is
 * trashed and recoverable for 30 days. Saying "deleted" would be a lie in the safe direction, which
 * is still a lie: someone who needs it back would not know to look.
 *
 * ⚠ 409 project_not_empty IS SHOWN, NOT SWALLOWED. The button only renders on a project the panel
 * believes is empty, but the panel reads Drive's eventually-consistent estate — a device created
 * seconds ago can be missing from it. The worker is the authority and its refusal carries the counts,
 * so the modal can say what is actually still in there instead of "not empty". */
async function projectDeleteModal(folderId, name) {
  const m = modal(`<h3>${esc(t('panel.proj.deleteTitle', { name: name || t('panel.proj.defaultName') }))}</h3>
    <p class="note">${esc(t('panel.proj.deleteNote'))}</p>
    <div class="rp-adm-say" id="rp-proj-say" hidden></div>
    <div class="modal-actions">
      <button class="secondary-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
      <button class="primary-btn rp-danger" data-m="go">${esc(t('panel.proj.deleteGo'))}</button>
    </div>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', (e) => busy(e.target, async () => {
    try {
      await Researcher.projectDelete(folderId);
      m.close();
      deps.toast(t('panel.proj.deleted'), 5000);
      /* ⚠ RELEASE THE TAB FIRST if it was the one on screen — projectScope falls back on its own,
       * but only after painting a dashboard for a project that no longer exists. */
      if (currentProject === folderId) currentProject = null;
      await estateWithoutFolder(folderId);
      renderFromSettledEstate();
    } catch (err) {
      const el = m.el.querySelector('#rp-proj-say');
      el.hidden = false; el.className = 'rp-adm-say rp-adm-err';
      const d = err && err.body;
      el.textContent = (d && d.error === 'project_not_empty')
        ? t('panel.proj.deleteNotEmpty', { n: d.devices || 0 })
        : String(err.message || err);
    }
  }));
}

/* LEAVE A SHARED PROJECT — the member's own withdrawal (Seth, 2026-08-28: "we need members to be
 * able to revoke themselves — leave a project"). Confirms first, because it is not undoable by the
 * member: getting back in needs the OWNER to add them again. */
async function leaveProjectModal(projectId, name) {
  const m = modal(`<h3>${esc(t('panel.proj.leaveTitle', { name: name || '' }))}</h3>
    <p class="note">${esc(t('panel.proj.leaveNote'))}</p>
    <div class="rp-adm-say" id="rp-leave-say" hidden></div>
    <div class="modal-actions">
      <button class="secondary-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
      <button class="primary-btn rp-danger" data-m="go">${esc(t('panel.proj.leaveGo'))}</button>
    </div>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', (e) => busy(e.target, async () => {
    try {
      await Researcher.leaveProject(projectId);
      m.close();
      /* ⚠ The tab that was on screen no longer exists, so the selection must be released before the
       * next render — projectScope's stale-selection branch would fall back on its own, but only
       * after painting an empty dashboard once. */
      currentProject = null;
      deps.toast(t('panel.proj.left'), 5000);
      renderDashboard();
    } catch (err) {
      const el = m.el.querySelector('#rp-leave-say');
      el.hidden = false; el.className = 'rp-adm-say rp-adm-err'; el.textContent = String(err.message || err);
    }
  }));
}

async function projectRenameModal(folderId, current) {
  const m = modal(`<h3>${esc(t('panel.proj.renameTitle'))}</h3>
    <label class="rp-field"><span>${esc(t('panel.proj.nameLabel'))}</span>
      <input id="rp-proj-name" spellcheck="false" value="${esc(current || '')}"></label>
    <p class="note">${esc(t('panel.proj.renameNote'))}</p>
    <div class="rp-adm-say" id="rp-proj-say" hidden></div>
    <div class="modal-actions">
      <button class="secondary-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
      <button class="primary-btn" data-m="go">${esc(t('panel.proj.renameGo'))}</button>
    </div>`);
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', (e) => busy(e.target, async () => {
    const name = m.el.querySelector('#rp-proj-name').value.trim();
    if (!name) return;
    try {
      await Researcher.projectRename(folderId, name);
      m.close();
      deps.toast(t('panel.proj.renamed'), 4000);
      /* A rename cannot change the project COUNT, so estateSettle's predicate cannot detect it. The
       * name is read from the same lagging index, so the card may show the old one for a moment;
       * a full render is the honest thing to do rather than fake the new name locally. */
      renderDashboard();
    } catch (err) {
      const el = m.el.querySelector('#rp-proj-say');
      el.hidden = false; el.className = 'rp-adm-say rp-adm-err'; el.textContent = String(err.message || err);
    }
  }));
}

/* ── THE HIERARCHY: ONE PROJECT AT A TIME ─────────────────────────────────────────────────────────
 *
 * Projects CONTAIN devices, crowd recorders and their own Unassigned pile (§16.16), so the dashboard
 * has to as well — a list of projects sitting above a flat list of devices is a label, not a
 * hierarchy, and it teaches the wrong shape.
 *
 * ⚠ A SWITCHER, NOT STACKED SECTIONS (Seth's call, weighed against where this is going: several
 * projects per researcher, several researchers per project). Stacking every project on one page is
 * simpler today and wrong tomorrow — it scales into a long scroll, and it is the opposite of the
 * access model this is being built for, where a member holds rights to ONE project and should not be
 * scrolling past ones they cannot open. Showing one project at a time makes "what you can see" and
 * "what you are looking at" the same question, which is what an invited researcher's dashboard needs
 * to be by default.
 *
 * ⚠ THE FLAT PATH IS UNTOUCHED — with no project folders this returns null and the dashboard renders
 * exactly as it always has. Everything here can only affect an estate that has been migrated.
 *
 * ⚠ THE JOIN IS BY FOLDER ID, NEVER BY NAME. `estate.devices` maps folderId -> projectId and each
 * instance carries `oauth_folder_id`. Matching on the device NAME would work today and break the
 * moment someone renames a device — names are display-only here, and nothing is found by them.
 *
 * ⚠ CONTAINERS WITH NO PROJECT GET THEIR OWN TAB, rather than being hidden or silently folded into
 * the first project. An interrupted migration leaves containers under master; they still work, and a
 * researcher must be able to reach them — but they are not IN a project and must not be shown as if
 * they were. */
const STRAY_TAB = '__none';
/* SHARED-PROJECT TABS live in the same strip as owned ones but in their OWN id namespace: a member
 * tab's id is `member:<D1 project uuid>`, never a Drive folderId. The prefix is what keeps the two
 * estates from ever being confused — every Drive-side action (new device into project, crowd
 * create, rename) either checks `ids.has()` or is guarded with isMemberTab(), so a D1 uuid can
 * never be handed to Drive as a folder. (Seth, 2026-08-27: shared projects render as tabs, not as
 * a card section that reads like a sub-project of whichever tab is open.) */
const MEMBER_TAB_PREFIX = 'member:';
const memberTabId = (pid) => MEMBER_TAB_PREFIX + pid;
const isMemberTab = (id) => typeof id === 'string' && id.startsWith(MEMBER_TAB_PREFIX);
let currentProject = null;          // folderId | STRAY_TAB | member:<id> | null (= pick the first)

function projectScope(insts, estate, crowdRecs, memberProjects) {
  const projects = (estate && estate.projects) || [];
  /* ⚠ A flat estate STAYS flat (the whole backward-compatibility story below) even when shares
   * exist — the flat branch renders shares as their own card sections instead, where nothing
   * above them can be misread as their parent. Tabs only exist once projects do. */
  if (!projects.length) return null;
  const mps = memberProjects || [];
  /* ⚠ PREFER THE WORKER'S OWN ANSWER. `instanceId` is stamped onto each estate device server-side,
   * where the D1 rows and the Drive tree are both already in hand — one derivation of the
   * relationship instead of two. The folder-id lookup stays as a FALLBACK for a worker that predates
   * the stamp, so an un-deployed backend degrades to the old behaviour rather than emptying the
   * dashboard. Never by NAME in either path. */
  const devs = ((estate && estate.devices) || []);
  const byInstance = new Map(devs.filter((d) => d.instanceId).map((d) => [d.instanceId, d.projectId || '']));
  const byFolder = new Map(devs.map((d) => [d.folderId, d.projectId || '']));
  const projOf = (folderId) => byFolder.get(folderId) || '';
  const projOfInst = (it) => (byInstance.has(it.instance_id) ? byInstance.get(it.instance_id)
                                                             : projOf(it.oauth_folder_id));
  const ids = new Set(projects.map((p) => p.folderId));
  const strayInsts = insts.filter((it) => !ids.has(projOfInst(it)));
  const strayRecs = (crowdRecs || []).filter((r) => !ids.has(projOf(r.oauth_folder_id)));
  const hasStrays = !!(strayInsts.length || strayRecs.length);
  /* A stored selection can point at a project that has since been renamed away, undone, or belonged
   * to another account. Falling back to the first project is always safe; falling back to "whatever
   * was stored" would render an empty dashboard that looks like the devices are gone. */
  let sel = currentProject;
  if (sel === STRAY_TAB) { if (!hasStrays) sel = null; }
  else if (isMemberTab(sel)) {
    // A share can be revoked between renders; falling back to the first owned project is the
    // same "never render an empty dashboard" rule the stale-folderId branch below follows.
    if (!mps.some((m) => memberTabId(m.project_id) === sel)) sel = null;
  }
  else if (!ids.has(sel)) sel = null;
  if (sel === null) sel = projects[0].folderId;
  const selProject = projects.find((p) => p.folderId === sel) || null;
  const ownedSel = sel !== STRAY_TAB && !isMemberTab(sel);
  return {
    projects, hasStrays, sel, selProject, projOf, projOfInst, memberProjects: mps,
    insts: sel === STRAY_TAB ? strayInsts : ownedSel ? insts.filter((it) => projOfInst(it) === sel) : [],
    recs: sel === STRAY_TAB ? strayRecs : ownedSel ? (crowdRecs || []).filter((r) => projOf(r.oauth_folder_id) === sel) : [],
  };
}

/* "Move to project…" on a device card — rendered ONLY when there is somewhere to move it to, i.e.
 * two or more projects exist. A control that always errs into "there is no other project" is worse
 * than an absent one: it teaches the researcher that the button does not work.
 *
 * ⚠ It needs the device's FOLDER, not its instance id — the move is a Drive re-parent, and Drive
 * parentage is the only record of which project a container is in. A device whose folder has never
 * been created (no upload yet, made before eager creation) has nothing to move, and correctly
 * renders no button. */
/* Icon form of projectMoveBtn for the header row. Delegates so the two can never disagree about
 * WHEN a move is offered — it reuses the same function and just swaps the presentation. */
function projectMoveIconBtn(it) {
  const full = projectMoveBtn(it);
  if (!full) return '';
  const m = full.match(/data-iact="([^"]+)"/), i = full.match(/data-i="([^"]+)"/);
  if (!m) return '';
  return `<button class="rp-iconbtn" data-iact="${m[1]}"${i ? ` data-i="${i[1]}"` : ''} title="${esc(t('panel.proj.moveBtn'))}" aria-label="${esc(t('panel.proj.moveBtn'))}">${ICON_MOVE}</button>`;
}

function projectMoveBtn(it) {
  const projects = ((estateCache && estateCache.projects) || []);
  if (projects.length < 2) return '';
  const dev = ((estateCache && estateCache.devices) || [])
    .find((d) => (d.instanceId && d.instanceId === it.instance_id) || d.folderId === it.oauth_folder_id);
  if (!dev) return '';
  return `<button class="secondary-btn" data-pact="moveto" data-folder="${esc(dev.folderId)}" data-name="${esc(it.nickname || '')}">${esc(t('panel.proj.moveBtn'))}</button>`;
}

function renderProjectSwitcher(scope) {
  /* Rendered even with ONE project: it is the project's HEADING as much as a control, and the whole
   * complaint that produced this was that the dashboard did not say which project you were looking
   * at. A single unlabelled tab is still an answer to that question. */
  const tab = (id, label, on) => `<button class="rp-ptab${on ? ' rp-ptab-on' : ''}" data-pact="pick" data-p="${esc(id)}"
      aria-current="${on ? 'true' : 'false'}">${esc(label)}</button>`;
  const tabs = scope.projects.map((p) => tab(p.folderId, p.name || t('panel.proj.defaultName'), p.folderId === scope.sel));
  if (scope.hasStrays) tabs.push(tab(STRAY_TAB, t('panel.proj.outside'), scope.sel === STRAY_TAB));
  /* Shared projects ride the SAME strip, last and visibly different — a distinct tab, never a
   * section under someone else's tab (which read as a sub-project). The "(shared)" tag is part of
   * the label so it survives every styling context (narrow screens, high-contrast). */
  for (const mp of scope.memberProjects || []) {
    const id = memberTabId(mp.project_id);
    const on = id === scope.sel;
    tabs.push(`<button class="rp-ptab rp-ptab-shared${on ? ' rp-ptab-on' : ''}" data-pact="pick" data-p="${esc(id)}"
      aria-current="${on ? 'true' : 'false'}">${esc(mp.name || '?')} <span class="rp-ptab-sharedtag">${esc(t('panel.proj.sharedTag'))}</span></button>`);
  }
  /* "+ New device" rides ON the strip row, right-aligned with Rename (Seth, 2026-08-31, two
   * screenshots: first to the right edge, then up onto this row — the in-between left a wasted
   * blank band under the tabs). One right-side GROUP carries the auto margin, so the button stays
   * flush right whether or not Rename renders (two competing auto margins would split the gap).
   * It lives in the switcher, so it exists on every tabbed layout — owned, strays, shared (where
   * newDeviceModal handles both the manageDevices path and the no-cap fallback); the flat layout
   * has no strip and keeps its own row (renderDashboard). wireActs binds [data-act] anywhere. */
  return `<div class="rp-ptabs" role="tablist" aria-label="${esc(t('panel.proj.title'))}">
      ${tabs.join('')}
      <span class="rp-ptab-right">
        ${scope.selProject ? `<button class="link-btn rp-ptab-rename" data-pact="rename"
          data-folder="${esc(scope.selProject.folderId)}" data-name="${esc(scope.selProject.name || '')}">${esc(t('panel.proj.rename'))}</button>` : ''}
        ${/* ⚠ "New text…" belongs to the PROJECT, beside the project's own device button (issue #4):
             "a 'Upload text' button associated with the project… At a later time, I can move/assign
             it to the device of my choice." Rendered only on a real owned project — the strays tab
             and a member tab have no project folder to upload into, and a button that cannot act is
             worse than an absent one. */''}
        ${scope.selProject ? `<button class="secondary-btn" data-pact="newtext"
          data-folder="${esc(scope.selProject.folderId)}">${esc(t('panel.proj.newText'))}</button>` : ''}
        <button class="primary-btn rp-newdev-btn" data-act="new">${esc(t('panel.dash.newDevice'))}</button>
      </span>
    </div>
    ${scope.sel === STRAY_TAB ? `<p class="note">${esc(t('panel.proj.outsideNote'))}</p>` : ''}`;
}

/* WHICH PROJECT'S "Unassigned" SHOULD LIST THIS TEXT WHILE IT IS IN FLIGHT (issue #14, case 2).
 *
 * Normally the answer is Drive's: the text's own projectId. But adopting re-parents the folder to
 * the destination FIRST and the device fetches it later, so between those two moments a text moved
 * to another project's device belongs, by that field, to a project it has not reached — and it
 * silently left the list the researcher was looking at. Brian: it "does not show up in Unassigned
 * (Project1). It disappears from there." The same-project case looks right only because the field
 * happens not to change.
 *
 * ⚠ THE FALLBACK IS THE DANGEROUS PART, so it is explicit: a remembered origin is honoured ONLY
 * while that project still exists in the estate. Trusting a stale id — a project deleted or renamed
 * away since the move began — would filter the text out of the origin's card AND the destination's,
 * and a text that is in flight must be SHOWN AND LOCKED, never hidden (the rule renderUnassignedCard
 * already states at length). Anything doubtful falls back to Drive's own answer.
 *
 * ⚠ Per-browser, because pendingCmds is: another researcher's panel still lists it under the
 * destination project, exactly as today. Strictly better where it applies, and nothing regresses
 * where it does not. */
function unassignedHomeProject(tx) {
  const here = (tx && tx.projectId) || '';
  const pc = tx && pendingCmds.get(tx.docId);
  const from = pc && pc.kind === 'assign' ? (pc.fromProject || '') : '';
  if (!from || from === here) return here;
  const known = ((estateCache && estateCache.projects) || []).some((p) => p && p.folderId === from);
  return known ? from : here;
}

function renderUnassignedCard(estate, projectFolderId) {
  /* Scoped to ONE project when the dashboard is grouped: each project has its own Unassigned folder
   * (§16.22 #1), so a single shared pile would put one project's set-aside texts under another's
   * heading. Unscoped (flat estate) it behaves exactly as before. */
  let texts = unassignedTexts(estate);
  if (projectFolderId) {
    /* ⚠ ON THE TEXT'S OWN projectId, which the worker stamps. The first version joined through
     * `estate.devices` on `deviceFolderId` — and an unassigned text has NO device folder by
     * construction (the estate reports '' when the parent is not a device), so the filter matched
     * nothing in EVERY tab and the Unassigned card was silently empty everywhere. */
    texts = texts.filter((tx) => unassignedHomeProject(tx) === projectFolderId);
  }
  if (!texts.length) return '';
  texts = texts.slice().sort(textOrder);                    // #15 — same order as the device rows
  const bytes = texts.reduce((a, t) => a + (t.bytes || 0), 0);
  const iid = firstInstanceId();
  const rows = texts.map((tx) => `<li class="rp-text-row">
      <div class="rp-text-main">
        <div class="rp-text-title">${esc(tx.title || t('panel.hist.untitled'))}
          ${tx.done ? `<span class="rp-tag rp-tag-done">${esc(t('panel.inst.doneTag'))}</span>` : ''}</div>
        <div class="note rp-text-meta">${esc(gb(tx.bytes || 0))} · ${esc(t('panel.store.nFiles', { n: tx.files || 0 }))}</div>
      </div>
      <div class="rp-text-actions">
        ${iid ? previewBtnHtml(iid, tx.docId, tx.title || '') + filesMenuHtml(iid, tx.docId, tx.title || '') : ''}
        ${tx.pending
          ? `<span class="rp-tag rp-tag-moving">${esc(t('panel.store.inFlight'))}</span>`
          : `<button class="link-btn" data-uact="adopt" data-id="${esc(tx.docId)}" data-title="${esc(tx.title || '')}">${esc(t('panel.move.btn'))}</button>
             <button class="link-btn rp-revoke" data-uact="drop" data-folder="${esc(tx.folderId)}" data-title="${esc(tx.title || '')}">${esc(t('panel.store.delete'))}</button>`}
      </div>
    </li>`).join('');
  const collapsed = !unassignedOpen;
  return `<div class="rp-card rp-inst rp-unassigned${collapsed ? ' rp-inst-collapsed' : ''}">
    <div class="rp-inst-top">
      <button class="rp-inst-toggle" data-uact="collapse"
              aria-expanded="${collapsed ? 'false' : 'true'}" aria-controls="rp-unassigned-body"
              title="${esc(t(collapsed ? 'panel.inst.expand' : 'panel.inst.collapse'))}">
        <span class="rp-caret" aria-hidden="true">▾</span>
        <span class="rp-inst-name">${esc(t('panel.store.unassignedGroup'))}
          <span class="rp-badge rp-badge-type">${esc(t('panel.store.nTexts', { n: texts.length }))}</span></span>
        <span class="rp-inst-count">${esc(gb(bytes))}</span>
      </button>
    </div>
    <div class="rp-inst-body" id="rp-unassigned-body"${collapsed ? ' hidden' : ''}>
      <div class="rp-install">
        <div class="note">${esc(t('panel.unassigned.intro', { size: gb(bytes) }))}</div>
        <ul class="rp-inv">${rows}</ul>
      </div>
    </div>
  </div>`;
}

/* Adopt: pick a destination device, re-file the folder out of Unassigned, mint streaming URLs, then
 * send the ordinary assign command. A REAL re-assignment (Seth) — the text becomes live on that
 * device again, not merely a folder tidy. */
/* THE SOURCE-LESS MOVE — used by BOTH the Unassigned card and a crowd recorder's rows.
 *
 * ⚠ IT IS NOT `/move`, DELIBERATELY, and that decision predates the crowd work: `/move` requires
 * `toId !== instanceId` because it is a transfer BETWEEN devices, and relaxing that to serve a
 * source-less flow would make one endpoint mean two things on a path field devices use. `/adopt`
 * takes the destination in the path and no source at all, which is exactly the shape a text held by
 * no device needs — a crowd recording included. It is also why the in-flight marker here is an
 * ordinary `assign`, not a pendingMoves record: there is no source half to remove, so a move record
 * would be a removal waiting to fire at a device that never had the text.
 *
 * `opts.unassign` adds Google Drive (Unassigned) as a destination — filing rather than assigning.
 * That is the action §16.25 requires to EXIST: a text may enter the set-aside queue only when the
 * researcher puts it there, and until it existed the queue could only be entered by the sweep. */
async function adoptTextModal(docId, title, opts = {}) {
  /* ⚠ CAPTURED BEFORE ANYTHING MOVES (issue #14, Brian's case 2). Adopting re-parents the text's
   * Drive folder to the destination, so `tx.projectId` becomes the DESTINATION's project the moment
   * the adopt succeeds — and the source project's Unassigned card, which filters on exactly that
   * field, stops listing a text that has not arrived anywhere yet. Brian's report: moving an
   * unassigned text to a device in ANOTHER project made it "disappear from there", while the
   * same-project case correctly kept showing it with "on its way…".
   *
   * So the origin is remembered here, at the top, while it is still true. */
  const originProject = (((estateCache && estateCache.texts) || [])
    .find((tx) => tx && tx.docId === docId) || {}).projectId || '';
  const insts = ((lastData && lastData.instances) || []);
  if (!insts.length && !opts.unassign) { deps.toast(t('panel.move.noOther'), 5000); return; }
  /* SAME GATE AS A DEVICE-TO-DEVICE MOVE (Seth: "either from unassigned or from another device").
   * An unassigned text is the MORE likely one to predate the manifest — it has been sitting in
   * Drive precisely because no device claimed it — so skipping the check here would leave the gap
   * exactly where it is widest.
   *
   * The instance id is only a route for the listing call: driveEnsureTextFolder resolves a text
   * folder by its `flextextDoc` tag and NEVER by parent, which is what makes an unassigned text
   * (whose folder now lives under "Unassigned") listable through any instance at all. */
  /* ⚠ THE GATE GOVERNS DEVICE DESTINATIONS ONLY. Filing under Unassigned assigns nothing — it is a
   * Drive re-parent — so a text that cannot be delivered to a device can still be filed. Returning
   * early on a failed gate, as this did, is what would leave such a text with nowhere to go. */
  let src = null;
  let why = '';
  if (!insts.length) why = 'panel.move.noOther';
  else {
    try { src = await moveSources(insts[0].instance_id, docId, title); }
    catch { src = null; }
    if (!src) why = 'panel.dl.zipFailed';
    else if (!src.ok) why = src.manifest ? 'panel.move.manifestIncomplete' : 'panel.move.noManifest';
  }
  if (why && !opts.unassign) { deps.toast(t(why), 10000); return; }
  const deviceOk = !why;
  /* ⚠ THE TEXT'S OWN PROJECT IS THE HOME here, not a device's — an unassigned or crowd text has no
   * device, but it does sit in some project's folder, and that is what makes a destination "another
   * project" or not. */
  const homeProject = (() => {
    const tx = ((estateCache && estateCache.texts) || []).find((x) => x.docId === docId);
    if (!tx) return '';
    const dev = ((estateCache && estateCache.devices) || []).find((d) => d.folderId === tx.deviceFolderId);
    return (dev && dev.projectId) || tx.projectId || '';
  })();
  const adoptOpt = (value, label, sub, disabled, checked) => tileOpt('rp-adopt-to', value, label, sub, disabled, checked);
  const adoptGrouped = groupedDestinations(insts, homeProject, adoptOpt, () => deviceOk, !!opts.unassign);

  const m = modal(`<h3>${esc(t('panel.unassigned.moveTitle', { title }))}</h3>
    <p class="note">${esc(t(deviceOk ? 'panel.unassigned.moveIntro' : why))}</p>
    ${adoptGrouped || insts.map((x, i) => tileOpt('rp-adopt-to', x.instance_id, x.nickname || '?', '', !deviceOk, deviceOk && i === 0)).join('')}
    ${opts.unassign && !adoptGrouped ? tileOpt('rp-adopt-to', '__unassigned', t('panel.move.unassignedOpt'), t('panel.move.unassignedWhyCrowd'), false, !deviceOk) : ''}
    ${opts.unassign && adoptGrouped ? `<p class="note">${esc(t('panel.move.unassignedPerProject'))}</p>` : ''}
    <div class="rp-adm-say" hidden></div>
    <div class="modal-actions">
      <button class="secondary-btn" data-m="cancel">${esc(t('panel.assign.cancel'))}</button>
      <button class="primary-btn" data-m="go">${esc(t('panel.move.btn'))}</button>
    </div>`);
  const say = m.el.querySelector('.rp-adm-say');
  m.el.querySelector('[data-m="cancel"]').onclick = m.close;
  m.el.querySelector('[data-m="go"]').addEventListener('click', (e) => busy(e.target, async () => {
    const to = (m.el.querySelector('input[name="rp-adopt-to"]:checked') || {}).value;
    if (!to) return;
    if (!to.startsWith('__unassigned') && !(await confirmCrossProject(to, homeProject))) return;
    if (to.startsWith('__unassigned:') && !(await confirmCrossProjectFile(to.slice(13), homeProject))) return;
    try {
      if (to.startsWith('__unassigned')) {
        // A re-parent and nothing else. drive-unassign already takes explicit ids — the sweep is
        // simply a batched caller of the same route, so filing one text adds no machinery.
        await Researcher.driveUnassign([docId], to.startsWith('__unassigned:') ? to.slice(13) : '',
                                       unassignFolderEcho([docId]));
        m.close();
        deps.toast(t('panel.move.filed'), 6000);
        renderDashboard();
        return;
      }
      // The text's own Drive files supply the content, exactly as a move does.
      const files = (await Researcher.listTextFiles(to, docId).catch(() => null)) || { files: [] };
      const picks = pickSourceFiles(files.files || []);
      const r = await Researcher.adoptText(to, docId, {
        flextextFileId: (picks.flextext || {}).id || null,
        audioFileId: (picks.audio || {}).id || null,
        extractFromZipId: (picks.bundle || {}).id || null,
      });
      if (!r.flextextUrl && !r.audioUrl) {
        say.hidden = false; say.className = 'rp-adm-say rp-adm-err';
        say.textContent = t('panel.move.nothingToMove');
        return;
      }
      const fields = { title, folderId: r.folderId || '' };
      if (r.audioUrl) fields.audioUrl = r.audioUrl;
      if (r.flextextUrl) fields.flextextUrl = r.flextextUrl;
      const sent = await Researcher.assign(to, docId, fields);
      const nick = (insts.find((x) => x.instance_id === to) || {}).nickname || '?';
      recordEvents(Researcher.currentAccountId(), [assignedEvent({ instanceId: to, device: nick, docId, title,
        audioUrl: fields.audioUrl || '', flextextUrl: fields.flextextUrl || '' })]);
      // Same pending marker any assignment gets, so the text is visible while the device fetches it.
      // `fromProject` keeps the source project's Unassigned card listing it until it truly arrives —
      // see the capture at the top of this function and unassignedHomeProject below.
      if (sent && sent.seq) {
        pendingCmds.set(docId, { seq: sent.seq, kind: 'assign', instanceId: to, title,
                                 hasAudio: !!fields.audioUrl, at: Date.now(),
                                 ...(originProject ? { fromProject: originProject } : {}) });
        savePending(Researcher.currentAccountId());
      }
      m.close();
      deps.toast(t('panel.move.sent', { device: nick }), 6000);
      renderDashboard();
    } catch (err) {
      say.hidden = false; say.className = 'rp-adm-say rp-adm-err'; say.textContent = String(err.message || err);
    }
  }));
}

/* ---------------- Google Drive storage manager (Seth, 2026-08-12) ----------------
 *
 * The first view in this suite that is NOT derived from device inventory. Every other list answers
 * "what does this device say it holds"; this one answers "what is actually in the researcher's
 * Drive" — which is the only way a text that was uploaded and then removed from its device is
 * visible at all, and the only way its space is accounted for.
 *
 * ⚠ "UNASSIGNED" IS COMPUTED HERE, NOT BY THE WORKER, and it has to be: device inventories are
 * E2EE, so the worker genuinely cannot know which texts a device still holds. That makes the
 * delete-only-unassigned rule a researcher-facing SAFETY RAIL rather than a security boundary, and
 * it is described that way rather than pretended otherwise. The rail is still worth having: Drive
 * is the archive, and deleting the Drive copy of a text a device still holds destroys the only
 * backup of live work if that device is later lost or wiped. */
/* THE UNASSIGNED SWEEP — move the folder of a text no device holds into "FlexText Uploads /
 * Unassigned", so the Drive tree stops contradicting the panel.
 *
 * The worker route has existed, complete and idempotent, since the estate work and had ZERO callers
 * (plans/drive-as-truth.md §7). Seth saw the consequence in the v396 test drive: a text the panel
 * tags `unassigned` whose folder still sits inside a device folder in Drive.
 *
 * ⚠ DRIVEN FROM THE ESTATE, NOT FROM THE present→absent EVENT. The obvious wiring is to sweep when
 * diffInventory reports a text gone — but that event fires ONCE, so anything skipped in that instant
 * is skipped for ever. A text dropped by device A while a move to B is in flight is correctly
 * skipped then, and if the move later fails nothing ever revisits it. Deriving the work from the
 * estate instead makes the sweep SELF-HEALING: every full render re-asks "which texts are unassigned
 * but not in the Unassigned folder", so a skip is retried and a success stops appearing. It also
 * costs nothing extra — the estate is already fetched for the Unassigned card.
 *
 * ⚠ THE THREE EXCLUSIONS ARE THE SAFETY, and they are the same ones the storage modal uses for its
 * Remove button. A text on its WAY to a device reads as "no device holds it" in exactly the same way
 * as one nobody wants, and sweeping then re-parents the folder an upload is still streaming into.
 * `assignedDocIds` is the device truth; `pendingMoves` and `inFlightAssignIds` cover the gap between
 * a researcher's intent and the device's next report.
 *
 * Fire-and-forget by design: this is organisational, and it must never delay a render or take the
 * panel down. A failed sweep simply happens again on the next full render. */
const UNASSIGN_BATCH = 12;          // matches the worker's per-call cap; the rest drains next render
function sweepUnassigned(estate) {
  try {
    /* ⚠ DO NOT RE-ADD `&& estate.unassignedFolderId` HERE. It was in the first version and it made
     * this whole feature INERT — a deadlock found only because a Drive snapshot showed the estate
     * still had no Unassigned folder and the text Seth reported was still in its device folder.
     *
     * The reasoning that put it there sounds right — "do not sweep if there is nowhere to sweep to"
     * — and is exactly backwards: `driveUnassignedFolder()` CREATES the folder on demand, so the
     * destination is made by the very call the guard was suppressing. No folder ⇒ no call ⇒ no
     * folder, for ever, on every estate that has never had one, which is all of them.
     *
     * The route is idempotent and cheap when there is nothing to move, so there is no cost to
     * calling it; the only real precondition is having ids worth sending. */
    if (!estate || !Array.isArray(estate.texts)) return;
    const assigned = assignedDocIds();
    const inFlight = inFlightAssignIds();
    /* ⚠ A CROWD-BORN TEXT IS NOT UNASSIGNED — IT IS HELD BY ITS RECORDER.
     *
     * The sweep's test is "no device reports it", and that is PERMANENTLY TRUE of a crowd
     * submission: it was never on a device and never will be. Without this exclusion the sweep
     * empties every crowd folder into Unassigned and keeps doing it, undoing the whole point of
     * v396 — crowd recordings living as first-class texts in their recorder's folder.
     *
     * Found in production data, not in review: the 11:24 snapshot showed the crowd text in
     * `Crowd — Test Crowd Recorder`, and an hour later the storage view showed it under
     * "Google Drive (unassigned)" with the crowd container gone from the list entirely. The code
     * had read fine twice.
     *
     * ⚠ AND THE EXCLUSION IS SELF-CORRECTING, which is why it is the right shape: `fromCrowd` is
     * computed from where the folder ACTUALLY SITS. Move a crowd text onto a device and it stops
     * being crowd-born, so if that device later drops it, it sweeps normally — no second rule and
     * nothing to keep in sync. (§16.9: crowd is a source, never a destination.) */
    /* ⚠ A TEXT ON A DEVICE THAT HAS NEVER PAIRED IS NOT UNASSIGNED — IT IS WAITING.
     *
     * THIRD TIME for this predicate shape, and the sweep's own comment above says to check every new
     * rule against it. "No device reports it" is PERMANENTLY TRUE of a device that has never paired:
     * it has no installs, so it has no inventory, so it can never claim anything. Assigning a text to
     * a not-yet-paired device — which Seth calls out as important — therefore looked exactly like
     * abandonment, and the sweep hauled the text out of the device's folder into Unassigned.
     *
     * Found in production data again, not in review: the 00:56 snapshot had "Yuli Kwodu Deda" sitting
     * in `Dani Dictionary / Unassigned` seconds after being assigned to `Wemis Wanimbo's Phone`.
     *
     * ⚠ SELF-CORRECTING, like the crowd exclusion: this asks whether the CONTAINER's instance has
     * ever reported, so the moment that device pairs and sends its first inventory the text sweeps
     * under the ordinary rules. No second rule, nothing to keep in sync. */
    const waitingForPairing = (tx) => {
      const dev = (estate.devices || []).find((d) => d.folderId === tx.deviceFolderId);
      const iid = dev && dev.instanceId;
      return !!iid && !instanceReported(iid);
    };
    const ids = estate.texts
      .filter((tx) => tx && tx.docId && !tx.inUnassigned && !tx.fromCrowd && !waitingForPairing(tx)
        && !assigned.has(tx.docId) && !pendingMoves.has(tx.docId) && !inFlight.has(tx.docId))
      .map((tx) => tx.docId)
      .slice(0, UNASSIGN_BATCH);
    if (!ids.length) return;
    Researcher.driveUnassign(ids, '', unassignFolderEcho(ids, estate))
      .catch(() => { /* retried by the next full render */ });
  } catch { /* the sweep must never break the dashboard it rides on */ }
}

/* The devices of ONE owned project, resolved estate-side: project row → drive_folder_id →
 * estate devices under that folder → their instance ids (estate instanceId first, oauth join as
 * the fallback for a device the estate has not stamped yet). Empty when Drive is unreachable —
 * callers report that honestly rather than pretending a grant happened. (Hoisted from
 * coworkersModal so the grant sweep below shares the ONE derivation.) */
function projectInstanceIds(proj) {
  const pf = proj && proj.drive_folder_id;
  if (!pf) return [];
  const devs = ((estateCache && estateCache.devices) || []).filter((d) => d.projectId === pf && d.kind !== 'crowd');
  const out = new Set(devs.map((d) => d.instanceId).filter(Boolean));
  const folders = new Set(devs.map((d) => d.folderId).filter(Boolean));
  for (const i of ((lastData && lastData.instances) || [])) {
    if (i.oauth_folder_id && folders.has(i.oauth_folder_id)) out.add(i.instance_id);
  }
  return [...out];
}

/* THE GRANT SWEEP (2026-08-27) — closes the created-after-membership gap for good. A device made
 * AFTER a coworker was added got no key grants, so the member saw ciphertext (or, before the
 * member view, nothing) until the owner removed and re-added them — a workaround the panel's own
 * error strings had to document. The members list now reports per-member `granted` + `pubkey_set`
 * (the worker join), so the OWNER's panel can diff and heal silently: for each owned project's
 * member with a published key, mint exactly the missing grants.
 *
 * ⚠ ONCE PER SESSION, fire-and-forget, and it must never break the dashboard it rides on: every
 * failure is a console.warn and a retry next session. Idempotent by construction (INSERT OR
 * REPLACE server-side), so over-running costs nothing but requests. Runs AFTER a render so the
 * estate cache it diffs against is as settled as it gets. */
/* ⚠ DELIVER KEYS TO INSTALLS THAT WERE APPROVED WITHOUT ONE (v470). Key delivery has only ever
 * happened INLINE with the panel's Approve button (approveInstall → deliverKey). Every other route
 * to "approved" leaves the install keyless forever, and one of those routes is a FEATURE: a member
 * with manageDevices may approve, but the key route is owner-only on purpose — the worker cannot
 * inspect an opaque wrapped key, so a member could otherwise install one the owner cannot read and
 * lock them out of their own device. That comment predicts "the device waits for the owner"; before
 * this sweep, the owner had nothing that would ever deliver it, so the device waited forever.
 *
 * Owner-only by construction: it runs over the caller's OWN instances, and the route would refuse a
 * member anyway. Best-effort and quiet — a failure here must not disturb a dashboard that is
 * otherwise fine, and the next full render tries again. */
let keySweepBusy = false;
async function deliverPendingDeviceKeys(data) {
  if (keySweepBusy || !Researcher.isUnlocked()) return;
  keySweepBusy = true;
  try {
    let delivered = 0;
    for (const it of ((data && data.instances) || [])) {
      for (const ins of (it.installs || [])) {
        if (ins.status !== 'approved' || ins.has_key || !ins.pubkey) continue;
        /* PHASE 2b: ask the worker to mint (server-key) first — same lane approval uses now — and
         * keep the client-side wrap as the fallback for an older worker or a refused mint. */
        try { await Researcher.serverKeyInstall(it.instance_id, ins.install_id); delivered++; continue; }
        catch { /* fall through to the legacy client-side wrap */ }
        try { await Researcher.deliverKey(it.instance_id, ins.install_id, ins.pubkey); delivered++; }
        catch (e) { console.warn('key delivery failed for', ins.install_id, (e && e.message) || e); }
      }
    }
    if (delivered) deps.toast(t('panel.inst.keysDelivered', { n: delivered }), 6000);
  } catch (e) { console.warn('key sweep skipped:', (e && e.message) || e); }
  finally { keySweepBusy = false; }
}

let grantSweepRan = false, grantSweepBusy = false;
async function memberGrantSweep(force) {
  /* ⚠ NOT session-once any more — that was the gap Seth hit live (2026-08-27): a device created
   * AFTER the session's sweep got no member grant until the owner's next sign-in, so the member
   * saw the device but no_key_for_instance on everything inside it. Now every FULL render forces
   * a pass (initial load, the Refresh button, post-action renders — all human-triggered, so the
   * listProjects+listMembers cost lands where a Drive round trip already does); poll repaints
   * keep the old once-per-session behaviour so the 12s tick stays flat. The busy flag stops two
   * overlapping full renders from double-granting. */
  if (grantSweepBusy || (grantSweepRan && !force) || !Researcher.isApprovedSelf()) return;
  grantSweepRan = true; grantSweepBusy = true;
  try {
    const pj = await Researcher.listProjects();
    let healed = 0;
    for (const proj of (pj.owned || [])) {
      if (!proj.drive_folder_id) continue;
      let members = [];
      try { members = (await Researcher.listMembers(proj.project_id)).members || []; }
      catch { continue; }
      if (!members.length) continue;
      /* PHASE 2b: one call — the WORKER derives each Ki and writes the missing rows itself,
       * keyless-by-design instances excluded by construction (they used to make this loop retry
       * and warn forever). The client-side wrap loop below survives only for an older worker. */
      try {
        const r = await Researcher.sweepProjectGrants(proj.project_id);
        healed += r.granted || 0;
        continue;
      } catch (e) {
        if (!(e && e.status === 404)) { console.warn('grant sweep:', proj.project_id, (e && e.message) || e); continue; }
        /* 404 = a worker predating the route — fall through to the legacy client-side loop. */
      }
      const iids = projectInstanceIds(proj);
      if (!iids.length) continue;
      for (const m of members) {
        if (m.invalid || !m.pubkey_set) continue;   // nothing to wrap to yet — reported on their row
        const have = new Set(m.granted || []);
        const missing = iids.filter((id) => !have.has(id));
        if (!missing.length) continue;
        try {
          const r = await Researcher.grantKeysToMember(m.researcher_id, missing);
          healed += r.granted || 0;
        } catch (e) { console.warn('grant sweep:', m.researcher_id, (e && e.message) || e); }
      }
    }
    if (healed) deps.toast(t('panel.share.sweepHealed', { n: healed }), 6000);
  } catch (e) { console.warn('grant sweep skipped:', (e && e.message) || e); }
  /* ⚠ THE FLAG MUST CLEAR OR THE SWEEP RUNS ONCE PER PAGE LOAD, EVER (v454 — this shipped broken
   * in v451). Without this finally, the first sweep left busy=true forever, every later call —
   * including the forced one right after creating a device — returned at the top, and the device
   * created mid-session never reached the members (Seth: "keys are never being delivered at all").
   * The visible promise ("new devices are unlocked for them automatically") was made by a toast
   * whose mechanism was disabled by its own re-entrancy guard. */
  finally { grantSweepBusy = false; }
}

/* THE JOINED-PROJECTS SECTION (2026-08-27) — the member-side dashboard, v1. One card per project
 * this researcher was invited into, rendering the SAME device cards the owner sees through
 * renderInstanceCard's memberCtx: controls map to the member's capabilities, Drive surfaces are
 * absent (not greyed out), and everything decrypts through the member's own key grants. There is
 * deliberately NO Drive/estate column for joined projects — the honest v1 of the member Drive
 * question, not a bad answer to it. */
/* ONE shared project's body: the coworker badge + caps note + member-gated device cards. Used two
 * ways — as the content of a shared TAB (tabbed layout; the tab carries the name), and wrapped in
 * a titled card by renderJoinedSections (flat layout, where there is no strip to live in). */
async function renderMemberProjectContent(mp) {
  const caps = mp.caps || {};
  const cards = await Promise.all((mp.instances || []).map((it) =>
    renderInstanceCard(it, (mp.instances || []).length, { caps, projectName: mp.name })));
  const capBits = [];
  if (caps.manageDevices) capBits.push(t('panel.share.capManage'));
  if (caps.createInvites) capBits.push(t('panel.share.capInvite'));
  if (caps.assignTexts) capBits.push(t('panel.share.capAssign'));
  if (caps.drive) capBits.push(t('panel.share.capDrive'));
  /* ⚠ LEAVING IS ALWAYS AVAILABLE, and ungated on purpose — it is the one action here that is not
   * the owner's to permit. A share you cannot get out of is not a share, and an owner who stops
   * responding must never be able to strand a coworker in their project. It sits beside the
   * capability line because that line is where "what this share is" is already being stated. */
  return `<p class="note rp-joined-note"><span class="rp-badge rp-badge-type">${esc(t('panel.joined.tag'))}</span>
      ${esc(capBits.length ? t('panel.joined.note', { caps: capBits.join(', ') }) : t('panel.joined.noteNone'))}
      <button class="link-btn rp-revoke rp-leave" data-pact="leave" data-project="${esc(mp.project_id || '')}" data-name="${esc(mp.name || '')}">${esc(t('panel.proj.leave'))}</button></p>
    ${cards.join('') || `<p class="note">${esc(t('panel.joined.empty'))}</p>`}`;
}

// Flat-estate fallback only: shares as their own card sections (no tab strip exists to put them in).
async function renderJoinedSections(data) {
  const mps = (data && data.memberProjects) || [];
  if (!mps.length) return '';
  const parts = [];
  for (const mp of mps) {
    parts.push(`<div class="rp-card rp-joined">
      <div class="rp-inst-top"><span class="rp-inst-name">${esc(t('panel.joined.title', { name: mp.name || '?' }))}</span></div>
      ${await renderMemberProjectContent(mp)}
    </div>`);
  }
  return parts.join('');
}

/* The {docId: folderId} echo driveUnassign sends so a filing survives Drive's search-index lag —
 * the panel already knows every text's folder from the estate, and files.get by id is strongly
 * consistent where the worker's tag search is not (issue #13's silent no-op half). Falls back to
 * the cached estate so the modal call sites need no estate in hand; undefined when nothing is
 * known, which old and new workers alike treat as "search as before". */
function unassignFolderEcho(ids, est) {
  const texts = ((est || estateCache || {}).texts) || [];
  const map = {};
  for (const id of ids) {
    const tx = texts.find((t) => t && t.docId === id && t.folderId);
    if (tx) map[id] = tx.folderId;
  }
  return Object.keys(map).length ? map : undefined;
}

/* THE MAINTENANCE BANNER — an operator-set notice, refreshed by the poll the panel already makes.
 *
 * Seth, 2026-08-19: *"advise the researcher users that critical pieces are undergoing maintenance and
 * they may experience an outage or a glitch during that time and are advised to avoid making changes
 * in Researcher panel until this message is gone."*
 *
 * ⚠ RESEARCHER PANEL ONLY, and that is not incidental. The editor and the panel share an origin and
 * a service worker, so a maintenance screen shipped as a BUILD would reach field translators at
 * /flextext-editor/ and stop them working offline — which would be far worse than any outage it was
 * warning about. Living in this file, rendered into the dashboard, it can only ever reach the panel.
 *
 * ⚠ NOT DISMISSIBLE. The whole point is that it stays until the operator clears the flag; a banner a
 * researcher can hide is a banner they hide once and then make changes under.
 *
 * The message is operator-authored and arrives over the wire, so it is escaped like any other server
 * string — free, and the habit is what keeps the one that isn't free from slipping through. */
function maintenanceBanner() {
  /* Two independent flags (Seth, 2026-08-26): `maintenance` is a banner and nothing else; `freeze`
   * is a banner PLUS the worker-side write lock (423 on every researcher mutation). Both can be up
   * at once — the freeze banner leads, because it states a restriction rather than an advisory. */
  const fz = Researcher.freeze();
  const msg = Researcher.maintenance();
  let out = '';
  if (fz) {
    out += `<div class="rp-maint rp-frozen" role="status">
      <strong>${esc(t('panel.freeze.title'))}</strong>
      <div>${esc(fz)}</div>
      <div class="note">${esc(t('panel.freeze.advice'))}</div>
    </div>`;
  }
  if (msg) {
    out += `<div class="rp-maint" role="status">
      <strong>${esc(t('panel.maint.title'))}</strong>
      <div>${esc(msg)}</div>
      <div class="note">${esc(t('panel.maint.advice'))}</div>
    </div>`;
  }
  return out;
}

function assignedDocIds() {
  const ids = new Set();
  for (const it of (lastData && lastData.instances) || []) {
    for (const ins of it.installs || []) {
      const items = (ins.inventory && Array.isArray(ins.inventory.items)) ? ins.inventory.items : [];
      for (const d of items) if (d && d.id) ids.add(d.id);
    }
  }
  return ids;
}

/* ⚠ A STORAGE VIEW WHOSE SIZES LIE IS WORSE THAN NO STORAGE VIEW. The first version floored every
 * value at 1 MB, so a 400-byte manifest, a 26 KB flextext and a 1.1 MB recording all rendered as
 * "1 MB" — on the one screen whose entire purpose is deciding what is worth deleting. Scale down
 * through KB and bytes rather than clamping. */
const gb = (b) => {
  const n = Number(b) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
};

function storageModal() {
  /* ⚠ THIS MODAL IS ALWAYS AND ONLY THE CALLER'S OWN DRIVE (Seth, 2026-08-28). It reads the
   * caller's own estate, which is right — but a member of a shared project sees THEIR storage,
   * which for a coworker who owns no devices is empty, and an empty list reads as "the shared
   * project has no files" rather than "this is not where those live". One line removes the
   * misreading; it appears only for someone who actually is in a shared project. */
  const inSharedProjects = !!((lastData && lastData.memberProjects) || []).length;
  const m = modal(`<h3>${esc(t('panel.store.title'))}</h3>
    <p class="note">${esc(t('panel.store.intro'))}</p>
    ${inSharedProjects ? `<p class="note">${esc(t('panel.store.ownOnly'))}</p>` : ''}
    <div id="rp-store-body">${loadingHtml('panel.store.loading', true)}</div>
    <div class="modal-actions"><button class="secondary-btn" data-m="close">${esc(t('panel.help.close'))}</button></div>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;

  const body = m.el.querySelector('#rp-store-body');
  let estate = null;

  const paint = () => {
    if (!estate) return;
    const assigned = assignedDocIds();
    const q = estate.quota || {};
    // A MISSING limit means unlimited (pooled accounts) — never render it as 0% free.
    const pct = q.limit ? Math.min(100, Math.round((q.usage / q.limit) * 100)) : 0;
    const quotaLine = q.limit
      ? t('panel.store.quota', { used: gb(q.usage), total: gb(q.limit), pct })
      : t('panel.store.quotaNoLimit', { used: gb(q.usage) });

    // Group: one per device (in estate order), then everything with no device.
    const groups = new Map();
    // folderId rides along so the groups can be nested under their project (storeByProject).
    for (const d of estate.devices || []) groups.set(d.folderId, { folderId: d.folderId, name: d.name, texts: [] });
    const loose = [];
    for (const tx of estate.texts || []) {
      const g = groups.get(tx.deviceFolderId);
      (g ? g.texts : loose).push(tx);
    }
    /* A text is UNASSIGNED when no device reports it — which is independent of where its folder
     * sits. A text still in its device's folder but long since deleted from the device is
     * unassigned, and that is exactly the case this modal exists to surface.
     * ⚠ Except while it is on its WAY to a device: same exclusion as the Unassigned card, and for
     * the same reason — the tag here drives a Remove that trashes the folder an upload is still
     * streaming into. Reclaim-space reads this too, and that one is not recoverable from Drive's
     * trash. */
    const inFlight = inFlightAssignIds();
    /* ⚠ TWO DIFFERENT QUESTIONS, AND CONFLATING THEM MADE A TEXT VANISH. `isUnassigned` was doing
     * double duty: deciding WHICH GROUP a text belongs to, and whether it is safe to offer Remove.
     * An in-flight text then answered "no" to both — so it appeared under no heading at all, in the
     * one view whose whole job is to show what is actually in Drive.
     *
     * Placement is about where the text IS. Safety is about what may be done to it. */
    const isUnassigned = (tx) => !assigned.has(tx.docId);
    const inFlightTx = (tx) => pendingMoves.has(tx.docId) || inFlight.has(tx.docId);

    const row = (tx) => {
      const un = isUnassigned(tx);
      return `<div class="rp-store-row">
        <div class="rp-store-main">
          <div class="rp-store-title">${esc(tx.title || t('panel.hist.untitled'))}
            ${tx.done ? `<span class="rp-tag rp-tag-done">${esc(t('panel.inst.doneTag'))}</span>` : ''}
            ${un ? `<span class="rp-tag rp-tag-unassigned">${esc(t('panel.store.unassignedTag'))}</span>` : ''}</div>
          <div class="note rp-store-meta">${esc(gb(tx.bytes))} · ${esc(t('panel.store.nFiles', { n: tx.files }))}</div>
        </div>
        <div class="rp-store-actions">
          ${firstInstanceId() ? previewBtnHtml(firstInstanceId(), tx.docId, tx.title || '') + filesMenuHtml(firstInstanceId(), tx.docId, tx.title || '') : ''}
          ${un && !inFlightTx(tx)
            ? `<button class="link-btn rp-revoke" data-storedel="${esc(tx.folderId)}" data-title="${esc(tx.title || '')}">${esc(t('panel.store.delete'))}</button>`
            : (inFlightTx(tx) ? `<span class="rp-tag rp-tag-moving">${esc(t('panel.store.inFlight'))}</span>` : '')}
        </div>
      </div>`;
    };

    /* ⚠ THE STORAGE VIEW IS HIERARCHICAL TOO (Seth, 2026-08-20: it "needs to cover ALL Google Drive
     * storage (organized hierarchically by device/container and project)").
     *
     * Container groups are nested under their project, each project carrying its own total, and each
     * project's own Unassigned pile listed with it — because there is one per project, and a single
     * shared "unassigned" heading would put one project's set-aside texts under another's roof.
     *
     * ⚠ Flat estate ⇒ unchanged output, byte for byte: with no projects this returns the container
     * groups followed by one Unassigned group, exactly as before.
     *
     * ⚠ FUTURE-FACING, deliberately: the totals are computed per project rather than only for the
     * account, because a member will one day need "this project's use against this project's limit"
     * for a Drive they do not own. Nothing here reads the owner's quota per project yet — that needs
     * the grant model — but the shape no longer has to be rebuilt to say it. */
    const storeByProject = (est, groups, loose, groupHtml) => {
      const projects = (est.projects || []);
      if (!projects.length) {
        return [...groups.values()].map((g) => groupHtml(g.name, g.texts)).join('')
             + groupHtml(t('panel.store.unassignedGroup'), loose);
      }
      const projOfFolder = new Map((est.devices || []).map((d) => [d.folderId, d.projectId || '']));
      const out = [];
      const claimed = new Set();
      for (const p of projects) {
        const mine = [...groups.values()].filter((g) => projOfFolder.get(g.folderId) === p.folderId);
        mine.forEach((g) => claimed.add(g.folderId));
        const un = loose.filter((tx) => (tx.projectId || '') === p.folderId);
        const bytes = mine.reduce((a, g) => a + g.texts.reduce((b, x) => b + x.bytes, 0), 0)
                    + un.reduce((a, x) => a + x.bytes, 0);
        const n = mine.reduce((a, g) => a + g.texts.length, 0) + un.length;
        if (!n) continue;
        out.push(`<div class="rp-store-project">
          <div class="rp-store-phead">${esc(p.name || t('panel.proj.defaultName'))}
            <span class="note">${esc(gb(bytes))} · ${esc(t('panel.store.nTexts', { n }))}</span></div>
          ${mine.map((g) => groupHtml(g.name, g.texts)).join('')}
          ${groupHtml(t('panel.move.unassignedOf', { project: p.name || t('panel.proj.defaultName') }), un)}
        </div>`);
      }
      /* Anything no project claims — an interrupted migration, or a text filed before projects
       * existed. Shown, never dropped: this view's whole job is to account for what is in Drive. */
      const strayGroups = [...groups.values()].filter((g) => !claimed.has(g.folderId));
      const strayLoose = loose.filter((tx) => !projects.some((p) => (tx.projectId || '') === p.folderId));
      if (strayGroups.length || strayLoose.length) {
        out.push(`<div class="rp-store-project">
          <div class="rp-store-phead">${esc(t('panel.proj.outside'))}</div>
          ${strayGroups.map((g) => groupHtml(g.name, g.texts)).join('')}
          ${groupHtml(t('panel.store.unassignedGroup'), strayLoose)}</div>`);
      }
      return out.join('');
    };

    const groupHtml = (name, texts) => {
      if (!texts.length) return '';
      const sum = texts.reduce((a, x) => a + x.bytes, 0);
      return `<div class="rp-store-group">
        <div class="rp-store-ghead">${esc(name)} <span class="note">${esc(gb(sum))} · ${esc(t('panel.store.nTexts', { n: texts.length }))}</span></div>
        ${texts.map(row).join('')}</div>`;
    };

    const trashed = estate.trashed || { n: 0, bytes: 0 };
    body.innerHTML = `
      <div class="rp-store-quota"><div class="rp-store-bar"><span style="width:${pct}%"></span></div>
        <div class="note">${esc(quotaLine)}</div></div>
      ${trashed.n ? `<div class="rp-store-trash">
        <div><div>${esc(t('panel.store.trashHeld', { size: gb(trashed.bytes), n: trashed.n }))}</div>
        <div class="note">${esc(t('panel.store.trashWhy'))}</div></div>
        <button class="secondary-btn" data-storepurge>${esc(t('panel.store.reclaim'))}</button></div>` : ''}
      ${storeByProject(estate, groups, loose, groupHtml)}
      ${(estate.texts || []).length ? '' : `<p class="note">${esc(t('panel.store.empty'))}</p>`}
      <div class="rp-store-snap">
        <button class="link-btn" data-storesnap>${esc(t('panel.store.snapshot'))}</button>
        <p class="note">${esc(t('panel.store.snapshotNote'))}</p>
      </div>`;

    /* THE PRE-MIGRATION SNAPSHOT (plans/drive-as-truth.md §17.0).
     *
     * ⚠ An endpoint nobody can reach does not get taken, and this is the one recovery artefact that
     * CANNOT be produced after the fact — Drive does not version folder parentage, so once a folder
     * has moved nothing records where it was. It lives here, in the Drive management view, because
     * that is where someone already is when they are about to change the estate.
     *
     * Saves the RAW listing, not the grouped estate: if the grouping logic is what turns out to be
     * wrong, a snapshot shaped by it preserves the same mistake. */
    const snapBtn = body.querySelector('[data-storesnap]');
    if (snapBtn) snapBtn.addEventListener('click', () => busy(snapBtn, async () => {
      try {
        const snap = await Researcher.driveSnapshot();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `flextext-drive-snapshot-${stamp}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        deps.toast(t('panel.store.snapshotSaved', { n: (snap.counts && snap.counts.live) || 0 }), 6000);
      } catch (err) { errToast(err); }
    }));

    wireDownloadMenus(body);
    body.querySelectorAll('[data-storedel]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      if (!await confirmModal(t('panel.store.deleteConfirm', { title: b.dataset.title || '?' }))) return;
      try {
        await Researcher.trashFiles([b.dataset.storedel], 'drive storage manager');
        deps.toast(t('panel.store.deleted'), 5000);
        await load();
      } catch (e) { errToast(e); }
    })));
    const purge = body.querySelector('[data-storepurge]');
    if (purge) purge.addEventListener('click', () => busy(purge, async () => {
      if (!await confirmModal(t('panel.store.reclaimConfirm', { size: gb(trashed.bytes), n: trashed.n }))) return;
      try {
        /* The worker deletes a BOUNDED batch per request (subrequest cap — see drive-purge), so a
         * large backlog needs several passes. Loop until it reports nothing remaining, with a hard
         * stop so a worker that always answered `remaining` could never spin forever. */
        let deleted = 0, bytes = 0;
        for (let pass = 0; pass < 25; pass++) {
          const r = await Researcher.drivePurge();
          deleted += r.deleted || 0; bytes += r.bytes || 0;
          if (!r.remaining) break;
          purge.textContent = t('panel.store.reclaiming', { n: r.remaining });
        }
        deps.toast(t('panel.store.reclaimed', { size: gb(bytes), n: deleted }), 6000);
        await load();
      } catch (e) { errToast(e); }
    }));
  };

  const load = async () => {
    try { estate = await Researcher.driveEstate(); paint(); }
    catch (e) { body.innerHTML = `<p class="note rp-adm-err">${esc(String(e.message || e))}</p>`; }
  };
  load();
}

// Any instance id will do for the Files ▾ control: it routes by DOC id through the worker, and the
// worker resolves the text folder from the docId tag rather than from the instance.
function firstInstanceId() {
  const it = ((lastData && lastData.instances) || [])[0];
  return (it && it.instance_id) || '';
}

function historyModal() {
  const all = loadHistory(Researcher.currentAccountId());
  let filter = 'all';

  const rowsHtml = () => {
    const list = all.filter((e) => filter === 'all' || e.kind === filter).slice().reverse();   // newest first
    if (!list.length) {
      return `<p class="note rp-hist-empty">${esc(t(all.length ? 'panel.hist.emptyFilter' : 'panel.hist.empty'))}</p>`;
    }
    return `<ul class="rp-hist">${list.map((e) => {
      // SECURITY: kind lands in a class attribute and every other value comes from a field
      // device's own report — allow-list the kind, esc() the rest, and build links only from a
      // Drive-shaped id (history.js/driveLink). Same reasoning as the uploadState allow-list.
      const kind = HISTORY_KINDS.includes(e.kind) ? e.kind : 'assigned';
      const audio = /^https?:\/\//.test(e.audioUrl || '') ? e.audioUrl : '';
      const up = driveLink(e.fileId);
      const by = kind === 'deleted' && e.by === 'researcher' ? ' ' + t('panel.hist.byResearcher')
               : kind === 'deleted' ? ' ' + t('panel.hist.byDevice') : '';
      return `<li class="rp-hist-row rp-hist-${kind}">
        <div class="rp-hist-head">
          <span class="rp-tag rp-hist-k rp-hist-k-${kind}">${esc(t('panel.hist.kind.' + kind))}</span>
          <span class="rp-hist-title">${esc(e.title || t('panel.hist.untitled'))}</span>
        </div>
        <div class="note rp-hist-meta">${esc(histWhen(e.at))}${e.device ? ' · ' + esc(e.device) : ''}${esc(by)}</div>
        <div class="rp-hist-links">
          ${e.instanceId && e.docId ? filesMenuHtml(e.instanceId, e.docId, e.title || '', e.audioUrl, e.fileId) : ''}
          ${kind === 'deleted' && e.instanceId && e.docId ? `<button class="link-btn rp-revoke rp-histclean" data-histclean data-i="${esc(e.instanceId)}" data-id="${esc(e.docId)}" data-title="${esc(e.title || '')}">${esc(t('panel.hist.removeFolder'))}</button>` : ''}
          ${/* ⚠ `!hasMenu`, NOT `!(instanceId && docId)`. These plain links predate the Files menu and
                were suppressed only because the menu SUPERSEDED them — so with the menu hidden
                (FILES_MENU_ENABLED === false) that same condition would leave a History row with no
                link at all, silently removing more than the drop-down. Tied to the flag, hiding the
                menu restores exactly the pre-menu behaviour and nothing else. */''}
          ${audio && !histHasMenu(e) ? `<a href="${esc(audio)}" target="_blank" rel="noopener noreferrer">${esc(t('panel.hist.audioLink'))}</a>` : ''}
          ${up && !histHasMenu(e) ? `<a href="${esc(up)}" target="_blank" rel="noopener noreferrer">${esc(t('panel.hist.uploadLink'))}</a>` : ''}
        </div>
      </li>`;
    }).join('')}</ul>`;
  };

  // ⚠ Say plainly WHEN observation began. Anything deleted before that is unrecordable — the text
  // was already gone, so there was nothing to notice disappearing. Without this line the log just
  // looks broken, which is exactly how it looked after a delete that happened while the browser was
  // still serving a pre-v126 engine.
  const since = recordingSince(Researcher.currentAccountId());
  const sinceLine = since
    ? `<p class="note rp-hist-since">${esc(t('panel.hist.since', { when: histWhen(since) }))}</p>`
    : `<p class="note rp-hist-since">${esc(t('panel.hist.sinceNone'))}</p>`;

  const m = modal(`
    <h3>${esc(t('panel.hist.title'))}</h3>
    <p class="note">${esc(t('panel.hist.intro'))}</p>
    ${sinceLine}
    <div class="rp-hist-filters">
      <button class="link-btn rp-hist-f is-on" data-f="all">${esc(t('panel.hist.all'))}</button>
      ${HISTORY_KINDS.map((k) => `<button class="link-btn rp-hist-f" data-f="${k}">${esc(t('panel.hist.kind.' + k))}</button>`).join('')}
    </div>
    <div id="rp-hist-list">${rowsHtml()}</div>
    <hr class="rp-sep">
    <button class="link-btn rp-danger" data-m="clear">${esc(t('panel.hist.clear'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);

  const repaint = () => { m.el.querySelector('#rp-hist-list').innerHTML = rowsHtml(); wireDownloadMenus(m.el); };
  wireDownloadMenus(m.el);
  m.el.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    m.el.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('is-on', x === b));
    repaint();
  }));
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="clear"]').onclick = async () => {
    // Typed-confirm-free but still explicit: this is the researcher's own local log, not field
    // data, and it is re-derivable for nothing that is still on a device — but the tombstones
    // ARE unrecoverable, so say that in the prompt rather than a generic "are you sure".
    if (!await confirmModal(t('panel.hist.confirmClear'))) return;
    clearHistory(Researcher.currentAccountId());
    all.length = 0;
    repaint();
  };
}

/* ---------------- Utilities: audio converter + FLEx writing-systems checker ----------------
 * Surfaced in the panel as modals; both reuse the SAME engine the editor's Settings tab uses
 * (convertAudio / surveyWritingSystems / remapWritingSystems). All runs locally in the browser. */

function utilitiesModal() {
  const m = modal(`
    <h3>${esc(t('panel.util.title'))}</h3>
    <p class="note">${esc(t('panel.util.intro'))}</p>
    <button class="primary-btn" data-m="audio">${esc(t('panel.util.audio'))}</button>
    <button class="primary-btn" data-m="ws">${esc(t('panel.util.ws'))}</button>
    <button class="primary-btn" data-m="export">${esc(t('exp.h'))}</button>
    <hr class="rp-sep">
    <p class="note"><b>${esc(t('panel.util.apps'))}</b> — ${esc(t('panel.util.appsNote'))}</p>
    ${companionApps().map((a) => `<a class="secondary-btn rp-app-link" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(t(a.label))} ↗</a>`).join('')}
    <hr class="rp-sep">
    <label class="rp-field"><span>${esc(t('panel.util.ttl'))}</span>
      <input id="rp-ttl" type="number" min="7" max="400" step="1" value="${assignTtlDays()}"></label>
    <p class="note">${esc(t('panel.util.ttlNote'))}</p>
    <hr class="rp-sep">
    <button class="link-btn rp-danger" data-m="erase">${esc(t('panel.erase.btn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="audio"]').onclick = () => { m.close(); audioConverterModal(); };
  m.el.querySelector('[data-m="ws"]').onclick = () => { m.close(); wsCheckModal(); };
  m.el.querySelector('[data-m="export"]').onclick = () => { m.close(); fileExporterModal(); };
  m.el.querySelector('[data-m="erase"]').onclick = () => { m.close(); eraseDataModal(); };
  // Delivery-TTL preference: stored per account; the WORKER's clamp (7–400) is authoritative, this
  // input's min/max is only a courtesy mirror of it.
  m.el.querySelector('#rp-ttl').addEventListener('change', async (e) => {
    const v = parseInt(e.target.value, 10);
    if (!(Number.isFinite(v) && v > 0)) return;
    /* ⚠ The write is a server round trip now, so the confirmation has to wait for it. Toasting
     * "saved" before the PUT lands would claim an account-wide change that may not have happened,
     * and the researcher's other browser would still be on the old value with nothing to show. On
     * failure the field is put back, so the screen never disagrees with the account. */
    try { await setAssignTtlDays(v); deps.toast(t('panel.util.ttlSaved'), 3000); }
    catch (err) { e.target.value = String(assignTtlDays()); errToast(err); }
  });
}

// Complete local wipe of THIS browser → a blank, no-PWA-installed slate (testing + privacy). Behind a
// typed confirm so a reflex tap can't trigger it. Local only — does NOT touch the server (that's the
// separate "delete account" action). Reuses the engine's eraseAllData (injected via deps).
function eraseDataModal(after) {
  const m = modal(`
    <h3>${esc(t('panel.erase.title'))}</h3>
    <p class="note">${esc(t('panel.erase.what'))}</p>
    <p class="banner warn-banner">${esc(t('panel.erase.scope'))}</p>
    <label class="rp-field"><span>${esc(t('panel.erase.typeLabel', { word: t('panel.erase.word') }))}</span>
      <input id="erase-confirm" spellcheck="false" autocomplete="off" autocapitalize="characters"></label>
    <button class="primary-btn rp-danger" data-m="go" disabled>${esc(t('panel.erase.btn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const input = m.el.querySelector('#erase-confirm');
  const go = m.el.querySelector('[data-m="go"]');
  const word = t('panel.erase.word');
  input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== word.toUpperCase(); });
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  go.onclick = async () => {
    go.disabled = true; go.textContent = t('panel.erase.working');
    try { if (typeof after === 'function') await after(); } catch (e) { errToast(e); go.disabled = false; go.textContent = t('panel.erase.btn'); return; }
    // eraseAllData wipes everything then reloads to a blank slate — if control returns, surface the error.
    try { await deps.eraseAllData(); } catch (e) { errToast(e); go.disabled = false; go.textContent = t('panel.erase.btn'); }
  };
}

// SEPARATE, server-side account deletion (reached from the erase-offline flow). Permanently deletes the
// researcher account + ALL its instances/installs/invites from the server, THEN erases this device. Behind
// its own type-DELETE confirm (distinct from the local ERASE word). ORDER is load-bearing: the SERVER
// delete runs FIRST while still authed, because the local wipe destroys the session token it needs.
function deleteAccountModal() {
  const m = modal(`
    <h3>${esc(t('panel.delacct.title'))}</h3>
    <p class="note">${esc(t('panel.delacct.what'))}</p>
    <p class="banner warn-banner">${esc(t('panel.delacct.warn'))}</p>
    <label class="rp-field"><span>${esc(t('panel.delacct.typeLabel', { word: t('panel.delacct.word') }))}</span>
      <input id="delacct-confirm" spellcheck="false" autocomplete="off" autocapitalize="characters"></label>
    <button class="primary-btn rp-danger" data-m="go" disabled>${esc(t('panel.delacct.btn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const input = m.el.querySelector('#delacct-confirm');
  const go = m.el.querySelector('[data-m="go"]');
  const word = t('panel.delacct.word');
  input.addEventListener('input', () => { go.disabled = input.value.trim().toUpperCase() !== word.toUpperCase(); });
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  go.onclick = async () => {
    go.disabled = true; go.textContent = t('panel.delacct.working');
    // 1) delete the SERVER account while still authed.
    try { await Researcher.deleteAccount(); }
    catch (e) {
      // 401/404 = the row is ALREADY gone (a prior attempt committed but its response was lost in transit)
      // → treat as deleted and fall through to the wipe, so a manual retry can't get stuck insisting it
      // "failed" on a dead session. Any other error (offline / 5xx — account still there) → surface + retry.
      if (!(e && (e.status === 401 || e.status === 404))) { errToast(e); go.disabled = false; go.textContent = t('panel.delacct.btn'); return; }
    }
    deps.toast(t('panel.delacct.done'), 6000);
    // 2) Completely wipe THIS device back to a blank slate (the warning copy makes the full scope explicit
    // + this is behind a type-DELETE gate). eraseAllData reloads itself; force a reload too in case it
    // returns, so the user is never left on a frozen modal. (OTHER researcher devices wipe only their
    // console data on their next 401 via purgeLocal — safe, since a 401 isn't always an account delete.
    // Linked FIELD devices keep their texts and just unlink via the 410 path on their next poll.)
    try { await deps.eraseAllData(); } catch { /* noop */ }
    try { location.replace(location.pathname); } catch { /* noop */ }
  };
}

// REMOTE WIPE of a device no longer in trusted hands. Typed device-name confirm (strong "are you sure?"). If the
// researcher has 2FA, the worker answers the first attempt with 401 totp_required → we reveal a code field
// and retry (step-up auth on this destructive, remote, irreversible action). The wipe is delivered to the
// device on its NEXT connection, so the copy says so honestly.
function wipeConfirmModal(instanceId, installId, name) {
  let totpShown = false;
  const m = modal(`
    <h3>${esc(t('panel.wipe.title'))}</h3>
    <p class="note">${esc(t('panel.wipe.what'))}</p>
    <p class="banner warn-banner">${esc(t('panel.wipe.warn'))}</p>
    <label class="rp-field"><span>${esc(t('panel.wipe.typeLabel', { name: name || 'WIPE' }))}</span>
      <input id="wipe-confirm" spellcheck="false" autocomplete="off"></label>
    <div id="wipe-totp" hidden><label class="rp-field"><span>${esc(t('panel.wipe.totpLabel'))}</span>
      <input id="wipe-totp-code" inputmode="numeric" autocomplete="off" spellcheck="false"></label></div>
    <button class="primary-btn rp-danger" data-m="go" disabled>${esc(t('panel.wipe.btn'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const input = m.el.querySelector('#wipe-confirm');
  const go = m.el.querySelector('[data-m="go"]');
  const want = (name || 'WIPE').trim().toLowerCase();
  input.addEventListener('input', () => { go.disabled = input.value.trim().toLowerCase() !== want; });
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  go.onclick = async () => {
    const code = totpShown ? m.el.querySelector('#wipe-totp-code').value.trim() : undefined;
    go.disabled = true; go.textContent = t('panel.wipe.working');
    try {
      await Researcher.wipeInstall(instanceId, installId, code);
      m.close(); deps.toast(t('panel.wipe.sent'), 6000); renderDashboard();
    } catch (e) {
      if (e && e.status === 401 && e.data && e.data.error === 'totp_required' && !totpShown) {
        totpShown = true; m.el.querySelector('#wipe-totp').hidden = false;
        deps.toast(t('panel.wipe.needTotp'), 6000);
        go.textContent = t('panel.wipe.btn'); go.disabled = false; return;   // name already matched → re-enable for the code
      }
      errToast(e); go.disabled = false; go.textContent = t('panel.wipe.btn');
    }
  };
}

// Recording-format help — reuses the editor's trusted recfmt.* i18n HTML (incl. the archive-acceptance table).
function recfmtHelpModal() {
  const ps = ['recfmt.helpKeep', 'recfmt.helpRaw', 'recfmt.helpProcessing', 'recfmt.helpBits', 'recfmt.helpWavFlac',
    'recfmt.helpMono', 'recfmt.helpRate', 'recfmt.helpMp3', 'recfmt.helpWebm', 'recfmt.helpArchives'];
  const body = ps.map((k) => `<p>${t(k)}</p>`).join('') + `<div>${t('recfmt.helpTable')}</div><p>${t('recfmt.helpTech')}</p><p class="note">${t('recfmt.helpCourse')}</p>`;
  const m = modal(`<h3>${esc(t('recfmt.helpTitle'))}</h3><div class="help-body">${body}</div>
    <button class="primary-btn" data-m="close">${esc(t('recfmt.helpClose'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
}

// Map a label to a validOutputs() option value (en/id come from i18n; fall back to the raw value).
function cvFmtLabel(v) { const s = t('convert.fmt.' + v); return s === 'convert.fmt.' + v ? v : s; }

// A small WaveSurfer player (matches the baseline tab's look): a play/pause button + a waveform.
// split:true stacks one waveform PER CHANNEL, so a stereo file shows both — the user can see which
// channel carries the voice before choosing a mono mode. normalize is OFF when split so a near-silent
// channel reads as flat (honest) instead of being boosted to look like signal.
function cvMakePlayer(host, url, split) {
  host.innerHTML = `<button type="button" class="player-play cv-play" aria-label="${esc(t('convert.play'))}">▶</button><div class="cv-wave"></div>`;
  host.hidden = false;
  const ws = WaveSurfer.create({
    container: host.querySelector('.cv-wave'),
    url, height: split ? 38 : 54, normalize: !split,
    waveColor: '#9db4d4', progressColor: '#1f4f8f', cursorColor: '#c0392b', cursorWidth: 2,
    dragToSeek: true, splitChannels: split ? true : undefined,
  });
  const btn = host.querySelector('.cv-play');
  btn.onclick = () => { try { ws.playPause(); } catch { /* not ready */ } };
  ws.on('play', () => { btn.textContent = '⏸'; });
  ws.on('pause', () => { btn.textContent = '▶'; });
  ws.on('finish', () => { btn.textContent = '▶'; });
  ws.on('error', (e) => { console.warn('converter player:', e); });
  return ws;
}

function audioConverterModal() {
  let srcBuf = null, srcInfo = null, srcName = '', srcSize = 0;
  let srcWs = null, outWs = null, srcUrl = null, outUrl = null;
  const destroyPlayers = () => {
    for (const w of [srcWs, outWs]) { try { w && w.destroy(); } catch { /* noop */ } }
    for (const u of [srcUrl, outUrl]) { try { u && URL.revokeObjectURL(u); } catch { /* noop */ } }
    srcWs = outWs = srcUrl = outUrl = null;
  };
  const m = modal(`
    <h3>${esc(t('convert.h'))} <button class="rp-help-inline" data-m="help" aria-label="${esc(t('recfmt.helpLink'))}" title="${esc(t('recfmt.helpLink'))}">?</button></h3>
    <p class="note">${esc(t('convert.note2'))}</p>
    <button class="primary-btn" data-m="pick">${esc(t('convert.pick'))}</button>
    <input type="file" id="cv-file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg" hidden>
    <div id="cv-form" hidden>
      <p class="note rp-cv-src" id="cv-src"></p>
      <p class="note cv-cap" id="cv-before-cap" hidden>${esc(t('convert.before'))}</p>
      <div id="cv-src-player" class="cv-player" hidden></div>
      <p class="note cv-cap" id="cv-chan-hint" hidden>${esc(t('convert.chanHint'))}</p>
      <label class="rp-field"><span>${esc(t('convert.outFmt'))}</span><select id="cv-fmt"></select></label>
      <label class="rp-field" id="cv-mono-row"><span>${esc(t('convert.monoMode'))}</span>
        <select id="cv-mono">
          <option value="keep">${esc(t('convert.mono.keep'))}</option>
          <option value="auto" selected>${esc(t('convert.mono.auto'))}</option>
          <option value="mix">${esc(t('convert.mono.mix'))}</option>
          <option value="left">${esc(t('convert.mono.left'))}</option>
          <option value="right">${esc(t('convert.mono.right'))}</option>
        </select></label>
      <div id="cv-mp3opts">
        <label class="rp-field"><span>${esc(t('convert.kbps'))}</span>
          <select id="cv-kbps"><option value="32">32</option><option value="48">48</option><option value="64" selected>64</option><option value="96">96</option><option value="128">128</option></select></label>
        <label class="rp-field"><span>${esc(t('convert.rate'))}</span>
          <select id="cv-rate"><option value="16000">16000</option><option value="22050" selected>22050</option><option value="44100">44100</option></select></label>
      </div>
      <button class="primary-btn" data-m="go">${esc(t('convert.go'))}</button>
    </div>
    <p class="note" id="cv-status" hidden></p>
    <div id="cv-out-wrap" hidden>
      <p class="note cv-cap">${esc(t('convert.after'))}</p>
      <div id="cv-out-player" class="cv-player"></div>
    </div>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true, destroyPlayers);
  const $$ = (s) => m.el.querySelector(s);
  const status = $$('#cv-status'), form = $$('#cv-form'), fmtSel = $$('#cv-fmt'), monoRow = $$('#cv-mono-row'), mp3opts = $$('#cv-mp3opts');
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="help"]').onclick = recfmtHelpModal;
  m.el.querySelector('[data-m="pick"]').onclick = () => $$('#cv-file').click();

  const syncMp3Vis = () => {
    const o = (srcInfo && srcInfo.outs.find((x) => x.value === fmtSel.value)) || {};
    mp3opts.hidden = o.format !== 'mp3';
  };
  fmtSel.addEventListener('change', syncMp3Vis);

  const setStereoUi = (stereo) => { monoRow.hidden = !stereo; $$('#cv-chan-hint').hidden = !stereo; };

  $$('#cv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    destroyPlayers();                                           // tear down any previous file's players
    $$('#cv-out-wrap').hidden = true; status.hidden = true;
    srcName = file.name; srcSize = file.size;
    try { srcBuf = await file.arrayBuffer(); } catch (err) { status.hidden = false; status.textContent = t('convert.failed', { msg: err.message }); return; }
    const fmt = detectFormat(srcBuf);
    let bits = null, chans = null, rate = null;
    if (fmt === 'wav') { const h = readWavHeader(srcBuf); if (h) { bits = h.bitsPerSample; chans = h.channels; rate = h.sampleRate; } }
    const outs = validOutputs(fmt, bits);
    srcInfo = { fmt, bits, chans, outs };
    // Source summary line (what we cheaply know). esc'd — file metadata is untrusted.
    const parts = [fmt ? fmt.toUpperCase() : t('convert.fmtUnknown')];
    if (bits) parts.push(t('convert.bit', { n: bits }));
    if (chans) parts.push(chans >= 2 ? t('convert.stereo') : t('convert.monoSrc'));
    if (rate) parts.push(rate + ' Hz');
    parts.push(fmtSize(srcSize));
    $$('#cv-src').textContent = t('convert.src', { name: srcName, detail: parts.join(' · ') });
    fmtSel.innerHTML = outs.map((o) => `<option value="${esc(o.value)}">${esc(cvFmtLabel(o.value))}</option>`).join('');
    setStereoUi(chans == null || chans >= 2);   // assume stereo until the decoded channel count says otherwise
    $$('#cv-before-cap').hidden = false;
    form.hidden = false; syncMp3Vis();
    // "Before" player: per-channel waveforms + playback. The decoded channel count is the authority
    // (covers non-WAV sources we can't header-sniff) — refine the mono controls once it's ready.
    srcUrl = URL.createObjectURL(file);
    srcWs = cvMakePlayer($$('#cv-src-player'), srcUrl, true);
    srcWs.on('ready', () => {
      let nch = chans || 1; try { const d = srcWs.getDecodedData(); if (d) nch = d.numberOfChannels; } catch { /* noop */ }
      setStereoUi(nch >= 2);
    });
  });

  m.el.querySelector('[data-m="go"]').onclick = async () => {
    if (!srcBuf || !srcInfo) return;
    const o = srcInfo.outs.find((x) => x.value === fmtSel.value); if (!o) return;
    const opts = { format: o.format, mono: monoRow.hidden ? 'keep' : $$('#cv-mono').value };
    if (o.format === 'wav') opts.wavBits = o.wavBits;
    if (o.format === 'flac') opts.flacBits = o.flacBits;
    if (o.format === 'mp3') { opts.kbps = parseInt($$('#cv-kbps').value, 10); opts.sampleRate = parseInt($$('#cv-rate').value, 10); }
    status.hidden = false; status.textContent = t('convert.working', { pct: 0 });
    try {
      const res = await convertAudio(srcBuf, opts, (f) => { status.textContent = t('convert.working', { pct: Math.round(f * 100) }); });
      // Marked derived for the same reason as the editor's copy — see the note there.
      const outName = srcName.replace(/\.[^.]+$/, '') + (res.derived ? '-converted' : '') + '.' + res.ext;
      const dlUrl = URL.createObjectURL(res.blob);
      const a = document.createElement('a'); a.href = dlUrl; a.download = outName; a.click();
      setTimeout(() => URL.revokeObjectURL(dlUrl), 30000);
      status.textContent = t('convert.done', { name: outName, out: fmtSize(res.blob.size), in: fmtSize(srcSize) });
      // "After" player on the converted result (its own object URL, released on re-convert / close).
      try { if (outWs) outWs.destroy(); } catch { /* noop */ }
      try { if (outUrl) URL.revokeObjectURL(outUrl); } catch { /* noop */ }
      outUrl = URL.createObjectURL(res.blob);
      $$('#cv-out-wrap').hidden = false;
      outWs = cvMakePlayer($$('#cv-out-player'), outUrl, false);
    } catch (err) { status.textContent = t('convert.failed', { msg: err.message }); }
  };
}

// FLEx writing-system-codes help — adapted from Seth's writing-system-codes doc (trusted i18n HTML) + the
// vern_writ_sys.png screenshot precached in the SW shell so it works offline.
function wsCodesHelpModal() {
  const m = modal(`<div class="rp-help wsc-help">${t('panel.wscodes.html')}</div>
    <button class="primary-btn" data-m="close">${esc(t('panel.help.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
}

function wsCheckModal() {
  let wsState = null;
  const m = modal(`
    <h3>${esc(t('panel.util.ws'))} <button class="rp-help-inline" data-m="help" aria-label="?" title="?">?</button></h3>
    <p class="note">${esc(t('panel.util.wsIntro'))}</p>
    <button class="primary-btn" data-m="pick">${esc(t('research.checkBtn'))}</button>
    <input type="file" id="wsc-file" accept=".flextext,.xml,.txt,text/plain,text/xml,application/xml" hidden>
    <div id="wsc-result" hidden>
      <p id="wsc-name" class="note"></p>
      <table class="ws-table"><thead><tr><th>${esc(t('ws.line'))}</th><th>${esc(t('ws.code'))}</th><th>${esc(t('ws.count'))}</th><th>${esc(t('ws.changeTo'))}</th></tr></thead><tbody id="wsc-rows"></tbody></table>
      <button class="primary-btn" data-m="apply">${esc(t('research.downloadCorrected'))}</button>
    </div>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="help"]').onclick = wsCodesHelpModal;
  m.el.querySelector('[data-m="pick"]').onclick = () => m.el.querySelector('#wsc-file').click();
  m.el.querySelector('#wsc-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    let res;
    try { res = surveyWritingSystems(await file.text()); } catch (err) { deps.toast(t('toast.importFailed', { msg: err.message }), 6000); return; }
    if (res.error) { deps.toast(t('toast.importFailed', { msg: res.error }), 6000); return; }
    wsState = { dom: res.dom, filename: file.name };
    m.el.querySelector('#wsc-name').textContent = t('research.declared', { name: file.name, list: res.declared.length ? res.declared.map((l) => `${l.lang}${l.vernacular ? ' ★' : ''}`).join(', ') : t('research.noneDeclared') });
    const tbody = m.el.querySelector('#wsc-rows'); tbody.innerHTML = '';
    for (const r of res.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td><code></code></td><td></td><td><input class="ws-newcode" spellcheck="false"></td>';
      tr.children[0].textContent = t(r.label);
      tr.children[1].firstChild.textContent = r.lang;   // textContent: lang codes from the file are attacker-controllable
      tr.children[2].textContent = r.count;
      const inp = tr.querySelector('input'); inp.placeholder = t('ws.keepPh'); inp.dataset.selector = r.selector; inp.dataset.fromLang = r.lang;
      tbody.appendChild(tr);
    }
    m.el.querySelector('#wsc-result').hidden = false;
  });
  m.el.querySelector('[data-m="apply"]').onclick = () => {
    if (!wsState) return;
    const mappings = Array.from(m.el.querySelectorAll('#wsc-rows .ws-newcode')).filter((i) => i.value.trim())
      .map((i) => ({ selector: i.dataset.selector, fromLang: i.dataset.fromLang, toLang: i.value.trim() }));
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n' + remapWritingSystems(wsState.dom, mappings).replace(/^<\?xml[^>]*\?>\s*/i, '');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    a.download = wsState.filename.replace(/(\.flextext|\.xml)?$/i, (mm) => mm || '.flextext'); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    deps.toast(mappings.length ? t('toast.corrected') : t('toast.noChanges'));
  };
}

/* ── MAKE FILES FROM A PICKED .flextext + ITS RECORDING (the panel's copy) ─────────────────────
 * Seth, 2026-08-14: "exactly the same thing that our files drop down box already does for texts
 * that are on Google Drive, except that the user can submit their own flextext and matching audio
 * file … a backup way to do it with files they just happen to have lying around that match."
 *
 * ⚠ THE DECISIONS ARE NOT DUPLICATED HERE. Which rows are possible, what each one builds, how it
 * degrades and what it is named all live in seg-exports.js (loosePlan / buildLooseConversion) —
 * the SAME two functions the editor's Utilities tab calls. Only the DOM differs, because the editor
 * has static markup and this is a built modal, and there is no shared UI layer to put a widget in.
 * If a behaviour needs changing, change it in seg-exports and both surfaces move together;
 * test/loose-conversions.test.mjs pins that against the Files ▾ menu's own want/full table. */
function fileExporterModal() {
  let st = { doc: null, ftBlob: null, ftName: '', audio: null, plan: null, base: 'text', busy: false };
  const m = modal(`
    <h3>${esc(t('exp.h'))}</h3>
    <p class="note">${esc(t('exp.note'))}</p>
    <button class="primary-btn" data-m="pickFt">${esc(t('exp.pickFt'))}</button>
    <button class="secondary-btn" data-m="pickAudio">${esc(t('exp.pickAudio'))}</button>
    <input type="file" id="xc-ft" accept=".flextext,.xml,text/xml,application/xml" hidden>
    <input type="file" id="xc-audio" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.webm,.flac,.3gp,.amr" hidden>
    <p class="note rp-cv-src" id="xc-src"></p>
    <p class="note rp-ex-msg rp-as-warn" id="xc-warn" hidden></p>
    <div id="xc-rows" class="rp-ex-rows" hidden></div>
    <p class="note rp-ex-msg" id="xc-status" role="status" hidden></p>
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  const q = (sel) => m.el.querySelector(sel);
  const srcEl = q('#xc-src'), warnEl = q('#xc-warn'), rowsEl = q('#xc-rows'), statusEl = q('#xc-status');

  const say = (msg, kind) => {
    statusEl.hidden = !msg;
    statusEl.textContent = msg || '';
    statusEl.className = 'note rp-ex-msg' + (kind ? ' rp-as-' + kind : '');
  };
  /* Reason CODES come back from the shared planner; the sentences live here, because seg-exports
   * has no i18n by rule. Same map as the editor's — one row, one explanation, both surfaces. */
  const why = (code) => ({
    noText: t('exp.no.text'), noAudio: t('exp.no.audio'), noAlign: t('panel.dl.noAlign'),
    badAlign: t('exp.no.badAlign'), tooBig: t('panel.dl.previewTooBig', { size: fmtSize(st.plan?.caps?.est || 0) }),
  }[code] || '');

  q('[data-m="close"]').onclick = m.close;
  q('[data-m="pickFt"]').onclick = () => q('#xc-ft').click();
  q('[data-m="pickAudio"]').onclick = () => q('#xc-audio').click();

  q('#xc-ft').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    rowsEl.hidden = true; rowsEl.innerHTML = ''; warnEl.hidden = true; say('');
    let xml = '';
    try { xml = await f.text(); } catch { say(t('exp.readFailed'), 'err'); return; }
    const parsed = parseFlextext(xml);
    if (parsed.error || !parsed.texts.length) { say(t('task.ftParseFailed', { msg: parsed.error || t('task.ftNone') }), 'err'); return; }
    const doc = parsed.texts[0];
    // Times come from the FILE. segmentsFromOffsets returns null (not []) when nothing carries them.
    doc.segments = segmentsFromOffsets(doc) || [];
    st.doc = doc; st.ftBlob = f; st.ftName = f.name;      // the blob is passed through byte-for-byte
    st.base = sanitizeBase(doc.title || f.name.replace(/\.[^.]+$/, '')) || 'text';
    if (parsed.texts.length > 1) say(t('exp.multiText', { n: parsed.texts.length }), 'warn');
    render();
  });

  q('#xc-audio').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    st.audio = { blob: f, name: f.name, mimeType: f.type || 'application/octet-stream', size: f.size, durationMs: 0 };
    /* ⚠ DO THE TWO FILES BELONG TOGETHER? (Seth: "check to make sure the duration matches".) Free
     * for a WAV — readWavHeader gives frames/rate off a 64 KB slice, no decode. A lossy source
     * cannot be measured without decoding it, so it stays 0 and durationVerdict says 'unknown'
     * rather than guessing at a pairing. */
    try {
      /* ⚠ An ArrayBuffer, NOT a Uint8Array — readWavHeader does `new DataView(buf)`, which throws on
       * a typed array, and the catch below would have swallowed it into a silent durationMs of 0.
       * That reads as "undecodable", so the pair check would have been permanently OFF while looking
       * implemented. 64 KB suffices: the data chunk's DECLARED size gives the frame count. */
      const h = readWavHeader(await f.slice(0, 65536).arrayBuffer());
      if (h && h.sampleRate && h.frames) st.audio.durationMs = Math.round((h.frames / h.sampleRate) * 1000);
    } catch { /* not a WAV, or unreadable — 'unknown' is the honest answer */ }
    render();
  });

  function render() {
    if (!st.doc) return;
    const a = st.audio;
    const isWav = !!a && (/\.wav$/i.test(a.name) || /wav$/i.test(a.mimeType || ''));
    st.plan = loosePlan({ doc: st.doc, hasAudio: !!a, audioBytes: a ? a.size : 0, isWav });
    srcEl.textContent = t('exp.src', {
      ft: st.ftName, lines: st.plan.rows, aligned: st.plan.alignedRows,
      audio: a ? `${a.name} (${fmtSize(a.size)})` : t('exp.noAudioYet'),
    });
    /* Prominent, never blocking — and audioUnaligned WINS the shared line. NOT mutually exclusive:
     * a badAlign text has aligned rows, so spanEnd > 0 and the duration verdict can read 'short'
     * simultaneously — off offsets that are themselves the unusable part. Same fix as app.js. */
    const verdict = a ? durationVerdict({ spanEndMs: st.plan.spanEnd, durationMs: a.durationMs }) : 'unknown';
    warnEl.hidden = !(verdict === 'short' || st.plan.audioUnaligned);
    if (st.plan.audioUnaligned) warnEl.textContent = t('exp.noAlignAudio');
    else if (verdict === 'short') warnEl.textContent = t('exp.mismatch', { text: clockMs(st.plan.spanEnd), audio: clockMs(a.durationMs) });
    rowsEl.hidden = false;
    rowsEl.innerHTML = '';
    for (const kind of ['elan', 'saymore', 'preview', 'fxpa', 'flextext']) {
      const p = st.plan[kind];
      /* Listening page when the recording embeds; text-only Interlinear page otherwise. ⚠ p.ok
       * gates the rename — a tooBig REFUSAL refuses the LISTENING flavor and must keep its name
       * (an "Interlinear page" refused for audio size contradicts itself). Same fix as app.js. */
      const rowKey = kind === 'preview' && p.ok && !st.plan.previewEmbed ? 'previewText' : kind;
      const row = document.createElement('div');
      row.className = 'rp-dl-item' + (p.ok ? '' : ' rp-dl-pending');
      row.innerHTML = '<span class="rp-dl-name"></span><span class="rp-dl-sub"></span>';
      row.querySelector('.rp-dl-name').textContent = t('exp.row.' + rowKey);
      row.querySelector('.rp-dl-sub').textContent = p.ok ? t('exp.sub.' + rowKey) : why(p.reason);
      if (p.ok) {
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        const go = () => build(kind);
        row.addEventListener('click', go);
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      } else row.setAttribute('aria-disabled', 'true');
      rowsEl.appendChild(row);
    }
  }

  async function build(kind) {
    if (st.busy) { say(t('panel.dl.oneAtATime'), 'warn'); return; }
    st.busy = true;
    say(t('panel.dl.working'));
    try {
      const r = await buildLooseConversion({
        kind, doc: st.doc, base: st.base, title: st.doc.title || st.base,
        producedBy: deps.producedBy ? deps.producedBy() : '',
        flextextBlob: st.ftBlob, audio: st.audio, plan: st.plan,
        vern: st.doc.vernLang || 'und', anal: st.doc.analLang || 'en',
        // The impure step seg-exports refuses to own — see its header.
        convertWav: async (blob) => (await convertAudio(await blob.arrayBuffer(), { format: 'wav', wavBits: 16 })).blob,
        onPhase: (ph) => say(t('exp.phase.' + ph)),
      });
      if (!r.entries.length) { say(t('panel.dl.zipFailed'), 'err'); return; }
      const out = r.zip ? await makeZip(r.entries) : r.entries[0].data;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(out);
      a.download = r.saveName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      const notes = (r.notes || []).map((n) => ({
        lossyTiming: t('panel.dl.lossyTiming'), fxpaNoAudio: t('panel.dl.fxpaNoAudioSub'),
        eafNoMedia: t('exp.eafNoMedia'), previewNoAudio: t('exp.noAlignAudio'),
      }[n])).filter(Boolean);
      say(t('exp.done', { name: r.saveName }) + (notes.length ? ' ' + notes.join(' ') : ''), 'ok');
    } catch (e) {
      console.warn('[flextext] loose-file conversion failed:', e);
      say(e && e.code === 'ZIP_TOO_LARGE' ? t('panel.dl.zipTooLarge') : t('panel.dl.zipFailed'), 'err');
    } finally { st.busy = false; }
  }
}

// mm:ss for a duration — the pair-mismatch warning only (mirrors app.js fmtClockMs).
function clockMs(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------- coworkers on a project (Phase D — the sharing surface) ----------------
 *
 * Owner-side membership management for the D1 `project` boundary: who else may help look after this
 * project's DEVICES. Backed entirely by routes that already exist (`GET /v1/projects`,
 * `GET|POST|DELETE /v1/projects/<id>/members`), so this ships with no worker change and no deploy.
 *
 * ⚠ THE D1 PROJECT IS NOT THE DRIVE PROJECT FOLDER the dashboard tabs already show. Those are keyed
 * by folder id and come from the estate; this is keyed by `project_id` and is the authorization
 * boundary. They correspond one-to-one after migration, and `drive_folder_id` is what links them —
 * which is also why the worker refuses to share a project that has none (`not_migrated`).
 *
 * ⚠ THE DRIVE CAPABILITY IS ABSENT, NOT DISABLED (handoff §8). `assignTexts` and `drive` are refused
 * by the worker's `validateCaps` — a checkbox for them would either 400 the whole grant or, worse,
 * read as a promise that files can be shared. What ships is exactly what the worker will honour:
 * `manageDevices` and `createInvites`, both plain booleans. If a key is ever added here that
 * validateCaps does not accept, EVERY add fails with `bad_caps` — the allowlist is strict on purpose.
 *
 * ⚠ WHAT A MEMBER CANNOT YET SEE. Their own dashboard still lists devices with
 * `WHERE researcher_id=?` (the owner), so a coworker added here can be authorized for a device and
 * still see an empty device list in their panel until that read is project-scoped. This UI is the
 * owner's half; it is honest about the grant it makes, and the member-side view is the next step. */
async function coworkersModal() {
  const m = modal(`<h3>${esc(t('panel.share.title'))}</h3>
    <p class="note">${esc(t('panel.share.intro'))}</p>
    <div id="rp-share-body">${loadingHtml('panel.share.loading', true)}</div>
    <hr class="rp-sep">
    <button class="link-btn" data-m="close">${esc(t('panel.util.close'))}</button>`, true);
  m.el.querySelector('[data-m="close"]').onclick = m.close;

  const body = m.el.querySelector('#rp-share-body');
  let owned = [];
  let selected = '';
  /* ⚠ A message that must OUTLIVE a repaint. The add flow reports its outcome and then repaints the
   * member list — but the say() element lives inside the repainted body, so an inline warning shown
   * before paint() was destroyed by it (browser-verified on the rig: the no-estate warning never
   * appeared, the one state where the owner most needs telling). paint() re-shows this at its end. */
  let notice = null;

  /* The worker's own error names, turned into sentences that say what to DO. Anything unrecognised
   * falls through to the raw message rather than a generic apology — a message nobody can act on is
   * worse than an ugly one. */
  const sayErr = (err) => {
    const k = (err && err.message) || '';
    if (k === 'no_such_researcher') return t('panel.share.errNoSuch');
    if (k === 'not_migrated') return t('panel.share.errNotMigrated');
    if (k === 'owner_is_not_a_member') return t('panel.share.errSelf');
    if (k === 'bad_caps' || k === 'bad_body') return t('panel.share.errCaps');
    return String(k || err);
  };

  const capWords = (caps) => {
    const out = [];
    if (caps && caps.manageDevices) out.push(t('panel.share.capManage'));
    if (caps && caps.createInvites) out.push(t('panel.share.capInvite'));
    if (caps && caps.assignTexts) out.push(t('panel.share.capAssign'));
    if (caps && caps.drive) out.push(t('panel.share.capDrive'));
    return out.length ? out.join(', ') : t('panel.share.capNone');
  };

  async function paint() {
    const proj = owned.find((p) => p.project_id === selected) || null;
    if (!proj) { body.innerHTML = `<p class="note">${esc(t('panel.share.noProjects'))}</p>`; return; }
    /* Only render the picker when there is a choice to make: one project is every account on day
     * one, and a select with a single option is a control that cannot do anything. */
    const picker = owned.length > 1
      ? `<label class="rp-field"><span>${esc(t('panel.share.project'))}</span>
           <select id="rp-share-proj">${owned.map((p) =>
             `<option value="${esc(p.project_id)}"${p.project_id === selected ? ' selected' : ''}>${esc(p.name || p.project_id)}</option>`).join('')}</select></label>`
      : `<div class="rp-field"><span>${esc(t('panel.share.project'))}</span>
           <div class="rp-readonly">${esc(proj.name || proj.project_id)}</div></div>`;

    let members = null, listErr = null;
    try { members = (await Researcher.listMembers(selected)).members || []; }
    catch (e) { listErr = e; }
    // Nicknames are the ONLY thing naming a coworker now, so they must be in hand before the first
    // paint — otherwise every row renders "Unnamed" and then flickers once the prefs decrypt.
    await loadNicks();

    body.innerHTML = `${picker}
      ${listErr ? `<p class="note rp-adm-err">${esc(sayErr(listErr))}</p>` : `
      <div class="rp-share-list">${members.length ? members.map((x, i) => `
        <div class="rp-install rp-share-row" data-mrow="${i}">
          ${/* ⚠⚠ NO NAME, NO EMAIL, NO AVATAR (Seth, 2026-08-28). The worker no longer sends them and
              this no longer asks for them: what the panel HOLDS on a lost device is the question, and
              a collaborator directory is the wrong answer. A coworker is identified here by the ID
              they gave you plus a NICKNAME YOU TYPE — kept in your own Kr-encrypted prefs, never sent
              to the server, so it names them to you and to nobody else.
              ⚠ An older worker still returns the identity fields; they are simply never read. */''}
          <div class="invite-who">
            <div><div class="invite-name">${esc(memberNick(x.researcher_id) || t('panel.share.unnamed'))}
              <button class="link-btn rp-nick-edit" data-sact="nick" data-rid="${esc(x.researcher_id)}">${esc(t(memberNick(x.researcher_id) ? 'panel.share.nickEdit' : 'panel.share.nickAdd'))}</button></div>
            <div class="note rp-rid-sm">${esc(x.researcher_id)}</div>
            <div class="note" data-mcaps="${i}">${x.invalid ? esc(t('panel.share.invalidCaps'))
                                          : esc(t('panel.share.memberCaps', { caps: capWords(x.caps) }))}${x.pubkey_set === false ? ' · ' + esc(t('panel.share.awaitingKey')) : ''}</div>
            <div class="rp-share-edit" data-medit="${i}" hidden>
              <label class="check-label"><input type="checkbox" data-mem="${i}" data-cap="manageDevices" ${x.caps && x.caps.manageDevices ? 'checked' : ''}> ${esc(t('panel.share.capManageLabel'))}</label>
              <label class="check-label"><input type="checkbox" data-mem="${i}" data-cap="createInvites" ${x.caps && x.caps.createInvites ? 'checked' : ''}> ${esc(t('panel.share.capInviteLabel'))}</label>
              <label class="check-label"><input type="checkbox" data-mem="${i}" data-cap="assignTexts" ${x.caps && x.caps.assignTexts ? 'checked' : ''}> ${esc(t('panel.share.capAssignLabel'))}</label>
              <label class="check-label"><input type="checkbox" data-mem="${i}" data-cap="drive" ${x.caps && x.caps.drive ? 'checked' : ''}> ${esc(t('panel.share.capDriveLabel'))}</label>
              <button class="secondary-btn" data-sact="editsave" data-rid="${esc(x.researcher_id)}" data-i="${i}">${esc(t('panel.share.editSave'))}</button>
            </div></div></div>
          <div class="rp-inst-actions">
            <button class="link-btn" data-sact="edit" data-i="${i}">${esc(t('panel.share.edit'))}</button>
            <button class="link-btn rp-revoke" data-sact="remove" data-rid="${esc(x.researcher_id)}">${esc(t('panel.share.remove'))}</button>
          </div>
        </div>`).join('') : `<p class="note">${esc(t('panel.share.none'))}</p>`}</div>`}
      <hr class="rp-sep">
      <div class="rp-adm-sec">
        <div class="rp-adm-h">${esc(t('panel.share.addTitle'))}</div>
        <label class="rp-field"><span>${esc(t('panel.share.idLabel'))}</span>
          <input id="rp-share-id" spellcheck="false" autocapitalize="off" placeholder="${esc(t('panel.share.idPh'))}"></label>
        ${/* ⚠ NAMED AT THE MOMENT OF ADDING, not in a later visit (Seth, 2026-08-28): "I'd like them
             to be able (and even required) to fill in the name when they paste the ID."
             Since v503 the server sends no name, email or avatar, so this nickname is the ONLY thing
             telling two coworkers apart. A field you must remember to go back for is one that stays
             empty — and an owner deciding which of two uuids to revoke months later is exactly the
             moment it matters. Required, therefore, and required HERE.
             ⚠ Local: it is written with setPref into the Kr-encrypted account prefs, never sent with
             the membership. The add call still carries only the ID and the capabilities. */''}
        <label class="rp-field"><span>${esc(t('panel.share.nickLabel'))}</span>
          <input id="rp-share-nick" maxlength="60" placeholder="${esc(t('panel.share.nickPh'))}"></label>
        <p class="note">${esc(t('panel.share.nickNote'))}</p>
        ${/* ⚠ NUMBERED STEPS, BOTH SIDES, because this is the least intuitive thing in the panel
             (Seth, 2026-08-28: "make sure to give instructions for how to add a colleague to a
             project as another researcher, because right now it's not very intuitive"). It is a
             manual exchange between two people through a channel this app knows nothing about, and
             the old single sentence described only the colleague's half.
             ⚠ STEP 5 changed with Phase 2b (2026-08-31): the WORKER writes the member's key grants
             inside the add itself, so there is no leave-the-panel-open ritual any more — the step
             now simply says the setup is immediate. (Historically the grants came from a sweep on
             the owner's next dashboard render, and closing too fast left the coworker keyless.) */''}
        <ol class="rp-steps note">
          <li>${esc(t('panel.share.step1'))}</li>
          <li>${esc(t('panel.share.step2'))}</li>
          <li>${esc(t('panel.share.step3'))}</li>
          <li>${esc(t('panel.share.step4'))}</li>
          <li>${esc(t('panel.share.step5'))}</li>
        </ol>
        <p class="note">${esc(t('panel.share.idNote'))}</p>
        ${/* ⚠ A FIELDSET, not an rp-field: `.rp-field input` styles a control as a TEXT BOX (border,
             padding, full width), which a checkbox inherits too — it renders as a stretched box with
             its label pushed away. rp-fieldset is the house idiom for a group of checkboxes. */''}
        <fieldset class="rp-fieldset">
          <legend>${esc(t('panel.share.capsLabel'))}</legend>
          ${/* ⚠ ALL FOUR CHECKED BY DEFAULT (Seth, 2026-08-28). Deliberately the opposite of the usual
               "grant nothing until asked": you invite a coworker in order to be HELPED, so the common
               case is full delegation, and an owner who wants less unticks what they do not want —
               which is a decision they can see, rather than four empty boxes whose consequences only
               show up later as a colleague reporting that nothing works.
               ⚠ WHAT "ALL" STILL DOES NOT INCLUDE, which is what makes this safe to default: no
               capability approves or keys a device, wipes one, deletes or re-parents anything in
               Drive, or grants Drive beyond read — the worker refuses drive:'manage' outright and
               DEFERRED_CAPS withholds cancelOthers. The ceiling is low enough that ticking everything
               is not the same shape of decision as an admin role. */''}
          <label class="check-label"><input type="checkbox" id="rp-share-manage" checked> ${esc(t('panel.share.capManageLabel'))}</label>
          <label class="check-label"><input type="checkbox" id="rp-share-invite" checked> ${esc(t('panel.share.capInviteLabel'))}</label>
          <label class="check-label"><input type="checkbox" id="rp-share-assign" checked> ${esc(t('panel.share.capAssignLabel'))}</label>
          <label class="check-label"><input type="checkbox" id="rp-share-drive" checked> ${esc(t('panel.share.capDriveLabel'))}</label>
        </fieldset>
        <p class="note">${esc(t('panel.share.driveNote'))}</p>
        ${/* The revocation-honesty rule moved UPSTREAM (project-split.md): the owner should learn what
             cannot be taken back BEFORE granting, not discover it while revoking. One box, plain
             language, both halves kept distinct — what is unrewindable (knowledge) and what is
             merely stoppable (actions). */''}
        <div class="warn-banner rp-share-warn">
          <div><strong>${esc(t('panel.share.warnTitle'))}</strong>
            <p class="note">${esc(t('panel.share.warnSee'))}</p>
            <p class="note">${esc(t('panel.share.warnDo'))}</p>
            <p class="note">${esc(t('panel.share.warnWhy'))}</p>
            ${/* ⚠ THE GOOGLE DRIVE REQUEST-ACCESS PHISH (Seth, 2026-08-28). Anyone holding a folder
                 id can send the owner a Drive "request access" email — from Google's own domain,
                 with an attacker-chosen display name and a free-text message. Approving it grants
                 real Drive access outside this app entirely, where none of our capabilities,
                 revocation or audit apply. The saving grace is that the correct answer is ALWAYS
                 no: sharing works through this panel, so a coworker never needs Drive permissions,
                 and every project folder should carry exactly one permission — the owner's. Said
                 HERE because adding a member is the moment a researcher starts expecting messages
                 about that person. */''}
            <p class="note">${esc(t('panel.share.warnDriveReq'))}</p>
            ${/* ⚠ THE OWNER IS THE BOTTLENECK FOR DEVICE APPROVAL, and they must learn it HERE
                 (Seth, 2026-08-28) — before they delegate, not when a coworker reports that a phone
                 they set up in a village does not work. A coworker can invite a device, but only
                 the owner can approve it and give it its key, because an opaque wrapped key from
                 anyone else could lock the owner out of their own device.
                 Stated plainly so the real decision is available: a team whose owner cannot be
                 bothered with approvals should make the OTHER person the project owner. */''}
            <p class="note">${esc(t('panel.share.warnApproval'))}</p></div>
        </div>
        <button class="primary-btn" id="rp-share-add">${esc(t('panel.share.addGo'))}</button>
        <div id="rp-share-say" class="rp-adm-say" hidden></div>
      </div>`;

    const say = (msg, bad) => {
      const el = body.querySelector('#rp-share-say');
      el.hidden = false; el.className = 'rp-adm-say' + (bad ? ' rp-adm-err' : ''); el.textContent = msg;
    };
    // A message carried across the repaint (see `notice` above) is shown into the FRESH body here.
    if (notice) { say(notice.msg, notice.bad); notice = null; }

    const sel = body.querySelector('#rp-share-proj');
    if (sel) sel.onchange = () => { selected = sel.value; paint(); };

    /* ⚠ NICKNAME EDITING IS PURELY LOCAL — setPref writes the account prefs blob, encrypted under Kr
     * before it leaves the browser. Nothing about it reaches the members route, which is the point:
     * the server stopped naming coworkers, and this must not quietly put the names back. */
    body.querySelectorAll('[data-sact="nick"]').forEach((el) => el.addEventListener('click', async () => {
      const rid = el.dataset.rid;
      const cur = memberNick(rid);
      const next = prompt(t('panel.share.nickPrompt'), cur || '');
      if (next === null) return;                       // cancelled — not the same as cleared
      try {
        await setMemberNick(rid, next.trim().slice(0, 60));
        paint();
      } catch (e) { say(sayErr(e), true); }
    }));

    body.querySelectorAll('[data-sact="edit"]').forEach((el) => el.addEventListener('click', () => {
      const box = body.querySelector(`[data-medit="${el.dataset.i}"]`);
      if (box) box.hidden = !box.hidden;
    }));
    body.querySelectorAll('[data-sact="editsave"]').forEach((el) => el.addEventListener('click', (e) => busy(e.target, async () => {
      const i = el.dataset.i;
      const caps = {};
      /* ⚠ `drive` IS STRING-VALUED, every other cap is boolean. Sending `drive: true` makes the
       * worker refuse the WHOLE record (validateCaps returns null → 400), so the edit would fail
       * with a bare status code rather than saving. 'read' is the only value a member may hold. */
      body.querySelectorAll(`input[data-mem="${i}"]`).forEach((c) => {
        if (c.checked) caps[c.dataset.cap] = c.dataset.cap === 'drive' ? 'read' : true;
      });
      /* ⚠ WARN ON INCREASE, NEVER ON DECREASE (project-split.md trust-warning mechanics): widening
       * what a person can do deserves the same pause as inviting them; narrowing never does. The
       * add-form's warning box covers the invite; this confirm covers the increase. */
      const before = (members.find((m) => m.researcher_id === el.dataset.rid) || {}).caps || {};
      const increased = Object.keys(caps).some((k) => caps[k] && !before[k]);
      if (increased && !await confirmModal(t('panel.share.increaseConfirm'))) return;
      try {
        /* The add route is an upsert (INSERT OR REPLACE), so editing IS re-adding with new caps.
         * Key grants are untouched — capabilities say what a member may DO; the keys they hold
         * already exist and removal is the only thing that withdraws them. */
        await Researcher.addMember(selected, el.dataset.rid, caps);
        deps.toast(t('panel.share.updated'), 4000);
        await paint();
      } catch (err) { say(sayErr(err), true); }
    })));
    body.querySelectorAll('[data-sact="remove"]').forEach((el) => el.addEventListener('click', () => {
      busy(el, async () => {
        if (!await confirmModal(t('panel.share.removeConfirm', { name: proj.name || proj.project_id }))) return;
        try { await Researcher.removeMember(selected, el.dataset.rid); deps.toast(t('panel.share.removed'), 5000); await paint(); }
        catch (e) { say(sayErr(e), true); }
      });
    }));

    body.querySelector('#rp-share-add').addEventListener('click', (e) => busy(e.target, async () => {
      const who = body.querySelector('#rp-share-id').value.trim();
      if (!who) return;
      /* ⚠ REQUIRED, and refused here rather than silently defaulted. Without a nickname the list is
       * two indistinguishable uuids, and the owner has no way to tell which coworker they are about
       * to revoke. Saying so is cheap; discovering it later is not. */
      const nick = body.querySelector('#rp-share-nick').value.trim().slice(0, 60);
      if (!nick) { say(t('panel.share.nickRequired'), true); return; }
      /* Send ONLY what is ticked. validateCaps stores "granted" and treats absent as false, so
       * sending `false` values would be noise — and any key it does not know refuses the whole grant. */
      const caps = {};
      if (body.querySelector('#rp-share-manage').checked) caps.manageDevices = true;
      if (body.querySelector('#rp-share-invite').checked) caps.createInvites = true;
      if (body.querySelector('#rp-share-assign').checked) caps.assignTexts = true;
      // 'read' only — the worker refuses any other value outright (never downgrades it).
      if (body.querySelector('#rp-share-drive').checked) caps.drive = 'read';
      try {
        const addResp = await Researcher.addMember(selected, who, caps);
        /* Saved AFTER the membership lands, so a failed add leaves no orphan nickname for a coworker
         * who was never added. Best-effort on purpose: the membership is the real act, and losing the
         * label must not surface as "adding failed" when it did not — the list offers a rename. */
        try { await setMemberNick(who, nick); } catch { /* label only; the row can be renamed */ }
        /* ⚠ NAME THEM, NOT THEIR UUID. The owner just typed a nickname; showing the raw id back at
         * them is the panel forgetting what it was told one field earlier — and since v503 the id is
         * all the SERVER knows, so the nickname is the only human-readable thing in reach. */
        const whoLabel = nick || who;
        /* PHASE 2b: the WORKER wrote the member's grants inside the add itself, and the response
         * says exactly what happened — including the keyless-by-design class (open-to-everyone
         * recorders) as its own category rather than as failures. That is the honest end state, no
         * client-side wrapping and no re-check round trip. The legacy path below survives for an
         * older worker whose add response has no grants summary. */
        const sg = addResp && addResp.grants;
        if (sg) {
          const keylessN = (sg.keyless || []).length;
          const usable = Math.max(0, (sg.instances || 0) - keylessN);
          if ((sg.no_pubkey || []).includes(who)) {
            notice = { msg: t('panel.share.addedNoKeys', { who: whoLabel }), bad: true };
          } else if (keylessN) {
            deps.toast(t('panel.share.addedKeyedKeyless', { who: whoLabel, n: usable, m: keylessN }), 8000);
          } else {
            deps.toast(t('panel.share.addedKeyed', { who: whoLabel, n: usable }), 6000);
          }
          await paint();
          return;
        }
        /* ⚠ THE MEMBERSHIP ROW ALONE READS NOTHING — metadata is E2EE, so the member needs each
         * device's Ki wrapped to THEIR key, and the owner is the only party who can mint that.
         * Minted here, at the one moment the owner is present. Instances are resolved through the
         * estate (folder → project folder → this project), the only join that survives renames. */
        const iids = projectInstanceIds(proj);
        let keyed = null;
        if (iids.length) {
          try { keyed = await Researcher.grantKeysToMember(who, iids); }
          catch (e2) { keyed = { granted: 0, failed: 0, err: e2 }; }
        } else {
          /* ⚠ ZERO DEVICES HAS TWO MEANINGS and only one is fine. A genuinely empty project keys
           * nothing and that is a success; an UNREACHABLE ESTATE (Drive down, offline) also yields
           * zero — but then devices exist that the member cannot read, behind a cheerful toast.
           * The estate cache distinguishes them: no devices listed anywhere ⇒ we cannot know. */
          keyed = { granted: 0, failed: 0, noEstate: !((estateCache && estateCache.devices) || []).length };
        }
        /* ⚠⚠ REPORT THE END STATE, NOT THE ATTEMPT COUNT (Seth, 2026-08-28: "this error is fairly
         * consistently showing all the time… as far as I can tell, there isn't any glitch in what the
         * researcher can actually access").
         *
         * grantKeysToMember counts how many WRAPS THREW. That is not the question the owner is asking,
         * which is "can this coworker read my devices?" — and the two come apart routinely: a wrap for
         * a device the member ALREADY holds a grant for can fail while their access is perfectly fine
         * (they created it themselves, or an earlier sweep delivered it). The result was a red banner
         * on a working outcome, every single time, which is the fastest way to teach someone to ignore
         * a banner that will one day be real.
         *
         * So: ask the server what the member actually holds now, and report only what is GENUINELY
         * missing. One extra round trip on a deliberate, once-per-coworker action. If the re-check
         * itself fails we fall back to the attempt count rather than claiming success we cannot see. */
        if (keyed && !keyed.err && keyed.failed) {
          try {
            const fresh = (await Researcher.listMembers(proj)).members || [];
            const mine = fresh.find((x) => x.researcher_id === who);
            const have = new Set((mine && mine.granted) || []);
            const stillMissing = iids.filter((id) => !have.has(id));
            keyed = { granted: iids.length - stillMissing.length, failed: stillMissing.length };
          } catch { /* cannot re-check — keep the attempt count, which errs toward warning */ }
        }
        if (keyed.err && String(keyed.err.message) === 'member_no_pubkey') {
          /* Not an error to bury: the fix is on THEIR side (open the panel once), and until then
           * the membership is real but blind. Say exactly that — via `notice`, which survives the
           * repaint below. */
          notice = { msg: t('panel.share.addedNoKeys', { who: whoLabel }), bad: true };
        } else if (keyed.noEstate) {
          notice = { msg: t('panel.share.addedNoEstate', { who: whoLabel }), bad: true };
        } else if (keyed.err || keyed.failed) {
          notice = { msg: t('panel.share.addedSomeKeys', { who: whoLabel, n: keyed.granted, m: iids.length }), bad: true };
        } else {
          deps.toast(t('panel.share.addedKeyed', { who: whoLabel, n: keyed.granted }), 6000);
        }
        await paint();
      } catch (err) { say(sayErr(err), true); }
    }));
  }


  try {
    const r = await Researcher.listProjects();
    owned = r.owned || [];
    selected = (owned[0] && owned[0].project_id) || '';
  } catch (e) {
    body.innerHTML = `<p class="note rp-adm-err">${esc(sayErr(e))}</p>`;
    return;
  }
  await paint();
}

function accountModal() {
  const m = modal(`
    <h3>${esc(t('panel.account.title'))}</h3>
    <div class="rp-field"><span>${esc(t('panel.account.signedInAs'))}</span><div class="rp-readonly">${esc(Researcher.accountEmail() || '')}</div></div>
    ${/* ⚠ THE OTHER HALF OF "add a coworker". An owner adds someone BY RESEARCHER ID, because the
        worker deliberately offers no id-to-identity lookup (that would be a directory of everyone
        on the deployment — see the pubkey route). So the id has to be handed over deliberately by
        the person it belongs to, and until this existed there was nowhere for them to read it. */''}
    <div class="rp-field"><span>${esc(t('panel.account.rid'))}</span>
      <div class="rp-readonly rp-rid">${esc(Researcher.currentAccountId() || '')}</div>
      <button class="link-btn" data-m="ridcopy">${esc(t('panel.account.ridCopy'))}</button>
      <p class="note">${esc(t('panel.account.ridNote'))}</p></div>
    <label class="check-label"><input type="checkbox" data-m="stay"${Researcher.staySignedIn() ? ' checked' : ''}> ${esc(t('panel.account.stay'))}</label>
    <p class="note">${esc(t('panel.account.stayNote'))}</p>
    <button class="link-btn" data-m="signout">${esc(t('panel.account.signout'))}</button>
    <hr class="rp-sep">
    <div class="rp-field"><span>${esc(t('panel.sessions.title'))}</span>
      <div id="rp-sessions-body">${loadingHtml('panel.sessions.loading', true)}</div></div>
    <hr class="rp-sep">
    <div class="rp-field"><span>${esc(t('panel.drive.title'))}</span>
      <div id="rp-drive-body"><p class="note">${esc(t('panel.drive.loading'))}</p></div></div>
    <hr class="rp-sep">
    <p class="note">${esc(t('panel.delacct.intro'))}</p>
    <button class="link-btn rp-danger" data-m="delacct">${esc(t('panel.delacct.link'))}</button>
    <button class="link-btn" data-m="close">${esc(t('panel.invite.close'))}</button>`, true);

  m.el.querySelector('[data-m="close"]').onclick = m.close;
  m.el.querySelector('[data-m="ridcopy"]').onclick = async () => {
    try { await navigator.clipboard.writeText(Researcher.currentAccountId() || ''); deps.toast(t('panel.account.ridCopied'), 3000); }
    catch { /* clipboard refused (permissions, insecure context) — the id is on screen to select by hand */ }
  };
  m.el.querySelector('[data-m="stay"]').onchange = (e) => Researcher.setStaySignedIn(e.target.checked);
  m.el.querySelector('[data-m="signout"]').onclick = async () => {
    if (!await confirmModal(t('panel.account.confirmSignout'))) return;
    Researcher.signOut(); m.close(); deps.onSignedUp && deps.onSignedUp(); route();
  };
  m.el.querySelector('[data-m="delacct"]').onclick = () => { m.close(); deleteAccountModal(); };   // permanent server-side account delete
  driveSection(m.el.querySelector('#rp-drive-body'));
  sessionsSection(m.el.querySelector('#rp-sessions-body'));
}

/* The signed-in-browsers list. This is what makes the session CAP tolerable rather than mysterious:
 * without it, "the oldest browser was signed out" is an unexplained event, and "sign out everything
 * that isn't me" — the one action a person wants the moment they suspect something — has no button.
 *
 * ⚠ Everything shown comes from the SERVER, so it is the same in every panel. The IP is shown in
 * full deliberately (Seth, 2026-08-17): a hash cannot answer "is that my office?", which is the only
 * question this list exists to answer. It is stored encrypted at rest, so displaying it here creates
 * no new standing record. */
async function sessionsSection(host) {
  if (!host) return;
  let data;
  try { data = await Researcher.listSessions(); }
  catch { host.innerHTML = `<p class="note">${esc(t('panel.sessions.failed'))}</p>`; return; }

  const rows = (data && data.sessions) || [];
  const when = (ms) => {
    if (!ms) return esc(t('panel.sessions.unknown'));
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 60) return `${mins}m`;
    if (mins < 1440) return `${Math.round(mins / 60)}h`;
    return `${Math.round(mins / 1440)}d`;
  };

  const others = rows.filter((r) => !r.current).length;
  host.innerHTML = rows.map((r) => {
    const detail = [r.geo, r.ip].filter(Boolean).join(' \u00b7 ');
    return `<div class="rp-session${r.current ? ' rp-session-current' : ''}">
      <div><b>${esc(r.label || t('panel.sessions.unknown'))}</b>${r.current ? ` <span class="note">(${esc(t('panel.sessions.current'))})</span>` : ''}</div>
      <div class="note">${esc(detail || t('panel.sessions.unknown'))} \u00b7 ${esc(t('panel.sessions.lastSeen'))} ${esc(when(r.last_seen_at))}</div>
      ${r.current ? '' : `<button class="link-btn" data-revoke="${esc(r.session_id)}">${esc(t('panel.sessions.revoke'))}</button>`}
    </div>`;
  }).join('')
    + (others ? `<button class="link-btn" data-m="revoke-others">${esc(t('panel.sessions.revokeOthers'))}</button>` : '')
    + (rows.length ? '' : `<p class="note">${esc(t('panel.sessions.none'))}</p>`)
    + `<p class="note">${esc(String(t('panel.sessions.cap')).replace('{n}', String((data && data.cap) || 5)))}</p>`;

  host.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = (e) => busy(e.target, async () => {
      await Researcher.revokeSession(b.dataset.revoke);
      await sessionsSection(host);        // re-read from the server rather than guessing locally
    });
  });
  const all = host.querySelector('[data-m="revoke-others"]');
  if (all) {
    all.onclick = (e) => {
      busy(e.target, async () => {
        if (!await confirmModal(t('panel.sessions.confirmOthers'))) return;
        await Researcher.revokeOtherSessions();
        await sessionsSection(host);
      });
    };
  }
}

/* Drive-delivery section (inside the account modal). There is NO mode and NO switch:
 * crowd uploads always try the researcher's OWN Drive first (streaming, via the token
 * their Google sign-in stores) and fall back to the shared relay automatically. This
 * section just shows the connection state, surfaces any background delivery failure
 * loudly, and offers a live test. Error codes are translated into plain-language fix
 * steps — the idiot-proof rule applies to researchers too. */
function driveSection(body) {
  // Worker error codes → plain language. Codes come from OUR worker (not attacker data), but esc()'d anyway.
  const explain = (e) => {
    const code = (e && e.message) || '';
    if (code === 'reconnect_needed') return t('panel.drive.reconnectNeeded');
    if (code === 'drive_api_disabled') return t('panel.drive.apiDisabled');
    if (code === 'oauth_unconfigured') return t('panel.drive.oauthUnconfigured');
    return t('panel.err', { msg: code || String(e) });
  };
  const load = async () => {
    body.innerHTML = `<p class="note">${esc(t('panel.drive.loading'))}</p>`;
    let st;
    try { st = await Researcher.driveStatus(); }
    catch {
      // Tolerate a fetch failure with an inline retry — never a dead section in the account modal.
      body.innerHTML = `<p class="note">${esc(t('panel.drive.loadFail'))} <button type="button" class="link-btn" data-d="retry">${esc(t('panel.drive.retry'))}</button></p>`;
      body.querySelector('[data-d="retry"]').onclick = load;
      return;
    }
    body.innerHTML = `
      ${st.error ? `<p class="banner warn-banner">${esc(t('panel.drive.errBanner', { msg: (st.error && st.error.msg) || '' }))} ${esc(t('panel.drive.reconnectNeeded'))}</p>` : ''}
      <p class="note">${esc(st.connected ? t('panel.drive.how', { email: st.email || '?' }) : t('panel.drive.notConnected'))}</p>
      <div class="rp-inst-actions">
        <button type="button" class="secondary-btn" data-d="test">${esc(t('panel.drive.test'))}</button>
      </div>
      <div class="rp-probe-result" role="status" hidden></div>`;
    const out = body.querySelector('.rp-probe-result');
    const paint = (msg, kind) => { out.hidden = false; out.textContent = msg; out.className = 'rp-probe-result' + (kind ? ' rp-as-' + kind : ''); };
    body.querySelector('[data-d="test"]').addEventListener('click', (e) => busy(e.target, async () => {
      paint(t('panel.drive.testing'));
      try { const r = await Researcher.driveTest(); paint(t('panel.drive.testOk') + ((r && r.note) ? ' — ' + r.note : ''), 'ok'); }
      catch (err) { paint(explain(err), 'err'); }
    }));
  };
  load();
}

/* ---------------- the reusable tabbed settings modal ---------------- */

function fieldHtml(f) {
  const label = esc(t('panel.f.' + f.k));
  // f.tip → hover tooltip on the label + input (e.g. the WS-code case warning).
  const tip = f.tip ? ` title="${esc(t(f.tip))}"` : '';
  if (f.type === 'checkbox') {
    const cb = `<label class="check-label"><input type="checkbox" data-f="${f.k}"> ${label}</label>`;
    // Auto-backup needs its "what actually happens" note (new timestamped copy per backup; the
    // quiet-time wait stops a copy per keystroke) — without it researchers expect an overwrite.
    if (f.k === 'autoBackup') return cb + `<p class="note">${esc(t('panel.f.autoBackupNote'))}</p>`;
    if (f.note) return cb + `<p class="note">${esc(t(f.note))}</p>`;
    return cb;
  }
  if (f.type === 'multicheck') {
    const boxes = f.opts.map((o) => `<label class="check-label rp-inline"><input type="checkbox" data-f="${f.k}" data-v="${o}"> ${esc(t((f.optPrefix || '') + o))}</label>`).join('');
    return `<div class="rp-field"><span>${label}</span><div class="rp-multi">${boxes}</div></div>`;
  }
  if (f.type === 'action') {
    const note = f.k === 'archivalDefaults' ? `<p class="note">${esc(t('panel.f.archivalNote'))}</p>` : '';
    return `<div class="rp-field"><button type="button" class="secondary-btn" data-gact="${f.k}">${label}</button></div>${note}`;
  }
  if (f.type === 'range') {
    // Max-duration slider (0 = no limit) with a live duration label + size readout
    // that tracks the recording-format select (mirrors the crowd editor's estimate).
    return `<label class="rp-field"><span>${label} — <span id="rp-maxrec-lbl"></span></span><input type="range" data-f="${f.k}" min="0" max="3600" step="10"></label><p class="note" id="rp-maxrec-est"></p>`;
  }
  if (f.type === 'select') {
    const opts = f.opts.map((o) => `<option value="${o}">${esc(f.optPrefix ? t(f.optPrefix + o) : o)}</option>`).join('');
    // The recording format is the one setting whose consequences are invisible here: it decides how
    // long a cheap phone can record before the app has to stop it, and whether the result can be
    // called an archival master at all. Neither is guessable from a format name in a dropdown.
    const help = f.k === 'recordFormat'
      ? `<p class="note"><a href="/flextext-editor/help/recording-limits.html" target="_blank" rel="noopener">${esc(t('panel.f.recordFormatHelp'))}</a></p>`
      : '';
    return `<label class="rp-field"><span>${label}</span><select data-f="${f.k}">${opts}</select></label>${help}`;
  }
  if (f.type === 'textarea') return `<label class="rp-field"><span>${label}</span><textarea data-f="${f.k}" rows="2"></textarea></label>`;
  // f.note → an explanatory line under the input. Generic on purpose: several fields have
  // meanings that are NOT obvious from a short label (e.g. consent audio is the prompt PLAYED to
  // the speaker, not their recorded answer).
  const note = f.note ? `<p class="note">${t(f.note)}</p>` : '';
  // The consent PROMPT is a file upload too (assign-by-upload rule 1): pick the audio, it streams
  // to the DEVICE folder in the researcher's Drive, and the minted private URL fills this same
  // field — the settings push carries it exactly as a pasted URL always did (zero wire changes).
  if (f.k === 'consentAudioUrl') {
    /* ⚠ The URL input is a HIDDEN value carrier, not a thing to type in. It stays in the DOM
     * because fillForm/readForm move the setting through `[data-f]`, and the minted private URL
     * lands in it — but showing it invited the obvious question ("what is the textbox for?", Seth,
     * 2026-08-12) and implied a URL was still something a researcher pastes. Since assign-by-upload
     * there is exactly one way in: pick the file. The status line reports what is stored. */
    return `<div class="rp-field"${tip}><span>${label}</span>
      <input data-f="${f.k}" type="hidden">
      <div class="rp-prompt-state" data-promptstate>${esc(t('panel.f.consentNone'))}</div>
      <button type="button" class="secondary-btn" data-gact="consentUpload">${esc(t('panel.f.consentUpload'))}</button>
      <input type="file" id="rp-consent-file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.opus,.webm,.flac" hidden></div>${note}`;
  }
  const input = `<label class="rp-field"${tip}><span>${label}</span><input data-f="${f.k}" spellcheck="false"${tip}></label>${note}`;
  return input;
}

/* Every field, always. The `deviceOnly` filter existed for ONE caller — the researcher's own
 * "This device" modal — which is gone (Seth, 2026-08-07): a researcher's own device is unpaired, so
 * it already has the editor's Settings tab, which does this properly and standalone. What is left
 * here only ever configures ANOTHER device, where every field applies. */
function groupFields(g) { return g.fields; }
// A prominent, plain-language warning box at the top of a settings group. Used to tell a
// researcher that a website-installed (PWA) device cannot make archive-quality recordings —
// the single most consequential thing they can get wrong without ever being told.
function noticeHtml(kind) {
  if (kind !== 'pwaAudio') return '';
  const link = NATIVE_DOWNLOADS_URL
    ? `<p><a href="${esc(NATIVE_DOWNLOADS_URL)}" target="_blank" rel="noopener noreferrer">${esc(t('panel.notice.audioGet'))}</a></p>`
    : `<p class="note">${esc(t('panel.notice.audioSoon'))}</p>`;
  return `<div class="rp-notice"><b>${esc(t('panel.notice.audioTitle'))}</b>${t('panel.notice.audioBody')}${link}</div>`;
}

function groupHtml(g) {
  // The TAB label (panel.grp.<id>) and the fieldset heading may differ (g.legend):
  // e.g. the Languages tab's fieldset is headed "FLEx Writing System Codes".
  // g.helpModal renders an inline "more info…" that opens the in-panel help modal —
  // NOT a new-tab link: the editor SW's navigate fallback serves the app shell for
  // any non-precached in-scope URL, so same-scope help pages can't be linked from
  // inside the PWA. The modal also works offline and follows the panel language.
  const help = g.helpModal ? `<button type="button" class="link-btn rp-legend-help" data-ghelp="${g.helpModal}">${esc(t('panel.grp.moreInfo'))}</button>` : '';
  const fields = groupFields(g);
  const outside = fields.filter((f) => f.outside).map(fieldHtml).join('');   // e.g. appLang sits above the codes fieldset
  const inside = fields.filter((f) => !f.outside).map(fieldHtml).join('');
  const notice = g.notice ? noticeHtml(g.notice) : '';
  return `<div class="rp-group" id="rp-grp-${g.id}" role="tabpanel" aria-labelledby="rp-tab-${g.id}" data-group="${g.id}" hidden>${notice}${outside}<fieldset class="rp-fieldset"><legend>${esc(t(g.legend || 'panel.grp.' + g.id))}</legend>${help}${inside}</fieldset></div>`;
}

// Map stored settings → canonical form values (mode-aware on the divergent fields).
function toFormValues(s) {
  s = s || {};
  const v = {};
  for (const g of GROUPS) for (const f of groupFields(g)) {
    if (f.type === 'action') continue;
    if (f.k === 'sendOptions') v.sendOptions = s.sendOptions || [];
    else if (f.k === 'buttons') v.buttons = s.toolbarButtons || [];
    // Consent multi-select: prefer the new arrays; else migrate the old single consentMode/consentResp.
    else if (f.k === 'consentAsk') v.consentAsk = Array.isArray(s.consentAsk) ? s.consentAsk
      : (s.consentMode && s.consentMode !== 'off' ? [s.consentMode] : []);
    else if (f.k === 'consentConfirm') v.consentConfirm = Array.isArray(s.consentConfirm) ? s.consentConfirm
      : (s.consentMode && s.consentMode !== 'off' ? [s.consentResp || 'yesno'] : []);
    // appLang is a one-shot "set the device language" command, NOT a persistent setting to display:
    // always open at 'follow' so it's re-sent ONLY when the researcher deliberately re-picks a language
    // (else every later push would re-clobber a field worker who toggled their own language back).
    else if (f.k === 'appLang') v.appLang = 'follow';
    else if (f.k === 'autoDel') v.autoDel = !!s.autoDelUploaded;                                   // stored as autoDelUploaded
    // Export toggles: unset follows Audio Segmentation Mode — show the EFFECTIVE value, so the
    // researcher sees what the device will actually do, not a misleading unchecked box.
    else if (f.k === 'exportEaf' || f.k === 'exportSaymore' || f.k === 'exportPreview' || f.k === 'exportJson') v[f.k] = s[f.k] ?? (s.segmentation !== false);
    /* Segmentation defaults ON for a device whose researcher has never set it — matching
     * segmentationEnabled() on the device (app.js). Rendering it from `!!s.segmentation` showed a
     * NEW instance an unchecked box and then pushed `false`, so the first assigned text opened in
     * the basic editor until the researcher toggled the box (Seth, 2026-08-12). Only an explicit
     * false stays false. */
    else if (f.k === 'segmentation') v.segmentation = s.segmentation !== false;
    else if (f.k === 'cutTab') v.cutTab = s.cutTab !== false;
    else if (f.k === 'landOnCut') v.landOnCut = s.landOnCut !== false;
    else if (f.k === 'joinSplitBaseline') v.joinSplitBaseline = s.joinSplitBaseline !== false;
    else if (f.k === 'joinSplitGloss') v.joinSplitGloss = s.joinSplitGloss !== false;
    else if (f.k === 'cutJoinTexted') v.cutJoinTexted = s.cutJoinTexted === true;
    else if (f.k === 'autoBackupMins') v.autoBackupMins = String(s.autoBackupMins || 15);          // stored as a number; default 15
    else if (f.type === 'checkbox') v[f.k] = !!s[f.k];
    else if (f.type === 'select') v[f.k] = s[f.k] || (f.k === 'recordFormat' ? DEFAULT_REC_FORMAT : f.opts[0]);
    else if (f.type === 'range') v[f.k] = parseInt(s[f.k], 10) || 0;
    else v[f.k] = s[f.k] || '';
  }
  return v;
}

function fillForm(box, v) {
  box.querySelectorAll('[data-f]').forEach((el) => {
    const k = el.dataset.f;
    if (el.type === 'checkbox') {
      if (el.dataset.v) el.checked = Array.isArray(v[k]) && v[k].includes(el.dataset.v);
      else el.checked = !!v[k];
    } else { el.value = v[k] != null ? v[k] : ''; }
  });
  paintPromptState(box);
}

/* The consent prompt's status line — the visible half of a hidden value carrier. A stored value is
 * a minted private URL, never anything a researcher would read, so report the STATE. */
function paintPromptState(box) {
  const el = box.querySelector('[data-promptstate]');
  if (!el) return;
  const url = (box.querySelector('[data-f="consentAudioUrl"]') || {}).value || '';
  el.textContent = url ? t('panel.f.consentHave') : t('panel.f.consentNone');
  el.classList.toggle('rp-prompt-set', !!url);
}

// Collect the form's raw values keyed by canonical field id (vernLang, upload, sendOptions, …).
// Shared by readForm (→ settings patch) and validateDeviceSettings (→ required-field check).
function collectRaw(box) {
  const raw = {};
  box.querySelectorAll('[data-f]').forEach((el) => {
    const k = el.dataset.f;
    if (el.type === 'checkbox' && el.dataset.v) { (raw[k] = raw[k] || []); if (el.checked) raw[k].push(el.dataset.v); }
    else if (el.type === 'checkbox') raw[k] = el.checked;
    else raw[k] = (el.value || '').trim();
  });
  return raw;
}

// Read the form → a settings patch (mode-aware on divergent keys).
function readForm(box) {
  const raw = collectRaw(box);
  const patch = {};
  const SPECIAL = ['sendOptions', 'buttons', 'autoDel', 'consentAudioUrl', 'autoBackupMins', 'maxRecordSeconds'];
  for (const g of GROUPS) for (const f of groupFields(g)) {
    if (SPECIAL.includes(f.k) || f.type === 'action') continue;
    patch[f.k] = raw[f.k];
  }
  // appLang 'follow' (or unset) = "don't change this device's language" → never push it (it would
  // clobber a field worker's own toggle choice). Only an explicit en/id is sent (set-with-override).
  if (patch.appLang === 'follow' || !patch.appLang) delete patch.appLang;
  // autoDel checkbox is stored as autoDelUploaded (the key the field client reads).
  patch.autoDelUploaded = !!raw.autoDel;
  // autoBackup rides the generic path (boolean); the minutes select is a string → the device wants a number.
  patch.autoBackupMins = parseInt(raw.autoBackupMins, 10) || 15;
  patch.maxRecordSeconds = parseInt(raw.maxRecordSeconds, 10) || 0;   // 0 = no limit
  // Consent audio: store the raw link AND the resolved URL the device actually plays.
  patch.consentAudioUrl = raw.consentAudioUrl || '';
  patch.consentAudio = (raw.consentAudioUrl && deps.resolveAudioInput) ? deps.resolveAudioInput(raw.consentAudioUrl) : '';
  /* ⚠ linkSendOptions / linkButtons are GONE with the "This device" modal, which was their only
   * writer — and nothing ever read them. They were a "link template" from a design that never
   * shipped a consumer. Do not reintroduce them without a reader. */
  patch.sendOptions = raw.sendOptions || [];
  patch.toolbarButtons = raw.buttons || [];
  return patch;
}

/* ---------------- required-settings validation ----------------
 * Minimal-usable check: flag anything blank that would BREAK a device in the field, so a researcher
 * can neither push broken settings nor mint an invite for a misconfigured device. Required:
 *   • vernacular + analysis language CODES — no codes → no writing system (app.js builds the WS only
 *     when vernLang is set; analLang silently falls back to 'en', i.e. wrong for non-English work);
 *   • a Google Drive folder IF "Upload" is an enabled send button — else the upload button silently
 *     never appears (app.js shows it only when uploadFolder is set);
 *   • the consent AUDIO link IF consent mode is Audio (else the audio consent step has nothing to play);
 *   • the consent MESSAGE IF consent mode is Text (else the text consent screen is blank).
 * Everything else has a safe default/fallback. Returns [{ group, field, msg }] (empty = OK). */
function validateDeviceSettings(raw, opts = {}) {
  /* opts.templateMode drops ONLY the consent-audio URL rule, for the project template form: that
   * URL is minted per device by the prompt upload, so a template can never hold one and the rule
   * would make audio consent unreachable there. Everything a template CAN satisfy it still must —
   * and the dropped rule is re-applied to each merged object before it is pushed to a device. */
  const { parseFolder, uploadIsUrl, templateMode } = opts;
  const blank = (v) => !v || !String(v).trim();
  const out = [];
  if (blank(raw.vernLang)) out.push({ group: 'languages', field: 'vernLang', msg: t('panel.val.vernLang') });
  if (blank(raw.analLang)) out.push({ group: 'languages', field: 'analLang', msg: t('panel.val.analLang') });
  // No upload-folder requirement any more: linked devices stream into the
  // researcher's own Drive automatically (the relay leg is retired).
  /* ⚠ A DEVICE MUST HAVE SOME WAY TO GET WORK OUT. With nothing ticked the coworker records and
   * glosses into IndexedDB and can never send any of it anywhere — a dead end that looks like a
   * working app. Here upload DOES count: a managed device really can upload. */
  /* ⚠ SHARE ALONE IS NOT ENOUGH. navigator.share() only accepts an allowlisted set of file types —
   * not XML, not ZIP — so it sends the bare .flextext renamed .txt and nothing else: no audio, no
   * EAF, no .fxpa, no preview page. A device permitted only Share can never get one second of audio
   * off itself. Upload and Save both carry the whole bundle, so one of those is required. */
  const send = Array.isArray(raw.sendOptions) ? raw.sendOptions : [];
  if (!send.includes('save') && !send.includes('upload')) {
    out.push({ group: 'sending', field: 'sendOptions', msg: t('panel.val.sendNone') });
  }
  const ask = Array.isArray(raw.consentAsk) ? raw.consentAsk : [];
  if (!templateMode && ask.includes('audio') && blank(raw.consentAudioUrl)) out.push({ group: 'consent', field: 'consentAudioUrl', msg: t('panel.val.consentAudio') });
  if (ask.includes('text') && blank(raw.consentMsg)) out.push({ group: 'consent', field: 'consentMsg', msg: t('panel.val.consentMsg') });
  return out;
}

// Map a stored settings snapshot (device keys) → the canonical shape validateDeviceSettings reads.
function settingsToRaw(s) {
  s = s || {};
  return {
    vernLang: s.vernLang, analLang: s.analLang,
    sendOptions: s.sendOptions || [],
    consentAsk: Array.isArray(s.consentAsk) ? s.consentAsk : (s.consentMode && s.consentMode !== 'off' ? [s.consentMode] : []),
    consentConfirm: Array.isArray(s.consentConfirm) ? s.consentConfirm : (s.consentMode && s.consentMode !== 'off' ? [s.consentResp || 'yesno'] : []),
    consentAudioUrl: s.consentAudioUrl, consentMsg: s.consentMsg,
  };
}

// Paint validation errors VERY explicitly so the researcher can't miss what's blocking the save:
//   1. a persistent banner above the tabs listing each blocked field WITH its tab name (each entry
//      clicks through to that field) — survives tab switches so multi-tab errors are all visible;
//   2. a red marker dot on every offending tab;
//   3. a red ring + inline "why" message on each field;
//   4. jump to + focus the first offending field;
//   5. a toast naming the first blocker (field + tab).
// All of it is cleared and recomputed on every save attempt.
function flagProblems(box, problems, showGroup) {
  box.querySelectorAll('.rp-invalid').forEach((el) => el.classList.remove('rp-invalid'));
  box.querySelectorAll('.rp-fielderr').forEach((el) => el.remove());
  box.querySelectorAll('.rp-tab.rp-tab-err').forEach((el) => el.classList.remove('rp-tab-err'));
  const oldBanner = box.querySelector('.rp-valbanner'); if (oldBanner) oldBanner.remove();

  const labelFor = (p) => t('panel.val.fieldAtTab', { field: t('panel.f.' + p.field), tab: t('panel.grp.' + p.group) });

  for (const p of problems) {
    const el = box.querySelector(`[data-f="${p.field}"]`);
    if (el) {
      const wrap = el.closest('.rp-field, .check-label') || el;
      wrap.classList.add('rp-invalid');
      const err = document.createElement('div');
      err.className = 'rp-fielderr';
      err.textContent = p.msg;
      wrap.appendChild(err);
    }
    const tab = box.querySelector(`.rp-tab[data-tab="${p.group}"]`);
    if (tab) tab.classList.add('rp-tab-err');   // mark the tab so errors on other tabs are visible too
  }

  // Persistent "what's blocking + which tab" banner, above the tabs; each item jumps to its field.
  const banner = document.createElement('div');
  banner.className = 'rp-valbanner';
  banner.innerHTML = `<strong>${esc(t('panel.val.bannerTitle'))}</strong><ul>${problems.map((p) =>
    `<li><button type="button" class="rp-valjump" data-grp="${esc(p.group)}" data-fld="${esc(p.field)}">${esc(labelFor(p))}</button></li>`).join('')}</ul>`;
  const tabs = box.querySelector('.rp-tabs');
  if (tabs && tabs.parentNode) tabs.parentNode.insertBefore(banner, tabs);
  else box.appendChild(banner);
  banner.querySelectorAll('.rp-valjump').forEach((btn) => btn.addEventListener('click', () => {
    showGroup(btn.dataset.grp);
    const f = box.querySelector(`[data-f="${btn.dataset.fld}"]`);
    if (f) { try { f.focus(); } catch { /* noop */ } }
  }));

  if (showGroup && problems[0]) showGroup(problems[0].group);
  const first = problems[0] && box.querySelector(`[data-f="${problems[0].field}"]`);
  if (first) { try { first.focus(); } catch { /* noop */ } }

  const firstLabel = labelFor(problems[0]);
  deps.toast(problems.length === 1
    ? t('panel.val.summaryOne', { field: firstLabel })
    : t('panel.val.summaryMany', { field: firstLabel, more: problems.length - 1 }), 6000);
}

async function openSettingsModal(target, opts = {}) {
  const m = modal(`
    <div class="rp-set-head"><h3>${esc(target.project
      ? t('panel.set.projTitle', { name: target.project.name || '' })
      : t('panel.set.title', { name: (target.instance && target.instance.nickname) || '' }))}</h3></div>
    ${target.project ? `<p class="note">${esc(t('panel.set.projIntro'))}</p>` : ''}
    ${/* DEVICE RENAME (Seth, 2026-08-30: "the ability to rename devices… maybe as a setting in the
         device settings"). The engine (renameInstance) and the worker route existed all along —
         authMember + manageDevices, the same gate as this modal — but nothing in the UI ever called
         them. Device mode only: a project template has no nickname. */''}
    ${target.instance ? `<label class="rp-field"><span>${esc(t('panel.set.nick'))}</span>
      <input id="rp-set-nick" maxlength="60" value="${esc(target.instance.nickname || '')}" placeholder="${esc(t('panel.set.nickPh'))}"></label>` : ''}
    <div class="rp-tabs" role="tablist">${GROUPS.map((g, i) => `<button class="rp-tab${i === 0 ? ' on' : ''}" role="tab" id="rp-tab-${g.id}" aria-controls="rp-grp-${g.id}" aria-selected="${i === 0}" data-tab="${g.id}">${esc(t('panel.grp.' + g.id))}</button>`).join('')}</div>
    <div class="rp-groups">${GROUPS.map((g) => groupHtml(g)).join('')}</div>
    <p class="note rp-enc">${esc(t('panel.set.encNote'))}</p>
    <button class="primary-btn" data-m="save">${esc(target.project ? t('panel.set.projSave') : t('panel.set.push'))}</button>
    <button class="link-btn" data-m="cancel">${esc(t('panel.set.cancel'))}</button>`, true);

  const box = m.el;
  const groups = box.querySelectorAll('.rp-group');
  const showGroup = (id) => {
    groups.forEach((g) => { g.hidden = g.dataset.group !== id; });
    box.querySelectorAll('.rp-tab').forEach((b) => {
      const on = b.dataset.tab === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
  };
  box.querySelectorAll('.rp-tab').forEach((b) => b.addEventListener('click', () => showGroup(b.dataset.tab)));
  showGroup(GROUPS[0].id);

  // prefill — for a device, prefer the researcher's own last-pushed snapshot (available even before
  // the device has reported back); fall back to whatever the device last reported.
  let source = {};
  source = (target.project && projectDefaults(target.project.folderId))
    || (target.instance && await Researcher.getInstanceSettings(target.instance.instance_id).catch(() => null))
    || (target.instance && firstInventorySettings(target.instance)) || {};
  /* THE TEMPLATE'S COPY SITE (v519): a device with no settings at all seeds its form from the
   * project's default settings — this is the "new devices are born with the template" half of the
   * v505 feature, which until now only STORED templates. Never over real settings: the pushed
   * snapshot and the device's own report both outrank it, so an already-configured device can
   * never have its truth papered over by a template. The create flow hands the folder id straight
   * in (opts.projectFolderId — the estate cannot know a device created seconds ago); the retry
   * path (a card's Settings button after a failed first delivery) resolves it from the estate the
   * same way projectScope does. Prefill only — the PUSH stays the researcher's explicit act. */
  let seededFromTemplate = false;
  let unreadable = false;
  if (target.instance && !target.project && !Object.keys(source || {}).length) {
    let folder = opts.projectFolderId || '';
    if (!folder) {
      const dev = ((estateCache && estateCache.devices) || []).find((d) =>
        (d.instanceId && d.instanceId === target.instance.instance_id)
        || (d.folderId && d.folderId === target.instance.oauth_folder_id));
      folder = dev ? (dev.projectId || '') : '';
    }
    if (folder) {
      /* ⚠ "HAS NO SETTINGS" AND "ITS SETTINGS COULD NOT BE READ" ARE DIFFERENT FACTS, and
       * getInstanceSettings answers null to BOTH: its lane read swallows its own failures, and the
       * snapshot fallback is empty for a device somebody ELSE configured. Seeding on the second
       * one would hand the researcher a full, plausible, already-valid form over a member's real
       * configuration — with a note telling them to push it, one click from replacing it. So the
       * lane is re-read DIRECTLY here, where a failure throws instead of vanishing, and the
       * template is seeded only on a positive "there is nothing there". A device created moments
       * ago by the create flow (projectFolderId passed) skips the check: it has no lane to
       * misread, and no round trip is worth spending to learn that. */
      let empty = !!opts.projectFolderId;
      if (!empty) {
        try {
          const lane = await Researcher.readSettingsLane(target.instance.instance_id);
          if (lane && Object.keys(lane).length) source = lane;   // a blip hid it — show the truth
          else empty = true;
        } catch { unreadable = true; }
      }
      if (empty) {
        await loadProjectDefaults();
        const tpl = projectDefaults(folder);
        if (tpl && Object.keys(tpl).length) { source = tpl; seededFromTemplate = true; }
      }
    }
  }
  /* An all-blank form on a device someone ELSE created reads as "sharing is broken" (Seth,
   * 2026-08-27, three screenshots in a row) — when the truth is simply that nobody has configured
   * the device yet. Say so. Keyless seats never reach this modal (the act gate toasts first), so
   * blank HERE always means unconfigured, and the note is always true when shown.
   * A template-seeded form gets the OTHER note: the fields are full but NOTHING IS ON THE DEVICE
   * YET, and a full form that quietly needed pushing would read as configured when it is not.
   * And when the read simply FAILED, say that instead of either — neither claim is knowable. */
  const noteKey = unreadable ? 'panel.set.readFailed'
    : (target.instance && !target.project && !Object.keys(source || {}).length) ? 'panel.set.unconfigured'
    : seededFromTemplate ? 'panel.set.fromTemplate' : '';
  if (noteKey) {
    const h = box.querySelector('h3');
    if (h) h.insertAdjacentHTML('afterend', `<p class="note">${esc(t(noteKey))}</p>`);
  }
  fillForm(box, toFormValues(source));
  /* ⚠ THE CONSENT PROMPT IS PER-DEVICE, so in TEMPLATE mode its upload button had nothing to
   * target and sat there dead — the upload streams the audio into one device's own Drive folder
   * and mints a URL for that device, which is why its wiring below requires target.instance. A
   * control that cannot act must say what to do instead of sitting there (the repo's rule), so in
   * template mode it is replaced by the reason. The template still carries the consent MODE; the
   * prompt itself is uploaded on each device, where the button works. */
  if (target.project) {
    const cu = box.querySelector('[data-gact="consentUpload"]');
    if (cu) { cu.insertAdjacentHTML('afterend', `<p class="note">${esc(t('panel.set.promptPerDevice'))}</p>`); cu.remove(); }
    const cf = box.querySelector('#rp-consent-file');
    if (cf) cf.remove();
  }
  /* Template mode drops ONE validation rule — the audio-prompt URL — because that URL is minted
   * per device (above) and can never exist in a template. Without this, ticking audio consent in a
   * template failed validation naming a field the modal cannot fill: a loop with no exit. The rule
   * still applies where it can be satisfied: on each device's own form, and on every merged object
   * applyTemplateModal actually pushes, so a device whose prompt is missing is refused BY NAME
   * rather than silently given a consent step with nothing to play. */
  const vopts = { parseFolder: deps.parseDriveFolder, uploadIsUrl: true, templateMode: !!target.project };
  // Group help buttons → the matching in-panel help modal (stacks over settings,
  // same pattern as the WS utility's "?" button).
  box.querySelectorAll('[data-ghelp]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.ghelp === 'wscodes') wsCodesHelpModal();
    if (b.dataset.ghelp === 'recfmt') recfmtHelpModal();
  }));
  // Archive-grade one-tap: 24-bit WAV + AGC/NR/echo/normalization OFF (the widely
  // accepted preservation-master baseline). Sets the form; Save/push as usual.
  box.querySelectorAll('[data-gact="archivalDefaults"]').forEach((b) => b.addEventListener('click', () => {
    const fmt = box.querySelector('[data-f="recordFormat"]');
    if (fmt) { fmt.value = 'wav24'; fmt.dispatchEvent(new Event('change')); }   // change → live size readout follows
    const agc = box.querySelector('[data-f="agc"]');
    if (agc) agc.value = 'off';
    for (const k of ['nr', 'echo', 'norm']) {
      const el = box.querySelector(`[data-f="${k}"]`);
      if (el) el.checked = false;
    }
    deps.toast(t('panel.f.archivalSet'), 4000);
  }));
  // Consent-prompt upload (assign-by-upload): stream the picked audio to the DEVICE folder via the
  // assignment-upload mechanism ('consent-prompt' kind — the docId path segment is a placeholder,
  // the worker targets the device folder for this kind), then fill the URL field with the minted
  // private token URL. The researcher still presses Save/Push — nothing is sent behind their back.
  /* ⚠ IN-FLIGHT STATE, READ BY THE SAVE BUTTON BELOW (v3 work order item 4). Until this existed,
   * pressing "push to device" while the prompt was still uploading produced a VALIDATION ERROR —
   * consentAudioUrl is only filled when the upload finishes, so the form correctly reported a
   * required field as missing and incorrectly made that look like a failure. Seth: never an error
   * that looks like failure when the thing is simply not done yet. */
  let consentUploading = null;   // { pct } while a prompt upload is running, else null
  {
    const cuBtn = box.querySelector('[data-gact="consentUpload"]');
    const cuFile = box.querySelector('#rp-consent-file');
    if (cuBtn && cuFile && target.instance) {
      cuBtn.addEventListener('click', () => cuFile.click());
      cuFile.addEventListener('change', (e) => busy(cuBtn, async () => {
        const file = e.target.files[0]; e.target.value = '';
        if (!file) return;
        const iid = target.instance.instance_id;
        consentUploading = { pct: 0 };
        // busy() restores the label in its own finally, so painting it here is safe.
        cuBtn.textContent = t('panel.f.consentUploadingPct', { pct: 0 });
        try {
          const fileId = await Researcher.assignUploadFile(iid, 'consent-prompt', {
            blob: file, name: file.name, mime: file.type || 'audio/mpeg', kind: 'consent-prompt',
          }, {
            // A spoken prompt on a field connection is minutes, not seconds. Silence for that long
            // is indistinguishable from a hang, which is what made people press Save and meet the
            // error above.
            onProgress: (sent, total) => {
              const pct = total ? Math.min(100, Math.round((sent / total) * 100)) : 0;
              consentUploading = { pct };
              cuBtn.textContent = t('panel.f.consentUploadingPct', { pct });
            },
          });
          // Minting the delivery URL is a separate round trip: 100% is not yet done.
          cuBtn.textContent = t('panel.f.consentFinishing');
          const fin = await Researcher.assignFinish(iid, 'consent-prompt', { promptFileId: fileId, ttlDays: assignTtlDays() });
          const input = box.querySelector('[data-f="consentAudioUrl"]');
          if (input && fin.promptUrl) input.value = fin.promptUrl;
          paintPromptState(box);   // the hidden carrier changed — the visible state must follow
          deps.toast(t('panel.f.consentUploaded'), 5000);
        } catch (err) { errToast(err); }
        finally { consentUploading = null; }   // always cleared, or Save would be wedged for good
      }));
    }
  }
  // Live max-duration label + size readout (crowd-editor twin). mbTxt keeps 1dp under 10 MB.
  const mrSlider = box.querySelector('[data-f="maxRecordSeconds"]');
  if (mrSlider) {
    const fmtSel = box.querySelector('[data-f="recordFormat"]');
    const mbTxt = (bytes) => { const mb = bytes / 1048576; return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1); };
    const paintMr = () => {
      const secs = parseInt(mrSlider.value, 10) || 0;
      const fmt = fmtSel ? fmtSel.value : 'wav24';
      box.querySelector('#rp-maxrec-lbl').textContent = secs ? fmtDur(secs) : t('panel.f.maxRecUnlimited');
      box.querySelector('#rp-maxrec-est').textContent = secs
        ? t('panel.crowd.estimate', { mb: mbTxt(crowdEstimate(fmt, secs)) })
        : t('panel.f.perMinEstimate', { mb: mbTxt(crowdEstimate(fmt, 60)) });
    };
    mrSlider.addEventListener('input', paintMr);
    if (fmtSel) fmtSel.addEventListener('change', paintMr);
    paintMr();
  }

  // If opened because validation already blocked the researcher (e.g. the invite gate), show
  // exactly what's missing right away rather than waiting for them to hit Save.
  if (opts.flagOnOpen) {
    const probs = validateDeviceSettings(collectRaw(box), vopts);
    if (probs.length) flagProblems(box, probs, showGroup);
  }

  box.querySelector('[data-m="cancel"]').onclick = m.close;
  box.querySelector('[data-m="save"]').onclick = (e) => busy(e.target, async () => {
    /* NOT-DONE-YET IS NOT A FAILURE. The consent prompt's URL field is filled by the upload above,
     * so validating mid-upload would flag a required field as missing and paint it red — the exact
     * "push to device throws an error until the background upload finishes" this replaces. Refuse
     * plainly instead, and say how far along it is so the wait is legible rather than mysterious. */
    if (consentUploading) {
      deps.toast(t('panel.f.consentStillUploading', { pct: consentUploading.pct }), 6000);
      return;
    }
    // Block save/push until minimal usable settings are present (offending fields flagged inline).
    const problems = validateDeviceSettings(collectRaw(box), vopts);
    if (problems.length) { flagProblems(box, problems, showGroup); return; }
    const patch = readForm(box);
    try {
      if (target.project) {
        /* ⚠ STORED FIRST, PUSHED ONLY BY CHOICE. Saving a template must not touch a single
         * existing device by itself — changing defaults is safe, and changing devices is a
         * deliberate second act. That second act is the chooser that opens NEXT (v519,
         * applyTemplateModal): tick one, several or all of the project's devices and push either
         * the whole template or only the fields this save changed — or decline, and the save
         * stays exactly the save it always was. The same validation runs first, though, because a
         * template that cannot pass validateDeviceSettings would mint devices that fail the
         * invite gate later, and the owner would meet that error at a moment with no obvious
         * connection to here. */
        const prevTpl = projectDefaults(target.project.folderId);
        await saveProjectDefaults(target.project.folderId, patch);
        m.close();
        const targets = projectInstanceList(target.project.folderId);
        if (!targets.length) { deps.toast(t('panel.set.projSaved'), 4000); return; }
        applyTemplateModal(target.project, patch, prevTpl, targets);
      } else {
        /* Rename FIRST, and only when actually changed — a rename bumps desired_rev, and doing it
         * needlessly would wake every install's poll for nothing. A failed rename aborts before the
         * settings push so the toast can never claim more than happened. Blank = keep the old name
         * (an accidentally-cleared field must not strip a device of its label). */
        const nickEl = box.querySelector('#rp-set-nick');
        const newNick = nickEl ? nickEl.value.trim().slice(0, 60) : '';
        if (newNick && newNick !== (target.instance.nickname || '')) {
          await Researcher.renameInstance(target.instance.instance_id, newNick);
          target.instance.nickname = newNick;
          /* target.instance came from a FRESH listView(), not from lastData — patch the cached
           * row too (own + shared projects), or the repaint below paints the OLD name and the
           * rename only "lands" at the next poll (Seth saw exactly that lag). */
          const cachedRow = ((lastData && lastData.instances) || [])
            .concat(((lastData && lastData.memberProjects) || []).flatMap((mp) => mp.instances || []))
            .find((x) => x.instance_id === target.instance.instance_id);
          if (cachedRow) cachedRow.nickname = newNick;
        }
        await Researcher.changeSettings(target.instance.instance_id, patch);
        m.close(); deps.toast(t('panel.set.pushed'), 4000);
        renderDashboard(lastData || undefined);   // the card shows the new name now, not at the next poll
      }
    } catch (err) { errToast(err); }
  });

}

/* ---------------- apply the template to existing devices (v519) ----------------
 * The "deliberate second act" the template comment promises, offered right after every template
 * save — the one moment the researcher is already thinking about these exact values — and never
 * fired by the save itself. Three outcomes, all explicit: push to the ticked devices (one,
 * several, or all of them), or decline and the save stays a save. Escape/backdrop = decline; the
 * template is already stored, so closing this loses nothing.
 *
 * Two modes when this save CHANGED an existing template. "Only what changed" updates just those
 * fields on each ticked device and leaves the rest of its settings alone — the bulk-change tool
 * (Seth: "for example a new consent prompt. There's really not a very good reason that should
 * apply to only one device") that cannot clobber per-device differences. "The whole template" is
 * the full overwrite, described in exactly those words. A first-ever save has no "changed" subset,
 * so only the overwrite is offered, with its warning standing alone. */

function projectInstanceList(folderId) {
  /* Same instance→project resolution as projectScope (the worker's own instanceId stamp first,
   * the folder lookup as the fallback) — one derivation of the relationship, not a third. */
  const devs = ((estateCache && estateCache.devices) || []);
  const byInstance = new Map(devs.filter((d) => d.instanceId).map((d) => [d.instanceId, d.projectId || '']));
  const byFolder = new Map(devs.map((d) => [d.folderId, d.projectId || '']));
  return ((lastData && lastData.instances) || []).filter((it) =>
    (byInstance.has(it.instance_id) ? byInstance.get(it.instance_id) : (byFolder.get(it.oauth_folder_id) || '')) === folderId);
}

function templateChangedKeys(prevTpl, patch) {
  // Raw PATCH keys (including derived ones like autoDelUploaded/consentAudio) — this list drives
  // the merge, so it must match what changeSettings actually ships, not what the form displays.
  const a = prevTpl || {}, b = patch || {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/* Display names for the changed-fields outline. Derived patch keys map back to the form field
 * whose label the researcher actually saw; keys with no form field (e.g. consentAudio, the
 * resolved twin of consentAudioUrl) fold into it rather than surfacing internals. */
const APPLY_DISPLAY_KEY = { autoDelUploaded: 'autoDel', toolbarButtons: 'buttons', consentAudio: 'consentAudioUrl' };
function changedFieldLabels(rawKeys) {
  const known = new Set();
  for (const g of GROUPS) for (const f of groupFields(g)) if (f.type !== 'action') known.add(f.k);
  const ks = [];
  for (const k of rawKeys) {
    const d = APPLY_DISPLAY_KEY[k] || k;
    if (known.has(d) && !ks.includes(d)) ks.push(d);
  }
  return ks.map((k) => t('panel.f.' + k));
}

function applyTemplateModal(project, patch, prevTpl, targets) {
  /* ⚠ THE DELTA SURVIVES A DECLINE. "Not now" promises the researcher they lose nothing, and
   * without this it quietly cost them the SAFE push: re-saving an unchanged template yields no
   * changed keys, so the only remaining offer is the full overwrite — the one thing the
   * changed-only mode exists to avoid. Pending keys are unioned into every later save's delta and
   * cleared only when they have actually landed on every ticked device. */
  const pending = projectPending(project.folderId);
  /* ⚠ THE RULE, AND IT IS DELIBERATELY THIS SIMPLE (Seth, 2026-08-31: "We can judge 'changes'
   * based on before and after of the template… if it's a first edit, then yes, everything is a
   * change. After that, only things specifically changed count as a change. We don't need to be
   * more sophisticated than that."). So a first template offers BOTH modes too — "only these
   * fields" then means every field the template sets, while leaving anything else on the device
   * alone, which is a real and safer choice than replacing its entire settings. An earlier build
   * offered a first save nothing but the overwrite; Seth's objection was exactly that. */
  const changed = [...new Set([...templateChangedKeys(prevTpl, patch), ...pending])];
  const offerChanges = changed.length > 0;
  const labels = offerChanges ? changedFieldLabels(changed) : [];
  /* Display-only cap: a first template legitimately changes every field, and a note naming thirty
   * of them buries the buttons under it. The COUNT is always exact. */
  const shown = labels.length > 8
    ? `${labels.slice(0, 8).join(', ')} ${t('panel.apply.andMore', { n: labels.length - 8 })}`
    : labels.join(', ');
  let pushing = false, cancelled = false;
  const m = modal(`
    <h3>${esc(t('panel.apply.title', { name: project.name || '' }))}</h3>
    <p class="note">${esc(t('panel.apply.savedNote'))}</p>
    ${offerChanges ? `<p class="note">${esc(t('panel.apply.changedList', { n: labels.length, fields: shown }))}</p>
      <label class="check-label"><input type="radio" name="rp-apply-mode" value="changes" checked> ${esc(t('panel.apply.modeChanges'))}</label>
      <label class="check-label"><input type="radio" name="rp-apply-mode" value="all"> ${esc(t('panel.apply.modeAll'))}</label>`
    : `<p class="note">${esc(t('panel.apply.modeAllOnly'))}</p>`}
    <div class="rp-field"><span>${esc(t('panel.apply.devices'))}</span>
      <label class="check-label"><input type="checkbox" id="rp-apply-all"> ${esc(t('panel.apply.selectAll', { n: targets.length }))}</label>
      <div class="rp-apply-list">${targets.map((it) => `<label class="check-label"><input type="checkbox" class="rp-apply-dev" value="${esc(it.instance_id)}"> ${esc(it.nickname || it.instance_id.slice(0, 8))}</label>`).join('')}</div></div>
    <button class="primary-btn" data-m="apply">${esc(t('panel.apply.push'))}</button>
    <button class="link-btn" data-m="skip">${esc(t('panel.apply.skip'))}</button>`,
    false,
    /* ⚠ CLOSING MID-PUSH MUST ACTUALLY STOP IT. Escape and the backdrop stay live while the loop
     * runs (busy() disables only the button it was given), so without this the modal vanished —
     * reading as "cancelled" — while every remaining device kept being written, and mode "all"
     * replaces a device's ENTIRE settings. The flag is checked before each device, so a close
     * aborts before the next one and the toast says how far it actually got. */
    () => { if (pushing) cancelled = true; });
  const master = m.el.querySelector('#rp-apply-all');
  master.addEventListener('change', () => m.el.querySelectorAll('.rp-apply-dev').forEach((c) => { c.checked = master.checked; }));
  m.el.querySelector('.rp-apply-list').addEventListener('change', () => {
    master.checked = [...m.el.querySelectorAll('.rp-apply-dev')].every((c) => c.checked);
  });
  m.el.querySelector('[data-m="skip"]').onclick = async () => {
    // Mid-push this is a STOP, not a decline: onClose flags the loop, whose own toast reports how
    // far it got. A second toast here would contradict it.
    if (pushing) { m.close(); return; }
    m.close();
    // The whole delta survives a decline — on a first template that is every field, per the rule
    // above; the changed-list note caps its DISPLAY, not what is carried.
    if (changed.length) await savePendingApply(project.folderId, changed);
    deps.toast(t('panel.set.projSaved'), 4000);
  };
  m.el.querySelector('[data-m="apply"]').onclick = (e) => busy(e.target, async () => {
    const sel = [...m.el.querySelectorAll('.rp-apply-dev:checked')].map((c) => c.value);
    /* Never a silently disabled button: with nothing ticked the button SAYS what to tick. */
    if (!sel.length) { deps.toast(t('panel.apply.pickOne'), 5000); return; }
    const mode = offerChanges
      ? ((m.el.querySelector('input[name="rp-apply-mode"]:checked') || {}).value || 'changes') : 'all';
    const byId = new Map(targets.map((it) => [it.instance_id, it]));
    let ok = 0; const failed = [];
    pushing = true;
    for (let i = 0; i < sel.length; i++) {
      if (cancelled) break;                       // the modal was closed — stop before the next device
      const iid = sel[i]; const inst = byId.get(iid);
      e.target.textContent = t('panel.apply.pushing', { i: i + 1, n: sel.length });   // busy() restores the label
      try {
        let toPush = patch;
        if (mode === 'changes') {
          /* Merge base = what the device actually obeys (getInstanceSettings is lane-first), so
           * "only what changed" can never resurrect a stale snapshot underneath the new fields.
           * A key ABSENT from the new patch is deleted, so clearing a template field clears it on
           * the device too. A device with NO settings at all gets the whole template — it would
           * have been born with it (the prefill above). */
          const base = (await Researcher.getInstanceSettings(iid).catch(() => null)) || firstInventorySettings(inst);
          if (base && Object.keys(base).length) {
            toPush = { ...base };
            for (const k of changed) { if (k in patch) toPush[k] = patch[k]; else delete toPush[k]; }
            /* ⚠ appLang IS A ONE-SHOT COMMAND, NOT A SETTING — and the base is the last thing
             * PUSHED, which still carries it. Re-sending it re-runs applyDeviceLang on the device
             * whenever the key is merely PRESENT, so a field worker who set their own language
             * back would have it flipped again by an unrelated consent edit. readForm deletes it
             * at 'follow' for exactly this reason; the merge has to honour the same rule. Only a
             * deliberate language change in THIS save (in `changed` AND in the template) survives. */
            if (!(changed.includes('appLang') && ('appLang' in patch))) delete toPush.appLang;
          }
        }
        /* ⚠ VALIDATE WHAT IS ACTUALLY BEING SENT, per device. Every other push path validates; this
         * one must too, and the merged object is a combination neither form ever showed: the
         * template can tick text consent while THIS device holds a blank message, and the pair
         * rule that exists to stop a blank consent screen would be split across the two. A device
         * that fails is left exactly as it was and named with the reason. */
        const probs = validateDeviceSettings(settingsToRaw(toPush), { parseFolder: deps.parseDriveFolder, uploadIsUrl: true });
        if (probs.length) throw new Error(probs[0].msg);
        await Researcher.changeSettings(iid, toPush);
        ok++;
      } catch (err) {
        failed.push(`${(inst && inst.nickname) || iid.slice(0, 8)} (${(err && err.message) || '?'})`);
      }
    }
    pushing = false;
    /* The delta is only spent when it reached EVERY ticked device: a partial or stopped run keeps
     * it pending so the next save can still offer the safe mode. */
    const clean = !failed.length && !cancelled;
    if (clean) await savePendingApply(project.folderId, []);
    else if (changed.length) await savePendingApply(project.folderId, changed);
    m.close();
    /* Per-device failures leave that device exactly as it was — named, with the retry pointed at
     * (its own Settings), never folded into a success count. */
    if (failed.length) deps.toast(t('panel.apply.partial', { n: ok, names: failed.join('; ') }), 12000);
    else if (cancelled) deps.toast(t('panel.apply.stopped', { n: ok }), 8000);
    else deps.toast(t('panel.apply.done', { n: ok }), 6000);
  });
}

// Pull a device's last-reported settings snapshot (if any) to prefill its editor.
function firstInventorySettings(inst) {
  for (const ins of inst.installs || []) {
    if (ins.inventory && ins.inventory.settings) return ins.inventory.settings;
  }
  return null;
}
