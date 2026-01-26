// Simple sensor monitoring
const { SensorManager } = require("./lib/sensor-manager");
const {
    AccelerometerHandler,
    GyroscopeHandler,
    MagnetometerHandler,
    OrientationHandler,
} = require("./lib/motion-sensors");
const { TapDetectorHandler } = require("./lib/activity-sensors");
const { ShakeDetectorHandler, NodDetectorHandler } = require("./lib/gesture-detectors");
const { DeviceManager } = require("../utils/device-manager");

async function getDevice() {
    const device = await new DeviceManager().connectToDevice();
    return device;
}

async function main() {
    // Get enabled sensors from environment variable or default to all
    const enabledSensors = process.env.ENABLED_SENSORS
        ? process.env.ENABLED_SENSORS.split(",").map((s) => s.trim())
        : ["acceleration", "gyroscope", "magnetometer", "orientation", "tapDetector"];

    console.log("Connecting to device...");
    const device = await getDevice();
    console.log("✓ Connected!\n");

    const sensorManager = new SensorManager(device, { enabledSensors: enabledSensors });

    // Apply per-sensor device rates from env (supports Hz number or '<ms>ms')
    const roundTo5 = (hz) => Math.max(5, Math.round(hz / 5) * 5);
    const parseRateHz = (raw) => {
        if (!raw) return null;
        if (/ms$/i.test(raw)) {
            const v = Number(raw.replace(/ms$/i, ""));
            if (!Number.isNaN(v) && v > 0) return Math.min(200, 1000 / v);
            return null;
        }
        const hz = Number(raw);
        return !Number.isNaN(hz) && hz > 0 ? hz : null;
    };
    const rateEnv = {
        acceleration: process.env.ACCELERATION_RATE,
        gyroscope: process.env.GYROSCOPE_RATE,
        magnetometer: process.env.MAGNETOMETER_RATE,
        orientation: process.env.ORIENTATION_RATE,
        linearAcceleration: process.env.LINEAR_ACCELERATION_RATE,
        gameRotation: process.env.GAME_ROTATION_RATE,
        rotation: process.env.ROTATION_RATE,
        tapDetector: process.env.TAP_DETECTOR_RATE,
    };
    for (const [sensor, raw] of Object.entries(rateEnv)) {
        const hz = parseRateHz(raw);
        if (!hz) continue;
        const rate = roundTo5(hz);
        if (!enabledSensors.includes(sensor)) {
            try { sensorManager.enableSensor(sensor, rate); } catch {}
        } else {
            try { sensorManager.setSensorRate(sensor, rate); } catch {}
        }
    }

    // Setup clean event handlers
    sensorManager.on("error", (err) => {
        console.error("❌ Sensor error:", err);
    });

    let eventCount = 0;
    let lastLines = 0;
    let gestureMessage = '';
    let gestureTimeout = null;
    
    // Disable in-place updates when DEBUG=1 (verbose output mode)
    const isDebugMode = process.env.DEBUG === '1';

    // Instantiate handlers only for enabled sensors
    const accelHandler = enabledSensors.includes("acceleration") ? new AccelerometerHandler() : null;
    const gyroHandler = enabledSensors.includes("gyroscope") ? new GyroscopeHandler() : null;
    const magHandler = enabledSensors.includes("magnetometer") ? new MagnetometerHandler() : null;
    const orientHandler = enabledSensors.includes("orientation") ? new OrientationHandler() : null;
    const tapHandler = enabledSensors.includes("tapDetector") ? new TapDetectorHandler() : null;
    
    // Gesture detectors (always available if orientation sensor is enabled)
    const shakeHandler = orientHandler ? new ShakeDetectorHandler() : null; // Head shake (horizontal)
    const nodHandler = orientHandler ? new NodDetectorHandler() : null; // Head nod (vertical)

    // Helper to clear previous lines and print new ones
    const updateDisplay = (lines) => {
        if (isDebugMode) {
            // In debug mode, just print without clearing (scrolling output)
            console.log(lines.filter(Boolean).join(' | '));
            return;
        }
        
        // Move cursor up to clear previous lines
        if (lastLines > 0) {
            process.stdout.write(`\x1b[${lastLines}A`); // Move up
            process.stdout.write('\x1b[0J'); // Clear from cursor to end
        }
        // Add gesture line if present
        const allLines = [...lines];
        if (gestureMessage) {
            allLines.push(''); // Empty line separator
            allLines.push(gestureMessage);
        }
        // Print new lines
        process.stdout.write(allLines.join('\n') + '\n');
        lastLines = allLines.length;
    };

    // Helper to show gesture temporarily
    const showGesture = (msg) => {
        if (isDebugMode) {
            // In debug mode, just print the gesture
            console.log(msg);
            return;
        }
        
        gestureMessage = msg;
        updateDisplay(sensorLines.filter(Boolean));
        
        // Clear gesture after 2 seconds
        if (gestureTimeout) clearTimeout(gestureTimeout);
        gestureTimeout = setTimeout(() => {
            gestureMessage = '';
            updateDisplay(sensorLines.filter(Boolean));
        }, 2000);
    };

    // Map sensor types to their display indices
    const sensorLineMap = {};
    let lineIndex = 0;
    if (enabledSensors.includes("acceleration")) sensorLineMap.acceleration = lineIndex++;
    if (enabledSensors.includes("gyroscope")) sensorLineMap.gyroscope = lineIndex++;
    if (enabledSensors.includes("magnetometer")) sensorLineMap.magnetometer = lineIndex++;
    if (enabledSensors.includes("orientation")) sensorLineMap.orientation = lineIndex++;
    
    const sensorLines = new Array(lineIndex);

    if (accelHandler) {
        sensorManager.on("acceleration", (event) => {
            eventCount++;
            accelHandler.updateData(event.message);
            const data = accelHandler.getData();
            const mag = accelHandler.getMagnitude();
            const a = data.data.acceleration;
            const line = `📱 Accel #${eventCount}: x:${a.x.toFixed(3)} y:${a.y.toFixed(3)} z:${a.z.toFixed(3)} | mag:${mag?.toFixed(3)}`;
            sensorLines[sensorLineMap.acceleration] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (gyroHandler) {
        sensorManager.on("gyroscope", (event) => {
            gyroHandler.updateData(event.message);
            const data = gyroHandler.getData();
            const rate = gyroHandler.getRotationRate();
            const g = data.data.gyroscope;
            const line = `🔄 Gyro: x:${g.x.toFixed(3)} y:${g.y.toFixed(3)} z:${g.z.toFixed(3)} | rate:${rate?.toFixed(3)}°/s`;
            sensorLines[sensorLineMap.gyroscope] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (magHandler) {
        sensorManager.on("magnetometer", (event) => {
            magHandler.updateData(event.message);
            const data = magHandler.getData();
            const field = magHandler.getFieldStrength();
            const heading = magHandler.getHeading();
            const direction = magHandler.getCompassDirection();
            const m = data.data.magnetometer;
            const line = `🧲 Mag: x:${m.x.toFixed(1)} y:${m.y.toFixed(1)} z:${m.z.toFixed(1)} | field:${field?.toFixed(1)}μT | ${heading?.toFixed(0)}° ${direction}`;
            sensorLines[sensorLineMap.magnetometer] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (orientHandler) {
        sensorManager.on("orientation", (event) => {
            orientHandler.updateData(event.message);
            const data = orientHandler.getData();
            const { heading, pitch, roll } = data.data.orientation;
            const isPortrait = orientHandler.isPortrait();
            const isLandscape = orientHandler.isLandscape();
            const line = `🧭 Orient: H:${heading.toFixed(1)}° P:${pitch.toFixed(1)}° R:${roll.toFixed(1)}° | ${isPortrait ? "Portrait" : isLandscape ? "Landscape" : "Tilted"}`;
            sensorLines[sensorLineMap.orientation] = line;
            updateDisplay(sensorLines.filter(Boolean));
            
            // Update gesture detectors
            if (nodHandler) {
                nodHandler.updateData(event.message);
            }
            if (shakeHandler) {
                shakeHandler.updateData(event.message);
            }
        });
    }

    // Tap detector via handler (debounced + gesture grouping)
    if (tapHandler) {
        sensorManager.on("tapDetector", (event) => {
            tapHandler.updateData(event.message);
        });

        tapHandler.on("gesture", ({ type }) => {
            if (type === "single") showGesture("👉 Single tap");
            else if (type === "double") showGesture("👉👉 Double tap");
            else if (type === "triple") showGesture("👉👉👉 Triple tap");
        });
    }

    // Head shake gesture detector (horizontal)
    if (shakeHandler) {
        shakeHandler.on("gesture", ({ type, cycles, headingRange }) => {
            showGesture(`🙅 Shake detected! (cycles: ${cycles}, range: ${headingRange.toFixed(1)}°)`);
        });
    }

    // Nod gesture detector (vertical)
    if (nodHandler) {
        nodHandler.on("gesture", ({ type, cycles, pitchRange }) => {
            showGesture(`🙂 Nod detected! (cycles: ${cycles}, range: ${pitchRange.toFixed(1)}°)`);
        });
    }

    try {
        await sensorManager.startSensors();

        console.log("Monitoring active! Press Ctrl+C to stop\n");

        // Handle Ctrl+C
        process.on("SIGINT", async () => {
            console.log("\n🛑 Stopping sensor monitoring...");
            await sensorManager.stop();
            process.exit(0);
        });
    } catch (err) {
        console.error("❌ Failed to start sensor monitoring:", err);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = main;

