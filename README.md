# WearMux Headless

WearMux Headless is the unattended Node.js host of the **WearMux** wearable toolchain. It connects heterogeneous Brilliant Wear / BrilliantSole-compatible devices over BLE or Wi-Fi, exposes modality-oriented camera, microphone, sensor, and display functions, and can forward data to local or distributed consumers through MQTT or Zenoh.

## Repository layout

```text
wearmux-headless/
├── camera/                 Camera capture and viewer
├── config/                 INI and Zenoh configuration files
├── display/                Display rendering and upload
├── examples/               Interaction and latency examples
├── microphone/             Audio monitoring, recording, RTSP
├── sensors/                Sensor acquisition and ML utilities
├── tools/                  Launcher, Wi-Fi setup, MQTT/Zenoh helpers
├── utils/                  Device, transport, and configuration abstractions
├── whisper/                Optional speech-to-text consumer
├── yolo/                   Optional object-detection consumer
├── Dockerfile
├── docker-compose.yml
├── package.json
└── SOURCE_SNAPSHOT.md      Provenance of this public snapshot
```

## Requirements

For the core Node.js host:

- Node.js 18 or newer (Node.js 20 is used by the Docker image and CI).
- A supported Brilliant Wear / BrilliantSole-compatible wearable.
- BLE support through the host OS, or a device reachable over Wi-Fi.

For Linux BLE operation, BlueZ and the native Bluetooth development libraries are typically required. For audio streaming, install FFmpeg. Python 3 is needed only for the Zenoh sidecars and optional Whisper/YOLO services.

### Install

After cloning the repository:

```bash
cd wearmux-headless
npm ci
```

The `brilliantsole` dependency currently pulls a public Noble fork from GitHub. The lockfile in this snapshot uses HTTPS so that an SSH key is not required. If a locally regenerated lockfile switches the dependency back to an SSH Git URL, configure Git to rewrite GitHub SSH URLs to HTTPS before reinstalling.

## Configuration

Runtime settings are split across `config/*.ini`. `config/config.ini` selects which npm scripts are launched; the remaining files provide modality and transport defaults.

The launcher loads the configuration directory by default:

```bash
npm start
```

To use another configuration file or directory:

```bash
node tools/launcher.js --config /path/to/config
```

or set:

```bash
WEARMUX_CONFIG_PATH=/path/to/config npm start
```

`BSOLE_CONFIG_PATH` remains accepted as a backward-compatible alias for earlier development snapshots.

Environment variables override values loaded from the INI files. This is useful for selecting a device or changing a transport without editing tracked configuration:

```bash
DEVICE_NAME="<advertised-device-name>" npm run sensors
DEVICE_IP=192.168.1.100 DEVICE_TRANSPORT=udp npm run camera
```

The Bluetooth addresses in `config/bluetooth.ini` are intentionally placeholders. Replace them with identifiers from your own devices if ID-based filtering is required.

## Quick start

### Sensors

```bash
npm run sensors
```

Enable a specific set and rate in `config/sensors.ini` or through environment variables, for example:

```bash
ENABLED_SENSORS=linearAcceleration,gyroscope \
LINEAR_ACCELERATION_RATE=25 \
GYROSCOPE_RATE=25 \
npm run sensors
```

### Camera

```bash
npm run camera
```

Camera defaults are in `config/camera.ini`. Images can be saved locally by setting `CAMERA_OUTPUT_DIR`; the browser/MJPEG viewer is controlled through `CAMERA_VIEW_*` settings. See [camera/README.md](camera/README.md).

### Microphone

```bash
npm run microphone:rtsp
npm run microphone:record
```

See [microphone/README.md](microphone/README.md).

### Display

```bash
npm run display -- ./display/assets/collision_warning_8c.png
```

See [display/README.md](display/README.md).

### Wi-Fi provisioning

```bash
WIFI_SSID="<ssid>" WIFI_PASSWORD="<password>" npm run wifi:setup
```

Credentials are read from the environment and are not tracked by the repository.

## Distributed data transport

WearMux Headless can publish data through Zenoh or MQTT. The existing development protocol uses `bsole/...` as its default key/topic namespace; this has been retained in the public snapshot to avoid changing the wire protocol. Prefixes are configurable through the `ZENOH_*`, `MQTT_*`, and modality-specific environment variables.

Typical streams include:

- `bsole/sensors/...`
- `bsole/microphone/...`
- `bsole/camera/...`
- `bsole/whisper/...`
- `bsole/yolo/...`

Start the bundled Zenoh router with:

```bash
docker compose up zenoh-router
```

For distributed sensor inference, see [sensors/inference/README.md](sensors/inference/README.md).

## Optional processing services

The `whisper/` and `yolo/` directories are auxiliary consumers of the acquisition streams. They are useful examples of distributed processing, but they are not presented here as exact reproductions of every processing benchmark in the WearMux paper.

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt

npm run whisper:runner
npm run yolo:runner
```

Detailed configuration is in [whisper/README.md](whisper/README.md) and [yolo/README.md](yolo/README.md).

## Edge Impulse and TFLite utilities

The `sensors/` tree contains utilities for collecting labeled motion data, running Edge Impulse WebAssembly exports, and invoking a TFLite model through the wearable SDK. The bundled model/configuration should be treated as an example artifact rather than an assertion that it is the exact classifier configuration reported for every paper experiment.

The activity-inference experiment described in the manuscript used Edge Impulse and is linked from the paper to the corresponding public Edge Impulse project:

- <https://studio.edgeimpulse.com/public/937255/live>

See [sensors/README.md](sensors/README.md) and [sensors/model/README.md](sensors/model/README.md).

## Docker

The release snapshot uses public container images; it does not require access to the original institutional registry.

Build the main image:

```bash
docker build -t wearmux-headless .
```

Or start selected services with Compose:

```bash
docker compose up zenoh-router wearmux
```

BLE access from containers is platform-dependent. The Compose file uses host networking/privileged access for the main wearable host as a pragmatic Linux default; review those permissions for your deployment.
