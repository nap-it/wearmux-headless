# Android BLE bridge protocol v1

The bridge in the existing WearMux Android app owns Bluetooth GATT. Headless owns the BrilliantSole device protocol, rendering and inference. This targets Brilliant Labs Frame running custom BrilliantSole/BrilliantWear firmware; stock Frame's Lua protocol is different. Android opens a WebSocket to the headless server at `/android-ble`, using `Authorization: Bearer <shared token>` in the upgrade request. A token is required; it is never sent in the URL or logged. Use the Droidspaces Debian bridge IP or a forwarded port, not an assumed shared loopback address.

Frames are JSON text, at most 64 KiB. Binary characteristic values are canonical standard Base64. This bridge initially supports one glasses connection per companion and one companion per headless listener. Device IDs are Bluetooth MAC addresses. Headless normalizes case and colon separators for filters, but frames use the original device ID throughout a connection.

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
