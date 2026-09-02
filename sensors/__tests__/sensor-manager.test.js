const { SensorManager } = require("../lib/sensor-manager");

// Mock ZenohManager to avoid real connections
jest.mock("../../utils/zenoh-manager", () => ({
    ZenohManager: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        start: jest.fn().mockResolvedValue(),
        attachToSensorManager: jest.fn().mockResolvedValue(),
    })),
}));

function createMockDevice(overrides = {}) {
    return {
        setSensorConfiguration: jest.fn(),
        addEventListener: jest.fn(),
        sensorTypes: [],
        isConnected: true,
        ...overrides,
    };
}

describe("SensorManager._configureSensors", () => {
    test("builds config for enabled sensors only", () => {
        const device = createMockDevice();
        const sm = new SensorManager(device, {
            enabledSensors: ["acceleration", "orientation"],
        });

        sm._configureSensors();

        expect(sm.sensorConfiguration).toEqual({
            acceleration: 50,
            orientation: 50,
        });
    });

    test("passes clearRest=true to setSensorConfiguration", () => {
        const device = createMockDevice();
        const sm = new SensorManager(device, {
            enabledSensors: ["acceleration"],
        });

        sm._configureSensors();

        expect(device.setSensorConfiguration).toHaveBeenCalledWith(
            { acceleration: 50 },
            true
        );
    });

    test("does not include disabled sensors in config (SDK handles zeroing)", () => {
        const device = createMockDevice();
        const sm = new SensorManager(device, {
            enabledSensors: ["tapDetector"],
        });

        sm._configureSensors();

        expect(sm.sensorConfiguration).toEqual({ tapDetector: 5 });
        // No gyroscope, acceleration, etc. keys — SDK zeros them via clearRest
        expect(sm.sensorConfiguration.acceleration).toBeUndefined();
        expect(sm.sensorConfiguration.gyroscope).toBeUndefined();
    });

    test("enables all sensors when none specified", () => {
        const device = createMockDevice();
        const sm = new SensorManager(device, { enabledSensors: [] });

        sm._configureSensors();

        // Should have all 12 sensors from availableSensors
        expect(Object.keys(sm.sensorConfiguration).length).toBe(12);
        expect(sm.sensorConfiguration.acceleration).toBe(50);
        expect(sm.sensorConfiguration.tapDetector).toBe(5);
    });

    test("warns on unknown sensor type", () => {
        const device = createMockDevice();
        const sm = new SensorManager(device, {
            enabledSensors: ["nonexistent"],
        });

        const warnSpy = jest.spyOn(console, "warn").mockImplementation();
        sm._configureSensors();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("Unknown sensor type: nonexistent")
        );
        warnSpy.mockRestore();
    });

    test("handles device without setSensorConfiguration gracefully", () => {
        const device = createMockDevice({ setSensorConfiguration: undefined });
        const sm = new SensorManager(device, {
            enabledSensors: ["acceleration"],
        });

        const warnSpy = jest.spyOn(console, "warn").mockImplementation();
        expect(() => sm._configureSensors()).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("does not support setSensorConfiguration")
        );
        warnSpy.mockRestore();
    });
});

describe("SensorManager.enableSensor / disableSensor / setSensorRate", () => {
    function createMonitoringManager(enabledSensors) {
        const device = createMockDevice();
        const sm = new SensorManager(device, { enabledSensors });
        sm._configureSensors();
        sm.isMonitoring = true; // enable/disable only reconfigure when monitoring
        device.setSensorConfiguration.mockClear();
        return { device, sm };
    }

    test("enableSensor adds sensor and reconfigures", () => {
        const { device, sm } = createMonitoringManager(["acceleration"]);

        sm.enableSensor("gyroscope", 100);

        expect(sm.enabledSensors).toContain("gyroscope");
        expect(device.setSensorConfiguration).toHaveBeenCalledWith(
            expect.objectContaining({ acceleration: 50, gyroscope: 100 }),
            true
        );
    });

    test("disableSensor removes sensor and reconfigures", () => {
        const { sm } = createMonitoringManager(["acceleration", "gyroscope"]);

        sm.disableSensor("gyroscope");

        expect(sm.enabledSensors).not.toContain("gyroscope");
        expect(sm.sensorConfiguration.gyroscope).toBeUndefined();
    });

    test("setSensorRate updates rate for sensor", () => {
        const { device, sm } = createMonitoringManager(["acceleration"]);

        sm.setSensorRate("acceleration", 100);

        expect(sm.availableSensors.acceleration).toBe(100);
        expect(device.setSensorConfiguration).toHaveBeenCalledWith(
            expect.objectContaining({ acceleration: 100 }),
            true
        );
    });

    test("enableSensor does not reconfigure when not monitoring", () => {
        const device = createMockDevice();
        const sm = new SensorManager(device, { enabledSensors: ["acceleration"] });
        sm._configureSensors();
        device.setSensorConfiguration.mockClear();

        sm.enableSensor("gyroscope", 50);

        expect(sm.enabledSensors).toContain("gyroscope");
        expect(device.setSensorConfiguration).not.toHaveBeenCalled();
    });
});
