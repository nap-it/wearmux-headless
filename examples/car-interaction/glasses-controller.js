#!/usr/bin/env node

/**
 * Glasses Controller - Interactive Car Use Case
 * 
 * This script acts as the Interaction Router (State Machine).
 * It uses NetworkClient for Zenoh communication and GlassesInterface for hardware interaction.
 */

const { NetworkClient } = require("./network-client");
const { GlassesInterface } = require("./glasses-interface");
const { ZENOH_TOPICS, STATE, GLASSES_CONFIG } = require("./constants");

// Block the event loop indefinitely
function _keepAlive() {
    return new Promise(() => { });
}

class GlassesController {
    constructor() {
        this.demoMode = process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true";
        this.config = GLASSES_CONFIG;

        this.network = null;
        this.glasses = null;

        this.state = STATE.IDLE;
        this.currentQuestion = null;
        this.gestureTimeout = null;
        this.clearDisplayTimeout = null;

        // Latency tracking
        this.approachReceiveTime = null;
        this.gestureResponseSendTime = null;
    }

    async initialize() {
        console.log("Glasses controller\n");

        // 1. Initialize Hardware Interface
        this.glasses = new GlassesInterface(this.demoMode, this.config);
        this.glasses.onGestureDetected((gesture) => this._handleGesture(gesture));
        await this.glasses.initialize();

        // 2. Initialize Network Client
        console.log("Initializing Network Client...");
        this.network = new NetworkClient({
            pubPrefix: ZENOH_TOPICS.GESTURE_PUB_PREFIX,
            subExpression: ZENOH_TOPICS.CAR_SUB_EXPRESSION,
            pubUdsPath: this.config.UDS_PUB_PATH,
            subUdsPath: this.config.UDS_SUB_PATH,
        });

        this.network.onMessage((topic, payload) => this._handleZenohMessage(topic, payload));
        await this.network.start();

        if (this.glasses.device) {
            this.network.setDeviceInfo({
                id: this.glasses.device.bluetoothId || this.glasses.device.id,
                name: this.glasses.device.name,
            });
        }
        console.log("Network Client ready\n");

        if (this.demoMode) {
            console.log("Demo mode ready! Waiting for car approach...\n");
        } else {
            await this.glasses.showMessage(this.config.MSG_READY);
            console.log("System ready! Waiting for car approach...\n");
        }
    }

    _handleZenohMessage(topic, payload) {
        if (topic === ZENOH_TOPICS.CAR_APPROACHING) {
            this.approachReceiveTime = Date.now();
            this._handleCarApproaching(payload);
        } else if (topic === ZENOH_TOPICS.CAR_CONFIRMATION) {
            if (payload.gestureSentTime) {
                const latency = Date.now() - payload.gestureSentTime;
                console.log(`Latency (gesture response to confirmation): ${latency.toFixed(2)}ms`);
            }
            this._handleCarConfirmation(payload);
        }
    }

    async _handleCarApproaching(payload) {
        if (this.state !== STATE.IDLE) {
            console.log("Ignoring car approach (busy)");
            return;
        }

        const message = payload.message || this.config.MSG_DEFAULT_APPROACH;
        console.log(`Car approaching: "${message}"`);

        this.state = STATE.WAITING_FOR_GESTURE;
        this.currentQuestion = message;

        if (this.demoMode) {
            console.log("Press [y] for YES (nod) or [n] for NO (shake) within 5 seconds...\n");
            const gesture = await this.glasses.waitForDemoGesture();
            await this._handleDemoGestureResult(gesture);
            return;
        }

        await this.glasses.showMessage(message, { color: this.config.COLOR_ATTENTION });
        this.glasses.startWaitingForGesture();

        this.gestureTimeout = setTimeout(() => {
            this._handleGestureTimeout();
        }, this.config.DEFAULT_GESTURE_TIMEOUT_MS);

        console.log("Waiting for gesture (nod=yes, shake=no)...");
    }

    async _handleDemoGestureResult(gesture) {
        if (gesture === "timeout") {
            console.log("No response (timeout)...");
        } else {
            console.log(`Response: ${gesture === "nod" ? "YES" : "NO"}`);
        }

        await this._sendGestureResponse(gesture);

        const feedback = gesture === "nod" ? "Response: YES" : gesture === "shake" ? "Response: NO" : "No response - Car will proceed";
        console.log(`Sent gesture response: ${gesture}\n   ${feedback}\n`);

        this.state = STATE.IDLE;
    }

