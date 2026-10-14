#!/usr/bin/env python3
"""Run the contract tests against lcm_real on a DISPOSABLE COPY (plan §13.2, handoff §7.1).

  python desktop/vm/run_conformance.py --project "C:\\ProgramData\\SIL\\FieldWorks\\Projects\\<copy>"

Refuses unless the folder carries flextext-disposable-copy.txt and the cache's project name, the
.fwdata file name and the folder name all agree. Takes a restore-point copy of the .fwdata first and
diffs it at the end. Any mismatch with the mock is a bug in the mock or in lcm_real — fix, re-run.
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(HERE)
sys.path.insert(0, DESKTOP)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", required=True, help="the disposable copy's folder")
    ap.add_argument("--keep-going", action="store_true")
    a = ap.parse_args()
    from flexshell import copyonly
    folder = os.path.abspath(a.project.rstrip("\\/"))
    name = os.path.basename(folder)
    fw = os.path.join(folder, name + ".fwdata")
    if not copyonly.project_is_disposable_copy(folder, name):
        sys.exit("REFUSED: %s is not a marked disposable copy (no %s)" % (folder, copyonly.MARKER_FILE))
    if not os.path.isfile(fw):
        sys.exit("REFUSED: %s has no %s.fwdata (folder and file names must agree)" % (folder, name))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    restore = os.path.join(folder, "%s.restore-point-%s.fwdata.bak" % (name, stamp))
    shutil.copy2(fw, restore)
    before = sha(fw)
    print("restore point:", restore)
    print("versions:", _versions())
    env = dict(os.environ, FLEXSHELL_BACKEND="real", FLEXSHELL_PROJECT=folder)
    cmd = [sys.executable, "-m", "pytest", os.path.join(DESKTOP, "tests", "contract"), "-v", "-p", "no:cacheprovider"]
    if not a.keep_going:
        cmd.append("-x")
    rc = subprocess.call(cmd, env=env)
    after = sha(fw)
    print("\n.fwdata before: %s\n.fwdata after:  %s\n%s" % (before, after, "UNCHANGED" if before == after else "CHANGED (expected: the tests write and undo; diff against the restore point)"))
    if rc == 0:
        print("\nCONFORMANCE PASSED on", name, "— lcm_real agrees with the mock on every contract test.")
    else:
        print("\nCONFORMANCE FAILED (exit %d): fix the mock or lcm_real and re-run." % rc)
    sys.exit(rc)


def _versions():
    try:
        from flexshell.lcm_real import RealBackendFactory
        return RealBackendFactory().install_info()
    except Exception as e:   # noqa: BLE001
        return {"error": str(e)}


if __name__ == "__main__":
    main()
