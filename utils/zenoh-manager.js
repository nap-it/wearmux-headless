// Zenoh integration: session management and publishing helpers
// Supports multiple package names: '@eclipse-zenoh/zenoh-ts', 'zenoh-ts', 'zenoh', '@eclipse-zenoh/zenoh-node'
const EventEmitter = require("events");
const { spawn } = require("child_process");
const net = require("net");
const msgpack = require("@msgpack/msgpack");
const path = require("path");

// Native bindings are not supported in Node here; we use a small Python sidecar.

class ZenohManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.keyPrefix = options.keyPrefix || "bsole/sensors";
        this.prettyJson = true;
        this.locator = "tcp/127.0.0.1:7447";
        this.session = null;
        this._mode = "python"; // always python sidecar
        this._pubCache = new Map(); // key => publisher or null for session.put
        this._attached = false;
        this._attachedHandlers = new Map(); // sensorType => handler fn
        this._sensorManager = null;
        this._deviceInfo = null; // optional info injected via setDeviceInfo
        this._child = null; // python sidecar
        this._childReady = false;
        // UDS transport (MessagePack) only
        this._udsPath = options.udsPath || process.env.ZENOH_UDS_PATH || require("path").join(require("os").tmpdir(), "bsole-zenoh.sock");
        this._udsSocket = null;
    }

    setDeviceInfo(info) {
        this._deviceInfo = info || null;
    }

    async start() {
        if (this.session || this._child) return this.session;
        await this._startDenoBridge();
        this.emit("ready");
        return this.session;
    }

    async _startDenoBridge() { // historical name; starts the Python sidecar
        const script = path.resolve(__dirname, "../tools/zenoh_py_publisher.py");
        const fs = require("fs");
        const isWin = process.platform === "win32";
        let pyBin = isWin ? "python" : "python3";
        const venvPyBin = path.resolve(__dirname, isWin ? "../venv/Scripts/python.exe" : "../venv/bin/python3");
        if (fs.existsSync(venvPyBin)) {
            pyBin = venvPyBin;
        }
        const args = ["-u", script]; // -u = unbuffered stdin/stdout
        const env = { ...process.env };
        env.ZENOH_UDS_PATH = this._udsPath;
        env.ZENOH_KEY_PREFIX = this.keyPrefix;
        const child = spawn(pyBin, args, { stdio: ["ignore", "pipe", "inherit"], env });
        this._child = child;
        this._childReady = true;
        child.on("error", (err) => this.emit("error", new Error(`[ZenohManager] Python sidecar error: ${err?.message || err}`)));
        child.on("exit", (code, signal) => {
            if (code !== 0) this.emit("error", new Error(`[ZenohManager] Python sidecar exited code=${code} signal=${signal}`));
            this._child = null;
            this._childReady = false;
        });
        // Wait for readiness from sidecar; reject immediately if the process exits first
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                child.stdout.off("data", onData);
                child.off("exit", onExit);
                child.off("error", onProcessError);
            };
            const onData = (chunk) => {
                if (chunk.toString().includes("[PythonSidecar] READY")) {
                    cleanup();
                    resolve();
                }
            };
            const onExit = (code) => {
                cleanup();
                reject(new Error(`Python sidecar exited before READY (code=${code})`));
            };
            const onProcessError = (err) => {
                cleanup();
                reject(new Error(`Python sidecar error: ${err?.message || err}`));
            };
            child.stdout.on("data", onData);
            child.once("exit", onExit);
            child.once("error", onProcessError);
        });
        // Connect to the UDS socket now (UDS-only)
        if (!msgpack) {
            throw new Error("@msgpack/msgpack is required for UDS transport. Please install dependencies.");
        }
        await new Promise((resolve, reject) => {
            const sock = net.createConnection({ path: this._udsPath }, () => resolve());
            sock.setMaxListeners(256); // high-frequency publishes add transient drain/error/close listeners
            sock.on("error", (e) => {
                this.emit("error", new Error(`[ZenohManager] UDS socket error: ${e?.message || e}`));
                reject(e);
            });
            sock.on("close", () => {
                // Sidecar closed the socket; keep state but notify
                this.emit("error", new Error("[ZenohManager] UDS socket closed"));
            });
            this._udsSocket = sock;
        });
        // Placeholder session descriptor for python mode
        this.session = { bridge: "python", locator: this.locator };
    }

    async stop() {
        try {
            await this.detachAll(this._sensorManager);
        } catch { }
        try {
            if (this._udsSocket) {
                try { this._udsSocket.end(); } catch { }
                try { this._udsSocket.destroy(); } catch { }
                this._udsSocket = null;
            }
            await new Promise((r) => setTimeout(r, 100));
            try {
                this._child?.kill("SIGTERM");
            } catch { }
        } catch (e) {
            this.emit("error", e);
        } finally {
            this.session = null;
            this._pubCache.clear();
            this._child = null;
            this._childReady = false;
            this._mode = "python";
            this._sensorManager = null;
        }
    }

    _topicFor(sensorType) {
        return `${this.keyPrefix}/${sensorType}`;
    }

    async _getPublisher(key) {
        if (this._pubCache.has(key)) return this._pubCache.get(key);
        // Prefer a declared publisher if available
        const declare = this.session?.declare_publisher || this.session?.declarePublisher;
        if (declare && typeof declare === "function") {
            try {
                const pub = await declare.call(this.session, key);
                this._pubCache.set(key, pub);
                return pub;
            } catch (e) {
                // Fall through to session.put path if declare fails
                this._pubCache.set(key, null);
                return null;
            }
        }
        this._pubCache.set(key, null);
        return null;
    }

    _serialize(payload) {
        if (payload == null) return "null";
        try {
            return JSON.stringify(payload, null, this.prettyJson ? 2 : 0);
        } catch {
            // Best-effort fallback
            return String(payload);
        }
    }

    async publish(key, payload) {
        if (!this._udsSocket) throw new Error("UDS socket is not connected");
        // Pre-serialize JSON on the JS side: msgpack would turn any Buffer field
        // into Python bytes, which json.dumps can't handle in the sidecar.
        const jsonStr = this._serialize(payload);
        const buf = Buffer.from(msgpack.encode({ key, json: jsonStr }));
        const ok = this._udsSocket.write(buf);
        if (!ok) {
            const sock = this._udsSocket;
            await new Promise((resolve, reject) => {
                const onDrain = () => { cleanup(); resolve(); };
                const onError = (e) => { cleanup(); reject(e); };
                const onClose = () => { cleanup(); reject(new Error("UDS socket closed before drain")); };
                const cleanup = () => {
                    sock.off("drain", onDrain);
                    sock.off("error", onError);
                    sock.off("close", onClose);
                };
                sock.once("drain", onDrain);
                sock.once("error", onError);
                sock.once("close", onClose);
            });
        }
    }

    // Attach all enabled sensors from SensorManager and publish
    async attachToSensorManager(sensorManager, options = {}) {
        if (this._attached) return;
        if (!this.session) await this.start();
        this._sensorManager = sensorManager;
        const enabled = sensorManager.getEnabledSensors?.() || [];
        const sensors =
            Array.isArray(options.sensors) && options.sensors.length > 0
                ? options.sensors
                : enabled;
        const quiet = Boolean(options.quiet);

        // Capture device info for payload enrichment
        try {
            const dev = sensorManager?.device || sensorManager.getDevice?.() || sensorManager.getDeviceManager?.().getDevice?.();
            if (dev) {
                this.setDeviceInfo({
                    id: dev.bluetoothId || dev.id || undefined,
                    name: dev.name || undefined,
                });
            }
        } catch { }

        sensors.forEach((sensorType) => {
            const key = this._topicFor(sensorType);
            // Predeclare publisher on the Python sidecar to avoid first-message latency
            try {
                if (this._udsSocket) {
                    this._udsSocket.write(Buffer.from(msgpack.encode({ key, declare: true })));
                }
            } catch { }
            const handler = async (event) => {
                // Prefer the plain message payload to avoid circular refs
                const safeMessage = event && typeof event === "object" ? event.message ?? null : null;
                const payload = {
                    ts: Date.now(),
                    sensor: sensorType,
                    device: this._deviceInfo || undefined,
                    message: safeMessage,
                };
                try {
                    await this.publish(key, payload);
                } catch (e) {
                    if (!quiet)
                        console.warn(`[ZenohManager] publish failed on ${key}:`, e?.message || e);
                    this.emit("error", e);
                }
            };
            this._attachedHandlers.set(sensorType, handler);
            sensorManager.on(sensorType, handler);
            if (!quiet) console.log(`[ZenohManager] Publishing '${sensorType}' to '${key}'`);
        });

        this._attached = true;
    }

    async detachAll(sensorManager) {
        if (!this._attached) return;
        const sm = sensorManager || this._sensorManager;
        if (sm && this._attachedHandlers.size) {
            for (const [sensorType, handler] of this._attachedHandlers.entries()) {
                try {
                    sm.off?.(sensorType, handler);
                } catch { }
                try {
                    sm.removeListener?.(sensorType, handler);
                } catch { }
            }
        }
        this._attachedHandlers.clear();
        this._attached = false;
    }
}

module.exports = { ZenohManager };
