# Message contracts

WearMux Headless publishes JSON payloads through MQTT or Zenoh. The [technical guide](../technical-guide.md#published-data-topics) is the topic reference; the [consumer guide](../../examples/consumers/README.md) explains external processing and raw-frame assembly. The JSDoc types on the site's Global page describe the corresponding fields.

## Device identity and time

Use the identity emitted by the host when joining streams or targeting commands. Sessions select `bluetoothId`, falling back to `id`; names are descriptive and need not be unique. A fleet preserves one session per normalized device identity across reconnects. Unknown identity fields may be null or omitted, depending on the publishing path.

Top-level `ts` values are host Unix time in **milliseconds**, generally captured when the message is prepared for publication. They are not measurements of transport delivery time. The nested SDK sensor `message.timestamp` and camera `cameraTimestamp` retain the device's time base; the host does not normalize them into Unix time. Applications that synchronize streams must account for those different clocks. Latency fields are SDK-reported values and do not constitute an end-to-end benchmark.

Acceleration is reported in m/s², gyroscope in rad/s, magnetometer in μT, and Euler orientation in degrees according to the SDK modality contract. Quaternion and pressure structures remain SDK payloads; confirm their shape and units for the relevant hardware/firmware. *_RATE environment settings accept Hz or an `Xms` period for host event throttling. Device configuration values are handled separately through the SDK; do not assume the same number directly guarantees a measured device sampling rate.

For direct Wear OS, heartRate values are BPM and watch timestamps pass through as numeric milliseconds, with host Date.now() as the fallback for missing/zero/nonnumeric input. The watch config wire values are millisecond intervals. The [watch protocol guide](wearos.md#sensor-packets-and-configuration) explains the current mismatch between shared *_RATE parsing and watch intervals, and the difference between session and standalone heart-rate selection.

## Metadata and media bytes

CameraImage and MicrophoneLevel messages describe frames/packets; they do not contain encoded media. Raw publication is enabled separately with `CAMERA_RAW_ENABLE=1` and `MIC_RAW_ENABLE=1`.

Each raw frame has a RawMediaMetadata record and zero or more RawMediaChunk messages. Group by `frameId`, order chunks by zero-based `idx`, concatenate their `data` strings, then base64-decode once. Confirm `totalChunks` and the decoded `bytes` count. Expire incomplete frames and limit buffered memory; several devices can interleave messages. RAW_CHUNK_SIZE counts base64 characters, rather than decoded bytes.

Camera bytes are JPEG. Microphone raw samples are little-endian 32-bit floats (`f32le`), even when `bitDepth` reports a different capture depth. Metadata includes the sample rate and number of samples in that SDK packet. Raw audio is not a WAV file; a consumer that needs a window or file must assemble it itself.

MQTT publication uses QoS 0. Publication completion means local/backend acceptance and does not acknowledge consumer receipt. Zenoh publication goes through a local Python sidecar; the Node.js write promise does not acknowledge receipt by the remote consumer either. Neither path implements frame retransmission.

## Commands and outcomes

Publish an ActionCommand to `<root>/actions` and subscribe to `<root>/actions/result` before sending it. Generate a unique string `id` so results can be correlated. The default root is `bwear`; TOPIC_PREFIX must match on all participants.

```json
{
  "id": "example-alert-001",
  "deviceId": "<id-from-devices-status>",
  "action": "haptic.vibrate",
  "effect": "strongClick100"
}
```

The fleet selects a ready connected device. Without `deviceId`, exactly one device must support the requested display, haptic, audio, or notification action. No matching device or several eligible devices produce `ok:false`. Commands are serialized per device; they are not broadcast, persisted, or automatically retried.

This branch also supports `audio.beep` and `notification.show` through the Wear OS adapter. The ActionCommand type lists their fields and defaults; the [technical guide](../technical-guide.md#wear-os-watches) describes the adapter setup and current client limitation.

An ActionResult includes host time, selected identity when known, `ok`, and the supplied correlation/action strings when available. Invalid JSON can produce a failure without a correlation ID. `ok:true` means the SDK call succeeded; it does not prove that the wearer saw the display or felt the vibration. Consumers should use an application timeout when a result is missing and consider duplicate effects before retrying a command.

ActionDispatcher.dispatch() can also be called locally. It returns a promise and does not publish a result on its own; the standalone receiver or fleet wraps dispatch with result publication. Direct callers must catch rejected promises and serialize commands themselves, or use DeviceSession.dispatchAction().
