// The browser SDK retains the device protocol without loading Noble's HCI backend.
const sdks = new Map();

/**
 * Check whether DEVICE_TRANSPORT selects the Android GATT proxy.
 * @returns {boolean}
 */
function usesAndroidBleBridge() {
    return process.env.DEVICE_TRANSPORT?.trim().toLowerCase() === "android-ble";
}

/**
 * Lazily load and cache the browser SDK for Android BLE, or the Node SDK otherwise.
 * The browser entry avoids loading Noble's native HCI backend. Choose the transport
 * before importing/starting device modules; the SDK import itself is cached per entry.
 * @returns {Promise<Object>} BrilliantSole SDK module namespace.
 */
function loadSdk() {
    const target = usesAndroidBleBridge() ? "brilliantsole/browser" : "brilliantsole/node";
    if (!sdks.has(target)) sdks.set(target, import(target));
    return sdks.get(target);
}

module.exports = { loadSdk, usesAndroidBleBridge };
