const { createPublisher, createSubscriber } = require("../../utils/transport");
const fs = require('fs');

/**
 * Wraps pub/sub logic for the selected transport (zenoh or mqtt) into a single client.
 */
class NetworkClient {
  /**
   * @param {Object} options 
   * @param {string} options.pubPrefix - The prefix for the Zenoh Publisher (e.g. "car", "gesture")
   * @param {string} options.subExpression - The expression for the Zenoh Subscriber (e.g. "car/**", "gesture/response")
   * @param {string} options.pubUdsPath - Internal Unix Domain Socket path for the publisher
   * @param {string} options.subUdsPath - Internal Unix Domain Socket path for the subscriber
   */
  constructor(options) {
    this.options = options;
    this.publisher = null;
    this.subscriber = null;
    this.onMessageCallback = null;
  }

  /**
   * Set the message handler callback
   * @param {Function} callback (topic, payload) => void
   */
  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  async start() {
    this.publisher = createPublisher({
      keyPrefix: this.options.pubPrefix,
      udsPath: this.options.pubUdsPath,
    });
    if (!this.publisher) throw new Error("No transport enabled (set MQTT_ENABLE=1 or ZENOH_ENABLE=1)");
    await this.publisher.start();

    this.subscriber = createSubscriber({
      keyExpression: this.options.subExpression,
      udsPath: this.options.subUdsPath,
    });
    if (!this.subscriber) throw new Error("No transport enabled (set MQTT_ENABLE=1 or ZENOH_ENABLE=1)");

    this.subscriber.on("message", (msg) => {
      if (this.onMessageCallback) {
        const { key, payload } = msg;
        let parsedPayload = payload;

        // Validate & Parse JSON Payload safely
        if (typeof payload === 'string') {
          try {
            parsedPayload = JSON.parse(payload);
          } catch (e) {
            console.error(`[NetworkClient] Error parsing Zenoh payload for key ${key}:`, e.message);
            return;
          }
        }
        this.onMessageCallback(key, parsedPayload);
      }
    });

    this.subscriber.on("error", (err) => {
      console.error("[NetworkClient] Zenoh subscriber error:", err.message);
    });

    await this.subscriber.start();
  }

  /**
   * Used for wearable devices to assert identification metadata
   * @param {Object} deviceInfo {id, name}
   */
  setDeviceInfo(deviceInfo) {
    if (this.publisher) {
      this.publisher.setDeviceInfo(deviceInfo);
    }
  }

  /**
   * Publish a message
   * @param {string} topic 
   * @param {Object} data 
   */
  async publish(topic, data) {
    if (!this.publisher) {
      throw new Error("Publisher not initialized");
    }
    await this.publisher.publish(topic, data);
  }

  async cleanup() {
    // Run each step independently so a failure in one doesn't orphan the rest
    if (this.subscriber) {
      try { await this.subscriber.stop(); }
      catch (e) { console.error("[NetworkClient] subscriber.stop failed:", e.message); }
    }
    if (this.publisher) {
      try { await this.publisher.stop(); }
      catch (e) { console.error("[NetworkClient] publisher.stop failed:", e.message); }
    }
    for (const p of [this.options.pubUdsPath, this.options.subUdsPath]) {
      try { fs.rmSync(p, { force: true }); }
      catch (e) { console.error(`[NetworkClient] rm ${p} failed:`, e.message); }
    }
  }
}

module.exports = { NetworkClient };
