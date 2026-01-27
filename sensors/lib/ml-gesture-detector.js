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
        this._init();
    }

    async _init() {
        await this.classifier.init();
        this.initialized = true;
    }

    // Call this with each new sensor reading
    addSample(sensorData) {
        // sensorData: { accX, accY, accZ, heading, pitch, roll }
        this.buffer.push([
            sensorData.accX, sensorData.accY, sensorData.accZ,
            sensorData.heading, sensorData.pitch, sensorData.roll
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
