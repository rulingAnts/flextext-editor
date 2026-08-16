# FlexText Editor — repo guide for Claude / LLMs

Offline-first interlinear text editor PWA for FLEx `.flextext` files (baseline
transcription, word glossing, free translation). It's a **static site** served
via GitHub Pages.

## Branches — READ THIS FIRST

| Branch | Purpose |
|---|---|
| `main` | **Releasable trunk.** Small same-day changes and finished feature merges. A release is `merge --ff-only main` into `productionWeb`, so main must stay shippable at all times. |
| `productionWeb` | **The live site.** Deployed by GitHub Pages to https://rulingants.github.io/flextext-editor/ . Pushing it also triggers `sync-satellites.yml`, which publishes the satellite mirrors AFTER verifying the editor is live. Never push without Seth's explicit test-drive sign-off. |
| `staging` | **The dev site.** `main` + in-progress feature merges (`--no-ff`), built by Cloudflare's git integration into the `flextext-staging` Worker at **https://staging-flextext-editor.68mh29kgsd.workers.dev/** (free tier; root `wrangler.toml` serves `./docs` as a static site). This is where Seth test-drives features before a production release. Verify a deploy landed by curling `/sw.js` for the new version. ⚠ The **Paragraph Analysis tool is a SEPARATE Worker** and is NOT on that origin — its staging build is **https://staging-paragraph-analysis-tool.68mh29kgsd.workers.dev/**, which serves the engine under `/flextext-editor/js/…` (so check the engine version by curling `/flextext-editor/js/i18n.js` for `ENGINE_VERSION`, not `/sw.js`). Both auto-build from a `staging` push. |
| feature branches | e.g. `segmentation2` (shipped as v158), `seg-exports` (in test). Branch from `main`, merge `--no-ff` into `staging` to test, ff into `main` only when complete + approved. |

> **⚠ The OLD `segmentation` branch is OBSOLETE** (superseded by `segmentation2`, which shipped to
> production as v158 on 2026-08-03). It was removed from `main` by revert (`1ef6df2`) and must never
> be merged — delete it when convenient. The history of why it was parked (cherry-pick churn, the
> SHELL-hunk trap behind the v108 outage) is in the feature-branch policy below.

### 🚩 FEATURE BRANCHES — standing policy (Seth, 2026-07-28)

**Build any new feature on its own branch — especially a major one. Do not develop it on `main`.**

`main` must stay releasable at all times, because a release is a `merge --ff-only main` and there is
no way to ship *part* of `main`. The moment an unfinished feature sits there, every unrelated
release has to be cherry-picked around it — which happened three times for segmentation before it
was moved off, and each cherry-pick re-offered the SHELL hunk that caused the v108 outage.

- Branch from `main`: `git checkout -b <feature> main`. Push it freely, finished or not.
- **Test a MAJOR feature on its OWN branch preview; use `staging` for modest fixes** (Seth,
  2026-08-11). Every non-`productionWeb` branch already builds its own complete app estate — the
  `deploy.sh` in each `apps/*` folder routes any other branch to
  `https://<branch>-<worker>.68mh29kgsd.workers.dev`, so pushing `assign-by-upload` published
  `assign-by-upload-flextext-editor…`, `…-researcher`, `…-recorder`, `…-crowd` with no extra
  work. Branch names are lowercased and non-alphanumerics become `-`, capped at 63 chars.
  - **Why prefer it over staging for big work:** staging holds `main` + other in-progress
    features, so a failure there is ambiguous and a rollback costs a revert commit. A branch
    preview is that branch ALONE — nothing else can explain what you see, and abandoning it costs
    nothing. Merge to `staging` only when the feature is behaving, as the integration check.
  - The **backend** is separate from the app estate: a branch preview still talks to whatever
    worker the client points at. `?devworker=staging` (persisted per device; `?devworker=prod`
    reverts) aims it at `flextext-r2-worker-staging`, which you deploy from any ref with
    `worker-wrangler.yml` → `deploy --env staging`. Preview origins are pre-authorized there by
    the `*-flextext-*.68mh29kgsd.workers.dev` entries in `[env.staging].ALLOWED_ORIGINS` — see
    `originAllows()` in `worker/src/v1.js`: they match branch previews but NOT production origins,
    so "a field device reached the staging backend" still fails loudly. New branches need no
    config edit.
  - ⚠ The same build-cancellation rule applies as for staging/main: **two pushes within a couple
    of minutes for the same Worker cancel each other.** Push one branch, confirm its build, then
    push the next.
- **Test on `staging`** (Seth, 2026-08-04) — the fast path for smaller, self-contained changes:
  merge the feature branch `--no-ff` into `staging`, which auto-builds the dev site with no gates.
  If the staging test FAILS, **roll staging back** (`git revert -m 1 <merge-commit>` on staging) so
  staging returns to main-plus-working-features; the feature branch keeps the work and can re-merge
  after fixes. staging is a TEST SURFACE, not a history archive.
- Merge to `main` only when the feature is **complete and tested** — at which point `main` is
  releasable again and a production release is a plain fast-forward with nothing to resolve.
- Small, self-contained, same-day changes can still go straight to `main`. The test is whether
  `main` would be releasable if you stopped work right now.
- ⚠ If a branch was ever removed from `main` by revert (as `segmentation` was), **rebase it onto
  `main`, never merge it** — a merge meets the reverts and silently reinstates nothing.

