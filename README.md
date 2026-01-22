# BSole Connector

Node.js + Python tooling to connect to BrilliantSole devices, stream microphone audio, monitor sensors, and optionally publish data to Zenoh.

## Project Structure

The project has been organized with clear separation of concerns:

```
bsole-connector/
├── config/
│   ├── config.ini                  # App configuration (for Docker)
│   ├── peer.json5                  # Zenoh peer configuration
│   ├── peer.docker.json5           # Zenoh peer configuration (for Docker)
│   └── router.json5                # Zenoh router configuration
├── display/
│   ├── index.js                    # Show images on device display
│   └── lib/display-manager.js      # Display rendering & tiling
├── microphone/
│   ├── index.js                    # Microphone → RTSP publisher
│   └── lib/microphone-manager.js
├── sensors/
│   ├── index.js                    # Sensor monitor
│   └── lib/
│       ├── sensor-manager.js       # Device + sensor orchestration
│       ├── motion-sensors.js       # Motion handlers/utilities
│       └── activity-sensors.js     # Tap detector
├── tools/
│   ├── launcher.js                 # Config parser and script launcher
│   ├── zenoh_py_publisher.py       # Python sidecar: UDS→Zenoh publisher
│   └── zenoh_py_subscriber.py      # Python subscriber helper
├── utils/
│   ├── config.js                   # Env-driven config loader
│   ├── device-manager.js           # BLE connection
│   ├── stream-manager.js           # FFmpeg RTSP publisher
│   └── zenoh-manager.js            # Node→Python sidecar bridge (UDS)
├── docker-compose.yml              # Docker for Linux

## Camera capture (no ML)

This repo includes a simple camera capture utility (`CameraManager`) that connects to a BrilliantSole device and can show live images in a browser and optionally save them (no ML/AI processing).

- Single capture and exit:

   npm run camera

- Continuous auto-capture (poll as fast as possible):

   CAMERA_AUTO_PICTURE=1 npm run camera

Environment variables:

- CAMERA_OUTPUT_DIR: optional directory for saved images (if unset, images aren’t written to disk)
- CAMERA_AUTO_PICTURE: set to 1 to continuously poll the camera
- CAMERA_IMAGE_FORMAT: file extension to use (default: jpg)
- CAMERA_QUALITY: legacy quality setting (kept for compatibility)
- CAMERA_RESOLUTION: square frame size (e.g., 300 => 300x300)
- CAMERA_QUALITY_FACTOR: quality factor (1..100, device-dependent)
- CAMERA_SHUTTER: shutter/exposure setting (number or supported string)
- CAMERA_GAIN: overall gain
- CAMERA_RED_GAIN / CAMERA_GREEN_GAIN / CAMERA_BLUE_GAIN: per-channel gains
- CAMERA_VIEW_ENABLE: set to 1 to enable a lightweight browser viewer (default http://127.0.0.1:8099)
- CAMERA_VIEW_HOST / CAMERA_VIEW_PORT: viewer host/port
 - CAMERA_VIEW_MJPEG: set to 1 to use a true MJPEG stream at /stream.mjpg (lower latency)

Notes:

- Uses the same Noble-based connection as the microphone/sensors modules via `utils/device-manager.js`.
- Images are emitted as raw buffers from the SDK and saved directly without any processing.
- The browser viewer auto-refreshes the latest image. If you want a smoother MJPEG endpoint, I can add `/stream.mjpg`.
├── package.json
└── README.md
```

## Components

1. **Config** (`utils/config.js`)
   - Centralized configuration management
   - Environment variable handling

2. **DeviceManager** (`utils/device-manager.js`)
   - BrilliantSole device connection logic
   - BLE scanning and connection management

3. **SensorManager** (`sensors/lib/sensor-manager.js`)
   - Sensor data collection
   - Motion sensors (accelerometer, gyroscope, magnetometer)
   - Event sensors (tap detector)
   - Configurable sample rates and sensor selection

## Usage

### Environment variables

Audio / RTSP
- `RTSP_URL` (default `rtsp://127.0.0.1:8554/mic`): RTSP destination for microphone.
- `SAMPLE_RATE` (default `16000`): Microphone sample rate (Hz).
- `CHANNELS` (default `1`): Audio channels.
- `SAMPLE_FORMAT` (default `s16le`): PCM format forwarded to FFmpeg.
- `AUDIO_BITRATE` (default `64k`): OPUS bitrate for RTSP.
- `FFMPEG_PATH` (default `ffmpeg`): FFmpeg binary path.
- `FFMPEG_LOGLEVEL` (default `error`): FFmpeg verbosity.
- `TEST_MODE` (default `0`): If `1`, saves audio to `test_output.wav` instead of RTSP.

