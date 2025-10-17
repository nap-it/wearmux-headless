const EventEmitter = require("events");
const { DeviceManager } = require("../../utils/device-manager");

/**
 * CameraManager
 * - Connects to a BrilliantSole device using DeviceManager (Noble-only)
 * - Applies camera configuration (resolution, quality, shutter, gains)
 * - Provides takePicture() and optional auto-capture
 * - Emits 'image' with a Buffer of encoded image data
 */
class CameraManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.deviceManager = options.deviceManager || new DeviceManager();
        this.device = null;

        // Behavior
        this.auto = Boolean(options.auto);
        this.imageFormat = options.imageFormat || "jpg";

        // Configuration knobs (best-effort; depends on SDK/firmware)
        this.resolution = options.resolution || undefined; // e.g., { width: 640, height: 480 }
        this.qualityFactor = options.qualityFactor; // numeric 1..100
        this.shutter = options.shutter; // e.g., exposure time or enum
        this.gain = options.gain; // overall gain
        this.redGain = options.redGain;
        this.greenGain = options.greenGain;
        this.blueGain = options.blueGain;

        this._timer = null;
        this._connected = false;
        this._captureInFlight = false;
        this._cameraStatus = undefined;
    }

    async connectOnly() {
        try {
            this.device = await this.deviceManager.connectToDevice();
            this._connected = true;
            this.deviceManager.on("error", (err) => this.emit("error", err));
            this._setupCameraEventHandlers();
            return this.device;
        } catch (err) {
            this.emit("error", err);
            throw err;
        }
    }

    async start() {
        if (!this._connected) await this.connectOnly();
        if (!this.device) throw new Error("Device not connected");

        // Apply camera configuration if available
    await this._applyCameraConfiguration();

        try {
            if (typeof this.device.wakeCamera === "function") {
                await this.device.wakeCamera();
            }
        } catch {}

        // Try to start/enable camera feed if the API exists
        await this._maybeStartCameraFeed();

        if (this.auto) this.enableAutoCapture(true);
    }

    async _applyCameraConfiguration() {
        // Build configuration object from options
        const config = {};
        if (this.qualityFactor !== undefined) config.qualityFactor = this.qualityFactor;
        if (this.shutter !== undefined) config.shutter = this.shutter;
        if (this.gain !== undefined) config.gain = this.gain;
        if (this.redGain !== undefined) config.redGain = this.redGain;
        if (this.greenGain !== undefined) config.greenGain = this.greenGain;
        if (this.blueGain !== undefined) config.blueGain = this.blueGain;

        // Handle resolution - SDK will accept what it supports and ignore the rest
        if (this.resolution !== undefined) {
            if (Number.isFinite(this.resolution)) {
                // Numeric resolution (e.g., 640)
                config.resolution = this.resolution;
            } else if (this.resolution && typeof this.resolution === "object") {
                const { width, height } = this.resolution;
                if (Number.isFinite(width) && Number.isFinite(height)) {
                    if (width === height) {
                        // Square resolution - use numeric format
                        config.resolution = width;
                    } else {
                        // Non-square - pass width/height
                        config.width = width;
                        config.height = height;
                    }
                }
            }
        }

        // Apply camera configuration (SDK ignores unsupported properties)
        try {
            if (Object.keys(config).length && typeof this.device.setCameraConfiguration === "function") {
                this.device.setCameraConfiguration(config);
            }
        } catch (e) {
            if (process.env.DEBUG) console.warn("[Camera] setCameraConfiguration failed:", e?.message || e);
        }

        // Some devices gate camera via sensorConfiguration; ensure camera rate is set
        try {
            const cameraRate = Number(process.env.CAMERA_RATE || process.env.CAMERA_SENSOR_RATE || 10);
            if (
                typeof this.device.setSensorConfiguration === "function" &&
                Number.isFinite(cameraRate) && cameraRate > 0
            ) {
                const sc = { camera: cameraRate };
                if (process.env.DEBUG) console.log("[Camera] applying sensorConfiguration:", sc);
                this.device.setSensorConfiguration(sc);
            }
        } catch (e) {
            if (process.env.DEBUG) console.warn("[Camera] setSensorConfiguration(camera) failed:", e?.message || e);
        }
    }

    enableAutoCapture(on) {
        this.auto = Boolean(on);
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (!this.auto) return;
        // Kick an immediate try if idle/unknown
        this._scheduleAutoIfIdle(0);
    }

    async _queueCapture() {
        if (this._captureInFlight) return;
        this._captureInFlight = true;
        try {
            await this.takePicture();
        } catch (e) {
            this.emit("error", e);
        } finally {
            this._captureInFlight = false;
        }
    }

    async takePicture() {
        if (!this.device) throw new Error("Device not connected");
        if (process.env.DEBUG) console.log("[Camera] takePicture() requested");
        // If we know status, only shoot when idle (mirrors web SDK)
        try {
            const status = this.device.cameraStatus ?? this._cameraStatus;
            if (status && status !== "idle") {
                if (process.env.DEBUG) console.log("[Camera] skipped takePicture: status=", status);
                return null;
            }
        } catch {}
        // Preferred path
        if (typeof this.device.takePicture === "function") {
            try {
                const res = await this.device.takePicture();
                if (res) this._emitImagePayload(res);
            } catch (e) {
                if (process.env.DEBUG) console.warn("[Camera] takePicture call failed:", e?.message || e);
            }
            if (!this.auto) {
                const ev = await this._awaitImageOnce(2000);
                if (!ev && process.env.DEBUG) console.warn("[Camera] no image event received after takePicture");
                return ev;
            }
            return null;
        }
        // Fallback
        const altMethods = [
            "requestCameraImage",
            "getCameraImage",
            "captureImage",
            "capturePhoto",
            "getImage",
            "snapPicture",
        ];
        for (const m of altMethods) {
            if (typeof this.device[m] === "function") {
                try {
                    const res = await this.device[m]();
                    if (res) this._emitImagePayload(res);
                } catch (e) {
                    if (process.env.DEBUG) console.warn(`[Camera] ${m} call failed:`, e?.message || e);
                }
                if (!this.auto) {
                    const ev = await this._awaitImageOnce(2000);
                    if (!ev && process.env.DEBUG) console.warn(`[Camera] no image event received after ${m}`);
                    return ev;
                }
                return null;
            }
        }
        throw new Error("Device does not expose a takePicture-like API");
    }

    async focus() {
        try {
            if (this.device && typeof this.device.focusCamera === "function") {
                await this.device.focusCamera();
                return true;
            }
        } catch (e) {
            this.emit("error", e);
        }
        return false;
    }

    async sleep() {
        try {
            if (this.device && typeof this.device.sleepCamera === "function") {
                await this.device.sleepCamera();
                return true;
            }
        } catch (e) {
            this.emit("error", e);
        }
        return false;
    }

    _setupCameraEventHandlers() {
        if (!this.device) return;

        const logFirst = this._firstLogOnce();
        const handle = (payload) => {
            try {
                logFirst(payload);
                this._emitImagePayload(payload);
                // Web SDK pattern: trigger next capture when a frame arrives
                if (this.auto) this._scheduleAutoIfIdle(1);
            } catch (e) {
                this.emit("error", e);
            }
        };

        const names = [
            "cameraImage",
            "cameraPicture",
            "cameraFrame",
            "picture",
            "image",
            "cameraData",
            // Additional common variants
            "cameraJpeg",
            "cameraImageJpeg",
            "cameraImagePng",
            "jpeg",
            "jpg",
            "png",
            "videoFrame",
            "cameraFrameJpeg",
        ];
        for (const n of names) {
            try {
                if (typeof this.device.addEventListener === "function") {
                    this.device.addEventListener(n, handle);
                } else if (typeof this.device.on === "function") {
                    this.device.on(n, handle);
                }
            } catch {}
        }

        try {
            this.device.addEventListener?.("cameraStatus", (ev) => {
                const msg = ev?.message || ev;
                this._cameraStatus = typeof msg === 'string' ? msg : (msg?.cameraStatus || msg?.status || this.device?.cameraStatus);
                if (process.env.DEBUG) console.log("[Camera] status:", this._cameraStatus);
                if (this.auto && this._cameraStatus === 'idle') this._scheduleAutoIfIdle(0);
            });
            this.device.addEventListener?.("getCameraConfiguration", (ev) => {
                const msg = ev?.message || ev;
                this._lastCameraConfiguration = msg;
                const types = this._extractTypesFromCameraConfig(msg);
                if (types && types.length) {
                    this._availableCameraTypes = new Set(types);
                }
                if (process.env.DEBUG) console.log("[Camera] configuration types:", Array.from(this._availableCameraTypes));
            });
        } catch {}
    }

    _firstLogOnce() {
        let first = true;
        return (payload) => {
            if (!first) return;
            first = false;
            const p = payload && payload.message ? payload.message : payload;
            let info = { type: typeof p };
            if (p && typeof p === "object") {
                info = {
                    ...info,
                    keys: Object.keys(p),
                    ctor: p.constructor?.name,
                    byteLength: p.byteLength || p.length,
                };
            }
            console.log("[Camera] first image payload:", info);
        };
    }

    _emitImagePayload(payload) {
        const p = payload && payload.message ? payload.message : payload;

    // 1) Direct binary payloads
        let buf = null;
        buf = this._tryBufferFrom(p);
    let ext = this._detectFormatExtension(p) || this.imageFormat;

        // 2) Common wrappers
        if (!buf && p && typeof p === "object") {
            const candidates = [
                p.data,
                p.image,
                p.jpeg,
                p.jpg,
                p.png,
                p.value,
                p.bytes,
                p.byteArray,
                p.arrayBuffer,
                p.buffer,
                p.payload,
                p.frame,
                p.frameData,
            ];
            for (const c of candidates) {
                if (!c) continue;
                const b = this._tryBufferFrom(c);
                if (b) { buf = b; break; }
            }
        }

        // 3) data URI / base64
        if (!buf && p && typeof p === "object") {
            const uri = p.uri || p.url || p.href;
            if (typeof uri === "string" && uri.startsWith("data:image/")) {
                const b64 = uri.split(",")[1];
                if (b64) buf = Buffer.from(b64, "base64");
            }
            if (!buf && typeof p.base64 === "string") {
                buf = Buffer.from(p.base64, "base64");
                ext = this._detectFormatExtension(p) || ext;
            }
            // try nested base64 (e.g., p.image.base64)
            if (!buf) {
                const nested = this._deepFindBase64(p, 2);
                if (nested) {
                    buf = Buffer.from(nested, "base64");
                    ext = this._detectFormatExtension(p) || ext;
                }
            }
            // Blob support (Node 20+)
            if (!buf && p.blob && typeof p.blob === "object" && typeof p.blob.arrayBuffer === "function") {
                const guessed = this._extFromMime(p.blob.type) || ext;
                this._bufferFromBlob(p.blob)
                    .then((b) => {
                        if (b) this.emit("image", { buffer: b, format: guessed });
                    })
                    .catch((e) => this.emit("error", e));
                return; // async path
            }
            // http/https URL fetch (avoid blob: scheme)
            if (!buf && typeof uri === "string" && /^(https?:)\/\//i.test(uri)) {
                this._bufferFromUrl(uri)
                    .then((out) => {
                        if (out && out.buffer) {
                            const guessed = this._extFromMime(out.contentType) || this._extFromUrl(uri) || ext;
                            this.emit("image", { buffer: out.buffer, format: guessed });
                        }
                    })
                    .catch((e) => this.emit("error", e));
                return; // async path
            }
        }

        // 4) Raw frame to encode (RGB/RGBA)
        const w = p && Number.isFinite(p.width) ? p.width : null;
        const h = p && Number.isFinite(p.height) ? p.height : null;
        const rgba = p && (p.rgba || p.RGBA || p.argb || p.ARGB || p.abgr || p.ABGR);
        const rgb = p && (p.rgb || p.RGB);
        if (!buf && w && h && (rgba || rgb)) {
            const channels = rgba ? 4 : 3;
            const raw = rgba || rgb;
            let u8 = null;
            if (Buffer.isBuffer(raw)) u8 = raw;
            else if (raw instanceof Uint8Array) u8 = raw;
            else if (raw instanceof ArrayBuffer) u8 = new Uint8Array(raw);
            if (u8 && u8.length >= w * h * channels) {
                this._encodeRawToImageBuffer(u8, w, h, channels)
                    .then((out) => {
                        if (out) this.emit("image", { buffer: out, format: this.imageFormat });
                    })
                    .catch((e) => this.emit("error", e));
                return;
            }
        }

        if (!buf) {
            // Fallback: deep-scan for any buffer-like up to depth 2
            const deep = this._deepFindBufferLike(p, 2);
            if (deep) buf = deep;
        }

        if (!buf) {
            if (process.env.DEBUG) {
                try {
                    const info = p && typeof p === "object" ? { keys: Object.keys(p), types: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v && v.constructor ? v.constructor.name : typeof v])) } : typeof p;
                    console.warn("[Camera] Unrecognized image payload shape", info);
                } catch {}
            }
            return;
        }
        if (process.env.DEBUG) console.log("[Camera] image buffer", buf.length, "bytes");
        this._lastImageTs = Date.now();
        this.emit("image", { buffer: buf, format: ext || this.imageFormat });
    }

    async _encodeRawToImageBuffer(rawU8, width, height, channels) {
        let sharp;
        try { sharp = require("sharp"); } catch (e) {
            console.warn("[Camera] sharp not available to encode raw frame");
            return null;
        }
        const input = Buffer.isBuffer(rawU8) ? rawU8 : Buffer.from(rawU8);
        const pipeline = sharp(input, { raw: { width, height, channels } });
        if (this.imageFormat === "png") {
            return pipeline.png().toBuffer();
        }
        // default to jpeg
        const quality = Number.isFinite(this.qualityFactor) ? Math.max(1, Math.min(100, this.qualityFactor)) : 80;
        return pipeline.jpeg({ quality }).toBuffer();
    }

    async _bufferFromBlob(blob) {
        try {
            if (!blob || typeof blob.arrayBuffer !== "function") return null;
            const ab = await blob.arrayBuffer();
            return Buffer.from(new Uint8Array(ab));
        } catch (e) {
            if (process.env.DEBUG) console.warn("[Camera] blob->buffer failed:", e?.message || e);
            return null;
        }
    }

    async _bufferFromUrl(url) {
        try {
            if (typeof fetch !== "function") return null;
            const res = await fetch(url);
            if (!res.ok) return null;
            const ab = await res.arrayBuffer();
            const buffer = Buffer.from(new Uint8Array(ab));
            const contentType = (res.headers && typeof res.headers.get === "function") ? res.headers.get("content-type") : undefined;
            return { buffer, contentType };
        } catch (e) {
            if (process.env.DEBUG) console.warn("[Camera] fetch url failed:", e?.message || e);
            return null;
        }
    }

    _extFromUrl(u) {
        if (!u || typeof u !== "string") return null;
        try {
            const pathname = new URL(u).pathname;
            const m = pathname.match(/\.([a-z0-9]+)$/i);
            return m ? m[1].toLowerCase() : null;
        } catch { return null; }
    }

    _extFromMime(mime) {
        if (!mime || typeof mime !== "string") return null;
        const m = mime.toLowerCase();
        if (m.includes("jpeg")) return "jpg";
        if (m.includes("jpg")) return "jpg";
        if (m.includes("png")) return "png";
        if (m.includes("bmp")) return "bmp";
        if (m.includes("webp")) return "webp";
        return null;
    }

    _detectFormatExtension(p) {
        if (!p || typeof p !== "object") return null;
        const uri = p.uri || p.url || p.href;
        if (typeof uri === "string") {
            if (uri.startsWith("data:image/")) {
                const mt = uri.slice(5, uri.indexOf(",")); // image/xxx;base64
                return this._extFromMime(mt);
            }
            const ex = this._extFromUrl(uri);
            if (ex) return ex;
        }
        const mt = p.mime || p.mimeType || (p.blob && p.blob.type) || p.type;
        const ext = this._extFromMime(mt);
        return ext;
    }

    _tryBufferFrom(x) {
        if (!x) return null;
        if (Buffer.isBuffer(x)) return x;
        if (x instanceof Uint8Array) return Buffer.from(x);
        if (x instanceof ArrayBuffer) return Buffer.from(new Uint8Array(x));
        if (Array.isArray(x)) {
            // assume numeric array 0..255
            try {
                const u8 = Uint8Array.from(x);
                return Buffer.from(u8);
            } catch {}
        }
        return null;
    }

    _deepFindBase64(obj, depth) {
        if (!obj || depth < 0) return null;
        if (typeof obj !== "object") return null;
        if (typeof obj.base64 === "string") return obj.base64;
        for (const v of Object.values(obj)) {
            const found = this._deepFindBase64(v, depth - 1);
            if (found) return found;
        }
        return null;
    }

    _deepFindBufferLike(obj, depth) {
        if (!obj || depth < 0) return null;
        const b = this._tryBufferFrom(obj);
        if (b) return b;
        if (typeof obj !== "object") return null;
        for (const v of Object.values(obj)) {
            const found = this._deepFindBufferLike(v, depth - 1);
            if (found) return found;
        }
        return null;
    }

    async _maybeStartCameraFeed() {
        const startMethods = [
            "startCamera",
            "startCameraFeed",
            "startVideo",
            "startPreview",
            "enableCamera",
            "toggleCamera",
        ];
        for (const m of startMethods) {
            if (typeof this.device[m] === "function") {
                try {
                    if (process.env.DEBUG) console.log(`[Camera] calling ${m}()`);
                    await this.device[m]();
                    return true;
                } catch (e) {
                    if (process.env.DEBUG) console.warn(`[Camera] ${m} failed:`, e?.message || e);
                }
            }
        }
        // If none supported, assume still-capture only
        return false;
    }

    _awaitImageOnce(timeoutMs = 1000) {
        return new Promise((resolve) => {
            let settled = false;
            const names = ["cameraImage", "cameraPicture", "cameraFrame", "picture", "image", "cameraData"];
            const handler = (payload) => {
                if (settled) return;
                settled = true;
                try {
                    this._emitImagePayload(payload);
                } finally {
                    cleanup();
                    resolve(payload);
                }
            };
            const cleanup = () => {
                for (const n of names) {
                    try {
                        if (typeof this.device.removeEventListener === "function") this.device.removeEventListener(n, handler);
                        if (typeof this.device.off === "function") this.device.off(n, handler);
                    } catch {}
                }
            };
            for (const n of names) {
                try {
                    if (typeof this.device.addEventListener === "function") this.device.addEventListener(n, handler);
                    else if (typeof this.device.on === "function") this.device.on(n, handler);
                } catch {}
            }
            setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(null);
            }, Math.max(100, timeoutMs));
        });
    }

    async close() {
        try {
            if (this._timer) clearTimeout(this._timer);
            this._timer = null;
            try { await this.sleep(); } catch {}
            if (this.deviceManager) await this.deviceManager.disconnect();
        } catch (e) {
            this.emit("error", e);
        } finally {
            this.emit("close");
        }
    }

    _scheduleAutoIfIdle(delayMs = 0) {
        try {
            const status = this.device?.cameraStatus ?? this._cameraStatus;
            if (status && status !== 'idle') return; // wait for idle
        } catch {}
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this._timer = setTimeout(() => this._queueCapture(), Math.max(0, delayMs));
    }
}

module.exports = { CameraManager };
