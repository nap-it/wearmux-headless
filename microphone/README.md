# Microphone Capture

Capture audio from compatible SDK devices with a microphone, display audio levels, record WAV files, or publish an RTSP stream. Run the commands below from the repository root; npm loads the INI configuration before starting each script.

## Audio Monitoring and RTSP

```bash
npm run microphone:rtsp
```

This command displays audio levels and publishes RTSP audio when `RTSP_URL` is configured. To publish to a local RTSP server:

```bash
RTSP_URL=rtsp://127.0.0.1:8554/mic npm run microphone:rtsp
```

Start the RTSP server first and ensure FFmpeg is on `PATH`. The Compose stack includes MediaMTX; see the [Docker setup](../docs/technical-guide.md#docker).

## WAV Recording

```bash
npm run microphone:record -- --duration 10 --sampleRate 16000 --bitDepth 16
```

The recorder saves a mono, 16-bit PCM WAV file under `microphone/recordings/`. Its command-line options are:

| Option | Purpose | Default |
| --- | --- | --- |
| `--duration` | Recording duration in seconds | `5` |
| `--sampleRate` | Sample rate in Hz, supported by the device | `16000` (`8000` or `16000`) |
| `--bitDepth` | Requested device audio bit depth; WAV output remains 16-bit | `16` (`8` or `16`) |
| `--output` | Filename within the recordings directory | Generated from the recording timestamp |

These options configure the recorder directly. Streaming settings are documented in the [audio and RTSP reference](../docs/technical-guide.md#audio-and-rtsp).

## Runtime Notes

The session runtime also handles microphone acquisition and raw audio publishing through MQTT or Zenoh. See the [messaging guide](../docs/technical-guide.md#messaging-and-reverse-actions) for transport setup and topics. Avoid running a standalone microphone command and `npm run sessions` against the same BLE device at the same time.

The MicrophoneSession and RtspPublisher interfaces are documented in the [generated API reference](../docs/documentation.md), including callbacks, stream ownership, and cleanup.
