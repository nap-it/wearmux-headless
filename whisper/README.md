# whisper — speech-to-text consumer

Real-time transcription for the bsole-connector pipeline.

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

1. **Install Python dependencies** (from `bsole-connector/`):
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Enable raw audio publishing** in `config/zenoh.ini` (or via env):
   ```ini
   ZENOH_MIC_ENABLE=1
   ZENOH_MIC_RAW_ENABLE=1
   ```
   Without this flag `microphone/index.js` only publishes level metrics, not samples.

3. **A Zenoh router must be reachable** — default `tcp/127.0.0.1:7447`.

---

## Running

Run both sides in separate terminals (or add both to `config/config.ini [scripts]`):

```bash
# Terminal 1 — stream mic audio
npm run microphone:rtsp   # (or sensors, etc.)

# Terminal 2 — transcribe
npm run whisper:runner
```

Or configure `config/config.ini` to run them together:

```ini
[scripts]
run=microphone:rtsp
run=whisper:runner       # not yet wired into launcher — see improvements below
```

### Direct invocation

```bash
WHISPER_MODEL=base WHISPER_LANGUAGE=en python3 whisper/runner.py
```

---

## Configuration (`config/whisper.ini`)

| Variable | Default | Description |
|---|---|---|
| `WHISPER_MODEL` | `tiny` | Model size: `tiny` `base` `small` `medium` `large-v3` |
| `WHISPER_DEVICE` | `cpu` | `cpu`, `cuda`, or `auto` |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8`, `float16`, `float32` |
| `WHISPER_LANGUAGE` | _(empty)_ | BCP-47 code (`en`, `pt`…) or empty for auto-detect |
| `WHISPER_WINDOW_S` | `5` | Seconds to accumulate before each inference call |
| `WHISPER_PUB_KEY` | `bsole/whisper/transcript` | Zenoh key for transcript output |
| `ZENOH_SUB_MIC` | `bsole/microphone/raw/**` | Zenoh key expression to subscribe to |
| `ZENOH_ROUTER` | `tcp/127.0.0.1:7447` | Router endpoint |
| `DEBUG` | `0` | Set to `1` for frame-level logging |

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

---

## Architecture

```
Zenoh callback thread
  on_message()
    └── FrameAssembler.on_meta() / on_chunk()
          │  reassemble multi-chunk base64 frames by frameId
          └── AudioAccumulator.add()
                │  concatenate Float32 samples
                └── (when window full) InferenceWorker.enqueue()

InferenceWorker (daemon thread)
  dequeue window
    └── resample to 16 kHz (if needed)
    └── WhisperModel.transcribe()
    └── publisher.put(json)
```

The Zenoh callback and inference run on separate threads so a slow CPU
inference pass never stalls frame reception.

---

## Possible improvements

The items below are intentionally **not** in this V1 — they add complexity
that is only justified once the baseline pipeline is validated.

### 1. Voice Activity Detection (VAD) gated windowing

**What:** Instead of cutting at a fixed `WHISPER_WINDOW_S` boundary, only
trigger inference when a speech segment ends (detected by
[Silero-VAD](https://github.com/snakers4/silero-vad)).

**Why:** Fixed windows cut words at the boundary and waste inference cycles
on silence. VAD eliminates both problems: utterances arrive complete, and
inference only runs when there is actually speech.

**How:** Load the Silero-VAD ONNX model (~1 MB) in `AudioAccumulator`.
Run it on each incoming frame (~3 ms per frame). Trigger `on_window` on
speech-end events instead of on fixed length. Add `WHISPER_VAD_ENABLE=1`
env flag to keep it optional.

**Cost:** one extra ONNX Runtime dependency; ~3 ms extra latency per frame.

---

### 2. Overlapping windows (interim fix before VAD)

**What:** Slide the window by 50% overlap (e.g., infer every 2.5 s on a 5 s
buffer) instead of non-overlapping.

**Why:** Reduces word-boundary cut-offs without requiring VAD. Simple change
to `AudioAccumulator`.

**Cost:** 2× the inference calls. Produces duplicate words at the overlap
that need deduplication. Only worthwhile as a temporary improvement before
VAD is added.

---

### 3. Initial prompt for continuity

**What:** Pass the previous transcript as Whisper's `initial_prompt` parameter.

**Why:** Whisper uses the prompt as context for the next window. This
significantly reduces hallucinations and improves continuity across window
boundaries (especially for technical vocabulary).

**How:** Store the last `text` output in `InferenceWorker`. Pass it as
`initial_prompt=prev_text` to `model.transcribe()`.

**Cost:** Near-zero; one variable and one extra argument.

---

### 4. Higher-quality resampling

**What:** Replace the current `np.interp` linear resampler with
[`soxr`](https://python-soxr.readthedocs.io/) or
`librosa.resample(res_type="kaiser_fast")`.

**Why:** Linear interpolation introduces aliasing at high frequencies. For
the `tiny` model this is rarely perceptible, but `small`/`medium` models
benefit from cleaner input.

**Cost:** one extra dependency (`soxr` is ~300 KB, no heavy transitive deps).
Only relevant when `sampleRate != 16000`.

---

### 5. MQTT transport

**What:** Add a subscriber path that reads from MQTT (`bsole/microphone/raw/#`)
in addition to Zenoh, selected by the `MQTT_ENABLE=1` env var — mirroring
the `utils/transport.js` pattern.

**Why:** Allows the whisper runner to work in MQTT-only deployments without
a Zenoh router.

**How:** Use `paho-mqtt` as the subscriber. The frame reassembly and inference
worker are transport-agnostic; only the subscriber initialization changes.

**Cost:** `paho-mqtt` dependency; ~50 lines of subscriber code.

---

### 6. Word-level timestamps

**What:** Enable `word_timestamps=True` in `model.transcribe()` and include
per-word timing in the published payload.

**Why:** Enables downstream consumers to synchronize text with display events
(e.g., showing subtitles on the Frame glasses synchronized to speech).

**Cost:** ~10–20% slower inference. Add `WHISPER_WORD_TIMESTAMPS=1` env flag.

---

### 7. Language detection caching

**What:** Run language detection only on the first window (or every N windows),
then lock `WHISPER_LANGUAGE` to the detected code for subsequent calls.

**Why:** Language detection adds ~0.3 s per window. For single-speaker
sessions the language does not change.

**How:** Detect on first window, store result, set `self._language` for all
subsequent calls. Add `WHISPER_AUTODETECT_EVERY=10` env flag to re-detect
periodically.

**Cost:** Near-zero; a counter variable.

---

### 8. Docker service

**What:** Add a `whisper` service to `docker-compose.yml` that runs
`whisper/runner.py` alongside the `bsole` and `zenoh-router` services.

**Why:** Currently the runner must be started manually in a separate terminal.
A Docker service enables fully automated startup with health checks and
restart policies.

**How:**
```yaml
whisper:
  build:
    context: .
    dockerfile: whisper/Dockerfile
  depends_on:
    zenoh-router:
      condition: service_healthy
  environment:
    - WHISPER_MODEL=tiny
    - ZENOH_ROUTER=tcp/zenoh-router:7447
  networks:
    - bsole-network
  restart: unless-stopped
```
Requires a separate `whisper/Dockerfile` (Python base image + `faster-whisper`).

---

### 9. No-speech filtering

**What:** Discard windows where `faster-whisper`'s `no_speech_prob` exceeds
a threshold before publishing.

**Why:** When VAD is not enabled, Whisper still runs on silent windows and
emits hallucinated text (e.g., `"Thank you."`, `"Bye."` — a known Whisper
artifact). Filtering on `no_speech_prob > 0.6` suppresses most hallucinations.

**How:** Check `segments[i].no_speech_prob` (available on each segment
object) and skip `put()` if all segments are above the threshold. Add
`WHISPER_NO_SPEECH_THRESHOLD=0.6` env flag.

**Cost:** Near-zero. This should probably be added even in V1 once validated.

---

### 10. Launcher integration (multi-script startup)

**What:** Wire `whisper:runner` into `tools/launcher.js` so it starts
alongside `microphone:rtsp` from a single `npm start`.

**Why:** Currently the launcher only supports `npm run` scripts that invoke
Node.js. The whisper launcher spawns Python, which the current `run-with-config.js`
cannot do.

**How:** Either modify `tools/launcher.js` to accept arbitrary shell commands
in `config.ini [scripts]`, or add a `whisper:runner` entry that is recognized
as a Node-started script (since `whisper/launcher.js` is the entry point,
this already works — just needs a `run=whisper:runner` line in `config.ini`).
