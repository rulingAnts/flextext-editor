"""Write the pre-release's notes (Markdown) for a built fxdiag executable.

    python tools/fxdiag/packaging/release_notes.py <exe> <gui-outcome> <commit> > notes.md
"""
import hashlib
import sys
from pathlib import Path

exe, gui, commit = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
sha = hashlib.sha256(exe.read_bytes()).hexdigest()
gui_line = ("- **The window was opened on the build machine** (Windows, WebView2) and listed the test profile."
            if gui == "success" else
            "- ⚠ **The window could not be confirmed on the build machine** (outcome: %s). If it does not open, every "
            "command works from a terminal, and a double-click falls back to a console scan." % gui)
print("\n".join([
    "Portable Windows x64 build of **fxdiag**, the FlexText suite's diagnostic and USB-exchange tool for computers.",
    "",
    "**A pre-release, not a release.** Built from commit `%s` on the `desktop-flex` branch." % commit,
    "",
    "- **One file, no install, no admin rights.** Double-click for the window; or from a terminal:",
    "  `fxdiag scan`, `fxdiag report --flextext --with-audio --out report.zip`, `fxdiag pack …`, `fxdiag doctor`.",
    "- **Reads only the FlexText apps' storage** (Chrome, Edge, Brave, Chromium, Vivaldi, the Flextext Desktop shell,",
    "  the FLEx shell; Firefox-family profiles provisionally). Copies first, reads the copy; never writes to a browser.",
    "- **Node.js is bundled**, so texts export as `.flextext` files with the engine's own writer on a laptop with no Node.",
    "- **Unsigned**: Windows SmartScreen warns on first run — *More info → Run anyway*. Some antivirus products",
    "  distrust single-file Python executables; if one quarantines it, the pip install in the README is the alternative.",
    "- **Checked on the build machine**: the exe ran with Node removed from PATH against a real Chromium profile of",
    "  made-up texts — `doctor`, `scan`, a full report (both texts as `.flextext` + the recording + raw storage) and",
    "  a USB package all passed.",
    gui_line,
    "",
    "SHA-256 `%s`" % sha,
    "",
    "Third-party components and their licences: `THIRD-PARTY.txt`, attached. Source: "
    "https://github.com/rulingAnts/flextext-editor/tree/desktop-flex/tools/fxdiag",
]))
