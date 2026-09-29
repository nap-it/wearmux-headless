jest.mock("../../camera/lib/camera-session", () => ({ CameraSession: jest.fn() }));
jest.mock("../../microphone/lib/microphone-session", () => ({ MicrophoneSession: jest.fn() }));
const WebSocket = require("ws");
const { WearOsServer } = require("../wearos-device");
const { DeviceSession } = require("../device-session");

// Real sockets need real timers.
jest.useRealTimers();

const HELLO = {
    type: "hello", id: "wearos-test", name: "Galaxy Watch8",
    sensors: ["acceleration", "gyroscope", "magnetometer", "heartRate"], vibration: true,
};
const oldEnv = { ...process.env };
let server;
let session;
let clients;

beforeEach(async () => {
    process.env = { ...oldEnv };
    delete process.env.ENABLED_SENSORS;
    delete process.env.VRU_INTERACTION_ENABLED;
    delete process.env.TOPIC_PREFIX;
    jest.spyOn(console, "log").mockImplementation(() => {});
    clients = [];
    server = new WearOsServer({ port: 0, host: "127.0.0.1" });
    await server.start();
});

afterEach(async () => {
    await session?.stop();
    session = null;
    for (const client of clients) client.terminate();
    await server.stop();
    process.env = { ...oldEnv };
    jest.restoreAllMocks();
});

// Connects a fake watch and records every packet the host sends to it.
async function connectWatch(hello = HELLO) {
    const client = new WebSocket(`ws://127.0.0.1:${server.port}`);
    clients.push(client);
    client.received = [];
    client.on("message", (data) => client.received.push(JSON.parse(data.toString())));
    await new Promise((resolve) => client.once("open", resolve));
    client.send(JSON.stringify(hello));
    return client;
}

const waitFor = async (check, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

async function startSession() {
    const devices = [];
    server.on("device", (device) => devices.push(device));
    const watch = await connectWatch();
    await waitFor(() => devices.length === 1);
    const publisher = { publish: jest.fn().mockResolvedValue() };
    session = new DeviceSession(devices[0], publisher);
    await session.start();
    return { watch, device: devices[0], publisher };
}

test("a watch hello becomes a session with sensor and haptic capabilities only", async () => {
    const { watch } = await startSession();
    expect(session.info).toEqual({ id: "wearos-test", name: "Galaxy Watch8" });
    expect(session.capabilities).toEqual({
        sensors: ["acceleration", "magnetometer", "gyroscope", "heartRate"],
        camera: false, microphone: false, display: false, haptics: true,
    });
    await waitFor(() => watch.received.some((packet) => packet.type === "config"));
    expect(watch.received.find((packet) => packet.type === "config").sensors).toEqual({
        acceleration: 50, magnetometer: 50, gyroscope: 50, heartRate: 1000,
    });
});

test("watch samples are published with the SDK payload shape", async () => {
    const { watch, publisher } = await startSession();
    watch.send(JSON.stringify({ type: "sensor", sensor: "acceleration", timestamp: 1234, x: 0.1, y: 0.2, z: 9.8 }));
    await waitFor(() => publisher.publish.mock.calls.some(([key]) => key === "bwear/sensors/acceleration"));
    watch.send(JSON.stringify({ type: "sensor", sensor: "heartRate", timestamp: 1300, bpm: 72 }));
    await waitFor(() => publisher.publish.mock.calls.some(([key]) => key === "bwear/sensors/heartRate"));
    const payload = (sensor) => publisher.publish.mock.calls.find(([key]) => key === `bwear/sensors/${sensor}`)[1];
    expect(payload("acceleration")).toMatchObject({
        sensor: "acceleration", device: { id: "wearos-test", name: "Galaxy Watch8" },
        message: { sensorType: "acceleration", timestamp: 1234, acceleration: { x: 0.1, y: 0.2, z: 9.8 } },
    });
    expect(payload("heartRate").message).toEqual({ sensorType: "heartRate", timestamp: 1300, heartRate: 72 });
});

test("haptic.vibrate is forwarded to the watch", async () => {
    const { watch } = await startSession();
    await session.dispatchAction({ action: "haptic.vibrate" });
    await waitFor(() => watch.received.some((packet) => packet.type === "vibrate"));
    expect(watch.received.find((packet) => packet.type === "vibrate")).toEqual({ type: "vibrate", effect: "strongClick100" });
});

test("a reconnecting watch keeps its device and gets its sensor configuration back", async () => {
    const { watch, device } = await startSession();
    const statuses = jest.fn();
    device.addEventListener("isConnected", (event) => statuses(event.message.isConnected));
    watch.close();
    await waitFor(() => device.isConnected === false);

    const again = [];
    server.on("device", (item) => again.push(item));
    const second = await connectWatch();
    await waitFor(() => again.length === 1 && device.isConnected);
    expect(again[0]).toBe(device);
    await waitFor(() => second.received.filter((packet) => packet.type === "config").length >= 2);
    expect(second.received[0].sensors).toEqual(expect.objectContaining({ acceleration: 50, heartRate: 1000 }));
    expect(statuses.mock.calls).toEqual([[false], [true]]);
    await waitFor(() => session.ready);
});

test("a connection that does not start with hello is closed", async () => {
    const devices = [];
    server.on("device", (device) => devices.push(device));
    const client = await connectWatch({ type: "sensor", sensor: "acceleration" });
    const code = await new Promise((resolve) => client.once("close", resolve));
    expect(code).toBe(1008);
    expect(devices).toHaveLength(0);
});
