#!/usr/bin/env python3
"""
YOLO Viewer — live MJPEG browser viewer for annotated detection frames.

Subscribes to bsole/yolo/annotated (published by runner.py when
YOLO_PUBLISH_ANNOTATED=1), decodes base64 JPEG frames, and serves
them as an MJPEG stream at http://localhost:<PORT>.

Usage:
    python3 yolo/view.py
    npm run yolo:view

    Then open http://localhost:8080 in a browser.

Environment variables:
    YOLO_VIEW_PORT      HTTP port to serve on (default: 8080)
    YOLO_ANNOTATED_PUB_KEY  Zenoh key to subscribe to (default: bsole/yolo/annotated)
    ZENOH_ROUTER        Router endpoint override
"""

import os
import sys
import json
import base64
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


def _load_ini(path: Path) -> None:
    try:
        in_env = False
        for line in path.read_text().splitlines():
            line = line.strip()
            if line.startswith("["):
                in_env = line.lower() == "[env]"
                continue
            if not in_env or not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip()
                if key and key not in os.environ:
                    os.environ[key] = val
    except OSError:
        pass


_load_ini(Path(__file__).resolve().parent.parent / "config" / "yolo.ini")

try:
    import zenoh
except ImportError:
    print("[yolo-view] zenoh not installed — run: npm run yolo:setup", file=sys.stderr)
    sys.exit(1)

PORT       = int(os.environ.get("YOLO_VIEW_PORT", "8080"))
SUB_KEY    = os.environ.get("YOLO_ANNOTATED_PUB_KEY", "bsole/yolo/annotated")
ROUTER     = os.environ.get("ZENOH_ROUTER", "")

CONFIG_FILE = Path(__file__).resolve().parent.parent / "config" / "peer.json5"

_BOUNDARY = b"frame"
_latest_frame: bytes = b""
_frame_lock = threading.Lock()
_frame_event = threading.Event()


def _set_frame(jpeg_bytes: bytes) -> None:
    global _latest_frame
    with _frame_lock:
        _latest_frame = jpeg_bytes
    _frame_event.set()
    _frame_event.clear()


def _get_frame() -> bytes:
    with _frame_lock:
        return _latest_frame


_HTML = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>YOLO Annotated View</title>
  <style>
    body { margin: 0; background: #111; display: flex; align-items: center; justify-content: center; height: 100vh; }
    img  { max-width: 100%; max-height: 100vh; image-rendering: pixelated; }
    #msg { color: #888; font-family: monospace; font-size: 14px; }
  </style>
</head>
<body>
  <img id="feed" src="/stream" onerror="document.getElementById('feed').style.display='none';document.getElementById('msg').style.display='block'">
  <p id="msg" style="display:none">Waiting for annotated frames — make sure YOLO_PUBLISH_ANNOTATED=1 is set.</p>
</body>
</html>
""".encode("utf-8")


class MjpegHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # suppress access logs

    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(_HTML)))
            self.end_headers()
            self.wfile.write(_HTML)

        elif self.path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={_BOUNDARY.decode()}")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                while True:
                    frame = _get_frame()
                    if frame:
                        chunk = (
                            b"--" + _BOUNDARY + b"\r\n"
                            b"Content-Type: image/jpeg\r\n"
                            b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n" +
                            frame + b"\r\n"
                        )
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    _frame_event.wait(timeout=1.0)
            except (BrokenPipeError, ConnectionResetError):
                pass

        else:
            self.send_response(404)
            self.end_headers()


def _start_http(port: int) -> None:
    server = HTTPServer(("0.0.0.0", port), MjpegHandler)
    server.daemon_threads = True
    server.serve_forever()


def main() -> None:
    if not CONFIG_FILE.exists():
        print(f"[yolo-view] peer config not found: {CONFIG_FILE}", file=sys.stderr)
        sys.exit(1)

    conf = zenoh.Config.from_file(str(CONFIG_FILE))
    if ROUTER:
        conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')

    session = zenoh.open(conf)

    def on_message(sample) -> None:
        try:
            payload = json.loads(bytes(sample.payload).decode("utf-8"))
            jpeg_bytes = base64.b64decode(payload["data"])
            _set_frame(jpeg_bytes)
        except Exception:
            pass

    session.declare_subscriber(SUB_KEY, on_message)

    http_thread = threading.Thread(target=_start_http, args=(PORT,), daemon=True)
    http_thread.start()

    print(f"[yolo-view] subscribed  '{SUB_KEY}'", flush=True)
    print(f"[yolo-view] viewer at   http://localhost:{PORT}", flush=True)
    print("[yolo-view] press Ctrl+C to stop\n", flush=True)

    signal.signal(signal.SIGINT,  lambda *_: os._exit(0))
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))

    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
