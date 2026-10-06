const EventEmitter = require("events");
const { spawn } = require("child_process");

/** @private */
function clampSample(sample) {
  if (sample > 1) return 1;
  if (sample < -1) return -1;
  return sample;
}

/**
 * Encode normalized audio samples for FFmpeg's raw input.
 * Integer formats clamp to [-1, 1]; float output preserves sample values.
 * @param {Float32Array|number[]} samples Interleaved normalized audio samples.
 * @param {string} sampleFormat f32le, s16le, or s8.
 * @returns {Buffer} Encoded bytes; empty when no samples are supplied.
 * @throws {Error} When a nonempty input requests an unsupported format.
 */
function serializeSamples(samples, sampleFormat) {
  if (!samples || samples.length === 0) return Buffer.alloc(0);

  switch (sampleFormat) {
    case "f32le": {
      const buffer = Buffer.allocUnsafe(samples.length * 4);
      for (let i = 0; i < samples.length; i += 1) {
        buffer.writeFloatLE(samples[i], i * 4);
      }
      return buffer;
    }
    case "s16le": {
      const buffer = Buffer.allocUnsafe(samples.length * 2);
      for (let i = 0; i < samples.length; i += 1) {
        const sample = clampSample(samples[i]);
        const int16 = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
        buffer.writeInt16LE(int16, i * 2);
      }
      return buffer;
    }
    case "s8": {
      const buffer = Buffer.allocUnsafe(samples.length);
      for (let i = 0; i < samples.length; i += 1) {
        const sample = clampSample(samples[i]);
        const int8 = sample < 0 ? Math.round(sample * 128) : Math.round(sample * 127);
        buffer.writeInt8(int8, i);
      }
      return buffer;
    }
    default:
      throw new Error(`Unsupported sample format '${sampleFormat}'. Use f32le, s16le, or s8.`);
  }
}

/**
 * Own an FFmpeg process that encodes raw samples as Opus and publishes over RTSP/TCP.
 * Requires FFmpeg and a reachable RTSP server. Register an error listener before start().
 * @class
 * @extends EventEmitter
 * @fires RtspPublisher#error
 * @see MicrophoneSession
 */
class RtspPublisher extends EventEmitter {
  /**
   * @param {Object} options FFmpeg input and publishing configuration.
   * @param {string} options.rtspUrl Destination RTSP URL.
   * @param {string} [options.ffmpegPath="ffmpeg"] Executable path/name.
   * @param {string} [options.ffmpegLogLevel="error"] FFmpeg log verbosity.
   * @param {number} [options.sampleRate=16000] Input sample rate in Hz.
   * @param {number} [options.channels=1] Interleaved input channel count.
   * @param {string} [options.sampleFormat="s16le"] f32le, s16le, or s8.
   * @param {string} [options.audioBitrate="64k"] Opus output bitrate.
   */
  constructor(options = {}) {
    super();
    this.rtspUrl = options.rtspUrl;
    this.ffmpegPath = options.ffmpegPath || "ffmpeg";
    this.ffmpegLogLevel = options.ffmpegLogLevel || "error";
    this.sampleRate = Number(options.sampleRate || 16000);
    this.channels = Number(options.channels || 1);
    this.sampleFormat = options.sampleFormat || "s16le";
    this.audioBitrate = options.audioBitrate || "64k";

    this._child = null;
    this._stopping = false;
    this._writeChain = Promise.resolve();
    this._stderrTail = [];
  }

  /**
   * Whether an FFmpeg child process is currently held.
   * @type {boolean}
   */
  get isRunning() {
    return Boolean(this._child);
  }

