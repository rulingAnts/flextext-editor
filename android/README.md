# Flextext native wrappers

Native app shells for the [Flextext suite](https://github.com/rulingAnts/flextext-editor) —
an offline-first interlinear text editor and voice recorder used for language documentation
and Bible translation.

**These exist for one reason: archive-quality audio capture.** Everything else — the whole
editor/recorder UI, upload, consent, glossing — is the shared web engine from the
`flextext-editor` repo, unchanged.

## Why a native build is necessary

Two independent, archival reasons. The second is the stronger one and is often overlooked:

1. **The browser controls the microphone, and won't let go.** In a mobile WebView the browser
   sets the input level itself and offers no analog-gain control, so a loud voice clips. The only
   escape a web app has is automatic gain control — but AGC is *processing*, which
   [IASA TC-03](https://www.iasa-web.org/technical-committee) and
   [FADGI](https://www.digitizationguidelines.gov/guidelines/digitize-audio.html) prohibit on a
   preservation master. Native capture sidesteps the dilemma entirely.

2. **The web cannot record at a chosen bit depth at all.** The Web Audio API is 32-bit float
   end-to-end *by specification* — `AudioWorkletProcessor` only ever receives `Float32Array`, and
   there is no integer capture path. A web app can therefore only capture float and reduce
   afterwards; "16-bit" or "24-bit" from a browser is always a conversion, never a capture.
   Android's `AudioRecord` can request a genuine 16/24/32-bit integer capture from the converter.

## The honesty contract

The plugin's purpose is to be *auditable*, because a language archive may have to sign off on it.

- **`capabilities()`** reports only what the device can genuinely do — proven by actually opening
  an `AudioRecord` for each encoding and sample rate, not by assuming.
- **Substitution is allowed; silent substitution is not.** If a device cannot record the requested
  format, capture falls back to the closest it truly supports (preferring not to lose information)
  and reports `requested` vs actual, plus a plain-language reason.
- **Processing is reported per effect, not as a vague boolean.** Automatic gain control, noise
  suppression and echo cancellation are each queried on our own capture session, forced off, and
  reported as available / was-enabled / still-active. A device without Android's `UNPROCESSED`
  source can still yield a clean signal path — those are different questions and are reported
  separately.
- **Bit depth is a property of the file, not the microphone.** A phone converter yields roughly 16
  effective bits, so extra depth is headroom, not detail. The tooling never implies otherwise.

## Layout

- `plugin/` — the shared native audio plugin (`FlextextAudio`), used by both apps.
- `apps/recorder/`, `apps/editor/` — thin Capacitor shells.
- `tools/diagnostic/` — a capability + test-recording page. Sideload it to find out what a
  particular handset can really do.
- `scripts/build-diagnostic.sh` — builds that diagnostic into an installable APK.

Desktop (Windows/Mac) wrappers via Tauri are planned for the same reason.

## Build

Requires the Android SDK and a JDK 21 (Android Studio's bundled runtime works).

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=~/Library/Android/sdk
./scripts/build-diagnostic.sh
```

## Licence

[AGPL-3.0](LICENSE), matching the rest of the Flextext suite.
