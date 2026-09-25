const { Config } = require("./config");
const { topic } = require("./topics");
const { ActionDispatcher } = require("./action-dispatcher");
const { SensorManager, DEFAULT_SENSOR_RATES } = require("../sensors/lib/sensor-manager");
const { CameraSession } = require("../camera/lib/camera-session");
const { MicrophoneSession } = require("../microphone/lib/microphone-session");

// Coordinates the capabilities exposed by one already-connected physical device.
class DeviceSession {
    constructor(device, publisher, options = {}) {
        this.device = device;
        this.publisher = publisher;
        this.cameraIndex = options.cameraIndex || 0;
        this.microphoneIndex = options.microphoneIndex || 0;
        this.info = { id: device.bluetoothId || device.id || null, name: device.name || null };
        this.capabilities = { sensors: [], camera: false, microphone: false, display: false, haptics: false };
        this.actions = new ActionDispatcher(device, { publisher });
        this.pendingAction = Promise.resolve();
        this.sensorHandlers = new Map();
        this.sensorPublishBusy = new Set();
        this.running = false;
        this.ready = false;
        this.started = false;
        this.resuming = null;
        this.onConnection = (event) => {
            if (event.message?.isConnected === true && this.running && this.started) {
                this.resume().catch((error) => console.warn(`[Device][${this.info.id}] reconnect:`, error?.message || error));
            } else if (event.message?.isConnected === false) {
                this.ready = false;
                this.publishStatus("disconnected");
            }
        };
    }

    refreshCapabilities() {
        this.info.id = this.device.bluetoothId || this.device.id || this.info.id;
        this.info.name = this.device.name || this.info.name;
        const known = Object.keys(DEFAULT_SENSOR_RATES);
        const available = Array.isArray(this.device.availableSensorTypes) ? this.device.availableSensorTypes : [];
        // Build the supported feature set from SDK-reported capabilities, not device names.
        this.capabilities = {
            sensors: known.filter((sensor) => available.includes(sensor)),
            camera: Boolean(this.device.hasCamera),
            microphone: Boolean(this.device.hasMicrophone),
            display: Boolean(this.device.isDisplayAvailable),
            haptics: Array.isArray(this.device.vibrationLocations) && this.device.vibrationLocations.length > 0,
        };
    }

    async start() {
        if (this.running) return;
        this.refreshCapabilities();
        this.running = true;
        this.device.addEventListener?.("isConnected", this.onConnection);
        console.log(`[Device][${this.info.id}] ${this.info.name || "unnamed"}: ${JSON.stringify(this.capabilities)}`);
        try {
            // Start sensor configuration first; media sessions then add their own sensor rates.
            await this.startSensors();
            if (this.capabilities.camera) {
                this.camera = new CameraSession(this.device, this.publisher, {
                    cameraIndex: this.cameraIndex, deviceInfo: this.info,
                });
                try { await this.camera.start(); }
                catch (error) { console.warn(`[Device][${this.info.id}] camera:`, error?.message || error); this.camera = null; }
            }
            if (this.capabilities.microphone) {
                this.microphone = new MicrophoneSession(this.device, this.publisher, {
                    microphoneIndex: this.microphoneIndex, deviceInfo: this.info,
                });
                try { await this.microphone.start(); }
                catch (error) { console.warn(`[Device][${this.info.id}] microphone:`, error?.message || error); this.microphone = null; }
            }
            await this.publishStatus("connected");
            this.started = true;
            this.ready = true;
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async startSensors() {
        const requested = process.env.ENABLED_SENSORS?.split(",").map((sensor) => sensor.trim()).filter(Boolean);
        const enabled = requested?.length
            ? this.capabilities.sensors.filter((sensor) => requested.includes(sensor))
            : this.capabilities.sensors;
        if (process.env.VRU_INTERACTION_ENABLED === "1" &&
            this.capabilities.sensors.includes("orientation") &&
            !enabled.includes("orientation")) {
            enabled.push("orientation");
        }
        if (!enabled.length) return;
        this.sensors = new SensorManager(this.device, {
            enabledSensors: [...enabled], side: process.env.DEVICE_SIDE || null,
            // Preserve media sensor settings configured by the camera or microphone session.
            publisherEnabled: false, clearRest: false,
        });
        for (const [sensor, rate] of Object.entries(Config.getSensorRates())) {
            if (rate !== null && enabled.includes(sensor)) this.sensors.setSensorRate(sensor, rate);
        }
        this.sensors.on("error", (error) => console.warn(`[Device][${this.info.id}] sensor:`, error?.message || error));
        for (const sensor of enabled) {
            const handler = (event) => {
                // Drop an update if publishing this sensor is still in flight to avoid a growing queue.
                if (!this.publisher || this.sensorPublishBusy.has(sensor)) return;
                this.sensorPublishBusy.add(sensor);
                this.publisher.publish(topic("sensors", sensor), {
                    ts: Date.now(), sensor, device: this.info,
                    message: event?.message ?? null,
                }).catch((error) => console.warn(`[Device][${this.info.id}] publish ${sensor}:`, error?.message || error))
                    .finally(() => this.sensorPublishBusy.delete(sensor));
            };
            this.sensors.on(sensor, handler);
            this.sensorHandlers.set(sensor, handler);
        }
        await this.sensors.startSensors();
    }

    dispatchAction(command) {
        this.pendingAction = this.pendingAction
            .catch(() => {})
            .then(() => this.actions.dispatch(command));
        return this.pendingAction;
    }

    async resume() {
        if (this.resuming) return this.resuming;
        this.resuming = (async () => {
            if (!this.running) return;
            this.ready = false;
            this.refreshCapabilities();
            // Reapply device configuration after the SDK reconnects.
            if (this.sensors) {
                try { await this.sensors.reconfigure(); }
                catch (error) { console.warn(`[Device][${this.info.id}] sensor resume:`, error?.message || error); }
            }
            if (this.camera) {
                try { await this.camera.resume(); }
                catch (error) { console.warn(`[Device][${this.info.id}] camera resume:`, error?.message || error); }
            }
            if (this.microphone) {
                try { await this.microphone.resume(); }
                catch (error) { console.warn(`[Device][${this.info.id}] microphone resume:`, error?.message || error); }
            }
            if (this.running) {
                await this.publishStatus("connected");
                this.ready = true;
            }
        })().finally(() => { this.resuming = null; });
        return this.resuming;
    }

    async publishStatus(status) {
        if (!this.publisher) return;
        try {
            await this.publisher.publish(topic("devices", "status"), {
                ts: Date.now(), device: this.info, status, capabilities: this.capabilities,
            });
        } catch (error) {
            console.warn(`[Device][${this.info.id}] status:`, error?.message || error);
        }
    }

    async stop() {
        this.running = false;
        this.ready = false;
        this.started = false;
        this.device.removeEventListener?.("isConnected", this.onConnection);
        // Stop feature handlers before disconnecting so no more data is sent for this device.
        await this.camera?.stop();
        await this.microphone?.stop();
        if (this.sensors) {
            for (const [sensor, handler] of this.sensorHandlers) this.sensors.off(sensor, handler);
            await this.sensors.stop();
        }
        this.sensorHandlers.clear();
        this.sensorPublishBusy.clear();
        await this.publishStatus("disconnected");
    }
}

module.exports = { DeviceSession };
