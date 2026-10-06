const EventEmitter = require("events");
const { createPublisher, createSubscriber, selectedTransport } = require("./transport");
const { topic } = require("./topics");

const ACTION_TOPIC = topic("actions");
const RESULT_TOPIC = topic("actions", "result");
const MAX_IMAGE_BYTES = 1024 * 1024;
const NOTIFICATION_LEVELS = ["warning", "danger", "safe"];

/**
 * Serializes display, haptic, audio, and notification actions received from the selected transport.
 * @class
 * @extends EventEmitter
 * @param {Object} device Connected SDK device.
 * @param {Object} [options]
 * @param {string} [options.transport] `mqtt`, `zenoh`, or `none`.
 * @param {string} [options.actionTopic] Inbound action key.
 * @param {string} [options.resultTopic] Outbound result key.
 * @param {Publisher|null} [options.publisher] Shared publisher.
 * @param {Subscriber|null} [options.subscriber] Shared subscriber.
 */
class ActionDispatcher extends EventEmitter {
    /**
     * Create a dispatcher for one connected SDK device.
     * @param {Object} device Connected SDK device.
     * @param {Object} [options]
     * @param {string} [options.transport] `mqtt`, `zenoh`, or `none`.
     * @param {string} [options.actionTopic] Inbound action key.
     * @param {string} [options.resultTopic] Outbound result key.
     * @param {Publisher|null} [options.publisher] Shared publisher to reuse.
     * @param {Subscriber|null} [options.subscriber] Shared subscriber to reuse.
     */
    constructor(device, options = {}) {
        super();
        if (!device) throw new Error("ActionDispatcher requires a connected device");
        this.device = device;
        this.transport = options.transport || selectedTransport();
        this.actionTopic = options.actionTopic || ACTION_TOPIC;
        this.resultTopic = options.resultTopic || RESULT_TOPIC;
        this.publisher = options.publisher || null;
        this.subscriber = options.subscriber || null;
        this.textDisplay = null;
        this.promptDisplay = null;
        this.displayManager = null;
        this._pending = Promise.resolve();
        this._started = false;
        this._onTransportError = (error) => this.emit("error", error);
        this._onMessage = (message) => {
            // Device display and vibration commands must not overlap.
            this._pending = this._pending
                .then(() => this._handleMessage(message))
                .catch((error) => this.emit("error", error));
        };
    }

    /**
     * Start the publisher and subscriber, then listen for action messages.
     * Stops both endpoints on startup failure, including supplied endpoints.
     * Register an error listener before starting this standalone receiver.
     * @returns {Promise<void>}
     * @throws {Error} If the selected transport cannot start.
     */
    async start() {
        if (this._started) return;
        if (this.transport === "none" && (!this.publisher || !this.subscriber)) {
            throw new Error("No messaging transport enabled for actions");
        }
        this.publisher ||= createPublisher({
            transport: this.transport,
            keyPrefix: topic("actions"),
        });
        this.subscriber ||= createSubscriber({
            transport: this.transport,
            topicFilter: this.actionTopic,
        });
        this.publisher.on("error", this._onTransportError);
        this.subscriber.on("error", this._onTransportError);
        this.subscriber.on("message", this._onMessage);
        try {
            await this.publisher.start();
            await this.subscriber.start();
            this._started = true;
        } catch (error) {
            try { await this.stop(); }
            catch (cleanupError) { this.emit("error", cleanupError); }
            throw error;
        }
        console.log(`[Actions] Listening on ${this.actionTopic} via ${this.transport}`);
    }

    /**
     * Stop inbound messages, drain queued actions, and stop transport endpoints.
     * Supplied publisher/subscriber instances are stopped too. To share a publisher
     * with a fleet or session, use dispatch() directly rather than starting this receiver.
     * @returns {Promise<void>}
     */
    async stop() {
        try {
            await this.subscriber?.stop();
        } finally {
            await this._pending;
            try {
                await this.publisher?.stop();
            } finally {
                this.publisher?.off("error", this._onTransportError);
                this.subscriber?.off("error", this._onTransportError);
                this.subscriber?.off("message", this._onMessage);
                this._started = false;
            }
        }
    }

