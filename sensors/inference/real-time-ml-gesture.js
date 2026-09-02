// Real-time ML gesture detection using live sensor data
const MLGestureDetector = require('../lib/ml/ml-gesture-detector');
const { SensorManager } = require('../lib/sensor-manager');
const { DeviceManager } = require('../../utils/device-manager');

async function main() {
    const detector = new MLGestureDetector(30);

    const isDebugMode = process.env.DEBUG === '1';
    let lastGestureLines = 0;
    detector.on('ml-gesture', (result) => {
        if (isDebugMode) {
            console.log('Real-time ML Gesture:', result);
        } else {
            // Clear previous gesture output
            if (lastGestureLines > 0) {
                process.stdout.write(`\x1b[${lastGestureLines}A`); // Move up
                process.stdout.write('\x1b[0J'); // Clear from cursor to end
            }
            let output = '';
            if (result && result.results && result.results.length > 0) {
                const top = result.results.reduce((a, b) => (a.value > b.value ? a : b));
                output = `Gesture: ${top.label} (${(top.value * 100).toFixed(1)}%)`;
            } else {
                output = 'No gesture detected';
            }
            console.log(output);
            lastGestureLines = output.split('\n').length;
        }
        // You can trigger actions here based on result
    });

    await detector.ready();
    console.log('MLGestureDetector initialized.');

    // Connect to device
    console.log('Connecting to device...');
    const deviceManager = new DeviceManager();
    const device = await deviceManager.connectToDevice();
    console.log('Device connected!');

    // Start sensor manager
    const sensorManager = new SensorManager(device, { enabledSensors: ['acceleration'] });

    sensorManager.on('acceleration', (event) => {
        if (isDebugMode) {
            console.log('[DEBUG] Acceleration event:', event.message);
        }
        const { x, y, z } = event.message.acceleration;
        detector.addSample({ accX: x, accY: y, accZ: z });
    });

    // Start sensors and log
    try {
        await sensorManager.startSensors();
        console.log('Monitoring active! Press Ctrl+C to stop\n');
        process.on('SIGINT', async () => {
            console.log('\n🛑 Stopping sensor monitoring...');
            await sensorManager.stop();
            process.exit(0);
        });
    } catch (err) {
        console.error('❌ Failed to start sensor monitoring:', err);
        process.exit(1);
    }
}

main();
