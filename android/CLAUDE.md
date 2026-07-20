# flextext-native — Capacitor (Android) wrappers for the Flextext suite

Native shells for the **Flextext Recorder** and **Flextext Editor** PWAs. The ONLY reason
these exist is **audio capture**; everything else stays web.

## Why native at all (two independent archival reasons)

1. **AGC-or-clip.** The Chromium System WebView drives mic input high and gives web code no
   analog-gain control, so a loud voice clips — and the only web escape (AGC on) is *processing*,
   which IASA TC-03 / FADGI forbid on a preservation master. `AudioRecord` with
   `MediaRecorder.AudioSource.UNPROCESSED` avoids the whole dilemma.
2. **True bit depth.** The Web Audio API is **32-bit float end-to-end by specification** —
   `AudioWorkletProcessor` only ever receives `Float32Array`. So a web app can *never* capture at a
   chosen integer depth; it can only capture float and reduce afterwards. `AudioRecord` can request
   a genuine 16/24/32-bit integer capture off the ADC. This is what makes "the researcher chose
   24-bit and the app really recorded 24-bit" an auditable fact rather than a claim.

## Architecture — keep the native side DUMB

- `plugin/` — **the shared native audio plugin** (`FlextextAudio`, Java). Opens the mic, writes the
  exact ADC bytes into a WAV container, reports peak levels for the meter. **No gain, no
  resampling, no bit-depth conversion, no DSP.** Both apps use this one plugin.
- `apps/recorder/`, `apps/editor/` — thin Capacitor shells (`app.flextext.recorder`,
  `app.flextext.editor`).
- The web engine lives in the **`flextext-editor` repo** and is copied into each app's `www/` at
  build time. Never hand-edit `www/` and never commit it — that would fork the engine.

**Why dumb matters:** native code cannot be auto-updated (no service worker, no OTA of native code
— Google forbids it). Everything that churns — encoding, formats, UI, upload, consent, i18n —
stays in the web engine so it keeps auto-updating. Keeping the native surface to "give me clean
bytes" makes an APK rebuild a rare event.

## The honesty contract (do not weaken this)

- `capabilities()` probes what *this* device can genuinely capture by really opening an
  `AudioRecord` for each combination, and reports `unprocessedSupported` from
  `AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED`.
- `start()` **rejects** a format the device cannot truly capture. It must NEVER silently substitute
  a different depth or rate — a fabricated "24-bit" file poisons the provenance chain.
- Bit depth is a property of the *file*, not the microphone: a phone ADC yields ~16 effective bits,
  so extra depth is **headroom, not detail**. Never imply otherwise.

## Input routing — WHICH microphone (added 2026-07-20, easy to revert)

The plugin proved what **format** a device could capture but said nothing about the **source**.
Those are independent, and the gap was real: a Bluetooth headset routes input through SCO at
8/16 kHz, heavily processed, and Android will hand those samples to an `AudioRecord` configured for
24-bit/48 kHz. The result is a genuine 24-bit/48 kHz WAV containing narrowband compressed audio —
every number in it correct, the whole thing misleading, since upsampling adds no information. That
is the fabricated-provenance failure the honesty contract exists to stop, arriving through a door
the contract did not cover.

**How likely, honestly:** less than that framing suggests. SCO input normally requires
`startBluetoothSco()`, which this plugin never calls, so the built-in mic is the expected route on
stock Android. But OEM behaviour varies across exactly the cheap phones this project targets, and
newer Android can route BLE headsets. So the primary value is **making the route an observed fact
instead of an assumption**; steering is a secondary safeguard.

**What it does** (all in `plugin/.../AudioRouting.java`):
- before capture, `setPreferredDevice()` toward the best-ranked input (USB > wired > built-in), and
  only ever to *avoid* a wireless route — if the only mic is wireless, it records anyway;
- after `startRecording()`, `getRoutedDevice()` reports what was actually used.

**Added fields on `start()`** — additive only, so **`CONTRACT_VERSION` stays 1** and an engine that
has never heard of routing is unaffected:

| Field | Meaning |
|---|---|
| `routedDevice` | product name, or null if the OS did not say |
| `routedType` | `builtin_mic` / `usb_device` / `bluetooth_sco` / `ble_headset` / … |
| `routedWireless` | true only for SCO/BLE |
| `routedArchival` | `!routedWireless` |
| `routedNote` | plain-language explanation when not archival |

`archivalClean` is deliberately **not** changed by the native side — its documented meaning is "no
OS processor left running", which stays true and separately measured. The web chokepoint
(`docs/js/native-audio.js` → `NativeRecorder._normalizeArchival`) merges the two claims, so an old
APK reporting no `routed*` fields behaves exactly as before. That separation is what lets the APK
and the engine ship on different schedules; keep it.

### To revert (no APK users existed when this landed)
1. `AudioRouting.ENABLED = false` — every method becomes a no-op, nothing else changes; **or**
2. delete `AudioRouting.java` and the two blocks in `FlextextAudioPlugin.java` marked
   `// --- AudioRouting ---` (no imports were added, so there is nothing else to unpick); **or**
3. `git revert` the single commit that introduced it.

The engine-side merge is inert without the native fields, so it can be left in place either way.

