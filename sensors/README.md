# Sensor Monitoring

Real-time sensor data collection and ML-based gesture detection for BrilliantSole Frame glasses.

## Quick Start

```bash
# Basic sensor monitoring with ML gestures
node index.js

# Interactive menu (includes ML gesture option)
node index-menu.js

# Standalone ML gesture recognition
node real-time-ml-gesture.js
```

## Available Scripts

**index.js** - Monitor all enabled sensors with real-time display
**index-menu.js** - Interactive menu
**pressure-map.js** - Per-sensor pressure visualization

**inference/real-time-ml-gesture.js** - Real-time ML gesture recognition
**inference/tflite-runner.js** - On-device TFLite inference

**training/collect-training-data.js** - Collect labeled sensor data for ML training
**training/run-inference.js** - Test Edge Impulse WASM model inference
**training/run-impulse.js** - Edge Impulse classifier wrapper

## ML Gesture Recognition

1. Collect training data:
   ```bash
   node training/collect-training-data.js --label nod --duration 60
   ```

2. Train model at [Edge Impulse Studio](https://studio.edgeimpulse.com/)

3. Export as WebAssembly and place in `model/` directory

4. Run inference:
   ```bash
   node inference/real-time-ml-gesture.js
   ```

## Configuration

**Sensor rates** via environment variables:
```bash
ACCELERATION=20 ORIENTATION=20 node index.js
```

Supported sensors: acceleration, gyroscope, magnetometer, orientation, tapDetector

**ML gesture detection**:
- Enabled by default in `index.js` if model exists
- Disable with: `ML_GESTURES=0 node index.js`
- In `index-menu.js`: select option 3 for ML gestures
- Requires trained Edge Impulse model in `model/` directory

## Debug Mode

Enable verbose logging:
```bash
DEBUG=1 node index.js
```

## Directory Structure

```text
sensors/
├── index.js                        # General sensor monitoring
├── index-menu.js                   # Interactive menu
├── pressure-map.js                 # Pressure map visualization
├── inference/                      # Runtime ML inference scripts
│   ├── real-time-ml-gesture.js     # Real-time Edge Impulse gesture detection
│   └── tflite-runner.js            # On-device TFLite inference
├── training/                       # ML development scripts
│   ├── collect-training-data.js    # Collect labeled sensor data
│   ├── run-inference.js            # Test Edge Impulse WASM inference
│   └── run-impulse.js              # Edge Impulse classifier wrapper
├── lib/                            # Sensor utilities
│   ├── sensor-manager.js           # Core sensor management
│   ├── motion-sensors.js           # Motion sensor handlers
│   ├── activity-sensors.js         # Activity sensor handlers
│   └── ml/                         # ML-specific utilities
│       ├── ml-gesture-detector.js  # Gesture detection logic
│       └── ei-classifier.js        # Edge Impulse classifier wrapper
└── model/                          # Model files (.tflite, Edge Impulse WASM)
```
