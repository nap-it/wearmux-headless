// Distributed inference: subscribe to sensor data, run ML, publish results back.
// Transport is auto-selected by env (MQTT_ENABLE=1 or ZENOH_ENABLE=1).
//
// RPi side: run sensors/index.js with a transport enabled → publishes bsole/sensors/acceleration
// PC side:  run this script                               → subscribes, classifies, publishes bsole/inference/gesture
//
// Env vars:
//   MQTT_ENABLE / ZENOH_ENABLE   Select transport (MQTT wins if both set)
//   ZENOH_SUB_EXPRESSION         Key expression to subscribe to (default: bsole/sensors/acceleration)
//   ZENOH_PUB_PREFIX             Prefix for inference result topics (default: bsole/inference)
//   ML_WINDOW_SIZE               Sliding window sample count (default: 30 = 1.5s at 20 Hz)
//   ML_CONFIDENCE                Minimum confidence to publish a result (default: 0.7)
//   DEBUG                        Set to 1 for verbose logging

const { createPublisher, createSubscriber, selectedTransport } = require("../../utils/transport");
const MLGestureDetector = require("../lib/ml/ml-gesture-detector");

// Extract acceleration from a Zenoh sensor message payload.
// Returns null if the payload doesn't carry acceleration data.
function extractAcceleration(payload) {
    const acc = payload?.message?.acceleration;
    if (!acc || typeof acc.x !== "number" || typeof acc.y !== "number" || typeof acc.z !== "number") {
        return null;
    }
    return acc;
}

// Pick the highest-scoring label from inference results.
// Returns null on empty/missing results.
function topResult(results) {
    if (!results?.length) return null;
    return results.reduce((a, b) => (a.value > b.value ? a : b));
}

// Build the payload published to bsole/inference/gesture.
function buildInferencePayload(top, results) {
    return {
        ts: Date.now(),
        gesture: top.label,
        confidence: top.value,
        results,
    };
}

class RemoteInferencePipeline {
    constructor(options = {}) {
        this.pubPrefix = options.pubPrefix || "bsole/inference";
        this.subExpression = options.subExpression || "bsole/sensors/acceleration";
        this.windowSize = options.windowSize || 30;
        this.confidenceThreshold = options.confidenceThreshold || 0.7;
        this.debug = options.debug || false;

        this.resultTopic = `${this.pubPrefix}/gesture`;
        this.sampleCount = 0;
        this._lastResultLines = 0;

        this.transport = options.transport || selectedTransport();
        if (this.transport === "none") {
            // Default to zenoh if no env var is set, so the legacy command still works
            this.transport = "zenoh";
        }

        this.detector = options.detector || new MLGestureDetector(this.windowSize);
        this.publisher = options.publisher || createPublisher({
            transport: this.transport,
            keyPrefix: this.pubPrefix,
        });
        this.subscriber = options.subscriber || createSubscriber({
            transport: this.transport,
            keyExpression: this.subExpression,
        });
    }

    // Handle one Zenoh message. Extracts acc and feeds detector.
    handleMessage({ payload }) {
        const acc = extractAcceleration(payload);
        if (!acc) return;

        this.sampleCount++;
        if (this.debug) {
            console.log(`[sample #${this.sampleCount}] acc x=${acc.x.toFixed(3)} y=${acc.y.toFixed(3)} z=${acc.z.toFixed(3)}`);
        }

        this.detector.addSample({ accX: acc.x, accY: acc.y, accZ: acc.z });
    }

    // Handle one ML inference result. Publishes if above threshold.
    async handleInferenceResult(result) {
        const top = topResult(result?.results);
        if (!top) return;

        if (!this.debug) {
            if (this._lastResultLines > 0) {
                process.stdout.write(`\x1b[${this._lastResultLines}A\x1b[0J`);
            }
            process.stdout.write(`Gesture: ${top.label} (${(top.value * 100).toFixed(1)}%)\n`);
            this._lastResultLines = 1;
        } else {
            const bar = [...result.results]
                .sort((a, b) => b.value - a.value)
                .map((r) => `  ${r.label.padEnd(12)} ${(r.value * 100).toFixed(1)}%`)
                .join("\n");
            console.log(`\n[inference]\n${bar}`);
        }

        if (top.value < this.confidenceThreshold) return;

        const inferencePayload = buildInferencePayload(top, result.results);
        try {
            await this.publisher.publish(this.resultTopic, inferencePayload);
            if (this.debug) console.log(`Published '${top.label}' to ${this.resultTopic}`);
        } catch (e) {
            console.warn("[publish error]", e?.message || e);
        }
    }

    async start() {
        console.log("Loading ML gesture detector...");
        try {
            await this.detector.ready();
        } catch (e) {
            throw new Error(`Failed to load ML model: ${e.message}`);
        }
        console.log(`ML model ready (transport: ${this.transport})`);

        this.publisher.on("error", (e) => console.warn("[publisher]", e?.message || e));
        await this.publisher.start();
        console.log(`Publishing results to '${this.resultTopic}'`);

        this.subscriber.on("error", (e) => console.warn("[subscriber]", e?.message || e));
        this.subscriber.on("message", (msg) => this.handleMessage(msg));
        this.detector.on("ml-gesture", (result) => this.handleInferenceResult(result));

        await this.subscriber.start();
        console.log(`Subscribed to '${this.subExpression}'`);
        console.log(`Confidence threshold: ${this.confidenceThreshold}`);
        console.log("Waiting for sensor data... Press Ctrl+C to stop\n");
    }

    async stop() {
        try { await this.subscriber.stop(); } catch { }
        try { await this.publisher.stop(); } catch { }
    }
}

async function main() {
    const pipeline = new RemoteInferencePipeline({
        pubPrefix: process.env.ZENOH_PUB_PREFIX || "bsole/inference",
        subExpression: process.env.ZENOH_SUB_EXPRESSION || "bsole/sensors/acceleration",
        windowSize: Number(process.env.ML_WINDOW_SIZE) || 30,
        confidenceThreshold: Number(process.env.ML_CONFIDENCE) || 0.7,
        debug: process.env.DEBUG === "1",
    });

    const shutdown = async () => {
        console.log("\nShutting down...");
        await pipeline.stop();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await pipeline.start();
}

if (require.main === module) {
    main().catch((err) => {
        console.error("Fatal:", err.message);
        process.exit(1);
    });
}

module.exports = { RemoteInferencePipeline, extractAcceleration, topResult, buildInferencePayload };
