"""Finding a FLEx text's recording on THIS machine (plan §8.4). Pure filesystem: no LCM, no network.

FLEx keeps a text's recording as `CmMediaURI.MediaURI`, a plain string that FLEx's own interlinear
view reads as a URI (FieldWorks `InterlinVc.CheckFileExistsFromUri`: `new Uri(s)`, `IsFile`,
`LocalPath`) [source]. So a link may be `file:///C:/…`, a plain absolute path, or, in older or
hand-edited data, a path relative to the project's LinkedFiles folder (liblcm's convention for
linked files, `%lf%\…` or unrooted) [source]. Texts that travelled between machines keep the path
of the machine they came from, so most links in the field point nowhere here (Seth, 2026-10-14).

This module (1) resolves a link to the path it names here, (2) searches a BOUNDED set of folders for
a file with the link's name, and (3) remembers what the user chose, so the next text naming the same
recording, and the next session, find it without asking. It never writes to a FLEx project.
"""

import json
import os
import re
import threading
import time
from urllib.parse import unquote, urlsplit

# What WebView2 (Chromium) can decode, and so what the Segmenter can cut.
AUDIO_EXTS = (".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".webm")
DIALOG_FILTER = "Audio files (" + ";".join("*" + e for e in AUDIO_EXTS) + ")"   # pywebview's 'Description (*.a;*.b)'

LF_MARKER = "%lf%"                      # liblcm LinkedFilesRelativePathHelper.ksLFrelPath [source]
_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]+):")   # two or more letters: `C:` is a drive, not a scheme
_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
MAX_CANDIDATES = 10
MAX_FOLDERS = 12


def _windowsish(p):
    return bool(_DRIVE.match(p)) or p.startswith("\\\\")


def _decode_file_uri(uri):
    """`file:` URI → path string, or None. Drive and UNC forms come back with backslashes."""
    parts = urlsplit(uri)
    host = parts.netloc
    path = unquote(parts.path or "")
    if host and re.match(r"^[A-Za-z]:$", host):          # file://C:/x — a common malformation
        return (host + path).replace("/", "\\")
    if host and host.lower() != "localhost":              # file://server/share/x → \\server\share\x
        return "\\\\" + host + path.replace("/", "\\")
    if re.match(r"^/[A-Za-z]:", path):                    # /C:/x → C:\x
        return path[1:].replace("/", "\\")
    return path or None


def link_path(uri, linked_files_dir=None):
    """The local path a media link names, or None when it names no local file (empty, or a
    non-file URI such as http). Relative and `%lf%` links resolve under `linked_files_dir`."""
    if not isinstance(uri, str):
        return None
    s = uri.strip()
    if not s:
        return None
    m = _SCHEME.match(s)
    if m:
        return _decode_file_uri(s) if m.group(1).lower() == "file" else None
    if s.lower().startswith(LF_MARKER):
        rest = s[len(LF_MARKER):].lstrip("\\/")
        return _under(linked_files_dir, rest)
    if _windowsish(s) or s.startswith("/"):
        return s
    return _under(linked_files_dir, s)


def _under(root, rel):
    if not root:
        return None
    parts = [p for p in re.split(r"[\\/]+", rel) if p and p != "."]
    if any(p == ".." for p in parts):
        return None                                       # a link never climbs out of LinkedFiles
    return os.path.join(root, *parts) if parts else None


def link_name(uri):
    """The file name a link ends in (decoded), or '' — what the search looks for."""
    if not isinstance(uri, str) or not uri.strip():
        return ""
    s = uri.strip()
    m = _SCHEME.match(s)
    if m:
        s = _decode_file_uri(s) if m.group(1).lower() == "file" else unquote(urlsplit(s).path or "")
        s = s or ""
    parts = [p for p in re.split(r"[\\/]+", s) if p]
    return parts[-1] if parts else ""


def link_exists(uri, linked_files_dir=None):
    p = link_path(uri, linked_files_dir)
    return bool(p) and os.path.isfile(p)


def is_audio(path):
    return isinstance(path, str) and os.path.splitext(path)[1].lower() in AUDIO_EXTS


