const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { Config } = require("../../utils/config");
const { DeviceManager } = require("../../utils/device-manager");
const { ColorScreenServer } = require("./lib/color-screen-server");
const {
    detectDominantColor,
    summarizeLatencySamples,
} = require("./lib/latency-utils");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_START_COLOR = "green";
const DEFAULT_VIEWER_TIMEOUT_MS = 120000;
const DEFAULT_BROWSER_PAINT_DELAY_MS = 10;
const DEFAULT_ROI_RATIO = 0.5;

function envNumber(name, fallback) {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function envFlag(name, fallback) {
    if (process.env[name] == null) return fallback;
    return !["0", "false", "no", "off"].includes(String(process.env[name]).toLowerCase());
}

function oppositeColor(color) {
    return color === "red" ? "green" : "red";
}

function formatMs(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}ms` : "n/a";
}

function formatTimestamp(value) {
    if (!Number.isFinite(value)) return "n/a";
    try {
        return new Date(value).toISOString();
    } catch {
        return "n/a";
    }
}

function normalizeMeasurementCount(value) {
    return Math.max(0, Math.trunc(Number(value) || 0));
}

function summarizeSamples(samples) {
    const summary = summarizeLatencySamples(samples.map((sample) => sample.latencyMs));
    const browserAdjustedSummary = summarizeLatencySamples(
        samples.map((sample) => sample.browserAdjustedLatencyMs).filter((value) => Number.isFinite(value))
    );
    const deviceLatencies = samples
        .map((sample) => sample.deviceReportedLatencyMs)
        .filter((value) => Number.isFinite(value));
    const analysisSummary = summarizeLatencySamples(
        samples.map((sample) => sample.analysisDurationMs).filter((value) => Number.isFinite(value))
    );

    return {
        summary,
        browserAdjustedSummary,
        deviceSummary: summarizeLatencySamples(deviceLatencies),
        analysisSummary,
    };
}

function printSummaries(samples) {
    const { summary, browserAdjustedSummary, deviceSummary, analysisSummary } = summarizeSamples(samples);
    const browserPaintSummary = summarizeLatencySamples(
        samples.map((sample) => sample.browserPaintDelayMs).filter((value) => Number.isFinite(value))
    );

    console.log("");
    if (!summary) {
        console.log("No latency samples collected.");
        return { summary, browserAdjustedSummary, deviceSummary, browserPaintSummary, analysisSummary };
    }

    if (browserAdjustedSummary) {
        console.log("Browser-adjusted E2E latency summary:");
        console.log(`  samples: ${browserAdjustedSummary.count}`);
        console.log(`  min: ${formatMs(browserAdjustedSummary.minMs)}`);
        console.log(`  mean: ${formatMs(browserAdjustedSummary.meanMs)}`);
        console.log(`  median: ${formatMs(browserAdjustedSummary.medianMs)}`);
        console.log(`  p90: ${formatMs(browserAdjustedSummary.p90Ms)}`);
        console.log(`  p95: ${formatMs(browserAdjustedSummary.p95Ms)}`);
        console.log(`  max: ${formatMs(browserAdjustedSummary.maxMs)}`);
        console.log(`  stddev: ${formatMs(browserAdjustedSummary.stdDevMs)}`);
    }

    console.log("");
    console.log("Raw wall-clock E2E latency summary:");
    console.log(`  samples: ${summary.count}`);
    console.log(`  min: ${formatMs(summary.minMs)}`);
    console.log(`  mean: ${formatMs(summary.meanMs)}`);
    console.log(`  median: ${formatMs(summary.medianMs)}`);
    console.log(`  p90: ${formatMs(summary.p90Ms)}`);
    console.log(`  p95: ${formatMs(summary.p95Ms)}`);
    console.log(`  max: ${formatMs(summary.maxMs)}`);
    console.log(`  stddev: ${formatMs(summary.stdDevMs)}`);

    if (deviceSummary) {
        console.log("");
        console.log("Device-reported camera latency summary:");
        console.log(`  samples: ${deviceSummary.count}`);
        console.log(`  mean: ${formatMs(deviceSummary.meanMs)}`);
        console.log(`  median: ${formatMs(deviceSummary.medianMs)}`);
        console.log(`  p90: ${formatMs(deviceSummary.p90Ms)}`);
    }

    if (browserPaintSummary) {
        console.log("");
        console.log("Browser paint-delay summary:");
        console.log(`  samples: ${browserPaintSummary.count}`);
        console.log(`  mean: ${formatMs(browserPaintSummary.meanMs)}`);
        console.log(`  median: ${formatMs(browserPaintSummary.medianMs)}`);
        console.log(`  p90: ${formatMs(browserPaintSummary.p90Ms)}`);
        console.log(`  max: ${formatMs(browserPaintSummary.maxMs)}`);
    }

    if (analysisSummary) {
        console.log("");
        console.log("Color-analysis time summary (excluded from E2E):");
        console.log(`  samples: ${analysisSummary.count}`);
        console.log(`  mean: ${formatMs(analysisSummary.meanMs)}`);
        console.log(`  median: ${formatMs(analysisSummary.medianMs)}`);
        console.log(`  p90: ${formatMs(analysisSummary.p90Ms)}`);
        console.log(`  max: ${formatMs(analysisSummary.maxMs)}`);
    }

    return { summary, browserAdjustedSummary, deviceSummary, browserPaintSummary, analysisSummary };
}

function assertBrowserPaintDelay(presentation, options) {
    if (!presentation || !Number.isFinite(presentation.clientPaintDelayMs)) {
        throw new Error("Browser did not report a valid paint acknowledgement");
    }

    if (presentation.clientPaintDelayMs > options.maxBrowserPaintDelayMs) {
        throw new Error(
            `Browser paint delay ${formatMs(presentation.clientPaintDelayMs)} exceeded ` +
                `${formatMs(options.maxBrowserPaintDelayMs)}. ` +
                "Use a local browser window or a faster display path."
        );
    }
}

async function getDevice() {
    return new DeviceManager().connectToDevice();
}

function waitForDeviceEvent(device, eventType, timeoutMs, predicate = () => true) {
    return new Promise((resolve) => {
        let timeout;
        const handler = (event) => {
            let matches = false;
            try {
                matches = predicate(event);
            } catch {}

            if (!matches) {
                return;
            }

            cleanup();
            resolve({ timedOut: false, event });
        };

        const cleanup = () => {
            if (timeout) clearTimeout(timeout);
            device.removeEventListener(eventType, handler);
        };

        device.addEventListener(eventType, handler);
        timeout = setTimeout(() => {
            cleanup();
            resolve({ timedOut: true, event: null });
        }, timeoutMs);
    });
}

async function invokeCameraCommand(device, label, invoke, timeoutMs) {
    const settledPromise = Promise.resolve()
        .then(() => invoke())
        .then(
            () => ({ status: "resolved" }),
            (error) => ({ status: "rejected", error })
        );

    const result = timeoutMs > 0
        ? await Promise.race([
            settledPromise,
            sleep(timeoutMs).then(() => ({ status: "timeout" })),
        ])
        : await settledPromise;

    if (result.status === "rejected") {
        throw result.error;
    }

    if (result.status === "timeout") {
        console.warn(
            `[WARN] ${label} did not report a camera status change within ${timeoutMs}ms. ` +
                "Continuing and waiting for camera data."
        );
        settledPromise.then((lateResult) => {
            if (lateResult.status === "rejected") {
                console.error(`[ERROR] ${label} failed after timeout:`, lateResult.error);
            }
        });
    }
}

async function focusCameraForCapture(device, options) {
    const focusIdlePromise = waitForDeviceEvent(
        device,
        "cameraStatus",
        options.focusIdleTimeoutMs,
        (event) =>
            event?.message?.cameraStatus === "idle" &&
            event?.message?.previousCameraStatus === "focusing"
    );

    console.log("Focusing camera...");
    await invokeCameraCommand(
        device,
        "Focus command",
        () => device.focusCamera(options.cameraRate),
        options.cameraCommandTimeoutMs
    );

    const focusIdle = await focusIdlePromise;
    if (focusIdle.timedOut) {
        console.warn(
            `[WARN] Camera focus did not return to idle within ${options.focusIdleTimeoutMs}ms; continuing anyway.`
        );
    }

    if (options.focusSettleMs > 0) {
        await sleep(options.focusSettleMs);
    }
}

async function triggerPicture(device, options) {
    await invokeCameraCommand(
        device,
        "Take picture command",
        () => device.takePicture(options.cameraRate),
        options.cameraCommandTimeoutMs
    );
}

async function ensureCameraReady(device, options) {
    if (!device.hasCamera) {
        throw new Error("Device does not have a camera");
    }

    await new Promise((resolve) => {
        if (device.connectionStatus === "connected") {
            resolve();
            return;
        }

        const handler = () => {
            device.removeEventListener("connected", handler);
            resolve();
        };
        device.addEventListener("connected", handler);
    });

    const availableCameraConfigTypes = new Set(
        Array.isArray(device.availableCameraConfigurationTypes) && device.availableCameraConfigurationTypes.length > 0
            ? device.availableCameraConfigurationTypes
            : Object.keys(device.cameraConfiguration || {})
    );

    const requestedCameraConfig = {
        resolution: options.cameraResolution,
        qualityFactor: options.cameraQualityFactor,
        shutter: options.cameraShutter,
        gain: options.cameraGain,
        redGain: options.cameraRedGain,
        greenGain: options.cameraGreenGain,
        blueGain: options.cameraBlueGain,
        autoWhiteBalanceEnabled: options.cameraAutoWhiteBalanceEnabled,
        autoGainEnabled: options.cameraAutoGainEnabled,
        exposure: options.cameraExposure,
        autoExposureEnabled: options.cameraAutoExposureEnabled,
        autoExposureLevel: options.cameraAutoExposureLevel,
        brightness: options.cameraBrightness,
        saturation: options.cameraSaturation,
        contrast: options.cameraContrast,
        sharpness: options.cameraSharpness,
    };

    const cameraConfig = {};
    for (const [key, value] of Object.entries(requestedCameraConfig)) {
        if (value === undefined) continue;
        if (availableCameraConfigTypes.size > 0 && !availableCameraConfigTypes.has(key)) {
            continue;
        }
        cameraConfig[key] = value;
    }

    if (Object.keys(cameraConfig).length > 0) {
        console.log("Applying camera config:", cameraConfig);
        await device.setCameraConfiguration(cameraConfig);
    }

    if (device.cameraStatus === "asleep") {
        await invokeCameraCommand(
            device,
            "Wake camera command",
            () => device.wakeCamera(),
            options.cameraCommandTimeoutMs
        );
    }

    if (options.cameraRate !== undefined && device.sensorConfiguration?.camera !== options.cameraRate) {
        console.log(`Setting camera sensor rate: ${options.cameraRate}`);
        await device.setSensorConfiguration({ camera: options.cameraRate }, false, true);
    }

    await sleep(options.cameraWakeDelayMs);

    if (options.focusAtStart) {
        await focusCameraForCapture(device, options);
    }
}

async function toImageBuffer(cameraImage) {
    if (!cameraImage) {
        throw new Error("Missing camera image payload");
    }

    if (cameraImage.blob) {
        return Buffer.from(await cameraImage.blob.arrayBuffer());
    }
    if (cameraImage.arrayBuffer) {
        return Buffer.from(cameraImage.arrayBuffer);
    }

    throw new Error("Unsupported camera image payload");
}

async function captureBestImage(device, options) {
    return new Promise((resolve, reject) => {
        const images = [];
        let settled = false;
        let settleTimer = null;
        let timeoutTimer = null;

        const cleanup = () => {
            if (settleTimer) clearTimeout(settleTimer);
            if (timeoutTimer) clearTimeout(timeoutTimer);
            device.removeEventListener("cameraImage", onImage);
        };

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };

        const chooseBest = () =>
            [...images].sort((left, right) => right.size - left.size)[0];

        const onImage = async (event) => {
            try {
                const cameraImage = event.message;
                const buffer = await toImageBuffer(cameraImage);
                images.push({
                    buffer,
                    size: buffer.length,
                    receivedAtMs: performance.now(),
                    cameraTimestamp: cameraImage.timestamp ?? null,
                    deviceLatencyMs: cameraImage.latency ?? null,
                });

                if (settleTimer) clearTimeout(settleTimer);
                settleTimer = setTimeout(() => {
                    const best = chooseBest();
                    if (!best) {
                        finish(reject, new Error("Camera returned no image data"));
                        return;
                    }
                    finish(resolve, best);
                }, options.captureSettleMs);
            } catch (error) {
                finish(reject, error);
            }
        };

        timeoutTimer = setTimeout(() => {
            finish(reject, new Error(`Timed out waiting for camera image after ${options.captureTimeoutMs}ms`));
        }, options.captureTimeoutMs);

        device.addEventListener("cameraImage", onImage);

        (async () => {
            try {
                await triggerPicture(device, options);
            } catch (error) {
                finish(reject, error);
            }
        })();
    });
}

async function writeResults(outputPath, payload) {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, JSON.stringify(payload, null, 2));
}

async function main() {
    const config = Config.getAllConfig();
    const startColor = DEFAULT_START_COLOR;
    const measurementCount = normalizeMeasurementCount(envNumber("CAMERA_LATENCY_MEASUREMENTS", 12));
    const options = {
        measurements: measurementCount,
        continuous: measurementCount === 0,
        perFlipTimeoutMs: Math.max(500, envNumber("CAMERA_LATENCY_TIMEOUT_MS", 8000)),
        warmupAttempts: Math.max(1, envNumber("CAMERA_LATENCY_WARMUP_ATTEMPTS", 6)),
        browserAckTimeoutMs: Math.max(50, envNumber("CAMERA_LATENCY_BROWSER_ACK_TIMEOUT_MS", 1000)),
        maxBrowserPaintDelayMs: DEFAULT_BROWSER_PAINT_DELAY_MS,
        captureTimeoutMs: Math.max(1000, envNumber("CAMERA_LATENCY_CAPTURE_TIMEOUT_MS", 6000)),
        captureSettleMs: Math.max(50, envNumber("CAMERA_LATENCY_CAPTURE_SETTLE_MS", 300)),
        analysisSize: Math.max(16, envNumber("CAMERA_LATENCY_ANALYSIS_SIZE", 96)),
        roiWidthRatio: DEFAULT_ROI_RATIO,
        roiHeightRatio: DEFAULT_ROI_RATIO,
        minDominanceRatio: envNumber("CAMERA_LATENCY_COLOR_RATIO", 1.15),
        minChannelGap: envNumber("CAMERA_LATENCY_COLOR_GAP", 12),
        minMeanIntensity: envNumber("CAMERA_LATENCY_MIN_INTENSITY", 20),
        focusAtStart: envFlag("CAMERA_LATENCY_FOCUS_AT_START", true),
        cameraWakeDelayMs: Math.max(0, envNumber("CAMERA_LATENCY_CAMERA_WAKE_DELAY_MS", 1500)),
        focusSettleMs: Math.max(0, envNumber("CAMERA_LATENCY_FOCUS_SETTLE_MS", 1200)),
        cameraCommandTimeoutMs: Math.max(0, envNumber("CAMERA_COMMAND_TIMEOUT_MS", 1500)),
        focusIdleTimeoutMs: Math.max(0, envNumber("CAMERA_FOCUS_IDLE_TIMEOUT_MS", 3000)),
        cameraRate: Math.max(1, envNumber("CAMERA_LATENCY_CAMERA_RATE", config.camera.rate || 10)),
        outputPath: process.env.CAMERA_LATENCY_OUTPUT || "",
        screenHost: process.env.CAMERA_LATENCY_SCREEN_HOST || "0.0.0.0",
        screenPort: Math.max(1, envNumber("CAMERA_LATENCY_SCREEN_PORT", 8765)),
        viewerTimeoutMs: DEFAULT_VIEWER_TIMEOUT_MS,
        requireViewer: envFlag("CAMERA_LATENCY_REQUIRE_VIEWER", true),
        cameraResolution: config.camera.resolution || 640,
        cameraQualityFactor: config.camera.qualityFactor !== undefined ? config.camera.qualityFactor : 95,
        cameraShutter: config.camera.shutter,
        cameraGain: config.camera.gain,
        cameraRedGain: config.camera.redGain,
        cameraGreenGain: config.camera.greenGain,
        cameraBlueGain: config.camera.blueGain,
        cameraAutoWhiteBalanceEnabled: config.camera.autoWhiteBalanceEnabled,
        cameraAutoGainEnabled: config.camera.autoGainEnabled,
        cameraExposure: config.camera.exposure,
        cameraAutoExposureEnabled: config.camera.autoExposureEnabled,
        cameraAutoExposureLevel: config.camera.autoExposureLevel,
        cameraBrightness: config.camera.brightness,
        cameraSaturation: config.camera.saturation,
        cameraContrast: config.camera.contrast,
        cameraSharpness: config.camera.sharpness,
    };

    let device = null;
    const screenServer = new ColorScreenServer();
    let stopping = false;
    let stopRequested = false;
    const cleanup = async () => {
        if (stopping) return;
        stopping = true;
        try {
            screenServer.stop();
        } catch {}
        try {
            if (device) {
                await device.disconnect();
            }
        } catch {}
    };

    const onSigint = async () => {
        if (stopRequested) {
            console.log("\nForce stopping latency test...");
            await cleanup();
            process.exit(130);
        }
        stopRequested = true;
        process.exitCode = 130;
        console.log("\nStopping latency test after the current capture...");
    };
    process.on("SIGINT", onSigint);

    try {
        await screenServer.start(options.screenHost, options.screenPort);
        console.log("Open the latency color screen in a browser on the display the camera watches:");
        for (const url of screenServer.urls) {
            console.log(`  ${url}`);
        }
        if (options.requireViewer) {
            console.log(`Waiting for a browser viewer (${options.viewerTimeoutMs}ms timeout)...`);
            await screenServer.waitForViewer(options.viewerTimeoutMs);
            console.log("Browser viewer connected.");
        }

        console.log("Connecting to device...");
        device = await getDevice();
        console.log(`Connected to device: ${device.name || device.id}`);

        await ensureCameraReady(device, options);

        function showColor(color) {
            const state = screenServer.setColor(color);
            const presentationPromise = screenServer.waitForPresentation(state.revision, options.browserAckTimeoutMs);
            return { state, presentationPromise };
        }

        const samples = [];
        let currentColor = startColor;

        console.log(
            `Starting camera latency test: measurements=${options.continuous ? "continuous" : options.measurements}, start=${currentColor}, ` +
                `roi=${options.roiWidthRatio}x${options.roiHeightRatio}, resolution=${
                    typeof options.cameraResolution === "number"
                        ? options.cameraResolution
                        : `${options.cameraResolution.width}x${options.cameraResolution.height}`
                }`
        );
        if (options.continuous) {
            console.log("Continuous mode enabled. Press Ctrl-C to stop and print the summary.");
        }
        console.log(
            `Browser paint-delay budget: ${formatMs(options.maxBrowserPaintDelayMs)} ` +
                `(ack timeout ${formatMs(options.browserAckTimeoutMs)})`
        );

        const initialDisplay = showColor(currentColor);
        assertBrowserPaintDelay(await initialDisplay.presentationPromise, options);
        console.log(`Warmup: waiting until camera sees ${currentColor}...`);

        let warmupSuccess = false;
        for (let attempt = 1; attempt <= options.warmupAttempts && !stopRequested; attempt += 1) {
            const capture = await captureBestImage(device, options);
            const analysisStartedAtMs = performance.now();
            const detection = await detectDominantColor(capture.buffer, options);
            const analysisDurationMs = performance.now() - analysisStartedAtMs;
            if (detection.color === currentColor) {
                warmupSuccess = true;
                console.log(
                    `Warmup locked in on attempt ${attempt}: ${detection.color} ` +
                        `(R=${detection.means.red.toFixed(1)} G=${detection.means.green.toFixed(1)} ` +
                        `analysis=${formatMs(analysisDurationMs)})`
                );
                break;
            }

            console.log(
                `Warmup attempt ${attempt}/${options.warmupAttempts}: saw ${detection.color} ` +
                    `(R=${detection.means.red.toFixed(1)} G=${detection.means.green.toFixed(1)} ` +
                    `analysis=${formatMs(analysisDurationMs)})`
            );
        }

        if (!warmupSuccess) {
            if (stopRequested) {
                console.log("Latency test stopped during warmup.");
            } else {
                throw new Error(`Camera never locked onto the initial ${currentColor} frame`);
            }
        }

        if (warmupSuccess && !stopRequested) {
            let previousColor = currentColor;
            currentColor = oppositeColor(currentColor);
            let flipState = showColor(currentColor);
            let attemptsSinceFlip = 0;

            while (!stopRequested && (options.continuous || samples.length < options.measurements)) {
                attemptsSinceFlip += 1;
                const capture = await captureBestImage(device, options);
                const analysisStartedAtMs = performance.now();
                const detection = await detectDominantColor(capture.buffer, options);
                const analysisDurationMs = performance.now() - analysisStartedAtMs;

                if (detection.color !== currentColor) {
                    const elapsedMs = performance.now() - flipState.state.changedAtMs;
                    if (elapsedMs > options.perFlipTimeoutMs) {
                        throw new Error(
                            `Timed out waiting for ${currentColor} after ${options.perFlipTimeoutMs}ms ` +
                                `(last seen=${detection.color} R=${detection.means.red.toFixed(1)} G=${detection.means.green.toFixed(1)})`
                        );
                    }
                    continue;
                }

                const presentation = await flipState.presentationPromise;
                assertBrowserPaintDelay(presentation, options);

                const latencyMs = capture.receivedAtMs - (flipState.state.changedAtMs || performance.now());
                const browserAdjustedLatencyMs = Math.max(0, latencyMs - presentation.clientPaintDelayMs);
                const sample = {
                    index: samples.length + 1,
                    fromColor: previousColor,
                    toColor: currentColor,
                    attempts: attemptsSinceFlip,
                    latencyMs,
                    browserAdjustedLatencyMs,
                    browserPaintDelayMs: presentation.clientPaintDelayMs,
                    browserAckLatencyMs: presentation.receivedAtServerMs - flipState.state.changedAtMs,
                    analysisDurationMs,
                    wallClockDetectedAtMs: capture.receivedAtMs,
                    cameraTimestamp: capture.cameraTimestamp,
                    deviceReportedLatencyMs: capture.deviceLatencyMs,
                    means: detection.means,
                    confidence: detection.confidence,
                };

                samples.push(sample);
                console.log(
                    `#${sample.index} ${sample.fromColor}->${sample.toColor} ` +
                        `adj=${formatMs(sample.browserAdjustedLatencyMs)} raw=${formatMs(sample.latencyMs)} ` +
                        `(attempts=${sample.attempts}, browser=${formatMs(sample.browserPaintDelayMs)}, ` +
                        `analysis=${formatMs(sample.analysisDurationMs)}, frameTs=${formatTimestamp(sample.cameraTimestamp)}, seen=${currentColor}, ` +
                        `R=${sample.means.red.toFixed(1)} G=${sample.means.green.toFixed(1)})`
                );

                previousColor = currentColor;
                currentColor = oppositeColor(currentColor);
                flipState = showColor(currentColor);
                attemptsSinceFlip = 0;
            }
        }

        if (stopRequested && options.continuous) {
            console.log(`Collected ${samples.length} measurement${samples.length === 1 ? "" : "s"} before stopping.`);
        } else if (stopRequested) {
            console.log(
                `Collected ${samples.length} of ${options.measurements} requested measurements before stopping.`
            );
        }

        const { summary, browserAdjustedSummary, deviceSummary, browserPaintSummary, analysisSummary } =
            printSummaries(samples);

        if (options.outputPath) {
            const results = {
                createdAt: new Date().toISOString(),
                interrupted: stopRequested,
                completed: !stopRequested && !options.continuous,
                config: {
                    measurements: options.measurements,
                    continuous: options.continuous,
                    startColor,
                    browserAckTimeoutMs: options.browserAckTimeoutMs,
                    maxBrowserPaintDelayMs: options.maxBrowserPaintDelayMs,
                    screenHost: options.screenHost,
                    screenPort: options.screenPort,
                    cameraRate: options.cameraRate,
                    cameraResolution: options.cameraResolution,
                    cameraQualityFactor: options.cameraQualityFactor,
                    analysisSize: options.analysisSize,
                    roiWidthRatio: options.roiWidthRatio,
                    roiHeightRatio: options.roiHeightRatio,
                    minDominanceRatio: options.minDominanceRatio,
                    minChannelGap: options.minChannelGap,
                    minMeanIntensity: options.minMeanIntensity,
                },
                summary,
                browserAdjustedSummary,
                deviceSummary,
                browserPaintSummary,
                analysisSummary,
                samples,
            };
            await writeResults(options.outputPath, results);
            console.log(`Saved results to ${options.outputPath}`);
        }
    } finally {
        process.removeListener("SIGINT", onSigint);
        await cleanup();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error("Camera latency test failed:", error);
        process.exit(1);
    });
}

module.exports = main;
