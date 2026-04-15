// Activity sensor handling for hardware tap detection
const EventEmitter = require("events");

class TapDetectorHandler extends EventEmitter {
    constructor() {
        super();
        this.data = null;
        this.lastUpdate = null;
        this.eventCount = 0;
        this.tapHistory = [];
        this.maxHistorySize = 10;
        
        // Debounce and gesture grouping
        this.debounceMs = parseInt(process.env.TAP_DEBOUNCE_MS || "120", 10);
        this.doubleWindowMs = parseInt(process.env.TAP_DOUBLE_WINDOW_MS || "350", 10);
        this.tripleWindowMs = parseInt(process.env.TAP_TRIPLE_WINDOW_MS || "700", 10);
        
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

        this.data = rawData;
        this.lastUpdate = Date.now();
        this.eventCount++;

        // Add to tap history
        this.tapHistory.push({
            timestamp: Date.now(),
            data: rawData,
        });

        // Keep only recent taps
        if (this.tapHistory.length > this.maxHistorySize) {
            this.tapHistory.shift();
        }

        // Gesture grouping: single/double/triple
        this._processGesture(now);
    }

    _processGesture(now) {
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
                if (this._groupTimer) clearTimeout(this._groupTimer);
                this.emit("gesture", { type: "double", timestamp: this.lastUpdate });
                this._groupCount = 1;
                this._groupFirstMs = now;
                scheduleGroupTimeout(this.doubleWindowMs);
            }
        }
    }

    getData() {
        return {
            sensor: "tapDetector",
            data: this.data,
            timestamp: this.lastUpdate,
            eventCount: this.eventCount,
            isActive: this.data !== null,
        };
    }

    getRecentTaps(maxAge = 5000) {
        const cutoff = Date.now() - maxAge;
        return this.tapHistory.filter((tap) => tap.timestamp > cutoff);
    }

    isDoubleTap(maxInterval = 500) {
        const recentTaps = this.getRecentTaps(maxInterval);
        return recentTaps.length >= 2;
    }

    isTripleTap(maxInterval = 1000) {
        const recentTaps = this.getRecentTaps(maxInterval);
        return recentTaps.length >= 3;
    }

    reset() {
        this.data = null;
        this.lastUpdate = null;
        this.eventCount = 0;
        this.tapHistory = [];
        if (this._groupTimer) {
            clearTimeout(this._groupTimer);
            this._groupTimer = null;
        }
        this._groupCount = 0;
        this._groupFirstMs = 0;
    }
}

module.exports = {
    TapDetectorHandler,
};
