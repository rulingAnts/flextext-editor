"""Find the places on this disk where a FlexText app may have left storage.

Four layouts, one shape of result:
  chromium   <User Data>/<Default|Profile N>/{IndexedDB, Local Storage/leveldb, Preferences}
  flat       Electron's userData: {IndexedDB, Local Storage/leveldb} at the root (the Flextext Desktop shell)
  webview2   pywebview's storage_path for the FLEx shell: <path>/EBWebView/<Default>/… (chromium inside)
  gecko      Firefox and relatives: <profile>/storage/default/<scheme+++host>/{idb/*.sqlite, ls/data.sqlite}
             (gecko.py; profiles from profiles.ini) — [unverified] on a real profile, see gecko.py

Everything here is file-system reading of names and small JSON files; the LevelDB folders are only
LOCATED, never opened (reader.py does that, on a copy). Paths can be given explicitly
(`--user-data-dir`) — a thumb drive plugged into someone else's machine, a copied profile folder.
"""

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import gecko, suite


@dataclass
class OriginStorage:
    origin: str              # 'https://app.flextext.app'
    host: str
    leveldb: Path            # chromium: the .indexeddb.leveldb folder; gecko: the origin folder (idb/ + ls/ inside)
    blob: Path | None        # chromium: the .indexeddb.blob folder beside it, if any; gecko: None
    app_hint: str = ""
    kind: str = "chromium"   # chromium | gecko — which reader decodes it


@dataclass
class ProfileStore:
    app: str                 # 'Google Chrome', 'Microsoft Edge', 'Flextext Desktop', 'FlexText Segmenter for FLEx', …
    layout: str              # chromium | flat | webview2
    user_data_dir: Path
    profile_dir: Path
    profile_name: str
    origins: list = field(default_factory=list)       # [OriginStorage]
    local_storage: Path | None = None                # the Local Storage/leveldb folder
    web_apps: list = field(default_factory=list)      # installed-PWA hints (best effort)
    notes: list = field(default_factory=list)

    @property
    def slug(self):
        s = "%s-%s" % (self.app, self.profile_name)
        return "".join(c if c.isalnum() or c in "-_." else "-" for c in s).strip("-")[:60]

    def to_dict(self):
        return {
            "app": self.app, "layout": self.layout, "userDataDir": str(self.user_data_dir), "profileDir": str(self.profile_dir),
            "profileName": self.profile_name, "slug": self.slug,
            "origins": [{"origin": o.origin, "host": o.host, "appHint": o.app_hint, "hasBlobs": o.blob is not None, "kind": o.kind} for o in self.origins],
            "localStorage": str(self.local_storage) if self.local_storage else None,
            "installedWebApps": self.web_apps, "notes": self.notes,
        }


def _home():
    return Path(os.path.expanduser("~"))


