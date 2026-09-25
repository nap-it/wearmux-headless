#!/usr/bin/env python3
"""
YOLO Runner — object detection consumer for the wearmux-headless pipeline.

Subscribes to bwear/camera/raw/** (chunked JPEG frames published by
camera/index.js when CAMERA_RAW_ENABLE=1), reassembles frames,
runs YOLOv8 inference, and publishes detection results to bwear/yolo/detections.

Usage:
    python3 examples/consumers/yolo/runner.py

Environment variables:
    YOLO_MODEL          Model file or name: yolov8n.pt, yolov8s.pt, ... (default: yolov8n.pt)
    YOLO_DEVICE         Inference device: cpu, cuda, mps (default: cpu)
    YOLO_CONFIDENCE     Minimum detection confidence 0–1 (default: 0.5)
    YOLO_IOU            IOU threshold for NMS 0–1 (default: 0.45)
    YOLO_INPUT_SIZE     Inference image size in pixels (default: 320)
    YOLO_CLASSES        Comma-separated class IDs to filter, empty = all (default: empty)
    TOPIC_PREFIX        Root for all message topics (default: bwear)
    ZENOH_ROUTER        Zenoh router endpoint override (e.g. tcp/192.168.1.10:7447)
    MESSAGE_TRANSPORT   Select mqtt or zenoh (default: zenoh)
    MQTT_BROKER_URL     MQTT broker URL, optionally mqtts:// with credentials
    DEBUG               Set to 1 for verbose frame-level logging
"""

import os
import sys
import json
import time
import base64
import signal
import queue
import threading
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from python_config import load_config

load_config("yolo")

try:
    from PIL import Image, ImageDraw, ImageOps
    from ultralytics import YOLO
except ImportError:
    print("[yolo-runner] missing dependencies — install examples/consumers/yolo/requirements.txt", file=sys.stderr)
    sys.exit(1)

# ── Configuration ──────────────────────────────────────────────────────────────

MODEL_PATH   = os.environ.get("YOLO_MODEL", "yolov8n.pt")
DEVICE       = os.environ.get("YOLO_DEVICE", "cpu")
CONFIDENCE   = float(os.environ.get("YOLO_CONFIDENCE", "0.5"))
IOU          = float(os.environ.get("YOLO_IOU", "0.45"))
INPUT_SIZE   = int(os.environ.get("YOLO_INPUT_SIZE", "320"))
_classes_raw = os.environ.get("YOLO_CLASSES", "").strip()
CLASSES      = [int(c) for c in _classes_raw.split(",") if c.strip()] if _classes_raw else None
TOPIC_PREFIX      = (os.environ.get("TOPIC_PREFIX", "bwear").strip().strip("/") or "bwear")
PUB_KEY           = f"{TOPIC_PREFIX}/yolo/detections"
ANNOTATED_PUB_KEY = f"{TOPIC_PREFIX}/yolo/annotated"
PUBLISH_ANNOTATED = os.environ.get("YOLO_PUBLISH_ANNOTATED", "0") == "1"
SUB_EXPR     = f"{TOPIC_PREFIX}/camera/raw/**"
ROUTER       = os.environ.get("ZENOH_ROUTER", "")
MESSAGE_TRANSPORT = os.environ.get("MESSAGE_TRANSPORT", "zenoh").strip().lower()
if MESSAGE_TRANSPORT not in ("mqtt", "zenoh"):
    raise ValueError("YOLO requires MESSAGE_TRANSPORT=mqtt or zenoh")
USE_MQTT  = MESSAGE_TRANSPORT == "mqtt"
_mqtt_url    = urlparse(os.environ.get("MQTT_BROKER_URL", "mqtt://127.0.0.1:1883"))
if _mqtt_url.scheme not in ("mqtt", "mqtts") or not _mqtt_url.hostname:
    raise ValueError("MQTT_BROKER_URL must use mqtt:// or mqtts://")
MQTT_BROKER  = _mqtt_url.hostname
MQTT_PORT    = _mqtt_url.port or (8883 if _mqtt_url.scheme == "mqtts" else 1883)
MQTT_PUB_TOPIC = PUB_KEY
MQTT_SUB_TOPIC = f"{TOPIC_PREFIX}/camera/raw/#"
DEBUG        = os.environ.get("DEBUG", "0") == "1"

