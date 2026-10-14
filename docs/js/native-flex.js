/* ============================================================================================
 * FLEx SHELL BRIDGE — THE ONLY FILE IN THIS ENGINE THAT MAY TOUCH `window.pywebview`
 *
 * ⚠ READ THIS BEFORE CHANGING ANYTHING HERE ⚠
 *
 * The FlexText Segmenter for FLEx (desktop/, a Windows pywebview shell — plans/flex-desktop-segmenter.md)
 * runs THIS engine from http://127.0.0.1:<port>/ and adds the FLEx features that only make sense beside
 * a local FieldWorks install. pywebview injects `window.pywebview.api` asynchronously and fires
 * `pywebviewready`; every method on it is async and answers {ok, result} or {ok: false, error}.
 *
 * ⚠ THE ENGINE AUTO-UPDATES. THE SHELL DOES NOT. ⚠
 * A shell build pins ONE engine, but the same engine source also ships to the web, so:
 *   - Do NOT reference `window.pywebview` anywhere else in the engine. A grep hit outside this file
 *     is a bug, not a style question. check-native-containment.sh (rule 1c) enforces it.
 *   - Keep this module INERT on the web: every export is safe to call in a normal browser.
 *     isFlexShell() is false there, flex.* calls reject with E_NOT_SHELL, and the engine shows FLEx
 *     menus and buttons ONLY when isFlexShell() is true AND the contract matches.
 *   - This is a SECOND chokepoint, separate from native-audio.js on purpose: that file's header
 *     forbids touching it for unrelated work, because installed APKs depend on it.
 *
 * The Python side of the contract is desktop/flexshell/api.py (FLEX_CONTRACT in desktop/flexshell/__init__.py).
 * ============================================================================================ */

// The bridge contract this engine speaks. Must equal FLEX_CONTRACT in desktop/flexshell/__init__.py.
// On a mismatch the seam refuses every FLEx feature and says so, rather than misbehave quietly.
const EXPECTED_FLEX_CONTRACT = 1;

let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn('[flextext flex-shell] ' + msg);
}

/* The injected bridge object, or null. Never throws. Only this function reads the global. */
function bridge() {
  try {
    if (typeof window === 'undefined') return null;
    const pw = window.pywebview;
    return (pw && pw.api) ? pw.api : null;
  } catch { return null; }
}

/* True when THIS PAGE was served by the FLEx shell: its staging step stamps the shell page with
 * <meta name="flextext-flex-shell"> (desktop/build/stage_engine.py), readable synchronously before
 * pywebview has injected the bridge. It says where the page came from, not that FLEx is reachable —
 * isFlexShell() below is that. Used for the choices that must be made at module load: the shell's
 * 127.0.0.1 origin is NOT a developer's localhost (app.js isLocalDev), so the engine talks to the
 * production relay worker as an installed app would. */
export function isFlexShellPage() {
  try {
    if (typeof document === 'undefined') return false;
    const m = document.querySelector('meta[name="flextext-flex-shell"]');
    return !!(m && m.getAttribute('content') === '1');
  } catch { return false; }
}

/* True only inside the FLEx shell: the window was opened by pywebview AND the shell's hello()
 * answered with a matching contract. Before hello() has been checked this is false — call
 * whenFlexReady() first. */
let hello = null;          // the shell's hello() result once checked, or null
let helloChecked = false;
export function isFlexShell() {
  return !!(hello && hello.contract === EXPECTED_FLEX_CONTRACT);
}
/* The shell's answer to hello() (version, FW/LCM/model versions, copyOnly, capabilities) or null. */
export function flexShellInfo() { return hello; }

/* Resolves true once the bridge is present and hello() checked out, false otherwise — immediately
 * when the bridge is already there, on `pywebviewready` when it arrives, or after `timeoutMs` in a
 * browser (where the event never fires). Idempotent: later calls return the same answer. */
