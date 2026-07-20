/* ============================================================================================
 * Preload — the ONLY surface the remote page can see.
 *
 * ⚠ We load REMOTE content (the live PWA) into a shell that can touch the microphone and the
 * filesystem. So this file is a security boundary, not a convenience layer:
 *   - expose ONLY the audio contract. No `fs`, no `shell`, no `child_process`, no generic
 *     `ipcRenderer.invoke` passthrough — a generic bridge would hand the page arbitrary IPC.
 *   - every method here maps to one named, validated handler in main.js.
 *
 * The method names and return shapes mirror the Android FlextextAudioPlugin exactly, so
 * docs/js/native-audio.js can treat Capacitor and Electron as one contract with two transports.
 * If you change the shape here, bump CONTRACT_VERSION in BOTH places — the web engine
 * auto-updates while this shell does NOT, so a silent divergence breaks installed desktop apps
 * with no way to push a fix except a new installer.
 * ============================================================================================ */

const { contextBridge, ipcRenderer } = require('electron');

// Must match EXPECTED_CONTRACT in docs/js/native-audio.js and CONTRACT_VERSION in the Android plugin.
const CONTRACT_VERSION = 1;

const meterListeners = new Set();
ipcRenderer.on('flextext-audio:meter', (_e, payload) => {
  for (const fn of meterListeners) { try { fn(payload); } catch { /* a bad listener must not kill capture */ } }
});

contextBridge.exposeInMainWorld('__flextextNative', {
  platform: 'electron',
  // Which desktop OS. The engine's chokepoint reads this to report the device accurately
  // in the researcher panel (windows vs mac) — capabilities() is async and too late for that.
  os: process.platform,
  contractVersion: CONTRACT_VERSION,

  capabilities: () => ipcRenderer.invoke('flextext-audio:capabilities'),
  requestMicPermission: () => ipcRenderer.invoke('flextext-audio:requestMicPermission'),
  start: (opts) => ipcRenderer.invoke('flextext-audio:start', opts || {}),
  stop: () => ipcRenderer.invoke('flextext-audio:stop'),
  cancel: () => ipcRenderer.invoke('flextext-audio:cancel'),

  deleteCapture: (args) => ipcRenderer.invoke('flextext-audio:deleteCapture', args || {}),
  listCaptures: () => ipcRenderer.invoke('flextext-audio:listCaptures'),
  cleanupCaptures: (args) => ipcRenderer.invoke('flextext-audio:cleanupCaptures', args || {}),

  // Chunked read of a finished capture. The renderer is on a REMOTE https origin, so it cannot
  // fetch a file:// path the way the Android shell can via convertFileSrc. Chunked IPC avoids
  // both a local HTTP server (antivirus/firewall prompts) and base64 (a third larger, and an
  // ~86 MB capture would be a single enormous string).
  readChunk: (path, offset, length) =>
    ipcRenderer.invoke('flextext-audio:readChunk', { path, offset, length }),

  addListener: (event, fn) => {
    if (event !== 'meter' || typeof fn !== 'function') return { remove() {} };
    meterListeners.add(fn);
    return { remove() { meterListeners.delete(fn); } };
  },
});

// Marks this as a Flextext native shell. The engine's chokepoint reads it; nothing else should.
contextBridge.exposeInMainWorld('__NATIVE', 'electron');
