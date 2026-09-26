const sharp = require("sharp");

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
                width: maxWidth,
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

    async _layout(text, width, height) {
        const scale = Math.min(width / 640, height / 400, 1);
        const maxWidth = Math.floor(width * 0.85);
        const maxHeight = Math.floor(height * 0.8);
        const minimumSize = Math.max(12, Math.round(18 * scale));
        let question;
        for (let size = Math.max(minimumSize, Math.round(32 * scale)); size >= minimumSize; size -= 2) {
            question = await this._renderText(text, size, maxWidth, true);
            if (question.height <= maxHeight) break;
        }
        if (!question || question.height > maxHeight) {
            throw new Error("Question does not fit the display; provide a shorter prompt");
        }

        return [{
            ...question,
            x: Math.round((width - question.width) / 2),
            y: Math.round((height - question.height) / 2),
        }];
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

    async show(text) {
        const timingEnabled = process.env.DISPLAY_TIMING === "1" || process.env.DEBUG === "1";
        const startedAt = timingEnabled ? performance.now() : 0;
        const width = this.device.displayInformation?.width || 640;
        const height = this.device.displayInformation?.height || 400;
        const key = JSON.stringify([text, width, height]);
        let blocks = this.cache.get(key);
        const cacheHit = Boolean(blocks);
        if (!blocks) {
            blocks = await this._layout(text, width, height);
            if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value);
            this.cache.set(key, blocks);
        }

        // The SDK reserves seven bytes of transport overhead, one command byte
        // and a 13-byte bitmap header. One-bit pixels pack eight per byte.
        const mtu = Number(this.device.mtu) || 23;
        const maxPixels = Math.floor(mtu - 21) * 8;
        if (maxPixels < 8) throw new Error("Display MTU is too small for bitmap commands");
        const preparedAt = timingEnabled ? performance.now() : 0;
        // A preceding clear/show action can finish its SDK flush before the
        // device acknowledges it. Drain that event before drawing this prompt.
        if (this.device.isDisplayReady === false) await this._waitForDisplayReady();
        const drawStartedAt = timingEnabled ? performance.now() : 0;
        let tileCount = 0;
        let packedBitmapBytes = 0;

        await this.device.setDisplayColor(0, "#000000", false);
        await this.device.setDisplayColor(1, "#FFFFFF", false);
        await this.device.setDisplayOpacity(1, false);
        await this.device.selectDisplayBackgroundColor(0, false);
        await this.device.selectDisplayBitmapColors([
            { bitmapColorIndex: 0, colorIndex: 0 },
            { bitmapColorIndex: 1, colorIndex: 1 },
        ], false);
        await this.device.setDisplayHorizontalAlignment("start", false);
        await this.device.setDisplayVerticalAlignment("start", false);
        await this.device.resetDisplayBitmapScale(false);
        await this.device.clearDisplay(false);

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
                previousReadyWaitMs: Number((drawStartedAt - preparedAt).toFixed(2)),
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