**Unverified:** written and compiled, packaged into the APK (confirmed in the dex), but the routing
behaviour itself has **never run on real hardware** — an emulator certifies nothing about audio
routing, exactly as it certifies nothing about `UNPROCESSED`. Treat `routedType` as unproven until
a real phone reports it.

## ⚠ THE JS↔NATIVE CONTRACT — read before touching engine code

The web engine **auto-updates** (service worker today, OTA bundle later). The **APK does not.**
So a web-side change that breaks this contract breaks *installed field apps* with no obvious
cause, and no way to push a fix except a new APK. Treat this boundary as load-bearing.

`capabilities()` returns **`contractVersion`** (currently **1**). The web adapter MUST check it and
degrade loudly — never silently — on mismatch. **Bump `CONTRACT_VERSION` in
`FlextextAudioPlugin.java`** whenever a method is added/removed or a returned field changes meaning.

### Methods (the whole surface — keep it this small)
| Method | Purpose |
|---|---|
| `capabilities()` | what this device can genuinely capture + `contractVersion`, `recommended{}`, `effectsAvailable{}` |
| `requestMicPermission()` | permission prompt |
| `start({encoding,sampleRate,channels,notificationTitle,notificationText})` | begin capture; returns `requested{}` vs actual, `substituted`, `substitutionReason`, `effects{}`, `archivalClean` |
| `stop()` | ends capture; returns the file `path`/`uri` + the full provenance record |
| `cancel()` | abandon capture and delete the file |
| `deleteCapture({path})` | called AFTER the web layer has absorbed a capture |
| `listCaptures()` / `cleanupCaptures({keep})` | orphan sweep |
| event `meter` | `{peak}` 0..1, ~10/s (the web meter cannot see a native stream) |

### Capture-file lifecycle — absorb, THEN delete
1. `stop()` → returns a path in `filesDir/flextext-captures` (deliberately **not** cacheDir: the OS
   purges cacheDir under storage pressure and these users run storage at 100%).
2. Web layer reads it via **`Capacitor.convertFileSrc(path)` + `fetch()` → `Blob`** — **NOT**
   `Filesystem.readFile`, which returns base64 (~33% inflation through the JS bridge; a 10-minute
   24-bit capture is ~86 MB and would OOM a cheap phone).
3. Web layer stores the Blob in IndexedDB (byte-exact; the WAV header carries rate/bits/channels,
   and the provenance JSON from `stop()` is persisted as doc fields).
4. **Only then** call `deleteCapture({path})`.
5. On startup, call `listCaptures()` and `cleanupCaptures({keep})` to sweep orphans left by a crash
   or an OEM process-kill between steps 1 and 4. Native never auto-deletes: only the web layer
   knows what was really absorbed, and guessing would destroy field data.

### Containment rules for the web side (so a future session can't break Android by accident)
- **ONE chokepoint file** in the `flextext-editor` repo — `js/native-audio.js` — is the **only**
  place allowed to reference `window.Capacitor`. A `grep -rn "window.Capacitor" js/` hit anywhere
  else is a bug, not a style preference.
- That module is **inert on the web**: it feature-detects and returns a null backend, so every
  non-native app path behaves exactly as before. Nothing else in the engine needs to know Android
  exists.
- It exposes a **small, documented backend interface** matching the existing capture backends
  (`record-pcm.js`, MediaRecorder), so the engine selects a backend and is otherwise unaware.
- It carries a **loud header comment** stating: this is the native bridge, the APK cannot
  auto-update, changing this file requires rebuilding and re-testing the APK.
- **Do not "tidy", inline, or refactor it** while working on unrelated engine features. If a change
  seems to require touching it, that is a signal to stop and rebuild/verify the APK.

## Build

Requires the Android SDK + Android Studio's bundled JDK 21.

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=~/Library/Android/sdk
cd apps/recorder && npx cap sync android && cd android && ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

Release signing keys are **never** committed and never handled by an agent.

---

## ⚠️ GitHub costs — ask before anything billable (firm policy, 2026-07-07)

**Claude: never trigger anything that can incur GitHub charges without Seth's explicit approval
AND a stated cost estimate first.**

- FREE, always: Actions on **public** repos with **standard** GitHub-hosted runners; self-hosted
  runners; GitHub Pages.
- METERED (free monthly quota, then paid): Actions in **private** repos (2,000 min/mo; **Windows
  counts 2×, macOS 10×**); Codespaces; Packages; Git LFS.
- **ALWAYS billable, even on public repos: larger / GPU runners.**
- Safety valve: with **no payment method on file, GitHub blocks usage at the quota and cannot
  bill** — keep it that way, or set stop-usage budgets.

So WITHOUT Seth's explicit OK (and cost), do **not**: add or change `.github/workflows/**`; use a
non-standard `runs-on:`; add a `schedule:` trigger; create Codespaces; use Git LFS; publish private
Packages; or change the plan / budgets. The local `.git/hooks/pre-push` blocks workflow pushes
(override `ALLOW_WORKFLOW_PUSH=1`) and production-branch pushes (`ALLOW_MAIN_PUSH=1`) — set those
flags only after Seth approves that specific push.
