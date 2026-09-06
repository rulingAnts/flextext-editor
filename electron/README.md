# Flextext Desktop — the Windows shell

**Status (2026-09-06): a test build.** One Windows x64 pre-release exists (`desktop-v0.1.0-test`,
2026-07-23). It is unsigned and has not been handed to field users. The web app at
<https://app.flextext.app> is the product; this shell exists for one thing the web cannot do.

## Why it exists

Two independent archival reasons, the same two as the Android apps (`../android/README.md` has the
full argument):

1. **Browsers control the microphone and offer no analog gain control.** The only escape a web app
   has from a clipping input is automatic gain control, and AGC is processing, which IASA TC-03 and
   FADGI prohibit on a preservation master.
2. **The Web Audio API is 32-bit float by specification.** A browser can capture float and convert
   afterwards; it can never capture at a chosen integer bit depth. "16-bit" or "24-bit" from a
   browser is a conversion, never a capture.

Chromium inside Electron has exactly those limits, so capture does not run in the renderer at all.

## How it works

- **`src/main.js`** opens the live editor site in one window: sandboxed, context-isolated, no Node
  in the page, DevTools off unless a build flag turns them on, and only the media permission
  granted. Navigation and window-opens are refused unless they stay on the site's origin. The
  default URL is the GitHub Pages editor; `FLEXTEXT_URL` overrides it (`npm run start:local` points
  at the dev rig on port 8012). If the site cannot be reached at start, a plain offline notice is
  shown instead of a blank window.
- **`src/preload.js`** is the security boundary. It exposes exactly one object to the page,
  `window.__flextextNative`, with the audio methods and nothing else: no `fs`, no `shell`, no
  generic `ipcRenderer.invoke`. The method names and return shapes mirror the Android
  `FlextextAudioPlugin`, so the engine's `docs/js/native-audio.js` treats Capacitor and Electron
  as one contract with two transports. `CONTRACT_VERSION` is the same number in the plugin, this
  preload, and the engine; a mismatch makes the engine refuse the native path and say so.
- **`src/ipc.js`** maps every method to one named handler (`flextext-audio:*`). There is
  deliberately no "invoke anything" channel, because the page is remote content.
- **`src/audio.js`** is the capture engine. It spawns ffmpeg as a separate process: `dshow` on
  Windows to enumerate real device names and to record (the code also knows `avfoundation` for
  macOS, but only Windows is built), the PCM encoders to write WAV at an exact format (16-, 24-,
  32-bit integer or 32-bit float; 44.1, 48 or 96 kHz; mono or stereo), and the `astats` filter for
  the level meter. Captures land in the app's own data folder and follow the same
  absorb-then-delete lifecycle as Android: the engine stores the bytes in IndexedDB before the
  file is released.
- **`src/flags.js`** decides whether DevTools exist and fails closed: anything but a literal JSON
  `true` in `src/build-flags.json` means off. `FLEXTEXT_DEVTOOLS=1` is the escape hatch for running
  from source. It is tested without Electron (`test/devtools-flag.test.mjs`).

## The honesty gap

On Android the plugin proves what a device can capture by really opening `AudioRecord`, and
refuses to fabricate a depth the hardware cannot produce. ffmpeg does not behave that way: ask it
for 24-bit from a 16-bit interface and it writes a 24-bit file holding 16 bits of information. So
this shell reports `probed: false` and `verifiedDepth: false`, and every capture result carries
`depthVerified: false`. A desktop recording must be described as **written at** N-bit, never
**captured at** N-bit, until per-device format probing lands (`-list_options` on dshow exposes it;
avfoundation does not).

## Building

`Build desktop (Windows)` is a manual GitHub Actions workflow (free: public repository, standard
`windows-latest` runner). It:

1. downloads the current BtbN **LGPL** ffmpeg build and stops if the binary was configured with
   `--enable-gpl` or `--enable-nonfree`, or lacks `dshow`, any of the four PCM encoders, or `astats`;
2. copies the licence text and a source pointer beside the binary (`resources/ffmpeg-LICENSE.txt`,
   `resources/ffmpeg-SOURCE.txt`), which is what the LGPL asks of a separate-process invocation;
3. stamps `build-flags.json` (DevTools on only for a build somebody asked for);
4. runs `npm run dist:win` (electron-builder, portable x64 exe) and, if asked, attaches it to a
   pre-release for a stable download URL.

The output is **unsigned**. Windows SmartScreen warns on first run ("Windows protected your PC";
More info → Run anyway). Code signing needs a paid certificate; until then the warning is expected,
and anyone testing a build is told so in advance rather than left to assume the app is broken.

From source: `npm install`, then `npm start` (live site) or `npm run start:local` (dev rig). Without
an ffmpeg beside the app, `capabilities()` reports `ffmpeg_not_found`, and the engine falls back to
browser capture and says so rather than pretending.

## Licence

AGPL-3.0, like the rest of the suite (`../LICENSE`). ffmpeg is bundled under the LGPL and invoked as
a separate process, never linked; its licence and source offer ship in `resources/`.
