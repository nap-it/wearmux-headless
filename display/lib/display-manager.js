// Display image processing utilities for BrilliantSole devices (Node.js)
const sharp = require("sharp");
const RgbQuant = require("rgbquant");
const { Config } = require("../../utils/config");

class DisplayManager {
    /**
     * @param {Device} device - SDK device instance (already connected)
     * @param {Object} options - Configuration options
     */
    constructor(device, options = {}) {
        if (!device) {
            throw new Error("DisplayManager requires a device instance (use SDK DeviceManager to connect)");
        }
        if (!device.isDisplayAvailable) {
            throw new Error("Device does not have a display available");
        }

        this.device = device;
        const dcfg = Config.getDisplayConfig();

        const info = device.displayInformation;
        this.width = options.width || dcfg.outWidth || (info?.width) || 640;
        this.height = options.height || dcfg.outHeight || (info?.height) || 400;

        // Device displays are palette-indexed; valid depths are 1, 2, 4 (bits per pixel -> 2,4,16 colors)
        this.pixelDepth = options.pixelDepth || dcfg.pixelDepth || (info?.pixelDepth ? Number(info.pixelDepth) : 4);
        if (![1, 2, 4].includes(this.pixelDepth)) this.pixelDepth = 4;

        this.defaultFit = options.fit || dcfg.fit || "contain";
        this.defaultAlign = options.align || dcfg.align || "center";
        this.defaultX = Number.isFinite(options.x) ? options.x : dcfg.x ?? 0;
        this.defaultY = Number.isFinite(options.y) ? options.y : dcfg.y ?? 0;
        this.tileMaxPixels = options.tileMaxPixels || dcfg.tileMaxPixels || 220;
        this.inputHeight = options.inputHeight || dcfg.inputHeight; // height used to process/quantize
        this.outputHeight = options.outputHeight || dcfg.outputHeight; // height used on device via scale

        if (process.env.DEBUG === '1') {
            console.log("[DisplayManager] display caps:", {
                width: this.width,
                height: this.height,
                pixelDepth: this.pixelDepth,
            });
        }
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

        const enableTiming = process.env.DEBUG === '1' || process.env.DISPLAY_TIMING === '1';
        const renderStartTime = enableTiming ? performance.now() : 0;

        const dstW = opts.outWidth || this.width || srcInfo.width;
        const dstH = opts.outHeight || this.height || srcInfo.height;
        const posX = Number.isFinite(opts.x) ? opts.x : this.defaultX;
        const posY = Number.isFinite(opts.y) ? opts.y : this.defaultY;

        const pipeline = sharp(rawRgbBuffer, {
            raw: { width: srcInfo.width, height: srcInfo.height, channels: 3 },
        });

        // Prefer height-based resize for upload speed; fall back to width/height
        const processHeight = opts.inputHeight || this.inputHeight;
        if (processHeight) {
            pipeline.resize({ height: processHeight, fit: "inside" });
        } else {
            const fit = opts.fit || this.defaultFit || "contain";
            const align = opts.align || this.defaultAlign || "center";
            const alignMap = { top: "top", bottom: "bottom", left: "left", right: "right", center: "centre" };
            pipeline.resize({
                width: dstW,
                height: dstH,
                fit,
                position: alignMap[align] || "centre",
            });
        }
        pipeline.raw();

        const resizeStartTime = enableTiming ? performance.now() : 0;
        const resized = await pipeline.toBuffer({ resolveWithObject: true });
        const resizeTime = enableTiming ? performance.now() - resizeStartTime : 0;

        // rgbquant expects RGBA; expand RGB -> RGBA with opaque alpha
        const actualW = resized.info.width;
        const actualH = resized.info.height;
        const rgba = Buffer.alloc(actualW * actualH * 4);
        for (let i = 0, j = 0; i < resized.data.length; i += 3, j += 4) {
            rgba[j] = resized.data[i];
            rgba[j + 1] = resized.data[i + 1];
            rgba[j + 2] = resized.data[i + 2];
            rgba[j + 3] = 255;
        }

        // Quantize to the device-supported number of colors
        const targetDepth = Number(opts.pixelDepth || this.pixelDepth);
        const numberOfColors = targetDepth === 1 ? 2 : targetDepth === 2 ? 4 : 16; // 1->2, 2->4, 4->16
        const quantizeStartTime = enableTiming ? performance.now() : 0;
        const { indexed, paletteHex } = await this._quantizeRGBToIndexed(
            rgba,
            actualW,
            actualH,
            numberOfColors
        );
        const quantizeTime = enableTiming ? performance.now() - quantizeStartTime : 0;

        // Configure display alignment so x/y are top-left
        await this.device.setDisplayHorizontalAlignment("start");
        await this.device.setDisplayVerticalAlignment("start");

        // Compute output scale from desired outputHeight relative to processed height
        const processedH = resized.info.height;
        const processedW = resized.info.width;
        const desiredOutputH = opts.outputHeight || this.outputHeight || processedH;
        const scale = Math.max(0.01, desiredOutputH / processedH);
        if (Math.abs(scale - 1) > 1e-3) {
            await this.device.setDisplayBitmapScale(scale, true);
        }

        const finalWidth = Math.round(processedW * scale);
        const finalHeight = Math.round(processedH * scale);
        const centeredX = posX === 0 ? Math.round((this.width - finalWidth) / 2) : posX;
        const centeredY = posY === 0 ? Math.round((this.height - finalHeight) / 2) : posY;

        // Draw using tiled bitmaps to respect device limits
        const procW = resized.info.width;
        const procH = resized.info.height;
        const fullIndexed = Array.isArray(indexed) ? indexed : Array.from(indexed);

        const pixelDepth = this.pixelDepth;
        const pixelsPerByte = 8 / pixelDepth;

        // Use MTU-based calculation if available, but ensure we don't go smaller than tileMaxPixels
        let maxPixelsPerBitmap;
        if (this.device.mtu && this.device.mtu > 0) {
            // SDK: maxCommandDataLength = mtu - 7, drawBitmapHeaderLength = 13
            // So max pixel data = mtu - 7 - 13 = mtu - 20
            const maxPixelDataLength = this.device.mtu - 20;
            const mtuBasedMaxPixels = Math.floor(maxPixelDataLength / pixelsPerByte);
            maxPixelsPerBitmap = Math.max(mtuBasedMaxPixels, this.tileMaxPixels);
            if (process.env.DEBUG === '1') {
                console.log(`[Tile Sizing] MTU-based: mtu=${this.device.mtu}, maxPixelDataLength=${maxPixelDataLength}, pixelsPerByte=${pixelsPerByte}, mtuBasedMaxPixels=${mtuBasedMaxPixels}, using maxPixelsPerBitmap=${maxPixelsPerBitmap} (tileMaxPixels=${this.tileMaxPixels})`);
            }
        } else {
            maxPixelsPerBitmap = this.tileMaxPixels;
            if (process.env.DEBUG === '1') {
                console.log(`[Tile Sizing] Fallback: tileMaxPixels=${this.tileMaxPixels}`);
            }
        }

        // Calculate tile dimensions (row-based like SDK)
        const maxBitmapWidth = Math.min(maxPixelsPerBitmap, procW);
        let maxBitmapHeight = 1;
        if (maxBitmapWidth === procW) {
            const bitmapRowPixelDataLength = Math.ceil(procW / pixelsPerByte);
            const maxPixelDataLength = this.device.mtu ?
                (this.device.mtu - 12 - 5) : (maxPixelsPerBitmap * pixelsPerByte);
            maxBitmapHeight = Math.floor(maxPixelDataLength / bitmapRowPixelDataLength);
        }

        const pickTileHeight = (w) => {
            if (w === procW && maxBitmapHeight > 1) {
                return maxBitmapHeight;
            }
            return Math.max(1, Math.floor(maxPixelsPerBitmap / w));
        };
        const baseTileW = Math.min(procW, maxBitmapWidth);

        // Collect all tiles first, then draw them in batch
        const tilePrepStartTime = enableTiming ? performance.now() : 0;
        const tiles = [];
        for (let yOff = 0; yOff < procH;) {
            const tileW = baseTileW;
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
                tiles.push({
                    bitmap: { width: w, height: h, numberOfColors, pixels },
                    x: centeredX + Math.round(xOff * scale),
                    y: centeredY + Math.round(yOff * scale),
                    srcX: xOff,
                    srcY: yOff,
                    srcW: w,
                    srcH: h
                });
            }
            yOff += tileH;
        }

