// Sensor management for Brilliant Wear device sensors
const EventEmitter = require("events");
const { createPublisher, selectedTransport } = require("../../utils/transport");
const { topic } = require("../../utils/topics");

/**
 * Baseline SDK sensor-configuration values. These are passed to the device SDK;
 * they are distinct from the host emission throttle in *_RATE environment variables.
 * Device firmware determines the interpretation of these values.
 * @type {Object<string, number>}
 */
const DEFAULT_SENSOR_RATES = Object.freeze({
    acceleration: 50,
    magnetometer: 50,
    orientation: 50,
    gravity: 50,
    linearAcceleration: 50,
    gyroscope: 50,
    gameRotation: 50,
    rotation: 50,
    activity: 5,
    stepCounter: 5,
    tapDetector: 5,
    pressure: 50,
});

/**
 * Configure supported sensors and forward SDK events through Node's EventEmitter.
 * Subscribe with on(sensorType, handler); the handler receives the SDK event,
 * optionally extended with a side label. The owner keeps the device connected.
 * Attach an error listener before changing configuration during monitoring.
 * Configure enabled sensors before startSensors(); that method installs listeners
 * for the initial selection. Later selection changes do not rebuild those listeners.
 * @class
 * @extends EventEmitter
 * @fires SensorManager#error
 * @see {@tutorial sensors}
 */
class SensorManager extends EventEmitter {
    /**
     * @param {Object} device Connected SDK device.
     * @param {Object} [options={}] Configuration and publisher ownership settings.
     * @param {string[]} [options.enabledSensors=[]] Initial selection; empty enables all known supported sensors.
     * @param {?string} [options.side=null] Optional side label added to forwarded events.
     * @param {boolean} [options.clearRest=true] Whether SDK configuration replaces other active modes.
     * @param {string} [options.transport] mqtt, zenoh, or none; defaults to selectedTransport().
     * @param {boolean} [options.publisherEnabled] Defaults to true when a transport is selected.
     * @param {string} [options.publisherKeyPrefix] Sensor topic root, normally bwear/sensors.
     * @throws {Error} When device is missing or the selected transport is invalid.
     */
    constructor(device, options = {}) {
        super();
        if (!device) {
            throw new Error("SensorManager requires a device instance (use SDK DeviceManager to connect)");
        }
        this.device = device;
        this.side = options.side || null; // 'left' | 'right' | null
        this.enabledSensors = options.enabledSensors || [];
        // When false, setSensorConfiguration preserves other active modes such as camera and microphone.
        this.clearRest = options.clearRest !== undefined ? Boolean(options.clearRest) : true;
        this.isMonitoring = false;
        this.sensorConfiguration = {};
        
        // Transport integration: zenoh or mqtt, auto-selected by env.
        this.transport = options.transport || selectedTransport();
        this.publisherEnabled =
            options.publisherEnabled !== undefined
                ? Boolean(options.publisherEnabled)
                : this.transport !== "none";
        this.publisherOptions = {
            keyPrefix: options.publisherKeyPrefix || topic("sensors"),
            prettyJson: true,
        };
        this.publisher = null;

        // Available sensor types with their default device rates (SDK expects multiples of 5).
        // Rate 0 means disabled by default; non-zero means enabled at that rate when included
        // in ENABLED_SENSORS. Insoles support the full IMU set; Frame only has the first group.
        this.availableSensors = { ...DEFAULT_SENSOR_RATES };

        // Build per-sensor output throttle (Hz or ms) from environment
        this.outputThrottleMs = this._buildOutputThrottleMap();
    }

    /**
     * Start an owned publisher when enabled, configure sensors, then attach listeners.
     * Call once per start/stop cycle. Publisher startup failures are logged and
     * monitoring proceeds; device configuration failures reject.
     * @returns {Promise<void>}
     */
    async startSensors() {
        // If a transport is selected, start the publisher and attach sensors
        if (this.publisherEnabled && this.transport !== "none") {
            try {
                this.publisher = createPublisher({
                    transport: this.transport,
                    keyPrefix: this.publisherOptions.keyPrefix,
                    prettyJson: this.publisherOptions.prettyJson,
                });
                this.publisher.on("error", (e) =>
                    console.warn(`[SensorManager][${this.transport}]`, e?.message || e)
                );
                await this.publisher.start();
                await this.publisher.attachToSensorManager(this, { quiet: true });
            } catch (e) {
                console.warn(
                    `[SensorManager] Failed to start ${this.transport} publisher:`,
                    e?.message || e
                );
            }
        }

        await this._configureSensors();

        // Wait for configuration to take effect
        await new Promise((r) => setTimeout(r, 500));

        // Setup event listeners for sensor data
        this._setupSensorEventListeners();
        
        this.isMonitoring = true;
    }

