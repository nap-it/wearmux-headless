// On-device TFLite inference runner
const fs = require("fs");
const path = require("path");
const { DeviceManager } = require("../../utils/device-manager");

async function main() {
    // --- Configuration from environment ---
    const modelPath = path.resolve(
        __dirname, "../..",
        process.env.TFLITE_MODEL || "sensors/model/model.tflite"
    );
    const modelName = process.env.TFLITE_NAME || path.basename(modelPath, ".tflite");
    const task = process.env.TFLITE_TASK || "classification";
    const sensorTypes = process.env.TFLITE_SENSORS
        ? process.env.TFLITE_SENSORS.split(",").map((s) => s.trim())
        : ["gyroscope", "linearAcceleration"];
    const sampleRate = Number(process.env.TFLITE_SAMPLE_RATE) || 50;
    const classes = process.env.TFLITE_CLASSES
        ? process.env.TFLITE_CLASSES.split(",").map((s) => s.trim())
        : undefined;
    const threshold = process.env.TFLITE_THRESHOLD !== undefined
        ? Number(process.env.TFLITE_THRESHOLD)
        : 0.7;
    const captureDelay = Number(process.env.TFLITE_CAPTURE_DELAY) || 0;

    // --- Load model file ---
    if (!fs.existsSync(modelPath)) {
        console.error(`❌ Model file not found: ${modelPath}`);
        console.error(`   Set TFLITE_MODEL in config/tflite.ini or as env var.`);
        process.exit(1);
    }
    const modelBuffer = fs.readFileSync(modelPath);
    console.log(`📦 Model: ${modelName} (${(modelBuffer.length / 1024).toFixed(1)} KB)`);
    console.log(`   Task: ${task} | Sensors: ${sensorTypes.join(", ")} | ${sampleRate} Hz`);
    if (classes) console.log(`   Classes: ${classes.join(", ")}`);
    if (threshold > 0) console.log(`   Threshold: ${threshold}`);
    console.log();

    // --- Connect device ---
    console.log("Connecting to device...");
    const device = await new DeviceManager().connectToDevice();
    console.log("✓ Connected!\n");

    if (!device.isTfliteAvailable) {
        console.error("❌ Device firmware does not support TFLite inference.");
        console.error("   Flash a firmware build with TFLite support and try again.");
        process.exit(1);
    }

    // --- Cursor helpers ---
    const clearLines = (n) => {
        if (n > 0) process.stdout.write(`\x1b[${n}A\x1b[0J`);
    };

    // --- File transfer progress ---
    let lastProgressLines = 0;
    device.addEventListener("fileTransferProgress", (event) => {
        const msg = event.message;
        const progress = msg?.fileTransferProgress?.progress ?? msg?.progress ?? 0;
        const filled = Math.round(progress * 20);
        const bar = "█".repeat(filled) + "░".repeat(20 - filled);
        clearLines(lastProgressLines);
        process.stdout.write(`📤 Uploading: [${bar}] ${Math.round(progress * 100)}%\n`);
        lastProgressLines = 1;
    });

    // --- Wait for device to signal ready ---
    const tfliteReady = new Promise((resolve, reject) => {
        let timeout;
        const handler = (event) => {
            if (event.message?.tfliteIsReady) {
                cleanup();
                resolve();
            }
        };
        const cleanup = () => {
            clearTimeout(timeout);
            device.removeEventListener("tfliteIsReady", handler);
        };
        timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for tfliteIsReady (30s)"));
        }, 30_000);
        device.addEventListener("tfliteIsReady", handler);
    });

    // --- Send configuration + model to device ---
    console.log("Sending TFLite configuration to device...");
    await device.sendTfliteConfiguration({
        name: modelName,
        task,
        sensorTypes,
        sampleRate,
        captureDelay,
        threshold,
        classes,
        file: modelBuffer,
    });

    await tfliteReady;
    clearLines(lastProgressLines);
    lastProgressLines = 0;
    console.log("✓ Model loaded on device!\n");

    // --- Enable inferencing ---
    await device.enableTfliteInferencing();
    console.log("✓ Inferencing enabled\n");
    console.log("Monitoring results... Press Ctrl+C to stop\n");

    // --- In-place inference result display ---
    let lastResultLines = 0;

    device.addEventListener("tfliteInference", (event) => {
        const inf = event.message?.tfliteInference;
        if (!inf) return;

        const lines = [];

        if (task === "classification" && inf.classValues) {
            lines.push(`🤖 Inference: ${inf.maxClass ?? "?"} (${((inf.maxValue ?? 0) * 100).toFixed(1)}%)`);
            const sorted = Object.entries(inf.classValues).sort(([, a], [, b]) => b - a);
            for (const [label, score] of sorted) {
                const filled = Math.round(score * 20);
                const bar = "█".repeat(filled) + "░".repeat(20 - filled);
                const marker = label === inf.maxClass ? " ◀" : "";
                lines.push(`  ${label.padEnd(16)} [${bar}] ${(score * 100).toFixed(1)}%${marker}`);
            }
        } else if (task === "classification") {
            // No class labels — show raw values with index
            lines.push(`🤖 Inference: index ${inf.maxIndex ?? "?"} (${((inf.maxValue ?? 0) * 100).toFixed(1)}%)`);
            inf.values.forEach((v, i) => {
                const filled = Math.round(v * 20);
                const bar = "█".repeat(filled) + "░".repeat(20 - filled);
                const marker = i === inf.maxIndex ? " ◀" : "";
                lines.push(`  [${i}]              [${bar}] ${(v * 100).toFixed(1)}%${marker}`);
            });
        } else {
            // Regression
            lines.push(`🔢 Regression: [${inf.values.map((v) => v.toFixed(4)).join(", ")}]`);
        }

        clearLines(lastResultLines);
        process.stdout.write(lines.join("\n") + "\n");
        lastResultLines = lines.length;
    });

    // --- Graceful shutdown ---
    process.on("SIGINT", async () => {
        console.log("\n🛑 Disabling inferencing...");
        try { await device.disableTfliteInferencing(); } catch (err) {
            console.warn("[tflite-runner] Failed to disable inferencing:", err?.message || err);
        }
        process.exit(0);
    });
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = main;
