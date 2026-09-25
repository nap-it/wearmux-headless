// Transport selection — one messaging backend for publishers and subscribers.
//
// Env vars:
//   MESSAGE_TRANSPORT=mqtt|zenoh|none  explicit choice
//   MQTT_ENABLE=1   use MQTT (MqttManager / MqttSubscriber)
//   ZENOH_ENABLE=1  use Zenoh (ZenohManager / ZenohSubscriber)
//
// Legacy enable flags remain supported. If both are set, MQTT wins.

const { ZenohManager } = require("./zenoh-manager");
const { ZenohSubscriber } = require("./zenoh-subscriber");
const { MqttManager } = require("./mqtt-manager");
const { MqttSubscriber } = require("./mqtt-subscriber");

function selectedTransport() {
    const explicit = process.env.MESSAGE_TRANSPORT?.trim().toLowerCase();
    if (explicit) {
        if (!["mqtt", "zenoh", "none"].includes(explicit)) {
            throw new Error(`Invalid MESSAGE_TRANSPORT '${explicit}' (expected mqtt, zenoh, or none)`);
        }
        return explicit;
    }
    if (process.env.MQTT_ENABLE === "1") return "mqtt";
    if (process.env.ZENOH_ENABLE === "1") return "zenoh";
    return "none";
}

function createPublisher(options = {}) {
    const transport = options.transport || selectedTransport();
    if (transport === "mqtt") return new MqttManager(options);
    if (transport === "zenoh") return new ZenohManager(options);
    return null;
}

function createSubscriber(options = {}) {
    const transport = options.transport || selectedTransport();
    if (transport === "mqtt") {
        return new MqttSubscriber({
            topicFilter: options.keyExpression || options.topicFilter,
            brokerUrl: options.brokerUrl,
        });
    }
    if (transport === "zenoh") {
        return new ZenohSubscriber({
            keyExpression: options.keyExpression || options.topicFilter,
            udsPath: options.udsPath,
        });
    }
    return null;
}

module.exports = { selectedTransport, createPublisher, createSubscriber };
