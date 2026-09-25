#!/usr/bin/env node
const { DeviceManager } = require("../utils/device-manager");
const { createPublisher } = require("../utils/transport");
const { topic } = require("../utils/topics");
const { formatLevelBar } = require("./lib/audio-utils");
const { MicrophoneSession } = require("./lib/microphone-session");

async function main() {
    const publisher = createPublisher({ keyPrefix: topic() });
    publisher?.on("error", (error) => console.warn("[Microphone] transport:", error?.message || error));
    const manager = new DeviceManager();
    // connectToDevice rejects the same error after emitting it.
    manager.on("error", () => {});
    let device;
    let microphone;
    let stopping = false;
    let sampleCount = 0;
    let duration = 0;

    const shutdown = async (code) => {
        if (stopping) return;
        stopping = true;
        // Stop capture and close transports before dropping the device connection.
        try { await microphone?.stop(); }
        catch (error) { console.warn("[Microphone] stop:", error?.message || error); }
        try { await publisher?.stop(); }
        catch (error) { console.warn("[Microphone] transport stop:", error?.message || error); }
        try { await manager.disconnect(); }
        catch (error) { console.warn("[Microphone] disconnect:", error?.message || error); }
        console.log(`\n[Microphone] ${duration.toFixed(1)}s, ${sampleCount} samples`);
        process.exit(code);
    };
    process.on("SIGINT", () => { void shutdown(0); });
    process.on("SIGTERM", () => { void shutdown(0); });

    try {
        if (publisher) await publisher.start();
        device = await manager.connectToDevice();
        if (!device.hasMicrophone) throw new Error("Device does not have a microphone");
        const deviceInfo = { id: device.bluetoothId || device.id, name: device.name };
        microphone = new MicrophoneSession(device, publisher, {
            deviceInfo,
            onStatus: (status) => console.log(`\n[Microphone] ${status}`),
            onLevel: (meta) => {
                sampleCount += meta.samples;
                duration = sampleCount / Number(meta.sampleRate || 16000);
                const line = `${formatLevelBar(meta.rms, 30)} | RMS ${(meta.rms * 100).toFixed(1)}% | ` +
                    `Peak ${(meta.peak * 100).toFixed(1)}% | ${duration.toFixed(1)}s`;
                const pad = " ".repeat(Math.max(0, (process.stdout.columns || 0) - line.length));
                process.stdout.write(`\r${line}${pad}`);
            },
        });
        manager.on("reconnected", () => microphone.resume().catch((error) =>
            console.warn("[Microphone] reconnect:", error?.message || error)));
        await microphone.start();
        console.log(`\n[Microphone] Streaming from ${deviceInfo.name || deviceInfo.id}. Press Ctrl+C to stop.`);
    } catch (error) {
        console.error("[Microphone]", error?.stack || error);
        await shutdown(1);
    }
}

if (require.main === module) {
    // The SDK can emit a malformed audio packet; keep the known packet error local
    // to this standalone command instead of masking unrelated process errors.
    process.on("uncaughtException", (error) => {
        if (error instanceof RangeError && error.message.includes("bounds of the DataView")) {
            if (process.env.DEBUG === "1") console.warn("[Microphone] bad packet skipped:", error.message);
            return;
        }
        console.error("[Microphone] uncaught:", error?.stack || error);
        process.exit(1);
    });
    main().catch((error) => {
        console.error("[Microphone]", error?.stack || error);
        process.exit(1);
    });
}

module.exports = main;
