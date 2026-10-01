const sharp = require("sharp");

const GESTURE_HINT = "Nod yes · Shake no";
const FRAME_COLOR = "#FFD05A";

const escapeMarkup = (text) => text.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Compact yes/no question layout, rendered through the SDK bitmap primitive. */
class PromptDisplay {
    constructor(device) {
        this.device = device;
        // Cache host-side rasterization, not display contents (clear and other
        // actions can change the device between questions).
        this.cache = new Map();
    }

    async _renderText(text, fontSize, maxWidth, bold = false) {
        const { data, info } = await sharp({
            text: {
                text: escapeMarkup(text),
                font: `sans-serif ${bold ? "bold " : ""}${fontSize}`,
                ...(maxWidth ? { width: maxWidth } : {}),
                align: "centre",
                wrap: "word-char",
                dpi: 72,
            },
        }).greyscale().raw().toBuffer({ resolveWithObject: true });
        return {
            width: info.width,
            height: info.height,
            // Threshold the glyph mask directly: no PNG encode/decode, palette
            // search, dithering, or full-display background bitmap is needed.
            pixels: Array.from(data, (value) => value >= 128 ? 1 : 0),
        };
    }

    async _fitText(text, minimumSize, maximumSize, maxWidth, maxHeight, wrap = false) {
        const largest = await this._renderText(text, maximumSize, wrap ? maxWidth : undefined, true);
        if (largest.width <= maxWidth && largest.height <= maxHeight) {
            return { ...largest, fontSize: maximumSize };
        }
        maximumSize--;
        let fitted;
        // Prefer one line for a short question, with a bounded number of cold
        // rasterizations. Long custom questions can use the wrapped fallback.
        while (minimumSize <= maximumSize) {
            const fontSize = Math.floor((minimumSize + maximumSize) / 2);
            const bitmap = await this._renderText(text, fontSize, wrap ? maxWidth : undefined, true);
            if (bitmap.width <= maxWidth && bitmap.height <= maxHeight) {
                fitted = { ...bitmap, fontSize };
                minimumSize = fontSize + 1;
            } else {
                maximumSize = fontSize - 1;
            }
        }
        return fitted;
    }

    async _layout(text, width, height) {
        const scale = Math.min(width / 640, height / 400);
        const margin = Math.max(4, Math.round(48 * scale));
        const padding = Math.max(4, Math.round(20 * scale));
        const gap = Math.max(4, Math.round(24 * scale));
        const lineWidth = Math.max(2, Math.round(6 * scale));
        const frameWidth = width - margin * 2;
        const inset = padding + lineWidth;
        const maxWidth = frameWidth - inset * 2;
        const availableHeight = height - margin * 2;
        const noFit = () => new Error("Question with gesture hint does not fit the display; provide a shorter prompt");
        if (maxWidth <= 0 || availableHeight <= 0) throw noFit();

        const hint = await this._fitText(GESTURE_HINT, 12, Math.max(12, Math.round(28 * scale)),
            frameWidth, availableHeight);
        if (!hint) throw noFit();
        const maxQuestionHeight = availableHeight - hint.height - gap - inset * 2;
        if (maxQuestionHeight < 12) throw noFit();
        const minimumSize = Math.max(12, Math.round(28 * scale));
        const maximumSize = Math.max(minimumSize, Math.round(60 * scale));
        const question = await this._fitText(text, minimumSize, maximumSize, maxWidth, maxQuestionHeight)
            || await this._fitText(text, minimumSize, maximumSize, maxWidth, maxQuestionHeight, true);
        if (!question) {
            throw new Error("Question does not fit the display; provide a shorter prompt");
        }

        const frameHeight = question.height + inset * 2;
        const top = Math.round((height - frameHeight - gap - hint.height) / 2);
        return {
            frame: { x: margin, y: top, width: frameWidth, height: frameHeight, lineWidth },
            questionFontSize: question.fontSize,
            hintFontSize: hint.fontSize,
            blocks: [{
                ...question,
                x: Math.round((width - question.width) / 2),
                y: top + inset,
            }, {
                ...hint,
                x: Math.round((width - hint.width) / 2),
                y: top + frameHeight + gap,
            }],
        };
    }

