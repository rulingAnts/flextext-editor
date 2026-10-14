"""Copy-only dev builds (plan §12.3). Until Seth signs off on the VM results, every build refuses
write mode unless the project folder carries the disposable-copy marker — and the flag is read the
way electron/src/flags.js reads its DevTools flag: anything but an explicit release stamp means
copy-only. Fail closed."""

import json
import os

MARKER_FILE = "flextext-disposable-copy.txt"
STAMP_FILE = "release-stamp.json"
# Names a copy may never carry: a project with one of these names is treated as production even
# with a marker file beside it (someone copied the marker, not the project).
PROTECTED_NAMES = frozenset()   # filled per deployment from settings; the default protects nothing by name


def is_copy_only(stamp_dir=None):
    """True unless `<stamp_dir>/release-stamp.json` holds exactly {"copyOnlyLifted": true}."""
    if not stamp_dir:
        return True
    p = os.path.join(stamp_dir, STAMP_FILE)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return True
    return not (isinstance(data, dict) and data.get("copyOnlyLifted") is True and len(data) == 1)


def project_is_disposable_copy(project_dir, project_name=None, protected=PROTECTED_NAMES):
    if project_name and project_name in protected:
        return False
    try:
        return os.path.isfile(os.path.join(project_dir, MARKER_FILE))
    except OSError:
        return False


def check_write_allowed(project_dir, project_name, copy_only):
    """Raises FlexError('E_COPY_ONLY') when a copy-only build is asked to write to a project that is
    not a marked disposable copy."""
    from .errors import FlexError
    if copy_only and not project_is_disposable_copy(project_dir, project_name):
        raise FlexError("E_COPY_ONLY",
                        "This build writes only to a disposable copy. Make one with FLEx closed (copy "
                        "the project folder, rename the .fwdata to match, add %s) and open that." % MARKER_FILE,
                        {"marker": MARKER_FILE})
