const { RemoteInferencePipeline, extractAcceleration, topResult, buildInferencePayload } = require("../inference/remote-inference");

jest.mock("../../utils/zenoh-subscriber", () => ({
    ZenohSubscriber: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        start: jest.fn().mockResolvedValue(),
        stop: jest.fn().mockResolvedValue(),
    })),
}));

jest.mock("../../utils/zenoh-manager", () => ({
    ZenohManager: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        start: jest.fn().mockResolvedValue(),
        stop: jest.fn().mockResolvedValue(),
        publish: jest.fn().mockResolvedValue(),
    })),
}));

jest.mock("../lib/ml/ml-gesture-detector", () => {
    const EventEmitter = require("events");
    return jest.fn().mockImplementation(() => {
        const emitter = new EventEmitter();
        emitter.initialized = true;
        emitter.initError = null;
        emitter.addSample = jest.fn();
        emitter.ready = jest.fn().mockResolvedValue();
        return emitter;
    });
});

// ── extractAcceleration ────────────────────────────────────────────────────

describe("extractAcceleration", () => {
    test("returns acc from valid payload", () => {
        const payload = { message: { acceleration: { x: 1, y: 2, z: 3 } } };
        expect(extractAcceleration(payload)).toEqual({ x: 1, y: 2, z: 3 });
    });

    test("returns null when message is missing", () => {
        expect(extractAcceleration({})).toBeNull();
    });

    test("returns null when acceleration is missing", () => {
        expect(extractAcceleration({ message: {} })).toBeNull();
    });

    test("returns null when payload is null", () => {
        expect(extractAcceleration(null)).toBeNull();
    });

    test("returns null when axis values are not numbers", () => {
        const payload = { message: { acceleration: { x: "a", y: 0, z: 0 } } };
        expect(extractAcceleration(payload)).toBeNull();
    });

    test("returns null when an axis is undefined", () => {
        const payload = { message: { acceleration: { x: 1, y: 2 } } };
        expect(extractAcceleration(payload)).toBeNull();
    });
});

// ── topResult ──────────────────────────────────────────────────────────────

describe("topResult", () => {
    test("returns the label with highest value", () => {
        const results = [
            { label: "idle", value: 0.1 },
            { label: "nod", value: 0.85 },
            { label: "shake", value: 0.05 },
        ];
        expect(topResult(results)).toEqual({ label: "nod", value: 0.85 });
    });

    test("returns the single result if only one", () => {
        const results = [{ label: "nod", value: 0.9 }];
        expect(topResult(results)).toEqual({ label: "nod", value: 0.9 });
    });

    test("returns null for empty array", () => {
        expect(topResult([])).toBeNull();
    });

    test("returns null for null", () => {
        expect(topResult(null)).toBeNull();
    });

    test("returns null for undefined", () => {
        expect(topResult(undefined)).toBeNull();
    });
});

// ── buildInferencePayload ──────────────────────────────────────────────────

describe("buildInferencePayload", () => {
    test("includes gesture, confidence, results, and ts", () => {
        const top = { label: "nod", value: 0.9 };
        const results = [top, { label: "idle", value: 0.1 }];
        const before = Date.now();
        const payload = buildInferencePayload(top, results);
        const after = Date.now();

        expect(payload.gesture).toBe("nod");
        expect(payload.confidence).toBe(0.9);
        expect(payload.results).toBe(results);
        expect(payload.ts).toBeGreaterThanOrEqual(before);
        expect(payload.ts).toBeLessThanOrEqual(after);
    });
});

// ── RemoteInferencePipeline.handleMessage ──────────────────────────────────

