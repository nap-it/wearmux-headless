# Display Module

Utilities for displaying images on Brilliant Wear devices from a Node.js environment.

This module provides a simple API to:
- Connect to a Brilliant Wear device
- Convert images (PNG/JPEG) into the device's expected pixel format
- Upload frames or slideshows to the device display

## Features

- Image loading via `sharp` (PNG/JPEG/WebP) or Buffer
- Auto-resize and letterbox to device resolution
- Dithering and palette reduction for low-color displays (1/2/4 bpp)
- Push a single image or run a slideshow with a configurable interval
- Compact yes/no prompts through the `display.prompt` action

## Interaction prompts

The VRU interaction uses `display.prompt` with **Should I stop?**, a question
from the approaching vehicle. Large bold white text sits inside a thick amber
frame, with **Nod yes · Shake no** below it. The whole group is centered.
The question uses the largest fitting font up to 60 px at 640 × 400, preferring
one line; the gesture hint uses up to 28 px and the frame a 6 px stroke with
48 px side margins. Layout
sizes scale with display dimensions. Long custom questions wrap without
silently dropping text; questions that cannot fit at a readable size are rejected.
Two-color displays keep the frame white instead of using an unavailable palette slot.

![Example VRU question on a 640 by 400 display](assets/vru-prompt-preview.png)

`PromptDisplay` renders the question and hint as separate cropped black/white,
one-bit bitmaps, caches up to eight prepared layouts, and splits transfers to
fit the device MTU. The amber frame uses the SDK rectangle primitive, so it adds
only drawing commands without a larger bitmap or higher text pixel depth.
It drains any pending `displayReady`, sends `clearDisplay(true)`, and waits for
the clear's own acknowledgement before drawing. It then queues the frame and
text, sends one final display update, and waits for a separate acknowledgement
before allowing gesture monitoring to start. Each acknowledgement wait is
bounded to three seconds and a missing acknowledgement fails the prompt.

The SDK's `sendImmediately=false` batches transport only: commands are sent as
soon as the MTU buffer fills. It does not make a clear plus drawing atomic.
Both `clear` and `show` mark the display busy. Drawing during an unfinished
Frame buffer clear/switch can lose early pixels; a late clear acknowledgement
could also be mistaken for the final show's acknowledgement. The separate
waits prevent those overlaps. The `display.clear` action uses the same
acknowledged clear path without issuing a redundant `show` afterward.
Packed pixel data depends on the question, font availability, and display size.

Set `DISPLAY_TIMING=1` to log cache hits, preparation time, palette/setup time,
`clearAndReadyMs`, drawing/SDK flush time, previous/final acknowledgement waits, tile count, packed pixel
bytes, and bitmap command bytes. Command bytes
include bitmap headers but exclude palette/setup commands and transport
overhead. The timing measures host processing, SDK calls, and receipt of the
device acknowledgement; it does not measure the physical display optically.

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
  - Connects to a Brilliant Wear device and initializes display settings.

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
