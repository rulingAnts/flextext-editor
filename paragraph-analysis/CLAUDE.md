# Flextext Paragraph Analysis Tool — folder guide for Claude / LLMs

This folder ships the **Flextext Paragraph Analysis Tool** PWA — the satellite where a researcher
groups interlinear lines into progressively larger units (phrase → clause → sentence →
paragraph → …) for Semantic Structure Analysis / arcing / Longacre-style paragraph work.
Live at <https://pat.flextext.app/> (own Cloudflare Worker `paragraph-analysis-tool`, see below).

## ⚠ This app lives at the ORIGIN ROOT — and that is the exception, not the pattern

`build.sh` assembles the shell into `public/` ITSELF (`/index.html`, `/sw.js`,
`/manifest.webmanifest`, `/icons/`), with the engine copy beside it at `/flextext-editor/`. So
the app IS <https://pat.flextext.app/> — no sub-path, no redirect (Seth, 2026-08-04).

That is safe HERE and nowhere else in the suite: PWA scope isolation only matters when apps
share an origin, which is the case on github.io (editor + recorder + researcher) but not here —
this origin belongs to this app alone, and `/flextext-editor/` on it is asset storage rather
than a second site (its HTML entry points redirect to `/` so nothing can register there).
The shell files still live in this folder, so the LOCAL dev rig serves them at
`/paragraph-analysis/` beside the editor; the manifest therefore uses RELATIVE `start_url`/`scope`
(`"./"`), which resolves correctly at either mount point.

## ⚠ Kill switches — keep them forever

`shell.js` serves a self-unregistering worker at `/paragraph-analysis/sw.js` and
`/flextext-editor/sw.js`. Those are not hypothetical: this site's first (setup-wizard) deployment
served the EDITOR at the origin root, so browsers that visited then held the editor's service
worker at scope `/` and kept painting the editor no matter what the server sent — invisible to
curl, and permanent in Firefox, which (unlike Chrome) keeps a registration whose script 404s.
`/sw.js` fixes itself now because that URL is this app's real worker; `sw.js` detects the ghost by
its `flextext-v<n>` cache, activates immediately instead of waiting behind it, and reloads the tab.
Deleting a kill-switch route silently re-strands every browser that has not come back yet.
`test/paragraph-shell.test.mjs` guards all of it.

## This is a SHELL, not a fork

`index.html` sets `window.__MODE = 'paragraph'` and loads the SHARED engine same-origin
(`/flextext-editor/js/app.js` + `css/app.css`) — exactly the researcher-app pattern. **All
paragraph logic lives in the editor's `docs/js/`:**

- `docs/js/paragraph-model.js` — the `.fxpa` validate/serialize + the grouping-tree invariants
  (PURE, node-tested by `test/paragraph-model.test.mjs`)
- `docs/js/paragraph-ui.js` — the whole UI (open screen, display modes, audio, bracket tree)
- `docs/js/seg-exports.js → buildFxpa()` — the editor-side `.fxpa` export this app consumes

Do **not** copy engine code into this folder. This folder holds ONLY the shell (`index.html`),
`manifest.webmanifest` (id/scope `/paragraph-analysis/`), `sw.js`, `icons/`, and the deploy
plumbing (`wrangler.toml`, `build.sh`, `shell.js`).

## Deployment — its OWN Cloudflare Worker, NOT a Pages mirror

Unlike the recorder/researcher (GitHub Pages mirror repos published by `sync-satellites.yml`),
this app deploys as the git-connected Cloudflare Worker **`paragraph-analysis-tool`**
(production branch `productionWeb`, root directory `paragraph-analysis/`, custom domain
**pat.flextext.app**). **Branch routing lives IN GIT, not the dashboard** (Seth's rule —
guarded in the workflow, not in memory): both dashboard commands (Deploy AND the
non-production "Version" command) are `bash deploy.sh`, which

1. runs `build.sh` (also wired as the wrangler `[build]` hook, so assembly can never be
   skipped) — assembles `public/`: `../docs` → `public/flextext-editor/` (the engine, COPIED)
   + this shell → `public/paragraph-analysis/`;
2. verifies release integrity and FAILS the build otherwise: `test/version-sync.test.mjs` +
   every `sw.js` SHELL path must exist in the assembled `public/`;
3. routes by `WORKERS_CI_BRANCH`: `productionWeb` → `wrangler deploy` (production);
   any other branch → `wrangler versions upload --preview-alias <branch>` → a stable
   per-branch preview URL (`staging-paragraph-analysis-tool.68mh29kgsd.workers.dev` is always
   the latest staging build; other branches get their own alias and never touch it).

**Safety net:** `build.sh` REFUSES to build a non-production branch unless routed through
`deploy.sh` (`FX_CI_ROUTED`), so a dashboard command misconfigured back to raw
`npx wrangler deploy` fails loudly instead of deploying a feature branch over production.

**Engine and shell ship in one atomic deployment, so this satellite has NO deploy-order
hazard** — its precached engine paths can never 404. `shell.js` redirects `/` →
`/paragraph-analysis/` and serves `sw.js` with `no-store` (workers.dev CDN pinned a stale
sw.js for the staging site once — same fix as `staging-shell.js`).

## Version coupling (enforced)

`sw.js` declares its own `VERSION` (own cadence) and the editor `ENGINE` it was built against;
`test/version-sync.test.mjs` fails the release unless ENGINE == the editor's ENGINE_VERSION.
`./bump-version.sh vNNN` maintains all of it. **A new top-level import in `js/app.js` is a new
SHELL entry here too** (and in both other satellites) — keep the engine list identical to the
editor's `sw.js`.

## Local dev

`bash dev-serve.sh 8012` serves this shell at `http://localhost:8012/paragraph-analysis/`
beside the editor (same origin, like production). No Cloudflare needed for local testing.
