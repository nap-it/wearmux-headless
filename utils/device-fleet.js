const { DeviceManager } = require("./device-manager");
const { DeviceSession } = require("./device-session");
const { ACTION_TOPIC, RESULT_TOPIC } = require("./action-dispatcher");
const { createPublisher, createSubscriber } = require("./transport");
const { topic } = require("./topics");
const { VruStopRequestInteraction } = require("../interactions/vru-stop-request");
const { loadSdk, usesAndroidBleBridge } = require("./sdk");
const { AndroidBleBridge } = require("./android-ble/bridge");

// Own one session per discovered wearable while sharing a single transport connection.
const normalizeId = (value) => String(value || "").toLowerCase().replaceAll(":", "");

/**
 * Owns one {@link DeviceSession} per connected wearable and routes transport actions.
 *
 * @class
 * @example
 * const { DeviceFleet } = require("./utils/device-fleet");
 * const fleet = new DeviceFleet();
 * async function main() {
 *     try {
 *         await fleet.start();
 *         // Application uses the configured data streams here.
 *     } finally {
 *         await fleet.stop();
 *     }
 * }
 * main().catch(console.error);
 */
class DeviceFleet {
    /** Create a fleet using the selected transport and optional VRU interaction. */
    constructor() {
        this.sessions = new Map();
        this.connecting = new Set();
        this.connectQueue = Promise.resolve();
        this.publisher = createPublisher({ keyPrefix: topic() });
        this.subscriber = createSubscriber({ topicFilter: ACTION_TOPIC });
        this.vruInteraction = process.env.VRU_INTERACTION_ENABLED === "1"
            ? new VruStopRequestInteraction({
                publisher: this.publisher,
                getSessions: () => this.sessions.values(),
            })
            : null;
        this.actions = new Set();
        this.stopping = false;
        this.cameraCount = 0;
        this.microphoneCount = 0;
        this.onDiscovered = (event) => this.discovered(event.message?.discoveredDevice);
        this.onConnected = (event) => {
            this.attach(event.message?.device).catch((error) =>
                console.warn("[Fleet] device session:", error?.message || error));
        };
        this.onScanningAvailable = () => this.scan();
        this.onNotScanning = () => {
            if (!this.stopping) setTimeout(() => this.scan(), 1000);
        };
        this.onAction = ({ key, payload }) => {
            if (key !== ACTION_TOPIC) return;
            const task = this.routeAction(payload).catch((error) =>
                console.warn("[Actions]", error?.message || error));
            this.actions.add(task);
            task.finally(() => this.actions.delete(task));
        };
    }

    /**
     * Start transport listeners, attach existing devices, and begin scanning.
     * @returns {Promise<void>}
     * @throws {Error} If no scanner is available and `DEVICE_IP` is not configured,
     * or startup of a selected transport fails.
     */
    async start() {
        // Start messaging before scanning so the first connected device can publish immediately.
        if (this.publisher) {
            this.publisher.on("error", (error) => console.warn("[Transport]", error?.message || error));
            await this.publisher.start();
        }
        if (this.subscriber) {
            this.subscriber.on("error", (error) => console.warn("[Actions]", error?.message || error));
            this.subscriber.on("message", this.onAction);
            await this.subscriber.start();
            console.log(`[Actions] Listening on ${ACTION_TOPIC}`);
        }
        await this.vruInteraction?.start();
        this.sdk = await loadSdk();
        if (usesAndroidBleBridge()) {
            if (process.env.DEVICE_IP) throw new Error("DEVICE_IP cannot be combined with DEVICE_TRANSPORT=android-ble");
            this.androidBridge = new AndroidBleBridge({ sdk: this.sdk });
            this.androidBridge.on("error", (error) => console.warn("[Android BLE]", error?.message || error));
            this.androidBridge.on("status", (status) => console.log("[Android BLE]", status));
            // Explicit listener also supports SDK builds whose global manager does
            // not publish transport-specific connection events. attach deduplicates.
            this.androidBridge.on("deviceConnected", (device) => this.onConnected({ message: { device } }));
            await this.androidBridge.start();
            console.log("[Fleet] Waiting for the Android BLE companion");
            return;
        }

        this.sdk.DeviceManager.AddEventListener("deviceConnected", this.onConnected);
        for (const device of this.sdk.DeviceManager.ConnectedDevices || []) {
            await this.attach(device);
        }

        if (process.env.DEVICE_IP) {
            const manager = new DeviceManager();
            manager.on("error", (error) => console.warn("[Fleet] Wi-Fi:", error?.message || error));
            manager.connectToDevice().then((device) => this.attach(device)).catch((error) =>
                console.warn("[Fleet] Wi-Fi connection:", error?.message || error));
        }

        this.scanner = this.sdk.Scanner;
        if (!this.scanner?.isSupported) {
            if (!process.env.DEVICE_IP) throw new Error("No BLE scanner available; set DEVICE_IP for Wi-Fi");
            return;
        }
        // Scanner events can stop while a connection is in progress; resume scanning afterward.
        this.scanner.addEventListener("discoveredDevice", this.onDiscovered);
        this.scanner.addEventListener("scanningAvailable", this.onScanningAvailable);
        this.scanner.addEventListener("notScanning", this.onNotScanning);
        this.scan();
        this.scanTimer = setInterval(() => this.scan(), 5000);
        console.log("[Fleet] Discovering all compatible devices");
    }