describe("RemoteInferencePipeline.handleMessage", () => {
    function makePipeline(opts = {}) {
        return new RemoteInferencePipeline({ confidenceThreshold: 0.7, ...opts });
    }

    test("feeds valid acceleration to detector", () => {
        const pipeline = makePipeline();
        const payload = { message: { acceleration: { x: 0.1, y: 0.2, z: 0.9 } } };

        pipeline.handleMessage({ payload });

        expect(pipeline.detector.addSample).toHaveBeenCalledWith({ accX: 0.1, accY: 0.2, accZ: 0.9 });
    });

    test("ignores message with no acceleration", () => {
        const pipeline = makePipeline();
        pipeline.handleMessage({ payload: { message: {} } });
        expect(pipeline.detector.addSample).not.toHaveBeenCalled();
    });

    test("ignores null payload", () => {
        const pipeline = makePipeline();
        pipeline.handleMessage({ payload: null });
        expect(pipeline.detector.addSample).not.toHaveBeenCalled();
    });

    test("increments sampleCount on valid message", () => {
        const pipeline = makePipeline();
        const payload = { message: { acceleration: { x: 0, y: 0, z: 1 } } };
        pipeline.handleMessage({ payload });
        pipeline.handleMessage({ payload });
        expect(pipeline.sampleCount).toBe(2);
    });

    test("does not increment sampleCount for invalid message", () => {
        const pipeline = makePipeline();
        pipeline.handleMessage({ payload: {} });
        expect(pipeline.sampleCount).toBe(0);
    });
});

// ── RemoteInferencePipeline.handleInferenceResult ──────────────────────────

describe("RemoteInferencePipeline.handleInferenceResult", () => {
    function makePipeline(opts = {}) {
        return new RemoteInferencePipeline({ confidenceThreshold: 0.7, debug: true, ...opts });
    }

    test("publishes when top result meets threshold", async () => {
        const pipeline = makePipeline();
        const result = { results: [{ label: "nod", value: 0.85 }, { label: "idle", value: 0.15 }] };

        await pipeline.handleInferenceResult(result);

        expect(pipeline.publisher.publish).toHaveBeenCalledWith(
            "bsole/inference/gesture",
            expect.objectContaining({ gesture: "nod", confidence: 0.85 })
        );
    });

    test("does not publish when top result is below threshold", async () => {
        const pipeline = makePipeline({ confidenceThreshold: 0.9 });
        const result = { results: [{ label: "nod", value: 0.6 }] };

        await pipeline.handleInferenceResult(result);

        expect(pipeline.publisher.publish).not.toHaveBeenCalled();
    });

    test("does not publish for empty results", async () => {
        const pipeline = makePipeline();
        await pipeline.handleInferenceResult({ results: [] });
        expect(pipeline.publisher.publish).not.toHaveBeenCalled();
    });

    test("does not publish for null result", async () => {
        const pipeline = makePipeline();
        await pipeline.handleInferenceResult(null);
        expect(pipeline.publisher.publish).not.toHaveBeenCalled();
    });

    test("publish payload contains results array", async () => {
        const pipeline = makePipeline();
        const results = [{ label: "shake", value: 0.8 }, { label: "idle", value: 0.2 }];

        await pipeline.handleInferenceResult({ results });

        const published = pipeline.publisher.publish.mock.calls[0][1];
        expect(published.results).toEqual(results);
    });

    test("warns but does not throw when publish fails", async () => {
        const pipeline = makePipeline();
        pipeline.publisher.publish.mockRejectedValueOnce(new Error("UDS disconnected"));
        const warnSpy = jest.spyOn(console, "warn").mockImplementation();

        const result = { results: [{ label: "nod", value: 0.9 }] };
        await expect(pipeline.handleInferenceResult(result)).resolves.not.toThrow();

        expect(warnSpy).toHaveBeenCalledWith("[publish error]", "UDS disconnected");
        warnSpy.mockRestore();
    });

    test("publishes to configured prefix topic", async () => {
        const pipeline = makePipeline({ pubPrefix: "custom/prefix" });
        const result = { results: [{ label: "nod", value: 0.9 }] };

        await pipeline.handleInferenceResult(result);

        expect(pipeline.publisher.publish).toHaveBeenCalledWith(
            "custom/prefix/gesture",
            expect.anything()
        );
    });
});
