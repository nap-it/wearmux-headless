// Device connection and management utilities for BrilliantSole devices
const EventEmitter = require("events");
/** @type {import("brilliantsole/node")?} */
let BS = null;

// Debug logging helper
const debugLog = (...args) => {
    if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
        console.log(...args);
    }
};

class DeviceManager extends EventEmitter {
    constructor() {
        super();
        this.device = null;
        this._reconnecting = false;
        this._lastFilters = { id: "", name: "" };

        const os = require("os");

        // Check if we should use custom Noble implementation
        const bEnvVar = process.env.USE_CUSTOM_NOBLE === 'true' || process.env.USE_CUSTOM_NOBLE === '1';
        this._useCustomNoble = process.env.USE_CUSTOM_NOBLE !== undefined
            ? bEnvVar
            : os.platform() === "linux";

        if (this._useCustomNoble) {
            const { NobleDeviceManager } = require('./noble-device-manager');
            this._nobleManager = new NobleDeviceManager();
        }
    }

    async connectToDevice() {
        // WiFi transport path: if DEVICE_IP is set, skip BLE entirely
        const wifiIp = process.env.DEVICE_IP;
        if (wifiIp) {
            debugLog("[DeviceManager] DEVICE_IP set, connecting via WiFi transport");
            try {
                if (!BS) BS = await import("brilliantsole/node");
                await this._connectViaWifi(wifiIp);
                this._setupEventListeners();
                await this._waitForConnection();
                return this.device;
            } catch (err) {
                this.emit("error", err);
                throw err;
            }
        }

        // If custom Noble is enabled, delegate to NobleDeviceManager
        if (this._useCustomNoble) {
            debugLog("[DeviceManager] Using custom Noble implementation");
            return await this._nobleManager.connectToDevice();
        }

        try {
            await this._connectViaBle();
            this._setupEventListeners();
            await this._waitForConnection();
            // Log the negotiated MTU for debugging purposes
            console.log(`[DeviceManager] Connected with MTU: ${this.device?.connectionManager?.mtu}`);
            return this.device;
        } catch (err) {
            this.emit("error", err);
            throw err;
        }
    }

    async _connectViaBle() {
        if (!BS) BS = await import("brilliantsole/node");

        const { id: filterId, name: filterName } = this._getFilters();
        this._lastFilters = { id: filterId, name: filterName };

        // 1) Try an existing device from SDK DeviceManager first (no scanning)
        const existing = this._pickFromDeviceManager(filterId, filterName);
        if (existing) {
            if (!existing.isConnected) {
                try { await existing.connect?.(); } catch { }
            }
            this.device = existing;
        } else {
            // 2) Use scanner-based connection
            debugLog("[DeviceManager] Starting scanner-based connection...");
            await this._connectViaScanner(filterId, filterName);
        }
    }

    async _connectViaWifi(ipAddress) {
        const transport = (process.env.DEVICE_TRANSPORT || "websocket").toLowerCase();
        const isSecure = process.env.DEVICE_WIFI_SECURE === "1";

        // The SDK expects browser-style message events where event.data is a Blob with
        // .arrayBuffer(). The ws package provides a plain Buffer instead. Wrap ws to patch this.
        if (globalThis.WebSocket === undefined) {
            const WsClass = require("ws");
            class BlobCompatWebSocket extends WsClass {
                addEventListener(type, listener, options) {
                    if (type !== "message") return super.addEventListener(type, listener, options);
                    const wrapped = (event) => {
                        const raw = event.data;
                        if (raw != null && typeof raw.arrayBuffer !== "function") {
                            // event.data is a read-only getter on MessageEvent — proxy the event
                            listener(Object.create(event, {
                                data: {
                                    value: {
                                        arrayBuffer() {
                                            let buf;
                                            if (Buffer.isBuffer(raw)) buf = raw;
                                            else if (raw instanceof ArrayBuffer) buf = Buffer.from(raw);
                                            else buf = Buffer.from(String(raw));
                                            return Promise.resolve(
                                                buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
                                            );
                                        },
                                    },
                                },
                            }));
                        } else {
                            listener(event);
                        }
                    };
                    return super.addEventListener(type, wrapped, options);
                }
            }
            globalThis.WebSocket = BlobCompatWebSocket;
        }

        const device = new BS.Device();
        this.device = device;

        if (transport === "udp") {
            debugLog(`[DeviceManager] Connecting via UDP → ${ipAddress}:3000`);
            await device.connect({ type: "udp", ipAddress });
        } else {
            const proto = isSecure ? "wss" : "ws";
            debugLog(`[DeviceManager] Connecting via WebSocket → ${proto}://${ipAddress}/ws`);
            await device.connect({ type: "webSocket", ipAddress, isWifiSecure: isSecure });
        }
    }

    _getFilters() {
        return {
            id: process.env.DEVICE_ID || process.env.MIC_DEVICE_ID || "",
            name: process.env.DEVICE_NAME || process.env.MIC_DEVICE_NAME || "",
        };
    }

    _pickFromDeviceManager(filterId, filterName) {
        try {
            const dm = BS?.DeviceManager;
            const list = Array.isArray(dm?.AvailableDevices) ? dm.AvailableDevices : [];
            if (!list.length) return null;
            if (filterId) return list.find((d) => d.bluetoothId === filterId || d.id === filterId) || null;
            if (filterName) return list.find((d) => d.name === filterName) || list[0] || null;
            return list[0] || null;
        } catch {
            return null;
        }
    }

