#!/usr/bin/env python3
"""Development server for FlexText Interlinear.

Plain static serving with two service-worker-friendly behaviors:
  * Cache-Control: no-cache on everything, so edited files show up on reload
    (the service worker is skipped on localhost anyway unless you add ?sw=1).
  * Correct MIME types for .webmanifest / .js / .flextext.

Offline testing
---------------
1. Run:  python3 dev_server.py
2. Open  http://localhost:8765/?sw=1  (the ?sw=1 enables the service worker
   on localhost) and let it load once while "online".
3. Restart the server with:  python3 dev_server.py --offline
   Every request now fails with 503, exactly like a dead connection —
   reload the page and the app should keep working from the service-worker
   cache. (Stopping the server entirely tests the same thing, but then the
   browser shows its own connection-refused page if the SW is missing.)

Afterwards, to go back to normal development, unregister the service worker:
DevTools → Application → Service workers → Unregister (or use a fresh
private window for ?sw=1 testing).
"""

import argparse
import http.server
import pathlib
import socketserver

ROOT = pathlib.Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.webmanifest': 'application/manifest+json',
        '.flextext': 'application/xml',
    }
    offline = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _maybe_offline(self) -> bool:
        if Handler.offline:
            self.send_error(503, 'Offline simulation (dev_server.py --offline)')
            return True
        return False

    def do_GET(self):
        if not self._maybe_offline():
            super().do_GET()

    def do_HEAD(self):
        if not self._maybe_offline():
            super().do_HEAD()

    def log_message(self, fmt, *args):
        prefix = 'OFFLINE ' if Handler.offline else ''
        super().log_message(prefix + fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    # Must be a class attribute: it is consulted while binding, so quick
    # online → --offline restarts don't fail with "Address already in use".
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--offline', action='store_true',
                        help='answer every request with 503 to simulate no connection')
    args = parser.parse_args()
    Handler.offline = args.offline

    with Server((args.bind, args.port), Handler) as httpd:
        mode = 'OFFLINE SIMULATION' if args.offline else 'online'
        print(f'FlexText dev server ({mode}) → http://{args.bind}:{args.port}/')
        if not args.offline:
            print(f'Service-worker test URL    → http://{args.bind}:{args.port}/?sw=1')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopped.')


if __name__ == '__main__':
    main()
