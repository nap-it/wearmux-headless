# Direct Wear OS developer guide

This guide applies to `features-wear-os`. `WearOsServer` accepts watch connections over Wi-Fi and exposes each watch as a `WearOsDevice` for the common DeviceSession runtime. It supports advertised acceleration, gyroscope, magnetometer, heart rate, wrist vibration, beeps, and alerts. It does not advertise camera, microphone, or SDK display capabilities.

**A matching direct PC-mode watch client is still required.** The current WearMux Android watch module uses Google Wear Data Layer with the phone. That path does not implement this WebSocket/UDP protocol, and building its watch APK alone does not enable a Headless connection. The Node.js client below simulates the protocol for development; a watch implementation must acquire real sensors and execute commands through its platform APIs.

## Run the host

```bash
WEAROS_PORT=8765 MESSAGE_TRANSPORT=none npm run sessions
```

The normal [host prerequisites](../technical-guide.md#prerequisites) still apply. WEAROS_PORT enables the adapter alongside SDK device discovery; leaving it unset disables it. WEAROS_HOST limits the TCP listener's bind address, defaulting to all interfaces. UDP discovery binds all IPv4 interfaces on the same port, regardless of WEAROS_HOST. Allow TCP and UDP on the chosen port when using another device on the network.

This adapter provides no authentication or TLS. Its hello ID is a client-provided identity, not an authenticated device identity. Use a trusted network and control access to the listener. A replacement connection with the same exact ID terminates that ID's previous socket.

## Discovery and connection

Discovery is optional; a client may connect to a known `ws://<host-ip>:8765` address directly. To discover a host, send `{"type":"discover"}` in a UDP datagram to that port, either directly or by IPv4 broadcast. The response is a WearOsDiscoveryReply:

```json
{"type":"wearmux","port":8765,"name":"host-name"}
```

Use the response datagram's sender IP and the returned TCP port to open the WebSocket. When a server uses port 0, both UDP discovery and the response use the actual allocated TCP port; port 0 itself is not a discoverable destination.

Save this discovery example as `discover-watch-host.js` and run `node discover-watch-host.js <host-ip> 8765`. To broadcast, pass your network's broadcast address; the example enables broadcast after binding.

```javascript
const dgram = require('node:dgram');
const socket = dgram.createSocket('udp4');
const destination = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 8765);
const timer = setTimeout(() => {
    console.error('Discovery timed out');
    socket.close();
}, 3000);
socket.on('error', (error) => {
    clearTimeout(timer);
    console.error(error);
    socket.close();
});
socket.once('message', (data, remote) => {
    clearTimeout(timer);
    const reply = JSON.parse(data.toString());
    console.log(`ws://${remote.address}:${reply.port}`, reply.name);
    socket.close();
});
socket.bind(0, () => {
    socket.setBroadcast(true);
    socket.send(JSON.stringify({ type: 'discover' }), port, destination);
});
```

The first WebSocket frame must be a JSON text hello with a nonempty string ID:

```json
{"type":"hello","id":"wearos-example","name":"Example watch","sensors":["acceleration","heartRate"],"vibration":true,"beep":true,"notifications":true}
```

Send it within five seconds. A missing hello causes socket termination; an invalid first frame is closed with code 1008. There is no version negotiation or hello acknowledgement. The server emits `device` after binding, including on reconnects. Heartbeat pings run every ten seconds; the client must answer standard WebSocket pings. The `ws` library used in the example answers automatically.

## Sensor packets and configuration

Each sensor update is one JSON text frame:

```json
{"type":"sensor","sensor":"acceleration","timestamp":1234,"x":0,"y":0,"z":9.81}
```

Vector units are m/s² for acceleration, rad/s for gyroscope, and µT for magnetometer. A heart-rate update uses `sensor:"heartRate"` and `bpm:72` instead of x/y/z. Send numeric timestamps in milliseconds and choose/document a consistent client clock. The adapter retains nonzero numeric timestamps without clock conversion; missing, zero, or nonnumeric values fall back to host Date.now(). MQTT/Zenoh envelopes add a separate host Unix-millisecond `ts`.

The host requests a full sensor selection through a config command:

```json
{"type":"config","sensors":{"acceleration":50,"heartRate":1000}}
```

These values are **intervals in milliseconds**: 50 requests approximately 20 Hz, and 1000 requests approximately 1 Hz. A client must stop sensors missing from this selection or set to zero. Hardware determines actual cadence, particularly for heart rate.

In `npm run sessions`, unset ENABLED_SENSORS selects all advertised sensors, including heartRate; set it to a comma-separated list to restrict selection. A standalone SensorManager created with an empty selection excludes heartRate. The default watch configuration requests 50 ms for advertised motion sensors and 1000 ms for heart rate.

The shared `*_RATE` settings have a current limitation: Config parses them as Hz (or converts an `Xms` string to Hz), and DeviceSession passes the resulting number directly to this adapter without converting it to a millisecond interval. For example, ACCELERATION_RATE=50 produces a watch config value of 50 ms, while ACCELERATION_RATE=20ms also parses to 50 and produces 50 ms. Host publication throttling is separate. Leave those overrides unset for the default watch cadence; direct adapter users may call setSensorConfiguration() with explicit millisecond values. This guide describes the existing behavior; it does not change the rate path.

## Commands and outcomes

Applications normally use the shared [reverse actions](../technical-guide.md#device-actions), not the watch socket. The adapter sends these frames:

| Frame | Watch behavior |
| --- | --- |
| `{"type":"vibrate","effect":"strongClick100"}` | Execute the supported effect; one frame is sent per SDK waveform segment |
| `{"type":"beep","frequency":880,"durationMs":250}` | Play a tone; routed actions validate 40–8000 Hz and 10–5000 ms |
| `{"type":"notify","level":"warning","title":"WearMux","text":"Hello"}` | Present an alert; routed actions allow warning/danger/safe, title length 1–100, and text up to 500 characters |

Direct WearOsDevice methods do not perform the ActionDispatcher's field validation. The wire protocol has no command IDs, acknowledgements, persistence, or retry. A successful beep/notification adapter call means the packet was accepted for sending on an open socket; it does not detect asynchronous delivery failures. An action result does not confirm that the watch displayed an alert or that the wearer perceived it. Vibration segment timing and locations are not forwarded by this adapter.

## Simulate a client

Save this as `example-watch.js` in the repository root, then run `node example-watch.js ws://127.0.0.1:8765` with the host running. It advertises only acceleration, follows config requests, and prints host commands. The values are synthetic.

