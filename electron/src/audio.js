/* ============================================================================================
 * Native audio capture for the desktop shell.
 *
 * WHY NOT getUserMedia: the renderer is Chromium, so it has exactly the limits we are escaping —
 * Web Audio is 32-bit float by specification, so it can never capture at a chosen integer bit
 * depth. Capture therefore runs here, in the main process.
 *
 * WHY ffmpeg: it is on every platform we care about (dshow on Windows, avfoundation on macOS),
 * enumerates real device names, writes WAV directly at an exact PCM format, and needs no native
 * addon to compile or distribute. A PortAudio addon would be lighter but adds per-platform
 * prebuild risk for no benefit we need.
 *
 * ⚠ HONESTY GAP — READ BEFORE TRUSTING A DESKTOP RECORDING FOR ARCHIVE USE.
 * On Android we PROVE what a device can capture by really opening an AudioRecord, and refuse to
 * fabricate a depth the hardware cannot produce. ffmpeg does NOT behave that way: ask it for
 * 24-bit from a 16-bit interface and it will happily hand you a 24-bit file containing 16 bits of
 * real information. So this module reports `probed: false` and `verifiedDepth: false`, and the
 * capture result carries `depthVerified: false`. Until per-device format probing lands
 * (`-list_options` on dshow exposes it; avfoundation does not), a desktop capture must be
 * described as "written at N-bit", never "captured at N-bit".
 * ============================================================================================ */

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

const CONTRACT_VERSION = 1;

// Captures live in the app's own data dir — we own them and are responsible for cleaning up.
function captureDir() {
  const d = path.join(app.getPath('userData'), 'captures');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function ffmpegPath() {
  // A bundled binary wins (that is how a shipped installer will work); otherwise fall back to PATH
  // so a developer machine works with no extra setup.
  const bundled = path.join(process.resourcesPath || '', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  if (fs.existsSync(bundled)) return bundled;
  return process.env.FLEXTEXT_FFMPEG || 'ffmpeg';
}

const IS_WIN = process.platform === 'win32';
const INPUT_FORMAT = IS_WIN ? 'dshow' : 'avfoundation';

// Encoding ids shared with the engine + the Android plugin. int vs float is kept explicit:
// pcm32 and float32 are both 32 bits wide but are NOT the same thing to an archive.
const CODEC = { pcm16: 'pcm_s16le', pcm24: 'pcm_s24le', pcm32: 'pcm_s32le', float32: 'pcm_f32le' };
const BITS = { pcm16: 16, pcm24: 24, pcm32: 32, float32: 32 };
const LABEL = {
  pcm16: '16-bit WAV', pcm24: '24-bit WAV',
  pcm32: '32-bit WAV (integer)', float32: '32-bit float WAV',
};

function run(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });   // ffmpeg lists devices on stderr
    });
  });
}

// Enumerating devices means running ffmpeg and parsing its output — over a second on macOS. That is
// fine when the settings screen opens, but not on the record button, so the result is cached briefly.
// The TTL is short because a USB interface can be plugged in at any moment and must still show up.
let lastEnumerationOutput = '';
let deviceCache = { at: 0, list: null };
const DEVICE_TTL_MS = 30000;

async function listDevices(useCache = false) {
  if (useCache && deviceCache.list && Date.now() - deviceCache.at < DEVICE_TTL_MS) {
    return deviceCache.list;
  }
  const list = await listDevicesUncached();
  deviceCache = { at: Date.now(), list };
  return list;
}

/** Real input devices, with their platform-specific selector string. */
async function listDevicesUncached() {
  const ff = ffmpegPath();
  const args = IS_WIN
    ? ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']
    : ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
  const { stderr } = await run(ff, args);
  const out = [];
  // Kept so the caller can log ffmpeg's RAW output when parsing yields nothing. The dshow branch
  // below has never run outside CI, and a regex that fails to match produces exactly the same empty
  // list as a machine with no microphone. Without the raw text those two are indistinguishable from
  // a log file, and one is a five-minute fix while the other is a hardware problem.
  lastEnumerationOutput = stderr;
  if (IS_WIN) {
    // ... "Microphone (Realtek)" (audio)
    const re = /"([^"]+)"\s*\(audio\)/g;
    let m; while ((m = re.exec(stderr))) out.push({ id: `audio=${m[1]}`, name: m[1] });
  } else {
    // AVFoundation audio devices are listed after the video block: [0] MacBook Pro Microphone
    const audioBlock = stderr.split(/AVFoundation audio devices:/)[1] || '';
    const re = /\[(\d+)\]\s+(.+)/g;
    let m; while ((m = re.exec(audioBlock))) out.push({ id: `:${m[1]}`, name: m[2].trim() });
  }
  return out.map((d) => ({ ...d, ...classify(d.name) })).sort((a, b) => b.rank - a.rank);
}

