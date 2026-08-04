# Flextext Paragraph Analysis — folder guide for Claude / LLMs

This folder ships the **Flextext Paragraph Analysis** PWA — the satellite where a researcher
groups interlinear lines into progressively larger units (phrase → clause → sentence →
paragraph → …) for Semantic Structure Analysis / arcing / Longacre-style paragraph work.
Live at <https://flextext-paragraph.68mh29kgsd.workers.dev/> (own Cloudflare Worker, see below).

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
this app deploys as the git-connected Cloudflare Worker **`flextext-paragraph`** (branch
`productionWeb`, root directory `paragraph-analysis/`, build `bash build.sh`, deploy
`npx wrangler deploy` — the git connection is Seth's dashboard step). `build.sh` assembles
`public/`: `../docs` → `public/flextext-editor/` (the engine, COPIED) + this shell →
`public/paragraph-analysis/`. **Engine and shell ship in one atomic deployment, so this
satellite has NO deploy-order hazard** — its precached engine paths can never 404.
`shell.js` redirects `/` → `/paragraph-analysis/` and serves `sw.js` with `no-store`
(workers.dev CDN pinned a stale sw.js for the staging site once — same fix as
`staging-shell.js`).

## Version coupling (enforced)

`sw.js` declares its own `VERSION` (own cadence) and the editor `ENGINE` it was built against;
`test/version-sync.test.mjs` fails the release unless ENGINE == the editor's ENGINE_VERSION.
`./bump-version.sh vNNN` maintains all of it. **A new top-level import in `js/app.js` is a new
SHELL entry here too** (and in both other satellites) — keep the engine list identical to the
editor's `sw.js`.

## Local dev

`bash dev-serve.sh 8012` serves this shell at `http://localhost:8012/paragraph-analysis/`
beside the editor (same origin, like production). No Cloudflare needed for local testing.
