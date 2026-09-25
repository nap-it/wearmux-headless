# WearMux Headless

Node.js + Python tooling to connect to BrilliantSole devices, stream sensor data, run AI inference (speech-to-text, object detection), and exchange data and device actions over MQTT or Zenoh.

## Project Structure

The project has been organized with clear separation of concerns:

```
wearmux-headless/
├── config/
│   ├── config.ini                  # App configuration (for Docker)
│   ├── peer.json5                  # Zenoh peer configuration
│   ├── peer.docker.json5           # Zenoh peer configuration (for Docker)
│   ├── router.json5                # Zenoh router configuration
│   ├── whisper.ini                 # Whisper STT configuration
│   └── yolo.ini                    # YOLO object detection configuration
├── display/
│   ├── index.js                    # Show images on device display
│   └── lib/display-manager.js      # Display rendering & tiling
├── actions/
│   └── index.js                    # Standalone device action receiver
├── microphone/
│   ├── index.js                    # Microphone → RTSP publisher
│   ├── record-audio.js             # Record audio to WAV file
│   └── lib/
│       ├── audio-utils.js          # Audio format utilities
│       └── rtsp-publisher.js       # FFmpeg RTSP publisher
├── sensors/
│   ├── index.js                    # Sensor monitor
│   ├── inference/
│   │   ├── real-time-ml-gesture.js # ML gesture recognition
│   │   ├── remote-inference.js     # Remote inference client
│   │   └── tflite-runner.js        # On-device TFLite inference
│   ├── training/
│   │   ├── collect-training-data.js# Edge Impulse data collection
│   │   ├── run-impulse.js          # Run Edge Impulse pipeline
│   │   └── run-inference.js        # Edge Impulse inference runner
│   └── lib/
│       ├── sensor-manager.js       # Device + sensor orchestration
│       ├── motion-sensors.js       # Motion handlers/utilities
│       ├── activity-sensors.js     # Tap detector & activity classification
│       └── ml/
│           ├── ml-gesture-detector.js # ML gesture detection
│           └── ei-classifier.js    # Edge Impulse classifier wrapper
├── camera/
│   ├── index.js                    # Camera capture CLI
│   └── lib/
│       ├── image-validator.js      # Image validation utilities
│       └── viewer-server.js        # HTTP/MJPEG browser viewer
├── whisper/
│   ├── runner.py                   # Speech-to-text inference (faster-whisper)
│   ├── launcher.js                 # Node entry point for whisper runner
│   ├── Dockerfile                  # Standalone whisper Docker image
│   └── README.md                   # Whisper configuration & payload docs
├── yolo/
│   ├── runner.py                   # Object detection inference (YOLOv8)
│   ├── launcher.js                 # Node entry point for yolo runner
│   ├── Dockerfile                  # Standalone yolo Docker image
│   └── README.md                   # YOLO configuration & payload docs
├── examples/
│   ├── car-interaction/            # Car interaction example + tests
│   └── latency-evaluation/         # Display-to-camera latency evaluation example
├── tools/
│   ├── launcher.js                 # Config parser and script launcher
│   ├── run-with-config.js          # Env-injecting script runner
│   ├── mqtt-broker.js              # Embedded MQTT broker helper
│   ├── send-action.js              # Send an action and wait for its result
│   ├── wifi-setup.js               # BLE WiFi provisioning tool
│   ├── zenoh_py_publisher.py       # Python sidecar: UDS→Zenoh publisher
│   ├── zenoh_py_subscriber.py      # Python subscriber helper
│   └── zenoh_py_subscriber_bridge.py # Zenoh→Node subscriber bridge
├── utils/
│   ├── config.js                   # Env-driven config loader
│   ├── ini-config.js               # INI file parser
│   ├── device-manager.js           # BLE/WiFi connection manager
│   ├── mqtt-manager.js             # MQTT publisher
│   ├── mqtt-subscriber.js          # MQTT subscriber
│   ├── transport.js                # Transport abstraction (Zenoh/MQTT)
│   ├── action-dispatcher.js        # Route incoming actions to device outputs
│   ├── zenoh-manager.js            # Node→Python sidecar bridge (UDS)
│   └── zenoh-subscriber.js         # Zenoh subscriber helper
├── docker-compose.yml              # Docker for Linux
├── package.json
└── README.md
```


