/* ============================================================================================
 * NATIVE AUDIO BRIDGE — THE ONLY FILE IN THIS ENGINE THAT MAY TOUCH A NATIVE GLOBAL
 * (`window.Capacitor` on Android, `window.__flextextNative` on desktop).
 *
 * ⚠ READ THIS BEFORE CHANGING ANYTHING HERE ⚠
 *
 * The Flextext Android apps (rulingAnts/flextext-native) wrap THIS engine in a native shell so
 * recordings can be captured by Android's AudioRecord instead of the browser. That exists for two
 * archival reasons the web genuinely cannot satisfy:
 *   1. the WebView forces an AGC-or-clip dilemma that IASA TC-03 / FADGI forbid on a master;
 *   2. Web Audio is 32-bit-float BY SPECIFICATION, so a web app can never capture at a chosen
 *      integer bit depth — it can only capture float and reduce afterwards.
 *
 * ⚠ THE ENGINE AUTO-UPDATES. THE APK DOES NOT. ⚠
 * A change here that breaks the contract breaks INSTALLED FIELD APPS, with no way to push a fix
 * except building and distributing a new APK. So:
 *   - Do NOT "tidy", inline, or refactor this file while working on unrelated engine features.
 *     If a change elsewhere seems to require editing this file, that is the signal to STOP and
 *     rebuild + re-test the APK (rulingAnts/flextext-native, scripts/build.sh).
 *   - Do NOT reference `window.Capacitor` or `window.__flextextNative` anywhere else in the
 *     engine. A grep hit outside this file is a bug, not a style question.
 *     check-native-containment.sh enforces it.
 *   - Keep this module INERT on the web: every export must be safe to call in a normal browser
 *     and must behave exactly as before the native work existed.
 *
 * The native side of the contract lives in flextext-native/CLAUDE.md and
 * plugin/android/.../FlextextAudioPlugin.java (CONTRACT_VERSION).
 * ============================================================================================ */

// The contract revision this engine speaks. Must match the plugin's CONTRACT_VERSION.
// If they diverge, we refuse the native path and say so loudly rather than misbehave quietly.
const EXPECTED_CONTRACT = 1;

let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn('[flextext native] ' + msg);
}

/** True only inside a Flextext native shell. Always false in a browser/PWA. */
export function isNativeShell() {
  try {
    return typeof window !== 'undefined' && !!window.__NATIVE;
  } catch { return false; }
}

/**
 * The native backend, or null. Never throws.
 *
 * TWO TRANSPORTS, ONE CONTRACT: the Android Capacitor plugin and the desktop preload bridge expose
 * the same method names and return shapes, so everything below this function is platform-agnostic.
 * Adding a platform means adding a line here — not touching any other file.
 */
function plugin() {
  try {
    if (typeof window === 'undefined') return null;
    const cap = window.Capacitor;
    const androidPlugin = cap && cap.Plugins && cap.Plugins.FlextextAudio;
    if (androidPlugin) return androidPlugin;
    return window.__flextextNative || null;      // desktop (Electron) preload bridge
  } catch { return null; }
}

/** Is native capture actually usable right now? Feature-detected, never assumed. */
export function nativeAudioAvailable() {
  return !!(isNativeShell() && plugin());
}

/**
 * Which shell is this engine running in? The panel shows it per device, because each install is a
 * SEPARATE storage sandbox — the PWA, the recorder APK, the editor APK and the desktop app each
 * have their own IndexedDB and their own enrollment, even though several load the same URL. A
 * coworker using two of them legitimately appears as two devices.
 *
 * Returns one of: 'web' | 'android-recorder' | 'android-editor' | 'windows' | 'unknown-native'.
 * Kept HERE rather than in app.js so nothing else has to know how native shells identify
 * themselves — same containment rule as everything else in this file.
 */