CONFIG_FILE = Path(__file__).resolve().parent.parent / "peer.json5"

_FRAME_TIMEOUT_S = 2.0
_QUEUE_MAXSIZE   = 2


# ── Helpers ────────────────────────────────────────────────────────────────────

def log(msg: str, *, err: bool = False) -> None:
    print(f"[yolo-runner] {msg}", flush=True, file=sys.stderr if err else sys.stdout)


def decode_frame(chunks_by_idx: dict) -> bytes:
    """Concatenate ordered base64 chunk data and return raw JPEG bytes."""
    b64 = "".join(chunks_by_idx[i] for i in sorted(chunks_by_idx))
    return base64.b64decode(b64)


# ── Frame assembler ────────────────────────────────────────────────────────────

class FrameAssembler:
    """Reassembles multi-chunk JPEG frames from meta + chunk messages.

    camera/index.js splits each JPEG into N base64 chunks and publishes them as:
        bwear/camera/raw/meta  — {frameId, totalChunks, encoding, mime, bytes, ...}
        bwear/camera/raw/chunk — {frameId, idx, data (base64 slice)}

    Meta and chunks may arrive in any order; both are buffered by frameId.
    Incomplete frames older than _FRAME_TIMEOUT_S are evicted.
    """

    def __init__(self, on_frame):
        self._on_frame = on_frame
        self._pending: dict = {}
        self._lock = threading.Lock()

    def on_meta(self, payload: dict) -> None:
        frame_id = payload.get("frameId")
        if not frame_id:
            return
        with self._lock:
            self._evict_stale()
            entry = self._pending.setdefault(frame_id, {"meta": None, "chunks": {}, "ts": time.monotonic()})
            entry["meta"] = payload
            self._try_complete(frame_id)

    def on_chunk(self, payload: dict) -> None:
        frame_id = payload.get("frameId")
        idx      = payload.get("idx")
        data     = payload.get("data")
        if frame_id is None or idx is None or data is None:
            return
        with self._lock:
            self._evict_stale()
            entry = self._pending.setdefault(frame_id, {"meta": None, "chunks": {}, "ts": time.monotonic()})
            entry["chunks"][idx] = data
            self._try_complete(frame_id)

    def _try_complete(self, frame_id: str) -> None:
        """Must be called with self._lock held."""
        entry = self._pending.get(frame_id)
        if entry is None or entry["meta"] is None:
            return
        meta  = entry["meta"]
        total = meta.get("totalChunks", 1)
        if len(entry["chunks"]) < total:
            return

        del self._pending[frame_id]
        try:
            jpeg_bytes = decode_frame(entry["chunks"])
        except Exception as exc:
            log(f"frame decode error (frameId={frame_id}): {exc}", err=True)
            return

        if DEBUG:
            log(f"frame assembled: {len(jpeg_bytes)} bytes  frameId={frame_id}")

        self._on_frame(jpeg_bytes, meta)

    def _evict_stale(self) -> None:
        """Must be called with self._lock held."""
        now   = time.monotonic()
        stale = [fid for fid, e in self._pending.items() if now - e["ts"] > _FRAME_TIMEOUT_S]
        for fid in stale:
            if DEBUG:
                log(f"evicting stale frame {fid}", err=True)
            del self._pending[fid]


# ── Inference worker ───────────────────────────────────────────────────────────

