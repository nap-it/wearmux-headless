/**
 * Android companion wire validation and constants.
 * @namespace AndroidBleProtocol
 * @see {@tutorial android-ble-protocol}
 */
/**
 * Protocol version accepted in hello frames.
 * @constant {number}
 * @memberof AndroidBleProtocol
 */
const VERSION = 1;
/**
 * WebSocket upgrade path.
 * @constant {string}
 * @memberof AndroidBleProtocol
 */
const PATH = "/android-ble";
/**
 * Maximum JSON text-frame size in bytes.
 * @constant {number}
 * @memberof AndroidBleProtocol
 */
const MAX_PAYLOAD = 64 * 1024;
const CHARACTERISTICS = new Set([
    "rx", "batteryLevel", "manufacturerName", "modelNumber", "hardwareRevision",
    "firmwareRevision", "softwareRevision", "serialNumber", "pnpId",
]);
/**
 * Lowercase a device identity and remove colon separators for comparisons.
 * @memberof AndroidBleProtocol
 * @param {*} id Device identity; missing/falsy values become an empty string.
 * @returns {string}
 */
const normalizeId = (id) => String(id || "").toLowerCase().replaceAll(":", "");

/**
 * Decode bounded canonical standard Base64 without accepting alternate encodings.
 * @memberof AndroidBleProtocol
 * @param {string} data Encoded characteristic value; at most MAX_PAYLOAD characters.
 * @returns {Buffer}
 * @throws {Error} If the input is not bounded canonical Base64.
 */
function decodeData(data) {
    if (typeof data !== "string" || data.length > MAX_PAYLOAD ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new Error("Characteristic data must be canonical Base64");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) throw new Error("Invalid Base64 data");
    return bytes;
}

/**
 * Validate one inbound companion frame and decode value.data into frame.bytes.
 * This checks shape and bounds, not protocol sequence or active-device ownership;
 * those are enforced by AndroidBleBridge. Outbound write frames are not accepted.
 * @memberof AndroidBleProtocol
 * @param {Buffer|string} data JSON text received through WebSocket.
 * @param {boolean} [isBinary=false] Binary WebSocket messages are rejected.
 * @returns {AndroidBleFrame} Parsed frame; value frames gain a bytes Buffer.
 * @throws {Error} If size, JSON, version, device ID, or type-specific fields are invalid.
 */
function parseFrame(data, isBinary = false) {
    if (isBinary || Buffer.byteLength(data) > MAX_PAYLOAD) throw new Error("Expected bounded JSON text frame");
    let frame;
    try { frame = JSON.parse(data.toString()); }
    catch { throw new Error("Invalid bridge JSON"); }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Expected bridge object");
    if (!["hello", "connected", "value", "writeResult", "disconnected", "error"].includes(frame.type)) {
        throw new Error("Unknown bridge message type");
    }
    if (frame.type === "hello") {
        if (frame.version !== VERSION) throw new Error("Unsupported Android bridge protocol version");
        return frame;
    }
    if (frame.type === "error") {
        if (typeof frame.error !== "string" || frame.error.length > 512) throw new Error("Invalid bridge error");
        return frame;
    }
    if (typeof frame.deviceId !== "string" || !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(frame.deviceId)) {
        throw new Error("Expected Bluetooth MAC deviceId");
    }
    if (frame.type === "connected") {
        if (!Number.isInteger(frame.mtu) || frame.mtu < 23 || frame.mtu > 517) throw new Error("Invalid ATT MTU");
        if (frame.name !== undefined && (typeof frame.name !== "string" || frame.name.length > 128)) {
            throw new Error("Invalid device name");
        }
    } else if (frame.type === "value") {
        if (!CHARACTERISTICS.has(frame.characteristic)) throw new Error("Unsupported characteristic");
        frame.bytes = decodeData(frame.data);
    } else if (frame.type === "writeResult") {
        if (typeof frame.requestId !== "string" || !/^\d{1,16}$/.test(frame.requestId) || typeof frame.ok !== "boolean") {
            throw new Error("Invalid write result");
        }
        if (frame.error !== undefined && (typeof frame.error !== "string" || frame.error.length > 512)) {
            throw new Error("Invalid write error");
        }
    }
    return frame;
}

module.exports = { VERSION, PATH, MAX_PAYLOAD, normalizeId, decodeData, parseFrame };
