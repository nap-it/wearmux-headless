# VRU Stop-Request Interaction

This optional application adapter presents a stop-request question on a compatible wearable and maps a detected head nod to **yes** and a head shake to **no**. It runs in the WearMux Headless host and uses the bundled BrilliantWear Edge Impulse gesture model.

## Enable the interaction

The adapter is enabled only in the multi-device session runtime. It requires MQTT and a connected wearable with both a display and an acceleration sensor:

```bash
MESSAGE_TRANSPORT=mqtt VRU_INTERACTION_ENABLED=1 npm run sessions
```

WearMux connects to `mqtt://127.0.0.1:1883` by default. Start an MQTT broker there, or set `MQTT_BROKER_URL` to a reachable broker. If more than one connected wearable supports the interaction, set `VRU_DEVICE_ID` to the target device ID. A prompt can also select a device with `device_id` or `deviceId`.

When enabled, the session runtime starts acceleration sensing for gesture recognition and skips its camera and microphone sessions. Acceleration is sampled at 20 ms intervals (50 Hz); inference runs on the Headless host. The detector evaluates a rolling 600 ms window and accepts a nod or shake only when its model score exceeds `VRU_GESTURE_CONFIDENCE` (default `0.6`). See the [model notes](../../sensors/model/README.md) for model provenance.

## MQTT messages

The adapter listens on `<TOPIC_PREFIX>/vru/prompt` and publishes accepted answers on `<TOPIC_PREFIX>/vru/answer`. The topic prefix defaults to `bwear` and can be changed with `TOPIC_PREFIX`.

Send a JSON prompt with a non-empty `prompt_id`. `question` and `timeout_s` are optional:

```json
{
  "prompt_id": "request-42",
  "question": "Should I stop?",
  "timeout_s": 12
}
```

If a nod or shake is accepted before the prompt expires, the adapter publishes:

```json
{
  "prompt_id": "request-42",
  "answer": "yes",
  "gesture": "nod",
  "device": {
    "id": "device-id",
    "name": "wearable-name"
  }
}
```

A shake produces `"answer": "no"` and `"gesture": "shake"`. If the prompt expires, no answer is published; the requesting application remains responsible for its timeout policy. The adapter handles one prompt at a time. Its default timeout is 12 seconds and can be changed with `VRU_INTERACTION_TIMEOUT_MS`; a positive `timeout_s` on a prompt can shorten that limit.
