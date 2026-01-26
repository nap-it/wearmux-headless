// Gesture detection for head movements (computed from orientation sensor data)
const EventEmitter = require("events");

class NodDetectorHandler extends EventEmitter {
    constructor() {
        super();
        this.orientationHistory = [];
        this.maxHistorySize = 40; // ~2s at 20Hz
        this.nodThreshold = 25; // degrees - minimum pitch change (was too low)
        this.maxNodRange = 140; // degrees - maximum pitch range (was 70, too strict!)
        this.nodWindow = 1200; // ms - time window for nod detection (longer window)
        this.minNodCycles = 1; // minimum up-down cycles (nod is typically 1 cycle)
        this.maxNodCycles = 2; // maximum cycles (nods don't repeat rapidly)
        
        this._lastNodTime = 0;
        this._nodCooldown = 1200; // ms between nod detections (reduced)
        this._lastValidPitch = null; // For glitch filtering
        this._pitchBuffer = []; // Small buffer for moving average
        this._maxBufferSize = 5; // Average over 5 samples (~250ms, more smoothing)
    }

    updateData(orientationData) {
        if (!orientationData || !orientationData.orientation) return;
        
        const { pitch } = orientationData.orientation;
        let pitchDeg = (pitch * 180) / Math.PI;
        
        // Normalize pitch to [-180, 180] range to handle wrapping
        while (pitchDeg > 180) pitchDeg -= 360;
        while (pitchDeg < -180) pitchDeg += 360;
        
        // Add to moving average buffer
        this._pitchBuffer.push(pitchDeg);
        if (this._pitchBuffer.length > this._maxBufferSize) {
            this._pitchBuffer.shift();
        }
        
        // Calculate smoothed pitch (moving average)
        let smoothedPitch = this._pitchBuffer.reduce((sum, p) => sum + p, 0) / this._pitchBuffer.length;
        
        // Reject obvious glitches (jumps > 80°) but allow normal movement
        if (this._lastValidPitch !== null) {
            let diff = smoothedPitch - this._lastValidPitch;
            
            // Normalize the difference
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            
            // Only reject extreme glitches (> 80°)
            if (Math.abs(diff) > 80) {
                return; // Skip this sample
            }
        }
        
        this._lastValidPitch = smoothedPitch;
        pitchDeg = smoothedPitch; // Use smoothed value
        
        const timestamp = Date.now();

        const { heading } = orientationData.orientation;
        let headingDeg = (heading * 180) / Math.PI;
        
        // Normalize heading to [-180, 180] range
        while (headingDeg > 180) headingDeg -= 360;
        while (headingDeg < -180) headingDeg += 360;
        
        // Add to history (include heading for cross-validation)
        this.orientationHistory.push({
            timestamp,
            pitch: pitchDeg,
            heading: headingDeg
        });

        // Keep only recent samples
        if (this.orientationHistory.length > this.maxHistorySize) {
            this.orientationHistory.shift();
        }

        // Check for nod if we have enough samples
        if (this.orientationHistory.length >= 10) {
            this._detectNod();
        }
    }

