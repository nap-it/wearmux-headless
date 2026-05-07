#!/usr/bin/env python3
"""
Whisper Runner — speech-to-text consumer for the bsole-connector pipeline.

Subscribes to bsole/microphone/raw/** (chunked Float32 PCM frames published
by microphone/index.js when ZENOH_MIC_RAW_ENABLE=1), reassembles audio
windows, runs faster-whisper inference, and publishes transcripts to
bsole/whisper/transcript.

Usage:
    python3 whisper/runner.py

Environment variables:
    WHISPER_MODEL         Model size: tiny, base, small, medium, large-v3 (default: tiny)
    WHISPER_DEVICE        Inference device: cpu, cuda, auto (default: cpu)
    WHISPER_COMPUTE_TYPE  Quantization: int8, float16, float32 (default: int8)
    WHISPER_LANGUAGE      Language code e.g. en, pt — empty = auto-detect (default: empty)
    WHISPER_WINDOW_S      Seconds of audio to accumulate before each inference run (default: 5)
    WHISPER_PUB_KEY       Zenoh key to publish transcripts to (default: bsole/whisper/transcript)
    ZENOH_SUB_MIC         Key expression to subscribe to (default: bsole/microphone/raw/**)
    ZENOH_ROUTER          Zenoh router endpoint override (e.g. tcp/192.168.1.10:7447)
    DEBUG                 Set to 1 for verbose frame-level logging
"""

import os
import sys
import json
import time
import base64
import signal
import struct
import queue
import threading
from pathlib import Path

try:
    import numpy as np
except ImportError:
    print("[whisper-runner] missing dependencies — run: npm run whisper:setup", file=sys.stderr)
    sys.exit(1)

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("[whisper-runner] missing dependencies — run: npm run whisper:setup", file=sys.stderr)
    sys.exit(1)

try:
    import zenoh
except ImportError:
    print(
        "[whisper-runner] zenoh is not installed.\n"
        "  pip install eclipse-zenoh==1.6.1",
        file=sys.stderr,
    )
    sys.exit(1)

# ── Configuration ──────────────────────────────────────────────────────────────

MODEL_SIZE        = os.environ.get("WHISPER_MODEL", "tiny")
DEVICE            = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE      = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
LANGUAGE          = os.environ.get("WHISPER_LANGUAGE", "") or None  # None = auto-detect
WINDOW_S          = float(os.environ.get("WHISPER_WINDOW_S", "5"))
PUB_KEY           = os.environ.get("WHISPER_PUB_KEY", "bsole/whisper/transcript")
SUB_EXPR          = os.environ.get("ZENOH_SUB_MIC", "bsole/microphone/raw/**")
ROUTER            = os.environ.get("ZENOH_ROUTER", "")
DEBUG             = os.environ.get("DEBUG", "0") == "1"
NO_SPEECH_THRESH  = float(os.environ.get("WHISPER_NO_SPEECH_THRESHOLD", "0.6"))

# Zenoh peer config: one level up from this file, inside config/
CONFIG_FILE = Path(__file__).resolve().parent.parent / "config" / "peer.json5"

_FRAME_TIMEOUT_S = 2.0   # discard incomplete frames after this duration
_QUEUE_MAXSIZE   = 4     # inference windows to buffer before dropping (backpressure)


# ── Helpers ────────────────────────────────────────────────────────────────────

def log(msg: str, *, err: bool = False) -> None:
    print(f"[whisper-runner] {msg}", flush=True, file=sys.stderr if err else sys.stdout)


def decode_frame(chunks_by_idx: dict) -> np.ndarray:
    """Concatenate ordered base64 chunk data and decode to float32 samples."""
    b64 = "".join(chunks_by_idx[i] for i in sorted(chunks_by_idx))
    raw = base64.b64decode(b64)
    n = len(raw) // 4
    return np.frombuffer(raw, dtype="<f4", count=n).copy()


def resample_to_16k(audio: np.ndarray, src_rate: int) -> np.ndarray:
    """Linear-interpolation resampling to 16 kHz.

    Sufficient for speech recognition; replace with soxr or librosa for
    higher fidelity (see README — possible improvements).
    """
    if src_rate == 16000:
        return audio
    target_len = int(len(audio) * 16000 / src_rate)
    return np.interp(
        np.linspace(0, len(audio) - 1, target_len),
        np.arange(len(audio)),
        audio,
    ).astype(np.float32)