    async _handleGesture(gesture) {
        if (this.state !== STATE.WAITING_FOR_GESTURE) return;

        if (this.approachReceiveTime) {
            const latency = Date.now() - this.approachReceiveTime;
            console.log(`Latency (approach to gesture): ${latency.toFixed(2)}ms`);
            this.approachReceiveTime = null;
        }

        if (this.gestureTimeout) {
            clearTimeout(this.gestureTimeout);
            this.gestureTimeout = null;
        }

        this.glasses.stopWaitingForGesture();

        const feedbackMessage = gesture === "nod" ? "\nSent: YES\n" : gesture === "shake" ? "\nSent: NO\n" : "\nSent: " + gesture + "\n";
        const msgColor = gesture === "nod" ? this.config.COLOR_CONFIRM : gesture === "shake" ? this.config.COLOR_WARNING : this.config.COLOR_CONFIRM;
        await this.glasses.showMessage(feedbackMessage, { color: msgColor });

        await this._sendGestureResponse(gesture);

        await new Promise(r => setTimeout(r, this.config.FEEDBACK_DISPLAY_MS));
        this.state = STATE.IDLE;
    }

    async _sendGestureResponse(gesture) {
        this.gestureResponseSendTime = Date.now();
        const response = {
            ts: this.gestureResponseSendTime,
            gesture: gesture,
            device: {
                id: this.glasses?.device?.bluetoothId || this.glasses?.device?.id || "DEMO",
                name: this.glasses?.device?.name || "Demo Glasses",
            },
            gestureSentTime: this.gestureResponseSendTime,
        };

        await this.network.publish(ZENOH_TOPICS.GESTURE_RESPONSE, response);
    }

    async _handleGestureTimeout() {
        if (this.state !== STATE.WAITING_FOR_GESTURE) return;

        console.log("Gesture timeout - no response");
        this.glasses.stopWaitingForGesture();

        await this._sendGestureResponse("timeout");

        await this.glasses.showMessage(this.config.MSG_TIMEOUT, { color: this.config.COLOR_WARNING });
        await new Promise(r => setTimeout(r, this.config.TIMEOUT_DISPLAY_MS));

        this.state = STATE.IDLE;
        await this.glasses.clearDisplay();
    }

    async _handleCarConfirmation(payload) {
        if (this.state === STATE.WAITING_FOR_GESTURE) {
            if (this.gestureTimeout) {
                clearTimeout(this.gestureTimeout);
                this.gestureTimeout = null;
            }
            this.glasses.stopWaitingForGesture();
        }

        const message = payload.message || this.config.MSG_DEFAULT_CONFIRMATION;
        console.log(`Car confirmation: "${message}"`);

        this.state = STATE.SHOWING_CONFIRMATION;

        await this.glasses.showMessage(message, { color: this.config.COLOR_CONFIRM });
        await new Promise(r => setTimeout(r, this.config.CONFIRMATION_DISPLAY_MS));

        if (this.clearDisplayTimeout) {
            clearTimeout(this.clearDisplayTimeout);
        }

        this.clearDisplayTimeout = setTimeout(async () => {
            if (this.state === STATE.IDLE) {
                await this.glasses.clearDisplay();
                console.log("Display cleared after confirmation");
            }
            this.clearDisplayTimeout = null;
        }, 5000);

        await this.glasses.clearDisplay();
        this.state = STATE.IDLE;
        console.log("Ready for next interaction\n");
    }

    async cleanup() {
        console.log("\nShutting down...");
        try {
            if (this.gestureTimeout) clearTimeout(this.gestureTimeout);
            if (this.clearDisplayTimeout) clearTimeout(this.clearDisplayTimeout);
            if (this.glasses) await this.glasses.cleanup();
            if (this.network) await this.network.cleanup();
            console.log("Cleanup complete");
        } catch (e) {
            console.error("Cleanup error:", e.message);
        }
    }
}

async function main() {
    const controller = new GlassesController();

    process.on("SIGINT", async () => {
        await controller.cleanup();
        process.exit(0);
    });

    process.on("SIGTERM", async () => {
        await controller.cleanup();
        process.exit(0);
    });

    await controller.initialize();
    await _keepAlive();
}

if (require.main === module) {
    main().catch((error) => {
        console.error("\nError:", error.message);
        console.error(error.stack);
        process.exit(1);
    });
}

module.exports = { GlassesController };