def link_key(uri, project=None):
    """How a link is remembered: an absolute link names one recording whatever project carries it
    (a disposable copy and its original share it); a relative one is only unique within a project."""
    s = (uri or "").strip()
    p = link_path(s, None)
    absolute = bool(p) and (_windowsish(p) or p.startswith("/"))
    norm = (p if absolute else s).replace("\\", "/").casefold()
    return norm if absolute else (str(project or "").casefold() + "|" + norm)


def search(name, roots, max_entries=20000):
    """Files called `name` under `roots` = [(folder, depth), …], best first: exact name (case-
    insensitive) in root order, then the same stem with another audio extension (a WAV that was
    later converted, or the reverse). Bounded: at most `max_entries` directory entries are looked
    at in total; symlinked folders are not followed; unreadable folders are skipped."""
    want = (name or "").casefold()
    if not want:
        return []
    stem = os.path.splitext(want)[0]
    exact, near, seen = [], [], set()
    budget = [max_entries]
    for root, depth in roots:
        if not root or not os.path.isdir(root):
            continue
        queue = [(root, 0)]
        while queue and budget[0] > 0:
            folder, level = queue.pop(0)
            try:
                entries = list(os.scandir(folder))
            except OSError:
                continue
            for e in entries:
                budget[0] -= 1
                if budget[0] <= 0:
                    break
                try:
                    if e.is_dir(follow_symlinks=False):
                        if level < depth and not e.name.startswith("."):
                            queue.append((e.path, level + 1))
                        continue
                    if not e.is_file():
                        continue
                except OSError:
                    continue
                low = e.name.casefold()
                if low != want and not (os.path.splitext(low)[0] == stem and is_audio(low)):
                    continue
                key = os.path.normcase(os.path.realpath(e.path))
                if key in seen:
                    continue
                seen.add(key)
                (exact if low == want else near).append(e.path)
    return (exact + near)[:MAX_CANDIDATES]


def describe(path, remembered=False):
    st = os.stat(path)
    return {"path": path, "name": os.path.basename(path), "folder": os.path.dirname(path),
            "size": int(st.st_size), "modified": int(st.st_mtime), "remembered": bool(remembered)}


class MediaMemory:
    """`media-map.json` in the shell's own data folder: for each missing link the user resolved, the
    file they chose; and the folders recordings were found in, most recent first. Local to this
    machine — it holds this machine's paths and never leaves it. A damaged file is set aside as
    `.bad` and the shell carries on with an empty memory rather than failing to start."""

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._data = self._load()

    def _load(self):
        empty = {"version": 1, "links": {}, "folders": []}
        if not self.path or not os.path.isfile(self.path):
            return empty
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                d = json.load(f)
            if not isinstance(d, dict) or not isinstance(d.get("links"), dict) or not isinstance(d.get("folders"), list):
                raise ValueError("not a media map")
            return {"version": 1, "links": d["links"], "folders": [x for x in d["folders"] if isinstance(x, str)]}
        except (OSError, ValueError):
            try:
                os.replace(self.path, self.path + ".bad")
            except OSError:
                pass
            return empty

    def _save(self):
        if not self.path:
            return
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=1)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def lookup(self, uri, project=None):
        """The file chosen before for this link, while it still exists; else None."""
        if not uri:
            return None
        with self._lock:
            hit = self._data["links"].get(link_key(uri, project))
        p = hit.get("path") if isinstance(hit, dict) else None
        return p if p and os.path.isfile(p) else None

    def folders(self):
        with self._lock:
            return [f for f in self._data["folders"] if os.path.isdir(f)]

    def remember(self, uri, path, project=None):
        folder = os.path.dirname(os.path.abspath(path))
        with self._lock:
            if uri:
                self._data["links"][link_key(uri, project)] = {"path": os.path.abspath(path), "at": int(time.time())}
            keep = [f for f in self._data["folders"] if os.path.normcase(f) != os.path.normcase(folder)]
            self._data["folders"] = ([folder] + keep)[:MAX_FOLDERS]
            self._save()
