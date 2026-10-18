"""Stable error codes (plan §3). The engine maps each code to a translated message; the `message`
here is for logs and for the one case where the engine has no string yet. `detail` is free-form and
never carries a text title or any vernacular text — the UI, not the log, shows those."""

CODES = (
    "E_NOT_SHELL", "E_CONTRACT", "E_BUSY", "E_NOT_FOUND", "E_ALREADY_OPEN",
    "E_FLEX_HOLDS_PROJECT", "E_LOCKED_OTHER", "E_LOCK_BUSY", "E_SHARING_ON", "E_PEERS_CONNECTED",
    "E_MODEL_NEWER", "E_MODEL_OLDER", "E_CRASHED_SAVE_STATE", "E_NOT_LOCAL_DISK", "E_CLOUD_FOLDER",
    "E_READONLY_FILE", "E_DISK_SPACE", "E_COPY_ONLY",
    "E_STALE_BASE", "E_FRAGILE_PARAGRAPH", "E_CHART_REFS", "E_EMPTY_PHRASE", "E_SCOPE", "E_PREVIEW_EXPIRED",
    "E_BACKUP_FAILED", "E_INVARIANT", "E_ROLLBACK_INCOMPLETE", "E_SAVE_FAILED", "E_DISK_CHECK_FAILED",
    "E_POISONED", "E_MEDIA_PRESENT", "E_MEDIA_FILE_MISSING", "E_MEDIA_NOT_AUDIO", "E_IMPORT_INVALID", "E_INTERNAL",
    "E_WS_WORDS", "E_NEEDS_CONFIRM", "E_NO_SNAPSHOT", "E_RECOVER_SENT_RECEIVED",
)

# These poison the session (plan §3, §5.6): every later call but close_project answers E_POISONED.
POISONING = frozenset({"E_ROLLBACK_INCOMPLETE", "E_SAVE_FAILED", "E_DISK_CHECK_FAILED"})


class FlexError(Exception):
    """An error the dispatcher turns into {ok: false, error: {code, message, detail}}."""

    def __init__(self, code, message="", detail=None):
        if code not in CODES:
            raise ValueError("unknown error code " + repr(code))
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.detail = detail

    def to_dict(self):
        d = {"code": self.code, "message": self.message}
        if self.detail is not None:
            d["detail"] = self.detail
        return d
