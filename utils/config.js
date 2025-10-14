// Configuration utilities for environment variables and settings
class Config {
    static getAudioConfig() {
        return {
            sampleRate: parseInt(process.env.SAMPLE_RATE || "16000", 10),
            channels: parseInt(process.env.CHANNELS || "1", 10),
            sampleFormat: process.env.SAMPLE_FORMAT || "s16le",
            audioBitrate: process.env.AUDIO_BITRATE || "64k",
        };
    }

    static getRtspConfig() {
        return {
            rtspUrl: process.env.RTSP_URL || "rtsp://127.0.0.1:8554/mic",
        };
    }

    static getFfmpegConfig() {
        return {
            ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
            ffmpegLogLevel: process.env.FFMPEG_LOGLEVEL || "error",
        };
    }

    static getDeviceConfig() {
        return {
            connectionType: (process.env.MIC_CONNECTION || "").toLowerCase(),
            allowFallback: process.env.MIC_ALLOW_FALLBACK === "1",
            deviceId: process.env.MIC_DEVICE_ID || "",
            deviceName: process.env.MIC_DEVICE_NAME || "",
            connectOnly: process.env.MIC_CONNECT_ONLY === "1",
        };
    }

    static getMicrophoneConfig() {
        return {
            sensorConfig: { microphone: 5 },
            microphoneConfig: {
                sampleRate: String(this.getAudioConfig().sampleRate),
                bitDepth: "16",
            },
        };
    }

    static getSensorConfig() {
        return {
            sampleRate: parseInt(process.env.SENSOR_SAMPLE_RATE || "50", 10),
            enabledSensors: process.env.ENABLED_SENSORS
                ? process.env.ENABLED_SENSORS.split(",").map((s) => s.trim())
                : [],

            // Individual sensor rates
            acceleration: parseInt(process.env.ACCELERATION_RATE || "50", 10),
            gyroscope: parseInt(process.env.GYROSCOPE_RATE || "50", 10),
            magnetometer: parseInt(process.env.MAGNETOMETER_RATE || "50", 10),
            orientation: parseInt(process.env.ORIENTATION_RATE || "50", 10),
            // Only include rates actually supported by availableSensors; keep multiples of 5
            tapDetector: parseInt(process.env.TAP_DETECTOR_RATE || "5", 10),
        };
    }

    static getDisplayConfig() {
        const n = (v) => (v !== undefined && v !== null && v !== "" ? Number(v) : undefined);
        const s = (v) => (v !== undefined && v !== null && v !== "" ? String(v) : undefined);
        const pxDepth = n(process.env.DISPLAY_PIXEL_DEPTH);
        return {
            // Position and size
            x: n(process.env.DISPLAY_X) ?? 0,
            y: n(process.env.DISPLAY_Y) ?? 0,
            // Prefer height-based sizing like the web SDK
            inputHeight: n(process.env.DISPLAY_INPUT_HEIGHT),
            outputHeight: n(process.env.DISPLAY_OUTPUT_HEIGHT),
            // Legacy width/height envs still supported as fallback
            outWidth: n(process.env.DISPLAY_WIDTH),
            outHeight: n(process.env.DISPLAY_HEIGHT),
            // Rendering
            fit: s(process.env.DISPLAY_FIT) || "contain", // contain | cover | fill | inside | outside
            align: s(process.env.DISPLAY_ALIGN) || "center", // top|bottom|left|right|center
            pixelDepth: [1, 2, 4].includes(pxDepth) ? pxDepth : undefined,
            brightness: s(process.env.DISPLAY_BRIGHTNESS) || undefined // veryLow|low|medium|high|veryHigh
        };
    }

    static getZenohConfig() {
        // Accept endpoints as comma-separated list, e.g. "tcp/127.0.0.1:7447,udp/239.255.0.1:7447"
        const enabled = process.env.ZENOH_ENABLE === "1" || process.env.ZENOH === "1";
        const mode = (process.env.ZENOH_MODE || "client").toLowerCase(); // client|peer
        const endpoints = (process.env.ZENOH_ENDPOINTS || "").split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const keyPrefix = process.env.ZENOH_KEY_PREFIX || "bsole/sensors";
        const prettyJson = process.env.ZENOH_JSON_PRETTY === "1";
        const attachAll = process.env.ZENOH_ATTACH_ALL !== "0"; // default on: publish all events from SensorManager

        return {
            enabled,
            mode, // forwarded to Zenoh config if supported
            endpoints,
            keyPrefix,
            prettyJson,
            attachAll,
        };
    }

    static getAllConfig() {
        return {
            audio: this.getAudioConfig(),
            rtsp: this.getRtspConfig(),
            ffmpeg: this.getFfmpegConfig(),
            device: this.getDeviceConfig(),
            microphone: this.getMicrophoneConfig(),
            sensors: this.getSensorConfig(),
            display: this.getDisplayConfig(),
            zenoh: this.getZenohConfig(),
        };
    }
}

module.exports = { Config };
