#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const { Config } = require("../../utils/config");
const { DeviceManager } = require("../../utils/device-manager");
const { isValidJpeg, hasValidJpegStructure } = require("../../camera/lib/image-validator");
const { ViewerServer } = require("../../camera/lib/viewer-server");
const { summarizeLatencySamples } = require("./lib/latency-utils");

function isExpectedDisconnectError(error) {
    const message = String(error?.message || error || "");
    return message.startsWith("Disconnected ") || message === "Disconnected";
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMeasurementCount(value) {
    const parsed = Number.parseInt(String(value ?? "50"), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 50;
    }
    return parsed;
}

function formatMs(value) {
    return `${value.toFixed(1)}ms`;
}

function printSummary(label, summary) {
    if (!summary) {
        console.log(`${label}: no samples`);
        return;
    }
    console.log(
        `${label}: count=${summary.count} min=${formatMs(summary.minMs)} avg=${formatMs(summary.meanMs)} std=${formatMs(summary.stdDevMs)} median=${formatMs(summary.medianMs)} p90=${formatMs(summary.p90Ms)} max=${formatMs(summary.maxMs)}`
    );
}

async function writeResults(outputPath, payload) {
    const resolved = path.resolve(outputPath);
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Results saved to ${resolved}`);
}

async function toImageBuffer(cameraImage) {
    if (!cameraImage) return null;
    if (cameraImage.blob && typeof cameraImage.blob.arrayBuffer === "function") {
        return Buffer.from(await cameraImage.blob.arrayBuffer());
    }
    if (cameraImage.arrayBuffer) {
        return Buffer.from(cameraImage.arrayBuffer);
    }
    return null;
}

async function prepareCamera(device, config, cameraRate) {
    const availableSettings = new Set(
        Array.isArray(device.availableCameraConfigurationTypes) && device.availableCameraConfigurationTypes.length > 0
            ? device.availableCameraConfigurationTypes
            : Object.keys(device.cameraConfiguration || {})
    );

    const settingsMap = {
        resolution: config.resolution,
        qualityFactor: config.qualityFactor ?? config.quality,
        gain: config.gain,
        redGain: config.redGain,
        greenGain: config.greenGain,
        blueGain: config.blueGain,
        autoWhiteBalanceEnabled: config.autoWhiteBalanceEnabled,
        autoGainEnabled: config.autoGainEnabled,
        exposure: config.exposure,
        autoExposureEnabled: config.autoExposureEnabled,
        autoExposureLevel: config.autoExposureLevel,
        brightness: config.brightness,
        saturation: config.saturation,
        contrast: config.contrast,
        sharpness: config.sharpness,
    };

    const cameraConfig = {};
    for (const [key, value] of Object.entries(settingsMap)) {
        if (value === undefined) continue;
        if (availableSettings.size > 0 && !availableSettings.has(key)) continue;
        cameraConfig[key] = value;
    }

    if (cameraRate !== undefined && device.sensorConfiguration?.camera !== cameraRate) {
        console.log(`Setting camera sensor rate: ${cameraRate}`);
        await device.setSensorConfiguration({ camera: cameraRate }, false, true);
    }

    console.log("Waiting for camera to stabilize...");
    await sleep(2000);
}

async function main() {
    const config = Config.getCameraConfig();
    const debug = process.env.DEBUG === "1" || process.env.CAMERA_DEBUG === "1";
    const measurementsTarget = normalizeMeasurementCount(process.env.CAMERA_LATENCY_MEASUREMENTS);
    const outputPath = process.env.CAMERA_LATENCY_OUTPUT;
    const cameraRate = config.rate ?? 10;
    const viewEnable = config.viewEnable;
    const viewPort = config.viewPort || 8099;
    const viewHost = config.viewHost || "0.0.0.0";
    const viewMjpeg = config.viewMjpeg;

    let stopRequested = false;
    let shuttingDown = false;
    let requestStopCapture = null;
    let summaryPrinted = false;

    process.on("unhandledRejection", (reason) => {
        if (shuttingDown && isExpectedDisconnectError(reason)) {
            if (debug) {
                console.warn("Ignoring expected disconnect rejection during shutdown:", reason?.message || reason);
            }
            return;
        }
        console.error("Unhandled rejection:", reason?.stack || reason?.message || String(reason));
        process.exitCode = 1;
    });

    process.on("uncaughtException", (error) => {
        if (shuttingDown && isExpectedDisconnectError(error)) {
            if (debug) {
                console.warn("Ignoring expected disconnect exception during shutdown:", error?.message || error);
            }
            return;
        }
        console.error("Uncaught exception:", error?.stack || error?.message || String(error));
        process.exit(1);
    });

    process.on("SIGINT", () => {
        if (!stopRequested) {
            stopRequested = true;
            shuttingDown = true;
            console.log("\nStopping after current frame...");
            requestStopCapture?.();
        }
    });

    process.on("SIGTERM", () => {
        if (!stopRequested) {
            stopRequested = true;
            shuttingDown = true;
            console.log("\nStopping...");
            requestStopCapture?.();
        }
    });

    let deviceManager;
    let device;
    let viewerServer = null;
    let latestImage = null;
    const samples = [];

    const printResults = async () => {
        if (summaryPrinted) return;
        summaryPrinted = true;

        console.log("\n--- Results ---");

        const latencySummary = summarizeLatencySamples(
            samples.map((s) => s.deviceLatencyMs).filter((v) => Number.isFinite(v))
        );
        const sizeSummary = summarizeLatencySamples(
            samples.map((s) => s.bytes).filter((v) => Number.isFinite(v))
        );

        printSummary("Capture latency (command -> image received)", latencySummary);
        if (sizeSummary) {
            console.log(
                `Frame size: count=${sizeSummary.count} min=${sizeSummary.minMs}B avg=${Math.round(sizeSummary.meanMs)}B max=${sizeSummary.maxMs}B`
            );
        }

        if (samples.length >= 2) {
            const intervals = [];
            for (let i = 1; i < samples.length; i++) {
                intervals.push(samples[i].receivedAtUnixMs - samples[i - 1].receivedAtUnixMs);
            }
            const intervalSummary = summarizeLatencySamples(intervals);
            printSummary("Frame interval", intervalSummary);
            if (intervalSummary && intervalSummary.meanMs > 0) {
                console.log(`Effective FPS: ${(1000 / intervalSummary.meanMs).toFixed(1)}`);
            }
        }

        if (outputPath) {
            await writeResults(outputPath, {
                generatedAt: new Date().toISOString(),
                config: { measurementsTarget, cameraRate },
                samples,
                summaries: { latencyMs: latencySummary, sizeBytes: sizeSummary },
            });
        }
    };

    try {
        console.log("Connecting to device...");
        deviceManager = new DeviceManager();
        device = await deviceManager.connectToDevice();
        if (!device.isConnected) await device.waitForEvent("connected");
        console.log(`Connected to device: ${device.name || device.id}`);

        if (!device.hasCamera) {
            throw new Error("Device does not have a camera");
        }

        await prepareCamera(device, config, cameraRate);

        if (viewEnable) {
            viewerServer = new ViewerServer({ mjpeg: viewMjpeg });
            viewerServer.start(viewHost, viewPort, () => latestImage);
            console.log(`Viewer at http://${viewHost === "0.0.0.0" ? "localhost" : viewHost}:${viewPort}`);
        }

        device.autoPicture = true;
        await device.takePicture(cameraRate);

        console.log(
            `Camera latency test: ${measurementsTarget || "continuous"} frames, cameraRate=${cameraRate}` +
            (viewEnable ? `, viewer on port ${viewPort}` : "")
        );
        console.log("Capturing frames...\n");

        let index = 0;

        await new Promise((resolve) => {
            let finished = false;
            let onImage;

            const finishCapture = () => {
                if (finished) return;
                finished = true;
                if (onImage) {
                    device.removeEventListener("cameraImage", onImage);
                }
                resolve();
            };

            requestStopCapture = finishCapture;

            onImage = async (event) => {
                if (stopRequested || (measurementsTarget > 0 && index >= measurementsTarget)) {
                    finishCapture();
                    return;
                }

                try {
                    const cameraImage = event?.message;
                    if (!cameraImage) return;

                    const buffer = await toImageBuffer(cameraImage);
                    if (!buffer || buffer.length < 100) return;
                    if (!isValidJpeg(buffer) || !hasValidJpegStructure(buffer)) return;

                    const receivedAt = Date.now();
                    const timestamp = Number(cameraImage.timestamp);
                    const deviceLatencyMs = Number.isFinite(Number(cameraImage.latency))
                        ? Number(cameraImage.latency) : null;

                    latestImage = { buffer, mime: "image/jpeg" };
                    if (viewerServer) {
                        viewerServer.updateImage(buffer, "image/jpeg");
                    }

                    index += 1;
                    samples.push({
                        index,
                        deviceLatencyMs,
                        bytes: buffer.length,
                        receivedAtUnixMs: receivedAt,
                        cameraTimestamp: Number.isFinite(timestamp) ? timestamp : null,
                    });

                    const tsStr = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "n/a";
                    console.log(
                        `#${index} latency=${deviceLatencyMs != null ? formatMs(deviceLatencyMs) : "n/a"} size=${buffer.length}B ts=${tsStr}`
                    );

                    if (stopRequested || (measurementsTarget > 0 && index >= measurementsTarget)) {
                        finishCapture();
                    }
                } catch (err) {
                    if (debug) console.warn("[Capture] Error:", err.message);
                }
            };

            device.addEventListener("cameraImage", onImage);

            if (stopRequested) {
                finishCapture();
            }
        });

        requestStopCapture = null;
        await printResults();
    } finally {
        shuttingDown = true;
        if (!summaryPrinted) {
            try {
                await printResults();
            } catch (error) {
                console.warn("Failed to print final results:", error?.message || error);
            }
        }

        try {
            if (device && device.isConnected) device.autoPicture = false;
        } catch {}

        try {
            viewerServer?.stop();
        } catch {}

        try {
            if (deviceManager && device?.isConnected) {
                console.log("Disconnecting from device...");
            }
            await deviceManager?.disconnect();
            if (deviceManager) {
                console.log("Disconnected.");
            }
        } catch {}
    }
}

main().catch((error) => {
    console.error("Camera latency test failed:", error?.stack || error?.message || String(error));
    process.exit(1);
});
