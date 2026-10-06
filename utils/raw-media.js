const { randomUUID } = require("crypto");
const { topic } = require("./topics");

/**
 * Publish a metadata record followed by ordered base64 chunks for one media frame.
 * RAW_CHUNK_SIZE is a number of base64 characters, with a minimum of 1024 and
 * default of 30000. Consumers concatenate chunks before decoding, group them by
 * frameId, and expire incomplete frames. Publication is sequential within this call;
 * concurrent devices can interleave frames. MQTT uses QoS 0, so delivery is not guaranteed.
 * @param {Publisher} publisher Started shared publisher.
 * @param {string} modality Normally camera or microphone.
 * @param {Buffer} buffer Complete image or audio packet.
 * @param {Object} meta Additional metadata; reserve framing fields for this helper.
 * @param {DeviceIdentity} [meta.device] Source identity used in messages and frameId.
 * @returns {Promise<void>} Rejects on publication failure; no retry or rollback is performed.
 * @see RawMediaMetadata
 * @see RawMediaChunk
 * @see {@tutorial message-contract}
 */
async function publishRawMedia(publisher, modality, buffer, meta) {
    const frameId = `${meta.device?.id || "device"}-${randomUUID()}`;
    const encoded = buffer.toString("base64");
    const chunkSize = Math.max(1024, Number(process.env.RAW_CHUNK_SIZE || 30000));
    const totalChunks = Math.ceil(encoded.length / chunkSize);
    // A unique frame ID lets consumers reassemble interleaved streams from several devices.
    await publisher.publish(topic(modality, "raw", "meta"), {
        ts: Date.now(), frameId, totalChunks, encoding: "base64", bytes: buffer.length, ...meta,
    });
    for (let idx = 0; idx < totalChunks; idx++) {
        await publisher.publish(topic(modality, "raw", "chunk"), {
            ts: Date.now(), frameId, device: meta.device, idx,
            data: encoded.slice(idx * chunkSize, (idx + 1) * chunkSize),
        });
    }
}

module.exports = { publishRawMedia };
