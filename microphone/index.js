#!/usr/bin/env node

/**
 * Real-time Microphone Streaming
 * 
 * Streams audio from BrilliantSole Frame microphone and displays audio levels.
 * 
 * Usage:
 *   node index.js
 * 
 * Environment Variables:
 *   SAMPLE_RATE - Sample rate in Hz (8000 or 16000, default: 16000)
 *   BIT_DEPTH - Bit depth (8 or 16, default: 16)
 */

const { DeviceManager } = require('../utils/device-manager');
const { calculateRMS, calculatePeak, formatLevelBar } = require('./lib/audio-utils');
const { RtspPublisher } = require("./lib/rtsp-publisher");
const { createPublisher, selectedTransport } = require("../utils/transport");

// Configuration
const SAMPLE_RATE = Number(process.env.SAMPLE_RATE || "16000");
const BIT_DEPTH = process.env.BIT_DEPTH || '16';
const CHANNELS = Math.max(1, Number(process.env.CHANNELS || "1"));
const SAMPLE_FORMAT = process.env.SAMPLE_FORMAT || "s16le";
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || "64k";
const RTSP_URL = process.env.RTSP_URL || "";
const RTSP_ENABLED = process.env.RTSP_ENABLE !== "0" && Boolean(RTSP_URL);

function normalizeRtspPublishUrl(url) {
  if (!url) return { url, normalized: false };
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "0.0.0.0") {
      return { url, normalized: false };
    }
    parsed.hostname = "0.0.0.0";
    return { url: parsed.toString(), normalized: true };
  } catch {
    return { url, normalized: false };
  }
}

