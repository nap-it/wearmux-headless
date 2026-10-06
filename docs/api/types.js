/**
 * Shared documentation contracts for the Headless host.
 * These typedefs describe current message shapes and duck-typed interfaces;
 * they do not add runtime validation or create a separately published SDK.
 * @file
 */

/**
 * Source identity. SDK adapters may omit unknown fields; session status uses null.
 * @typedef {Object} DeviceIdentity
 * @property {?string} [id] SDK Bluetooth ID or device ID; use the emitted value for targeting.
 * @property {?string} [name] Device-reported name.
 */

/**
 * Capabilities discovered after device connection, independent of product names.
 * @typedef {Object} DeviceCapabilities
 * @property {string[]} sensors Known sensor types advertised by the device.
 * @property {boolean} camera Camera acquisition available.
 * @property {boolean} microphone Microphone acquisition available.
 * @property {boolean} display Display output available.
 * @property {boolean} haptics At least one vibration location available.
 * @property {boolean} audio Beep output available through the device adapter.
 * @property {boolean} notifications Notification output available through the device adapter.
 */

/**
 * Shared publisher interface implemented by MqttManager and ZenohManager.
 * Register an error listener before start(). Await start() before publishing.
 * publish() completion describes local/backend acceptance, not consumer delivery.
 * @typedef {Object} Publisher
 * @property {function():Promise<*>} start Start the owned transport connection/sidecar.
 * @property {function():Promise<void>} stop Release the transport's owned resources.
 * @property {function(string, *):Promise<void>} publish Publish a JSON-serializable value.
 * @property {function(string, Function):*} on Subscribe to EventEmitter events, including error and ready.
 * @property {function(string, Function):*} off Remove an EventEmitter listener.
 */

/**
 * Shared subscriber interface implemented by MqttSubscriber and ZenohSubscriber.
 * Listen for message and error before start(); the backend controls wildcard syntax.
 * @typedef {Object} Subscriber
 * @property {function():Promise<void>} start Open the subscription.
 * @property {function():Promise<void>} stop Close the subscription and owned resources.
 * @property {function(string, Function):*} on Subscribe to message, ready, and error events.
 * @property {function(string, Function):*} off Remove an EventEmitter listener.
 */

/**
 * A subscriber event. Valid JSON is decoded; other payloads remain strings.
 * @typedef {Object} TransportMessage
 * @property {string} key Exact MQTT topic or Zenoh key.
 * @property {*} payload Decoded JSON value or original text.
 */

/**
 * Backend selection and constructor options; unused fields are ignored by a backend.
 * @typedef {Object} TransportOptions
 * @property {string} [transport] mqtt, zenoh, or none; otherwise selected from MESSAGE_TRANSPORT.
 * @property {string} [keyPrefix] Sensor attachment prefix, normally bwear/sensors.
 * @property {string} [topicFilter] Subscriber filter; MQTT uses #/+ wildcards.
 * @property {string} [keyExpression] Subscriber filter; Zenoh uses double-star and single-star wildcards.
 * @property {string} [brokerUrl] MQTT broker URL; defaults to MQTT_BROKER_URL or localhost:1883.
 * @property {string} [udsPath] Unique local Unix socket path for a Zenoh sidecar.
 */

/**
 * Attach a publisher to SensorManager's currently selected events.
 * @typedef {Object} SensorAttachmentOptions
 * @property {string[]} [sensors] Explicit list; an empty/missing list uses getEnabledSensors().
 * @property {boolean} [quiet=false] Suppress attachment and per-message failure logs.
 */

/**
 * An application command published to the action topic. Required fields depend
 * on action. Correlation and routing fields are optional; commands never broadcast.
 * @typedef {Object} ActionCommand
 * @property {string} action display.text, display.prompt, display.clear, display.image, haptic.vibrate, audio.beep, or notification.show.
 * @property {string} [id] Application-generated correlation ID echoed in the result.
 * @property {string} [deviceId] Source device ID; required when several devices support the action.
 * @property {string} [text] Nonempty text of at most 500 characters for text/prompt actions.
 * @property {string} [data] Base64 image bytes, at most 1 MiB decoded, for display.image.
 * @property {string} [effect="strongClick100"] SDK vibration effect for haptic.vibrate.
 * @property {string[]} [locations] Supported device vibration locations.
 * @property {number} [frequency=880] Integer frequency from 40 to 8000 Hz for audio.beep.
 * @property {number} [durationMs=250] Integer duration from 10 to 5000 milliseconds for audio.beep.
 * @property {string} [level="warning"] warning, danger, or safe for notification.show.
 * @property {string} [title="WearMux"] Nonempty notification title of at most 100 characters.
 */