/* Rank inputs by how defensible a recording from them would be.
 *
 * ⚠ NEVER just take the first device the OS lists. On a Mac with a paired iPhone, Continuity puts
 * "<name>'s iPhone Microphone" FIRST — so the obvious default would record over a wireless, heavily
 * processed phone link and write it into a file labelled 24-bit. The file would look archival and
 * not be, which is the precise mislabelling this whole project exists to prevent. Windows has the
 * same trap with webcam and virtual-cable mics.
 *
 * `wireless` is the load-bearing field: it does not merely lose the ranking, it is reported to the
 * user and marks the capture as non-archival. We still RECORD over it — refusing would strand a
 * field worker mid-session, which is a worse outcome than a quality note — we just never let the
 * label outrun the source. */
/* Desktop input categories -> the shared vocabulary the Android plugin uses, so the engine can
 * render both without knowing which platform it is on. 'virtual' has no Android equivalent (a phone
 * has no loopback devices), so it is desktop-only and the engine must tolerate it. */
const DEVICE_TYPE = {
  interface: 'usb_device',
  builtin: 'builtin_mic',
  wireless: 'bluetooth_sco',
  virtual: 'virtual',
  unknown: 'unknown',
};

function classify(name) {
  const n = String(name).toLowerCase();
  // Wireless/relayed inputs: compressed, processed, and not an archival source at any bit depth.
  if (/iphone|ipad|continuity|bluetooth|airpod|handsfree|hands-free/.test(n)) {
    return { rank: 0, wireless: true, kind: 'wireless',
             note: 'Wireless or relayed microphone — compressed and processed. Not archive quality.' };
  }
  // Virtual/loopback devices capture other software, not a room. Never a field recording.
  if (/blackhole|soundflower|virtual|aggregate|loopback|vb-audio|voicemeeter|stereo mix|teams|zoom/.test(n)) {
    return { rank: 1, wireless: false, kind: 'virtual',
             note: 'Virtual audio device — records other software, not a microphone.' };
  }
  // A real interface is what archival fieldwork actually uses.
  if (/usb|scarlett|focusrite|zoom h|tascam|rode|røde|behringer|audio.?box|interface|xlr/.test(n)) {
    return { rank: 4, wireless: false, kind: 'interface', note: null };
  }
  if (/built.?in|internal|macbook|realtek|microphone array/.test(n)) {
    return { rank: 3, wireless: false, kind: 'builtin', note: null };
  }
  return { rank: 2, wireless: false, kind: 'unknown', note: null };
}

async function capabilities() {
  const ff = ffmpegPath();
  const probe = await run(ff, ['-hide_banner', '-version'], 8000);
  const haveFfmpeg = !probe.err;

  if (!haveFfmpeg) {
    // Be explicit rather than pretending: the engine will fall back to browser capture.
    return {
      platform: 'electron', contractVersion: CONTRACT_VERSION, probed: false,
      os: process.platform, device: os.hostname(), encodings: [], devices: [],
      error: 'ffmpeg_not_found',
      note: 'Native capture unavailable — ffmpeg was not found. The app will use browser capture.',
    };
  }

  const devices = await listDevices();
  // NOTE: not proven per-device (see the HONESTY GAP at the top). These are the formats we can
  // ASK for; whether the hardware truly delivers that depth is not yet verified on desktop.
  const encodings = Object.keys(CODEC).map((id) => ({
    id, bits: BITS[id], float: id === 'float32', label: LABEL[id],
    rates: [44100, 48000, 96000], stereo: true,
  }));

  return {
    platform: 'electron',
    contractVersion: CONTRACT_VERSION,
    os: process.platform,
    device: os.hostname(),
    devices,
    encodings,
    recommended: { encoding: 'pcm24', sampleRate: 48000, channels: 1, label: LABEL.pcm24 },
    permission: 'granted',          // desktop grants at OS level, not per page
    probed: true,
    verifiedDepth: false,           // ⚠ ffmpeg will pad rather than refuse — see header
    unprocessedSupported: null,     // no desktop equivalent of Android's UNPROCESSED flag
    note: 'Desktop capture does not yet verify that the hardware truly delivers the requested bit '
        + 'depth. Describe results as "written at N-bit", not "captured at N-bit".',
  };
}

