"""Locate the FieldWorks install, projects folder and versions (plan §12.1) — Windows registry,
imported lazily. On other platforms every function answers None/{}."""
import os
import sys


def registry_values():
    if sys.platform != "win32":
        return {}
    import winreg   # type: ignore[import-not-found]
    out = {}
    for hive, path in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\SIL\FieldWorks\9"),
                       (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\SIL\FieldWorks\9"),
                       (winreg.HKEY_CURRENT_USER, r"SOFTWARE\SIL\FieldWorks\9")):
        try:
            with winreg.OpenKey(hive, path) as k:
                for name in ("RootCodeDir", "ProjectsDir", "RootDataDir"):
                    try:
                        out.setdefault(name, winreg.QueryValueEx(k, name)[0])
                    except OSError:
                        pass
        except OSError:
            continue
    return out


def code_dir():
    return registry_values().get("RootCodeDir")


def flexbridge_dir():
    """FLEx Bridge's install folder — FLEx 9's Send/Receive, which ships the Mercurial it runs on the project's
    store in `<InstallationDir>\\mercurial\\hg.exe` (seen on the VM, 2026-10-21: FLEx Bridge 4.3, 32-bit, under
    `SOFTWARE\\WOW6432Node\\SIL\\FLEx Bridge\\9`). None when it is not installed or off Windows."""
    if sys.platform != "win32":
        return None
    import winreg   # type: ignore[import-not-found]
    for hive, path in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\SIL\FLEx Bridge\9"),
                       (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\SIL\FLEx Bridge\9"),
                       (winreg.HKEY_CURRENT_USER, r"SOFTWARE\SIL\FLEx Bridge\9")):
        try:
            with winreg.OpenKey(hive, path) as k:
                v = winreg.QueryValueEx(k, "InstallationDir")[0]
                if v:
                    return v
        except OSError:
            continue
    return None


def projects_dir():
    v = registry_values().get("ProjectsDir")
    if v:
        return v
    pd = os.environ.get("ProgramData")
    return os.path.join(pd, "SIL", "FieldWorks", "Projects") if pd else None


def fw_version(code=None):
    """FieldWorks.exe's product version, via the .NET assembly loader when available."""
    code = code or code_dir()
    if not code:
        return None
    exe = os.path.join(code, "FieldWorks.exe")
    if not os.path.isfile(exe):
        return None
    try:
        import clr   # type: ignore[import-not-found]  # noqa: F401
        from System.Diagnostics import FileVersionInfo   # type: ignore[import-not-found]
        return FileVersionInfo.GetVersionInfo(exe).ProductVersion
    except Exception:   # noqa: BLE001
        return None


def webview2_installed():
    """The Evergreen runtime's registry key (either hive). [unverified] on the VM."""
    if sys.platform != "win32":
        return None
    import winreg   # type: ignore[import-not-found]
    for hive, path in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                       (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")):
        try:
            with winreg.OpenKey(hive, path) as k:
                return winreg.QueryValueEx(k, "pv")[0]
        except OSError:
            continue
    return False
