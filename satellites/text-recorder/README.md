# Flextext Recorder

A stripped‑down, **recording‑only** PWA for native‑speaker coworkers gathering audio
on a phone — record → send.

> **This is a companion to the [Flextext Editor](https://github.com/rulingAnts/flextext-editor),
> which is the main project.** The Flextext Recorder is the *same app* running in its "record"
> mode — all the recording, consent, storage, and upload logic lives in the editor repo and
> is maintained there, once. This repo is only a thin shell so the recorder installs as its
> **own** home‑screen app. **For issues, contributions, and the full story, go to the
> [Flextext Editor repo](https://github.com/rulingAnts/flextext-editor).**

Live: <https://rulingants.github.io/text-recorder/> · Editor: <https://rulingants.github.io/flextext-editor/>

## Why a separate repo?

Two PWAs on the same origin must have **non‑overlapping scopes** or the browser treats
them as one app (installing one makes the other show "already installed"). The editor
lives at `…/flextext-editor/` (root scope). Hosting the recorder at the sibling path
`…/text-recorder/` gives it a **disjoint scope**, so it installs as a separate app —
*without* moving or disrupting the already‑deployed editor.

## How it shares the codebase

`index.html` here is a thin shell that loads the editor's engine over the **same origin**
(no CORS): `/flextext-editor/js/app.js` + `/flextext-editor/css/app.css`. The recording /
consent / upload logic is therefore maintained **once**, in the editor repo. This repo
holds only:

- `index.html` — the shell (sets `window.__MODE = 'record'` to tell the shared engine to
  render the record‑only UI)
- `recorder.webmanifest` — the manifest, with a distinct `id` + `scope` so it installs separately
- `sw.js` — its own service worker (a SW can't reach above its own folder on GitHub Pages,
  so each app serves its own)
- `icons/` — the recorder's app icons (microphone)

## Independent but coupled — read before changing either repo

This and the editor are **two independent Git repos**, but the recorder runs the
editor's engine, so they are coupled. Three rules keep them consistent (full
detail for AI agents in [CLAUDE.md](CLAUDE.md)):

1. **Change the engine in the editor repo, not here.** All record/consent/upload
   logic lives in `flextext-editor`; never copy engine code into this repo.
2. **Bump this `sw.js` `VERSION`** whenever an editor-engine change should reach
   installed recorders — this SW precaches the editor engine *by path*, so
   without a bump, recorders keep serving a stale cached engine offline.
3. **Deploy the editor FIRST.** When a change spans both repos, deploy the
   editor's `productionWeb`, confirm `/flextext-editor/` is live, *then* push
   this repo — the recorder's SW caches whatever editor engine is live at install
   time, so the reverse order would cache the old engine.
4. **The consent modal markup is stamped in three shells.** The consent dialog in
   `index.html` here is kept identical to the copies in the editor's and the
   [crowd recorder](https://github.com/rulingAnts/crowd-recorder)'s `index.html`
   (the shared engine only wires behavior onto it) — a markup change in one must
   be made in all three.

## Deploy

GitHub Pages from the repo root → served at <https://rulingants.github.io/text-recorder/>.
Bump `sw.js` `VERSION` on each deploy. See the deploy-order rule above when the
change also touches the editor.

> ⚠️ The shell depends on the editor being deployed at `…/flextext-editor/` on the **same
> origin**. If the editor moves or its `js/`/`css/` paths change, update the script/link
> hrefs in `index.html` here to match.

## License

[GNU AGPL‑3.0](LICENSE) — same license as the [Flextext Editor](https://github.com/rulingAnts/flextext-editor).
© 2026 Seth Johnston.
