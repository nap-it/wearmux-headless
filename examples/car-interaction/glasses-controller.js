#!/usr/bin/env node

/**
 * Glasses Controller - Interactive Car Use Case
 * 
 * This script:
 * 1. Connects to BrilliantSole Frame glasses
 * 2. Subscribes to car messages via Zenoh
 * 3. Detects nod/shake gestures using ML model
 * 4. Displays messages on the glasses
 * 5. Publishes gesture responses back to the car
 * 
 * Demo mode (DEMO_MODE=1): Skips device connection, uses keyboard (y/n) for gestures
 */

const path = require("path");
const { DeviceManager } = require("../../utils/device-manager");
const { ZenohManager } = require("../../utils/zenoh-manager");
const { ZenohSubscriber } = require("../../utils/zenoh-subscriber");
const { SensorManager } = require("../../sensors/lib/sensor-manager");
const MLGestureDetector = require("../../sensors/lib/ml-gesture-detector");
const { TextDisplay } = require("../../display/lib/text-display");

// State machine states
const STATE = {
    IDLE: "idle",
    WAITING_FOR_GESTURE: "waiting_for_gesture",
    SHOWING_CONFIRMATION: "showing_confirmation",
};

class GlassesController {
    constructor() {
        this.device = null;
        this.textDisplay = null;
        this.sensorManager = null;
        this.mlDetector = null;
        this.zenohPublisher = null;
        this.zenohSubscriber = null;
        
        this.state = STATE.IDLE;
        this.currentQuestion = null;
        this.gestureTimeout = null;
        
        this.demoMode = process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
        
        // Configuration
        this.config = {
            sensorRate: 20, // Hz
            gestureConfidenceThreshold: 0.5, // General threshold for any recognized gesture
            nodConfidenceThreshold: 0.8, // Specific threshold for 'nod' gesture
            shakeConfidenceThreshold: 0.8, // Specific threshold for 'shake' gesture
            gestureTimeoutMs: 8000, // 8 seconds to respond (more time for gesture)
            fontSize: 24,
        };

        // Latency tracking
        this.approachReceiveTime = null;
        this.gestureResponseSendTime = null;
    }

    async initialize() {
        console.log("Glasses controller\n");
        if (this.demoMode) {
            console.log("DEMO MODE - No device required. Use [y] for yes, [n] for no.\n");
            await this._initializeDemoMode();
        } else {
            await this._initializeWithDevice();
        }
    }

    async _initializeDemoMode() {
        this.device = {
            bluetoothId: "DEMO",
            id: "DEMO",
            name: "Demo Glasses",
        };
        
        console.log("Initializing Zenoh publisher...");
        this.zenohPublisher = new ZenohManager({
            keyPrefix: "gesture",
            udsPath: `/tmp/bsole-zenoh-glasses-pub-${process.pid}.sock`,
        });
        
        await this.zenohPublisher.start();
        this.zenohPublisher.setDeviceInfo({ id: "DEMO", name: "Demo Glasses" });
        console.log("Zenoh publisher ready");
        
        console.log("Initializing Zenoh subscriber...");
        this.zenohSubscriber = new ZenohSubscriber({
            keyExpression: "car/**",
            udsPath: `/tmp/bsole-zenoh-glasses-sub-${process.pid}.sock`,
        });
        
        this.zenohSubscriber.on("message", (msg) => this._handleZenohMessage(msg));
        this.zenohSubscriber.on("error", (err) => console.error("Zenoh subscriber error:", err.message));
        
        await this.zenohSubscriber.start();
        console.log("Zenoh subscriber ready\n");
        console.log("Demo mode ready! Waiting for car approach...\n");
    }

