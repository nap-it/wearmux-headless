#!/usr/bin/env python3
"""
YOLO Pipeline Tester — publishes a JPEG to Zenoh as if the camera sent it.

Usage:
    python3 examples/consumers/yolo/test_publish.py [image_path] [--loop]

    image_path  JPEG/PNG to publish (default: downloads a sample person image)
    --loop      Repeat every second until Ctrl+C

Environment variables:
    ZENOH_ROUTER    Router endpoint override (default: consumers/peer.json5)
    TOPIC_PREFIX    Root for message topics (default: bwear)
"""

import os
import sys
import json
import time
import base64
import signal
import uuid
from pathlib import Path
from io import BytesIO


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from python_config import load_config

load_config("yolo")

try:
    import zenoh
except ImportError:
    print("[yolo-test] zenoh not installed — install examples/consumers/yolo/requirements.txt", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    print("[yolo-test] Pillow not installed — install examples/consumers/yolo/requirements.txt", file=sys.stderr)
    sys.exit(1)

ROUTER       = os.environ.get("ZENOH_ROUTER", "")
TOPIC_PREFIX = (os.environ.get("TOPIC_PREFIX", "bwear").strip().strip("/") or "bwear")
PUB_BASE     = f"{TOPIC_PREFIX}/camera/raw"
RESULTS_KEY  = f"{TOPIC_PREFIX}/yolo/detections"
CONFIG_FILE  = Path(__file__).resolve().parent.parent / "peer.json5"
CHUNK_SIZE   = 32 * 1024  # 32 KB per chunk (base64 chars)


def load_image(path: str | None) -> bytes:
    if path:
        img = Image.open(path).convert("RGB")
    else:
        # Minimal 320x240 grey placeholder if no image provided
        img = Image.new("RGB", (320, 240), color=(100, 100, 100))
        print("[yolo-test] no image given — using grey placeholder (detections unlikely)")

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()


def publish_frame(session, jpeg_bytes: bytes) -> str:
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    chunks = [b64[i:i + CHUNK_SIZE] for i in range(0, len(b64), CHUNK_SIZE)]
    frame_id = str(uuid.uuid4())

    meta = {
        "frameId":     frame_id,
        "totalChunks": len(chunks),
        "encoding":    "base64",
        "mime":        "image/jpeg",
        "bytes":       len(jpeg_bytes),
    }
    session.put(f"{PUB_BASE}/meta", json.dumps(meta))

    for idx, data in enumerate(chunks):
        chunk = {"frameId": frame_id, "idx": idx, "data": data}
        session.put(f"{PUB_BASE}/chunk", json.dumps(chunk))

    return frame_id


def on_result(sample) -> None:
    try:
        payload = json.loads(bytes(sample.payload).decode("utf-8"))
    except Exception:
        return
    detections = payload.get("detections", [])
    ms = payload.get("inference_ms", 0)
    fid = payload.get("frameId", "?")[:8]
    if detections:
        print(f"[{fid}] {ms:.0f}ms — {len(detections)} detection(s):")
        for d in detections:
            print(f"  {d['class']} {d['confidence']:.2f}  [{d['x1']:.0f},{d['y1']:.0f} {d['x2']:.0f},{d['y2']:.0f}]")
    else:
        print(f"[{fid}] {ms:.0f}ms — no detections")


def main() -> None:
    args = sys.argv[1:]
    loop = "--loop" in args
    image_path = next((a for a in args if not a.startswith("--")), None)

    jpeg_bytes = load_image(image_path)
    print(f"[yolo-test] image: {image_path or 'placeholder'}  ({len(jpeg_bytes)} bytes)")

    if not CONFIG_FILE.exists():
        print(f"[yolo-test] peer config not found: {CONFIG_FILE}", file=sys.stderr)
        sys.exit(1)

    conf = zenoh.Config.from_file(str(CONFIG_FILE))
    if ROUTER:
        conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')

    session = zenoh.open(conf)
    sub = session.declare_subscriber(RESULTS_KEY, on_result)

    print(f"[yolo-test] publishing to '{PUB_BASE}/{{meta,chunk}}'")
    print(f"[yolo-test] listening on  '{RESULTS_KEY}'")
    if loop:
        print("[yolo-test] looping every 1s — Ctrl+C to stop\n")
    else:
        print("[yolo-test] sending one frame — waiting 3s for result\n")

    signal.signal(signal.SIGINT,  lambda *_: os._exit(0))
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))

    if loop:
        while True:
            fid = publish_frame(session, jpeg_bytes)
            print(f"[yolo-test] sent frameId={fid[:8]}", flush=True)
            time.sleep(1)
    else:
        publish_frame(session, jpeg_bytes)
        time.sleep(3)


if __name__ == "__main__":
    main()
