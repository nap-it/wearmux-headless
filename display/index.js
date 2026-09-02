// Example: Show an image on the device display
const { DisplayManager } = require("./lib/display-manager");
const { Config } = require("../utils/config");
const { DeviceManager } = require("../utils/device-manager");
const { createPublisher, selectedTransport } = require("../utils/transport");

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

    const publisherEnabled = selectedTransport() !== "none" && process.env.ZENOH_DISPLAY_ENABLE !== "0";
    const zenoh = publisherEnabled
        ? createPublisher({
            keyPrefix: process.env.ZENOH_DISPLAY_KEY_PREFIX || "bsole/display",
            udsPath: process.env.ZENOH_DISPLAY_UDS_PATH || `/tmp/bsole-zenoh-display-${process.pid}.sock`,
        })
        : null;
    if (zenoh) {
        zenoh.on("error", (e) => {
            if (process.env.DEBUG === "1") console.warn("[Display][Zenoh]", e?.message || e);
        });
        await zenoh.start();
    }
    
    if (!device.isDisplayAvailable) {
        throw new Error("Display is not available on this device");
    }
    
    const info = device.displayInformation;
    if (info) {
        console.log(`Device display: ${info.width}x${info.height} depth=${info.pixelDepth}`);
    } else {
        console.warn("Warning: Could not get display information");
    }

    if (zenoh) {
        try {
            await zenoh.publish(`${zenoh.keyPrefix}/info`, {
                ts: Date.now(),
                device: { id: device.bluetoothId || device.id, name: device.name },
                displayInformation: info || null,
            });
        } catch {}
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

    if (zenoh) {
        try {
            await zenoh.publish(`${zenoh.keyPrefix}/shown`, {
                ts: Date.now(),
                device: { id: device.bluetoothId || device.id, name: device.name },
                imagePath: img,
                config: {
                    x: dcfg.x,
                    y: dcfg.y,
                    width: dcfg.outWidth,
                    height: dcfg.outHeight,
                    fit: dcfg.fit,
                    align: dcfg.align,
                    pixelDepth: dcfg.pixelDepth,
                },
            });
        } catch (e) { console.warn("[Display] publish failed:", e?.message || e); }
        try { await zenoh.stop(); } catch (e) { console.warn("[Display] zenoh.stop failed:", e?.message || e); }
    }

    const shutdown = async () => {
        try { await device.disconnect(); } catch (e) { console.warn("[Display] disconnect failed:", e?.message || e); }
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    
    if (process.env.DISPLAY_KEEP_ALIVE === "1") {
        console.log("Done. Press Ctrl+C to exit.");
    } else {
        await shutdown();
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error("Display error:", e);
        process.exit(1);
    });
}

module.exports = main;
