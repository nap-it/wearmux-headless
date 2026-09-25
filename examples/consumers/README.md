# External consumers

WearMux Headless acquires data from wearables and publishes modality events through MQTT or Zenoh. An application can subscribe on another process or machine, run its own processing, and optionally publish a device action back. The core Docker image and Compose stack do not include inference models or consumer services.

The [Whisper](whisper/README.md) and [YOLO](yolo/README.md) examples are standalone Python consumers. Each has its own configuration and dependency list. You can copy this `consumers/` directory to a machine with access to the same MQTT broker or Zenoh router. No WearMux Node.js installation is needed there.

## Message contract

Set the same `TOPIC_PREFIX` (default `bwear`) on the producer and consumer. All message payloads are JSON. MQTT and Zenoh use the same logical names; MQTT subscriptions use `#` and Zenoh subscriptions use `**` for the final wildcard.

| Purpose | Topic or key |
| --- | --- |
| Image metadata | `<root>/camera/image` |
| Image bytes | `<root>/camera/raw/meta`, `<root>/camera/raw/chunk` |
| Audio levels | `<root>/microphone/level` |
| Audio samples | `<root>/microphone/raw/meta`, `<root>/microphone/raw/chunk` |
| Sensor events | `<root>/sensors/<sensor>` |
| Device commands | `<root>/actions` |
| Command results | `<root>/actions/result` |

Set `CAMERA_RAW_ENABLE=1` or `MIC_RAW_ENABLE=1` in the WearMux configuration to publish raw media. Each media frame starts with a JSON message on `raw/meta` containing `frameId`, `totalChunks`, `encoding: "base64"`, `bytes`, and a timestamp `ts`. Camera metadata also contains `mime`; microphone metadata contains `format: "f32le"` and `sampleRate`. Messages on `raw/chunk` contain the same `frameId`, a zero-based `idx`, and a base64 string `data`. Concatenate `data` in `idx` order, then base64-decode the complete string. Keep incomplete frames separate by `frameId` and discard them after a timeout. The sample runners implement this assembly for both transports.

The microphone samples decode to little-endian 32-bit floats. Camera bytes decode to the image format declared by `mime` (JPEG with the default camera settings). MQTT publishes at QoS 0, so consumers should tolerate missing frames. Result topics such as `<root>/whisper/transcript` and `<root>/yolo/detections` belong to the examples; applications can choose their own result topics and JSON schemas.

## Run an optional consumer

On the consumer machine, enter the `consumers/` directory, create a Python environment, and install only the example you need:

```bash
cd examples/consumers  # or the copied consumers/ directory
python3 -m venv .venv
.venv/bin/pip install -r whisper/requirements.txt
# Or install yolo/requirements.txt for object detection.
```

Connect to the same transport as WearMux Headless. For a remote Zenoh router, set `ZENOH_ROUTER` to its reachable endpoint. For MQTT, set `MESSAGE_TRANSPORT=mqtt` and `MQTT_BROKER_URL` to its reachable broker URL. Set `TOPIC_PREFIX` if the producer uses a custom root. Then run, for example (replace `broker.example.net` with your broker):

```bash
MESSAGE_TRANSPORT=mqtt MQTT_BROKER_URL=mqtt://broker.example.net:1883 \
  .venv/bin/python yolo/runner.py
```

The examples read the core `config/` directory when available, followed by their own `config.ini`. Shell variables win. On another machine, their own configuration and the transport defaults are enough; set the broker or router address in the shell.

## Adapt a separate inference server

A general inference server will not understand WearMux's `raw/meta` and `raw/chunk` messages directly. Put an application adapter between the transport and that server:

1. Subscribe to the desired modality topic and assemble frames by `frameId`.
2. Send the decoded bytes to the server using its HTTP, gRPC, or other API.
3. Publish the server's response on an application result topic. Include `frameId` or a source timestamp so responses can be matched to input frames.
4. If the result should affect the wearable, publish an action JSON object on `<root>/actions` and read the matching `id` on `<root>/actions/result`.

The [YOLO runner](yolo/runner.py) shows camera reassembly and result publication; the [Whisper runner](whisper/runner.py) shows audio reassembly and windowing. Replace the model call in either runner with a client for the inference server you choose. WearMux Headless only needs the transport and topic settings; it does not need to know which model or server the application uses.
