// MQTT subscriber — mirrors ZenohSubscriber for selectable transport.
//
// Env vars:
//   MQTT_BROKER_URL   e.g. mqtt://127.0.0.1:1883 (default)

const EventEmitter = require("events");
const mqtt = require("mqtt");
const { topic } = require("./topics");

/**
 * Subscribes to MQTT keys and emits decoded transport messages.
 * @class
 * @extends EventEmitter
 * @param {Object} [options]
 * @param {string} [options.topicFilter] MQTT subscription filter.
 * @param {string} [options.keyExpression] Alias for `topicFilter`.
 * @param {string} [options.brokerUrl] MQTT URL; defaults to `MQTT_BROKER_URL` or localhost.
 */
class MqttSubscriber extends EventEmitter {
    /**
     * Create an MQTT subscriber.
     * @param {Object} [options]
     * @param {string} [options.topicFilter] MQTT subscription filter.
     * @param {string} [options.keyExpression] Alias for `topicFilter`.
     * @param {string} [options.brokerUrl] MQTT broker URL.
     */
    constructor(options = {}) {
        super();
        this.topicFilter = options.topicFilter || options.keyExpression || topic("#");
        this.brokerUrl = options.brokerUrl || process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883";
        this.client = null;
    }

    /**
     * Connect and subscribe, then emit `ready`.
     * @returns {Promise<void>}
     * @throws {Error} On connection or subscription failure.
     */
    async start() {
        if (this.client?.connected) return;
        this.client = mqtt.connect(this.brokerUrl, {
            reconnectPeriod: 1000,
            connectTimeout: 10_000,
        });
        this.client.on("error", (err) => this.emit("error", err));
        this.client.on("message", (topic, messageBuf) => {
            let payload = messageBuf.toString("utf-8");
            try { payload = JSON.parse(payload); } catch { /* leave as string */ }
            this.emit("message", { key: topic, payload });
        });

        await new Promise((resolve, reject) => {
            const onConnect = () => { cleanup(); resolve(); };
            const onError = (err) => { cleanup(); reject(err); };
            const cleanup = () => {
                this.client.off("connect", onConnect);
                this.client.off("error", onError);
            };
            this.client.once("connect", onConnect);
            this.client.once("error", onError);
        });

        await new Promise((resolve, reject) => {
            this.client.subscribe(this.topicFilter, { qos: 0 }, (err) => {
                if (err) reject(err); else resolve();
            });
        });

        this.emit("ready");
    }

    /**
     * End the MQTT client connection.
     * @returns {Promise<void>}
     */
    async stop() {
        if (!this.client) return;
        await new Promise((resolve) => this.client.end(false, {}, resolve));
        this.client = null;
    }
}

/**
 * @event MqttSubscriber#ready
 * @description Emitted after the MQTT subscription is active.
 */
/**
 * @event MqttSubscriber#message
 * @description Emitted for each matching message.
 * @property {TransportMessage} message Decoded transport message.
 */
/**
 * @event MqttSubscriber#error
 * @description Emitted for broker errors.
 * @property {Error} error The failure.
 */

module.exports = { MqttSubscriber };
