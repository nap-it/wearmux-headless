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
function makeSession() {
    const device = new EventEmitter();
    Object.assign(device, {
        id: "frame", availableSensorTypes: ["acceleration", "orientation", "magnetometer"],
        hasCamera: true, hasMicrophone: true, isDisplayAvailable: true,
        setSensorConfiguration: jest.fn().mockResolvedValue(),
        addEventListener: device.on.bind(device), removeEventListener: device.off.bind(device),
    });
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