    async _connectViaScanner(filterId, filterName) {
        const scanner = BS.Scanner;
        debugLog(
            "[DeviceManager] scanner present:",
            Boolean(scanner),
            "isSupported:",
            scanner?.isSupported,
            "isScanningAvailable:",
            scanner?.isScanningAvailable
        );

        if (!scanner || !scanner.isSupported) {
            throw new Error("Scanner not available or not supported in this environment");
        }
        if (!scanner.isScanningAvailable) {
            const ok = await this._waitForScanningAvailable(scanner, 20000);
            if (!ok) throw new Error("BLE scanning not available.");
        }

        debugLog("[DeviceManager] starting BLE scan...");
        scanner.startScan();
        try {
            // Select first discovered device that matches optional filters
            const discoveredDevice = await (async () => {
                while (true) {
                    const ev = await scanner.waitForEvent("discoveredDevice");
                    const dd = ev.message.discoveredDevice;
                    if (filterId && dd.bluetoothId !== filterId && dd.id !== filterId) continue;
                    if (filterName && dd.name !== filterName) continue;
                    return dd;
                }
            })();
            debugLog("[DeviceManager] discovered:", discoveredDevice?.name || discoveredDevice?.bluetoothId);
            const id = discoveredDevice.bluetoothId || discoveredDevice.id;
            await scanner.connectToDevice(id);
            // Wait for SDK DeviceManager to expose the connected instance
            this.device = await this._awaitDeviceById(id, 15000);
            if (!this.device) {
                throw new Error("Connected device instance not found after connectToDevice");
            }
        } finally {
            try { scanner.stopScan(); } catch { }
        }
    }

    async _waitForScanningAvailable(scanner, timeoutMs = 20000) {
        if (scanner.isScanningAvailable) return true;
        debugLog("[DeviceManager] Waiting for BLE adapter to be ready...");
        return new Promise((resolve) => {
            let done = false;
            const cleanup = () => {
                if (done) return;
                done = true;
                clearInterval(iv);
                clearTimeout(to);
                try { scanner.removeEventListener?.("isScanningAvailable", onEvt); } catch { }
            };
            const onEvt = (ev) => {
                const avail = ev?.message?.isScanningAvailable ?? ev?.isScanningAvailable ?? scanner.isScanningAvailable;
                debugLog("[DeviceManager] BLE event, available:", avail);
                if (avail) { cleanup(); resolve(true); }
            };
            try { scanner.addEventListener?.("isScanningAvailable", onEvt); } catch { }
            const iv = setInterval(() => {
                debugLog("[DeviceManager] Checking... isScanningAvailable:", scanner.isScanningAvailable);
                if (scanner.isScanningAvailable) { cleanup(); resolve(true); }
            }, 300);
            const to = setTimeout(() => {
                debugLog("[DeviceManager] Timeout waiting for BLE adapter");
                cleanup(); resolve(false);
            }, timeoutMs);
        });
    }

    async _awaitDeviceById(id, timeoutMs = 15000) {
        const dm = BS?.DeviceManager;
        if (!dm) return null;
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            const list = Array.isArray(dm.AvailableDevices) ? dm.AvailableDevices : [];
            const found = list.find((d) => d.bluetoothId === id || d.id === id) || null;
            if (found) return found;
            await new Promise((r) => setTimeout(r, 200));
        }
        return null;
    }

    _setupEventListeners() {
        try {
            this.device.addEventListener?.("connectionStatus", () => {
                debugLog("[DeviceManager] connectionStatus:", this.device.connectionStatus);
                // Auto-reconnect on disconnect
                this._onConnectionStatusChange().catch((e) => {
                    console.warn("[DeviceManager] Auto-reconnect error:", e?.message || e);
                });
            });
            this.device.addEventListener?.("microphoneStatus", () => {
                debugLog("[DeviceManager] microphoneStatus:", this.device.microphoneStatus);
            });
            this.device.addEventListener?.("getSensorConfiguration", () => {
                debugLog("[DeviceManager] sensorConfiguration:", this.device.sensorConfiguration);
            });
            this.device.addEventListener?.("getMicrophoneConfiguration", () => {
                debugLog("[DeviceManager] microphoneConfiguration:", this.device.microphoneConfiguration);
            });
        } catch (error) {
            console.warn("[DeviceManager] Failed to setup event listeners:", error);
        }
    }

    async _onConnectionStatusChange() {
        try {
            const isConnected = this.device?.isConnected;
            if (isConnected) return;
            if (this._reconnecting) return;
            this._reconnecting = true;
            debugLog("[DeviceManager] Disconnected. Attempting auto-reconnect via scanner...");

            // Prefer scanner to establish a fresh connection path
            await this._connectViaScanner(this._lastFilters.id, this._lastFilters.name);
            await this._waitForConnection();
            this.emit("reconnected", this.device);
            debugLog("[DeviceManager] Auto-reconnect successful");
        } finally {
            this._reconnecting = false;
        }
    }

    async _waitForConnection() {
        // Wait until connected (up to 20s)
        const timeoutAt = Date.now() + 20000;
        while (Date.now() < timeoutAt) {
            if (this.device?.isConnected) return;
            await new Promise((r) => setTimeout(r, 300));
        }
        throw new Error("Timeout waiting for device connection");
    }

    getDevice() {
        if (this._useCustomNoble) {
            return this._nobleManager.getDevice();
        }
        return this.device;
    }

    async disconnect() {
        try {
            if (this._useCustomNoble) {
                return await this._nobleManager.disconnect();
            }
            if (this.device && typeof this.device.disconnect === "function") {
                await this.device.disconnect();
            }
        } catch (error) {
            console.warn("[DeviceManager] Error during disconnect:", error);
        }
    }
}

module.exports = { DeviceManager };
