const EventEmitter = require("events");
const { spawn } = require("child_process");

function clampSample(sample) {
  if (sample > 1) return 1;
  if (sample < -1) return -1;
  return sample;
}

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

class RtspPublisher extends EventEmitter {
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

  get isRunning() {
    return Boolean(this._child);
  }

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

  async write(samples) {
    if (!samples || samples.length === 0) return;
    this._writeChain = this._writeChain.then(() => this._writeOnce(samples));
    return this._writeChain;
  }

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

  _createExitError(code, signal) {
    const details = this._stderrTail.length ? ` (${this._stderrTail.join(" | ")})` : "";
    return new Error(`[RTSP] ffmpeg exited code=${code} signal=${signal}${details}`);
  }
}

module.exports = {
  RtspPublisher,
  serializeSamples,
};
