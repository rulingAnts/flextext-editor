/* "Push to device" must not report an ERROR while the consent prompt is still uploading.
 *
 * WHY THIS TEST EXISTS (Seth, v336 test drive): "push to device" threw an error until the
 * background upload finished. The mechanism is worth stating, because the code looked correct at
 * every step: the prompt upload fills the hidden `consentAudioUrl` carrier only when it COMPLETES,
 * and `validateDeviceSettings` quite rightly requires that field when consent asks for audio. So a
 * researcher who pressed Save mid-upload got a required-field failure, painted red, for a state
 * that was simply not finished. Nothing was broken; the report was just wrong about what it meant.
 *
 * ⚠ THE SUBTLE HALF is the ordering. Guarding this by making validateDeviceSettings tolerate a
 * blank URL would be worse than the bug: the field would stop being required at all, and a device
 * could be pushed a consent-audio setup with no audio — which fails silently, in the field, in
 * front of a speaker being asked to consent. The guard therefore sits BEFORE validation and
 * short-circuits, leaving the requirement itself untouched. Both halves are asserted.
 *
 * The second half of the work order is progress: a spoken prompt on a field connection is minutes,
 * and silence that long is indistinguishable from a hang — which is what made people press Save in
 * the first place.
 *
 * Run: node test/consent-upload-progress.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const panel = read('../docs/js/researcher-panel.js');
const researcher = read('../docs/js/researcher.js');
const i18n = read('../docs/js/i18n.js');

console.log('\nthe upload reports progress');
{
  ok(/onProgress: \(sent, total\) => \{/.test(panel),
     'the consent upload passes an onProgress callback (it accepted one all along and never used it)');
  ok(/const pct = total \? Math\.min\(100, Math\.round\(\(sent \/ total\) \* 100\)\) : 0;/.test(panel),
     'progress is a real percentage of real bytes');
  ok(/cuBtn\.textContent = t\('panel\.f\.consentUploadingPct', \{ pct \}\)/.test(panel),
     'and it is painted on the button as it moves');
  // A zero-byte or unknown total must not produce NaN% on screen.
  ok(/total \?/.test(panel.slice(panel.indexOf('onProgress: (sent, total)'))),
     'a missing total degrades to 0%, never NaN');
  ok(/onProgress\(offset, total\)/.test(researcher),
     'researcher.js actually calls it during the chunk loop — otherwise the bar never moves');
}

console.log('\n...including the step AFTER the bytes, which is not instant');
{
  /* Minting the delivery token is a separate round trip. Leaving the button at 100% through it
   * re-creates the same "is it stuck?" impression the percentage exists to remove. */
  const at = panel.indexOf("t('panel.f.consentFinishing')");
  ok(at > 0, 'a distinct "finishing" state exists for the URL-minting round trip');
  ok(at < panel.indexOf('assignFinish(iid'), '...and it is painted BEFORE that call, not after it');
}

console.log('\nSave refuses clearly instead of reporting a failure');
{
  ok(/let consentUploading = null;/.test(panel), 'an in-flight flag exists');
  ok(/consentUploading = \{ pct: 0 \};/.test(panel), 'set when the upload starts');
  ok(/finally \{ consentUploading = null; \}/.test(panel),
     'and cleared in a finally — on the error path too, or Save would be wedged for good');

  const saveAt = panel.indexOf(`box.querySelector('[data-m="save"]').onclick`);
  const guardAt = panel.indexOf('if (consentUploading) {', saveAt);
  const validateAt = panel.indexOf('validateDeviceSettings(collectRaw(box)', saveAt);
  ok(guardAt > saveAt && validateAt > guardAt,
     'THE ORDERING: the guard runs BEFORE validateDeviceSettings, so the requirement is never relaxed');
  ok(/deps\.toast\(t\('panel\.f\.consentStillUploading', \{ pct: consentUploading\.pct \}\), 6000\);\s*\n\s*return;/.test(panel),
     'it says how far along the upload is, then returns — no red field, no error toast');
}

console.log('\n...and the requirement itself is untouched — relaxing it would be the worse bug');
{
  /* If consent asks for audio and no audio is configured, the device shows a consent prompt with
   * nothing to play. That has to keep failing validation. */
  ok(/if \(ask\.includes\('audio'\) && blank\(raw\.consentAudioUrl\)\) out\.push\(\{ group: 'consent', field: 'consentAudioUrl'/.test(panel),
     'consent-audio is still a required field when consent asks for audio');
  ok(/'panel\.val\.consentAudio'/.test(panel), 'and still has its own validation message');
}

console.log('\nthe wording says "not finished", not "failed"');
{
  const en = (i18n.match(/'panel\.f\.consentStillUploading': '([^']*)'/) || [])[1] || '';
  ok(/still uploading/i.test(en), 'it names the actual state');
  ok(/\{pct\}/.test(en), 'and includes the percentage, so the wait has a size');
  ok(/nothing has gone wrong/i.test(en), 'it explicitly says nothing is wrong — the whole point of the item');
  ok(/press Save again|then press/i.test(en), 'and tells the researcher what to do next');

  const block = (lang) => {
    const at = i18n.indexOf(`\n${lang}: {`);
    const rest = i18n.slice(at + 1);
    const nxt = rest.search(/\n[a-z]{2,3}: \{/);
    return nxt < 0 ? i18n.slice(at) : i18n.slice(at, at + 1 + nxt);
  };
  for (const k of ['panel.f.consentUploadingPct', 'panel.f.consentFinishing', 'panel.f.consentStillUploading']) {
    const re = new RegExp(`^  '${k.replace(/\./g, '\\.')}':`, 'm');
    ok(re.test(block('en')) && re.test(block('id')), `${k} is in en AND id`);
  }
}

console.log(fail ? `\nFAILED (${fail})\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
