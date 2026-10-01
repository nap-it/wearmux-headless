const { PromptDisplay } = require("../lib/prompt-display");

function device(mtu = 247) {
    const listeners = new Set();
    const fake = { displayInformation: { width: 640, height: 400 }, mtu, isDisplayReady: true, listeners };
    for (const method of [
        "setDisplayColor", "setDisplayOpacity", "selectDisplayBackgroundColor",
        "selectDisplayBitmapColors", "setDisplayHorizontalAlignment",
        "setDisplayVerticalAlignment", "resetDisplayBitmapScale", "clearDisplay",
        "drawDisplayBitmap", "showDisplay",
        "selectDisplayLineColor", "setDisplayIgnoreFill", "setDisplayIgnoreLine",
        "setDisplayLineWidth", "drawDisplayRect", "clearDisplayRotation",
        "clearDisplayCrop", "clearDisplayRotationCrop",
    ]) fake[method] = jest.fn().mockResolvedValue(undefined);
    fake.addEventListener = jest.fn((event, listener) => listeners.add(listener));
    fake.removeEventListener = jest.fn((event, listener) => listeners.delete(listener));
    fake.emitReady = () => {
        fake.isDisplayReady = true;
        for (const listener of [...listeners]) listener();
    };
    fake.showDisplay.mockImplementation(async () => {
        fake.isDisplayReady = false;
        fake.emitReady();
    });
    return fake;
}

function simpleDisplay(fake) {
    const display = new PromptDisplay(fake);
    jest.spyOn(display, "_layout").mockResolvedValue({
        blocks: [
            { x: 4, y: 4, width: 1, height: 1, pixels: [1] },
            { x: 4, y: 12, width: 1, height: 1, pixels: [1] },
        ],
        frame: { x: 1, y: 1, width: 7, height: 7, lineWidth: 2 },
        questionFontSize: 12,
        hintFontSize: 8,
    });
    return display;
}

