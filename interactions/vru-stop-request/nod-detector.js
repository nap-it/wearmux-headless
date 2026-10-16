const { captureTime } = require("../../utils/latency-events");
const EdgeImpulseClassifier = require("../../sensors/lib/ml/ei-classifier");

// The SDK takes a sampling interval in milliseconds, not a frequency in Hz.
// Match the glasses-gestures example's 600 ms acceleration window.
const GESTURE_SENSOR = Object.freeze({ type: "acceleration", intervalMs: 20 });
const GESTURE_WINDOW_MS = 600;
const GESTURES = Object.freeze({ "1_nod": "nod", "2_shake": "shake" });

function modelWindowSize(classifier) {
    const properties = classifier.getProperties();
    const windowSize = GESTURE_WINDOW_MS / GESTURE_SENSOR.intervalMs;
    const windowFeatures = windowSize * 3;
    if (properties.interval_ms !== GESTURE_SENSOR.intervalMs ||
        !Number.isInteger(properties.input_features_count) ||
        properties.input_features_count < windowFeatures || properties.input_features_count % 3 !== 0) {
        throw new Error("The gesture model must accept acceleration x/y/z at 20 ms intervals");
    }
    return windowSize;
}

class NodDetector {
    static async loadClassifier() {
        const classifier = new EdgeImpulseClassifier();
        await classifier.init();
        modelWindowSize(classifier);
        return classifier;
    }

    constructor(sensorManager, { classifier, confidence = process.env.VRU_GESTURE_CONFIDENCE } = {}) {
        this.sensorManager = sensorManager;
        this.classifier = classifier;
        this.windowSize = modelWindowSize(classifier);
        this.modelInputFeatures = classifier.getProperties().input_features_count;
        const threshold = Number(confidence);
        this.confidence = Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : 0.6;
        this.samples = [];
        this.sampleTimes = [];
        this.lastTimestamp = null;
        this.active = false;
        this.onAcceleration = (event) => this._handleAcceleration(event);
    }

    start(callback, onError, onTiming) {
        if (!this.sensorManager?.getEnabledSensors().includes(GESTURE_SENSOR.type)) {
            throw new Error("Acceleration sensing is required for the BrilliantWear gesture model");
        }
        this.stop();
        this.callback = callback;
        this.onError = onError;
        this.onTiming = onTiming;
        this.active = true;
        this.sensorManager.on(GESTURE_SENSOR.type, this.onAcceleration);
    }

    stop() {
        if (this.active) this.sensorManager.off(GESTURE_SENSOR.type, this.onAcceleration);
        this.active = false;
        this.callback = null;
        this.onError = null;
        this.onTiming = null;
        this.samples = [];
        this.sampleTimes = [];
        this.lastTimestamp = null;
    }

    _handleAcceleration(event) {
        if (!this.active) return;
        const arrival = captureTime();
        const { acceleration, timestamp } = event?.message || {};
        const values = [acceleration?.x, acceleration?.y, acceleration?.z];
        if (!values.every(Number.isFinite)) {
            this.samples = [];
            this.sampleTimes = [];
            this.lastTimestamp = null;
            return;
        }
        const sampleTime = Number.isFinite(timestamp) ? timestamp : Date.now();
        if (this.lastTimestamp !== null) {
            const gap = sampleTime - this.lastTimestamp;
            if (gap === 0) return; // Duplicate packet, not another sample.
            // Never join movement from before a disconnect or a stalled stream.
            if (gap < 0 || gap > GESTURE_SENSOR.intervalMs * 3) {
                this.samples = [];
                this.sampleTimes = [];
            }
        }
        this.lastTimestamp = sampleTime;
        // Preserve the SDK example's exact feature order and normalization.
        this.samples.push(values.map((value) => value / 4));
        this.sampleTimes.push({ ...arrival, sensor_timestamp_ms: sampleTime });
        if (this.samples.length > this.windowSize) { this.samples.shift(); this.sampleTimes.shift(); }
        if (this.samples.length < this.windowSize) return;

        const timing = {
            window_first_sample_mono_ns: this.sampleTimes[0].mono_time_ns,
            window_last_sample_mono_ns: arrival.mono_time_ns,
            window_first_sensor_timestamp_ms: this.sampleTimes[0].sensor_timestamp_ms,
            window_last_sensor_timestamp_ms: sampleTime,
            window_samples: this.samples.length, window_features: this.samples.length * 3,
            nominal_window_ms: GESTURE_WINDOW_MS, sample_interval_ms: GESTURE_SENSOR.intervalMs,
            model_input_features: this.modelInputFeatures,
            confidence_threshold: this.confidence,
        };
        let top;
        try {
            // The upstream glasses-gestures example sends this 90-feature window
            // even though the bundled model metadata reports 150 input features.
            timing.classifier_started_mono_ns = process.hrtime.bigint().toString();
            const result = this.classifier.classify(this.samples.flat(), false, {
                shortWindowFeatures: this.windowSize * 3,
            });
            timing.classifier_finished_mono_ns = process.hrtime.bigint().toString();
            top = result.results?.reduce((best, entry) =>
                Number.isFinite(entry.value) && (!best || entry.value > best.value) ? entry : best, null);
        } catch (error) {
            timing.classifier_finished_mono_ns = process.hrtime.bigint().toString();
            try { this.onTiming?.("gesture_inference_failed", { ...timing,
                error: String(error?.message || error).slice(0, 512) }); } catch {}
            const onError = this.onError;
            this.stop();
            if (onError) onError(error);
            else console.warn("[VRU interaction] gesture inference failed:", error?.message || error);
            return;
        }
        const gesture = GESTURES[top?.label];
        // Only accepted windows are logged by default; detailed mode may generate
        // 50 records/s while awaiting a gesture and must be declared in the study.
        if (process.env.HITL_EVAL_DETAIL === "1") {
            try { this.onTiming?.("gesture_window_evaluated", { ...timing,
                label: top?.label, confidence: top?.value,
                accepted: Boolean(gesture && top.value > this.confidence) }); } catch {}
        }
        if (!gesture || top.value <= this.confidence) return;

        const callback = this.callback;
        this.stop();
        callback?.(gesture, {
            ...timing,
            model: "brilliantwear-edge-impulse",
            label: top.label,
            confidence: top.value,
        });
    }
}

module.exports = { NodDetector, GESTURE_SENSOR, GESTURE_WINDOW_MS };