        // Merge adjacent uniform tiles to reduce tile count
        const mergeStartTime = enableTiming ? performance.now() : 0;
        let mergedTiles = tiles;
        const avgTilePixels = tiles.length > 0 ? tiles.reduce((sum, t) => sum + (t.srcW * t.srcH), 0) / tiles.length : 0;
        const canMerge = avgTilePixels < maxPixelsPerBitmap * 0.7;

        if (canMerge) {
            mergedTiles = [];
            const processed = new Set();
            const tileMap = new Map();
            tiles.forEach((t, idx) => {
                const key = `${t.srcX},${t.srcY}`;
                tileMap.set(key, idx);
            });

            for (let i = 0; i < tiles.length; i++) {
                if (processed.has(i)) continue;

                const tile = tiles[i];
                const pixels = tile.bitmap.pixels;
                const firstColor = pixels[0];
                const isUniform = pixels.every(p => p === firstColor);

                if (!isUniform) {
                    mergedTiles.push(tile);
                    processed.add(i);
                    continue;
                }

                let mergedW = tile.srcW;
                let mergedH = tile.srcH;
                let mergedX = tile.srcX;
                let mergedY = tile.srcY;

                while (true) {
                    const rightX = mergedX + mergedW;
                    if (rightX >= procW) break;

                    const rightKey = `${rightX},${mergedY}`;
                    const rightTileIdx = tileMap.get(rightKey);
                    if (rightTileIdx === undefined || processed.has(rightTileIdx)) break;

                    const rightTile = tiles[rightTileIdx];
                    if (rightTile.srcH !== mergedH) break;

                    const rightPixels = rightTile.bitmap.pixels;
                    const rightColor = rightPixels[0];
                    if (!rightPixels.every(p => p === rightColor) || rightColor !== firstColor) break;

                    const newW = mergedW + rightTile.srcW;
                    if (newW * mergedH > maxPixelsPerBitmap) break;

                    mergedW = newW;
                    processed.add(rightTileIdx);
                }

                while (true) {
                    const downY = mergedY + mergedH;
                    if (downY >= procH) break;

                    let allUniform = true;
                    const tilesToMerge = [];

                    for (let x = mergedX; x < mergedX + mergedW; x += baseTileW) {
                        const w = Math.min(baseTileW, mergedX + mergedW - x);
                        const downKey = `${x},${downY}`;
                        const downTileIdx = tileMap.get(downKey);
                        if (downTileIdx === undefined || processed.has(downTileIdx)) {
                            allUniform = false;
                            break;
                        }

                        const tileAtPos = tiles[downTileIdx];
                        if (tileAtPos.srcW !== w) {
                            allUniform = false;
                            break;
                        }

                        const tilePixels = tileAtPos.bitmap.pixels;
                        const tileColor = tilePixels[0];
                        const tileIsUniform = tilePixels.every(p => p === tileColor);

                        if (!tileIsUniform || tileColor !== firstColor) {
                            allUniform = false;
                            break;
                        }

                        tilesToMerge.push(tileAtPos);
                    }

                    if (!allUniform || tilesToMerge.length === 0) break;

                    const newH = mergedH + tilesToMerge[0].srcH;
                    if (mergedW * newH > maxPixelsPerBitmap) break;

                    mergedH = newH;
                    tilesToMerge.forEach(tileToMerge => {
                        const mergeKey = `${tileToMerge.srcX},${tileToMerge.srcY}`;
                        const mergeIdx = tileMap.get(mergeKey);
                        if (mergeIdx !== undefined) processed.add(mergeIdx);
                    });
                }

                if (mergedW > tile.srcW || mergedH > tile.srcH) {
                    const mergedPixels = new Array(mergedW * mergedH);
                    for (let r = 0; r < mergedH; r++) {
                        for (let c = 0; c < mergedW; c++) {
                            const srcY = mergedY + r;
                            const srcX = mergedX + c;
                            const srcIdx = srcY * procW + srcX;
                            mergedPixels[r * mergedW + c] = fullIndexed[srcIdx] || 0;
                        }
                    }

                    mergedTiles.push({
                        bitmap: { width: mergedW, height: mergedH, numberOfColors, pixels: mergedPixels },
                        x: centeredX + Math.round(mergedX * scale),
                        y: centeredY + Math.round(mergedY * scale),
                        srcX: mergedX,
                        srcY: mergedY,
                        srcW: mergedW,
                        srcH: mergedH
                    });
                } else {
                    mergedTiles.push(tile);
                }

                processed.add(i);
            }

        }

