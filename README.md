# WearMux Headless

Node.js tooling to connect to Brilliant Wear devices and exchange modality data and device actions over MQTT or Zenoh. Optional consumer examples show how to run speech-to-text and object detection on another process or machine.

The default `sessions` runtime discovers nearby compatible devices and keeps one connection per device. Each session starts the sensors, camera, and microphone that its SDK capabilities support, and accepts display or haptic actions when available. Multiple devices can publish to the same MQTT or Zenoh topics; modality payloads carry a device ID.

## Project Structure

The project has been organized with clear separation of concerns:

```
wearmux-headless/
├── config/
│   ├── config.ini                  # App configuration (for Docker)
│   ├── peer.json5                  # Zenoh peer configuration
│   ├── peer.docker.json5           # Zenoh peer configuration (for Docker)
│   └── router.json5                # Zenoh router configuration
├── display/
│   ├── index.js                    # Show images on device display
│   └── lib/display-manager.js      # Display rendering & tiling
├── interactions/
│   └── vru-stop-request/           # Prompt display and nod/shake response adapter
│       ├── index.js                 # Prompt state machine and MQTT response
│       ├── message-display.js       # Display actions on a device session
│       └── nod-detector.js          # Orientation-window nod/shake detector
├── actions/
│   └── index.js                    # Standalone device action receiver
├── microphone/
│   ├── index.js                    # Standalone microphone command
│   ├── record-audio.js             # Record audio to WAV file
│   └── lib/
│       ├── audio-utils.js          # Audio format utilities
│       ├── microphone-session.js   # Microphone on a shared device session
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
│   ├── index.js                    # Standalone camera command
│   └── lib/
│       ├── camera-session.js       # Camera on a shared device session
│       ├── image-validator.js      # Image validation utilities
│       └── viewer-server.js        # HTTP/MJPEG browser viewer
├── examples/
│   ├── car-interaction/            # Car interaction example + tests
│   ├── latency-evaluation/         # Display-to-camera latency evaluation example
│   └── consumers/                  # Optional off-device consumer adapters
│       ├── whisper/                # Speech-to-text example and dependencies
│       ├── yolo/                   # Object detection example and dependencies
│       └── README.md               # Message contract and deployment guide
├── tools/
│   ├── launcher.js                 # Config parser and script launcher
│   ├── sessions.js                 # Multi-device session runtime
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
│   ├── device-fleet.js             # Discovery and concurrent sessions
│   ├── device-session.js           # Per-device capability ownership
│   ├── raw-media.js                # Shared camera/audio chunk publishing
│   ├── mqtt-manager.js             # MQTT publisher
│   ├── mqtt-subscriber.js          # MQTT subscriber
│   ├── transport.js                # Transport abstraction (Zenoh/MQTT)
│   ├── topics.js                   # Shared topic root and names
│   ├── action-dispatcher.js        # Route incoming actions to device outputs
│   ├── zenoh-manager.js            # Node→Python sidecar bridge (UDS)
│   └── zenoh-subscriber.js         # Zenoh subscriber helper
├── docker-compose.yml              # Docker for Linux
├── requirements.txt                 # Core Zenoh bridge dependencies only
├── package.json
└── README.md
```


## Prerequisites

### Linux
- Node.js 22.16+
- Python 3.9+ (for Zenoh only)
- Bluetooth adapter with BlueZ

### Windows
- Node.js 22.16+
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

