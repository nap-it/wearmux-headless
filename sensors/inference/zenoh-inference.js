// Distributed inference: subscribe to sensor data from Zenoh, run ML, publish results back
//
// RPi side: run sensors/index.js with ZENOH_ENABLE=1  → publishes bsole/sensors/acceleration
// PC side:  run this script                           → subscribes, classifies, publishes bsole/inference/gesture
//
// Env vars:
//   ZENOH_SUB_EXPRESSION   Key expression to subscribe to (default: bsole/sensors/acceleration)
//   ZENOH_PUB_PREFIX       Prefix for inference result topics (default: bsole/inference)
//   ML_WINDOW_SIZE         Sliding window sample count (default: 30 = 1.5s at 20 Hz)
//   ML_CONFIDENCE          Minimum confidence to publish a result (default: 0.7)
//   DEBUG                  Set to 1 for verbose logging

const { ZenohSubscriber } = require("../../utils/zenoh-subscriber");
const { ZenohManager } = require("../../utils/zenoh-manager");
const MLGestureDetector = require("../lib/ml/ml-gesture-detector");

const SUB_EXPRESSION = process.env.ZENOH_SUB_EXPRESSION || "bsole/sensors/acceleration";
const PUB_PREFIX = process.env.ZENOH_PUB_PREFIX || "bsole/inference";
const WINDOW_SIZE = Number(process.env.ML_WINDOW_SIZE) || 30;
const CONFIDENCE_THRESHOLD = Number(process.env.ML_CONFIDENCE) || 0.7;
const DEBUG = process.env.DEBUG === "1";

const RESULT_TOPIC = `${PUB_PREFIX}/gesture`;

async function main() {
    // --- Init ML model ---
    console.log("Loading ML gesture detector...");
    const detector = new MLGestureDetector(WINDOW_SIZE);
    while (!detector.initialized && !detector.initError) {
        await new Promise((r) => setTimeout(r, 50));
    }
    if (detector.initError) {
        console.error("Failed to load ML model:", detector.initError.message);
        process.exit(1);
    }
    console.log("ML model ready");

    // --- Init Zenoh publisher ---
    const publisher = new ZenohManager({ keyPrefix: PUB_PREFIX });
    publisher.on("error", (e) => console.warn("[publisher]", e?.message || e));
    await publisher.start();
    console.log(`Publishing results to '${RESULT_TOPIC}'`);

    // --- Init Zenoh subscriber ---
    const subscriber = new ZenohSubscriber({ keyExpression: SUB_EXPRESSION });
    subscriber.on("error", (e) => console.warn("[subscriber]", e?.message || e));

    let sampleCount = 0;
    let lastResultLines = 0;

    subscriber.on("message", ({ key, payload }) => {
        // Payload shape from ZenohManager.attachToSensorManager:
        //   { ts, sensor, device, message: { acceleration: { x, y, z } } }
        const acc = payload?.message?.acceleration;
        if (!acc) return;

        sampleCount++;
        if (DEBUG) {
            console.log(`[sample #${sampleCount}] acc x=${acc.x?.toFixed(3)} y=${acc.y?.toFixed(3)} z=${acc.z?.toFixed(3)}`);
        }

        detector.addSample({ accX: acc.x, accY: acc.y, accZ: acc.z });
    });

    // --- Handle inference results ---
    detector.on("ml-gesture", async (result) => {
        if (!result?.results?.length) return;

        const top = result.results.reduce((a, b) => (a.value > b.value ? a : b));

        if (DEBUG) {
            const bar = result.results
                .sort((a, b) => b.value - a.value)
                .map((r) => `  ${r.label.padEnd(12)} ${(r.value * 100).toFixed(1)}%`)
                .join("\n");
            console.log(`\n[inference]\n${bar}`);
        } else {
            // In-place display
            if (lastResultLines > 0) {
                process.stdout.write(`\x1b[${lastResultLines}A\x1b[0J`);
            }
            const line = `Gesture: ${top.label} (${(top.value * 100).toFixed(1)}%)`;
            process.stdout.write(line + "\n");
            lastResultLines = 1;
        }

        if (top.value < CONFIDENCE_THRESHOLD) return;

        const inferencePayload = {
            ts: Date.now(),
            gesture: top.label,
            confidence: top.value,
            results: result.results,
        };

        try {
            await publisher.publish(RESULT_TOPIC, inferencePayload);
            if (DEBUG) console.log(`Published '${top.label}' to ${RESULT_TOPIC}`);
        } catch (e) {
            console.warn("[publish error]", e?.message || e);
        }
    });

    await subscriber.start();
    console.log(`Subscribed to '${SUB_EXPRESSION}'`);
    console.log(`Confidence threshold: ${CONFIDENCE_THRESHOLD}`);
    console.log("Waiting for sensor data... Press Ctrl+C to stop\n");

    // --- Graceful shutdown ---
    const shutdown = async () => {
        console.log("\nShutting down...");
        try { await subscriber.stop(); } catch { }
        try { await publisher.stop(); } catch { }
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
});
