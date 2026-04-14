/**
 * Calculate RMS (Root Mean Square) audio level
 * @param {Float32Array} samples - Audio samples normalized to [-1, 1]
 * @returns {number} RMS level (0-1)
 */
function calculateRMS(samples) {
  if (!samples || samples.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Calculate peak audio level
 * @param {Float32Array} samples - Audio samples normalized to [-1, 1]
 * @returns {number} Peak level (0-1)
 */
function calculatePeak(samples) {
  if (!samples || samples.length === 0) return 0;

  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/**
 * Convert Float32Array audio samples to WAV format
 * Based on SDK's AudioUtils but adapted for Node.js
 * @param {Float32Array} audioData - Audio samples normalized to [-1, 1]
 * @param {number} sampleRate - Sample rate in Hz (e.g., 16000)
 * @param {number} numChannels - Number of channels (1 for mono)
 * @returns {Buffer} WAV file buffer
 */
function float32ArrayToWav(audioData, sampleRate, numChannels = 1) {
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;

  const dataLength = audioData.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataLength);

  // WAV header
  let offset = 0;

  // "RIFF" chunk descriptor
  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(36 + dataLength, offset); offset += 4; // File size - 8
  buffer.write('WAVE', offset); offset += 4;

  // "fmt " sub-chunk
  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4; // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, offset); offset += 2; // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(numChannels, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;
  buffer.writeUInt32LE(sampleRate * blockAlign, offset); offset += 4; // ByteRate
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(bytesPerSample * 8, offset); offset += 2; // BitsPerSample

  // "data" sub-chunk
  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataLength, offset); offset += 4;

  // Write audio data
  for (let i = 0; i < audioData.length; i++) {
    // Convert float [-1, 1] to int16 [-32768, 32767]
    const sample = Math.max(-1, Math.min(1, audioData[i]));
    const int16 = Math.round(sample * 32767);
    buffer.writeInt16LE(int16, offset);
    offset += 2;
  }

  return buffer;
}

/**
 * Format audio level as visual bar
 * @param {number} level - Audio level (0-1)
 * @param {number} width - Bar width in characters
 * @returns {string} Visual bar representation
 */
function formatLevelBar(level, width = 20) {
  const filled = Math.round(level * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

module.exports = {
  calculateRMS,
  calculatePeak,
  float32ArrayToWav,
  formatLevelBar,
};
