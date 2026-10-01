const VERSION = 1;
const PATH = "/android-ble";
const MAX_PAYLOAD = 64 * 1024;
const CHARACTERISTICS = new Set([
    "rx", "batteryLevel", "manufacturerName", "modelNumber", "hardwareRevision",
    "firmwareRevision", "softwareRevision", "serialNumber", "pnpId",
]);
const normalizeId = (id) => String(id || "").toLowerCase().replaceAll(":", "");

function decodeData(data) {
    if (typeof data !== "string" || data.length > MAX_PAYLOAD ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new Error("Characteristic data must be canonical Base64");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) throw new Error("Invalid Base64 data");
    return bytes;
}

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