## Prerequisites

### Linux
- Node.js 18+
- Python 3.9+ (for Zenoh only)
- Bluetooth adapter with BlueZ

### Windows
- Node.js 18+
- Windows 10 build 15063+ (required for WinRT BLE API)
- **Visual Studio Build Tools** with "Desktop development with C++" workload and Windows 10 SDK — required to compile the native BLE addon. Install via winget:
  ```
  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows10SDK.19041 --includeRecommended"
  ```
  Or download manually from [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- Python 3.9+ (for Zenoh only) — on Windows, ensure `python` is on your PATH
- FFmpeg on PATH (for audio streaming only)


## Quick Start

```bash
# Install dependencies
npm install

# Microphone → RTSP
npm run microphone:rtsp

# Record audio to WAV file
npm run microphone:record

# Clean recorded audio files
npm run clean:recordings

# Sensor monitor (use ENABLED_SENSORS and per-sensor *_RATE envs)
npm run sensors

# Receive device actions without the sensor monitor
npm run actions

# Display an image on the device display
npm run display -- path/to/image.png

# Camera capture
npm run camera

# Display-to-camera latency example
npm run examples:latency

# --- AI Inference ---

# Install Python dependencies (shared venv for whisper + yolo)
npm run whisper:setup   # or npm run yolo:setup — same venv

# Speech-to-text (requires ZENOH_MIC_RAW_ENABLE=1)
npm run whisper:runner
npm run whisper:listen  # read transcripts in another terminal

# Object detection (requires ZENOH_CAMERA_RAW_ENABLE=1)
npm run yolo:runner
npm run yolo:listen     # read detections in another terminal
```


## Features

### 🎤 Audio Streaming
- **Real-time RTSP streaming** at 8kHz or 16kHz
- **Recording** to WAV files with configurable quality
- **Audio level monitoring** via Zenoh
- Supports multiple concurrent listeners

### 📊 Sensor Monitoring
- **Motion sensors**: acceleration, gyroscope, magnetometer
- **Activity detection**: step counting, activity classification
- **ML gesture recognition**: powered by Edge Impulse models
- Real-time data publishing via Zenoh

### 📷 Camera Integration
- Single capture or continuous auto-capture mode
- Optional auto-focus before each capture (enabled by default)
- Configurable delay between captures in auto mode
- Browser-based viewer interface (refresh or MJPEG stream)
- Adjustable resolution, quality, exposure, and gain settings
- Save images to disk with timestamps

### 🖼️ Display Control
- Render images to device display
- Automatic image preprocessing and dithering
- Performance timing diagnostics
- Supports PNG and JPEG formats

### 🧠 AI Inference

#### Speech-to-Text (Whisper)

- **Real-time transcription** via [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- Subscribes to `bsole/microphone/raw/**` — works with the existing mic pipeline
- Publishes transcripts to `bsole/whisper/transcript` (Zenoh or MQTT)
- **Automatic language detection** with majority-vote locking across windows
- **No-speech filtering** suppresses silent-window hallucinations
- Configurable window size, overlap, model size, and compute type
- See [whisper/README.md](whisper/README.md) for full configuration

#### Object Detection (YOLO)

- **Real-time detection** via [Ultralytics YOLOv8](https://docs.ultralytics.com/)
- Subscribes to `bsole/camera/raw/**` — works with the existing camera pipeline
- Publishes detections to `bsole/yolo/detections` (Zenoh or MQTT)
- Configurable model size (n/s/m/l/x), confidence threshold, IOU, and class filter
- Detection payload includes bounding boxes, class names, and confidence scores
- See [yolo/README.md](yolo/README.md) for full configuration


## Messaging and reverse actions

WearMux uses one messaging transport at a time. Set `MESSAGE_TRANSPORT=mqtt` or `MESSAGE_TRANSPORT=zenoh`; the existing `MQTT_ENABLE=1` and `ZENOH_ENABLE=1` settings still work. `config/zenoh.ini` selects Zenoh by default. MQTT uses `mqtt://127.0.0.1:1883` unless `MQTT_BROKER_URL` is set. No action-specific configuration is required.

The older `ZENOH_MIC_*` and `ZENOH_CAMERA_*` options in the configuration files still control raw audio and image publishing for either transport. Their names are retained so existing setups continue to work.

The normal sensor command (`npm run sensors`) publishes sensor data and listens for actions on the same device connection. If sensors are not running, `npm run actions` starts a standalone action receiver. Run one action receiver per device connection.

Applications publish a JSON object to `bsole/actions`. The action receiver publishes a result to `bsole/actions/result` with the same `id`, an `ok` flag, device identity, and timestamp. `ok` means the device SDK accepted the action call; it does not confirm that the wearer perceived the output. Failed actions also include an `error`. An optional `deviceId` targets one connected device. Supported actions are:

| Action | Fields | Effect |
| --- | --- | --- |
| `display.text` | `text` | Show up to 500 characters on a device display |
| `display.clear` | — | Clear the device display |
| `display.image` | `data` | Show a base64 PNG or JPEG, up to 1 MiB |
| `haptic.vibrate` | optional `effect`, `locations` | Trigger a supported SDK vibration effect; defaults to `strongClick100` |

Use the included sender to publish an action and print its result:

```bash
# Default Zenoh configuration; run `npm run sensors` in another terminal first.
npm run actions:send -- '{"action":"display.text","text":"Hello"}'

# MQTT, with `npm run mqtt:broker` running in another terminal.
MESSAGE_TRANSPORT=mqtt npm run sensors
MESSAGE_TRANSPORT=mqtt npm run actions:send -- '{"action":"haptic.vibrate"}'
```

With Docker Compose, a broker listening on the host's port 1883 is reachable from the Whisper and YOLO containers as `host.docker.internal`. Pass `MESSAGE_TRANSPORT=mqtt` to select MQTT for all services.

The transport sends modality data from the device to applications. The reverse path is `bsole/actions` → subscriber → action dispatcher → device display or haptics. The result topic lets an application distinguish an accepted command from one the device could not perform.

## Published data topics

MQTT and Zenoh publish the same logical topics and JSON payloads. For Zenoh, the Node.js connector uses a Python sidecar (`tools/zenoh_py_publisher.py`) over a Unix domain socket with MessagePack framing.

### Published Topics

#### Sensors (`bsole/sensors/`)
When messaging is enabled, all enabled sensors are automatically published:
- **`bsole/sensors/acceleration`** - 3-axis acceleration data (x, y, z in m/s²)
- **`bsole/sensors/gyroscope`** - 3-axis gyroscope data (x, y, z in rad/s)
- **`bsole/sensors/magnetometer`** - 3-axis magnetometer data (x, y, z in μT)
- **`bsole/sensors/orientation`** - Euler angles (heading, pitch, roll in degrees)
- **`bsole/sensors/linearAcceleration`** - Linear acceleration without gravity
- **`bsole/sensors/gameRotation`** - Game rotation quaternion
- **`bsole/sensors/rotation`** - Rotation quaternion
- **`bsole/sensors/tapDetector`** - Tap detection events

Each message includes:
```json
{
  "ts": 1234567890,
  "sensor": "acceleration",
  "device": { "id": "CE:59:C3:0F:4D:C9", "name": "BrilliantFrame" },
  "message": { "timestamp": 1234567890, "sensorType": "acceleration", "acceleration": { "x": 0.1, "y": 0.2, "z": 9.8 } }
}
```

#### Microphone (`bsole/microphone/`)
When messaging is enabled and `ZENOH_MIC_ENABLE` is not `0`:
- **`bsole/microphone/status`** - Microphone connection status
- **`bsole/microphone/level`** - Real-time audio level (RMS, peak, timestamp)
- **`bsole/microphone/raw/meta`** - Raw audio metadata (when `ZENOH_MIC_RAW_ENABLE=1`)
- **`bsole/microphone/raw/chunk`** - Raw audio data chunks in base64 (when `ZENOH_MIC_RAW_ENABLE=1`)

#### Camera (`bsole/camera/`)
When messaging is enabled and `ZENOH_CAMERA_ENABLE` is not `0`:
- **`bsole/camera/image`** - Image metadata (timestamp, filename, dimensions, etc.)
- **`bsole/camera/raw/meta`** - Raw image metadata (when `ZENOH_CAMERA_RAW_ENABLE=1`)
- **`bsole/camera/raw/chunk`** - Raw image data chunks in base64 (when `ZENOH_CAMERA_RAW_ENABLE=1`)

#### Whisper (`bsole/whisper/`)

Published by `whisper/runner.py` when running (`npm run whisper:runner`):

- **`bsole/whisper/transcript`** - Transcription result per audio window

```json
{
  "ts": 1748198400000,
  "text": "hello world",
  "language": "en",
  "language_probability": 0.998,
  "inference_s": 1.42,
  "window_s": 5.0,
  "segments": [{ "start": 0.0, "end": 1.8, "text": "hello world" }]
}
```

#### YOLO (`bsole/yolo/`)

Published by `yolo/runner.py` when running (`npm run yolo:runner`):

- **`bsole/yolo/detections`** - Object detection results per camera frame

```json
{
  "ts": 1748198400000,
  "frameId": "abc123",
  "inference_ms": 45.2,
  "image_w": 320,
  "image_h": 240,
  "model": "yolov8n",
  "device": "BrilliantFrame",
  "detections": [
    { "class": "person", "class_id": 0, "confidence": 0.9213, "x1": 10.0, "y1": 20.0, "x2": 150.0, "y2": 300.0 }
  ]
}
```

### Configuration

See the [Zenoh](#zenoh) subsection in [Environment Variables](#environment-variables) for all configuration options.

### Python Helpers

- **`tools/zenoh_py_publisher.py`** - Sidecar process that receives data via UDS and publishes to Zenoh
- **`tools/zenoh_py_subscriber.py`** - Example subscriber to receive published data

Example subscriber usage:
```bash
python3 tools/zenoh_py_subscriber.py --key "bsole/sensors/**"
```


## Docker

This project provides a `docker-compose.yml` for running the connector in a containerized environment. All configuration is managed through `config/config.ini`.

### Quick Start

1. **Configure your settings:**
  - Edit `config/config.ini` to set environment variables and scripts to run
  - See the [Environment Variables](#environment-variables) section for all available options

2. **Build and start the container:**
  ```bash
  docker-compose up --build
  ```

3. **Stop the container:**
  ```bash
  docker-compose down
  ```

### Configuration

All settings are defined in `config/config.ini`:
- **`[env]` section**: Environment variables (device ID, sensors, Zenoh settings, etc.)
- **`[scripts]` section**: Scripts to run on startup (e.g., `sensors`, `camera`, `microphone:rtsp`)

Example `config/config.ini`:
```ini
[env]
ZENOH_ENABLE=1
ENABLED_SENSORS=acceleration,magnetometer,orientation
DEVICE_ID=CE:59:C3:0F:4D:C9

[scripts]
run=sensors
```

### Permissions & Troubleshooting

- Ensure your user has access to Bluetooth and USB devices. You may need to run as root or add your user to the `bluetooth` group.
- On Linux, grant NET_RAW capability to Node.js if you see BLE errors:
  ```bash
  sudo setcap cap_net_raw+eip $(readlink -f $(which node))
  ```
- Make sure Bluetooth is unblocked and powered on:
  ```bash
  rfkill unblock bluetooth
  sudo hciconfig hci0 up
  ```

See the Troubleshooting section below for more details on BLE and device access issues.


## Troubleshooting
- For Linux kernel 6.x, set `USE_CUSTOM_NOBLE=true` to enable compatibility
- If BLE adapter is unauthorized, run with sudo or set NET_RAW capability:
  - `sudo setcap cap_net_raw+eip $(readlink -f $(which node))`
- Ensure Bluetooth is unblocked and powered on:
  - `rfkill unblock bluetooth`
  - `sudo hciconfig hci0 up`
- For Zenoh, ensure the router is running locally or via Docker



## Environment Variables

Below is a comprehensive list of environment variables, grouped by function. 

**For Docker usage:** All variables should be set in `config/config.ini` under the `[env]` section.  
**For local development:** Set variables in your shell or use npm scripts with inline variables (e.g., `ZENOH_ENABLE=1 npm run sensors`).

### Audio / RTSP

| Variable           | Description                                 | Default                | Example/Values           |
|--------------------|---------------------------------------------|------------------------|--------------------------|
| `RTSP_URL`         | RTSP destination for microphone             | `rtsp://127.0.0.1:8554/mic` | `rtsp://...`      |
| `SAMPLE_RATE`      | Microphone sample rate (Hz)                 | `16000`                | `8000`, `16000`          |
| `CHANNELS`         | Audio channels                              | `1`                    | `1`, `2`                 |
| `SAMPLE_FORMAT`    | PCM format for FFmpeg                       | `s16le`                | `s16le`, `s8`            |
| `AUDIO_BITRATE`    | OPUS bitrate for RTSP                       | `64k`                  | `64k`, `128k`            |
| `FFMPEG_PATH`      | FFmpeg binary path                          | `ffmpeg`               | `/usr/bin/ffmpeg`        |
| `FFMPEG_LOGLEVEL`  | FFmpeg verbosity                            | `error`                | `info`, `warning`        |
| `TEST_MODE`        | If `1`, saves audio to `test_output.wav`    | `0`                    | `1`                      |
| `BIT_DEPTH`        | Audio bit depth                             | `16`                   | `8`, `16`                |

### Device Discovery / Connection

| Variable           | Description                                 | Default   | Example/Values                |
|--------------------|---------------------------------------------|-----------|------------------------------|
| `USE_CUSTOM_NOBLE` | Use custom Noble for Linux kernel 6.x       | `false`   | `true`, `1`                  |
| `DEVICE_ID`        | Filter by Bluetooth MAC address             | -         | `CE:59:C3:0F:4D:C9`          |
| `DEVICE_NAME`      | Filter by device name                       | -         | `BrilliantSole`              |
| `MIC_DEVICE_ID`    | Filter by Bluetooth ID for microphone       | -         | `CE:59:C3:0F:4D:C9`          |
| `MIC_DEVICE_NAME`  | Filter by device name for microphone        | -         | `BrilliantSole`              |
| `MIC_CONNECT_ONLY` | If `1`, connect but don't start microphone  | `0`       | `1`                          |

### Sensors

| Variable                    | Description                                 | Default | Example/Values              |
|-----------------------------|---------------------------------------------|---------|----------------------------|
| `ENABLED_SENSORS`           | Comma-separated list of sensors             | -       | `acceleration,gyroscope`    |
| `SENSOR_SAMPLE_RATE`        | Default rate for all sensors (Hz)           | `50`    | `100`                      |
| `ACCELERATION_RATE`         | Acceleration sensor rate (Hz)               | `50`    | `100`                      |
| `GYROSCOPE_RATE`            | Gyroscope sensor rate (Hz)                  | `50`    | `100`                      |
| `MAGNETOMETER_RATE`         | Magnetometer sensor rate (Hz)               | `50`    | `100`                      |
| `ORIENTATION_RATE`          | Orientation sensor rate (Hz)                | `50`    | `100`                      |
| `TAP_DETECTOR_RATE`         | Tap detector rate (Hz)                      | `50`    | `100`                      |
| `LINEAR_ACCELERATION_RATE`  | Linear acceleration rate (Hz)               | `50`    | `100`                      |
| `GAME_ROTATION_RATE`        | Game rotation rate (Hz)                     | `50`    | `100`                      |
| `ROTATION_RATE`             | Rotation rate (Hz)                          | `50`    | `100`                      |

### Zenoh

| Variable | Description | Default |
|----------|-------------|---------|
| `MESSAGE_TRANSPORT` | Select `mqtt`, `zenoh`, or `none`; overrides legacy enable flags | _(unset)_ |
| `ZENOH_ENABLE` | Legacy Zenoh selection | `1` |
| `ZENOH_KEY_PREFIX` | Sensor topic prefix | `bsole/sensors` |
| `ZENOH_ATTACH_ALL` | Publish all enabled sensors | `1` |
| `ZENOH_MIC_ENABLE` | Enable microphone publishing | `1` (if ZENOH_ENABLE=1) |
| `ZENOH_MIC_KEY_PREFIX` | Microphone topic prefix | `bsole/microphone` |
| `ZENOH_MIC_RAW_ENABLE` | Publish raw audio data | `0` |
| `ZENOH_MIC_RAW_THROTTLE_MS` | Throttle raw audio (ms) | `200` |
| `ZENOH_CAMERA_ENABLE` | Enable camera publishing | `1` (if ZENOH_ENABLE=1) |
| `ZENOH_CAMERA_KEY_PREFIX` | Camera topic prefix | `bsole/camera` |
| `ZENOH_CAMERA_RAW_ENABLE` | Publish raw image data | `1` |
| `ZENOH_RAW_CHUNK_SIZE` | Chunk size for raw data | `30000` |
| `ZENOH_UDS_PATH` | Unix socket path for sidecar | `/tmp/bsole-zenoh.sock` |

### Camera

| Variable                | Description                                 | Default   | Example/Values             |
|-------------------------|---------------------------------------------|-----------|---------------------------|
| `CAMERA_OUTPUT_DIR`     | Directory to save images                    | -         | `./images`                |
| `CAMERA_AUTO_PICTURE`   | Enable continuous capture mode              | `0`       | `1`                       |
| `CAMERA_AUTO_DELAY`     | Delay between captures in auto mode (ms)    | `0`       | `1000`, `2000`            |
| `CAMERA_AUTO_FOCUS`     | Auto-focus before each capture              | `1`       | `0` (disable)             |
| `CAMERA_IMAGE_FORMAT`   | File extension for images                   | `jpg`     | `jpg`, `png`              |
| `CAMERA_QUALITY`        | Legacy quality setting                      | -         | `80`                      |
| `CAMERA_RESOLUTION`     | Square frame size (e.g., 300x300)           | `640`     | `300`, `1280`             |
| `CAMERA_QUALITY_FACTOR` | Quality factor (1..100)                     | `95`      | `80`, `100`               |
| `CAMERA_SHUTTER`        | Shutter/exposure setting                    | -         | `auto`, `100`             |
| `CAMERA_GAIN`           | Overall gain                                | -         | `1.5`                     |
| `CAMERA_RED_GAIN`       | Red channel gain                            | -         | `1.2`                     |
| `CAMERA_GREEN_GAIN`     | Green channel gain                          | -         | `1.1`                     |
| `CAMERA_BLUE_GAIN`      | Blue channel gain                           | -         | `1.3`                     |
| `CAMERA_VIEW_ENABLE`    | Enable browser viewer                       | `0`       | `1`                       |
| `CAMERA_VIEW_HOST`      | Viewer host                                 | `127.0.0.1` | `0.0.0.0`               |
| `CAMERA_VIEW_PORT`      | Viewer port                                 | `8099`    | `8080`                    |
| `CAMERA_VIEW_MJPEG`     | Use MJPEG stream at /stream.mjpg            | `0`       | `1`                       |
| `CAMERA_DEBUG`          | Enable verbose camera logging               | `0`       | `1`                       |

### Display

| Variable         | Description                | Default | Example |
|------------------|---------------------------|---------|---------|
| `DISPLAY_TIMING` | Log display timing         | `0`     | `1`     |

### Whisper (Speech-to-Text)

Defaults are set in `config/whisper.ini`. See [whisper/README.md](whisper/README.md) for full details.

| Variable | Default | Description |
| --- | --- | --- |
| `WHISPER_MODEL` | `tiny` | Model size: `tiny` `base` `small` `medium` `large-v3` |
| `WHISPER_DEVICE` | `cpu` | `cpu`, `cuda`, or `auto` |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8`, `float16`, `float32` |
| `WHISPER_LANGUAGE` | _(empty)_ | BCP-47 language code or empty for auto-detect |
| `WHISPER_AUTODETECT_WINDOWS` | `3` | Windows to sample before locking language |
| `WHISPER_AUTODETECT_EVERY` | `0` | Re-detect every N windows; `0` = lock forever |
| `WHISPER_WINDOW_S` | `5` | Seconds of audio per inference window |
| `WHISPER_OVERLAP` | `0` | Overlap fraction between windows (0–0.9) |
| `WHISPER_NO_SPEECH_THRESHOLD` | `0.6` | Drop windows where all segments exceed this no-speech probability |
| `WHISPER_WORD_TIMESTAMPS` | `0` | Set to `1` for per-word timing in payload |
| `WHISPER_PUB_KEY` | `bsole/whisper/transcript` | Zenoh key for transcript output |
| `ZENOH_SUB_MIC` | `bsole/microphone/raw/**` | Zenoh key expression to subscribe to |
| `ZENOH_ROUTER` | `tcp/127.0.0.1:7447` | Zenoh router endpoint |
| `MQTT_ENABLE` | `0` | Set to `1` to use MQTT instead of Zenoh |
| `MQTT_BROKER` | `localhost` | MQTT broker host |
| `MQTT_PORT` | `1883` | MQTT broker port |

### YOLO (Object Detection)

Defaults are set in `config/yolo.ini`. See [yolo/README.md](yolo/README.md) for full details.

| Variable | Default | Description |
| --- | --- | --- |
| `YOLO_MODEL` | `yolov8n.pt` | Model file: `yolov8n`, `yolov8s`, `yolov8m`, `yolov8l`, `yolov8x` |
| `YOLO_DEVICE` | `cpu` | `cpu`, `cuda`, or `mps` |
| `YOLO_CONFIDENCE` | `0.5` | Minimum detection confidence (0–1) |
| `YOLO_IOU` | `0.45` | NMS IOU threshold (0–1) |
| `YOLO_INPUT_SIZE` | `320` | Inference image size in pixels (multiple of 32) |
| `YOLO_CLASSES` | _(empty)_ | Comma-separated COCO class IDs; empty = all 80 |
| `YOLO_PUB_KEY` | `bsole/yolo/detections` | Zenoh key for detection output |
| `ZENOH_SUB_CAMERA` | `bsole/camera/raw/**` | Zenoh key expression to subscribe to |
| `ZENOH_ROUTER` | `tcp/127.0.0.1:7447` | Zenoh router endpoint |
| `MQTT_ENABLE` | `0` | Set to `1` to use MQTT instead of Zenoh |
| `MQTT_BROKER` | `localhost` | MQTT broker host |
| `MQTT_PORT` | `1883` | MQTT broker port |

---

For more details, see the README in each subfolder.
