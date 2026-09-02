#!/usr/bin/env python3
"""
Whisper Runner — speech-to-text consumer for the WearMux headless pipeline.

Subscribes to bsole/microphone/raw/** (chunked Float32 PCM frames published
by microphone/index.js when ZENOH_MIC_RAW_ENABLE=1), reassembles audio
windows, runs faster-whisper inference, and publishes transcripts to
bsole/whisper/transcript.

Usage:
    python3 whisper/runner.py

Environment variables:
    WHISPER_MODEL               Model size: tiny, base, small, medium, large-v3 (default: tiny)
    WHISPER_DEVICE              Inference device: cpu, cuda, auto (default: cpu)
    WHISPER_COMPUTE_TYPE        Quantization: int8, float16, float32 (default: int8)
    WHISPER_LANGUAGE            Language code e.g. en, pt — empty = auto-detect (default: empty)
    WHISPER_AUTODETECT_EVERY    Re-detect language every N windows; 0 = detect once then lock (default: 0)
    WHISPER_AUTODETECT_WINDOWS  Number of windows to sample before locking language via majority vote (default: 3)
    WHISPER_WINDOW_S            Seconds of audio per inference window (default: 5)
    WHISPER_OVERLAP             Fraction of window kept as overlap between windows, 0–0.9 (default: 0)
    WHISPER_WORD_TIMESTAMPS     Set to 1 for per-word timing in transcript payload (default: 0)
    WHISPER_NO_SPEECH_THRESHOLD Drop windows where all segments exceed this prob (default: 0.6)
    WHISPER_PUB_KEY             Zenoh key to publish transcripts to (default: bsole/whisper/transcript)
    ZENOH_SUB_MIC               Key expression to subscribe to (default: bsole/microphone/raw/**)
    ZENOH_ROUTER                Zenoh router endpoint override (e.g. tcp/192.168.1.10:7447)
    MQTT_ENABLE                 Set to 1 to use MQTT instead of Zenoh (default: 0)
    MQTT_BROKER                 MQTT broker host (default: localhost)
    MQTT_PORT                   MQTT broker port (default: 1883)
    MQTT_PUB_TOPIC              Topic to publish transcripts to (default: same as WHISPER_PUB_KEY)
    MQTT_SUB_MIC                Topic filter to subscribe for audio (default: bsole/microphone/raw/#)
    DEBUG                       Set to 1 for verbose frame-level logging
"""

import os
import sys
import json
import time
import base64
import signal
import queue
import threading
from pathlib import Path

# Apply config/whisper.ini before reading env vars so the script works when
# invoked directly (python3 runner.py) or in Docker without the Node launcher.
# Existing env vars always take precedence (shell / docker-compose explicit values).
def _load_ini(path: Path) -> None:
    try:
        in_env = False
        for line in path.read_text().splitlines():
            line = line.strip()
            if line.startswith("["):
                in_env = line.lower() == "[env]"
                continue
            if not in_env or not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip()
                if key and key not in os.environ:
                    os.environ[key] = val
    except OSError:
        pass

_load_ini(Path(__file__).resolve().parent.parent / "config" / "whisper.ini")

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
    import soxr as _soxr
    _HAS_SOXR = True
except ImportError:
    _HAS_SOXR = False

# ── Configuration ──────────────────────────────────────────────────────────────

MODEL_SIZE        = os.environ.get("WHISPER_MODEL", "tiny")
DEVICE            = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE      = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
LANGUAGE           = os.environ.get("WHISPER_LANGUAGE", "") or None  # None = auto-detect
AUTODETECT_EVERY   = int(os.environ.get("WHISPER_AUTODETECT_EVERY", "0"))
AUTODETECT_WINDOWS = int(os.environ.get("WHISPER_AUTODETECT_WINDOWS", "3"))
WINDOW_S          = float(os.environ.get("WHISPER_WINDOW_S", "5"))
OVERLAP           = float(os.environ.get("WHISPER_OVERLAP", "0"))
WORD_TIMESTAMPS   = os.environ.get("WHISPER_WORD_TIMESTAMPS", "0") == "1"
NO_SPEECH_THRESH  = float(os.environ.get("WHISPER_NO_SPEECH_THRESHOLD", "0.6"))
PUB_KEY           = os.environ.get("WHISPER_PUB_KEY", "bsole/whisper/transcript")
SUB_EXPR          = os.environ.get("ZENOH_SUB_MIC", "bsole/microphone/raw/**")
ROUTER            = os.environ.get("ZENOH_ROUTER", "")
MQTT_ENABLE       = os.environ.get("MQTT_ENABLE", "0") == "1"
MQTT_BROKER       = os.environ.get("MQTT_BROKER", "localhost")
MQTT_PORT         = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_PUB_TOPIC    = os.environ.get("MQTT_PUB_TOPIC", PUB_KEY)
MQTT_SUB_TOPIC    = os.environ.get("MQTT_SUB_MIC", "bsole/microphone/raw/#")
DEBUG             = os.environ.get("DEBUG", "0") == "1"

