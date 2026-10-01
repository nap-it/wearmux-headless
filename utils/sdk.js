// The browser SDK retains the device protocol without loading Noble's HCI backend.
const sdks = new Map();

function usesAndroidBleBridge() {
    return process.env.DEVICE_TRANSPORT?.trim().toLowerCase() === "android-ble";
}

function loadSdk() {
    const target = usesAndroidBleBridge() ? "brilliantsole/browser" : "brilliantsole/node";
    if (!sdks.has(target)) sdks.set(target, import(target));
    return sdks.get(target);
}

module.exports = { loadSdk, usesAndroidBleBridge };
