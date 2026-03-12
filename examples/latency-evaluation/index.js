#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const { Config } = require("../../utils/config");
const { DeviceManager } = require("../../utils/device-manager");
const { isValidJpeg, hasValidJpegStructure } = require("../../camera/lib/image-validator");
const { detectDominantColor, summarizeLatencySamples } = require("./lib/latency-utils");

const START_COLOR = "green";
const DEFAULT_ANALYSIS_OPTIONS = Object.freeze({
    roiWidthRatio: 0.5,
    roiHeightRatio: 0.5,
    analysisSize: 96,
    minMeanIntensity: 20,
    minDominanceRatio: 1.15,
    minChannelGap: 12,
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function envNumber(name, fallback, minimum = -Infinity) {
    const parsed = Number(process.env[name]);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(minimum, parsed);
}

function normalizeMeasurementCount(value) {
    const parsed = Number.parseInt(String(value ?? "12"), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 12;
    }
    return parsed;
}

function oppositeColor(color) {
    return color === "red" ? "green" : "red";
}

function formatMs(value) {
    return `${value.toFixed(1)}ms`;
}

function formatTimestamp(unixMs) {
    return new Date(unixMs).toISOString();
}

function summarizeValues(samples, selector) {
    return summarizeLatencySamples(
        samples
            .map(selector)
            .filter((value) => Number.isFinite(value))
    );
}

function printSummary(label, summary) {
    if (!summary) {
        console.log(`${label}: no samples`);
        return;
    }

    console.log(
        `${label}: count=${summary.count} min=${formatMs(summary.minMs)} avg=${formatMs(summary.meanMs)} median=${formatMs(summary.medianMs)} p90=${formatMs(summary.p90Ms)} max=${formatMs(summary.maxMs)}`
    );
}

async function ensureDir(dirPath) {
    await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeResults(outputPath, payload) {
    const resolved = path.resolve(outputPath);
    await ensureDir(path.dirname(resolved));
    await fs.promises.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Saved latency results to ${resolved}`);
}

async function toImageBuffer(cameraImage) {
    if (!cameraImage) {
        return null;
    }

    if (cameraImage.blob && typeof cameraImage.blob.arrayBuffer === "function") {
        return Buffer.from(await cameraImage.blob.arrayBuffer());
    }

    if (cameraImage.arrayBuffer) {
        return Buffer.from(cameraImage.arrayBuffer);
    }

    return null;
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return { promise, resolve, reject };
}

class HostColorWindow {
    constructor() {
        this.pythonBin = process.env.BSOLE_PYTHON_BIN || "python3";
        this.scriptPath = path.join(__dirname, "host_color_window.py");
        this.child = null;
        this.stdout = null;
        this.readyDeferred = createDeferred();
        this.closed = false;
        this.nextRevision = 1;
        this.pendingPresentations = new Map();
    }

    async start(timeoutMs = 5000) {
        if (this.child) {
            return this.readyDeferred.promise;
        }

        this.child = spawn(this.pythonBin, ["-u", this.scriptPath], {
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
        });

        this.child.on("error", (error) => {
            this.rejectAllPending(error);
            this.readyDeferred.reject(error);
        });

        this.child.on("exit", (code, signal) => {
            const reason = new Error(
                this.closed
                    ? "Host color window closed"
                    : `Host color window exited unexpectedly (code=${code}, signal=${signal || "none"})`
            );
            this.closed = true;
            this.rejectAllPending(reason);
            this.readyDeferred.reject(reason);
        });

        const stdout = readline.createInterface({ input: this.child.stdout });
        stdout.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            try {
                this.handleMessage(JSON.parse(trimmed));
            } catch (error) {
                console.warn(`[HostWindow] invalid JSON: ${error.message}`);
            }
        });
        this.stdout = stdout;

        const stderr = readline.createInterface({ input: this.child.stderr });
        stderr.on("line", (line) => {
            if (line.trim()) {
                console.warn(`[HostWindow] ${line}`);
            }
        });

        return Promise.race([
            this.readyDeferred.promise,
            sleep(timeoutMs).then(() => {
                throw new Error(
                    "Timed out waiting for the host color window. Run the example on the desktop host, not inside Docker."
                );
            }),
        ]);
    }

    handleMessage(message) {
        switch (message.type) {
            case "ready":
                this.readyDeferred.resolve(message);
                return;
            case "presented": {
                const pending = this.pendingPresentations.get(message.revision);
                if (!pending) {
                    return;
                }
                clearTimeout(pending.timeoutId);
                this.pendingPresentations.delete(message.revision);
                pending.resolve({
                    ...message,
                    commandSentAtUnixMs: pending.commandSentAtUnixMs,
                    presentationDelayMs: message.presentedAtUnixMs - pending.commandSentAtUnixMs,
                });
                return;
            }
            case "closed":
                this.closed = true;
                this.rejectAllPending(new Error("Host color window closed"));
                return;
            case "error":
                console.warn(`[HostWindow] ${message.message}`);
                return;
            default:
                console.warn(`[HostWindow] unexpected message type: ${message.type}`);
        }
    }

    rejectAllPending(error) {
        for (const pending of this.pendingPresentations.values()) {
            clearTimeout(pending.timeoutId);
            pending.reject(error);
        }
        this.pendingPresentations.clear();
    }

    sendCommand(command) {
        if (!this.child || this.closed) {
            throw new Error("Host color window is not running");
        }
        this.child.stdin.write(`${JSON.stringify(command)}\n`);
    }

    async setColor(color, timeoutMs = 3000) {
        if (this.closed) {
            throw new Error("Host color window is closed");
        }

        const revision = this.nextRevision++;
        const commandSentAtUnixMs = Date.now();
        const deferred = createDeferred();
        const timeoutId = setTimeout(() => {
            this.pendingPresentations.delete(revision);
            deferred.reject(new Error(`Timed out waiting for host window to present ${color}`));
        }, timeoutMs);

        this.pendingPresentations.set(revision, {
            ...deferred,
            timeoutId,
            commandSentAtUnixMs,
        });

        this.sendCommand({ type: "setColor", color, revision });
        return deferred.promise;
    }

    async stop(timeoutMs = 1000) {
        if (!this.child) {
            return;
        }

        if (!this.closed) {
            try {
                this.sendCommand({ type: "close" });
            } catch {}
        }

        await Promise.race([
            new Promise((resolve) => this.child.once("exit", resolve)),
            sleep(timeoutMs),
        ]).catch(() => {});

        if (!this.closed) {
            this.child.kill("SIGTERM");
        }
    }
}

async function waitForConnected(device) {
    if (device.connectionStatus === "connected" || device.isConnected) {
        return;
    }

    await new Promise((resolve) => {
        const handler = () => {
            device.removeEventListener("connected", handler);
            resolve();
        };
        device.addEventListener("connected", handler);
    });
}

async function invokeCameraCommand(device, label, invoke, timeoutMs) {
    const operation = Promise.resolve()
        .then(() => invoke())
        .then(
            () => ({ status: "resolved" }),
            (error) => ({ status: "rejected", error })
        );

    const result = timeoutMs > 0
        ? await Promise.race([
            operation,
            sleep(timeoutMs).then(() => ({ status: "timeout" })),
        ])
        : await operation;

    if (result.status === "rejected") {
        throw result.error;
    }

    if (result.status === "timeout") {
        console.warn(`[WARN] ${label} did not report a camera status change within ${timeoutMs}ms`);
    }
}

async function focusCamera(device, cameraRate, commandTimeoutMs, idleTimeoutMs) {
    const idlePromise = new Promise((resolve) => {
        let timeoutId;
        const handler = (event) => {
            const message = event?.message || {};
            if (message.cameraStatus !== "idle" || message.previousCameraStatus !== "focusing") {
                return;
            }
            cleanup();
            resolve(true);
        };
        const cleanup = () => {
            clearTimeout(timeoutId);
            device.removeEventListener("cameraStatus", handler);
        };

        device.addEventListener("cameraStatus", handler);
        timeoutId = setTimeout(() => {
            cleanup();
            resolve(false);
        }, idleTimeoutMs);
    });

    console.log("Focusing camera...");
    await invokeCameraCommand(
        device,
        "Focus command",
        () => device.focusCamera(cameraRate),
        commandTimeoutMs
    );

    const reachedIdle = await idlePromise;
    if (!reachedIdle) {
        console.warn(`[WARN] Focus did not return to idle within ${idleTimeoutMs}ms`);
    }
}

async function applyCameraConfiguration(device, config, debug) {
    const availableCameraConfigTypes = new Set(
        Array.isArray(device.availableCameraConfigurationTypes) && device.availableCameraConfigurationTypes.length > 0
            ? device.availableCameraConfigurationTypes
            : Object.keys(device.cameraConfiguration || {})
    );

    const requestedCameraConfig = {
        resolution: config.resolution,
        qualityFactor: config.qualityFactor ?? config.quality,
        shutter: config.shutter,
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
    for (const [key, value] of Object.entries(requestedCameraConfig)) {
        if (value === undefined) {
            continue;
        }
        if (availableCameraConfigTypes.size > 0 && !availableCameraConfigTypes.has(key)) {
            if (debug) {
                console.warn(`[Camera] Skipping unsupported camera setting "${key}"`);
            }
            continue;
        }
        cameraConfig[key] = value;
    }

    if (debug && availableCameraConfigTypes.size > 0) {
        console.log("[Camera] Available camera settings:", [...availableCameraConfigTypes].join(", "));
        console.log("[Camera] Current device camera config:", device.cameraConfiguration);
    }

    if (Object.keys(cameraConfig).length > 0) {
        console.log("Applying camera config:", cameraConfig);
        await device.setCameraConfiguration(cameraConfig);
    } else {
        console.log("Using device camera defaults");
    }

    if (debug) {
        console.log("[Camera] Updated device camera config:", device.cameraConfiguration);
    }
}

async function prepareCamera(device, cameraRate, debug) {
    const cameraConfig = Config.getAllConfig().camera;
    await applyCameraConfiguration(device, cameraConfig, debug);

    console.log("Camera status:", device.cameraStatus);
    if (device.cameraStatus === "asleep") {
        console.log("Waking camera...");
        await device.wakeCamera();
        await sleep(1000);
    }

    if (cameraRate !== undefined && device.sensorConfiguration?.camera !== cameraRate) {
        console.log(`Setting camera sensor rate: ${cameraRate}`);
        await device.setSensorConfiguration({ camera: cameraRate }, false, true);
    }

    console.log("Waiting for camera to stabilize...");
    await sleep(2000);
}

async function captureFrame(device, options) {
    const {
        cameraRate,
        cameraCommandTimeoutMs,
        captureTimeoutMs,
        debug,
    } = options;

    const captureStartedAtUnixMs = Date.now();

    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId;

        const cleanup = () => {
            clearTimeout(timeoutId);
            device.removeEventListener("cameraImage", onCameraImage);
        };

        const settle = (fn, value) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            fn(value);
        };

        const onCameraImage = (event) => {
            Promise.resolve()
                .then(async () => {
                    const cameraImage = event?.message;
                    if (!cameraImage) {
                        return;
                    }

                    const imageTimestamp = Number(cameraImage.timestamp);
                    if (Number.isFinite(imageTimestamp) && imageTimestamp < captureStartedAtUnixMs) {
                        if (debug) {
                            console.log(
                                `[Capture] Ignoring stale image ts=${formatTimestamp(imageTimestamp)} expected>=${formatTimestamp(captureStartedAtUnixMs)}`
                            );
                        }
                        return;
                    }

                    const buffer = await toImageBuffer(cameraImage);
                    if (!buffer || buffer.length < 100) {
                        return;
                    }
                    if (!isValidJpeg(buffer) || !hasValidJpegStructure(buffer)) {
                        return;
                    }

                    settle(resolve, {
                        buffer,
                        receivedAtUnixMs: Date.now(),
                        cameraTimestamp: Number.isFinite(imageTimestamp) ? imageTimestamp : null,
                        deviceReportedLatencyMs: Number.isFinite(Number(cameraImage.latency))
                            ? Number(cameraImage.latency)
                            : null,
                        bytes: buffer.length,
                    });
                })
                .catch((error) => {
                    if (debug) {
                        console.warn("[Capture] Failed to process camera image:", error.message);
                    }
                });
        };

        timeoutId = setTimeout(() => {
            settle(reject, new Error(`Timed out waiting for a valid camera image after ${captureTimeoutMs}ms`));
        }, captureTimeoutMs);

        device.addEventListener("cameraImage", onCameraImage);

        invokeCameraCommand(
            device,
            "Take picture command",
            () => device.takePicture(cameraRate),
            cameraCommandTimeoutMs
        ).catch((error) => {
            settle(reject, error);
        });
    });
}

async function analyzeFrame(buffer, options) {
    const startedAt = process.hrtime.bigint();
    const detection = await detectDominantColor(buffer, options);
    const analysisMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { detection, analysisMs };
}

async function warmupUntilColor(device, expectedColor, options) {
    const {
        warmupAttempts,
        captureOptions,
        analysisOptions,
    } = options;

    console.log(`Warmup: waiting until camera sees ${expectedColor}...`);

    for (let attempt = 1; attempt <= warmupAttempts; attempt += 1) {
        const frame = await captureFrame(device, captureOptions);
        const { detection, analysisMs } = await analyzeFrame(frame.buffer, analysisOptions);

        if (detection.color === expectedColor) {
            console.log(
                `Warmup locked in on attempt ${attempt}: ${detection.color} (R=${detection.means.red.toFixed(1)} G=${detection.means.green.toFixed(1)} analysis=${formatMs(analysisMs)})`
            );
            return;
        }

        console.log(
            `Warmup attempt ${attempt}/${warmupAttempts}: saw ${detection.color} (R=${detection.means.red.toFixed(1)} G=${detection.means.green.toFixed(1)} analysis=${formatMs(analysisMs)})`
        );
    }

    throw new Error(`Warmup failed: the camera never locked onto ${expectedColor}`);
}

async function measureTransition(device, targetColor, measurementOptions) {
    const {
        hostWindow,
        timeoutMs,
        captureOptions,
        analysisOptions,
    } = measurementOptions;

    const presentation = await hostWindow.setColor(targetColor);
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;

    while (Date.now() < deadline) {
        attempts += 1;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            break;
        }

        const frame = await captureFrame(device, {
            ...captureOptions,
            captureTimeoutMs: Math.min(captureOptions.captureTimeoutMs, remainingMs),
        });
        const { detection, analysisMs } = await analyzeFrame(frame.buffer, analysisOptions);

        if (detection.color !== targetColor) {
            continue;
        }

        return {
            ...presentation,
            attempts,
            analysisMs,
            frameReceivedAtUnixMs: frame.receivedAtUnixMs,
            cameraTimestamp: frame.cameraTimestamp,
            deviceReportedLatencyMs: frame.deviceReportedLatencyMs,
            frameBytes: frame.bytes,
            detection,
            latencyMs: frame.receivedAtUnixMs - presentation.presentedAtUnixMs,
        };
    }

    throw new Error(`Timed out waiting for the camera to see ${targetColor}`);
}

async function main() {
    const debug = process.env.DEBUG === "1" || process.env.CAMERA_DEBUG === "1";
    const measurementsTarget = normalizeMeasurementCount(process.env.CAMERA_LATENCY_MEASUREMENTS || "12");
    const timeoutMs = envNumber("CAMERA_LATENCY_TIMEOUT_MS", 8000, 1000);
    const warmupAttempts = envNumber("CAMERA_LATENCY_WARMUP_ATTEMPTS", 6, 1);
    const outputPath = process.env.CAMERA_LATENCY_OUTPUT;
    const autoFocus = process.env.CAMERA_AUTO_FOCUS === "1";
    const cameraRate = envNumber(
        "CAMERA_LATENCY_CAMERA_RATE",
        Config.getAllConfig().camera.rate ?? 10,
        1
    );
    const cameraCommandTimeoutMs = envNumber("CAMERA_COMMAND_TIMEOUT_MS", 1500, 0);
    const focusIdleTimeoutMs = envNumber("CAMERA_FOCUS_IDLE_TIMEOUT_MS", 3000, 1000);
    const captureTimeoutMs = envNumber("CAMERA_CAPTURE_TIMEOUT_MS", 5000, 1000);
    const analysisOptions = {
        ...DEFAULT_ANALYSIS_OPTIONS,
        analysisSize: envNumber("CAMERA_LATENCY_ANALYSIS_SIZE", DEFAULT_ANALYSIS_OPTIONS.analysisSize, 16),
        minMeanIntensity: envNumber("CAMERA_LATENCY_MIN_INTENSITY", DEFAULT_ANALYSIS_OPTIONS.minMeanIntensity, 0),
        minDominanceRatio: envNumber("CAMERA_LATENCY_COLOR_RATIO", DEFAULT_ANALYSIS_OPTIONS.minDominanceRatio, 1),
        minChannelGap: envNumber("CAMERA_LATENCY_COLOR_GAP", DEFAULT_ANALYSIS_OPTIONS.minChannelGap, 0),
    };

    let stopRequested = false;
    const requestStop = (message) => {
        if (stopRequested) {
            return;
        }
        stopRequested = true;
        console.log(message);
    };

    process.on("SIGINT", () => requestStop("Stopping after the current capture..."));
    process.on("SIGTERM", () => requestStop("Stopping after the current capture..."));

    const hostWindow = new HostColorWindow();
    let deviceManager;
    let device;
    const samples = [];

    try {
        console.log("Opening fullscreen host color window...");
        const ready = await hostWindow.start();
        console.log(
            `Host color window ready on ${ready.width}x${ready.height}. Press Escape on that window or Ctrl+C here to stop.`
        );

        console.log("Connecting to device...");
        deviceManager = new DeviceManager();
        device = await deviceManager.connectToDevice();

        await waitForConnected(device);

        console.log(`Connected to device: ${device.name || device.id}`);
        if (!device.hasCamera) {
            throw new Error("Device does not have a camera");
        }

        await prepareCamera(device, cameraRate, debug);

        if (autoFocus) {
            await focusCamera(device, cameraRate, cameraCommandTimeoutMs, focusIdleTimeoutMs);
        }

        const initialPresentation = await hostWindow.setColor(START_COLOR);
        console.log(
            `Starting camera latency test: measurements=${measurementsTarget || "continuous"}, start=${START_COLOR}, timeout=${timeoutMs}ms, cameraRate=${cameraRate}`
        );
        console.log(
            `Host window presentation delay: ${formatMs(initialPresentation.presentationDelayMs)}`
        );

        const captureOptions = {
            cameraRate,
            cameraCommandTimeoutMs,
            captureTimeoutMs,
            debug,
        };

        await warmupUntilColor(device, START_COLOR, {
            warmupAttempts,
            captureOptions,
            analysisOptions,
        });

        let currentColor = START_COLOR;
        let index = 0;

        while (!stopRequested && (measurementsTarget === 0 || index < measurementsTarget)) {
            const targetColor = oppositeColor(currentColor);
            const sample = await measureTransition(device, targetColor, {
                hostWindow,
                timeoutMs,
                captureOptions,
                analysisOptions,
            });

            index += 1;
            currentColor = targetColor;

            const record = {
                index,
                fromColor: oppositeColor(targetColor),
                toColor: targetColor,
                latencyMs: sample.latencyMs,
                presentationDelayMs: sample.presentationDelayMs,
                attempts: sample.attempts,
                analysisMs: sample.analysisMs,
                frameReceivedAtUnixMs: sample.frameReceivedAtUnixMs,
                presentedAtUnixMs: sample.presentedAtUnixMs,
                cameraTimestamp: sample.cameraTimestamp,
                deviceReportedLatencyMs: sample.deviceReportedLatencyMs,
                frameBytes: sample.frameBytes,
                colorMeans: {
                    red: sample.detection.means.red,
                    green: sample.detection.means.green,
                    blue: sample.detection.means.blue,
                },
            };
            samples.push(record);

            console.log(
                `#${index} ${record.fromColor}->${record.toColor} lat=${formatMs(record.latencyMs)} (attempts=${record.attempts}, present=${formatMs(record.presentationDelayMs)}, analysis=${formatMs(record.analysisMs)}, received=${formatTimestamp(record.frameReceivedAtUnixMs)}, cameraTs=${record.cameraTimestamp ? formatTimestamp(record.cameraTimestamp) : "n/a"}, device=${record.deviceReportedLatencyMs != null ? formatMs(record.deviceReportedLatencyMs) : "n/a"})`
            );
        }

        const payload = {
            generatedAt: new Date().toISOString(),
            config: {
                measurementsTarget,
                timeoutMs,
                warmupAttempts,
                cameraRate,
                autoFocus,
                analysisOptions,
                pythonBin: hostWindow.pythonBin,
                configPath: process.env.BSOLE_CONFIG_PATH || null,
            },
            samples,
            summaries: {
                latencyMs: summarizeValues(samples, (sample) => sample.latencyMs),
                presentationDelayMs: summarizeValues(samples, (sample) => sample.presentationDelayMs),
                deviceReportedLatencyMs: summarizeValues(samples, (sample) => sample.deviceReportedLatencyMs),
                analysisMs: summarizeValues(samples, (sample) => sample.analysisMs),
            },
        };

        printSummary("E2E latency", payload.summaries.latencyMs);
        printSummary("Host window presentation delay", payload.summaries.presentationDelayMs);
        printSummary("Device-reported image latency", payload.summaries.deviceReportedLatencyMs);
        printSummary("Color-analysis time", payload.summaries.analysisMs);

        if (outputPath) {
            await writeResults(outputPath, payload);
        }
    } finally {
        try {
            await hostWindow.stop();
        } catch {}
        try {
            await deviceManager?.disconnect();
        } catch {}
    }
}

main().catch((error) => {
    console.error("Camera latency test failed:", error?.stack || error?.message || String(error));
    process.exit(1);
});
