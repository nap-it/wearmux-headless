// Zenoh integration: session management and publishing helpers
// Supports multiple package names: '@eclipse-zenoh/zenoh-ts', 'zenoh-ts', 'zenoh', '@eclipse-zenoh/zenoh-node'
const EventEmitter = require("events");
const { spawn } = require("child_process");
const path = require("path");

// Native bindings are not supported in Node here; we use a small Python sidecar.

class ZenohManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.keyPrefix = options.keyPrefix || "bsole/sensors";
        this.prettyJson = true;
        this.locator = "tcp/127.0.0.1:7447";
        this._z = null; // unused in python sidecar mode
        this.session = null;
        this._mode = "python"; // always python sidecar
        this._pubCache = new Map(); // key => publisher or null for session.put
        this._attached = false;
        this._attachedHandlers = new Map(); // sensorType => handler fn
        this._deviceInfo = null; // optional info injected via setDeviceInfo
        this._child = null; // python sidecar
        this._childReady = false;
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
        const pyBin = process.env.PYTHON_BIN || "python3";
        const args = ["-u", script]; // -u = unbuffered stdin/stdout
        const env = { ...process.env };
        if (!env.ZENOH_KEY_PREFIX && this.keyPrefix) env.ZENOH_KEY_PREFIX = this.keyPrefix;
        const child = spawn(pyBin, args, { stdio: ["pipe", "inherit", "inherit"], env });
        this._child = child;
        this._childReady = true;
        child.on("error", (err) => this.emit("error", new Error(`[ZenohManager] Python sidecar error: ${err?.message || err}`)));
        child.on("exit", (code, signal) => {
            if (code !== 0) this.emit("error", new Error(`[ZenohManager] Python sidecar exited code=${code} signal=${signal}`));
            this._child = null;
            this._childReady = false;
        });
        // Placeholder session descriptor for python mode
        this.session = { bridge: "python", locator: this.locator };
    }

    async stop() {
        try {
            await this.detachAll();
        } catch {}
        try {
            if (this._mode === "python") {
                if (this._child?.stdin) {
                    try {
                        this._child.stdin.end();
                    } catch {}
                }
                await new Promise((r) => setTimeout(r, 100));
                try {
                    this._child?.kill("SIGTERM");
                } catch {}
            }
        } catch (e) {
            this.emit("error", e);
        } finally {
            this.session = null;
            this._pubCache.clear();
            this._child = null;
            this._childReady = false;
            this._mode = "python";
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
        if (this._mode === "python") {
            if (!this._child || !this._child.stdin) throw new Error("Python bridge is not running");
            const line = JSON.stringify({ key, json: payload }) + "\n";
            const ok = this._child.stdin.write(line);
            if (!ok) await new Promise((resolve) => this._child.stdin.once("drain", resolve));
            return;
        }
        if (!this.session) throw new Error("Zenoh session is not started");
        const pub = await this._getPublisher(key);
        const data = this._serialize(payload);
        if (pub && (pub.put || pub.write)) {
            const fn = pub.put || pub.write;
            return fn.call(pub, data);
        }
        // Generic session.put path
        const put = this.session.put || this.session.write || this.session.putKey;
        if (!put) throw new Error("Zenoh binding does not expose put/write");
        return put.call(this.session, key, data);
    }

    // Attach all enabled sensors from SensorManager and publish
    async attachToSensorManager(sensorManager, options = {}) {
        if (this._attached) return;
        if (!this.session) await this.start();
        const enabled = sensorManager.getEnabledSensors?.() || [];
        const sensors =
            Array.isArray(options.sensors) && options.sensors.length > 0
                ? options.sensors
                : enabled;
        const quiet = Boolean(options.quiet);

        // Capture device info for payload enrichment
        try {
            const dev = sensorManager.getDeviceManager?.().getDevice?.();
            if (dev) {
                this.setDeviceInfo({
                    id: dev.bluetoothId || dev.id || undefined,
                    name: dev.name || undefined,
                    connectionType: dev.connectionType || undefined,
                });
            }
        } catch {}

        sensors.forEach((sensorType) => {
            const key = this._topicFor(sensorType);
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
        if (sensorManager && this._attachedHandlers.size) {
            for (const [sensorType, handler] of this._attachedHandlers.entries()) {
                try {
                    sensorManager.off?.(sensorType, handler);
                } catch {}
                try {
                    sensorManager.removeListener?.(sensorType, handler);
                } catch {}
            }
        }
        this._attachedHandlers.clear();
        this._attached = false;
    }
}

module.exports = { ZenohManager };
