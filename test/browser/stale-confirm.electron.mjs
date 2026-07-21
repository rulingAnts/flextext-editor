/* Confirmed-staleness threshold — drives the REAL staleConfirmed() in researcher-panel.js.
 *
 * WHY IT RUNS UNDER ELECTRON AND NOT NODE: researcher-panel.js needs a browser (it touches
 * `location` and starts timers at module scope), so plain `node` cannot import it. The alternative
 * — extracting the function into its own module — would add a file to app.js's import graph, which
 * becomes a new SHELL entry in BOTH satellites and pulls in the whole deploy-ordering sequence. Not
 * worth it for a test-only concern, so the test comes to the browser instead.
 *
 * It deliberately drives the real exported function rather than a copy of its logic: a copied test
 * passes while the real path is broken, which is exactly how a missing IPC handler once hid in the
 * desktop shell.
 *
 * Needs the dev server up:  bash dev-serve.sh 8012
 * Run:                      cd electron && npx electron ../test/browser/stale-confirm.electron.mjs
 */
import { app, BrowserWindow } from 'electron';

const URL = process.env.FLEXTEXT_TEST_URL || 'http://localhost:8012/flextext-editor/';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  let failed = 0;
  try {
    await win.loadURL(URL);
    const r = await win.webContents.executeJavaScript(`(async () => {
      const m = await import('/flextext-editor/js/researcher-panel.js?cb=' + Date.now());
      const sc = m.staleConfirmed;
      if (typeof sc !== 'function') throw new Error('staleConfirmed is not exported');
      const H = 3600e3, t0 = Date.parse('2026-07-21T00:00:00Z');
      const iso = h => new Date(t0 + h * H).toISOString();
      const reset = () => localStorage.removeItem('flextext-rp-stale-watch');
      const out = [];
      const ck = (name, got, want) => out.push({ name, ok: got === want, got, want });

      // A device behind right after a release must NOT alarm — that is the normal update window,
      // and alarming there would train the researcher to ignore the badge entirely.
      reset();
      ck('first sighting is quiet',        sc('dev1', iso(0), true,  'v109'), false);
      ck('1h later still quiet',           sc('dev1', iso(1), true,  'v109'), false);
      ck('5h later still quiet',           sc('dev1', iso(5), true,  'v109'), false);
      ck('6h later ALARMS',                sc('dev1', iso(6), true,  'v109'), true);
      ck('stays alarming',                 sc('dev1', iso(9), true,  'v109'), true);

      // Resolving clears the badge, and a fresh mismatch starts the clock over.
      ck('resolved -> quiet',              sc('dev1', iso(10), false, 'v114'), false);
      ck('watch entry removed',            !JSON.parse(localStorage.getItem('flextext-rp-stale-watch')||'{}').dev1, true);
      ck('new mismatch restarts clock',    sc('dev1', iso(11), true,  'v114'), false);

      // A device that MOVED is lagging, not stuck. Only stuck deserves an alarm.
      reset();
      sc('dev2', iso(0), true, 'v109');
      ck('version moved -> no alarm',      sc('dev2', iso(7),  true, 'v110'), false);
      ck('then stuck 7h -> alarms',        sc('dev2', iso(14), true, 'v110'), true);

      // Leaving the panel open must not confirm staleness from ONE report: the gap is measured on
      // the DEVICE's report timestamps, not on wall clock.
      reset();
      sc('dev3', iso(0), true, 'v109');
      ck('same report repeated',           sc('dev3', iso(0), true, 'v109'), false);
      ck('same report again',              sc('dev3', iso(0), true, 'v109'), false);

      // Devices must not contaminate each other's timers.
      reset();
      sc('devA', iso(0), true, 'v109');
      ck('other device isolated',          sc('devB', iso(8), true, 'v109'), false);

      // An install with no id cannot be tracked; show the mismatch rather than swallow it.
      ck('untracked id falls through',     sc('', iso(0), true, 'v109'), true);
      return out;
    })()`);
    for (const c of r) {
      console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.ok ? '' : `  (got ${c.got}, want ${c.want})`}`);
      if (!c.ok) failed++;
    }
  } catch (e) {
    console.log('  FAIL  harness error: ' + (e && e.message));
    failed++;
  }
  console.log(failed ? `\nFAILED (${failed})\n` : '\nPASS: staleness is confirmed, not guessed, and clears itself.\n');
  app.exit(failed ? 1 : 0);
});
