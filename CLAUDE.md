# FlexText Editor — repo guide for Claude / LLMs

Offline-first interlinear text editor PWA for FLEx `.flextext` files (baseline
transcription, word glossing, free translation). It's a **static site** served
via GitHub Pages.

## Branches — READ THIS FIRST

| Branch | Purpose |
|---|---|
| `main` | **Development.** All work and commits go here. Test locally with the dev server (below). |
| `productionWeb` | **The live site.** Deployed by GitHub Pages to https://rulingants.github.io/flextext-editor/ . Only stable, tested versions belong here. |

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

- `index.html`, `manifest.webmanifest`, `sw.js` (service worker)
- `js/` — `app.js` (main), `upload.js` (Google Drive upload), `i18n.js` (en/id strings),
  `audio.js` (download/cache/playback), and the **connectivity engine**: `crypto.js`
  (E2EE primitives), `sync.js` (no-login D1 sync), `researcher.js` (account/auth +
  instance/Ki logic), `researcher-panel.js` (the researcher UI)
- `dev-serve.sh` (no-cache rig), `devctl.sh` (dev-rig daemon controller)
- `css/`, `icons/`, `samples/`, `docs/`
- `docs/` — `RELEASE-RUNBOOK.md` (how to ship), `connectivity-*.md` (design/status),
  `release-track-broker-and-turnstile.md` (the deferred Drive-broker design)

## Connectivity / researcher backend (separate repo)

The no-login sync + researcher accounts run on a Cloudflare Worker + D1 in the
**`flextext-r2-worker`** repo (`/Users/Seth/GIT/flextext-r2-worker/`, deployed to
`*.workers.dev`; the client's `DEFAULT_WORKER` in `js/app.js`). Auth = email +
password (password never reaches the server) with operator-recoverable escrow +
optional TOTP 2FA; metadata is E2EE so D1 holds ciphertext. See
[`docs/RELEASE-RUNBOOK.md`](docs/RELEASE-RUNBOOK.md) for deploy/migration and
[`docs/connectivity-auth-plan.md`](docs/connectivity-auth-plan.md) for the locked design.
