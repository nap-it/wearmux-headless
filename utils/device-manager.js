// Device connection and management utilities for BrilliantSole devices
const EventEmitter = require("events");
/** @type {import("brilliantsole/node")?} */
let BS = null;

class DeviceManager extends EventEmitter {
    constructor() {
        super();
        this.device = null;
    }

    async connectToDevice() {
        try {
            if (!BS) {
                BS = await import("brilliantsole/node");
                // BS.setAllConsoleLevelFlags({log: true});
            }

            const { id: filterId, name: filterName } = this._getFilters();

            // 1) Try an existing device from SDK DeviceManager first (no scanning)
            const existing = this._pickFromDeviceManager(filterId, filterName);
            if (existing) {
                if (!existing.isConnected && typeof existing.connect === "function") {
                    try { await existing.connect(); } catch {}
                }
                this.device = existing;
            } else {
                // 2) Otherwise, use scanner: discover and connect
                await this._connectViaScanner(filterId, filterName);
            }

            this._setupEventListeners();
            await this._waitForConnection();
            return this.device;
        } catch (err) {
            this.emit("error", err);
            throw err;
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
            const list = dm && Array.isArray(dm.AvailableDevices) ? dm.AvailableDevices : [];
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
        if (process.env.DEBUG) {
            console.log(
                "[DeviceManager] scanner present:",
                Boolean(scanner),
                "isSupported:",
                scanner?.isSupported,
                "isScanningAvailable:",
                scanner?.isScanningAvailable
            );
        }

        if (!scanner || !scanner.isSupported) {
            throw new Error("Scanner not available or not supported in this environment");
        }
        if (!scanner.isScanningAvailable) {
            const ok = await this._waitForScanningAvailable(scanner, 20000);
            if (!ok) throw new Error("BLE scanning not available.");
        }

        if (process.env.DEBUG) console.log("[DeviceManager] starting BLE scan...");
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
            if (process.env.DEBUG) console.log("[DeviceManager] discovered:", discoveredDevice?.name || discoveredDevice?.bluetoothId);
            scanner.stopScan();
            const id = discoveredDevice.bluetoothId || discoveredDevice.id;
            await scanner.connectToDevice(id);
            // Wait for SDK DeviceManager to expose the connected instance
            this.device = await this._awaitDeviceById(id, 15000);
            if (!this.device) {
                throw new Error("Connected device instance not found after connectToDevice");
            }
        } finally {
            try { scanner.stopScan(); } catch {}
        }
    }

    async _waitForScanningAvailable(scanner, timeoutMs = 20000) {
        if (scanner.isScanningAvailable) return true;
        return new Promise((resolve) => {
            let done = false;
            const cleanup = () => {
                if (done) return; done = true;
                clearInterval(iv);
                clearTimeout(to);
                try { scanner.removeEventListener?.("isScanningAvailable", onEvt); } catch {}
            };
            const onEvt = (ev) => {
                const avail = ev?.message?.isScanningAvailable ?? ev?.isScanningAvailable ?? scanner.isScanningAvailable;
                if (avail) { cleanup(); resolve(true); }
            };
            try { scanner.addEventListener?.("isScanningAvailable", onEvt); } catch {}
            const iv = setInterval(() => {
                if (scanner.isScanningAvailable) { cleanup(); resolve(true); }
            }, 300);
            const to = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
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
                if (process.env.DEBUG) {
                    console.log("[DeviceManager] connectionStatus:", this.device.connectionStatus);
                }
            });
            this.device.addEventListener?.("microphoneStatus", () => {
                if (process.env.DEBUG) {
                    console.log("[DeviceManager] microphoneStatus:", this.device.microphoneStatus);
                }
            });
            this.device.addEventListener?.("getSensorConfiguration", () => {
                if (process.env.DEBUG) {
                    console.log("[DeviceManager] sensorConfiguration:", this.device.sensorConfiguration);
                }
            });
            this.device.addEventListener?.("getMicrophoneConfiguration", () => {
                if (process.env.DEBUG) {
                    console.log("[DeviceManager] microphoneConfiguration:", this.device.microphoneConfiguration);
                }
            });
        } catch (error) {
            console.warn("[DeviceManager] Failed to setup event listeners:", error);
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
