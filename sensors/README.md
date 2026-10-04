# Sensor Monitoring

Monitor motion, pressure, and activity sensors exposed by compatible SDK devices. Optional scripts run gesture inference on the host or TFLite inference on supported device firmware.

## Quick Start

Run commands from the repository root. npm loads the INI configuration, and shell variables override its values:

```bash
npm run sensors
```

The standalone monitor defaults to acceleration, magnetometer, orientation, and tap detection. Use `ENABLED_SENSORS` to select another set supported by your device:

```bash
ENABLED_SENSORS=acceleration,gyroscope ACCELERATION_RATE=20 GYROSCOPE_RATE=20 npm run sensors
```

Unlike the standalone monitor, `npm run sessions` uses each device's reported sensor capabilities when `ENABLED_SENSORS` is unset. See the [sensor configuration reference](../docs/technical-guide.md#sensors) for sensor names and rates.

For an interactive menu, run:

```bash
node tools/run-with-config.js sensors/index-menu.js
```

## Available Scripts

| Command | Purpose |
| --- | --- |
| `npm run sensors` | Display readings from the selected sensors |
| `npm run sensors:pressure-map` | Visualize readings from a pressure-capable device |
| `npm run sensors:ml-gesture` | Run the bundled gesture model on the host |
| `npm run sensors:tflite` | Upload and run a TFLite model on compatible device firmware |
| `npm run sensors:remote-inference` | Send sensor data to the configured remote inference service |
| `npm run sensors:inference` | Exercise the host-side model inference workflow |
| `npm run sensors:collect-training` | Collect labeled sensor data for training |

## Gesture Models and Training

The repository sets `ML_GESTURES=0` in `config/ml.ini`. To enable gesture detection alongside the standalone sensor monitor:

```bash
ML_GESTURES=1 npm run sensors
```

The dedicated `sensors:ml-gesture` command loads the bundled BrilliantWear Edge Impulse WebAssembly model. See the [model guide](model/README.md) for its input contract, provenance, and update procedure. Copying another export into `sensors/model/` does not replace the bundled model selected by the classifier.

To collect labeled training data:

```bash
npm run sensors:collect-training -- --label nod --duration 60
```

The collector saves data under `training-data/` and currently records acceleration and orientation at 20 Hz. This training format differs from the bundled gesture model's input contract; adapt the collector and inference pipeline together when training a replacement.

## Debugging

```bash
DEBUG=1 npm run sensors
```

For connection and transport failures, use the shared [troubleshooting guide](../docs/technical-guide.md#troubleshooting). Avoid running this standalone monitor and `npm run sessions` against the same BLE device at the same time.
