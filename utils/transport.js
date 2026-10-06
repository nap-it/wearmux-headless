// Transport selection — one messaging backend for publishers and subscribers.
//
// MESSAGE_TRANSPORT=mqtt|zenoh|none selects one backend for both directions.

const { ZenohManager } = require("./zenoh-manager");
const { ZenohSubscriber } = require("./zenoh-subscriber");
const { MqttManager } = require("./mqtt-manager");
const { MqttSubscriber } = require("./mqtt-subscriber");

/**
 * Read and validate the shared message transport selection.
 * @returns {string} `mqtt`, `zenoh`, or `none`.
 * @throws {Error} If `MESSAGE_TRANSPORT` is unsupported.
 */
function selectedTransport() {
    const transport = process.env.MESSAGE_TRANSPORT?.trim().toLowerCase() || "none";
    if (!["mqtt", "zenoh", "none"].includes(transport)) {
        throw new Error(`Invalid MESSAGE_TRANSPORT '${transport}' (expected mqtt, zenoh, or none)`);
    }
    return transport;
}

/**
 * Create the configured publisher, or null when messaging is disabled.
 * @param {TransportOptions} [options]
 * @returns {Publisher|null}
 */
function createPublisher(options = {}) {
    const transport = options.transport || selectedTransport();
    if (transport === "mqtt") return new MqttManager(options);
    if (transport === "zenoh") return new ZenohManager(options);
    return null;
}

/**
 * Create the configured subscriber, or null when messaging is disabled.
 * @param {TransportOptions} [options]
 * @returns {Subscriber|null}
 */
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
