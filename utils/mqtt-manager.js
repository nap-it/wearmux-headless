// MQTT publisher — mirrors ZenohManager's interface for selectable transport.
//
// Env vars:
//   MQTT_BROKER_URL   e.g. mqtt://127.0.0.1:1883 (default)
//   TOPIC_PREFIX      Topic root (default: bwear)

const EventEmitter = require("events");
const mqtt = require("mqtt");
const { topic } = require("./topics");

/**
 * Publishes sensor envelopes through MQTT and can bind to a SensorManager.
 * @class
 * @extends EventEmitter
 * @param {Object} [options]
 * @param {string} [options.keyPrefix] Prefix for published sensor keys.
 * @param {string} [options.brokerUrl] MQTT URL; defaults to `MQTT_BROKER_URL` or localhost.
 */
class MqttManager extends EventEmitter {
    /**
     * Create an MQTT publisher.
     * @param {Object} [options]
     * @param {string} [options.keyPrefix] Prefix for published sensor keys.
     * @param {string} [options.brokerUrl] MQTT broker URL.
     */
    constructor(options = {}) {
        super();
        this.keyPrefix = options.keyPrefix || topic("sensors");
        this.brokerUrl = options.brokerUrl || process.env.MQTT_BROKER_URL || "mqtt://127.0.0.1:1883";
        this.prettyJson = true;
        this.client = null;
        this._attached = false;
        this._attachedHandlers = new Map();
        this._sensorManager = null;
        this._deviceInfo = null;
    }

    /**
     * Set optional device identity included in subsequent sensor envelopes.
     * @param {DeviceIdentity|null} info
     * @returns {void}
     */
    setDeviceInfo(info) {
        this._deviceInfo = info || null;
    }

    /**
     * Connect to the broker and emit `ready`.
     * @returns {Promise<Object>} MQTT client.
     * @throws {Error} On initial connection failure.
     */
    async start() {
        if (this.client?.connected) return this.client;
        this.client = mqtt.connect(this.brokerUrl, {
            reconnectPeriod: 1000,
            connectTimeout: 10_000,
        });
        this.client.on("error", (err) => this.emit("error", err));
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
        this.emit("ready");
        return this.client;
    }

    /**
     * Detach sensor listeners and close the MQTT client.
     * @returns {Promise<void>}
     */
    async stop() {
        try { await this.detachAll(this._sensorManager); } catch { }
        if (this.client) {
            await new Promise((resolve) => this.client.end(false, {}, resolve));
            this.client = null;
        }
        this._sensorManager = null;
    }

    /**
     * Build a key for one sensor type.
     * @private
     * @param {string} sensorType
     * @returns {string}
     */
    _topicFor(sensorType) {
        return `${this.keyPrefix}/${sensorType}`;
    }

    /**
     * Serialize a payload for MQTT.
     * @private
     * @param {*} payload
     * @returns {string}
     */
    _serialize(payload) {
        if (payload == null) return "null";
        try {
            return JSON.stringify(payload, null, this.prettyJson ? 2 : 0);
        } catch {
            return String(payload);
        }
    }

    /**
     * Publish one JSON-serialized payload at QoS 0.
     * @param {string} topic
     * @param {*} payload
     * @returns {Promise<void>}
     * @throws {Error} If disconnected or publishing fails.
     */
    async publish(topic, payload) {
        if (!this.client?.connected) throw new Error("MQTT client is not connected");
        const body = this._serialize(payload);
        return new Promise((resolve, reject) => {
            this.client.publish(topic, body, { qos: 0 }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
    }

    /**
     * Subscribe to selected sensor events and publish them under the configured prefix.
     * @param {Object} sensorManager
     * @param {SensorAttachmentOptions} [options]
     * @returns {Promise<void>}
     */
    async attachToSensorManager(sensorManager, options = {}) {
        if (this._attached) return;
        if (!this.client?.connected) await this.start();
        this._sensorManager = sensorManager;
        const enabled = sensorManager.getEnabledSensors?.() || [];
        const sensors = Array.isArray(options.sensors) && options.sensors.length > 0
            ? options.sensors
            : enabled;
        const quiet = Boolean(options.quiet);

        try {
            const dev = sensorManager?.device || sensorManager.getDevice?.();
            if (dev) {
                this.setDeviceInfo({
                    id: dev.bluetoothId || dev.id || undefined,
                    name: dev.name || undefined,
                });
            }
        } catch { }

        sensors.forEach((sensorType) => {
            const topic = this._topicFor(sensorType);
            const handler = async (event) => {
                const safeMessage = event && typeof event === "object" ? event.message ?? null : null;
                const payload = {
                    ts: Date.now(),
                    sensor: sensorType,
                    device: this._deviceInfo || undefined,
                    message: safeMessage,
                };
                try {
                    await this.publish(topic, payload);
                } catch (e) {
                    if (!quiet) console.warn(`[MqttManager] publish failed on ${topic}:`, e?.message || e);
                    this.emit("error", e);
                }
            };
            this._attachedHandlers.set(sensorType, handler);
            sensorManager.on(sensorType, handler);
            if (!quiet) console.log(`[MqttManager] Publishing '${sensorType}' to '${topic}'`);
        });

        this._attached = true;
    }

    /**
     * Remove all listeners installed by {@link MqttManager#attachToSensorManager}.
     * @param {Object} [sensorManager]
     * @returns {Promise<void>}
     */
    async detachAll(sensorManager) {
        if (!this._attached) return;
        const sm = sensorManager || this._sensorManager;
        if (sm && this._attachedHandlers.size) {
            for (const [sensorType, handler] of this._attachedHandlers.entries()) {
                try { sm.off?.(sensorType, handler); } catch { }
                try { sm.removeListener?.(sensorType, handler); } catch { }
            }
        }
        this._attachedHandlers.clear();
        this._attached = false;
    }
}

/**
 * @event MqttManager#ready
 * @description Emitted after the MQTT broker connection is established.
 */
/**
 * @event MqttManager#error
 * @description Emitted for broker and publish failures.
 * @property {Error} error The failure.
 */

module.exports = { MqttManager };
