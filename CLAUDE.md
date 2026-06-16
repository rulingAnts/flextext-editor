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
  or installed recorders keep serving a **stale cached engine** offline.
- **⚠ DEPLOY ORDER — editor first, always:** when a change spans both repos,
  deploy **this repo's `productionWeb` FIRST**, confirm `/flextext-editor/` is
  live, **then** push the recorder repo. The recorder's SW precaches whatever
  editor engine is live *at install time* — pushing it first would cache the OLD
  engine.
- The recorder repo holds only: its shell (`index.html`), its manifest
  (`recorder.webmanifest`, distinct `id`/`scope`), its `sw.js`, and its icons.
  It has its own `CLAUDE.md` stating the same rules from its side.

## Local dev / testing

The app is a static PWA — no build step. Serve it locally:

```sh
python3 dev_server.py --port 8765   # HTTPS via mkcert — needed for getUserMedia (audio recording)
python3 -m http.server 8011         # plain HTTP — fine for most testing (localhost is a secure
                                    #   context, so the service worker works; recording needs HTTPS)
```

`.claude/launch.json` has these as preview configs.

## How it's used (assignment URLs)

Researchers push a worker's setup/assignment as a **URL query string**, e.g.
`https://rulingants.github.io/flextext-editor/?vern=fau&vernName=Fayu&anal=id&upload=<driveFolderId>&consentMode=text&consentResp=record`.
`js/app.js → applyUrlSettings()` reads those params on load, applies + persists
them (`localStorage['flextext-ws-settings']`), and shows the "settings received"
toast **only when something actually changed**. The PWA manifest sets
`launch_handler: navigate-existing` so a link reuses the already-open window.

## Structure

- `index.html`, `manifest.webmanifest`, `sw.js` (service worker)
- `js/` — `app.js` (main), `upload.js` (Google Drive upload), `i18n.js` (en/id strings)
- `css/`, `icons/`, `samples/`, `docs/`