```javascript
const WebSocket = require('ws');
const socket = new WebSocket(process.argv[2] || 'ws://127.0.0.1:8765');
let samples;
socket.on('error', console.error);
socket.on('open', () => socket.send(JSON.stringify({
    type: 'hello', id: 'wearos-example', name: 'Protocol simulator',
    sensors: ['acceleration'], vibration: false, beep: false, notifications: false,
})));
socket.on('message', (data) => {
    const command = JSON.parse(data.toString());
    console.log('Host:', command);
    if (command.type !== 'config') return;
    clearInterval(samples);
    const intervalMs = Number(command.sensors.acceleration) || 0;
    if (intervalMs <= 0) return;
    samples = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
            type: 'sensor', sensor: 'acceleration', timestamp: Date.now(),
            x: 0, y: 0, z: 9.81,
        }));
    }, Math.max(20, intervalMs));
});
socket.on('close', () => clearInterval(samples));
process.once('SIGINT', () => socket.close());
process.once('SIGTERM', () => socket.close());
```

## Ownership and reconnects

DeviceFleet starts/stops WearOsServer and the corresponding DeviceSessions. For custom integrations, register server `device` and `error` listeners before start(), manage your own sessions/publishers, and stop sessions before the server. Server start() creates a listener each time; call it once per instance lifecycle and create a new instance for a fresh lifecycle. Stop after a failed startup to release partially created resources.

An exact hello ID retains one device object across reconnects. The name may update, but sensors and feedback capabilities remain those from the first hello. The previous configuration is resent on bind(), and the session's connection listener reapplies its configuration. A capability change requires a new adapter identity/lifecycle. DeviceManager alone handles SDK devices; direct watch discovery belongs to DeviceFleet/WearOsServer.

Startup TCP errors reject start(); later TCP listener errors emit server `error`. UDP discovery failures and individual socket errors are logged; discovery can fail while TCP continues to work. Sensor packets with invalid JSON or unadvertised sensor names are ignored. The adapter coerces numeric values but does not provide comprehensive schema, finite-value, or timestamp validation; a watch client must send well-formed values.

## Reference and validation

The branch reference includes WearOsServer, WearOsDevice, WEAROS_SENSORS, their events, and hello/sensor/command/discovery typedefs. Generate it locally or download this branch's Documentation action artifact. The public Pages site follows `main` until the feature is merged.

```bash
npm run docs:check
npx jest utils/__tests__/wearos-device.test.js --runInBand
```

The tests use real local WebSocket/UDP sockets and a simulated watch, covering capabilities, sensor publication, feedback, reconnects, hello validation, and discovery. Real watch sensor cadence, platform permissions, alert presentation, and haptics still need a matching client and hardware validation.
