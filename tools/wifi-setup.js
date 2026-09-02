#!/usr/bin/env node
// One-time WiFi provisioning tool
// Connects to the device via BLE, sets SSID/password, enables WiFi, and prints the IP.
// Run once to provision a device. After this, set DEVICE_IP in config/wifi.ini to skip BLE.

const { DeviceManager } = require("../utils/device-manager");

async function main() {
    const ssid = process.env.WIFI_SSID;
    const password = process.env.WIFI_PASSWORD || "";

    if (!ssid) {
        console.error("[Error] WIFI_SSID is required. Set it in config/wifi.ini or as an env var.");
        process.exit(1);
    }

    console.log("Connecting to device via BLE...");
    const device = await new DeviceManager().connectToDevice();
    console.log(`✓ Connected: ${device.name || device.bluetoothId || "device"}\n`);

    if (!device.isWifiAvailable) {
        console.error("[Error] This device does not support WiFi.");
        process.exit(1);
    }

    console.log(`Current SSID: "${device.wifiSSID || "(none)"}"`);
    console.log(`Current WiFi connected: ${device.isWifiConnected}`);
    if (device.isWifiConnected) {
        console.log(`Current IP: ${device.ipAddress}`);
    }
    console.log();

    // Disable WiFi connection before changing credentials (SDK requirement)
    if (device.wifiConnectionEnabled) {
        console.log("Disabling WiFi connection to update credentials...");
        await device.disableWifiConnection();
        await new Promise((r) => setTimeout(r, 500));
    }

    console.log(`Setting SSID: "${ssid}"`);
    await device.setWifiSSID(ssid);

    if (password) {
        console.log("Setting password...");
        await device.setWifiPassword(password);
    }

    // Wait for IP address
    const ipReady = new Promise((resolve, reject) => {
        const onIp = (event) => {
            const ip = event.message?.ipAddress;
            if (ip) {
                cleanup();
                resolve(ip);
            }
        };
        const cleanup = () => {
            clearTimeout(timeout);
            device.removeEventListener("ipAddress", onIp);
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for WiFi IP address (30s)"));
        }, 30_000);
        device.addEventListener("ipAddress", onIp);
    });

    console.log(`\nEnabling WiFi connection to "${ssid}"...`);
    await device.enableWifiConnection();

    process.stdout.write("Waiting for IP");
    const ipTicker = setInterval(() => process.stdout.write("."), 500);

    let ipAddress;
    try {
        ipAddress = await ipReady;
    } finally {
        clearInterval(ipTicker);
        process.stdout.write("\n");
    }

    console.log(`\n✓ WiFi connected!`);
    console.log(`  IP address: ${ipAddress}`);
    console.log(`  Secure:     ${device.isWifiSecure}`);
    console.log(`\nTo use WiFi transport, add to config/wifi.ini:`);
    console.log(`  DEVICE_IP=${ipAddress}`);
    console.log(`  DEVICE_TRANSPORT=websocket`);

    process.exit(0);
}

main().catch((err) => {
    console.error("[Error]", err?.message || err);
    process.exit(1);
});
