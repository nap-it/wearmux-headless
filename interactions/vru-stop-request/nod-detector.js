const DEFAULTS = Object.freeze({
    windowMs: 1500,
    nodThresholdDeg: 16,
    shakeThresholdDeg: 24,
    deadbandDeg: 2,
});

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function wrapDegrees(value) {
    return ((value + 540) % 360) - 180;
}

function unwrap(values, wrap) {
    if (!values.length) return [];
    const result = [0];
    for (let index = 1; index < values.length; index += 1) {
        const delta = values[index] - values[index - 1];
        result.push(result[index - 1] + (wrap ? wrapDegrees(delta) : delta));
    }
    return result;
}

function axisMovement(values, deadbandDeg) {
    if (values.length < 2) return null;
    const start = values[0];
    const end = values[values.length - 1];
    let min = Infinity;
    let max = -Infinity;
    let direction = 0;
    let reversals = 0;

    for (let index = 0; index < values.length; index += 1) {
        min = Math.min(min, values[index]);
        max = Math.max(max, values[index]);
        if (index === 0) continue;
        const delta = values[index] - values[index - 1];
        if (Math.abs(delta) < deadbandDeg) continue;
        const nextDirection = Math.sign(delta);
        if (direction && nextDirection !== direction) reversals += 1;
        direction = nextDirection;
    }

    const range = max - min;
    const excursion = Math.max(Math.abs(min - start), Math.abs(max - start));
    return {
        range,
        excursion,
        reversals,
        returned: Math.abs(end - start) <= Math.max(8, excursion * 0.65),
    };
}

class NodDetector {
    constructor(sensorManager, options = {}) {
        this.sensorManager = sensorManager;
        this.windowMs = positiveNumber(options.windowMs ?? process.env.VRU_GESTURE_WINDOW_MS, DEFAULTS.windowMs);
        this.nodThresholdDeg = positiveNumber(options.nodThresholdDeg ?? process.env.VRU_NOD_THRESHOLD_DEG, DEFAULTS.nodThresholdDeg);
        this.shakeThresholdDeg = positiveNumber(options.shakeThresholdDeg ?? process.env.VRU_SHAKE_THRESHOLD_DEG, DEFAULTS.shakeThresholdDeg);
        this.deadbandDeg = positiveNumber(options.deadbandDeg ?? process.env.VRU_GESTURE_DEADBAND_DEG, DEFAULTS.deadbandDeg);
        this.samples = [];
        this.callback = null;
        this.active = false;
        this.onOrientation = (event) => this._handleOrientation(event);
    }

    start(callback) {
        if (!this.sensorManager) throw new Error("The selected device has no active sensor manager");
        if (!this.sensorManager.getEnabledSensors().includes("orientation")) {
            throw new Error("Orientation sensing is required for nod/shake detection");
        }
        this.stop();
        this.samples = [];
        this.callback = callback;
        this.active = true;
        this.sensorManager.on("orientation", this.onOrientation);
    }

    stop() {
        if (this.active) this.sensorManager?.off("orientation", this.onOrientation);
        this.active = false;
        this.callback = null;
    }

    _handleOrientation(event) {
        if (!this.active) return;
        const orientation = event?.message?.orientation;
        if (![orientation?.heading, orientation?.pitch].every(Number.isFinite)) return;

        const now = Date.now();
        this.samples.push({
            ts: now,
            heading: orientation.heading,
            pitch: orientation.pitch,
        });
        this.samples = this.samples.filter((sample) => now - sample.ts <= this.windowMs);
        if (this.samples.length < 8) return;

        const heading = axisMovement(unwrap(this.samples.map((sample) => sample.heading), true), this.deadbandDeg);
        const pitch = axisMovement(this.samples.map((sample) => sample.pitch), this.deadbandDeg);
        if (!heading || !pitch) return;

        const nod = pitch.excursion >= this.nodThresholdDeg && pitch.reversals >= 1 && pitch.returned;
        const shake = heading.excursion >= this.shakeThresholdDeg && heading.reversals >= 1 && heading.returned;
        if (!nod && !shake) return;

        let gesture;
        if (nod && shake) {
            gesture = pitch.excursion / this.nodThresholdDeg >= heading.excursion / this.shakeThresholdDeg
                ? "nod"
                : "shake";
        } else {
            gesture = nod ? "nod" : "shake";
        }

        const callback = this.callback;
        this.stop();
        callback?.(gesture, {
            pitchExcursionDeg: pitch.excursion,
            headingExcursionDeg: heading.excursion,
        });
    }
}

module.exports = { NodDetector };