### 🚩 PUSHING `staging` AND `main` BACK-TO-BACK CANCELS ONE OF THE BUILDS (2026-08-07)

**Wait for the staging build to finish before pushing `main` (or vice versa). Do not fire both
within a couple of minutes.**

Both branches build the **same Cloudflare Worker** per app (`apps/researcher` → `flextext-researcher`,
and so on). Cloudflare supersedes an in-flight build when a newer one is queued for that Worker, so
the second push cancels the first — and the survivor publishes to *its own* preview alias:

| pushed branch | alias the build publishes to |
|---|---|
| `staging` | `https://staging-<worker>.68mh29kgsd.workers.dev/` |
| `main` | `https://main-<worker>.68mh29kgsd.workers.dev/` |

**What it looks like when it bites** (v299, and it cost a test round): staging was pushed at 08:39:03
and `main` seconds later. Only the `main` build finished — its log header reads
`== PREVIEW upload (branch: main → alias: main) ==` — so `staging-flextext-researcher` was left
serving **v298** while every local check said v299. The panel's badge read `v298/v234`, which is a
correctly MATCHED pair, so nothing looked broken; it was simply the previous build.

**How to tell this apart from a stale service worker**, because they present identically:
`fxUpdate()` reporting *"already on the latest version (vNNN)"* means the SW asked the SERVER and
the server really is on vNNN. That is an origin that never rebuilt, not a cache — no amount of
reloading will fix it. A genuinely stale SW updates instead of saying that.

**The fix when it happens:** re-run the cancelled deployment from the Cloudflare dashboard, or push
one more commit to the branch that lost, on its own. Read the build log's `branch: X → alias: X`
line before believing any deploy landed.

#### 🚩🚩 RELEASING: NEVER FIRE `main` AND `productionWeb` TOGETHER — WAIT, THEN **VERIFY** (Seth, 2026-08-08)

**The rule that does not depend on knowing the mechanism: push ONE branch, confirm its deploy
actually landed, and only then push the other.** Not "wait 5–10 minutes" — a timer is a guess. The
gate is the Cloudflare log header reading `branch: X → alias: X` for the push you just made, plus
the live origin serving the new version.

**⚠ Which order is correct is NOT settled — do not write one into a script yet.** What is known:

- Seth: *"push productionWeb first, wait a very long time (like 5–10 minutes), and then push main.
  Because I think if we push two in a row like that, it skips productionWeb."* Then, immediately:
  *"Maybe pushing main first and then waiting would work. Or something. I'm really not sure."*
- Observed behaviour is **not** the clean "second push supersedes the first" of the staging/main case
  above. `productionWeb` has been seen to **stall or be skipped entirely**, needing a **manual re-run
  from the Cloudflare dashboard** — which is a different failure from being cancelled by a newer
  build, and is why the reasoning "push production second so it wins" is unsafe.

⚠ **So do not reason about who wins. Assume any second push within the window can cost you the
production deploy, and space them by verification.** `main` can sit unpushed indefinitely — the
commits are identical whenever it goes out, and tidiness is worth nothing against a release that
silently did not ship.

**Settle it next release:** push one branch, watch the dashboard, and record which deployments appear
and in what state. Two clean observations would turn this into a real rule; until then this section
is deliberately agnostic.

#### Observations so far — the skip is INTERMITTENT, not deterministic

| release | what was done | outcome |
|---|---|---|
| v318 (2026-08-08) | `main` pushed 05:18:13, `productionWeb` seconds later | **Every Cloudflare site deployed from `productionWeb`** — verified by Seth on the dashboard across all Workers built from this repo. Pages + all three satellite mirrors green too. |

⚠ **So v318 was NOT a broken release** — do not read the caution above as a post-mortem of one. It
records a failure mode Seth has *seen*, which v318 then did not reproduce despite being pushed in
exactly the risky pattern. That is the worst kind of hazard to reason about: it lets a bad habit look
safe for several releases before it costs one. Keep spacing the pushes and keep verifying; the reason
is the tail, not the average.

⚠ **What made v318 hard to judge from inside the release**, and is the durable lesson: the Pages
estate has its own gate (`sync-satellites.yml` waits for the live editor to serve the pushed version
and 200-checks every precached path before publishing), so it shipped green and *nothing looked
wrong*. Cloudflare has no equivalent gate. **A green satellite workflow says nothing about
Cloudflare** — they are independent estates off the same push, and only one of them can fail loudly.
Check the dashboard; do not infer one estate from the other.

**Do NOT push to `productionWeb` without the maintainer's explicit OK.** It's the
live site that real users (field translators in the village) load — a broken push
breaks their work. Develop and test on `main` first.

### 🚩 PLANNING DOCS DO NOT GET A VERSION BUMP (Seth, 2026-08-07)

**"Plan changes don't need version bumps or to be tested on staging, if all that's changed is
plans."**

A version bump exists to make every installed service worker fetch a new shell. A `.md` under
`docs/` is **not in any sw.js SHELL**, so bumping for one costs a pointless update round-trip on
every field device and — worse — inflates the number so the staging/production gap reads as far more
untested code than there is. Between v306 and v315, EIGHT versions carried nothing but Markdown.

