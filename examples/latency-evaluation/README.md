# Latency Evaluation

Hardware latency evaluation example for a host-side browser display and a BrilliantSole camera.

## What it measures

The example:
- hosts a fullscreen browser page that flips between `red` and `green`
- repeatedly triggers camera captures
- when the camera recognizes the currently displayed color, it immediately flips the page to the other color
- records both raw wall-clock E2E latency and a browser-adjusted E2E latency that subtracts the browser paint delay
- records the camera image timestamp reported by the SDK for each recognized frame
- rejects runs where the browser reports a paint delay above the configured budget

This is a practical end-to-end host-display-to-camera latency check. Run the script on a machine that can host the web page, open the page fullscreen on the display the device camera is pointed at, and then let the example drive the color flips.

## Run

```bash
npm run examples:latency
```

When it starts, it prints one or more URLs. Open one of them in a browser on the screen the camera is looking at. The page is designed to work on another machine, tablet, or phone if the host itself has no GUI.

## Useful environment variables

```bash
CAMERA_LATENCY_MEASUREMENTS=20 \
CAMERA_LATENCY_OUTPUT=./camera-latency.json \
CAMERA_LATENCY_SCREEN_HOST=0.0.0.0 \
CAMERA_LATENCY_SCREEN_PORT=8765 \
CAMERA_RESOLUTION=320 \
CAMERA_QUALITY_FACTOR=85 \
npm run examples:latency
```

- `CAMERA_LATENCY_MEASUREMENTS`: number of recognition-driven latency measurements to collect, default `12`; set to `0` for a continuous test
- `CAMERA_LATENCY_OUTPUT`: optional JSON path for raw samples and summary
- `CAMERA_LATENCY_COLOR_RATIO`: red-vs-green dominance ratio threshold, default `1.15`
- `CAMERA_LATENCY_COLOR_GAP`: minimum average channel gap, default `12`
- `CAMERA_LATENCY_TIMEOUT_MS`: per-flip timeout in ms, default `8000`
- `CAMERA_LATENCY_SCREEN_HOST`: bind host for the browser color screen, default `0.0.0.0`
- `CAMERA_LATENCY_SCREEN_PORT`: bind port for the browser color screen, default `8765`
- `CAMERA_LATENCY_REQUIRE_VIEWER`: require at least one browser screen connection before starting, default `1`
- `CAMERA_LATENCY_BROWSER_ACK_TIMEOUT_MS`: how long to wait for each browser paint acknowledgement, default `1000`

For faster sampling, lower `CAMERA_RESOLUTION` and `CAMERA_QUALITY_FACTOR`.

In continuous mode, stop the run with `Ctrl-C`. The script will finish the current capture, print a summary for the collected samples, and then exit.

The browser page now removes animated transitions and reports a paint acknowledgement for every color change. The example fails if the browser-reported paint delay exceeds the configured budget.
The browser paint-delay budget is fixed at `10ms`, the viewer wait timeout is fixed at `120000ms`, the start color is fixed at `green`, and color detection uses a fixed center ROI ratio of `0.5`.

The console output now reports:
- browser-adjusted E2E latency: raw E2E latency minus browser paint delay
- raw wall-clock E2E latency: from server-side flip dispatch to image receipt
- browser paint delay
- color-analysis time, which is reported separately and is not included in the E2E latency calculation
- `cameraTimestamp` for each recognized frame

`cameraTimestamp` comes from the SDK camera image metadata. It is useful for frame tracking, but it is not guaranteed to be a true sensor exposure timestamp.

For a strict sub-10ms budget, open the browser on the same machine that is driving the tested display. If you open the page on another device over the network, transport latency and that device's own display pipeline are outside the browser paint-delay check and can still affect the end-to-end result.
