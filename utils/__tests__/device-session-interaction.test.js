const EventEmitter = require("events");
jest.mock("../../camera/lib/camera-session", () => ({
    CameraSession: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn() })),
}));
jest.mock("../../microphone/lib/microphone-session", () => ({
    MicrophoneSession: jest.fn().mockImplementation(() => ({ start: jest.fn(), stop: jest.fn() })),
}));
const { CameraSession } = require("../../camera/lib/camera-session");
const { MicrophoneSession } = require("../../microphone/lib/microphone-session");
const { DeviceSession } = require("../device-session");

let session;
const oldEnv = { ...process.env };
beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
    await session?.stop();
    process.env = { ...oldEnv };
    jest.restoreAllMocks();
});
function makeSession(properties = {}) {
    const device = new EventEmitter();
    Object.assign(device, {
        id: "frame", availableSensorTypes: ["acceleration", "orientation", "magnetometer"],
        hasCamera: true, hasMicrophone: true, isDisplayAvailable: true,
        setSensorConfiguration: jest.fn().mockResolvedValue(),
        addEventListener: device.on.bind(device), removeEventListener: device.off.bind(device),
    }, properties);
    session = new DeviceSession(device, { publish: jest.fn().mockResolvedValue() });
    return device;
}

test("interaction starts only model acceleration at 20ms, with no media or event throttle", async () => {
    process.env.VRU_INTERACTION_ENABLED = "1";
    process.env.ENABLED_SENSORS = "orientation";
    process.env.ACCELERATION_RATE = "5";
    const device = makeSession();
    const started = session.start();
    await jest.advanceTimersByTimeAsync(501);
    await started;
    expect(device.setSensorConfiguration).toHaveBeenCalledWith({ acceleration: 20 }, true);
    expect(session.sensors.getEnabledSensors()).toEqual(["acceleration"]);
    expect(CameraSession).not.toHaveBeenCalled();
    expect(MicrophoneSession).not.toHaveBeenCalled();
    const events = jest.fn();
    session.sensors.on("acceleration", events);
    device.emit("acceleration", { message: { timestamp: 0 } });
    device.emit("acceleration", { message: { timestamp: 20 } });
    expect(events).toHaveBeenCalledTimes(2);
    await session.resume();
    expect(device.setSensorConfiguration).toHaveBeenLastCalledWith({ acceleration: 20 }, true);
});

test("ordinary sessions still honor their sensor selection and start media", async () => {
    process.env.VRU_INTERACTION_ENABLED = "0";
    process.env.ENABLED_SENSORS = "orientation";
    const device = makeSession();
    const started = session.start();
    await jest.advanceTimersByTimeAsync(501);
    await started;
    expect(device.setSensorConfiguration).toHaveBeenCalledWith({ orientation: 50 }, false);
    expect(CameraSession).toHaveBeenCalledTimes(1);
    expect(MicrophoneSession).toHaveBeenCalledTimes(1);
});

test("interaction prepares supported graphics by default after sensors before becoming ready", async () => {
    process.env.VRU_INTERACTION_ENABLED = "1";
    const device = makeSession();
    let finishPreparation;
    jest.spyOn(session.actions, "preparePrompt").mockImplementation(() => {
        expect(device.setSensorConfiguration).toHaveBeenCalled();
        return new Promise((resolve) => { finishPreparation = resolve; });
    });
    const started = session.start();
    await jest.advanceTimersByTimeAsync(501);
    expect(session.ready).toBe(false);
    expect(session.publisher.publish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        status: "preparing", promptPreparation: { ready: false, mode: "preparing" },
    }));
    finishPreparation({ ready: true, mode: "sprites" });
    await started;
    expect(session.ready).toBe(true);
    expect(session.publisher.publish).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
        status: "connected", promptPreparation: { ready: true, mode: "sprites" },
    }));
});

test.each([
    ["0", true], ["1", false],
])("preparation skips ordinary or display-less sessions (%s, %s)", async (interaction, display) => {
    process.env.VRU_INTERACTION_ENABLED = interaction;
    makeSession({ availableSensorTypes: [], isDisplayAvailable: display });
    jest.spyOn(session.actions, "preparePrompt");
    await session.start();
    expect(session.actions.preparePrompt).not.toHaveBeenCalled();
    expect(session.ready).toBe(true);
    expect(session.promptPreparation).toBeNull();
});

test("unsupported sprites are explicitly ready through bitmap fallback", async () => {
    process.env.VRU_INTERACTION_ENABLED = "1";
    makeSession({ availableSensorTypes: [] });
    jest.spyOn(session.actions, "preparePrompt").mockResolvedValue({ ready: true, mode: "bitmap", reason: "unsupported" });
    await session.start();
    expect(session.ready).toBe(true);
    expect(session.promptPreparation).toEqual({ ready: true, mode: "bitmap", reason: "unsupported" });
});

