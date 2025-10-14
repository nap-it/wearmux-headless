// Display utilities for BrilliantSole devices (Node.js)
const EventEmitter = require("events");
const sharp = require("sharp");
const RgbQuant = require("rgbquant");
const { DeviceManager } = require("../../utils/device-manager");
const { Config } = require("../../utils/config");

class DisplayManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.deviceManager = options.deviceManager || new DeviceManager();
        this.device = null;
        const dcfg = Config.getDisplayConfig();
        this.width = options.width || dcfg.outWidth || null;
        this.height = options.height || dcfg.outHeight || null;
        // Device displays are palette-indexed; valid depths are 1, 2, 4 (bits per pixel -> 2,4,16 colors)
        this.pixelDepth = options.pixelDepth || dcfg.pixelDepth || 4;
        this.defaultFit = options.fit || dcfg.fit || "contain";
        this.defaultAlign = options.align || dcfg.align || "center";
        this.defaultX = Number.isFinite(options.x) ? options.x : dcfg.x ?? 0;
        this.defaultY = Number.isFinite(options.y) ? options.y : dcfg.y ?? 0;
        this.brightness = options.brightness || dcfg.brightness; // optional override
        this.tileMaxPixels = options.tileMaxPixels || dcfg.tileMaxPixels || 220;
        // Height-first sizing like the web SDK
        this.inputHeight = options.inputHeight || dcfg.inputHeight; // height used to process/quantize
        this.outputHeight = options.outputHeight || dcfg.outputHeight; // height used on device via scale
    }

    async connect() {
        this.device = await this.deviceManager.connectToDevice();

        // Wait for display availability/readiness
        try {
            if (!this.device.isDisplayAvailable) {
                await this.device.waitForEvent("isDisplayAvailable");
            }
            // Some firmwares emit a displayReady event when context can be used
            if (!this.device.isDisplayReady) {
                try {
                    await this.device.waitForEvent("displayReady");
                } catch {}
            }
        } catch {}

        // Fetch display information (size and pixel depth)
        try {
            if (this.device.isDisplayAvailable) {
                // Wake display and set a visible brightness
                try {
                    if (this.device.displayStatus === "asleep") {
                        await this.device.wakeDisplay();
                    }
                    const b = this.brightness || "medium";
                    await this.device.setDisplayBrightness(b, true);
                } catch {}
                const info = this.device.displayInformation;
                if (info && info.width && info.height) {
                    this.width = this.width || info.width;
                    this.height = this.height || info.height;
                }
                // Map device pixelDepth ('1'|'2'|'4') to number
                if (info && info.pixelDepth) {
                    const d = Number(info.pixelDepth);
                    if ([1, 2, 4].includes(d)) this.pixelDepth = d;
                }
            }
            // Basic sanity defaults if missing
            this.width = this.width || 640;
            this.height = this.height || 400;
            if (process.env.DEBUG) {
                console.log("[DisplayManager] display caps:", {
                    width: this.width,
                    height: this.height,
                    pixelDepth: this.pixelDepth,
                });
            }
        } catch (e) {
            // Fallback to defaults
            this.width = this.width || 640;
            this.height = this.height || 400;
        }

        // Listen for basic display status if available
        try {
            this.device.addEventListener?.("displayStatus", (ev) => {
                if (process.env.DEBUG)
                    console.log("[DisplayManager] displayStatus:", ev?.message || ev);
            });
        } catch {}

        return this.device;
    }

    async showImageFile(filePath, opts = {}) {
        const { data, info } = await sharp(filePath)
            .toColourspace("srgb")
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return this._renderToDevice(data, info, opts);
    }

    async showImageBuffer(buffer, mimeType = "image/png", opts = {}) {
        // Let sharp decode from buffer
        const { data, info } = await sharp(buffer)
            .toColourspace("srgb")
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return this._renderToDevice(data, info, opts);
    }

    async _renderToDevice(rawRgbBuffer, srcInfo, opts) {
        if (!this.device) throw new Error("Device not connected");
        if (!this.device.isDisplayAvailable) throw new Error("Display not available on this device");

        // Destination geometry
        // Target dimensions for processing and display
        const dstW = opts.outWidth || this.width || srcInfo.width;
        const dstH = opts.outHeight || this.height || srcInfo.height;
        const posX = Number.isFinite(opts.x) ? opts.x : this.defaultX;
        const posY = Number.isFinite(opts.y) ? opts.y : this.defaultY;

        // Resize/fit the image to the device resolution
        const fit = opts.fit || this.defaultFit || "contain";
        const alignMap = {
            top: "top",
            bottom: "bottom",
            left: "left",
            right: "right",
            center: "centre",
        };

        const pipeline = sharp(rawRgbBuffer, {
            raw: { width: srcInfo.width, height: srcInfo.height, channels: 3 },
        });

        // Prefer height-based resize for upload speed; fall back to width/height
        const processHeight = opts.inputHeight || this.inputHeight;
        if (processHeight) {
            pipeline.resize({ height: processHeight, fit: "inside" });
        } else {
            pipeline.resize({
                width: dstW,
                height: dstH,
                fit,
                position: alignMap[opts.align || this.defaultAlign] || "centre",
            });
        }
        pipeline.raw();

        const resized = await pipeline.toBuffer({ resolveWithObject: true });
        // rgbquant expects RGBA; expand RGB -> RGBA with opaque alpha
        const rgba = Buffer.alloc(dstW * dstH * 4);
        for (let i = 0, j = 0; i < resized.data.length; i += 3, j += 4) {
            rgba[j] = resized.data[i];
            rgba[j + 1] = resized.data[i + 1];
            rgba[j + 2] = resized.data[i + 2];
            rgba[j + 3] = 255;
        }

        // Quantize to the device-supported number of colors
        const targetDepth = Number(opts.pixelDepth || this.pixelDepth);
        const numberOfColors = targetDepth === 1 ? 2 : targetDepth === 2 ? 4 : 16; // 1->2, 2->4, 4->16
        const { indexed, paletteHex } = await this._quantizeRGBToIndexed(
            rgba,
            dstW,
            dstH,
            numberOfColors
        );

        // Configure display alignment so x/y are top-left
        await this.device.setDisplayHorizontalAlignment("start");
        await this.device.setDisplayVerticalAlignment("start");

        // Compute output scale from desired outputHeight relative to processed height
        const processedH = resized.info.height;
        const desiredOutputH = opts.outputHeight || this.outputHeight || processedH;
        const scale = Math.max(0.01, desiredOutputH / processedH);
        if (Math.abs(scale - 1) > 1e-3) {
            await this.device.setDisplayBitmapScale(scale, true);
        }

        // Set the display's palette colors (global)
        for (let i = 0; i < paletteHex.length; i++) {
            await this.device.setDisplayColor(i, paletteHex[i]);
        }
        // Map bitmap indices to display color indices (identity mapping)
        const bitmapColorPairs = paletteHex.map((_, i) => ({ bitmapColorIndex: i, colorIndex: i }));
        if (bitmapColorPairs.length) {
            await this.device.selectDisplayBitmapColors(bitmapColorPairs);
        }

        // Draw using tiled bitmaps to respect device limits (pixels length <= ~227)
        const maxPixelsPerBitmap = this.tileMaxPixels; // configurable
        const fullIndexed = Array.isArray(indexed) ? indexed : Array.from(indexed);
        // Use processed dimensions for tiling
        const procW = resized.info.width;
        const procH = resized.info.height;
        const pickTileHeight = (w) => Math.max(1, Math.floor(maxPixelsPerBitmap / w));
        const baseTileW = Math.min(procW, Math.max(1, Math.floor(Math.sqrt(maxPixelsPerBitmap))));

        for (let yOff = 0; yOff < procH; ) {
            const tileW = baseTileW; // dynamic per row can be tuned if needed
            const tileH = Math.min(procH - yOff, pickTileHeight(tileW));
            for (let xOff = 0; xOff < procW; xOff += tileW) {
                const w = Math.min(tileW, procW - xOff);
                const h = Math.min(tileH, procH - yOff);
                const pixels = new Array(w * h);
                for (let r = 0; r < h; r++) {
                    const srcStart = (yOff + r) * procW + xOff;
                    const row = fullIndexed.slice(srcStart, srcStart + w);
                    for (let c = 0; c < w; c++) {
                        pixels[r * w + c] = row[c] || 0;
                    }
                }
                const bitmap = { width: w, height: h, numberOfColors, pixels };
                const drawX = posX + Math.round(xOff * scale);
                const drawY = posY + Math.round(yOff * scale);
                await this.device.drawDisplayBitmap(drawX, drawY, bitmap, true);
            }
            yOff += tileH;
        }
        await this.device.showDisplay(true);
        if (Math.abs(scale - 1) > 1e-3) {
            await this.device.resetDisplayBitmapScale(true);
        }
        return true;
    }

    async slideshow(files, intervalMs = 1000, opts = {}) {
        if (!Array.isArray(files) || files.length === 0)
            throw new Error("slideshow requires a non-empty files array");
        let i = 0;
        while (true) {
            await this.showImageFile(files[i % files.length], opts);
            i += 1;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    }

    async _quantizeRGBToIndexed(rgbaBuffer, width, height, numberOfColors) {
        const q = new RgbQuant({ colors: numberOfColors, dithKern: null });
        // Provide RGBA buffer directly
        q.sample(rgbaBuffer);
        const indexed = q.reduce(rgbaBuffer, 2); // JS array of palette indices length=width*height
        const pal = q.palette(true); // array of [r,g,b]
        const paletteHex = [];
        for (let k = 0; k < pal.length; k++) {
            const [r, g, b] = pal[k];
            paletteHex.push(`#${r.toString(16).padStart(2, "0")}${g
                .toString(16)
                .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`);
        }
        // Ensure palette size exactly numberOfColors (pad with black if needed)
        while (paletteHex.length < numberOfColors) paletteHex.push("#000000");
        if (paletteHex.length > numberOfColors) paletteHex.length = numberOfColors;
        return { indexed, paletteHex };
    }
}

module.exports = { DisplayManager };
