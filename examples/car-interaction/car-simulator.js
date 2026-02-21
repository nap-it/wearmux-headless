#!/usr/bin/env node

/**
 * Car Simulator - Autonomous Car Interaction Demo
 * 
 * This script simulates an autonomous car that:
 * 1. Approaches the user at random intervals
 * 2. Sends a message to the glasses asking permission to stop
 * 3. Waits for gesture response (nod/shake)
 * 4. Sends confirmation based on response
 * 5. Repeats the cycle
 * 
 * Manual Control Mode (MANUAL_CONTROL=true):
 * - Car waits for user input (Enter key) before triggering an approach
 * - Useful for testing and debugging
 * 
 * Automatic Mode (MANUAL_CONTROL=false):
 * - Car approaches at random intervals (default behavior)
 */

const readline = require("readline");
const { ZenohManager } = require("../../utils/zenoh-manager");
const { ZenohSubscriber } = require("../../utils/zenoh-subscriber");

const CONSTANTS = {
    // Socket paths
    SOCKET_PATH_PUB: `/tmp/bsole-zenoh-car-pub-${process.pid}.sock`,
    SOCKET_PATH_SUB: `/tmp/bsole-zenoh-car-sub-${process.pid}.sock`,

    // Zenoh topics
    TOPIC_APPROACHING: "car/approaching",
    TOPIC_CONFIRMATION: "car/confirmation",
    KEY_GESTURE_RESPONSE: "gesture/response",

    // Gesture types
    GESTURE_NOD: "nod",
    GESTURE_SHAKE: "shake",
    GESTURE_TIMEOUT: "timeout",

    // Timing (ms)
    MIN_APPROACH_DELAY: 5000,
    MAX_APPROACH_DELAY: 15000,
    RESPONSE_TIMEOUT: 8000,
    ERROR_RETRY_DELAY: 5000,

    // Action durations (ms)
    STOP_DURATION: 2000,
    PASS_DURATION: 1500,
    RESUME_DELAY: 1000,
};

class CarSimulator {
    constructor() {
        this.zenohPublisher = null;
        this.zenohSubscriber = null;
        this.isWaitingForResponse = false;
        this.responseTimeout = null;
        this.approachCount = 0;

        // Latency tracking
        this.approachSentTime = null;
        this.gestureResponseReceiveTime = null;
        
        // Manual control mode
        this.manualControl = process.env.MANUAL_CONTROL !== "false";
        this.rl = null;
        
        // Configuration
        this.config = {
            minApproachDelay: CONSTANTS.MIN_APPROACH_DELAY,
            maxApproachDelay: CONSTANTS.MAX_APPROACH_DELAY,
            responseTimeoutMs: CONSTANTS.RESPONSE_TIMEOUT,
        };
    }

    async initialize() {
        console.log("Car simulator\n");
        
        // Show manual control status
        if (this.manualControl) {
            console.log("[Mode] MANUAL CONTROL - Press Enter to trigger approach");
        } else {
            console.log("[Mode] AUTOMATIC - Car will approach at random intervals");
        }
        console.log("");
        
        // Initialize Zenoh publisher for car messages
        console.log("Initializing Zenoh publisher...");
        this.zenohPublisher = new ZenohManager({
            keyPrefix: "car",
            udsPath: CONSTANTS.SOCKET_PATH_PUB,
        });
        
        await this.zenohPublisher.start();
        console.log("Zenoh publisher ready");
        
        // Initialize Zenoh subscriber for gesture responses
        console.log("Initializing Zenoh subscriber...");
        this.zenohSubscriber = new ZenohSubscriber({
            keyExpression: CONSTANTS.KEY_GESTURE_RESPONSE,
            udsPath: CONSTANTS.SOCKET_PATH_SUB,
        });
        
        this.zenohSubscriber.on("message", (msg) => this._handleGestureResponse(msg));
        this.zenohSubscriber.on("error", (err) => {
            console.error("Zenoh subscriber error:", err.message);
        });
        
        await this.zenohSubscriber.start();
        console.log("Zenoh subscriber ready");
        
        // Initialize readline for manual control
        if (this.manualControl) {
            this.rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
        }
        
        console.log("Car simulator initialized!");
        if (!this.manualControl) {
            console.log("Will approach at random intervals (5-15 seconds)\n");
        } else {
            console.log("\nPress Enter to simulate car approach...\n");
        }
    }

    async start() {
        // Start the simulation loop
        await this._simulationLoop();
    }

