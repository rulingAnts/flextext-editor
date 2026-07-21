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

  // The default application menu carries View -> Toggle Developer Tools. devTools:false already
  // refuses to open it, but leaving a menu item that silently does nothing looks like a broken app,
  // so the menu goes too. A test build keeps the normal menu.
  if (!DEVTOOLS) Menu.setApplicationMenu(null);

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

  win.loadURL(APP_URL).catch(() => showOfflineNotice());

  // First launch NEEDS the network (afterwards the service worker serves it). Say so in plain
  // words rather than showing a blank window, which is what a field user would otherwise get.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) showOfflineNotice(desc);
  });
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { audio.cancel().catch(() => {}); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
