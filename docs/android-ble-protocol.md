# Android BLE bridge protocol v1

The bridge in the existing WearMux Android app owns Bluetooth GATT. Headless owns the BrilliantSole device protocol, rendering and inference. This targets Brilliant Labs Frame running custom BrilliantSole/BrilliantWear firmware; stock Frame's Lua protocol is different. Android opens a WebSocket to the headless server at `/android-ble`. Droidspaces Compose defaults to `ANDROID_BLE_BRIDGE_AUTH_MODE=local`: no token or Authorization header is needed, and the actual TCP peer must match `ANDROID_BLE_BRIDGE_LOCAL_PEERS` (loopback and the Android host gateway `172.28.0.1` on this phone). Forwarding headers cannot bypass this check. Other applications on that host share the same local trust boundary. Remote deployments use `ANDROID_BLE_BRIDGE_AUTH_MODE=token` (the server default outside this Compose file), `ANDROID_BLE_BRIDGE_TOKEN`, and `Authorization: Bearer <shared token>` in the upgrade request. Tokens are never sent in the URL or logged. Use the Droidspaces Debian bridge IP or a forwarded port, not an assumed shared loopback address.

Frames are JSON text, at most 64 KiB. Binary characteristic values are canonical standard Base64. This bridge initially supports one glasses connection per companion and one companion per headless listener. Device IDs are Bluetooth MAC addresses. Headless normalizes case and colon separators for filters, but frames use the original device ID throughout a connection.

## Android companion container

Pushes to `feature-android-bluetooth` build `Dockerfile.android` for both amd64 and
arm64 and publish the combined image as
`code.nap.av.it.pt:5050/ar_vr/wearmux-headless:feature-android-bluetooth`.
This image starts `tools/sessions.js` with the Android BLE transport. Default
branch and release-tag pipelines keep their existing Dockerfile selection.

## Android → headless

- `{"type":"hello","version":1}`: first frame after WebSocket opens. Headless replies with the same frame; Android starts BLE discovery only after that reply.
- `{"type":"connected","deviceId":"AA:BB:CC:DD:EE:FF","name":"Glasses","mtu":517}`: after service discovery, MTU negotiation (fallback 23), and RX notification subscription. The MTU is the ATT MTU, including its three-byte overhead. Do not send data before this frame.
- `{"type":"value","deviceId":"...","characteristic":"rx","data":"BASE64"}`: characteristic notification/read. Allowed characteristic names: `rx`, `batteryLevel`, `manufacturerName`, `modelNumber`, `hardwareRevision`, `firmwareRevision`, `softwareRevision`, `serialNumber`, `pnpId`. Forward raw bytes unchanged. Optional battery/device-information reads follow `connected`.
- `{"type":"writeResult","deviceId":"...","requestId":"1","ok":true}`: only after Android receives a successful `onCharacteristicWrite` for that write. On failure use `ok:false,error:"short explanation"`. A request is one complete ATT write; do not split or merge its payload.
- `{"type":"disconnected","deviceId":"...","reason":"..."}`: GATT lost/disconnected. Cancel queued writes and fail each outstanding request. Android resumes discovery while the socket remains active.
- `{"type":"error","error":"..."}`: diagnostic status, no secret or sensor payload logging.

## Headless → Android

- `{"type":"hello","version":1}`: accepts protocol version.
- `{"type":"write","deviceId":"...","requestId":"1","characteristic":"tx","data":"BASE64"}`: queued TX characteristic write **with response**. Strictly serialize GATT operations, including optional reads; callback completion drives the next operation. Reject mismatched device IDs and values larger than ATT MTU minus 3. TX is `ea6d1001-a725-4f9b-893d-c3913e33b39f`.
- `{"type":"disconnect","deviceId":"..."}`: disconnect the indicated peripheral, then allow discovery/reconnection while running.

The main service is `ea6d0000-a725-4f9b-893d-c3913e33b39f`; RX is `ea6d1000-a725-4f9b-893d-c3913e33b39f`. RX CCCD must be enabled before `connected`. Prefer ATT MTU 517; the headless SDK also learns the firmware's protocol MTU from its existing `getMtu` response and must honor the smaller limit. Preserve complete SDK TLV messages (one-byte type, two-byte little-endian length, payload). The Android app must not interpret display or sensor protocol opcodes.

Close/disconnect all GATT state when the WebSocket is lost or the foreground service stops. Never replay writes after WebSocket reconnection. Heartbeats use standard WebSocket ping/pong. Bound write queues and timeouts; report failures rather than dropping control commands. Never publish VRU answers or fabricate display readiness in the bridge.

## Optional evaluation timing extension

New companions advertise `"timingVersion":1` in `hello`, with an optional
`timing` snapshot. Old peers can ignore these fields; protocol version remains
1. Headless requests callback metadata by adding `"evaluationTiming":true` to
its hello reply only when `HITL_EVAL_DETAIL=1`. Without this negotiation the
Android companion forwards characteristic values and write results with the
original frame shape and does not collect per-callback timing snapshots.

With timing enabled, `value` and successful or failed GATT callback `writeResult`
frames contain `timing` captured on the callback thread **before** posting to
Android's main thread. Locally rejected or cancelled writes may lack callback
timing. A snapshot has decimal-string `wall_time_ns` (millisecond resolution)
and `mono_time_ns` from `SystemClock.elapsedRealtimeNanos()`, plus
`clock_domain: "android:<process-instance-uuid>:elapsed_realtime"`,
`process_instance`, `sequence`, and `trace_event_id`. The process-specific domain
forces a new mapping after an app restart. It must not be equated to Linux
`CLOCK_MONOTONIC`: Android elapsed real time includes deep sleep. No sensor bytes,
credentials, or question text are included in evaluation telemetry.

Only after hello/authentication, Headless may send
`{"type":"clockProbe","probeId":"<uuid>"}` to an advertising companion.
Android replies `{"type":"clockSample","probeId":"<uuid>","received":{...},"sent":{...}}`.
`received` is captured at the WebSocket callback before `Handler.post`; `sent` is
captured immediately before constructing/enqueueing the response. These frames
do not enter the BLE queue. Probe IDs are bounded to 64 alphanumeric/hyphen
characters, Android limits responses to one per 50 ms, and Headless allows one
outstanding probe with a five-second timeout. Late samples do not disconnect BLE.

Headless emits an `android_clock_sample` event containing `headless_send`,
`android_received`, `android_sent`, and `headless_receive`. It sends one probe
after a supported hello and repeats every 30 seconds in detail mode. Estimate
offset, delay, drift and uncertainty offline from all four timestamps; retain
network-asymmetry uncertainty and recalibrate after suspension/reconnection.
These exchanges estimate a mapping; they do not adjust device clocks.

In detail mode, `android_ble_value_received` and `android_ble_write_result`
events carry the Android snapshot plus the Headless receive time; where an
interaction is active they also carry prompt/action correlation. GATT write
completion establishes neither firmware rendering nor optical completion.