    /**
     * Return a snapshot of the target device identity.
     * @returns {DeviceIdentity}
     */
    get deviceInfo() {
        return {
            id: this.device.bluetoothId || this.device.id || null,
            name: this.device.name || null,
        };
    }

    /**
     * Validate and dispatch one transport message.
     * @private
     * @param {{key:string,payload:*}} message
     * @returns {Promise<void>}
     */
    async _handleMessage({ key, payload } = {}) {
        if (key !== this.actionTopic) return;
        let command = payload;
        try {
            if (typeof command === "string") command = JSON.parse(command);
            if (!command || typeof command !== "object" || Array.isArray(command)) {
                throw new Error("Action payload must be a JSON object");
            }
        } catch (error) {
            await this._publishResult({ ok: false, error: error.message });
            return;
        }

        const id = typeof command.id === "string" ? command.id : undefined;
        const action = typeof command.action === "string" ? command.action : undefined;
        if (command.deviceId && !this._isTargetDevice(command.deviceId)) return;

        try {
            await this.dispatch(command);
            await this._publishResult({ id, action, ok: true });
        } catch (error) {
            await this._publishResult({ id, action, ok: false, error: error.message });
        }
    }

    /**
     * Compare a command target with this device identity.
     * @private
     * @param {string} deviceId
     * @returns {boolean}
     */
    _isTargetDevice(deviceId) {
        const normalize = (value) => String(value || "").toLowerCase().replaceAll(":", "");
        return normalize(deviceId) === normalize(this.deviceInfo.id);
    }

    /**
     * Publish a result envelope for an action message.
     * @private
     * @param {ActionResult} result
     * @returns {Promise<void>}
     */
    async _publishResult(result) {
        await this.publisher.publish(this.resultTopic, {
            ts: Date.now(),
            device: this.deviceInfo,
            ...result,
        });
    }

    /**
     * Ensure the display is connected and awake before rendering.
     * @private
     * @returns {Promise<void>}
     * @throws {Error} If display capability is unavailable or the device is disconnected.
     */
    async _readyDisplay() {
        if (!this.device.isDisplayAvailable) throw new Error("Display is unavailable on this device");
        if (this.device.isConnected === false) throw new Error("Device is disconnected");
        if (this.device.displayStatus === "asleep") await this.device.wakeDisplay();
    }

    /**
     * Lazily create the SDK prompt display helper.
     * @private
     * @returns {Object}
     */
    _getPromptDisplay() {
        if (!this.promptDisplay) {
            const { PromptDisplay } = require("../display/lib/prompt-display");
            this.promptDisplay = new PromptDisplay(this.device);
        }
        return this.promptDisplay;
    }