/**
 * Action outcome. ok indicates SDK command acceptance, not that the wearer
 * perceived the output. No command persistence or automatic retry is provided.
 * @typedef {Object} ActionResult
 * @property {number} ts Host Unix time in milliseconds.
 * @property {?DeviceIdentity} device Selected device, or null when routing failed in the fleet.
 * @property {string} [id] Correlation ID, if supplied as a string.
 * @property {string} [action] Requested action name, when available.
 * @property {boolean} ok Whether routing and dispatch succeeded.
 * @property {string} [error] Failure description when ok is false.
 */

/**
 * Sensor publication. The inner SDK message is preserved; its timestamps are
 * not converted to the host clock. ts records host publication time.
 * @typedef {Object} SensorEnvelope
 * @property {number} ts Host Unix time in milliseconds.
 * @property {string} sensor Sensor event name.
 * @property {DeviceIdentity} [device] Source identity.
 * @property {?Object} message SDK sensor payload, including its own timestamp and sensor values.
 */

/**
 * Processed camera-frame metadata; encoded bytes are published separately when enabled.
 * @typedef {Object} CameraImage
 * @property {number} ts Host Unix time in milliseconds.
 * @property {DeviceIdentity} device Source identity.
 * @property {number} bytes JPEG byte count.
 * @property {string} mime image/jpeg.
 * @property {?number} cameraTimestamp SDK timestamp, with its device-defined clock.
 * @property {?number} latencyMs SDK-reported latency, or null when absent/zero.
 * @property {boolean} saved Whether the frame was written to CAMERA_OUTPUT_DIR.
 */

/**
 * Audio-level publication and local callback value. Levels describe the SDK samples.
 * @typedef {Object} MicrophoneLevel
 * @property {number} ts Host Unix time in milliseconds.
 * @property {DeviceIdentity} device Source identity.
 * @property {number} sampleRate SDK-reported sample rate in Hz.
 * @property {number} bitDepth SDK-reported device bit depth.
 * @property {number} rms Root mean square of the normalized samples.
 * @property {number} peak Maximum absolute sample magnitude.
 * @property {string} db RMS in dB, formatted to one decimal, or -∞ for silence.
 * @property {number} samples Number of samples in the packet.
 */

/**
 * Metadata starting a raw-media frame. Audio describes one packet, not a complete WAV file.
 * @typedef {Object} RawMediaMetadata
 * @property {number} ts Host Unix time in milliseconds.
 * @property {string} frameId Unique identity for grouping metadata and chunks.
 * @property {number} totalChunks Expected chunk count.
 * @property {string} encoding base64; decode after concatenating chunk strings.
 * @property {number} bytes Decoded byte count.
 * @property {DeviceIdentity} [device] Source identity.
 * @property {string} [mime] Camera format, normally image/jpeg.
 * @property {string} [format] Audio format f32le (little-endian float32 samples).
 * @property {number} [sampleRate] Audio sample rate in Hz.
 * @property {number} [bitDepth] SDK-reported capture bit depth; raw wire samples remain float32.
 * @property {number} [samples] Audio sample count.
 */

/**
 * One chunk of a raw media frame; chunks can be lost or interleaved across devices.
 * @typedef {Object} RawMediaChunk
 * @property {number} ts Host Unix time in milliseconds.
 * @property {string} frameId Matching metadata/frame identity.
 * @property {DeviceIdentity} [device] Source identity.
 * @property {number} idx Zero-based chunk index.
 * @property {string} data Base64 substring; concatenate by idx before decoding.
 */

/**
 * Image sizing and placement passed to DisplayManager.
 * @typedef {Object} DisplayRenderOptions
 * @property {number} [outWidth] Resize target width in pixels.
 * @property {number} [outHeight] Resize target height in pixels.
 * @property {number} [inputHeight] Host processing height in pixels, overriding width/height resize.
 * @property {number} [outputHeight] Scaled device output height in pixels.
 * @property {number} [x] Placement; zero invokes automatic centering.
 * @property {number} [y] Placement; zero invokes automatic centering.
 * @property {string} [fit] contain, cover, fill, inside, or outside.
 * @property {string} [align] top, bottom, left, right, or center.
 * @property {number} [pixelDepth] Quantization depth of 1, 2, or 4; use the manager's depth for bitmap packing.
 */

/**
 * Parsed INI structure returned without converting environment values to numbers.
 * @typedef {Object} ParsedIni
 * @property {Object<string, string>} _env Environment key/value strings.
 * @property {Object[]} _scripts Launcher entries.
 * @property {string} _scripts.name INI script key.
 * @property {string} _scripts.cmd Command name from the comma-separated value.
 */
