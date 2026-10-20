"""fxdiag — console entry point.

  fxdiag                         the window (needs the [gui] extra); falls back to `scan`
  fxdiag scan [--user-data-dir P]... [--all-users]
  fxdiag report [--out report.zip] [--store SLUG]... [--texts all|id,id] [--with-audio]
                [--redact-titles] [--note TEXT] [--user-data-dir P]... [--all-users]
"""

import argparse
import datetime as _dt
import json
import sys
from pathlib import Path

from . import VERSION, profiles, report


def _common(p):
    p.add_argument("--user-data-dir", action="append", default=[], metavar="PATH",
                   help="a browser User Data folder, an Electron userData folder or the FLEx shell's webview folder (repeatable); the OS's known places are always scanned too")
    p.add_argument("--all-users", action="store_true", help="also look under every user account's folder (permission permitting)")


def cmd_scan(args):
    stores = profiles.discover(args.user_data_dir, all_users=args.all_users)
    if args.json:
        print(json.dumps([s.to_dict() for s in stores], indent=1, default=str))
        return 0
    if not stores:
        print("no browser profile with FlexText storage found (pass --user-data-dir to point at one)")
        return 1
    for s in stores:
        print("%s — profile %r [%s]  (%s)" % (s.app, s.profile_name, s.slug, s.profile_dir))
        for o in s.origins:
            print("    %s  %s%s" % (o.origin, o.app_hint, "" if o.blob else "  (no blob folder)"))
        if s.web_apps:
            print("    installed web apps: %s" % json.dumps(s.web_apps, default=str)[:200])
    return 0


def _parse_texts(s):
    if not s or s == "none":
        return "none"
    if s == "all":
        return "all"
    return [t.strip() for t in s.split(",") if t.strip()]


def cmd_report(args):
    stores = profiles.discover(args.user_data_dir, all_users=args.all_users)
    if args.store:
        stores = [s for s in stores if s.slug in args.store]
    if not stores:
        print("nothing to report on (run `fxdiag scan`)")
        return 1
    out = Path(args.out) if args.out else Path.cwd() / ("fxdiag-%s.zip" % _dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    summary = report.build(stores, out, texts=_parse_texts(args.texts), with_audio=args.with_audio,
                           redact_titles=args.redact_titles, note=args.note or "")
    print(report.readme(summary))
    print("written: %s" % out)
    return 0


def cmd_gui(args):
    try:
        from . import gui
    except ImportError as e:
        print("the window needs pywebview: pip install \"flextext-fxdiag[gui]\" (%s)" % e)
        return 2
    return gui.run(args.user_data_dir, all_users=args.all_users)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="fxdiag", description="FlexText suite: read a device's browser storage from disk into one diagnostic report (v%s)" % VERSION)
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("scan", help="list the profiles and suite origins on this disk")
    _common(s)
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_scan)
    r = sub.add_parser("report", help="write the report zip")
    _common(r)
    r.add_argument("--out", metavar="FILE.zip")
    r.add_argument("--store", action="append", default=[], metavar="SLUG", help="only these stores (slugs from `scan`)")
    r.add_argument("--texts", default="none", metavar="all|ID,ID", help="include full text records (they are the language data): all, or a list of ids; default none")
    r.add_argument("--with-audio", action="store_true", help="also include the recordings of the included texts")
    r.add_argument("--redact-titles", action="store_true", help="replace titles in the manifest with a hash")
    r.add_argument("--note", help="a line from you, kept in the report")
    r.set_defaults(fn=cmd_report)
    g = sub.add_parser("gui", help="open the window")
    _common(g)
    g.set_defaults(fn=cmd_gui)
    args = ap.parse_args(argv)
    if not args.cmd:
        args.user_data_dir, args.all_users = [], False
        try:
            import webview  # noqa: F401
        except ImportError:
            args.json = False
            return cmd_scan(args)
        return cmd_gui(args)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
