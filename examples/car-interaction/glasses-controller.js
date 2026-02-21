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

const CONSTANTS = {
    // Socket paths (templates - combine with process.pid)
    UDS_PUB_PATH_PREFIX: "/tmp/bsole-zenoh-glasses-pub-",
    UDS_SUB_PATH_PREFIX: "/tmp/bsole-zenoh-glasses-sub-",
    UDS_PATH_SUFFIX: ".sock",

    // Zenoh topics
    ZENOH_PUB_KEY_PREFIX: "gesture",
    ZENOH_SUB_KEY_EXPRESSION: "car/**",
    ZENOH_GESTURE_RESPONSE_TOPIC: "gesture/response",
    ZENOH_CAR_APPROACHING_KEY: "car/approaching",
    ZENOH_CAR_CONFIRMATION_KEY: "car/confirmation",

    // Display colors
    COLOR_ATTENTION: "#FFFF00",
    COLOR_CONFIRM: "#00FF00",
    COLOR_WARNING: "#FF8800",

    // Delays (ms)
    ML_INIT_POLL_INTERVAL_MS: 50,
    FEEDBACK_DISPLAY_MS: 1000,
    TIMEOUT_DISPLAY_MS: 2000,
    CONFIRMATION_DISPLAY_MS: 3000,

    // ML detector
    ML_WINDOW_SIZE: 30, // 30 samples = 1.5s at 20Hz

    // Sensor config defaults
    DEFAULT_SENSOR_RATE: 20,
    DEFAULT_FONT_SIZE: 24,
    DEFAULT_GESTURE_CONFIDENCE: 0.5,
    DEFAULT_NOD_CONFIDENCE: 0.8,
    DEFAULT_SHAKE_CONFIDENCE: 0.8,
    DEFAULT_GESTURE_TIMEOUT_MS: 8000,

    // Display messages
    MSG_READY: "Ready\nWaiting for car...",
    MSG_TIMEOUT: "No response\nCar will proceed",
    MSG_DEFAULT_APPROACH: "Car approaching\nAllow to stop?",
    MSG_DEFAULT_CONFIRMATION: "Car confirmed",
};

// State machine states
const STATE = {
    IDLE: "idle",
    WAITING_FOR_GESTURE: "waiting_for_gesture",
    SHOWING_CONFIRMATION: "showing_confirmation",
};

/**
 * Build a UDS socket path from prefix, pid, and suffix.
 */
function _buildUdsPath(prefix, pid) {
    return `${prefix}${pid}${CONSTANTS.UDS_PATH_SUFFIX}`;
}

/**
 * Block the event loop indefinitely. The process stays alive until
 * SIGINT or SIGTERM triggers the cleanup handler registered in main().
 */
