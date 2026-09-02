# Edge Impulse Model Directory

This directory contains trained **Edge Impulse WebAssembly models** for gesture recognition.

## Required Files

After training and exporting your model from Edge Impulse Studio, place these files here:

- **`edge-impulse-standalone.js`** - WebAssembly runtime and model loader
- **`edge-impulse-standalone.wasm`** - Compiled neural network model

## How to Get Your Model

### 1. Train Your Model

Use the workflow documented in [`sensors/README.md`](../README.md):

1. Collect training data using `collect-training-data.js`
2. Upload to [Edge Impulse Studio](https://studio.edgeimpulse.com/)
3. Design impulse and train neural network

### 2. Export for Node.js

In Edge Impulse Studio:

1. Go to **Deployment** tab
2. Select **WebAssembly**
3. Click **Build**
4. Download the generated `.zip` file
5. Extract and place both `.js` and `.wasm` files in this directory

### 3. Verify Installation

Your directory should look like this:

```
model/
├── README.md (this file)
├── edge-impulse-standalone.js
└── edge-impulse-standalone.wasm
```

## Usage

The model is automatically loaded by:

- **`real-time-ml-gesture.js`** - Real-time gesture detection
- **`lib/ei-classifier.js`** - Edge Impulse classifier wrapper

No manual configuration needed - just place the files here and run!

## Model Information

**Typical Model Specs:**
- Input: 6 features (accX, accY, accZ, heading, pitch, roll)
- Window: 30 samples (600ms at 20Hz)
- Output: Gesture probabilities
- Size: 30-100KB
- Inference time: 5-15ms

## Updating Your Model

To update with a new trained model:

1. Train new version in Edge Impulse Studio
2. Export as WebAssembly
3. Replace existing files in this directory
4. Restart `real-time-ml-gesture.js`

## Troubleshooting

### "Model not found" error
- Ensure both `.js` and `.wasm` files are present
- Check file names match exactly: `edge-impulse-standalone.*`
- Verify files are not corrupted (re-download if needed)

### Low accuracy
- Retrain with more diverse data
- Check confusion matrix in Edge Impulse Studio
- Review the confusion matrix and validation metrics for the intended deployment data.

## Resources

- [Edge Impulse Documentation](https://docs.edgeimpulse.com/)
- [Sensor and ML utilities](../README.md)