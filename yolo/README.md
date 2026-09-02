# yolo — object detection consumer

Real-time object detection for the WearMux headless pipeline.

Subscribes to the raw camera stream published by `camera/index.js`, reassembles
JPEG frames, runs [YOLOv8](https://docs.ultralytics.com/) inference via Ultralytics,
and publishes detection results back onto the transport layer.

```
camera/index.js  ──(bsole/camera/raw/**)──►  yolo/runner.py
                                                    │
                                           bsole/yolo/detections
                                                    │
                                             Python subscribers
                                             glasses-controller
                                             ...
```

---

## Prerequisites

1. **Install Python dependencies** (from the repository root):
   ```bash
   npm run yolo:setup
   ```

2. **Verify raw camera publishing is enabled** in `config/zenoh.ini`:
   ```ini
   ZENOH_ENABLE=1
   ZENOH_CAMERA_RAW_ENABLE=1
   ```
   Both are enabled by default. Without `ZENOH_CAMERA_RAW_ENABLE=1` the camera
   only publishes image metadata, not the JPEG pixel data needed for inference.

3. **A Zenoh router must be reachable** — default `tcp/127.0.0.1:7447`:
   ```bash
   docker compose up -d zenoh-router
   ```

---

## Running

```bash
# Terminal 1 — stream camera frames
npm run camera

# Terminal 2 — detect objects
npm run yolo:runner

# Terminal 3 — read detections
npm run yolo:listen
```

To start yolo automatically with `npm start`, add to `config/config.ini`:
```ini
run=yolo:runner
```

Or run the full stack in Docker:
```bash
docker compose up --build yolo
```

---

## Configuration (`config/yolo.ini`)

Values in `config/yolo.ini` take precedence over code defaults. Shell environment variables override both.

### Model

| Variable | `yolo.ini` default | Description |
|---|---|---|
| `YOLO_MODEL` | `yolov8m.pt` | Model file or name: `yolov8n`, `yolov8s`, `yolov8m`, `yolov8l`, `yolov8x` |
| `YOLO_DEVICE` | `cuda` | `cpu`, `cuda`, or `mps` |

### Detection thresholds

| Variable | `yolo.ini` default | Description |
|---|---|---|
| `YOLO_CONFIDENCE` | `0.40` | Minimum detection confidence (0–1); lower = more detections, more noise |
| `YOLO_IOU` | `0.45` | NMS IOU threshold (0–1); lower = fewer overlapping boxes |
| `YOLO_INPUT_SIZE` | `640` | Inference image size in pixels (must be multiple of 32) |
| `YOLO_CLASSES` | `0,1,2` | Comma-separated COCO class IDs to detect; empty = all 80 classes |

Common class IDs: `0`=person, `1`=bicycle, `2`=car, `15`=cat, `16`=dog.

### Transport

| Variable | Default | Description |
|---|---|---|
| `MQTT_ENABLE` | `0` | Set to `1` to subscribe via MQTT instead of Zenoh |
| `MQTT_BROKER` | `localhost` | MQTT broker host |
| `MQTT_PORT` | `1883` | MQTT broker port |
| `MQTT_PUB_TOPIC` | _(same as `YOLO_PUB_KEY`)_ | Topic to publish detections to |
| `MQTT_SUB_CAMERA` | `bsole/camera/raw/#` | Topic filter for camera subscription |
| `ZENOH_SUB_CAMERA` | `bsole/camera/raw/**` | Zenoh key expression to subscribe to |
| `ZENOH_ROUTER` | `tcp/127.0.0.1:7447` | Router endpoint |
| `YOLO_PUB_KEY` | `bsole/yolo/detections` | Zenoh key for detection output |

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

## Detection payload (`bsole/yolo/detections`)

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