    /** @private */
    async _configureSensors() {
        // Build sensor configuration - ONLY for enabled sensors
        this.sensorConfiguration = {};

        if (this.enabledSensors.length === 0) {
            // Enable all sensors by default
            this.enabledSensors = Object.keys(this.availableSensors).filter(
                (sensor) => sensor !== "camera" && sensor !== "microphone"
            );
        }

        // Filter against sensors the device actually supports (populated after connect)
        const deviceSensors = this.device.availableSensorTypes;
        if (Array.isArray(deviceSensors) && deviceSensors.length > 0) {
            const skipped = this.enabledSensors.filter((s) => !deviceSensors.includes(s));
            if (skipped.length > 0) {
                console.log(`[SensorManager] Skipping sensors not available on this device: ${skipped.join(", ")}`);
            }
            this.enabledSensors = this.enabledSensors.filter((s) => deviceSensors.includes(s));
        }

        this.enabledSensors.forEach((sensorType) => {
            if (this.availableSensors.hasOwnProperty(sensorType)) {
                this.sensorConfiguration[sensorType] =
                    this.availableSensors[sensorType];
            } else {
                console.warn(`[SensorManager] Unknown sensor type: ${sensorType}`);
            }
        });

        console.log(
            "[SensorManager] Configuring sensors:",
            this.sensorConfiguration
        );
        console.log("[SensorManager] Enabled sensors:", this.enabledSensors);

        if (typeof this.device.setSensorConfiguration === "function") {
            await this.device.setSensorConfiguration(this.sensorConfiguration, this.clearRest);
        } else {
            console.warn(
                "[SensorManager] Device does not support setSensorConfiguration"
            );
        }
    }

    /** @private */
    _buildOutputThrottleMap() {
        // Accept per-sensor RATE as either Hz (number) or ms (string with 'ms')
        const sensors = Object.keys(this.availableSensors);
        const toEnvKey = (name) => name.replace(/([A-Z])/g, "_$1").toUpperCase();
        const clampMs = (ms) => Math.max(5, Math.min(1000, ms));
        const map = {};
        for (const sensor of sensors) {
            const envKey = `${toEnvKey(sensor)}_RATE`;
            const raw = process.env[envKey];
            if (!raw) continue;
            let ms;
            if (/ms$/i.test(raw)) {
                const v = Number(raw.replace(/ms$/i, ""));
                if (!Number.isNaN(v) && v > 0) ms = clampMs(v);
            } else {
                const hz = Number(raw);
                if (!Number.isNaN(hz) && hz > 0) ms = clampMs(1000 / hz);
            }
            if (ms) map[sensor] = ms;
        }
        return map;
    }

    /** @private */
    _setupSensorEventListeners() {
        if (typeof this.device.addEventListener !== "function") {
            console.warn("[SensorManager] Device does not support addEventListener");
            return;
        }

        // Client-side emission throttle based on *_RATE envs (Hz or ms)
        const lastEmitMs = {};

        // Track device listeners so stop() can remove them (prevents duplicate
        // registration if startSensors is called again after stop).
        this._deviceListeners = this._deviceListeners || new Map();

        // Motion sensor events
        const motionSensors = [
            "acceleration",
            "gravity",
            "linearAcceleration",
            "gyroscope",
            "magnetometer",
            "gameRotation",
            "rotation",
            "orientation",
        ];

        const allSensors = [...motionSensors, "activity", "stepCounter", "pressure", "tapDetector"];
        allSensors.forEach((sensorType) => {
            if (this.enabledSensors.includes(sensorType)) {
                const handler = (event) => {
                    const interval = this.outputThrottleMs[sensorType];
                    if (interval) {
                        const now = Date.now();
                        const last = lastEmitMs[sensorType] || 0;
                        if (now - last < interval) return;
                        lastEmitMs[sensorType] = now;
                    }
                    this.emit(sensorType, this.side ? { ...event, side: this.side } : event);
                };
                this.device.addEventListener(sensorType, handler);
                this._deviceListeners.set(sensorType, handler);
            }
        });

        if (process.env.DEBUG === '1') {
            const sensorDataHandler = (event) => {
                const { sensorType, timestamp, isLast } = event.message || {};
                console.log(`[SensorManager] sensorData: ${sensorType} t=${timestamp} last=${isLast}`);
                this.emit("sensorData", event);
            };
            this.device.addEventListener("sensorData", sensorDataHandler);
            this._deviceListeners.set("sensorData", sensorDataHandler);
        }
    }

