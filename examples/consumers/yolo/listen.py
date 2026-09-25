#!/usr/bin/env python3
"""
YOLO Listener — prints detection payloads from bwear/yolo/detections.

Usage:
    python3 examples/consumers/yolo/listen.py

Environment variables:
    TOPIC_PREFIX    Root for message topics (default: bwear)
    ZENOH_ROUTER    Router endpoint override (e.g. tcp/192.168.1.10:7447)
"""

import os
import sys
import json
import signal
import time
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from python_config import load_config

load_config("yolo")

try:
    import zenoh
except ImportError:
    print("[yolo-listen] zenoh not installed — install examples/consumers/yolo/requirements.txt", file=sys.stderr)
    sys.exit(1)

SUB_KEY = f"{(os.environ.get('TOPIC_PREFIX', 'bwear').strip().strip('/') or 'bwear')}/yolo/detections"
ROUTER  = os.environ.get("ZENOH_ROUTER", "")
VERBOSE = os.environ.get("YOLO_LISTEN_VERBOSE", "0") == "1"

CONFIG_FILE = Path(__file__).resolve().parent.parent / "peer.json5"


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
