"""fxdiag — read a FlexText device's browser storage FROM DISK into one diagnostic report.

Desktop only, by the nature of the thing: Chromium-family browsers keep every origin's IndexedDB and
localStorage as LevelDB folders inside the profile, an installed PWA is just its origin inside the same
profile, and a tool with the disk can read them. An Android phone's Chrome is sandboxed and opts out of
backup, so this tool cannot reach a field device; the in-app problem report is the route there.

Read-only by construction: the storage folders are COPIED into a temporary folder first and the copy
is what is parsed (snapshot.py), so a profile a browser holds open is never touched, and LevelDB's
LOCK file is never taken.
"""

VERSION = "0.1.0"