async function main() {
  console.log('BrilliantSole Frame - Microphone Streaming\n');

  const publisherEnabled = selectedTransport() !== "none" && process.env.ZENOH_MIC_ENABLE !== "0";
  const zenoh = publisherEnabled
    ? createPublisher({
        keyPrefix: process.env.ZENOH_MIC_KEY_PREFIX || "bsole/microphone",
        udsPath: process.env.ZENOH_MIC_UDS_PATH || `/tmp/bsole-zenoh-mic-${process.pid}.sock`,
      })
    : null;

  const zenohRawEnabled = Boolean(zenoh) && process.env.ZENOH_MIC_RAW_ENABLE === "1";
  const zenohRawChunkSize = Math.max(1024, Number(process.env.ZENOH_RAW_CHUNK_SIZE || 30000));
  const zenohRawThrottleMs = Math.max(0, Number(process.env.ZENOH_MIC_RAW_THROTTLE_MS || 200));
  let lastRawPublishAt = 0;
  const publishRtsp = normalizeRtspPublishUrl(RTSP_URL);
  const rtsp = RTSP_ENABLED
    ? new RtspPublisher({
        rtspUrl: publishRtsp.url,
        ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
        ffmpegLogLevel: process.env.FFMPEG_LOGLEVEL || "error",
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        sampleFormat: SAMPLE_FORMAT,
        audioBitrate: AUDIO_BITRATE,
      })
    : null;
  let isShuttingDown = false;
  let sampleCount = 0;
  let totalDuration = 0;
  let device = null;

  async function publishRawAudio(samples, meta) {
    if (!zenohRawEnabled) return;
    const now = Date.now();
    if (zenohRawThrottleMs > 0 && now - lastRawPublishAt < zenohRawThrottleMs) return;
    lastRawPublishAt = now;

    const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    const frameId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const b64 = buf.toString("base64");
    const totalChunks = Math.ceil(b64.length / zenohRawChunkSize);
    await zenoh.publish(`${zenoh.keyPrefix}/raw/meta`, {
      ts: Date.now(),
      frameId,
      totalChunks,
      encoding: "base64",
      format: "f32le",
      bytes: buf.length,
      device: meta?.device || null,
      sampleRate: meta?.sampleRate || null,
      bitDepth: meta?.bitDepth || null,
      samples: meta?.samples || null,
    });
    for (let i = 0; i < totalChunks; i += 1) {
      const part = b64.slice(i * zenohRawChunkSize, (i + 1) * zenohRawChunkSize);
      await zenoh.publish(`${zenoh.keyPrefix}/raw/chunk`, {
        ts: Date.now(),
        frameId,
        idx: i,
        data: part,
      });
    }
  }

  async function shutdown({ exitCode = 0, error = null } = {}) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    setTimeout(() => process.exit(exitCode), 3000).unref();

    if (error) {
      console.error(`\n[RTSP] ${error.message}`);
    }

    console.log('\n\nStopping microphone...');
    try {
      if (device) {
        await device.stopMicrophone();
        console.log('Microphone stopped.');
        try { await device.disconnect(); } catch (e) { console.warn("[Microphone] disconnect failed:", e?.message || e); }
      }
      console.log(`\nTotal duration: ${totalDuration.toFixed(1)}s`);
      console.log(`Total samples: ${sampleCount}`);
      if (zenoh) {
        try {
          await zenoh.publish(`${zenoh.keyPrefix}/status`, {
            ts: Date.now(),
            device: { id: device.bluetoothId || device.id, name: device.name },
            status: exitCode === 0 ? "stopped" : "error",
            totalDuration,
            totalSamples: sampleCount,
            error: error?.message || null,
          });
        } catch {}
      }
    } catch (stopError) {
      console.error('Error stopping microphone:', stopError.message);
    }

    if (rtsp) {
      try {
        await rtsp.stop();
      } catch (rtspError) {
        console.error('[RTSP] Error stopping publisher:', rtspError.message);
      }
    }

    if (zenoh) {
      try {
        await zenoh.stop();
      } catch {}
    }

    process.exit(exitCode);
  }

  // Connect to device
  console.log('Connecting to device...');
  const deviceManager = new DeviceManager();
  device = await deviceManager.connectToDevice();
  console.log('Device connected.\n');

  if (zenoh) {
    zenoh.on("error", (e) => {
      if (process.env.DEBUG === "1") console.warn("[Microphone][Zenoh]", e?.message || e);
    });
    await zenoh.start();
    try {
      await zenoh.publish(`${zenoh.keyPrefix}/status`, {
        ts: Date.now(),
        device: { id: device.bluetoothId || device.id, name: device.name },
        status: "connected",
      });
    } catch {}
  }

  // Check microphone availability
  if (!device.hasMicrophone) {
    console.error('Device does not have microphone support');
    process.exit(1);
  }

  // Configure microphone
  console.log(`Configuring microphone: ${SAMPLE_RATE}Hz, ${BIT_DEPTH}-bit`);
  await device.setMicrophoneConfiguration({
    sampleRate: String(SAMPLE_RATE),
    bitDepth: BIT_DEPTH
  });

  // Set sensor rate (5Hz for microphone data packets)
  await device.setSensorConfiguration({ microphone: 5 }, true);

  console.log('Microphone configured.\n');

  if (rtsp) {
    rtsp.on("error", (error) => {
      shutdown({ exitCode: 1, error }).catch(() => process.exit(1));
    });
    if (publishRtsp.normalized) {
      console.log(`[RTSP] normalized publish target from ${RTSP_URL} to ${publishRtsp.url}`);
    }
    console.log(`Starting RTSP publisher: ${publishRtsp.url}`);
    await rtsp.start();
    console.log('RTSP publisher ready.\n');
  }

  // Listen for microphone data
  device.addEventListener('microphoneData', (event) => {
    const { samples, sampleRate, bitDepth } = event.message;

    // Calculate audio metrics
    const rms = calculateRMS(samples);
    const peak = calculatePeak(samples);
    const db = rms > 0 ? (20 * Math.log10(rms)).toFixed(1) : '-∞';

    // Update statistics
    sampleCount += samples.length;
    totalDuration = sampleCount / Number(sampleRate);

    // Print metrics on the same line, overwriting previous output
    const line =
      `${formatLevelBar(rms, 30)} | ` +
      `RMS: ${(rms * 100).toFixed(1)}% | ` +
      `Peak: ${(peak * 100).toFixed(1)}% | ` +
      `dB: ${db} | ` +
      `Duration: ${totalDuration.toFixed(1)}s`;
    const pad = ' '.repeat(Math.max(0, process.stdout.columns - line.length));
    process.stdout.write(`\r${line}${pad}`);

    if (zenoh) {
      const meta = {
        ts: Date.now(),
        device: { id: device.bluetoothId || device.id, name: device.name },
        sampleRate,
        bitDepth,
        rms,
        peak,
        db,
        duration: totalDuration,
        samples: samples?.length || 0,
      };
      zenoh.publish(`${zenoh.keyPrefix}/level`, meta).catch((e) => { if (process.env.DEBUG === "1") console.error('[Mic/Zenoh] level publish error:', e?.message || e); });
      if (zenohRawEnabled && samples && samples.buffer) {
        publishRawAudio(samples, meta).catch((e) => { if (process.env.DEBUG === "1") console.error('[Mic/Zenoh] raw publish error:', e?.message || e); });
      }
    }

    if (rtsp && samples) {
      rtsp.write(samples).catch((error) => {
        shutdown({ exitCode: 1, error }).catch(() => process.exit(1));
      });
    }
  });

  // Listen for microphone status changes
  device.addEventListener('microphoneStatus', (event) => {
    const { microphoneStatus } = event.message;
    console.log(`\nMicrophone status: ${microphoneStatus}`);

    if (zenoh) {
      zenoh.publish(`${zenoh.keyPrefix}/status`, {
        ts: Date.now(),
        device: { id: device.bluetoothId || device.id, name: device.name },
        microphoneStatus,
      }).catch(() => {});
    }
  });

  // Start microphone
  console.log('Starting microphone...');
  await device.startMicrophone();
  console.log('Microphone streaming.\n');
  console.log('Press Ctrl+C to stop\n');

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    shutdown({ exitCode: 0 }).catch(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown({ exitCode: 0 }).catch(() => process.exit(0));
  });
}

// The BrilliantSole library can throw RangeError on malformed microphone packets.
// Catch it here so a bad packet doesn't kill the process.
process.on('uncaughtException', (err) => {
  if (err instanceof RangeError && err.message.includes('bounds of the DataView')) {
    if (process.env.DEBUG === '1') console.warn('[Microphone] bad packet skipped:', err.message);
    return;
  }
  console.error('\nUncaught exception:', err.message);
  process.exit(1);
});

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
