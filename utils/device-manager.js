// Device connection and management utilities for BrilliantSole devices
const EventEmitter = require("events");

// Defer loading ESM module until runtime using dynamic import
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
            }

            const connectionType = (process.env.MIC_CONNECTION || "").toLowerCase();
            const allowFallback = process.env.MIC_ALLOW_FALLBACK === "1";
            const filterId = process.env.MIC_DEVICE_ID || "";
            const filterName = process.env.MIC_DEVICE_NAME || "";

            if (connectionType === "webbluetooth") {
                await this._connectViaWebBluetooth();
            } else {
                try {
                    await this._connectViaNoble(filterId, filterName);
                } catch (e) {
                    console.warn(
                        "[DeviceManager] Noble path failed:",
                        e?.message || e
                    );
                    if (allowFallback) {
                        console.warn(
                            "[DeviceManager] Falling back to WebBluetooth because MIC_ALLOW_FALLBACK=1"
                        );
                        await this._connectViaWebBluetooth();
                    } else {
                        throw e;
                    }
                }
            }

            this._setupEventListeners();
            await this._waitForConnection();

            return this.device;
        } catch (err) {
            this.emit("error", err);
            throw err;
        }
    }

    async _connectViaNoble(filterId, filterName) {
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
            throw new Error(
                "Scanner not available or not supported in this environment"
            );
        }

        // Wait for scanning availability if needed
        if (!scanner.isScanningAvailable) {
            console.log("[DeviceManager] waiting for scanning availability...");
            const ev = await scanner.waitForEvent("isScanningAvailable");
            console.log(
                "[DeviceManager] isScanningAvailable event:",
                ev.message.isScanningAvailable
            );

            if (!ev.message.isScanningAvailable) {
                throw new Error(
                    "BLE scanning not available. On macOS, enable Bluetooth permission for your terminal in System Settings → Privacy & Security → Bluetooth."
                );
            }
        }

        if (process.env.DEBUG) console.log("[DeviceManager] starting BLE scan...");
        scanner.startScan();

        let discoveredDevice;
        const pick = async () => {
            while (true) {
                const ev = await scanner.waitForEvent("discoveredDevice");
                const dd = ev.message.discoveredDevice;
                if (filterId && dd.bluetoothId !== filterId) continue;
                if (filterName && dd.name !== filterName) continue;
                return dd;
            }
        };

        discoveredDevice = await pick();
        console.log("[DeviceManager] discovered device:", discoveredDevice);
        scanner.stopScan();

        console.log(
            "[DeviceManager] connecting via Noble to",
            discoveredDevice.bluetoothId
        );
        await scanner.connectToDevice(discoveredDevice.bluetoothId);

        const dm = BS.DeviceManager;
        let connected = null;
        const start = Date.now();

        while (Date.now() - start < 15000) {
            const list =
                dm && Array.isArray(dm.AvailableDevices) ? dm.AvailableDevices : [];
            connected = list.find(
                (d) => d.bluetoothId === discoveredDevice.bluetoothId
            );
            if (!connected && discoveredDevice.name) {
                connected = list.find((d) => d.name === discoveredDevice.name);
            }
            if (connected) break;
            await new Promise((r) => setTimeout(r, 200));
        }

        if (!connected) {
            const list =
                dm && Array.isArray(dm.AvailableDevices) ? dm.AvailableDevices : [];
            if (process.env.DEBUG) {
                console.warn(
                    "[DeviceManager] AvailableDevices after connect:",
                    list.map((d) => ({
                        id: d.bluetoothId,
                        name: d.name,
                        type: d.connectionType,
                    }))
                );
            }
            throw new Error(
                "Connected device instance not found after scanner.connectToDevice"
            );
        }

        this.device = connected;
    }

    async _connectViaWebBluetooth() {
        if (process.env.DEBUG)
            console.log("[DeviceManager] connecting with WebBluetooth path...");
        const device = new BS.Device();
        this.device = device;
        await device.connect({ type: "webBluetooth" });
        if (process.env.DEBUG)
            console.log("[DeviceManager] connected with WebBluetooth path");
    }

    _setupEventListeners() {
        try {
            this.device.addEventListener?.("connectionStatus", () => {
                if (process.env.DEBUG) {
                    console.log(
                        "[DeviceManager] connectionStatus:",
                        this.device.connectionStatus
                    );
                }
            });
            this.device.addEventListener?.("microphoneStatus", () => {
                if (process.env.DEBUG) {
                    console.log(
                        "[DeviceManager] microphoneStatus:",
                        this.device.microphoneStatus
                    );
                }
            });
            this.device.addEventListener?.("getSensorConfiguration", () => {
                if (process.env.DEBUG) {
                    console.log(
                        "[DeviceManager] sensorConfiguration:",
                        this.device.sensorConfiguration
                    );
                }
            });
            this.device.addEventListener?.("getMicrophoneConfiguration", () => {
                if (process.env.DEBUG) {
                    console.log(
                        "[DeviceManager] microphoneConfiguration:",
                        this.device.microphoneConfiguration
                    );
                }
            });
        } catch (error) {
            console.warn("[DeviceManager] Failed to setup event listeners:", error);
        }
    }

    async _waitForConnection() {
        // Wait until connected and ensure microphone is present
        await new Promise((resolve, reject) => {
            let timer = setTimeout(
                () => reject(new Error("Timeout waiting for device connection")),
                20000
            );

            const check = () => {
                if (this.device.isConnected) {
                    clearTimeout(timer);
                    resolve();
                }
            };

            const interval = setInterval(() => {
                if (this.device.isConnected) {
                    clearInterval(interval);
                    check();
                }
            }, 300);

            check();
        });
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
