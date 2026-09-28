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
        const threshold = Number(confidence);
        this.confidence = Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : 0.6;
        this.samples = [];
        this.lastTimestamp = null;
        this.active = false;
        this.onAcceleration = (event) => this._handleAcceleration(event);
    }

    start(callback, onError) {
        if (!this.sensorManager?.getEnabledSensors().includes(GESTURE_SENSOR.type)) {
            throw new Error("Acceleration sensing is required for the BrilliantWear gesture model");
        }
        this.stop();
        this.callback = callback;
        this.onError = onError;
        this.active = true;
        this.sensorManager.on(GESTURE_SENSOR.type, this.onAcceleration);
    }

    stop() {
        if (this.active) this.sensorManager.off(GESTURE_SENSOR.type, this.onAcceleration);
        this.active = false;
        this.callback = null;
        this.onError = null;
        this.samples = [];
        this.lastTimestamp = null;
    }

    _handleAcceleration(event) {
        if (!this.active) return;
        const { acceleration, timestamp } = event?.message || {};
        const values = [acceleration?.x, acceleration?.y, acceleration?.z];
        if (!values.every(Number.isFinite)) {
            this.samples = [];
            this.lastTimestamp = null;
            return;
        }
        const sampleTime = Number.isFinite(timestamp) ? timestamp : Date.now();
        if (this.lastTimestamp !== null) {
            const gap = sampleTime - this.lastTimestamp;
            if (gap === 0) return; // Duplicate packet, not another sample.
            // Never join movement from before a disconnect or a stalled stream.
            if (gap < 0 || gap > GESTURE_SENSOR.intervalMs * 3) this.samples = [];
        }
        this.lastTimestamp = sampleTime;
        // Preserve the SDK example's exact feature order and normalization.
        this.samples.push(values.map((value) => value / 4));
        if (this.samples.length > this.windowSize) this.samples.shift();
        if (this.samples.length < this.windowSize) return;

        let top;
        try {
            // The upstream glasses-gestures example sends this 90-feature window
            // even though the bundled model metadata reports 150 input features.
            const result = this.classifier.classify(this.samples.flat(), false, {
                shortWindowFeatures: this.windowSize * 3,
            });
            top = result.results?.reduce((best, entry) =>
                Number.isFinite(entry.value) && (!best || entry.value > best.value) ? entry : best, null);
        } catch (error) {
            const onError = this.onError;
            this.stop();
            if (onError) onError(error);
            else console.warn("[VRU interaction] gesture inference failed:", error?.message || error);
            return;
        }
        const gesture = GESTURES[top?.label];
        if (!gesture || top.value <= this.confidence) return;

        const callback = this.callback;
        this.stop();
        callback?.(gesture, {
            model: "brilliantwear-edge-impulse",
            label: top.label,
            confidence: top.value,
        });
    }
}

module.exports = { NodDetector, GESTURE_SENSOR, GESTURE_WINDOW_MS };
