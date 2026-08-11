/* Assign intake: the background allowlist carries the assignment identity (assign-by-upload).
 *
 * WHY THIS IS WORTH A TEST: openUrlTask's background allowlist is a single object literal that
 * SILENTLY drops every field not named in it. It already broke this exact feature once — the v137
 * "adopt the panel's docId" fix was dead code for months because this line stripped task.docId
 * before the adopt could read it (one text, two Drive folders, and nothing looked wrong). The
 * whole dedupe design rests on docId + folderId surviving this line, so the test pins the line
 * itself, plus the dispatch that feeds it.
 *
 * app.js cannot be imported under node (DOM at module scope, by design) — regex-pin technique,
 * same as text-folder-files.test.mjs.
 *
 * Run: node test/assign-intake.test.mjs
 */
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nthe background allowlist (openUrlTask) keeps the assignment identity');
{
  // The exact strip line: `if (!interactive) task = { ... }` — one statement, one object literal.
  const m = app.match(/if \(!interactive\) task = \{([^}]*)\}/);
  ok(!!m, 'the allowlist line exists in its pinned shape');
  const list = m ? m[1] : '';
  ok(/\bdocId:\s*task\.docId\b/.test(list), 'docId survives the strip (the v137 dead-code trap)');
  ok(/\bfolderId:\s*task\.folderId\b/.test(list), 'folderId survives the strip (dedupe-from-birth)');
  ok(/\bassigned:\s*task\.assigned\b/.test(list), 'assigned survives the strip (upload-lane rules)');
  ok(/\baudioUrl:\s*task\.audioUrl\b/.test(list) && /\bflextextUrl:\s*task\.flextextUrl\b/.test(list),
     'the original fields are still there (this is an ADDITION, not a rewrite)');
  ok(!/\breplace\b/.test(list) && !/\bcleanup\b/.test(list),
     'replace/cleanup stay OUT — background commands must never overwrite or delete');
}

console.log('\nsyncDispatch forwards the assignment fields into the task');
{
  const m = app.match(/case 'assign': \{([\s\S]*?)\n {4}\}/);
  ok(!!m, "the 'assign' dispatch case exists");
  const body = m ? m[1] : '';
  ok(/\bdocId:\s*cmd\.id\b/.test(body), 'panel id -> task.docId');
  ok(/\bfolderId:\s*cmd\.folderId\b/.test(body), 'cmd.folderId is forwarded');
  ok(/\bassigned:\s*true\b/.test(body), 'a remote assign marks the task assigned');
}

console.log('\nopenUrlTask stamps the identity onto the doc record (both branches)');
{
  ok(/if \(task\.folderId\) rec\.driveFolderId = task\.folderId/.test(app), 'new-rec branch stamps driveFolderId');
  ok(/if \(task\.assigned\) rec\.assigned = true/.test(app), 'new-rec branch stamps assigned');
  ok(/if \(task\.folderId\) current\.driveFolderId = task\.folderId/.test(app), 'replace branch stamps driveFolderId');
  ok(/if \(task\.assigned\) current\.assigned = true/.test(app), 'replace branch stamps assigned');
  ok(/id: task\.docId \|\| newGuid\(\)/.test(app), 'the docId adopt itself is still in place');
}

console.log(fail ? `\nFAILED (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
