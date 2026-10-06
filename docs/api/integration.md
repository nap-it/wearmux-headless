# Developer integration guide

Use the command-line host for ordinary acquisition. Direct module imports are useful when an application needs to coordinate sessions or process data in the same Node.js process. Run the examples below from the repository root, after the [technical guide's prerequisites](../technical-guide.md#prerequisites) are installed. They use source imports, not an installed WearMux npm package.

## Start and stop the multi-device host

Save this example as `local-host.js` in the repository root and run `node local-host.js`. It loads the normal configuration, starts discovery, and cleans up connections on shutdown. Set `MESSAGE_TRANSPORT=none` before running for local acquisition without a broker or Zenoh sidecar.

```javascript
const { loadConfigFile } = require('./utils/ini-config');
loadConfigFile();
// Load settings before importing modules with environment-derived topic constants.
const { DeviceFleet } = require('./utils/device-fleet');

const fleet = new DeviceFleet();
let stopping = false;
async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    try {
        await fleet.stop();
    } catch (error) {
        console.error(error);
        code = 1;
    }
    process.exit(code);
}

process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());
fleet.start().catch(async (error) => {
    console.error(error);
    await shutdown(1);
});
```

DeviceFleet owns discovery, its device connections, sessions, and shared transport clients. It sends each modality stream with a device identity. An action without `deviceId` selects the sole ready device with the requested capability; ambiguous targets produce an error result. Create a new fleet instance for a new lifecycle after stopping it.

## Consume sensor events in the same process

For one device, use DeviceManager to connect and SensorManager to subscribe to SDK events. The manager loads the SDK lazily. This example preserves camera/microphone configuration and disables SensorManager's owned publisher, so it only forwards local events.

```javascript
const { loadConfigFile } = require('./utils/ini-config');
loadConfigFile();
const { DeviceManager } = require('./utils/device-manager');
const { SensorManager } = require('./sensors/lib/sensor-manager');

async function main() {
    const manager = new DeviceManager();
    manager.on('error', (error) => console.error('Device connection:', error));
    let sensors;
    let stopping = false;
    async function shutdown(code = 0) {
        if (stopping) return;
        stopping = true;
        try {
            await sensors?.stop();
        } catch (error) {
            console.error(error);
            code = 1;
        } finally {
            await manager.disconnect();
            process.exit(code);
        }
    }
    process.once('SIGINT', () => shutdown());
    process.once('SIGTERM', () => shutdown());
    try {
        const device = await manager.connectToDevice();
        sensors = new SensorManager(device, {
            enabledSensors: ['acceleration'],
            publisherEnabled: false,
            clearRest: false,
        });
        sensors.on('error', (error) => console.error('Sensor configuration:', error));
        sensors.on('acceleration', (event) => console.log(event.message));
        await sensors.startSensors();
    } catch (error) {
        console.error(error);
        await shutdown(1);
    }
}
main().catch(console.error);
```

Choose sensors before starting. SensorManager installs listeners for that initial selection; changing its selection during monitoring does not rebuild those listeners. Stop it and create a new manager when changing which events the application consumes. Its stop method detaches listeners and its owned publisher, without disconnecting or disabling sensors on the device. DeviceManager remains responsible for disconnection.

## Lifecycle and errors

- Load INI settings before creating sessions or importing modules that construct topic constants. Shell variables override INI values by default.
- Keep one owner for each physical connection. Do not run standalone modality commands alongside the fleet against the same BLE device.
- Register `error` listeners on EventEmitter-based publishers, subscribers, SensorManager, ActionDispatcher, and RtspPublisher before starting them. Unhandled Node.js `error` events can terminate the process.
- Await asynchronous start, publication, dispatch, and stop calls. Handle rejected promises as well as emitted errors. Individual camera, microphone, and sensor paths also log recoverable failures; startup completion does not guarantee every optional output is active.
- Stop consumers and incoming actions, drain pending operations, stop modality sessions, then disconnect the device and stop any shared publisher owned by the application. DeviceSession stops its child sessions; it does not disconnect its device or stop the supplied publisher.

## Add a device integration

The SDK-backed runtime derives capabilities from a connected device. A new device should expose the SDK-compatible methods and events used by DeviceSession and the relevant modality module. Read the upstream SDK contract before adapting a protocol; the Headless API reference documents the calls it makes, without reimplementing the SDK reference.

DeviceSession inspects `availableSensorTypes`, `hasCamera`, `hasMicrophone`, `isDisplayAvailable`, and `vibrationLocations`. It derives identity from `bluetoothId` or `id`, plus `name`. The device must provide event registration and connection state, and implement the operations for every capability it advertises. Unsupported capabilities must remain absent/false. The main host currently recognizes the sensor names in DEFAULT_SENSOR_RATES.

Connect the device through DeviceManager/DeviceFleet, or supply an already-connected compatible object to DeviceSession. Discovery itself is SDK-specific; supporting an unrelated device protocol also requires an explicit connection/discovery integration. Keep protocol parsing in that adapter and application-specific processing in a consumer or interaction.

## Add a transport integration

Publishers and subscribers share the documented Publisher and Subscriber contracts. A publisher starts/stops its own resources and publishes a JSON-serializable value under a logical key. A subscriber emits `{ key, payload }` messages and reports asynchronous failures through `error`. Sensor publisher attachment additionally requires `attachToSensorManager()` and `detachAll()`.

Add the backend to the transport factories and selection validation, then document its settings, wildcard syntax, delivery guarantees, and cleanup behavior. Keep device identity and payload shapes compatible with the [message contracts](message-contract.md), so consumers can choose a transport without changing modality handling.

Test routing, capability filtering, reconnection, rejected starts, and cleanup without requiring physical hardware. The existing tests under `utils/__tests__/` and the modality `__tests__/` directories demonstrate fake devices and transports. Hardware-dependent behavior still needs validation on the supported device and firmware.
