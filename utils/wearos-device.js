const dgram = require("dgram");
const EventEmitter = require("events");
const os = require("os");
const { WebSocketServer } = require("ws");

// Sensors the Wear OS companion streams, in the SDK's units (m/s², rad/s, µT) plus heart rate in BPM.
/**
 * Sensor names accepted by the direct Wear OS adapter. Vector units are m/s²,
 * rad/s, and µT; heart rate is BPM. The hello packet advertises the available subset.
 * @constant {string[]}
 */
const WEAROS_SENSORS = Object.freeze(["acceleration", "gyroscope", "magnetometer", "heartRate"]);
const VECTOR_SENSORS = new Set(["acceleration", "gyroscope", "magnetometer"]);
const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 10000;

// Exposes a watch through the subset of the SDK Device API used by DeviceSession.
/**
 * Adapts one watch's JSON WebSocket protocol to the DeviceSession device interface.
 * WearOsServer owns the sockets and retains this object by hello.id across reconnects.
 * Camera, microphone, and SDK display capabilities are always absent. Device events
 * use the SDK-style envelope; addEventListener/removeEventListener alias on/off.
 * @class
 * @extends EventEmitter
 * @fires WearOsDevice#isConnected
 * @fires WearOsDevice#acceleration
 * @fires WearOsDevice#gyroscope
 * @fires WearOsDevice#magnetometer
 * @fires WearOsDevice#heartRate
 * @see {@tutorial wearos}
 */
class WearOsDevice extends EventEmitter {
    /**
     * Create a disconnected device using the first hello's capability advertisement.
     * @param {WearOsHello} hello Identity and capabilities; the server validates type/id.
     */
    constructor({ id, name, sensors, vibration, beep, notifications }) {
        super();
        this.id = id;
        this.name = name || "Wear OS";
        this.availableSensorTypes = WEAROS_SENSORS.filter((sensor) => sensors?.includes(sensor));
        this.vibrationLocations = vibration ? ["wrist"] : [];
        this.canBeep = Boolean(beep);
        this.canNotify = Boolean(notifications);
        this.hasCamera = false;
        this.hasMicrophone = false;
        this.isDisplayAvailable = false;
        this.isConnected = false;
        this.sensorConfiguration = {};
        this.socket = null;
        this.addEventListener = this.on.bind(this);
        this.removeEventListener = this.off.bind(this);
    }

    /**
     * Replace the active socket, restore saved configuration, then emit connected.
     * The name may change on reconnect; the original capabilities remain unchanged.
     * Server integrations call this after validating hello, not ordinary session users.
     * @param {Object} socket Connected ws WebSocket, owned by WearOsServer.
     * @param {WearOsHello} hello Current connection's hello.
     * @returns {void}
     */
    bind(socket, hello) {
        if (this.socket && this.socket !== socket) this.socket.terminate();
        this.socket = socket;
        this.name = hello.name || this.name;
        socket.on("message", (data, isBinary) => {
            if (!isBinary) this._handle(data.toString());
        });
        socket.on("close", () => {
            if (this.socket !== socket) return;
            this.socket = null;
            this._setConnected(false);
        });
        // A reconnecting watch starts with no sensors; restore the last configuration.
        if (Object.keys(this.sensorConfiguration).length) this._send({ type: "config", sensors: this.sensorConfiguration });
        this._setConnected(true);
    }

    /** @private */
    _setConnected(isConnected) {
        if (this.isConnected === isConnected) return;
        this.isConnected = isConnected;
        this.emit("isConnected", { type: "isConnected", target: this, message: { isConnected } });
    }

    /** @private */
    _handle(text) {
        let packet;
        try { packet = JSON.parse(text); }
        catch { return; }
        if (packet?.type !== "sensor" || !this.availableSensorTypes.includes(packet.sensor)) return;
        const sensorType = packet.sensor;
        const timestamp = Number(packet.timestamp) || Date.now();
        const message = VECTOR_SENSORS.has(sensorType)
            ? { sensorType, timestamp, [sensorType]: { x: Number(packet.x), y: Number(packet.y), z: Number(packet.z) } }
            : { sensorType, timestamp, heartRate: Number(packet.bpm) };
        this.emit(sensorType, { type: sensorType, target: this, message });
    }

