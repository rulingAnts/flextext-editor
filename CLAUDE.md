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
