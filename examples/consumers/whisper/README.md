# whisper — speech-to-text consumer

Optional real-time transcription consumer for WearMux Headless. It runs outside the core service and can run on another machine.

Subscribes to the raw audio stream published by `microphone/index.js`, accumulates
fixed-size windows, runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
inference, and publishes transcripts back onto the transport layer.

```
microphone/index.js  ──(bwear/microphone/raw/**)──►  examples/consumers/whisper/runner.py
                                                            │
                                                   bwear/whisper/transcript
                                                            │
                                                     Python subscribers
                                                     glasses-controller
                                                     ...
```

---

## Prerequisites

1. **Install this example's Python dependencies** (from the repository root or the copied `consumers/` directory):
   ```bash
   cd examples/consumers  # or the copied consumers/ directory
   python3 -m venv .venv
   .venv/bin/pip install -r whisper/requirements.txt
   ```

2. **Enable raw audio publishing** in `config/audio.ini`:
   ```ini
   MIC_RAW_ENABLE=1
   ```
   This is enabled by default. Without it the microphone only publishes level metrics, not samples.

3. **Start the selected transport.** For Zenoh, start a router (default `tcp/127.0.0.1:7447`):
   ```bash
   docker compose up -d zenoh-router
   ```

---

## Running

```bash
# Terminal 1, from the WearMux Headless repository — stream mic audio
npm run microphone:rtsp

# Terminal 2, from consumers/ — transcribe (can be another host)
.venv/bin/python whisper/runner.py

# Terminal 3, from consumers/ — read transcripts
.venv/bin/python whisper/listen.py
```

`listen.py` uses Zenoh. For MQTT, subscribe to `bwear/whisper/transcript` (or the configured `TOPIC_PREFIX`) with an MQTT client. When running on another machine, set `ZENOH_ROUTER` or `MQTT_BROKER_URL` to the reachable endpoint and set `MESSAGE_TRANSPORT` to match WearMux Headless.

---

## Configuration (`examples/consumers/whisper/config.ini`)

The example reads shared transport settings from the repository's `config/` directory when present, then reads its own `config.ini`. Shell variables take precedence. A copied `examples/consumers/` directory can run without the main repository configuration.

### Model

| Variable | Default | Description |
|---|---|---|
| `WHISPER_MODEL` | `tiny` | Model size: `tiny` `base` `small` `medium` `large-v3` |
| `WHISPER_DEVICE` | `cpu` | `cpu`, `cuda`, or `auto` |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8`, `float16`, `float32` |

### Language

| Variable | Default | Description |
|---|---|---|
| `WHISPER_LANGUAGE` | _(empty)_ | BCP-47 code (`en`, `pt`…) or empty for auto-detect |
| `WHISPER_AUTODETECT_WINDOWS` | `3` | Windows to sample before locking via majority vote |
| `WHISPER_AUTODETECT_EVERY` | `0` | Re-detect every N windows after locking; `0` = lock forever |

When `WHISPER_LANGUAGE` is empty, the runner samples the first 3 windows (15 s at default window size), takes the majority-voted language, and locks to it. This makes detection robust against the occasional misidentification that `tiny` produces on short clips. Each vote is logged — watch for `language vote N/3` then `language locked: pt`.

### Audio window

| Variable | Default | Description |
|---|---|---|
| `WHISPER_WINDOW_S` | `5` | Seconds to accumulate before each inference call |
| `WHISPER_OVERLAP` | `0` | Fraction of window kept as overlap (0–0.9). `0.5` = 50% overlap, 2× inference cost |

### Quality

| Variable | Default | Description |
|---|---|---|
| `WHISPER_NO_SPEECH_THRESHOLD` | `0.6` | Drop windows where all segments exceed this no-speech probability |
| `WHISPER_WORD_TIMESTAMPS` | `0` | Set to `1` for per-word timing in payload (~10–20% slower) |

### Transport

| Variable | Default | Description |
|---|---|---|
| `MESSAGE_TRANSPORT` | `zenoh` | Select `mqtt` or `zenoh`; set in the shell on a separate host |
| `TOPIC_PREFIX` | `bwear` | Shared root for input and output topics |
| `MQTT_BROKER_URL` | `mqtt://127.0.0.1:1883` | MQTT broker URL, including optional credentials or TLS (`mqtts://`) |
| `ZENOH_ROUTER` | `tcp/127.0.0.1:7447` | Zenoh router endpoint override; default in `examples/consumers/peer.json5` |

### CPU performance guide

| Model | Disk | RAM (int8) | Latency/5 s window |
|---|---|---|---|
| `tiny` | 75 MB | ~230 MB | 1–2 s |
| `base` | 145 MB | ~310 MB | 2–4 s |
| `small` | 461 MB | ~600 MB | 5–10 s |
| `medium` | 1.5 GB | ~1.3 GB | 15–25 s |

`tiny` is the right default for real-time use on CPU. Use `small` or `medium`
only with GPU (`WHISPER_DEVICE=cuda WHISPER_COMPUTE_TYPE=float16`).

---

## Transcript payload (`bwear/whisper/transcript`)

Default (no word timestamps):
```json
{
  "ts": 1748198400000,
  "text": "hello world",
  "language": "en",
  "language_probability": 0.998,
  "inference_s": 1.42,
  "window_s": 5.0,
  "segments": [
    { "start": 0.0, "end": 1.8, "text": "hello world" }
  ]
}
```

With `WHISPER_WORD_TIMESTAMPS=1`, each segment includes a `words` array:
```json
{
  "segments": [
    {
      "start": 0.0, "end": 1.8, "text": "hello world",
      "words": [
        { "word": "hello", "start": 0.0, "end": 0.6, "prob": 0.98 },
        { "word": "world", "start": 0.7, "end": 1.8, "prob": 0.97 }
      ]
    }
  ]
}
```

---

## Architecture

```
Subscriber thread (Zenoh or MQTT)
  on_message()
    └── FrameAssembler.on_meta() / on_chunk()
          │  reassemble multi-chunk base64 frames by frameId
          └── AudioAccumulator.add()
                │  concatenate Float32 samples; emit when window full
                │  if OVERLAP > 0: keep overlap fraction for next window
                └── InferenceWorker.enqueue()

InferenceWorker (daemon thread)
  dequeue window
    └── resample_to_16k()  (soxr if installed, else np.interp)
    └── WhisperModel.transcribe()
          language caching: detect once, then lock
          no-speech filter: drop silent windows
          initial_prompt: pass previous transcript for continuity
    └── publish_fn(json)   (Zenoh publisher.put or MQTT client.publish)
```

The subscriber and inference run on separate threads so a slow CPU inference
pass never stalls frame reception.

---

## Possible improvements

### Voice Activity Detection (VAD) gated windowing

**What:** Instead of fixed `WHISPER_WINDOW_S` boundaries, trigger inference
when a speech segment ends using [Silero-VAD](https://github.com/snakers4/silero-vad).

**Why:** Fixed windows cut words at the boundary and waste inference cycles
on silence. VAD eliminates both: utterances arrive complete, inference only
runs on speech.

**How:** Load the Silero-VAD ONNX model (~1 MB) in `AudioAccumulator`. Run it
on each incoming frame (~3 ms). Trigger `on_window` on speech-end events instead
of on fixed length. Add `WHISPER_VAD_ENABLE=1` flag.

**Cost:** `onnxruntime` dependency; ~3 ms extra latency per frame.