    /** @private */
    _send(packet) {
        if (this.socket?.readyState !== 1) return false;
        this.socket.send(JSON.stringify(packet));
        return true;
    }

    /**
     * Store supported sensor intervals and send a config packet when connected.
     * Values are coerced to nonnegative numbers; unknown sensor names are ignored.
     * Configuration persists while disconnected and is resent on bind(). No watch
     * acknowledgement is awaited. These values are intervals in milliseconds.
     * @param {Object<string, number>} configuration Sensor name to requested interval; 0 disables.
     * @param {boolean} [clearRest=true] Replace configuration, or merge into saved values when false.
     * @returns {Promise<void>}
     */
    async setSensorConfiguration(configuration, clearRest = true) {
        const next = clearRest ? {} : { ...this.sensorConfiguration };
        for (const [sensor, interval] of Object.entries(configuration || {})) {
            if (this.availableSensorTypes.includes(sensor)) next[sensor] = Math.max(0, Number(interval) || 0);
        }
        this.sensorConfiguration = next;
        this._send({ type: "config", sensors: next });
    }

    /**
     * Send one vibrate packet per waveform segment; timing/location details are not forwarded.
     * Missing segment effects default to strongClick100. Does not await wearer feedback.
     * @param {Object[]} waveforms SDK-style waveforms with segments containing effect names.
     * @returns {Promise<void>}
     * @throws {Error} If the adapter is disconnected.
     */
    async triggerVibration(waveforms) {
        if (!this.isConnected) throw new Error("Wear OS device is not connected");
        for (const waveform of waveforms || []) {
            for (const segment of waveform.segments || []) {
                this._send({ type: "vibrate", effect: segment.effect || "strongClick100" });
            }
        }
    }

    /**
     * Send a beep packet. ActionDispatcher validates frequency and duration for routed actions.
     * @param {Object} options
     * @param {number} options.frequency Tone frequency in Hz.
     * @param {number} options.durationMs Tone duration in milliseconds.
     * @returns {Promise<void>} Packet accepted for sending on an open socket; no watch acknowledgement.
     * @throws {Error} If there is no open socket; asynchronous socket errors are logged separately.
     */
    async playBeep({ frequency, durationMs }) {
        if (!this._send({ type: "beep", frequency, durationMs })) throw new Error("Wear OS device is not connected");
    }

    /**
     * Send a notify packet. ActionDispatcher validates fields for routed actions.
     * @param {Object} options
     * @param {string} options.level warning, danger, or safe.
     * @param {string} options.title Alert title.
     * @param {string} options.text Alert body.
     * @returns {Promise<void>} Packet accepted for sending on an open socket; no watch acknowledgement.
     * @throws {Error} If there is no open socket; asynchronous socket errors are logged separately.
     */
    async showNotification({ level, title, text }) {
        if (!this._send({ type: "notify", level, title, text })) throw new Error("Wear OS device is not connected");
    }

    /**
     * Close the active socket and emit disconnected while retaining sensor configuration.
     * @returns {Promise<void>}
     */
    async disconnect() {
        const socket = this.socket;
        this.socket = null;
        socket?.close();
        this._setConnected(false);
    }
}

// Accepts watch connections and keeps one device object per watch across reconnects.
/**
 * Owns the direct watch WebSocket listener, UDP discovery, and heartbeat checks.
 * Retains devices under their exact hello.id and emits device on every accepted
 * connection. This protocol has no authentication or TLS; deploy on a trusted
 * network. DeviceFleet owns it when WEAROS_PORT is set.
 * @class
 * @extends EventEmitter
 * @fires WearOsServer#device
 * @fires WearOsServer#error
 * @see {@tutorial wearos}
 */
class WearOsServer extends EventEmitter {
    /**
     * Create an unstarted listener. DeviceFleet validates the configured TCP port.
     * @param {WearOsServerOptions} [options] Direct callers should supply port explicitly.
     */
    constructor({ port, host } = {}) {
        super();
        this.port = port;
        this.host = host || undefined;
        this.devices = new Map();
    }

