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
        if self._maybe_offline():
            return
        # Byte-range support (Range: bytes=N-[M]) plus a "?slow" query that
        # throttles to ~64 KB / 200 ms — lets us test the app's resumable,
        # pausable download UI against realistic slow connections.
        import os, re, time, urllib.parse
        slow = 'slow' in urllib.parse.urlparse(self.path).query
        rng = self.headers.get('Range')
        path = self.translate_path(self.path)
        if (rng or slow) and os.path.isfile(path):
            size = os.path.getsize(path)
            start, end = 0, size - 1
            status = 200
            m = re.match(r'bytes=(\d+)-(\d*)$', rng or '')
            if m:
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
                if start >= size:
                    self.send_error(416, 'Range not satisfiable')
                    return
                status = 206
            length = end - start + 1
            self.send_response(status)
            self.send_header('Content-Type', self.guess_type(path))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(length))
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    remaining -= len(chunk)
                    if slow:
                        time.sleep(0.2)
            return
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
    parser.add_argument('--cert', help='TLS certificate (PEM) — serve HTTPS (e.g. an mkcert cert)')
    parser.add_argument('--key', help='TLS private key (PEM) — serve HTTPS')
    args = parser.parse_args()
    Handler.offline = args.offline

    with Server((args.bind, args.port), Handler) as httpd:
        scheme = 'http'
        if args.cert and args.key:
            # HTTPS so LAN clients (Android AVD, Parallels VM) get a secure
            # context — geolocation and service workers require one. Pair with an
            # mkcert cert + the mkcert root CA installed on each client to be trusted.
            import ssl
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(args.cert, args.key)
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
            scheme = 'https'
        mode = 'OFFLINE SIMULATION' if args.offline else 'online'
        print(f'FlexText dev server ({mode}) → {scheme}://{args.bind}:{args.port}/')
        if not args.offline:
            print(f'Service-worker test URL    → {scheme}://{args.bind}:{args.port}/?sw=1')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopped.')


if __name__ == '__main__':
    main()
