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
│   ├── record-audio.js             # Record audio to WAV file
│   └── lib/microphone-manager.js   # Microphone data handling
├── sensors/
│   ├── index.js                    # Sensor monitor
│   ├── real-time-ml-gesture.js     # ML gesture recognition
│   ├── run-inference.js            # Edge Impulse inference runner
│   └── lib/
│       ├── sensor-manager.js       # Device + sensor orchestration
│       ├── motion-sensors.js       # Motion handlers/utilities
│       ├── activity-sensors.js     # Tap detector & activity classification
│       ├── ml-gesture-detector.js  # ML gesture detection
│       └── ei-classifier.js        # Edge Impulse classifier wrapper
├── camera/
│   ├── index.js                    # Camera capture CLI
│   └── lib/
│       ├── image-validator.js      # Image validation utilities
│       └── viewer-server.js        # HTTP/MJPEG browser viewer
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
├── package.json
└── README.md
```


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

# Display an image on the device display
npm run display -- path/to/image.png

# Camera capture
npm run camera
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


## Zenoh Integration
- Enable Zenoh by setting `ZENOH_ENABLE=1` in your environment
- Publishes data to keys like `bsole/sensors/<sensor>`, `bsole/microphone/level`, etc.
- See tools/zenoh_py_publisher.py and tools/zenoh_py_subscriber.py for Python helpers


## Docker

This project provides a `docker-compose.yml` for running the connector in a containerized environment.

### Quick Start

1. **Build and start the container:**
  ```bash
  docker-compose up --build
  ```

2. **Stop the container:**
  ```bash
  docker-compose down
  ```

3. **Run with custom environment variables:**
  - You can pass environment variables via a `.env` file or with `-e` flags:
  ```bash
  ZENOH_ENABLE=1 docker-compose up
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
- If you do not need BLE in Docker, you can use the default compose file which avoids extra privileges.

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

Below is a comprehensive list of environment variables, grouped by function. For more advanced options, see comments in each script or the main README.md.

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
| `ZENOH_ENABLE`              | Enable Zenoh publishing                     | `0`     | `1`                        |
| `ZENOH_KEY_PREFIX`          | Zenoh key prefix for sensors                | `bsole/sensors` | `bsole/sensors`      |
| `ZENOH_ATTACH_ALL`          | Attach/publish all enabled sensors          | `1`     | `0`                        |

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

For more advanced options, see the comments in each script or the main README.md.

---

For more details, see the README in each subfolder.
