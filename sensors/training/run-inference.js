// This script demonstrates how to use the Edge Impulse WebAssembly (Node.js, SIMD) model

const ei = require('../model/edge-impulse-standalone.js');

async function runInference(inputFeatures) {
    // inputFeatures: Array of numbers, e.g. [accX, accY, accZ, heading, pitch, roll, ...]
    // The length and order must match your model's expected input
    await ei.init();
    const result = await ei.classify(inputFeatures);
    console.log('Inference result:', result);
    return result;
}

module.exports = { runInference };