    /** @private */
    _removeDeviceListeners() {
        if (!this._deviceListeners || typeof this.device?.removeEventListener !== "function") return;
        for (const [sensorType, handler] of this._deviceListeners.entries()) {
            try { this.device.removeEventListener(sensorType, handler); } catch { }
        }
        this._deviceListeners.clear();
    }

    /**
     * Stop the owned publisher and remove SDK listeners. Does not disconnect the
     * device or disable sensor configuration on it. Publisher errors are logged.
     * @returns {Promise<void>}
     */
    async stop() {
        try {
            if (this.publisher) {
                await this.publisher.stop();
            }
        } catch (e) {
            console.warn(`[SensorManager] Error stopping ${this.transport} publisher:`, e?.message || e);
        } finally {
            this.publisher = null;
        }
        this._removeDeviceListeners();
        this.isMonitoring = false;
    }

    /**
     * Reapply the current sensor selection after reconnection, if monitoring.
     * @returns {Promise<void>} Rejects on SDK configuration failure.
     */
    async reconfigure() {
        // Reapply rates after the device SDK reports a connection has resumed.
        if (this.isMonitoring) await this._configureSensors();
    }

    // Sensor-specific methods
    /**
     * Add a known sensor to the selection; asynchronous configuration failures
     * during monitoring emit error. Does not install new event listeners.
     * @param {string} sensorType Key from DEFAULT_SENSOR_RATES.
     * @param {?number} [sampleRate=null] SDK configuration value; null preserves its current value.
     * @returns {void}
     * @throws {Error} When the sensor type is unknown.
     */
    enableSensor(sensorType, sampleRate = null) {
        if (!this.availableSensors.hasOwnProperty(sensorType)) {
            throw new Error(`Unknown sensor type: ${sensorType}`);
        }

        if (!this.enabledSensors.includes(sensorType)) {
            this.enabledSensors.push(sensorType);
        }

        if (sampleRate !== null) {
            this.availableSensors[sensorType] = sampleRate;
        }

        if (this.isMonitoring) {
            this._configureSensors().catch((error) => this.emit("error", error));
        }
    }

    /**
     * Remove a sensor from the requested selection and reconfigure when monitoring.
     * Existing listeners remain until stop(); an empty selection enables defaults
     * on the next configuration pass. Async failures emit error.
     * @param {string} sensorType Sensor name to remove.
     * @returns {void}
     */
    disableSensor(sensorType) {
        const index = this.enabledSensors.indexOf(sensorType);
        if (index > -1) {
            this.enabledSensors.splice(index, 1);
        }

        if (this.isMonitoring) {
            this._configureSensors().catch((error) => this.emit("error", error));
        }
    }

    /**
     * Set the SDK configuration value for a known sensor. During monitoring,
     * reconfiguration is asynchronous and failures emit error.
     * @param {string} sensorType Key from DEFAULT_SENSOR_RATES.
     * @param {number} sampleRate Value passed to the SDK, independent of host throttling.
     * @returns {void}
     * @throws {Error} When the sensor type is unknown.
     */
    setSensorRate(sensorType, sampleRate) {
        if (!this.availableSensors.hasOwnProperty(sensorType)) {
            throw new Error(`Unknown sensor type: ${sensorType}`);
        }

        this.availableSensors[sensorType] = sampleRate;

        if (this.isMonitoring) {
            this._configureSensors().catch((error) => this.emit("error", error));
        }
    }

    /** @returns {string[]} Copy of the current requested sensor selection. */
    getEnabledSensors() {
        return [...this.enabledSensors];
    }

    /** @returns {Object<string, number>} Copy of the last generated SDK configuration. */
    getSensorConfiguration() {
        return { ...this.sensorConfiguration };
    }
}

module.exports = { SensorManager, DEFAULT_SENSOR_RATES };

/**
 * Asynchronous configuration failure from enableSensor(), disableSensor(), or
 * setSensorRate() while monitoring.
 * @event SensorManager#error
 * @type {Error}
 */
