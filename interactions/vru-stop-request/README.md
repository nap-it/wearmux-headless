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

## Evaluation traces

The interaction emits best-effort records on the existing `latency/events/v1`
MQTT topic. This evaluation topic is independent of `TOPIC_PREFIX`.
Each record contains `schema: 1`, `source: "wearmux"`, `stage`, `prompt_id`, and
`request_action_id` when the prompt includes `originating_station_id` and
`sequence_number`. Business messages and gesture decisions are unchanged.

`trace_event_id`, `sequence`, and `process_instance` identify individual records.
`wall_time_ns` and `mono_time_ns` are decimal strings. Wall time comes from
`Date.now()` and has **millisecond resolution**, even though encoded in
nanoseconds. Monotonic time comes from `process.hrtime.bigint()`. On Linux,
`clock_domain` is `linux:<boot_id>:monotonic`; `clock_namespace` also records the
time-namespace inode when readable. Compare across processes only after checking
their boot IDs and time namespaces, and across hosts only after calibration.
Other platforms use a process-specific domain. Never subtract unrelated clocks.

The normal trace includes:

- `prompt_received`, `prompt_rejected` (busy or no ready device), `display_started`,
  `display_ready`, and `gesture_collection_started`.
- `gesture_received`, `answer_publish_started`, `answer_published`, and
  `answer_publish_failed`. The publication-completion event describes the local
  transport promise; it does not establish receipt by the vehicle.
- `prompt_timeout`, `prompt_failed`, `gesture_inference_failed`,
  `prompt_cancelled`, `display_clear_started`, `display_cleared`, and
  `display_clear_failed`, where applicable.

`display_ready` and `display_cleared` use
`completion_semantics: "firmware_render_ack"` and `optical_completion: false`.
They mean the firmware acknowledged the render command. A camera measurement is
needed to establish when the complete question became visible.

Accepted `gesture_received` records include the first and last sample-arrival
monotonic timestamps, the corresponding SDK sensor timestamps in milliseconds,
classifier start/end monotonic timestamps, label, confidence and threshold.
`nominal_window_ms: 600`, `window_samples: 30`, `window_features: 90`, and
`model_input_features: 150` describe the existing SDK-compatible short-window
path; the model and normalization have not changed. The first-to-last sample
span at 50 Hz is nominally **580 ms**; 600 ms describes the 30-sample window
budget. Arrival timestamps are measured after SDK decoding on Headless, not at
physical movement onset or sensor acquisition.

Set `HITL_EVAL_DETAIL=1` to additionally record every `gesture_window_evaluated`
and Android callback timings. This can produce about 50 window records per
second and adds tracing overhead. Keep the setting fixed throughout a study and
record it with the experiment configuration. The asynchronous telemetry queue is
bounded at 128 pending publications per emitter; failed or stalled telemetry
does not gate display or answers. Subsequent records report cumulative
`telemetry_dropped` and `telemetry_failures`. A trace with missing records must be
reported as incomplete, not silently treated as a successful fast trial.

The Android clock-mapping extension is documented in
[android-ble-protocol.md](../../docs/android-ble-protocol.md). Existing APKs still
work but do not produce Android callback timings. Updating this source does not
update an installed APK.
