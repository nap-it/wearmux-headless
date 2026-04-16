// MQTT subscriber — mirrors ZenohSubscriber for selectable transport.
//
// Env vars:
//   MQTT_BROKER_URL   e.g. mqtt://127.0.0.1:1883 (default)

const EventEmitter = require("events");
const mqtt = require("mqtt");

class MqttSubscriber extends EventEmitter {
    constructor(options = {}) {
        super();
        this.topicFilter = options.topicFilter || options.keyExpression || "bsole/#";
        this.brokerUrl = options.brokerUrl || process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883";
        this.client = null;
    }

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

    async stop() {
        if (!this.client) return;
        await new Promise((resolve) => this.client.end(false, {}, resolve));
        this.client = null;
    }
}

module.exports = { MqttSubscriber };
