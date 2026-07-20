/* Routing -> archival merge in the native chokepoint.
 *
 * WHY: the plugin reports "which mic" and "were the OS processors off" as two independent facts and
 * never merges them. The merge happens engine-side so the APK can stay additive — which is exactly
 * what lets the APK and the engine ship on different schedules. The case that must never break is
 * an OLD build that reports no routed* fields at all: it has to behave precisely as it did before
 * routing existed, because an installed APK cannot be patched.
 *
 * Run: node test/native-routing.test.mjs
 */
import { NativeRecorder } from '../docs/js/native-audio.js';

const merge = NativeRecorder._normalizeArchival;
let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fail++; };

console.log('\nbackward compatibility (an APK that predates routing)');
{
  const old = { encoding: 'pcm24', archivalClean: true, label: '24-bit WAV' };
  const r = merge(old);
  ok(r.archivalClean === true, 'no routed* fields -> archivalClean untouched');
  ok(r.archivalReason === undefined, 'no reason invented for a build that cannot report one');
  ok(JSON.stringify(r) === JSON.stringify(old), 'metadata passes through byte-identical');
}

console.log('\nwireless route demotes the claim');
{
  const r = merge({ encoding: 'pcm24', archivalClean: true, routedWireless: true,
                    routedType: 'bluetooth_sco', routedNote: 'Recorded through a wireless microphone.' });
  ok(r.archivalClean === false, 'a Bluetooth route is never archive quality, whatever the depth says');
  ok(r.archivalReason === 'Recorded through a wireless microphone.', 'uses the native note verbatim');
  ok(r.encoding === 'pcm24' && r.routedType === 'bluetooth_sco', 'other provenance is preserved');
}
{
  const r = merge({ archivalClean: true, routedWireless: true });   // note omitted
  ok(typeof r.archivalReason === 'string' && r.archivalReason.length > 20,
     'falls back to its own explanation when the plugin sent no note');
}

console.log('\nwired routes are left alone');
for (const t of ['builtin_mic', 'usb_device', 'wired_headset', 'unknown']) {
  const r = merge({ archivalClean: true, routedWireless: false, routedType: t });
  ok(r.archivalClean === true, `${t}: claim preserved`);
}
{
  // Effects-dirty must STAY dirty — the merge may only ever demote, never upgrade.
  const r = merge({ archivalClean: false, routedWireless: false, routedType: 'builtin_mic' });
  ok(r.archivalClean === false, 'a good mic cannot rescue a capture that had processors running');
}

console.log('\nrobustness (this runs on every native capture)');
{
  ok(merge(null) === null, 'null passes through');
  ok(merge(undefined) === undefined, 'undefined passes through');
  const r = merge({ archivalClean: true, routedWireless: 'true' });   // string, not boolean
  ok(r.archivalClean === true, 'only a real boolean true demotes — no truthiness coercion');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: routing merges safely and stays backward compatible.\n');
process.exit(fail ? 1 : 0);