def candidate_user_data_dirs(home=None, platform=None, all_users=False):
    """[(app, path, layout)] — where each known app keeps its browser storage on this OS. Only the
    paths that exist are returned. all_users: every account's folder (Windows C:\\Users\\*, Mac /Users/*,
    Linux /home/*), for a thumb drive run on a shared machine; permission decides what is readable."""
    platform = platform or sys.platform
    homes = [Path(home)] if home else [_home()]
    if all_users and not home:
        roots = {"win32": [Path(os.environ.get("SystemDrive", "C:") + "\\Users")], "darwin": [Path("/Users")]}.get(platform, [Path("/home")])
        for r in roots:
            if r.is_dir():
                homes = sorted({p for p in r.iterdir() if p.is_dir() and not p.name.lower() in ("public", "default", "default user", "all users", "shared")} | set(homes))
    out = []
    for h in homes:
        if platform == "win32":
            la = Path(os.environ.get("LOCALAPPDATA") or (h / "AppData" / "Local")) if h == _home() else h / "AppData" / "Local"
            ra = Path(os.environ.get("APPDATA") or (h / "AppData" / "Roaming")) if h == _home() else h / "AppData" / "Roaming"
            cands = [
                ("Google Chrome", la / "Google" / "Chrome" / "User Data", "chromium"),
                ("Google Chrome Beta", la / "Google" / "Chrome Beta" / "User Data", "chromium"),
                ("Microsoft Edge", la / "Microsoft" / "Edge" / "User Data", "chromium"),
                ("Brave", la / "BraveSoftware" / "Brave-Browser" / "User Data", "chromium"),
                ("Chromium", la / "Chromium" / "User Data", "chromium"),
                ("Vivaldi", la / "Vivaldi" / "User Data", "chromium"),
                ("Flextext Desktop", ra / "flextext-desktop", "flat"),
                ("Flextext Desktop", ra / "Flextext Desktop", "flat"),
                ("FlexText Segmenter for FLEx", la / "FlexTextSegmenterFLEx" / "webview", "webview2"),
            ]
        elif platform == "darwin":
            asup = h / "Library" / "Application Support"
            cands = [
                ("Google Chrome", asup / "Google" / "Chrome", "chromium"),
                ("Microsoft Edge", asup / "Microsoft Edge", "chromium"),
                ("Brave", asup / "BraveSoftware" / "Brave-Browser", "chromium"),
                ("Chromium", asup / "Chromium", "chromium"),
                ("Vivaldi", asup / "Vivaldi", "chromium"),
                ("Flextext Desktop", asup / "flextext-desktop", "flat"),
                ("Flextext Desktop", asup / "Flextext Desktop", "flat"),
            ]
        else:
            cfg = h / ".config"
            cands = [
                ("Google Chrome", cfg / "google-chrome", "chromium"),
                ("Microsoft Edge", cfg / "microsoft-edge", "chromium"),
                ("Brave", cfg / "BraveSoftware" / "Brave-Browser", "chromium"),
                ("Chromium", cfg / "chromium", "chromium"),
                ("Chromium (snap)", h / "snap" / "chromium" / "common" / "chromium", "chromium"),
                ("Vivaldi", cfg / "vivaldi", "chromium"),
                ("Flextext Desktop", cfg / "flextext-desktop", "flat"),
                ("Flextext Desktop", cfg / "Flextext Desktop", "flat"),
            ]
        out.extend((app, p, layout) for app, p, layout in cands if p.is_dir())
        out.extend((app, p, "gecko") for app, p in gecko.candidate_roots(h, platform))
    return out


def guess_layout(path):
    """For an explicit --user-data-dir: which of the three shapes is this folder?"""
    path = Path(path)
    if (path / "EBWebView").is_dir():
        return "webview2"
    if (path / "profiles.ini").is_file() or (path / "storage" / "default").is_dir():
        return "gecko"
    if (path / "IndexedDB").is_dir() or (path / "Local Storage").is_dir():
        return "chromium" if (path / "Preferences").is_file() and (path.parent / "Local State").is_file() else "flat"
    return "chromium"


def _profile_dirs(user_data_dir):
    """Chromium: the profiles `Local State` names, else every folder holding a Preferences file."""
    user_data_dir = Path(user_data_dir)
    names = {}
    ls = user_data_dir / "Local State"
    try:
        info = json.loads(ls.read_text(encoding="utf-8")).get("profile", {}).get("info_cache", {})
        for k, v in info.items():
            names[k] = (v.get("name") or v.get("gaia_name") or k) if isinstance(v, dict) else k
    except (OSError, ValueError, AttributeError):
        pass
    found = []
    for d in sorted(user_data_dir.iterdir()) if user_data_dir.is_dir() else []:
        if d.is_dir() and ((d / "Preferences").is_file() or (d / "IndexedDB").is_dir()) and (d.name == "Default" or d.name.startswith("Profile") or d.name in names):
            found.append((d, names.get(d.name)))
    return found


def _profile_name(profile_dir, fallback):
    try:
        prefs = json.loads((Path(profile_dir) / "Preferences").read_text(encoding="utf-8"))
        return prefs.get("profile", {}).get("name") or fallback or Path(profile_dir).name
    except (OSError, ValueError, AttributeError):
        return fallback or Path(profile_dir).name


