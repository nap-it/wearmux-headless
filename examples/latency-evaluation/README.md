# Latency Evaluation

Display-to-camera latency example for a BrilliantSole camera using a local fullscreen host window.

## What it does

The example opens a fullscreen red/green window on the host display, then loops like this:

1. The host window shows a solid color.
2. The glasses capture one image.
3. The host classifies the image as mostly `red`, `green`, or `unknown`.
4. When the expected color is recognized, the host flips the window to the opposite color.
5. The latency timer starts when the host window confirms that the new color has actually been presented.
6. The timer stops when the host receives the first matching camera image for that new color.

This keeps the measurement focused on:

- host display presentation
- camera capture and transfer
- host-side JPEG assembly
- host-side red/green classification

There is no browser or web server in this flow.

## Run

Run it on the desktop host that owns the display the camera is watching:

```bash
npm run examples:latency
```

`npm run` now loads [`config/config.ini`](../../config/config.ini) automatically through the wrapper scripts, so you can test directly on the host without rebuilding Docker.

The example requires:

- `python3`
- `tkinter` available in that Python
- a graphical desktop session so the fullscreen window can open

Press `Esc` on the fullscreen window or `Ctrl+C` in the terminal to stop.

## Useful settings

Add these to [`config/config.ini`](../../config/config.ini) or export them inline before `npm run`. Inline environment values win over the INI file:

```bash
CAMERA_LATENCY_MEASUREMENTS=12 \
CAMERA_LATENCY_TIMEOUT_MS=8000 \
CAMERA_LATENCY_CAMERA_RATE=10 \
CAMERA_LATENCY_OUTPUT=./logs/camera-latency.json \
npm run examples:latency
```

- `CAMERA_LATENCY_MEASUREMENTS`: number of red/green flips to measure; `0` means run until stopped
- `CAMERA_LATENCY_TIMEOUT_MS`: max time to wait for the camera to see each new color
- `CAMERA_LATENCY_CAMERA_RATE`: camera sensor rate used for `takePicture()`
- `CAMERA_LATENCY_WARMUP_ATTEMPTS`: number of startup captures used to lock onto the initial color
- `CAMERA_LATENCY_OUTPUT`: optional JSON file for raw samples and summary
- `CAMERA_AUTO_FOCUS=1`: focus once before the test starts
- `BSOLE_PYTHON_BIN`: override the Python executable if `python3` is not the right one

The console prints:

- end-to-end latency from host-window presentation to matching camera frame receipt
- host-window presentation delay
- device-reported image latency from the SDK
- color-analysis time

If you want to compare against the normal camera path, run:

```bash
npm run camera
```

That uses the same host-side config loading, but it is not a latency benchmark.
