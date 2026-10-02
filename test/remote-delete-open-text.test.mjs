/* A TEXT DELETED WHILE IT IS OPEN TAKES ITS PLAYER WITH IT (issue #90, Brian Plimley, 2026-10-01).
 *
 * His report: he opened a text in the Editor; while it was open the Researcher Panel removed it from
 * the device. The Editor went to the (empty) texts list — but "a working audio widget for the text
 * that was deleted" stayed on screen.
 *
 * The cause: deleteUploadedDoc (the teardown every remote / auto delete ends in) nulled `current`
 * and showed the texts view, but never ran leaveEditor() — the shared leave-the-text cleanup Back
 * and returnToLibraryAfterSend use. The player dock (#audio-player) is a sibling of the views, so
 * show('texts') never hides it; only leaveEditor() does. In the Audio Segmenter the open text lives
 * in the matcher (MG), and nothing closed that either.
 *
 * ⚠ THE PROPERTY THAT MUST NOT REGRESS ALONG WITH THE FIX: nothing on the way out may write the
 * deleted record back. Back persists before it leaves; this path must NOT — so leaveEditor runs
 * after `current = null`, where persist() returns at once.
 *
 * Source pins first, then the real function lifted out of app.js and run against stubs, so the
 * order is the function's actual behaviour and not a regex's opinion of it.
 * Run: node --test test/remote-delete-open-text.test.mjs
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
const fn = (src, name) => (src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];
const asyncFn = (src, name) => (src.match(new RegExp(`\\nasync function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`)) || [''])[0];

function checker() {
  let fail = 0;
  const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
  const done = () => {
    console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
    if (fail) throw new Error(`${fail} check(s) failed`);
  };
  return { ok, done };
}

test('#90: deleteUploadedDoc leaves the open text the whole way (source)', () => {
  const { ok, done } = checker();
  const body = fn(app, 'deleteUploadedDoc');
  ok(body.length > 80, 'deleteUploadedDoc exists');

  console.log('\nthe editor: the shared leave, in the only safe order');
  const iNull = body.indexOf('current = null;');
  const iLeave = body.indexOf('leaveEditor();');
  const iShow = body.indexOf("if (!RECORD_MODE && !CONSENT_MODE && !SEGMENTER_MODE) show('texts');");
  ok(iLeave > 0, 'it calls leaveEditor() — the cleanup that hides the dock show() cannot reach');
  ok(iNull > 0 && iLeave > iNull,
     'AFTER `current = null`, so nothing leaveEditor sets off can persist the deleted record');
  ok(iShow > iLeave, 'and BEFORE the satellites-safe show(\'texts\') line (kept as it was)');
  ok(!/persist\(/.test(body),
     'no persist() here, unlike Back: a write racing db.deleteDoc could put the deleted text back');

  console.log('\nthe segmenter: its own exit closes the matcher');
  const iMg = body.indexOf('if (SEGMENTER_MODE && MG && MG.docId === docId) mgClose();');
  ok(iMg > 0, 'an open matcher on the deleted text is closed through mgClose(), keyed on MG.docId');
  ok(iMg < body.indexOf('if (current && current.id === docId)'),
     'before the editor branch — mgClose releases `current` itself, so the teardown runs once');
  ok(/MG = null;/.test(fn(app, 'mgClose')) && /current = null;/.test(fn(app, 'mgClose')) && /player\?\.hide\?\.\(\)/.test(fn(app, 'mgClose')),
     '(mgClose drops MG and `current` and hides the shared dock — what this relies on)');
  ok(/docId: rec\.id,/.test(fn(app, 'mgLoad')), '(and MG.docId is the field mgLoad actually sets)');

  console.log('\nwhat makes it safe to call from every shell that reaches it');
  const leave = fn(app, 'leaveEditor');
  ok(/if \(player\) \{ player\.hide\(\); player\.loadedFor = null; \}/.test(leave),
     'leaveEditor guards the player — the recorder and consent collector have no dock');
  ok(/const el = \$\(sel\);\s*if \(el\) el\.innerHTML = '';/.test(leave), 'and every container lookup');
  ok(!/persist\(|putDoc/.test(leave), 'and writes nothing itself');
  ok(/async function persist\(\) \{\n  if \(!current\) return;/.test(asyncFn(app, 'persist')),
     'persist() still returns at once on a null `current` — the reason the order above is safe');
  ok(/await deleteUploadedDoc\(docId\);/.test(asyncFn(app, 'deleteConfirmedDoc')),
     'the researcher\'s remote deletes (delete / uploadDelete) still end in this teardown');
  done();
});

/* Lift the real function out and run it in a scope that stands in for app.js's module scope. The
 * stubs record what happened and in what order; mgClose behaves as the real one does to the two
 * variables this function reads after it (MG and `current`). */
