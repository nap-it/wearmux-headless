# Android BLE developer guide

This guide applies to `feature-android-bluetooth`. Android owns the peripheral's Bluetooth GATT connection and forwards characteristic bytes over WebSocket. Headless uses the BrilliantSole **browser** SDK for metadata, sensor decoding, display encoding, and capability detection. It does not use the phone's HCI device or load Noble in this mode.

The supported target is Brilliant Labs Frame with compatible custom BrilliantSole/BrilliantWear firmware. Stock Frame firmware uses a different protocol. This path does not add phone or Wear OS sensor acquisition to Headless. See [Droidspaces deployment](../android-deployment.md) for the matching Android branch, APK controls, Docker setup, and phone network addresses.

## Run the session host

Choose the transport before starting the host. In a local development environment, with an Android companion able to reach this listener:

```bash
export DEVICE_TRANSPORT=android-ble
export ANDROID_BLE_BRIDGE_HOST=0.0.0.0
export ANDROID_BLE_BRIDGE_PORT=8765
export ANDROID_BLE_BRIDGE_AUTH_MODE=token
export ANDROID_BLE_BRIDGE_TOKEN="$(openssl rand -hex 32)"
MESSAGE_TRANSPORT=none npm run sessions
```

Configure the same token in the Android bridge controls. The companion endpoint is `ws://<reachable-host>:8765/android-ble`. For remote use, place TLS in front and use `wss://`; the listener itself serves HTTP/WebSocket. Droidspaces local mode instead admits exact TCP peer IPs without a token, as described in the deployment guide. Its gateway examples are specific to that phone and must be checked for your environment.

Leave `DEVICE_IP` unset; it cannot be combined with `android-ble`. Optional `DEVICE_ID`/`DEVICE_NAME` filters select the peripheral, with ID taking precedence. Android bridge mode replaces SDK scanning for this fleet and supports **one companion and one active peripheral per listener**. Headless keeps the same MQTT/Zenoh payloads and reverse-action routing as the core runtime.

`DeviceFleet` owns the bridge, device sessions, and messaging clients. Use the [integration guide](integration.md#start-and-stop-the-multi-device-host) for its shutdown pattern. `DeviceManager.connectToDevice()` also supports this mode for a single-device application and waits up to 60 seconds for a matching initialized device. Do not run both owners against the same listener/peripheral.

## Embed the bridge directly

For an application that needs to manage sessions itself, save this as `local-bridge.js` in the repository root. It starts a loopback-only listener for a same-network-namespace companion and prints initialized devices; it does not start modality sessions.

```javascript
const { AndroidBleBridge } = require('./utils/android-ble/bridge');

const bridge = new AndroidBleBridge({
    host: '127.0.0.1',
    port: 8765,
    authMode: 'local',
    localPeers: ['127.0.0.1', '::1'],
});
bridge.on('error', (error) => console.error('Bridge:', error.message));
bridge.on('status', (text) => console.log('Companion:', text));
bridge.on('deviceConnected', (device) => console.log(device.name, device.bluetoothId));

let stopping = false;
async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    try {
        await bridge.stop();
    } catch (error) {
        console.error(error);
        code = 1;
    }
    process.exit(code);
}
process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());
bridge.start().catch(async (error) => {
    console.error(error);
    await shutdown(1);
});
```

Android and Droidspaces Debian normally have different network namespaces; use the deployment guide rather than assuming their loopback addresses are shared. A custom session owner must start/stop its own DeviceSession and publisher. Stop sessions before stopping the bridge. Register an `error` listener before calling `start()`; errors can both emit events and reject startup promises. Use a new bridge instance for a new lifecycle after `stop()`.

## Readiness, reconnection, and write completion

The [wire protocol](../android-ble-protocol.md) defines GATT UUIDs, frame fields, order, and Base64 encoding. The connection sequence is: authenticated upgrade, versioned hello, Android GATT setup, `connected`, then SDK metadata/capability queries. `deviceConnected` is emitted only after initialization, including display information for glasses that advertise a display.

The SDK receives the original characteristic bytes. Whole TLV messages must fit the effective MTU minus three bytes; the effective MTU is the smaller of Android's negotiated ATT MTU and the firmware's protocol MTU. Each TX request waits for a `writeResult` associated with its request ID. GATT acknowledgement does not prove that a wearer perceived the effect; SDK firmware events determine completion of higher-level operations.

Default deadlines are 10 seconds for hello, 30 seconds for SDK readiness, and 10 seconds for each GATT write. Ping/pong checks run every 15 seconds. Incoming frames are bounded to 64 KiB; the bridge allows at most 256 pending writes and the connection manager queues at most 2048 SDK messages. Malformed protocol input or readiness/write failures invalidate the active link. Do not replay writes after a reconnect.

Android owns rediscovery after peripheral disconnection. Headless retains the SDK device object for a normalized MAC and initializes it again on reconnection; DeviceSession resumes its enabled capabilities. Losing the companion invalidates its peripheral and rejects pending writes. Firmware update and SDK-driven reconnection are unsupported by this adapter.

The unauthenticated HTTP `GET /healthz` endpoint reports listener health (`ok`), completed companion hello (`bridgeConnected`), and initialized SDK device readiness (`deviceConnected`). A GATT connection announcement alone does not make the last field true.

## Reference and validation

The generated reference covers `AndroidBleBridge`, `AndroidBleConnection`, `AndroidBleProtocol`, `loadSdk()`, `usesAndroidBleBridge()`, and their settings/message typedefs. Generate it with `npm run docs`; branch builds are downloadable from the Documentation action. The public Pages site follows `main` and does not contain these feature APIs until they are merged.

```bash
npm run docs:check
npm run test:android-ble
```

The bridge tests use a simulated Android peer and the real browser SDK. Physical GATT delivery, display appearance, and gestures require hardware validation.
