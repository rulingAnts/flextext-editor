/* ============================================================================================
 * Flextext desktop shell — main process.
 *
 * ⚠ THIS SHELL EXISTS FOR ONE REASON: archive-quality audio capture.
 *
 * The Web Audio API is 32-bit float BY SPECIFICATION, so a browser can never capture at a chosen
 * integer bit depth — only capture float and reduce afterwards. Native capture can. That is the
 * whole justification; everything else the app does stays in the web engine.
 *
 * ⚠ KEEP THIS SHELL DUMB — it is what makes a ~200 MB download acceptable.
 * The shell is downloaded ONCE and rebuilt RARELY. Engine changes (UI, i18n, upload, consent,
 * settings) reach users for free through the service worker, because we load the LIVE site. The
 * moment shell-requiring features creep in, every release becomes a large redownload over a poor
 * connection and that trade collapses. If a feature seems to need shell code, check whether the
 * engine can do it instead.
 *
 * The shell's entire job:
 *   1. open a window at the configured origin,
 *   2. refuse to navigate anywhere else,
 *   3. expose the audio contract (and nothing else),
 *   4. update itself rarely.
 * ============================================================================================ */

const { app, BrowserWindow, shell, session, Menu } = require('electron');
const path = require('node:path');
const audio = require('./audio');
const { registerAudioIpc } = require('./ipc');

// Configurable, never hard-coded: moving off GitHub Pages would otherwise orphan every install.
const APP_URL = process.env.FLEXTEXT_URL || 'https://rulingants.github.io/flextext-editor/';
const APP_ORIGIN = new URL(APP_URL).origin;

/* DEVELOPER TOOLS — off unless this build was made as a TEST build.
 *
 * Why off in a release: the renderer runs REMOTE content with a native bridge attached. DevTools is
 * a console with that bridge in scope, and the people using this app cannot judge what is safe to
 * paste into one — "run this to fix your problem" is a plausible thing for a stranger to say. It
 * also lets a curious user break their own install in ways nobody can diagnose from a village.
 *
 * Why on in a test build: while proving the Windows capture path, being able to read the console is
 * worth far more than the risk, and the audience is Seth.
 *
 * The flag is written at BUILD time (see .github/workflows/build-desktop.yml). Missing or malformed
 * means OFF — a release must never gain devtools by accident, so the failure direction is closed.
 * FLEXTEXT_DEVTOOLS=1 in the environment also enables it, for running from source.
 */
