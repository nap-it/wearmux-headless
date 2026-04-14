#!/usr/bin/env node

/**
 * Audio Recording Script
 * 
 * Records audio from BrilliantSole Frame microphone and saves to WAV file.
 * 
 * Usage:
 *   node record-audio.js --duration 10 --sampleRate 16000 --bitDepth 16
 * 
 * Options:
 *   --duration <seconds>  Recording duration (default: 5)
 *   --sampleRate <hz>     Sample rate: 8000 or 16000 (default: 16000)
 *   --bitDepth <bits>     Bit depth: 8 or 16 (default: 16)
 *   --output <filename>   Output filename (default: auto-generated)
 */

const fs = require('fs');
const path = require('path');
const { DeviceManager } = require('../utils/device-manager');
const { float32ArrayToWav, calculateRMS, formatLevelBar } = require('./lib/audio-utils');

// Parse command line arguments
function parseArgs() {
  const args = {
    duration: 5,
    sampleRate: '16000',
    bitDepth: '16',
    output: null
  };

  for (let i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
      case '--duration':
        args.duration = parseInt(process.argv[++i]);
        break;
      case '--sampleRate':
        args.sampleRate = process.argv[++i];
        break;
      case '--bitDepth':
        args.bitDepth = process.argv[++i];
        break;
      case '--output':
        args.output = process.argv[++i];
        break;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs();

  console.log('[INFO] BrilliantSole Frame - Audio Recorder\n');
  console.log(`[INFO] Duration: ${args.duration}s`);
  console.log(`[INFO] Sample Rate: ${args.sampleRate}Hz`);
  console.log(`[INFO] Bit Depth: ${args.bitDepth}-bit\n`);

  // Connect to device
  console.log('[INFO] Connecting to device...');
  const deviceManager = new DeviceManager();
  const device = await deviceManager.connectToDevice();
  console.log('[STATUS] Device connected.\n');

  // Check microphone availability
  if (!device.hasMicrophone) {
    console.error('[ERROR] Device does not have microphone support');
    process.exit(1);
  }

  // Configure microphone
  console.log('[INFO] Configuring microphone...');
  await device.setMicrophoneConfiguration({
    sampleRate: args.sampleRate,
    bitDepth: args.bitDepth
  });
  await device.setSensorConfiguration({ microphone: 5 }, true);
  console.log('[STATUS] Microphone configured.\n');

  // Recording buffer
  const recordingData = [];
  let recordingStartTime = null;
  let isRecording = false;

  // Listen for microphone data
  device.addEventListener('microphoneData', (event) => {
    if (!isRecording) return;

    const { samples } = event.message;
    recordingData.push(samples);

    // Calculate progress
    const elapsed = (Date.now() - recordingStartTime) / 1000;
    const progress = Math.min(elapsed / args.duration, 1);
    const rms = calculateRMS(samples);

    // Display progress
    process.stdout.write('\r\x1b[K');
    process.stdout.write(
      `[INFO] Recording: ${formatLevelBar(progress, 30)} | ` +
      `${elapsed.toFixed(1)}s / ${args.duration}s | ` +
      `Level: ${formatLevelBar(rms, 10)}`
    );
  });

  // Start microphone
  console.log('Starting microphone...');
  await device.startMicrophone();
  console.log('[STATUS] Microphone started.\n');

  // Start recording
  console.log('[INFO] Recording...\n');
  isRecording = true;
  recordingStartTime = Date.now();

  // Wait for duration
  await new Promise(resolve => setTimeout(resolve, args.duration * 1000));

  // Stop recording
  isRecording = false;
  console.log('\n\n[INFO] Stopping recording...');
  await device.stopMicrophone();
  console.log('[STATUS] Recording stopped.\n');

  // Combine all samples
  console.log('[INFO] Processing audio data...');
  const totalSamples = recordingData.reduce((sum, arr) => sum + arr.length, 0);
  const combinedSamples = new Float32Array(totalSamples);
  let offset = 0;
  for (const samples of recordingData) {
    combinedSamples.set(samples, offset);
    offset += samples.length;
  }

  console.log(`[INFO] Total samples: ${totalSamples}`);
  console.log(`[INFO] Actual duration: ${(totalSamples / parseInt(args.sampleRate)).toFixed(2)}s`);

  // Convert to WAV
  console.log('[INFO] Converting to WAV format...');
  const wavBuffer = float32ArrayToWav(combinedSamples, parseInt(args.sampleRate), 1);

  // Generate filename if not provided
  const outputDir = path.join(__dirname, 'recordings');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = args.output ||
    `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
  const outputPath = path.join(outputDir, filename);

  // Save to file
  console.log(`[INFO] Saving to: ${outputPath}`);
  fs.writeFileSync(outputPath, wavBuffer);

  const fileSizeKB = (wavBuffer.length / 1024).toFixed(2);
  console.log(`[INFO] Saved. (${fileSizeKB} KB)\n`);

  try { await device.disconnect(); } catch (e) { console.warn("[record-audio] disconnect failed:", e?.message || e); }
  process.exit(0);
}

main().catch((error) => {
  console.error('\n[ERROR] Error:', error.message);
  process.exit(1);
});
