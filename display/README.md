# Display Module

Utilities for displaying images on BrilliantSole devices from a Node.js environment.

This module provides a simple API to:
- Connect to a BrilliantSole device
- Convert images (PNG/JPEG) into the device's expected pixel format
- Upload frames or slideshows to the device display

## Features

- Image loading via `sharp` (PNG/JPEG/WebP) or Buffer
- Auto-resize and letterbox to device resolution
- Dithering and palette reduction for low-color displays (1/2/4 bpp)
- Push a single image or run a slideshow with a configurable interval

## Install Dependencies

This module uses `sharp` for image processing and `rgbquant` for palette reduction (2/4bpp). Install them in your workspace:

```bash
npm install sharp rgbquant
```

## Quick Start

```js
const { DisplayManager } = require('./display/lib/display-manager');

(async () => {
  const dm = new DisplayManager();
  await dm.connect();
  await dm.showImageFile('path/to/image.png', { fit: 'cover' });
})();
```

Or via the provided entry:

```bash
# From the repo root (npm will pass the arg to the script)
npm run display -- ./path/to/image.png

# Or directly
node display/index.js ./path/to/image.png
```

To prefer the height-first flow (smaller upload, scaled-up on device):

```bash
DISPLAY_INPUT_HEIGHT=120 DISPLAY_OUTPUT_HEIGHT=240 npm run display -- ./sample.png
```

## API

- `new DisplayManager(options?)`
  - options:
    - `deviceManager`: optional, reuse an existing DeviceManager
    - `x`, `y`: default position (top-left)
    - `width`, `height`: default output size (fallback if device info isn't available)
    - `inputHeight`: processing height (smaller = faster upload)
    - `outputHeight`: on-device bitmap scale target (upscale drawn size)
    - `pixelDepth`: 1|2|4 (palette depth bits)
    - `brightness`: veryLow|low|medium|high|veryHigh
    - `tileMaxPixels`: internal tile size in pixels (default 220; pass via code option)

- `connect()`
  - Connects to a BrilliantSole device and initializes display settings.

- `showImageFile(filePath, opts)`
  - Loads, resizes, and displays an image on the device.
  - opts:
    - `x`, `y`: destination position (top-left)
    - `inputHeight`: process/quantize to this height (smaller uploads)
    - `outputHeight`: draw scaled to this height on-device (faster + larger display)
    - `outWidth`, `outHeight`: legacy destination size; height-first flow is preferred
    - `pixelDepth`: 1, 2, or 4 (default 4)
    - `fit`: 'cover'|'contain'|'fill' (default 'contain')
    - `align`: 'center'|'top'|'bottom'|'left'|'right' (default 'center')

- `showImageBuffer(buffer, mimeType, opts)`
  - Same as above but accepts raw buffers.

- `slideshow(files, intervalMs, opts)`
  - Cycles through a list of files at `intervalMs` per frame.

## Environment variables

- DISPLAY_X, DISPLAY_Y: top-left draw position
- DISPLAY_INPUT_HEIGHT: processing height for quantization and upload
- DISPLAY_OUTPUT_HEIGHT: scaled display height on device
- DISPLAY_PIXEL_DEPTH: 1|2|4 bits (2, 4, 16 colors)
- DISPLAY_BRIGHTNESS: veryLow|low|medium|high|veryHigh
- DISPLAY_FIT: contain|cover|fill|inside|outside
- DISPLAY_ALIGN: top|bottom|left|right|center

Note: `tileMaxPixels` is configurable via the `DisplayManager` constructor option, not via env.

## Notes

- Devices may have different pixel formats or color depths. This module attempts a sensible default and uses SDK methods when available.
- The manager aligns drawing to top-left and will briefly set brightness (default: medium) to ensure the panel is visible.
- Use `DEBUG=1` to see detailed logs and inferred device capabilities.
