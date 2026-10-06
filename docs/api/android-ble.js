/**
 * Documentation-only Android BLE adapter contracts.
 * @file
 */

/**
 * Settings for AndroidBleBridge. Environment defaults are read at construction.
 * @typedef {Object} AndroidBleBridgeOptions
 * @property {Object} [sdk] BrilliantSole browser SDK; imported lazily when omitted.
 * @property {string} [host="127.0.0.1"] Bind address; ANDROID_BLE_BRIDGE_HOST overrides the default.
 * @property {number} [port=8765] TCP port, 0 for automatic selection; ANDROID_BLE_BRIDGE_PORT supplies the default.
 * @property {string} [authMode="token"] token or local; defaults from ANDROID_BLE_BRIDGE_AUTH_MODE.
 * @property {string} [token] Required in token mode: 16–256 characters without whitespace; defaults from ANDROID_BLE_BRIDGE_TOKEN.
 * @property {string|string[]} [localPeers="127.0.0.1,::1"] Exact allowed IPs in local mode; defaults from ANDROID_BLE_BRIDGE_LOCAL_PEERS.
 * @property {number} [writeTimeoutMs=10000] GATT acknowledgement deadline in milliseconds.
 * @property {number} [helloTimeoutMs=10000] Companion hello deadline in milliseconds.
 * @property {number} [readyTimeoutMs=30000] SDK metadata/capability initialization deadline in milliseconds.
 * @property {number} [heartbeatMs=15000] WebSocket ping interval in milliseconds.
 */

/**
 * Bridge-owned callbacks and SDK protocol metadata for AndroidBleConnection.
 * @typedef {Object} AndroidBleConnectionOptions
 * @property {string} deviceId Bluetooth MAC identity.
 * @property {number} mtu Negotiated ATT MTU, including the three-byte ATT overhead.
 * @property {string[]} messageTypes SDK TxRxMessageTypes index table.
 * @property {function(Buffer):Promise<void>} write Write one TX value and await GATT acknowledgement.
 * @property {function():void} disconnect Request peripheral teardown.
 * @property {function(Error):void} onError Handle encoding, SDK callback, and transport failures.
 */

/**
 * One SDK command before TLV encoding.
 * @typedef {Object} AndroidBleTxMessage
 * @property {string} type Entry in the SDK TxRxMessageTypes table.
 * @property {Buffer|ArrayBuffer|Uint8Array} [data] Binary payload; absent means zero bytes.
 */

/**
 * Inbound Android companion message; required fields depend on type.
 * Consult the protocol guide for the six accepted variants and sequencing.
 * @typedef {Object} AndroidBleFrame
 * @property {string} type hello, connected, value, writeResult, disconnected, or error.
 * @property {number} [version] hello must use version 1.
 * @property {string} [deviceId] Bluetooth MAC; required except for hello/error.
 * @property {string} [name] Optional connection label; SDK metadata remains authoritative.
 * @property {number} [mtu] connected requires an integer ATT MTU from 23 to 517.
 * @property {string} [characteristic] value requires an allowed RX/battery/device-information name.
 * @property {string} [data] value requires canonical standard Base64.
 * @property {Buffer} [bytes] Added by parseFrame for value frames; absent on the wire.
 * @property {string} [requestId] writeResult requires 1–16 decimal digits matching an outstanding write.
 * @property {boolean} [ok] writeResult acknowledgement outcome.
 * @property {string} [error] error text or optional failed-write detail, at most 512 characters.
 */
