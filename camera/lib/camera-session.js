const fs = require("fs");
const path = require("path");
const { Config } = require("../../utils/config");
const { topic } = require("../../utils/topics");
const { publishRawMedia } = require("../../utils/raw-media");
const { validateImageBuffer } = require("./image-validator");
const { ViewerServer } = require("./viewer-server");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Captures camera frames for either a standalone command or a device session.
class CameraSession {
    constructor(device, publisher, options = {}) {
        this.device = device;
        this.publisher = publisher;
        this.config = Config.getCameraConfig();
        this.port = this.config.viewPort + (options.cameraIndex || 0);
        this.deviceInfo = options.deviceInfo;
        this.running = false;
        this.capturing = false;
        this.images = [];
        this.timer = null;
        this.collectionTimer = null;
        this.sequence = 0;
        this.firstFrame = new Promise((resolve) => { this.resolveFirstFrame = resolve; });
        this.onImage = (event) => {
            this.receiveImage(event).catch((error) => console.warn(`[Camera][${this.deviceInfo.id}]`, error?.message || error));
        };
    }

    async start() {
        if (this.running) return;
        this.running = true;
        try {
            if (this.config.outputDir) await fs.promises.mkdir(this.config.outputDir, { recursive: true });
            this.device.addEventListener("cameraImage", this.onImage);
            if (this.config.viewEnable) {
                this.viewer = new ViewerServer({ mjpeg: this.config.viewMjpeg });
                this.viewer.start(this.config.viewHost, this.port);
                this.viewer.server.on("error", (error) => console.warn(`[Camera][${this.deviceInfo.id}] viewer: ${error.message}`));
                console.log(`[Camera][${this.deviceInfo.id}] viewer at http://localhost:${this.port}`);
            }
            await this.configure();
            await sleep(2000);
            this.schedule(0);
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async configure() {
        const configured = this.config;
        const available = new Set(this.device.availableCameraConfigurationTypes || []);
        const requested = {
            resolution: configured.resolution,
            qualityFactor: configured.qualityFactor ?? configured.quality,
            shutter: configured.shutter,
            gain: configured.gain,
            redGain: configured.redGain,
            greenGain: configured.greenGain,
            blueGain: configured.blueGain,
            autoWhiteBalanceEnabled: configured.autoWhiteBalanceEnabled,
            autoGainEnabled: configured.autoGainEnabled,
            exposure: configured.exposure,
            autoExposureEnabled: configured.autoExposureEnabled,
            autoExposureLevel: configured.autoExposureLevel,
            brightness: configured.brightness,
            saturation: configured.saturation,
            contrast: configured.contrast,
            sharpness: configured.sharpness,
        };
        // A wearable may expose only a subset of camera controls, so apply supported values only.
        const values = Object.fromEntries(Object.entries(requested).filter(([key, value]) =>
            value !== undefined && (!available.size || available.has(key))));
        if (Object.keys(values).length) await this.device.setCameraConfiguration(values);
        if (this.device.cameraStatus === "asleep") {
            await this.command("wakeCamera", () => this.device.wakeCamera());
            await sleep(1000);
        }
        await this.device.setSensorConfiguration({ camera: configured.rate }, false, true);
    }

    async command(label, invoke) {
        // SDK commands may finish late; stop waiting here without cancelling the device operation.
        const timeoutMs = Math.max(500, Number(process.env.CAMERA_COMMAND_TIMEOUT_MS || 1500));
        const operation = Promise.resolve().then(invoke).then(() => null, (error) => error);
        const result = await Promise.race([operation, sleep(timeoutMs).then(() => "timeout")]);
        if (result === "timeout") {
            operation.then((lateError) => {
                if (lateError) console.warn(`[Camera][${this.deviceInfo.id}] ${label}:`, lateError.message);
            });
        } else if (result) {
            throw result;
        }
    }

    async focus() {
        const timeoutMs = Math.max(1500, Number(process.env.CAMERA_FOCUS_IDLE_TIMEOUT_MS || 3000));
        let timer;
        let handler;
        const idle = new Promise((resolve) => {
            handler = (event) => {
                if (event.message?.cameraStatus !== "idle" ||
                    event.message?.previousCameraStatus !== "focusing") return;
                resolve();
            };
            this.device.addEventListener("cameraStatus", handler);
            timer = setTimeout(resolve, timeoutMs);
        });
        try {
            await this.command("focusCamera", () => this.device.focusCamera(this.config.rate));
            await idle;
        } finally {
            clearTimeout(timer);
            this.device.removeEventListener("cameraStatus", handler);
        }
    }

    schedule(delay) {
        clearTimeout(this.timer);
        if (!this.running || this.device.isConnected === false) return;
        this.timer = setTimeout(() => {
            this.capture().catch((error) => {
                console.warn(`[Camera][${this.deviceInfo.id}] capture:`, error?.message || error);
                this.capturing = false;
                if (this.config.autoPicture) this.schedule(2000);
                else this.completeFirstFrame(false);
            });
        }, Math.max(0, delay));
    }

    async capture() {
        if (!this.running || this.capturing || this.device.isConnected === false) return;
        this.capturing = true;
        this.images = [];
        try {
            if (process.env.CAMERA_AUTO_FOCUS !== "0") {
                await this.focus();
            }
            if (!this.running || !this.capturing || this.device.isConnected === false) return;
            const captureTimeoutMs = Math.max(1000, Number(process.env.CAMERA_CAPTURE_TIMEOUT_MS || 5000));
            this.timer = setTimeout(() => {
                // Some devices emit several image candidates for one capture; finish after the burst.
                if (this.images.length) this.finishCapture().catch((error) => console.warn("[Camera]", error));
                else {
                    this.capturing = false;
                    if (this.config.autoPicture) this.schedule(1000);
                    else this.completeFirstFrame(false);
                }
            }, captureTimeoutMs);
            await this.command("takePicture", () => this.device.takePicture(this.config.rate));
        } catch (error) {
            clearTimeout(this.timer);
            this.capturing = false;
            throw error;
        }
    }

    async receiveImage(event) {
        if (!this.running || !this.capturing) return;
        const image = event?.message;
        const buffer = image?.blob ? Buffer.from(await image.blob.arrayBuffer()) :
            image?.arrayBuffer ? Buffer.from(image.arrayBuffer) : null;
        if (!validateImageBuffer(buffer).isValid) return;
        const minBytes = Number(process.env.CAMERA_MIN_IMAGE_BYTES || 0);
        if (buffer.length < minBytes) return;
        this.images.push({ buffer, timestamp: image.timestamp, latency: image.latency });
        clearTimeout(this.collectionTimer);
        this.collectionTimer = setTimeout(() => {
            this.finishCapture().catch((error) => console.warn(`[Camera][${this.deviceInfo.id}]`, error?.message || error));
        }, 300);
    }

    async finishCapture() {
        if (!this.capturing || !this.images.length) return;
        clearTimeout(this.timer);
        clearTimeout(this.collectionTimer);
        // Keep the largest valid candidate, which is usually the most complete camera frame.
        const image = this.images.sort((a, b) => b.buffer.length - a.buffer.length)[0];
        this.images = [];
        this.capturing = false;
        const mime = "image/jpeg";
        this.viewer?.updateImage(image.buffer, mime);

        try {
            let saved = false;
            if (this.config.outputDir) {
                const safeId = String(this.deviceInfo.id).replace(/[^A-Za-z0-9_-]/g, "");
                const file = path.join(this.config.outputDir, `${safeId}-${Date.now()}-${this.sequence++}.jpg`);
                await fs.promises.writeFile(file, image.buffer);
                saved = true;
            }
            if (this.publisher) {
                const meta = {
                    ts: Date.now(), device: this.deviceInfo, bytes: image.buffer.length, mime,
                    cameraTimestamp: image.timestamp || null, latencyMs: image.latency || null, saved,
                };
                await this.publisher.publish(topic("camera", "image"), meta);
                if (process.env.CAMERA_RAW_ENABLE === "1") {
                    await publishRawMedia(this.publisher, "camera", image.buffer, meta);
                }
            }
        } finally {
            this.completeFirstFrame(true);
            // A disabled auto-picture mode ends after this first capture; otherwise schedule the next.
            if (this.running && this.config.autoPicture) this.schedule(Number(process.env.CAMERA_AUTO_DELAY || 0));
        }
    }

    completeFirstFrame(received) {
        if (!this.resolveFirstFrame) return;
        this.resolveFirstFrame(received);
        this.resolveFirstFrame = null;
    }

    async resume() {
        if (!this.running) return;
        this.capturing = false;
        clearTimeout(this.timer);
        clearTimeout(this.collectionTimer);
        await this.configure();
        await sleep(2000);
        this.schedule(0);
    }

    async stop() {
        this.running = false;
        this.completeFirstFrame(false);
        this.capturing = false;
        clearTimeout(this.timer);
        clearTimeout(this.collectionTimer);
        this.device.removeEventListener?.("cameraImage", this.onImage);
        try { this.viewer?.stop(); }
        catch (error) { console.warn(`[Camera][${this.deviceInfo.id}] viewer stop:`, error?.message || error); }
        this.viewer = null;
    }
}

module.exports = { CameraSession };
