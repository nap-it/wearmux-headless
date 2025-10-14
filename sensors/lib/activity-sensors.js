// Activity sensor handling for tap detection, step counting, etc.
const EventEmitter = require("events");

class ActivitySensorHandler extends EventEmitter {
    constructor(sensorType) {
        super();
        this.sensorType = sensorType;
        this.data = null;
        this.lastUpdate = null;
        this.eventCount = 0;
    }

    updateData(rawData) {
        this.data = rawData;
        this.lastUpdate = Date.now();
        this.eventCount++;

        this.emit("event", {
            sensor: this.sensorType,
            data: rawData,
            timestamp: this.lastUpdate,
            eventCount: this.eventCount,
        });
    }

    getData() {
        return {
            sensor: this.sensorType,
            data: this.data,
            timestamp: this.lastUpdate,
            eventCount: this.eventCount,
            isActive: this.data !== null,
        };
    }

    reset() {
        this.data = null;
        this.lastUpdate = null;
        this.eventCount = 0;
    }
}

class TapDetectorHandler extends ActivitySensorHandler {
    constructor() {
        super("tapDetector");
        this.tapHistory = [];
        this.maxHistorySize = 10;
        // Debounce and gesture grouping
        this.debounceMs = parseInt(process.env.TAP_DEBOUNCE_MS || "120", 10);
        this.doubleWindowMs = parseInt(
            process.env.TAP_DOUBLE_WINDOW_MS || "350",
            10
        );
        this.tripleWindowMs = parseInt(
            process.env.TAP_TRIPLE_WINDOW_MS || "700",
            10
        );
        this._lastRawTapMs = 0;
        this._groupCount = 0;
        this._groupFirstMs = 0;
        this._groupTimer = null;
    }

    updateData(rawData) {
        const now = Date.now();
        // Debounce repeated frames per physical tap
        if (now - this._lastRawTapMs < this.debounceMs) {
            return;
        }
        this._lastRawTapMs = now;

        super.updateData(rawData);

        // Add to tap history
        this.tapHistory.push({
            timestamp: Date.now(),
            data: rawData,
        });

        // Keep only recent taps
        if (this.tapHistory.length > this.maxHistorySize) {
            this.tapHistory.shift();
        }

        this.emit("tap", {
            tapDetector: rawData,
            timestamp: this.lastUpdate,
            totalTaps: this.eventCount,
        });

        // Gesture grouping: single/double/triple
        const clearGroup = () => {
            if (this._groupTimer) {
                clearTimeout(this._groupTimer);
                this._groupTimer = null;
            }
            this._groupCount = 0;
            this._groupFirstMs = 0;
        };

        const scheduleGroupTimeout = (ms) => {
            if (this._groupTimer) clearTimeout(this._groupTimer);
            this._groupTimer = setTimeout(() => {
                if (this._groupCount === 1) {
                    this.emit("gesture", {
                        type: "single",
                        timestamp: this.lastUpdate,
                    });
                } else if (this._groupCount === 2) {
                    this.emit("gesture", {
                        type: "double",
                        timestamp: this.lastUpdate,
                    });
                }
                clearGroup();
            }, ms);
        };

        if (this._groupCount === 0) {
            this._groupCount = 1;
            this._groupFirstMs = now;
            scheduleGroupTimeout(this.doubleWindowMs);
            return;
        }

        if (this._groupCount === 1) {
            if (now - this._groupFirstMs <= this.doubleWindowMs) {
                this._groupCount = 2;
                const remaining = Math.max(
                    0,
                    this.tripleWindowMs - (now - this._groupFirstMs)
                );
                scheduleGroupTimeout(remaining || 1);
            } else {
                // Finalize previous single
                if (this._groupTimer) clearTimeout(this._groupTimer);
                this.emit("gesture", { type: "single", timestamp: this.lastUpdate });
                this._groupCount = 1;
                this._groupFirstMs = now;
                scheduleGroupTimeout(this.doubleWindowMs);
            }
            return;
        }

        if (this._groupCount === 2) {
            if (now - this._groupFirstMs <= this.tripleWindowMs) {
                if (this._groupTimer) clearTimeout(this._groupTimer);
                this.emit("gesture", { type: "triple", timestamp: this.lastUpdate });
                clearGroup();
            } else {
                // Let the timer finalize double; start a new group with this tap
                this._groupCount = 1;
                this._groupFirstMs = now;
                scheduleGroupTimeout(this.doubleWindowMs);
            }
        }
    }

    // Get recent tap pattern
    getRecentTaps(maxAge = 5000) {
        const cutoff = Date.now() - maxAge;
        return this.tapHistory.filter((tap) => tap.timestamp > cutoff);
    }

    // Detect double tap pattern
    isDoubleTap(maxInterval = 500) {
        const recentTaps = this.getRecentTaps(maxInterval);
        return recentTaps.length >= 2;
    }

    // Detect triple tap pattern
    isTripleTap(maxInterval = 1000) {
        const recentTaps = this.getRecentTaps(maxInterval);
        return recentTaps.length >= 3;
    }
}

module.exports = {
    ActivitySensorHandler,
    TapDetectorHandler,
};
