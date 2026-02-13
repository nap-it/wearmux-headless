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
 */

const { ZenohManager } = require("../../utils/zenoh-manager");
const { ZenohSubscriber } = require("../../utils/zenoh-subscriber");

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
        
        // Configuration
        this.config = {
            minApproachDelay: 5000, // 5 seconds
            maxApproachDelay: 15000, // 15 seconds
            responseTimeoutMs: 8000, // 8 seconds to respond (match glasses controller)
        };
    }

    async initialize() {
        console.log("Car simulator\n");
        // Initialize Zenoh publisher for car messages
        console.log("Initializing Zenoh publisher...");
        this.zenohPublisher = new ZenohManager({
            keyPrefix: "car",
            udsPath: `/tmp/bsole-zenoh-car-pub-${process.pid}.sock`,
        });
        
        await this.zenohPublisher.start();
        console.log("Zenoh publisher ready");
        
        // Initialize Zenoh subscriber for gesture responses
        console.log("Initializing Zenoh subscriber...");
        this.zenohSubscriber = new ZenohSubscriber({
            keyExpression: "gesture/response",
            udsPath: `/tmp/bsole-zenoh-car-sub-${process.pid}.sock`,
        });
        
        this.zenohSubscriber.on("message", (msg) => this._handleGestureResponse(msg));
        this.zenohSubscriber.on("error", (err) => {
            console.error("Zenoh subscriber error:", err.message);
        });
        
        await this.zenohSubscriber.start();
        console.log("Zenoh subscriber ready");
        
        console.log("Car simulator initialized!");
        console.log("Will approach at random intervals (5-15 seconds)\n");
    }

    async start() {
        // Start the simulation loop
        await this._simulationLoop();
    }

    async _simulationLoop() {
        while (true) {
            // Wait random time before next approach
            const delay = this._randomDelay(
                this.config.minApproachDelay,
                this.config.maxApproachDelay
            );
            
            console.log(`Next approach in ${(delay / 1000).toFixed(1)}s...`);
            await new Promise(r => setTimeout(r, delay));
            
            // Simulate car approach
            await this._simulateApproach();
        }
    }

    async _simulateApproach() {
        this.approachCount++;
        console.log(`\n${"=".repeat(60)}`);
        console.log(`Approach #${this.approachCount}: Car is approaching...`);
        console.log("=".repeat(60));
        
        // Send approach message to glasses
        this.approachSentTime = Date.now(); // Track latency
        const approachMessage = {
            ts: this.approachSentTime,
            message: "Car approaching\nAllow to stop?",
            type: "question",
            approachId: this.approachCount,
        };
        
        await this.zenohPublisher.publish("car/approaching", approachMessage);
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
            await this._sendConfirmation("timeout");
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
            case "nod":
                message = "Car will stop\nThank you!";
                action = "STOPPING";
                break;
            
            case "shake":
                message = "Car will proceed\nStay safe!";
                action = "PROCEEDING";
                break;
            
            case "timeout":
            default:
                message = "No response\nCar will proceed";
                action = "➡️  PROCEEDING (no response)";
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
        
        await this.zenohPublisher.publish("car/confirmation", confirmation);
        console.log("Sent confirmation to glasses");
        
        await this._simulateAction(gesture);
    }

    async _simulateAction(gesture) {
        if (gesture === "nod") {
            console.log("Car is stopping...");
            await new Promise(r => setTimeout(r, 2000));
            console.log("Car stopped safely");
            await new Promise(r => setTimeout(r, 1000));
            console.log("Car resuming...");
        } else {
            console.log("Car proceeding without stopping...");
            await new Promise(r => setTimeout(r, 1500));
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
