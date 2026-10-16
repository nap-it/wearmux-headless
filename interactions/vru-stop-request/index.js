const { createSubscriber, selectedTransport } = require("../../utils/transport");
const { topic } = require("../../utils/topics");
const { MessageDisplay } = require("./message-display");
const { NodDetector, GESTURE_SENSOR, GESTURE_WINDOW_MS } = require("./nod-detector");

const PROMPT_TOPIC = topic("vru", "prompt");
const ANSWER_TOPIC = topic("vru", "answer");
const normalizeId = (value) => String(value || "").toLowerCase().replaceAll(":", "");
const { createLatencyEmitter } = require("../../utils/latency-events");

class VruStopRequestInteraction {
    constructor({ publisher, getSessions }) {
        this.publisher = publisher;
        this.getSessions = getSessions;
        this.emitLatency = createLatencyEmitter(publisher);
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

    _emitLatency(stage, fields = {}, active = this.active) {
        this.emitLatency(stage, {
            ...(active ? { prompt_id: active.promptId,
                ...(active.requestActionId ? { request_action_id: active.requestActionId } : {}),
                device_id: active.session.info.id } : {}),
            ...fields,
        });
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
        }, null);
        if (this.active) {
            this._emitLatency("prompt_rejected", { prompt_id: prompt.prompt_id,
                ...(requestActionId ? { request_action_id: requestActionId } : {}), reason: "busy" }, null);
            console.warn("[VRU interaction] busy; ignoring prompt " + prompt.prompt_id);
            return;
        }

        const session = this._chooseSession(prompt);
        if (!session) {
            this._emitLatency("prompt_rejected", { prompt_id: prompt.prompt_id,
                ...(requestActionId ? { request_action_id: requestActionId } : {}), reason: "no_unique_ready_device" }, null);
            console.warn("[VRU interaction] no unique ready display/acceleration device for prompt " + prompt.prompt_id);
            return;
        }

        const active = {
            promptId: prompt.prompt_id,
            requestActionId,
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
            this._complete(active, null, { reason: "timeout" }).catch((error) =>
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
                completion_semantics: "firmware_render_ack", optical_completion: false,
            });
            active.detector.start((gesture, details) => {
                this._complete(active, gesture, details).catch((error) =>
                    console.warn("[VRU interaction] response failed:", error?.message || error));
            }, (error) => {
                console.warn("[VRU interaction] gesture inference failed:", error?.message || error);
                this._complete(active, null, { reason: "inference_failure", error: String(error?.message || error).slice(0, 512) }).catch((cleanupError) =>
                    console.warn("[VRU interaction] inference cleanup failed:", cleanupError?.message || cleanupError));
            }, (stage, details) => this._emitLatency(stage, details, active));
            this._emitLatency("gesture_collection_started", { window_ms: GESTURE_WINDOW_MS });
            console.log("[VRU interaction] prompt " + active.promptId + " shown on " + session.info.id + "; waiting for nod/shake");
        } catch (error) {
            this._emitLatency("prompt_failed", { reason: "display_or_detector_failure", error: String(error?.message || error).slice(0, 512) }, active);
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
                    ...(details || {}),
                });
                this._emitLatency("answer_publish_started", { answer, gesture });
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
                this._emitLatency(details?.reason === "timeout" ? "prompt_timeout" : "prompt_failed", details || { reason: "no_accepted_gesture" }, active);
                console.log("[VRU interaction] prompt " + active.promptId + ": no accepted gesture; handler will apply its timeout policy");
            }
        } catch (error) {
            this._emitLatency("answer_publish_failed", { error: String(error?.message || error).slice(0, 512) }, active);
            throw error;
        } finally {
            await this._finishDisplay(active);
            if (this.active === active) this.active = null;
        }
    }

    async _finishDisplay(active) {
        this._emitLatency("display_clear_started", {}, active);
        try {
            await active.display.clear();
            this._emitLatency("display_cleared", { completion_semantics: "firmware_render_ack", optical_completion: false }, active);
        } catch (error) {
            this._emitLatency("display_clear_failed", { error: String(error?.message || error).slice(0, 512) }, active);
            console.warn("[VRU interaction] display cleanup " + active.promptId + ":", error?.message || error);
        }
    }

    async stop() {
        if (this.active) {
            const active = this.active;
            active.finished = true;
            this._emitLatency("prompt_cancelled", { reason: "shutdown" }, active);
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
