/* A MOVE WHOSE SOURCE DEVICE IS GONE MUST CLOSE ITSELF, AND MUST SAY SO WHILE IT IS OPEN.
 *
 * Seth, 2026-09-24, after migrating a laptop by moving its texts away, erasing the PWA and pairing
 * it afresh: "some texts aren't able to be moved from device to device. Which is funny because for
 * some of them, I moved them once, but they don't show me the move option to move them again."
 *
 * ⚠ THE MECHANISM. A move retires only when the SOURCE reports and no longer lists the doc —
 * deliberately, because an unreadable report must never be read as a deletion. An erased, deleted or
 * unlinked device never reports again, so the record stayed open forever; and an open record hides
 * the Move button on EVERY card, while the only chip explaining it draws on the source row, which by
 * then does not exist. The result was a text with one button fewer than its neighbours and nothing
 * anywhere to say why — the state was both permanent and invisible.
 *
 * ⚠ AND CLOSING ONE REMOVES NOTHING: the destination's assignment is durable server-side, the text
 * stays where it is, and a source that somehow returns keeps its copy. The only thing abandoned is a
 * removal with nobody left to deliver it.
 *
 * Run: node --test test/move-stuck-source.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PANEL = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../docs/js/i18n.js', import.meta.url), 'utf8');

test('the source-can-release test never judges from an empty device list', () => {
  const fn = PANEL.slice(PANEL.indexOf('function sourceCanRelease(instanceId)'),
                         PANEL.indexOf('function instanceNick(instanceId)'));
  /* ⚠ THE WHOLE SWEEP HANGS ON THIS LINE. Before the first dashboard payload there are no instances
   * at all, so "not in the list" would be true of every device in the account — and one tick would
   * close every in-flight move in it. Same family as the absent-because-unreadable guard below. */
  assert.match(fn, /if \(!Array\.isArray\(list\) \|\| !list\.length\) return true;/,
    'no list yet means no verdict');
  assert.match(fn, /if \(!it\) return false;/, 'absent from the account: deleted or unlinked, never coming back');
  assert.match(fn, /if \(!installs\.length\) return true;/, 'linked but not yet reporting: keep waiting');
  assert.match(fn, /installs\.some\(\(ins\) => ins && ins\.wipe_state !== 'confirmed'\)/,
    'erased and confirmed: it can never release anything again');
});

test('the sweep closes such a move, and closing deletes the record', () => {
  /* ⚠ Sliced FORWARD from the sweep, not to the first `loadCollapsed(` in the file: that name is
   * defined long before it is called here, so an unanchored second boundary yields an empty window —
   * and every assertion below would then pass against nothing. */
  const from = PANEL.indexOf('const transitions = [];');
  const sweep = PANEL.slice(from, PANEL.indexOf('loadCollapsed(Researcher.currentAccountId());', from));
  assert.ok(sweep.length > 400, 'the sweep window is real');
  assert.match(sweep, /if \(!sourceCanRelease\(mv\.from\)\) \{\s*\n\s*transitions\.push\(\['gone', docId\]\);/,
    'a move whose source cannot release it is closed');
  assert.match(sweep, /if \(what === 'done' \|\| what === 'gone'\) delete cur\[docId\];/,
    'and closing it drops the record');
  assert.doesNotMatch(sweep, /uploadDelete\([^)]*\)[\s\S]{0,80}sourceCanRelease/,
    'closing issues no command: it abandons a removal, it does not perform one');
  /* ⚠ REGRESSION GUARD. The ordinary completion path must still require the source to have REPORTED
   * before an absent doc counts as a deletion. The fix above is for sources that are gone for good,
   * not a licence to treat silence as proof. */
  assert.match(sweep, /mv\.stage === 'removing' && instanceReported\(mv\.from\) && !findInventoryItem\(mv\.from, docId\)/,
    'absent-because-unreadable is still not absent-because-removed');
  // one toast for the sweep, not one per text: a migration can orphan a whole device's worth
  assert.match(sweep, /orphaned\.length === 1\s*\n?\s*\? t\('panel\.move\.sourceGone'/, 'one text names itself');
  assert.match(sweep, /t\('panel\.move\.sourceGoneN', \{ n: orphaned\.length \}\)/, 'several are counted');
});

test('while a move is open, the row that is NOT the source says so and can clear it', () => {
  const row = PANEL.slice(PANEL.indexOf('const moveChip = mvSource'), PANEL.indexOf('const cancelRemovalBtn'));
  assert.match(row, /: \(mv && !d\.__assigning\)\s*\n\s*\? ` <span class="rp-tag rp-tag-moving" title="\$\{esc\(t\('panel\.move\.srcChipWhy', \{ from: instanceNick\(mv\.from\) \}\)\)\}"/,
    'a row that already HOLDS the text names the device that has not released its copy');
  /* ⚠ ONLY a row that holds it. While the destination is still a GHOST its pending assignment is its
   * story, and a second chip beside it would be two markers for one wait — the rule
   * test/panel-shared-state.test.mjs has pinned since v392, and this is its refinement, not its
   * removal: the uncovered case was a destination that received the text while the source never
   * released it. */
  assert.match(row, /data-iact="clear-move"/, 'and offers the escape');
  assert.match(row, /\(memberCtx \? '' :/, 'though a member, who may not move texts, is offered no clear');
  // the gate itself is unchanged: an open record still hides Move, which is correct while it is open
  const gate = PANEL.slice(PANEL.indexOf('const moveBtn ='), PANEL.indexOf('const moveBtn =') + 260);
  assert.match(gate, /\(memberCtx \|\| !d\.id \|\| mv \|\| d\.__assigning \|\| deleting \|\| uploading \|\| wiped\)/,
    'Move stays hidden while a move is genuinely in flight');
});

test('the clear-move handler confirms, drops the record, and commands nothing', () => {
  const h = PANEL.slice(PANEL.indexOf("} else if (act === 'clear-move')"), PANEL.indexOf("} else if (act === 'cancel-cmd')"));
  assert.match(h, /confirmModal\(t\('panel\.move\.clearConfirm'/, 'confirmed: on a healthy move this leaves the old device holding a copy');
  assert.match(h, /saveMoves\(\(cur\) => \{ delete cur\[docId\]; return cur; \}\)/, 'dropping the record is the whole action');
  assert.doesNotMatch(h, /uploadDelete|Researcher\.assign|deleteDoc/, 'it issues no command of any kind');
});

test('every new string exists in both languages', () => {
  for (const k of ['panel.move.sourceGone', 'panel.move.sourceGoneN', 'panel.move.srcChip',
                   'panel.move.srcChipWhy', 'panel.move.clearBtn', 'panel.move.clearConfirm',
                   'panel.move.unknownDevice']) {
    const hits = I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || [];
    assert.equal(hits.length, 2, `${k} is in English and Indonesian`);
  }
  /* ⚠ The closure message must not suggest anything was deleted — it is the sentence a researcher
   * reads when several texts close at once, and "removed" about the TEXT would be a false alarm. */
  assert.match(I18N, /'panel\.move\.sourceGone': 'The move of [^']*stays where it is, and you can move it again\.'/,
    'it says the text stays where it is');
});