def installed_web_apps(profile_dir):
    """Best effort: Chromium keeps installed web apps in Preferences under `web_apps` and in
    `Web Applications/`. We report the SUITE's entries (start_url / scope on a suite host) and only a
    COUNT of the others — this tool reads the FlexText suite's storage, not the browser's — plus
    whether the Web Applications folder exists. Enough to say "an app of ours is installed here"."""
    out = []
    profile_dir = Path(profile_dir)
    try:
        prefs = json.loads((profile_dir / "Preferences").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prefs = {}

    def walk(node, depth=0):
        if depth > 6:
            return
        if isinstance(node, dict):
            if any(k in node for k in ("start_url", "scope", "launch_url")) or ("name" in node and "install_time" in node):
                hit = {k: node[k] for k in ("name", "start_url", "scope", "launch_url", "install_time", "manifest_id") if k in node and isinstance(node[k], (str, int))}
                url = hit.get("start_url") or hit.get("scope") or hit.get("launch_url") or ""
                hit["suite"] = suite.is_suite_host(url.split("/")[2]) if "://" in url else False
                out.append(hit)
                return
            for v in node.values():
                walk(v, depth + 1)
        elif isinstance(node, list):
            for v in node:
                walk(v, depth + 1)
    walk(prefs.get("web_apps") or {})
    others = len([h for h in out if not h.get("suite")])
    out = [h for h in out if h.get("suite")]
    if others:
        out.append({"otherInstalledWebApps": others})
    wa = profile_dir / "Web Applications"
    if wa.is_dir():
        out.append({"webApplicationsFolder": True})
    return out


def scan_profile_dir(profile_dir, app, layout, user_data_dir, fallback_name=None):
    profile_dir = Path(profile_dir)
    store = ProfileStore(app=app, layout=layout, user_data_dir=Path(user_data_dir), profile_dir=profile_dir,
                         profile_name=(fallback_name or profile_dir.name) if layout == "gecko" else _profile_name(profile_dir, fallback_name) if layout != "flat" else app)
    if layout == "gecko":
        for origin, host, d in gecko.suite_origins(profile_dir):
            store.origins.append(OriginStorage(origin=origin, host=host, leveldb=d, blob=None, app_hint=suite.app_hint(host), kind="gecko"))
        store.local_storage = None      # per origin in gecko (inside each origin folder), plus the legacy file
        store.notes.append("gecko profile: Firefox-family storage, read with moz-idb-edit's codecs — unverified on a real profile until the first run says otherwise")
        return store
    idb = profile_dir / "IndexedDB"
    if idb.is_dir():
        for d in sorted(idb.iterdir()):
            parsed = suite.parse_idb_folder(d.name)
            if not parsed or not d.name.endswith(".leveldb"):
                continue
            scheme, host, port = parsed
            if not suite.is_suite_host(host):
                continue
            blob = idb / d.name.replace(".leveldb", ".blob")
            store.origins.append(OriginStorage(origin=suite.origin_url(scheme, host, port), host=host, leveldb=d,
                                               blob=blob if blob.is_dir() else None, app_hint=suite.app_hint(host)))
    lsdir = profile_dir / "Local Storage" / "leveldb"
    store.local_storage = lsdir if lsdir.is_dir() else None
    if layout != "flat":
        store.web_apps = installed_web_apps(profile_dir)
    return store


def discover(user_data_dirs=None, all_users=False, home=None, platform=None):
    """[ProfileStore] for every profile that holds storage from a suite origin (or any profile of an
    explicitly given folder). Explicit folders first, then this OS's known places."""
    todo = []
    for p in user_data_dirs or []:
        p = Path(p)
        todo.append((p.name, p, guess_layout(p)))
    todo.extend(candidate_user_data_dirs(home=home, platform=platform, all_users=all_users))
    out, seen = [], set()
    for app, path, layout in todo:
        root = path / "EBWebView" if layout == "webview2" else path
        if layout == "flat":
            profiles = [(root, app)]
        elif layout == "gecko":
            profiles = gecko.profiles_in(root) if not (root / "storage" / "default").is_dir() else [(root, root.name)]
        else:
            profiles = _profile_dirs(root)
        for pdir, name in profiles:
            key = str(pdir.resolve())
            if key in seen:
                continue
            seen.add(key)
            store = scan_profile_dir(pdir, app, layout, path, fallback_name=name)
            if store.origins or user_data_dirs and path in (Path(u) for u in user_data_dirs):
                out.append(store)
    return out
