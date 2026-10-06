// SDK-compatible connection manager. Android proxies characteristic bytes; the SDK
// remains responsible for metadata, sensor decoding and display command encoding.
/**
 * SDK-compatible connection manager for acknowledged Android GATT writes.
 * Created by AndroidBleBridge, which owns the connection lifetime. Callbacks
 * onStatusUpdated, onMessageReceived, and onMessagesReceived are assigned by the
 * SDK. Android owns scanning and reconnection; firmware updates are unsupported.
 * @class
 * @see {@tutorial android-ble-protocol}
 */
class AndroidBleConnection {
    /**
     * Create an adapter; this does not connect a GATT peripheral.
     * @param {AndroidBleConnectionOptions} options SDK types and bridge-owned callbacks.
     */
    constructor({ deviceId, mtu, messageTypes, write, disconnect, onError }) {
        this.bluetoothId = deviceId;
        this.type = "androidBle";
        this.attMtu = mtu;
        this._mtu = mtu;
        this.messageTypes = messageTypes;
        this.write = write;
        this.requestDisconnect = disconnect;
        this.onError = onError;
        this.status = "notConnected";
        this.pending = [];
        this.generation = 0;
    }

    /** @type {boolean} */
    get isConnected() { return this.status === "connected"; }
    /** @type {boolean} */
    get isAvailable() { return this.isConnected; }
    /** @type {boolean} */
    get canReconnect() { return false; } // Android owns scan/reconnection.
    /** @type {boolean} */
    get canUpdateFirmware() { return false; }
    /**
     * Effective protocol MTU, capped by negotiated ATT MTU; write bytes are limited to mtu minus 3.
     * @type {number}
     */
    get mtu() { return Math.min(this._mtu, this.attMtu); }
    /**
     * Set the SDK protocol MTU; reads still honor the ATT limit.
     * @param {number} value Integer of at least 23.
     * @throws {Error} If the SDK MTU is invalid.
     */
    set mtu(value) {
        if (!Number.isInteger(value) || value < 23) throw new Error("Invalid SDK protocol MTU");
        this._mtu = value;
    }

