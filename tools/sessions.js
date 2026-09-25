#!/usr/bin/env node
const { DeviceFleet } = require("../utils/device-fleet");

// Keep the fleet alive until shutdown, then release BLE sessions and transport clients.
async function main() {
    const fleet = new DeviceFleet();
    let stopping = false;
    const shutdown = (code) => {
        if (stopping) return;
        stopping = true;
        fleet.stop().then(() => process.exit(code)).catch((error) => {
            console.error("[Fleet] shutdown:", error?.stack || error);
            process.exit(1);
        });
    };
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    try {
        await fleet.start();
    } catch (error) {
        console.error("[Fleet] startup:", error?.stack || error);
        shutdown(1);
    }
}

main().catch((error) => {
    console.error("[Fleet] fatal:", error?.stack || error);
    process.exitCode = 1;
});
