// Configuration utilities for environment variables and settings
const path = require("path");
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
            brightness: s(process.env.DISPLAY_BRIGHTNESS) || undefined, // veryLow|low|medium|high|veryHigh
            tileMaxPixels: n(process.env.DISPLAY_TILE_MAX_PIXELS) || 220 // Max pixels per tile (fallback when MTU not available, or minimum when MTU yields smaller tiles)
        };
    }

    static getCameraConfig() {
        const n = (v) => (v !== undefined && v !== null && v !== "" ? Number(v) : undefined);
        const s = (v) => (v !== undefined && v !== null && v !== "" ? String(v) : undefined);
        const flag = (v) => (v !== undefined && v !== null && v !== "" ? Number(v) : undefined);
        const resolution = (() => {
            const direct = n(process.env.CAMERA_RESOLUTION);
            if (direct !== undefined) return direct;

            const width = n(process.env.CAMERA_WIDTH);
            const height = n(process.env.CAMERA_HEIGHT);
            if (width !== undefined && height !== undefined) {
                return width;
            }

            return width ?? height;
        })();

        return {
            // Output directory is optional; if not set, images won't be saved automatically
            outputDir: (process.env.CAMERA_OUTPUT_DIR && process.env.CAMERA_OUTPUT_DIR.trim()) || undefined,
            autoPicture: process.env.CAMERA_AUTO_PICTURE === "1",
            imageFormat: s(process.env.CAMERA_IMAGE_FORMAT) || "jpg",
            quality: n(process.env.CAMERA_QUALITY), // legacy alias
            // Camera resolution is a numeric SDK value, not a width/height object.
            resolution,
            qualityFactor: n(process.env.CAMERA_QUALITY_FACTOR),
            shutter: n(process.env.CAMERA_SHUTTER),
            gain: n(process.env.CAMERA_GAIN),
            redGain: n(process.env.CAMERA_RED_GAIN),
            greenGain: n(process.env.CAMERA_GREEN_GAIN),
            blueGain: n(process.env.CAMERA_BLUE_GAIN),
            autoWhiteBalanceEnabled: flag(process.env.CAMERA_AUTO_WHITE_BALANCE_ENABLED),
            autoGainEnabled: flag(process.env.CAMERA_AUTO_GAIN_ENABLED),
            exposure: n(process.env.CAMERA_EXPOSURE),
            autoExposureEnabled: flag(process.env.CAMERA_AUTO_EXPOSURE_ENABLED),
            autoExposureLevel: n(process.env.CAMERA_AUTO_EXPOSURE_LEVEL),
            brightness: n(process.env.CAMERA_BRIGHTNESS),
            saturation: n(process.env.CAMERA_SATURATION),
            contrast: n(process.env.CAMERA_CONTRAST),
            sharpness: n(process.env.CAMERA_SHARPNESS),
            // Optional lightweight viewer
            viewEnable: process.env.CAMERA_VIEW_ENABLE === "1",
            viewHost: s(process.env.CAMERA_VIEW_HOST) || "0.0.0.0",
            viewPort: n(process.env.CAMERA_VIEW_PORT) || 8099,
            viewMjpeg: process.env.CAMERA_VIEW_MJPEG === "1",
            // Camera sensor sampling rate (if device uses sensorConfiguration for camera)
            rate: n(process.env.CAMERA_RATE) ?? n(process.env.CAMERA_SENSOR_RATE) ?? 5,
        };
    }

    static getZenohConfig() {
        // Single endpoint via ZENOH_LOCATOR (e.g., "tcp/127.0.0.1:7447")
    const enabled = process.env.ZENOH_ENABLE === "1";
    const keyPrefix = process.env.ZENOH_KEY_PREFIX || "bsole/sensors";
    const prettyJson = true; // Always pretty-print
    const attachAll = process.env.ZENOH_ATTACH_ALL !== "0"; // default on: publish all events from SensorManager
    const locator = "tcp/127.0.0.1:7447"; // Fixed default

        return {
            enabled,
            keyPrefix,
            prettyJson,
            attachAll,
            locator,
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
            camera: this.getCameraConfig(),
            zenoh: this.getZenohConfig(),
        };
    }
}

module.exports = { Config };
