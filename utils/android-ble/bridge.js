const EventEmitter = require("events");
const http = require("http");
const { timingSafeEqual } = require("crypto");
const { isIP } = require("net");
const { WebSocketServer, WebSocket } = require("ws");
const { AndroidBleConnection } = require("./connection");
const { VERSION, PATH, MAX_PAYLOAD, normalizeId, parseFrame } = require("./protocol");

function authorized(header, token) {
    const supplied = Buffer.from(typeof header === "string" ? header : "");
    const expected = Buffer.from(`Bearer ${token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const peerAddress = address => address.startsWith("::ffff:") ? address.slice(7) : address;

/**
 * Owns one authenticated Android WebSocket companion and its active BLE peripheral.
 * Android handles GATT; the supplied browser SDK decodes device capabilities and
 * sensor messages. Register an error listener before start(), and create a new
 * bridge instance after stop(). A deviceConnected event follows SDK initialization,
 * rather than the companion's initial GATT connection announcement.
 * @class
 * @extends EventEmitter
 * @fires AndroidBleBridge#error
 * @fires AndroidBleBridge#status
 * @fires AndroidBleBridge#companionConnected
 * @fires AndroidBleBridge#companionDisconnected
 * @fires AndroidBleBridge#deviceConnected
 * @see {@tutorial android-ble}
 */
class AndroidBleBridge extends EventEmitter {
    /**
     * Validate settings without opening a listener.
     * @param {AndroidBleBridgeOptions} [options] Environment variables provide listener/auth defaults.
     * @throws {Error} If the port, authentication mode, token, or local peers are invalid.
     */
    constructor({ sdk, host = process.env.ANDROID_BLE_BRIDGE_HOST || "127.0.0.1",
        port = Number(process.env.ANDROID_BLE_BRIDGE_PORT || 8765),
        token = process.env.ANDROID_BLE_BRIDGE_TOKEN,
        authMode = process.env.ANDROID_BLE_BRIDGE_AUTH_MODE || "token",
        localPeers = process.env.ANDROID_BLE_BRIDGE_LOCAL_PEERS || "127.0.0.1,::1",
        writeTimeoutMs = 10000, helloTimeoutMs = 10000, readyTimeoutMs = 30000, heartbeatMs = 15000 } = {}) {
        super();
        if (!["token", "local"].includes(authMode)) throw new Error("Invalid Android bridge authentication mode");
        if (authMode === "token" && (typeof token !== "string" || token.length < 16 || token.length > 256 || /\s/.test(token))) {
            throw new Error("ANDROID_BLE_BRIDGE_TOKEN must be 16–256 characters with no whitespace");
        }
        const peers = (typeof localPeers === "string" ? localPeers.split(",") : localPeers);
        if (authMode === "local" && (!Array.isArray(peers) || !peers.length ||
            peers.some(address => typeof address !== "string" || !isIP(address.trim())))) {
            throw new Error("Local bridge peers must be a non-empty list of IP addresses");
        }
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Android bridge port");
        this.sdk = sdk;
        this.host = host;
        this.port = port;
        this.token = token;
        this.authMode = authMode;
        this.localPeers = new Set(authMode === "local" ? peers.map(address => peerAddress(address.trim())) : []);
        this.writeTimeoutMs = writeTimeoutMs;
        this.helloTimeoutMs = helloTimeoutMs;
        this.readyTimeoutMs = readyTimeoutMs;
        this.heartbeatMs = heartbeatMs;
        this.devices = new Map();
        this.pending = new Map();
        this.nextRequestId = 0;
        this.stopping = false;
    }

    /**
     * Load the browser SDK if needed, bind HTTP/WebSocket, and start ping/pong checks.
     * The bound port is available as port after this resolves; port 0 selects a free port.
     * Repeated calls while listening do nothing. Call stop() even after a failed start.
     * @returns {Promise<void>}
     * @throws {Error} If SDK import or listener startup fails; listener errors also emit error.
     */
    async start() {
        if (this.server) return;
        if (!this.sdk) this.sdk = await import("brilliantsole/browser");
        this.server = http.createServer((request, response) => {
            if (request.method !== "GET" || request.url !== "/healthz") {
                response.writeHead(404); response.end(); return;
            }
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ ok: true, bridgeConnected: Boolean(this.peer?.hello),
                deviceConnected: Boolean(this.active?.ready) }));
        });
        this.wss = new WebSocketServer({ server: this.server, maxPayload: MAX_PAYLOAD,
            verifyClient: ({ req }, done) => {
                // Trust the actual TCP peer, never a client-supplied forwarding header.
                const accepted = this.authMode === "local"
                    ? this.localPeers.has(peerAddress(req.socket.remoteAddress || ""))
                    : authorized(req.headers.authorization, this.token);
                if (req.url !== PATH || !accepted) {
                    done(false, 401, "Unauthorized");
                } else if (this.peer || this.stopping) {
                    done(false, 409, "An Android companion is already connected");
                } else done(true);
            },
        });
        this.wss.on("connection", (socket) => this.accept(socket));
        this.wss.on("error", (error) => this.emit("error", error));
        this.server.on("error", (error) => this.emit("error", error));
        await new Promise((resolve, reject) => {
            const failed = (error) => { this.server.off("listening", listening); reject(error); };
            const listening = () => { this.server.off("error", failed); resolve(); };
            this.server.once("error", failed);
            this.server.once("listening", listening);
            this.server.listen(this.port, this.host);
        });
        this.port = this.server.address().port;
        this.heartbeat = setInterval(() => {
            const peer = this.peer;
            if (!peer) return;
            if (!peer.alive) { peer.socket.terminate(); return; }
            peer.alive = false;
            peer.socket.ping();
        }, this.heartbeatMs);
        this.heartbeat.unref();
        console.log(`[Android BLE] Listening on ${this.host}:${this.port}${PATH}`);
    }

    /** @private */
    accept(socket) {
        // verifyClient and connection are separate callbacks; guard simultaneous upgrades too.
        if (this.peer || this.stopping) { socket.close(1008, "Companion already connected"); return; }
        const peer = { socket, alive: true, hello: false, cancelled: new Map() };
        this.peer = peer;
        peer.timer = setTimeout(() => socket.close(1008, "Protocol hello timed out"), this.helloTimeoutMs);
        socket.on("pong", () => { peer.alive = true; });
        socket.on("error", (error) => this.emit("error", error));
        socket.on("close", () => this.drop(peer));
        socket.on("message", (data, binary) => {
            try { this.receive(peer, parseFrame(data, binary)); }
            catch (error) {
                this.emit("error", error);
                // Stop controls immediately; don't keep a session ready during the close handshake.
                this.drop(peer);
                socket.close(1008, "Invalid bridge protocol");
            }
        });
    }

    /** @private */
    send(peer, frame) {
        if (peer !== this.peer || peer.socket.readyState !== WebSocket.OPEN) throw new Error("Android companion disconnected");
        if (peer.socket.bufferedAmount > MAX_PAYLOAD * 4) throw new Error("Android bridge send queue is full");
        peer.socket.send(JSON.stringify(frame));
    }

    /** @private */
    receive(peer, frame) {
        if (peer !== this.peer) return;
        if (!peer.hello) {
            if (frame.type !== "hello") throw new Error("Protocol hello must be the first bridge frame");
            peer.hello = true;
            clearTimeout(peer.timer);
            this.send(peer, { type: "hello", version: VERSION });
            this.emit("companionConnected");
            return;
        }
        if (frame.type === "hello") throw new Error("Duplicate bridge hello");
        if (frame.type === "error") { this.emit("status", frame.error); return; }
        if (frame.type === "connected") {
            if (this.active) throw new Error("Disconnect the previous peripheral before connecting another");
            const key = normalizeId(frame.deviceId);
            let entry = this.devices.get(key);
            if (!entry) {
                const manager = new AndroidBleConnection({ deviceId: frame.deviceId, mtu: frame.mtu,
                    messageTypes: this.sdk.TxRxMessageTypes,
                    write: (bytes) => this.write(entry, bytes),
                    disconnect: () => {
                        if (this.active === entry && this.peer) this.send(this.peer, { type: "disconnect", deviceId: entry.id });
                        this.disconnectEntry(entry);
                    },
                    onError: (error) => this.failDevice(entry, error),
                });
                const device = new this.sdk.Device();
                device.connectionManager = manager;
                device.reconnectOnDisconnection = false;
                entry = { id: frame.deviceId, device, manager };
                device.addEventListener("isConnected", (event) => {
                    if (event.message?.isConnected) this.checkReady(entry);
                });
                this.devices.set(key, entry);
            }
            entry.id = frame.deviceId;
            entry.manager.bluetoothId = frame.deviceId;
            entry.manager.attMtu = frame.mtu;
            entry.manager.mtu = frame.mtu;
            this.active = entry;
            entry.ready = false;
            entry.readyTimer = setTimeout(() => this.failDevice(entry,
                new Error("Timed out waiting for glasses metadata and capabilities")), this.readyTimeoutMs);
            // SDK requests its real metadata and capabilities over the proxy. A GATT
            // link announcement alone must never mark the device/session ready.
            entry.manager.connect().catch((error) => this.failDevice(entry, error));
            return;
        }
        const entry = this.active;
        if (frame.type === "writeResult" && peer.cancelled.get(frame.requestId) === normalizeId(frame.deviceId)) {
            peer.cancelled.delete(frame.requestId);
            return;
        }
        if (frame.type === "disconnected" && !entry && this.devices.has(normalizeId(frame.deviceId))) return;
        if (!entry || normalizeId(frame.deviceId) !== normalizeId(entry.id)) throw new Error("Bridge frame refers to a different peripheral");
        if (frame.type === "value") {
            entry.manager.receive(frame.characteristic, frame.bytes);
            this.checkReady(entry);
        } else if (frame.type === "writeResult") {
            const pending = this.pending.get(frame.requestId);
            if (!pending || pending.peer !== peer || pending.entry !== entry) throw new Error("Unknown or expired BLE write result");
            this.pending.delete(frame.requestId);
            clearTimeout(pending.timer);
            if (frame.ok) pending.resolve();
            else pending.reject(new Error(frame.error || "Android GATT write failed"));
        } else if (frame.type === "disconnected") {
            this.disconnectEntry(entry);
        }
    }

    /** @private */
    checkReady(entry) {
        if (this.active !== entry || entry.ready || !entry.device.isConnected) return;
        const { device } = entry;
        // Base metadata may finish before queued display queries. Wait for the
        // glasses capability probe before constructing a session.
        if (device.type === "glasses") {
            if (!device.latestConnectionMessages.has("isDisplayAvailable")) return;
            if (device.isDisplayAvailable && !["displayInformation", "displayStatus", "getDisplayBrightness"]
                .every(type => device.latestConnectionMessages.has(type))) return;
        }
        entry.ready = true;
        clearTimeout(entry.readyTimer);
        this.emit("deviceConnected", device);
    }

    /** @private */
    write(entry, bytes) {
        const peer = this.peer;
        if (!peer?.hello || this.active !== entry) return Promise.reject(new Error("Android BLE link is not active"));
        if (this.pending.size >= 256) return Promise.reject(new Error("Too many pending BLE writes"));
        const requestId = String(++this.nextRequestId);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.cancelledWrite(peer, requestId, entry.id);
                this.pending.delete(requestId);
                const error = new Error("Timed out waiting for Android GATT write acknowledgement");
                reject(error);
                this.failDevice(entry, error);
            }, this.writeTimeoutMs);
            this.pending.set(requestId, { resolve, reject, timer, peer, entry });
            try { this.send(peer, { type: "write", deviceId: entry.id, requestId, characteristic: "tx", data: bytes.toString("base64") }); }
            catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
        });
    }

    /** @private */
    cancelledWrite(peer, id, deviceId) {
        peer.cancelled.set(id, normalizeId(deviceId));
        if (peer.cancelled.size > 256) peer.cancelled.delete(peer.cancelled.keys().next().value);
    }

    /** @private */
    failDevice(entry, error) {
        this.emit("error", error);
        if (this.active !== entry) return;
        try { this.send(this.peer, { type: "disconnect", deviceId: entry.id }); } catch {}
        this.disconnectEntry(entry);
    }

    /** @private */
    disconnectEntry(entry) {
        if (!entry) return;
        clearTimeout(entry.readyTimer);
        entry.ready = false;
        if (this.active === entry) this.active = null;
        for (const [id, pending] of this.pending) {
            if (pending.entry !== entry) continue;
            clearTimeout(pending.timer);
            this.cancelledWrite(pending.peer, id, entry.id);
            pending.reject(new Error("Android BLE device disconnected during write"));
            this.pending.delete(id);
        }
        entry.manager.markDisconnected();
    }

    /** @private */
    drop(peer) {
        clearTimeout(peer.timer);
        if (this.peer !== peer) return;
        this.peer = null;
        this.disconnectEntry(this.active);
        this.emit("companionDisconnected");
    }

    /**
     * Stop heartbeat checks, drop the companion, reject outstanding writes, remove
     * SDK connection callbacks, and close owned listeners. Stop any DeviceSession
     * using an emitted device before calling this; sessions are not owned here.
     * @returns {Promise<void>}
     */
    async stop() {
        this.stopping = true;
        clearInterval(this.heartbeat);
        if (this.peer) { const peer = this.peer; this.drop(peer); peer.socket.terminate(); }
        for (const entry of this.devices.values()) entry.manager.remove();
        this.devices.clear();
        if (this.wss) await new Promise((resolve) => this.wss.close(resolve));
        if (this.server) await new Promise((resolve) => this.server.close(resolve));
        this.server = null;
    }
}

/**
 * Listener, socket, protocol, initialization, or BLE write failure.
 * @event AndroidBleBridge#error
 * @type {Error}
 */
/**
 * Diagnostic error text sent by the companion; does not itself disconnect the link.
 * @event AndroidBleBridge#status
 * @type {string}
 */
/**
 * Authenticated companion completed protocol hello; no peripheral readiness implied.
 * @event AndroidBleBridge#companionConnected
 */
/**
 * Companion disconnected; any active peripheral and pending writes are invalidated.
 * @event AndroidBleBridge#companionDisconnected
 */
/**
 * Fully initialized SDK device. Reconnection reuses the device object for its normalized MAC.
 * @event AndroidBleBridge#deviceConnected
 * @type {Object}
 */
module.exports = { AndroidBleBridge };
