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
**collect-training-data.js** - Collect labeled sensor data for ML training  
**real-time-ml-gesture.js** - Standalone ML gesture recognition

## ML Gesture Recognition

1. Collect training data:
   ```bash
   node collect-training-data.js --label nod --duration 60
   ```

2. Train model at [Edge Impulse Studio](https://studio.edgeimpulse.com/)

3. Export as WebAssembly and place in `model/` directory

4. Run inference:
   ```bash
   node real-time-ml-gesture.js
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

```
sensors/
├── index.js                     # Basic monitoring
├── index-menu.js                # Interactive menu
├── collect-training-data.js     # ML data collection
├── real-time-ml-gesture.js      # ML inference
├── lib/                         # Sensor utilities
└── model/                       # Edge Impulse models
```
