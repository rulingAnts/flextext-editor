# FlexText Suite — developer documentation

Technical documentation for developers who want to contribute to, fork, audit, or **adopt** these
apps. It complements [`CLAUDE.md`](CLAUDE.md) (the operational rulebook — deploy ordering, version
discipline, the traps that have actually bitten) and the in-code commentary, which is deliberately
dense: most design decisions are documented at the line that implements them.

> **An open invitation.** This suite is built and maintained by a solo field linguist / Bible
> translator to serve minority-language documentation and translation work (primary field site:
> Papua, Indonesia). It is AGPL-3.0 and designed from the start to be handed over: language
> software organizations (the SIL LSDev / Payap-style world) who see value here are warmly invited
> to adopt, steward, or absorb these tools. The architecture notes below are written with that
> reader in mind.

---

## 1. What this is

An **offline-first suite** for oral-text documentation with minority-language communities:

| App | Path / repo dir | What it does |
|---|---|---|
| **FlexText Editor** | `docs/` (the published PWA) | Interlinear text editor for FLEx `.flextext` files: baseline transcription, word glossing, free translation — plus researcher-gated **Audio Segmentation Mode** (time-aligned waveform strips, ELAN/SayMore export). |
| **Flextext Recorder** | `satellites/text-recorder/` | Record-only companion PWA for low-literacy speakers: record, consent, upload. |
| **Flextext Researcher** | `satellites/flextext-researcher/` | The researcher console: device management, assignments, settings push, corpus/Drive management, history. |
| **Crowd recorder** | `satellites/crowd-recorder/` | Embeddable one-shot recorder. |
| **Flextext Paragraph Analysis Tool** | `paragraph-analysis/` | Discourse-structure satellite: groups interlinear lines into phrase→clause→sentence→paragraph trees (SSA / arcing / Longacre-style) over a `.fxpa` or `.flextext` file. Own Cloudflare Worker deploy (`paragraph-analysis-tool`), where it is the ROOT of its own origin https://pat.flextext.app/ — not a Pages mirror, and the one app in the suite not confined to a sub-path. |
| **Connectivity Worker** | `worker/` | Cloudflare Worker + D1: no-login device sync, researcher accounts (Google Sign-In), E2EE metadata, uploads streamed into the researcher's own Google Drive. |
| **Native shells** | `android/` (Capacitor), `electron/` | Thin wrappers whose sole reason to exist is archive-grade audio capture (see §7). |

Design constraints that explain most of the architecture:

- **Users are field translators on cheap Android phones with intermittent connectivity.** Offline
  is the primary mode; sync is opportunistic; nothing may ever silently discard field work.
- **Coworker users may be barely literate.** Foolproofing outranks features; anything that
  requires phone-call tech support is considered broken (see the researcher-recoverable design of
  uploads, remote settings, remote deletes).
- **The threat model includes hostile-government scrutiny.** Corpus metadata is E2EE (the server
  stores ciphertext); researcher identity in D1 is being minimized; see `notes/connectivity-*`.
- **Archival honesty.** Preservation masters are never processed (no AGC/NR); lossy→WAV
  conversions are labeled in both filename and BWF `bext` bytes as NOT archival.

**Browser support: Chromium-family only. ⚠ SAFARI IS NOT SUPPORTED, PERIOD (Seth, 2026-08-14).** The
target device is an Android phone running Chrome; the desktop targets are Chrome/Edge and the
Electron shell. Nothing is tested on Safari or iOS, no bug is triaged against them, and "it breaks in
Safari" is not a defect here. Do not spend review or test effort there, and do not add Safari
work-arounds to shared code — they cost the field devices complexity for nobody's benefit.

## 2. Quick start

No build step — the PWA is static files.

```sh
# Simple no-cache dev rig at production paths (fixed port = stable PWA origin):
bash dev-serve.sh 8012
# → http://localhost:8012/flextext-editor/   (append ?devreset to wipe the origin's state)

# Tests (plain node, no framework):
./check-native-containment.sh     # runs test/*.test.mjs + native-boundary lint
node test/seg-exports.test.mjs    # the segmentation/export format suite
```

Useful dev affordances baked into the app:
- `?segmentation=on|off` — persist the segmentation setting from a URL.
- `?mode=researcher` — opens the researcher panel on localhost and the staging host.
- `?devreset` — full local wipe for a clean test.

### Console functions (`window.fx*`) — the complete list

