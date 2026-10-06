// Text display utilities using SVG + sharp
const sharp = require("sharp");
const { DisplayManager } = require("./display-manager");
const { Config } = require("../../utils/config");

/**
 * Render text through host-side SVG rasterization and DisplayManager.
 * Call loadFont() before showText(). The owner keeps the device connected and
 * serializes display operations; font family and weight are constructor settings.
 * @class
 * @see {@tutorial display}
 */
class TextDisplay {
    /**
     * @param {Object} device Connected SDK device with an available display.
     * @param {Object} [options={}] Text rendering defaults.
     * @param {number} [options.fontSize=24] SVG font size.
     * @param {string} [options.fontFamily="sans-serif"] Host font family.
     * @param {string} [options.fontWeight="normal"] Host font weight.
     * @param {string} [options.color="#FFFFFF"] Text color.
     * @throws {Error} When the device is missing or display unavailable.
     */
    constructor(device, options = {}) {
        if (!device) {
            throw new Error("TextDisplay requires a device instance");
        }
        if (!device.isDisplayAvailable) {
            throw new Error("Device does not have a display available");
        }

        this.device = device;
        this.currentFontSize = options.fontSize || 24;
        this.fontFamily = options.fontFamily || "sans-serif";
        this.fontWeight = options.fontWeight || "normal";
        this.defaultColor = options.color ?? "#FFFFFF";
        this.displayManager = null;
        this.initialized = false;

        const dcfg = Config.getDisplayConfig();
        const info = device.displayInformation;
        this.width = info?.width || 640;
        this.height = info?.height || 400;
    }

    /**
     * Initialize the renderer and its cache, optionally changing the font size.
     * Uses fonts available to the host SVG renderer; no font file is loaded.
     * @param {?number} [fontSize=null] SVG font size; null preserves the constructor value.
     * @returns {Promise<void>}
     */
    async loadFont(fontSize = null) {
        if (fontSize) {
            this.currentFontSize = fontSize;
        }

        const dcfg = Config.getDisplayConfig();
        this.displayManager = new DisplayManager(this.device, {
            pixelDepth: dcfg.pixelDepth,
            x: dcfg.x,
            y: dcfg.y,
            width: this.width,
            height: this.height,
            fit: "contain",
            align: "center",
        });

        this.cache = new Map();
        this.initialized = true;
        console.log(`Text display ready (${this.currentFontSize}pt)`);
    }

    /**
     * Render text to PNG buffer using SVG
     * @private
     */
    async _textToImageBuffer(text, color = "#FFFFFF") {
        const lines = text.split("\n");
        const lineHeight = this.currentFontSize + 8;
        const padding = 16;
        const svgWidth = Math.min(this.width, 600);
        const fontFamily = this.fontFamily;
        const fontWeight = this.fontWeight;
        const lineSpacing = lineHeight;

        const maxLineWidth = svgWidth * 0.85;
        const wrappedLines = [];

        for (const line of lines) {
            if (line.length * 8 < maxLineWidth) { // Rough char width est
                wrappedLines.push(line);
            } else {
                // Simple word wrap
                const words = line.split(" ");
                let currentLine = "";
                for (const word of words) {
                    const testLine = currentLine ? currentLine + " " + word : word;
                    if (testLine.length * 8 > maxLineWidth) {
                        if (currentLine) wrappedLines.push(currentLine);
                        currentLine = word;
                    } else {
                        currentLine = testLine;
                    }
                }
                if (currentLine) wrappedLines.push(currentLine);
            }
        }

        // Tight-fit height based on actual wrapped line count (no arbitrary minimum)
        const svgHeight = Math.min(this.height, wrappedLines.length * lineHeight + padding * 2);
        const startY = padding + this.currentFontSize;

        const textElements = wrappedLines
            .map(
                (line, i) =>
                    `    <text x="${svgWidth / 2}" y="${startY + i * lineSpacing}" text-anchor="middle" font-size="${this.currentFontSize}" font-family="${fontFamily}" font-weight="${fontWeight}" fill="${color}">${this._escapeXml(line)}</text>`
            )
            .join("\n");

        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="100%" height="100%" fill="#000000"/>
${textElements}
</svg>`;

        const buffer = await sharp(Buffer.from(svg))
            .png()
            .toBuffer();

        return { buffer, width: svgWidth, height: svgHeight };
    }

    /** @private */
    _escapeXml(str) {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    }

    /**
     * Show text on the display
     * @param {string} text - Text to display (supports \n for line breaks)
     * @param {Object} [options={}] Supported display options.
     * @param {boolean} [options.clearBefore=false] Clear before rendering.
     * @param {string} [options.color] Text color; defaults to setColor()/constructor setting.
     * @param {number} [options.pixelDepth] Palette depth override.
     * @returns {Promise<boolean>} Resolves true after rendering; rejects if uninitialized or rendering fails.
     */
    async showText(text, options = {}) {
        if (!this.initialized) {
            throw new Error("TextDisplay not initialized. Call loadFont() first.");
        }

        if (options.clearBefore) {
            await this.clear();
        }

        const color = options.color || this.defaultColor;
        const fontSize = options.fontSize || this.currentFontSize;
        const fontFamily = options.fontFamily || this.fontFamily;
        const fontWeight = options.fontWeight || this.fontWeight;
        const key = `${text}:${color}:${fontSize}:${fontFamily}:${fontWeight}`;

        let result = this.cache.get(key);
        if (!result) {
            try {
                result = await this._textToImageBuffer(text, color);
                if (this.cache.size >= 10) {
                    const firstKey = this.cache.keys().next().value;
                    this.cache.delete(firstKey);
                }
                this.cache.set(key, result);
            } catch (err) {
                console.error("Text render error:", err.message);
                throw err;
            }
        }

        const { buffer, width: imgW, height: imgH } = result;

        // Center the tight-fit text strip on the full display
        const x = Math.round((this.width - imgW) / 2);
        const y = Math.round((this.height - imgH) / 2);

        await this.displayManager.showImageBuffer(buffer, "image/png", {
            outWidth: imgW,
            outHeight: imgH,
            x,
            y,
            fit: "contain",
            align: "center",
            pixelDepth: options.pixelDepth || this.displayManager.pixelDepth,
        });

        return true;
    }

    /**
     * Clear and show the device display when those SDK methods are available.
     * @returns {Promise<void>} Rejects on a device command failure.
     */
    async clear() {
        if (this.device && this.device.clearDisplay) {
            await this.device.clearDisplay(false);
            await this.device.showDisplay(true);
        }
    }

    /**
     * Change the font size for subsequent uncached text.
     * @param {number} fontSize SVG font size.
     * @returns {void}
     */
    setFontSize(fontSize) {
        this.currentFontSize = fontSize;
    }

    /**
     * Change the default text color for subsequent calls.
     * @param {string} color Text color.
     * @returns {void}
     */
    setColor(color) {
        this.defaultColor = color;
    }
}

module.exports = { TextDisplay };
