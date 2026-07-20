# Flextext Editor

Copyright © 2026 Seth Johnston. Licensed under the
[GNU AGPL v3.0](LICENSE) — you may use, modify, and redeploy this app
(e.g. for your own language project), provided derivative deployments also
share their source under the same license.

Developed collaboratively with [Claude Code](https://claude.com/claude-code)
(Anthropic's AI coding agent), which implemented the application from the
FLEx flextext schema and real interlinear exports under Seth's direction.
Bundles [wavesurfer.js](https://wavesurfer.xyz/) (BSD-3-Clause, see
`js/vendor/wavesurfer.LICENSE`).

An offline-capable web app (PWA) that duplicates FieldWorks Language Explorer's
interlinear **Baseline** and **Gloss** tabs, editing
[`.flextext`](notes/FlexInterlinear.xsd) files directly — no FLEx, no lexicon, no
server. Built for the workflow where a researcher sets up the language settings
and a native-speaker coworker transcribes, glosses, and free-translates texts on
whatever device they have (Windows, Mac, Linux, iOS, Android).

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

## Repository layout — one repo, four published apps

**All development happens in this repository.** Only `docs/` is published:
GitHub Pages serves `productionWeb:/docs`, so everything else is committed but
never served.

```
docs/          THE PUBLISHED SITE (the PWA) → /flextext-editor/
satellites/    source of the three sibling apps (see below)
android/       Capacitor wrappers — recorder + editor APKs
electron/      Windows desktop shell (planned)
notes/         planning docs, schema, retired code — gitignored
```

### The sibling apps

Three companion PWAs ship from their own repos **only because they have to**:
GitHub Pages serves a project site at `/<repo-name>/`, and two PWAs sharing a
scope are treated by the browser as **one installed app**. They therefore need
paths disjoint from `/flextext-editor/`:

| App | Path | What it is |
|---|---|---|
| **Flextext Recorder** | `/text-recorder/` | record → send, for coworkers gathering audio on a phone |
| **Flextext Researcher** | `/flextext-researcher/` | the researcher console |
| **Crowd Recorder** | `/crowd-recorder/` | public, embeddable, one-clip contribution |

None is a fork. Each is a thin shell that loads **this repo's engine**
(`docs/js/app.js` + `docs/css/app.css`) and sets a mode flag. Their source lives
here in `satellites/`; the sibling repos are **machine-managed mirrors** — do
not edit them directly.

### How they are published

The `Publish satellites` workflow mirrors `satellites/<name>/` into each repo
using a per-repo SSH deploy key. **It enforces the ordering that matters:** it
waits until the live editor actually serves this commit's `sw.js` version, then
verifies every engine path that satellite precaches returns 200, and refuses to
publish if any does not. A satellite published ahead of the engine it caches
fails its service-worker install — which silently costs new installs their
offline support.

### Native wrappers

The Android apps (`android/`) exist for one reason: **archive-compliant audio**.
The Web Audio API is 32-bit float *by specification*, so a browser can never
capture at a chosen integer bit depth — it can only capture float and reduce
afterwards. Native `AudioRecord` can. `docs/js/native-audio.js` is the single
file permitted to touch a native bridge, and `check-native-containment.sh`
enforces that.

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

## Deployment

**`main` is development. `productionWeb` is what the world sees.** GitHub Pages
serves **`productionWeb` → `/docs`** (Settings → Pages → Deploy from a branch).

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

> **Note:** `samples/` contains real language data and is `.gitignore`d so it
> never lands in a public repo. `notes/` (planning docs, schema, retired code)
> is likewise ignored and never served.