    /** Request a scan when the SDK scanner is available and idle. */
    scan() {
        if (this.stopping || !this.scanner?.isScanningAvailable || this.scanner.isScanning) return;
        try { this.scanner.startScan(); }
        catch (error) { console.warn("[Fleet] scan:", error?.message || error); }
    }

    /**
     * Check the optional ID and name filters from the environment.
     * @param {Object} device SDK device or discovery record.
     * @returns {boolean} Whether the filters accept the device.
     */
    matches(device) {
        // Filters are optional. With neither set, every compatible device is accepted.
        const id = process.env.DEVICE_ID || process.env.MIC_DEVICE_ID;
        const name = process.env.DEVICE_NAME || process.env.MIC_DEVICE_NAME;
        if (id && normalizeId(device.bluetoothId || device.id) !== normalizeId(id)) return false;
        if (name && !id && String(device.name || "").toLowerCase() !== name.toLowerCase()) return false;
        return true;
    }

    /**
     * Queue a discovered device for serialized connection and session attachment.
     * Repeated advertisements for the same normalized ID are deduplicated.
     * @param {Object} discoveredDevice SDK discovery record.
     * @returns {void}
     */
    discovered(discoveredDevice) {
        if (!discoveredDevice || this.stopping || !this.matches(discoveredDevice)) return;
        const rawId = discoveredDevice.bluetoothId || discoveredDevice.id;
        const key = normalizeId(rawId);
        if (!key || this.connecting.has(key) || this.sessions.get(key)?.device.isConnected) return;
        // Serialize SDK connection attempts and deduplicate repeat advertisements by device ID.
        this.connecting.add(key);
        this.connectQueue = this.connectQueue.catch(() => {}).then(async () => {
            if (this.stopping || this.sessions.get(key)?.device.isConnected) {
                this.connecting.delete(key);
                return;
            }
            console.log(`[Fleet] Connecting ${discoveredDevice.name || "device"} (${rawId})`);
            const operation = Promise.resolve().then(() => this.scanner.connectToDevice(rawId));
            operation.catch(() => {}).finally(() => this.connecting.delete(key));
            let timer;
            try {
                const timeout = new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("connection timed out")), 20000);
                });
                await Promise.race([operation, timeout]);
            } finally {
                clearTimeout(timer);
            }
            const connected = this.sdk.DeviceManager.AvailableDevices?.find((device) =>
                normalizeId(device.bluetoothId || device.id) === key && device.isConnected);
            if (connected) await this.attach(connected);
        }).catch((error) => console.warn(`[Fleet] ${rawId}:`, error?.message || error));
    }

    /**
     * Attach a connected SDK device as a managed session.
     * @param {Object} device Connected SDK device.
     * @returns {Promise<void>}
     * @throws {Error} If session startup fails; the session is removed before rejection.
     */
    async attach(device) {
        if (this.stopping || !device || device.isConnected === false || !this.matches(device)) return;
        const key = normalizeId(device.bluetoothId || device.id);
        if (!key || this.sessions.has(key)) return;
        // Number only devices with each media capability so their viewer ports stay consecutive.
        const session = new DeviceSession(device, this.publisher, {
            cameraIndex: device.hasCamera ? this.cameraCount++ : 0,
            microphoneIndex: device.hasMicrophone ? this.microphoneCount++ : 0,
        });
        this.sessions.set(key, session);
        try { await session.start(); }
        catch (error) {
            this.sessions.delete(key);
            throw error;
        }
    }

    /**
     * Validate, target, and execute one action payload, then publish its result.
     * @param {ActionCommand|string} payload JSON action object or encoded JSON string.
     * @returns {Promise<void>}
     */
    async routeAction(payload) {
        let command = payload;
        try {
            if (typeof command === "string") command = JSON.parse(command);
            if (!command || typeof command !== "object" || Array.isArray(command)) {
                throw new Error("Action payload must be a JSON object");
            }
        } catch (error) {
            await this.publishActionResult({ ok: false, error: error.message });
            return;
        }

        const result = {
            id: typeof command.id === "string" ? command.id : undefined,
            action: typeof command.action === "string" ? command.action : undefined,
        };
        try {
            if (typeof command.action !== "string") throw new Error("Action requires a string action");
            if (command.deviceId !== undefined && typeof command.deviceId !== "string") {
                throw new Error("deviceId must be a string");
            }
            const connected = [...this.sessions.values()].filter((session) => session.ready && session.device.isConnected);
            let session;
            if (command.deviceId) {
                session = connected.find((item) => normalizeId(item.info.id) === normalizeId(command.deviceId));
                if (!session) throw new Error(`Device '${command.deviceId}' is not connected`);
            } else {
                // Never broadcast an action: require a device ID if multiple devices can perform it.
                const eligible = connected.filter((item) =>
                    command.action.startsWith("display.") ? item.capabilities.display :
                        command.action === "haptic.vibrate" && item.capabilities.haptics);
                if (!eligible.length) throw new Error(`No connected device supports '${command.action}'`);
                if (eligible.length > 1) throw new Error(`Multiple devices support '${command.action}'; set deviceId`);
                session = eligible[0];
            }
            result.device = session.info;
            await session.dispatchAction(command);
            result.ok = true;
        } catch (error) {
            result.ok = false;
            result.error = error.message;
        }
        await this.publishActionResult(result);
    }

    /**
     * Publish an action result on the configured result topic.
     * @param {ActionResult} result
     * @returns {Promise<void>}
     */
    async publishActionResult(result) {
        await this.publisher.publish(RESULT_TOPIC, { ts: Date.now(), device: null, ...result });
    }

    /**
     * Stop scanning, inbound actions, VRU interaction, sessions, and the shared publisher.
     * Existing SDK device connections are explicitly disconnected after sessions stop.
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        // Stop discovery and inbound commands before tearing down each device session.
        clearInterval(this.scanTimer);
        this.scanner?.removeEventListener("discoveredDevice", this.onDiscovered);
        this.scanner?.removeEventListener("scanningAvailable", this.onScanningAvailable);
        this.scanner?.removeEventListener("notScanning", this.onNotScanning);
        try { this.scanner?.stopScan(); } catch {}
        this.sdk?.DeviceManager.RemoveEventListener("deviceConnected", this.onConnected);
        if (this.subscriber) {
            this.subscriber.off("message", this.onAction);
            await this.subscriber.stop();
        }
        await this.vruInteraction?.stop();
        await Promise.all([...this.actions]);
        for (const session of this.sessions.values()) {
            try { await session.stop(); }
            catch (error) { console.warn(`[Fleet] stop ${session.info.id}:`, error?.message || error); }
            try { await session.device.disconnect(); } catch {}
        }
        this.sessions.clear();
        await this.androidBridge?.stop();
        await this.publisher?.stop();
    }
}

module.exports = { DeviceFleet };
