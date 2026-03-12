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
    percentile,
    summarizeLatencySamples,
};
