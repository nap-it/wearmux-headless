# Microphone Utilities

This directory contains scripts and utilities for working with microphones exposed through the Brilliant Wear / BrilliantSole SDK, including real-time streaming, recording, and voice activity detection (VAD).

## Contents

- `index.js` — Real-time microphone streaming and audio level display.
- `record-audio.js` — Record audio samples from the device to a file.
- `lib/audio-utils.js` — Audio processing helper functions.
- `recordings/` — Local output directory for saved audio recordings (ignored by Git).

## Usage

Each script can be run directly with Node.js. Example:

```sh
node index.js
```

Refer to comments at the top of each script for specific options and environment variables.

## Notes

- Ensure your device is powered on and in range before running these scripts.
- For advanced configuration, see the environment variable options in each script.

---