export function nativePlatform() {
  try {
    const n = (typeof window !== 'undefined' && window.__NATIVE) || null;
    if (!n) return 'web';
    const rec = (typeof window !== 'undefined' && window.__MODE === 'record');
    if (n === 'android') return rec ? 'android-recorder' : 'android-editor';
    if (n === 'electron') {
      // The shell tells us which OS it is; default to windows since that is the shipped target.
      const os = (window.__flextextNative && window.__flextextNative.os) || '';
      if (os === 'darwin') return 'mac';
      return 'windows';
    }
    return 'unknown-native';
  } catch { return 'web'; }
}

/** Engine build info stamped into the native shell at bundle time (for diagnostics). */
export function nativeEngineInfo() {
  try { return (window.__NATIVE_ENGINE) || null; } catch { return null; }
}

/**
 * Ask the device what it can genuinely capture. Returns null when not native, or when the
 * plugin speaks a different contract version (we refuse rather than guess at field data).
 */
export async function nativeCapabilities() {
  const p = plugin();
  if (!p) return null;
  let caps;
  try {
    caps = await p.capabilities();
  } catch (e) {
    warnOnce('capabilities() failed: ' + (e && e.message));
    return null;
  }
  const got = caps && caps.contractVersion;
  if (got !== EXPECTED_CONTRACT) {
    warnOnce(`contract mismatch — engine expects v${EXPECTED_CONTRACT}, app provides v${got}. `
           + 'Native capture disabled; the installed app needs rebuilding from flextext-native.');
    return null;
  }
  return caps;
}

/** Request the microphone permission through the native prompt. */
export async function nativeRequestMic() {
  const p = plugin();
  if (!p) return false;
  try { const r = await p.requestMicPermission(); return !!(r && r.granted); }
  catch { return false; }
}

/**
 * A capture in progress. Deliberately mirrors the shape the engine already uses for its other
 * backends (start / peak / stop / cancel) so the calling code stays backend-agnostic.
 *
 * Unlike the Web Audio backend, native returns a FINISHED WAV FILE rather than PCM channels —
 * the bytes never pass through JS during capture, which is what keeps a long recording from
 * exhausting memory on a cheap phone.
 */
export class NativeRecorder {
  constructor() {
    this.meta = null;       // provenance from start(): requested vs actual, effects, source
    this._peak = 0;
    this._meterSub = null;
  }

  /* Fold "which microphone" into the archival claim.
   *
   * The native side reports two INDEPENDENT facts and deliberately does not merge them:
   * `archivalClean` means no OS processor was left running, and `routedWireless` means the audio
   * arrived over Bluetooth. Either one alone can make a capture unfit as a preservation master, and
   * a wireless route is the sneakier of the two — the file really is 24-bit/48k, it just contains
   * narrowband compressed audio, so every number in it looks right.
   *
   * Merging happens HERE rather than in the plugin so the native side stays additive: a build that
   * predates routing reports no routed* fields, `wireless` reads as false, and behaviour is
   * unchanged. That is what lets the APK and the engine ship on different schedules. */
  static _normalizeArchival(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const wireless = meta.routedWireless === true;
    if (!wireless) return meta;
    return {
      ...meta,
      archivalClean: false,
      archivalReason: meta.routedNote
        || 'Recorded through a wireless microphone, which compresses the audio before this app '
         + 'receives it. Not archive quality regardless of the bit depth shown.',
    };
  }

  /** opts: { encoding, sampleRate, channels, notificationTitle, notificationText } */
  async start(opts = {}) {
    const p = plugin();
    if (!p) throw new Error('native audio unavailable');
    // The meter must be fed from native: native capture replaces the MediaStream the web
    // AnalyserNode would otherwise read, so there is nothing for the web meter to tap.
    try {
      this._meterSub = await p.addListener('meter', (e) => { this._peak = (e && e.peak) || 0; });
    } catch { /* meter is cosmetic; never fail a recording over it */ }
    this.meta = NativeRecorder._normalizeArchival(await p.start(opts));
    return this.meta;
  }

  /** 0..1, same contract as the Web Audio backend's peak(). */
  peak() { return this._peak; }

