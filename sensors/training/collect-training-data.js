#!/usr/bin/env node

/**
 * Edge Impulse Training Data Collector
 * 
 * This script collects sensor data from BrilliantSole Frame for ML training.
 * 
 * Usage:
 *   node collect-training-data.js --label nod --duration 60
 *   node collect-training-data.js --label shake --duration 60
 *   node collect-training-data.js --label idle --duration 60
 * 
 * Output: JSON files compatible with Edge Impulse data ingestion
 */

const { DeviceManager } = require("../../utils/device-manager");
const fs = require("fs");
const path = require("path");

// Configuration
const CONFIG = {
    sampleRate: 20, // Hz - matches Edge Impulse examples
    sensors: ["acceleration", "orientation"], // Sensors to collect
    outputDir: path.join(__dirname, "../../training-data"),
};

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const params = {
        label: "unknown",
        duration: 10, // seconds
        output: null,
    };
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--label" && args[i + 1]) {
            params.label = args[i + 1];
            i++;
        } else if (args[i] === "--duration" && args[i + 1]) {
            params.duration = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === "--output" && args[i + 1]) {
            params.output = args[i + 1];
            i++;
        }
    }
    
    return params;
}

// Data collector class
class TrainingDataCollector {
    constructor(device, label, duration) {
        this.device = device;
        this.label = label;
        this.duration = duration;
        this.samples = [];
        this.startTime = null;
        this.isCollecting = false;
    }
    
    async start() {
        console.log(`\n📊 Starting data collection for label: "${this.label}"`);
        console.log(`⏱️  Duration: ${this.duration} seconds`);
        console.log(`📡 Sample rate: ${CONFIG.sampleRate} Hz`);
        console.log(`🎯 Sensors: ${CONFIG.sensors.join(", ")}\n`);
        
        // Configure sensors
        const sensorConfiguration = {};
        CONFIG.sensors.forEach((sensor) => {
            sensorConfiguration[sensor] = CONFIG.sampleRate;
        });
        
        await this.device.setSensorConfiguration(sensorConfiguration, true);
        
        // Setup event listeners
        this._setupListeners();
        
        // Start collection
        this.isCollecting = true;
        this.startTime = Date.now();
        
        console.log("🟢 Recording started! Perform the gesture now...\n");
        
        // Wait for duration
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                const elapsed = (Date.now() - this.startTime) / 1000;
                const remaining = this.duration - elapsed;
                
                if (remaining <= 0) {
                    clearInterval(interval);
                    this.isCollecting = false;
                    resolve();
                } else {
                    process.stdout.write(`\r⏳ Recording... ${remaining.toFixed(1)}s remaining (${this.samples.length} samples collected)`);
                }
            }, 100);
        });
        
        console.log("\n\n✅ Recording complete!");
        console.log(`📦 Collected ${this.samples.length} samples\n`);
    }
    
    _setupListeners() {
        // Collect data from all configured sensors
        CONFIG.sensors.forEach((sensorType) => {
            this.device.addEventListener(sensorType, (event) => {
                if (!this.isCollecting) return;
                
                const data = event.message[sensorType] || event.message;
                const timestamp = Date.now() - this.startTime;
                
                // Store sample in Edge Impulse format
                const sample = {
                    timestamp,
                    sensorType,
                    data: this._flattenSensorData(sensorType, data),
                };
                
                this.samples.push(sample);
            });
        });
    }
    
    _flattenSensorData(sensorType, data) {
        // Flatten sensor data to array format for ML
        if (sensorType === "acceleration") {
            return [data.x, data.y, data.z];
        } else if (sensorType === "magnetometer") {
            return [data.x, data.y, data.z];
        } else if (sensorType === "orientation") {
            return [data.heading, data.pitch, data.roll];
        } else {
            return [JSON.stringify(data)];
        }
    }
    
    save(outputPath) {
        // Create output directory if it doesn't exist
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        // Convert samples to Edge Impulse format
        const edgeImpulseData = this._convertToEdgeImpulseFormat();
        
        // Save to file
        fs.writeFileSync(outputPath, JSON.stringify(edgeImpulseData, null, 2));
        
        console.log(`💾 Data saved to: ${outputPath}`);
        console.log(`📊 Format: Edge Impulse JSON`);
        console.log(`🏷️  Label: ${this.label}`);
        console.log(`📦 Samples: ${this.samples.length}\n`);
    }
    
    _convertToEdgeImpulseFormat() {
        // Group samples by timestamp to create feature vectors
        const timeSeriesData = [];
        const samplesByTimestamp = {};
        
        this.samples.forEach((sample) => {
            const ts = Math.floor(sample.timestamp / (1000 / CONFIG.sampleRate));
            if (!samplesByTimestamp[ts]) {
                samplesByTimestamp[ts] = {};
            }
            samplesByTimestamp[ts][sample.sensorType] = sample.data;
        });
        
        // Convert to time-series array
        Object.keys(samplesByTimestamp)
            .sort((a, b) => parseInt(a) - parseInt(b))
            .forEach((ts) => {
                const features = [];
                
                // Add features in consistent order
                CONFIG.sensors.forEach((sensorType) => {
                    if (samplesByTimestamp[ts][sensorType]) {
                        features.push(...samplesByTimestamp[ts][sensorType]);
                    } else {
                        // Fill missing sensors with zeros
                        const size = this._getSensorSize(sensorType);
                        features.push(...Array(size).fill(0));
                    }
                });
                
                timeSeriesData.push({
                    timestamp: parseInt(ts) * (1000 / CONFIG.sampleRate),
                    features,
                });
            });
        
        return {
            protected: {
                ver: "v1",
                alg: "none",
            },
            signature: "0",
            payload: {
                device_name: "BrilliantSole Frame",
                device_type: "BRILLIANTSOLE_FRAME",
                interval_ms: 1000 / CONFIG.sampleRate,
                sensors: this._getSensorSchema(),
                values: timeSeriesData.map((d) => d.features),
            },
            metadata: {
                label: this.label,
                duration_ms: this.duration * 1000,
                sample_count: timeSeriesData.length,
                collected_at: new Date().toISOString(),
            },
        };
    }
    
    _getSensorSchema() {
        const schema = [];
        CONFIG.sensors.forEach((sensorType) => {
            if (sensorType === "acceleration") {
                schema.push({ name: "accX", units: "m/s2" });
                schema.push({ name: "accY", units: "m/s2" });
                schema.push({ name: "accZ", units: "m/s2" });
            } else if (sensorType === "orientation") {
                schema.push({ name: "heading", units: "rad" });
                schema.push({ name: "pitch", units: "rad" });
                schema.push({ name: "roll", units: "rad" });
            }
        });
        return schema;
    }
    
    _getSensorSize(sensorType) {
        if (["acceleration", "magnetometer", "orientation"].includes(sensorType)) {
            return 3;
        }
        return 1;
    }
}

