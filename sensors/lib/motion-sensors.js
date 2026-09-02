// Motion sensor handling for accelerometer, gyroscope, magnetometer, etc.
const EventEmitter = require("events");

class MotionSensorHandler extends EventEmitter {
    constructor(sensorType) {
        super();
        this.sensorType = sensorType;
        this.data = null;
        this.lastUpdate = null;
        this.sampleCount = 0;
    }

    updateData(rawData) {
        this.data = rawData;
        this.lastUpdate = Date.now();
        this.sampleCount++;

        this.emit("data", {
            sensor: this.sensorType,
            data: rawData,
            timestamp: this.lastUpdate,
            sampleCount: this.sampleCount,
        });
    }

    getData() {
        return {
            sensor: this.sensorType,
            data: this.data,
            timestamp: this.lastUpdate,
            sampleCount: this.sampleCount,
            isActive: this.data !== null,
        };
    }

    reset() {
        this.data = null;
        this.lastUpdate = null;
        this.sampleCount = 0;
    }
}

class AccelerometerHandler extends MotionSensorHandler {
    constructor() {
        super("acceleration");
    }

    // Calculate magnitude of acceleration vector
    getMagnitude() {
        if (!this.data || !this.data.acceleration) return null;

        const { x, y, z } = this.data.acceleration;
        return Math.sqrt(x * x + y * y + z * z);
    }

    // Check if device is in free fall (magnitude close to 0)
    isInFreeFall(threshold = 0.1) {
        const magnitude = this.getMagnitude();
        return magnitude !== null && magnitude < threshold;
    }
}

class GyroscopeHandler extends MotionSensorHandler {
    constructor() {
        super("gyroscope");
    }

    // Calculate rotation rate magnitude
    getRotationRate() {
        if (!this.data || !this.data.gyroscope) return null;

        const { x, y, z } = this.data.gyroscope;
        return Math.sqrt(x * x + y * y + z * z);
    }

    // Check if device is rotating (above threshold)
    isRotating(threshold = 0.1) {
        const rate = this.getRotationRate();
        return rate !== null && rate > threshold;
    }
}

class MagnetometerHandler extends MotionSensorHandler {
    constructor() {
        super("magnetometer");
    }

    // Calculate magnetic field strength
    getFieldStrength() {
        if (!this.data || !this.data.magnetometer) return null;

        const { x, y, z } = this.data.magnetometer;
        return Math.sqrt(x * x + y * y + z * z);
    }

    // Calculate heading (simplified compass direction)
    getHeading() {
        if (!this.data || !this.data.magnetometer) return null;

        const { x, y } = this.data.magnetometer;
        let heading = (Math.atan2(y, x) * 180) / Math.PI;

        // Normalize to 0-360 degrees
        if (heading < 0) heading += 360;

        return heading;
    }

    // Get compass direction as text
    getCompassDirection() {
        const heading = this.getHeading();
        if (heading === null) return null;

        const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
        const index = Math.round(heading / 45) % 8;
        return directions[index];
    }
}

class OrientationHandler extends MotionSensorHandler {
    constructor() {
        super("orientation");
    }

    // SDK orientation event already delivers { heading, pitch, roll } in degrees
    isPortrait(threshold = 45) {
        if (!this.data?.orientation) return null;
        return Math.abs(this.data.orientation.pitch) < threshold;
    }

    isLandscape(threshold = 45) {
        if (!this.data?.orientation) return null;
        return Math.abs(this.data.orientation.roll) < threshold;
    }
}

module.exports = {
    MotionSensorHandler,
    AccelerometerHandler,
    GyroscopeHandler,
    MagnetometerHandler,
    OrientationHandler,
};
