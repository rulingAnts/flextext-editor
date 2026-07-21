/* A diagnostics log the shell writes to disk.
 *
 * WHY: on the first real Windows run, "Toggle Developer Tools" did nothing at all — no pane, no
 * window — so the only channel for finding out WHY recording failed did not exist. DevTools opens
 * fine on macOS with the identical configuration, so this is Windows- or portable-build-specific and
 * cannot be reproduced from the development machine.
 *
 * Depending on DevTools was the mistake. A field app is used on machines nobody can inspect, by
 * people who will not open a console, over a connection too poor for screen sharing. It has to be
 * able to say what happened in a file that can be attached to a message.
 *
 * Deliberately boring: plain text, appended, size-capped, and it NEVER throws. A logger that can
 * fail the app it is diagnosing is worse than no logger.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 512 * 1024;      // a few sessions' worth; small enough to attach to a message
let logPath = null;

function init(userDataDir) {
  try {
    const dir = path.join(userDataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'flextext-desktop.log');
    // Truncate from the FRONT when oversized: the recent entries are the ones that explain the
    // problem being reported, and losing old ones costs nothing.
    try {
      const st = fs.statSync(logPath);
      if (st.size > MAX_BYTES) {
        const keep = fs.readFileSync(logPath, 'utf8').slice(-Math.floor(MAX_BYTES / 2));
        fs.writeFileSync(logPath, '--- earlier entries trimmed ---\n' + keep);
      }
    } catch { /* no existing log */ }
  } catch { logPath = null; }
  return logPath;
}

function write(level, ...parts) {
  const line = `[${new Date().toISOString()}] ${level} ` + parts.map(fmt).join(' ') + '\n';
  try { if (logPath) fs.appendFileSync(logPath, line); } catch { /* never break the app to log */ }
  try { process.stdout.write(line); } catch { /* no console in a packaged app */ }
}

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = {
  init,
  path: () => logPath,
  info: (...a) => write('INFO', ...a),
  warn: (...a) => write('WARN', ...a),
  error: (...a) => write('ERROR', ...a),
};