    /** @private */
    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        // SDK status callbacks may be async; always handle their rejection.
        try { Promise.resolve(this.onStatusUpdated?.(status)).catch(this.onError); }
        catch (error) { this.onError(error); }
    }

    /**
     * Announce the proxy link to the SDK; capability initialization follows separately.
     * @returns {Promise<boolean>} Always true; not a capability-readiness acknowledgement.
     */
    async connect() { this.setStatus("connected"); return true; }
    /**
     * Request peripheral disconnection through the bridge and clear queued SDK writes.
     * @returns {Promise<boolean>} False if already disconnected, otherwise true.
     */
    async disconnect() {
        if (this.status === "notConnected") return false;
        this.requestDisconnect();
        this.markDisconnected();
        return true;
    }
    /** @private */
    markDisconnected() {
        this.clear();
        this.setStatus("notConnected");
    }
    /** @returns {Promise<boolean>} Always false; Android owns reconnection. */
    async reconnect() { return false; }
    /**
     * Reject unsupported firmware-update traffic.
     * @returns {Promise<void>}
     * @throws {Error} Always: firmware update is unsupported.
     */
    async sendSmpMessage() { throw new Error("Firmware update is not supported by the Android BLE bridge"); }

    /**
     * Encode complete SDK TLVs and optionally flush them in order within the MTU.
     * Transport/encoding failures reach the supplied onError callback and are
     * consumed here, because SDK callers may fire and forget these writes.
     * @param {AndroidBleTxMessage[]} messages SDK message names and binary payloads.
     * @param {boolean} [sendImmediately=true] False queues until a later flush.
     * @returns {Promise<void|boolean>|undefined} Current flush, false on failure, or undefined when only queued.
     */
    sendTxMessages(messages, sendImmediately = true) {
        // SDK managers fire and forget commands; public operations await firmware
        // events. Invalidate the link through onError and consume transport errors.
        try { return this.queueTxMessages(messages, sendImmediately); }
        catch (error) { this.onError(error); return Promise.resolve(false); }
    }

    /** @private */
    queueTxMessages(messages, sendImmediately) {
        if (!this.isConnected) throw new Error("Android BLE device is disconnected");
        const encoded = (messages || []).map(({ type, data }) => {
            const index = this.messageTypes.indexOf(type);
            if (index < 0 || index > 255) throw new Error("Unknown SDK message type");
            const bytes = data ? Buffer.from(data) : Buffer.alloc(0);
            if (bytes.length > 65535) throw new Error("SDK payload is too large");
            const packet = Buffer.alloc(3 + bytes.length);
            packet[0] = index;
            packet.writeUInt16LE(bytes.length, 1);
            bytes.copy(packet, 3);
            if (packet.length > this.mtu - 3) throw new Error("SDK message exceeds negotiated BLE MTU");
            return packet;
        });
        if (this.pending.length + encoded.length > 2048) throw new Error("SDK command queue is full");
        this.pending.push(...encoded);
        if (!sendImmediately) return;
        if (!this.flushing) {
            const generation = this.generation;
            const task = this.drain(generation).catch((error) => {
                if (generation === this.generation) {
                    this.pending.length = 0;
                    this.onError(error);
                }
                return false;
            });
            this.flushing = task;
            task.then(() => {
                if (this.flushing !== task) return;
                this.flushing = null;
                // A firmware notification can enqueue a command after drain's
                // last await, before this completion callback runs.
                if (this.isConnected && generation === this.generation && this.pending.length) {
                    this.queueTxMessages([], true);
                }
            });
        }
        return this.flushing;
    }

    /** @private */
    async drain(generation) {
        while (this.pending.length) {
            if (!this.isConnected || generation !== this.generation) throw new Error("BLE connection changed during write");
            const packets = [];
            let size = 0;
            while (this.pending.length && size + this.pending[0].length <= this.mtu - 3) {
                const packet = this.pending.shift();
                packets.push(packet);
                size += packet.length;
            }
            if (!packets.length) throw new Error("Queued SDK message exceeds updated BLE MTU");
            await this.sendTxData(Buffer.concat(packets));
        }
    }

    /**
     * Send one complete TX packet and wait for its Android GATT acknowledgement.
     * @param {Buffer|ArrayBuffer|Uint8Array} data Binary packet; must fit mtu minus 3.
     * @returns {Promise<void>}
     * @throws {Error} If disconnected, oversized, or the bridge write fails/times out.
     */
    async sendTxData(data) {
        if (!this.isConnected) throw new Error("Android BLE device is disconnected");
        const bytes = Buffer.from(data);
        if (!bytes.length) return;
        if (bytes.length > this.mtu - 3) throw new Error("Write exceeds negotiated BLE MTU");
        await this.write(bytes);
    }

    /**
     * Deliver a characteristic read/notification into the SDK using exact-size buffers.
     * RX is validated as complete TLVs before any callback. Firmware getMtu replies
     * are capped to ATT MTU so the SDK's own packetizers honor the negotiated limit.
     * @param {string} characteristic rx or an allowed battery/device-information name.
     * @param {Buffer} bytes Unmodified characteristic bytes from the companion.
     * @returns {void}
     * @throws {Error} If disconnected, the value is empty/invalid, or an SDK parser throws.
     */
    receive(characteristic, bytes) {
        if (!this.isConnected) throw new Error("Value received for disconnected BLE device");
        if (characteristic !== "rx") {
            if (!bytes.length) throw new Error("Empty characteristic value");
            const copy = Uint8Array.from(bytes);
            this.onMessageReceived?.(characteristic, new DataView(copy.buffer));
        } else {
            // Validate the entire notification before mutating SDK state.
            const messages = [];
            for (let offset = 0; offset < bytes.length;) {
                if (bytes.length - offset < 3) throw new Error("Truncated SDK TLV header");
                const type = this.messageTypes[bytes[offset]];
                const length = bytes.readUInt16LE(offset + 1);
                offset += 3;
                if (!type || length > bytes.length - offset) throw new Error("Invalid SDK TLV payload");
                // SDK parsers use dataView.buffer directly; give each message an exact buffer.
                const copy = Uint8Array.from(bytes.subarray(offset, offset + length));
                const view = new DataView(copy.buffer);
                if (type === "getMtu") {
                    if (length !== 2 || view.getUint16(0, true) < 23) throw new Error("Invalid firmware MTU response");
                    // SDK display/file managers use Device.mtu, not our getter.
                    // Give all SDK packetizers the effective negotiated limit.
                    view.setUint16(0, Math.min(view.getUint16(0, true), this.attMtu), true);
                }
                messages.push([type, view]);
                offset += length;
            }
            for (const [type, view] of messages) this.onMessageReceived?.(type, view);
        }
        this.onMessagesReceived?.();
    }

    /** @private */
    clear() {
        this.generation++;
        this.pending.length = 0;
        this.flushing = null;
    }
    /**
     * Clear queued work and detach SDK callbacks; does not request GATT disconnection.
     * @returns {void}
     */
    remove() {
        this.clear();
        this.onStatusUpdated = undefined;
        this.onMessageReceived = undefined;
        this.onMessagesReceived = undefined;
    }
}

module.exports = { AndroidBleConnection };
