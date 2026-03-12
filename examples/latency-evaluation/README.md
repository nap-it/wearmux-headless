# Latency Evaluation

Camera capture latency benchmark for a BrilliantSole camera device. Measures the time from issuing a capture command to receiving the JPEG image over BLE.

## What it does

1. Connects to the BLE camera device.
2. Configures camera settings from `config.ini`.
3. Enables `autoPicture` for continuous streaming.
4. Records per-frame capture latency (device-reported), frame size, and inter-frame intervals.
5. Serves a live MJPEG/polling viewer in the browser so you can see what the camera sees.
6. Prints a summary (min, avg, median, p90, max) when finished.

No monitor, GUI, or Python dependencies are required.

## Run

```bash
npm run examples:latency
```

Open the viewer in a browser at the address printed in the terminal (default `http://localhost:8099`).

Press `Ctrl+C` to stop early.

## Settings

All camera settings come from [`config/config.ini`](../../config/config.ini). The latency example only adds:

- `CAMERA_LATENCY_MEASUREMENTS`: number of frames to capture; `0` = continuous (default: 50)
- `CAMERA_LATENCY_OUTPUT`: optional JSON file path for raw samples and summaries

The camera-level settings used are:

- `CAMERA_RESOLUTION`, `CAMERA_QUALITY_FACTOR`: image quality
- `CAMERA_RATE`: sensor polling rate (default: 10)
- `CAMERA_VIEW_ENABLE`, `CAMERA_VIEW_PORT`, `CAMERA_VIEW_MJPEG`: web viewer

Example override:

```bash
CAMERA_LATENCY_MEASUREMENTS=100 \
CAMERA_LATENCY_OUTPUT=./logs/camera-latency.json \
npm run examples:latency
```

The console prints per-frame capture latency, frame size, and a final summary with min/avg/median/p90/max, frame intervals, and effective FPS.

If you want to compare against the normal camera path, run:

```bash
npm run camera
```

That uses the same host-side config loading, but it is not a latency benchmark.