# ── Frame assembler ────────────────────────────────────────────────────────────

class FrameAssembler:
    """Reassembles multi-chunk audio frames from Zenoh meta + chunk messages.

    microphone/index.js splits each Float32 frame into N base64 chunks and
    publishes them as:
        bsole/microphone/raw/meta  — {frameId, totalChunks, sampleRate, ...}
        bsole/microphone/raw/chunk — {frameId, idx, data (base64 slice)}

    Meta and chunks may arrive in any order; both are buffered by frameId.
    Incomplete frames older than _FRAME_TIMEOUT_S are evicted.
    """

    def __init__(self, on_frame):
        # on_frame(samples: np.ndarray, meta: dict)
        self._on_frame = on_frame
        self._pending: dict = {}
        self._lock = threading.Lock()

    def on_meta(self, payload: dict) -> None:
        frame_id = payload.get("frameId")
        if not frame_id:
            return
        with self._lock:
            self._evict_stale()
            entry = self._pending.setdefault(frame_id, {"meta": None, "chunks": {}, "ts": time.monotonic()})
            entry["meta"] = payload
            self._try_complete(frame_id)

    def on_chunk(self, payload: dict) -> None:
        frame_id = payload.get("frameId")
        idx      = payload.get("idx")
        data     = payload.get("data")
        if frame_id is None or idx is None or data is None:
            return
        with self._lock:
            self._evict_stale()
            entry = self._pending.setdefault(frame_id, {"meta": None, "chunks": {}, "ts": time.monotonic()})
            entry["chunks"][idx] = data
            self._try_complete(frame_id)

    def _try_complete(self, frame_id: str) -> None:
        """Must be called with self._lock held."""
        entry = self._pending.get(frame_id)
        if entry is None or entry["meta"] is None:
            return
        meta = entry["meta"]
        total = meta.get("totalChunks", 1)
        if len(entry["chunks"]) < total:
            return

        del self._pending[frame_id]
        try:
            samples = decode_frame(entry["chunks"])
        except Exception as exc:
            log(f"frame decode error (frameId={frame_id}): {exc}", err=True)
            return

        if DEBUG:
            log(f"frame assembled: {len(samples)} samples  sr={meta.get('sampleRate')}")

        self._on_frame(samples, meta)

    def _evict_stale(self) -> None:
        """Must be called with self._lock held."""
        now = time.monotonic()
        stale = [fid for fid, e in self._pending.items() if now - e["ts"] > _FRAME_TIMEOUT_S]
        for fid in stale:
            if DEBUG:
                log(f"evicting stale frame {fid}", err=True)
            del self._pending[fid]


# ── Audio accumulator ──────────────────────────────────────────────────────────

class AudioAccumulator:
    """Buffers assembled frames until a full WHISPER_WINDOW_S window is ready.

    When the buffer fills, the window is handed to on_window and the buffer
    is reset (non-overlapping windows). Overlapping / VAD-gated windowing
    are documented as possible improvements in the README.
    """

    def __init__(self, window_s: float, on_window):
        # on_window(samples: np.ndarray, sample_rate: int)
        self._window_s   = window_s
        self._on_window  = on_window
        self._samples    = np.empty(0, dtype=np.float32)
        self._sample_rate = 16000
        self._lock       = threading.Lock()

    def add(self, samples: np.ndarray, meta: dict) -> None:
        sr = int(meta.get("sampleRate") or 16000)
        with self._lock:
            self._sample_rate = sr
            self._samples = np.concatenate([self._samples, samples])
            needed = int(self._window_s * sr)
            while len(self._samples) >= needed:
                window = self._samples[:needed].copy()
                self._samples = self._samples[needed:]
                self._on_window(window, sr)


# ── Inference worker ───────────────────────────────────────────────────────────

