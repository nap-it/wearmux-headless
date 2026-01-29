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
const { ZenohManager } = require("../utils/zenoh-manager");
const readline = require("readline");

// Configuration
const SAMPLE_RATE = process.env.SAMPLE_RATE || '16000';
const BIT_DEPTH = process.env.BIT_DEPTH || '16';

async function main() {
  console.log('BrilliantSole Frame - Microphone Streaming\n');

  const zenohEnabled = process.env.ZENOH_ENABLE === "1" && process.env.ZENOH_MIC_ENABLE !== "0";
  const zenoh = zenohEnabled
    ? new ZenohManager({
        keyPrefix: process.env.ZENOH_MIC_KEY_PREFIX || "bsole/microphone",
        udsPath: process.env.ZENOH_MIC_UDS_PATH || `/tmp/bsole-zenoh-mic-${process.pid}.sock`,
      })
    : null;

  const zenohRawEnabled = Boolean(zenoh) && process.env.ZENOH_MIC_RAW_ENABLE === "1";
  const zenohRawChunkSize = Math.max(1024, Number(process.env.ZENOH_RAW_CHUNK_SIZE || 30000));
  const zenohRawThrottleMs = Math.max(0, Number(process.env.ZENOH_MIC_RAW_THROTTLE_MS || 200));
  let lastRawPublishAt = 0;

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

  // Connect to device
  console.log('Connecting to device...');
  const deviceManager = new DeviceManager();
  const device = await deviceManager.connectToDevice();
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
    sampleRate: SAMPLE_RATE,
    bitDepth: BIT_DEPTH
  });

  // Set sensor rate (5Hz for microphone data packets)
  await device.setSensorConfiguration({ microphone: 5 });

  console.log('Microphone configured.\n');

  // Audio level tracking
  let sampleCount = 0;
  let totalDuration = 0;

  // Listen for microphone data
  device.addEventListener('microphoneData', (event) => {
    const { samples, sampleRate, bitDepth } = event.message;

    // Calculate audio metrics
    const rms = calculateRMS(samples);
    const peak = calculatePeak(samples);
    const db = rms > 0 ? (20 * Math.log10(rms)).toFixed(1) : '-∞';

    // Update statistics
    sampleCount += samples.length;
    totalDuration = sampleCount / parseInt(sampleRate);

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
      zenoh.publish(`${zenoh.keyPrefix}/level`, meta).catch(() => {});
      if (zenohRawEnabled && samples && samples.buffer) {
        publishRawAudio(samples, meta).catch(() => {});
      }
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
  process.on('SIGINT', async () => {
    console.log('\n\nStopping microphone...');
    try {
      await device.stopMicrophone();
      console.log('Microphone stopped.');
      console.log(`\nTotal duration: ${totalDuration.toFixed(1)}s`);
      console.log(`Total samples: ${sampleCount}`);
      if (zenoh) {
        try {
          await zenoh.publish(`${zenoh.keyPrefix}/status`, {
            ts: Date.now(),
            device: { id: device.bluetoothId || device.id, name: device.name },
            status: "stopped",
            totalDuration,
            totalSamples: sampleCount,
          });
        } catch {}
        try { await zenoh.stop(); } catch {}
      }
    } catch (error) {
      console.error('Error stopping microphone:', error.message);
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
