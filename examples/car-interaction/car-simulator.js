#!/usr/bin/env node

/**
 * Car Simulator - Autonomous Car Interaction Demo
 * 
 * Simulated autonomous vehicle using NetworkClient and centralized constants.
 */

const readline = require("readline");
const { NetworkClient } = require("./network-client");
const { ZENOH_TOPICS, GESTURE_TYPES, CAR_CONFIG } = require("./constants");

class CarSimulator {
    constructor() {
        this.network = null;
        this.isWaitingForResponse = false;
        this.responseTimeout = null;
        this.approachCount = 0;

        // Latency tracking
        this.approachSentTime = null;
        this.gestureResponseReceiveTime = null;

        // Manual control mode
        this.manualControl = process.env.MANUAL_CONTROL !== "false";
        this.rl = null;
        this.config = CAR_CONFIG;
    }

    async initialize() {
        console.log("Car simulator\n");

        if (this.manualControl) {
            console.log("[Mode] MANUAL CONTROL - Press Enter to trigger approach");
        } else {
            console.log("[Mode] AUTOMATIC - Car will approach at random intervals");
        }
        console.log("");

        console.log("Initializing Network Client...");
        this.network = new NetworkClient({
            pubPrefix: ZENOH_TOPICS.CAR_PUB_PREFIX,
            subExpression: ZENOH_TOPICS.GESTURE_RESPONSE,
            pubUdsPath: this.config.UDS_PUB_PATH,
            subUdsPath: this.config.UDS_SUB_PATH,
        });

        this.network.onMessage((topic, payload) => {
            if (topic === ZENOH_TOPICS.GESTURE_RESPONSE) {
                this._handleGestureResponse(payload);
            }
        });

        await this.network.start();
        console.log("Network client ready");

        if (this.manualControl) {
            this.rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
        }

        console.log("Car simulator initialized!");
        if (!this.manualControl) {
            console.log(`Will approach at random intervals (${this.config.MIN_APPROACH_DELAY / 1000}-${this.config.MAX_APPROACH_DELAY / 1000} seconds)\n`);
        } else {
            console.log("\nPress Enter to simulate car approach...\n");
        }
    }

    async start() {
        await this._simulationLoop();
    }

    async _simulationLoop() {
        while (true) {
            try {
                if (this.manualControl) {
                    await this._waitForUserInput();
                } else {
                    const delay = this._randomDelay(
                        this.config.MIN_APPROACH_DELAY,
                        this.config.MAX_APPROACH_DELAY
                    );

                    console.log(`Next approach in ${(delay / 1000).toFixed(1)}s...`);
                    await new Promise(r => setTimeout(r, delay));
                }

                await this._simulateApproach();
            } catch (error) {
                console.error(`[CarSimulator] Simulation loop error: ${error.message}`);
                await new Promise(r => setTimeout(r, this.config.ERROR_RETRY_DELAY));
            }
        }
    }

    async _waitForUserInput() {
        return new Promise((resolve) => {
            if (!this.rl) { resolve(); return; }
            this.rl.question("Press Enter to trigger car approach: ", () => resolve());
        });
    }

    async _simulateApproach() {
        this.approachCount++;
        console.log(`\nApproach #${this.approachCount}: Car is approaching...`);

        this.approachSentTime = Date.now();
        const approachMessage = {
            ts: this.approachSentTime,
            message: "Car approaching\nAllow to stop?",
            type: "question",
            approachId: this.approachCount,
        };

        await this.network.publish(ZENOH_TOPICS.CAR_APPROACHING, approachMessage);
        console.log("Sent approach message to glasses");

        this.isWaitingForResponse = true;

        const responseReceived = await new Promise((resolve) => {
            this.responseTimeout = setTimeout(() => resolve(false), this.config.RESPONSE_TIMEOUT);
            this._responseResolve = resolve;
        });

        this.isWaitingForResponse = false;

        if (!responseReceived) {
            console.log("No response (timeout)");
            await this._sendConfirmation(GESTURE_TYPES.TIMEOUT);
        } else if (this._pendingConfirmation) {
            // Ensure the confirmation flow finishes before starting the next approach
            try { await this._pendingConfirmation; } catch (e) {
                console.error("[CarSimulator] confirmation failed:", e.message);
            }
            this._pendingConfirmation = null;
        }
    }

    _handleGestureResponse(payload) {
        if (!this.isWaitingForResponse || !payload || !payload.gesture) return;

        // Synchronously lock out duplicate responses arriving in the same tick
        // before any await point is reached.
        this.isWaitingForResponse = false;

        const gesture = payload.gesture;
        console.log(`Received gesture response: ${gesture}`);

        if (this.responseTimeout) {
            clearTimeout(this.responseTimeout);
            this.responseTimeout = null;
        }

        this._pendingConfirmation = this._sendConfirmation(gesture);

        if (this._responseResolve) {
            this._responseResolve(true);
            this._responseResolve = null;
        }
    }

    async _sendConfirmation(gesture) {
        let message, action;
        switch (gesture) {
            case GESTURE_TYPES.NOD:
                message = "Car will stop\nThank you!"; action = "STOPPING"; break;
            case GESTURE_TYPES.SHAKE:
                message = "Car will proceed\nStay safe!"; action = "PROCEEDING"; break;
            case GESTURE_TYPES.TIMEOUT:
            default:
                message = "No response\nCar will proceed"; action = "PROCEEDING (no response)"; break;
        }

        console.log(`Decision: ${action}`);

        const confirmation = {
            ts: Date.now(),
            message: message,
            type: "confirmation",
            gesture: gesture,
            action: action,
        };

        await this.network.publish(ZENOH_TOPICS.CAR_CONFIRMATION, confirmation);
        console.log("Sent confirmation to glasses");

        await this._simulateAction(gesture);
    }

    async _simulateAction(gesture) {
        if (gesture === GESTURE_TYPES.NOD) {
            console.log("Car is stopping...");
            await new Promise(r => setTimeout(r, this.config.STOP_DURATION));
            console.log("Car stopped safely");
            await new Promise(r => setTimeout(r, this.config.RESUME_DELAY));
            console.log("Car resuming...");
        } else {
            console.log("Car proceeding without stopping...");
            await new Promise(r => setTimeout(r, this.config.PASS_DURATION));
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
            if (this.responseTimeout) clearTimeout(this.responseTimeout);
            if (this.rl) this.rl.close();
            if (this.network) await this.network.cleanup();
            console.log("Cleanup complete");
        } catch (e) {
            console.error("Cleanup error:", e.message);
        }
    }
}

async function main() {
    const simulator = new CarSimulator();
    process.on("SIGINT", async () => { await simulator.cleanup(); process.exit(0); });
    process.on("SIGTERM", async () => { await simulator.cleanup(); process.exit(0); });
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
