/* describeCapture — turning a native capture's provenance into something displayable.
 *
 * WHY IT MATTERS: this is the readout that makes testing a USB microphone possible at all. Without
 * it the only test is "record twice and listen", which cannot tell "the phone ignored the mic" from
 * "the mic is poor". It is also the provenance a researcher audits weeks later, so a wrong answer
 * here becomes a wrong claim about an archival recording.
 *
 * The case that must never break: an APK built BEFORE routing existed reports no routed* fields.
 * The engine auto-updates and the APK does not, so that combination is guaranteed to occur in the
 * field. A missing field must read as "not reported", never as a negative verdict — inventing a
 * negative from silence would mark good recordings as non-archival.
 *
 * Run: node test/capture-provenance.test.mjs
 */
import { describeCapture } from '../docs/js/native-audio.js';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\nnot a native capture');
ok(describeCapture(null) === null, 'null meta -> null (web paths render nothing)');
ok(describeCapture(undefined) === null, 'undefined -> null');
ok(describeCapture('nonsense') === null, 'non-object -> null, never a throw');
ok(describeCapture({}) === null, 'empty meta -> null rather than an empty row');

console.log('\na USB microphone was really used (the thing being tested)');
{
  const c = describeCapture({
    routedDevice: 'Samson Q2U', routedType: 'usb_device', routedWireless: false,
    label: '24-bit WAV', encoding: 'pcm24', sampleRate: 48000, channels: 1,
    source: 'UNPROCESSED', unprocessedSource: true, archivalClean: true, depthVerified: true,
  });
  ok(c.device === 'Samson Q2U', 'reports the device by name');
  ok(c.deviceType === 'usb_device', 'reports the type, so a missing name still resolves');
  ok(c.archival === true && c.wireless === false, 'archive grade');
  ok(c.unprocessed === true, 'unprocessed source preserved');
}

console.log('\nthe phone ignored the USB mic — the failure the readout must expose');
{
  const c = describeCapture({ routedDevice: null, routedType: 'builtin_mic', routedWireless: false,
                              label: '24-bit WAV', archivalClean: true });
  ok(c.deviceType === 'builtin_mic', 'built-in mic is reported plainly, not hidden');
  ok(c.device === null, 'no product name is invented when the OS gave none');
}

console.log('\nwireless — never archive grade whatever the depth says');
{
  const c = describeCapture({ routedType: 'bluetooth_sco', routedWireless: true, label: '24-bit WAV',
                              archivalClean: false, routedNote: 'Recorded through a wireless microphone.' });
  ok(c.wireless === true && c.archival === false, 'flagged non-archival');
  ok(c.archivalReason === 'Recorded through a wireless microphone.', 'carries the reason for display');
  ok(c.label === '24-bit WAV', 'still reports the depth — the file really is 24-bit; the SOURCE is the problem');
}

console.log('\nan APK older than routing (engine updates, APK does not)');
{
  const c = describeCapture({ label: '24-bit WAV', encoding: 'pcm24', sampleRate: 48000,
                              archivalClean: true, source: 'UNPROCESSED' });
  ok(c !== null, 'still renders — it knows the format even without routing');
  ok(c.deviceType === null && c.device === null, 'device is simply unknown');
  ok(c.wireless === false, 'absence of routing info is NOT treated as wireless');
  ok(c.archival === true, 'and does NOT downgrade a capture that reported itself clean');
}
{
  // Silence about archivalClean must stay silence, not a false verdict either way.
  const c = describeCapture({ routedType: 'usb_device' });
  ok(c.archival === null, 'unreported archival status is null, not false');
  ok(c.unprocessed === null, 'unreported unprocessed status is null, not false');
  ok(c.depthVerified === null, 'unreported depth verification is null, not false');
}

console.log('\nformat substitution still surfaces');
{
  const c = describeCapture({ routedType: 'builtin_mic', label: '16-bit WAV', substituted: true,
                              substitutionReason: 'This device cannot capture 24-bit.' });
  ok(c.substituted === true && /cannot capture/.test(c.substitutionReason),
     'a substituted format is reported with its reason');
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nPASS: provenance is reported honestly, and silence is never a verdict.\n');
process.exit(fail ? 1 : 0);