These are the app's deliberate console entry points. They are **not** keyboard shortcuts: a
shortcut has to survive dead keys, IMEs and screen readers on every platform, and one of these was
originally a ⌃⌥E binding that could never fire on a Mac, because Option+E is the dead key that
composes an acute accent. Anything hidden from ordinary users belongs here instead.

| Function | Where | What it does |
|---|---|---|
| `fxUpdate()` | any app | Forces a service-worker update check/activation (same flow as the ⌃/⌥+U shortcut). The fix for "I pushed a version but the device still runs the old one". |
| `fxLinks()` | researcher panel | Shows the current link-estate mode and reveals the advanced picker. |
| `fxBlanks()` | paragraph tool | Lists hidden blank lines — where each sits in sibling order and which group holds it. FLEx exports carry empty phrases; they are hidden and auto-absorbed, so a selection can look adjacent on screen and not be. Console-only by design: analysts should not have to think about them. |
| `fxTree()` | paragraph tool | Prints the selection, every group's children in order, the top-level units, and — for the current selection — whether its members are adjacent among their siblings, naming what sits between them if not. The answer to "why won't these group?". |
| `fxDevices()` | researcher panel | Prints what the panel actually received per device — nickname, `estate` (or `(FIELD ABSENT)`), and whether it is flagged legacy. The answer to "why is/isn't this device flagged?". |
| `fxLinks('auto' \| 'cloud' \| 'pages' \| 'origin')` | researcher panel | Overrides which estate's URLs the panel PRINTS in invite and crowd share links — for pairing a dev app. `auto` clears it. |

⚠ `fxLinks` changes the **printed link only, never the stored estate**. The worker stamps every new
row `'cloud'` at creation and that stays true, so a dev pairing cannot quietly re-home a real
coworker. It is `sessionStorage`-backed (survives the reloads a dev pairing needs, dies with the
tab) and while an override is active the panel keeps a highlighted badge visible — an invisible mode
that rewrites every invite link is exactly what you forget is on and then hand to a real coworker.

## 3. Repository layout & the engine/satellite model

**`docs/` is the website** (GitHub Pages serves `productionWeb:/docs`). Everything else is
committed but never served.

The satellites are **not forks**: each is a thin `index.html` that loads THIS repo's engine
cross-origin-path (`/flextext-editor/js/app.js` + CSS) and sets `window.__MODE`
(`record` / `researcher` / `paragraph`). All logic lives in `docs/js/`. Satellite GitHub repos are
dumb serving mirrors published by `.github/workflows/sync-satellites.yml` — never edit them
directly. The **Paragraph Analysis** satellite (`paragraph-analysis/`) is the exception in
deployment only: it ships as its own git-connected Cloudflare Worker whose `build.sh` copies
`docs/` into the same deployment (`public/flextext-editor/`), so its shell and engine ship
atomically and it has no deploy-order hazard.

Why separate origins-paths at all: two PWAs sharing a scope are treated by the browser as one app,
and moving the editor off `/flextext-editor/` would change its PWA id and orphan every installed
field copy.

Key engine modules (`docs/js/`):

| Module | Role | Purity |
|---|---|---|
| `app.js` | UI + orchestration (the only place allowed to touch app state) | DOM |
| `flextext.js` | parse/serialize/reconcile FLEx `.flextext`; round-trip preservation policy in its header | **pure, node-testable** |
| `segments.js` | the time-span model + ordering invariants (never invent a time; `timePending`) | **pure** |
| `segment-strips.js` | segmentation-mode baseline UI: waveform strips, peaks pipeline | DOM |
| `seg-exports.js` | EAF writers (ELAN + SayMore profiles), the self-contained preview page, BWF `bext`, `buildFxpa()` (the `.fxpa` paragraph-analysis interchange), and `loosePlan()`/`buildLooseConversion()` — the same outputs from a user-picked `.flextext` + recording (see §4.1) | **pure** |
| `paragraph-model.js` | `.fxpa` validate/serialize + the grouping-tree invariants (adjacency, single parent, asym head, levels) | **pure** |
| `paragraph-ui.js` | the Paragraph Analysis satellite UI (open/convert screen, display modes, audio, bracket tree) | DOM |
| `audio.js` | the single shared Player (wavesurfer) | DOM |
| `record-pcm.js`, `convert.js` | capture formats, WAV encoding, archival defaults | mostly pure |
| `upload.js` | queued, resumable, retry-forever Drive uploads (via the worker) | DOM/db |
| `crypto.js`, `sync.js`, `researcher.js`, `researcher-panel.js` | E2EE primitives, device sync, accounts, panel UI | mixed |
| `native-audio.js` | **the ONE native chokepoint** — see §7 | DOM |