    _detectNod() {
        const now = Date.now();
        
        // Cooldown check
        if (now - this._lastNodTime < this._nodCooldown) {
            return;
        }

        // Get recent samples within time window
        const windowStart = now - this.nodWindow;
        const recentSamples = this.orientationHistory.filter(
            s => s.timestamp >= windowStart
        );

        if (recentSamples.length < 5) return;

        // Calculate pitch range using ACTUAL min/max (not accumulated)
        const pitches = recentSamples.map(s => s.pitch);
        
        // Find min and max directly from raw pitches
        let minPitch = Math.min(...pitches);
        let maxPitch = Math.max(...pitches);
        
        // Calculate range, handling boundary crossing (e.g., -170° to 170° = 20°, not 340°)
        let pitchRange = maxPitch - minPitch;
        if (pitchRange > 180) {
            // Crossing ±180° boundary - calculate the "other way around"
            pitchRange = 360 - pitchRange;
        }
        
        // For debug - still show normalized relative to first sample
        const basePitch = pitches[0];
        const normalizedPitches = pitches.map(p => {
            let diff = p - basePitch;
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            return diff;
        });

        // Calculate heading range for cross-validation
        let headingRange = 0;
        if (recentSamples.length > 0 && recentSamples[0].heading !== undefined) {
            const headings = recentSamples.map(s => s.heading || 0);
            const maxHeading = Math.max(...headings);
            const minHeading = Math.min(...headings);
            headingRange = maxHeading - minHeading;
            if (headingRange > 180) headingRange = 360 - headingRange;
        }

        // Check if range is within nod bounds (not too small, not too large)
        if (pitchRange < this.nodThreshold || pitchRange > this.maxNodRange) {
            return;
        }
        
        // Reject if this looks more like a shake (heading movement is significantly larger than pitch)
        // Increased tolerance: pitch should be at least 60% of heading, not 80%
        if (headingRange > pitchRange * 0.6) { // More forgiving: allow 40% difference
            return;
        }

        // Detect up-down cycles by finding peaks and valleys
        // Use the normalized pitches (relative values)
        let cycles = 0;
        let lastExtreme = null;
        let lastExtremeType = null; // 'peak' or 'valley'

        for (let i = 1; i < normalizedPitches.length - 1; i++) {
            const prev = normalizedPitches[i - 1];
            const curr = normalizedPitches[i];
            const next = normalizedPitches[i + 1];

            // Detect peak (local maximum)
            if (curr > prev && curr > next && curr > minPitch + this.nodThreshold * 0.5) {
                if (lastExtremeType !== 'peak') {
                    if (lastExtremeType === 'valley') {
                        cycles++; // Completed a down-up cycle
                    }
                    lastExtreme = curr;
                    lastExtremeType = 'peak';
                }
            }
            // Detect valley (local minimum)
            else if (curr < prev && curr < next && curr < maxPitch - this.nodThreshold * 0.5) {
                if (lastExtremeType !== 'valley') {
                    if (lastExtremeType === 'peak') {
                        cycles++; // Completed an up-down cycle
                    }
                    lastExtreme = curr;
                    lastExtremeType = 'valley';
                }
            }
        }

        // Nod detected if we have the right number of cycles (not too few, not too many)
        if (cycles >= this.minNodCycles && cycles <= this.maxNodCycles) {
            this._lastNodTime = now;
            this.emit("gesture", {
                type: "nod",
                timestamp: now,
                cycles,
                pitchRange
            });
        }
    }

    reset() {
        this.orientationHistory = [];
        this._lastNodTime = 0;
        this._lastValidPitch = null;
        this._pitchBuffer = [];
        this._nodCycles = 0;
    }
}

class ShakeDetectorHandler extends EventEmitter {
    constructor() {
        super();
        this.orientationHistory = [];
        this.maxHistorySize = 40; // ~2s at 20Hz
        this.shakeThreshold = 30; // degrees - minimum heading change (increased)
        this.maxShakeRange = 140; // degrees - maximum heading range (same as nod)
        this.shakeWindow = 1400; // ms - time window for shake detection (longer)
        this.minShakeCycles = 2; // minimum left-right cycles (shake needs >=2)
        this.maxShakeCycles = 4; // maximum cycles (reduced from 5)
        
        this._lastShakeTime = 0;
        this._shakeCooldown = 1200; // ms between shake detections (reduced)
        this._lastValidHeading = null; // For glitch filtering
        this._headingBuffer = []; // Small buffer for moving average
        this._maxBufferSize = 5; // Average over 5 samples (~250ms, more smoothing)
    }

