#!/usr/bin/env python3
"""
Whisper Listener — prints transcripts from bsole/whisper/transcript.

Usage:
    python3 whisper/listen.py
    npm run whisper:listen

Environment variables:
    WHISPER_PUB_KEY         Key to subscribe to (default: bsole/whisper/transcript)
    ZENOH_ROUTER            Router endpoint override (e.g. tcp/192.168.1.10:7447)
    WHISPER_LISTEN_VERBOSE  Set to 1 to print full JSON payload instead of text only
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


_load_ini(Path(__file__).resolve().parent.parent / "config" / "whisper.ini")

try:
    import zenoh
except ImportError:
    print("[whisper-listen] zenoh not installed — run: npm run whisper:setup", file=sys.stderr)
    sys.exit(1)

SUB_KEY = os.environ.get("WHISPER_PUB_KEY", "bsole/whisper/transcript")
ROUTER  = os.environ.get("ZENOH_ROUTER", "")
VERBOSE = os.environ.get("WHISPER_LISTEN_VERBOSE", "0") == "1"

CONFIG_FILE = Path(__file__).resolve().parent.parent / "config" / "peer.json5"


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