- Docs-only commit (planning notes, DEVELOPERS.md, this file) → **commit and push, no bump.**
- Any change to `docs/js/`, `docs/css/`, `docs/index.html`, or anything a sw.js precaches →
  **bump**, because that is what a bump is for.
- The version-sync test only requires the five sites to AGREE; it never requires a bump, so nothing
  fails when you skip one.

When reporting what is on staging, say which versions carry code and which carry documents. "Eleven
versions ahead" and "four versions of code ahead" are very different facts to a person deciding
whether to test.

### Deploy a stable version to production
Once the change is committed and tested on `main`:

```sh
git checkout productionWeb
git merge --ff-only main      # fast-forward production to the tested main
git push origin productionWeb # GitHub Pages rebuilds (~1 min)
git checkout main             # go back to dev
```

> **⚠ When a change touches the connectivity backend (the `flextext-r2-worker`
> Cloudflare Worker or its D1 schema), the editor is NOT the first thing to ship.**
> The deployed client must never be ahead of the backend. Full ordered sequence —
> **D1 migrate → worker deploy → smoke test → editor `productionWeb` → recorder →
> Turnstile** — is in **[`notes/RELEASE-RUNBOOK.md`](notes/RELEASE-RUNBOOK.md)**.
> Skipping the order gives field users 404s (worker/D1 behind) or a dead-offline
> recorder (engine import gap). The `git push origin productionWeb` step still
> requires the maintainer's explicit test-drive sign-off.

## 🚨 DEPLOY ORDER IS ENFORCED — read before pushing ANY satellite

**The rule:** the editor's `productionWeb` must be **LIVE and serving** every engine file a
satellite precaches, *before* that satellite is pushed. Not "committed" — **live**.

**Why (this actually broke production 2026-07-20):** editor v108 added `js/native-audio.js`; the
satellites were pushed while that editor commit still sat on `main`. Live result:
`/flextext-editor/js/native-audio.js` returned **404** while the recorder (sw v57) and researcher
(sw v47) listed it in their SHELL. `precacheAll()` retries 3× then **throws**, inside `install`'s
`waitUntil` → **the service-worker install FAILS**. Existing installs stuck on the old worker;
**new installs got no precached shell at all — offline support silently gone**, which is the
entire point of a field app.

**The old rule was too weak.** "Bump the satellite sw when the engine changes" says *bump*; it
never said *verify the file is live first*. Both halves are required.

