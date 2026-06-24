const EventEmitter = require("events");
/** @type {import("brilliantsole/node")?} */
let BS = null;

const debugLog = (...args) => {
    if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
        console.log(...args);
    }
};

class DeviceManager extends EventEmitter {
    constructor() {
        super();
        this.device = null;
        this._wasConnected = false;
        this._lastFilters = { id: "", name: "" };
    }

    async connectToDevice() {
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

        try {
            await this._connectViaBle();
            this._setupEventListeners();
            await this._waitForConnection();
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

        const existing = this._pickFromDeviceManager(filterId, filterName);
        if (existing) {
            if (!existing.isConnected) {
                try { await existing.connect?.(); } catch { }
            }
            this.device = existing;
        } else {
            debugLog("[DeviceManager] Starting scanner-based connection...");
            await this._connectViaScanner(filterId, filterName);
        }
    }

    async _connectViaWifi(ipAddress) {
        const transport = (process.env.DEVICE_TRANSPORT || "websocket").toLowerCase();
        const isSecure = process.env.DEVICE_WIFI_SECURE === "1";

        // The SDK expects browser-style message events where event.data is a Blob with
        // .arrayBuffer(). Wrap ws to patch this.
        if (globalThis.WebSocket === undefined) {
            const WsClass = require("ws");
            const wrappedMap = new WeakMap();
            class BlobCompatWebSocket extends WsClass {
                addEventListener(type, listener, options) {
                    if (type !== "message") return super.addEventListener(type, listener, options);
                    const wrapped = (event) => {
                        const raw = event.data;
                        if (raw != null && typeof raw.arrayBuffer !== "function") {
                            // event.data is a read-only getter on MessageEvent, must proxy the whole event
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
                    wrappedMap.set(listener, wrapped);
                    return super.addEventListener(type, wrapped, options);
                }
                removeEventListener(type, listener, options) {
                    if (type !== "message") return super.removeEventListener(type, listener, options);
                    const wrapped = wrappedMap.get(listener);
                    if (wrapped) {
                        wrappedMap.delete(listener);
                        return super.removeEventListener(type, wrapped, options);
                    }
                    // Fallback: listener wasn't registered through this wrapper
                    return super.removeEventListener(type, listener, options);
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
            const discoveredDevice = await (async () => {
                while (true) {
                    const ev = await scanner.waitForEvent("discoveredDevice");
                    const dd = ev.message.discoveredDevice;
                    // Noble on Linux reports IDs without colons, normalize before comparing
                    const normalize = (id) => id?.toLowerCase().replaceAll(":", "");
                    const idMatched = filterId && normalize(dd.bluetoothId) === normalize(filterId);
                    if (filterId && !idMatched) continue;
                    debugLog("[DeviceManager] found device:", dd.name, dd.bluetoothId);
                    // Skip name filter when ID matched, noble on Linux omits names during scan
                    if (filterName && !idMatched && dd.name?.toLowerCase() !== filterName.toLowerCase()) continue;
                    return dd;
                }
            })();
            debugLog("[DeviceManager] discovered:", discoveredDevice?.name || discoveredDevice?.bluetoothId);
            const id = discoveredDevice.bluetoothId || discoveredDevice.id;
            // Register before connectToDevice to avoid a race on fast connections
            let onConnected;
            let timeout;
            try {
                const deviceConnectedPromise = new Promise((resolve, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error("Timeout waiting for device to connect")),
                        20000
                    );
                    onConnected = (event) => {
                        const device = event.message?.device;
                        if (device?.bluetoothId === id || device?.id === id) {
                            resolve(device);
                        }
                    };
                    BS.DeviceManager.AddEventListener("deviceConnected", onConnected);
                });
                await scanner.connectToDevice(id);
                this.device = await deviceConnectedPromise;
            } finally {
                if (timeout) clearTimeout(timeout);
                if (onConnected) {
                    try { BS.DeviceManager.RemoveEventListener("deviceConnected", onConnected); } catch { }
                }
            }
        } finally {
            try { scanner.stopScan(); } catch { }
        }
    }

    async _waitForScanningAvailable(scanner, timeoutMs = 20000) {
        if (scanner.isScanningAvailable) return true;
        debugLog("[DeviceManager] Waiting for BLE adapter to be ready...");
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                debugLog("[DeviceManager] Timeout waiting for BLE adapter");
                resolve(false);
            }, timeoutMs);

            scanner.waitForEvent("scanningAvailable").then(() => {
                clearTimeout(timeout);
                resolve(true);
            });
        });
    }

    _setupEventListeners() {
        try {
            this.device.addEventListener?.("connectionStatus", () => {
                debugLog("[DeviceManager] connectionStatus:", this.device.connectionStatus);
            });
            this.device.addEventListener?.("isConnected", (event) => {
                const connected = event.message?.isConnected;
                debugLog("[DeviceManager] isConnected:", connected);
                if (connected && this._wasConnected === false) {
                    this.emit("reconnected", this.device);
                    debugLog("[DeviceManager] Reconnected (SDK auto-reconnect)");
                }
                this._wasConnected = connected;
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

    async _waitForConnection() {
        if (this.device?.isConnected) return;
        await Promise.race([
            (async () => {
                while (!this.device?.isConnected) {
                    await this.device.waitForEvent("isConnected");
                }
            })(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Timeout waiting for device connection")), 20000)
            ),
        ]);
    }

    getDevice() {
        return this.device;
    }

    async disconnect() {
        try {
            if (this.device && typeof this.device.disconnect === "function") {
                await this.device.disconnect();
            }
        } catch (error) {
            console.warn("[DeviceManager] Error during disconnect:", error);
        }
    }
}

module.exports = { DeviceManager };