# Discover all nearby compatible devices and start their capabilities
npm run sessions

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
```

`npm start` and Docker Compose use the same session runtime through `config/config.ini`. Leave `DEVICE_ID` and `DEVICE_NAME` unset to connect multiple devices. The standalone `sensors`, `camera`, `microphone:rtsp`, and `actions` commands remain useful for focused single-device work; do not run them beside `sessions` against the same BLE device. Standalone camera and microphone commands use the same capture and streaming code as device sessions.

For off-device inference, see the [consumer guide](examples/consumers/README.md). Whisper and YOLO are optional examples with separate Python dependencies; the default Docker build does not install or start them.


## Features

### 🎤 Audio Streaming
- **Real-time RTSP streaming** at 8kHz or 16kHz
- **Recording** to WAV files with configurable quality
- **Audio level monitoring** via MQTT or Zenoh
- Supports multiple concurrent listeners

### 📊 Sensor Monitoring
- **Motion sensors**: acceleration, gyroscope, magnetometer
- **Activity detection**: step counting, activity classification
- **ML gesture recognition**: powered by Edge Impulse models
- Real-time data publishing via MQTT or Zenoh

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

## VRU stop-request interaction

The VRU stop-request handler owns DENM matching and response-event generation.
WearMux displays its question, listens to the selected device session's orientation
sensor, and returns a prompt-bound yes/no answer. A nod maps to yes (continue
stopping); a shake maps to no (the handler publishes its existing response event).

```mermaid
sequenceDiagram
    participant H as Python VRU handler
    participant B as MQTT broker
    participant I as WearMux VRU interaction
    participant D as Message Display
    participant N as Nod Detector
    participant S as WearMux DeviceSession
    participant E as EventResponse
    participant T as Notification service

    H->>B: Publish bwear/vru/prompt with prompt_id
    B-->>I: Deliver prompt
    I->>D: Show question
    D->>S: display.text / display.clear
    I->>N: Start detection for prompt_id
    S-->>N: orientation sensor events
    N-->>I: nod or shake
    I->>B: Publish bwear/vru/answer with same prompt_id
    B-->>H: Deliver normalized answer
    H->>E: Respond to the original event
    E->>B: Publish existing DENM response event on denm/events/vru
    B-->>T: Deliver response event