        const mergeTime = enableTiming ? performance.now() - mergeStartTime : 0;
        const tilePrepTime = enableTiming ? performance.now() - tilePrepStartTime : 0;
        const originalTileCount = tiles.length;
        const actualTileCount = mergedTiles.length;

        if (process.env.DEBUG === '1') {
            if (canMerge && originalTileCount !== actualTileCount) {
                console.log(`[Tile Merge] Merged ${originalTileCount} → ${actualTileCount} tiles (${((1 - actualTileCount / originalTileCount) * 100).toFixed(1)}% reduction, ${mergeTime.toFixed(2)}ms)`);
            } else if (!canMerge) {
                console.log(`[Tile Merge] Skipped (tiles at MTU limit, avg ${avgTilePixels.toFixed(0)}px, limit ${maxPixelsPerBitmap}, ${mergeTime.toFixed(2)}ms)`);
            }
        }

        // Map bitmap colors to the device's 16-color global palette to prevent color shifting
        if (!this._devicePaletteCache) {
            this._devicePaletteCache = new Array(16).fill(null);
            this._devicePaletteNext = 0;
        }

        const colorSetupStartTime = enableTiming ? performance.now() : 0;
        const bitmapColorPairs = [];

        for (let i = 0; i < paletteHex.length; i++) {
            const hex = paletteHex[i];
            let colorIndex = this._devicePaletteCache.indexOf(hex);

            if (colorIndex === -1) {
                // Color not in cache, allocate a new index (0-15)
                colorIndex = this._devicePaletteNext;
                this._devicePaletteCache[colorIndex] = hex;
                this._devicePaletteNext = (this._devicePaletteNext + 1) % 16;
                // Update the hardware's global palette at this index
                if (process.env.DEBUG === '1') console.log(`[Debug] Calling setDisplayColor(${colorIndex}, ${hex})...`);
                await this.device.setDisplayColor(colorIndex, hex);
                if (process.env.DEBUG === '1') console.log(`[Debug] setDisplayColor done`);
            }
            bitmapColorPairs.push({ bitmapColorIndex: i, colorIndex });
        }

