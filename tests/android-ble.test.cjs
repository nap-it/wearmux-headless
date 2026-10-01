const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { AndroidBleConnection } = require('../utils/android-ble/connection');
const { AndroidBleBridge } = require('../utils/android-ble/bridge');
const { parseFrame } = require('../utils/android-ble/protocol');

const token = 'test-token-at-least-16-characters';
const id = 'AA:BB:CC:DD:EE:FF';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (ws, frame) => ws.send(JSON.stringify(frame));
function tlv(types, type, data = Buffer.alloc(0)) {
    const result = Buffer.alloc(3 + data.length);
    result[0] = types.indexOf(type);
    assert.notEqual(result[0], 255, `unknown fixture message ${type}`);
    result.writeUInt16LE(data.length, 1);
    data.copy(result, 3);
    return result;
}
async function setup(t, options = {}) {
    const bridge = new AndroidBleBridge({ host: '127.0.0.1', port: 0, token, ...options });
    const errors = [];
    bridge.on('error', error => errors.push(error));
    await bridge.start();
    t.after(() => bridge.stop());
    return { bridge, errors, url: `ws://127.0.0.1:${bridge.port}/android-ble` };
}
async function companion(url) {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    await once(ws, 'open');
    const hello = once(ws, 'message');
    send(ws, { type: 'hello', version: 1 });
    assert.deepEqual(JSON.parse((await hello)[0]), { type: 'hello', version: 1 });
    return ws;
}

test('rejects malformed wire values and unsupported versions', () => {
    assert.throws(() => parseFrame(JSON.stringify({ type: 'hello', version: 2 })), /version/);
    for (const data of ['AAAA\n', 'YR==', 'A===']) {
        assert.throws(() => parseFrame(JSON.stringify({ type: 'value', deviceId: id, characteristic: 'rx', data })), /Base64/);
    }
    assert.throws(() => parseFrame('{}', true), /text/);
    assert.throws(() => parseFrame(JSON.stringify({ type: 'connected', deviceId: id, mtu: 518 })), /MTU/);
});

test('serializes complete SDK messages to ATT MTU and waits for write acknowledgement', async () => {
    const writes = [], acks = [], errors = [];
    const connection = new AndroidBleConnection({ deviceId: id, mtu: 23, messageTypes: ['a'],
        write: bytes => { writes.push(bytes); return new Promise(resolve => acks.push(resolve)); },
        onError: error => errors.push(error), disconnect() {} });
    await connection.connect();
    const operation = connection.sendTxMessages(Array.from({ length: 3 }, () => ({ type: 'a', data: Buffer.alloc(8, 42) })));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 11);
    for (let i = 0; i < 3; i++) { acks[i](); await delay(0); }
    await operation;
    assert.equal(writes.length, 3);
    assert.equal(await connection.sendTxMessages([{ type: 'a', data: Buffer.alloc(18) }]), false);
    assert.match(errors[0].message, /MTU/);
});

test('validates a whole notification before invoking SDK parsers and uses exact buffers', async () => {
    const received = [];
    const connection = new AndroidBleConnection({ deviceId: id, mtu: 517, messageTypes: ['a'],
        write: async () => {}, onError() {}, disconnect() {} });
    connection.onMessageReceived = (type, view) => received.push([type, view]);
    await connection.connect();
    const valid = tlv(['a'], 'a', Buffer.from([10, 20]));
    assert.throws(() => connection.receive('rx', Buffer.concat([valid, Buffer.from([0, 9])])), /header/);
    assert.equal(received.length, 0);
    connection.receive('rx', valid);
    assert.deepEqual([...new Uint8Array(received[0][1].buffer)], [10, 20]);
});

test('requires bearer authentication and a hello before accepting device traffic', async t => {
    const { bridge, url } = await setup(t);
    const rejected = new WebSocket(url);
    rejected.on('error', () => {});
    const [, response] = await once(rejected, 'unexpected-response');
    assert.equal(response.statusCode, 401);
    response.resume(); rejected.terminate();
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    await once(ws, 'open');
    const closed = once(ws, 'close');
    send(ws, { type: 'connected', deviceId: id, mtu: 517 });
    assert.equal((await closed)[0], 1008);
    assert.equal(bridge.active, undefined);
});