    /**
     * Execute one validated display, haptic, audio, or notification command.
     * @param {ActionCommand} command
     * @returns {Promise<void>} Rejects for invalid fields, missing capabilities,
     * a disconnected device, or a failed SDK call. Does not serialize concurrent
     * direct calls or publish an action result.
     * @throws {Error} If the device is unavailable, input is invalid, or the action is unsupported.
     */
    async dispatch(command) {
        if (this.device.isConnected === false) throw new Error("Device is disconnected");
        switch (command.action) {
        case "display.prompt": {
            if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 500) {
                throw new Error("display.prompt requires 1–500 characters of text");
            }
            await this._readyDisplay();
            // Prompt drawing owns black/white/amber palette slots. Existing image
            // renderers must refresh their palette before their next draw.
            this.displayManager?.invalidatePaletteCache();
            this.textDisplay?.displayManager?.invalidatePaletteCache();
            await this._getPromptDisplay().show(command.text);
            return;
        }
        case "display.text": {
            if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 500) {
                throw new Error("display.text requires 1–500 characters of text");
            }
            await this._readyDisplay();
            if (!this.textDisplay) {
                const { TextDisplay } = require("../display/lib/text-display");
                this.textDisplay = new TextDisplay(this.device);
                await this.textDisplay.loadFont();
            }
            await this.textDisplay.showText(command.text, { clearBefore: true });
            return;
        }
        case "display.clear":
            await this._readyDisplay();
            await this._getPromptDisplay().clear();
            return;
        case "display.image": {
            if (typeof command.data !== "string" || command.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.data)) {
                throw new Error("display.image requires base64 image data");
            }
            const buffer = Buffer.from(command.data, "base64");
            if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
                throw new Error("display.image must be at most 1 MiB");
            }
            await this._readyDisplay();
            if (!this.displayManager) {
                const { DisplayManager } = require("../display/lib/display-manager");
                this.displayManager = new DisplayManager(this.device);
            }
            await this.displayManager.showImageBuffer(buffer);
            return;
        }
        case "haptic.vibrate": {
            if (!Array.isArray(this.device.vibrationLocations) || !this.device.vibrationLocations.length) {
                throw new Error("Vibration is unavailable on this device");
            }
            const effect = command.effect === undefined ? "strongClick100" : command.effect;
            if (typeof effect !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(effect)) {
                throw new Error("haptic.vibrate requires a valid effect name");
            }
            if (effect !== "strongClick100") {
                const { VibrationWaveformEffects } = await import("brilliantsole/node");
                if (!VibrationWaveformEffects.includes(effect)) {
                    throw new Error(`Unsupported vibration effect '${effect}'`);
                }
            }
            const locations = command.locations;
            if (locations !== undefined && (!Array.isArray(locations) || !locations.length ||
                locations.some((location) => !this.device.vibrationLocations.includes(location)))) {
                throw new Error("haptic.vibrate locations must be supported by the device");
            }
            await this.device.triggerVibration([{
                type: "waveformEffect",
                segments: [{ effect }],
                ...(locations ? { locations } : {}),
            }]);
            return;
        }
        case "audio.beep": {
            if (!this.device.canBeep) throw new Error("Beep is unavailable on this device");
            const frequency = command.frequency ?? 880;
            const durationMs = command.durationMs ?? 250;
            if (!Number.isInteger(frequency) || frequency < 40 || frequency > 8000) {
                throw new Error("audio.beep frequency must be an integer from 40 to 8000 Hz");
            }
            if (!Number.isInteger(durationMs) || durationMs < 10 || durationMs > 5000) {
                throw new Error("audio.beep durationMs must be an integer from 10 to 5000");
            }
            await this.device.playBeep({ frequency, durationMs });
            return;
        }
        case "notification.show": {
            if (!this.device.canNotify) throw new Error("Notifications are unavailable on this device");
            const level = command.level ?? "warning";
            if (!NOTIFICATION_LEVELS.includes(level)) {
                throw new Error(`notification.show level must be one of ${NOTIFICATION_LEVELS.join(", ")}`);
            }
            const title = command.title ?? "WearMux";
            const text = command.text ?? "";
            if (typeof title !== "string" || !title.trim() || title.length > 100) {
                throw new Error("notification.show requires a title of 1–100 characters");
            }
            if (typeof text !== "string" || text.length > 500) {
                throw new Error("notification.show text must be at most 500 characters");
            }
            await this.device.showNotification({ level, title, text });
            return;
        }
        default:
            throw new Error(`Unsupported action '${command.action || ""}'`);
        }
    }
}

/**
 * @event ActionDispatcher#error
 * @description Emitted when transport setup or a queued inbound action fails.
 * @property {Error} error The failure.
 */

module.exports = { ActionDispatcher, ACTION_TOPIC, RESULT_TOPIC };
