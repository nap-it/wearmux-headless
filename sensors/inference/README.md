# Distributed Inference

Run sensor collection and ML inference on separate machines over Zenoh.

## Architecture

```
RPi (collects)                    PC (classifies)
──────────────                    ───────────────
npm run sensors                   npm run sensors:remote-inference
  MESSAGE_TRANSPORT=zenoh →          subscribes to bwear/sensors/acceleration
  ZENOH_ROUTER=<pc-ip>:7447           runs MLGestureDetector
  ENABLED_SENSORS=acceleration        publishes to bwear/inference/gesture
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

In `config/config.ini` on the RPi:

```ini
MESSAGE_TRANSPORT=zenoh
```

Set the router endpoint in `config/config.ini` if it is on another machine:

```ini
ZENOH_ROUTER=tcp/<pc-ip>:7447
```

Then:

```bash
ML_GESTURES=1 ENABLED_SENSORS=acceleration npm run sensors
```

This collector command also runs local inference. Enabling ML configures acceleration
at **20 ms (50 Hz)** and disables sample throttling before publication. The PC
uses the bundled model's **50-sample / one-second window** automatically;
`ML_WINDOW_SIZE` no longer overrides the model input shape.

### 4. PC — run inference

```bash
npm run sensors:remote-inference
```

Results above the confidence threshold are published to `bwear/inference/gesture`.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ZENOH_ROUTER` | *(from peer.json5)* | Override router endpoint, e.g. `tcp/192.168.1.90:7447` |
| `MESSAGE_TRANSPORT` | `zenoh` | Select Zenoh on both machines |
| `ENABLED_SENSORS` | `acceleration,...` | Comma-separated list; must include `acceleration` |
| `TOPIC_PREFIX` | `bwear` | Root for sensor and inference topics |
| `ML_GESTURES` | `0` in config | Set `1` on the collector to configure acceleration at the model interval and preserve all samples |
| `ML_CONFIDENCE` | `0.7` | Minimum confidence to publish a gesture result |
| `DEBUG` | `0` | Set to `1` for verbose per-sample logging |

## Scripts

| Script | Description |
|---|---|
| `npm run sensors` | Collect sensors (RPi), publishes through the selected transport |
| `npm run sensors:remote-inference` | Distributed inference (PC) |
| `npm run sensors:ml-gesture` | Local inference — device connected directly |
| `npm run sensors:tflite` | On-device TFLite inference (Frame only) |
