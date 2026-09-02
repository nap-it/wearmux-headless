// Sensor management for BrilliantSole device sensors
const EventEmitter = require("events");
const { createPublisher, selectedTransport } = require("../../utils/transport");

class SensorManager extends EventEmitter {
    /**
     * @param {Device} device - SDK device instance (already connected)
     * @param {Object} options - Configuration options
     */
    constructor(device, options = {}) {
        super();
        if (!device) {
            throw new Error("SensorManager requires a device instance (use SDK DeviceManager to connect)");
        }
        this.device = device;
        this.side = options.side || null; // 'left' | 'right' | null
        this.sampleRate = options.sampleRate || 50;
        this.enabledSensors = options.enabledSensors || [];
        this.isMonitoring = false;
        this.sensorConfiguration = {};
        
        // Transport integration: zenoh or mqtt, auto-selected by env.
        this.transport = options.transport || selectedTransport();
        this.publisherEnabled =
            options.publisherEnabled !== undefined
                ? Boolean(options.publisherEnabled)
                : this.transport !== "none";
        this.publisherOptions = {
            keyPrefix: options.publisherKeyPrefix || process.env.ZENOH_KEY_PREFIX
                || process.env.MQTT_KEY_PREFIX || "bsole/sensors",
            prettyJson: true,
        };
        this.publisherAttachAll =
            options.publisherAttachAll !== undefined
                ? Boolean(options.publisherAttachAll)
                : process.env.PUBLISHER_ATTACH_ALL !== "0" && process.env.ZENOH_ATTACH_ALL !== "0";
        this.publisher = null;

        // Available sensor types with their default device rates (SDK expects multiples of 5).
        // Rate 0 means disabled by default; non-zero means enabled at that rate when included
        // in ENABLED_SENSORS. Insoles support the full IMU set; Frame only has the first group.
        this.availableSensors = {
            // Full IMU (Insole + Frame)
            acceleration: 50,
            magnetometer: 50,
            orientation: 50,
            // Full IMU (Insole only — Frame lacks these)
            gravity: 50,
            linearAcceleration: 50,
            gyroscope: 50,
            gameRotation: 50,
            rotation: 50,
            // Activity / step sensors (Insole only)
            activity: 5,
            stepCounter: 5,
            // Tap detection
            tapDetector: 5,
            // Pressure (Insole only)
            pressure: 50,
        };

        // Build per-sensor output throttle (Hz or ms) from environment
        this.outputThrottleMs = this._buildOutputThrottleMap();
    }

    async startSensors() {
        // If a transport is selected, start the publisher and attach sensors
        if (this.publisherEnabled && this.publisherAttachAll && this.transport !== "none") {
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

        this._configureSensors();

        // Wait for configuration to take effect
        await new Promise((r) => setTimeout(r, 500));

        // Setup event listeners for sensor data
        this._setupSensorEventListeners();
        
        this.isMonitoring = true;
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
            this.device.setSensorConfiguration(this.sensorConfiguration, true);
        } else {
            console.warn(
                "[SensorManager] Device does not support setSensorConfiguration"
            );
        }
    }

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

    _removeDeviceListeners() {
        if (!this._deviceListeners || typeof this.device?.removeEventListener !== "function") return;
        for (const [sensorType, handler] of this._deviceListeners.entries()) {
            try { this.device.removeEventListener(sensorType, handler); } catch { }
        }
        this._deviceListeners.clear();
    }

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
}

module.exports = { SensorManager };