    _waitForDisplayReady(send) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let acknowledged = false;
            let flushed = !send;
            let flushedAt = performance.now();
            let readyAt;
            let listenerAdded = false;
            const finish = (error) => {
                if (settled || (!error && (!acknowledged || !flushed))) return;
                settled = true;
                clearTimeout(timeout);
                if (listenerAdded) this.device.removeEventListener("displayReady", onReady);
                if (error) reject(error);
                else resolve({ flushedAt, readyAt });
            };
            const onReady = () => {
                acknowledged = true;
                readyAt = performance.now();
                finish();
            };
            const timeout = setTimeout(() => finish(new Error("Timed out waiting for displayReady after 3000 ms")), 3000);
            try {
                this.device.addEventListener("displayReady", onReady);
                listenerAdded = true;
                if (send) {
                    // Attach rejection handling immediately, including for a
                    // synchronous throw or a send that rejects after timeout.
                    Promise.resolve().then(send).then(() => {
                        flushed = true;
                        flushedAt = performance.now();
                        finish();
                    }, finish);
                } else if (this.device.isDisplayReady !== false) {
                    onReady();
                }
            } catch (error) {
                finish(error);
            }
        });
    }

    async clear() {
        if (this.device.isDisplayReady === false) await this._waitForDisplayReady();
        // clear is its own asynchronous display operation in the SDK, not a
        // buffered drawing primitive. Frame must finish clearing/switching its
        // buffers before we write new pixels. No extra show command is needed.
        return this._waitForDisplayReady(() => this.device.clearDisplay(true));
    }

    async show(text) {
        const timingEnabled = process.env.DISPLAY_TIMING === "1" || process.env.DEBUG === "1";
        const startedAt = timingEnabled ? performance.now() : 0;
        const width = this.device.displayInformation?.width || 640;
        const height = this.device.displayInformation?.height || 400;
        const key = JSON.stringify([text, width, height]);
        let layout = this.cache.get(key);
        const cacheHit = Boolean(layout);
        if (!layout) {
            layout = await this._layout(text, width, height);
            if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value);
            this.cache.set(key, layout);
        }
        const { blocks, frame } = layout;

        // The SDK reserves seven bytes of transport overhead, one command byte
        // and a 13-byte bitmap header. One-bit pixels pack eight per byte.
        const mtu = Number(this.device.mtu) || 23;
        const maxPixels = Math.floor(mtu - 21) * 8;
        if (maxPixels < 8) throw new Error("Display MTU is too small for bitmap commands");
        const preparedAt = timingEnabled ? performance.now() : 0;
        // A preceding clear/show action can finish its SDK flush before the
        // device acknowledges it. Drain that event before drawing this prompt.
        if (this.device.isDisplayReady === false) await this._waitForDisplayReady();
        const setupStartedAt = timingEnabled ? performance.now() : 0;
        let tileCount = 0;
        let packedBitmapBytes = 0;

        await this.device.setDisplayColor(0, "#000000", false);
        await this.device.setDisplayColor(1, "#FFFFFF", false);
        const frameColorIndex = Number(this.device.displayInformation?.pixelDepth) === 1 ? 1 : 2;
        if (frameColorIndex === 2) await this.device.setDisplayColor(2, FRAME_COLOR, false);
        await this.device.setDisplayOpacity(1, false);
        await this.device.selectDisplayBackgroundColor(0, false);
        await this.device.selectDisplayBitmapColors([
            { bitmapColorIndex: 0, colorIndex: 0 },
            { bitmapColorIndex: 1, colorIndex: 1 },
        ], false);
        await this.device.setDisplayHorizontalAlignment("start", false);
        await this.device.setDisplayVerticalAlignment("start", false);
        await this.device.resetDisplayBitmapScale(false);
        await this.device.clearDisplayRotation(false);
        await this.device.clearDisplayCrop(false);
        await this.device.clearDisplayRotationCrop(false);
        // `false` only batches transport: the SDK flushes automatically at its
        // MTU limit. Do not queue a clear alongside drawing or let its late
        // displayReady event acknowledge the final show prematurely.
        const clearStartedAt = timingEnabled ? performance.now() : 0;
        await this.clear();
        const drawStartedAt = timingEnabled ? performance.now() : 0;

        // A vector outline costs only a few commands; it does not increase
        // the one-bit text rasters or require a full-screen color bitmap.
        await this.device.selectDisplayLineColor(frameColorIndex, false);
        await this.device.setDisplayIgnoreFill(true, false);
        await this.device.setDisplayIgnoreLine(false, false);
        await this.device.setDisplayLineWidth(frame.lineWidth, false);
        // The SDK adds the stroke footprint around the requested rectangle.
        // Our layout stores its outer bounds, including that footprint.
        const strokeExpansion = 2 * Math.ceil(frame.lineWidth / 2);
        await this.device.drawDisplayRect(frame.x, frame.y,
            frame.width - strokeExpansion, frame.height - strokeExpansion, false);
        await this.device.setDisplayIgnoreFill(false, false);
        await this.device.setDisplayLineWidth(0, false);
        await this.device.selectDisplayLineColor(1, false);

        for (const block of blocks) {
            const tileWidth = Math.min(block.width, maxPixels);
            const tileHeight = Math.max(1, Math.floor(maxPixels / tileWidth));
            for (let y = 0; y < block.height; y += tileHeight) {
                for (let x = 0; x < block.width; x += tileWidth) {
                    const w = Math.min(tileWidth, block.width - x);
                    const h = Math.min(tileHeight, block.height - y);
                    const pixels = [];
                    for (let row = 0; row < h; row++) {
                        const offset = (y + row) * block.width + x;
                        pixels.push(...block.pixels.slice(offset, offset + w));
                    }
                    await this.device.drawDisplayBitmap(block.x + x, block.y + y, {
                        width: w, height: h, numberOfColors: 2, pixels,
                    }, false);
                    tileCount++;
                    packedBitmapBytes += Math.ceil(pixels.length / 8);
                }
            }
        }
        // showDisplay resolves after sending. The separate displayReady event
        // gates the interaction's gesture monitoring until drawing is acknowledged.
        const { flushedAt, readyAt } = await this._waitForDisplayReady(() => this.device.showDisplay(true));
        if (timingEnabled) {
            console.log("[Prompt display timing]", {
                cache: cacheHit ? "hit" : "miss",
                prepareMs: Number((preparedAt - startedAt).toFixed(2)),
                previousReadyWaitMs: Number((setupStartedAt - preparedAt).toFixed(2)),
                setupMs: Number((clearStartedAt - setupStartedAt).toFixed(2)),
                clearAndReadyMs: Number((drawStartedAt - clearStartedAt).toFixed(2)),
                drawAndFlushMs: Number((flushedAt - drawStartedAt).toFixed(2)),
                readyWaitMs: Number(Math.max(0, readyAt - flushedAt).toFixed(2)),
                tileCount,
                packedBitmapBytes,
                bitmapCommandBytes: packedBitmapBytes + tileCount * 14,
            });
        }
    }
}

module.exports = { PromptDisplay };
