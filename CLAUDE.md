# FlexText Editor — repo guide for Claude / LLMs

Offline-first interlinear text editor PWA for FLEx `.flextext` files (baseline
transcription, word glossing, free translation). It's a **static site** served
via GitHub Pages.

## Branches — READ THIS FIRST

| Branch | Purpose |
|---|---|
| `main` | **Development.** All work and commits go here. Test locally with the dev server (below). |
| `productionWeb` | **The live site.** Deployed by GitHub Pages to https://rulingants.github.io/flextext-editor/ . Only stable, tested versions belong here. |
| `segmentation` | **Experimental, parked.** Simple-ELAN segmentation Phase 1 — unfinished and risky. Kept OFF `main` on purpose (2026-07-28). |

> **⚠ `segmentation`: REBASE onto `main`, never merge it.** It was removed from `main` by revert
> (`1ef6df2`), so a merge would meet those reverts and git would treat the changes as already
> applied-and-undone — silently reinstating nothing. Rebase replays the commits fresh.
>
> **Why it was parked:** it lived on `main` while unfinished, so every release had to cherry-pick
> around it and merge back (v126, v127/v128, v129). Worse, the SHELL merge conflict offers
> `segments.js` and `history.js` as a single hunk — taking both precaches a file production does not
> serve, which is exactly the v108 outage. Anything long-running and half-built belongs on its own
> branch for the same reason.

### 🚩 FEATURE BRANCHES — standing policy (Seth, 2026-07-28)

**Build any new feature on its own branch — especially a major one. Do not develop it on `main`.**

`main` must stay releasable at all times, because a release is a `merge --ff-only main` and there is
no way to ship *part* of `main`. The moment an unfinished feature sits there, every unrelated
release has to be cherry-picked around it — which happened three times for segmentation before it
was moved off, and each cherry-pick re-offered the SHELL hunk that caused the v108 outage.

- Branch from `main`: `git checkout -b <feature> main`. Push it freely, finished or not.
- Merge to `main` only when the feature is **complete and tested** — at which point `main` is
  releasable again and a production release is a plain fast-forward with nothing to resolve.
- Small, self-contained, same-day changes can still go straight to `main`. The test is whether
  `main` would be releasable if you stopped work right now.
- ⚠ If a branch was ever removed from `main` by revert (as `segmentation` was), **rebase it onto
  `main`, never merge it** — a merge meets the reverts and silently reinstates nothing.

**Do NOT push to `productionWeb` without the maintainer's explicit OK.** It's the
live site that real users (field translators in the village) load — a broken push
breaks their work. Develop and test on `main` first.

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
> Turnstile** — is in **[`docs/RELEASE-RUNBOOK.md`](docs/RELEASE-RUNBOOK.md)**.
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

**Enforcement (don't rely on memory — it already failed once):**
- Each satellite repo has **`check-editor-shell.sh`** — curls every `/flextext-editor/...` path in
  its SHELL against the live site and fails on anything that isn't 200.
- It is wired into each satellite's **`.git/hooks/pre-push`**, so a premature push is *blocked*.
  Hooks aren't versioned — **reinstall after any re-clone** (the script is committed; the hook
  calls it). Override only with cause: `ALLOW_STALE_SHELL=1`.
- **Adding a new top-level `import` to `js/app.js` is the trigger.** It becomes a new SHELL entry
  in the editor *and both satellites*, so it is exactly the change that needs this ordering.

**Correct sequence, every time:**
1. Land the engine change on editor `main`, bump `sw.js` VERSION.
2. Get Seth's sign-off, then ff-merge `main` → `productionWeb` and push.
3. **Confirm it is live** (`curl` the new path → 200; the sw.js VERSION reports the new number).
4. Only then bump + push the satellites — their hook will re-verify anyway.

## Companion repo: the Flextext Recorder (`rulingAnts/text-recorder`) — READ THIS

There is a **second, independent Git repo** that ships a sibling PWA, the
**Flextext Recorder**, live at https://rulingants.github.io/text-recorder/ .
Local path: `/Users/Seth/GIT/text-recorder/`. This editor is the **main
project**; the recorder is a thin companion.

- **Why a separate repo:** two PWAs on one origin must have **non-overlapping
  scopes** or the browser treats them as one app (installing one makes the other
  report "already installed"). The editor owns `/flextext-editor/` (root scope);
  the recorder lives at the disjoint sibling path `/text-recorder/`. Keeping it
  in its own repo lets the editor stay at `/flextext-editor/` **untouched** —
  moving the editor would change its PWA `id` and **orphan every installed copy
  in the field**.
- **Same code, one engine — change it HERE:** the recorder is NOT a fork. Its
  `index.html` is a thin shell that loads THIS repo's engine cross-path over the
  same origin (`/flextext-editor/js/app.js` + `css/app.css`) and sets
  `window.__MODE='record'` to render the record-only UI. **All
  record/consent/storage/upload logic lives in this editor repo.** Make engine
  changes here; never copy engine code into the recorder repo.
- **⚠ VERSION COUPLING:** the recorder has its OWN `sw.js` that **precaches this
  repo's engine files by path**. Whenever you change the engine here in a way the
  recorder should pick up, you MUST also bump `text-recorder/sw.js`'s `VERSION`,
  or installed recorders keep serving a **stale cached engine** offline. **And if
  you change `js/app.js`'s top-level `import` graph, add/remove the matching files
  in the recorder's `sw.js` `SHELL` list too** — the recorder loads `app.js` as a
  module and resolves every static import at load (even in record mode), so a
  missing precached module makes an updated recorder **dead offline**. (v67 added
  `crypto.js`/`sync.js`/`researcher.js`/`researcher-panel.js` to that graph →
  recorder `sw.js` `v19` precaches them.)
- **⚠ DEPLOY ORDER — editor first, always:** when a change spans both repos,
  deploy **this repo's `productionWeb` FIRST**, confirm `/flextext-editor/` is
  live, **then** push the recorder repo. The recorder's SW precaches whatever
  editor engine is live *at install time* — pushing it first would cache the OLD
  engine.
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

## Local dev / testing

The app is a static PWA — no build step. Simple options:

```sh
python3 dev_server.py --port 8765   # HTTPS via mkcert — needed for getUserMedia (audio recording)
python3 -m http.server 8011         # plain HTTP — fine for most testing (localhost is a secure
                                    #   context, so the service worker works; recording needs HTTPS)
```

`.claude/launch.json` has these as preview configs.

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
docs/        THE PUBLISHED SITE (the PWA)
android/     Capacitor wrappers (recorder + editor APKs) — never served
electron/    desktop shell (Windows) — never served
worker/      the Cloudflare Worker + D1 backend (former flextext-r2-worker repo) — never served
notes/       planning docs, gitignored, never served
```

- `docs/index.html`, `docs/manifest.webmanifest`, `docs/sw.js` (service worker)
- `docs/js/` — `app.js` (main), `upload.js` (Google Drive upload), `i18n.js` (en/id strings),
  `audio.js` (download/cache/playback), `native-audio.js` (**the ONE native chokepoint**), and the
  **connectivity engine**: `crypto.js` (E2EE primitives), `sync.js` (no-login D1 sync),
  `researcher.js` (account/auth + instance/Ki logic), `researcher-panel.js` (the researcher UI)
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
[`docs/RELEASE-RUNBOOK.md`](docs/RELEASE-RUNBOOK.md) for deploy/migration and
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
