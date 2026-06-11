# FlexText Interlinear

An offline-capable web app (PWA) that duplicates FieldWorks Language Explorer's
interlinear **Baseline** and **Gloss** tabs, editing
[`.flextext`](docs/FlexInterlinear.xsd) files directly — no FLEx, no lexicon, no
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
[docs/](docs/FlexInterlinear.xsd)):
`document > interlinear-text > paragraphs > paragraph > phrases > phrase >
words > word`, with `item` elements (`txt`, `punct`, `gls`, `segnum`, `pos`, …)
carrying `lang` writing-system codes, chained words as `<word type="phrase">`,
and a `<languages>` declaration block.

## Development

Static site, no build step. Serve the folder with the included dev server
(plain Python, no dependencies — sends `Cache-Control: no-cache` and correct
MIME types):

```sh
python3 dev_server.py            # http://localhost:8765/
```

The service worker is skipped on `localhost` so you always see fresh files
(add `?sw=1` to test offline behavior locally).

**Testing offline:** load `http://localhost:8765/?sw=1` once while the server
is running normally, then restart it as `python3 dev_server.py --offline` —
every request now fails with 503, like a dead connection. Reload the page:
the app should keep working entirely from the service-worker cache. When
done, unregister the service worker (DevTools → Application → Service
workers → Unregister) to get back to live-reload development.

**Branches:** day-to-day work lands on `main`; when a release is ready, bump
`VERSION` in `sw.js` and merge/push `main` into `productionWeb`, which is the
branch GitHub Pages serves.

**Releasing an update:** bump `VERSION` in `sw.js` and deploy. Installed
clients check for a changed `sw.js` on every launch, on returning to the
foreground, and when the network comes back; when a new version has downloaded
they see an **Update** button (so the app never swaps versions mid-edit —
the new version also applies on the next full restart). GitHub Pages caches
`sw.js` for up to 10 minutes, so allow that long for rollout to begin.

`js/flextext.js` is the format engine (parse / serialize / tokenize /
segment / reconcile); `js/app.js` is the UI; `js/db.js` is IndexedDB storage.

## Deploying to GitHub Pages

GitHub Pages serves the `productionWeb` branch, folder `/ (root)`
(**Settings → Pages → Deploy from a branch**). The app appears at
`https://<user>.github.io/<repo>/` — HTTPS, so the service worker and Web
Share work. To release: bump `VERSION` in `sw.js` on `main`, then fast-forward
`productionWeb` to `main` and push:

```sh
git checkout productionWeb && git merge --ff-only main && git push && git checkout main
```

> **Note:** `samples/` contains real language data and is `.gitignore`d so it
> never lands in a public repo. Remove the ignore line if you want them
> published.