function _keepAlive() {
    return new Promise(() => {});
}

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
        this.clearDisplayTimeout = null;
        
        this.demoMode = process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
        
        // Configuration
        this.config = {
            sensorRate: CONSTANTS.DEFAULT_SENSOR_RATE,
            gestureConfidenceThreshold: CONSTANTS.DEFAULT_GESTURE_CONFIDENCE,
            nodConfidenceThreshold: CONSTANTS.DEFAULT_NOD_CONFIDENCE,
            shakeConfidenceThreshold: CONSTANTS.DEFAULT_SHAKE_CONFIDENCE,
            gestureTimeoutMs: CONSTANTS.DEFAULT_GESTURE_TIMEOUT_MS,
            fontSize: CONSTANTS.DEFAULT_FONT_SIZE,
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
            keyPrefix: CONSTANTS.ZENOH_PUB_KEY_PREFIX,
            udsPath: _buildUdsPath(CONSTANTS.UDS_PUB_PATH_PREFIX, process.pid),
        });
        
        await this.zenohPublisher.start();
        this.zenohPublisher.setDeviceInfo({ id: "DEMO", name: "Demo Glasses" });
        console.log("Zenoh publisher ready");
        
        console.log("Initializing Zenoh subscriber...");
        this.zenohSubscriber = new ZenohSubscriber({
            keyExpression: CONSTANTS.ZENOH_SUB_KEY_EXPRESSION,
            udsPath: _buildUdsPath(CONSTANTS.UDS_SUB_PATH_PREFIX, process.pid),
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
        this.mlDetector = new MLGestureDetector(CONSTANTS.ML_WINDOW_SIZE);
        
        while (!this.mlDetector.initialized) {
            await new Promise(r => setTimeout(r, CONSTANTS.ML_INIT_POLL_INTERVAL_MS));
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
            keyPrefix: CONSTANTS.ZENOH_PUB_KEY_PREFIX,
            udsPath: _buildUdsPath(CONSTANTS.UDS_PUB_PATH_PREFIX, process.pid),
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
            keyExpression: CONSTANTS.ZENOH_SUB_KEY_EXPRESSION,
            udsPath: _buildUdsPath(CONSTANTS.UDS_SUB_PATH_PREFIX, process.pid),
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
        await this.textDisplay.showText(CONSTANTS.MSG_READY, {
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

        if (key === CONSTANTS.ZENOH_CAR_APPROACHING_KEY) {
            this.approachReceiveTime = Date.now(); // Track latency
            this._handleCarApproaching(parsedPayload);
        } else if (key === CONSTANTS.ZENOH_CAR_CONFIRMATION_KEY) {
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
        
        const message = payload.message || CONSTANTS.MSG_DEFAULT_APPROACH;
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
                color: CONSTANTS.COLOR_ATTENTION,
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
        
         // Display immediate feedback before sending
         const feedbackMessage = gesture === "nod"
             ? "Sent: YES"
             : gesture === "shake"
             ? "Sent: NO"
             : "Sent: " + gesture;
         
          if (!this.demoMode && this.textDisplay) {
              try {
                  await this.textDisplay.showText(feedbackMessage, {
                      align: "center",
                      valign: "middle",
                      color: CONSTANTS.COLOR_CONFIRM,
                      clearBefore: true,
                  });
              } catch (err) {
                  console.error("Display error:", err.message);
              }
          }
         
         // Send response to car
         await this._sendGestureResponse(gesture);
         
         // Wait a bit before going back to idle
         await new Promise(r => setTimeout(r, CONSTANTS.FEEDBACK_DISPLAY_MS));
         
         this.state = STATE.IDLE;
    }

    async _sendGestureResponse(gesture) {
        this.gestureResponseSendTime = Date.now();
        const response = {
            ts: this.gestureResponseSendTime,
            gesture: gesture,
            device: {
                id: this.device.bluetoothId || this.device.id,
                name: this.device.name,
            },
            gestureSentTime: this.gestureResponseSendTime,
        };
        
        await this.zenohPublisher.publish(CONSTANTS.ZENOH_GESTURE_RESPONSE_TOPIC, response);
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
        await this.textDisplay.showText(CONSTANTS.MSG_TIMEOUT, {
            align: "center",
            valign: "middle",
            color: CONSTANTS.COLOR_WARNING,
        });
        
        await new Promise(r => setTimeout(r, CONSTANTS.TIMEOUT_DISPLAY_MS));
        
        // Return to idle
        this.state = STATE.IDLE;
        await this.textDisplay.showText(CONSTANTS.MSG_READY, {
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
        
        const message = payload.message || CONSTANTS.MSG_DEFAULT_CONFIRMATION;
        console.log(`Car confirmation: "${message}"`);
        
        this.state = STATE.SHOWING_CONFIRMATION;
        
        if (!this.demoMode && this.textDisplay) {
            await this.textDisplay.showText(message, {
                align: "center",
                valign: "middle",
                color: CONSTANTS.COLOR_CONFIRM,
            });
            await new Promise(r => setTimeout(r, CONSTANTS.CONFIRMATION_DISPLAY_MS));
            
            // Schedule display cleanup (clear after 5 seconds if no new message arrives)
            if (this.clearDisplayTimeout) {
                clearTimeout(this.clearDisplayTimeout);
            }
            
            this.clearDisplayTimeout = setTimeout(async () => {
                // Only clear if still in idle state (no new message arrived)
                if (this.state === STATE.IDLE) {
                    try {
                        await this.textDisplay.clear();
                        console.log("Display cleared after confirmation");
                    } catch (err) {
                        console.error("Display clear error:", err.message);
                    }
                }
                this.clearDisplayTimeout = null;
            }, 5000);
            
            // Show ready message instead of leaving confirmation up
            await this.textDisplay.showText(CONSTANTS.MSG_READY, {
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
            
            if (this.clearDisplayTimeout) {
                clearTimeout(this.clearDisplayTimeout);
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
    await _keepAlive();
}

if (require.main === module) {
    main().catch((error) => {
        console.error("\nError:", error.message);
        console.error(error.stack);
        process.exit(1);
    });
}

module.exports = { GlassesController, CONSTANTS, STATE };