        if (bitmapColorPairs.length) {
            if (process.env.DEBUG === '1') console.log(`[Debug] Calling selectDisplayBitmapColors...`);
            await this.device.selectDisplayBitmapColors(bitmapColorPairs);
            if (process.env.DEBUG === '1') console.log(`[Debug] selectDisplayBitmapColors done`);
        }
        const colorSetupTime = enableTiming ? performance.now() - colorSetupStartTime : 0;

        const drawStartTime = enableTiming ? performance.now() : 0;

        for (let i = 0; i < mergedTiles.length; i++) {
            const tile = mergedTiles[i];
            const isLast = i === mergedTiles.length - 1;
            if (process.env.DEBUG === '1') console.log(`[Debug] Calling drawDisplayBitmap(${i}/${mergedTiles.length})...`);
            await this.device.drawDisplayBitmap(tile.x, tile.y, tile.bitmap, isLast);
            if (process.env.DEBUG === '1') console.log(`[Debug] drawDisplayBitmap done`);
        }
        if (process.env.DEBUG === '1') console.log(`[Debug] Calling showDisplay...`);
        await this.device.showDisplay(true);
        if (process.env.DEBUG === '1') console.log(`[Debug] showDisplay done`);
        const drawTime = enableTiming ? performance.now() - drawStartTime : 0;

        if (Math.abs(scale - 1) > 1e-3) {
            if (process.env.DEBUG === '1') console.log(`[Debug] Calling resetDisplayBitmapScale...`);
            await this.device.resetDisplayBitmapScale(true);
            if (process.env.DEBUG === '1') console.log(`[Debug] resetDisplayBitmapScale done`);
        }

        if (enableTiming) {
            const totalTime = performance.now() - renderStartTime;
            console.log(`[Render Timing] Total: ${totalTime.toFixed(2)}ms`);
            console.log(`  - Resize: ${resizeTime.toFixed(2)}ms | Quantize: ${quantizeTime.toFixed(2)}ms | Tile prep: ${tilePrepTime.toFixed(2)}ms`);
            if (process.env.DEBUG === '1' && mergeTime > 0.1) {
                console.log(`  - Tile merge: ${mergeTime.toFixed(2)}ms`);
            }
            console.log(`  - Color setup: ${colorSetupTime.toFixed(2)}ms | Draw/transmit: ${drawTime.toFixed(2)}ms (${actualTileCount} tiles)`);
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
        const isSmall = width * height < 4;
        const method = isSmall ? 1 : 2;

        const q = new RgbQuant({
            colors: numberOfColors,
            dithKern: null,
            method: method
        });
        q.sample(rgbaBuffer);
        const indexed = q.reduce(rgbaBuffer, method);
        const pal = q.palette(true);
        const paletteHex = [];
        for (let k = 0; k < pal.length; k++) {
            const [r, g, b] = pal[k];
            paletteHex.push(`#${r.toString(16).padStart(2, "0")}${g
                .toString(16)
                .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`);
        }
        while (paletteHex.length < numberOfColors) paletteHex.push("#000000");
        if (paletteHex.length > numberOfColors) paletteHex.length = numberOfColors;
        return { indexed, paletteHex };
    }
}

module.exports = { DisplayManager };
