const dgram = require("dgram");
const EventEmitter = require("events");
const os = require("os");
const { WebSocketServer } = require("ws");

// Sensors the Wear OS companion streams, in the SDK's units (m/s², rad/s, µT) plus heart rate in BPM.
const WEAROS_SENSORS = Object.freeze(["acceleration", "gyroscope", "magnetometer", "heartRate"]);
const VECTOR_SENSORS = new Set(["acceleration", "gyroscope", "magnetometer"]);
const HELLO_TIMEOUT_MS = 5000;
const PING_INTERVAL_MS = 10000;

// Exposes a watch through the subset of the SDK Device API used by DeviceSession.
class WearOsDevice extends EventEmitter {
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

    _setConnected(isConnected) {
        if (this.isConnected === isConnected) return;
        this.isConnected = isConnected;
        this.emit("isConnected", { type: "isConnected", target: this, message: { isConnected } });
    }

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

    _send(packet) {
        if (this.socket?.readyState !== 1) return false;
        this.socket.send(JSON.stringify(packet));
        return true;
    }

    async setSensorConfiguration(configuration, clearRest = true) {
        const next = clearRest ? {} : { ...this.sensorConfiguration };
        for (const [sensor, interval] of Object.entries(configuration || {})) {
            if (this.availableSensorTypes.includes(sensor)) next[sensor] = Math.max(0, Number(interval) || 0);
        }
        this.sensorConfiguration = next;
        this._send({ type: "config", sensors: next });
    }

    async triggerVibration(waveforms) {
        if (!this.isConnected) throw new Error("Wear OS device is not connected");
        for (const waveform of waveforms || []) {
            for (const segment of waveform.segments || []) {
                this._send({ type: "vibrate", effect: segment.effect || "strongClick100" });
            }
        }
    }

    async playBeep({ frequency, durationMs }) {
        if (!this._send({ type: "beep", frequency, durationMs })) throw new Error("Wear OS device is not connected");
    }

    async showNotification({ level, title, text }) {
        if (!this._send({ type: "notify", level, title, text })) throw new Error("Wear OS device is not connected");
    }

    async disconnect() {
        const socket = this.socket;
        this.socket = null;
        socket?.close();
        this._setConnected(false);
    }
}

// Accepts watch connections and keeps one device object per watch across reconnects.
class WearOsServer extends EventEmitter {
    constructor({ port, host } = {}) {
        super();
        this.port = port;
        this.host = host || undefined;
        this.devices = new Map();
    }

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

module.exports = { WearOsDevice, WearOsServer, WEAROS_SENSORS };