    updateData(orientationData) {
        if (!orientationData || !orientationData.orientation) return;
        
        const { heading, pitch } = orientationData.orientation;
        let headingDeg = (heading * 180) / Math.PI;
        let pitchDeg = (pitch * 180) / Math.PI;
        
        // Normalize heading to [-180, 180] range
        while (headingDeg > 180) headingDeg -= 360;
        while (headingDeg < -180) headingDeg += 360;
        
        // Normalize pitch to [-180, 180] range
        while (pitchDeg > 180) pitchDeg -= 360;
        while (pitchDeg < -180) pitchDeg += 360;
        
        // Add to moving average buffer
        this._headingBuffer.push(headingDeg);
        if (this._headingBuffer.length > this._maxBufferSize) {
            this._headingBuffer.shift();
        }
        
        // Calculate smoothed heading (moving average)
        let smoothedHeading = this._headingBuffer.reduce((sum, h) => sum + h, 0) / this._headingBuffer.length;
        
        // Reject obvious glitches (jumps > 80°) but allow normal movement
        if (this._lastValidHeading !== null) {
            let diff = smoothedHeading - this._lastValidHeading;
            
            // Normalize the difference
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            
            // Only reject extreme glitches (> 80°)
            if (Math.abs(diff) > 80) {
                return;
            }
        }
        
        this._lastValidHeading = smoothedHeading;
        headingDeg = smoothedHeading; // Use smoothed value
        
        const timestamp = Date.now();

        // Add to history (include pitch for cross-validation)
        this.orientationHistory.push({
            timestamp,
            heading: headingDeg,
            pitch: pitchDeg
        });

        // Keep only recent samples
        if (this.orientationHistory.length > this.maxHistorySize) {
            this.orientationHistory.shift();
        }

        // Check for shake if we have enough samples
        if (this.orientationHistory.length >= 10) {
            this._detectShake();
        }
    }

    _detectShake() {
        const now = Date.now();
        
        // Cooldown check
        if (now - this._lastShakeTime < this._shakeCooldown) {
            return;
        }

        // Get recent samples within time window
        const windowStart = now - this.shakeWindow;
        const recentSamples = this.orientationHistory.filter(
            s => s.timestamp >= windowStart
        );

        if (recentSamples.length < 5) return;

        // Calculate heading range
        const headings = recentSamples.map(s => s.heading);
        const maxHeading = Math.max(...headings);
        const minHeading = Math.min(...headings);
        let headingRange = maxHeading - minHeading;
        
        // Handle boundary spanning
        if (headingRange > 180) {
            headingRange = 360 - headingRange;
        }

        // Calculate pitch range for cross-validation
        let pitchRange = 0;
        if (recentSamples.length > 0 && recentSamples[0].pitch !== undefined) {
            const pitches = recentSamples.map(s => s.pitch || 0);
            const maxPitch = Math.max(...pitches);
            const minPitch = Math.min(...pitches);
            pitchRange = maxPitch - minPitch;
            if (pitchRange > 180) pitchRange = 360 - pitchRange;
        }

        // Check if range is within shake bounds
        if (headingRange < this.shakeThreshold || headingRange > this.maxShakeRange) {
            return;
        }
        
        // Reject if this looks more like a nod (pitch movement is significantly larger than heading)
        // Increased tolerance: heading should be at least 60% of pitch, not 80%
        if (pitchRange > headingRange * 0.6) { // More forgiving: allow 40% difference
            return;
        }

        // Detect left-right cycles by finding peaks and valleys
        let cycles = 0;
        let lastExtreme = null;
        let lastExtremeType = null; // 'peak' or 'valley'

        for (let i = 1; i < headings.length - 1; i++) {
            const prev = headings[i - 1];
            const curr = headings[i];
            const next = headings[i + 1];

            // Detect peak (local maximum - turned right)
            if (curr > prev && curr > next && curr > minHeading + this.shakeThreshold * 0.5) {
                if (lastExtremeType !== 'peak') {
                    if (lastExtremeType === 'valley') {
                        cycles++; // Completed a left-right cycle
                    }
                    lastExtreme = curr;
                    lastExtremeType = 'peak';
                }
            }
            // Detect valley (local minimum - turned left)
            else if (curr < prev && curr < next && curr < maxHeading - this.shakeThreshold * 0.5) {
                if (lastExtremeType !== 'valley') {
                    if (lastExtremeType === 'peak') {
                        cycles++; // Completed a right-left cycle
                    }
                    lastExtreme = curr;
                    lastExtremeType = 'valley';
                }
            }
        }

        // Shake detected if we have the right number of cycles
        if (cycles >= this.minShakeCycles && cycles <= this.maxShakeCycles) {
            this._lastShakeTime = now;
            this.emit("gesture", {
                type: "shake",
                timestamp: now,
                cycles,
                headingRange
            });
        }
    }

    reset() {
        this.orientationHistory = [];
        this._lastShakeTime = 0;
        this._lastValidHeading = null;
        this._headingBuffer = [];
    }
}

module.exports = {
    ShakeDetectorHandler,
    NodDetectorHandler,
};