    async _initializeWithDevice() {
        // Connect to device
        console.log("Connecting to BrilliantSole Frame...");
        const deviceManager = new DeviceManager();
        this.device = await deviceManager.connectToDevice();
        console.log("Connected to:", this.device.name || this.device.id);
        
        // Wait for display to be ready
        if (!this.device.isDisplayAvailable) {
            console.log("Waiting for display...");
            await this.device.waitForEvent("isDisplayAvailable");
        }
        
        if (!this.device.isDisplayReady) {
            try {
                await this.device.waitForEvent("displayReady");
            } catch {}
        }
        
        // Wake display if asleep
        if (this.device.displayStatus === "asleep") {
            await this.device.wakeDisplay();
        }
        
        // Set brightness for visibility
        await this.device.setDisplayBrightness("high", true);
        
        // Initialize text display
        console.log("Initializing text display...");
        this.textDisplay = new TextDisplay(this.device, {
            fontSize: this.config.fontSize,
        });
        
        await this.textDisplay.loadFont(this.config.fontSize);
        console.log("Text display ready");
        
        // Initialize ML gesture detector
        console.log("Initializing ML gesture detector...");
        this.mlDetector = new MLGestureDetector(30); // 30 samples = 1.5s at 20Hz
        
        while (!this.mlDetector.initialized) {
            await new Promise(r => setTimeout(r, 50));
        }
        console.log("ML gesture detector ready");
        
        // Initialize sensors
        console.log("Initializing sensors...");
        this.sensorManager = new SensorManager(this.device, {
            enabledSensors: ["acceleration", "orientation"],
            zenohEnabled: false, // Disable Zenoh in sensor manager for this use case
        });
        this.sensorManager.setSensorRate("acceleration", this.config.sensorRate);
        this.sensorManager.setSensorRate("orientation", this.config.sensorRate);
        
        // Feed sensor data to ML detector (must be before startSensors)
        this._setupSensorHandlers();
        
        await this.sensorManager.startSensors();
        console.log("Sensors ready");
        
        // Initialize Zenoh publisher for gesture responses
        console.log("Initializing Zenoh publisher...");
        this.zenohPublisher = new ZenohManager({
            keyPrefix: "gesture",
            udsPath: `/tmp/bsole-zenoh-glasses-pub-${process.pid}.sock`,
        });
        
        await this.zenohPublisher.start();
        this.zenohPublisher.setDeviceInfo({
            id: this.device.bluetoothId || this.device.id,
            name: this.device.name,
        });
        console.log("Zenoh publisher ready");
        
        // Initialize Zenoh subscriber for car messages
        console.log("Initializing Zenoh subscriber...");
        this.zenohSubscriber = new ZenohSubscriber({
            keyExpression: "car/**",
            udsPath: `/tmp/bsole-zenoh-glasses-sub-${process.pid}.sock`,
        });
        
        this.zenohSubscriber.on("message", (msg) => this._handleZenohMessage(msg));
        this.zenohSubscriber.on("error", (err) => {
            console.error("Zenoh subscriber error:", err.message);
        });
        
        await this.zenohSubscriber.start();
        console.log("Zenoh subscriber ready\n");
        
        // Setup ML gesture handler
        this.mlDetector.on("ml-gesture", (result) => this._handleGesture(result));
        
        // Show ready message
        await this.textDisplay.showText("Ready\nWaiting for car...", {
            align: "center",
            valign: "middle",
        });
        
        console.log("System ready! Waiting for car approach...\n");
    }

    _waitForDemoGesture() {
        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                setTimeout(() => resolve("timeout"), this.config.gestureTimeoutMs);
                return;
            }
            
            const timeout = setTimeout(() => {
                cleanup();
                resolve("timeout");
            }, this.config.gestureTimeoutMs);
            
            const cleanup = () => {
                clearTimeout(timeout);
                process.stdin.removeListener("data", onData);
                if (process.stdin.isTTY) process.stdin.setRawMode(false);
            };
            