test("failed sprite upload keeps the session unavailable and requires a fresh SDK connection", async () => {
    process.env.VRU_INTERACTION_ENABLED = "1";
    makeSession({ availableSensorTypes: [] });
    jest.spyOn(session.actions, "preparePrompt").mockResolvedValue({ ready: false, mode: "bitmap",
        reason: "upload_timeout", requiresReconnect: true });
    await expect(session.start()).rejects.toMatchObject({ requiresReconnect: true });
    expect(session.ready).toBe(false);
    expect(session.publisher.publish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        status: "preparation_failed", promptPreparation: expect.objectContaining({ reason: "upload_timeout" }),
    }));
    jest.spyOn(session.actions, "dispatch");
    await expect(session.dispatchAction({ action: "display.clear" })).rejects.toMatchObject({ requiresReconnect: true });
    expect(session.actions.dispatch).not.toHaveBeenCalled();
    await expect(session.start()).rejects.toMatchObject({ requiresReconnect: true });
    expect(session.actions.preparePrompt).toHaveBeenCalledTimes(1);
    // The caller observed rejection; keep the queue drained for teardown.
    await session.pendingAction.catch(() => {});
});

test("a clean reconnect resets the old graphics and prewarms again before readiness", async () => {
    process.env.VRU_INTERACTION_ENABLED = "1";
    const device = makeSession({ availableSensorTypes: [] });
    jest.spyOn(session.actions, "preparePrompt").mockResolvedValue({ ready: true, mode: "sprites" });
    const reset = jest.spyOn(session.actions, "resetPromptCache");
    await session.start();
    device.emit("isConnected", { message: { isConnected: false } });
    expect(session.ready).toBe(false);
    expect(reset).toHaveBeenCalledTimes(1);
    let finishPreparation;
    session.actions.preparePrompt.mockImplementationOnce(() => new Promise((resolve) => { finishPreparation = resolve; }));
    const resumed = session.resume();
    await jest.advanceTimersByTimeAsync(0);
    expect(session.ready).toBe(false);
    expect(reset).toHaveBeenCalledTimes(2);
    finishPreparation({ ready: true, mode: "sprites" });
    await resumed;
    expect(session.ready).toBe(true);
    expect(session.actions.preparePrompt).toHaveBeenCalledTimes(2);
});

test("preparation and display commands execute in submission order on the same queue", async () => {
    process.env.VRU_INTERACTION_ENABLED = "1";
    makeSession({ availableSensorTypes: [] });
    session.refreshCapabilities();
    session.running = true;
    const calls = [];
    let finishFirst;
    jest.spyOn(session.actions, "dispatch").mockImplementation(async ({ action }) => {
        calls.push(action);
        if (action === "first") await new Promise((resolve) => { finishFirst = resolve; });
    });
    jest.spyOn(session.actions, "preparePrompt").mockImplementation(async () => {
        calls.push("prepare"); return { ready: true, mode: "sprites" };
    });
    const first = session.dispatchAction({ action: "first" });
    const preparing = session.prepareInteractionPrompt();
    await jest.advanceTimersByTimeAsync(0);
    const last = session.dispatchAction({ action: "last" });
    expect(calls).toEqual(["first"]);
    finishFirst();
    await Promise.all([first, preparing, last]);
    expect(calls).toEqual(["first", "prepare", "last"]);
});

test("a display queued during a failed preload cannot use the tainted SDK state", async () => {
    process.env.VRU_INTERACTION_ENABLED = "1";
    makeSession({ availableSensorTypes: [] });
    session.refreshCapabilities();
    session.running = true;
    let finishPreparation;
    jest.spyOn(session.actions, "preparePrompt").mockImplementation(() => new Promise((resolve) => { finishPreparation = resolve; }));
    jest.spyOn(session.actions, "dispatch");
    const preparing = session.prepareInteractionPrompt();
    await jest.advanceTimersByTimeAsync(0);
    const displaying = session.dispatchAction({ action: "display.clear" });
    const outcomes = Promise.allSettled([preparing, displaying]);
    finishPreparation({ ready: false, mode: "bitmap", reason: "upload_failed", requiresReconnect: true });
    const results = await outcomes;
    expect(results.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(session.actions.dispatch).not.toHaveBeenCalled();
    expect(session.ready).toBe(false);
});

test("disconnect invalidates an in-flight preload without advertising readiness", async () => {
    process.env.VRU_INTERACTION_ENABLED = "1";
    const device = makeSession({ availableSensorTypes: [] });
    let finishPreparation;
    jest.spyOn(session.actions, "preparePrompt").mockImplementation(() => new Promise((resolve) => { finishPreparation = resolve; }));
    jest.spyOn(session.actions, "resetPromptCache").mockImplementation(() => {
        finishPreparation?.({ ready: false, mode: "bitmap", reason: "invalidated", requiresReconnect: true });
    });
    const started = session.start();
    const checked = expect(started).rejects.toThrow("disconnected");
    await jest.advanceTimersByTimeAsync(0);
    device.emit("isConnected", { message: { isConnected: false } });
    await checked;
    expect(session.ready).toBe(false);
    expect(session.promptRequiresReconnect).toBe(true);
    expect(session.publisher.publish.mock.calls.some(([, value]) => value.status === "connected")).toBe(false);
});
