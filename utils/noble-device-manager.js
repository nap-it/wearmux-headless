// Alternative device-manager using @stoprocent/noble directly
const EventEmitter = require("events");
const noble = require('@stoprocent/noble');

class NobleDeviceManager extends EventEmitter {
    constructor() {
        super();
        this.peripheral = null;
        this.device = null;
        this._targetAddress = null;
    }

    async connectToDevice() {
        try {
            // BrilliantSole main service UUID from SDK bluetoothUUIDs.ts
            const BRILLIANTSOLE_SERVICE_UUID = 'ea6d0000a7254f9b893dc3913e33b39f'.replace(/-/g, '').toLowerCase();

            const { id, name } = this._getFilters();
            // If no filter provided, auto-discover first BrilliantSole device
            this._targetAddress = id ? id.toLowerCase().replace(/:/g, '') : null;
            const targetName = name || null;

            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] Looking for device:`, {
                    address: this._targetAddress || 'auto-discover',
                    name: targetName || 'any BrilliantSole device'
                });
            }

            // Wait for Noble to be powered on
            await this._waitForPoweredOn();

            // Scan and connect
            const peripheral = await this._scanAndConnect(this._targetAddress, targetName, BRILLIANTSOLE_SERVICE_UUID);
            this.peripheral = peripheral;

            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] ✓ Found peripheral ${peripheral.address}`);
            }

            // CRITICAL: Connect to peripheral BEFORE discovering services
            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] Connecting to peripheral...`);
            }

            if (peripheral.state !== 'connected') {
                await peripheral.connectAsync();
            }

            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] ✓ Connected, state: ${peripheral.state}`);
            }

            // Import SDK to create Device and ConnectionManager
            const BS = await import("brilliantsole/node");

            // Create a new SDK Device with real NobleConnectionManager
            const device = new BS.Device();
            const connectionManager = new BS.NobleConnectionManager();

            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] Discovering services and characteristics...`);
            }

            // Now discover everything (peripheral must be connected first!)
            try {
                await peripheral.discoverAllServicesAndCharacteristicsAsync();
                if (process.env.DEBUG === '1') {
                    console.log(`[NobleDeviceManager] ✓ Found ${peripheral.services.length} services`);
                }
            } catch (err) {
                console.error(`[NobleDeviceManager] Discovery failed:`, err.message);
                throw err;
            }

            // CRITICAL: Set noblePeripheral BEFORE emitting events so listeners are attached
            connectionManager.noblePeripheral = peripheral;
            device.connectionManager = connectionManager;

            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] Emitting discovery events to SDK...`);
            }

            // Manually emit the discovery events that the SDK expects
            // Filter out system services (1800, 1801) that the SDK doesn't recognize
            const skippedServices = ['1800', '1801'];
            const servicesToProcess = peripheral.services.filter(s => !skippedServices.includes(s.uuid));

            // Emit servicesDiscover event
            peripheral.emit('servicesDiscover', servicesToProcess);

            // For each service, emit characteristicsDiscover event
            for (const service of servicesToProcess) {
                if (service.characteristics && service.characteristics.length > 0) {
                    service.emit('characteristicsDiscover', service.characteristics);
                }
            }

            // Wait for SDK to process all events and initialize
            await new Promise(r => setTimeout(r, 1000));

            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] Connection status: ${connectionManager.status}`);
                const sensorTypes = device.sensorConfigurationManager?.availableSensorTypes;
                console.log(`[NobleDeviceManager] Available sensors: ${sensorTypes?.length || 0}`);
                if (sensorTypes?.length) {
                    console.log(`[NobleDeviceManager] Sensor types: ${sensorTypes.join(', ')}`);
                }
            }

            this.device = device;

            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] ✓ SDK Device ready`);
            }

            return this.device;
        } catch (err) {
            this.emit("error", err);
            throw err;
        }
    }

    async _waitForPoweredOn(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (noble.state === 'poweredOn') {
                return resolve();
            }

            const timeout = setTimeout(() => {
                noble.removeListener('stateChange', onStateChange);
                reject(new Error('Timeout waiting for Bluetooth adapter'));
            }, timeoutMs);

            const onStateChange = (state) => {
                if (state === 'poweredOn') {
                    clearTimeout(timeout);
                    noble.removeListener('stateChange', onStateChange);
                    resolve();
                }
            };

            noble.on('stateChange', onStateChange);
        });
    }

    async _scanAndConnect(targetAddress, targetName, brilliantSoleServiceUuid) {
        return new Promise((resolve, reject) => {
            let resolved = false;

            const timeout = setTimeout(() => {
                if (!resolved) {
                    noble.stopScanning();
                    noble.removeAllListeners('discover');
                    reject(new Error(`Device not found after 30s (looking for ${targetAddress || targetName})`));
                }
            }, 30000);

            const onDiscover = async (peripheral) => {
                if (resolved) return;

                const addr = peripheral.address.toLowerCase().replace(/:/g, '');
                const name = peripheral.advertisement.localName || '';

                // Filter by BrilliantSole service UUID
                const serviceUuid = peripheral.advertisement.serviceUuids?.[0]?.replace(/-/g, '').toLowerCase();

                if (process.env.DEBUG === '1') {
                    console.log(`[NobleDeviceManager] Found: ${peripheral.address} ${name} [${serviceUuid}]`);
                }

                // Only match devices with the correct BrilliantSole service UUID
                if (serviceUuid !== brilliantSoleServiceUuid) {
                    if (process.env.DEBUG === '1') {
                        console.log(`[NobleDeviceManager] Skipping - not a BrilliantSole device`);
                    }
                    return;
                }

                // Parse manufacturer data to get device type
                const manufacturerData = peripheral.advertisement.manufacturerData;
                let deviceType = 'unknown';
                if (manufacturerData && manufacturerData.byteLength >= 3) {
                    const deviceTypeEnum = manufacturerData.readUInt8(2);
                    deviceType = deviceTypeEnum === 0 ? 'insole' : deviceTypeEnum === 1 ? 'frame' : 'unknown';
                    if (process.env.DEBUG === '1') {
                        console.log(`[NobleDeviceManager] Device type: ${deviceType}`);
                    }
                }

                // Check if this is our target device
                const isMatch = (targetAddress && addr === targetAddress) ||
                    (targetName && name.includes(targetName)) ||
                    (!targetAddress && !targetName); // Auto-discover: match first BrilliantSole device

                if (isMatch) {
                    resolved = true;
                    clearTimeout(timeout);
                    noble.removeAllListeners('discover');

                    if (process.env.DEBUG === '1') {
                        console.log(`[NobleDeviceManager] Matched! Found peripheral`);
                    }

                    // Await scan stop before resolving — on Linux/BlueZ, D-Bus
                    // operations deadlock if discovery starts while scan is stopping.
                    noble.stopScanningAsync().then(
                        () => resolve(peripheral),
                        () => resolve(peripheral)  // resolve even if stopScan fails
                    );
                }
            };

            noble.on('discover', onDiscover);

            if (process.env.DEBUG === '1') {
                console.log(`[NobleDeviceManager] Starting BLE scan...`);
            }
            noble.startScanning([], true); // Allow duplicates
        });
    }

    _getFilters() {
        return {
            id: process.env.DEVICE_ID || process.env.MIC_DEVICE_ID || "",
            name: process.env.DEVICE_NAME || process.env.MIC_DEVICE_NAME || "",
        };
    }

    getDevice() {
        return this.device;
    }

    async disconnect() {
        try {
            if (this.peripheral) {
                await this.peripheral.disconnectAsync();
            }
        } catch (error) {
            console.warn("[NobleDeviceManager] Error during disconnect:", error);
        }
    }
}

module.exports = { NobleDeviceManager };
