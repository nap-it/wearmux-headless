const { LATENCY_TOPIC, captureTime, latencyEvent, createLatencyEmitter } = require("../latency-events");

test("events preserve business IDs and identify clock, process, unique record and sequence", () => {
    const first = latencyEvent("first", { event_id: "business-id" });
    const second = latencyEvent("second");
    expect(first.event_id).toBe("business-id");
    expect(first.trace_event_id).not.toBe(second.trace_event_id);
    expect(second.sequence).toBe(first.sequence + 1);
    expect(second.process_instance).toBe(first.process_instance);
    expect(first.clock_domain).toEqual(expect.any(String));
    expect(first.wall_time_ns).toMatch(/^\d+$/);
    expect(first.mono_time_ns).toMatch(/^\d+$/);
    expect(first.wall_clock_resolution_ns).toBe("1000000");
});

test("origin timestamps and nested fields are frozen before asynchronous publication", async () => {
    const publish = jest.fn().mockResolvedValue();
    const emit = createLatencyEmitter({ publish });
    const captured = captureTime();
    const fields = { inference: { score: 0.9 } };
    emit("accepted", fields, captured);
    fields.inference.score = 0;
    expect(publish).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledWith(LATENCY_TOPIC, expect.objectContaining({
        ...captured, inference: { score: 0.9 }, stage: "accepted",
    }));
});

test("a stalled telemetry publisher is bounded and never blocks or throws into runtime", async () => {
    const publish = jest.fn(() => new Promise(() => {}));
    const emit = createLatencyEmitter({ publish }, { maxPending: 2 });
    for (let n = 0; n < 10; n++) expect(() => emit("test")).not.toThrow();
    await jest.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(emit.stats()).toEqual({ pending: 2, dropped: 8, failures: 0 });
});

test.each([
    () => { throw new Error("offline"); },
    () => Promise.reject(new Error("offline")),
])("publisher failure is contained and reported on the next event", async (publish) => {
    const emitter = createLatencyEmitter({ publish });
    emitter("test");
    await jest.advanceTimersByTimeAsync(0);
    expect(emitter.stats()).toEqual({ pending: 0, dropped: 0, failures: 1 });
});