**Enforcement (automated since the satellites folded into this repo — don't rely on memory):**
- `sync-satellites.yml` (triggered by the `productionWeb` push) WAITS for the live editor to serve
  the pushed sw.js version, then runs `check-release-integrity.sh paths <satellite>` — every
  `/flextext-editor/...` path in that satellite's SHELL must return 200 — before it will publish
  that mirror. A premature publish is impossible by construction.
- `test/version-sync.test.mjs` runs in the same workflow and fails the release when a satellite's
  declared ENGINE ≠ the editor's ENGINE_VERSION — the "bumped the engine, forgot the satellites"
  silent no-op (the v130 failure) is now a loud failure at release time.
- **Adding a new top-level `import` to `js/app.js` is the trigger.** It becomes a new SHELL entry
  in the editor *and every satellite sw.js file* (`satellites/*/sw.js` and
  `paragraph-analysis/sw.js`), in the same commit. (The paragraph app deploys atomically with its
  engine copy, so it can't 404 — but its SHELL must still list the import or it is dead offline.)

**Correct sequence, every time:**
1. Land the engine change (feature branch → `staging` for Seth's test drive → ff into `main`),
   bumping all four version sites together.
2. Get Seth's sign-off, then ff-merge `main` → `productionWeb` and push.
3. Watch the `Publish satellites` workflow run green, then confirm the mirrors' Pages went live
   (curl each satellite's `/sw.js` for the new version — their Pages rebuild takes ~1 min).

## Hosting: TWO live estates at once — Cloudflare for new users, GitHub Pages for existing ones

⚠ **Both are live and both must keep working.** New users are directed to the **Cloudflare Workers**
sites; **existing users stay on the legacy GitHub Pages / satellite-repo URLs**, because a PWA's
identity is its origin — moving someone to a new origin gives them a different installed app with an
empty IndexedDB. Their data does not follow. So the Pages estate is not deprecated infrastructure to
be cleaned up; it is where field users already have their work.

**Five Cloudflare Workers, each its own deploy folder with its own `wrangler.toml`, `build.sh` and
`deploy.sh`:**

| Folder | Worker |
|---|---|
| `apps/editor` | `flextext-editor` |
| `apps/recorder` | `flextext-recorder` |
| `apps/researcher` | `flextext-researcher` |
| `apps/crowd` | `flextext-crowd` |
| `paragraph-analysis` | `paragraph-analysis-tool` (pat.flextext.app) |

Each `deploy.sh` routes `productionWeb` → a real deploy and any other branch → a preview alias, so a
staging push can never reach production traffic. The integrity guard that runs on every build checks
all of this — version sync across the editor and all satellites, every SHELL path present, each
folder naming its own Worker, and no two folders targeting the same Worker name.

**The GitHub Pages estate is unchanged** and is still published by `sync-satellites.yml` on a
`productionWeb` push, with the same ordering guard (editor live first, every precached path verified
200, then the mirrors).

## 🚩 CORE DESIGN PRINCIPLE: modularize what is app-specific, generalize what is shared (Seth, 2026-08-08)

> *"With our suite, in general we should move toward modularizing whatever is app specific and
> generalizing things (whether back end or GUI) that are likely to be used by multiple apps in the
> suite. That's just a core design principle."*

**The suite is ONE engine wearing different faces.** Every satellite is a 59–141 line shell that
loads THIS repo's `js/app.js`; what makes them different apps is a `window.__MODE` flag plus their
own PWA identity (`sw.js`, manifest `id`/`scope`, icons). PAT is the one that also carries engine
modules of its own (`paragraph-model.js`, `paragraph-ui.js`) and its own data model.

So when adding or changing anything, ask which of two things it is:

- **App-specific** → it belongs behind a `__MODE` branch or in its own module, not sprinkled through
  shared code. The model to copy is `js/native-audio.js`: one chokepoint, inert everywhere else,
  with a script (`check-native-containment.sh`) that FAILS if the boundary leaks.
- **Likely useful to more than one app** → generalize it, engine-side, once. Backend and GUI alike.

⚠ **The corollary that bites: a change to shared code changes every app at once.** Before touching
anything in `docs/js/`, know its blast radius and say so. Two questions answer most of it:
- Does it add a top-level `import` to `js/app.js`? Then it is a new SHELL entry in the editor **and
  every satellite `sw.js`**, in the same commit — that is the v108 outage.
- Which apps actually reach the code path? (`reconcileBaseline` lives in the engine, but only the
  editor's baseline editing calls it and PAT never does — so v320's guid gate was one file, no SHELL
  change, zero satellite impact. That is the kind of answer to have BEFORE merging, not after.)

⚠ **Generalize on the second use, not the first.** A premature abstraction spanning five apps is far
more expensive to unpick than a duplicated function, because unpicking it means touching all five.
The live example is in `plans/BACKLOG.md` under *"Engine-wide drift is worth watching"*.

## Developer documentation

**`DEVELOPERS.md` (repo root) is the contributor/adopter-facing technical documentation** —
architecture, data model, versioning discipline, connectivity, native contract. Keep it CURRENT:
when a rule in this file changes, check whether DEVELOPERS.md states the same rule and update both.
(Seth's goal is that an organization like SIL LSDev or Payap could pick these apps up from the
docs alone.)

## Per-text Drive folders — the dedupe contract (v167)

Drive's SEARCH index is eventually consistent; `files.get` by id is strongly consistent. So the
worker returns `folderId` on upload responses, the device stamps it on the doc (`driveFolderId`)
and echoes it back (`x-fx-folder` header / chunked-start `folderId`), and the worker verifies the
echoed id by GET before falling back to the `appProperties` tag search (now `orderBy=createdTime`
so pre-existing duplicates stop compounding). Re-searching per upload is what minted a new
"Title (n)" folder every time. Old engines send nothing and keep the old behaviour.

## Satellite apps: source of truth is `satellites/` IN THIS REPO — READ THIS

The sibling PWAs — **Flextext Recorder** (https://rulingants.github.io/text-recorder/),
**Flextext Researcher** (https://rulingants.github.io/flextext-researcher/), and the crowd-recorder
embed — are developed HERE, under `satellites/<name>/`. Their GitHub repos
(`rulingAnts/text-recorder`, `rulingAnts/flextext-researcher`, `rulingAnts/crowd-recorder`) are
**dumb serving mirrors**, overwritten by the `sync-satellites.yml` workflow on every
`productionWeb` push. Never edit a mirror repo directly (each carries a `DO-NOT-EDIT-HERE.md`);
the old local clone `/Users/Seth/GIT/text-recorder/` is legacy.

- **Why separate serving repos:** two PWAs on one origin must have **non-overlapping scopes** or
  the browser treats them as one app. On GitHub Pages one repo = one path, and the editor must
  stay at `/flextext-editor/` untouched (moving it would change its PWA `id` and orphan every
  installed copy in the field).
- **Same code, one engine — change it HERE:** satellites are NOT forks. Each `index.html` is a
  thin shell loading THIS repo's engine cross-path (`/flextext-editor/js/app.js` + `css/app.css`).
  All engine logic lives in `docs/js/`; never copy engine code into a satellite.
- **⚠ VERSION COUPLING (enforced):** each satellite `sw.js` precaches the editor's engine files BY
  PATH and declares the `ENGINE` version it was built against. `test/version-sync.test.mjs` fails
  the release when any satellite's ENGINE ≠ the editor's `ENGINE_VERSION` — so **any `docs/`
  change bumps ALL the version sites together** (`./bump-version.sh` does it): `docs/sw.js`
  VERSION == `docs/js/i18n.js` ENGINE_VERSION, plus the VERSION + ENGINE lines of
  `satellites/text-recorder/sw.js`, `satellites/flextext-researcher/sw.js`, AND
  `paragraph-analysis/sw.js` (crowd-recorder has no sw.js). **A new top-level import in
  `js/app.js` is a new SHELL entry in the editor AND every satellite sw.js file** — a
  missing precached module makes an updated satellite dead offline (the v108 outage).
- **⚠ DEPLOY ORDER — automated but still the law:** `sync-satellites.yml` waits for the live
  editor to serve the pushed version, verifies every precached engine path returns 200
  (`check-release-integrity.sh`), and only then publishes the mirrors. The version-sync test makes
  the "bumped engine but forgot the satellites" silent no-op (the v130 failure) loud.
- The recorder repo holds only: its shell (`index.html`), its manifest
  (`recorder.webmanifest`, distinct `id`/`scope`), its `sw.js`, and its icons.
  It has its own `CLAUDE.md` stating the same rules from its side.

## ⚠ Native apps depend on this engine — `js/native-audio.js` is a hard boundary

There are Android apps (**`rulingAnts/flextext-native`**) that wrap THIS engine so recordings can be
captured by Android's `AudioRecord` instead of the browser. That exists for two archival reasons the
web cannot satisfy: the WebView's AGC-or-clip dilemma, and the fact that **Web Audio is 32-bit float
by specification** — so a web app can never capture at a chosen integer bit depth, only capture float
and reduce afterwards.

**The engine auto-updates. The APK does not.** A careless change here breaks installed field apps
with no way to push a fix except building and distributing a new APK. So:

- **`js/native-audio.js` is the ONLY file allowed to touch `window.Capacitor`.** Everything
  Android-specific lives behind it, and it is INERT in a browser (feature-detects, returns safe
  values). A grep hit elsewhere is a bug, not a style preference.
- **Run `./check-native-containment.sh`** after touching recording/capture code. It enforces the
  above, checks the warning header is intact, and checks the contract version is declared once.
- **Do not "tidy", inline, or refactor `js/native-audio.js`** while working on unrelated features.
  If a change seems to require editing it, that is the signal to STOP and rebuild + re-test the APK.
- The engine touches the native path in only a handful of clearly-commented places in `js/app.js`
  (import, service-worker skip, `startNative`, the `rec.mode === 'native'` branches in
  `stopRecording`/`saveRecording`, and the absorb-then-delete in `saveRecording`). Keep it that few.
- **Absorb-then-delete:** a native capture is a file on the device. It is read into a Blob, stored
  in IndexedDB, and only THEN released via `releaseCapture()`. Never delete first — until it is
  stored, those bytes exist only on disk.

Full contract (methods, capture lifecycle, `CONTRACT_VERSION`): `flextext-native/CLAUDE.md`.

## Audio Segmentation Mode + exports (v158+) — the rules that keep it safe

Researcher-gated (default **OFF**: `settings.segmentation`, pushed from the panel's Buttons group
or a `?segmentation=on` settings link). OFF = the classic textarea workflow, pixel-identical. ON =
the Baseline tab becomes waveform **strips** (one line = one paragraph = one phrase = one time
span; Enter breaks text at the CURSOR and time at the PLAYHEAD; Backspace/Delete merges) and the
Gloss tab gets per-line mini waves, join buttons, and Enter-split on gloss fields. Blank lines are
real timed spans (silence) and hold placeholder rows on the Gloss tab.

- **`flextext` IS the segmentation format — no proprietary sidecar.** Aligned spans export as
  FLEx-native phrase `begin/end-time-offset` attributes (+ a `media-files` block) AND as visible
  `note` items (`audio 0:00.000–0:02.000`, `~` = estimated) — NEVER into the baseline text.
  `segmentsFromOffsets()` (flextext.js) derives spans back on open, clamped monotonic. FLEx stores
  the offsets on its Segment objects (ELAN interop); it has no interlinear line for them, so the
  note line is the visible carrier — that's why both are written.
- **`doc.segments` is the working state** (time spans, one per paragraph), edited ONLY through
  `segments.js` (never invent a time; out-of-range → `timePending`; text is sacred). ALIGNMENT
  EDITS NEVER TOUCH TEXT: the ⇥ set-boundary control and the seeds write `doc.segments` only, so
  glosses/free translations cannot be lost by construction.
- **Seeds:** fresh single-line doc → one whole-file span. Pre-transcribed multi-line doc with no
  alignment → even division marked `timeEstimated` (dashed) — line 1 claiming the whole recording
  would be a false alignment. All-pending docs heal the same way once audio decodes.
- **Exports (in the save/share zip):** `<title>.eaf` + `<title>.pfsx` (ELAN reads display settings
  from a same-basename sidecar; without it ELAN's remembered `sortAlphabetically` puts every gloss
  tier ABOVE its own vernacular partner — `A_phrase-gls-*` sorts before `A_phrase-txt-*`. The
  sidecar pins TierOrder + TierSortingMode=0 + SortAlpabetically=false — ELAN's own misspelling,
  match it exactly. `serializeEafPrefs`, schema-validated, no annotation data) (ELAN-for-FLEx: `A_interlinear-text-title-*`
  > `A_paragraph` > `A_phrase-txt-*` > word/gloss; the paragraph tier MIRRORS the phrase tier
  sharing its slots — mergeable in ELAN, never needs splitting; **NO segnum in EAFs**, Seth's
  rule); `<audio>.annotations.eaf` (SayMore profile, ONLY `Transcription` + `Free Translation`;
  named by SayMore's own convention so dropping it beside the audio in a session folder is
  picked up automatically); `<audio-basename>.preview.html` (self-contained, audio embedded
  base64, per-segment playback — for alt-tabbing beside FLEx). WHICH exports ride is
  RESEARCHER-SELECTED (`exportEaf` / `exportSaymore` / `exportPreview` / `exportJson` —
  the `.fxpa` Paragraph Analysis file, local saves only — panel Buttons group);
  unset values follow the mode — the basic editor exports a CLEAN classic flextext with no
  offsets/notes (`serializeFlextext` `opts.segTimes`), segmentation mode defaults everything on.
  Imported offsets preserved in `seg.attrs` round-trip verbatim regardless. EAFs ride every
  selected bundle incl. uploads; the preview + bext-stamped derived WAV ride LOCAL bundles only —
  field upload bandwidth never pays for embedded audio.
- **Lossy sources:** segmentation works on a WAV working copy (`segwav:` key,
  `<orig>.converted-NOT-ARCHIVAL.wav`, `derived:true`) because AAC priming makes decode and
  playback disagree by ~44ms. The ORIGINAL is never touched; the derived copy exported in bundles
  carries a BWF `bext` chunk naming its lossy origin (honesty that survives renaming).
- **⚠ Traps that already bit once — do not "simplify" these away:**
  - `applyBaseline` is gated on DOM truth (`#baseline-text` hidden ⇒ skip), NOT on
    `segmentationEnabled()` — during a live settings flip the setting changes before the DOM, and
    the setting-based guard read the hidden empty textarea and WIPED the doc's text.
  - Strip/gloss waveform canvases redraw via ResizeObserver + the existing tickers — a draw that
    races layout bakes a tiny buffer that CSS stretches into a blank slab.
  - `reconcile()`'s seeds/heals persist immediately; peaks failures `console.warn` instead of
    vanishing.

## Browser support: Chromium only — ⚠ NOT SAFARI (Seth, 2026-08-14)

**"This app doesn't support Safari, period."** The field device is an Android phone running Chrome;
desktop is Chrome/Edge and the Electron shell. **Testing on Android is worth doing; testing on Safari
or iOS is not**, and neither is carrying Safari work-arounds in shared code.

⚠ Do not list Safari as a gap when reporting what still needs testing — it is not a gap, it is out of
scope. (This line exists because it was listed as one.)

## Local dev / testing

The app is a static PWA — no build step. Simple options:

```sh
python3 dev_server.py --port 8765   # HTTPS via mkcert — needed for getUserMedia (audio recording)
python3 -m http.server 8011         # plain HTTP — fine for most testing (localhost is a secure
                                    #   context, so the service worker works; recording needs HTTPS)
```

`.claude/launch.json` has these as preview configs.

Dev affordances: `FLEXTEXT_DOCS=<path>/docs bash dev-serve.sh <port>` serves ANY checkout (e.g. a
`git worktree` of `staging` — the pattern for Seth's local test rig on :8012); mirrors are
per-port so instances can't re-point each other. In the app, the console entry points are `fxUpdate()` (forces a service-worker update
check/activation — the ⌃/⌥+U flow) and, in the researcher panel, `fxLinks()` (advanced link-estate
override for pairing a dev app; prints a different URL, never changes the stored estate). The full
list lives in DEVELOPERS.md — add new ones THERE, and never as a keyboard shortcut (a ⌃⌥E binding
could never fire on a Mac: Option+E is a dead key). `?devreset` wipes the origin. Bump
versions ONLY via `./bump-version.sh vNNN` (explicit-set, fails loudly — see DEVELOPERS.md).

### 🚩 BUILD_TAG — feature builds are NAMED; production keeps the numbers (Seth, 2026-08-12)

`BUILD_TAG` in `docs/js/i18n.js` is what the on-screen version badge shows: `''` on production, a
feature name + revision on a feature/staging build (`'assign-by-upload v1'`, bumped v2, v3… per fix
you re-test). It answers "am I testing the right build?" without anyone having to remember which
number went out when.

**`ENGINE_VERSION` must stay numeric `vNNN` regardless** — the name cannot replace the number:
- Device-capability gates parse it as an integer AFTER STRIPPING NON-DIGITS
  (`engNum`, researcher-panel.js): `'assign-by-uploadv1'` → **1**, so `engNum >= 138` fails and the
  panel disables the Done toggle and upload-delete on perfectly capable devices — reading as bugs
  in whatever you are testing.
- `sw.js` VERSION must equal it, and changing it is what makes installed PWAs fetch a new shell, so
  **every re-test still needs a numeric bump** to actually reach your devices.
- Each satellite declares the ENGINE it was built against, matched as an exact string.

So a feature re-test is: `./bump-version.sh vNNN` (number, for the machines) plus editing
`BUILD_TAG` (name, for you). **A production release clears `BUILD_TAG` to `''`** — `bump-version.sh`
warns while it is set, and the badge shows it on screen, so a tagged build reaching production
announces itself.

### `dev-serve.sh` — the stable no-cache rig (preferred)
`bash dev-serve.sh 8012` serves the editor + recorder at their **production paths**
(`/flextext-editor/`, `/text-recorder/`) on a **fixed port**, so the PWA
origin/scope, service worker, and `localStorage` persist across sessions (switching
ports = a new origin = lost test state). It sends `Cache-Control: no-store`, so a
normal reload always gets fresh files — no hard-reload needed. Append `?devreset`
to wipe this origin's settings/docs/SW/caches for a clean test.

### `devctl.sh` — the full dev rig as daemons (for the connectivity/researcher panel)
The researcher panel + sync need the Cloudflare dev worker. `./devctl.sh
start|stop|restart|status|logs` runs the whole rig as **detached, self-healing
daemons** (stopped by default, survive the shell that launched them):
- **editor** — the no-cache `dev-serve.sh` on `:8012` (Mac).
- **tunnel** — SSH `-L 8787` to the KDE-neon VM (Mac); auto-starts the VM via
  `prlctl` if it's stopped.
- **worker** — `wrangler dev` on the VM as a **systemd `--user` service** (linger
  on → survives logout/reboot/crash); managed over SSH via `flextext-r2-worker/worker-daemon.sh`.

On `localhost` the client env-switches its worker base to `http://localhost:8787`
(plain HTTP on purpose — an HTTPS page can't reach the HTTP dev worker) and uses
Cloudflare's always-pass **Turnstile TEST keys**; production uses the deployed
worker + the real widget. URL: `http://localhost:8012/flextext-editor/?mode=researcher`.
The worker repo's `.dev.vars` (gitignored; `.dev.vars.example` is committed) holds
the dev secrets incl. `RELAY_SECRET` (must equal the client's `DEFAULT_RELAY_TOKEN`
or `/drive` downloads 401) and `localhost:8012` in `ALLOWED_ORIGINS`.

## How it's used (assignment URLs)

Researchers push a worker's setup/assignment as a **URL query string**, e.g.
`https://rulingants.github.io/flextext-editor/?vern=fau&vernName=Fayu&anal=id&upload=<driveFolderId>&consentMode=text&consentResp=record`.
`js/app.js → applyUrlSettings()` reads those params on load, applies + persists
them (`localStorage['flextext-ws-settings']`), and shows the "settings received"
toast **only when something actually changed**. The PWA manifest sets
`launch_handler: navigate-existing` so a link reuses the already-open window.

## Structure

> ⚠ **`docs/` IS THE WEBSITE.** GitHub Pages serves **`productionWeb:/docs`**, so only what is
> inside `docs/` is ever published. Everything else in this repo is committed but never served —
> which is exactly what lets the native wrappers live here without reaching the web.
> `docs/.nojekyll` disables Jekyll so files are served verbatim.

```
docs/                THE PUBLISHED SITE (the PWA)
android/             Capacitor wrappers (recorder + editor APKs) — never served
electron/            desktop shell (Windows) — never served
worker/              the Cloudflare Worker + D1 backend (former flextext-r2-worker repo) — never served
paragraph-analysis/  the Paragraph Analysis Tool satellite shell + its Cloudflare deploy plumbing
                     (own git-connected Worker `paragraph-analysis-tool` → pat.flextext.app, where
                     the app IS the origin ROOT — safe only because that origin is its own;
                     deploy.sh routes productionWeb → deploy, other branches → preview alias;
                     build.sh copies docs/ into the same deployment; shell.js serves kill-switch
                     workers at the stale scopes — see its CLAUDE.md). public/ is build output.
plans/       DESIGN DOCS — tracked in git, NEVER served (deliberately not under docs/, which is
             the website). The one exception to the "AI/dev markdown is not tracked" rule; see
             plans/README.md for what may and may not go in it.
notes/       working scratch + task briefs, gitignored, never served
```

- `docs/index.html`, `docs/manifest.webmanifest`, `docs/sw.js` (service worker)
- `docs/js/` — `app.js` (main), `upload.js` (Google Drive upload), `i18n.js` (en/id strings),
  `audio.js` (download/cache/playback), `native-audio.js` (**the ONE native chokepoint**), the
  **connectivity engine**: `crypto.js` (E2EE primitives), `sync.js` (no-login D1 sync),
  `researcher.js` (account/auth + instance/Ki logic), `researcher-panel.js` (the researcher UI),
  and the **segmentation engine**: `segments.js` (the time-span model + ordering invariants),
  `segment-strips.js` (baseline strip UI + peaks), `seg-exports.js` (EAF ×2 profiles, preview
  page, BWF bext, `buildFxpa` — pure format module, node-testable), plus the **paragraph
  engine**: `paragraph-model.js` (`.fxpa` validate/serialize + grouping invariants — pure) and
  `paragraph-ui.js` (the Paragraph Analysis satellite UI, `window.__MODE='paragraph'`)
- `satellites/` — the recorder / researcher / crowd-recorder apps (source of truth; mirrored out
  by `sync-satellites.yml` — see the satellites section above)
- root `wrangler.toml` — the `flextext-staging` static-site Worker config for the staging branch's
  Cloudflare dev site (NOT the connectivity Worker; that one is `worker/wrangler.toml`)
- `docs/css/`, `docs/icons/`, `docs/help/`, `docs/installers/`
- `dev-serve.sh` (no-cache rig), `devctl.sh` (dev-rig daemon controller) — root, not served
- `notes/` — `RELEASE-RUNBOOK.md` (how to ship), `connectivity-*.md` (design/status),
  `release-track-broker-and-turnstile.md` (the deferred Drive-broker design)
- `samples/` — real language data, gitignored, root only

**Two traps this layout created — both already handled, don't undo them:**
1. `.gitignore` must ignore `notes/`, **not** `docs/`. Ignoring `docs/` would ignore the whole website.
2. The bare `CLAUDE.md` ignore rule swallows `android/CLAUDE.md` (the native contract). It is
   **force-added**; if you ever re-add it, use `git add -f`.

**Flipping the Pages source does NOT trigger a rebuild.** Changing it and pushing in the wrong
order once served the branch root, so every asset 404'd while Jekyll returned a 200 placeholder
built from README.md. Push first, flip, then **force a rebuild with a commit** — and verify with a
check that can FAIL, e.g. `/dev-serve.sh` must be **404** (it exists only at the branch root, so if
it serves, Pages is publishing the root).

## Connectivity / researcher backend (separate repo)

The no-login sync + researcher accounts run on a Cloudflare Worker + D1 that lives IN THIS REPO
under **`worker/`** (folded 2026-07-23 from the former private repo `flextext-r2-worker`, as a fresh
snapshot — the old clone at `/Users/Seth/GIT/flextext-r2-worker/` is now legacy). Deployed to
`*.workers.dev` (the client's `DEFAULT_WORKER` in `js/app.js`) via the manual-dispatch Actions
`worker-deploy.yml` / `worker-d1-migrate.yml` / `worker-wrangler.yml`. Auth = email +
password (password never reaches the server) with operator-recoverable escrow +
optional TOTP 2FA; metadata is E2EE so D1 holds ciphertext. See
[`notes/RELEASE-RUNBOOK.md`](notes/RELEASE-RUNBOOK.md) for deploy/migration and
[`docs/connectivity-auth-plan.md`](docs/connectivity-auth-plan.md) for the locked design.

---

## ⚠️ GitHub costs — ask before anything billable (firm policy, 2026-07-07)

**Claude: never trigger anything that can incur GitHub charges without Seth's explicit
approval AND a stated cost estimate first.**

- FREE, always: Actions on **public** repos with **standard** GitHub-hosted runners;
  self-hosted runners; GitHub Pages.
- METERED (free monthly quota, then paid): Actions in **private** repos (2,000 min/mo;
  **Windows counts 2×, macOS 10×**); Codespaces; Packages; Git LFS.
- **ALWAYS billable, even on public repos: larger / GPU runners** (anything beyond the
  standard `ubuntu-latest` / `windows-latest` / `macos-latest` tiers).
- Safety valve: with **no payment method on file, GitHub blocks usage at the quota and
  cannot bill** — keep it that way, or set stop-usage budgets.

So WITHOUT Seth's explicit OK (and cost), do **not**: add or change `.github/workflows/**`;
use a non-standard `runs-on:`; add a `schedule:` (cron) trigger; create Codespaces; use
Git LFS; publish private Packages; or change the plan / budgets. The local
`.git/hooks/pre-push` blocks workflow pushes (override `ALLOW_WORKFLOW_PUSH=1`) and
production-branch pushes (`ALLOW_MAIN_PUSH=1`) — set those flags only after Seth approves
that specific push.

---

## 🔐 SECRETS NEVER GO IN — the guard, and why it has no override (Seth, 2026-08-15)

> *"Let's have more careful guards to make sure we check for and don't upload secrets publicly in
> the future."* — after credentials in a OneStory project file sat in a public repo.

**A push to a public repo is irreversible.** The moment it lands it is cloned, cached and indexed;
deleting the file afterwards removes **nothing** (the blob stays fetchable until the history is
rewritten), and the credential has to be rotated whatever you do next. There is exactly one cheap
moment, and it is before the bytes leave. So:

- **`./check-secrets.sh`** — scans for credential FORMATS (PEM headers, `ghp_`/`github_pat_`, AWS
  key ids, Google API keys and service-account JSON, Slack/Stripe/SendGrid tokens, credentials
  inside a URL) and for FILE TYPES that exist to hold secrets or other people's personal data
  (`.onestory`, `.env`, `.dev.vars`, `*.pem|key|p12|pfx|jks`, `credentials.json`, …).
  `--staged` for a pre-commit check, `--range A..B` for what a push would send, no args for the
  whole tracked tree.
- **`hooks/pre-push`** (tracked) carries all three guards — secrets, workflows, production — and
  **`./install-hooks.sh`** copies it into `.git/hooks`. ⚠ The installer **never overwrites an
  existing hook**; it prints a diff and stops, because Seth's Mac already has one and silently
  replacing it would be a guard-changing act disguised as setup.
- **`test/secret-guard.test.mjs`** pins the three ways this rots into decoration: the scan's exit
  code not reaching git, an override appearing on the secrets check, and the self-reference
  exemption growing a DIRECTORY. That last one is not hypothetical — the list shipped with
  `plans/*` in it for about ten minutes, and the first version of the assertion passed anyway.

**⚠ The workflow and production guards have overrides; the secrets guard deliberately does not.**
Those two are POLICY — Seth approves a specific push. A leaked key is not policy, and *"I know what
I'm doing"* is the one thing every leaked key has in common. If something legitimate trips it, widen
`OK_NAMES` in `check-secrets.sh` **in the commit that needs it**, where a reviewer can see the
exception, rather than letting it live in someone's `--no-verify` habit.

**⚠ And keep it narrow.** It matches key FORMATS, never the words "password" or "secret", which
appear all over legitimate source. This repo's own rule, from its tests: *a check that cries wolf
gets muted, which is worse than no check.*

**On GitHub, per repo** (free on public repos, and Seth's to switch on): **Secret scanning** ON and
**Push protection** ON. Push protection is the half that blocks the push; scanning alone only tells
you after the bytes are already public.