  async _removeMeter() {
    try { if (this._meterSub && this._meterSub.remove) await this._meterSub.remove(); }
    catch { /* noop */ }
    this._meterSub = null;
    this._peak = 0;
  }

  /**
   * Finish the capture and ABSORB it: returns { blob, meta }.
   * The file is deleted from the device only after the caller confirms it is stored — see
   * absorbCapture() / releaseCapture() below. We never delete here, because at this point the
   * bytes exist only on disk and losing them would be losing field data.
   */
  async stop() {
    const p = plugin();
    if (!p) throw new Error('native audio unavailable');
    const meta = await p.stop();
    await this._removeMeter();
    const blob = await absorbCapture(meta && meta.path);
    this.meta = { ...(this.meta || {}), ...(meta || {}) };
    return { blob, meta: this.meta };
  }

  /** Abandon the capture; the native side deletes its own partial file. */
  async cancel() {
    const p = plugin();
    await this._removeMeter();
    if (!p) return;
    try { await p.cancel(); } catch { /* noop */ }
  }
}

/**
 * Read a native capture into a Blob.
 *
 * ⚠ Uses convertFileSrc + fetch DELIBERATELY. Do NOT switch this to Filesystem.readFile: that
 * returns base64 (~33% inflation) marshalled through the JS bridge as one enormous string, and a
 * 10-minute 24-bit capture (~86 MB) would very likely exhaust memory on a cheap phone. Going
 * through the WebView's own network stack streams the bytes instead.
 */
export async function absorbCapture(path) {
  if (!path) throw new Error('no capture path');

  // DESKTOP: the page is served from a REMOTE https origin, so it cannot fetch a file:// path the
  // way the Android shell can via convertFileSrc. Read it in chunks over IPC instead — a local
  // HTTP server trips antivirus/firewall prompts, and base64 would inflate an ~86 MB capture by a
  // third as one enormous string. Blob assembly from parts is disk-backed in Chromium, so memory
  // stays flat.
  const p = plugin();
  if (p && typeof p.readChunk === 'function') {
    const CHUNK = 4 * 1024 * 1024;
    const parts = [];
    for (let offset = 0; ; offset += CHUNK) {
      const r = await p.readChunk(path, offset, CHUNK);
      const bytes = r && r.bytes;
      if (!bytes || !bytes.byteLength) break;
      parts.push(bytes);
      if (bytes.byteLength < CHUNK) break;      // short read = end of file
    }
    return new Blob(parts, { type: 'audio/wav' });
  }

  // ANDROID: stream through the WebView's own network stack.
  let url = path;
  try {
    const cap = window.Capacitor;
    if (cap && typeof cap.convertFileSrc === 'function') url = cap.convertFileSrc(path);
  } catch { /* fall through to the raw path */ }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('could not read capture (HTTP ' + resp.status + ')');
  return await resp.blob();
}

/**
 * Delete a capture from the device. Call this ONLY once the bytes are safely stored
 * (IndexedDB write resolved) — never before.
 */
export async function releaseCapture(path) {
  const p = plugin();
  if (!p || !path) return false;
  try { const r = await p.deleteCapture({ path }); return !!(r && r.deleted); }
  catch { return false; }
}

/**
 * Sweep captures orphaned by a crash or an OEM process-kill between "file written" and "stored".
 * `keepPaths` are the paths the engine still holds; everything else in the capture directory is
 * garbage. Native never sweeps on its own — only this side knows what was really absorbed.
 */
export async function sweepOrphanCaptures(keepPaths = []) {
  const p = plugin();
  if (!p) return { deleted: 0, bytesFreed: 0 };
  try { return await p.cleanupCaptures({ keep: keepPaths }); }
  catch { return { deleted: 0, bytesFreed: 0 }; }
}

/** What is actually sitting in the capture directory (diagnostics + sweep planning). */
export async function listNativeCaptures() {
  const p = plugin();
  if (!p) return [];
  try { const r = await p.listCaptures(); return (r && r.captures) || []; }
  catch { return []; }
}
