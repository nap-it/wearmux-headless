#!/usr/bin/env python3
"""
Whisper Listener — prints transcripts from bwear/whisper/transcript.

Usage:
    python3 examples/consumers/whisper/listen.py

Environment variables:
    TOPIC_PREFIX            Root for message topics (default: bwear)
    ZENOH_ROUTER            Router endpoint override (e.g. tcp/192.168.1.10:7447)
    WHISPER_LISTEN_VERBOSE  Set to 1 to print full JSON payload instead of text only
"""

import os
import sys
import json
import signal
import time
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from python_config import load_config

load_config("whisper")

try:
    import zenoh
except ImportError:
    print("[whisper-listen] zenoh not installed — install examples/consumers/whisper/requirements.txt", file=sys.stderr)
    sys.exit(1)

SUB_KEY = f"{(os.environ.get('TOPIC_PREFIX', 'bwear').strip().strip('/') or 'bwear')}/whisper/transcript"
ROUTER  = os.environ.get("ZENOH_ROUTER", "")
VERBOSE = os.environ.get("WHISPER_LISTEN_VERBOSE", "0") == "1"

CONFIG_FILE = Path(__file__).resolve().parent.parent / "peer.json5"


def on_message(sample) -> None:
    try:
        payload = json.loads(bytes(sample.payload).decode("utf-8"))
    except Exception:
        return

    if VERBOSE:
        print(json.dumps(payload, indent=2))
    else:
        lang = payload.get("language") or "?"
        text = payload.get("text", "")
        ms   = payload.get("inference_s", 0) * 1000
        print(f"[{lang}] {text}  ({ms:.0f}ms)")


def main() -> None:
    if not CONFIG_FILE.exists():
        print(f"[whisper-listen] peer config not found: {CONFIG_FILE}", file=sys.stderr)
        sys.exit(1)

    conf = zenoh.Config.from_file(str(CONFIG_FILE))
    if ROUTER:
        conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')

    session = zenoh.open(conf)
    session.declare_subscriber(SUB_KEY, on_message)

    print(f"[whisper-listen] subscribed '{SUB_KEY}'")
    print("[whisper-listen] waiting for transcripts... press Ctrl+C to stop\n")

    signal.signal(signal.SIGINT,  lambda *_: os._exit(0))
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))

    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
