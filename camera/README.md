# Camera Capture

The camera module supports both single-shot and continuous auto-capture modes with configurable quality settings.

Run the commands below from the repository root. The npm command loads `config/camera.ini`, which enables continuous capture and the MJPEG viewer, with autofocus disabled. Shell variables override these settings. Camera capabilities and resolution values depend on the connected device.

## Single Capture

```bash
CAMERA_AUTO_PICTURE=0 npm run camera
```

Takes one picture and exits. If the device returns multiple candidate images, the script selects the largest image that passes the configured size filter.

## Continuous Auto-Capture

```bash
CAMERA_AUTO_PICTURE=1 CAMERA_OUTPUT_DIR=./images npm run camera
```

Continuously captures images until stopped (Ctrl+C). Options:

- **Autofocus**: Set `CAMERA_AUTO_FOCUS=1` to focus before each capture
- **Configurable delay**: Add `CAMERA_AUTO_DELAY=<ms>` to control capture rate
- **Browser viewer**: Add `CAMERA_VIEW_ENABLE=1` for real-time viewing

## Examples

**Continuous capture with autofocus and no added delay:**

```bash
CAMERA_AUTO_PICTURE=1 \
CAMERA_AUTO_FOCUS=1 \
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
CAMERA_RESOLUTION=480 \
CAMERA_QUALITY_FACTOR=80 \
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

- Images are saved with timestamps: `bwear-2026-02-02T16-20-01-123Z-0000.jpg`
- If `CAMERA_OUTPUT_DIR` is not set, images are captured but not saved to disk
- The browser viewer auto-refreshes or streams via MJPEG depending on `CAMERA_VIEW_MJPEG`
- Use `DEBUG=1` or `CAMERA_DEBUG=1` for verbose logging

See the [camera configuration reference](../docs/technical-guide.md#camera) for timeouts, viewer settings, and device-specific controls.

## Related Example

The display-to-camera latency workflow lives under [examples/latency-evaluation](../examples/latency-evaluation/README.md). It opens a fullscreen host window instead of using a browser. Run it with:

```bash
npm run examples:latency
```
