// Text display utilities using SVG + sharp
const sharp = require("sharp");
const { DisplayManager } = require("./display-manager");
const { Config } = require("../../utils/config");

/**
 * TextDisplay - Renders text messages on BrilliantSole Frame display using SVG + sharp
 *
 * Uses image-based rendering (no browser APIs) - compatible with Node.js.
 */
class TextDisplay {
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
     * Load font (validates path for @font-face; optional for SVG fallback)
     * @param {string} fontPath - Path to TTF/OTF font file
     * @param {number} fontSize - Font size in points
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
        const svgHeight = Math.min(this.height, Math.max(200, lines.length * lineHeight + padding * 2));
        const fontFamily = this.fontFamily;
        const fontWeightProp = `font-weight: ${this.fontWeight};`;
        const lineSpacing = lineHeight;
        const startY = padding + this.currentFontSize;

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
    const textLines = wrappedLines;
    const textElements = textLines
        .map(
            (line, i) =>
                `    <text x="${svgWidth / 2}" y="${startY + i * lineSpacing}" text-anchor="middle" font-size="${this.currentFontSize}" font-family="${fontFamily}" ${fontWeightProp} fill="${color}">${this._escapeXml(line)}</text>`
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

        return buffer;
    }

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
     * @param {Object} options - Display options
     */
    async showText(text, options = {}) {
        if (!this.initialized) {
            throw new Error("TextDisplay not initialized. Call loadFont() first.");
        }

        const color = options.color || this.defaultColor;
        const fontSize = options.fontSize || this.currentFontSize;
        const fontFamily = options.fontFamily || this.fontFamily;
        const fontWeight = options.fontWeight || this.fontWeight;
        const key = `${text}:${color}:${fontSize}:${fontFamily}:${fontWeight}`;

        let buffer = this.cache.get(key);
        if (!buffer) {
            try {
                buffer = await this._textToImageBuffer(text, color);
                if (this.cache.size >= 10) {
                    const firstKey = this.cache.keys().next().value;
                    this.cache.delete(firstKey);
                }
                this.cache.set(key, buffer);
            } catch (err) {
                console.error("Text render error:", err.message);
                throw err;
            }
        }

        await this.displayManager.showImageBuffer(buffer, "image/png", {
            fit: "contain",
            align: "center",
            pixelDepth: options.pixelDepth || this.displayManager.pixelDepth,
        });

        return true;
    }

    /**
     * Clear the display
     */
    async clear() {
        if (this.device && this.device.clearDisplay) {
            await this.device.clearDisplay(false);
            await this.device.showDisplay(true);
        }
    }

    setFontSize(fontSize) {
        this.currentFontSize = fontSize;
    }

    setColor(color) {
        this.defaultColor = color;
    }
}

module.exports = { TextDisplay };
