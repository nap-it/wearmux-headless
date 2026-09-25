const { DeviceManager } = require("../utils/device-manager");
const { ActionDispatcher } = require("../utils/action-dispatcher");
const { selectedTransport } = require("../utils/transport");

async function main() {
    if (selectedTransport() === "none") {
        throw new Error("Set MESSAGE_TRANSPORT=mqtt or MESSAGE_TRANSPORT=zenoh");
    }

    const deviceManager = new DeviceManager();
    const device = await deviceManager.connectToDevice();
    const dispatcher = new ActionDispatcher(device);
    dispatcher.on("error", (error) => console.warn("[Actions]", error?.message || error));

    try {
        await dispatcher.start();
    } catch (error) {
        await deviceManager.disconnect();
        throw error;
    }

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        let exitCode = 0;
        try { await dispatcher.stop(); }
        catch (error) {
            console.error("[Actions] stop failed:", error?.message || error);
            exitCode = 1;
        } finally {
            await deviceManager.disconnect();
        }
        process.exit(exitCode);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

if (require.main === module) {
    main().catch((error) => {
        console.error("[Actions]", error?.message || error);
        process.exit(1);
    });
}

module.exports = main;
