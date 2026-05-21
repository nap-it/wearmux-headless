const fs = require("fs");
const path = require("path");
const { Config } = require("../utils/config");
const { DeviceManager } = require("../utils/device-manager");
const { createPublisher, selectedTransport } = require("../utils/transport");
const { isValidJpeg, hasValidJpegStructure, formatToMime } = require("./lib/image-validator");
const { ViewerServer } = require("./lib/viewer-server");

async function ensureDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDevice() {
    const deviceManager = new DeviceManager();
    const device = await deviceManager.connectToDevice();
    return device;
}

async function main() {
    const config = Config.getAllConfig();
    const outDir = config.camera.outputDir;
    const auto = config.camera.autoPicture;
    const imgFmt = config.camera.imageFormat;
    const quality = config.camera.quality;
    const resolution = config.camera.resolution;
    const qualityFactor = config.camera.qualityFactor ?? quality;
    const shutter = config.camera.shutter;
    const gain = config.camera.gain;
    const redGain = config.camera.redGain;
    const greenGain = config.camera.greenGain;
    const blueGain = config.camera.blueGain;
    const autoWhiteBalanceEnabled = config.camera.autoWhiteBalanceEnabled;
    const autoGainEnabled = config.camera.autoGainEnabled;
    const exposure = config.camera.exposure;
    const autoExposureEnabled = config.camera.autoExposureEnabled;
    const autoExposureLevel = config.camera.autoExposureLevel;
    const brightness = config.camera.brightness;
    const saturation = config.camera.saturation;
    const contrast = config.camera.contrast;
    const sharpness = config.camera.sharpness;
    const cameraRate = config.camera.rate;
    const debug = process.env.DEBUG === "1" || process.env.CAMERA_DEBUG === "1";
    const autoCaptureDelay = parseInt(process.env.CAMERA_AUTO_DELAY || "0", 10);
    const autoFocus = process.env.CAMERA_AUTO_FOCUS !== "0"; // Enabled by default
    const cameraCommandTimeoutMs = Math.max(0, parseInt(process.env.CAMERA_COMMAND_TIMEOUT_MS || "1500", 10));
    const focusIdleTimeoutMs = Math.max(cameraCommandTimeoutMs, parseInt(process.env.CAMERA_FOCUS_IDLE_TIMEOUT_MS || "3000", 10));
    const captureTimeoutMs = Math.max(1000, parseInt(process.env.CAMERA_CAPTURE_TIMEOUT_MS || "5000", 10));

    function debugLog(...args) {
        if (debug) console.log(...args);
    }

    function debugWarn(...args) {
        if (debug) console.warn(...args);
    }

    if (outDir) await ensureDir(outDir);

    const viewEnable = config.camera.viewEnable;
    const viewPort = config.camera.viewPort || 8099;
    const viewHost = config.camera.viewHost || "0.0.0.0";
    const viewMjpeg = config.camera.viewMjpeg;
    let latestImage = null;
    let viewerServer = null;
    const publisherEnabled = selectedTransport() !== "none" && process.env.ZENOH_CAMERA_ENABLE !== "0";
    const zenoh = publisherEnabled
        ? createPublisher({
            keyPrefix: process.env.ZENOH_CAMERA_KEY_PREFIX || "bsole/camera",
            udsPath: process.env.ZENOH_CAMERA_UDS_PATH || `/tmp/bsole-zenoh-camera-${process.pid}.sock`,
        })
        : null;
    const zenohRawEnabled = Boolean(zenoh) && process.env.ZENOH_CAMERA_RAW_ENABLE === "1";
    const zenohRawChunkSize = Math.max(1024, Number(process.env.ZENOH_RAW_CHUNK_SIZE || 30000));

    async function publishRawImage(buffer, meta) {
        if (!zenohRawEnabled) return;
        const frameId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const b64 = buffer.toString("base64");
        const totalChunks = Math.ceil(b64.length / zenohRawChunkSize);
        await zenoh.publish(`${zenoh.keyPrefix}/raw/meta`, {
            ts: Date.now(),
            frameId,
            totalChunks,
            encoding: "base64",
            mime: meta?.mime || null,
            bytes: meta?.bytes || buffer.length,
            device: meta?.device || null,
            cameraTimestamp: meta?.cameraTimestamp || null,
            latencyMs: meta?.latencyMs || null,
        });
        for (let i = 0; i < totalChunks; i += 1) {
            const part = b64.slice(i * zenohRawChunkSize, (i + 1) * zenohRawChunkSize);
            await zenoh.publish(`${zenoh.keyPrefix}/raw/chunk`, {
                ts: Date.now(),
                frameId,
                idx: i,
                data: part,
            });
        }
    }

    try {
        if (zenoh) {
            zenoh.on("error", (e) => {
                debugWarn("[Camera][Zenoh]", e?.message || e);
            });
            await zenoh.start();
        }

        const device = await getDevice();
        console.log(`Connected to device: ${device.name || device.id}`);

        const waitForDeviceEvent = (eventType, timeoutMs, predicate = () => true) => new Promise((resolve) => {
            let timeout;
            const handler = (event) => {
                let matches = false;
                try {
                    matches = predicate(event);
                } catch (error) {
                    debugWarn(`[Camera] ${eventType} predicate failed:`, error?.message || error);
                }

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

        const invokeCameraCommand = async (label, invoke) => {
            const settledPromise = Promise.resolve()
                .then(() => invoke())
                .then(
                    () => ({ status: "resolved" }),
                    (error) => ({ status: "rejected", error })
                );

            const result = cameraCommandTimeoutMs > 0
                ? await Promise.race([
                    settledPromise,
                    sleep(cameraCommandTimeoutMs).then(() => ({ status: "timeout" })),
                ])
                : await settledPromise;

            if (result.status === "rejected") {
                throw result.error;
            }

            if (result.status === "timeout") {
                console.warn(`[WARN] ${label} did not report a camera status change within ${cameraCommandTimeoutMs}ms. Continuing and waiting for camera data.`);
                settledPromise.then((lateResult) => {
                    if (lateResult.status === "rejected") {
                        console.error(`[ERROR] ${label} failed after timeout:`, lateResult.error);
                    }
                });
            }
        };

        const focusCameraForCapture = async () => {
            const focusIdlePromise = waitForDeviceEvent(
                "cameraStatus",
                focusIdleTimeoutMs,
                (event) =>
                    event?.message?.cameraStatus === "idle" &&
                    event?.message?.previousCameraStatus === "focusing"
            );

            console.log("Focusing camera...");
            await invokeCameraCommand("Focus command", () => device.focusCamera(cameraRate));

            const focusIdle = await focusIdlePromise;

            if (focusIdle.timedOut) {
                debugWarn(`[Camera] focus did not return to idle within ${focusIdleTimeoutMs}ms; continuing with capture`);
            }
        };

        const triggerPicture = async () => {
            if (device.connectionStatus !== "connected") {
                console.warn("[Camera] Skipping takePicture — device not connected");
                return;
            }
            await invokeCameraCommand("Take picture command", () => device.takePicture(cameraRate));
        };

        if (!device.hasCamera) {
            throw new Error("Device does not have a camera");
        }
        console.log("[OK] Device has camera");

        if (device.connectionStatus !== 'connected') {
            await device.waitForEvent("connected");
        }

        console.log("Configuring camera...");

        if (debug) {
            device.addEventListener("cameraImageProgress", (event) => {
                debugLog("[PROGRESS]", event.message.type, `${Math.round((event.message.progress || 0) * 100)}%`);
            });
        }

        const availableCameraConfigTypes = new Set(
            device.availableCameraConfigurationTypes || []
        );

        const requestedCameraConfig = {
            resolution,
            qualityFactor,
            shutter,
            gain,
            redGain,
            greenGain,
            blueGain,
            autoWhiteBalanceEnabled,
            autoGainEnabled,
            exposure,
            autoExposureEnabled,
            autoExposureLevel,
            brightness,
            saturation,
            contrast,
            sharpness,
        };

        const cameraConfig = {};
        for (const [key, value] of Object.entries(requestedCameraConfig)) {
            if (value === undefined) continue;
            if (availableCameraConfigTypes.size > 0 && !availableCameraConfigTypes.has(key)) {
                debugWarn(`[Camera] Skipping unsupported camera setting "${key}"`);
                continue;
            }
            cameraConfig[key] = value;
        }

        if (availableCameraConfigTypes.size > 0) {
            debugLog("[Camera] Available camera settings:", [...availableCameraConfigTypes].join(", "));
        }
        debugLog("[Camera] Current device camera config:", device.cameraConfiguration);

        if (Object.keys(cameraConfig).length > 0) {
            console.log("Applying camera config:", cameraConfig);
            await device.setCameraConfiguration(cameraConfig);
        } else {
            console.log("Using device camera defaults");
        }

        debugLog("[Camera] Updated device camera config:", device.cameraConfiguration);

        console.log("Camera status:", device.cameraStatus);
        if (device.cameraStatus === 'asleep') {
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

        let isAutoActive = false;
        let counter = 0;
        let savedCount = 0;
        let isProcessingImage = false;
        let lastSavedTimestamp = null;
        let firstImageResolve;
        const firstImagePromise = new Promise((resolve) => (firstImageResolve = resolve));
        
        let pendingImages = [];
        let imageCollectionTimeout = null;

        let isSavingBestImage = false;
        const saveBestImage = async () => {
            if (isSavingBestImage || pendingImages.length === 0 || savedCount >= 1) {
                return;
            }
            
            isSavingBestImage = true;
            
            if (imageCollectionTimeout) {
                clearTimeout(imageCollectionTimeout);
                imageCollectionTimeout = null;
            }
            
            pendingImages.sort((a, b) => b.size - a.size);
            const bestImage = pendingImages[0];
            
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const fname = `bsole-${ts}-${(counter++).toString().padStart(4, "0")}.${imgFmt}`;
            
            if (outDir) {
                const file = path.join(outDir, fname);
                await fs.promises.writeFile(file, bestImage.buffer);
                console.log("[SAVED]", file, bestImage.buffer.length, "bytes");
            }

            if (zenoh) {
                try {
                    const meta = {
                        ts: Date.now(),
                        device: { id: device.bluetoothId || device.id, name: device.name },
                        bytes: bestImage.buffer.length,
                        mime: formatToMime(imgFmt),
                        cameraTimestamp: bestImage.timestamp || null,
                        latencyMs: bestImage.latency || null,
                        saved: Boolean(outDir),
                    };
                    await Promise.all([
                        zenoh.publish(`${zenoh.keyPrefix}/image`, meta),
                        publishRawImage(bestImage.buffer, meta),
                    ]);
                } catch (e) {
                    debugWarn("[Camera][Zenoh] publish failed:", e?.message || e);
                }
            }
            
            latestImage = { buffer: bestImage.buffer, mime: formatToMime(imgFmt) };
            if (viewerServer) {
                viewerServer.updateImage(bestImage.buffer, formatToMime(imgFmt));
            }
            
            savedCount += 1;
            lastSavedTimestamp = bestImage.timestamp || null;
            pendingImages = [];
            isSavingBestImage = false;
            
            device.removeEventListener('cameraImage', imageHandler);
            
            try { firstImageResolve(); } catch {}
        };

        const imageHandler = async (event) => {
            try {
                const cameraImage = event.message;
                if (!cameraImage) {
                    console.error("Invalid camera image event:", event);
                    return;
                }

                if (!auto && savedCount >= 1) {
                    debugLog("[SKIP] Skipping extra image (non-auto mode, already saved one)");
                    return;
                }
                
                if (!auto && imageCollectionTimeout) {
                    clearTimeout(imageCollectionTimeout);
                }
                
                isProcessingImage = true;
                
                let buffer;
                if (cameraImage.url) {
                    if (cameraImage.blob) {
                        buffer = Buffer.from(await cameraImage.blob.arrayBuffer());
                    } else if (cameraImage.arrayBuffer) {
                        buffer = Buffer.from(cameraImage.arrayBuffer);
                    } else {
                        console.error("[ERROR] No blob or arrayBuffer in camera image event");
                        isProcessingImage = false;
                        return;
                    }
                } else if (cameraImage.blob) {
                    buffer = Buffer.from(await cameraImage.blob.arrayBuffer());
                } else if (cameraImage.arrayBuffer) {
                    buffer = Buffer.from(cameraImage.arrayBuffer);
                } else {
                    console.error("[ERROR] Neither URL, blob, nor arrayBuffer in camera image event");
                    isProcessingImage = false;
                    return;
                }

                if (!buffer || buffer.length === 0) {
                    debugLog("[SKIP] Empty image buffer");
                    isProcessingImage = false;
                    return;
                }

                if (buffer.length < 100) {
                    debugLog(`[SKIP] Suspiciously small image (${buffer.length} bytes)`);
                    isProcessingImage = false;
                    return;
                }

                if (!isValidJpeg(buffer)) {
                    debugLog(`[SKIP] Invalid JPEG format`);
                    isProcessingImage = false;
                    return;
                }

                if (!hasValidJpegStructure(buffer)) {
                    debugLog(`[SKIP] JPEG with invalid structure`);
                    isProcessingImage = false;
                    return;
                }
                
                // Device sends two images per takePicture() - collect and save the largest
                if (!auto) {
                    if (savedCount >= 1) {
                        debugLog("[SKIP] Skipping image (already saved in non-auto mode)");
                        isProcessingImage = false;
                        return;
                    }
                    
                    pendingImages.push({
                        buffer,
                        size: buffer.length,
                        timestamp: cameraImage.timestamp,
                        latency: cameraImage.latency
                    });
                    
                    if (imageCollectionTimeout) {
                        clearTimeout(imageCollectionTimeout);
                        imageCollectionTimeout = null;
                    }
                    
                    imageCollectionTimeout = setTimeout(async () => {
                        await saveBestImage();
                        isProcessingImage = false;
                    }, 300);
                    
                    isProcessingImage = false;
                } else {
                    const minBytes = parseInt(process.env.CAMERA_MIN_IMAGE_BYTES || "0", 10);
                    if (minBytes > 0 && buffer.length < minBytes) {
                        debugLog(`[SKIP] Image too small (${buffer.length} < ${minBytes} bytes)`);
                        isProcessingImage = false;
                        return;
                    }

                    const ts = new Date().toISOString().replace(/[:.]/g, "-");
                    const fname = `bsole-${ts}-${(counter++).toString().padStart(4, "0")}.${imgFmt}`;
                    
                    if (outDir) {
                        const file = path.join(outDir, fname);
                        await fs.promises.writeFile(file, buffer);
                        console.log("[SAVED]", file, buffer.length, "bytes");
                    }
                    
                    latestImage = { buffer, mime: formatToMime(imgFmt) };
                    if (viewerServer) {
                        viewerServer.updateImage(buffer, formatToMime(imgFmt));
                    }

                    if (zenoh) {
                        try {
                            const meta = {
                                ts: Date.now(),
                                device: { id: device.bluetoothId || device.id, name: device.name },
                                bytes: buffer.length,
                                mime: formatToMime(imgFmt),
                                cameraTimestamp: cameraImage.timestamp || null,
                                latencyMs: cameraImage.latency || null,
                                saved: Boolean(outDir),
                            };
                            await Promise.all([
                                zenoh.publish(`${zenoh.keyPrefix}/image`, meta),
                                publishRawImage(buffer, meta),
                            ]);
                        } catch (e) {
                            debugWarn("[Camera][Zenoh] publish failed:", e?.message || e);
                        }
                    }
                    
                    savedCount += 1;
                    lastSavedTimestamp = cameraImage.timestamp || null;
                    isProcessingImage = false;
                    
                    // SDK's autoPicture mechanism doesn't trigger in Node.js environment
                    // Manually trigger next picture.
                    if (isAutoActive) {
                        const triggerNext = async () => {
                            try {
                                if (autoCaptureDelay > 0) {
                                    await sleep(autoCaptureDelay);
                                }
                                if (autoFocus) {
                                    await focusCameraForCapture();
                                }
                                await triggerPicture();
                            } catch (e) {
                                console.error("[ERROR] Failed to take next picture:", e);
                            }
                        };
                        setImmediate(triggerNext);
                    }
                }
            } catch (e) {
                console.error("[ERROR] Failed to save image:", e);
                isProcessingImage = false;
            }
        };

        device.addEventListener('cameraImage', imageHandler);
        
        device.addEventListener('cameraStatus', (event) => {
            if (debug) console.log("[STATUS] Camera:", event.message.cameraStatus);
        });

        let _cameraWasConnected = true;
        device.addEventListener('isConnected', async (event) => {
            const connected = Boolean(event.message?.isConnected);
            if (connected && _cameraWasConnected === false) {
                console.log("[Camera] Reconnected — resuming auto-capture...");
                isAutoActive = false;
                try {
                    await sleep(2000);
                    if (auto) {
                        isAutoActive = true;
                        await triggerPicture();
                    }
                } catch (e) {
                    console.error("[Camera] Resume after reconnect failed:", e);
                }
            }
            _cameraWasConnected = connected;
        });

        console.log(`Camera ready. Auto=${auto}. ${outDir ? `Output -> ${outDir}` : 'No file output (set CAMERA_OUTPUT_DIR to save images)'}`);

        if (viewEnable) {
            viewerServer = new ViewerServer({ mjpeg: viewMjpeg });
            viewerServer.start(viewHost, viewPort, () => latestImage);
            console.log(`Viewer at ${viewerServer.url}`);
        }

        if (!auto) {
            console.log("Taking picture...");
            if (autoFocus) {
                await focusCameraForCapture();
            }
            await triggerPicture();
            
            const receivedFirstImage = await Promise.race([
                firstImagePromise.then(() => true),
                sleep(captureTimeoutMs).then(() => false),
            ]);

            if (!receivedFirstImage) {
                console.warn(`[WARN] Timed out waiting for a camera image after ${captureTimeoutMs}ms`);
            }
            
            setTimeout(async () => {
                await device.disconnect();
                if (viewerServer) try { viewerServer.stop(); } catch {}
                process.exit(0);
            }, 500);
        } else {
            console.log("Starting auto-capture mode (Ctrl+C to stop)...");
            isAutoActive = true;
            
            // Show auto-capture configuration
            const config_info = [];
            if (autoFocus) config_info.push("focus enabled");
            if (autoCaptureDelay > 0) config_info.push(`${autoCaptureDelay}ms delay`);
            if (config_info.length > 0) {
                console.log(`[CONFIG] Auto-capture: ${config_info.join(", ")}`);
            }
            
            // Trigger the first picture to start the auto-capture loop
            console.log("Taking first picture...");
            if (autoFocus) {
                await focusCameraForCapture();
            }
            await triggerPicture();

            const shutdown = async () => {
                console.log("\nShutting down camera...");
                setTimeout(() => process.exit(0), 3000).unref();
                isAutoActive = false;
                if (zenoh) {
                    try { await zenoh.stop(); } catch (e) { console.warn("[Camera] zenoh.stop failed:", e?.message || e); }
                }
                try { await device.disconnect(); } catch (e) { console.warn("[Camera] disconnect failed:", e?.message || e); }
                if (viewerServer) try { viewerServer.stop(); } catch (e) { console.warn("[Camera] viewerServer.stop failed:", e?.message || e); }
                process.exit(0);
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
        }
    } catch (err) {
        console.error("Failed to start camera capture:", err);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = main;
