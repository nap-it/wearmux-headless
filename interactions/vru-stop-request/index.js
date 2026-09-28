const { createSubscriber, selectedTransport } = require("../../utils/transport");
const { topic } = require("../../utils/topics");
const { MessageDisplay } = require("./message-display");
const { NodDetector, GESTURE_SENSOR, GESTURE_WINDOW_MS } = require("./nod-detector");

const PROMPT_TOPIC = topic("vru", "prompt");
const ANSWER_TOPIC = topic("vru", "answer");
const normalizeId = (value) => String(value || "").toLowerCase().replaceAll(":", "");
const LATENCY_TOPIC = "latency/events/v1";

const latencyEvent = (stage, fields = {}) => ({
    schema: 1,
    source: "wearmux",
    stage,
    // Keep wall-clock values as decimal strings: JavaScript Numbers cannot
    // represent nanoseconds since the Unix epoch exactly.
    wall_time_ns: `${Date.now()}000000`,
    mono_time_ns: process.hrtime.bigint().toString(),
    ...fields,
});

class VruStopRequestInteraction {
    constructor({ publisher, getSessions }) {
        this.publisher = publisher;
        this.getSessions = getSessions;
        this.subscriber = createSubscriber({ topicFilter: PROMPT_TOPIC });
        const configuredTimeoutMs = Number(process.env.VRU_INTERACTION_TIMEOUT_MS);
        this.timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
            ? configuredTimeoutMs
            : 12_000;
        this.active = null;
        this.onMessage = ({ key, payload }) => {
            if (key !== PROMPT_TOPIC) return;
            this.handlePrompt(payload).catch((error) =>
                console.warn("[VRU interaction] prompt failed:", error?.message || error));
        };
    }

    _emitLatency(stage, fields = {}) {
        try {
            const result = this.publisher.publish(LATENCY_TOPIC, latencyEvent(stage, fields));
            Promise.resolve(result).catch((error) =>
                console.warn("[VRU interaction] latency event unavailable:", error?.message || error));
        } catch (error) {
            console.warn("[VRU interaction] latency event unavailable:", error?.message || error);
        }
    }

    async start() {
        if (selectedTransport() !== "mqtt") {
            throw new Error("The VRU stop-request handler uses MQTT; set MESSAGE_TRANSPORT=mqtt");
        }
        if (!this.publisher || !this.subscriber) {
            throw new Error("VRU interaction requires an enabled MQTT transport");
        }
        // Load the local WASM once before accepting prompts, outside the response deadline.
        this.classifier = await NodDetector.loadClassifier();
        const properties = this.classifier.getProperties();
        console.log(`[VRU interaction] BrilliantWear Edge Impulse model ready (${GESTURE_WINDOW_MS / properties.interval_ms} acceleration samples over ${GESTURE_WINDOW_MS} ms; model metadata lists ${properties.input_features_count} features)`);
        this.subscriber.on("error", (error) =>
            console.warn("[VRU interaction] MQTT:", error?.message || error));
        this.subscriber.on("message", this.onMessage);
        await this.subscriber.start();
        console.log("[VRU interaction] Listening on " + PROMPT_TOPIC + "; answers go to " + ANSWER_TOPIC);
    }

    _chooseSession(prompt) {
        const targetId = prompt.device_id || prompt.deviceId || process.env.VRU_DEVICE_ID;
        const candidates = [...this.getSessions()].filter((session) =>
            session.ready &&
            session.device.isConnected !== false &&
            session.capabilities.display &&
            session.capabilities.sensors.includes(GESTURE_SENSOR.type) &&
            session.sensors?.getEnabledSensors().includes(GESTURE_SENSOR.type));

        if (targetId) {
            return candidates.find((session) => normalizeId(session.info.id) === normalizeId(targetId)) || null;
        }
        return candidates.length === 1 ? candidates[0] : null;
    }

