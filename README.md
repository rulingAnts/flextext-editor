# Flextext Editor

Copyright © 2026 Seth Johnston. Licensed under the
[GNU AGPL v3.0](LICENSE) — you may use, modify, and redeploy this app
(e.g. for your own language project), provided derivative deployments also
share their source under the same license.

**Other licensing options.** The AGPL is the licence for everyone, and it stays.
Separately, I am willing to grant other terms — for example MIT-style permission
to use, modify and incorporate this code in your own software — to partner
organisations and individuals for their own work, on a case-by-case basis, on
request. Ask through <https://flextext.app/contact>, saying what you would like to use and how.

Developed collaboratively with [Claude Code](https://claude.com/claude-code)
(Anthropic's AI coding agent), which implemented the application from the
FLEx flextext schema and real interlinear exports under Seth's direction.
Bundles [wavesurfer.js](https://wavesurfer.xyz/) (BSD-3-Clause, see
`js/vendor/wavesurfer.LICENSE`).

> ## ⚠ Which branch you are looking at
>
> | branch | what it is |
> |---|---|
> | **`productionWeb`** | the live release. Every production site (`*.flextext.app`, and the legacy GitHub Pages editor) is built from it. It only moves forward by fast-forward after the maintainer has tested staging and signed off. |
> | **`main`** | the release line; fast-forwarded together with `productionWeb` at every release, so the two match. |
> | **`staging`** | what the staging estate (`staging-*.68mh29kgsd.workers.dev`) is built from; feature branches are merged here for testing first. |
> | feature branches | day-to-day work (currently `satellite-apps-v566`); may be broken at any moment. |
>
> Running the live apps: <https://app.flextext.app> (editor) and the others listed under
> [Repository layout](#repository-layout--one-repo-seven-published-sites); deployment mechanics in
> [Deployment](#deployment).

An offline-capable web app (PWA) for documenting oral texts with minority-language communities.
The **editor** duplicates FieldWorks Language Explorer's interlinear **Baseline** and **Gloss** tabs
and adds a **Cut** tab that segments a recording into playable lines, editing
[`.flextext`](notes/FlexInterlinear.xsd) files directly — no FLEx, no lexicon, no server. Around
it sit six sibling apps built on the same engine (recording, crowd recording, audio segmentation,
consent capture, paragraph analysis, and the researcher's console). Built for the workflow where a
researcher sets up the language settings and a native-speaker coworker, who may be barely literate,
transcribes, glosses, segments and free-translates texts on whatever device they have — a cheap
Android phone or tablet first, then Windows, Mac and Linux.

**Where this is going:** `ROADMAP.md` lists what is in progress and what is planned, with the
design of each. The largest item is the [Corpus Keeper](https://github.com/rulingAnts/corpus-keeper)
plan, which ties the suite to FLEx, lameta and a corpus checklist so one researcher can keep texts,
recordings, consent and archive metadata in step; the plan and its issues live in that repository.

## How it works

**Researcher (once):**
1. Open the app → **Research** tab.
2. Enter the vernacular and analysis writing systems (code, name, optional font).
3. Click **Copy setup link for coworker** and send the URL via WhatsApp/email/etc.

**Coworker:**
1. Open the link — settings are saved to the browser automatically.
2. Bookmark it / "Add to Home Screen" (the service worker makes it work fully
   offline afterwards).
3. **New text** → type the story on the **Baseline** tab (Enter = new paragraph;
   sentences split automatically at `. ! ?`).
4. Switch to the **Gloss** tab: type a gloss under each word, use the small
   chain link 🔗 between two words to merge them into a phrase (✂ break to
   undo), and fill in the **Free** translation line per sentence.
5. **Save and send…** — uses the system share sheet on mobile (WhatsApp,
   Signal, email, …), file save dialog or download on desktop.

Going back to the Baseline tab and editing works like FLEx: unchanged sentences
keep their glosses and free translations; edited sentences keep glosses for the
words that still match; removed material loses its annotations.

Everything is autosaved locally (IndexedDB). The **Texts** screen is a library
of all texts on the device; texts can also be re-opened from `.flextext` files.
Files containing multiple `<interlinear-text>` elements (FLEx can export a
whole corpus into one file) import as separate texts in the library.

## Audio task links

The Research tab's **Task link** form builds a URL that configures the
coworker's device, creates a titled text, and auto-downloads a recording into
a waveform player (wavesurfer.js, BSD-3-Clause, vendored) pinned above the
typing area — play/pause, jump-back-3s, playback speed, and a scrollable,
zoomable waveform. The audio blob and decoded peaks are stored in IndexedDB,
so after the first download the whole task works offline; if the link is
opened offline, the download retries automatically when a connection returns.
Re-opening the same task link never duplicates the text. Audio can also be
attached manually from a local file on the Baseline tab.

Transcribers can also start from a recording themselves: **New text from
audio…** on the Texts screen creates a titled text with the file loaded in
the player.

Audio sources can be any CORS-friendly direct URL, **or a researcher's own
Google Drive**. Uploads stream through a Cloudflare Worker into the
researcher's own Drive using their `drive.file` token; downloads (task audio,
consent prompts) are proxied by the same Worker. The old Apps Script relay for
uploads has been **retired** — its source is kept only for reference at
[notes/drive-relay.gs](notes/drive-relay.gs). Recommended distribution format:
mono 64 kbps MP3 (≈0.5 MB/min). Exports reference the recording via a
`<media-files>` element so FLEx can re-link it.

## Platform support & install

Supported: **Firefox and Chromium browsers (Chrome/Edge) on Windows, Mac,
Linux, and Android** — Android and Windows first. Safari/WebKit (including
all iPhone/iPad browsers) is not supported; those users see a dismissible
warning suggesting Firefox or Chrome.

On Chromium browsers the app offers a one-tap **Install app** banner
(`beforeinstallprompt`), so transcribers get a home-screen/desktop app
without hunting through browser menus; Firefox users get instructions in the
built-in help.

## Repository layout — one repo, seven published sites

**All development happens in this repository.** `docs/` is the engine and the editor's own site;
everything else is committed but only served through the deploy plumbing described below.

```
docs/                THE ENGINE + the editor site (index.html, js/, css/, help/, sw.js)
satellites/          the five sibling app shells (each an index.html + manifest + sw.js + icons)
paragraph-analysis/  the Paragraph Analysis Tool shell
apps/                Cloudflare deploy plumbing, one folder per site (build.sh copies docs/ in, deploy.sh routes
                     productionWeb → production, any other branch → a staging alias)
worker/              the connectivity Worker (Cloudflare Worker + D1 + Drive) and its migrations
android/             Capacitor wrappers — recorder + editor APKs (see Native shells)
electron/            the Windows desktop shell (see Native shells)
test/                the node test suite (`node --test "test/*.test.mjs"`)
plans/               design docs and the release smoke-test checklist — tracked, never served
notes/               schema, retired code, samples — gitignored, never served
```

### The apps

Every app is a thin shell that loads **this repo's engine** (`docs/js/app.js` + `docs/css/app.css`)
and sets `window.__MODE`. None is a fork; all logic lives in `docs/js/`.

| App | Production | Source | What it is |
|---|---|---|---|
| **FlexText Editor** | `app.flextext.app` | `docs/` | Baseline / Cut / Gloss tabs; the reference app |
| **Flextext Recorder** | `record.flextext.app` | `satellites/text-recorder/` | record → consent → send, for coworkers gathering audio on a phone |
| **Audio Segmenter** | `audio-segmenter.flextext.app` | `satellites/audio-segmenter/` | cut a recording into lines and match them to a text, one row per line; ELAN export |
| **Consent Collector** | `consent.flextext.app` | `satellites/consent-collector/` | recorded consent and receipts, importable with or without a text |
| **Crowd Recorder** | `crowd.flextext.app` | `satellites/crowd-recorder/` | public, embeddable, one-clip contribution |
| **Paragraph Analysis Tool** | `pat.flextext.app` | `paragraph-analysis/` | groups interlinear lines into phrase → clause → sentence → paragraph trees (`.fxpa`) |
| **Flextext Researcher** | `research.flextext.app` | `satellites/flextext-researcher/` | the researcher console: devices, assignments, settings push, Drive corpus, history |

Each production site is its own origin, which is what lets each be installed as its own PWA (two
PWAs sharing a scope are one installed app to the browser). The editor is additionally still served
by GitHub Pages at `rulingants.github.io/flextext-editor/`, the original home, for installs that
predate the move; the researcher panel knows both estates and links companion apps accordingly.

### How they are published

`Deploy to production` (GitHub Actions, run by hand on `productionWeb` only) builds and deploys
**all seven** sites at one version — a release is one estate at one version, and every satellite's
service worker verifies at install that the engine it precached carries that same version, so a
partial deploy is refused rather than shipped. `Deploy to staging / preview` does the same per app
from any branch. The satellite GitHub repositories (`text-recorder`, `flextext-researcher`,
`crowd-recorder`) are machine-managed mirrors published by the `Publish satellites` workflow for the
GitHub Pages estate; do not edit them directly.

### Native shells — Android and Electron, and why they exist

The web is the product; the native shells are not forks and add no features. **They exist for one
reason: archive-quality audio capture**, which a browser cannot provide, for two independent
reasons:

1. **The browser controls the microphone and will not let go.** In a mobile WebView the browser
   sets the input level itself and offers no analog-gain control, so a loud voice clips. The only
   escape a web app has is automatic gain control, and AGC is *processing*, which IASA TC-03 and
   FADGI prohibit on a preservation master. Native capture sidesteps the dilemma.
2. **The web cannot record at a chosen bit depth at all.** The Web Audio API is 32-bit float by
   specification; a web app can only capture float and reduce afterwards, so "16-bit" or "24-bit"
   from a browser is a conversion, never a capture. Android's `AudioRecord` can request a genuine
   integer capture.

**Android** (`android/`, mirrored at `rulingAnts/flextext-native`): Capacitor wrappers for the
recorder and the editor, with one small plugin whose job is to be *auditable* — it reports only
capabilities it has proven by opening `AudioRecord`, never substitutes a format silently, and
reports each processing effect (AGC, noise suppression, echo cancellation) as available / was
enabled / still active. The full reasoning and the honesty contract are in `android/README.md`;
the JS↔native contract in `android/CLAUDE.md`.

**Electron** (`electron/`, public notes in `electron/README.md`): the Windows desktop shell, for
the same reason on laptops. The window loads the live editor site (the GitHub Pages editor by
default; `FLEXTEXT_URL` points it at a dev rig), so the shell adds no features and the engine keeps
auto-updating. Capture does not go through Chromium at all: the main process runs a bundled LGPL
build of ffmpeg as a separate process, which enumerates the real input devices and writes WAV at an
exact PCM format. The page sees one object, `window.__flextextNative`, whose methods and return
shapes mirror the Android plugin, so the engine treats Capacitor and Electron as one contract with
two transports. Its honesty gap is stated in the code: ffmpeg does not prove what an interface can
deliver, so a desktop capture is reported as *written at* N-bit, never *captured at* N-bit, until
per-device probing lands. Status: one Windows x64 test build exists as an unsigned GitHub
pre-release (2026-07-23, from the manual `Build desktop (Windows)` workflow); it has not been given
to field users.

**Containment**, because the engine auto-updates and an installed APK does not: `docs/js/native-audio.js`
is the only file allowed to touch a native global (`window.Capacitor` on Android,
`window.__flextextNative` on the desktop), it is inert in a browser, and
`./check-native-containment.sh` enforces that. A capture is absorbed into IndexedDB before the native
file is released, so nothing is ever deleted before it is stored.

## What the researcher can set on a device

Every setting below lives on the device's **Settings** tab (the editor and the segmenter each show
the groups that apply to them) and in the researcher panel, from which it is pushed to a paired
device and lands live, without a reload:

| Group | Settings |
|---|---|
| Languages | app language; vernacular and analysis writing systems (code, font) |
| Segmentation | segmentation on/off; Cut tab; land on Cut; Backspace joins; join/split on Baseline and Gloss; cut/join lines that already have text; **allow moving boundaries by dragging** (grips on the strips of all three tabs and movable cut marks on the Cut tab's top player; independent of the texted-lines switch); export timing as notes; which exports ride a bundle (ELAN, SayMore, listening page, JSON) |
| Recording | format, maximum length, AGC / noise suppression / echo cancellation, normalisation, archival defaults |
| Consent | ask, message, consent audio, confirmation |
| Sending | send options, delete after upload, automatic backup and its interval, recorder welcome |
| Other | which buttons show; Done button; delete and delete-all; alphabetical sort; **text size** (whole app, the top row and player excepted); **top-row buttons and tabs** (automatic / icons and words / icons only / words only; automatic is icons only when the window is narrower than 1000 px); **the Space bar plays / pauses** (automatic = off on a mobile device, an Android phone or tablet; a laptop with a touch screen counts as a laptop); **Gloss tab icon** (seven pictures, chosen from a picker that shows them; interlinear rows by default; each device keeps its choice and the dashboard counts which is in use); segmenter: blank lines, in-place text editing |

The top-row setting is on the segmenter's Settings tab as well as the editor's, and in the
researcher panel's device settings; the Space-bar setting is editor-only.

## Touch and keyboard

- **On a touch screen, a waveform strip behaves like a WhatsApp voice note:** a tap places the
  playhead; touching the playhead line and dragging scrubs; dragging anywhere else scrolls the page,
  at any slant, because the strip listens to no finger movement at all. Same on the listening page.
- **The top player is the same grammar plus zoom:** a tap places the playhead, the playhead line
  scrubs, dragging anywhere else scrolls the waveform once it is zoomed, pinching zooms (a trackpad
  pinch zooms too). Its thin cut marks show on all three tabs and follow a boundary you drag on a
  line, while the player zooms in on that spot for the length of the drag.
- **A boundary is moved by its grip** at either end of a line's waveform, never on the top player;
  the researcher's "allow moving line boundaries by dragging" switch removes every grip at once.
- **Space** plays or pauses outside a text box on a laptop or desktop, touch screen or not; on a
  mobile device it types a space (setting above). **Shift+Space** always plays or pauses, inside a box too, and inside a box it
  plays that box's own line without moving the cursor.
- When Space does not play, typing with no box selected goes to the line you last played: the
  nearest box is focused at its end and the keystroke lands there.
- **Splitting a line is one rule on every tab.** A more basic tab cannot split or join a line with
  more advanced data (the Cut tab leaves texted lines alone; the Baseline tab leaves glossed or
  translated lines alone). A split asks for one position per part the line has, in any order: the
  playhead for the sound, the cursor for the words or the translation, the scissors between two
  words; nothing changes until every part is placed, the part still needed is marked in orange with
  a scissors under it, and Escape, Undo, the same scissors again or a tap elsewhere cancels.
- **Enter** in a free-translation box places that translation's side of a split when the cursor is
  inside the text; in an empty box it moves to the next line. On the Gloss tab a word can be
  corrected in place without losing its gloss.

## Localization & help

The interface is available in **English and Indonesian** — auto-detected from
the browser, switchable (and remembered) via the selector in the top bar. The
researcher's setup link carries their current language, so the coworker's app
opens already localized. The **?** button opens built-in help with a simple
step-by-step section for transcribers and a technical section for researchers,
in both languages, available offline.

## Round-tripping FLEx files

The app can open real FLEx flextext exports. Anything it does not edit —
morpheme analyses, POS items, notes, literal translations, scripture
milestones, media links, metadata — is preserved verbatim and re-emitted on
export, except for words/sentences the user actually changes (where stale
analyses are dropped, matching FLEx's own baseline-edit behavior).

The **Research** tab also has a **Writing system checker**: open any flextext
file, see which writing-system codes are in use on each interlinear line
(baseline, word, gloss, morphemes, free translation, …), remap wrong codes, and
download the corrected file. This operates on the raw XML and preserves
everything.

## Format

Follows `FlexInterlinear.xsd` from the FieldWorks sources (copy in
[notes/](notes/FlexInterlinear.xsd)):
`document > interlinear-text > paragraphs > paragraph > phrases > phrase >
words > word`, with `item` elements (`txt`, `punct`, `gls`, `segnum`, `pos`, …)
carrying `lang` writing-system codes, chained words as `<word type="phrase">`,
and a `<languages>` declaration block.

## Development

Static site, **no build step**. All web source lives in `docs/`.

```sh
python3 dev_server.py --port 8765   # HTTPS via mkcert — needed for microphone access
bash dev-serve.sh 8012              # serves the editor AND satellites at their real paths
./devctl.sh start                   # full rig incl. the Cloudflare dev worker
```

`dev-serve.sh` is usually what you want: it serves at the **production paths**
(`/flextext-editor/`, `/text-recorder/`, …) on a fixed port, so PWA scope,
service worker and `localStorage` survive across sessions — switching ports
means a new origin and lost test state. It sends `Cache-Control: no-store`, so
a normal reload always gets fresh files. Append `?devreset` to wipe that
origin's settings/storage for a clean test.

The service worker is skipped on `localhost` so you always see fresh files
(add `?sw=1` to test offline behaviour deliberately).

### Console functions (`window.fx*`) — the built-in diagnostics

Type these into the browser console in the running app. They are **deliberately not in the UI**: an
ordinary user should never meet them, and they are how you answer "why is it doing that?" without
guessing.

| Function | Where | What it tells you |
|---|---|---|
| `fxUpdate()` | any app | Forces a service-worker update check and activation. The fix for "I deployed a new version but this device still runs the old one" — the single most useful one to know. |
| `fxTree()` | Paragraph Analysis | The current selection, every group's children **in order**, the top-level units, and whether the selection is adjacent among its siblings — naming exactly what sits between them if not. Answers "why won't these group?". |
| `fxBlanks()` | Paragraph Analysis | Every hidden blank line, where it sits in sibling order, and which group holds it. FLEx exports carry empty phrases; they are hidden and absorbed automatically, so a selection can look adjacent on screen and not be. |
| `fxDevices()` | Researcher panel | What the panel actually received for each device — nickname, `estate`, and whether it is flagged as being on the legacy address. Answers "why is/isn't this device flagged?". |
| `fxLinks()` | Researcher panel | The current link-estate mode, and reveals the advanced picker. |
| `fxLinks('auto'\|'cloud'\|'pages'\|'origin')` | Researcher panel | Overrides which estate's URLs the panel **prints** in invite and share links — for pairing a dev app. `auto` clears it. Changes the printed link only, never where a device is registered, and the panel shows a badge the whole time it is active. |

Why console functions and not keyboard shortcuts: a shortcut must survive dead keys, IMEs and screen
readers on every platform. One of these began as a ⌃⌥E binding that could never fire on a Mac,
because Option+E is the dead key that composes an acute accent. New hidden affordances go in this
table, not on the keyboard.

Also available: `?devreset` (wipe this origin), `?segmentation=on|off`, `?mode=researcher`.

**Key files:** `docs/js/flextext.js` is the format engine (parse / serialize /
tokenize / segment / reconcile); `docs/js/app.js` is the UI; `docs/js/db.js` is
IndexedDB storage; `docs/js/native-audio.js` is the **only** file allowed to
touch a native bridge.

## Versions — what to bump

Three constants move together on an engine change:

| Constant | File | Why |
|---|---|---|
| `ENGINE_VERSION` | `docs/js/i18n.js` | what the app reports about itself |
| `VERSION` | `docs/sw.js` | triggers the update on installed PWAs |
| `VERSION` | `satellites/*/sw.js` | satellites cache the engine **by path** — without a bump they keep serving a stale copy offline |

Bump the version **up**, never down — a lower number will not reliably
re-trigger a service-worker update.

## Self-hosting: everything you must configure

The apps run as **static files with no build step**, so a plain fork serves fine from any static
host. Everything below is only needed for the **connectivity backend** — device sync, researcher
accounts, Drive uploads, crowd recording. Without it the editor, recorder and paragraph tool still
work fully offline; they simply cannot sync.

**No secrets from this deployment appear in this repository.** Every value below is a placeholder;
real secrets are set with `wrangler secret put` and never committed.

### 1. Client constants — `docs/js/app.js`

| Constant | What it is | Change to |
|---|---|---|
| `DEFAULT_WORKER` | Base URL of your connectivity Worker | `https://<your-worker-domain>` |
| `DEFAULT_RELAY_TOKEN` | **Deliberately public** read token, shipped in the client. Proxies public Drive files only; grants no write | any random hex string of your own |
| `TURNSTILE_SITE_KEY` | Your Turnstile widget's public site key | from your Cloudflare Turnstile widget |
| `LOCAL_WORKER` | Where `wrangler dev` listens | usually leave as-is |

### 2. App URLs — `docs/js/researcher-panel.js`

`ESTATES` maps each app to its public URL; the panel builds every invite and share link from it.
`LEGACY_PANEL_HOST` and `MIGRATE_DOC` exist only for this project's GitHub Pages → Cloudflare
migration — a fresh deployment should reduce `ESTATES` to a single estate and drop both.

### 3. Worker vars — `worker/wrangler.toml`

| Var | Purpose |
|---|---|
| `ALLOWED_ORIGINS` | **Exact-match**, comma-separated list of every origin allowed to call the Worker. No trailing slashes. Also gates the OAuth return origin |
| `MAX_FILE_BYTES` / `MAX_TOTAL_BYTES` | Upload caps. The defaults stop below Cloudflare's free-tier limits |
| `ALLOWED_RESEARCHERS` | Optional allowlist of researcher e-mails / domains |
| `ALERT_EMAIL`, `RESET_FROM` | Addresses for operational mail |

Also yours to change: the Worker `name`, `[[routes]]`, the D1 `database_name` + `database_id`, the
R2 `bucket_name`, and the `SIGNUP_LIMIT` rate-limit binding.

### 4. Worker secrets — `wrangler secret put <NAME>`, never committed

| Secret | Purpose |
|---|---|
| `TURNSTILE_SECRET` | Pairs with the client's `TURNSTILE_SITE_KEY` |
| `RELAY_SECRET` | **Must equal the client's `DEFAULT_RELAY_TOKEN`** or every Drive download 401s |
| `RELAY_WRITE_SECRET` | Optional; enables R2 uploads |
| `SERVER_HMAC_KEY` | Server-side HMAC for opaque identifiers |
| `ESCROW_PUBLIC_KEY` / `ESCROW_PRIVATE_KEY` | Operator-recoverable key escrow |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google Sign-In + Drive |
| `RESEND_API_KEY` | Transactional e-mail |

⚠ Leave `DEV_ECHO_RESET` **unset in production** — it is a local-dev affordance only.

For local development copy `worker/.dev.vars.example` → `worker/.dev.vars` (gitignored). It is
overlaid by `wrangler dev` and ignored by `wrangler deploy`.

### 5. Third-party consoles

- **Cloudflare** — Workers (one per app, plus the connectivity Worker), D1 database, R2 bucket,
  custom domains, and a **Turnstile widget**. The widget is hostname-locked: list every hostname
  that will render it. Wildcards are not accepted, but adding a domain covers its subdomains, and a
  free widget allows 10 hostnames.
- **Google Cloud** — an OAuth 2.0 client with Drive scope, and one authorized redirect URI:
  `https://<your-worker-domain>/v1/oauth/google/callback`. Note this is the **Worker's** URL, not
  any app's — so adding an app origin needs no Google change.
- **Resend** (or any provider, if you replace the mail code) — for reset/alert e-mail.
- **GitHub** — Pages if you publish there; `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo
  secrets if you use the bundled deploy workflows.

### 6. ⚠ The values that must MATCH across files

These are the ones that cost real debugging time, because each fails in a way that points somewhere
else:

| Must match | Symptom when they don't |
|---|---|
| client `DEFAULT_RELAY_TOKEN` == worker `RELAY_SECRET` | Every Drive download returns 401 |
| every app origin ∈ worker `ALLOWED_ORIGINS` | Requests refused by CORS — looks like a broken app |
| the panel's origin ∈ `ALLOWED_ORIGINS` | Sign-in completes, then returns to the wrong app |
| every crowd-recorder host ∈ Turnstile widget hostnames | Widget shows "Unable to connect to website"; upload can never start |
| client `TURNSTILE_SITE_KEY` pairs with worker `TURNSTILE_SECRET` | Crowd uploads rejected server-side |
| Google redirect URI == `<worker>/v1/oauth/google/callback` | `redirect_uri_mismatch` on sign-in |

**Adding a new app origin touches three places** — `ALLOWED_ORIGINS`, the Turnstile widget
hostnames (only if it serves a crowd recorder), and nothing in Google. Getting that list wrong is
the single most common way to break a working deployment.

## Deployment

**`main` is development — in progress, and possibly broken at any given moment.
`productionWeb` is what the world sees.** GitHub Pages serves
**`productionWeb` → `/docs`** (Settings → Pages → Deploy from a branch). Nothing
reaches `productionWeb` except by fast-forward from a `main` that has been tested
and explicitly signed off, so production is never a snapshot of whatever `main`
happened to look like.

> ⚠ **Never push `productionWeb` without the maintainer's explicit sign-off.**
> Real users in the field load it; a broken push breaks their work until it is
> noticed and fixed.

Releasing:

```sh
# 1. bump versions (table above), commit on main
ALLOW_MAIN_PUSH=1 git push origin main

# 2. after sign-off, fast-forward production
git checkout productionWeb && git merge --ff-only main
ALLOW_MAIN_PUSH=1 git push origin productionWeb
git checkout main
```

Pushing `productionWeb` triggers the **`Publish satellites`** workflow, which
does the rest — see below. Pages caches `sw.js` briefly, so allow a few minutes
for rollout to begin. Installed clients check for a changed `sw.js` on launch,
on returning to the foreground, and when the network returns; they show an
**Update** button rather than swapping versions mid-edit.

### How the satellites get published

`satellites/<name>/` is the source of truth for each sibling repo. The workflow
mirrors it across using a **per-repo SSH deploy key** (a leaked key writes to
exactly one repo and nothing else), and enforces the ordering that matters:

1. **Wait** until the live editor actually serves this commit's `sw.js` version.
2. **Verify** every `/flextext-editor/…` path that satellite precaches returns
   **200** — and refuse to publish it if any does not.
3. Only then commit and push.

Why that guard exists: a satellite's service worker precaches engine files by
path. Publish it before those files are live and `precacheAll()` throws inside
`install`, so the **service-worker install fails** — existing installs stick on
the old worker, and *new* installs get no precached shell at all, silently
losing offline support. That happened for real, hence the automation.

Run it by hand (e.g. from a cloud session) with:

```sh
gh workflow run sync-satellites.yml            # all three
gh workflow run sync-satellites.yml -f only=text-recorder
```

### Guards you will meet

| Guard | What it stops | Override |
|---|---|---|
| `.git/hooks/pre-push` | pushing `main`/`productionWeb` unthinkingly | `ALLOW_MAIN_PUSH=1` |
| same hook | adding/altering `.github/workflows/**` | `ALLOW_WORKFLOW_PUSH=1` |
| `check-native-containment.sh` | any file but `native-audio.js` touching a native bridge | fix the code, not the guard |
| `check-editor-shell.sh` *(satellite repos)* | publishing a satellite ahead of the engine | `ALLOW_STALE_SHELL=1` |

Hooks are **not** versioned by git — reinstall them after a fresh clone.

### Rolling back

```sh
git checkout productionWeb
git reset --hard <last-good-commit>
ALLOW_MAIN_PUSH=1 git push -f origin productionWeb
```

Then bump the service-worker `VERSION` **upward** (e.g. past the bad release)
so installed clients reliably pick the rollback up.

### Android APKs

```sh
cd android
./scripts/build.sh recorder                 # or: editor
./scripts/build.sh recorder --diagnostic    # capability/test-record harness
```

The build pins a snapshot of `docs/` into the APK, so an APK does **not**
auto-update — re-bundle and rebuild to move it forward. It also asserts the
native classes really landed in the packaged dex, because Gradle's up-to-date
check does not see edits through the symlinked plugin and will happily package
stale native code.

### Windows desktop shell

Built by the manual `Build desktop (Windows)` workflow (free: public repo,
standard runner), which bundles an LGPL ffmpeg for capture and produces a
portable, unsigned x64 exe; `electron/README.md` explains why the shell
exists, how capture works, and the honesty gap. From source:
`cd electron && npm install && npm start` (`npm run start:local` runs it
against the dev rig on port 8012).

> **Note:** `samples/` contains real language data and is `.gitignore`d so it
> never lands in a public repo. `notes/` (planning docs, schema, retired code)
> is likewise ignored and never served.