function expectLayoutInsideDisplay(layout, width, height) {
    const { blocks, frame } = layout;
    expect(blocks).toHaveLength(2);
    const [question, hint] = blocks;
    for (const block of blocks) {
        expect(block.pixels).toHaveLength(block.width * block.height);
        expect(block.x).toBeGreaterThanOrEqual(0);
        expect(block.y).toBeGreaterThanOrEqual(0);
        expect(block.x + block.width).toBeLessThanOrEqual(width);
        expect(block.y + block.height).toBeLessThanOrEqual(height);
        expect(Math.abs(block.x + block.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    }
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.y).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(width);
    expect(frame.y + frame.height).toBeLessThanOrEqual(height);
    expect(question.x).toBeGreaterThan(frame.x + frame.lineWidth);
    expect(question.y).toBeGreaterThan(frame.y + frame.lineWidth);
    expect(question.x + question.width).toBeLessThan(frame.x + frame.width - frame.lineWidth);
    expect(question.y + question.height).toBeLessThan(frame.y + frame.height - frame.lineWidth);
    expect(Math.abs(question.x + question.width / 2 - frame.x - frame.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(question.y + question.height / 2 - frame.y - frame.height / 2)).toBeLessThanOrEqual(1);
    expect(hint.y).toBeGreaterThan(frame.y + frame.height);
    expect(Math.abs((frame.y + hint.y + hint.height) / 2 - height / 2)).toBeLessThanOrEqual(1);
    expect(layout.questionFontSize).toBeLessThanOrEqual(72);
    expect(layout.hintFontSize).toBeLessThanOrEqual(32);
}

test.each([23, 64, 247, 512])("draws bounded one-bit tiles at MTU %i, then makes one visible update", async (mtu) => {
    const fake = device(mtu);
    const display = new PromptDisplay(fake);
    await display.show("Should I stop?");

    const layout = [...display.cache.values()][0];
    const { blocks, frame } = layout;
    expectLayoutInsideDisplay(layout, 640, 400);
    expect(layout.questionFontSize).toBeGreaterThan(50);
    expect(layout.questionFontSize).toBeGreaterThan(layout.hintFontSize);
    expect(frame.lineWidth).toBe(6);
    const pixelCount = blocks.reduce((count, block) => count + block.pixels.length, 0);
    // Text remains cropped; the native frame must not become a full-screen bitmap.
    expect(pixelCount).toBeLessThan(640 * 400 / 4);
    let transferredPixels = 0;
    for (const [x, y, bitmap, immediate] of fake.drawDisplayBitmap.mock.calls) {
        expect(bitmap.numberOfColors).toBe(2);
        expect(bitmap.pixels.every((pixel) => pixel === 0 || pixel === 1)).toBe(true);
        expect(Math.ceil(bitmap.pixels.length / 8) + 21).toBeLessThanOrEqual(mtu);
        expect(bitmap.pixels.length).toBe(bitmap.width * bitmap.height);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + bitmap.width).toBeLessThanOrEqual(640);
        expect(y + bitmap.height).toBeLessThanOrEqual(400);
        expect(immediate).toBe(false);
        transferredPixels += bitmap.pixels.length;
    }
    expect(transferredPixels).toBe(pixelCount);
    expect(fake.clearDisplay).toHaveBeenCalledWith(false);
    expect(fake.showDisplay).toHaveBeenCalledTimes(1);
    expect(fake.showDisplay).toHaveBeenCalledWith(true);
    expect(fake.drawDisplayRect).toHaveBeenCalledTimes(1);
    const strokeExpansion = 2 * Math.ceil(frame.lineWidth / 2);
    expect(fake.drawDisplayRect).toHaveBeenCalledWith(
        frame.x, frame.y, frame.width - strokeExpansion, frame.height - strokeExpansion, false);
    expect(fake.setDisplayColor).toHaveBeenCalledWith(1, "#FFFFFF", false);
    expect(fake.setDisplayColor).toHaveBeenCalledWith(2, "#FFD05A", false);
    expect(fake.selectDisplayLineColor).toHaveBeenCalledWith(2, false);
    expect(fake.setDisplayIgnoreFill).toHaveBeenCalledWith(true, false);
    expect(fake.setDisplayIgnoreLine).toHaveBeenCalledWith(false, false);
    expect(fake.setDisplayLineWidth).toHaveBeenCalledWith(6, false);
    expect(fake.selectDisplayLineColor).toHaveBeenLastCalledWith(1, false);
    expect(fake.setDisplayIgnoreFill).toHaveBeenLastCalledWith(false, false);
    expect(fake.setDisplayLineWidth).toHaveBeenLastCalledWith(0, false);
    expect(fake.selectDisplayBitmapColors).toHaveBeenCalledWith([
        { bitmapColorIndex: 0, colorIndex: 0 },
        { bitmapColorIndex: 1, colorIndex: 1 },
    ], false);
    for (const method of ["clearDisplayRotation", "clearDisplayCrop", "clearDisplayRotationCrop"]) {
        expect(fake[method]).toHaveBeenCalledWith(false);
        expect(fake[method].mock.invocationCallOrder[0]).toBeLessThan(fake.drawDisplayRect.mock.invocationCallOrder[0]);
    }
    expect(fake.clearDisplay.mock.invocationCallOrder[0]).toBeLessThan(fake.drawDisplayBitmap.mock.invocationCallOrder[0]);
    expect(fake.clearDisplay.mock.invocationCallOrder[0]).toBeLessThan(fake.drawDisplayRect.mock.invocationCallOrder[0]);
    expect(fake.showDisplay.mock.invocationCallOrder[0]).toBeGreaterThan(fake.drawDisplayBitmap.mock.invocationCallOrder.at(-1));
    expect(fake.showDisplay.mock.invocationCallOrder[0]).toBeGreaterThan(fake.drawDisplayRect.mock.invocationCallOrder[0]);
});

test("keeps the gesture hint explicit beneath the emphasized question", async () => {
    const display = new PromptDisplay(device());
    const render = jest.spyOn(display, "_renderText");
    await display.show("Should I stop?");
    expect(render).toHaveBeenCalledWith("Should I stop?", expect.any(Number), undefined, true);
    expect(render.mock.calls.some(([text]) => text === "Nod yes · Shake no")).toBe(true);
    expectLayoutInsideDisplay([...display.cache.values()][0], 640, 400);
});

test("uses a white frame on a monochrome display without changing one-bit text", async () => {
    const fake = device();
    fake.displayInformation.pixelDepth = "1";
    await new PromptDisplay(fake).show("Should I stop?");
    expect(fake.selectDisplayLineColor).toHaveBeenCalledWith(1, false);
    expect(fake.setDisplayColor.mock.calls.some(([slot]) => slot === 2)).toBe(false);
    expect(fake.drawDisplayRect).toHaveBeenCalledTimes(1);
    expect(fake.drawDisplayBitmap.mock.calls.every(([, , bitmap]) => bitmap.numberOfColors === 2)).toBe(true);
    expect(fake.showDisplay).toHaveBeenCalledTimes(1);
});

test("refits and recenters both text blocks and frame when the display size changes", async () => {
    const fake = device();
    const display = new PromptDisplay(fake);
    const render = jest.spyOn(display, "_layout");
    await display.show("Should I stop?");
    const original = [...display.cache.values()][0];
    fake.displayInformation = { width: 320, height: 240 };
    await display.show("Should I stop?");
    const resized = [...display.cache.values()][1];
    expect(render).toHaveBeenCalledTimes(2);
    expectLayoutInsideDisplay(resized, 320, 240);
    expect(resized.questionFontSize).toBeLessThan(original.questionFontSize);
    expect(resized.hintFontSize).toBeLessThanOrEqual(original.hintFontSize);
    await display.show("Should I stop?");
    expect(render).toHaveBeenCalledTimes(2);
});

test("reuses prepared pixels but redraws after clears; bounds the host cache", async () => {
    const fake = device();
    const display = new PromptDisplay(fake);
    const render = jest.spyOn(display, "_layout");
    await display.show("Should I stop?");
    await display.show("Should I stop?");
    expect(render).toHaveBeenCalledTimes(1);
    expect(fake.showDisplay).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 9; index++) await display.show(`Question ${index}?`);
    expect(display.cache.size).toBe(8);
});

