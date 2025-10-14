// Clean sensor monitoring with minimal output
const { SensorManager } = require("./lib/sensor-manager");
const {
    AccelerometerHandler,
    GyroscopeHandler,
    MagnetometerHandler,
    OrientationHandler,
} = require("./lib/motion-sensors");
const { TapDetectorHandler } = require("./lib/activity-sensors");

async function main() {
    // Get enabled sensors from environment variable or default
    const enabledSensors = process.env.ENABLED_SENSORS
        ? process.env.ENABLED_SENSORS.split(",").map((s) => s.trim())
        : ["acceleration", "gyroscope", "magnetometer", "orientation", "tapDetector"];

    const sensorManager = new SensorManager({ enabledSensors: enabledSensors });

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

    // Instantiate handlers
    const accelHandler = new AccelerometerHandler();
    const gyroHandler = new GyroscopeHandler();
    const magHandler = new MagnetometerHandler();
    const orientHandler = new OrientationHandler();
    const tapHandler = new TapDetectorHandler();

    sensorManager.on("acceleration", (event) => {
        eventCount++;
        accelHandler.updateData(event.message);
        const data = accelHandler.getData();
        const mag = accelHandler.getMagnitude();
        const a = data.data.acceleration;
        console.log(
            `📱 Accel #${eventCount}: x:${a.x.toFixed(3)} y:${a.y.toFixed(3)} z:${a.z.toFixed(
                3
            )} | mag:${mag?.toFixed(3)}`
        );
    });

    sensorManager.on("gyroscope", (event) => {
        eventCount++;
        gyroHandler.updateData(event.message);
        const data = gyroHandler.getData();
        const rate = gyroHandler.getRotationRate();
        const g = data.data.gyroscope;
        console.log(
            `🔄 Gyro #${eventCount}: x:${g.x.toFixed(3)} y:${g.y.toFixed(3)} z:${g.z.toFixed(
                3
            )} | rate:${rate?.toFixed(3)}°/s`
        );
    });

    sensorManager.on("magnetometer", (event) => {
        eventCount++;
        magHandler.updateData(event.message);
        const data = magHandler.getData();
        const field = magHandler.getFieldStrength();
        const heading = magHandler.getHeading();
        const direction = magHandler.getCompassDirection();
        const m = data.data.magnetometer;
        console.log(
            `🧲 Mag #${eventCount}: x:${m.x.toFixed(1)} y:${m.y.toFixed(1)} z:${m.z.toFixed(
                1
            )} | field:${field?.toFixed(1)}μT | ${heading?.toFixed(0)}° ${direction}`
        );
    });

    sensorManager.on("orientation", (event) => {
        eventCount++;
        orientHandler.updateData(event.message);
        const data = orientHandler.getData();
        const { heading, pitch, roll } = data.data.orientation;
        const isPortrait = orientHandler.isPortrait();
        const isLandscape = orientHandler.isLandscape();
        console.log(
            `🧭 Orient #${eventCount}: H:${heading.toFixed(1)}° P:${pitch.toFixed(
                1
            )}° R:${roll.toFixed(1)}° | ${
                isPortrait ? "Portrait" : isLandscape ? "Landscape" : "Tilted"
            }`
        );
    });

    // Tap detector via handler (debounced + gesture grouping)
    sensorManager.on("tapDetector", (event) => {
        tapHandler.updateData(event.message);
    });

    tapHandler.on("gesture", ({ type }) => {
        if (type === "single") console.log("👉 Single tap");
        else if (type === "double") console.log("👉👉 Double tap");
        else if (type === "triple") console.log("👉👉👉 Triple tap");
    });

    try {
        await sensorManager.connect();
        await sensorManager.startSensors();

        console.log("Monitoring active! Press Ctrl+C to stop\n");

        // Handle Ctrl+C
        process.on("SIGINT", async () => {
            console.log("\n🛑 Stopping sensor monitoring...");
            await sensorManager.stop();
            process.exit(0);
        });
    } catch (err) {
        console.error("❌ Failed to start clean sensor monitoring:", err);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = main;
