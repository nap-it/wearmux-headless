// Interactive sensor monitoring with menu selection
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
const readline = require("readline");

async function getDevice() {
    const device = await new DeviceManager().connectToDevice();
    return device;
}

function showMenu() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        console.log("\n=== Sensor Monitoring Menu ===");
        console.log("1. Motion sensors (acceleration, magnetometer, orientation)");
        console.log("2. Activity sensors (tap detector)");
        console.log("3. Gesture sensors (nod & shake detection)");
        console.log("0. Exit\n");

        rl.question("Select option (0-3): ", (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function selectSensors() {
    // Check if ENABLED_SENSORS env var is set (skip menu)
    if (process.env.ENABLED_SENSORS) {
        return process.env.ENABLED_SENSORS.split(",").map((s) => s.trim());
    }

    const choice = await showMenu();
    
    let enabledSensors = [];
    
    switch (choice) {
        case "1":
            enabledSensors = ["acceleration", "magnetometer", "orientation"];
            console.log("\n✓ Selected: Motion sensors (Frame: accel, mag, orient)");
            break;
        case "2":
            enabledSensors = ["tapDetector"];
            console.log("\n✓ Selected: Activity sensors");
            break;
        case "3":
            enabledSensors = ["orientation"]; // Only orientation needed for nod detection
            console.log("\n✓ Selected: Gesture sensors (nod detection)");
            break;
        case "0":
            console.log("\nExiting...");
            process.exit(0);
            break;
        default:
            console.log("\n✗ Invalid option. Exiting.");
            process.exit(0);
    }
    
    return enabledSensors;
}

async function main() {
    // Show menu to select sensors
    const enabledSensors = await selectSensors();
    
    // Enable gesture detection only for gesture sensors option (option 3)
    const enableGestures = enabledSensors.length === 1 && enabledSensors.includes("orientation");

    console.log("\nConnecting to device...");
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
        console.error("[ERROR] Sensor error:", err);
    });

    let eventCount = 0;
    let lastLines = 0;

    // Instantiate handlers only for enabled sensors
    const accelHandler = enabledSensors.includes("acceleration") ? new AccelerometerHandler() : null;
    const gyroHandler = enabledSensors.includes("gyroscope") ? new GyroscopeHandler() : null;
    const magHandler = enabledSensors.includes("magnetometer") ? new MagnetometerHandler() : null;
    const orientHandler = enabledSensors.includes("orientation") ? new OrientationHandler() : null;
    const tapHandler = enabledSensors.includes("tapDetector") ? new TapDetectorHandler() : null;
    
    // Gesture detectors are opt-in via menu selection
    const shakeHandler = (enableGestures && enabledSensors.includes("acceleration")) ? new ShakeDetectorHandler() : null;
    const nodHandler = (enableGestures && enabledSensors.includes("orientation")) ? new NodDetectorHandler() : null;

    // Helper to clear previous lines and print new ones
    const updateDisplay = (lines) => {
        // Move cursor up to clear previous lines
        if (lastLines > 0) {
            process.stdout.write(`\x1b[${lastLines}A`); // Move up
            process.stdout.write('\x1b[0J'); // Clear from cursor to end
        }
        // Print new lines
        process.stdout.write(lines.join('\n') + '\n');
        lastLines = lines.length;
    };

    // Map sensor types to their display indices
    // Don't show orientation data if only gesture detection is enabled
    const showOrientationData = !(enableGestures && enabledSensors.length === 1 && enabledSensors.includes("orientation"));
    
    const sensorLineMap = {};
    let lineIndex = 0;
    if (enabledSensors.includes("acceleration")) sensorLineMap.acceleration = lineIndex++;
    if (enabledSensors.includes("gyroscope")) sensorLineMap.gyroscope = lineIndex++;
    if (enabledSensors.includes("magnetometer")) sensorLineMap.magnetometer = lineIndex++;
    if (enabledSensors.includes("orientation") && showOrientationData) sensorLineMap.orientation = lineIndex++;
    
    const sensorLines = new Array(lineIndex);

    if (enabledSensors.includes("acceleration")) {
        sensorManager.on("acceleration", (event) => {
            eventCount++;
            accelHandler.updateData(event.message);
            const data = accelHandler.getData();
            const mag = accelHandler.getMagnitude();
            const a = data.data.acceleration;
            const line = `[Accel] #${eventCount}: x:${a.x.toFixed(3)} y:${a.y.toFixed(3)} z:${a.z.toFixed(3)} | mag:${mag?.toFixed(3)}`;
            sensorLines[sensorLineMap.acceleration] = line;
            updateDisplay(sensorLines.filter(Boolean));
            
            // Update shake detector only if gestures are enabled
            if (enableGestures && shakeHandler) {
                shakeHandler.updateData(event.message);
            }
        });
    }

    if (enabledSensors.includes("gyroscope")) {
        sensorManager.on("gyroscope", (event) => {
            gyroHandler.updateData(event.message);
            const data = gyroHandler.getData();
            const rate = gyroHandler.getRotationRate();
            const g = data.data.gyroscope;
            const line = `[Gyro] x:${g.x.toFixed(3)} y:${g.y.toFixed(3)} z:${g.z.toFixed(3)} | rate:${rate?.toFixed(3)}°/s`;
            sensorLines[sensorLineMap.gyroscope] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (enabledSensors.includes("magnetometer")) {
        sensorManager.on("magnetometer", (event) => {
            magHandler.updateData(event.message);
            const data = magHandler.getData();
            const field = magHandler.getFieldStrength();
            const heading = magHandler.getHeading();
            const direction = magHandler.getCompassDirection();
            const m = data.data.magnetometer;
            const line = `[Mag] x:${m.x.toFixed(1)} y:${m.y.toFixed(1)} z:${m.z.toFixed(1)} | field:${field?.toFixed(1)}μT | ${heading?.toFixed(0)}° ${direction}`;
            sensorLines[sensorLineMap.magnetometer] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (enabledSensors.includes("orientation")) {
        sensorManager.on("orientation", (event) => {
            orientHandler.updateData(event.message);
            
            // Only show orientation data if not in gesture-only mode
            if (showOrientationData) {
                const data = orientHandler.getData();
                const { heading, pitch, roll } = data.data.orientation;
                const isPortrait = orientHandler.isPortrait();
                const isLandscape = orientHandler.isLandscape();
                const line = `[Orient] H:${heading.toFixed(1)}° P:${pitch.toFixed(1)}° R:${roll.toFixed(1)}° | ${isPortrait ? "Portrait" : isLandscape ? "Landscape" : "Tilted"}`;
                sensorLines[sensorLineMap.orientation] = line;
                updateDisplay(sensorLines.filter(Boolean));
            }
            
            // Update nod detector only if gestures are enabled
            if (enableGestures && nodHandler) {
                nodHandler.updateData(event.message);
            }
        });
    }

    // Tap detector via handler (debounced + gesture grouping)
    if (enabledSensors.includes("tapDetector")) {
        sensorManager.on("tapDetector", (event) => {
            tapHandler.updateData(event.message);
        });
    }

    if (tapHandler) {
        tapHandler.on("gesture", ({ type }) => {
            const msg = type === "single" ? "[Tap] Single tap" : 
                       type === "double" ? "[Tap] Double tap" : 
                       "[Tap] Triple tap";
            _printGesture(msg);
        });
    }

    if (shakeHandler) {
        shakeHandler.on("gesture", ({ type, intensity }) => {
            const msg = `[Shake] Detected (intensity: ${intensity.toFixed(2)})`;
            _printGesture(msg);
        });
    }

    if (nodHandler) {
        nodHandler.on("gesture", ({ type, cycles }) => {
            const msg = `[Nod] Detected (${cycles} cycle${cycles > 1 ? 's' : ''})`;
            _printGesture(msg);
        });
    }

    // Helper to print gestures below sensor display
    function _printGesture(msg) {
        if (lastLines > 0) {
            process.stdout.write(`\x1b[${lastLines}B`); // Move down to end
        }
        console.log(msg);
        // Restore cursor position
        if (lastLines > 0) {
            process.stdout.write(`\x1b[${lastLines}A`); // Move back up
        }
    }

    try {
        await sensorManager.startSensors();

        console.log("Monitoring active! Press Ctrl+C to stop\n");

        // Handle Ctrl+C
        process.on("SIGINT", async () => {
            console.log("\n[STOP] Stopping sensor monitoring...");
            await sensorManager.stop();
            process.exit(0);
        });
    } catch (err) {
        console.error("[ERROR] Failed to start sensor monitoring:", err);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = main;