  /**
   * Spawn FFmpeg and wait for a short startup window. Does not guarantee that
   * the RTSP server has accepted the stream. Repeated calls while held have no effect.
   * @returns {Promise<void>} Rejects when URL is absent, spawn fails, or FFmpeg exits during startup.
   */
  async start() {
    if (!this.rtspUrl) {
      throw new Error("RTSP_URL is not configured");
    }
    if (this._child) return;

    this._stopping = false;
    this._stderrTail = [];

    const args = [
      "-hide_banner",
      "-loglevel",
      this.ffmpegLogLevel,
      "-f",
      this.sampleFormat,
      "-ar",
      String(this.sampleRate),
      "-ac",
      String(this.channels),
      "-i",
      "pipe:0",
      "-vn",
      "-map",
      "0:a:0",
      "-c:a",
      "libopus",
      "-b:a",
      this.audioBitrate,
      "-application",
      "lowdelay",
      "-frame_duration",
      "20",
      "-rtsp_transport",
      "tcp",
      "-f",
      "rtsp",
      this.rtspUrl,
    ];

    const child = spawn(this.ffmpegPath, args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    this._child = child;

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.length) {
        this._stderrTail.push(...lines);
        this._stderrTail = this._stderrTail.slice(-8);
      }
      if (process.env.DEBUG === "1" && text.trim()) {
        process.stderr.write(`[RTSP][ffmpeg] ${text}`);
      }
    });

    child.stdin.on("error", (error) => {
      if (!this._stopping && error.code !== "EPIPE") {
        this.emit("error", new Error(`[RTSP] ffmpeg stdin error: ${error.message}`));
      }
    });

    child.on("exit", (code, signal) => {
      if (this._child === child) {
        this._child = null;
      }
      if (!this._stopping) {
        this.emit("error", this._createExitError(code, signal));
      }
    });

    await new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onError = (error) => {
        finishReject(new Error(`[RTSP] failed to start ffmpeg: ${error.message}`));
      };
      const onExit = (code, signal) => {
        finishReject(this._createExitError(code, signal));
      };

      child.once("error", onError);
      child.once("exit", onExit);
      child.once("spawn", () => {
        setTimeout(finishResolve, 250);
      });
    });
  }

  /**
   * Queue sample serialization and writes with FFmpeg stdin backpressure.
   * Pass a stable sample array until the promise settles. A rejected write leaves
   * this instance's write chain rejected; stop it and create a new publisher to recover.
   * @param {Float32Array|number[]} samples Normalized, interleaved samples matching configured channels/rate.
   * @returns {Promise<void>} Resolves for empty input; rejects on format, process, or write failure.
   */
  async write(samples) {
    if (!samples || samples.length === 0) return;
    this._writeChain = this._writeChain.then(() => this._writeOnce(samples));
    return this._writeChain;
  }

  /**
   * Drain queued writes, close stdin, and terminate FFmpeg if it does not exit.
   * Attempts SIGTERM after 500 ms and SIGKILL after 2000 ms. Has no effect without a process.
   * @returns {Promise<void>}
   */
  async stop() {
    const child = this._child;
    if (!child) return;

    this._stopping = true;
    try {
      await this._writeChain.catch(() => {});
    } catch {}

    await new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (this._child === child) {
          this._child = null;
        }
        resolve();
      };

      child.once("exit", finish);

      try {
        child.stdin.end();
      } catch {
        finish();
        return;
      }

      setTimeout(() => {
        if (resolved || child.exitCode !== null) {
          finish();
          return;
        }
        try {
          child.kill("SIGTERM");
        } catch {}
      }, 500);

      setTimeout(() => {
        if (resolved || child.exitCode !== null) {
          finish();
          return;
        }
        try {
          child.kill("SIGKILL");
        } catch {}
        finish();
      }, 2000);
    });
  }

  /** @private */
  async _writeOnce(samples) {
    const child = this._child;
    if (!child || !child.stdin || child.stdin.destroyed || child.exitCode !== null) {
      throw new Error("[RTSP] ffmpeg is not running");
    }

    const buffer = serializeSamples(samples, this.sampleFormat);
    if (!buffer.length) return;

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        cleanup();
        reject(new Error(`[RTSP] failed to write audio to ffmpeg: ${error.message}`));
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        child.stdin.off("error", onError);
        child.stdin.off("drain", onDrain);
      };

      child.stdin.on("error", onError);
      const ok = child.stdin.write(buffer, (error) => {
        if (error) {
          cleanup();
          reject(new Error(`[RTSP] failed to write audio to ffmpeg: ${error.message}`));
          return;
        }
        if (ok) {
          cleanup();
          resolve();
        }
      });

      if (!ok) {
        child.stdin.once("drain", onDrain);
      }
    });
  }

  /** @private */
  _createExitError(code, signal) {
    const details = this._stderrTail.length ? ` (${this._stderrTail.join(" | ")})` : "";
    return new Error(`[RTSP] ffmpeg exited code=${code} signal=${signal}${details}`);
  }
}

module.exports = {
  RtspPublisher,
  serializeSamples,
};

/**
 * Unexpected FFmpeg exit or an active stdin error other than EPIPE.
 * @event RtspPublisher#error
 * @type {Error}
 */
