jest.mock('mqtt', () => ({
    connect: jest.fn(() => ({
        connected: false,
        on: jest.fn(),
        once: jest.fn(),
        off: jest.fn(),
        publish: jest.fn(),
        end: jest.fn((force, opts, cb) => cb && cb()),
    })),
}));

const { MqttManager } = require('../mqtt-manager');

afterEach(() => {
    delete process.env.MQTT_KEY_PREFIX;
    delete process.env.MQTT_BROKER_URL;
});

describe('MqttManager constructor', () => {
    test('uses default keyPrefix and brokerUrl', () => {
        const mm = new MqttManager();
        expect(mm.keyPrefix).toBe('bsole/sensors');
        expect(mm.brokerUrl).toBe('mqtt://127.0.0.1:1883');
    });

    test('accepts custom keyPrefix and brokerUrl via options', () => {
        const mm = new MqttManager({ keyPrefix: 'custom/prefix', brokerUrl: 'mqtt://host:9999' });
        expect(mm.keyPrefix).toBe('custom/prefix');
        expect(mm.brokerUrl).toBe('mqtt://host:9999');
    });

    test('reads keyPrefix from env when not in options', () => {
        process.env.MQTT_KEY_PREFIX = 'env/prefix';
        const mm = new MqttManager();
        expect(mm.keyPrefix).toBe('env/prefix');
    });

    test('reads brokerUrl from env when not in options', () => {
        process.env.MQTT_BROKER_URL = 'mqtt://env-host:2000';
        const mm = new MqttManager();
        expect(mm.brokerUrl).toBe('mqtt://env-host:2000');
    });

    test('starts with no active client or attached handlers', () => {
        const mm = new MqttManager();
        expect(mm.client).toBeNull();
        expect(mm._attached).toBe(false);
        expect(mm._attachedHandlers.size).toBe(0);
    });
});

describe('MqttManager._topicFor', () => {
    test('concatenates keyPrefix and sensorType with slash', () => {
        const mm = new MqttManager({ keyPrefix: 'bsole/sensors' });
        expect(mm._topicFor('acceleration')).toBe('bsole/sensors/acceleration');
    });

    test('works with custom prefix', () => {
        const mm = new MqttManager({ keyPrefix: 'my/custom' });
        expect(mm._topicFor('gyroscope')).toBe('my/custom/gyroscope');
    });
});

describe('MqttManager._serialize', () => {
    let mm;
    beforeEach(() => { mm = new MqttManager(); });

    test('serializes a plain object to JSON', () => {
        const result = mm._serialize({ ts: 1000, sensor: 'acc' });
        expect(JSON.parse(result)).toEqual({ ts: 1000, sensor: 'acc' });
    });

    test('returns "null" string for null input', () => {
        expect(mm._serialize(null)).toBe('null');
    });

    test('returns "null" string for undefined input', () => {
        expect(mm._serialize(undefined)).toBe('null');
    });

    test('serializes a number', () => {
        expect(JSON.parse(mm._serialize(42))).toBe(42);
    });

    test('falls back to String() for circular references', () => {
        const circular = {};
        circular.self = circular;
        const result = mm._serialize(circular);
        expect(typeof result).toBe('string');
    });
});

describe('MqttManager.setDeviceInfo', () => {
    test('stores provided device info', () => {
        const mm = new MqttManager();
        mm.setDeviceInfo({ id: 'abc123', name: 'Frame Left' });
        expect(mm._deviceInfo).toEqual({ id: 'abc123', name: 'Frame Left' });
    });

    test('sets _deviceInfo to null when called with null', () => {
        const mm = new MqttManager();
        mm.setDeviceInfo({ id: 'abc' });
        mm.setDeviceInfo(null);
        expect(mm._deviceInfo).toBeNull();
    });

    test('sets _deviceInfo to null when called with undefined', () => {
        const mm = new MqttManager();
        mm.setDeviceInfo({ id: 'abc' });
        mm.setDeviceInfo(undefined);
        expect(mm._deviceInfo).toBeNull();
    });
});

describe('MqttManager.detachAll', () => {
    test('does nothing and resolves when not attached', async () => {
        const mm = new MqttManager();
        await expect(mm.detachAll()).resolves.toBeUndefined();
        expect(mm._attached).toBe(false);
    });

    test('removes event listeners and clears handler map', async () => {
        const mm = new MqttManager();
        const mockSm = { off: jest.fn(), removeListener: jest.fn() };
        const handler = jest.fn();

        mm._attached = true;
        mm._sensorManager = mockSm;
        mm._attachedHandlers.set('acceleration', handler);
        mm._attachedHandlers.set('gyroscope', handler);

        await mm.detachAll(mockSm);

        expect(mockSm.off).toHaveBeenCalledWith('acceleration', handler);
        expect(mockSm.off).toHaveBeenCalledWith('gyroscope', handler);
        expect(mm._attachedHandlers.size).toBe(0);
        expect(mm._attached).toBe(false);
    });

    test('uses stored _sensorManager when none is passed', async () => {
        const mm = new MqttManager();
        const mockSm = { off: jest.fn(), removeListener: jest.fn() };
        const handler = jest.fn();

        mm._attached = true;
        mm._sensorManager = mockSm;
        mm._attachedHandlers.set('orientation', handler);

        await mm.detachAll();

        expect(mockSm.off).toHaveBeenCalledWith('orientation', handler);
        expect(mm._attached).toBe(false);
    });
});

describe('MqttManager.stop', () => {
    test('resolves cleanly when client is null', async () => {
        const mm = new MqttManager();
        await expect(mm.stop()).resolves.toBeUndefined();
        expect(mm._sensorManager).toBeNull();
    });
});
