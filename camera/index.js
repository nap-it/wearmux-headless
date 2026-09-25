const { DeviceManager } = require("../utils/device-manager");
const { createPublisher } = require("../utils/transport");
const { topic } = require("../utils/topics");
const { CameraSession } = require("./lib/camera-session");

async function main() {
    const publisher = createPublisher({ keyPrefix: topic() });
    publisher?.on("error", (error) => console.warn("[Camera] transport:", error?.message || error));
    const manager = new DeviceManager();
    // connectToDevice rejects the same error after emitting it.
    manager.on("error", () => {});
    let device;
    let camera;
    let stopping = false;

    const shutdown = async (code) => {
        if (stopping) return;
        stopping = true;
        // Release camera resources and the BLE connection before exiting this standalone command.
        try { await camera?.stop(); }
        catch (error) { console.warn("[Camera] stop:", error?.message || error); }
        try { await publisher?.stop(); }
        catch (error) { console.warn("[Camera] transport stop:", error?.message || error); }
        try { await manager.disconnect(); }
        catch (error) { console.warn("[Camera] disconnect:", error?.message || error); }
        process.exit(code);
    };
    process.on("SIGINT", () => { void shutdown(0); });
    process.on("SIGTERM", () => { void shutdown(0); });

    try {
        if (publisher) await publisher.start();
        device = await manager.connectToDevice();
        if (!device.hasCamera) throw new Error("Device does not have a camera");
        const deviceInfo = { id: device.bluetoothId || device.id, name: device.name };
        camera = new CameraSession(device, publisher, { deviceInfo });
        manager.on("reconnected", () => camera.resume().catch((error) =>
            console.warn("[Camera] reconnect:", error?.message || error)));
        await camera.start();
        console.log(`[Camera] ${deviceInfo.name || deviceInfo.id} ready; auto=${camera.config.autoPicture}`);

        if (!camera.config.autoPicture) {
            // In one-shot mode, return after confirming that the first image reached the pipeline.
            const timeoutMs = Math.max(1000, Number(process.env.CAMERA_CAPTURE_TIMEOUT_MS || 5000)) + 3000;
            const received = await Promise.race([
                camera.firstFrame,
                new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
            ]);
            if (!received) console.warn("[Camera] No image received before timeout");
            await new Promise((resolve) => setTimeout(resolve, 500));
            await shutdown(0);
        }
    } catch (error) {
        console.error("[Camera]", error?.stack || error);
        await shutdown(1);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error("[Camera]", error?.stack || error);
        process.exit(1);
    });
}

module.exports = main;