    /**
     * Bind WebSocket TCP and start discovery UDP on the actual bound port.
     * UDP binds all IPv4 interfaces regardless of host; discovery bind failures
     * are logged and disable discovery without rejecting a working TCP listener.
     * Call once per instance lifecycle and stop() after any failed startup.
     * @returns {Promise<void>}
     * @throws {Error} If WebSocket listener startup fails; later listener errors emit error.
     */
    async start() {
        this.server = new WebSocketServer({ port: this.port, host: this.host });
        await new Promise((resolve, reject) => {
            this.server.once("listening", resolve);
            this.server.once("error", reject);
        });
        this.port = this.server.address().port;
        this.server.on("error", (error) => this.emit("error", error));
        this.server.on("connection", (socket, request) => this._accept(socket, request));
        // Wi-Fi drops on a watch rarely close the socket; ping to notice dead links.
        this.pingTimer = setInterval(() => {
            for (const socket of this.server.clients) {
                if (socket.alive === false) { socket.terminate(); continue; }
                socket.alive = false;
                socket.ping();
            }
        }, PING_INTERVAL_MS);
        this.pingTimer.unref?.();
        this._startDiscovery();
    }

    // Answers watch discovery on UDP. Bound to every interface, since one address alone misses broadcasts.
    /** @private */
    _startDiscovery() {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        socket.on("message", (data, remote) => {
            let packet;
            try { packet = JSON.parse(data.toString()); }
            catch { return; }
            if (packet?.type !== "discover") return;
            const reply = JSON.stringify({ type: "wearmux", port: this.port, name: os.hostname() });
            socket.send(reply, remote.port, remote.address);
        });
        socket.on("error", (error) => {
            console.warn("[WearOS] discovery off:", error?.message || error);
            if (this.discovery === socket) this.discovery = null;
            socket.close();
        });
        socket.bind(this.port);
        socket.unref();
        this.discovery = socket;
    }

    /** @private */
    _accept(socket, request) {
        socket.alive = true;
        socket.on("pong", () => { socket.alive = true; });
        socket.on("error", (error) => console.warn("[WearOS] socket:", error?.message || error));
        const timer = setTimeout(() => socket.terminate(), HELLO_TIMEOUT_MS);
        socket.once("message", (data, isBinary) => {
            clearTimeout(timer);
            let hello;
            try { hello = isBinary ? null : JSON.parse(data.toString()); }
            catch { hello = null; }
            if (hello?.type !== "hello" || typeof hello.id !== "string" || !hello.id) {
                socket.close(1008, "expected hello");
                return;
            }
            let device = this.devices.get(hello.id);
            if (!device) {
                device = new WearOsDevice(hello);
                this.devices.set(hello.id, device);
            }
            console.log(`[WearOS] ${device.name} (${hello.id}) connected from ${request.socket.remoteAddress}`);
            device.bind(socket, hello);
            this.emit("device", device);
        });
    }

    /**
     * Stop heartbeat/discovery, terminate clients, and close the owned TCP server.
     * Stop any DeviceSessions using the devices first; this server does not own sessions.
     * @returns {Promise<void>}
     */
    async stop() {
        clearInterval(this.pingTimer);
        this.discovery?.close();
        this.discovery = null;
        if (!this.server) return;
        for (const socket of this.server.clients) socket.terminate();
        await new Promise((resolve) => this.server.close(() => resolve()));
        this.server = null;
    }
}

/**
 * Accepted watch connection, including reconnects using the same retained object.
 * @event WearOsServer#device
 * @type {WearOsDevice}
 */
/**
 * TCP listener error after startup. UDP and individual socket errors are logged separately.
 * @event WearOsServer#error
 * @type {Error}
 */
/**
 * Connection-state transition in message.isConnected.
 * @event WearOsDevice#isConnected
 * @type {WearOsConnectionEvent}
 */
/**
 * Acceleration vector in message.acceleration, in m/s².
 * @event WearOsDevice#acceleration
 * @type {WearOsSensorEvent}
 */
/**
 * Angular velocity in message.gyroscope, in rad/s.
 * @event WearOsDevice#gyroscope
 * @type {WearOsSensorEvent}
 */
/**
 * Magnetic field in message.magnetometer, in µT.
 * @event WearOsDevice#magnetometer
 * @type {WearOsSensorEvent}
 */
/**
 * Heart rate in message.heartRate, in BPM.
 * @event WearOsDevice#heartRate
 * @type {WearOsSensorEvent}
 */
module.exports = { WearOsDevice, WearOsServer, WEAROS_SENSORS };
