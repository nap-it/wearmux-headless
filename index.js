#!/usr/bin/env node

/**
 * WearMux Headless main CLI
 *
 * Usage:
 *   node index.js <feature>
 *
 * Features:
 *   microphone   - Real-time microphone streaming
 *   record       - Record audio samples
 *   sensors      - Sensor data streaming
 *   display      - Display features
 *   camera       - Camera features
 *
 * Example:
 *   node index.js microphone
 */

const { spawn } = require('child_process');
const path = require('path');

const features = {
  microphone: 'microphone/index.js',
  record: 'microphone/record-audio.js',
  sensors: 'sensors/index.js',
  display: 'display/index.js',
  camera: 'camera/index.js',
};

function printHelp() {
  console.log('WearMux Headless CLI');
  console.log('Usage: node index.js <feature>');
  console.log('Features:');
  Object.keys(features).forEach(f => {
    console.log(`  ${f.padEnd(12)}- Run ${features[f]}`);
  });
  console.log('\nExample: node index.js microphone');
}

const arg = process.argv[2];
if (!arg || !features[arg]) {
  printHelp();
  process.exit(1);
}

const child = spawn(process.execPath, [
  path.join(__dirname, 'tools/run-with-config.js'),
  '--config', process.env.WEARMUX_CONFIG_PATH || path.join(__dirname, 'config'),
  path.join(__dirname, features[arg]),
], { stdio: 'inherit' });
child.on('exit', code => process.exit(code));
