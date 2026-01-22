// Example: Show an image on the device display
const { DisplayManager } = require("./lib/display-manager");
const { Config } = require("../utils/config");
const { DeviceManager } = require("../utils/device-manager");

async function getDevice() {
    const device = await new DeviceManager().connectToDevice();
    
    if (!device.isDisplayAvailable) {
        await device.waitForEvent("isDisplayAvailable");
    }
    if (!device.isDisplayReady) {
        try {
            await device.waitForEvent("displayReady");
        } catch {}
    }
    
    if (device.displayStatus === "asleep") {
        await device.wakeDisplay();
    }
    const dcfg = Config.getDisplayConfig();
    const brightness = dcfg.brightness || "medium";
    await device.setDisplayBrightness(brightness, true);
    
    return device;
}

async function main() {
    const img = process.argv[2];
    if (!img) {
        console.error("Usage: node display/index.js <imagePath>");
        process.exit(1);
    }
    
    const dcfg = Config.getDisplayConfig();
    
    console.log("Connecting to device...");
    const device = await getDevice();
    
    if (!device.isDisplayAvailable) {
        throw new Error("Display is not available on this device");
    }
    
    const info = device.displayInformation;
    if (info) {
        console.log(`Device display: ${info.width}x${info.height} depth=${info.pixelDepth}`);
    } else {
        console.warn("Warning: Could not get display information");
    }
    
    const dm = new DisplayManager(device, {
        pixelDepth: dcfg.pixelDepth,
        x: dcfg.x,
        y: dcfg.y,
        width: dcfg.outWidth,
        height: dcfg.outHeight,
        fit: dcfg.fit,
        align: dcfg.align,
    });
    
    console.log(
        `Displaying ${img} at (${dcfg.x},${dcfg.y}) ${dcfg.outWidth || "auto"}x${
            dcfg.outHeight || "auto"
        } paletteDepth=${dcfg.pixelDepth || dm.pixelDepth}`
    );
    
    await dm.showImageFile(img, {
        x: dcfg.x,
        y: dcfg.y,
        width: dcfg.outWidth,
        height: dcfg.outHeight,
        fit: dcfg.fit,
        align: dcfg.align,
        pixelDepth: dcfg.pixelDepth,
    });
    
    console.log("Done. Press Ctrl+C to exit.");
}

if (require.main === module) {
    main().catch((e) => {
        console.error("Display error:", e);
        process.exit(1);
    });
}

module.exports = main;
