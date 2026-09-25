jest.mock('../mqtt-manager', () => ({
    MqttManager: jest.fn().mockImplementation((opts) => ({ _opts: opts })),
}));
jest.mock('../zenoh-manager', () => ({
    ZenohManager: jest.fn().mockImplementation((opts) => ({ _opts: opts })),
}));
jest.mock('../mqtt-subscriber', () => ({
    MqttSubscriber: jest.fn().mockImplementation((opts) => ({ _opts: opts })),
}));
jest.mock('../zenoh-subscriber', () => ({
    ZenohSubscriber: jest.fn().mockImplementation((opts) => ({ _opts: opts })),
}));

const { selectedTransport, createPublisher, createSubscriber } = require('../transport');
const { MqttManager } = require('../mqtt-manager');
const { ZenohManager } = require('../zenoh-manager');
const { MqttSubscriber } = require('../mqtt-subscriber');
const { ZenohSubscriber } = require('../zenoh-subscriber');

afterEach(() => {
    delete process.env.MESSAGE_TRANSPORT;
    delete process.env.MQTT_ENABLE;
    delete process.env.ZENOH_ENABLE;
    jest.clearAllMocks();
});

describe('selectedTransport', () => {
    test('MESSAGE_TRANSPORT overrides legacy enable flags', () => {
        process.env.MESSAGE_TRANSPORT = 'mqtt';
        process.env.ZENOH_ENABLE = '1';
        expect(selectedTransport()).toBe('mqtt');
    });

    test('rejects an unknown MESSAGE_TRANSPORT value', () => {
        process.env.MESSAGE_TRANSPORT = 'unknown';
        expect(() => selectedTransport()).toThrow(/Invalid MESSAGE_TRANSPORT/);
    });

    test('returns "mqtt" when MQTT_ENABLE=1', () => {
        process.env.MQTT_ENABLE = '1';
        expect(selectedTransport()).toBe('mqtt');
    });

    test('returns "zenoh" when ZENOH_ENABLE=1', () => {
        process.env.ZENOH_ENABLE = '1';
        expect(selectedTransport()).toBe('zenoh');
    });

    test('returns "none" when neither env var is set', () => {
        expect(selectedTransport()).toBe('none');
    });

    test('MQTT wins when both MQTT_ENABLE=1 and ZENOH_ENABLE=1 are set', () => {
        process.env.MQTT_ENABLE = '1';
        process.env.ZENOH_ENABLE = '1';
        expect(selectedTransport()).toBe('mqtt');
    });
});

describe('createPublisher', () => {
    test('returns MqttManager instance when transport=mqtt', () => {
        const pub = createPublisher({ transport: 'mqtt', keyPrefix: 'bwear/test' });
        expect(MqttManager).toHaveBeenCalledWith({ transport: 'mqtt', keyPrefix: 'bwear/test' });
        expect(pub).not.toBeNull();
    });

    test('returns ZenohManager instance when transport=zenoh', () => {
        const pub = createPublisher({ transport: 'zenoh' });
        expect(ZenohManager).toHaveBeenCalledWith({ transport: 'zenoh' });
        expect(pub).not.toBeNull();
    });

    test('returns null when transport=none', () => {
        expect(createPublisher({ transport: 'none' })).toBeNull();
    });

    test('reads transport from env when not specified in options', () => {
        process.env.MQTT_ENABLE = '1';
        const pub = createPublisher();
        expect(MqttManager).toHaveBeenCalled();
        expect(pub).not.toBeNull();
    });

    test('returns null when no transport is configured', () => {
        expect(createPublisher()).toBeNull();
    });
});

describe('createSubscriber', () => {
    test('returns MqttSubscriber with keyExpression mapped to topicFilter', () => {
        const sub = createSubscriber({ transport: 'mqtt', keyExpression: 'bwear/#' });
        expect(MqttSubscriber).toHaveBeenCalledWith({ topicFilter: 'bwear/#', brokerUrl: undefined });
        expect(sub).not.toBeNull();
    });

    test('returns MqttSubscriber using topicFilter when keyExpression absent', () => {
        createSubscriber({ transport: 'mqtt', topicFilter: 'bwear/sensors/#' });
        expect(MqttSubscriber).toHaveBeenCalledWith({ topicFilter: 'bwear/sensors/#', brokerUrl: undefined });
    });

    test('passes brokerUrl to MqttSubscriber', () => {
        createSubscriber({ transport: 'mqtt', keyExpression: 'x', brokerUrl: 'mqtt://host:1883' });
        expect(MqttSubscriber).toHaveBeenCalledWith({ topicFilter: 'x', brokerUrl: 'mqtt://host:1883' });
    });

    test('returns ZenohSubscriber with keyExpression', () => {
        const sub = createSubscriber({ transport: 'zenoh', keyExpression: 'bwear/**' });
        expect(ZenohSubscriber).toHaveBeenCalledWith({ keyExpression: 'bwear/**', udsPath: undefined });
        expect(sub).not.toBeNull();
    });

    test('ZenohSubscriber uses topicFilter as keyExpression fallback', () => {
        createSubscriber({ transport: 'zenoh', topicFilter: 'bwear/sensors' });
        expect(ZenohSubscriber).toHaveBeenCalledWith({ keyExpression: 'bwear/sensors', udsPath: undefined });
    });

    test('passes udsPath to ZenohSubscriber', () => {
        createSubscriber({ transport: 'zenoh', keyExpression: 'x', udsPath: '/tmp/test.sock' });
        expect(ZenohSubscriber).toHaveBeenCalledWith({ keyExpression: 'x', udsPath: '/tmp/test.sock' });
    });

    test('returns null when transport=none', () => {
        expect(createSubscriber({ transport: 'none' })).toBeNull();
    });

    test('reads transport from env when not specified in options', () => {
        process.env.ZENOH_ENABLE = '1';
        const sub = createSubscriber({ keyExpression: 'bwear/**' });
        expect(ZenohSubscriber).toHaveBeenCalled();
        expect(sub).not.toBeNull();
    });

    test('returns null when no transport is configured', () => {
        expect(createSubscriber()).toBeNull();
    });
});
