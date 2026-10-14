"""CF_UNICODETEXT only (plan §10): FLEx's Print view puts a private TsString and CF_UNICODETEXT;
the shell writes the plain text alone. No-op off Windows (returns False)."""
import sys


def copy_text(text):
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32   # type: ignore[attr-defined]
    data = (text or "").encode("utf-16-le") + b"\x00\x00"
    if not u32.OpenClipboard(None):
        return False
    try:
        u32.EmptyClipboard()
        h = k32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            return False
        p = k32.GlobalLock(h)
        ctypes.memmove(p, data, len(data))
        k32.GlobalUnlock(h)
        return bool(u32.SetClipboardData(CF_UNICODETEXT, h))
    finally:
        u32.CloseClipboard()
