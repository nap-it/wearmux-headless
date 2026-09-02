// ML-based gesture detection using Edge Impulse model
const EventEmitter = require("events");
const EdgeImpulseClassifier = require("./ei-classifier.js");

class MLGestureDetector extends EventEmitter {
    constructor(windowSize = 30) { // 30 samples for 1.5s at 20Hz
        super();
        this.windowSize = windowSize;
        this.buffer = [];
        this.classifier = new EdgeImpulseClassifier();
        this.initialized = false;
        this.initError = null;
        this._readyPromise = this._init();
        // Mark as handled so an un-awaited ready() won't crash the process;
        // consumers still see the rejection when they call ready().
        this._readyPromise.catch(() => { });
    }

    async _init() {
        try {
            await this.classifier.init();
            this.initialized = true;
        } catch (err) {
            this.initError = err;
            console.warn("ML initialization failed:", err.message);
            throw err;
        }
    }

    // Returns a promise that resolves when the classifier is ready, or rejects on init failure.
    ready() {
        return this._readyPromise;
    }

    // Call this with each new sensor reading
    addSample(sensorData) {
        // sensorData: { accX, accY, accZ } — scaled by 1/4 to match SDK training format
        this.buffer.push([
            sensorData.accX / 4,
            sensorData.accY / 4,
            sensorData.accZ / 4,
        ]);
        if (this.buffer.length > this.windowSize) {
            this.buffer.shift();
        }
        if (this.buffer.length === this.windowSize && this.initialized) {
            this._classify();
        }
    }

    async _classify() {
        // Flatten buffer to 1D array
        const input = this.buffer.flat();
        try {
            const result = await this.classifier.classify(input);
            this.emit("ml-gesture", result);
        } catch (err) {
            console.error("ML classification error:", err);
        }
    }

    reset() {
        this.buffer = [];
    }
}

module.exports = MLGestureDetector;
