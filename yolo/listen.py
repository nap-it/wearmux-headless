#!/usr/bin/env python3
"""
YOLO Listener — prints detection payloads from bsole/yolo/detections.

Usage:
    python3 yolo/listen.py
    npm run yolo:listen

Environment variables:
    YOLO_PUB_KEY    Key to subscribe to (default: bsole/yolo/detections)
    ZENOH_ROUTER    Router endpoint override (e.g. tcp/192.168.1.10:7447)
"""

import os
import sys
import json
import signal
import time
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
    print("[yolo-listen] zenoh not installed — run: npm run yolo:setup", file=sys.stderr)
    sys.exit(1)

SUB_KEY = os.environ.get("YOLO_PUB_KEY", "bsole/yolo/detections")
ROUTER  = os.environ.get("ZENOH_ROUTER", "")
VERBOSE = os.environ.get("YOLO_LISTEN_VERBOSE", "0") == "1"

CONFIG_FILE = Path(__file__).resolve().parent.parent / "config" / "peer.json5"


def fmt_detection(d: dict) -> str:
    return f"{d['class']} {d['confidence']:.2f} [{d['x1']:.0f},{d['y1']:.0f} {d['x2']:.0f},{d['y2']:.0f}]"


def on_message(sample) -> None:
    try:
        payload = json.loads(bytes(sample.payload).decode("utf-8"))
    except Exception:
        return

    detections = payload.get("detections", [])
    inference_ms = payload.get("inference_ms", 0)

    if VERBOSE or detections:
        det_str = ", ".join(fmt_detection(d) for d in detections) or "—"
        print(f"[{inference_ms:.0f}ms] {det_str}")

    if VERBOSE and not detections:
        return

    for d in detections:
        print(json.dumps(d) if VERBOSE else fmt_detection(d))


def main() -> None:
    if not CONFIG_FILE.exists():
        print(f"[yolo-listen] peer config not found: {CONFIG_FILE}", file=sys.stderr)
        sys.exit(1)

    conf = zenoh.Config.from_file(str(CONFIG_FILE))
    if ROUTER:
        conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')

    session = zenoh.open(conf)
    session.declare_subscriber(SUB_KEY, on_message)

    print(f"[yolo-listen] subscribed '{SUB_KEY}'")
    print("[yolo-listen] waiting for detections... press Ctrl+C to stop\n")

    signal.signal(signal.SIGINT,  lambda *_: os._exit(0))
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))

    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