test("fits long custom questions without truncating and escapes markup", async () => {
    const display = new PromptDisplay(device());
    const text = "Proceed only when everyone, including children & cyclists, is clear of the vehicle <and> it is safe?";
    const render = jest.spyOn(display, "_renderText");
    await display.show(text);
    expect(render).toHaveBeenCalledWith(text, expect.any(Number), expect.any(Number), true);
    expectLayoutInsideDisplay([...display.cache.values()][0], 640, 400);
});

test("fails explicitly instead of drawing a clipped question on a tiny display", async () => {
    const fake = device();
    fake.displayInformation = { width: 64, height: 16 };
    const display = new PromptDisplay(fake);
    await expect(display.show("Should I stop?")).rejects.toThrow(/does not fit|do not fit/);
    expect(fake.clearDisplay).not.toHaveBeenCalled();
});

test("reports opt-in host timing, cache hits, and bytes actually passed to the SDK", async () => {
    const previousTiming = process.env.DISPLAY_TIMING;
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    process.env.DISPLAY_TIMING = "1";
    try {
        const fake = device();
        const display = new PromptDisplay(fake);
        await display.show("Should I stop?");
        const tileCount = fake.drawDisplayBitmap.mock.calls.length;
        const packedBitmapBytes = fake.drawDisplayBitmap.mock.calls.reduce(
            (total, [, , bitmap]) => total + Math.ceil(bitmap.pixels.length / 8), 0);
        expect(log).toHaveBeenLastCalledWith("[Prompt display timing]", expect.objectContaining({
            cache: "miss",
            prepareMs: expect.any(Number),
            previousReadyWaitMs: expect.any(Number),
            drawAndFlushMs: expect.any(Number),
            readyWaitMs: expect.any(Number),
            tileCount,
            packedBitmapBytes,
            bitmapCommandBytes: packedBitmapBytes + tileCount * 14,
        }));
        await display.show("Should I stop?");
        expect(log).toHaveBeenLastCalledWith("[Prompt display timing]", expect.objectContaining({ cache: "hit" }));
    } finally {
        log.mockRestore();
        if (previousTiming === undefined) delete process.env.DISPLAY_TIMING;
        else process.env.DISPLAY_TIMING = previousTiming;
    }
});