let readyPromise = null;
export function whenFlexReady(timeoutMs = 1500) {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      const b = bridge();
      if (!b || typeof b.hello !== 'function') { helloChecked = true; resolve(false); return; }
      try {
        const r = await b.hello();
        const h = r && r.ok ? r.result : null;
        helloChecked = true;
        if (!h || h.contract !== EXPECTED_FLEX_CONTRACT) {
          hello = h ? { ...h, contractMismatch: true } : null;
          warnOnce('shell contract ' + (h && h.contract) + ' ≠ engine ' + EXPECTED_FLEX_CONTRACT + ': FLEx features disabled');
          resolve(false);
          return;
        }
        hello = h;
        resolve(true);
      } catch (e) {
        helloChecked = true;
        warnOnce('hello() failed: ' + (e && e.message));
        resolve(false);
      }
    };
    if (bridge()) { finish(); return; }
    if (typeof window === 'undefined') { finish(); return; }
    window.addEventListener('pywebviewready', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
  return readyPromise;
}

/* A call into the shell. Resolves with the result or rejects with an Error carrying `.code` (one
 * of the stable codes in plan §3). In a browser every call rejects with E_NOT_SHELL. */
export function flexCall(method, ...args) {
  return new Promise((resolve, reject) => {
    const fail = (code, message, detail) => { const e = new Error(message || code); e.code = code; e.detail = detail; reject(e); };
    const b = bridge();
    if (!b || !isFlexShell()) return fail(helloChecked && hello && hello.contractMismatch ? 'E_CONTRACT' : 'E_NOT_SHELL', 'not running in the FLEx shell');
    if (typeof b[method] !== 'function') return fail('E_INTERNAL', 'the shell has no method ' + method);
    Promise.resolve(b[method](...args)).then((r) => {
      if (r && r.ok) resolve(r.result);
      else if (r && r.error) fail(r.error.code || 'E_INTERNAL', r.error.message, r.error.detail);
      else fail('E_INTERNAL', 'malformed answer from the shell');
    }, (e) => fail('E_INTERNAL', e && e.message));
  });
}

/* Long operations answer {jobId}; poll until done. */
export async function flexJob(method, ...args) {
  const r = await flexCall(method, ...args);
  if (!r || !r.jobId) return r;
  for (;;) {
    const st = await flexCall('job_status', r.jobId);
    if (st.state === 'done') return st.result;
    if (st.state === 'error') { const e = new Error(st.error.message || st.error.code); e.code = st.error.code; e.detail = st.error.detail; throw e; }
    await new Promise((res) => setTimeout(res, 150));
  }
}

/* The typed surface (plan §3). Each is a thin name over flexCall/flexJob so callers never spell a
 * method string, and a renamed bridge method fails in ONE place. */
export const flex = {
  hello: () => flexCall('hello'),
  listProjects: () => flexCall('list_projects'),
  openProject: (name, mode) => flexCall('open_project', name, mode),
  closeProject: () => flexCall('close_project'),
  listTexts: () => flexCall('list_texts'),
  openText: (guid) => flexCall('open_text', guid),
  closeText: (guid) => flexCall('close_text', guid),
  previewSave: (guid, baseRev, ops, postState) => flexCall('preview_save', guid, baseRev, ops, postState),
  saveToFlex: (token) => flexJob('save_to_flex', token),
  undoFlex: () => flexJob('undo_flex'),
  redoFlex: () => flexJob('redo_flex'),
  relinkPreview: (guid, uriGuid, path) => flexCall('relink_preview', guid, uriGuid, path),
  exportEditorBundle: (guid) => flexJob('export_editor_bundle', guid),
  getMedia: (guid) => flexCall('get_media', guid),
  findMedia: (guid) => flexCall('find_media', guid),
  useMedia: (guid, uriGuid, path) => flexCall('use_media', guid, uriGuid, path),
  chooseMedia: (guid, uriGuid) => flexCall('choose_media', guid, uriGuid),
  importPreview: (path) => flexCall('import_preview', path),
  importFlextext: (token) => flexJob('import_flextext', token),
  printviewData: (segGuid) => flexCall('printview_data', segGuid),
  copyText: (text) => flexCall('copy_text', text),
  pickFile: (kind) => flexCall('pick_file', kind),
  openExternal: (url) => flexCall('open_external', url),
};

/* What the shell cannot do (plan §2.2 item 8): off-site flows (Google sign-in) are unavailable.
 * The engine hides those entry points when this is false. In a browser it is true. */
export function offsiteAuthAvailable() {
  if (!isFlexShell()) return true;
  const caps = hello && hello.capabilities;
  return !!(caps && caps.offsiteAuth);
}

/* For tests only: reset the module's memory of hello(). */
export function __resetFlexSeam() { hello = null; helloChecked = false; readyPromise = null; warned = false; }
