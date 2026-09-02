const {
    MotionSensorHandler,
    AccelerometerHandler,
    GyroscopeHandler,
    MagnetometerHandler,
    OrientationHandler,
} = require("../lib/motion-sensors");

describe("MotionSensorHandler", () => {
    let handler;
    beforeEach(() => { handler = new MotionSensorHandler("test"); });

    test("starts with null data", () => {
        expect(handler.getData()).toMatchObject({ data: null, sampleCount: 0, isActive: false });
    });

    test("updateData stores data and increments sampleCount", () => {
        handler.updateData({ foo: 1 });
        expect(handler.getData().data).toEqual({ foo: 1 });
        expect(handler.getData().sampleCount).toBe(1);
        expect(handler.getData().isActive).toBe(true);
    });

    test("emits 'data' event on updateData", () => {
        const spy = jest.fn();
        handler.on("data", spy);
        handler.updateData({ x: 1 });
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
            sensor: "test",
            data: { x: 1 },
            sampleCount: 1,
        }));
    });

    test("reset clears state", () => {
        handler.updateData({ x: 1 });
        handler.reset();
        expect(handler.getData()).toMatchObject({ data: null, sampleCount: 0, isActive: false });
    });
});

describe("AccelerometerHandler", () => {
    let handler;
    beforeEach(() => { handler = new AccelerometerHandler(); });

    test("getMagnitude returns null when no data", () => {
        expect(handler.getMagnitude()).toBeNull();
    });

    test("getMagnitude computes vector length", () => {
        handler.updateData({ acceleration: { x: 3, y: 4, z: 0 } });
        expect(handler.getMagnitude()).toBeCloseTo(5);
    });

    test("getMagnitude for gravity at rest (~9.8)", () => {
        handler.updateData({ acceleration: { x: 0, y: 0, z: 9.8 } });
        expect(handler.getMagnitude()).toBeCloseTo(9.8);
    });

    test("isInFreeFall detects near-zero magnitude", () => {
        handler.updateData({ acceleration: { x: 0.01, y: 0.01, z: 0.01 } });
        expect(handler.isInFreeFall(0.1)).toBe(true);
    });

    test("isInFreeFall returns false for normal gravity", () => {
        handler.updateData({ acceleration: { x: 0, y: 0, z: 9.8 } });
        expect(handler.isInFreeFall()).toBe(false);
    });
});

describe("GyroscopeHandler", () => {
    let handler;
    beforeEach(() => { handler = new GyroscopeHandler(); });

    test("getRotationRate returns null when no data", () => {
        expect(handler.getRotationRate()).toBeNull();
    });

    test("getRotationRate computes vector length", () => {
        handler.updateData({ gyroscope: { x: 1, y: 2, z: 2 } });
        expect(handler.getRotationRate()).toBeCloseTo(3);
    });

    test("isRotating detects movement", () => {
        handler.updateData({ gyroscope: { x: 0, y: 0, z: 0.5 } });
        expect(handler.isRotating(0.1)).toBe(true);
    });

    test("isRotating returns false when still", () => {
        handler.updateData({ gyroscope: { x: 0, y: 0, z: 0 } });
        expect(handler.isRotating(0.1)).toBe(false);
    });
});

describe("MagnetometerHandler", () => {
    let handler;
    beforeEach(() => { handler = new MagnetometerHandler(); });

    test("getFieldStrength returns null when no data", () => {
        expect(handler.getFieldStrength()).toBeNull();
    });

    test("getFieldStrength computes vector length", () => {
        handler.updateData({ magnetometer: { x: 20, y: 0, z: 0 } });
        expect(handler.getFieldStrength()).toBeCloseTo(20);
    });

    test("getHeading returns null when no data", () => {
        expect(handler.getHeading()).toBeNull();
    });

    test("getHeading returns 0 for north (positive x, zero y)", () => {
        handler.updateData({ magnetometer: { x: 1, y: 0, z: 0 } });
        expect(handler.getHeading()).toBeCloseTo(0);
    });

    test("getHeading returns 90 for east (zero x, positive y)", () => {
        handler.updateData({ magnetometer: { x: 0, y: 1, z: 0 } });
        expect(handler.getHeading()).toBeCloseTo(90);
    });

    test("getHeading normalizes negative angles to 0-360", () => {
        handler.updateData({ magnetometer: { x: 0, y: -1, z: 0 } });
        expect(handler.getHeading()).toBeCloseTo(270);
    });

    test("getCompassDirection returns null when no data", () => {
        expect(handler.getCompassDirection()).toBeNull();
    });

    test("getCompassDirection maps headings to cardinal directions", () => {
        const cases = [
            [{ x: 1, y: 0, z: 0 }, "N"],
            [{ x: 0, y: 1, z: 0 }, "E"],
            [{ x: -1, y: 0, z: 0 }, "S"],
            [{ x: 0, y: -1, z: 0 }, "W"],
        ];
        for (const [mag, expected] of cases) {
            handler.updateData({ magnetometer: mag });
            expect(handler.getCompassDirection()).toBe(expected);
        }
    });
});

describe("OrientationHandler", () => {
    let handler;
    beforeEach(() => { handler = new OrientationHandler(); });

    test("isPortrait returns null when no data", () => {
        expect(handler.isPortrait()).toBeNull();
    });

    test("isLandscape returns null when no data", () => {
        expect(handler.isLandscape()).toBeNull();
    });

    // SDK delivers orientation as { heading, pitch, roll } already in degrees
    test("isPortrait returns true when pitch is small (device upright)", () => {
        handler.updateData({ orientation: { heading: 0, pitch: 10, roll: 80 } });
        expect(handler.isPortrait()).toBe(true);
    });

    test("isPortrait returns false when pitch exceeds threshold", () => {
        handler.updateData({ orientation: { heading: 0, pitch: 60, roll: 30 } });
        expect(handler.isPortrait()).toBe(false);
    });

    test("isLandscape returns true when roll is small", () => {
        handler.updateData({ orientation: { heading: 0, pitch: 80, roll: 10 } });
        expect(handler.isLandscape()).toBe(true);
    });

    test("isLandscape returns false when roll exceeds threshold", () => {
        handler.updateData({ orientation: { heading: 0, pitch: 10, roll: 60 } });
        expect(handler.isLandscape()).toBe(false);
    });

    test("isPortrait/isLandscape work with negative angles", () => {
        handler.updateData({ orientation: { heading: 180, pitch: -20, roll: -10 } });
        expect(handler.isPortrait()).toBe(true);
        expect(handler.isLandscape()).toBe(true);
    });

    test("isPortrait respects custom threshold", () => {
        handler.updateData({ orientation: { heading: 0, pitch: 30, roll: 0 } });
        expect(handler.isPortrait(20)).toBe(false);
        expect(handler.isPortrait(45)).toBe(true);
    });

    test("reads SDK heading field correctly (not yaw)", () => {
        // SDK uses 'heading', not 'yaw' — verify we access the right field
        handler.updateData({ orientation: { heading: 270, pitch: 5, roll: 5 } });
        expect(handler.data.orientation.heading).toBe(270);
        expect(handler.data.orientation.yaw).toBeUndefined();
    });
});