# Zenoh peer config — only needed when MQTT_ENABLE=0
CONFIG_FILE = Path(__file__).resolve().parent.parent / "config" / "peer.json5"

_FRAME_TIMEOUT_S = 2.0
_QUEUE_MAXSIZE   = 4


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
    if src_rate == 16000:
        return audio
    if _HAS_SOXR:
        return _soxr.resample(audio, src_rate, 16000, quality="HQ").astype(np.float32)
    target_len = int(len(audio) * 16000 / src_rate)
    return np.interp(
        np.linspace(0, len(audio) - 1, target_len),
        np.arange(len(audio)),
        audio,
    ).astype(np.float32)


# ── Frame assembler ────────────────────────────────────────────────────────────

class FrameAssembler:
    """Reassembles multi-chunk audio frames from meta + chunk messages.

    microphone/index.js splits each Float32 frame into N base64 chunks and
    publishes them as:
        bsole/microphone/raw/meta  — {frameId, totalChunks, sampleRate, ...}
        bsole/microphone/raw/chunk — {frameId, idx, data (base64 slice)}

    Meta and chunks may arrive in any order; both are buffered by frameId.
    Incomplete frames older than _FRAME_TIMEOUT_S are evicted.
    """

    def __init__(self, on_frame):
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

    When OVERLAP > 0, keeps that fraction of each window as the start of the
    next, reducing word-boundary cut-offs at 1/(1-overlap)× more inference cost.
    """

    def __init__(self, window_s: float, overlap: float, on_window):
        self._window_s    = window_s
        self._overlap     = max(0.0, min(overlap, 0.9))
        self._on_window   = on_window
        self._samples     = np.empty(0, dtype=np.float32)
        self._sample_rate = 16000
        self._lock        = threading.Lock()

    def add(self, samples: np.ndarray, meta: dict) -> None:
        sr = int(meta.get("sampleRate") or 16000)
        with self._lock:
            self._sample_rate = sr
            self._samples = np.concatenate([self._samples, samples])
            needed = int(self._window_s * sr)
            keep   = int(needed * self._overlap)
            while len(self._samples) >= needed:
                window = self._samples[:needed].copy()
                self._samples = self._samples[needed - keep:]
                self._on_window(window, sr)


# ── Inference worker ───────────────────────────────────────────────────────────

class InferenceWorker(threading.Thread):
    """Daemon thread that dequeues audio windows and runs Whisper inference.

    Inference is intentionally isolated from the subscriber callback thread so
    that blocking GPU/CPU work never stalls the message receiver.
    """

    def __init__(self, model: WhisperModel, publish_fn, language):
        super().__init__(daemon=True, name="whisper-inference")
        self._model        = model
        self._publish_fn   = publish_fn
        self._language     = language       # configured value; None = always auto-detect
        self._locked_lang  = language       # majority-voted language once enough samples collected
        self._lang_votes: list = []         # language detections before lock
        self._window_count = 0
        self._queue: queue.Queue = queue.Queue(maxsize=_QUEUE_MAXSIZE)
        self._running      = True
        self._last_text    = ""

    def enqueue(self, samples: np.ndarray, sample_rate: int) -> None:
        try:
            self._queue.put_nowait((samples, sample_rate))
        except queue.Full:
            log("inference queue full — dropping window (inference is slower than audio input)", err=True)

    def stop(self) -> None:
        self._running = False
        try:
            self._queue.put_nowait(None)
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

        # Determine language for this window
        if self._language is None:
            # Still collecting votes to establish majority language
            if len(self._lang_votes) < AUTODETECT_WINDOWS:
                lang_arg = None
            elif AUTODETECT_EVERY > 0 and self._window_count % AUTODETECT_EVERY == 0:
                self._lang_votes = []  # reset for periodic re-detection
                lang_arg = None
            else:
                lang_arg = self._locked_lang
        else:
            lang_arg = self._language

        t0 = time.monotonic()
        try:
            segments_gen, info = self._model.transcribe(
                audio,
                language=lang_arg,
                beam_size=1,
                vad_filter=True,
                word_timestamps=WORD_TIMESTAMPS,
                initial_prompt=self._last_text or None,
            )
            segments = list(segments_gen)
        except Exception as exc:
            log(f"inference error: {exc}", err=True)
            return

        elapsed = time.monotonic() - t0

        # Accumulate language votes; lock to majority once enough samples collected
        if lang_arg is None and info and info.language:
            self._lang_votes.append(info.language)
            if len(self._lang_votes) == AUTODETECT_WINDOWS:
                from collections import Counter
                majority = Counter(self._lang_votes).most_common(1)[0][0]
                if self._locked_lang != majority:
                    log(f"language locked: {majority} (votes: {self._lang_votes})")
                self._locked_lang = majority
            else:
                log(f"language vote {len(self._lang_votes)}/{AUTODETECT_WINDOWS}: "
                    f"{info.language} (prob={info.language_probability:.2f})")

        self._window_count += 1

        # Drop silent / hallucination windows
        if segments and all(s.no_speech_prob > NO_SPEECH_THRESH for s in segments):
            if DEBUG:
                log(f"no-speech filtered (probs: {[round(s.no_speech_prob, 2) for s in segments]})")
            return

        text = " ".join(s.text.strip() for s in segments).strip()

        if text:
            self._last_text = text

        if text or DEBUG:
            lang = info.language if info else "?"
            log(f"[{lang}] {text!r}  ({elapsed:.2f}s)")

        if not text:
            return

        seg_list = []
        for s in segments:
            entry = {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
            if WORD_TIMESTAMPS and hasattr(s, "words") and s.words:
                entry["words"] = [
                    {"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3), "prob": round(w.probability, 3)}
                    for w in s.words
                ]
            seg_list.append(entry)

        payload = {
            "ts":                   int(time.time() * 1000),
            "text":                 text,
            "language":             info.language if info else None,
            "language_probability": round(info.language_probability, 3) if info else None,
            "inference_s":          round(elapsed, 3),
            "window_s":             round(len(samples) / sample_rate, 3),
            "segments":             seg_list,
        }

        try:
            self._publish_fn(json.dumps(payload))
        except Exception as exc:
            log(f"publish error: {exc}", err=True)


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    log(f"loading model '{MODEL_SIZE}'  device={DEVICE}  compute={COMPUTE_TYPE}")
    t0    = time.monotonic()
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    log(f"model ready ({time.monotonic() - t0:.1f}s)")

    if MQTT_ENABLE:
        try:
            import paho.mqtt.client as mqtt
        except ImportError:
            log("paho-mqtt not installed — run: pip install paho-mqtt", err=True)
            sys.exit(1)

        # publish_fn is set after client connects; use a holder so the lambda captures it
        _pub: list = [None]
        worker      = InferenceWorker(model, lambda s: _pub[0](s), LANGUAGE)
        accumulator = AudioAccumulator(window_s=WINDOW_S, overlap=OVERLAP, on_window=worker.enqueue)
        assembler   = FrameAssembler(on_frame=accumulator.add)

        try:
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        except AttributeError:
            client = mqtt.Client()  # paho-mqtt < 2.0

        def on_mqtt_message(client, userdata, msg):
            try:
                payload = json.loads(msg.payload.decode("utf-8"))
            except Exception:
                return
            if msg.topic.endswith("/meta"):
                assembler.on_meta(payload)
            elif msg.topic.endswith("/chunk"):
                assembler.on_chunk(payload)

        client.on_message = on_mqtt_message
        client.connect(MQTT_BROKER, MQTT_PORT)
        client.subscribe(MQTT_SUB_TOPIC)
        client.loop_start()
        _pub[0] = lambda s: client.publish(MQTT_PUB_TOPIC, s)

        worker.start()

        log(f"MQTT broker:  {MQTT_BROKER}:{MQTT_PORT}")
        log(f"subscribed    '{MQTT_SUB_TOPIC}'")
        log(f"publishing  → '{MQTT_PUB_TOPIC}'")
        log(f"window={WINDOW_S}s  overlap={OVERLAP}  language={'auto' if LANGUAGE is None else LANGUAGE}")
        log("waiting for audio... press Ctrl+C to stop\n")

        def shutdown(*_) -> None:
            log("\nshutting down...")
            worker.stop()
            client.loop_stop()
            client.disconnect()
            sys.exit(0)

    else:
        try:
            import zenoh
        except ImportError:
            log("zenoh not installed — pip install eclipse-zenoh==1.6.1", err=True)
            sys.exit(1)

        if not CONFIG_FILE.exists():
            log(f"zenoh peer config not found: {CONFIG_FILE}", err=True)
            log("expected at config/peer.json5 (one level above this script)", err=True)
            sys.exit(1)

        conf = zenoh.Config.from_file(str(CONFIG_FILE))
        if ROUTER:
            conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')
            log(f"router override: {ROUTER}")

        session   = zenoh.open(conf)
        publisher = session.declare_publisher(PUB_KEY)

        worker      = InferenceWorker(model, publisher.put, LANGUAGE)
        accumulator = AudioAccumulator(window_s=WINDOW_S, overlap=OVERLAP, on_window=worker.enqueue)
        assembler   = FrameAssembler(on_frame=accumulator.add)

        def on_zenoh_message(sample) -> None:
            key = str(sample.key_expr)
            try:
                payload = json.loads(bytes(sample.payload).decode("utf-8"))
            except Exception:
                return
            if key.endswith("/meta"):
                assembler.on_meta(payload)
            elif key.endswith("/chunk"):
                assembler.on_chunk(payload)

        sub = session.declare_subscriber(SUB_EXPR, on_zenoh_message)
        worker.start()

        log(f"subscribed   '{SUB_EXPR}'")
        log(f"publishing → '{PUB_KEY}'")
        log(f"window={WINDOW_S}s  overlap={OVERLAP}  language={'auto' if LANGUAGE is None else LANGUAGE}")
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
