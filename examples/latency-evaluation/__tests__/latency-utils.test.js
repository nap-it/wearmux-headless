const sharp = require("sharp");
const {
    buildSolidColorFrame,
    detectDominantColor,
    summarizeLatencySamples,
} = require("../lib/latency-utils");

async function buildBorderedFrame({ width, height, borderColor, centerColor, inset }) {
    const base = await sharp({
        create: {
            width,
            height,
            channels: 3,
            background: borderColor,
        },
    })
        .png()
        .toBuffer();

    const center = await sharp({
        create: {
            width: width - inset * 2,
            height: height - inset * 2,
            channels: 3,
            background: centerColor,
        },
    })
        .png()
        .toBuffer();

    return sharp(base)
        .composite([{ input: center, left: inset, top: inset }])
        .png()
        .toBuffer();
}

describe("latency-utils", () => {
    test("detects a red frame", async () => {
        const frame = await buildSolidColorFrame(96, 60, "#ff0000");
        const detection = await detectDominantColor(frame);

        expect(detection.color).toBe("red");
        expect(detection.means.red).toBeGreaterThan(detection.means.green);
        expect(detection.confidence).toBeGreaterThan(1);
    });

    test("detects green from the central ROI even with a red border", async () => {
        const frame = await buildBorderedFrame({
            width: 160,
            height: 100,
            borderColor: "#ff0000",
            centerColor: "#00ff00",
            inset: 40,
        });

        const detection = await detectDominantColor(frame, {
            roiWidthRatio: 0.35,
            roiHeightRatio: 0.35,
        });

        expect(detection.color).toBe("green");
        expect(detection.means.green).toBeGreaterThan(detection.means.red);
    });

    test("returns unknown when the frame is effectively grayscale", async () => {
        const frame = await buildSolidColorFrame(96, 60, "#808080");
        const detection = await detectDominantColor(frame);

        expect(detection.color).toBe("unknown");
        expect(detection.confidence).toBe(0);
    });

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
});
