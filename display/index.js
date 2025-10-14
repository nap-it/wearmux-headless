// Example: Show an image on the device display with position/size/depth
const { DisplayManager } = require("./lib/display-manager");
const { Config } = require("../utils/config");

async function main() {
    const img = process.argv[2];
    if (!img) {
        console.error("Usage: node display/index.js <imagePath>");
        process.exit(1);
    }
    const dcfg = Config.getDisplayConfig();
    const dm = new DisplayManager({ pixelDepth: dcfg.pixelDepth, x: dcfg.x, y: dcfg.y, width: dcfg.outWidth, height: dcfg.outHeight, fit: dcfg.fit, align: dcfg.align, brightness: dcfg.brightness });
    await dm.connect();

    if (dm.device?.isDisplayAvailable) {
        const info = dm.device.displayInformation;
        if (info) {
            console.log(`Device display: ${info.width}x${info.height} depth=${info.pixelDepth}`);
        }
    }
    console.log(
        `Displaying ${img} at (${dcfg.x},${dcfg.y}) ${dcfg.outWidth || "auto"}x${
            dcfg.outHeight || "auto"
        } paletteDepth=${dcfg.pixelDepth || dm.pixelDepth}`
    );
    await dm.showImageFile(img, { x: dcfg.x, y: dcfg.y, width: dcfg.outWidth, height: dcfg.outHeight, fit: dcfg.fit, align: dcfg.align, pixelDepth: dcfg.pixelDepth });
    console.log("Done.");
}

if (require.main === module) {
    main().catch((e) => {
        console.error("Display error:", e);
        process.exit(1);
    });
}

module.exports = main;
