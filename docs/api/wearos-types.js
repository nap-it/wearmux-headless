/** Documentation-only direct Wear OS protocol and adapter contracts. @file */

/**
 * Direct WebSocket listener settings; UDP uses the same actual port on all IPv4 interfaces.
 * @typedef {Object} WearOsServerOptions
 * @property {number} port TCP/UDP port, or 0 to choose a TCP port dynamically.
 * @property {string} [host] TCP bind address; omitted means all interfaces.
 */

/**
 * First text frame sent by a watch. Only type and a nonempty string id are checked
 * by the server; clients must provide the documented capability field shapes.
 * @typedef {Object} WearOsHello
 * @property {string} type hello.
 * @property {string} id Stable watch ID; retained under this exact string across reconnects.
 * @property {string} [name="Wear OS"] Human-readable label.
 * @property {string[]} [sensors] Supported subset of WEAROS_SENSORS.
 * @property {boolean} [vibration=false] Advertise wrist haptics.
 * @property {boolean} [beep=false] Advertise tone playback.
 * @property {boolean} [notifications=false] Advertise alerts.
 */

/**
 * Sensor text frame from a watch. Vector sensors use x/y/z; heartRate uses bpm.
 * @typedef {Object} WearOsSensorPacket
 * @property {string} type sensor.
 * @property {string} sensor acceleration, gyroscope, magnetometer, or heartRate, as advertised in hello.
 * @property {number} timestamp Client timestamp in milliseconds; numeric values are retained without clock normalization.
 * @property {number} [x] Vector X in m/s², rad/s, or µT according to sensor.
 * @property {number} [y] Vector Y in the same units.
 * @property {number} [z] Vector Z in the same units.
 * @property {number} [bpm] Heart rate in beats per minute.
 */

/**
 * Host command frame. No request ID or watch acknowledgement exists in this protocol.
 * @typedef {Object} WearOsHostCommand
 * @property {string} type config, vibrate, beep, or notify.
 * @property {Object<string, number>} [sensors] config: full selection of sensor intervals in milliseconds; 0 or missing disables.
 * @property {string} [effect] vibrate: requested vibration effect name.
 * @property {number} [frequency] beep: tone frequency in Hz.
 * @property {number} [durationMs] beep: tone duration in milliseconds.
 * @property {string} [level] notify: warning, danger, or safe.
 * @property {string} [title] notify: alert title.
 * @property {string} [text] notify: alert body.
 */

/**
 * UDP response to a discover datagram. Connect to the sender's IP and the given port.
 * @typedef {Object} WearOsDiscoveryReply
 * @property {string} type wearmux.
 * @property {number} port Actual WebSocket TCP port.
 * @property {string} name Host operating-system hostname.
 */

/**
 * SDK-compatible connection event emitted by WearOsDevice.
 * @typedef {Object} WearOsConnectionEvent
 * @property {string} type isConnected.
 * @property {WearOsDevice} target Source adapter.
 * @property {Object} message
 * @property {boolean} message.isConnected Current socket connection state.
 */

/**
 * SDK-compatible sensor event emitted by WearOsDevice, before transport publication.
 * @typedef {Object} WearOsSensorEvent
 * @property {string} type Advertised sensor name.
 * @property {WearOsDevice} target Source adapter.
 * @property {Object} message
 * @property {string} message.sensorType Same sensor name.
 * @property {number} message.timestamp Numeric client timestamp, or host Date.now() when absent/zero/nonnumeric.
 * @property {{x:number, y:number, z:number}} [message.acceleration] Acceleration in m/s².
 * @property {{x:number, y:number, z:number}} [message.gyroscope] Angular velocity in rad/s.
 * @property {{x:number, y:number, z:number}} [message.magnetometer] Magnetic field in µT.
 * @property {number} [message.heartRate] Heart rate in BPM.
 */