class InferenceWorker(threading.Thread):
    """Daemon thread that dequeues audio windows and runs Whisper inference.

    Inference is intentionally isolated from the Zenoh callback thread so
    that blocking GPU/CPU work never stalls the message receiver.
    """

    def __init__(self, model: WhisperModel, publisher, language):
        super().__init__(daemon=True, name="whisper-inference")
        self._model        = model
        self._publisher    = publisher
        self._language     = language
        self._queue: queue.Queue = queue.Queue(maxsize=_QUEUE_MAXSIZE)
        self._running      = True
        self._last_text    = ""  # for initial_prompt continuity

    def enqueue(self, samples: np.ndarray, sample_rate: int) -> None:
        try:
            self._queue.put_nowait((samples, sample_rate))
        except queue.Full:
            log("inference queue full — dropping window (inference is slower than audio input)", err=True)

    def stop(self) -> None:
        self._running = False
        try:
            self._queue.put_nowait(None)  # unblock get()
        except queue.Full:
            pass

    def run(self) -> None:
        while self._running:
            item = self._queue.get()
            if item is None:
                break
            samples, sample_rate = item
            self._infer(samples, sample_rate)

    def _infer(self, samples: np.ndarray, sample_rate: int) -> None:
        audio = resample_to_16k(samples, sample_rate)

        t0 = time.monotonic()
        try:
            segments_gen, info = self._model.transcribe(
                audio,
                language=self._language,
                beam_size=1,
                vad_filter=True,
                initial_prompt=self._last_text or None,
            )
            segments = list(segments_gen)
        except Exception as exc:
            log(f"inference error: {exc}", err=True)
            return

        elapsed = time.monotonic() - t0

        # Drop windows where all segments are likely silence/hallucination
        if segments and all(s.no_speech_prob > NO_SPEECH_THRESH for s in segments):
            if DEBUG:
                log(f"no-speech filtered (probs: {[round(s.no_speech_prob,2) for s in segments]})")
            return

        text = " ".join(s.text.strip() for s in segments).strip()

        if text:
            self._last_text = text

        if text or DEBUG:
            lang = info.language if info else "?"
            log(f"[{lang}] {text!r}  ({elapsed:.2f}s)")

        if not text:
            return

        payload = {
            "ts":                   int(time.time() * 1000),
            "text":                 text,
            "language":             info.language if info else None,
            "language_probability": round(info.language_probability, 3) if info else None,
            "inference_s":          round(elapsed, 3),
            "window_s":             round(len(samples) / sample_rate, 3),
            "segments": [
                {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
                for s in segments
            ],
        }

        try:
            self._publisher.put(json.dumps(payload))
        except Exception as exc:
            log(f"publish error: {exc}", err=True)


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    if not CONFIG_FILE.exists():
        log(f"zenoh peer config not found: {CONFIG_FILE}", err=True)
        log("expected at config/peer.json5 (one level above this script)", err=True)
        sys.exit(1)

    log(f"loading model '{MODEL_SIZE}'  device={DEVICE}  compute={COMPUTE_TYPE}")
    t0    = time.monotonic()
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    log(f"model ready ({time.monotonic() - t0:.1f}s)")

    conf = zenoh.Config.from_file(str(CONFIG_FILE))
    if ROUTER:
        conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')
        log(f"router override: {ROUTER}")

    session   = zenoh.open(conf)
    publisher = session.declare_publisher(PUB_KEY)

    worker      = InferenceWorker(model, publisher, LANGUAGE)
    accumulator = AudioAccumulator(window_s=WINDOW_S, on_window=worker.enqueue)
    assembler   = FrameAssembler(on_frame=accumulator.add)

    def on_message(sample) -> None:
        key = str(sample.key_expr)
        try:
            payload = json.loads(bytes(sample.payload).decode("utf-8"))
        except Exception:
            return
        if key.endswith("/meta"):
            assembler.on_meta(payload)
        elif key.endswith("/chunk"):
            assembler.on_chunk(payload)

    sub = session.declare_subscriber(SUB_EXPR, on_message)
    worker.start()

    log(f"subscribed   '{SUB_EXPR}'")
    log(f"publishing → '{PUB_KEY}'")
    log(f"window={WINDOW_S}s  language={'auto' if LANGUAGE is None else LANGUAGE}")
    log("waiting for audio... press Ctrl+C to stop\n")

    def shutdown(*_) -> None:
        log("\nshutting down...")
        worker.stop()
        try:
            sub.undeclare()
        except Exception:
            pass
        try:
            publisher.undeclare()
        except Exception:
            pass
        session.close()
        sys.exit(0)

    signal.signal(signal.SIGINT,  shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