    async _simulationLoop() {
        while (true) {
            try {
                if (this.manualControl) {
                    // Manual control: wait for user input
                    await this._waitForUserInput();
                } else {
                    // Automatic mode: wait random time before next approach
                    const delay = this._randomDelay(
                        this.config.minApproachDelay,
                        this.config.maxApproachDelay
                    );
                    
                    console.log(`Next approach in ${(delay / 1000).toFixed(1)}s...`);
                    await new Promise(r => setTimeout(r, delay));
                }
                
                // Simulate car approach
                await this._simulateApproach();
            } catch (error) {
                console.error(`[CarSimulator] Simulation loop error: ${error.message}`);
                await new Promise(r => setTimeout(r, CONSTANTS.ERROR_RETRY_DELAY));
            }
        }
    }

    async _waitForUserInput() {
        return new Promise((resolve) => {
            if (!this.rl) {
                resolve();
                return;
            }
            
            this.rl.question("Press Enter to trigger car approach: ", () => {
                resolve();
            });
        });
    }

    async _simulateApproach() {
        this.approachCount++;
        console.log(`\nApproach #${this.approachCount}: Car is approaching...`);
        
        // Send approach message to glasses
        this.approachSentTime = Date.now(); // Track latency
        const approachMessage = {
            ts: this.approachSentTime,
            message: "Car approaching\nAllow to stop?",
            type: "question",
            approachId: this.approachCount,
        };
        
        await this.zenohPublisher.publish(CONSTANTS.TOPIC_APPROACHING, approachMessage);
        console.log("Sent approach message to glasses");
        
        // Wait for gesture response
        this.isWaitingForResponse = true;
        
        // Set response timeout
        const responseReceived = await new Promise((resolve) => {
            this.responseTimeout = setTimeout(() => {
                resolve(false); // Timeout
            }, this.config.responseTimeoutMs);
            
            this._responseResolve = resolve;
        });
        
        this.isWaitingForResponse = false;
        
        if (!responseReceived) {
            console.log("No response (timeout)");
            await this._sendConfirmation(CONSTANTS.GESTURE_TIMEOUT);
        }
    }

    _handleGestureResponse(msg) {
        if (!this.isWaitingForResponse) {
            return;
        }
        
        const { payload } = msg;
        
        if (!payload || !payload.gesture) {
            return;
        }
        
        const gesture = payload.gesture;
        console.log(`Received gesture response: ${gesture}`);
        
        if (this.responseTimeout) {
            clearTimeout(this.responseTimeout);
            this.responseTimeout = null;
        }
        
        // Process response
        this._sendConfirmation(gesture);
        
        // Resolve the waiting promise
        if (this._responseResolve) {
            this._responseResolve(true);
            this._responseResolve = null;
        }
    }

    async _sendConfirmation(gesture) {
        let message;
        let action;
        
        switch (gesture) {
            case CONSTANTS.GESTURE_NOD:
                message = "Car will stop\nThank you!";
                action = "STOPPING";
                break;
            
            case CONSTANTS.GESTURE_SHAKE:
                message = "Car will proceed\nStay safe!";
                action = "PROCEEDING";
                break;
            
            case CONSTANTS.GESTURE_TIMEOUT:
            default:
                message = "No response\nCar will proceed";
                action = "PROCEEDING (no response)";
                break;
        }
        
        console.log(`Decision: ${action}`);
        
        const confirmation = {
            ts: Date.now(),
            message: message,
            type: "confirmation",
            gesture: gesture,
            action: action,
        };
        
        await this.zenohPublisher.publish(CONSTANTS.TOPIC_CONFIRMATION, confirmation);
        console.log("Sent confirmation to glasses");
        
        await this._simulateAction(gesture);
    }

    async _simulateAction(gesture) {
        if (gesture === CONSTANTS.GESTURE_NOD) {
            console.log("Car is stopping...");
            await new Promise(r => setTimeout(r, CONSTANTS.STOP_DURATION));
            console.log("Car stopped safely");
            await new Promise(r => setTimeout(r, CONSTANTS.RESUME_DELAY));
            console.log("Car resuming...");
        } else {
            console.log("Car proceeding without stopping...");
            await new Promise(r => setTimeout(r, CONSTANTS.PASS_DURATION));
            console.log("Car passed safely");
        }
        
        console.log("Interaction complete");
    }

    _randomDelay(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    async cleanup() {
        console.log("\nShutting down car simulator...");
        
        try {
            if (this.responseTimeout) {
                clearTimeout(this.responseTimeout);
            }
            
            if (this.rl) {
                this.rl.close();
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
    const simulator = new CarSimulator();
    
    // Setup cleanup handlers
    process.on("SIGINT", async () => {
        await simulator.cleanup();
        process.exit(0);
    });
    
    process.on("SIGTERM", async () => {
        await simulator.cleanup();
        process.exit(0);
    });
    
    // Initialize and run
    await simulator.initialize();
    await simulator.start();
}

if (require.main === module) {
    main().catch((error) => {
        console.error("\nError:", error.message);
        console.error(error.stack);
        process.exit(1);
    });
}

module.exports = { CarSimulator };
