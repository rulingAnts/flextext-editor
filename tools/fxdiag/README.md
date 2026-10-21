# fxdiag — FlexText storage, read from the disk

A small tool for a computer (Windows, Mac, Linux) that finds every browser profile holding FlexText
storage — Chrome, Edge, Brave, Chromium, Vivaldi, the Flextext Desktop (Electron) shell, the FLEx
shell's WebView2 folder, and the Firefox family (Firefox, LibreWolf, Waterfox — see the caveat below) —
and writes **one zip** with what a problem report needs: a manifest of the
texts on the device (ids, titles, dates, sizes, upload state, which have a recording), the device's
settings, which suite apps are installed, and, **only if ticked**: the texts as **`.flextext` files**
beside their **recordings** (written by the engine's own serializer, so FLEx or another device can open
them), the full text **records** as JSON, and the suite origins' **raw browser storage** (their IndexedDB
folders, byte for byte, for re-reading later). Same file shape as the in-app problem report's private
leg (`plans/BACKLOG.md`, the widened #98), so one reader serves both.

**It reads only the FlexText suite's storage.** Origins are filtered by host (the suite's domains, its
Cloudflare account's Workers, GitHub Pages, localhost), databases and keys by their `flextext` prefix.
Nothing from any other site is opened, copied or listed — the profile-wide Local Storage LevelDB is never
included raw for that reason (it holds every site's keys). `fxdiag/suite.py` is where the tool knows what
the suite is, and `test/fxdiag-suite-sync.test.mjs` (repo root) fails when an app, host, database or key
appears in `docs/js` that it would not recognise — see CLAUDE.md, "fxdiag follows the suite's storage".

**Where it is offered:** the researcher panel's Feedback window ("Diagnostic tool for computers"), and
nowhere else — a coworker's device shows no off-site links, and a phone cannot run it.

It never talks to a running browser: the LevelDB folders are **copied** first and the copy is parsed
(`snapshot.py`), LOCK files left alone. It cannot read an Android phone — that storage is sandboxed —
so for a field device the in-app report is the route; this tool is for laptops, the Electron shell,
and the FLEx shell.

## Install (needs Python 3.11+ and git on PATH)

```powershell
py -3.13 -m pip install "flextext-fxdiag[gui] @ git+https://github.com/rulingAnts/flextext-editor.git@desktop-flex#subdirectory=tools/fxdiag"
fxdiag                 # the window
fxdiag scan            # console: what is on this disk
fxdiag report --flextext --with-audio --out report.zip   # texts as .flextext files + recordings
fxdiag report --texts all --raw --out report.zip         # raw records + the suite origins' IndexedDB folders
```

`--flextext` runs the engine's serializer in **Node.js** (nodejs.org); without Node the report still
holds the JSON records and says what to install. 
**Or the portable Windows exe** — one file, no Python, no install, Node bundled: the pre-release
`fxdiag-v<version>-pre` on the repository's Releases page (rebuilt in place, same link, whenever
`tools/fxdiag` changes on `desktop-flex` or `main`). Unsigned, so SmartScreen warns on first run (*More info →
Run anyway*). Built by `.github/workflows/build-fxdiag.yml`; the build
runs the tests on Windows, then `packaging/smoke_exe.py` against the exe itself with Node removed from
PATH, then opens its window, before anything is published. `packaging/build_exe.py` builds the same thing
locally on any OS.

`git` is needed at install time because the LevelDB/IndexedDB decoder, CCL Solutions Group's
`ccl_chromium_reader` (MIT), is not on PyPI. Nothing needs the network when it runs. Without the
`[gui]` extra there is no window, only the console commands.

**From a thumb drive:** `py -3.13 -m venv X:\fxdiag && X:\fxdiag\Scripts\pip install "…"` (as above)
on a machine that has Python; then `X:\fxdiag\Scripts\fxdiag` on any machine with the same Python
version. Point it at a copied profile folder with `--user-data-dir` if the browser is not on that
machine. `--all-users` looks under every account's folder.

## Firefox and relatives — read, with a caveat

Gecko keeps each origin's storage in its own folder (`storage/default/<scheme+++host>/idb/*.sqlite`,
`ls/data.sqlite`), values Snappy-compressed and structured-clone encoded. fxdiag reads them with
moz-idb-edit's codecs (MPL-2.0, a git dependency) and its own SQL — `fxdiag/gecko.py`. ⚠ **Unverified
on a real Firefox profile**: no Firefox could be run where this was written, so the discovery and the
localStorage reader are tested on synthetic layouts only and the IndexedDB reader's test runs only when
`tests/fixtures/firefox-fixture.zip` exists. Every report says so in its blind spots. To make the fixture
on a machine with Playwright's Firefox: `FXDIAG_BROWSER=firefox node tests/make_profile.mjs <dir>`, then
zip that profile's `storage/default/<suite origins>` into the fixture file. Firefox has no installed PWAs
on desktop, so there is no installed-app listing for it.

## USB: grabbing, assigning and deleting with no network — `fxdiag pack`

`fxdiag report --flextext --with-audio` **grabs** a computer's texts as files. `fxdiag pack` makes the
return trip: a **USB exchange package** — the texts and recordings for a device, `assign.html` with the
same settings link the researcher panel would send (writing systems, upload folder, consent mode…), a
`MANIFEST.json`, and a README with the steps — which the person applies **in the app on the device**:
open the link (an installed app applies it offline), then *Open text + recording together* for each text.
Texts the researcher wants removed are listed in the manifest as a request; the person removes them in the
app after checking they are safe elsewhere.

```powershell
fxdiag pack report.zip --out E:or-device-7 --device "device 7" --assign vern=xx --assign anal=en --assign upload=<folderId> --delete <id>:<title> --zip
```

⚠ **fxdiag never writes into a browser's storage, and will not.** Chromium's IndexedDB is a LevelDB with
Blink-serialised values, blob journals and per-store metadata; Firefox's is SQLite with structured-clone
values and side files. One wrong byte written from outside the browser, into a store it may hold open,
is how a device loses every text on it — and no field phone can be reached that way anyway. Everything
goes in through the app's own doors. The app-side **Import from USB** that takes a whole package at once
and offers the marked deletions is planned (`plans/BACKLOG.md`, "USB exchange"); until then the package
is applied one pair at a time with the dialog the app already has.

## What is in the zip

| file | holds |
|---|---|
| `report.json` / `README.txt` | tool version, when, OS, what was asked, per-store counts, copy problems, the blind spots |
| `storage-<app>-<profile>.json` | per suite origin: databases → stores → counts; the `media` manifest; per-text manifest rows; localStorage (settings parsed; credential-named keys as *present + length*, never the value); installed web apps |
| `texts/…/<id>.json` | the full `docs` record — only with `--texts` |
| `media/…/<key>.wav` | the recording — only with `--with-audio` |
| `export/…/<title>.flextext`, `<title>.wav` | the text as a file FLEx can open, its recording beside it (the `media-files` block names it) — only with `--flextext` (+ `--with-audio`) |
| `raw/…/IndexedDB/<origin folder>/…` | the suite origins' IndexedDB folders as copied — only with `--raw`; never Local Storage |

Blind spots, also written into every report: Cache Storage (the installed service-worker shell) is
not read; sessionStorage, cookies, history are not read; a browser writing during the copy may have
written since; files the OS refused to copy are listed under `copyProblems`.

## Tests

```sh
pip install -e ".[test]" && pytest tools/fxdiag/tests -q
```

The fixture is a real Chromium profile written by headless Chromium (`tests/make_profile.mjs`) with
made-up records at the suite's production origin, so the on-disk encodings are genuine.