const { devToolsAllowed } = require('./flags');
const log = require('./log');
const DEVTOOLS = devToolsAllowed();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Non-negotiable: we load REMOTE content, so the renderer gets no Node and no shared context.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Blocks the shortcut, the context menu item, and any programmatic open — not just the menu.
      devTools: DEVTOOLS,
    },
  });

  win.once('ready-to-show', () => win.show());

  // EVERYTHING DEVTOOLS WOULD HAVE SHOWN, written to a file instead. The engine logs its failures
  // at console.error (native capture, audio playback), so this is the channel that answers "why did
  // recording fail on that laptop" without anyone opening a console.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return;                       // warnings and errors only; info would drown it
    log[level >= 3 ? 'error' : 'warn'](`renderer: ${message}`, `(${sourceId}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => log.error('renderer gone', details));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log.error('load failed', { code, desc, url }));

  // The default application menu carries View -> Toggle Developer Tools. devTools:false already
  // refuses to open it, but leaving a menu item that silently does nothing looks like a broken app,
  // so the menu goes too. A test build keeps the normal menu.
  // A CURATED menu rather than none. The default menu exposes Developer Tools, which a field build
  // must not; but removing the menu entirely also removes the only route to the diagnostics log,
  // which is the thing that actually helps when something breaks on a machine nobody can inspect.
  buildMenu();

  // The microphone permission prompt has no meaning here — the user already granted it to the app
  // at OS level, and capture runs natively, not through getUserMedia. Grant media, refuse the rest.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });

  // NAVIGATION LOCK. Remote content + a native bridge means anything that can navigate the window
  // off-origin could reach our IPC. Everything external opens in the real browser instead.
  const sameOrigin = (u) => { try { return new URL(u).origin === APP_ORIGIN; } catch { return false; } };
  win.webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  // Chromium enumerates devices independently of ffmpeg. Comparing the two is what separates "this
  // machine has no working microphone" from "our dshow parser is broken" — the single question the
  // first Windows report could not answer.
  win.webContents.once('did-finish-load', async () => {
    try {
      const seen = await win.webContents.executeJavaScript(
        `navigator.mediaDevices.enumerateDevices()
           .then(ds => ds.filter(d => d.kind === 'audioinput').map(d => d.label || '(unlabelled)'))
           .catch(e => ['ERROR: ' + e.name])`);
      log.info('chromium audio inputs', { count: seen.length, labels: seen });
      if (!seen.length) {
        log.error('CHROMIUM ALSO SEES NO MICROPHONE. Both enumerations are independent, so this '
                + 'points at the machine (no input device, a disabled device, or a driver), not at '
                + 'our device-name parsing.');
      }
    } catch (e) { log.warn('could not enumerate from the renderer', String(e && e.message)); }
  });

  win.loadURL(APP_URL).catch(() => showOfflineNotice());

  // First launch NEEDS the network (afterwards the service worker serves it). Say so in plain
  // words rather than showing a blank window, which is what a field user would otherwise get.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) showOfflineNotice(desc);
  });
}

function buildMenu() {
  const items = [
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
    { type: 'separator' },
    {
      // The point of the whole file: a field user can be asked for this over a message, with no
      // console, no screen share, and no technical vocabulary.
      label: 'Open diagnostics log…',
      click: async () => {
        const p = log.path();
        if (!p) return;
        try { await shell.showItemInFolder(p); } catch { /* nothing more we can do */ }
      },
    },
  ];
  if (DEVTOOLS) {
    items.push({ type: 'separator' },
      { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Shift+I',
        click: () => win && win.webContents.openDevTools({ mode: 'detach' }) });
  }
  items.push({ type: 'separator' }, { role: 'quit' });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Flextext', submenu: items },
    { label: 'Edit', submenu: [
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
  ]));
}

function showOfflineNotice(detail = '') {
  const html = `<!doctype html><meta charset="utf-8">
    <style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;
      height:100vh;background:#f4f6f9;color:#1a1d21;text-align:center;padding:24px}
      div{max-width:34em}h1{font-size:20px;margin:0 0 12px}code{font-size:12px;color:#5b6470}</style>
    <div><h1>Cannot reach the Flextext server</h1>
    <p>This app needs an internet connection <b>the first time it runs</b>. After that it works
    offline.</p><p>Check the connection and start the app again.</p>
    <p><code>${String(detail || '').replace(/[<&]/g, '')}</code></p></div>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

/* ---------------- the audio contract (the ONLY thing exposed to the renderer) ----------------
 * Method names and return shapes deliberately mirror the Android FlextextAudioPlugin, so the web
 * chokepoint (docs/js/native-audio.js) can treat both backends identically. */

registerAudioIpc(() => win);

app.whenReady().then(async () => {
  log.init(app.getPath('userData'));
  log.info('--- start ---', {
    app: app.getVersion(), electron: process.versions.electron,
    platform: process.platform, arch: process.arch, devTools: DEVTOOLS, url: APP_URL,
  });
  // Probe the capture chain AT STARTUP, so the log already answers the first question asked when a
  // machine cannot record: was ffmpeg found, and did it see any microphone at all?
  try {
    const caps = await audio.capabilities();
    // WHICH ffmpeg, stated first and unambiguously. A packaged app falling back to PATH is a
    // PACKAGING BUG that a developer machine hides, because installing ffmpeg to investigate makes
    // the symptom disappear while the cause ships to every field laptop.
    const ff = caps.ffmpeg || {};
    log.info('ffmpeg', {
      source: ff.source, path: ff.path, working: ff.working, version: ff.version,
      bundledPath: ff.bundledPath, bundledExists: ff.bundledExists, resourcesPath: ff.resourcesPath,
    });
    if (ff.source && ff.source !== 'bundled') {
      log.error(`⚠ NOT USING THE BUNDLED FFMPEG — resolved via ${ff.source}. The packaged binary was `
              + `expected at ${ff.bundledPath} and ${ff.bundledExists ? 'exists' : 'IS MISSING'}. `
              + 'A field machine has no ffmpeg on PATH, so this build would fail there even if it '
              + 'works here.');
    }
    log.info('audio capabilities', {
      probed: caps.probed, error: caps.error || null,
      deviceCount: (caps.devices || []).length,
      devices: (caps.devices || []).map((d) => d.name),
    });
    if (caps.error) log.error('NATIVE CAPTURE UNAVAILABLE:', caps.error, caps.note || '');
    else if (!(caps.devices || []).length) {
      log.error('NATIVE CAPTURE FOUND NO MICROPHONE.');
      // The decisive evidence: an unmatched regex and a machine with no microphone produce an
      // IDENTICAL empty list. The raw text distinguishes them, and one is a five-minute fix.
      log.error('ffmpeg raw enumeration output follows >>>');
      log.error(audio.lastEnumerationOutput() || '(ffmpeg produced no output at all)');
      log.error('<<< end raw enumeration output');
    }
  } catch (e) { log.error('capabilities threw', String(e && e.message)); }
  createWindow();
});

process.on('uncaughtException', (e) => log.error('uncaught', String(e && e.stack || e)));
app.on('window-all-closed', () => { audio.cancel().catch(() => {}); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