// Main function
async function main() {
    const params = parseArgs();
    
    console.log("╔═══════════════════════════════════════════════════════╗");
    console.log("║   Edge Impulse Training Data Collector               ║");
    console.log("║   BrilliantSole Frame Gesture Recognition            ║");
    console.log("╚═══════════════════════════════════════════════════════╝");
    
    // Connect to device
    console.log("\n🔌 Connecting to BrilliantSole Frame...");
    const deviceManager = new DeviceManager();
    const device = await deviceManager.connectToDevice();
    console.log("✅ Connected!\n");
    
    // Create collector
    const collector = new TrainingDataCollector(device, params.label, params.duration);
    
    // Start collection
    await collector.start();
    
    // Save data
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${params.label}_${timestamp}.json`;
    const outputPath = params.output || path.join(CONFIG.outputDir, filename);
    
    collector.save(outputPath);
    
    // Cleanup
    if (device && device.isConnected && typeof device.isConnected === 'function' ? device.isConnected() : true) {
        console.log("🔌 Disconnecting...");
        try {
            await deviceManager.disconnect();
            console.log("✅ Done!\n");
        } catch (e) {
            console.warn("⚠️  Disconnect error (already disconnected):", e.message);
        }
    } else {
        console.log("ℹ️  Device already disconnected.");
    }
    
    console.log("📝 Next steps:");
    console.log("   1. Collect more samples for different gestures");
    console.log("   2. Upload data to Edge Impulse Studio");
    console.log("   3. Train your model");
    console.log("   4. Export and use with run-inference.js\n");
}

// Run
main().catch((error) => {
    console.error("\n❌ Error:", error.message);
    process.exit(1);
});