test("keeps show pending until displayReady after the SDK flush, then removes the listener", async () => {
    const fake = device();
    let sent;
    const flushed = new Promise((resolve) => { sent = resolve; });
    fake.showDisplay.mockImplementation(async () => { fake.isDisplayReady = false; sent(); });
    let settled = false;
    const showing = simpleDisplay(fake).show("Question?").then(() => { settled = true; });
    await flushed;
    expect(settled).toBe(false);
    expect(fake.listeners.size).toBe(1);
    fake.emitReady();
    await showing;
    expect(settled).toBe(true);
    expect(fake.listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
});

test("drains a preceding displayReady before drawing and still requires the new acknowledgement", async () => {
    const fake = device();
    fake.isDisplayReady = false;
    let attached;
    const waiting = new Promise((resolve) => { attached = resolve; });
    fake.addEventListener.mockImplementation((event, listener) => { fake.listeners.add(listener); attached(); });
    let sent;
    const flushed = new Promise((resolve) => { sent = resolve; });
    fake.showDisplay.mockImplementation(async () => { fake.isDisplayReady = false; sent(); });
    let settled = false;
    const showing = simpleDisplay(fake).show("Question?").then(() => { settled = true; });
    await waiting;
    expect(fake.clearDisplay).not.toHaveBeenCalled();
    fake.emitReady();
    await flushed;
    expect(settled).toBe(false);
    expect(fake.listeners.size).toBe(1);
    fake.emitReady();
    await showing;
    expect(fake.removeEventListener).toHaveBeenCalledTimes(2);
    expect(fake.listeners.size).toBe(0);
});

test("times out a missing acknowledgement and removes its listener and timer", async () => {
    const fake = device();
    let sent;
    const flushed = new Promise((resolve) => { sent = resolve; });
    fake.showDisplay.mockImplementation(async () => { sent(); });
    const showing = simpleDisplay(fake).show("Question?");
    const failed = expect(showing).rejects.toThrow("Timed out waiting for displayReady");
    await flushed;
    await jest.advanceTimersByTimeAsync(3000);
    await failed;
    expect(fake.listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
});

test("removes the ready listener and timer when sending throws immediately", async () => {
    const fake = device();
    fake.showDisplay.mockImplementation(() => { throw new Error("BLE write failed"); });
    await expect(simpleDisplay(fake).show("Question?")).rejects.toThrow("BLE write failed");
    expect(fake.listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
});

test("also bounds an unfinished flush and handles its late rejection", async () => {
    const fake = device();
    let sent;
    const sending = new Promise((resolve) => { sent = resolve; });
    let rejectSend;
    fake.showDisplay.mockImplementation(() => {
        fake.emitReady();
        sent();
        return new Promise((resolve, reject) => { rejectSend = reject; });
    });
    const showing = simpleDisplay(fake).show("Question?");
    const failed = expect(showing).rejects.toThrow("Timed out waiting for displayReady");
    await sending;
    await jest.advanceTimersByTimeAsync(3000);
    await failed;
    rejectSend(new Error("Late BLE write failure"));
    await Promise.resolve();
    expect(fake.listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
});
