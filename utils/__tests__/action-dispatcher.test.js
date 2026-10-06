const EventEmitter = require("events");
const { ActionDispatcher, ACTION_TOPIC, RESULT_TOPIC } = require("../action-dispatcher");

jest.mock("../../display/lib/text-display", () => ({
    TextDisplay: jest.fn().mockImplementation(() => ({
        loadFont: jest.fn().mockResolvedValue(undefined),
        showText: jest.fn().mockResolvedValue(undefined),
    })),
}));
const { TextDisplay } = require("../../display/lib/text-display");
jest.mock("../../display/lib/prompt-display", () => ({
    PromptDisplay: jest.fn().mockImplementation(() => ({
        show: jest.fn().mockResolvedValue(undefined),
        clear: jest.fn().mockResolvedValue(undefined),
    })),
}));
const { PromptDisplay } = require("../../display/lib/prompt-display");

class FakeTransport extends EventEmitter {
    constructor() {
        super();
        this.start = jest.fn().mockResolvedValue(undefined);
        this.stop = jest.fn().mockResolvedValue(undefined);
        this.publish = jest.fn().mockResolvedValue(undefined);
    }
}

function fakeDevice() {
    return {
        id: "device-1",
        name: "Test wearable",
        isConnected: true,
        isDisplayAvailable: true,
        vibrationLocations: ["front"],
        triggerVibration: jest.fn().mockResolvedValue(undefined),
        clearDisplay: jest.fn().mockResolvedValue(undefined),
        showDisplay: jest.fn().mockResolvedValue(undefined),
    };
}

test("incoming action is dispatched and a correlated result is published", async () => {
    const device = fakeDevice();
    const publisher = new FakeTransport();
    const subscriber = new FakeTransport();
    const dispatcher = new ActionDispatcher(device, { transport: "mqtt", publisher, subscriber });

    await dispatcher.start();
    subscriber.emit("message", { key: ACTION_TOPIC, payload: { id: "test-1", action: "haptic.vibrate" } });
    await dispatcher._pending;

    expect(device.triggerVibration).toHaveBeenCalledWith([{
        type: "waveformEffect",
        segments: [{ effect: "strongClick100" }],
    }]);
    expect(publisher.publish).toHaveBeenCalledWith(RESULT_TOPIC, expect.objectContaining({
        id: "test-1", action: "haptic.vibrate", ok: true, device: { id: "device-1", name: "Test wearable" },
    }));
    await dispatcher.stop();
});

test("unsupported actions report an error without touching the device", async () => {
    const device = fakeDevice();
    const publisher = new FakeTransport();
    const subscriber = new FakeTransport();
    const dispatcher = new ActionDispatcher(device, { transport: "mqtt", publisher, subscriber });

    await dispatcher.start();
    subscriber.emit("message", { key: ACTION_TOPIC, payload: { id: "bad-1", action: "unknown" } });
    await dispatcher._pending;

    expect(publisher.publish).toHaveBeenCalledWith(RESULT_TOPIC, expect.objectContaining({
        id: "bad-1", action: "unknown", ok: false,
    }));
    expect(device.triggerVibration).not.toHaveBeenCalled();
    expect(device.clearDisplay).not.toHaveBeenCalled();
    await dispatcher.stop();
});

test("display.clear uses the acknowledged clear path without an extra show", async () => {
    const device = fakeDevice();
    const publisher = new FakeTransport();
    const subscriber = new FakeTransport();
    const dispatcher = new ActionDispatcher(device, { transport: "mqtt", publisher, subscriber });

    await dispatcher.start();
    subscriber.emit("message", { key: ACTION_TOPIC, payload: { id: "clear-1", action: "display.clear" } });
    await dispatcher._pending;

    expect(PromptDisplay.mock.results.at(-1).value.clear).toHaveBeenCalledTimes(1);
    expect(device.showDisplay).not.toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledWith(RESULT_TOPIC, expect.objectContaining({
        id: "clear-1", ok: true,
    }));
    await dispatcher.stop();
});

test("display.clear does not finish until the renderer acknowledges it", async () => {
    const dispatcher = new ActionDispatcher(fakeDevice(), { transport: "mqtt" });
    await dispatcher.dispatch({ action: "display.prompt", text: "Should I stop?" });
    const renderer = PromptDisplay.mock.results.at(-1).value;
    let acknowledge;
    renderer.clear.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    let finished = false;
    const clearing = dispatcher.dispatch({ action: "display.clear" }).then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    acknowledge();
    await clearing;
    expect(finished).toBe(true);
});

test("display.text uses the existing wearable text renderer", async () => {
    const device = fakeDevice();
    const publisher = new FakeTransport();
    const subscriber = new FakeTransport();
    const dispatcher = new ActionDispatcher(device, { transport: "mqtt", publisher, subscriber });

    await dispatcher.start();
    subscriber.emit("message", { key: ACTION_TOPIC, payload: {
        id: "text-1", action: "display.text", text: "Look left",
    } });
    await dispatcher._pending;

    const textDisplay = TextDisplay.mock.results.at(-1).value;
    expect(textDisplay.loadFont).toHaveBeenCalled();
    expect(textDisplay.showText).toHaveBeenCalledWith("Look left", { clearBefore: true });
    expect(publisher.publish).toHaveBeenCalledWith(RESULT_TOPIC, expect.objectContaining({ ok: true }));
    await dispatcher.stop();
});

test("actions addressed to another device are ignored", async () => {
    const device = fakeDevice();
    const publisher = new FakeTransport();
    const subscriber = new FakeTransport();
    const dispatcher = new ActionDispatcher(device, { transport: "mqtt", publisher, subscriber });

    await dispatcher.start();
    subscriber.emit("message", { key: ACTION_TOPIC, payload: {
        id: "other", deviceId: "device-2", action: "display.clear",
    } });
    await dispatcher._pending;

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(device.clearDisplay).not.toHaveBeenCalled();
    await dispatcher.stop();
});

test("display.prompt uses a persistent renderer and invalidates image palette caches", async () => {
    const dispatcher = new ActionDispatcher(fakeDevice(), { transport: "mqtt" });
    const invalidatePaletteCache = jest.fn();
    dispatcher.displayManager = { invalidatePaletteCache };
    await dispatcher.dispatch({ action: "display.prompt", text: "Should I stop?" });
    const renderer = PromptDisplay.mock.results.at(-1).value;
    await dispatcher.dispatch({ action: "display.prompt", text: "Should I stop?" });
    expect(renderer.show).toHaveBeenCalledTimes(2);
    expect(renderer.show).toHaveBeenCalledWith("Should I stop?");
    expect(invalidatePaletteCache).toHaveBeenCalledTimes(2);
    await expect(dispatcher.dispatch({ action: "display.prompt", text: "x".repeat(501) })).rejects.toThrow("1–500");
    expect(renderer.show).toHaveBeenCalledTimes(2);
});
