# What only a native shell can do better — and how to build for it now

**Audience:** anyone extending this engine, and anyone deciding whether a limitation is ours or the
platform's. Public on purpose: when a coworker reports that the app "won't stop correcting my
typing" or "won't record at archive quality," the honest answer is often *the browser cannot do that,
and here is what we are doing about it.*

## The principle

> "Whenever things like that come up (we can go this far with a PWA, but to actually solve this
> problem, we need the native version), make a note of that and also make design decisions that are
> forward-compatible with that design direction — for example modularized functions and libraries
> that handle a certain action or property and then take that and translate it to the specific
> platform code and functionality while the main PWA code can't tell the difference."
>
> "Areas where native and pure-PWA code have to diverge have some kind of intermediate
> function/library/module layer that handles the detection and translation so that the rest of the
> engine code doesn't have to deal directly with native/non-native decisions, but rather just use
> the API for things that might or might not interact with a native shell."
>
> "This is so that in general we don't have to update the native shell often."
> — Seth, 2026-09-10, as a general design principle

### Why "don't update the shell often" is the whole point

**The engine auto-updates. The APK and the desktop installer do not.** A field device in Papua gets
a new engine the next time it has any connection at all; it gets a new APK when someone carries a
build to it. Both bundled engines have already sat ~500 releases stale (issue #61).

So the split is: **the shell declares what it can do; the engine decides what to do about it.**
Anything we might change our mind about — policy, defaults, wording, which field gets which
treatment — stays in JS and ships continuously. The shell gains a *capability*, once, and is then
left alone.

### What is and is not a capability seam

⚠ **This is not about platform detection in general.** Seth: *"a UA sniff for things that a browser
can handle, I think is fine... Anything that CAN be purely browser handled isn't what I'm talking
about. But things that can do better with native, there's where we want the capability seams."*

- **No seam needed** — whether Space should play or type (a phone/laptop difference the browser
  answers perfectly well). Sniff away, at the point of use.
- **Seam** — anything a native shell can do *better* or at all: input-method control, real audio
  device control, background work, filesystem access.

### The shape of a seam

One module owns the question. Callers state *what they want*, never *what platform they are on*.

```
engine code ──▶  applyTyping(el, VERN)          "this field is vernacular"
                      │
                 typing.js                       owns the policy AND the question
                      ├─ browser answer:  a UA/feature test, fine to keep here
                      └─ native answer:   setTypingPlatform({...}) — the shell declared it
```

Three rules that make it work:

1. **The capability is a declaration, not a code path.** The shell says
   `{ dialsAreIndependent: true }`; it does not implement the decision. New policy needs no new APK.
2. **Generic primitives, not features.** A shell method should be
   *"set these input flags on the focused field"*, not *"harden the gloss box"*. The first is
   written once; the second changes every time we learn something.
3. **The browser answer is the default, and it is the pessimistic one.** An engine running with no
   shell must be correct and safe on its own, and the shell can only improve matters.

Existing seams: `docs/js/native-audio.js` (the audio bridge — the *only* file allowed to touch
`window.Capacitor`, enforced by `./check-native-containment.sh`) and `docs/js/typing.js`
(`setTypingPlatform` / `canMarkWithoutReplacing`).

---

## Register of native-only capabilities

### 1. The on-screen keyboard — everything Android Chrome does not expose

**Issue:** #62 · **Seam:** `docs/js/typing.js` · **Policy:** `plans/typing-policy.md`

**How far the PWA gets.** On a desktop browser, all the way: `spellcheck` draws squiggles and there
is no autocorrect to speak of, so "mark misspellings, change nothing" is exactly what you get. On
Android it stops dead. `spellcheck` is the *only* lever a web page has, and it is all-or-nothing:
`false` sets `TYPE_TEXT_FLAG_NO_SUGGESTIONS` and the keyboard goes silent; `true` hands Gboard
marking **and** suggesting **and** replacing as one bundle. `autocomplete`, `autocorrect` and
`writingsuggestions` do not separate them — and `autocorrect="off"` alone was verified insufficient
on the production WebAPK.

**What native does.** `TYPE_TEXT_FLAG_AUTO_CORRECT` and `TYPE_TEXT_FLAG_NO_SUGGESTIONS` are
**separate bits** on `EditorInfo`. Override `onCreateInputConnection` on the Capacitor WebView and
the shell can leave the suggestion strip visible while forbidding the automatic swap — which is
precisely the thing that was asked for: *"offering them choices, but not automatically correcting."*

**Why it matters here.** A Fayu speaker writing Indonesian glosses spells by ear — `fedahu` for
*perahu*, `tudu` for *turun*, because Fayu has neither /p/ nor /r/. Suggestions genuinely help them.
Automatic replacement silently destroys vernacular data instead. Today Android has to forgo both.

**And the flags are only the first thing behind this seam.** Gboard is a whole surface that Android
Chrome hands a web page almost none of, and every item below is something this suite has an active
reason to want:

- **Which language the keyboard corrects in.** `lang` on a field selects a *desktop* browser's
  dictionary and has no effect on Gboard, which corrects in whatever language its own settings say.
  A gloss field cannot ask to be corrected as Indonesian.
- **Which languages the keyboard has enabled** — `InputMethodManager.getEnabledInputMethodSubtypeList`.
  This is the one worth having soonest: right now the app cannot tell that a device's Gboard has
  English switched on and is about to pull Indonesian glosses toward English. Natively it could see
  that and *warn the researcher during setup*, which is a fix that needs no new policy at all.
- **Soft-keyboard visibility and height**, reliably. The web platform's answer is the VirtualKeyboard
  API (Chromium-only) or guessing from viewport resizes; getting it wrong is issue #43, where the
  keyboard covers the segment being typed.
- **Selecting an input method or subtype per field**, so a vernacular field and a gloss field can
  present different keyboards instead of relying on the typist to switch by hand every line.

**Generic primitives for the shell:** `setInputFlags({ noSuggestions, autoCorrect })` and
`setInputLanguage(tag)` on the focused field, `keyboardLanguages()` for the warning above, and
`onKeyboardGeometry(cb)`. Which fields get what, and every word of the warnings, stays in JS.

### 2. True hardware/OS-level control of archive-quality recording

**Issue:** #63 · **Seam:** `docs/js/native-audio.js` · **Background:**
`docs/help/recording-limits.html`

**How far the PWA gets.** Further than people expect, and not far enough to promise an archival
master. `getUserMedia` accepts `sampleRate`, `channelCount`, and requests to disable
`echoCancellation` / `noiseSuppression` / `autoGainControl` — but these are *requests*. The browser
or the OS may quietly ignore them, resample, or leave processing engaged, and what actually reached
the file is not reliably reportable afterwards. Bit depth is not expressible at all: the Web Audio
graph is float32 internally and the encoder decides what lands on disk. There is no exclusive device
access, no way to bypass the OS voice-processing pipeline, and no honest way to certify that a given
recording met a stated specification.

**What native does.** Android exposes `AudioSource.UNPROCESSED` (explicitly documented as no
device-side processing) and, via AAudio/Oboe, exclusive low-latency device access with a *known*
sample rate and PCM format. The shell can therefore both *set* the capture format and *report what
it actually got* — the difference between hoping for archive quality and being able to state it.

**Why it matters here.** These recordings are the primary record of a language with very few
speakers. A file that is quietly gain-ridden, denoised and resampled is a worse archival object than
one honestly labelled as a field recording, and right now the app cannot always tell which it has.

**Generic primitive for the shell:** `openCapture({ sampleRate, bitDepth, unprocessed })` returning
the format actually granted. Format *choice*, warnings and defaults stay in JS.

### 3. Getting files in and out — file picker, folder grants, and the Android share sheet

**Issue:** to file · **Seam:** to build (`docs/js/files.js`)

**How far the PWA gets.** `<input type="file">` for one-shot picking and a blob download for getting
something back out, and that is close to the whole story on Android. The File System Access API —
which would give a *remembered* folder handle — is Chromium desktop only. So on a tablet: every
export lands in Downloads with no say in the matter, every import is a fresh trip through a picker
that has forgotten where you were last time, and the app cannot receive a file another app wants to
hand it. Web Share Target exists but only for an installed PWA, only for the types declared in the
manifest, and it cannot send.

**What native does.** Android's Storage Access Framework grants a **persistent** directory
(`ACTION_OPEN_DOCUMENT_TREE`) that survives restarts — "put the exports here, always." Share intents
work in both directions: the app appears in the share sheet when a coworker forwards a recording over
WhatsApp or Bluetooth, and can hand a finished bundle straight back to any app on the device.

**Why it matters here.** This is how files actually move in the field — WhatsApp, Bluetooth, a
memory card, a phone passed across a table. Making every transfer route through a browser download
folder adds a step at exactly the point where the person doing it is least likely to be comfortable
navigating a file manager.

**Generic primitives for the shell:** `pickFile({ accept })`, `pickFolder()` returning a persistable
handle, `saveInto(handle, name, bytes)`, `shareFile(name, bytes)`, and an inbound
`onSharedFile(cb)`. Which files, named how, and when, all stay in JS.

### 4. Talking to FLEx directly — a researcher / corpus-keeper shell on Windows

**Issue:** to file · **Seam:** to build · **Not a field-device capability**

**How far the PWA gets.** Nowhere near, and it never will. A FLEx project is a local LibLCM database
reached through .NET assemblies. Everything this suite does with FLEx today goes through
`.flextext` XML that a human exports, moves, and re-imports by hand — which is also where writing
system codes get mangled and where a round trip loses anything the format does not carry.

**What native does.** A Windows shell for the researcher (not the coworker) could load LibLCM
directly, or drive `flexlibs2` through a bundled Python, and then: read and write the project in
place, round-trip analyses without an XML hop, query the lexicon live so glossing can offer real
entries instead of guesses, and push finished texts straight in.

**Why it matters here.** The hand-carried XML round trip is the most error-prone step in the whole
pipeline and the one a linguist repeats most often. It is also the step that produces the writing
system breakage the separate FLEx Writing Systems Utility exists to clean up afterwards.

**Generic primitive for the shell:** a narrow local RPC — `flexQuery(kind, args)` and
`flexApply(change)` — with the engine unaware whether a bridge is present. With no shell the calls
resolve to "unavailable" and the app offers the XML path exactly as it does today, which is the
default-safe rule again.

⚠ Scope note: this one serves a researcher at a desk on Windows. It must not become a reason to make
the field devices — the primary audience — depend on anything but the browser.

---

## Adding an entry

When a limitation turns out to be the platform's rather than ours:

1. Add a section here — how far the PWA gets, what native does, why it matters for this work, and
   the generic primitive the shell should expose.
2. File a GitHub issue and cross-reference it, so the work is tracked and not just described.
3. Put the seam in *now*, with the browser's answer as the default. The point is that when the
   native side eventually lands, nothing above the seam has to change.