test('actual browser SDK initializes capabilities, configures 50 Hz acceleration and receives display readiness', { timeout: 3000 }, async t => {
    const sdk = await import('brilliantsole/browser');
    const { bridge, url, errors } = await setup(t, { sdk });
    const ws = await companion(url);
    const time = Buffer.alloc(8); time.writeBigUInt64LE(BigInt(Date.now()));
    const scalar = Buffer.alloc(5); scalar[0] = 1; scalar.writeFloatLE(0.001, 1);
    const responses = {
        isCharging: Buffer.from([0]), getBatteryCurrent: Buffer.alloc(4),
        getId: Buffer.from('fixture-glasses'), getMtu: Buffer.from([0, 2]),
        getName: Buffer.from('Glasses'), getType: Buffer.from([4]), getCurrentTime: time,
        getSensorConfiguration: Buffer.from([1, 20, 0]), getSensorScalars: scalar,
        getVibrationLocations: Buffer.alloc(0), getFileTypes: Buffer.alloc(0), isWifiAvailable: Buffer.from([0]),
        isDisplayAvailable: Buffer.from([1]), displayInformation: Buffer.from([0, 3, 1, 128, 2, 2, 144, 1, 3, 1]),
        displayStatus: Buffer.from([0]), getDisplayBrightness: Buffer.from([2]),
    };
    const observed = [];
    ws.on('message', raw => {
        const frame = JSON.parse(raw);
        if (frame.type !== 'write') return;
        send(ws, { type: 'writeResult', deviceId: id, requestId: frame.requestId, ok: true });
        const bytes = Buffer.from(frame.data, 'base64');
        for (let offset = 0; offset < bytes.length;) {
            const type = sdk.TxRxMessageTypes[bytes[offset]], size = bytes.readUInt16LE(offset + 1);
            observed.push(type);
            if (type === 'setSensorConfiguration') responses[type] = Buffer.from(bytes.subarray(offset + 3, offset + 3 + size));
            offset += 3 + size;
            if (responses[type]) send(ws, { type: 'value', deviceId: id, characteristic: 'rx', data: tlv(sdk.TxRxMessageTypes, type, responses[type]).toString('base64') });
            if (type === 'displayContextCommands') send(ws, { type: 'value', deviceId: id, characteristic: 'rx', data: tlv(sdk.TxRxMessageTypes, 'displayReady').toString('base64') });
        }
    });
    const ready = once(bridge, 'deviceConnected');
    send(ws, { type: 'connected', deviceId: id, mtu: 517 });
    const [device] = await ready;
    const wait = async (promise, stage) => {
        let timer;
        try { return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${stage}: ${observed.join(',')}; errors=${errors.map(e=>e.message)}`)), 1000);
        })]); } finally { clearTimeout(timer); }
    };
    assert.equal(device.isConnected, true);
    assert.equal(device.isDisplayAvailable, true);
    assert.equal(device.displayInformation.width, 640);
    assert.equal(device.displayInformation.height, 400);
    assert.ok(observed.includes('getType'));
    assert.ok(observed.includes('displayInformation'));
    await wait(device.setSensorConfiguration({ acceleration: 40 }), 'configuration40');
    await wait(device.setSensorConfiguration({ acceleration: 20 }), 'configuration20');
    assert.ok(observed.includes('setSensorConfiguration'));
    const sample = Buffer.alloc(10);
    sample.writeUInt16LE(Date.now() % 65536, 0);
    sample[2] = 1; sample[3] = 6;
    sample.writeInt16LE(1000, 4); sample.writeInt16LE(-2000, 6); sample.writeInt16LE(3000, 8);
    const acceleration = once(device, 'acceleration');
    send(ws, { type: 'value', deviceId: id, characteristic: 'rx', data: tlv(sdk.TxRxMessageTypes, 'sensorData', sample).toString('base64') });
    const [event] = await wait(acceleration, 'acceleration');
    assert.ok(Math.abs(event.message.acceleration.x - 1) < 0.00001);
    assert.ok(Math.abs(event.message.acceleration.y + 2) < 0.00001);
    const displayReady = once(device, 'displayReady');
    await device.clearDisplay(true);
    await wait(displayReady, 'display');
    assert.ok(observed.includes('displayContextCommands'));
    assert.deepEqual(errors, []);
    const disconnected = once(device, 'isConnected');
    send(ws, { type: 'disconnected', deviceId: id });
    await disconnected;
    assert.equal(device.isConnected, false);
    const resumed = once(bridge, 'deviceConnected');
    send(ws, { type: 'connected', deviceId: id, mtu: 247 });
    assert.equal((await wait(resumed, 'reconnect'))[0], device);
    assert.equal(device.connectionManager.mtu, 247);
    assert.equal(device.mtu, 247);
    assert.equal(observed.filter(type => type === 'getType').length, 2);
    const { PromptDisplay } = require('../display/lib/prompt-display');
    await wait(new PromptDisplay(device).show('Should I stop?'), '247-byte prompt');
    assert.deepEqual(errors, []);
});

test('GATT link alone is not ready; write timeout invalidates the link and late acknowledgements are harmless', async t => {
    const { bridge, url } = await setup(t, { writeTimeoutMs: 40 });
    const ws = await companion(url);
    let requestId;
    const disconnect = new Promise(resolve => ws.on('message', raw => {
        const frame = JSON.parse(raw);
        if (frame.type === 'write') requestId = frame.requestId;
        if (frame.type === 'disconnect') resolve();
    }));
    send(ws, { type: 'connected', deviceId: id, mtu: 517 });
    await delay(10);
    const entry = bridge.active;
    assert.equal(entry.device.isConnected, false);
    await disconnect;
    assert.equal(bridge.active, null);
    assert.equal(bridge.pending.size, 0);
    send(ws, { type: 'writeResult', deviceId: id, requestId, ok: false, error: 'GATT disconnected' });
    send(ws, { type: 'disconnected', deviceId: id });
    await delay(10);
    assert.equal(ws.readyState, WebSocket.OPEN);
});