            const onData = (key) => {
                const k = key.toString().toLowerCase();
                if (k === "y") {
                    cleanup();
                    resolve("nod");
                } else if (k === "n") {
                    cleanup();
                    resolve("shake");
                }
            };
            
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", onData);
        });
    }

    _setupSensorHandlers() {
        let latestAcc = null;
        
        this.sensorManager.on("acceleration", (event) => {
            if (event?.message?.acceleration) {
                latestAcc = event.message.acceleration;
            }
        });
        
        this.sensorManager.on("orientation", (event) => {
            if (event?.message?.orientation && latestAcc) {
                const orient = event.message.orientation;
                this._feedToMLDetector(latestAcc, orient);
            }
        });
    }

    _feedToMLDetector(acceleration, orientation) {
        // Only feed data when waiting for gesture
        if (this.state !== STATE.WAITING_FOR_GESTURE) {
            return;
        }
        
        const sensorData = {
            accX: acceleration.x,
            accY: acceleration.y,
            accZ: acceleration.z,
            heading: orientation.heading,
            pitch: orientation.pitch,
            roll: orientation.roll,
        };
        
        this.mlDetector.addSample(sensorData);
    }

    _handleZenohMessage(msg) {
        const { key, payload } = msg;
        let parsedPayload = payload;

        // Data Validation: Handle malformed JSON
        if (typeof payload === 'string') {
            try {
                parsedPayload = JSON.parse(payload);
            } catch (e) {
                console.error(`Error parsing Zenoh message payload for key ${key}:`, e.message);
                return; // Abort if payload is malformed
            }
        }

        console.log(`Received message: ${key}`);

        if (key === "car/approaching") {
            this.approachReceiveTime = Date.now(); // Track latency
            this._handleCarApproaching(parsedPayload);
        } else if (key === "car/confirmation") {
            const confirmationReceiveTime = Date.now(); // Track latency
            if (parsedPayload.gestureSentTime) {
                const latency = confirmationReceiveTime - parsedPayload.gestureSentTime;
                console.log(`Latency (gesture response to confirmation): ${latency.toFixed(2)}ms`);
            }
            this._handleCarConfirmation(parsedPayload);
        }
    }

    async _handleCarApproaching(payload) {
        if (this.state !== STATE.IDLE) {
            console.log("Ignoring car approach (busy)");
            return;
        }
        
        const message = payload.message || "Car approaching\nAllow to stop?";
        console.log(`Car approaching: "${message}"`);
        
        // Change state to wait for gesture
        this.state = STATE.WAITING_FOR_GESTURE;
        this.currentQuestion = message;
        
        if (this.demoMode) {
            console.log("Press [y] for YES (nod) or [n] for NO (shake) within 5 seconds...\n");
            const gesture = await this._waitForDemoGesture();
            this._handleDemoGestureResult(gesture);
            return;
        }
        
        // Display message on device
        try {
            await this.textDisplay.showText(message, {
                align: "center",
                valign: "middle",
                color: "#FFFF00", // Yellow for attention
            });
        } catch (err) {
            console.error("Display error:", err.message);
        }
        
        // Reset ML detector buffer
        this.mlDetector.reset();
        
        // Set timeout for gesture response
        this.gestureTimeout = setTimeout(() => {
            this._handleGestureTimeout();
        }, this.config.gestureTimeoutMs);
        
        console.log("Waiting for gesture (nod=yes, shake=no)...");
    }

    async _handleDemoGestureResult(gesture) {
        if (gesture === "timeout") {
            console.log("No response (timeout)...");
        } else {
            console.log(`Response: ${gesture === "nod" ? "YES" : "NO"}`);
        }
        
        await this._sendGestureResponse(gesture);
        
        // Brief feedback
        const feedback = gesture === "nod" ? "Response: YES" : gesture === "shake" ? "Response: NO" : "No response - Car will proceed";
        console.log(`Sent gesture response: ${gesture}`);
        console.log(`   ${feedback}\n`);
        
        this.state = STATE.IDLE;
    }

    async _handleGesture(result) {
        if (this.state !== STATE.WAITING_FOR_GESTURE) {
            return;
        }
        
        if (process.env.DEBUG === "1" && result?.results) {
            const top = result.results.reduce((a, b) => (a.value > b.value ? a : b));
            console.log(`   [DEBUG] ML: ${top?.label} ${(top?.value * 100)?.toFixed(1)}%`);
        }
        
        // Find highest confidence gesture (exclude idle)
        const sorted = (result?.results || [])
            .filter(r => r.label && r.label.toLowerCase() !== "idle")
            .sort((a, b) => b.value - a.value);
        
        if (sorted.length === 0) {
            return;
        }
        
        const topGesture = sorted[0];
        
        // Check confidence threshold based on gesture type
        let confidenceThreshold = this.config.gestureConfidenceThreshold;
        if (topGesture.label.toLowerCase() === 'nod' || topGesture.label.toLowerCase() === 'yes') {
            confidenceThreshold = this.config.nodConfidenceThreshold;
        } else if (topGesture.label.toLowerCase() === 'shake' || topGesture.label.toLowerCase() === 'no') {
            confidenceThreshold = this.config.shakeConfidenceThreshold;
        }

        if (topGesture.value < confidenceThreshold) {
            return;
        }
        
        // Normalize label: nod/yes -> nod, shake/no -> shake
        const label = topGesture.label.toLowerCase();
        const gesture = label === "yes" || label === "nod" ? "nod" : label === "no" || label === "shake" ? "shake" : label;
        
        console.log(`Gesture detected: ${gesture} (${(topGesture.value * 100).toFixed(1)}%)`);

        // Latency Tracking: Car approach message received -> Gesture response sent
        if (this.approachReceiveTime) {
            const gestureResponseTime = Date.now();
            const latency = gestureResponseTime - this.approachReceiveTime;
            console.log(`Latency (approach to gesture): ${latency.toFixed(2)}ms`);
            this.approachReceiveTime = null; // Reset for next interaction
        }
        
        // Clear timeout
        if (this.gestureTimeout) {
            clearTimeout(this.gestureTimeout);
            this.gestureTimeout = null;
        }
        
        // Send response to car
        await this._sendGestureResponse(gesture);
        
        // Show feedback
        const feedbackMessage = gesture === "nod"
            ? "Response: YES"
            : gesture === "shake"
            ? "Response: NO"
            : "Response: " + gesture;
        
        await this.textDisplay.showText(feedbackMessage, {
            align: "center",
            valign: "middle",
            color: "#00FF00", // Green for confirmation
        });
        
        // Wait a bit before going back to idle
        await new Promise(r => setTimeout(r, 1000));
        
        this.state = STATE.IDLE;
    }

    async _sendGestureResponse(gesture) {
        this.gestureResponseSendTime = Date.now(); // Track when gesture response is sent
        const response = {
            ts: this.gestureResponseSendTime,
            gesture: gesture,
            device: {
                id: this.device.bluetoothId || this.device.id,
                name: this.device.name,
            },
            // Add timestamp for latency tracking in car simulator
            gestureSentTime: this.gestureResponseSendTime,
        };
        
        await this.zenohPublisher.publish("gesture/response", response);
        console.log(`Sent gesture response: ${gesture}`);
    }

    async _handleGestureTimeout() {
        if (this.state !== STATE.WAITING_FOR_GESTURE) {
            return;
        }
        
        console.log("Gesture timeout - no response");
        
        // Send timeout response
        await this._sendGestureResponse("timeout");
        
        // Show timeout message
        await this.textDisplay.showText("No response\nCar will proceed", {
            align: "center",
            valign: "middle",
            color: "#FF8800", // Orange for warning
        });
        
        await new Promise(r => setTimeout(r, 2000));
        
        // Return to idle
        this.state = STATE.IDLE;
        await this.textDisplay.showText("Ready\nWaiting for car...", {
            align: "center",
            valign: "middle",
        });
    }

    async _handleCarConfirmation(payload) {
        if (this.state === STATE.WAITING_FOR_GESTURE) {
            // Cancel gesture wait if we got confirmation already
            if (this.gestureTimeout) {
                clearTimeout(this.gestureTimeout);
                this.gestureTimeout = null;
            }
        }
        
        const message = payload.message || "Car confirmed";
        console.log(`Car confirmation: "${message}"`);
        
        this.state = STATE.SHOWING_CONFIRMATION;
        
        if (!this.demoMode && this.textDisplay) {
            await this.textDisplay.showText(message, {
                align: "center",
                valign: "middle",
                color: "#00FF00", // Green
            });
            await new Promise(r => setTimeout(r, 3000));
            await this.textDisplay.showText("Ready\nWaiting for car...", {
                align: "center",
                valign: "middle",
            });
        }
        
        this.state = STATE.IDLE;
        console.log("Ready for next interaction\n");
    }

    async cleanup() {
        console.log("\nShutting down...");
        
        try {
            if (this.gestureTimeout) {
                clearTimeout(this.gestureTimeout);
            }
            
            if (this.textDisplay && !this.demoMode) {
                await this.textDisplay.clear();
            }
            
            if (this.zenohSubscriber) {
                await this.zenohSubscriber.stop();
            }
            
            if (this.zenohPublisher) {
                await this.zenohPublisher.stop();
            }
            
            console.log("Cleanup complete");
        } catch (e) {
            console.error("Cleanup error:", e.message);
        }
    }
}

// Main function
async function main() {
    const controller = new GlassesController();
    
    // Setup cleanup handlers
    process.on("SIGINT", async () => {
        await controller.cleanup();
        process.exit(0);
    });
    
    process.on("SIGTERM", async () => {
        await controller.cleanup();
        process.exit(0);
    });
    
    // Initialize and run
    await controller.initialize();
    
    // Keep running
    await new Promise(() => {}); // Run forever
}

if (require.main === module) {
    main().catch((error) => {
        console.error("\nError:", error.message);
        console.error(error.stack);
        process.exit(1);
    });
}

module.exports = { GlassesController };
