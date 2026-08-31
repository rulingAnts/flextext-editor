/* THE PROJECT DEVICE COUNT TELLS THE TRUTH AFTER A REVOKE (issue #10).
 *
 * Brian: "Now I have no devices paired, but in the project list (under Projects) it says 4 devices
 * for this project instead of 0." Revoking clears the PAIRING but leaves the device's Drive folder,
 * and the count is built from Drive.
 *
 * ⚠ THE INTERESTING PART IS THAT v450 ALREADY 'FIXED' THIS and the reported case still failed —
 * through the very fallback meant to protect it. That fallback exists because an older worker does
 * not stamp `instanceId` onto estate device rows, so "no live signal" was read as "we cannot tell"
 * and the count fell back to raw. But revoke EVERY device and there is nothing to stamp and no
 * folder to match, so the all-revoked case — the reported one — took the can't-tell path and
 * counted 4.
 *
 * The two states come from DIFFERENT endpoints, which is what makes them separable: `lastData` is
 * listView, which excludes revoked instances, so an empty instance list is a positive statement
 * that none are live. Genuine ambiguity survives in exactly one shape (instances exist, yet none
 * carries a folder id and none is stamped), and only that shape may count raw.
 *
 * The predicate is executed here against synthetic estates rather than pattern-matched, because
 * every one of these cases is a boolean that reads plausibly either way.
 */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');

/* Extract the three lines that decide the count and run them over given inputs. Kept as an
 * extraction (not a copy) so the test cannot drift from the implementation. */
function countLive({ devices, lastData }) {
  const src = panel.match(/const liveInstances = [\s\S]*?const liveDevice = \([^;]+;/);
  if (!src) throw new Error('count predicate not found');
  const fn = new Function('devices', 'lastData', `${src[0]}; return devices.filter(liveDevice).length;`);
  return fn(devices, lastData);
}

const DEV = (folderId, extra = {}) => ({ folderId, kind: 'device', projectId: 'P1', ...extra });

test('project device count', () => {
  console.log('\nthe reported case: every device revoked ⇒ zero, not four');
  {
    const devices = [DEV('f1'), DEV('f2'), DEV('f3'), DEV('f4')];
    ok(countLive({ devices, lastData: { instances: [] } }) === 0,
       'four abandoned Drive folders, no live instances ⇒ 0');
  }

  console.log('\na live device still counts, by either signal');
  {
    ok(countLive({ devices: [DEV('f1'), DEV('f2')],
                   lastData: { instances: [{ oauth_folder_id: 'f1' }] } }) === 1,
       'matched by folder id (older estate, no stamping)');
    ok(countLive({ devices: [DEV('f1', { instanceId: 'i1' }), DEV('f2')],
                   lastData: { instances: [{ instance_id: 'i1' }] } }) === 1,
       'matched by the estate\'s own stamp');
  }

  console.log('\ncrowd recorders are containers in their own right');
  {
    ok(countLive({ devices: [{ folderId: 'c1', kind: 'crowd', projectId: 'P1' }],
                   lastData: { instances: [] } }) === 1,
       'a crowd recorder counts even with no paired devices at all');
  }

  console.log('\n⚠ the ONE genuinely ambiguous shape still counts raw');
  {
    // Instances exist, but this worker stamps nothing and returns no folder ids: we cannot tell
    // which Drive folders are live, and showing zero would be a lie about a working estate.
    ok(countLive({ devices: [DEV('f1'), DEV('f2')],
                   lastData: { instances: [{ instance_id: 'i1' }, { instance_id: 'i2' }] } }) === 2,
       'live instances but no usable signal ⇒ raw count (old-worker fallback preserved)');
    ok(countLive({ devices: [DEV('f1'), DEV('f2')], lastData: null }) === 2,
       'and nothing loaded yet is UNKNOWN, not zero');
  }

  console.log('\nrevoking one of several leaves the rest counted');
  {
    ok(countLive({ devices: [DEV('f1'), DEV('f2'), DEV('gone')],
                   lastData: { instances: [{ oauth_folder_id: 'f1' }, { oauth_folder_id: 'f2' }] } }) === 2,
       'two live, one revoked ⇒ 2');
  }

  console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
  if (fail) throw new Error(`${fail} check(s) failed`);
});
