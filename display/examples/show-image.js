// Example: Show an image on the device display with position/size/depth
const { DisplayManager } = require("../lib/display-manager");
const { Config } = require("../../utils/config");

async function main() {
    const img = process.argv[2];
    if (!img) {
        console.error(
            "Usage: node display/examples/show-image.js <imagePath> [x] [y] [outWidth] [outHeight] [pixelDepth]"
        );
        process.exit(1);
    }
    const dcfg = Config.getDisplayConfig();
    const x = process.argv[3] ? Number(process.argv[3]) : dcfg.x ?? 0;
    const y = process.argv[4] ? Number(process.argv[4]) : dcfg.y ?? 0;
    const outWidth = process.argv[5] ? Number(process.argv[5]) : dcfg.outWidth;
    const outHeight = process.argv[6] ? Number(process.argv[6]) : dcfg.outHeight;
    const pixelDepth = process.argv[7] ? Number(process.argv[7]) : dcfg.pixelDepth; // 1, 2 or 4 (bits)

    const dm = new DisplayManager({ pixelDepth, x, y, width: outWidth, height: outHeight, fit: dcfg.fit, align: dcfg.align, brightness: dcfg.brightness, tileMaxPixels: dcfg.tileMaxPixels });
    await dm.connect();

    if (dm.device?.isDisplayAvailable) {
        const info = dm.device.displayInformation;
        if (info) {
            console.log(`Device display: ${info.width}x${info.height} depth=${info.pixelDepth}`);
        }
    }
    console.log(
        `Displaying ${img} at (${x},${y}) ${outWidth || "auto"}x${
            outHeight || "auto"
        } paletteDepth=${pixelDepth || dm.pixelDepth}`
    );
    await dm.showImageFile(img, { x, y, outWidth, outHeight, fit: dcfg.fit, align: dcfg.align, pixelDepth });
    console.log("Done.");
}

if (require.main === module) {
    main().catch((e) => {
        console.error("Display error:", e);
        process.exit(1);
    });
}

module.exports = main;
