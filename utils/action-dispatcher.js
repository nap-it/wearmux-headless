const EventEmitter = require("events");
const { createPublisher, createSubscriber, selectedTransport } = require("./transport");
const { topic } = require("./topics");

const ACTION_TOPIC = topic("actions");
const RESULT_TOPIC = topic("actions", "result");
const MAX_IMAGE_BYTES = 1024 * 1024;

class ActionDispatcher extends EventEmitter {
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

    get deviceInfo() {
        return {
            id: this.device.bluetoothId || this.device.id || null,
            name: this.device.name || null,
        };
    }

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

    _isTargetDevice(deviceId) {
        const normalize = (value) => String(value || "").toLowerCase().replaceAll(":", "");
        return normalize(deviceId) === normalize(this.deviceInfo.id);
    }

    async _publishResult(result) {
        await this.publisher.publish(this.resultTopic, {
            ts: Date.now(),
            device: this.deviceInfo,
            ...result,
        });
    }

    async _readyDisplay() {
        if (!this.device.isDisplayAvailable) throw new Error("Display is unavailable on this device");
        if (this.device.isConnected === false) throw new Error("Device is disconnected");
        if (this.device.displayStatus === "asleep") await this.device.wakeDisplay();
    }

    async dispatch(command) {
        if (this.device.isConnected === false) throw new Error("Device is disconnected");
        switch (command.action) {
        case "display.prompt": {
            if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 500) {
                throw new Error("display.prompt requires 1–500 characters of text");
            }
            await this._readyDisplay();
            if (!this.promptDisplay) {
                const { PromptDisplay } = require("../display/lib/prompt-display");
                this.promptDisplay = new PromptDisplay(this.device);
            }
            // Prompt drawing owns black/white palette slots. Existing image
            // renderers must refresh their palette before their next draw.
            this.displayManager?.invalidatePaletteCache();
            this.textDisplay?.displayManager?.invalidatePaletteCache();
            await this.promptDisplay.show(command.text);
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
            await this.device.clearDisplay(false);
            await this.device.showDisplay(true);
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
        default:
            throw new Error(`Unsupported action '${command.action || ""}'`);
        }
    }
}

module.exports = { ActionDispatcher, ACTION_TOPIC, RESULT_TOPIC };
