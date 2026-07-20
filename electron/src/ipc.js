/* The audio IPC surface, extracted so it can be registered by main.js AND exercised directly by
 * tests. Keeping it here means a test drives the REAL wiring rather than a copy that can drift.
 *
 * Every channel maps 1:1 to a named audio.js function. There is deliberately no generic
 * "invoke anything" channel — the renderer loads REMOTE content, so a generic bridge would hand
 * the page arbitrary IPC. */
const { ipcMain } = require('electron');
const audio = require('./audio');

function registerAudioIpc(getWindow) {
  const send = (channel, payload) => {
    const w = getWindow && getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  ipcMain.handle('flextext-audio:capabilities', () => audio.capabilities());
  ipcMain.handle('flextext-audio:requestMicPermission', () => ({ granted: true }));
  ipcMain.handle('flextext-audio:start', (_e, opts) =>
    audio.start(opts, (peak) => send('flextext-audio:meter', { peak })));
  ipcMain.handle('flextext-audio:stop', () => audio.stop());
  ipcMain.handle('flextext-audio:cancel', () => audio.cancel());
  ipcMain.handle('flextext-audio:deleteCapture', (_e, a) => audio.deleteCapture((a || {}).path));
  ipcMain.handle('flextext-audio:listCaptures', () => audio.listCaptures());
  ipcMain.handle('flextext-audio:cleanupCaptures', (_e, a) => audio.cleanupCaptures((a || {}).keep));
  ipcMain.handle('flextext-audio:readChunk', (_e, a) =>
    audio.readChunk((a || {}).path, (a || {}).offset, (a || {}).length));
}

module.exports = { registerAudioIpc };
