// Simple sensor monitoring
const { Config } = require("../utils/config");
const { SensorManager } = require("./lib/sensor-manager");
const {
    AccelerometerHandler,
    GyroscopeHandler,
    MagnetometerHandler,
    OrientationHandler,
} = require("./lib/motion-sensors");
const { TapDetectorHandler } = require("./lib/activity-sensors");
const { DeviceManager } = require("../utils/device-manager");
const MLGestureDetector = require("./lib/ml/ml-gesture-detector");

async function getDevice() {
    const device = await new DeviceManager().connectToDevice();
    return device;
}

async function main() {
    const enabledSensors = process.env.ENABLED_SENSORS
        ? process.env.ENABLED_SENSORS.split(",").map((s) => s.trim())
        : ["acceleration", "magnetometer", "orientation", "tapDetector"];

    // ML gesture detection (enabled by default if model exists, disable with ML_GESTURES=0)
    const enableMLGestures = process.env.ML_GESTURES !== '0';
    let mlDetector = null;

    if (enableMLGestures) {
        mlDetector = new MLGestureDetector(30); // 30 samples for 1.5s at 20Hz
        console.log('Initializing ML gesture detector...');
        try {
            await mlDetector.ready();
            console.log('✓ ML gesture detector ready\n');
        } catch {
            console.log('⚠ ML model not found, gesture detection disabled\n');
            mlDetector = null;
        }
    }

    console.log("Connecting to device...");
    const device = await getDevice();
    console.log("✓ Connected!\n");

    const deviceSide = process.env.DEVICE_SIDE || null; // 'left' | 'right' | null
    const sensorManager = new SensorManager(device, { enabledSensors, side: deviceSide });
    for (const [sensor, rate] of Object.entries(Config.getSensorRates())) {
        if (rate === null) continue;
        if (enabledSensors.includes(sensor)) {
            try { sensorManager.setSensorRate(sensor, rate); } catch { }
        } else {
            try { sensorManager.enableSensor(sensor, rate); } catch { }
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

    // ML gesture detection event handler
    let latestAcc = null;
    if (mlDetector) {
        mlDetector.on('ml-gesture', (result) => {
            if (result?.results?.length > 0) {
                const top = result.results.reduce((a, b) => (a.value > b.value ? a : b));
                if (top.value > 0.7) { // Only show high-confidence gestures
                    showGesture(`🤖 ML: ${top.label} (${(top.value * 100).toFixed(1)}%)`);
                }
            }
        });
    }

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
            allLines.push('', gestureMessage);
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
    if (enabledSensors.includes("gravity")) sensorLineMap.gravity = lineIndex++;
    if (enabledSensors.includes("linearAcceleration")) sensorLineMap.linearAcceleration = lineIndex++;
    if (enabledSensors.includes("gyroscope")) sensorLineMap.gyroscope = lineIndex++;
    if (enabledSensors.includes("gameRotation")) sensorLineMap.gameRotation = lineIndex++;
    if (enabledSensors.includes("rotation")) sensorLineMap.rotation = lineIndex++;
    if (enabledSensors.includes("magnetometer")) sensorLineMap.magnetometer = lineIndex++;
    if (enabledSensors.includes("orientation")) sensorLineMap.orientation = lineIndex++;
    if (enabledSensors.includes("activity")) sensorLineMap.activity = lineIndex++;
    if (enabledSensors.includes("stepCounter")) sensorLineMap.stepCounter = lineIndex++;
    if (enabledSensors.includes("pressure")) sensorLineMap.pressure = lineIndex++;

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

            // Feed to ML detector
            if (mlDetector) {
                latestAcc = a;
            }
        });
    }

    if (enabledSensors.includes("gravity")) {
        sensorManager.on("gravity", (event) => {
            const g = event.message?.gravity;
            if (!g) return;
            const line = `🌍 Gravity: x:${g.x.toFixed(3)} y:${g.y.toFixed(3)} z:${g.z.toFixed(3)}`;
            sensorLines[sensorLineMap.gravity] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (enabledSensors.includes("linearAcceleration")) {
        sensorManager.on("linearAcceleration", (event) => {
            const la = event.message?.linearAcceleration;
            if (!la) return;
            const line = `➡️  LinAccel: x:${la.x.toFixed(3)} y:${la.y.toFixed(3)} z:${la.z.toFixed(3)}`;
            sensorLines[sensorLineMap.linearAcceleration] = line;
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

    if (enabledSensors.includes("gameRotation")) {
        sensorManager.on("gameRotation", (event) => {
            const r = event.message?.gameRotation;
            if (!r) return;
            const line = `🎮 GameRot: x:${r.x.toFixed(3)} y:${r.y.toFixed(3)} z:${r.z.toFixed(3)} w:${r.w.toFixed(3)}`;
            sensorLines[sensorLineMap.gameRotation] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (enabledSensors.includes("rotation")) {
        sensorManager.on("rotation", (event) => {
            const r = event.message?.rotation;
            if (!r) return;
            const line = `🔃 Rotation: x:${r.x.toFixed(3)} y:${r.y.toFixed(3)} z:${r.z.toFixed(3)} w:${r.w.toFixed(3)}`;
            sensorLines[sensorLineMap.rotation] = line;
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
            let orientation = "Tilted";
            if (isPortrait) orientation = "Portrait";
            else if (isLandscape) orientation = "Landscape";
            const line = `🧭 Orient: H:${heading.toFixed(1)}° P:${pitch.toFixed(1)}° R:${roll.toFixed(1)}° | ${orientation}`;
            sensorLines[sensorLineMap.orientation] = line;
            updateDisplay(sensorLines.filter(Boolean));

            // Feed to ML detector
            if (mlDetector && latestAcc) {
                mlDetector.addSample({
                    accX: latestAcc.x,
                    accY: latestAcc.y,
                    accZ: latestAcc.z,
                    heading: heading,
                    pitch: pitch,
                    roll: roll
                });
            }
        });
    }

    if (enabledSensors.includes("activity")) {
        sensorManager.on("activity", (event) => {
            const act = event.message?.activity;
            if (!act) return;
            const line = `🏃 Activity: ${act.activity ?? act}`;
            sensorLines[sensorLineMap.activity] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (enabledSensors.includes("stepCounter")) {
        sensorManager.on("stepCounter", (event) => {
            const sc = event.message?.stepCounter;
            if (!sc) return;
            const line = `👟 Steps: ${sc.steps ?? sc}`;
            sensorLines[sensorLineMap.stepCounter] = line;
            updateDisplay(sensorLines.filter(Boolean));
        });
    }

    if (enabledSensors.includes("pressure")) {
        sensorManager.on("pressure", (event) => {
            const p = event.message?.pressure;
            if (!p) return;
            const active = p.sensors.filter(s => s.normalizedValue > 0);
            const cop = p.normalizedCenter;
            const side = event.side ? `[${event.side}] ` : "";
            const copStr = cop ? ` | CoP:(${cop.x.toFixed(2)},${cop.y.toFixed(2)})` : "";
            const line = `${side}Pressure: sum:${p.normalizedSum.toFixed(3)} active:${active.length}/${p.sensors.length}${copStr}`;
            sensorLines[sensorLineMap.pressure] = line;
            updateDisplay(sensorLines.filter(Boolean));
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



    try {
        await sensorManager.startSensors();

        console.log("Monitoring active! Press Ctrl+C to stop\n");

        // Handle Ctrl+C and termination
        const shutdown = async () => {
            console.log("\n[sensors] Stopping...");
            await sensorManager.stop();
            try { await device.disconnect(); } catch {}
            process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (err) {
        console.error("❌ Failed to start sensor monitoring:", err);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = main;

