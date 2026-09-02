# Camera Capture

The camera module supports both single-shot and continuous auto-capture modes with configurable quality settings.

## Single Capture

```bash
npm run camera
```

Takes one picture and exits. The device sends multiple images per capture; the script automatically selects the largest/best quality image.

## Continuous Auto-Capture

```bash
CAMERA_AUTO_PICTURE=1 CAMERA_OUTPUT_DIR=./images npm run camera
```

Continuously captures images until stopped (Ctrl+C). Features:
- **Auto-focus** (enabled by default): Focuses before each capture for best quality
- **Configurable delay**: Add `CAMERA_AUTO_DELAY=<ms>` to control capture rate
- **Browser viewer**: Add `CAMERA_VIEW_ENABLE=1` for real-time viewing

## Examples

**Fast continuous capture (no delay, auto-focus enabled):**
```bash
CAMERA_AUTO_PICTURE=1 \
CAMERA_OUTPUT_DIR=./images \
CAMERA_VIEW_ENABLE=1 \
npm run camera
```

**Slow capture with 3-second delay:**
```bash
CAMERA_AUTO_PICTURE=1 \
CAMERA_AUTO_DELAY=3000 \
CAMERA_OUTPUT_DIR=./images \
npm run camera
```

**High-speed capture without auto-focus:**
```bash
CAMERA_AUTO_PICTURE=1 \
CAMERA_AUTO_FOCUS=0 \
CAMERA_OUTPUT_DIR=./images \
npm run camera
```

**Custom quality settings:**
```bash
CAMERA_AUTO_PICTURE=1 \
CAMERA_RESOLUTION=1280 \
CAMERA_QUALITY_FACTOR=100 \
CAMERA_OUTPUT_DIR=./images \
npm run camera
```

**With MJPEG browser viewer (lower latency):**
```bash
CAMERA_AUTO_PICTURE=1 \
CAMERA_VIEW_ENABLE=1 \
CAMERA_VIEW_MJPEG=1 \
CAMERA_OUTPUT_DIR=./images \
npm run camera
# View at http://127.0.0.1:8099
```

## Notes
- Images are saved with timestamps: a timestamped `.jpg` filename
- If `CAMERA_OUTPUT_DIR` is not set, images are captured but not saved to disk
- The browser viewer auto-refreshes or streams via MJPEG depending on `CAMERA_VIEW_MJPEG`
- Use `DEBUG=1` or `CAMERA_DEBUG=1` for verbose logging

## Related Example

A separate headless latency utility lives under [examples/latency-evaluation](../examples/latency-evaluation/README.md). It does not reproduce the Android camera benchmark reported in the WearMux paper. Run it with:

```bash
npm run examples:latency
```