    async handlePrompt(prompt) {
        if (!prompt || typeof prompt !== "object" || Array.isArray(prompt) ||
            typeof prompt.prompt_id !== "string" || !prompt.prompt_id) {
            console.warn("[VRU interaction] ignoring malformed prompt");
            return;
        }
        const requestActionId = prompt.originating_station_id !== undefined &&
            prompt.sequence_number !== undefined
            ? `${prompt.originating_station_id}:${prompt.sequence_number}`
            : undefined;
        this._emitLatency("prompt_received", {
            prompt_id: prompt.prompt_id,
            ...(requestActionId ? { request_action_id: requestActionId } : {}),
        });
        if (this.active) {
            console.warn("[VRU interaction] busy; ignoring prompt " + prompt.prompt_id);
            return;
        }

        const session = this._chooseSession(prompt);
        if (!session) {
            console.warn("[VRU interaction] no unique ready display/acceleration device for prompt " + prompt.prompt_id);
            return;
        }

        const active = {
            promptId: prompt.prompt_id,
            session,
            display: new MessageDisplay(session),
            detector: new NodDetector(session.sensors, { classifier: this.classifier }),
            finished: false,
            timeout: null,
        };
        this.active = active;
        const advertisedTimeoutMs = Number(prompt.timeout_s) * 1000;
        const promptTimeoutMs = Number.isFinite(advertisedTimeoutMs) && advertisedTimeoutMs > 0
            ? Math.min(this.timeoutMs, Math.max(100, advertisedTimeoutMs - 500))
            : this.timeoutMs;
        active.timeout = setTimeout(() => {
            this._complete(active, null).catch((error) =>
                console.warn("[VRU interaction] timeout cleanup failed:", error?.message || error));
        }, promptTimeoutMs);

        try {
            this._emitLatency("display_started", {
                prompt_id: active.promptId,
                ...(requestActionId ? { request_action_id: requestActionId } : {}),
            });
            await active.display.show(prompt.question || "Should I stop?");
            if (this.active !== active || active.finished) return;
            this._emitLatency("display_ready", {
                prompt_id: active.promptId,
                ...(requestActionId ? { request_action_id: requestActionId } : {}),
            });
            active.detector.start((gesture, details) => {
                this._complete(active, gesture, details).catch((error) =>
                    console.warn("[VRU interaction] response failed:", error?.message || error));
            }, (error) => {
                console.warn("[VRU interaction] gesture inference failed:", error?.message || error);
                this._complete(active, null).catch((cleanupError) =>
                    console.warn("[VRU interaction] inference cleanup failed:", cleanupError?.message || cleanupError));
            });
            console.log("[VRU interaction] prompt " + active.promptId + " shown on " + session.info.id + "; waiting for nod/shake");
        } catch (error) {
            clearTimeout(active.timeout);
            active.detector.stop();
            await this._finishDisplay(active);
            if (this.active === active) this.active = null;
            throw error;
        }
    }

    async _complete(active, gesture, details) {
        if (this.active !== active || active.finished) return;
        active.finished = true;
        clearTimeout(active.timeout);
        active.detector.stop();

        try {
            if (gesture) {
                const answer = gesture === "nod" ? "yes" : "no";
                this._emitLatency("gesture_received", {
                    prompt_id: active.promptId,
                    answer,
                    gesture,
                });
                await this.publisher.publish(ANSWER_TOPIC, {
                    prompt_id: active.promptId,
                    answer,
                    gesture,
                    device: active.session.info,
                });
                this._emitLatency("answer_published", {
                    prompt_id: active.promptId,
                    answer,
                    gesture,
                });
                const extra = details ? " (" + JSON.stringify(details) + ")" : "";
                console.log("[VRU interaction] prompt " + active.promptId + ": " + gesture + " -> " + answer + extra);
            } else {
                console.log("[VRU interaction] prompt " + active.promptId + ": no accepted gesture; handler will apply its timeout policy");
            }
        } finally {
            await this._finishDisplay(active);
            if (this.active === active) this.active = null;
        }
    }

    async _finishDisplay(active) {
        try { await active.display.clear(); }
        catch (error) {
            console.warn("[VRU interaction] display cleanup " + active.promptId + ":", error?.message || error);
        }
    }

    async stop() {
        if (this.active) {
            const active = this.active;
            active.finished = true;
            clearTimeout(active.timeout);
            active.detector.stop();
            await this._finishDisplay(active);
            this.active = null;
        }
        this.subscriber?.off("message", this.onMessage);
        await this.subscriber?.stop();
    }
}

module.exports = { VruStopRequestInteraction, PROMPT_TOPIC, ANSWER_TOPIC };