class InferenceWorker(threading.Thread):
    """Daemon thread that dequeues JPEG frames and runs YOLO inference.

    Inference is isolated from the subscriber callback thread so that
    blocking CPU/GPU work never stalls the message receiver.
    """

    def __init__(self, model: YOLO, publish_fn, publish_annotated_fn=None):
        super().__init__(daemon=True, name="yolo-inference")
        self._model                = model
        self._publish_fn           = publish_fn
        self._publish_annotated_fn = publish_annotated_fn
        self._queue: queue.Queue   = queue.Queue(maxsize=_QUEUE_MAXSIZE)
        self._running              = True
        self._dropped              = 0

    def enqueue(self, jpeg_bytes: bytes, meta: dict) -> None:
        try:
            self._queue.put_nowait((jpeg_bytes, meta))
            if self._dropped:
                log(f"dropped {self._dropped} frame(s) — inference slower than camera input", err=True)
                self._dropped = 0
        except queue.Full:
            self._dropped += 1

    def stop(self) -> None:
        self._running = False
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass

    def run(self) -> None:
        while self._running:
            item = self._queue.get()
            if item is None:
                break
            jpeg_bytes, meta = item
            self._infer(jpeg_bytes, meta)

    def _infer(self, jpeg_bytes: bytes, meta: dict) -> None:
        try:
            img = Image.open(BytesIO(jpeg_bytes))
            img = ImageOps.exif_transpose(img).convert("RGB")
        except Exception as exc:
            log(f"image decode error: {exc}", err=True)
            return

        t0 = time.monotonic()
        try:
            results = self._model.predict(
                img,
                conf=CONFIDENCE,
                iou=IOU,
                imgsz=INPUT_SIZE,
                classes=CLASSES,
                device=DEVICE,
                verbose=False,
            )
        except Exception as exc:
            log(f"inference error: {exc}", err=True)
            return

        elapsed_ms = (time.monotonic() - t0) * 1000

        detections = []
        if results:
            boxes = results[0].boxes
            for box in (boxes if boxes is not None else []):
                cls_id     = int(box.cls[0])
                confidence = float(box.conf[0])
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                detections.append({
                    "class":      self._model.names.get(cls_id, str(cls_id)),
                    "class_id":   cls_id,
                    "confidence": round(confidence, 4),
                    "x1": round(x1, 1),
                    "y1": round(y1, 1),
                    "x2": round(x2, 1),
                    "y2": round(y2, 1),
                })

        if DEBUG or detections:
            log(f"frameId={meta.get('frameId', '?')}  {len(detections)} detections  ({elapsed_ms:.1f}ms)")

        payload = {
            "ts":           int(time.time() * 1000),
            "frameId":      meta.get("frameId"),
            "inference_ms": round(elapsed_ms, 2),
            "image_w":      img.width,
            "image_h":      img.height,
            "model":        Path(MODEL_PATH).stem,
            "device":       DEVICE,
            "detections":   detections,
        }

        try:
            self._publish_fn(json.dumps(payload))
        except Exception as exc:
            log(f"publish error: {exc}", err=True)

        if PUBLISH_ANNOTATED and self._publish_annotated_fn and detections:
            try:
                draw = ImageDraw.Draw(img)
                for d in detections:
                    draw.rectangle([d["x1"], d["y1"], d["x2"], d["y2"]], outline="red", width=2)
                    draw.text((d["x1"], max(0, d["y1"] - 10)), f"{d['class']} {d['confidence']:.2f}", fill="red")
                buf = BytesIO()
                img.save(buf, format="JPEG", quality=75)
                annotated = json.dumps({
                    "ts":      payload["ts"],
                    "frameId": payload["frameId"],
                    "data":    base64.b64encode(buf.getvalue()).decode(),
                })
                self._publish_annotated_fn(annotated)
            except Exception as exc:
                log(f"annotated publish error: {exc}", err=True)


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    log(f"loading model '{MODEL_PATH}'  device={DEVICE}  conf={CONFIDENCE}  iou={IOU}  imgsz={INPUT_SIZE}")
    t0    = time.monotonic()
    model = YOLO(MODEL_PATH)
    log(f"model ready ({time.monotonic() - t0:.1f}s)  classes={len(model.names)}")

    log("warming up model...")
    model(Image.new("RGB", (INPUT_SIZE, INPUT_SIZE)), device=DEVICE, verbose=False)
    log("warm-up done")

    if USE_MQTT:
        try:
            import paho.mqtt.client as mqtt
        except ImportError:
            log("paho-mqtt not installed — run: pip install paho-mqtt", err=True)
            sys.exit(1)

        _pub: list = [None]
        _pub_ann: list = [None]
        worker    = InferenceWorker(model, lambda s: _pub[0](s),
                                    publish_annotated_fn=lambda s: _pub_ann[0](s) if _pub_ann[0] else None)
        assembler = FrameAssembler(on_frame=worker.enqueue)

        try:
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        except AttributeError:
            client = mqtt.Client()  # paho-mqtt < 2.0

        if _mqtt_url.username:
            client.username_pw_set(unquote(_mqtt_url.username), unquote(_mqtt_url.password or ""))
        if _mqtt_url.scheme == "mqtts":
            client.tls_set()

        def on_mqtt_message(client, userdata, msg):
            try:
                payload = json.loads(msg.payload.decode("utf-8"))
            except Exception:
                return
            if msg.topic.endswith("/meta"):
                assembler.on_meta(payload)
            elif msg.topic.endswith("/chunk"):
                assembler.on_chunk(payload)

        client.on_message = on_mqtt_message
        client.connect(MQTT_BROKER, MQTT_PORT)
        client.subscribe(MQTT_SUB_TOPIC)
        client.loop_start()
        _pub[0]     = lambda s: client.publish(MQTT_PUB_TOPIC, s)
        _pub_ann[0] = lambda s: client.publish(ANNOTATED_PUB_KEY, s) if PUBLISH_ANNOTATED else None

        worker.start()

        log(f"MQTT broker:  {MQTT_BROKER}:{MQTT_PORT}")
        log(f"subscribed    '{MQTT_SUB_TOPIC}'")
        log(f"publishing  → '{MQTT_PUB_TOPIC}'")
        log("waiting for camera frames... press Ctrl+C to stop\n")

        _stopping = False

        def shutdown(*_) -> None:
            nonlocal _stopping
            if _stopping:
                return
            _stopping = True
            sys.stderr.write("[yolo-runner] shutting down...\n")
            sys.stderr.flush()
            threading.Timer(3.0, lambda: os._exit(0)).start()
            worker.stop()
            client.loop_stop()
            client.disconnect()
            os._exit(0)

    else:
        try:
            import zenoh
        except ImportError:
            log("zenoh not installed — pip install eclipse-zenoh==1.6.1", err=True)
            sys.exit(1)

        if not CONFIG_FILE.exists():
            log(f"zenoh peer config not found: {CONFIG_FILE}", err=True)
            log("expected at examples/consumers/peer.json5", err=True)
            sys.exit(1)

        conf = zenoh.Config.from_file(str(CONFIG_FILE))
        if ROUTER:
            conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')
            log(f"router override: {ROUTER}")

        session              = zenoh.open(conf)
        publisher            = session.declare_publisher(PUB_KEY)
        annotated_publisher  = session.declare_publisher(ANNOTATED_PUB_KEY) if PUBLISH_ANNOTATED else None

        worker    = InferenceWorker(model, publisher.put,
                                    publish_annotated_fn=annotated_publisher.put if annotated_publisher else None)
        assembler = FrameAssembler(on_frame=worker.enqueue)

        def on_zenoh_message(sample) -> None:
            key = str(sample.key_expr)
            try:
                payload = json.loads(bytes(sample.payload).decode("utf-8"))
            except Exception:
                return
            if key.endswith("/meta"):
                assembler.on_meta(payload)
            elif key.endswith("/chunk"):
                assembler.on_chunk(payload)

        sub = session.declare_subscriber(SUB_EXPR, on_zenoh_message)
        worker.start()

        log(f"subscribed   '{SUB_EXPR}'")
        log(f"publishing → '{PUB_KEY}'")
        log(f"model={MODEL_PATH}  conf={CONFIDENCE}  iou={IOU}  imgsz={INPUT_SIZE}")
        log("waiting for camera frames... press Ctrl+C to stop\n")

        _stopping = False

        def shutdown(*_) -> None:
            nonlocal _stopping
            if _stopping:
                return
            _stopping = True
            sys.stderr.write("[yolo-runner] shutting down...\n")
            sys.stderr.flush()
            threading.Timer(3.0, lambda: os._exit(0)).start()
            worker.stop()
            try:
                sub.undeclare()
            except Exception:
                pass
            try:
                publisher.undeclare()
            except Exception:
                pass
            try:
                if annotated_publisher:
                    annotated_publisher.undeclare()
            except Exception:
                pass
            session.close()
            os._exit(0)

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