function harness(env) {
  const src = fn(app, 'deleteUploadedDoc');
  if (!src) throw new Error('deleteUploadedDoc not found');
  const make = new Function('env', `
    const { RECORD_MODE, CONSENT_MODE, SEGMENTER_MODE } = env;
    let current = env.current;
    let MG = env.MG;
    const calls = [];
    function splitCancel() { calls.push('splitCancel'); }
    function leaveEditor() { calls.push('leaveEditor(current=' + (current ? current.id : null) + ')'); }
    function show(v) { calls.push('show:' + v); }
    function mgClose() { calls.push('mgClose'); MG = null; current = null; }
    function refreshList() { calls.push('refreshList'); }
    const db = { deleteDoc: (id) => { calls.push('deleteDoc:' + id); return Promise.resolve(); } };
    ${src}
    return { run: (id) => deleteUploadedDoc(id), state: () => ({ calls, current, MG }) };
  `);
  return make(env);
}
const editor = { RECORD_MODE: false, CONSENT_MODE: false, SEGMENTER_MODE: false, MG: null };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('#90: deleteUploadedDoc, run for real against stubs', async () => {
  const { ok, done } = checker();

  console.log('\nthe editor, the deleted text open (Brian\'s case)');
  {
    const h = harness({ ...editor, current: { id: 'A' } });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['splitCancel', 'leaveEditor(current=null)', 'show:texts', 'deleteDoc:A', 'refreshList']),
       `released, left, list shown, then deleted (${s.calls.join(' → ')})`);
    ok(s.current === null, 'nothing is open afterwards');
  }

  console.log('\nthe editor, a DIFFERENT text open');
  {
    const h = harness({ ...editor, current: { id: 'B' } });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['deleteDoc:A', 'refreshList']), `only the delete and the repaint (${s.calls.join(' → ')})`);
    ok(s.current && s.current.id === 'B', 'the text the user IS working on stays open, its player untouched');
  }

  console.log('\nthe editor, nothing open');
  {
    const h = harness({ ...editor, current: null });
    await h.run('A');
    ok(same(h.state().calls, ['deleteDoc:A', 'refreshList']), 'no teardown for a text nobody has open');
  }

  console.log('\nthe recorder and the consent collector: the leave, but no texts view');
  for (const mode of ['RECORD_MODE', 'CONSENT_MODE']) {
    const h = harness({ ...editor, [mode]: true, current: { id: 'A' } });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['splitCancel', 'leaveEditor(current=null)', 'deleteDoc:A', 'refreshList']),
       `${mode}: released and left, never show('texts') — the shell has no such view (${s.calls.join(' → ')})`);
  }

  console.log('\nthe segmenter, the deleted text open in the matcher');
  {
    const h = harness({ ...editor, SEGMENTER_MODE: true, current: { id: 'A' }, MG: { docId: 'A' } });
    await h.run('A');
    const s = h.state();
    ok(s.calls[0] === 'mgClose', 'the matcher\'s own exit runs first');
    ok(s.calls.indexOf('mgClose') < s.calls.indexOf('deleteDoc:A'), 'before the record is deleted');
    ok(!s.calls.includes('show:texts'), 'and no texts view is shown — mgClose takes the user to the segmenter list');
    ok(s.MG === null && s.current === null, 'nothing is open afterwards');
  }

  console.log('\nthe segmenter, a DIFFERENT text in the matcher');
  {
    const h = harness({ ...editor, SEGMENTER_MODE: true, current: { id: 'B' }, MG: { docId: 'B' } });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['deleteDoc:A', 'refreshList']), `the matcher is left alone (${s.calls.join(' → ')})`);
    ok(s.MG && s.MG.docId === 'B' && s.current && s.current.id === 'B', 'still matching the text the user opened');
  }

  console.log('\nthe segmenter, `current` set but no matcher (an open that failed part-way)');
  {
    const h = harness({ ...editor, SEGMENTER_MODE: true, current: { id: 'A' }, MG: null });
    await h.run('A');
    const s = h.state();
    ok(same(s.calls, ['splitCancel', 'leaveEditor(current=null)', 'deleteDoc:A', 'refreshList']),
       `the editor branch still releases it and hides the dock (${s.calls.join(' → ')})`);
  }
  done();
});
