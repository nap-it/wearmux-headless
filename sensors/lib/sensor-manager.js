// Sensor management for BrilliantSole device sensors
const EventEmitter = require("events");
const { DeviceManager } = require("../../utils/device-manager");
const { ZenohManager } = require("../../utils/zenoh-manager");

class SensorManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.deviceManager = options.deviceManager || new DeviceManager();
        this.sampleRate = options.sampleRate || 50; // Default 50Hz
        this.enabledSensors = options.enabledSensors || [];
        this.device = null;
        this.isMonitoring = false;
        this.sensorConfiguration = {};
        // Zenoh integration controls (env or options)
        this.zenohEnabled =
            options.zenohEnabled !== undefined
                ? Boolean(options.zenohEnabled)
                : process.env.ZENOH_ENABLE === "1" || process.env.ZENOH === "1";
        this.zenohOptions = {
            keyPrefix: options.zenohKeyPrefix || process.env.ZENOH_KEY_PREFIX || "bsole/sensors",
            prettyJson:
                options.zenohJsonPretty !== undefined
                    ? Boolean(options.zenohJsonPretty)
                    : process.env.ZENOH_JSON_PRETTY === "1",
        };
        this.zenohAttachAll =
            options.zenohAttachAll !== undefined
                ? Boolean(options.zenohAttachAll)
                : process.env.ZENOH_ATTACH_ALL !== "0"; // default true
        this.zenoh = null;

        // Available sensor types with their default device rates (SDK expects multiples of 5)
        this.availableSensors = {
            // Motion sensors (continuous)
            acceleration: 50,
            linearAcceleration: 50,
            gyroscope: 50,
            magnetometer: 50,
            gameRotation: 50,
            rotation: 50,
            orientation: 50,

            // Event sensors
            tapDetector: 5,
        };

        // Build per-sensor output throttle (Hz or ms) from environment
        this.outputThrottleMs = this._buildOutputThrottleMap();
    }

    async connect() {
        try {
            this.device = await this.deviceManager.connectToDevice();
            return this.device;
        } catch (err) {
            this.emit("error", err);
            throw err;
        }
    }

    async startSensors() {
        this._configureSensors();

        // Wait for configuration to take effect
        await new Promise((r) => setTimeout(r, 500));

        // Setup event listeners for sensor data
        this._setupSensorEventListeners();

        // Optional Zenoh publishing: enabled via env or options
        if (this.zenohEnabled && this.zenohAttachAll) {
            try {
                this.zenoh = new ZenohManager({
                    keyPrefix: this.zenohOptions.keyPrefix,
                    prettyJson: this.zenohOptions.prettyJson,
                });
                this.zenoh.on("error", (e) =>
                    console.warn("[SensorManager][Zenoh]", e?.message || e)
                );
                await this.zenoh.start();
                await this.zenoh.attachToSensorManager(this, { quiet: true });
            } catch (e) {
                console.warn(
                    "[SensorManager] Failed to start Zenoh publisher:",
                    e?.message || e
                );
            }
        }
    }

    _configureSensors() {
        // Build sensor configuration - ONLY for enabled sensors
        this.sensorConfiguration = {};

        if (this.enabledSensors.length === 0) {
            // Enable all sensors by default
            this.enabledSensors = Object.keys(this.availableSensors).filter(
                (sensor) => sensor !== "camera" && sensor !== "microphone"
            );
        }

        // Configure ONLY the enabled sensors (device rates remain at defaults to satisfy SDK)
        this.enabledSensors.forEach((sensorType) => {
            if (this.availableSensors.hasOwnProperty(sensorType)) {
                this.sensorConfiguration[sensorType] =
                    this.availableSensors[sensorType];
            } else {
                console.warn(`[SensorManager] Unknown sensor type: ${sensorType}`);
            }
        });

        // Set all other sensors to 0 (disabled)
        Object.keys(this.availableSensors).forEach((sensorType) => {
            if (!this.enabledSensors.includes(sensorType)) {
                this.sensorConfiguration[sensorType] = 0; // Disable sensor
            }
        });

        console.log(
            "[SensorManager] Configuring sensors:",
            this.sensorConfiguration
        );
        console.log("[SensorManager] Enabled sensors:", this.enabledSensors);

        // Apply sensor configuration to device
        if (typeof this.device.setSensorConfiguration === "function") {
            this.device.setSensorConfiguration(this.sensorConfiguration);
        } else {
            console.warn(
                "[SensorManager] Device does not support setSensorConfiguration"
            );
        }
    }

    _buildOutputThrottleMap() {
        // Accept per-sensor RATE as either Hz (number) or ms (string with 'ms')
        // Example: ORIENTATION_RATE=11  -> ~90.91ms; ORIENTATION_RATE=90ms -> 90ms
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

    _setupSensorEventListeners() {
        if (typeof this.device.addEventListener !== "function") {
            console.warn("[SensorManager] Device does not support addEventListener");
            return;
        }

        // Client-side emission throttle based on *_RATE envs (Hz or ms)
        const lastEmitMs = {};

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

        motionSensors.forEach((sensorType) => {
            if (this.enabledSensors.includes(sensorType)) {
                this.device.addEventListener(sensorType, (event) => {
                    // Client-side throttle if configured
                    const interval = this.outputThrottleMs[sensorType];
                    if (interval) {
                        const now = Date.now();
                        const last = lastEmitMs[sensorType] || 0;
                        if (now - last < interval) return;
                        lastEmitMs[sensorType] = now;
                    }
                    this.emit(sensorType, event);
                });
            }
        });

        // Event sensor: Tap detector
        const eventSensors = ["tapDetector"];
        eventSensors.forEach((sensorType) => {
            if (this.enabledSensors.includes(sensorType)) {
                this.device.addEventListener(sensorType, (event) => {
                    // Client-side throttle if configured
                    const interval = this.outputThrottleMs[sensorType];
                    if (interval) {
                        const now = Date.now();
                        const last = lastEmitMs[sensorType] || 0;
                        if (now - last < interval) return;
                        lastEmitMs[sensorType] = now;
                    }
                    this.emit(sensorType, event);
                });
            }
        });

        // Generic sensor data event (DEBUG only to reduce noise)
        if (process.env.DEBUG) {
            console.log("[SensorManager] Adding listener for sensorData (DEBUG)");
            this.device.addEventListener("sensorData", (event) => {
                console.log("[SensorManager] Generic sensorData received:", event);
                this.emit("sensorData", event);
            });
        }
    }

    async stop() {
        try {
            if (this.zenoh) {
                await this.zenoh.stop();
            }
        } catch (e) {
            console.warn("[SensorManager] Error stopping Zenoh:", e?.message || e);
        } finally {
            this.zenoh = null;
        }
        if (this.deviceManager) {
            await this.deviceManager.disconnect();
        }
    }

    // Sensor-specific methods
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
            this._configureSensors();
        }
    }

    disableSensor(sensorType) {
        const index = this.enabledSensors.indexOf(sensorType);
        if (index > -1) {
            this.enabledSensors.splice(index, 1);
        }

        if (this.isMonitoring) {
            this._configureSensors();
        }
    }

    setSensorRate(sensorType, sampleRate) {
        if (!this.availableSensors.hasOwnProperty(sensorType)) {
            throw new Error(`Unknown sensor type: ${sensorType}`);
        }

        this.availableSensors[sensorType] = sampleRate;

        if (this.isMonitoring) {
            this._configureSensors();
        }
    }

    getEnabledSensors() {
        return [...this.enabledSensors];
    }

    getSensorConfiguration() {
        return { ...this.sensorConfiguration };
    }

    getDeviceManager() {
        return this.deviceManager;
    }
}

module.exports = { SensorManager };
