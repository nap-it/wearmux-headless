const { Config } = require("../../utils/config");

describe("Config.getSensorRates", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        // Clear all sensor rate env vars
        for (const key of Object.keys(process.env)) {
            if (key.endsWith("_RATE")) delete process.env[key];
        }
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test("returns null for all sensors when no env vars are set", () => {
        const rates = Config.getSensorRates();
        expect(rates.acceleration).toBeNull();
        expect(rates.gyroscope).toBeNull();
        expect(rates.tapDetector).toBeNull();
        expect(rates.pressure).toBeNull();
    });

    test("parses Hz values correctly", () => {
        process.env.ACCELERATION_RATE = "100";
        const rates = Config.getSensorRates();
        expect(rates.acceleration).toBe(100);
    });

    test("rounds to nearest multiple of 5", () => {
        process.env.ACCELERATION_RATE = "17";
        const rates = Config.getSensorRates();
        expect(rates.acceleration).toBe(15);
    });

    test("enforces minimum of 5 Hz", () => {
        process.env.ACCELERATION_RATE = "1";
        const rates = Config.getSensorRates();
        expect(rates.acceleration).toBe(5);
    });

    test("parses ms values and converts to Hz", () => {
        // 20ms = 50Hz
        process.env.GYROSCOPE_RATE = "20ms";
        const rates = Config.getSensorRates();
        expect(rates.gyroscope).toBe(50);
    });

    test("parses ms values case-insensitively", () => {
        process.env.GYROSCOPE_RATE = "50MS";
        const rates = Config.getSensorRates();
        // 50ms = 20Hz
        expect(rates.gyroscope).toBe(20);
    });

    test("caps ms-derived Hz at 200", () => {
        // 1ms would be 1000Hz, capped to 200
        process.env.ACCELERATION_RATE = "1ms";
        const rates = Config.getSensorRates();
        expect(rates.acceleration).toBe(200);
    });

    test("returns null for invalid values", () => {
        process.env.ACCELERATION_RATE = "abc";
        process.env.GYROSCOPE_RATE = "0";
        process.env.MAGNETOMETER_RATE = "-10";
        process.env.ORIENTATION_RATE = "";
        const rates = Config.getSensorRates();
        expect(rates.acceleration).toBeNull();
        expect(rates.gyroscope).toBeNull();
        expect(rates.magnetometer).toBeNull();
        expect(rates.orientation).toBeNull();
    });

    test("covers all 12 sensor types", () => {
        const rates = Config.getSensorRates();
        const expected = [
            "acceleration", "gravity", "linearAcceleration",
            "gyroscope", "magnetometer", "gameRotation",
            "rotation", "orientation", "activity",
            "stepCounter", "tapDetector", "pressure",
        ];
        expect(Object.keys(rates).sort()).toEqual(expected.sort());
    });

    test("each sensor reads its own env var", () => {
        process.env.TAP_DETECTOR_RATE = "10";
        process.env.PRESSURE_RATE = "25";
        const rates = Config.getSensorRates();
        expect(rates.tapDetector).toBe(10);
        expect(rates.pressure).toBe(25);
        expect(rates.acceleration).toBeNull();
    });
});
