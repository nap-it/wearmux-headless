# yolo — object detection consumer

Optional object detection consumer for WearMux Headless. It runs outside the core service and can run on another machine.

Subscribes to the raw camera stream published by a camera session, reassembles
JPEG frames, runs [YOLOv8](https://docs.ultralytics.com/) inference via Ultralytics,
and publishes detection results back onto the transport layer.

```
WearMux camera  ──(bwear/camera/raw/**)──►  examples/consumers/yolo/runner.py
                                                    │
                                           bwear/yolo/detections
                                                    │
                                             Python subscribers
                                             glasses-controller
                                             ...
```

---

## Prerequisites

1. **Install this example's Python dependencies** (from the repository root or the copied `consumers/` directory):
   ```bash
   cd examples/consumers  # or the copied consumers/ directory
   python3 -m venv .venv
   .venv/bin/pip install -r yolo/requirements.txt
   ```

2. **Verify raw camera publishing is enabled** in `config/camera.ini`:
   ```ini
   CAMERA_RAW_ENABLE=1
   ```
   It is enabled by default. Without `CAMERA_RAW_ENABLE=1` the camera
   only publishes image metadata, not the JPEG pixel data needed for inference.

3. **Start the selected transport.** For Zenoh, start a router (default `tcp/127.0.0.1:7447`):
   ```bash
   docker compose up -d zenoh-router
   ```

---

## Running

```bash
# Terminal 1, from the WearMux Headless repository — stream camera frames
npm run camera

# Terminal 2, from consumers/ — detect objects (can be another host)
.venv/bin/python yolo/runner.py

# Terminal 3, from consumers/ — read detections
.venv/bin/python yolo/listen.py
```

`listen.py` uses Zenoh. For MQTT, subscribe to `bwear/yolo/detections` (or the configured `TOPIC_PREFIX`) with an MQTT client. When running on another machine, set `ZENOH_ROUTER` or `MQTT_BROKER_URL` to the reachable endpoint and set `MESSAGE_TRANSPORT` to match WearMux Headless.

---

## Configuration (`examples/consumers/yolo/config.ini`)

The example reads shared transport settings from the repository's `config/` directory when present, then reads its own `config.ini`. Shell variables take precedence. A copied `examples/consumers/` directory can run without the main repository configuration.

### Model

| Variable | `config.ini` default | Description |
|---|---|---|
| `YOLO_MODEL` | `yolov8n.pt` | Model file or name: `yolov8n`, `yolov8s`, `yolov8m`, `yolov8l`, `yolov8x` |
| `YOLO_DEVICE` | `cpu` | `cpu`, `cuda`, or `mps` |

### Detection thresholds

| Variable | `config.ini` default | Description |
|---|---|---|
| `YOLO_CONFIDENCE` | `0.40` | Minimum detection confidence (0–1); lower = more detections, more noise |
| `YOLO_IOU` | `0.45` | NMS IOU threshold (0–1); lower = fewer overlapping boxes |
| `YOLO_INPUT_SIZE` | `320` | Inference image size in pixels (must be multiple of 32) |
| `YOLO_CLASSES` | _(empty)_ | Comma-separated COCO class IDs to detect; empty = all 80 classes |

Common class IDs: `0`=person, `1`=bicycle, `2`=car, `15`=cat, `16`=dog.

### Transport

| Variable | Default | Description |
|---|---|---|
| `MESSAGE_TRANSPORT` | `zenoh` | Select `mqtt` or `zenoh`; set in the shell on a separate host |
| `TOPIC_PREFIX` | `bwear` | Shared root for input and output topics |
| `MQTT_BROKER_URL` | `mqtt://127.0.0.1:1883` | MQTT broker URL, including optional credentials or TLS (`mqtts://`) |
| `ZENOH_ROUTER` | `tcp/127.0.0.1:7447` | Zenoh router endpoint override; default in `examples/consumers/peer.json5` |

### CPU performance guide

| Model | Size | Latency @ 320px (CPU) | mAP50-95 |
|---|---|---|---|
| `yolov8n` | 6 MB | 30–80 ms | 37.3 |
| `yolov8s` | 22 MB | 80–200 ms | 44.9 |
| `yolov8m` | 52 MB | 200–500 ms | 50.2 |
| `yolov8l` | 87 MB | 500–1000 ms | 52.9 |

`yolov8n` is the right default for real-time use on CPU. Use `yolov8s` or larger
only with GPU (`YOLO_DEVICE=cuda`).

---

## Detection payload (`bwear/yolo/detections`)

```json
{
  "ts": 1748198400000,
  "frameId": "abc123",
  "inference_ms": 45.2,
  "image_w": 640,
  "image_h": 480,
  "model": "yolov8m",
  "device": "cuda",
  "detections": [
    {
      "class": "person",
      "class_id": 0,
      "confidence": 0.9213,
      "x1": 10.0,
      "y1": 20.0,
      "x2": 150.0,
      "y2": 300.0
    }
  ]
}
```

Coordinates are in pixels relative to the original camera frame dimensions
(`image_w` × `image_h`). An empty `detections` array means no objects were
found above the confidence threshold in that frame.

---

## Architecture

```
Subscriber thread (Zenoh or MQTT)
  on_message()
    └── FrameAssembler.on_meta() / on_chunk()
          │  reassemble multi-chunk base64 JPEG frames by frameId
          └── InferenceWorker.enqueue()

InferenceWorker (daemon thread)
  dequeue (jpeg_bytes, meta)
    └── PIL.Image.open(BytesIO(jpeg_bytes))
    └── YOLO.predict(img, conf, iou, imgsz, classes, device)
    └── extract boxes: class, confidence, xyxy coords
    └── publish_fn(json)   (Zenoh publisher.put or MQTT client.publish)
```

The subscriber and inference run on separate threads so a slow CPU inference
pass never stalls frame reception. The queue is bounded (`maxsize=2`): if
inference falls behind, the oldest unprocessed frame is dropped.

---