**Format-module rule:** a format module imports nothing but other format modules — no DOM, no
settings, no IndexedDB, no i18n. Input is a plain doc object; output is a string/Blob/Buffer. The
acceptance test is "does it run under plain node" — `test/seg-exports.test.mjs` is the enforcement.

## 4. The data model

A text ("doc") is:
```
{ title, paragraphs: [ { guid, segments: [ phrase ] } ], segments: [ span ], … }
phrase = { attrs, baseline, words: [ { txt, gls, punct, … } ], free, pre/postItemsXML }
span   = { start, end }  |  { timePending: true }   (+ optional timeEstimated)
```
- `paragraphs[].segments` are FLEx *phrases* (text structure). `doc.segments` are *time spans*.
- **Segmentation mode invariant (flat mode): one line = one paragraph = one phrase = one span**,
  including blank lines (a blank line is a real timed span — usually silence).
- All span edits route through `segments.js` (`boundaryAtPlayhead` / `mergeSegments` /
  `normalizeSegments` / `syncToLines`): spans can never cross; a time is never invented
  (out-of-range → `timePending`); **text is sacred** (a text edit always applies even when the
  time can't). Alignment tools write `doc.segments` ONLY, so glosses/free translations cannot be
  damaged by construction.
- **Round-trip policy** (`flextext.js` header): anything the app doesn't edit (morphemes, notes,
  unknown items/attrs, media-files) is preserved as XML fragments and re-emitted.

**`.flextext` is the canonical time-alignment carrier** — phrase `begin/end-time-offset`
attributes + `media-files` (the FLEx/ELAN interop mechanism) on export, `segmentsFromOffsets()` on
import. There is no proprietary sidecar. Timestamps also emit as visible `note` items
(`audio 0:01.234–0:05.678`, `~` = estimated) because FLEx has no display line for the raw offsets.

### 4.1 Conversions from files the app has never seen (v377)

The researcher panel's **Files ▾** menu builds an ELAN package, a SayMore package, a listening page,
a `.fxpa` or the plain `.flextext` from a text on Drive. **Utilities → "Make files from a
.flextext"** builds the identical set from two files the user picks off their own disk — the same
five rows, the same names, the same degradations. It is on the editor's Utilities tab (no pairing,
no reveal, so an unpaired editor can do it) and in the panel's Utilities modal.

Two functions in `seg-exports.js` carry it, and the reason they are there rather than in either UI
is that the widget necessarily **exists twice** (a static section in the editor, a built modal in the
panel — there is no shared UI layer between them):

- `loosePlan({ doc, hasAudio, audioBytes, isWav })` → per-row `{ ok, reason }` plus the alignment
  facts, mirroring the menu's row logic. Reason codes (`noText` / `noAudio` / `noAlign` /
  `badAlign` / `tooBig`) come back as CODES; the sentences live in the UI, because a format module
  has no i18n.
- `buildLooseConversion({ kind, doc, audio, plan, … })` → `{ entries, zip, saveName, notes }`,
  wrapping the same `assembleSegEntries` the menu and the device bundle use.

What this tool must do that the menu does not: the menu gets its pair from a manifest, so the audio
provably belongs to the text. **Two file pickers cannot**, so `alignmentIsOrdered()` rejects
overlapping/backward offsets before offering an EAF row, and `durationVerdict()` warns when the text
is aligned past the end of the recording. Both are warnings and refusals of a ROW — never of the
whole tool. `test/loose-conversions.test.mjs` pins parity with the menu's own want/full table;
`test/browser/loose-exporter.playwright.mjs` drives both surfaces in a real browser.

## 5. Versioning, service workers, and the deploy pipeline

This is the part that has caused real outages when done wrong — read
[`CLAUDE.md`](CLAUDE.md) §"DEPLOY ORDER IS ENFORCED" for the history.

- **Bump versions ONLY via `./bump-version.sh vNNN`** — it sets all four sites explicitly and
  fails loudly if any didn't land (a sed-from-previous chain once no-opped silently and two
  releases shipped mislabelled; the script is the guard).
- **Four version sites move together** (enforced by `test/version-sync.test.mjs`):
  `docs/sw.js` `VERSION` == `docs/js/i18n.js` `ENGINE_VERSION`, plus each satellite `sw.js`'s own
  `VERSION` and its declared `ENGINE`.
