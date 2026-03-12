const {
    summarizeLatencySamples,
} = require("../lib/latency-utils");

describe("latency-utils", () => {
    test("summarizes latency samples", () => {
        const summary = summarizeLatencySamples([10, 20, 30, 40, 50]);

        expect(summary).toEqual(
            expect.objectContaining({
                count: 5,
                minMs: 10,
                maxMs: 50,
                meanMs: 30,
                medianMs: 30,
                p90Ms: 46,
                p95Ms: 48,
            })
        );
        expect(summary.stdDevMs).toBeCloseTo(Math.sqrt(200), 5);
    });

    test("returns null for empty input", () => {
        expect(summarizeLatencySamples([])).toBeNull();
    });

    test("handles single-element input", () => {
        const summary = summarizeLatencySamples([42]);
        expect(summary.count).toBe(1);
        expect(summary.minMs).toBe(42);
        expect(summary.maxMs).toBe(42);
        expect(summary.meanMs).toBe(42);
        expect(summary.medianMs).toBe(42);
    });
});
