# whisper — speech-to-text consumer

Real-time transcription for the WearMux headless pipeline.

Subscribes to the raw audio stream published by `microphone/index.js`, accumulates
fixed-size windows, runs [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
inference, and publishes transcripts back onto the transport layer.

```
microphone/index.js  ──(bsole/microphone/raw/**)──►  whisper/runner.py
                                                            │
                                                   bsole/whisper/transcript
                                                            │
                                                     Python subscribers
                                                     glasses-controller
                                                     ...
```

---

## Prerequisites

1. **Install Python dependencies** (from the repository root):
   ```bash
   npm run whisper:setup
   ```

2. **Enable raw audio publishing** in `config/zenoh.ini`:
   ```ini
   ZENOH_MIC_ENABLE=1
   ZENOH_MIC_RAW_ENABLE=1
   ZENOH_MIC_RAW_THROTTLE_MS=0
   ```
   Without these the microphone only publishes level metrics, not samples.

3. **A Zenoh router must be reachable** — default `tcp/127.0.0.1:7447`:
   ```bash
   docker compose up -d zenoh-router
   ```

---

## Running

```bash
# Terminal 1 — stream mic audio
npm run microphone:rtsp

# Terminal 2 — transcribe
npm run whisper:runner

# Terminal 3 — read transcripts
npm run whisper:listen
```

To start whisper automatically with `npm start`, uncomment in `config/config.ini`:
```ini
run=whisper:runner
```

Or run the full stack in Docker:
```bash
docker compose up --build whisper
```

---

## Configuration (`config/whisper.ini`)

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
| `MQTT_ENABLE` | `0` | Set to `1` to subscribe via MQTT instead of Zenoh |
| `MQTT_BROKER` | `localhost` | MQTT broker host |
| `MQTT_PORT` | `1883` | MQTT broker port |
| `MQTT_PUB_TOPIC` | _(same as `WHISPER_PUB_KEY`)_ | Topic to publish transcripts to |
| `MQTT_SUB_MIC` | `bsole/microphone/raw/#` | Topic filter for audio subscription |
| `ZENOH_SUB_MIC` | `bsole/microphone/raw/**` | Zenoh key expression to subscribe to |
| `ZENOH_ROUTER` | `tcp/127.0.0.1:7447` | Router endpoint |
| `WHISPER_PUB_KEY` | `bsole/whisper/transcript` | Zenoh key for transcript output |

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

## Transcript payload (`bsole/whisper/transcript`)

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
