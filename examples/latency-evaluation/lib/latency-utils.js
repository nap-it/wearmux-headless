const sharp = require("sharp");

const COLOR_HEX = Object.freeze({
    red: "#ff0000",
    green: "#00ff00",
});

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getCentralRegion(width, height, roiWidthRatio, roiHeightRatio) {
    const cropWidth = Math.max(1, Math.round(width * roiWidthRatio));
    const cropHeight = Math.max(1, Math.round(height * roiHeightRatio));

    return {
        left: Math.max(0, Math.floor((width - cropWidth) / 2)),
        top: Math.max(0, Math.floor((height - cropHeight) / 2)),
        width: cropWidth,
        height: cropHeight,
    };
}

async function buildSolidColorFrame(width, height, color) {
    return sharp({
        create: {
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
            channels: 3,
            background: color,
        },
    })
        .png()
        .toBuffer();
}

async function detectDominantColor(imageBuffer, options = {}) {
    const analysisSize = Math.max(16, Math.round(toFiniteNumber(options.analysisSize, 96)));
    const roiWidthRatio = clamp(toFiniteNumber(options.roiWidthRatio, 0.5), 0.05, 1);
    const roiHeightRatio = clamp(toFiniteNumber(options.roiHeightRatio, 0.5), 0.05, 1);
    const minMeanIntensity = Math.max(0, toFiniteNumber(options.minMeanIntensity, 20));
    const minDominanceRatio = Math.max(1, toFiniteNumber(options.minDominanceRatio, 1.15));
    const minChannelGap = Math.max(0, toFiniteNumber(options.minChannelGap, 12));

    const { data, info } = await sharp(imageBuffer)
        .rotate()
        .resize({
            width: analysisSize,
            height: analysisSize,
            fit: "inside",
            withoutEnlargement: true,
        })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const region = getCentralRegion(info.width, info.height, roiWidthRatio, roiHeightRatio);
    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;
    let pixels = 0;

    for (let y = region.top; y < region.top + region.height; y += 1) {
        const rowOffset = y * info.width * info.channels;
        for (let x = region.left; x < region.left + region.width; x += 1) {
            const idx = rowOffset + x * info.channels;
            redSum += data[idx];
            greenSum += data[idx + 1];
            blueSum += data[idx + 2];
            pixels += 1;
        }
    }

    const redMean = redSum / pixels;
    const greenMean = greenSum / pixels;
    const blueMean = blueSum / pixels;
    const redVsGreenRatio = greenMean > 0 ? redMean / greenMean : Infinity;
    const greenVsRedRatio = redMean > 0 ? greenMean / redMean : Infinity;
    const redGap = redMean - greenMean;
    const greenGap = greenMean - redMean;

    let color = "unknown";
    if (
        redMean >= minMeanIntensity &&
        redVsGreenRatio >= minDominanceRatio &&
        redGap >= minChannelGap &&
        redMean - blueMean >= minChannelGap / 2
    ) {
        color = "red";
    } else if (
        greenMean >= minMeanIntensity &&
        greenVsRedRatio >= minDominanceRatio &&
        greenGap >= minChannelGap &&
        greenMean - blueMean >= minChannelGap / 2
    ) {
        color = "green";
    }

    let confidence = 0;
    if (color === "red") {
        confidence = Math.min(redVsGreenRatio / minDominanceRatio, redGap / Math.max(1, minChannelGap));
    } else if (color === "green") {
        confidence = Math.min(greenVsRedRatio / minDominanceRatio, greenGap / Math.max(1, minChannelGap));
    }

    return {
        color,
        confidence,
        pixels,
        region,
        means: {
            red: redMean,
            green: greenMean,
            blue: blueMean,
        },
        ratios: {
            redVsGreen: redVsGreenRatio,
            greenVsRed: greenVsRedRatio,
        },
    };
}

function percentile(sortedValues, percentileValue) {
    if (sortedValues.length === 0) return null;
    if (sortedValues.length === 1) return sortedValues[0];

    const rank = (sortedValues.length - 1) * percentileValue;
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);

    if (lowerIndex === upperIndex) {
        return sortedValues[lowerIndex];
    }

    const weight = rank - lowerIndex;
    return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

function summarizeLatencySamples(samples) {
    const values = samples
        .map((sample) => Number(sample))
        .filter((sample) => Number.isFinite(sample));

    if (values.length === 0) {
        return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const meanMs = sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length;
    const variance = sorted.reduce((sum, sample) => sum + (sample - meanMs) ** 2, 0) / sorted.length;

    return {
        count: sorted.length,
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        meanMs,
        medianMs: percentile(sorted, 0.5),
        p90Ms: percentile(sorted, 0.9),
        p95Ms: percentile(sorted, 0.95),
        stdDevMs: Math.sqrt(variance),
    };
}

module.exports = {
    COLOR_HEX,
    buildSolidColorFrame,
    detectDominantColor,
    percentile,
    summarizeLatencySamples,
};
