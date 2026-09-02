# Distributed Inference

Run sensor collection and ML inference on separate machines over Zenoh.

## Architecture

```
RPi (collects)                    PC (classifies)
──────────────                    ───────────────
npm run sensors                   npm run sensors:remote-inference
  ZENOH_ENABLE=1          →           subscribes to bsole/sensors/acceleration
  ZENOH_ROUTER=<pc-ip>:7447           runs MLGestureDetector
  ENABLED_SENSORS=acceleration        publishes to bsole/inference/gesture
```

Zenoh router must be reachable by both machines. By default it runs in Docker on the PC at port 7447.

## Setup

### 1. Zenoh router (PC)

```bash
docker compose up zenoh-router
```

### 2. Python dependencies (both machines)

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

### 3. RPi — collect and publish sensors

In `config/zenoh.ini` on the RPi:

```ini
ZENOH_ENABLE=1
ZENOH_ROUTER=tcp/<pc-ip>:7447
```

Then:

```bash
ENABLED_SENSORS=acceleration npm run sensors
```

### 4. PC — run inference

```bash
npm run sensors:remote-inference
```

Results above the confidence threshold are published to `bsole/inference/gesture`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ZENOH_ROUTER` | *(from peer.json5)* | Override router endpoint, e.g. `tcp/192.168.1.90:7447` |
| `ZENOH_ENABLE` | `0` | Set to `1` on the RPi to enable sensor publishing |
| `ENABLED_SENSORS` | `acceleration,...` | Comma-separated list; must include `acceleration` |
| `ZENOH_SUB_EXPRESSION` | `bsole/sensors/acceleration` | Key expression the PC subscribes to |
| `ZENOH_PUB_PREFIX` | `bsole/inference` | Prefix for published inference results |
| `ML_WINDOW_SIZE` | `30` | Sliding window size (30 samples = 1.5s at 20 Hz) |
| `ML_CONFIDENCE` | `0.7` | Minimum confidence to publish a gesture result |
| `DEBUG` | `0` | Set to `1` for verbose per-sample logging |

## Scripts

| Script | Description |
|---|---|
| `npm run sensors` | Collect sensors (RPi), publishes if `ZENOH_ENABLE=1` |
| `npm run sensors:remote-inference` | Distributed inference (PC) |
| `npm run sensors:ml-gesture` | Local inference — device connected directly |
| `npm run sensors:tflite` | On-device TFLite inference (Frame only) |