let active = null;   // { proc, file, meta, onPeak }

async function start(opts = {}, onPeak) {
  if (active) throw new Error('already_recording');
  const encoding = CODEC[opts.encoding] ? opts.encoding : 'pcm24';
  const sampleRate = parseInt(opts.sampleRate, 10) || 48000;
  const channels = opts.channels === 2 ? 2 : 1;

  const devices = await listDevices(true);   // cached — the record button must not wait on ffmpeg
  if (!devices.length) throw new Error('no_input_device');
  // Default = the system's first input; the researcher may pin a specific one.
  const dev = (opts.deviceId && devices.find((d) => d.id === opts.deviceId)) || devices[0];

  const file = path.join(captureDir(), `flextext-${Date.now()}.wav`);
  const args = [
    '-hide_banner', '-nostdin',
    // Write through instead of buffering. Without this the file stays empty for SECONDS and then
    // lands in one burst, so "the file has bytes" would mean "ffmpeg flushed", not "the mic is
    // live" — measured 2.9s of audio already captured before the first flush appeared. We use file
    // growth to decide when the record indicator turns on, so it has to track reality.
    '-flush_packets', '1',
    '-f', INPUT_FORMAT, '-i', dev.id,
    '-ac', String(channels), '-ar', String(sampleRate),
    '-c:a', CODEC[encoding],
    // Peak level for the meter: the web meter cannot see a native stream, so ffmpeg reports it.
    '-af', 'astats=metadata=1:reset=1:length=0.1',
    '-f', 'wav', file,
  ];

  const proc = spawn(ffmpegPath(), args, { windowsHide: true });
  let peak = 0;
  proc.stderr.on('data', (buf) => {
    // astats prints "Peak level dB: -12.3" per window; convert to the 0..1 the meter expects.
    const m = String(buf).match(/Peak level dB:\s*(-?[\d.]+|-inf)/);
    if (!m) return;
    peak = m[1] === '-inf' ? 0 : Math.min(1, Math.pow(10, parseFloat(m[1]) / 20));
    if (onPeak) onPeak(peak);
  });

  // ⚠ DO NOT REPORT "RECORDING" UNTIL THE INTERFACE IS REALLY LIVE.
  //
  // Measured on macOS/avfoundation, and the numbers matter because the first guess was wrong:
  //   - ffmpeg needs ~1.5-2.5s to open the input. Originally everything in that window was simply
  //     ABSENT from the file (3s requested -> 1.46s captured): a user who pressed record and spoke
  //     immediately lost the start of the take, and the file looked perfectly fine afterwards.
  //   - `-flush_packets 1` (above) fixed that. Capture now runs from spawn and the duration tracks
  //     wall time, so nothing is dropped.
  //
  // What remains is PRE-ROLL, not loss: the file starts slightly before the indicator does. That is
  // the right way round for an archive — better a little room tone at the head than a clipped first
  // word — so we keep it and record how much there was, rather than trimming. Trimming would mean
  // deleting captured audio on a guess about where speech began.
  //
  // start() therefore resolves once bytes are genuinely landing, so the record indicator means what
  // it says, and `armMs` reports how long that took.
  const armFrom = Date.now();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; clearInterval(t); err ? reject(err) : resolve(); };
    proc.once('error', done);
    proc.once('close', (code) => done(new Error('ffmpeg exited before capture started (code ' + code + ')')));
    const t = setInterval(() => {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* not created yet */ }
      if (size > 1024) return done();                       // real audio past the header
      if (Date.now() > deadline) done(new Error('capture_did_not_start'));
    }, 50);
  });

  active = {
    proc, file, onPeak,
    meta: {
      encoding, sampleRate, channels,
      bits: BITS[encoding], float: encoding === 'float32', label: LABEL[encoding],
      device: dev.name, deviceId: dev.id,
      /* ⚠ ONE CONTRACT, TWO TRANSPORTS — these field NAMES are shared with the Android plugin.
       *
       * They diverged once: this shell reported device/deviceKind/archival while the Android plugin
       * reported routedDevice/routedType/archivalClean, so the engine's describeCapture() — written
       * against the Android names — silently found nothing here and the desktop showed a recording
       * with no microphone at all. Nothing errored; the information just vanished. Both sides must
       * use the SAME names or the engine has to special-case a platform, which is exactly what the
       * chokepoint exists to prevent. */
      routedDevice: dev.name,
      routedType: DEVICE_TYPE[dev.kind] || 'unknown',
      routedWireless: !!dev.wireless,
      routedNote: dev.note || null,
      archivalClean: !dev.wireless && dev.kind !== 'virtual',
      archivalReason: dev.note || null,
      requested: { encoding: opts.encoding || encoding, sampleRate: opts.sampleRate || sampleRate, label: LABEL[opts.encoding] || LABEL[encoding] },
      substituted: false, substitutionReason: null,
      depthVerified: false,          // see the HONESTY GAP
      unprocessedSource: null,
      // How long the interface took to go live. Surfaced so a slow or flaky device shows up as a
      // number in the researcher panel instead of only as a user complaining the button is sluggish.
      armMs: Date.now() - armFrom,
      startedAt: Date.now(),
    },
  };
  return { ...active.meta };
}