```

Enable the adapter in the sessions runtime with
`VRU_INTERACTION_ENABLED=1`, and run WearMux with
`MESSAGE_TRANSPORT=mqtt` and the same broker endpoint as the Python handler.
For a handler and WearMux runtime on the same host:

```bash
VRU_INTERACTION_ENABLED=1 MESSAGE_TRANSPORT=mqtt MQTT_BROKER_URL=mqtt://127.0.0.1:1883 npm run sessions
```

The handler's `config.ini` uses `bwear/vru/prompt` and
`bwear/vru/answer`, a 15 second answer timeout, and manual-answer mode. Set
`VRU_DEVICE_ID` when more than one connected display/orientation device could
answer. An explicit `ENABLED_SENSORS` list is augmented with orientation while
the adapter is enabled. If `TOPIC_PREFIX` changes from `bwear`, update both
handler topics to use that same root.

The detector uses a configurable orientation-window heuristic because this
checkout has no Edge Impulse nod/shake model. Defaults can be tuned with
`VRU_GESTURE_WINDOW_MS`, `VRU_NOD_THRESHOLD_DEG`,
`VRU_SHAKE_THRESHOLD_DEG`, and `VRU_GESTURE_DEADBAND_DEG`. Timeout sends no
answer, so the Python handler applies its existing timeout policy. A wearable
handles one prompt at a time; prompts received while it is busy are ignored and
expire through the handler's normal timeout path.

### 🧠 Optional consumer examples

#### Speech-to-Text (Whisper)

- **Real-time transcription** via [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- Subscribes to `bwear/microphone/raw/**` — works with the existing mic pipeline
- Publishes transcripts to `bwear/whisper/transcript` (Zenoh or MQTT)
- **Automatic language detection** with majority-vote locking across windows
- **No-speech filtering** suppresses silent-window hallucinations
- Configurable window size, overlap, model size, and compute type
- See the [Whisper example](examples/consumers/whisper/README.md) for setup and configuration

#### Object Detection (YOLO)

- **Real-time detection** via [Ultralytics YOLOv8](https://docs.ultralytics.com/)
- Subscribes to `bwear/camera/raw/**` — works with the existing camera pipeline
- Publishes detections to `bwear/yolo/detections` (Zenoh or MQTT)
- Configurable model size (n/s/m/l/x), confidence threshold, IOU, and class filter
- Detection payload includes bounding boxes, class names, and confidence scores
- See the [YOLO example](examples/consumers/yolo/README.md) for setup and configuration


## Messaging and reverse actions

WearMux Headless uses one messaging transport at a time. Set `MESSAGE_TRANSPORT=mqtt`, `zenoh`, or `none`; `config/config.ini` selects Zenoh by default. MQTT uses `mqtt://127.0.0.1:1883` unless `MQTT_BROKER_URL` is set. No action-specific configuration is required.

The default topic root for both transports is `bwear/`. Set `TOPIC_PREFIX` only when all publishers and subscribers need another root. Update external publishers and subscribers to use the selected root, including its `actions` and `actions/result` topics.

For existing configurations, replace `MQTT_ENABLE` or `ZENOH_ENABLE` with `MESSAGE_TRANSPORT`, and replace transport-specific topic prefixes with `TOPIC_PREFIX`. Raw media publishing uses `MIC_RAW_ENABLE` and `CAMERA_RAW_ENABLE`. Set these in `config/` or your shell; the old flags are no longer read.

The default `npm run sessions` command publishes data from every connected device and listens for actions on one shared subscription. The `npm run sensors` command publishes sensor data and listens for actions on its single device connection. `npm run actions` is a standalone single-device action receiver.

Applications publish a JSON object to `bwear/actions`. The action receiver publishes a result to `bwear/actions/result` with the same `id`, an `ok` flag, device identity, and timestamp. `ok` means the device SDK accepted the action call; it does not confirm that the wearer perceived the output. Failed actions also include an `error`. An optional `deviceId` targets one connected device. Supported actions are:

In the session runtime, an action without `deviceId` goes to the sole connected device with that capability. If several devices support it, the result asks for `deviceId` instead of sending the action to every device. A device-specific command uses the ID reported on `bwear/devices/status` or in modality messages.

| Action | Fields | Effect |
| --- | --- | --- |
| `display.text` | `text` | Show up to 500 characters on a device display |
| `display.clear` | — | Clear the device display |
| `display.image` | `data` | Show a base64 PNG or JPEG, up to 1 MiB |
| `haptic.vibrate` | optional `effect`, `locations` | Trigger a supported SDK vibration effect; defaults to `strongClick100` |

Use the included sender to publish an action and print its result:

```bash
# Default Zenoh configuration; run `npm run sessions` in another terminal first.
npm run actions:send -- '{"action":"display.text","text":"Hello"}'

# Target a specific wristband when more than one device can vibrate.
npm run actions:send -- '{"action":"haptic.vibrate","deviceId":"<wristband-id>"}'

# MQTT, with `npm run mqtt:broker` running in another terminal.
MESSAGE_TRANSPORT=mqtt npm run sessions
MESSAGE_TRANSPORT=mqtt npm run actions:send -- '{"action":"haptic.vibrate"}'
```

The transport sends modality data from the device to applications. The reverse path is `bwear/actions` → subscriber → action dispatcher → device display or haptics. The result topic lets an application distinguish an accepted command from one the device could not perform.

## Published data topics

MQTT and Zenoh publish the same logical topics and JSON payloads. For Zenoh, the Node.js connector uses a Python sidecar (`tools/zenoh_py_publisher.py`) over a Unix domain socket with MessagePack framing.

### Published Topics

#### Sensors (`bwear/sensors/`)
When messaging is enabled, all enabled sensors are automatically published:
- **`bwear/sensors/acceleration`** - 3-axis acceleration data (x, y, z in m/s²)
- **`bwear/sensors/gyroscope`** - 3-axis gyroscope data (x, y, z in rad/s)
- **`bwear/sensors/magnetometer`** - 3-axis magnetometer data (x, y, z in μT)
- **`bwear/sensors/orientation`** - Euler angles (heading, pitch, roll in degrees)
- **`bwear/sensors/linearAcceleration`** - Linear acceleration without gravity
- **`bwear/sensors/gameRotation`** - Game rotation quaternion
- **`bwear/sensors/rotation`** - Rotation quaternion
- **`bwear/sensors/tapDetector`** - Tap detection events

Each message includes:
```json
{
  "ts": 1234567890,
  "sensor": "acceleration",
  "device": { "id": "CE:59:C3:0F:4D:C9", "name": "BrilliantFrame" },
  "message": { "timestamp": 1234567890, "sensorType": "acceleration", "acceleration": { "x": 0.1, "y": 0.2, "z": 9.8 } }
}
```

#### Microphone (`bwear/microphone/`)
When messaging is enabled and a connected device has a microphone:
- **`bwear/microphone/status`** - Microphone connection status
- **`bwear/microphone/level`** - Real-time audio level (RMS, peak, timestamp)
- **`bwear/microphone/raw/meta`** - Raw audio metadata (when `MIC_RAW_ENABLE=1`)
- **`bwear/microphone/raw/chunk`** - Raw audio data chunks in base64 (when `MIC_RAW_ENABLE=1`)

#### Camera (`bwear/camera/`)
When messaging is enabled and a connected device has a camera:
- **`bwear/camera/image`** - Image metadata (timestamp, filename, dimensions, etc.)
- **`bwear/camera/raw/meta`** - Raw image metadata (when `CAMERA_RAW_ENABLE=1`)
- **`bwear/camera/raw/chunk`** - Raw image data chunks in base64 (when `CAMERA_RAW_ENABLE=1`)

#### Device sessions (`bwear/devices/`)
- **`bwear/devices/status`** - Connection status and discovered capabilities for each device

With multiple cameras, the browser viewers use consecutive ports starting at `CAMERA_VIEW_PORT` (8099 by default), in connection order. A second microphone RTSP stream uses the configured path with `-1` appended, and so on. Media frame IDs include the source device ID so consumer adapters can distinguish simultaneous streams.

#### Whisper (`bwear/whisper/`)

Published by the optional [Whisper consumer](examples/consumers/whisper/README.md) when running:

- **`bwear/whisper/transcript`** - Transcription result per audio window

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

#### YOLO (`bwear/yolo/`)

Published by the optional [YOLO consumer](examples/consumers/yolo/README.md) when running:

- **`bwear/yolo/detections`** - Object detection results per camera frame

```json
{
  "ts": 1748198400000,
  "frameId": "abc123",
  "inference_ms": 45.2,
  "image_w": 320,
  "image_h": 240,
  "model": "yolov8n",
  "device": "cpu",
  "detections": [
    { "class": "person", "class_id": 0, "confidence": 0.9213, "x1": 10.0, "y1": 20.0, "x2": 150.0, "y2": 200.0 }
  ]
}
```

### Configuration

See [Messaging](#messaging) for the shared transport settings and the [consumer guide](examples/consumers/README.md) for the payload contract.

### Python Helpers

- **`tools/zenoh_py_publisher.py`** - Sidecar process that receives data via UDS and publishes to Zenoh
- **`tools/zenoh_py_subscriber.py`** - Example subscriber to receive published data

Example subscriber usage:
```bash
python3 tools/zenoh_py_subscriber.py --key "bwear/sensors/**"
```


## Docker

This project provides a `docker-compose.yml` for running WearMux Headless and its Zenoh router. Configuration is loaded from the INI files in `config/`. The Compose file does not build or start inference consumers.

### Quick Start

1. **Configure your settings:**
  - Edit `config/config.ini` for shared settings and startup scripts; use the module INI files for device settings
  - See the [Environment Variables](#environment-variables) section for all available options

2. **Build and start the container:**
  ```bash
  docker compose up --build
  ```

3. **Stop the container:**
  ```bash
  docker compose down
  ```

### Build on another machine

On a Raspberry Pi, the native Node.js dependencies can make the image build demanding. If the Pi loses power during a build, build the ARM64 image on another machine and publish it to a registry you can access. An ARM64 builder is preferable; an x86 builder can use Docker Buildx with ARM64 emulation.

```bash
docker buildx build --platform linux/arm64 \
  -t registry.example.com/wearmux-headless:arm64 --push .
```

On the Pi, set the image name to the same registry tag and start Compose without building:

```bash
export WEARMUX_IMAGE=registry.example.com/wearmux-headless:arm64
docker compose pull wearmux-headless
docker compose up --no-build
```

The Compose file also supports local builds. The Dockerfile uses the CodeNap `node:22-bookworm-slim` image for both build and runtime stages, matching the Node.js 22.16+ requirement declared by a locked dependency. To use another compatible base image, pass `docker build --build-arg NODE_BASE_IMAGE=...`.

### Configuration

The launcher reads the INI files in `config/`. Shared settings and the startup scripts are in `config/config.ini`:
- **`[env]` section**: Environment variables (device ID, sensors, Zenoh settings, etc.)
- **`[scripts]` section**: Scripts to run on startup (`sessions` by default)

Example `config/config.ini`:
```ini
[env]
MESSAGE_TRANSPORT=zenoh
# Optional: restrict which sensor types run on each capable device.
# ENABLED_SENSORS=acceleration,magnetometer,orientation

[scripts]
run=sessions
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

**For Docker usage:** Set shared variables in `config/config.ini` and module settings in their respective INI files.
**For local development:** Set variables in your shell or use npm scripts with inline variables (e.g., `MESSAGE_TRANSPORT=mqtt npm run sensors`).
Set `WEARMUX_CONFIG_PATH` to load a different configuration directory or INI file.

### Audio / RTSP

| Variable           | Description                                 | Default                | Example/Values           |
|--------------------|---------------------------------------------|------------------------|--------------------------|
| `RTSP_URL`         | RTSP publish URL; unset disables RTSP       | unset                  | `rtsp://host:8554/mic` |
| `SAMPLE_RATE`      | Microphone sample rate (Hz)                 | `16000`                | `8000`, `16000`          |
| `CHANNELS`         | Audio channels                              | `1`                    | `1`, `2`                 |
| `SAMPLE_FORMAT`    | PCM format for FFmpeg                       | `s16le`                | `s16le`, `f32le`         |
| `AUDIO_BITRATE`    | OPUS bitrate for RTSP                       | `64k`                  | `64k`, `128k`            |
| `FFMPEG_PATH`      | FFmpeg binary path                          | `ffmpeg`               | `/usr/bin/ffmpeg`        |
| `FFMPEG_LOGLEVEL`  | FFmpeg verbosity                            | `error`                | `info`, `warning`        |
| `BIT_DEPTH`        | Audio bit depth                             | `16`                   | `8`, `16`                |
| `RTSP_ENABLE`      | Set to `0` to disable a configured RTSP publisher | `1` when `RTSP_URL` is set | `0`, `1` |

### Device Discovery / Connection

| Variable           | Description                                 | Default   | Example/Values                |
|--------------------|---------------------------------------------|-----------|------------------------------|
| `DEVICE_ID`        | In `sessions`, restrict to one Bluetooth device; unset discovers all compatible devices | unset | Bluetooth ID |
| `DEVICE_NAME`      | Restrict discovery to one advertised device name | unset | `Brilliant Frame 12` |
| `MIC_DEVICE_ID`    | Legacy alias for `DEVICE_ID`                | unset     | Bluetooth ID                 |
| `MIC_DEVICE_NAME`  | Legacy alias for `DEVICE_NAME`              | unset     | `Brilliant Frame 12`         |

### Sensors

Rates accept a value in Hz or a period such as `20ms`; the SDK uses 5 Hz steps. Unset `ENABLED_SENSORS` lets the session runtime use each device's supported sensors.

| Variable                    | Description                                 | Default | Example/Values              |
|-----------------------------|---------------------------------------------|---------|----------------------------|
| `ENABLED_SENSORS`           | Restrict the session runtime to these sensor types | all supported | `acceleration,gyroscope` |
| `ACCELERATION_RATE`         | Acceleration sensor rate (Hz)               | `50`    | `100`                      |
| `GRAVITY_RATE`              | Gravity sensor rate (Hz)                    | `50`    | `100`                      |
| `GYROSCOPE_RATE`            | Gyroscope sensor rate (Hz)                  | `50`    | `100`                      |
| `MAGNETOMETER_RATE`         | Magnetometer sensor rate (Hz)               | `50`    | `100`                      |
| `ORIENTATION_RATE`          | Orientation sensor rate (Hz)                | `50`    | `100`                      |
| `TAP_DETECTOR_RATE`         | Tap detector rate (Hz)                      | `5`     | `10`                       |
| `LINEAR_ACCELERATION_RATE`  | Linear acceleration rate (Hz)               | `50`    | `100`                      |
| `GAME_ROTATION_RATE`        | Game rotation rate (Hz)                     | `50`    | `100`                      |
| `ROTATION_RATE`             | Rotation rate (Hz)                          | `50`    | `100`                      |
| `ACTIVITY_RATE`             | Activity classification rate (Hz)           | `5`     | `10`                       |
| `STEP_COUNTER_RATE`         | Step counter rate (Hz)                      | `5`     | `10`                       |
| `PRESSURE_RATE`             | Pressure sensor rate (Hz)                   | `50`    | `100`                      |

### Messaging

| Variable | Description | Default |
|----------|-------------|---------|
| `MESSAGE_TRANSPORT` | Select `mqtt`, `zenoh`, or `none` | `zenoh` (config.ini) |
| `TOPIC_PREFIX` | Root for all published and subscribed topics | `bwear` |
| `MQTT_BROKER_URL` | MQTT broker URL, including optional credentials and TLS | `mqtt://127.0.0.1:1883` |
| `ZENOH_ROUTER` | Zenoh router endpoint override | `config/peer.json5` |
| `MIC_RAW_ENABLE` | `1` publishes audio chunks; `0` leaves level/status messages only | `1` (audio.ini) |
| `CAMERA_RAW_ENABLE` | `1` publishes image chunks; `0` leaves metadata only | `1` (camera.ini) |
| `MIC_RAW_THROTTLE_MS` | Minimum interval between raw audio publishes | `200` |
| `RAW_CHUNK_SIZE` | Base64 characters per raw chunk | `30000` |

### Camera

| Variable                | Description                                 | Default   | Example/Values             |
|-------------------------|---------------------------------------------|-----------|---------------------------|
| `CAMERA_OUTPUT_DIR`     | Directory to save JPEG images               | unset     | `./images`                |
| `CAMERA_AUTO_PICTURE`   | `1` captures continuously; `0` captures once | `1` (camera.ini) | `0`, `1` |
| `CAMERA_AUTO_DELAY`     | Delay between continuous captures (ms)      | `0`       | `1000`, `2000`            |
| `CAMERA_AUTO_FOCUS`     | `1` focuses before capture; `0` skips focus  | `0` (camera.ini) | `0`, `1` |
| `CAMERA_CAPTURE_TIMEOUT_MS` | Maximum wait for a captured image (ms)   | `5000` (camera.ini) | `8000` |
| `CAMERA_FOCUS_IDLE_TIMEOUT_MS` | Maximum wait for focus to finish (ms) | `3000`   | `5000`                    |
| `CAMERA_MIN_IMAGE_BYTES` | Reject smaller camera candidates           | `3000` (camera.ini) | `0`, `5000` |
| `CAMERA_RESOLUTION`     | Device-supported numeric SDK resolution     | `480` (camera.ini) | numeric SDK value |
| `CAMERA_WIDTH`, `CAMERA_HEIGHT` | Legacy resolution fallback when `CAMERA_RESOLUTION` is unset | unset | numeric values |
| `CAMERA_QUALITY_FACTOR` | JPEG quality from 0 to 100                  | `60` (camera.ini) | `80`, `100` |
| `CAMERA_QUALITY`        | Legacy alias for `CAMERA_QUALITY_FACTOR`     | unset     | `80`                      |
| `CAMERA_RATE`           | Camera sensor rate; supported values depend on device | `5` | `10` |
| `CAMERA_COMMAND_TIMEOUT_MS` | Wait before continuing from a camera command (ms) | `3000` (camera.ini) | `5000` |
| `CAMERA_VIEW_ENABLE`    | `1` starts an HTTP browser viewer; `0` disables it | `1` (camera.ini) | `0`, `1` |
| `CAMERA_VIEW_HOST`      | Viewer bind address                         | `0.0.0.0` | `127.0.0.1`               |
| `CAMERA_VIEW_PORT`      | Viewer TCP port; more cameras use following ports | `8099` | `8080` |
| `CAMERA_VIEW_MJPEG`     | `1` streams MJPEG; `0` uses browser polling  | `1` (camera.ini) | `0`, `1` |
| `CAMERA_RAW_ENABLE`     | `1` publishes image chunks; requires MQTT or Zenoh | `1` (camera.ini) | `0`, `1` |
| `CAMERA_EXPOSURE`       | Device-specific numeric exposure value      | `168` (camera.ini) | device-supported value |
| `CAMERA_AUTO_EXPOSURE_ENABLED` | Numeric flag: `1` on, `0` off         | `0` (camera.ini) | `0`, `1` |
| `CAMERA_AUTO_WHITE_BALANCE_ENABLED`, `CAMERA_AUTO_GAIN_ENABLED` | Device-specific numeric flags | unset | `0`, `1` |
| `CAMERA_SHUTTER`, `CAMERA_GAIN`, `CAMERA_RED_GAIN`, `CAMERA_GREEN_GAIN`, `CAMERA_BLUE_GAIN` | Device-specific numeric controls | unset | device-supported values |
| `CAMERA_BRIGHTNESS`, `CAMERA_SATURATION`, `CAMERA_CONTRAST`, `CAMERA_SHARPNESS` | Device-specific numeric controls | unset | device-supported values |
| `CAMERA_LATENCY_MEASUREMENTS` | Number of images in the latency example | `500` (camera.ini) | positive integer |
| `CAMERA_LATENCY_OUTPUT` | Optional latency results JSON path | unset | `./logs/latency.json` |

### Display

| Variable | Description | Default | Example/Values |
|----------|-------------|---------|----------------|
| `DISPLAY_TIMING` | Log display transfer timing | `0` | `1` |
| `DISPLAY_KEEP_ALIVE` | Keep the display process alive after sending an image | `1` | `0`, `1` |
| `DISPLAY_PIXEL_DEPTH` | Color depth in bits per pixel | automatic | `1`, `2`, `4` |
| `DISPLAY_BRIGHTNESS` | Display brightness preset | device default | `veryLow`, `low`, `medium`, `high`, `veryHigh` |
| `DISPLAY_FIT` | How to fit the image to the display | `contain` | `contain`, `cover`, `fill`, `inside`, `outside` |
| `DISPLAY_ALIGN` | Image alignment | `center` | `top`, `bottom`, `left`, `right`, `center` |
| `DISPLAY_X`, `DISPLAY_Y` | Top-left image position in pixels | `0`, `0` | integer values |
| `DISPLAY_INPUT_HEIGHT`, `DISPLAY_OUTPUT_HEIGHT` | Image processing and device output heights | device default | positive pixel values |
| `DISPLAY_WIDTH`, `DISPLAY_HEIGHT` | Legacy size fallback | unset | positive pixel values |
| `DISPLAY_TILE_MAX_PIXELS` | Pixel limit per transmitted tile | `220` | positive integer |

Whisper and YOLO settings are documented with their optional [consumer examples](examples/consumers/README.md). They are not loaded by the main service.