Device discovery / connection
- `USE_CUSTOM_NOBLE` (default `false`): Set to `true` or `1` to use custom Noble implementation for Linux kernel 6.x compatibility. Required on Linux with kernel 6.x due to `@abandonware/noble` incompatibility.
- `DEVICE_ID` (optional): Filter by Bluetooth MAC address (e.g., `CE:59:C3:0F:4D:C9`). If not set, auto-discovers first BrilliantSole device.
- `DEVICE_NAME` (optional): Filter by device name when scanning. If not set, matches any BrilliantSole device.
- `MIC_DEVICE_ID` (optional):  Filter by Bluetooth ID when scanning.
- `MIC_DEVICE_NAME` (optional):  Filter by device name when scanning.
- `MIC_CONNECT_ONLY` (default `0`):  If `1`, connect to device but don't start microphone.

Sensors
- `ENABLED_SENSORS` (optional): Comma-separated list. If unset, the CLI enables common sensors.
   - Example: `acceleration,gyroscope,magnetometer,orientation,tapDetector`
- `SENSOR_SAMPLE_RATE` (default `50` Hz): Default rate used by the SDK for supported sensors.
- Per-sensor rate overrides (Hz or `<ms>ms`, rounded to nearest 5 Hz):
   - `ACCELERATION_RATE`, `GYROSCOPE_RATE`, `MAGNETOMETER_RATE`, `ORIENTATION_RATE`,
   - `TAP_DETECTOR_RATE`, `LINEAR_ACCELERATION_RATE`, `GAME_ROTATION_RATE`, `ROTATION_RATE`.

Zenoh (optional)
- `ZENOH_ENABLE`: Enable Zenoh publishing (default: `0`)
- `ZENOH_KEY_PREFIX`: Key prefix for topics (default: `bsole/sensors`)
- `ZENOH_ATTACH_ALL`: Automatically attach and publish all enabled sensors (default: `1`)

Transport between Node and Python sidecar is Unix Domain Socket + MessagePack by default. Socket path is fixed at `/tmp/bsole-zenoh.sock`.
Note: BLE is supported via Noble only. WebBluetooth has been removed.

### Running the application

```bash
## Install dependencies
npm install

# Microphone → RTSP
npm run microphone:rtsp

# Clean sensor monitor (use ENABLED_SENSORS and per-sensor *_RATE envs)
npm run sensors

# Display an image on the device display
npm run display -- path/to/image.png

# Example: sensors with custom rates
ENABLED_SENSORS="orientation,acceleration" ORIENTATION_RATE=5 ACCELERATION_RATE=10 npm run sensors
````

## Zenoh: Publish sensor data

This project publishes sensor data to Zenoh keys at `bsole/sensors/<sensor>` using a small Python sidecar that connects to a local zenohd over TCP.

Steps:
- Run a zenoh router locally (zenohd) listening on TCP. Default: `tcp/127.0.0.1:7447`.
- Run sensors with Zenoh enabled:

```
ZENOH_ENABLE=1 npm run sensors
```

Quick verification in another terminal with the Python subscriber provided here:

```bash
python3 -u tools/zenoh_py_subscriber.py "bsole/sensors/**"
```

Payload structure:

```
{
   ts: 1690000000000,
   sensor: "acceleration",
   device: { id, name },
   message: { ...event.message if present... }
}
```

## Running Docker

Notes:
- This uses host networking, privileged mode, NET_ADMIN/NET_RAW caps, seccomp:unconfined, and passes the USB bus to the container. Adjust devices mapping to your host.
- You may also need to ensure the container user has access to Bluetooth groups, e.g., via `--group-add` or running as root (default).
- If you don’t need BLE in Docker, stick to the default compose which avoids extra privileges.

Linux BLE troubleshooting (e.g., Raspberry Pi):
- If you see "adapter state unauthorized", run with sudo/root or grant NET_RAW capability to Node:
   - `sudo setcap cap_net_raw+eip $(readlink -f $(which node))`
- Ensure the adapter is unblocked and up:
   - `rfkill unblock bluetooth`
   - `sudo hciconfig hci0 up` (or `bluetoothctl power on`)
- Verify your user is in the appropriate groups (e.g., `bluetooth`) or run as root.


## Troubleshooting

### Linux Kernel 6.x Compatibility

The BrilliantSole SDK uses `@abandonware/noble` which has a compatibility bug with Linux kernel 6.x. If you experience connection issues, enable the custom Noble implementation:

```bash
# Set in .env file:
USE_CUSTOM_NOBLE=true

# Or via environment variable:
USE_CUSTOM_NOBLE=true npm run sensors
```

The custom implementation uses `@stoprocent/noble` (maintained fork) and bypasses the SDK's built-in scanner with manual event triggering for full Linux kernel 6.x support.