function stopProc(proc) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once('close', finish);
    try { proc.stdin.write('q'); proc.stdin.end(); } catch { /* fall through to signal */ }
    setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 1500);
    setTimeout(finish, 5000);   // never hang the UI on a stuck encoder
  });
}

async function stop() {
  if (!active) throw new Error('not_recording');
  const { proc, file, meta } = active;
  active = null;
  await stopProc(proc);

  let bytes = 0;
  try { bytes = (await fsp.stat(file)).size; } catch { throw new Error('capture_file_missing'); }
  const bytesPerFrame = (meta.bits / 8) * meta.channels;
  const frames = Math.max(0, Math.floor((bytes - 44) / bytesPerFrame));

  return {
    ...meta,
    path: file, bytes, frames,
    durationSec: meta.sampleRate ? frames / meta.sampleRate : 0,
  };
}

async function cancel() {
  if (!active) return { cancelled: false };
  const { proc, file } = active;
  active = null;
  await stopProc(proc);
  try { await fsp.unlink(file); } catch { /* already gone */ }
  return { cancelled: true };
}

/* ---------------- capture-file lifecycle: ABSORB, THEN DELETE ----------------
 * Identical rule to Android. The web layer reads the bytes into IndexedDB and only then asks us to
 * delete. We never delete on our own: only that side knows what was really stored, and guessing
 * here would destroy field data. */

function insideCaptureDir(p) {
  const dir = path.resolve(captureDir());
  const target = path.resolve(p || '');
  return target.startsWith(dir + path.sep);
}

async function readChunk(p, offset, length) {
  if (!insideCaptureDir(p)) throw new Error('path_outside_capture_dir');
  const fh = await fsp.open(p, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, length | 0));
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset | 0);
    // Uint8Array survives structured clone to the renderer without a base64 round-trip.
    return { bytes: new Uint8Array(buf.subarray(0, bytesRead)), bytesRead };
  } finally { await fh.close(); }
}

async function deleteCapture(p) {
  if (!insideCaptureDir(p)) throw new Error('path_outside_capture_dir');
  if (active && path.resolve(active.file) === path.resolve(p)) throw new Error('still_recording_this_file');
  try { await fsp.unlink(p); return { deleted: true }; } catch { return { deleted: false }; }
}

async function listCaptures() {
  const dir = captureDir();
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return { dir, captures: [] }; }
  const captures = [];
  for (const n of names) {
    const full = path.join(dir, n);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
      captures.push({
        path: full, bytes: st.size, modified: st.mtimeMs,
        active: !!(active && path.resolve(active.file) === path.resolve(full)),
      });
    } catch { /* vanished mid-scan */ }
  }
  return { dir, captures };
}

/** Delete everything EXCEPT the paths the web layer says it still needs (and the live capture). */
async function cleanupCaptures(keep = []) {
  const keepSet = new Set((keep || []).map((k) => path.resolve(k)));
  const { captures } = await listCaptures();
  let deleted = 0, bytesFreed = 0;
  for (const c of captures) {
    if (keepSet.has(path.resolve(c.path)) || c.active) continue;
    try { await fsp.unlink(c.path); deleted++; bytesFreed += c.bytes; } catch { /* ignore */ }
  }
  return { deleted, bytesFreed };
}

module.exports = {
  lastEnumerationOutput: () => lastEnumerationOutput,
  capabilities, start, stop, cancel,
  readChunk, deleteCapture, listCaptures, cleanupCaptures,
};