- Each satellite SW **precaches the editor's engine files by path** — a new top-level import in
  `app.js` must be added to the editor SHELL *and every satellite SHELL* (`satellites/*/sw.js`
  **and** `paragraph-analysis/sw.js`) in the same commit, or updated satellites go dead offline.
- The staging dev site serves its service-worker files with `no-store` via `staging-shell.js`
  (root `wrangler.toml`, `run_worker_first`) so deploys turn over instantly; production keeps
  normal SW-update semantics.
- **Branches:** feature branch → `staging` (`--no-ff`, auto-built to the Cloudflare dev site) →
  after the maintainer's hands-on sign-off, ff into `main` → ff into `productionWeb`.
  Pushing `productionWeb` triggers `sync-satellites.yml`, which WAITS for the live editor,
  verifies every precached path returns 200, then publishes the mirrors.
- **Backend first:** when a change touches `worker/` or D1, deploy the worker (manual-dispatch
  `worker-deploy.yml`) before any client that depends on it — including CORS: a new `x-fx-*`
  header must be in the worker's allow-list before any deployed client sends it.

## 6. Connectivity: the worker, D1, Drive

- **Devices have no accounts.** A researcher mints an invite link; the device enrolls and holds a
  per-install secret. Commands (assign / changeSettings / triggerUpload / uploadDelete / setDone)
  flow through a desired-state lane with ack sequencing; inventory reports are **E2EE** (the
  server and D1 hold ciphertext; only the researcher's key decrypts).
- **Uploads stream through the worker into the researcher's own Google Drive** (`drive.file`
  OAuth; the app can only see files it created). Layout: `FlexText Uploads / <device> / <text>/`.
  Folder identity is an `appProperties` docId tag + a **remembered folder id echoed by the client**
  (`x-fx-folder`) — remembered ids are verified with `files.get` (strongly consistent) because
  Drive's *search* index is eventually consistent and re-searching per upload duplicated folders.
- Uploads are **queued in IndexedDB and retry forever**, chunked+resumable for big files, with
  Drive's own byte count as the resume truth. Delete flows are **upload-first**: nothing is
  removed until a verified backup exists.
- Security posture: open signup + rate limit + owner approval tiers; escrowed recovery; optional
  TOTP; security log (`worker/src/seclog.js`) with email alerts. See `notes/connectivity-*.md`.

## 7. Native shells & the bridge contract

The web engine auto-updates; an installed APK does not. So the native layer is kept so thin it
almost never needs to change:

- **`docs/js/native-audio.js` is the only file allowed to touch `window.Capacitor`** — enforced by
  `./check-native-containment.sh`. It feature-detects and is inert in a browser.
- Native exists for exactly two reasons the web can't satisfy: Android `AudioRecord` capture
  without the WebView AGC-or-clip dilemma, and integer bit-depth capture (Web Audio is float32 by
  spec). Capture lifecycle is absorb-then-delete: bytes are stored in IndexedDB before the native
  file is released.
- The bridge declares a `CONTRACT_VERSION`; the full contract lives in `android/CLAUDE.md`.

## 8. Testing

- `test/*.test.mjs` — plain node, assertion-style, run by `check-native-containment.sh`.
  Notable suites: `segments-ordering` (adversarial span-model inputs), `seg-exports`
  (EAF/flextext/preview/bext, includes pinned regressions from adversarial audits),
  `loose-conversions` (the Utilities converter, asserted as PARITY with the Files ▾ menu),
  `version-sync` (release gate), `worker-*` (auth boundaries, seclog).
- `test/browser/*.playwright.mjs` — real-browser checks, run deliberately (they need a server and
  Chromium), not part of the node suite. They exist for the half node cannot reach: wiring, decode,
  downloads. `loose-exporter` found a `new DataView(Uint8Array)` throw that a `catch` was swallowing
  into a permanently-silent duration check — every node test passed with the feature half-dead.
- UI verification is done against the no-cache dev rig; the repo's history shows the working
  method: probe with real DOM, screenshot, and assert — not "it should work".
- `notes/TEST-CHECKLIST.md` is the human pre-release checklist (real ELAN/SayMore/FLEx round
  trips are the acceptance tests for the interop claims — tier conventions are recognized by
  name, not schema, so only the real tools prove them).

## 9. Licensing & contact

AGPL-3.0 throughout (see `worker/CLAUDE.md` for the history of the worker fold-in). Maintainer:
Seth J (rulingAnts on GitHub). If your organization wants to run with any of this — from a small
contribution to full stewardship — open an issue and say so.
