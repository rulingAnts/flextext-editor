/* Build-time flags for the desktop shell.
 *
 * Split into its own module for one reason: it must be testable WITHOUT Electron. main.js cannot be
 * imported by a test (it requires electron and opens a window), so logic that lives there is logic
 * nobody checks — and this particular logic decides whether a field user's app ships with a
 * developer console attached to a native bridge. That is not something to leave unverified.
 *
 * ⚠ THE FAILURE DIRECTION IS CLOSED: anything other than an explicit `true` means OFF. Missing file,
 * unreadable file, malformed JSON, a string "true", a truthy 1 — all OFF. A release must never gain
 * developer tools by accident; a test build gains them only because someone asked.
 */
const fs = require('node:fs');
const path = require('node:path');

const FLAGS_FILE = path.join(__dirname, 'build-flags.json');

/** @param {{env?: object, file?: string}} [opts] injection points, for tests only */
function devToolsAllowed(opts = {}) {
  const env = opts.env || process.env;
  const file = opts.file || FLAGS_FILE;
  // Escape hatch for running from source; never present in a packaged app's environment.
  if (env.FLEXTEXT_DEVTOOLS === '1') return true;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw).devTools === true;   // strict: only a real boolean true
  } catch {
    return false;                                // missing or malformed -> off
  }
}

module.exports = { devToolsAllowed, FLAGS_FILE };
