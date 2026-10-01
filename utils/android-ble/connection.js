// SDK-compatible connection manager. Android proxies characteristic bytes; the SDK
// remains responsible for metadata, sensor decoding and display command encoding.
class AndroidBleConnection {
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

    get isConnected() { return this.status === "connected"; }
    get isAvailable() { return this.isConnected; }
    get canReconnect() { return false; } // Android owns scan/reconnection.
    get canUpdateFirmware() { return false; }
    get mtu() { return Math.min(this._mtu, this.attMtu); }
    set mtu(value) {
        if (!Number.isInteger(value) || value < 23) throw new Error("Invalid SDK protocol MTU");
        this._mtu = value;
    }

    setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        // SDK status callbacks may be async; always handle their rejection.
        try { Promise.resolve(this.onStatusUpdated?.(status)).catch(this.onError); }
        catch (error) { this.onError(error); }
    }

    async connect() { this.setStatus("connected"); return true; }
    async disconnect() {
        if (this.status === "notConnected") return false;
        this.requestDisconnect();
        this.markDisconnected();
        return true;
    }
    markDisconnected() {
        this.clear();
        this.setStatus("notConnected");
    }
    async reconnect() { return false; }
    async sendSmpMessage() { throw new Error("Firmware update is not supported by the Android BLE bridge"); }

    sendTxMessages(messages, sendImmediately = true) {
        // SDK managers fire and forget commands; public operations await firmware
        // events. Invalidate the link through onError and consume transport errors.
        try { return this.queueTxMessages(messages, sendImmediately); }
        catch (error) { this.onError(error); return Promise.resolve(false); }
    }

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

    async sendTxData(data) {
        if (!this.isConnected) throw new Error("Android BLE device is disconnected");
        const bytes = Buffer.from(data);
        if (!bytes.length) return;
        if (bytes.length > this.mtu - 3) throw new Error("Write exceeds negotiated BLE MTU");
        await this.write(bytes);
    }

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
                messages.push([type, new DataView(copy.buffer)]);
                offset += length;
            }
            for (const [type, view] of messages) this.onMessageReceived?.(type, view);
        }
        this.onMessagesReceived?.();
    }

    clear() {
        this.generation++;
        this.pending.length = 0;
        this.flushing = null;
    }
    remove() {
        this.clear();
        this.onStatusUpdated = undefined;
        this.onMessageReceived = undefined;
        this.onMessagesReceived = undefined;
    }
}

module.exports = { AndroidBleConnection };
